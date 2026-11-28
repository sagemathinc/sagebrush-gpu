# VM mode's launcher (the launcher's design note r4).  Not reachable yet: renderBootScript's VM branch still renders
# bootstrap.sh, which refuses VM mode, and the tests run this script directly.  renderBootScript puts in front of it,
# first, the two protections (a 077 umask and no core files, each read back: step 0), then these values:
#   SBGPU_AGENT_URL     https URL of the agent tarball
#   SBGPU_AGENT_SHA256  its sha256, 64 lowercase hex, pinned per launch
#   SBGPU_CONTROL_URL   https URL of the control plane
#   SBGPU_MODE          vm
#   SBGPU_MACHINE_ID    the machine's id
#   SBGPU_NONCE         the launch's single-use nonce: never exported, never an argument; only ever on a child's stdin
#   SBGPU_PREFIX        a path prefix for tests; empty on a real machine
#
# It runs once, as root, from cloud-init.  Every step runs in the foreground.  The first failure prints one line of
# fixed words, SBGPU-BOOT {"v":1,"ok":false,"step":"<step>","fail":["<word>"]}, and exits: 2 for a local failure, 3
# for the announce, 4 for a rerun.  Nothing retries but the agent's download; control's watchdog ends a machine that
# never enrolls.  The boot token never reaches this shell: only its digest does.

SBGPU_MAX_BYTES=16777216

fail() {
  printf 'SBGPU-BOOT {"v":1,"ok":false,"step":"%s","fail":["%s"]}\n' "$1" "$2" >&2
  exit "${3:-2}"
}

# 1. once: a create-only marker on persistent disk; a second run stops here, before anything else.
py=$(command -v python3) || fail once once
"$py" -I -S -c '
import os, stat, sys
prefix = sys.argv[1]
uid = 0 if prefix == "" else os.geteuid()
flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
lib = os.open(prefix + "/var/lib", flags)
lib_dev = os.fstat(lib).st_dev
try:
    os.mkdir("sbgpu", 0o700, dir_fd=lib)
except FileExistsError:
    pass
d = os.open("sbgpu", flags, dir_fd=lib)
st = os.fstat(d)
if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o700 or st.st_dev != lib_dev:
    sys.exit(2)
try:
    f = os.open("boot-ran", os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_WRONLY | os.O_CLOEXEC, 0o600, dir_fd=d)
except FileExistsError:
    sys.exit(4)
os.fsync(f)
os.fsync(d)
' "$SBGPU_PREFIX" 2>/dev/null
case $? in
  0) ;;
  4) fail once rerun 4 ;;
  *) fail once once ;;
esac

# 2. values: the rendered values, each in its exact shape (boot.ts checks them too: this is the machine's own check).
[ "$SBGPU_MODE" = vm ] || fail values values
case "$SBGPU_AGENT_URL" in
  https://*) ;;
  *) fail values values ;;
esac
case "$SBGPU_CONTROL_URL" in
  https://*) ;;
  *) fail values values ;;
esac
[ "${#SBGPU_AGENT_SHA256}" -eq 64 ] || fail values values
case "$SBGPU_AGENT_SHA256" in
  *[!0-9a-f]*) fail values values ;;
esac
[ "${#SBGPU_MACHINE_ID}" -eq 24 ] || fail values values
case "$SBGPU_MACHINE_ID" in
  mch_*) ;;
  *) fail values values ;;
esac
case "${SBGPU_MACHINE_ID#mch_}" in
  *[!0123456789abcdefghjkmnpqrstvwxyz]*) fail values values ;;
esac
[ "${#SBGPU_NONCE}" -eq 22 ] || fail values values
case "$SBGPU_NONCE" in
  *[!A-Za-z0-9_-]*) fail values values ;;
esac
for tool in env timeout tar sed; do
  command -v "$tool" >/dev/null 2>&1 || fail values values
done

# 3. self: the sha256 of this script's own delivered bytes ($0: a regular file, root's, not group- or other-writable,
# at most 64 KiB, opened without following a link).  A delivery measurement, not attestation.
selfsha=$("$py" -I -S -c '
import hashlib, os, stat, sys
prefix, path = sys.argv[1], sys.argv[2]
fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_uid != (0 if prefix == "" else os.geteuid()) or st.st_mode & 0o022:
    sys.exit(1)
data = b""
while len(data) <= 65536:
    chunk = os.read(fd, 65537 - len(data))
    if not chunk:
        break
    data += chunk
if len(data) > 65536:
    sys.exit(1)
print(hashlib.sha256(data).hexdigest())
' "$SBGPU_PREFIX" "$0" 2>/dev/null) || fail self self
[ "${#selfsha}" -eq 64 ] || fail self self

# 4. agent: download (https only, at most SBGPU_MAX_BYTES, 3 tries), the pinned hash, unpack: as container mode does,
# but into the marker's directory, and into a directory made fresh (nothing is removed first).
state="$SBGPU_PREFIX/var/lib/sbgpu"
tgz="$state/agent.tar.gz"
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
    if fetch_curl 2>/dev/null; then got=yes; break; fi
  else
    if fetch_python 2>/dev/null; then got=yes; break; fi
  fi
  sleep "$try"
done
[ "$got" = yes ] || fail agent agent
size=$(wc -c <"$tgz") || fail agent agent
if [ "$size" -le 0 ] || [ "$size" -gt "$SBGPU_MAX_BYTES" ]; then fail agent agent; fi
sum=$("$py" -I -S -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$tgz") ||
  fail agent agent
[ "$sum" = "$SBGPU_AGENT_SHA256" ] || fail agent agent
listing=$(tar -tvzf "$tgz" 2>/dev/null) || fail agent agent
names=$(tar -tzf "$tgz" 2>/dev/null) || fail agent agent
echo "$listing" | while IFS= read -r line; do
  case "$line" in
    -* | d*) ;;
    *) exit 1 ;;
  esac
done || fail agent agent
echo "$names" | while IFS= read -r name; do
  case "$name" in
    /* | .. | ../* | */.. | */../*) exit 1 ;;
  esac
done || fail agent agent
agentdir="$state/agent"
mkdir "$agentdir" 2>/dev/null || fail agent agent
tar -xzf "$tgz" -C "$agentdir" --no-same-owner --no-same-permissions 2>/dev/null || fail agent agent
rm -f "$tgz"
agent="$agentdir/sbgpu-agent"
[ -f "$agent/__main__.py" ] && [ -f "$agent/sbgpu_agent/vmboot.py" ] || fail agent agent
allow="$agent/image-allowlist.json"
# (runs one of the agent's modules: `"$py" -I -S -c "$load" "$agent" MODULE ARGS...`)
load='import sys; sys.path.insert(0, sys.argv.pop(1)); import importlib; m = importlib.import_module("sbgpu_agent." + sys.argv.pop(1)); raise SystemExit(m.main(sys.argv[1:]))'
pass1='SBGPU-GATE {"v":1,"pass":true,"fail":[]}'

# 5. neutralise: N1-N9, ssh first.  Its word, from its own closed list, becomes part of the boot's.
nline=$("$py" -I -S -c "$load" "$agent" neutralise "$allow" 2>/dev/null)
nrc=$?
if [ "$nrc" -ne 0 ] || [ "$nline" != 'SBGPU-NEUTRALISE {"v":1,"ok":true,"fail":[]}' ]; then
  word=$(printf '%s\n' "$nline" | sed -n 's/^SBGPU-NEUTRALISE {"v":1,"ok":false,"fail":\["\([a-z]*\)".*$/\1/p')
  case "$word" in
    units | sessions | keys | passwords | sudo | metadata | unreadable) ;;
    *) word=unreadable ;;
  esac
  fail neutralise "neutralise:$word"
fi

# 6. gate 1: the nonce's digest its only known value (on stdin).
noncesha=$(printf '%s' "$SBGPU_NONCE" | "$py" -I -S -c "$load" "$agent" vmboot digest 2>/dev/null) || fail gate1 gate1
[ "${#noncesha}" -eq 64 ] || fail gate1 gate1
g1=$(printf '{"known":[{"sha256":"%s","bytes":22}]}' "$noncesha" | "$py" -I -S -c "$load" "$agent" vmgate "$allow" 2>/dev/null) ||
  fail gate1 gate1
[ "$g1" = "$pass1" ] || fail gate1 gate1

# 7, 8. announce, then boot.json: one child, under a hard bound, the nonce on its stdin.  It prints /run/sbgpu's device
# and inode once it has made it (so a later failure can remove what it wrote, and nothing else), then the token's
# digest and the deadline D.
# Each `timeout -s KILL` runs in a { ...; } 2>/dev/null group: an older GNU timeout (coreutils 9.1) signals its own
# process group too, so it dies by SIGKILL and the shell would report "Killed" on stderr, breaking the one-line rule.
# The group sends that report nowhere; the children's own stderr already goes to /dev/null.
out=$({ printf '%s\n' "$SBGPU_NONCE" | timeout -s KILL 45 "$py" -I -S -c "$load" "$agent" vmboot announce \
  "$SBGPU_PREFIX" "$SBGPU_CONTROL_URL" "$SBGPU_MACHINE_ID" "$selfsha" "$SBGPU_AGENT_SHA256" 2>/dev/null; } 2>/dev/null)
arc=$?
dirid=$(printf '%s\n' "$out" | sed -n 's/^dir \([0-9][0-9]*\) \([0-9][0-9]*\)$/\1 \2/p')
# After a failure past this point: boot.json, gate.json and their temp files are removed (and only those).
late() {
  if [ -n "$dirid" ]; then
    # shellcheck disable=SC2086 # (two numbers)
    "$py" -I -S -c "$load" "$agent" vmboot scrub "$SBGPU_PREFIX" $dirid >/dev/null 2>&1
  fi
  fail "$@"
}
case $arc in
  0) ;;
  2) late bootfile bootfile ;;
  *) late announce announce 3 ;;
esac
okline=$(printf '%s\n' "$out" | sed -n 's/^ok \([0-9a-f]\{64\}\) \([0-9][0-9]*\)$/\1 \2/p')
tokensha=${okline% *}
deadline=${okline#* }
[ -n "$dirid" ] && [ "${#tokensha}" -eq 64 ] && [ -n "$deadline" ] || late bootfile bootfile

# 9. gate 2: both digests known; killed at D minus 30 s, and not started at all past it.  Its line becomes gate.json,
# written by D (and killed at D minus 25 s).
secs=$("$py" -I -S -c "$load" "$agent" vmboot remaining "$deadline" 30 2>/dev/null) || late gate2 gate2
g2=$({ printf '{"known":[{"sha256":"%s","bytes":22},{"sha256":"%s","bytes":43}]}' "$noncesha" "$tokensha" |
  timeout -s KILL "$secs" "$py" -I -S -c "$load" "$agent" vmgate "$allow" 2>/dev/null; } 2>/dev/null) || late gate2 gate2
[ "$g2" = "$pass1" ] || late gate2 gate2
secs=$("$py" -I -S -c "$load" "$agent" vmboot remaining "$deadline" 25 2>/dev/null) || late gate2 gate2
# shellcheck disable=SC2086 # (two numbers)
{ printf '%s\n' "$g2" | timeout -s KILL "$secs" "$py" -I -S -c "$load" "$agent" vmboot gatefile "$SBGPU_PREFIX" \
  "$deadline" $dirid >/dev/null 2>&1; } 2>/dev/null || late gate2 gate2

# 10. exec: the agent replaces this shell, with an environment built from nothing.  It reads both files once, removes
# them, and holds to D itself.
SBGPU_NONCE=""
printf '%s\n' 'SBGPU-BOOT {"v":1,"ok":true}' >&2
exec env -i "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" "HOME=/root" "LANG=C.UTF-8" \
  "SBGPU_PREFIX=$SBGPU_PREFIX" "$py" -I -S "$agent" vm
