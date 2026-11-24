import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOT_TOKEN_TTL_SECONDS,
  TOKEN_CLOCK_SKEW_SECONDS,
  TOKEN_KINDS,
  TOKEN_TTL_SECONDS,
  bootExchange,
  isBootTokenShape,
  isTokenKind,
  machineTokenStateOk,
  validateClaims,
  type BootTokenRecord,
  type TokenClaims,
  type TokenKind,
} from "./tokens.ts";
import { newId } from "./ids.ts";
import { MACHINE_STATES } from "./objects.ts";

const NOW = 1_800_000_000;
const mch = newId("machine");
const mbr = newId("member");
const prj = newId("project");
const team = newId("team");
const snp = newId("snapshot");
const jti = "AAAAAAAAAAAAAAAAAAAAAA";

const base = (kind: TokenKind) => ({ v: 1, kind, jti, iat: NOW - 10, exp: NOW - 10 + TOKEN_TTL_SECONDS[kind], mch, inc: 3 });
const agent = () => base("agent");
const page = () => ({ ...base("page"), mbr });
const jl = () => ({ ...base("jupyter-link"), mbr });
const ws = (o: Record<string, unknown> = {}) => ({
  ...base("workspace"),
  mbr,
  prj,
  team,
  grants: [
    { area: "member", mode: "rw", quotaBytes: 50e9 },
    { area: "team", mode: "rw", quotaBytes: 20e9 },
    { area: "project-data", mode: "ro" },
  ],
  mode: { kind: "normal" },
  ...o,
});
const finalSave = (o: Record<string, unknown> = {}) =>
  ws({
    grants: [{ area: "member", mode: "ro" }, { area: "project-data", mode: "ro" }],
    mode: { kind: "final-save", saveId: snp, area: "member", maxBytes: 1e9 },
    ...o,
  });

const ok = (x: unknown, kind: TokenKind, now = NOW) => validateClaims(x, kind, now).ok;
const reason = (x: unknown, kind: TokenKind, now = NOW) => {
  const r = validateClaims(x, kind, now);
  return r.ok ? "ok" : r.reason;
};

test("valid claims of each kind pass", () => {
  assert.equal(reason(agent(), "agent"), "ok");
  assert.equal(reason(page(), "page"), "ok");
  assert.equal(reason(jl(), "jupyter-link"), "ok");
  assert.equal(reason(ws(), "workspace"), "ok");
  assert.equal(reason(finalSave(), "workspace"), "ok");
  assert.equal(reason(ws({ team: null, grants: [{ area: "member", mode: "rw", quotaBytes: 1 }] }), "workspace"), "ok");
});

test("one kind can never pass as another", () => {
  const all: Record<TokenKind, unknown> = { agent: agent(), workspace: ws(), page: page(), "jupyter-link": jl() };
  for (const a of TOKEN_KINDS) for (const b of TOKEN_KINDS) assert.equal(ok(all[a], b), a === b, `${a} as ${b}`);
  // even with the kind field rewritten, the key set differs (page vs jupyter-link share keys
  // but not kind)
  assert.equal(ok({ ...page(), kind: "jupyter-link" }, "page"), false);
});

test("the claims language is closed", () => {
  assert.equal(reason({ ...agent(), extra: 1 }, "agent"), "keys");
  const { inc: _inc, ...noInc } = agent();
  assert.equal(reason(noInc, "agent"), "keys");
  assert.equal(reason({ ...agent(), v: 2 }, "agent"), "version");
  assert.equal(reason({ ...agent(), jti: "short" }, "agent"), "jti");
  assert.equal(reason({ ...agent(), jti: "AAAAAAAAAAAAAAAAAAAAA=" }, "agent"), "jti");
  assert.equal(reason({ ...agent(), mch: "mch_bad" }, "agent"), "mch");
  assert.equal(reason({ ...agent(), mch: newId("project") }, "agent"), "mch");
  assert.equal(reason({ ...agent(), inc: -1 }, "agent"), "inc");
  assert.equal(reason({ ...agent(), inc: 1.5 }, "agent"), "inc");
  assert.equal(reason({ ...page(), mbr: newId("user") }, "page"), "mbr");
  assert.equal(reason(null, "agent"), "not an object");
  assert.equal(reason([], "agent"), "not an object");
  assert.equal(reason(Object.assign(Object.create({ evil: 1 }), agent()), "agent"), "not an object");
  assert.equal(reason(agent(), "boot" as TokenKind), "unknown expected kind");
  assert.equal(reason(agent(), "agent", NaN), "now");
});

test("times: safe integers, iat < exp, per-kind caps, skew and expiry", () => {
  for (const k of TOKEN_KINDS) {
    const c = { ...(k === "workspace" ? ws() : k === "agent" ? agent() : { ...base(k), mbr }), iat: NOW, exp: NOW + TOKEN_TTL_SECONDS[k] };
    assert.equal(reason(c, k), "ok", k);
    assert.equal(reason({ ...c, exp: c.exp + 1 }, k), "lifetime over the cap", k);
  }
  assert.equal(reason({ ...agent(), iat: NOW, exp: NOW }, "agent"), "iat >= exp");
  assert.equal(reason({ ...agent(), iat: 1.5 }, "agent"), "times");
  assert.equal(reason({ ...agent(), exp: NaN }, "agent"), "times");
  assert.equal(reason({ ...agent(), iat: -5, exp: 10 }, "agent"), "times");
  const a = { ...agent(), iat: NOW + TOKEN_CLOCK_SKEW_SECONDS, exp: NOW + TOKEN_CLOCK_SKEW_SECONDS + 60 };
  assert.equal(reason(a, "agent"), "ok");
  assert.equal(reason({ ...a, iat: a.iat + 1, exp: a.exp + 1 }, "agent"), "issued in the future");
  const e = agent();
  assert.equal(reason(e, "agent", e.exp - 1), "ok");
  assert.equal(reason(e, "agent", e.exp), "expired");
  assert.ok(TOKEN_TTL_SECONDS.page <= 60 && TOKEN_TTL_SECONDS["jupyter-link"] <= 60);
});

test("workspace grants: project data is read-only, quotas per writable grant", () => {
  assert.equal(reason(ws({ grants: [{ area: "project-data", mode: "rw", quotaBytes: 1 }] }), "workspace"), "rw grant area");
  assert.equal(reason(ws({ grants: [{ area: "member", mode: "rw" }] }), "workspace"), "rw grant keys");
  assert.equal(reason(ws({ grants: [{ area: "member", mode: "rw", quotaBytes: 0 }] }), "workspace"), "rw grant quotaBytes");
  assert.equal(reason(ws({ grants: [{ area: "member", mode: "rw", quotaBytes: 2 ** 53 }] }), "workspace"), "rw grant quotaBytes");
  assert.equal(reason(ws({ grants: [{ area: "member", mode: "ro", quotaBytes: 5 }] }), "workspace"), "ro grant keys");
  assert.equal(reason(ws({ grants: [{ area: "other", mode: "ro" }] }), "workspace"), "ro grant area");
  assert.equal(reason(ws({ grants: [{ area: "member", mode: "wo" }] }), "workspace"), "grant mode");
  assert.equal(reason(ws({ grants: [] }), "workspace"), "grants");
  assert.equal(reason(ws({ grants: "member" }), "workspace"), "grants");
  assert.equal(
    reason(ws({ grants: [{ area: "member", mode: "ro" }, { area: "member", mode: "rw", quotaBytes: 1 }] }), "workspace"),
    "duplicate grant area",
  );
  assert.equal(reason(ws({ team: null }), "workspace"), "team grant without a team");
  assert.equal(reason(ws({ team: "team_x" }), "workspace"), "team");
  assert.equal(reason(ws({ mbr: newId("machine") }), "workspace"), "mbr");
  assert.equal(reason(ws({ prj: newId("org") }), "workspace"), "prj");
});

test("final-save authority is one save, one area, a byte cap, and no writable grant", () => {
  const fsm = (m: Record<string, unknown>) => finalSave({ mode: { kind: "final-save", saveId: snp, area: "member", maxBytes: 1e9, ...m } });
  assert.equal(reason(fsm({ saveId: "snp_x" }), "workspace"), "saveId");
  assert.equal(reason(fsm({ area: "project-data" }), "workspace"), "final-save area");
  assert.equal(reason(fsm({ maxBytes: 0 }), "workspace"), "maxBytes");
  assert.equal(reason(fsm({ maxBytes: -1 }), "workspace"), "maxBytes");
  assert.equal(reason(fsm({ extra: 1 }), "workspace"), "mode keys");
  assert.equal(reason(finalSave({ grants: [{ area: "member", mode: "rw", quotaBytes: 1 }] }), "workspace"), "final-save token with a writable grant");
  assert.equal(reason(finalSave({ team: null, mode: { kind: "final-save", saveId: snp, area: "team", maxBytes: 1 } }), "workspace"), "final-save to a team without a team");
  assert.equal(reason(ws({ mode: { kind: "normal", saveId: snp } }), "workspace"), "mode keys");
  assert.equal(reason(ws({ mode: { kind: "grace" } }), "workspace"), "mode kind");
  assert.equal(reason(ws({ mode: null }), "workspace"), "mode");
});

test("machineTokenStateOk: incarnation and state", () => {
  const m = (state: (typeof MACHINE_STATES)[number], incarnation = 3, id = mch) => ({ id, state, incarnation });
  const allow = (c: TokenClaims) => MACHINE_STATES.filter((s) => machineTokenStateOk(c, m(s)));
  assert.deepEqual(allow(agent() as TokenClaims), ["starting", "running", "saving"]);
  assert.deepEqual(allow(ws() as TokenClaims), ["running"]);
  assert.deepEqual(allow(finalSave() as TokenClaims), ["saving"]);
  assert.deepEqual(allow(page() as TokenClaims), ["running"]);
  assert.deepEqual(allow(jl() as TokenClaims), ["running"]);
  for (const c of [agent(), ws(), finalSave(), page(), jl()] as TokenClaims[]) {
    assert.equal(machineTokenStateOk(c, m("running", 4)), false, "newer incarnation");
    assert.equal(machineTokenStateOk(c, m("running", 2)), false, "older incarnation");
    assert.equal(machineTokenStateOk(c, m("running", 3, newId("machine"))), false, "other machine");
  }
});

test("boot tokens: shape, binding, window, first exchange wins", () => {
  assert.equal(isBootTokenShape("A".repeat(43)), true);
  assert.equal(isBootTokenShape("A".repeat(42)), false);
  assert.equal(isBootTokenShape("A".repeat(44)), false);
  assert.equal(isBootTokenShape("A".repeat(42) + "="), false);
  assert.equal(isBootTokenShape("A".repeat(42) + "+"), false);
  assert.equal(BOOT_TOKEN_TTL_SECONDS <= 120, true);
  const t0 = Date.UTC(2027, 1, 1, 9);
  const row: BootTokenRecord = {
    tokenSha256: "0".repeat(64),
    machineId: mch,
    incarnation: 1,
    provider: "runpod",
    providerMachineId: "pod-abc",
    firstRunningAt: new Date(t0).toISOString(),
    expiresAt: new Date(t0 + BOOT_TOKEN_TTL_SECONDS * 1000).toISOString(),
    usedAt: null,
  };
  const r = (o: Partial<BootTokenRecord>, pmid: string | null = "pod-abc", now = t0 + 1000) => {
    const x = bootExchange({ ...row, ...o }, pmid, now);
    return x.ok ? "ok" : x.reason;
  };
  assert.equal(r({}), "ok");
  assert.equal(r({}, "pod-abc", t0 + BOOT_TOKEN_TTL_SECONDS * 1000 - 1), "ok");
  assert.equal(r({}, "pod-abc", t0 + BOOT_TOKEN_TTL_SECONDS * 1000), "expired");
  assert.equal(r({}, "pod-xyz"), "instanceMismatch");
  assert.equal(r({}, null), "instanceMismatch");
  assert.equal(r({ usedAt: new Date(t0).toISOString() }), "used");
  assert.equal(r({ providerMachineId: null }, null), "unbound");
  assert.equal(r({ firstRunningAt: null, expiresAt: null }), "notRunningYet");
  assert.equal(r({ expiresAt: null }), "notRunningYet");
  // a row with a window longer than the cap, or garbage, counts as expired
  assert.equal(r({ expiresAt: new Date(t0 + BOOT_TOKEN_TTL_SECONDS * 1000 + 1).toISOString() }), "expired");
  assert.equal(r({ expiresAt: "soon" }), "expired");
  assert.equal(r({ firstRunningAt: "x" }), "expired");
  // SEC r2: the window starts at the first running report (first 09:01, exp 09:03, now 09:00)
  const first = t0 + 60_000;
  const win = { firstRunningAt: new Date(first).toISOString(), expiresAt: new Date(first + BOOT_TOKEN_TTL_SECONDS * 1000).toISOString() };
  assert.equal(r(win, "pod-abc", t0), "notRunningYet"); // now < first
  assert.equal(r(win, "pod-abc", first - 1), "notRunningYet");
  assert.equal(r(win, "pod-abc", first), "ok"); // first <= now
  assert.equal(r({ firstRunningAt: new Date(t0).toISOString(), expiresAt: new Date(t0).toISOString() }, "pod-abc", t0), "expired"); // exp == first
  assert.equal(r({ firstRunningAt: new Date(t0).toISOString(), expiresAt: new Date(t0).toISOString() }, "pod-abc", t0 - 1), "expired"); // an empty window is expired, not pending
  assert.equal(r({ firstRunningAt: new Date(t0).toISOString(), expiresAt: new Date(t0 - 1000).toISOString() }, "pod-abc", t0 - 2000), "expired"); // exp < first
  assert.equal(r({ firstRunningAt: new Date(t0).toISOString(), expiresAt: new Date(t0 + 1).toISOString() }, "pod-abc", t0), "ok"); // 1 ms window
  assert.equal(r({}, "pod-abc", NaN), "expired");
  // used beats every other reason (it must alert)
  assert.equal(r({ usedAt: "x", providerMachineId: null }, null), "used");
});

test("token kinds", () => {
  for (const k of TOKEN_KINDS) assert.ok(isTokenKind(k));
  assert.equal(isTokenKind("boot"), false);
  assert.equal(isTokenKind("session"), false);
});
