#!/bin/sh
# Run inside the built image (CI does): every pinned piece is there, at its pinned version, and the launcher's tools
# are on the fixed PATH the agent gets.  No GPU is needed: torch must import and report its CUDA build, not find a GPU.
set -eu
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
for tool in sh python3 curl tar gzip sha256sum wc timeout env sed uv sagebrush; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
[ "$(command -v python3)" = /usr/bin/python3 ] || { echo "python3 is shadowed" >&2; exit 1; }
want() { grep -E "^$1==" /opt/sbgpu/lock/"$2" | sed -E 's/^[^=]+==([^ ]+).*/\1/'; }
[ "$(uv --version | cut -d' ' -f2)" = "$(want uv tools.txt)" ] || { echo "uv version" >&2; exit 1; }
/opt/sbgpu/env/bin/python - "$(want torch env.txt)" "$(want sagebrush env.txt)" <<'PY'
import sys
from importlib.metadata import version
import torch
want_torch, want_sb = sys.argv[1], sys.argv[2]
assert torch.__version__ == want_torch, (torch.__version__, want_torch)
assert torch.version.cuda == "12.6", torch.version.cuda
assert version("sagebrush") == want_sb, version("sagebrush")
print("torch", torch.__version__, "cuda", torch.version.cuda, "sagebrush", want_sb)
PY
sagebrush remote --help >/dev/null
echo "SMOKE OK"
