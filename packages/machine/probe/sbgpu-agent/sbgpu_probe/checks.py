"""The probe's checks (DESIGN.md section 1.5): can anything in a launched container recover the provider's API key?

Each check returns (pass, paths, detail): paths are where something was found (at most PATHS_MAX, each at most
PATH_BYTES, non-printable bytes escaped), and detail is a fixed word.  The probe never reads, keeps, hashes or reports
a key's value: it looks for the variable's name and for strings shaped like a key, and reports where.

The name and the shapes are built at run time from pieces, so the probe's own files (its source, its bytecode) never
contain them and can't match its own file scan.
"""

import os
import re
import time

# ---- what is looked for: the variable's name, and key shapes (to be confirmed against the provider's documented
# key formats before a paid run; the driver uses the same shapes on the logs)
KEY_NAME = ("RUNPOD" + "_API" + "_KEY").encode()
KEY_SHAPES = (
    re.compile(b"rpa" + b"_[A-Za-z0-9_-]{16,}"),
    re.compile(b"RUNPOD" + b"_API" + rb"_KEY\s*[=:]\s*\S"),
)

PATHS_MAX = 20
PATH_BYTES = 256
CHUNK = 1024 * 1024
OVERLAP = 128  # (bytes carried between chunks, so a match across a chunk boundary is still seen)
# (filesystems that aren't storage: never walked)
VIRTUAL_FS = frozenset(
    "proc sysfs devtmpfs devpts tmpfs-dev cgroup cgroup2 mqueue debugfs tracefs securityfs pstore bpf configfs "
    "fusectl hugetlbfs autofs binfmt_misc rpc_pipefs nsfs".split()
)
SKIP_TOPS = ("/proc", "/sys", "/dev")


def found(data):
    """'found-name', 'found-shape' or None for these bytes."""
    if KEY_NAME in data:
        return "found-name"
    if any(r.search(data) for r in KEY_SHAPES):
        return "found-shape"
    return None


def show(path):
    """A path as reported: escaped, at most PATH_BYTES bytes, and never containing the variable's name."""
    b = path.encode("utf-8", "surrogateescape") if isinstance(path, str) else path
    out = "".join(chr(c) if 32 <= c < 127 and c != 92 else "\\x%02x" % c for c in b)
    if KEY_NAME.decode() in out:
        out = out.replace(KEY_NAME.decode(), "<name>")
    return out[:PATH_BYTES]


class Found:
    def __init__(self):
        self.paths = []
        self.detail = None

    def add(self, path, what):
        if self.detail is None or what == "found-name":
            self.detail = what
        if len(self.paths) < PATHS_MAX:
            self.paths.append(show(path))

    def result(self, default="ok"):
        return (self.detail is None, self.paths, self.detail or default)


# ---- 1. pid1
def check_pid1(proc="/proc", pid=None, entry_suffix="sbgpu-agent"):
    """The probe is PID 1 (the launcher exec'd it, keeping its PID), /proc/1/cmdline is python running it, and no
    other process exists."""
    pid = os.getpid() if pid is None else pid
    if pid != 1:
        return False, [], "not-pid1"
    try:
        with open("%s/1/cmdline" % proc, "rb") as f:
            argv = [a for a in f.read(4096).split(b"\0") if a]
    except OSError:
        return False, [], "unreadable"
    if not argv or b"python" not in os.path.basename(argv[0]) or not argv[-1].rstrip(b"/").endswith(entry_suffix.encode()):
        return False, [], "unexpected-cmdline"
    others = [d for d in os.listdir(proc) if d.isdigit() and d != "1"]
    if others:
        return False, [show("%s/%s" % (proc, d)) for d in sorted(others, key=int)[:PATHS_MAX]], "extra-process"
    return True, [], "ok"


# ---- 2. environ
def check_environ(proc="/proc"):
    """Every process's and every thread's environment: the name or a key shape anywhere is a finding; one that can't
    be read is too (doubt fails)."""
    f = Found()
    for d in sorted(os.listdir(proc)):
        if not d.isdigit():
            continue
        files = ["%s/%s/environ" % (proc, d)]
        try:
            files += ["%s/%s/task/%s/environ" % (proc, d, t) for t in sorted(os.listdir("%s/%s/task" % (proc, d)))]
        except OSError:
            pass
        for path in files:
            try:
                with open(path, "rb") as fh:
                    data = fh.read(4 * CHUNK)
            except FileNotFoundError:
                continue  # (it ended meanwhile)
            except OSError:
                f.add(path, "unreadable")
                continue
            what = found(data)
            if what:
                f.add(path, what)
    return f.result()


# ---- 3. files
def mounts(proc="/proc"):
    """[(mount point, fs type)] from /proc/mounts."""
    out = []
    with open("%s/mounts" % proc) as fh:
        for line in fh:
            parts = line.split()
            if len(parts) >= 3:
                out.append((parts[1].encode().decode("unicode_escape"), parts[2]))
    return out


def scan_file(path):
    """found-name / found-shape / None for one regular file, read in chunks with an overlap."""
    tail = b""
    with open(path, "rb") as fh:
        while True:
            b = fh.read(CHUNK)
            if not b:
                return None
            what = found(tail + b)
            if what:
                return what
            tail = (tail + b)[-OVERLAP:]


def check_files(root="/", proc="/proc", deadline=None, clock=time.monotonic):
    """Every regular file on every storage filesystem (not /proc, /sys, /dev or a virtual mount), symlinks not
    followed: the name or a key shape is a finding.  Past the deadline: fails with 'timeout'."""
    f = Found()
    try:
        skip = {mp for mp, fs in mounts(proc) if fs in VIRTUAL_FS}
    except OSError:
        return False, [], "unreadable"
    skip |= set(SKIP_TOPS)
    unreadable = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel = "/" + os.path.relpath(dirpath, root) if dirpath != root else "/"
        rel = os.path.normpath(rel)
        dirnames[:] = sorted(d for d in dirnames if os.path.normpath(os.path.join(rel, d)) not in skip)
        for name in sorted(filenames):
            if deadline is not None and clock() > deadline:
                return False, f.paths, "timeout"
            path = os.path.join(dirpath, name)
            try:
                if not os.path.isfile(path) or os.path.islink(path):
                    continue
                what = scan_file(path)
            except OSError:
                unreadable += 1
                continue
            if what:
                f.add(os.path.normpath(os.path.join(rel, name)), what)  # (as the container sees it)
    if f.detail is None and unreadable:
        # (root reads everything on a container's storage: a file that can't be read is doubt)
        return False, [], "unreadable"
    return f.result()


# ---- 4. metadata
# (a fixed, reviewed list: link-local and provider metadata addresses.  The probe can't recover any endpoint that
# was advertised only in the original environment, which the launcher's exec discarded, by design)
METADATA_ENDPOINTS = (
    ("http://169.254.169.254/", {}),
    ("http://169.254.169.254/latest/meta-data/", {}),
    ("http://169.254.169.254/latest/user-data", {}),
    ("http://169.254.169.254/computeMetadata/v1/?recursive=true", {"Metadata-Flavor": "Google"}),
    ("http://169.254.169.254/metadata/instance?api-version=2021-02-01", {"Metadata": "true"}),
    ("http://169.254.169.254/openstack/latest/meta_data.json", {}),
    ("http://169.254.170.2/v2/metadata", {}),
    ("http://169.254.170.2/v2/credentials", {}),
)
METADATA_TIMEOUT_S = 2
METADATA_BODY_MAX = 64 * 1024


def http_get(url, headers, timeout):
    """(status, body bytes) or None when nothing answers.  No redirects followed, no proxy."""
    import urllib.error
    import urllib.request

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)
    try:
        with opener.open(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
            return r.status, r.read(METADATA_BODY_MAX)
    except urllib.error.HTTPError as e:
        return e.code, (e.read(METADATA_BODY_MAX) if e.fp else b"")
    except (urllib.error.URLError, OSError, ValueError):
        return None


def check_metadata(get=http_get, endpoints=METADATA_ENDPOINTS):
    """Every endpoint on the list: a body that holds the name or a key shape is a finding.  An endpoint that answers
    without one passes (reported in paths, so the report says what was reachable)."""
    f = Found()
    reachable = []
    for url, headers in endpoints:
        r = get(url, headers, METADATA_TIMEOUT_S)
        if r is None:
            continue
        status, body = r
        what = found(body)
        if what:
            f.add(url, what)
        elif len(reachable) < PATHS_MAX:
            reachable.append(show(url))
    ok, paths, detail = f.result()
    return (True, reachable, "ok") if ok else (ok, paths, detail)


# ---- 5. history
HISTORY_FILES = (".bash_history", ".python_history", ".zsh_history", ".sh_history", ".ash_history",
                 ".local/share/fish/fish_history", ".lesshst", ".viminfo", ".psql_history", ".mysql_history")


def check_history(root="/"):
    """Shell and tool histories of root and every user under /home: the name or a key shape is a finding."""
    f = Found()
    base = root.rstrip("/")
    homes = [base + "/root"]
    try:
        homes += [base + "/home/" + h for h in sorted(os.listdir(base + "/home"))]
    except OSError:
        pass
    for home in homes:
        for name in HISTORY_FILES:
            path = home + "/" + name
            try:
                what = scan_file(path) if os.path.isfile(path) and not os.path.islink(path) else None
            except OSError:
                f.add(path[len(base):] or path, "unreadable")
                continue
            if what:
                f.add(path[len(base):] or path, what)
    return f.result()
