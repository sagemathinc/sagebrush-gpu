"""The agent's leg to the relay (DESIGN.md section 4): one outbound WebSocket, the agent token in its first message,
then the pages the relay pairs with this machine, served by the terminals.

Ported from Sagebrush's runner (engine/py/python/sagebrush/remote/relay.py: the RFC 6455 client, its frame reader and
write gate, the strict control parser, the prefix split, the pinger and the backoff; SageMath, Inc.).  What differs:
  - the dial: wss://<api>/api/relay/v1/peer?machine=<mch> (ws:// only to a loopback host, for tests), no proxy; no
    challenge or key: the first message is {"t":"hello","token":"<agent token>"} and the relay answers
    {"relay":"ready","inc":n}; nothing else is accepted before it;
  - the controls (relay -> agent): ready {inc}, page-open {conn, chan, gen, mbr}, page-close {conn, gen},
    receipt {r, upto}, revoked, dropped {gen, bytes}, pong; strictly parsed (keys in order, the one serialization);
  - pages: terminal pages only, each held to the terminal's 65,536-byte cap, its messages strict JSON objects handed
    to Terminals.page_message;
  - the end: the relay's revoked, or a close 4403, is fatal (the machine is stopping: the agent's caller then ends
    every process, proctree.stop_everything); 4009 (another leg of this machine took over) and anything else is
    dialled again with a fresh token, backing off 1, 2, 4 ... 60 s, +-20%.
"""

import asyncio
import base64
import collections
import hashlib
import json
import os
import random
import re
import socket
import ssl
import time
import urllib.parse

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
CONTROL_PREFIX = '{"relay":"'
RELAY_LIMITS = {
    "control": 256,             # a control message's bytes
    "pingMs": 15_000,           # between pings
    "missedPongs": 2,           # pings unanswered: the leg is dead
    "backoffMs": (1_000, 60_000),
    "jitter": 0.2,
    "rateBackoffMs": 60_000,    # after 4429 or a 429 at the upgrade
    "stableMs": 60_000,         # a leg up this long resets the backoff
    "connectMs": 30_000,        # TCP, TLS and the upgrade's answer
    "readyMs": 15_000,          # the hello's answer
    "head": 8 * 1024,           # the upgrade's answer head
    "inbound": 65_536 + 17,     # a message from the relay: the terminal's cap plus the `<gen>\n` prefix
    "fragments": 1024,
    "outData": 4 * 1024 * 1024,     # the leg's transport buffer: data refused past this (the page's sender closed)
    "outTotal": 5 * 1024 * 1024,    # ... and everything (controls too) past this (the leg aborted)
}
TERMINAL_FRAME = 65_536
_SAFE = 2 ** 53 - 1
_GEN_PREFIX = re.compile(r"([1-9][0-9]{0,15})\n")
_CONN = re.compile(r"[A-Za-z0-9_-]{1,64}")
_TOKEN = re.compile(r"[A-Za-z0-9_-]{22}")
_MBR = re.compile(r"mbr_[A-Za-z0-9]{1,64}")
CHANNELS = ("terminal",)
_IN_OPS = {
    "ready": ("inc",),
    "page-open": ("conn", "chan", "gen", "mbr"),
    "page-close": ("conn", "gen"),
    "receipt": ("r", "upto"),
    "revoked": (),
    "dropped": ("gen", "bytes"),
    "pong": (),
}
_CHECK = {
    "inc": lambda v: type(v) is int and 0 <= v <= _SAFE,
    "conn": lambda v: isinstance(v, str) and bool(_CONN.fullmatch(v)),
    "chan": lambda v: v in CHANNELS,
    "gen": lambda v: type(v) is int and 1 <= v <= _SAFE,
    "mbr": lambda v: isinstance(v, str) and bool(_MBR.fullmatch(v)),
    "r": lambda v: isinstance(v, str) and bool(_TOKEN.fullmatch(v)),
    "upto": lambda v: type(v) is int and 0 <= v <= _SAFE,
    "bytes": lambda v: type(v) is int and 0 <= v <= _SAFE,
}


class ControlError(ValueError):
    pass


def parse_control(text):
    """A relay -> agent control, strictly, or ControlError."""
    if not text.startswith(CONTROL_PREFIX):
        raise ControlError("not a control message")
    if len(text.encode("utf-8", "surrogatepass")) > RELAY_LIMITS["control"]:
        raise ControlError("a control message over 256 bytes")

    def pairs(kv):
        names = [k for k, _ in kv]
        if len(set(names)) != len(names):
            raise ControlError("a key twice")
        return kv

    def no_float(s):
        raise ControlError("a number not an integer")

    def no_const(s):
        raise ControlError("not JSON: %s" % s)
    try:
        v = json.loads(text, object_pairs_hook=pairs, parse_float=no_float, parse_constant=no_const)
    except ControlError:
        raise
    except (ValueError, RecursionError):
        raise ControlError("malformed")
    if not isinstance(v, list) or not v or v[0][0] != "relay" or not isinstance(v[0][1], str):
        raise ControlError("relay first")
    op = v[0][1]
    fields = _IN_OPS.get(op)
    if fields is None:
        raise ControlError("an unknown op")
    if [k for k, _ in v] != ["relay", *fields]:
        raise ControlError("the op's keys, in order")
    d = dict(v)
    for f in fields:
        if not _CHECK[f](d[f]):
            raise ControlError("a bad %s" % f)
    if json.dumps(d, separators=(",", ":"), ensure_ascii=False) != text:
        raise ControlError("not the one serialization")
    return d


def split_prefix(text):
    """(gen, payload) of an application message on the agent's leg, or ControlError."""
    m = _GEN_PREFIX.match(text)
    if m is None:
        raise ControlError("an application message without its generation prefix")
    gen = int(m.group(1))
    if gen > _SAFE:
        raise ControlError("a generation over 2^53 - 1")
    return gen, text[m.end():]


def strict_object(text):
    """A page message: a JSON object, no duplicate keys, no NaN or Infinity; else ValueError."""
    def pairs(kv):
        d = dict(kv)
        if len(d) != len(kv):
            raise ValueError("a key twice")
        return d

    def no_const(s):
        raise ValueError("not JSON: %s" % s)
    v = json.loads(text, object_pairs_hook=pairs, parse_constant=no_const)
    if not isinstance(v, dict):
        raise ValueError("not an object")
    return v


def ping_text():
    return '{"relay":"ping"}'


def ack_text(r):
    return '{"relay":"ack","r":"%s"}' % r


def close_text(gen):
    return '{"relay":"close","gen":%d}' % gen


def hello_text(token):
    return json.dumps({"t": "hello", "token": token}, separators=(",", ":"))


class Fatal(Exception):
    """The leg ends for good: the machine is revoked or stopping."""


class Retry(Exception):
    """This leg failed; dial again (after the backoff, or at least delay_ms)."""

    def __init__(self, message, delay_ms=0):
        super().__init__(message)
        self.delay_ms = delay_ms


def backoff_ms(attempt, rnd=random.random):
    """1, 2, 4 ... 60 s, +-20%."""
    lo, hi = RELAY_LIMITS["backoffMs"]
    base = min(hi, lo * (2 ** min(attempt, 16)))
    j = RELAY_LIMITS["jitter"]
    return int(base * (1 - j + 2 * j * rnd()))


def _mask(payload, key):
    n = len(payload)
    if not n:
        return b""
    rep = (key * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "little") ^ int.from_bytes(rep, "little")).to_bytes(n, "little")


def client_frame(op, payload, key=None):
    """A client frame: FIN, the opcode, masked (a client masks every frame)."""
    key = key if key is not None else os.urandom(4)
    n = len(payload)
    if n < 126:
        head = bytes([0x80 | op, 0x80 | n])
    elif n < 65536:
        head = bytes([0x80 | op, 0x80 | 126]) + n.to_bytes(2, "big")
    else:
        head = bytes([0x80 | op, 0x80 | 127]) + n.to_bytes(8, "big")
    return head + key + _mask(payload, key)


def _close_status_ok(s):
    """A close status a peer may send (RFC 6455 section 7.4)."""
    return (1000 <= s <= 1014 and s not in (1004, 1005, 1006)) or 3000 <= s <= 4999


class Leg:
    """One connection to the relay, after the upgrade: frames.  on_text(text) gets each whole message; on_end(code,
    reason) once, when it ends however it ends."""

    def __init__(self, reader, writer, on_text, on_end):
        self.r, self.w = reader, writer
        self.on_text, self.on_end = on_text, on_end
        self.buf = bytearray()
        self.parts, self.parts_len, self.in_msg, self.fragments = [], 0, False, 0
        self.closed = False
        self.ended = False
        self.task = None
        self.first = b""

    def _buffered(self):
        try:
            return self.w.transport.get_write_buffer_size()
        except Exception:
            return 0

    def write(self, frame, kind):
        if self.closed:
            return False
        if self._buffered() + len(frame) <= (RELAY_LIMITS["outData"] if kind == "data" else RELAY_LIMITS["outTotal"]):
            self.w.write(frame)
            return True
        if kind != "data":
            self.abort("the relay isn't reading")
        return False

    def fits(self, n, kind):
        frame = n + (6 if n < 126 else 8 if n < 65536 else 14)
        return not self.closed and self._buffered() + frame <= (RELAY_LIMITS["outData"] if kind == "data" else RELAY_LIMITS["outTotal"])

    def send_text(self, text, kind="data"):
        return self.write(client_frame(0x1, text.encode("utf-8", "surrogatepass")), kind)

    def close(self, code, reason=""):
        if self.closed:
            return
        self.write(client_frame(0x8, code.to_bytes(2, "big") + reason[:120].encode("utf-8")), "control")
        self.closed = True
        self._end(code, reason)
        try:
            self.w.close()
        except Exception:
            pass

    def abort(self, reason):
        self.closed = True
        try:
            self.w.transport.abort()
        except Exception:
            pass
        self._end(1006, reason)

    def _end(self, code, reason):
        if not self.ended:
            self.ended = True
            self.buf, self.parts = bytearray(), []
            self.on_end(code, reason)

    def start(self):
        self.task = asyncio.ensure_future(self.run(self.first))
        return self

    async def run(self, first=b""):
        try:
            if first:
                self.feed(first)
            while not self.closed:
                chunk = await self.r.read(65536)
                if not chunk:
                    break
                self.feed(chunk)
        except (OSError, ssl.SSLError, asyncio.IncompleteReadError):
            pass
        finally:
            if not self.ended:
                self.abort("the relay connection was lost")

    def feed(self, chunk):
        if self.closed:
            return
        self.buf += chunk
        while not self.closed and len(self.buf) >= 2:
            b0, b1 = self.buf[0], self.buf[1]
            fin, rsv, op, masked = bool(b0 & 0x80), b0 & 0x70, b0 & 0x0F, bool(b1 & 0x80)
            if rsv:
                return self.close(1002, "reserved bits")
            if masked:
                return self.close(1002, "a server frame must not be masked")
            n, at = b1 & 0x7F, 2
            if n == 126:
                if len(self.buf) < 4:
                    return
                n, at = int.from_bytes(self.buf[2:4], "big"), 4
                if n < 126:
                    return self.close(1002, "a length not in its shortest form")
            elif n == 127:
                if len(self.buf) < 10:
                    return
                big = int.from_bytes(self.buf[2:10], "big")
                if big >> 63:
                    return self.close(1002, "a 64-bit length's top bit must be 0")
                if big < 65536:
                    return self.close(1002, "a length not in its shortest form")
                n, at = big, 10
            control = op >= 0x8
            if control and (n > 125 or not fin):
                return self.close(1002, "bad control frame")
            # (the cap is checked on the header, before the payload is read or decoded)
            if not control and self.parts_len + n > RELAY_LIMITS["inbound"]:
                return self.close(1009, "message too big")
            if len(self.buf) < at + n:
                return
            payload = bytes(self.buf[at:at + n])
            del self.buf[:at + n]
            if op == 0x8:
                if len(payload) == 1:
                    return self.close(1002, "a close status is two bytes")
                if len(payload) >= 2 and not _close_status_ok(int.from_bytes(payload[:2], "big")):
                    return self.close(1002, "a close status a peer may not send")
                try:
                    reason = payload[2:].decode("utf-8")
                except UnicodeDecodeError:
                    return self.close(1007, "a close reason not UTF-8")
                code = int.from_bytes(payload[:2], "big") if len(payload) >= 2 else 1005
                if not self.closed:
                    self.write(client_frame(0x8, payload[:2] if len(payload) >= 2 else b""), "control")
                    self.closed = True
                    self._end(code, reason)
                    try:
                        self.w.close()
                    except Exception:
                        pass
                return
            if op == 0x9:
                self.write(client_frame(0xA, payload), "control")
                continue
            if op == 0xA:
                continue
            if op == 0x2:
                return self.close(1003, "text frames only")
            if op == 0x1:
                if self.in_msg:
                    return self.close(1002, "a new message inside a fragmented one")
                self.in_msg, self.fragments = True, 0
            elif op == 0x0:
                if not self.in_msg:
                    return self.close(1002, "a continuation with nothing to continue")
            else:
                return self.close(1002, "reserved opcode")
            self.fragments += 1
            if self.fragments > RELAY_LIMITS["fragments"]:
                return self.close(1009, "too many fragments")
            if payload:
                self.parts.append(payload)
                self.parts_len += len(payload)
            if not fin:
                continue
            whole = b"".join(self.parts)
            self.parts, self.parts_len, self.in_msg, self.fragments = [], 0, False, 0
            try:
                text = whole.decode("utf-8")
            except UnicodeDecodeError:
                return self.close(1007, "not UTF-8")
            self.on_text(text)


def check_relay_url(url):
    """(host, port, path, tls) of a relay URL, or ValueError: wss:// anywhere, ws:// only to a loopback host."""
    u = urllib.parse.urlsplit(url)
    if u.scheme not in ("wss", "ws") or not u.hostname or u.username or u.password or u.fragment:
        raise ValueError("not a relay URL")
    tls = u.scheme == "wss"
    if not tls and u.hostname not in ("127.0.0.1", "localhost", "::1"):
        raise ValueError("ws:// only to a loopback host")
    if u.path != "/api/relay/v1/peer":
        raise ValueError("not the relay's peer path")
    return u.hostname, u.port or (443 if tls else 80), u.path + ("?" + u.query if u.query else ""), tls


async def open_leg(url, on_text, on_end, connect_ms=None):
    """The connection (TLS) and the upgrade: a Leg, not yet started, or Retry."""
    connect_ms = connect_ms or RELAY_LIMITS["connectMs"]
    try:
        host, port, path, tls = check_relay_url(url)
    except ValueError as e:
        raise Fatal(str(e))
    deadline = time.monotonic() + connect_ms / 1000

    def left():
        return max(0.001, deadline - time.monotonic())
    try:
        ctx = ssl.create_default_context() if tls else None
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=ctx, server_hostname=host if tls else None,
                                    limit=RELAY_LIMITS["head"] * 2), left())
    except (OSError, ssl.SSLError, asyncio.TimeoutError, socket.gaierror) as e:
        raise Retry("can't reach the relay (%s)" % e.__class__.__name__)
    try:
        wskey = base64.b64encode(os.urandom(16)).decode("ascii")
        hostport = host if port in (80, 443) else "%s:%d" % (host, port)
        writer.write(("GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\nUser-Agent: sbgpu-agent\r\n\r\n"
                      % (path, hostport, wskey)).encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = await asyncio.wait_for(reader.read(4096), left())
            if not chunk:
                raise Retry("the relay closed the connection during the upgrade")
            head += chunk
            if len(head) > RELAY_LIMITS["head"] and b"\r\n\r\n" not in head[:RELAY_LIMITS["head"] + 4]:
                raise Retry("the relay's answer head is too long")
        head, rest = head.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ", 2)
        status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
        if status != 101:
            if status == 429:
                raise Retry("the relay is limiting this machine (429)", RELAY_LIMITS["rateBackoffMs"])
            raise Retry("the relay answered %d" % status)
        h = {}
        for line in lines[1:]:
            k, _, v = line.partition(":")
            k = k.strip().lower()
            if k in h:
                raise Retry("the relay repeated the header %s" % k)
            h[k] = v.strip()
        accept = base64.b64encode(hashlib.sha1((wskey + GUID).encode("ascii")).digest()).decode("ascii")
        tokens = [t.strip().lower() for t in h.get("connection", "").split(",")]
        if (h.get("upgrade", "").lower() != "websocket" or "upgrade" not in tokens
                or h.get("sec-websocket-accept") != accept or "sec-websocket-extensions" in h or "sec-websocket-protocol" in h):
            raise Retry("the relay's upgrade answer isn't a plain WebSocket")
    except asyncio.TimeoutError:
        writer.transport.abort()
        raise Retry("the relay's upgrade timed out")
    except BaseException:
        writer.transport.abort()
        raise
    leg = Leg(reader, writer, on_text, on_end)
    leg.first = rest
    return leg


class RelayPage:
    """A page, from page-open to page-close: what Terminals sees as a page."""

    def __init__(self, client, leg, conn, gen, chan, mbr):
        self.client, self.leg, self.conn, self.gen, self.chan, self.mbr = client, leg, conn, gen, chan, mbr
        self.prefix = "%d\n" % gen
        self.closed = False
        self.grant = None

    def send_text(self, text, kind):
        if self.closed:
            return False
        data = (self.prefix + text).encode("utf-8", "surrogatepass")
        if not self.leg.fits(len(data), kind):
            self.close(1013, "the page isn't reading its answers")
            return False
        return self.leg.write(client_frame(0x1, data), kind)

    def send(self, obj):
        return self.send_text(json.dumps(obj, separators=(",", ":")), "data")

    def close(self, code, reason=""):
        """This page only: ended here, and {"relay":"close","gen":n} to the relay, which closes its leg and answers
        with its page-close."""
        if self.closed:
            return
        self.client.page_gone(self)
        self.leg.send_text(close_text(self.gen), "control")


class RelayClient:
    """The agent's relay leg, dialled and served until stop or a Fatal.  host gives the terminals (`terms`: a
    Terminals, built with this client as its host: timers, incarnation, leg) and `token()`, the current agent token."""

    def __init__(self, url, token, terms_factory, timers, err=lambda s: None, rnd=random.random, sleep=asyncio.sleep):
        self.url, self.token = url, token
        self.timers, self.err, self.rnd, self.sleep = timers, err, rnd, sleep
        self.terms = terms_factory(self)
        self.leg = None
        self.incarnation = None
        self.pages = {}
        self.last_gen = 0
        self.ready = None
        self.leg_ended = None
        self.end_code = None
        self.fatal = None
        self.pings_unanswered = 0
        self.up_at = None  # (when the current leg became ready, on self.clock)
        self.clock = time.monotonic
        self.delays = collections.deque(maxlen=16)  # (the last reconnect delays, ms: diagnostics, bounded)
        self.stats = {"legs": 0, "acks": 0, "violations": 0, "pings": 0}

    # ---- messages from the relay
    def on_text(self, text):
        if text.startswith(CONTROL_PREFIX):
            try:
                c = parse_control(text)
            except ControlError as e:
                return self.violation("a malformed relay control (%s)" % e)
            return self.control(c)
        if self.ready is not None and not self.ready.done():
            return self.violation("a page's message before ready")
        try:
            gen, payload = split_prefix(text)
        except ControlError as e:
            return self.violation(str(e))
        page = self.pages.get(gen)
        if page is None:
            return self.violation("a page's message for no page this agent holds")
        if page.closed:
            return
        if len(payload.encode("utf-8", "surrogatepass")) > TERMINAL_FRAME:
            return page.close(1009, "message too big")
        try:
            msg = strict_object(payload)
        except (ValueError, RecursionError):
            return page.close(1007, "malformed JSON")
        self.terms.page_message(page, msg)

    def control(self, c):
        op = c["relay"]
        if op == "ready":
            if self.ready is None or self.ready.done():
                return self.violation("ready twice")
            self.incarnation = c["inc"]
            self.ready.set_result(c["inc"])
            return
        if self.ready is not None and not self.ready.done():
            return self.violation("a control before ready")
        if op == "pong":
            self.pings_unanswered = 0
        elif op == "receipt":
            self.stats["acks"] += 1
            self.leg.send_text(ack_text(c["r"]), "control")
        elif op == "page-open":
            if c["gen"] <= self.last_gen:
                return self.violation("a page's generation went back")
            self.last_gen = c["gen"]
            self.pages[c["gen"]] = RelayPage(self, self.leg, c["conn"], c["gen"], c["chan"], c["mbr"])
        elif op == "page-close":
            p = self.pages.get(c["gen"])
            if p is None or p.conn != c["conn"]:
                return self.violation("a page-close for no page this agent holds")
            self.page_gone(p)
            del self.pages[c["gen"]]
        elif op == "revoked":
            self.fatal = Fatal("the machine was revoked")
            self.leg.close(1000, "revoked")
        elif op == "dropped":
            pass

    def violation(self, why):
        self.stats["violations"] += 1
        self.err("The relay sent something this agent refuses (%s); reconnecting.\n" % why)
        if self.leg is not None:
            self.leg.close(1008, why[:100])

    def page_gone(self, p):
        if p.closed:
            return
        p.closed = True
        self.terms.page_gone(p)

    def on_end(self, code, reason):
        for p in list(self.pages.values()):
            self.page_gone(p)
        self.pages.clear()
        self.end_code = code
        if code == 4403 and self.fatal is None:
            self.fatal = Fatal("the relay refused or revoked this machine")
        if self.ready is not None and not self.ready.done():
            self.ready.set_exception(Retry("the relay closed the leg before ready (%d)" % code))
        if self.leg_ended is not None and not self.leg_ended.done():
            self.leg_ended.set_result(code)

    async def pinger(self, leg):
        while not leg.closed:
            await self.sleep(RELAY_LIMITS["pingMs"] / 1000)
            if leg.closed:
                return
            if self.pings_unanswered >= RELAY_LIMITS["missedPongs"]:
                return leg.abort("no pong")
            self.pings_unanswered += 1
            self.stats["pings"] += 1
            leg.send_text(ping_text(), "control")

    async def serve_once(self):
        """One leg: dial, hello, ready, serve until it ends.  Returns the end code; raises Retry or Fatal."""
        loop = asyncio.get_running_loop()
        self.leg_ended = loop.create_future()
        self.ready = loop.create_future()
        self.pings_unanswered = 0
        self.last_gen, self.pages = 0, {}
        self.leg = await open_leg(self.url, self.on_text, self.on_end)
        self.leg.start()
        self.leg.send_text(hello_text(self.token()), "control")
        try:
            await asyncio.wait_for(asyncio.shield(self.ready), RELAY_LIMITS["readyMs"] / 1000)
        except asyncio.TimeoutError:
            self.leg.abort("no ready")
            raise Retry("the relay didn't answer the hello")
        self.stats["legs"] += 1
        self.up_at = self.clock()
        ping = asyncio.ensure_future(self.pinger(self.leg))
        try:
            return await self.leg_ended
        finally:
            ping.cancel()

    async def pause(self, stop, seconds):
        """Wait between legs: seconds, or until stop."""
        waiting = asyncio.ensure_future(stop.wait())
        try:
            await asyncio.wait_for(asyncio.shield(waiting), seconds)
        except asyncio.TimeoutError:
            pass
        waiting.cancel()

    async def run(self, stop):
        """Dial, serve, dial again, until stop is set or a Fatal (then raised)."""
        attempt = 0
        while not stop.is_set():
            delay = 0
            self.up_at = None  # (set by serve_once once this leg is ready)
            try:
                serving = asyncio.ensure_future(self.serve_once())
                stopped = asyncio.ensure_future(stop.wait())
                await asyncio.wait([serving, stopped], return_when=asyncio.FIRST_COMPLETED)
                stopped.cancel()
                if not serving.done():
                    if self.leg is not None and not self.leg.closed:
                        self.leg.close(1001, "the agent stopped")
                    serving.cancel()
                    try:
                        await serving
                    except BaseException:
                        pass
                    break
                serving.result()
                if self.end_code == 4429:
                    delay = RELAY_LIMITS["rateBackoffMs"]
            except Retry as e:
                delay = e.delay_ms
                self.err("Relay: %s.\n" % e)
            if self.fatal is not None:
                raise self.fatal
            # (a leg that was ready for stableMs, however it ended, starts the backoff again from 1 s)
            if self.up_at is not None and self.clock() - self.up_at >= RELAY_LIMITS["stableMs"] / 1000:
                attempt = 0
            delay = max(delay, backoff_ms(attempt, self.rnd))
            attempt += 1
            self.delays.append(delay)
            await self.pause(stop, delay / 1000)
        if self.leg is not None and not self.leg.closed:
            self.leg.close(1001, "the agent stopped")
