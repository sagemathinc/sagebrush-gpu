# The machine image for container mode (RunPod) and the userland for VM mode: CUDA (from the PyTorch wheels), PyTorch,
# uv, and `sagebrush remote`, every byte pinned.  DESIGN.md section 4.3; lock.sh regenerates the two lock files.
#   base:   ubuntu 24.04, by digest
#   apt:    from snapshot.ubuntu.com at one fixed instant, so a rebuild gets the same packages
#   tools:  uv, hash-pinned (tools.txt), in its own venv
#   env:    /opt/sbgpu/env, torch for CUDA 12.6 and the sagebrush CLI, hash-pinned (env.txt)
# The launcher needs only python3, sh, curl (or its python fallback), tar, gzip, sha256sum, wc, timeout and env, all
# here.  Nothing on the image's PATH shadows the system python3 the launcher and agent run on.
FROM ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b

ARG APT_SNAPSHOT=20261126T000000Z
ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8

RUN apt-get update --snapshot "$APT_SNAPSHOT" \
 && apt-get install -y --no-install-recommends --snapshot "$APT_SNAPSHOT" \
      python3 python3-venv ca-certificates curl tar gzip coreutils \
 && rm -rf /var/lib/apt/lists/*

COPY tools.txt env.txt /opt/sbgpu/lock/

# uv itself, hash-checked, in a venv of its own
RUN python3 -m venv /opt/sbgpu/tools \
 && /opt/sbgpu/tools/bin/pip install --no-cache-dir --no-deps --require-hashes -r /opt/sbgpu/lock/tools.txt \
 && ln -s /opt/sbgpu/tools/bin/uv /usr/local/bin/uv

# the member's environment: torch (CUDA 12.6 wheels, which carry the CUDA libraries) and sagebrush, hash-checked
RUN uv venv --python /usr/bin/python3 /opt/sbgpu/env \
 && uv pip install --python /opt/sbgpu/env/bin/python --no-cache --require-hashes --no-deps \
      --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple \
      --index-strategy unsafe-best-match -r /opt/sbgpu/lock/env.txt \
 && ln -s /opt/sbgpu/env/bin/sagebrush /usr/local/bin/sagebrush

COPY smoke.sh /opt/sbgpu/smoke.sh
