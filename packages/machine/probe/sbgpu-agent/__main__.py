import os
import sys

# No bytecode, before anything of the probe is imported: its .pyc files would be on the filesystem it scans.  (Its
# markers are also built so the compiler can't fold them; this keeps the tree exactly the tarball's.)
sys.dont_write_bytecode = True
# The launcher runs this directory with python3 -I -S, which keeps the directory itself on sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sbgpu_probe.main import main  # noqa: E402

main()
