#!/bin/sh
# Regenerates env.txt and tools.txt from env.in and tools.in (hash-pinned, for the image's python 3.12 on x86_64).
#   sh packages/machine/image/lock.sh
set -eu
cd "$(dirname "$0")"
uv pip compile env.in --generate-hashes --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
  --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple \
  --index-strategy unsafe-best-match -o env.txt
uv pip compile tools.in --generate-hashes --python-version 3.12 --python-platform x86_64-manylinux_2_28 -o tools.txt
