# The probe's prologue (DESIGN.md section 1.5): PROBE ONLY, never in production.  The driver runs it as PID 1, before
# the unchanged production launcher (renderProbePrologue(salt) + renderBootScript(...)).  It reads the key the provider
# injected into this pod's environment, RUNPOD_API_KEY, and keeps only what is derived from it:
#   sha256("sbgpu-probe-capture-v1" NUL salt-bytes NUL key-bytes), the key's byte length, a coarse class set, and a
#   short public-looking prefix (or none),
# written to $SBGPU_PROBE_DIR/probe-capture (0600, created atomically, never replaced; the directory must be a real
# directory, not a link, owned by us and writable by nobody else).  The key itself goes only into
# a quoted shell variable and, through printf (a shell builtin: no argv), into python3's stdin; never into argv,
# command text, files, output or errors.  After a restart, the capture is computed again and must equal the stored one.
# Any failure, or no injected key at all, stops here (exit 2 or 3) before the launcher: fail closed.
# renderProbePrologue() puts these values in front of it:
#   SBGPU_PROBE_SALT   32 random bytes, 64 lowercase hex, per run
#   SBGPU_PROBE_DIR    where the capture goes: /opt/sbgpu (a test directory in tests)

set +x
umask 077
if [ -z "${RUNPOD_API_KEY-}" ]; then
  echo "sbgpu-probe: no injected key in the environment" >&2
  exit 2
fi
mkdir -p "$SBGPU_PROBE_DIR" || exit 2
sbgpu_probe_py=$(command -v python3) || exit 2
printf '%s\n%s' "$SBGPU_PROBE_SALT" "$RUNPOD_API_KEY" | "$sbgpu_probe_py" -I -S -c '
import hashlib, json, os, re, stat, sys
LABEL = b"sbgpu-probe-capture-v1"
def fail(code, why):
    sys.stderr.write("sbgpu-probe: capture " + why + "\n")
    os._exit(code)
try:
    data = sys.stdin.buffer.read(65536)
    nl = data.find(b"\n")
    if nl != 64 or not re.fullmatch(rb"[0-9a-f]{64}", data[:64]):
        fail(3, "salt")
    salt = bytes.fromhex(data[:64].decode("ascii"))
    key = data[65:]
    if not 16 <= len(key) <= 4096:
        fail(3, "length")
    digest = hashlib.sha256(LABEL + b"\0" + salt + b"\0" + key).hexdigest()
    classes = ""
    for name, test in (("d", lambda c: 48 <= c <= 57), ("h", lambda c: c == 45), ("l", lambda c: 97 <= c <= 122),
                       ("o", lambda c: not (48 <= c <= 57 or 65 <= c <= 90 or 97 <= c <= 122 or c in (45, 95))),
                       ("s", lambda c: c == 95), ("u", lambda c: 65 <= c <= 90)):
        if any(test(c) for c in key):
            classes += name
    m = re.match(rb"([A-Za-z0-9]{1,8})_", key)
    prefix = m.group(1).decode("ascii") if m and len(key) - m.end() >= 16 else None
    rec = json.dumps({"bytes": len(key), "classes": classes, "prefix": prefix, "salt": salt.hex(), "sha256": digest,
                      "v": 1}, separators=(",", ":"), sort_keys=True).encode("ascii")
    del key, data, m
    # (the directory itself: a real directory, not a link, ours and writable by us only; every name below is
    # opened relative to it, so nothing can swap it afterwards)
    dfd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    st = os.fstat(dfd)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.geteuid() or st.st_mode & 0o022:
        fail(3, "directory")
    path, tmp = "probe-capture", "probe-capture.tmp"
    try:
        os.unlink(tmp, dir_fd=dfd)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
    os.write(fd, rec)
    os.fsync(fd)
    os.close(fd)
    try:
        os.link(tmp, path, src_dir_fd=dfd, dst_dir_fd=dfd, follow_symlinks=False)  # (atomic, never replaces)
    except FileExistsError:
        st = os.stat(path, dir_fd=dfd, follow_symlinks=False)
        if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > 1024:
            fail(3, "file")
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=dfd)
        old = os.read(fd, 2048)
        os.close(fd)
        if old != rec:
            fail(3, "changed since the last boot")
    os.unlink(tmp, dir_fd=dfd)
except SystemExit:
    raise
except BaseException:
    fail(3, "error")
' "$SBGPU_PROBE_DIR" || exit 3
unset SBGPU_PROBE_SALT SBGPU_PROBE_DIR sbgpu_probe_py
