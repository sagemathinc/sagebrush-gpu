// The spend reads (spend.ts): the meters against the ledger's own billing and the contract's budget
// functions, who sees which meter, the spend CSV and the ledger's pages. Mock-only.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, entrySplit, minuteCharge, newId, reserveCharge, reserveSeconds, type SpendMeter } from "@sbgpu/api";
import { stmt, type SqlValue } from "./db.ts";
import { accrueAll, closeAccrual, openAccrual } from "./ledger.ts";
import { LEDGER_PAGE_SIZE, meters, spendCsv } from "./spend.ts";
import { ORIGIN, T0, addMember, call, person, signIn, world, type World } from "./testing/world.ts";

const RATE = 1_200_000; // $1.20/h, the provider's
const MARGIN = 3000; // the seed org's
const MIN = 60_000;
let w: World;
beforeEach(async () => {
  w = await world();
});

const allocOf = async (holderId: string) => (await w.db.all<{ id: string }>(`SELECT id FROM allocations WHERE holder_id = ?`, [holderId]))[0]!.id;
const reserve = (estimate = 0) => reserveSeconds(10, estimate); // (the seed project's final-save reserve: 10 min)
const machineRate = (rate = RATE) => ({ providerCostPerHour: rate, marginBps: MARGIN });

/** A running machine of `memberId` (paid from `allocationId`), its accrual open at `startMs`. */
async function running(memberId: string, allocationId: string, startMs = T0, rate = RATE, estimate = 0) {
  const id = newId("machine");
  await w.db.batch([
    stmt(
      `INSERT INTO machines (member_area_key, id, project_id, allocation_id, member_id, provider, gpu_type, gpu_count, data_center, state, incarnation, save_estimate_seconds, created_ms)
       VALUES (?, ?, ?, ?, ?, 'runpod', 'L4', 1, 'X', 'running', 1, ?, ?)`,
      `m:${w.projectId}:${memberId}`, id, w.projectId, allocationId, memberId, estimate, startMs,
    ),
    ...openAccrual(id, { incarnation: 1, provider: "runpod", providerCostPerHour: rate, marginBps: MARGIN, startMs }),
  ]);
  return id;
}
const meterOf = async (allocationId: string, at: number) => (await meters(w.db, w.projectId, at, [allocationId]))[0]!;

// ---------------------------------------------------------------- the meter

test("meter, billing caught up: spent is the ledger; reserved is the contract's reserveCharge; remaining and the rate follow", async () => {
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 50_000_000 });
  const alloc = await allocOf(mbr);
  await running(mbr, alloc);
  const at = T0 + 5 * MIN;
  await accrueAll(w.db, at);
  const m = await meterOf(alloc, at);
  const five = entrySplit(RATE, 60, MARGIN);
  assert.deepEqual(m.spent, { providerCost: 5 * five.providerCost, margin: 5 * five.margin, total: 5 * five.total });
  assert.equal(m.reserved, reserveCharge([machineRate()], reserve()));
  assert.equal(m.remaining, 50_000_000 - m.spent.total - m.reserved);
  assert.deepEqual(m.currentRatePerHour, entrySplit(RATE, 3600, MARGIN));
  assert.equal(m.asOf, new Date(at).toISOString());
  assert.deepEqual(m.holder, { kind: "member", memberId: mbr });
  assert.equal(m.amount, 50_000_000);
});

test("meter, billing delayed: the unbilled minutes are held back, so spent plus reserved is what it is once billed", async () => {
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 50_000_000 });
  const alloc = await allocOf(mbr);
  await running(mbr, alloc);
  await accrueAll(w.db, T0); // (billed-through set at T0, nothing billed)
  const at = T0 + 5 * MIN + 30_000;
  const lagged = await meterOf(alloc, at);
  assert.equal(lagged.spent.total, 0);
  assert.equal(lagged.asOf, new Date(T0).toISOString(), "asOf: the last minute spent includes");
  await accrueAll(w.db, at);
  const billed = await meterOf(alloc, at);
  assert.equal(billed.spent.total, 5 * minuteCharge(machineRate(), 60));
  assert.equal(lagged.spent.total + lagged.reserved, billed.spent.total + billed.reserved, "never overstated: the same commitment");
  assert.equal(lagged.remaining, billed.remaining);
});

test("meter: the machine's own save estimate, when longer than the project's reserve, sizes the reserve", async () => {
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 50_000_000 });
  const alloc = await allocOf(mbr);
  const id = await running(mbr, alloc);
  await accrueAll(w.db, T0);
  const before = await meterOf(alloc, T0);
  await w.db.batch([stmt(`UPDATE machines SET save_estimate_seconds = 6000 WHERE id = ?`, id)]);
  const after = await meterOf(alloc, T0);
  assert.equal(before.reserved, reserveCharge([machineRate()], reserve()));
  assert.equal(after.reserved, reserveCharge([machineRate()], reserve(6000)));
  assert.ok(after.reserved > before.reserved);
});

test("meter: a restart within the minute keeps that minute at its pinned (first) rate, as the ledger charges it", async () => {
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 500_000_000 });
  const alloc = await allocOf(mbr);
  const id = await running(mbr, alloc, T0, 6 * RATE);
  await w.db.batch([
    ...closeAccrual(id, 1, T0 + 5 * MIN + 10_000),
    stmt(`UPDATE machines SET incarnation = 2 WHERE id = ?`, id),
    ...openAccrual(id, { incarnation: 2, provider: "runpod", providerCostPerHour: RATE, marginBps: MARGIN, startMs: T0 + 5 * MIN + 20_000 }),
  ]);
  const at = T0 + 5 * MIN + 30_000;
  await accrueAll(w.db, at); // (bills the five closed minutes)
  const m = await meterOf(alloc, at);
  // the mock's formula: reserveCharge at the open rate, plus the current minute's pinned difference
  const expected = reserveCharge([machineRate()], reserve()) + minuteCharge(machineRate(6 * RATE), 60) - minuteCharge(machineRate(), 60);
  assert.equal(m.reserved, expected);
});

test("meter: a stopped machine's unbilled minutes count exactly; once billed they're spent", async () => {
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 50_000_000 });
  const alloc = await allocOf(mbr);
  const id = await running(mbr, alloc);
  await accrueAll(w.db, T0);
  await w.db.batch([...closeAccrual(id, 1, T0 + 3 * MIN), stmt(`UPDATE machines SET state = 'stopped' WHERE id = ?`, id)]);
  const lagged = await meterOf(alloc, T0 + 4 * MIN);
  assert.equal(lagged.reserved, 3 * minuteCharge(machineRate(), 60));
  assert.deepEqual(lagged.currentRatePerHour, { providerCost: 0, margin: 0, total: 0 });
  await accrueAll(w.db, T0 + 4 * MIN);
  const billed = await meterOf(alloc, T0 + 4 * MIN);
  assert.deepEqual([billed.reserved, billed.spent.total], [0, 3 * minuteCharge(machineRate(), 60)]);
});

test("meter: a machine counts against the allocation it's charged to: a member's team machine is the team's, not theirs", async () => {
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 50_000_000 });
  const team = newId("team");
  const teamAlloc = newId("allocation");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'T', ?)`, team, w.projectId, T0),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, mbr),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 50000000, ?)`, teamAlloc, w.projectId, team, T0),
  ]);
  await running(mbr, teamAlloc);
  await accrueAll(w.db, T0);
  const own = await meterOf(await allocOf(mbr), T0);
  const theirs = await meterOf(teamAlloc, T0);
  assert.deepEqual([own.reserved, own.currentRatePerHour.total], [0, 0]);
  assert.equal(theirs.reserved, reserveCharge([machineRate()], reserve()));
});

test("meter: no machines: nothing reserved, the full amount remaining; an overspent allocation never goes below zero", async () => {
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 1_000 });
  const alloc = await allocOf(mbr);
  assert.deepEqual(
    { ...(await meterOf(alloc, T0)), asOf: null },
    { allocationId: alloc, holder: { kind: "member", memberId: mbr }, amount: 1_000, spent: { providerCost: 0, margin: 0, total: 0 }, reserved: 0, remaining: 1_000, currentRatePerHour: { providerCost: 0, margin: 0, total: 0 }, storage: { usedBytes: 0, quotaBytes: DEFAULT_POLICY.storageQuotaBytesPerMember }, asOf: null },
  );
  await running(mbr, alloc);
  await accrueAll(w.db, T0 + 60 * MIN);
  assert.equal((await meterOf(alloc, T0 + 60 * MIN)).remaining, 0);
});

// ---------------------------------------------------------------- who sees what

test("getSpend: a member sees their own meter and their team's; assistant and above see all", async () => {
  const a = await person(w, "a@example.com", "member");
  const b = await person(w, "b@example.com", "member");
  const team = newId("team");
  const other = newId("team");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'T', ?), (?, ?, 'U', ?)`, team, w.projectId, T0, other, w.projectId, T0),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, a.memberId),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, other, b.memberId),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 0, ?), (?, ?, 'team', ?, 0, ?)`, newId("allocation"), w.projectId, team, T0, newId("allocation"), w.projectId, other, T0),
  ]);
  const seen = async (cookie: string) =>
    ((await call(w, "GET", `/v1/projects/${w.projectId}/spend`, { cookie })).json.meters as SpendMeter[]).map((m) => (m.holder.kind === "member" ? m.holder.memberId : m.holder.teamId)).sort();
  assert.deepEqual(await seen(a.cookie), [a.memberId, team].sort());
  assert.deepEqual(await seen(b.cookie), [b.memberId, other].sort());
  const staff = await person(w, "s@example.com", "assistant");
  assert.deepEqual(await seen(staff.cookie), [a.memberId, b.memberId, staff.memberId, team, other].sort());
  // a removed member sees nothing (no longer a member of the project)
  await w.db.batch([stmt(`UPDATE members SET status = 'removed' WHERE id = ?`, a.memberId)]);
  assert.equal((await call(w, "GET", `/v1/projects/${w.projectId}/spend`, { cookie: a.cookie })).res.status, 404);
});

// ---------------------------------------------------------------- the CSV

const csv = async (cookie: string, by: string) => {
  const res = await w.app.fetch(new Request(`${ORIGIN}/v1/projects/${w.projectId}/spend.csv?by=${by}`, { headers: { cookie } }));
  return { res, text: await res.text() };
};

test("spend.csv: by member, team and day, exact to the micro-dollar, with member text neutralised", async () => {
  const staff = await person(w, "s@example.com", "assistant");
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 2_000_000 });
  await w.db.batch([stmt(`UPDATE members SET name = '=HYPERLINK(1)' WHERE id = ?`, mbr)]);
  const team = newId("team");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, ?, ?)`, team, w.projectId, " @team", T0),
    stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, mbr),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 3000000, ?)`, newId("allocation"), w.projectId, team, T0),
  ]).catch(async () => {
    // (team names are trimmed by a CHECK: use a name that starts with the formula character itself)
    await w.db.batch([
      stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, ?, ?)`, team, w.projectId, "@team", T0),
      stmt(`UPDATE members SET team_id = ? WHERE id = ?`, team, mbr),
      stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 3000000, ?)`, newId("allocation"), w.projectId, team, T0),
    ]);
  });
  // a removed member (in the team), a deleted team, and another project's ledger entry: none of them appear
  const gone = await addMember(w, "gone@example.com", "member", { allocation: 0 });
  const dead = newId("team");
  const elsewhere = newId("project");
  await w.db.batch([
    stmt(`UPDATE members SET team_id = ?, status = 'removed' WHERE id = ?`, team, gone),
    stmt(`INSERT INTO teams (id, project_id, name, created_ms, deleted_ms) VALUES (?, ?, 'Deleted', ?, ?)`, dead, w.projectId, T0, T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 0, ?)`, newId("allocation"), w.projectId, dead, T0),
    stmt(`INSERT INTO projects (id, org_id, name, starts_ms, ends_ms, budget, created_ms) VALUES (?, ?, 'Other', ?, ?, 0, ?)`, elsewhere, w.orgId, T0, T0 + 1, T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'member', 'mbr_x', 0, ?)`, "alc_00000000000000000099", elsewhere, T0),
    stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms)
       VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, 5, 0, 5, ?)`,
      newId("ledgerEntry"), w.orgId, elsewhere, "alc_00000000000000000099", T0 + 86_400_000, T0,
    ),
  ]);
  const id = await running(mbr, await allocOf(team));
  await accrueAll(w.db, T0 + 2 * MIN);
  await w.db.batch([...closeAccrual(id, 1, T0 + 2 * MIN)]);
  const one = minuteCharge(machineRate(), 60);
  const split = entrySplit(RATE, 60, MARGIN);
  const usd = (n: number) => String(Number((n / 1e6).toFixed(6)));

  const byMember = await csv(staff.cookie, "member");
  assert.equal(byMember.res.status, 200);
  assert.match(byMember.res.headers.get("content-type")!, /^text\/csv/);
  const lines = byMember.text.split("\r\n");
  assert.equal(lines[0], "email,name,team,allocation_usd,provider_cost_usd,margin_usd,total_usd,remaining_usd");
  const row = lines.find((l) => l.startsWith("a@example.com,"))!;
  assert.equal(lines.some((l) => l.startsWith("gone@")), false, "a removed member isn't listed");
  assert.match(row, /^a@example\.com,'=HYPERLINK\(1\),'@team,2,0,0,0,2$/);

  const byTeam = (await csv(staff.cookie, "team")).text.split("\r\n");
  assert.equal(byTeam[0], "team,members,allocation_usd,provider_cost_usd,margin_usd,total_usd,remaining_usd");
  assert.equal(byTeam.some((l) => l.startsWith("Deleted")), false, "a deleted team isn't listed");
  assert.equal(byTeam[1], `'@team,1,3,${usd(2 * split.providerCost)},${usd(2 * split.margin)},${usd(2 * one)},${usd(3_000_000 - 2 * one)}`);

  const byDay = (await csv(staff.cookie, "day")).text.split("\r\n");
  assert.deepEqual(byDay.slice(0, 2), ["date_utc,provider_cost_usd,margin_usd,total_usd", `2027-02-01,${usd(2 * split.providerCost)},${usd(2 * split.margin)},${usd(2 * one)}`]);
  assert.equal(byDay.length, 3, "only this project's days");
  assert.equal(byDay.at(-1), "");

  for (const bad of ["", "week", "Member", "member%00"]) assert.equal((await csv(staff.cookie, bad)).res.status, 400, bad);
  // a member can't read it
  assert.equal((await csv(await signIn(w, "a@example.com"), "member")).res.status, 403);
});

// ---------------------------------------------------------------- the ledger

test("ledger: managers only; newest first, in pages, every entry once; a malformed cursor is refused", async () => {
  const boss = await person(w, "m@example.com", "manager");
  const mbr = await person(w, "a@example.com", "member");
  const alloc = await allocOf(mbr.memberId);
  const n = 400; // (two full pages: the last one ends the listing)
  const ids: string[] = [];
  const stmts = [];
  for (let i = 0; i < n; i++) {
    const id = newId("ledgerEntry");
    ids.push(id);
    // (pairs share a creation time, so the keyset's second column matters)
    stmts.push(stmt(
      `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, note, created_ms)
       VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, ?, 0, ?, ?, ?)`,
      id, w.orgId, w.projectId, alloc, T0, -i, -i, i === 0 ? "=1+1" : null, T0 + Math.floor(i / 2),
    ));
  }
  for (let i = 0; i < stmts.length; i += 50) await w.db.batch(stmts.slice(i, i + 50));
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  let lastKey: [number, string] | null = null;
  const sizes: number[] = [];
  do {
    const r = await call(w, "GET", `/v1/projects/${w.projectId}/ledger${cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`}`, { cookie: boss.cookie });
    assert.equal(r.res.status, 200);
    const items = r.json.items as Array<{ id: string; createdAt: string; amount: { total: number }; note: string | null }>;
    sizes.push(items.length);
    for (const e of items) {
      const key: [number, string] = [Date.parse(e.createdAt), e.id];
      if (lastKey) assert.ok(key[0] < lastKey[0] || (key[0] === lastKey[0] && key[1] < lastKey[1]), "newest first, strictly");
      lastKey = key;
      seen.push(e.id);
    }
    cursor = r.json.next as string | null;
    pages++;
  } while (cursor !== null);
  assert.deepEqual([pages, sizes, LEDGER_PAGE_SIZE], [2, [200, 200], 200]);
  assert.deepEqual([...seen].sort(), [...ids].sort());
  for (const bad of ["x", "1.led_short", "abc.led_00000000000000000000", "99999999999999999.led_00000000000000000000", "9007199254740992.led_00000000000000000000", ""]) {
    assert.equal((await call(w, "GET", `/v1/projects/${w.projectId}/ledger?cursor=${encodeURIComponent(bad)}`, { cookie: boss.cookie })).res.status, 400, bad);
  }
  assert.equal((await call(w, "GET", `/v1/projects/${w.projectId}/ledger`, { cookie: mbr.cookie })).res.status, 403);
});

void ({} as SqlValue);

/** An adjustment of `total` micros (all provider cost) on `allocationId`, in the UTC day `day` after T0's. */
const adjustment = (allocationId: string, total: number, day = 0) => stmt(
  `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms)
   VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, ?, 0, ?, ?)`,
  newId("ledgerEntry"), w.orgId, w.projectId, allocationId, T0 + day * 86_400_000, total, total, T0,
);

/** The CSV's lines without its header and its final empty line. */
async function csvLines(cookie: string, by: string): Promise<string[]> {
  const r = await csv(cookie, by);
  assert.equal(r.res.status, 200);
  return r.text.split("\r\n").slice(1, -1);
}

async function memberAndTeam() {
  const staff = await person(w, "s@example.com", "assistant");
  const mbr = await addMember(w, "a@example.com", "member", { allocation: 0 });
  const team = newId("team");
  const teamAlloc = newId("allocation");
  await w.db.batch([
    stmt(`INSERT INTO teams (id, project_id, name, created_ms) VALUES (?, ?, 'T', ?)`, team, w.projectId, T0),
    stmt(`INSERT INTO allocations (id, project_id, holder_kind, holder_id, amount, updated_ms) VALUES (?, ?, 'team', ?, 0, ?)`, teamAlloc, w.projectId, team, T0),
  ]);
  return { staff, alloc: await allocOf(mbr), teamAlloc };
}

test("spend.csv: a credit is a negative number in every grouping, never text", async () => {
  const { staff, alloc, teamAlloc } = await memberAndTeam();
  await w.db.batch([adjustment(alloc, -500_000), adjustment(teamAlloc, -1)]);
  assert.ok((await csvLines(staff.cookie, "member")).includes("a@example.com,,,0,-0.5,0,-0.5,0"));
  assert.deepEqual(await csvLines(staff.cookie, "team"), ["T,0,0,-0.000001,0,-0.000001,0"]);
  assert.deepEqual(await csvLines(staff.cookie, "day"), ["2027-02-01,-0.500001,0,-0.500001"]);
});

test("spend.csv: the safe integer range's ends export exactly, both signs", async () => {
  const { staff, alloc, teamAlloc } = await memberAndTeam();
  await w.db.batch([adjustment(alloc, Number.MAX_SAFE_INTEGER, 1), adjustment(teamAlloc, -Number.MAX_SAFE_INTEGER, 2)]);
  assert.ok((await csvLines(staff.cookie, "member")).includes("a@example.com,,,0,9007199254.740991,0,9007199254.740991,0"));
  assert.deepEqual(await csvLines(staff.cookie, "team"), ["T,0,0,-9007199254.740991,0,-9007199254.740991,0"]);
  assert.deepEqual(await csvLines(staff.cookie, "day"), ["2027-02-02,9007199254.740991,0,9007199254.740991", "2027-02-03,-9007199254.740991,0,-9007199254.740991"]);
});

// (each entry in range, and so are the cost and margin sums; two entries' total, 10^16 + 2, is not)
const BIG_COST = 3_000_000_000_000_001;
const BIG_MARGIN = 2_000_000_000_000_000;
const REFUSED = { name: "RangeError", message: "a sum past the safe integer range: 10000000000000002" };
const bigEntry = (allocationId: string, i: number) => stmt(
  `INSERT INTO ledger_entries (id, org_id, project_id, allocation_id, kind, period_start_ms, seconds, margin_bps, provider_cost, margin, total, created_ms)
   VALUES (?, ?, ?, ?, 'adjustment', ?, 0, 0, ?, ?, ?, ?)`,
  newId("ledgerEntry"), w.orgId, w.projectId, allocationId, T0 + i, BIG_COST, BIG_MARGIN, BIG_COST + BIG_MARGIN, T0,
);

test("money stays exact: an allocation's sum past the safe range is refused, not rounded", async () => {
  const alloc = await allocOf(await addMember(w, "a@example.com", "member", { allocation: 0 }));
  await w.db.batch([bigEntry(alloc, 0), bigEntry(alloc, 1)]);
  await assert.rejects(meters(w.db, w.projectId, T0, [alloc]), REFUSED);
});

test("money stays exact: a day's sum past the safe range is refused, while each allocation's meter reads", async () => {
  const a = await allocOf(await addMember(w, "a@example.com", "member", { allocation: 0 }));
  const b = await allocOf(await addMember(w, "b@example.com", "member", { allocation: 0 }));
  await w.db.batch([bigEntry(a, 0), bigEntry(b, 1)]);
  assert.deepEqual((await meters(w.db, w.projectId, T0, null)).map((m) => m.spent.total), [BIG_COST + BIG_MARGIN, BIG_COST + BIG_MARGIN]);
  await assert.rejects(spendCsv(w.db, w.projectId, T0, "day"), REFUSED);
});

test("money stays exact: no parseFloat or toFixed in the money modules (api, control)", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dirs = [new URL("../../api/src/", import.meta.url), new URL("./", import.meta.url)];
  for (const dir of dirs) {
    const files = readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"));
    assert.ok(files.includes("money.ts") || files.includes("spend.ts"), dir.pathname);
    for (const f of files) {
      assert.doesNotMatch(readFileSync(new URL(f, dir), "utf8"), /\b(parseFloat|toFixed)\s*\(/, `${dir.pathname}${f}`);
    }
  }
});
