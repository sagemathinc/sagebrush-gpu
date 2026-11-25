import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  LAUNCH_RECORD_OUTCOMES,
  ORPHAN_BINDINGS,
  ORPHAN_FAILURES,
  ORPHAN_REPORT_ONLY_REASONS,
  ORPHAN_TERMINATE_CAUSES,
  type OrphanReport,
} from "./orphans.ts";

test("orphan report: the closed lists", () => {
  assert.deepEqual([...ORPHAN_BINDINGS], ["providerId", "launchIntent", "none"]);
  assert.deepEqual([...ORPHAN_REPORT_ONLY_REASONS], ["unparsed", "otherInstallation", "nameMismatch", "unbound"]);
  assert.deepEqual([...ORPHAN_TERMINATE_CAUSES], ["staleIncarnation", "launchTerminated"]);
  assert.deepEqual([...ORPHAN_FAILURES], ["credentialUnusable", "providerError", "timeout"]);
  for (const list of [LAUNCH_RECORD_OUTCOMES, ORPHAN_BINDINGS, ORPHAN_REPORT_ONLY_REASONS, ORPHAN_TERMINATE_CAUSES, ORPHAN_FAILURES]) {
    assert.equal(Object.isFrozen(list), true);
  }
});

test("launch record outcomes: exactly the launches table's, from the newest migration that defines it", () => {
  const dir = new URL("../../control/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  let outcomes: string[] | null = null;
  for (const f of files) {
    const sql = readFileSync(new URL(f, dir), "utf8");
    if (!/CREATE TABLE launches \(/.test(sql)) continue;
    const m = /outcome TEXT NOT NULL CHECK \(outcome IN \(([^)]*)\)\)/.exec(sql);
    assert.ok(m, `${f}: the outcome CHECK`);
    outcomes = [...m[1]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!);
  }
  assert.deepEqual([...LAUNCH_RECORD_OUTCOMES], ["creating", "launched", "issued", "enrolled", "terminate", "terminated"]);
  assert.deepEqual([...LAUNCH_RECORD_OUTCOMES], outcomes);
});

test("a report of every kind of row type-checks against the contract", () => {
  const at = "2026-11-25T23:00:00.000Z";
  const machineId = "mch_0123456789abcdefghjk";
  const report: OrphanReport = {
    installation: "dev1",
    startedAt: at,
    finishedAt: at,
    coverage: [
      { provider: "runpod", account: { kind: "platform" }, listed: "ok" },
      { provider: "vast", account: { kind: "org", orgId: "org_0123456789abcdefghjk" }, listed: "failed", failure: "credentialUnusable" },
    ],
    rows: [
      {
        provider: "runpod",
        account: { kind: "platform" },
        providerMachineId: "p1",
        rawName: "sbg-dev1-0123456789abcdefghjk-2",
        parsed: { installation: "dev1", machineId, incarnation: 2 },
        binding: "providerId",
        launch: { incarnation: 2, outcome: "enrolled", currentIncarnation: 2 },
        ledgerState: "running",
        firstSeenAt: at,
        providerCostPerHour: 440_000,
        sweep: { action: "kept", reason: "launchActive" },
      },
      {
        provider: "runpod",
        account: { kind: "platform" },
        providerMachineId: "p2",
        rawName: "sbg-x",
        parsed: null,
        binding: "none",
        launch: null,
        ledgerState: null,
        firstSeenAt: at,
        providerCostPerHour: null,
        sweep: { action: "reportOnly", reason: "unparsed" },
      },
      {
        provider: "runpod",
        account: { kind: "platform" },
        providerMachineId: "p3",
        rawName: "sbg-dev1-0123456789abcdefghjk-1",
        parsed: { installation: "dev1", machineId, incarnation: 1 },
        binding: "launchIntent",
        launch: { incarnation: 1, outcome: "creating", currentIncarnation: 2 },
        ledgerState: "running",
        firstSeenAt: at,
        providerCostPerHour: 440_000,
        sweep: { action: "terminateFailed", at, because: "staleIncarnation", failure: "timeout", nextAttemptAt: at },
      },
    ],
  };
  assert.equal(report.rows.length, 3);
});
