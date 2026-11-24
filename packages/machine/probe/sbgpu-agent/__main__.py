import os
import sys

# The launcher runs this directory with python3 -I -S, which keeps the directory itself on sys.path.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sbgpu_probe.main import main  # noqa: E402

main()
