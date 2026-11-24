import { test } from "node:test";
import assert from "node:assert/strict";
import { MACHINE_STATES, QUOTE_REFUSALS, STOP_REASONS, type Machine, type SpendMeter } from "@sbgpu/api";
import { capitalize, GENERIC_LABELS, plural, resolveLabels, withArticle } from "./labels.ts";
import { ago, formatBytes, machineActions, machineStateLabel, meterView, refusalText, savePercent, stopReasonText } from "./view.ts";

const COURSE = resolveLabels({ project: "course", member: "student", manager: "instructor", assistant: "TA", team: "group" });

export function machine(over: Partial<Machine> = {}): Machine {
  return {
    id: "mch_00000000000000000001",
    projectId: "prj_00000000000000000001",
    memberId: "mbr_00000000000000000001",
    allocationId: "alc_00000000000000000001",
    gpuType: "L4",
    gpuCount: 1,
    provider: "runpod",
    dataCenter: "EU-SE-1",
    pricePerHour: { providerCost: 480_000, margin: 144_000, total: 624_000 },
    state: "running",
    incarnation: 1,
    stopReason: null,
    finalSaveIncomplete: false,
    save: { state: "idle", lastSavedAt: null, progress: null, error: null, snapshotId: null },
    spent: { providerCost: 0, margin: 0, total: 0 },
    createdAt: "2027-02-01T09:00:00.000Z",
    startedAt: "2027-02-01T09:01:30.000Z",
    stoppedAt: null,
    maxSessionEndsAt: null,
    terminalAvailable: true,
    jupyterAvailable: true,
    error: null,
    ...over,
  };
}

function meter(over: Partial<SpendMeter> = {}): SpendMeter {
  return {
    allocationId: "alc_00000000000000000001",
    holder: { kind: "member", memberId: "mbr_00000000000000000001" },
    amount: 25_000_000,
    spent: { providerCost: 480_000, margin: 144_000, total: 624_000 },
    reserved: 0,
    remaining: 24_376_000,
    currentRatePerHour: { providerCost: 0, margin: 0, total: 0 },
    storage: { usedBytes: 0, quotaBytes: 50 * 1024 ** 3 },
    asOf: "2027-02-01T10:00:00.000Z",
    ...over,
  };
}

test("labels: project words replace generic ones; blanks fall back", () => {
  assert.deepEqual(resolveLabels(null), GENERIC_LABELS);
  assert.deepEqual(resolveLabels(undefined), GENERIC_LABELS);
  assert.equal(COURSE.member, "student");
  assert.deepEqual(resolveLabels({ member: "  ", manager: " PI " }), { ...GENERIC_LABELS, manager: "PI" });
  assert.deepEqual(["student", "instructor", "TA", "assistant", "Owner"].map(withArticle),
    ["a student", "an instructor", "a TA", "an assistant", "an Owner"]);
  assert.equal(capitalize("student"), "Student");
  assert.equal(capitalize("TA"), "TA");
  assert.equal(capitalize(""), "");
  assert.deepEqual(["TA", "student", "class", "box", "batch", "dish", "quiz", "company", "day"].map(plural),
    ["TAs", "students", "classes", "boxes", "batches", "dishes", "quizes", "companies", "days"]);
});

test("every machine state, stop reason and refusal has its own text", () => {
  const states = MACHINE_STATES.map((state) => machineStateLabel(machine({ state })));
  assert.equal(new Set(states).size, MACHINE_STATES.length);
  assert.equal(machineStateLabel(machine({ save: { ...machine().save, state: "saving" } })), "Running, saving");
  assert.equal(machineStateLabel(machine({ state: "saving" })), "Saving before stop");
  const reasons = STOP_REASONS.map((r) => stopReasonText(r, COURSE));
  assert.equal(new Set(reasons).size, STOP_REASONS.length);
  assert.equal(stopReasonText("manager", COURSE), "Stopped by an instructor.");
  assert.equal(stopReasonText("manager", GENERIC_LABELS), "Stopped by a manager.");
  assert.equal(stopReasonText("projectEnded", COURSE), "Stopped because the course ended.");
  assert.equal(stopReasonText("budget", COURSE), "Stopped because the allocation was nearly used up.");
  const refusals = QUOTE_REFUSALS.map((r) => refusalText(r, COURSE));
  assert.equal(new Set(refusals).size, QUOTE_REFUSALS.length);
  assert.equal(refusalText("priceCap", COURSE), "Over the course's price limit.");
  assert.equal(refusalText("policy", GENERIC_LABELS), "Not allowed in this project.");
});

test("machine actions per state", () => {
  const on = (m: Machine) => Object.entries(machineActions(m)).filter(([, v]) => v).map(([k]) => k);
  assert.deepEqual(on(machine({ state: "starting", terminalAvailable: false, jupyterAvailable: false })), ["stop"]);
  assert.deepEqual(on(machine()), ["openTerminal", "openJupyter", "save", "stop"]);
  assert.deepEqual(on(machine({ terminalAvailable: false, jupyterAvailable: false })), ["save", "stop"]);
  assert.deepEqual(on(machine({ save: { ...machine().save, state: "saving" } })), ["openTerminal", "openJupyter", "stop"]);
  assert.deepEqual(on(machine({ state: "saving" })), []);
  assert.deepEqual(on(machine({ state: "stopping" })), []);
  assert.deepEqual(on(machine({ state: "stopped" })), ["restart", "delete"]);
  assert.deepEqual(on(machine({ state: "failed" })), ["stop", "delete"]);
  assert.deepEqual(on(machine({ state: "deleted" })), []);
  // Terminal and Jupyter need a running machine, whatever the flags say.
  assert.deepEqual(on(machine({ state: "stopped", terminalAvailable: true, jupyterAvailable: true })), ["restart", "delete"]);
});

test("save percent", () => {
  const at = (bytesDone: number, bytesTotal: number) =>
    savePercent(machine({ save: { ...machine().save, state: "saving", progress: { bytesDone, bytesTotal } } }));
  assert.equal(savePercent(machine()), null);
  assert.equal(at(0, 100), 0);
  assert.equal(at(999, 1000), 99);
  assert.equal(at(1000, 1000), 100);
  assert.equal(at(5, 0), 100);
  assert.equal(at(0, 0), 100);
  assert.equal(at(2000, 1000), 100);
  assert.equal(at(-5, 1000), 0);
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1024 ** 2 - 1), "1024.0 KB");
  assert.equal(formatBytes(50 * 1024 ** 3), "50.0 GB");
  assert.equal(formatBytes(3 * 1024 ** 5), "3072.0 TB");
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
});

test("meterView: idle allocation", () => {
  const v = meterView(meter());
  assert.equal(v.band, "ok");
  assert.equal(v.usedPercent, 2); // 0.624 of 25 = 2.5%, rounded
  assert.equal(v.remaining, "$24.38");
  assert.equal(v.used, "$0.62");
  assert.equal(v.allocation, "$25.00");
  assert.equal(v.reserved, null);
  assert.equal(v.rate, null);
  assert.equal(v.timeLeft, null);
  assert.equal(v.storage, "0 B of 50.0 GB");
});

test("meterView: running, with the final-save reserve held back", () => {
  const v = meterView(meter({ reserved: 104_000, currentRatePerHour: { providerCost: 480_000, margin: 144_000, total: 624_000 } }));
  assert.equal(v.reserved, "$0.10");
  assert.equal(v.remaining, "$24.27");
  assert.equal(v.rate, "provider $0.48/h + service $0.14/h = $0.62/h");
  assert.equal(v.timeLeft, "about 1 d 14 h left at $0.62/h"); // 24.272 / 0.624 = 38.9 h
});

test("meterView: bands and the used bar", () => {
  const band = (total: number) => meterView(meter({ spent: { providerCost: total, margin: 0, total } }));
  assert.equal(band(25_000_000).band, "empty");
  assert.equal(band(25_000_000).usedPercent, 100);
  assert.equal(band(30_000_000).usedPercent, 100);
  assert.equal(band(24_000_000).band, "critical");
  assert.equal(band(20_000_001).band, "low");
  assert.equal(band(0).usedPercent, 0);
  assert.equal(band(5_150_000).usedPercent, 21); // 20.6% rounds to 21
  assert.equal(meterView(meter({ amount: 0, spent: { providerCost: 0, margin: 0, total: 0 } })).band, "empty");
});

test("ago", () => {
  const t = Date.parse("2027-02-01T10:00:00.000Z");
  assert.equal(ago("2027-02-01T10:00:00.000Z", t), "just now");
  assert.equal(ago("2027-02-01T09:59:01.000Z", t), "just now");
  assert.equal(ago("2027-02-01T09:59:00.000Z", t), "1 min ago");
  assert.equal(ago("2027-02-01T07:40:00.000Z", t), "2 h 20 min ago");
  assert.equal(ago("2027-02-01T10:05:00.000Z", t), "just now"); // a clock a little behind
});
