"""The agent's relay leg (sbgpu_agent/relayclient.py) against a fake relay (a minimal WebSocket server here), and the
machine's stop on every path (main.serve; SEC ruling, Nov 24): a stop command, a revoke command, a refused heartbeat,
the relay's revoked, a relay close 4403, SIGTERM and an error all stop the terminals and, in container mode, call
stop_everything once; in VM mode, never.
"""

import asyncio
import base64
import hashlib
import json
import os
import signal
import struct
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from sbgpu_agent import main, relayclient as R  # noqa: E402
from sbgpu_agent.control import Control  # noqa: E402

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MBR = "mbr_" + "a" * 20


class FakeRelay:
    """Accepts WebSocket upgrades on /api/relay/v1/peer; records each leg's messages; sends what a test says."""

    def __init__(self, status=101, auto_pong=True):
        self.status = status
        self.auto_pong = auto_pong
        self.legs = []
        self.connected = asyncio.Event()

    async def start(self):
        self.server = await asyncio.start_server(self.handle, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.url = "ws://127.0.0.1:%d/api/relay/v1/peer?machine=mch_1" % self.port
        return self

    async def stop(self):
        for leg in self.legs:
            leg.writer.close()
        self.server.close()
        await self.server.wait_closed()

    async def handle(self, reader, writer):
        head = await reader.readuntil(b"\r\n\r\n")
        key = [l.split(":", 1)[1].strip() for l in head.decode().split("\r\n") if l.lower().startswith("sec-websocket-key:")][0]
        if self.status != 101:
            writer.write(b"HTTP/1.1 %d No\r\ncontent-length: 0\r\n\r\n" % self.status)
            await writer.drain()
            writer.close()
            return
        accept = base64.b64encode(hashlib.sha1((key + GUID).encode()).digest()).decode()
        writer.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        leg = FakeLeg(reader, writer, self)
        self.legs.append(leg)
        self.connected.set()
        await leg.read_loop()


class FakeLeg:
    def __init__(self, reader, writer, relay=None):
        self.reader, self.writer, self.relay = reader, writer, relay
        self.msgs = []
        self.closed = None
        self.got = asyncio.Event()

    async def read_loop(self):
        try:
            while True:
                b0, b1 = await self.reader.readexactly(2)
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", await self.reader.readexactly(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", await self.reader.readexactly(8))[0]
                key = await self.reader.readexactly(4)
                data = bytearray(await self.reader.readexactly(n))
                for i in range(n):
                    data[i] ^= key[i % 4]
                op = b0 & 0x0F
                if op == 0x8:
                    self.closed = struct.unpack(">H", bytes(data[:2]))[0] if n >= 2 else 1005
                    self.got.set()
                    return
                if op == 0x1:
                    text = data.decode()
                    self.msgs.append(text)
                    if text == '{"relay":"ping"}' and self.relay is not None and self.relay.auto_pong:
                        self.send('{"relay":"pong"}')
                    self.got.set()
        except (asyncio.IncompleteReadError, ConnectionError):
            if self.closed is None:
                self.closed = 1006
            self.got.set()

    def send(self, text):
        data = text.encode()
        n = len(data)
        head = bytes([0x81, n]) if n < 126 else bytes([0x81, 126]) + struct.pack(">H", n) if n < 65536 else bytes([0x81, 127]) + struct.pack(">Q", n)
        self.writer.write(head + data)

    def close(self, code, reason=""):
        payload = struct.pack(">H", code) + reason.encode()
        self.writer.write(bytes([0x88, len(payload)]) + payload)

    def json(self):
        return [json.loads(m) for m in self.msgs if m.startswith("{")]

    async def until(self, f, timeout=5):
        end = asyncio.get_running_loop().time() + timeout
        while not f():
            if asyncio.get_running_loop().time() > end:
                return False
            await asyncio.sleep(0.01)
        return True


def aio(fn):
    def run(self):
        return asyncio.run(fn(self))
    run.__name__ = fn.__name__
    return run


class Host:
    """A Terminals stand-in: records page messages and departures."""

    def __init__(self, client):
        self.client = client
        self.messages = []
        self.gone = []

    def page_message(self, p, msg):
        self.messages.append((p.gen, msg))
        if msg.get("t") == "echo":
            p.send({"t": "echoed", "x": msg.get("x")})

    def page_gone(self, p):
        self.gone.append(p.gen)

    def stop_all(self):
        pass


async def no_sleep(s):
    await asyncio.sleep(0.005)


def client_for(relay, tokens=None):
    tokens = tokens if tokens is not None else ["tok-1"]
    issued = []

    def token():
        t = tokens[min(len(issued), len(tokens) - 1)]
        issued.append(t)
        return t
    c = R.RelayClient(relay.url, token, Host, main.proctree.LoopTimers(), sleep=no_sleep, rnd=lambda: 0.0)
    c.issued = issued
    return c


class ParseTest(unittest.TestCase):
    def test_controls_strict(self):
        self.assertEqual(R.parse_control('{"relay":"ready","inc":2}'), {"relay": "ready", "inc": 2})
        self.assertEqual(R.parse_control('{"relay":"page-open","conn":"c1","chan":"terminal","gen":3,"mbr":"%s"}' % MBR)["gen"], 3)
        for bad in ('{"relay":"ready"}', '{"relay":"ready","inc":2,"x":1}', '{"relay":"ready","inc":2.0}', '{"relay": "pong"}',
                    '{"relay":"page-open","conn":"c1","chan":"kernel","gen":3,"mbr":"%s"}' % MBR,
                    '{"relay":"page-open","conn":"c1","chan":"terminal","gen":0,"mbr":"%s"}' % MBR,
                    '{"relay":"page-open","conn":"c1","chan":"terminal","gen":3,"mbr":"x"}',
                    '{"relay":"nope"}', '{"relay":"pong","relay":"pong"}', '{"relay":"receipt","r":"short","upto":1}'):
            with self.assertRaises(R.ControlError, msg=bad):
                R.parse_control(bad)

    def test_prefix_and_urls(self):
        self.assertEqual(R.split_prefix('7\n{"t":"x"}'), (7, '{"t":"x"}'))
        for bad in ("0\n{}", "07\n{}", "{}", "7{}"):
            with self.assertRaises(R.ControlError):
                R.split_prefix(bad)
        self.assertEqual(R.check_relay_url("wss://api.example.com/api/relay/v1/peer?machine=mch_1")[3], True)
        for bad in ("ws://api.example.com/api/relay/v1/peer", "https://api.example.com/api/relay/v1/peer",
                    "wss://api.example.com/other", "wss://u:p@api.example.com/api/relay/v1/peer", "wss:///api/relay/v1/peer"):
            with self.assertRaises(ValueError, msg=bad):
                R.check_relay_url(bad)
        self.assertEqual(R.check_relay_url("ws://127.0.0.1:9/api/relay/v1/peer")[3], False)

    def test_backoff(self):
        self.assertEqual([R.backoff_ms(a, lambda: 0.5) for a in (0, 1, 2, 6, 30)], [1000, 2000, 4000, 60000, 60000])


class ClientTest(unittest.TestCase):
    @aio
    async def test_hello_first_then_ready_pages_receipts_and_pings(self):
        relay = await FakeRelay().start()
        c = client_for(relay)
        stop = asyncio.Event()
        run = asyncio.ensure_future(c.run(stop))
        try:
            await asyncio.wait_for(relay.connected.wait(), 5)
            leg = relay.legs[0]
            self.assertTrue(await leg.until(lambda: leg.msgs))
            self.assertEqual(leg.msgs[0], '{"t":"hello","token":"tok-1"}')
            leg.send('{"relay":"ready","inc":4}')
            self.assertTrue(await leg.until(lambda: c.incarnation == 4))
            leg.send('{"relay":"page-open","conn":"c1","chan":"terminal","gen":1,"mbr":"%s"}' % MBR)
            leg.send('1\n{"t":"echo","x":5}')
            self.assertTrue(await leg.until(lambda: '1\n{"t":"echoed","x":5}' in leg.msgs))
            leg.send('{"relay":"receipt","r":"%s","upto":99}' % ("R" * 22))
            self.assertTrue(await leg.until(lambda: {"relay": "ack", "r": "R" * 22} in leg.json()))
            # (a message for a page over the terminal's cap, within the leg's: that page is closed, the leg goes on)
            frame = '{"t":"x","pad":"%s"}'
            body = frame % ("y" * (R.TERMINAL_FRAME + 4 - len(frame % "")))
            self.assertEqual(len(body), R.TERMINAL_FRAME + 4)
            leg.send("1\n" + body)
            self.assertTrue(await leg.until(lambda: {"relay": "close", "gen": 1} in leg.json()))
            self.assertIsNone(leg.closed)
            # (pings, answered: the leg stays up)
            self.assertTrue(await leg.until(lambda: leg.json().count({"relay": "ping"}) >= 5, 10))
            self.assertEqual((len(relay.legs), leg.closed), (1, None))
            # (unanswered twice: the leg is dropped and dialled again, with a fresh token)
            relay.auto_pong = False
            self.assertTrue(await leg.until(lambda: len(relay.legs) >= 2, 10))
            self.assertGreaterEqual(len(c.issued), 2)
        finally:
            stop.set()
            await asyncio.wait_for(run, 5)
            await relay.stop()

    @aio
    async def test_a_message_over_the_legs_cap_closes_it_1009_before_decoding(self):
        relay = await FakeRelay().start()
        c = client_for(relay)
        stop = asyncio.Event()
        run = asyncio.ensure_future(c.run(stop))
        try:
            await asyncio.wait_for(relay.connected.wait(), 5)
            leg = relay.legs[0]
            await leg.until(lambda: leg.msgs)
            leg.send('{"relay":"ready","inc":1}')
            await leg.until(lambda: c.incarnation == 1)
            leg.send("1\n" + "z" * R.RELAY_LIMITS["inbound"])
            self.assertTrue(await leg.until(lambda: leg.closed is not None))
            self.assertEqual(leg.closed, 1009)
        finally:
            stop.set()
            await asyncio.wait_for(run, 5)
            await relay.stop()

    @aio
    async def test_violations_close_the_leg_1008(self):
        cases = [
            ('1\n{"t":"x"}', "a page's message before ready"),
            ('{"relay":"pong"}', "a control before ready"),
            (None, '{"relay":"ready","inc":1}|{"relay":"ready","inc":1}'),
            (None, '{"relay":"ready","inc":1}|9\n{"t":"x"}'),
            (None, '{"relay":"ready","inc":1}|{"relay":"page-close","conn":"c9","gen":9}'),
            (None, '{"relay":"ready","inc":1}|{"relay":"page-open","conn":"c1","chan":"terminal","gen":2,"mbr":"%s"}|{"relay":"page-open","conn":"c2","chan":"terminal","gen":2,"mbr":"%s"}' % (MBR, MBR)),
            (None, '{"relay":"ready","inc":1}|{ "relay":"pong"}'),
        ]
        for first, seq in cases:
            relay = await FakeRelay().start()
            c = client_for(relay)
            stop = asyncio.Event()
            run = asyncio.ensure_future(c.run(stop))
            try:
                await asyncio.wait_for(relay.connected.wait(), 5)
                leg = relay.legs[0]
                await leg.until(lambda: leg.msgs)
                for m in ([first] if first else seq.split("|")):
                    leg.send(m)
                self.assertTrue(await leg.until(lambda: leg.closed is not None), seq)
                self.assertEqual(leg.closed, 1008, (first, seq))
            finally:
                stop.set()
                await asyncio.wait_for(run, 5)
                await relay.stop()

    @aio
    async def test_revoked_and_4403_are_fatal_4009_redials(self):
        for how in ("revoked", "4403"):
            relay = await FakeRelay().start()
            c = client_for(relay)
            stop = asyncio.Event()
            try:
                run = asyncio.ensure_future(c.run(stop))
                await asyncio.wait_for(relay.connected.wait(), 5)
                leg = relay.legs[0]
                await leg.until(lambda: leg.msgs)
                leg.send('{"relay":"ready","inc":1}')
                await leg.until(lambda: c.incarnation == 1)
                if how == "revoked":
                    leg.send('{"relay":"revoked"}')
                else:
                    leg.close(4403, "refused")
                with self.assertRaises(R.Fatal):
                    await asyncio.wait_for(run, 5)
                self.assertEqual(len(relay.legs), 1)
            finally:
                await relay.stop()
        relay = await FakeRelay().start()
        c = client_for(relay, ["tok-1", "tok-2"])
        stop = asyncio.Event()
        run = asyncio.ensure_future(c.run(stop))
        try:
            await asyncio.wait_for(relay.connected.wait(), 5)
            leg = relay.legs[0]
            await leg.until(lambda: leg.msgs)
            leg.send('{"relay":"ready","inc":1}')
            await leg.until(lambda: c.incarnation == 1)
            leg.close(4009, "replaced")
            self.assertTrue(await leg.until(lambda: len(relay.legs) == 2 and relay.legs[1].msgs))
            self.assertEqual(relay.legs[1].msgs[0], '{"t":"hello","token":"tok-2"}')
        finally:
            stop.set()
            await asyncio.wait_for(run, 5)
            await relay.stop()

    @aio
    async def test_429_at_the_upgrade_backs_off_longer(self):
        relay = await FakeRelay(status=429).start()
        c = client_for(relay)
        stop = asyncio.Event()
        run = asyncio.ensure_future(c.run(stop))
        try:
            self.assertTrue(await FakeLeg(None, None, None).until(lambda: len(c.delays) >= 1, 5))
            self.assertGreaterEqual(c.delays[0], R.RELAY_LIMITS["rateBackoffMs"])
        finally:
            stop.set()
            await asyncio.wait_for(run, 5)
            await relay.stop()


ENROLLED = {"machineId": "mch_1", "agentToken": "agent-tok-1", "agentTokenExpiresAt": "2026-11-25T00:00:00Z",
            "incarnation": 1, "heartbeatSeconds": 30, "idle": {"minutes": 30, "gpuUtilThresholdPct": 5},
            "maxSessionEndsAt": "2026-11-25T08:00:00Z", "setupScript": None, "workspace": {"restore": True}}


class Heartbeats:
    """A control-plane transport: heartbeats answer from a list (its last answer repeats)."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, method, url, headers, body, timeout):
        path = url.split("https://control.example.com", 1)[1]
        self.calls.append(path)
        if path == "/v1/agent/heartbeat":
            status, payload = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
            return status, json.dumps(payload).encode()
        return 200, b"{}"


class StopPathsTest(unittest.TestCase):
    """Every way serve() ends calls stop_everything once in container mode, after the terminals; never in VM mode."""

    async def serve(self, beats, container=True, on_leg=None, beat_gap=0.05, agent_run=None):
        relay = await FakeRelay().start()
        control = Control("https://control.example.com", Heartbeats(beats))
        control.token = "agent-tok-1"
        wake = threading.Event()
        agent = main.Agent(control, ENROLLED, sleep=lambda s: wake.wait(beat_gap))
        if agent_run is not None:
            agent.run = agent_run
        stops = []
        tmp = tempfile.mkdtemp()

        async def drive():
            await asyncio.wait_for(relay.connected.wait(), 5)
            leg = relay.legs[0]
            await leg.until(lambda: leg.msgs)
            leg.send('{"relay":"ready","inc":1}')
            if on_leg is not None:
                await on_leg(leg)
        driver = asyncio.ensure_future(drive())
        try:
            code = await asyncio.wait_for(main.serve(agent, relay.url, container, stop_everything=lambda: stops.append(1) or [],
                                                     cwd=tmp, relay_sleep=no_sleep, heartbeat_wake=wake), 20)
        finally:
            driver.cancel()
            await relay.stop()
        return code, stops

    @aio
    async def test_a_stop_command(self):
        code, stops = await self.serve([(200, {"commands": []}), (200, {"commands": [{"id": "c1", "op": "stop"}]})])
        self.assertEqual((code, stops), (0, [1]))

    @aio
    async def test_a_revoke_command(self):
        code, stops = await self.serve([(200, {"commands": [{"id": "c1", "op": "revoke"}]})])
        self.assertEqual((code, stops), (3, [1]))

    @aio
    async def test_a_refused_heartbeat(self):
        code, stops = await self.serve([(403, {"error": {"code": "forbidden"}})])
        self.assertEqual((code, stops), (3, [1]))

    @aio
    async def test_the_relay_revokes(self):
        async def revoke(leg):
            await asyncio.sleep(0.1)
            leg.send('{"relay":"revoked"}')
        code, stops = await self.serve([(200, {"commands": []})], on_leg=revoke)
        self.assertEqual((code, stops), (3, [1]))

    @aio
    async def test_the_relay_refuses_4403(self):
        async def refuse(leg):
            await asyncio.sleep(0.1)
            leg.close(4403, "refused")
        code, stops = await self.serve([(200, {"commands": []})], on_leg=refuse)
        self.assertEqual((code, stops), (3, [1]))

    @aio
    async def test_sigterm(self):
        async def term(leg):
            await asyncio.sleep(0.2)
            os.kill(os.getpid(), signal.SIGTERM)
        code, stops = await self.serve([(200, {"commands": []})], on_leg=term)
        self.assertEqual((code, stops), (0, [1]))

    @aio
    async def test_an_error_ends_the_machine_too(self):
        def boom():
            raise RuntimeError("an unexpected error in the heartbeats")
        code, stops = await self.serve([(200, {"commands": []})], agent_run=boom)
        self.assertEqual((code, stops), (3, [1]))

    @aio
    async def test_vm_mode_never_calls_it(self):
        code, stops = await self.serve([(200, {"commands": [{"id": "c1", "op": "stop"}]})], container=False)
        self.assertEqual((code, stops), (0, []))

    @aio
    async def test_terminals_stop_before_everything_else(self):
        order = []
        relay = await FakeRelay().start()
        control = Control("https://control.example.com", Heartbeats([(200, {"commands": [{"id": "c1", "op": "stop"}]})]))
        control.token = "agent-tok-1"
        agent = main.Agent(control, ENROLLED, sleep=lambda s: None)
        real = main.Terminals.stop_all
        main.Terminals.stop_all = lambda self: order.append("terminals") or real(self)
        try:
            code = await asyncio.wait_for(main.serve(agent, relay.url, True, stop_everything=lambda: order.append("everything") or [],
                                                     cwd=tempfile.mkdtemp(), relay_sleep=no_sleep), 20)
        finally:
            main.Terminals.stop_all = real
            await relay.stop()
        self.assertEqual((code, order), (0, ["terminals", "everything"]))


if __name__ == "__main__":
    unittest.main()
