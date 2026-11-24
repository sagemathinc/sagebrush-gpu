"""The probe's search for the injected key by its value (DESIGN.md section 1.5), from the capture the probe-only
prologue wrote before the launcher (src/boot/probe-prologue.sh): a salted digest of the key, its byte length, a
coarse class set and a short prefix (or none).  The probe never sees the key: it hashes candidate strings of the
key's exact length and shape and compares digests, so a hit means the exact value is there.

The capture file holds only data derived from the key; it is scanned like any other file, and nothing in it matches.
"""

import hashlib
import json
import os
import re
import stat

LABEL = b"sbgpu-probe-capture-v1"
CAPTURE_MAX = 1024
CLASSES = {
    "d": b"0-9",
    "h": b"\\-",
    "l": b"a-z",
    "s": b"_",
    "u": b"A-Z",
}
# ("other": every byte that isn't one of the classes above, as the prologue classes it: punctuation, space and other
# whitespace, control characters, DEL and high bytes (UTF-8 included); not NUL, which an environment value can't hold)
OTHER = rb"\x01-\x2c\x2e\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\xff"


class CaptureError(ValueError):
    """A capture that is missing, not as written, or malformed (never carries file content)."""


def load(path):
    """The capture's fields, checked: a regular file (not a link), mode 0600, at most CAPTURE_MAX bytes, exactly the
    prologue's keys and types, in its one serialization."""
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        raise CaptureError("missing")
    if not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) != 0o600 or st.st_size > CAPTURE_MAX:
        raise CaptureError("not as written")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        raw = os.read(fd, CAPTURE_MAX + 1)
    finally:
        os.close(fd)
    try:
        rec = json.loads(raw.decode("ascii"))
    except (ValueError, UnicodeDecodeError):
        raise CaptureError("not JSON")
    if not isinstance(rec, dict) or sorted(rec) != ["bytes", "classes", "prefix", "salt", "sha256", "v"] or rec["v"] != 1:
        raise CaptureError("keys")
    if json.dumps(rec, separators=(",", ":"), sort_keys=True).encode("ascii") != raw:
        raise CaptureError("not the one serialization")
    if not (isinstance(rec["salt"], str) and re.fullmatch(r"[0-9a-f]{64}", rec["salt"])):
        raise CaptureError("salt")
    if not (isinstance(rec["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", rec["sha256"])):
        raise CaptureError("sha256")
    if not (type(rec["bytes"]) is int and 16 <= rec["bytes"] <= 4096):
        raise CaptureError("bytes")
    c = rec["classes"]
    if not (isinstance(c, str) and c and re.fullmatch(r"d?h?l?o?s?u?", c)):
        raise CaptureError("classes")
    p = rec["prefix"]
    if p is not None and not (isinstance(p, str) and re.fullmatch(r"[A-Za-z0-9]{1,8}", p) and "s" in c):
        raise CaptureError("prefix")
    return rec


def shape(rec):
    """The observed shape, for the report: v<bytes>-<prefix or none>-<classes>, all [a-z0-9-] (a prefix that isn't
    lowercase alphanumeric is reported by its length only, pN)."""
    p = rec["prefix"]
    if p is None:
        ps = "none"
    elif re.fullmatch(r"[a-z0-9]+", p):
        ps = p
    else:
        ps = "p%d" % len(p)
    return "v%d-%s-%s" % (rec["bytes"], ps, rec["classes"])


class Matcher:
    """Finds the exact key in bytes, by its digest: every window of the key's length within a run of its character
    classes (embedded and overlapping occurrences alike), each hashed as the prologue hashed the key.  With a prefix,
    only windows that start with it are hashed."""

    def __init__(self, rec):
        self.n = rec["bytes"]
        self.salt = bytes.fromhex(rec["salt"])
        self.digest = rec["sha256"]
        chars = b"".join(CLASSES[k] for k in rec["classes"] if k != "o")
        if "o" in rec["classes"]:
            chars += OTHER
        self.run = re.compile(b"[" + chars + b"]{%d,}" % self.n)
        self.lead = (rec["prefix"].encode("ascii") + b"_") if rec["prefix"] else None
        self.hashed = 0

    def _is(self, window):
        self.hashed += 1
        return hashlib.sha256(LABEL + b"\0" + self.salt + b"\0" + window).hexdigest() == self.digest

    def spans(self, data):
        """(start, end) of every occurrence of the key in data."""
        out = []
        for m in self.run.finditer(data):
            s, e = m.span()
            if self.lead is None:
                starts = range(s, e - self.n + 1)
            else:
                starts = []
                i = data.find(self.lead, s, e)
                while i != -1 and i + self.n <= e:
                    starts.append(i)
                    i = data.find(self.lead, i + 1, e)
            for i in starts:
                if self._is(bytes(data[i:i + self.n])):
                    out.append((i, i + self.n))
        return out

    def found(self, data):
        return bool(self.spans(data))

    def redact(self, data):
        """data with every occurrence of the key replaced by <value>."""
        spans = self.spans(data)
        if not spans:
            return data
        out, at = bytearray(), 0
        for s, e in spans:
            if s < at:
                continue
            out += data[at:s] + b"<value>"
            at = e
        return bytes(out + data[at:])
