"""The probe-only prologue (src/boot/probe-prologue.sh, run for real with sh) and the probe's value search
(sbgpu_probe/capture.py): the capture's content and file, its fail-closed cases, restarts, and finding the exact key
(embedded, overlapping, across chunks, in every check) without ever printing it.
"""

import hashlib
import io
import json
import os
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sbgpu_probe import capture, checks, main  # noqa: E402

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROLOGUE = os.path.join(os.path.dirname(os.path.dirname(HERE)), "src", "boot", "probe-prologue.sh")
# (keys made at run time: joined, never a constant in this file or its bytecode)
ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def random_key(prefix="", n=40, chars=ALNUM):
    body = "".join(secrets.choice(chars) for _ in range(n))
    return "_".join((prefix, body)) if prefix else body


CLEAN_NET = tempfile.mkdtemp(prefix="sbgpu-net-")  # (socket tables where nothing listens on 22)
for _n in ("tcp", "tcp6"):
    with open(os.path.join(CLEAN_NET, _n), "w") as _f:
        _f.write("  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n")


def run_prologue(d, key, salt=None, extra_env=None, net=CLEAN_NET):
    salt = salt or secrets.token_hex(32)
    with open(PROLOGUE) as f:
        script = "SBGPU_PROBE_SALT='%s'\nSBGPU_PROBE_DIR='%s'\nSBGPU_PROBE_NET='%s'\n" % (salt, d, net) + f.read()
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
    if key is not None:
        env["RUNPOD" + "_API_KEY"] = key
    env.update(extra_env or {})
    r = subprocess.run(["/bin/sh", "-c", script], env=env, capture_output=True)
    return r, salt


def expected_digest(salt, key):
    kb = key if isinstance(key, bytes) else key.encode()
    return hashlib.sha256(capture.LABEL + b"\0" + bytes.fromhex(salt) + b"\0" + kb).hexdigest()


class Base(unittest.TestCase):
    def tmp(self):
        d = tempfile.mkdtemp(prefix="sbgpu-capture-")
        self.addCleanup(shutil.rmtree, d)
        return d


class PrologueTest(Base):
    def test_the_capture(self):
        d = self.tmp()
        key = random_key("rpa", 40)
        r, salt = run_prologue(d, key)
        self.assertEqual(r.returncode, 0, r.stderr)
        path = d + "/probe-capture"
        st = os.lstat(path)
        self.assertTrue(stat.S_ISREG(st.st_mode))
        self.assertEqual(stat.S_IMODE(st.st_mode), 0o600)
        rec = capture.load(path)
        self.assertEqual(rec, {"v": 1, "salt": salt, "sha256": expected_digest(salt, key), "bytes": 44,
                               "prefix": "rpa", "classes": "dlsu"})
        self.assertEqual(capture.shape(rec), "v44-rpa-dlsu")
        with open(path, "rb") as f:
            self.assertNotIn(key.encode(), f.read())
        self.assertNotIn(key.encode(), r.stdout + r.stderr)
        self.assertFalse(os.path.exists(path + ".tmp"))

    def test_the_prefix_rule(self):
        for key, want in [
            (random_key("rpa", 16), "rpa"),                      # (exactly 16 after the underscore)
            (random_key("rpa", 15), None),                       # (fewer)
            (random_key("abcdefgh", 20), "abcdefgh"),            # (8 characters)
            (random_key("abcdefghi", 20), None),                 # (9: not a short prefix)
            (random_key("", 40), None),                          # (no underscore)
            ("_" + random_key("", 30), None),                    # (empty prefix)
            (random_key("a-b", 20), None),                       # (not alphanumeric)
        ]:
            d = self.tmp()
            r, _ = run_prologue(d, key)
            self.assertEqual(r.returncode, 0, (key[:3], r.stderr))
            self.assertEqual(capture.load(d + "/probe-capture")["prefix"], want, len(key))

    def test_classes_and_byte_length(self):
        d = self.tmp()
        key = "ab-CD_12.x" + random_key("", 20, "xyz") + "é"  # (a 2-byte character: bytes, not characters)
        r, salt = run_prologue(d, key)
        self.assertEqual(r.returncode, 0, r.stderr)
        rec = capture.load(d + "/probe-capture")
        self.assertEqual(rec["bytes"], len(key.encode()))
        self.assertEqual(rec["classes"], "dhlosu")
        self.assertEqual(rec["sha256"], expected_digest(salt, key))

    def test_port_22_is_checked_before_the_key_is_touched(self):
        from test_probe import write_net, row4, row6
        key = random_key("rpa")
        for rows4, rows6 in (([row4(0, "00000000", "0016", "0A")], []), ([], [row6(0, "0" * 32, "0016", "0A")])):
            d, net = self.tmp(), self.tmp()
            write_net(net, rows4, rows6)
            r, _ = run_prologue(d, key, net=net + "/net")
            self.assertEqual(r.returncode, 3)
            self.assertEqual(r.stderr, b"sbgpu-probe: a listener on port 22, or /proc/net unreadable\n")
            self.assertEqual(os.listdir(d), [])
            self.assertNotIn(key.encode(), r.stdout + r.stderr)
            # (before the key at all: with no key, still 3, not the no-key 2)
            r, _ = run_prologue(d, None, net=net + "/net")
            self.assertEqual(r.returncode, 3)
        # (unreadable or malformed tables: the same)
        for case in ("no tcp6", "a bad row"):
            d, net = self.tmp(), self.tmp()
            write_net(net, [row4(0, "00000000", "1F90", "0A")])
            if case == "no tcp6":
                os.unlink(net + "/net/tcp6")
            else:
                with open(net + "/net/tcp", "a") as f:
                    f.write("   1: zz\n")
            r, _ = run_prologue(d, key, net=net + "/net")
            self.assertEqual(r.returncode, 3, case)
            self.assertEqual(os.listdir(d), [], case)
        # (a table past 4 MiB, every row harmless: unreadable, the same)
        d, net = self.tmp(), self.tmp()
        write_net(net, [row4(i % 9999, "00000000", "1F90", "0A") for i in range(4 * 1024 * 1024 // 120 + 10)])
        self.assertGreater(os.path.getsize(net + "/net/tcp"), 4 * 1024 * 1024)
        r, _ = run_prologue(d, key, net=net + "/net")
        self.assertEqual(r.returncode, 3)
        # (the control: other listeners, and 22 not listening, pass)
        d, net = self.tmp(), self.tmp()
        write_net(net, [row4(0, "00000000", "1F90", "0A"), row4(1, "0A000002", "0016", "01", rport="D431")],
                  [row6(0, "0" * 32, "0017", "0A")])
        r, _ = run_prologue(d, key, net=net + "/net")
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_fails_closed(self):
        d = self.tmp()
        for key, code in [(None, 2), ("", 2), ("short", 3), ("x" * 5000, 3)]:
            r, _ = run_prologue(d, key)
            self.assertEqual(r.returncode, code, key and len(key))
            self.assertFalse(os.path.exists(d + "/probe-capture"))
            if key:
                self.assertNotIn(key.encode(), r.stdout + r.stderr)
        r, _ = run_prologue(d, random_key("rpa"), salt="0" * 63 + "g")
        self.assertNotEqual(r.returncode, 0)

    def test_a_restart_must_find_the_same_capture(self):
        d = self.tmp()
        key = random_key("rpa")
        r, salt = run_prologue(d, key)
        self.assertEqual(r.returncode, 0)
        with open(d + "/probe-capture", "rb") as f:
            first = f.read()
        r2, _ = run_prologue(d, key, salt=salt)
        self.assertEqual(r2.returncode, 0, r2.stderr)
        with open(d + "/probe-capture", "rb") as f:
            self.assertEqual(f.read(), first)
        other = random_key("rpa")
        r3, _ = run_prologue(d, other, salt=salt)
        self.assertEqual(r3.returncode, 3)
        self.assertIn(b"changed since the last boot", r3.stderr)
        self.assertNotIn(other.encode(), r3.stdout + r3.stderr)
        with open(d + "/probe-capture", "rb") as f:
            self.assertEqual(f.read(), first)  # (never replaced)

    def test_a_link_or_a_loose_file_at_the_capture_path_fails(self):
        d = self.tmp()
        target = d + "/elsewhere"
        open(target, "w").close()
        os.symlink(target, d + "/probe-capture")
        r, _ = run_prologue(d, random_key("rpa"))
        self.assertEqual(r.returncode, 3)
        self.assertEqual(os.path.getsize(target), 0)
        d2 = self.tmp()
        with open(d2 + "/probe-capture", "w") as f:
            f.write("{}")
        os.chmod(d2 + "/probe-capture", 0o644)
        r, _ = run_prologue(d2, random_key("rpa"))
        self.assertEqual(r.returncode, 3)

    def test_the_directory_must_be_a_real_private_directory(self):
        # a link to a directory: refused, and nothing written through it
        d = self.tmp()
        os.mkdir(d + "/real", 0o700)
        os.symlink(d + "/real", d + "/link")
        r, _ = run_prologue(d + "/link", random_key("rpa"))
        self.assertEqual(r.returncode, 3)
        self.assertIn(b"capture", r.stderr)
        self.assertEqual(os.listdir(d + "/real"), [])
        # a directory others can write to: refused
        for mode in (0o720, 0o702):
            d2 = self.tmp()
            os.chmod(d2, mode)
            r, _ = run_prologue(d2, random_key("rpa"))
            self.assertEqual(r.returncode, 3, oct(mode))
            self.assertEqual(os.listdir(d2), [])
        # (a private one, 0700 or 0755, is accepted)
        d3 = self.tmp()
        os.chmod(d3, 0o755)
        self.assertEqual(run_prologue(d3, random_key("rpa"))[0].returncode, 0)

    def test_the_launcher_follows_and_sees_the_key_unchanged(self):
        # (the prologue unsets only its own variables: the launcher still has the injected key for its own check)
        d = self.tmp()
        key = random_key("rpa")
        with open(PROLOGUE) as f:
            script = "SBGPU_PROBE_SALT='%s'\nSBGPU_PROBE_DIR='%s'\nSBGPU_PROBE_NET='%s'\n" % (secrets.token_hex(32), d,
                                                                                         CLEAN_NET) + f.read()
        script += ('test "${' + "RUNPOD" + '_API_KEY-}" = "$EXPECT" && '
                   'test -z "${SBGPU_PROBE_SALT-}${SBGPU_PROBE_DIR-}${SBGPU_PROBE_NET-}" && echo fell-through\n')
        r = subprocess.run(["/bin/sh", "-c", script], env={"PATH": os.environ["PATH"], "RUNPOD" + "_API_KEY": key, "EXPECT": key},
                           capture_output=True)
        self.assertEqual(r.stdout, b"fell-through\n", r.stderr)


class LoadTest(Base):
    def capture_file(self, rec=None, mode=0o600, raw=None):
        d = self.tmp()
        p = d + "/probe-capture"
        rec = rec or {"bytes": 44, "classes": "dlsu", "prefix": "rpa", "salt": "a" * 64, "sha256": "b" * 64, "v": 1}
        with open(p, "wb") as f:
            f.write(raw if raw is not None else json.dumps(rec, separators=(",", ":"), sort_keys=True).encode())
        os.chmod(p, mode)
        return p

    def test_valid_and_invalid(self):
        self.assertEqual(capture.load(self.capture_file())["bytes"], 44)
        good = {"bytes": 44, "classes": "dlsu", "prefix": "rpa", "salt": "a" * 64, "sha256": "b" * 64, "v": 1}
        for why, kw in [
            ("mode", {"mode": 0o644}),
            ("an extra key", {"rec": dict(good, x=1)}),
            ("not canonical", {"raw": json.dumps(good).encode()}),
            ("big", {"raw": b" " * 2000}),
            ("salt", {"rec": dict(good, salt="A" * 64)}),
            ("bytes", {"rec": dict(good, bytes=15)}),
            ("classes", {"rec": dict(good, classes="ld")}),
            ("prefix without underscore class", {"rec": dict(good, classes="dlu")}),
            ("prefix too long", {"rec": dict(good, prefix="abcdefghi")}),
        ]:
            with self.assertRaises(capture.CaptureError, msg=why):
                capture.load(self.capture_file(**kw))
        d = self.tmp()
        os.symlink(self.capture_file(), d + "/probe-capture")
        with self.assertRaises(capture.CaptureError):
            capture.load(d + "/probe-capture")
        with self.assertRaisesRegex(capture.CaptureError, "missing"):
            capture.load(d + "/nothing")


def matcher_for(key, salt=None, prefix="auto"):
    salt = salt or secrets.token_hex(32)
    kb = key.encode()
    import re
    m = re.match(rb"([A-Za-z0-9]{1,8})_", kb)
    p = m.group(1).decode() if m and len(kb) - m.end() >= 16 else None
    classes = ""
    for name, test in (("d", bytes.isdigit), ("h", lambda c: c == b"-"), ("l", bytes.islower), ("o", lambda c: not c.isalnum() and c not in (b"-", b"_")),
                       ("s", lambda c: c == b"_"), ("u", bytes.isupper)):
        if any(test(bytes([c])) for c in kb):
            classes += name
    rec = {"v": 1, "salt": salt, "sha256": expected_digest(salt, key), "bytes": len(kb), "prefix": p, "classes": classes}
    return capture.Matcher(rec), rec


class MatcherTest(Base):
    def test_embedded_overlapping_and_near_misses(self):
        key = random_key("rpa", 40)
        m, _ = matcher_for(key)
        kb = key.encode()
        self.assertTrue(m.found(kb))
        self.assertTrue(m.found(b"export X=" + kb + b"\n"))
        self.assertTrue(m.found(b"abc" + kb + b"xyz123"))               # (embedded in a longer run)
        self.assertTrue(m.found(b"rpa_rpa_" + kb))                       # (the prefix occurring before, overlapping)
        self.assertEqual(m.spans(b"zz" + kb + kb), [(2, 2 + len(kb)), (2 + len(kb), 2 + 2 * len(kb))])
        flipped = kb[:-1] + (b"A" if kb[-1:] != b"A" else b"B")
        self.assertFalse(m.found(flipped))
        self.assertFalse(m.found(kb[:-1]))
        self.assertFalse(m.found(b""))

    def test_no_prefix_windows_everywhere_in_a_run(self):
        key = random_key("", 32)
        m, rec = matcher_for(key)
        self.assertIsNone(rec["prefix"])
        self.assertTrue(m.found(b"AAAA" + key.encode() + b"BBBB"))
        self.assertTrue(m.found(b"\x00\xff" + key.encode()))
        self.assertGreaterEqual(m.hashed, 9)

    def test_redaction_and_sanitize_order(self):
        key = random_key("rpa", 40)
        m, _ = matcher_for(key)
        self.assertEqual(m.redact(b"/a/" + key.encode() + b"/b"), b"/a/<value>/b")
        checks.MATCHER = m
        try:
            out = checks.show("/etc/" + key + "/x")
            self.assertEqual(out, "/etc/<value>/x")
            self.assertIsNone(checks.found(out.encode()))
        finally:
            checks.MATCHER = None


# (every byte an environment value can hold, as bytes, made at run time)
ALL_BYTES = bytes(range(1, 256))


class OtherBytesTest(Base):
    """Keys with bytes of the "other" class beyond ASCII punctuation (space, whitespace, control, DEL, high and UTF-8
    bytes): the real prologue captures them, and the matcher finds, redacts and hides the exact bytes."""

    def keys(self):
        x = random_key("", 20, "x").encode()
        out = [x + "\u00e9".encode(), x + b" ", x + b"\n", b"\t" + x, x + b"\x01", x + b"\x7f", x + b"\xff\x80",
               random_key("rpa", 16).encode() + b" \xc3\xa9\r"]
        out.append(bytes(secrets.choice(ALL_BYTES) for _ in range(40)))  # (any bytes at all)
        out.append(b"rpa_" + bytes(secrets.choice(ALL_BYTES) for _ in range(40)))
        return out

    def test_the_prologue_then_the_matcher(self):
        for key in self.keys():
            d = self.tmp()
            r, salt = run_prologue(d, key)
            self.assertEqual(r.returncode, 0, r.stderr)
            rec = capture.load(d + "/probe-capture")
            self.assertEqual((rec["bytes"], rec["sha256"]), (len(key), expected_digest(salt, key)))
            m = capture.Matcher(rec)
            self.assertTrue(m.found(key), rec["classes"])
            self.assertTrue(m.found(b"pre " + key + b" post\0"))
            self.assertEqual(m.redact(b"a=" + key + b"\n"), b"a=<value>\n")
            self.assertFalse(m.found(key[:-1] + bytes([key[-1] ^ 1])))
            checks.MATCHER = m
            try:
                self.assertEqual(checks.show(b"/etc/" + key), "/etc/<value>")
                self.assertEqual(checks.found(b"/etc/" + key), "found-value")
            finally:
                checks.MATCHER = None


class SeverityTest(Base):
    """A check's detail never goes down: the exact value outranks the name, the name a shape, any of them unreadable."""

    def test_mixed_orders(self):
        import itertools
        kinds = ["unreadable", "found-shape", "found-name", "found-value"]
        for n in (1, 2, 3, 4):
            for order in itertools.permutations(kinds, n):
                f = checks.Found()
                for i, what in enumerate(order):
                    f.add("/p%d" % i, what)
                want = max(order, key=kinds.index)
                self.assertEqual(f.result()[2], want, order)
                self.assertFalse(f.result()[0])


class RunTest(Base):
    """The probe's run with a real capture (made by the prologue) and the value planted around a fake tree."""

    def setUp(self):
        self.root = self.tmp()
        self.proc = self.root + "/proc"
        os.makedirs(self.proc + "/1")
        shutil.copytree(CLEAN_NET, self.proc + "/net")
        with open(self.proc + "/mounts", "w") as f:
            f.write("none / overlay rw 0 0\nproc /proc proc rw 0 0\n")
        with open(self.proc + "/1/environ", "wb") as f:
            f.write(b"PATH=/usr/bin\0")
        with open(self.proc + "/1/cmdline", "wb") as f:
            f.write(b"/usr/bin/python3\0-I\0-S\0/opt/sbgpu/agent/x/sbgpu-agent\0")
        self.key = random_key("rpa", 40)
        r, self.salt = run_prologue(self.root + "/opt/sbgpu", self.key)
        self.assertEqual(r.returncode, 0, r.stderr)

    def run_probe(self):
        out = io.StringIO()
        main.run(out=out, root=self.root, proc=self.proc, pid=1, boots_file=self.root + "/opt/sbgpu/probe-boots",
                 get=lambda *a: None, capture_file=self.root + "/opt/sbgpu/probe-capture")
        lines = out.getvalue().splitlines()
        for line in lines:
            self.assertNotIn(self.key, line)
            self.assertNotIn(self.salt, line)
        return {json.loads(x[12:])["check"]: json.loads(x[12:]) for x in lines}

    def test_clean_the_capture_scanned_too(self):
        got = self.run_probe()
        self.assertEqual({k: v["pass"] for k, v in got.items()}, {k: True for k in main.CHECK_ORDER})
        self.assertEqual(got["pid1"]["detail"], "v44-rpa-dlsu")
        self.assertEqual(got["pid1"]["paths"], ["digest:" + expected_digest(self.salt, self.key)])
        self.assertIsNone(checks.MATCHER)  # (let go at the end)

    def test_the_value_found_anywhere_and_never_printed(self):
        os.makedirs(self.root + "/etc/app")
        with open(self.root + "/etc/app/conf", "w") as f:
            f.write("token = " + self.key + "\n")                     # (contents, no name, no rpa_ shape needed)
        with open(self.root + "/etc/" + self.key, "w") as f:            # (a file named by the value)
            f.write("x")
        os.symlink("/x/" + self.key, self.root + "/etc/link")           # (a link's target)
        os.makedirs(self.root + "/root")
        with open(self.root + "/root/.bash_history", "w") as f:
            f.write("curl -H " + self.key + "\n")
        os.makedirs(self.proc + "/77")
        with open(self.proc + "/77/environ", "wb") as f:
            f.write(b"X=" + self.key.encode() + b"\0")
        got = self.run_probe()
        self.assertEqual((got["environ"]["pass"], got["environ"]["detail"]), (False, "found-value"))
        self.assertEqual((got["files"]["pass"], got["files"]["detail"]), (False, "found-value"))
        self.assertIn("/etc/<value>", got["files"]["paths"])
        self.assertIn("/etc/link", got["files"]["paths"])
        self.assertIn("/etc/app/conf", got["files"]["paths"])
        self.assertEqual((got["history"]["pass"], got["history"]["detail"]), (False, "found-value"))

    def test_other_byte_keys_end_to_end(self):
        # (a key with a high byte or a trailing space: a file holding it fails "files", and a file named by it, its
        # contents forcing a path finding, is reported as <value> in every byte form: never raw, never escaped)
        for tail in ("\u00e9".encode(), b" ", b"\n\x01\x7f\xff"):
            os.unlink(self.root + "/opt/sbgpu/probe-capture")
            key = random_key("", 20, "x").encode() + tail
            r, self.salt = run_prologue(self.root + "/opt/sbgpu", key)
            self.assertEqual(r.returncode, 0, r.stderr)
            shutil.rmtree(self.root + "/data", ignore_errors=True)
            os.makedirs(self.root + "/data")
            with open(self.root + "/data/held", "wb") as f:
                f.write(b"t=" + key + b"\n")
            with open(os.path.join(self.root.encode(), b"data", key), "wb") as f:
                f.write(b"RUNPOD" + b"_API_KEY")
            out = io.StringIO()
            main.run(out=out, root=self.root, proc=self.proc, pid=1, boots_file=self.root + "/opt/sbgpu/probe-boots",
                     get=lambda *a: None, capture_file=self.root + "/opt/sbgpu/probe-capture")
            text = out.getvalue()
            files = [json.loads(x[12:]) for x in text.splitlines() if json.loads(x[12:])["check"] == "files"][0]
            self.assertEqual((files["pass"], files["detail"]), (False, "found-value"), tail)
            self.assertIn("/data/held", files["paths"])
            self.assertIn("/data/<value>", files["paths"])
            esc = "".join(chr(c) if 32 <= c < 127 and c != 92 else "\\x%02x" % c for c in key)
            for form in (key.decode("latin-1"), esc, key.decode("utf-8", "replace"), key[:-len(tail)].decode()):
                self.assertNotIn(form, text, tail)

    def test_the_value_and_the_name_in_one_check(self):
        for first, second in ((b"X=" + self.key.encode(), b"RUNPOD" + b"_API_KEY=y"),
                              (b"RUNPOD" + b"_API_KEY=y", b"X=" + self.key.encode())):
            for pid, env in (("77", first), ("78", second)):
                os.makedirs(self.proc + "/" + pid, exist_ok=True)
                with open(self.proc + "/" + pid + "/environ", "wb") as f:
                    f.write(env + b"\0")
            got = self.run_probe()
            self.assertEqual((got["environ"]["pass"], got["environ"]["detail"]), (False, "found-value"))

    def test_across_a_chunk_boundary(self):
        saved = checks.CHUNK
        checks.CHUNK = 1000
        try:
            os.makedirs(self.root + "/data")
            with open(self.root + "/data/blob", "wb") as f:
                f.write(b"#" * 990 + self.key.encode() + b"#" * 2000)
            got = self.run_probe()
            self.assertEqual(got["files"]["detail"], "found-value")
        finally:
            checks.CHUNK = saved

    def test_a_long_key_across_a_chunk_boundary(self):
        # (a key longer than the default overlap: the overlap grows to the key's length)
        os.unlink(self.root + "/opt/sbgpu/probe-capture")
        self.key = random_key("", 300)
        r, self.salt = run_prologue(self.root + "/opt/sbgpu", self.key)
        self.assertEqual(r.returncode, 0, r.stderr)
        saved = checks.CHUNK
        checks.CHUNK = 1000
        try:
            os.makedirs(self.root + "/data")
            with open(self.root + "/data/blob", "wb") as f:
                f.write(b"#" * 850 + self.key.encode() + b"#" * 2000)
            got = self.run_probe()
            self.assertEqual(got["files"]["detail"], "found-value")
        finally:
            checks.CHUNK = saved

    def test_metadata_bodies(self):
        key = self.key
        out = io.StringIO()
        main.run(out=out, root=self.root, proc=self.proc, pid=1, boots_file=self.root + "/opt/sbgpu/probe-boots",
                 get=lambda url, h, t: (200, b'{"k":"' + key.encode() + b'"}') if "170.2" in url else None,
                 capture_file=self.root + "/opt/sbgpu/probe-capture")
        got = {json.loads(x[12:])["check"]: json.loads(x[12:]) for x in out.getvalue().splitlines()}
        self.assertEqual(got["metadata"]["detail"], "found-value")
        self.assertNotIn(key, out.getvalue())

    def test_no_or_bad_capture_fails_pid1(self):
        os.unlink(self.root + "/opt/sbgpu/probe-capture")
        self.assertEqual(self.run_probe()["pid1"]["detail"], "no-capture")
        with open(self.root + "/opt/sbgpu/probe-capture", "w") as f:
            f.write("{}")
        os.chmod(self.root + "/opt/sbgpu/probe-capture", 0o600)
        self.assertEqual(self.run_probe()["pid1"]["detail"], "bad-capture")


if __name__ == "__main__":
    unittest.main()
