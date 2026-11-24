# The machine's launcher (DESIGN.md section 1).  renderBootCommand() (boot.ts) puts these values in front of it:
#   SBGPU_AGENT_URL     https URL of the agent tarball
#   SBGPU_AGENT_SHA256  its sha256, 64 lowercase hex, pinned per launch
#   SBGPU_CONTROL_URL   https URL of the control plane
#   SBGPU_MODE          container | vm
#   SBGPU_PREFIX        a path prefix for tests; empty on a real machine
# The provider's environment carries only SBGPU_BOOT_TOKEN.
#
# In container mode this is PID 1, the first code in the container.  It starts nothing in the background: every
# command below runs in the foreground and has exited before the final exec, which replaces this shell by the agent
# with an environment rebuilt from an allowlist (section 1.4).  Any failure exits 2 with nothing run.

umask 077
SBGPU_MAX_BYTES=16777216

fail() {
  echo "sbgpu-boot: $1" >&2
  exit 2
}

# The values this script was rendered with (boot.ts checks them too: this is the machine's own check).
case "$SBGPU_MODE" in
  container) ;;
  vm) fail "vm mode is not built yet" ;;
  *) fail "bad mode" ;;
esac
case "$SBGPU_AGENT_URL" in
  https://*) ;;
  *) fail "the agent URL must be https" ;;
esac
case "$SBGPU_CONTROL_URL" in
  https://*) ;;
  *) fail "the control URL must be https" ;;
esac
if [ "${#SBGPU_AGENT_SHA256}" -ne 64 ]; then fail "bad pinned sha256"; fi
case "$SBGPU_AGENT_SHA256" in
  *[!0-9a-f]*) fail "bad pinned sha256" ;;
esac

# The boot token: 32 random bytes, base64url without padding (43 characters).
token="${SBGPU_BOOT_TOKEN-}"
if [ "${#token}" -ne 43 ]; then fail "bad boot token"; fi
case "$token" in
  *[!A-Za-z0-9_-]*) fail "bad boot token" ;;
esac

# The provider's id for this machine, a cross-check at enroll only (DESIGN.md section 2).
pmid="${RUNPOD_POD_ID-}"
if [ "${#pmid}" -gt 64 ]; then pmid=""; fi
case "$pmid" in
  *[!A-Za-z0-9-]*) pmid="" ;;
esac

py=$(command -v python3) || fail "python3 is missing"

run="$SBGPU_PREFIX/run/sbgpu"
rm -rf "$run" || fail "can't clear $run"
mkdir -p "$run" || fail "can't make $run"
chmod 700 "$run" || fail "can't chmod $run"
tgz="$run/agent.tar.gz"

# Download, https only (curl's --proto covers its redirects too), at most SBGPU_MAX_BYTES, 3 tries.
fetch_curl() {
  curl -fsS --proto =https --location --max-redirs 3 --max-filesize "$SBGPU_MAX_BYTES" \
    --connect-timeout 10 --max-time 120 -o "$tgz" "$SBGPU_AGENT_URL"
}
fetch_python() {
  "$py" -I -S -c '
import sys, urllib.request
url, out, cap = sys.argv[1], sys.argv[2], int(sys.argv[3])
class Https(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith("https://"):
            raise OSError("redirect off https")
        return super().redirect_request(req, fp, code, msg, headers, newurl)
r = urllib.request.build_opener(Https).open(url, timeout=30)
data = r.read(cap + 1)
if len(data) > cap:
    raise OSError("too big")
with open(out, "wb") as f:
    f.write(data)
' "$SBGPU_AGENT_URL" "$tgz" "$SBGPU_MAX_BYTES"
}
got=no
for try in 1 2 3; do
  rm -f "$tgz"
  if command -v curl >/dev/null 2>&1; then
    if fetch_curl; then got=yes; break; fi
  else
    if fetch_python; then got=yes; break; fi
  fi
  sleep "$try"
done
[ "$got" = yes ] || fail "can't download the agent"
size=$(wc -c <"$tgz") || fail "can't size the download"
if [ "$size" -le 0 ] || [ "$size" -gt "$SBGPU_MAX_BYTES" ]; then fail "bad download size"; fi

# The pinned hash, compared in full.
if command -v sha256sum >/dev/null 2>&1; then
  sum=$(sha256sum "$tgz") || fail "can't hash the download"
  sum=${sum%% *}
else
  sum=$("$py" -I -S -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$tgz") ||
    fail "can't hash the download"
fi
if [ "$sum" != "$SBGPU_AGENT_SHA256" ]; then fail "the agent's sha256 doesn't match the pinned one"; fi

# Unpack: regular files and directories only, relative names, no "..".  (The bytes are pinned, so this guards
# against a bad release, not an attacker.)
listing=$(tar -tvzf "$tgz") || fail "can't list the agent tarball"
names=$(tar -tzf "$tgz") || fail "can't list the agent tarball"
echo "$listing" | while IFS= read -r line; do
  case "$line" in
    -* | d*) ;;
    *) exit 1 ;;
  esac
done || fail "the agent tarball has a link or special file"
echo "$names" | while IFS= read -r name; do
  case "$name" in
    /* | .. | ../* | */.. | */../*) exit 1 ;;
  esac
done || fail "the agent tarball has an unsafe name"
dir="$SBGPU_PREFIX/opt/sbgpu/agent/$SBGPU_AGENT_SHA256"
rm -rf "$dir" || fail "can't clear $dir"
mkdir -p "$dir" || fail "can't make $dir"
tar -xzf "$tgz" -C "$dir" --no-same-owner --no-same-permissions || fail "can't unpack the agent"
rm -f "$tgz"
[ -f "$dir/sbgpu-agent/__main__.py" ] || fail "the agent tarball has no sbgpu-agent/__main__.py"

# What the agent needs to enroll.  Every value here was checked above to need no JSON escaping.
cat >"$run/boot.json" <<EOF || fail "can't write boot.json"
{"controlUrl":"$SBGPU_CONTROL_URL","mode":"$SBGPU_MODE","bootToken":"$token","providerMachineId":"$pmid","agentSha256":"$SBGPU_AGENT_SHA256"}
EOF
chmod 600 "$run/boot.json" || fail "can't chmod boot.json"

# The agent's environment, built from nothing (section 1.4): fixed values, then a few names copied when present.
# No copied value may contain the provider's API key.  The key is compared here, in memory, and never written.
key="${RUNPOD_API_KEY-}"
set -- "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "HOME=/root" "LANG=C.UTF-8" \
  "SBGPU_PREFIX=$SBGPU_PREFIX"
for name in LD_LIBRARY_PATH CUDA_HOME CUDA_VERSION NVIDIA_VISIBLE_DEVICES NVIDIA_DRIVER_CAPABILITIES \
  NVIDIA_REQUIRE_CUDA NV_CUDA_LIB_VERSION PYTORCH_VERSION TZ; do
  eval "isset=\${$name+x}"
  [ -n "$isset" ] || continue
  value=""
  eval "value=\$$name"
  if [ -n "$key" ]; then
    case "$value" in
      *"$key"*) fail "an allowlisted variable holds the provider key" ;;
    esac
  fi
  set -- "$@" "$name=$value"
done
key=""
token=""
# (If the exec fails, a non-interactive shell exits with it.)
exec env -i "$@" "$py" -I -S "$dir/sbgpu-agent"
