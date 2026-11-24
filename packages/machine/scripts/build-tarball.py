#!/usr/bin/env python3
"""Build an agent tarball the launcher accepts (DESIGN.md section 1.2), byte for byte reproducible, and print its
sha256 (the value control pins per launch):

    python3 -I packages/machine/scripts/build-tarball.py packages/machine/agent/sbgpu-agent agent.tar.gz
    python3 -I packages/machine/scripts/build-tarball.py packages/machine/probe/sbgpu-agent probe.tar.gz

The tarball holds one directory, sbgpu-agent/, with the source directory's files: regular files and directories only,
no tests, no bytecode; names sorted, owner 0:0, mode 0644 (0755 for directories), mtime 0; gzip without a name or a
time.  So the same source always gives the same bytes, and the same sha256.
"""

import gzip
import hashlib
import io
import os
import sys
import tarfile

TOP = "sbgpu-agent"
SKIP_DIRS = {"tests", "__pycache__"}
SKIP_SUFFIXES = (".pyc", ".pyo")


def entries(src):
    """(archive name, path or None for a directory), sorted, under TOP."""
    out = [(TOP, None)]
    for dirpath, dirnames, filenames in os.walk(src):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        rel = os.path.relpath(dirpath, src)
        for d in dirnames:
            p = os.path.join(dirpath, d)
            if os.path.islink(p):
                raise SystemExit("a symlink in the source: %s" % p)
            out.append((os.path.normpath(os.path.join(TOP, rel, d)), None))
        for f in sorted(filenames):
            p = os.path.join(dirpath, f)
            if f.endswith(SKIP_SUFFIXES):
                continue
            if os.path.islink(p) or not os.path.isfile(p):
                raise SystemExit("not a regular file: %s" % p)
            out.append((os.path.normpath(os.path.join(TOP, rel, f)), p))
    return sorted(out)


def build(src):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for name, path in entries(src):
            info = tarfile.TarInfo(name)
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = 0
            if path is None:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                t.addfile(info)
            else:
                with open(path, "rb") as f:
                    data = f.read()
                info.size = len(data)
                info.mode = 0o644
                t.addfile(info, io.BytesIO(data))
    gz = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=gz, mtime=0, compresslevel=9) as g:
        g.write(raw.getvalue())
    return gz.getvalue()


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: build-tarball.py SOURCE_DIR OUT.tar.gz")
    src, out = argv[1], argv[2]
    if not os.path.isfile(os.path.join(src, "__main__.py")):
        raise SystemExit("the source has no __main__.py")
    data = build(src)
    with open(out, "wb") as f:
        f.write(data)
    print("%s  %s  %d bytes" % (hashlib.sha256(data).hexdigest(), out, len(data)))


if __name__ == "__main__":
    main(sys.argv)
