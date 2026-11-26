import { test } from "node:test";
import assert from "node:assert/strict";
import { GENERIC_LABELS } from "./labels.ts";
import { canRestore, checkSaveName, KIND_WORDS, restoreBlockedText, restoreConfirmText, saveRows } from "./saves.ts";
import { ago } from "./view.ts";
import type { ListSnapshotsResponse, Machine, Snapshot } from "@sbgpu/api";

const NOW = Date.parse("2027-02-01T12:00:00.000Z");
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const snap = (id: string, minutesAgo: number, o: Partial<Snapshot> = {}): Snapshot => ({
  id,
  area: "member",
  createdAt: iso(minutesAgo),
  kind: "periodic",
  bytes: 120 * 1024 * 1024,
  name: null,
  machineId: "mch_1",
  current: false,
  restoredFrom: null,
  ...o,
});

test("rows: newest first as listed, each kind in words, the size, the name and the current one", () => {
  const items = [
    snap("snp_r", 5, { kind: "restore", current: true, machineId: null, restoredFrom: "snp_m" }),
    snap("snp_f", 60, { kind: "final" }),
    snap("snp_m", 120, { kind: "manual", name: "before I break it" }),
    snap("snp_p", 180),
    snap("snp_gone", 240, { kind: "restore", restoredFrom: "snp_pruned" }),
  ];
  const rows = saveRows(items, NOW);
  assert.deepEqual(rows.map((r) => r.id), ["snp_r", "snp_f", "snp_m", "snp_p", "snp_gone"]);
  assert.deepEqual(rows.map((r) => r.current), [true, false, false, false, false]);
  assert.equal(rows[0]!.kind, `Restored from the save of ${ago(iso(120), NOW)}`);
  assert.equal(rows[1]!.kind, "Saved when the machine stopped");
  assert.equal(rows[2]!.kind, "Saved on request");
  assert.equal(rows[3]!.kind, "Saved automatically");
  assert.equal(rows[4]!.kind, "Restored", "the save it restored is no longer listed");
  assert.deepEqual([rows[2]!.name, rows[3]!.name], ["before I break it", null]);
  assert.equal(rows[1]!.when, ago(iso(60), NOW));
  assert.equal(rows[1]!.createdAt, iso(60));
  assert.equal(rows[1]!.size, "120.0 MB");
  assert.deepEqual(KIND_WORDS, { periodic: "Saved automatically", manual: "Saved on request", final: "Saved when the machine stopped", restore: "Restored" });
});

test("a restore is offered only while none of your machines writes a workspace", () => {
  const m = (state: Machine["state"]) => ({ state }) as Machine;
  assert.equal(canRestore([]), true);
  for (const state of ["stopped", "failed", "deleted"] as const) assert.equal(canRestore([m(state)]), true, state);
  for (const state of ["starting", "running", "saving", "stopping"] as const) assert.equal(canRestore([m("stopped"), m(state)]), false, state);
  assert.match(restoreBlockedText(GENERIC_LABELS), /stop your machines first: a running machine keeps writing to your workspace and your team's/);
});

test("the restore confirmation names the save and says nothing is deleted", () => {
  const [named, plain] = saveRows([snap("a", 120, { name: "good run" }), snap("b", 60)], NOW);
  assert.equal(restoreConfirmText(named!), `Restore "good run" (saved ${ago(iso(120), NOW)})? It becomes your current workspace. Nothing is deleted: the current save stays in the list, so you can restore it again.`);
  assert.match(restoreConfirmText(plain!), new RegExp(`^Restore the save from ${ago(iso(60), NOW)}\\?`));
});

test("a name: trimmed, the server's rule, unique in the workspace, within the limit (a rename isn't counted twice)", () => {
  const list: ListSnapshotsResponse = { items: [snap("a", 1, { name: "one" }), snap("b", 2, { name: "two" }), snap("c", 3)], keepLast: 10, namedMax: 2 };
  assert.deepEqual(checkSaveName("  three  ", { ...list, namedMax: 5 }, "c"), { ok: true, name: "three" });
  assert.deepEqual(checkSaveName("one", list, "a"), { ok: true, name: "one" }, "its own name");
  assert.deepEqual(checkSaveName("uno", list, "a"), { ok: true, name: "uno" }, "a rename at the limit");
  assert.deepEqual(checkSaveName("uno", { ...list, namedMax: 1 }, "a"), { ok: true, name: "uno" }, "a rename with the limit already full (lowered since)");
  assert.deepEqual(checkSaveName("one", list, "b"), { ok: false, reason: "Another save here already has that name." });
  assert.deepEqual(checkSaveName("three", list, "c"), { ok: false, reason: "This workspace already has 2 named saves, the most allowed. Remove a name first." });
  assert.deepEqual(checkSaveName("three", list, null), { ok: false, reason: "This workspace already has 2 named saves, the most allowed. Remove a name first." }, "a new save");
  assert.equal(checkSaveName("x", { ...list, namedMax: 1, items: [snap("a", 1, { name: "one" })] }, null).ok, false);
  assert.match((checkSaveName("x", { ...list, namedMax: 1, items: [snap("a", 1, { name: "one" })] }, null) as { reason: string }).reason, /has 1 named save, the most/);
  for (const bad of ["", "   ", "a\u0007b", "x".repeat(65)]) {
    assert.deepEqual(checkSaveName(bad, { ...list, namedMax: 5 }, "c"), { ok: false, reason: "A name has 1 to 64 characters, with no control characters." }, JSON.stringify(bad));
  }
  assert.deepEqual(checkSaveName("x".repeat(64), { ...list, namedMax: 5 }, "c"), { ok: true, name: "x".repeat(64) });
});
