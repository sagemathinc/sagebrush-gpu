import { test } from "node:test";
import assert from "node:assert/strict";
import { MACHINE_STATES, QUOTE_REFUSALS, STOP_REASONS, type Machine, type SpendMeter } from "@sbgpu/api";
import { MACHINE_DOMAIN, TEST_MACHINE_DOMAIN } from "./config.ts";
import { capitalize, GENERIC_LABELS, plural, resolveLabels, withArticle } from "./labels.ts";
import { ago, formatBytes, hoursOnAllocation, startRefusalText, jupyterUrl, machineActions, machineStateLabel, meterView, pausedStartText, pauseView, refusalText, savePercent, START_FAILURE_WORDS, startFailureText, STORAGE_NEAR_FRACTION, stopReasonText, storageLevel, storageWarning } from "./view.ts";

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
    startFailure: null,
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

test("jupyterUrl: only exactly the machine's own https origin", () => {
  const id = "mch_0000000000000000000a";
  const domain = "machines.example.org";
  const ok = `https://m-${id}.${domain}/?code=abc`;
  assert.equal(jupyterUrl(ok, id, domain), ok);
  // Case doesn't matter in a host name: it compares as lowercase.
  assert.equal(jupyterUrl(`https://M-${id.toUpperCase()}.Machines.Example.ORG/lab`, id, domain), `https://m-${id}.${domain}/lab`);
  for (const bad of [
    `https://m-${id}.attacker.example/steal?code=secret`, // the right label, someone else's domain
    `https://m-${id}.${domain}.attacker.example/`,
    `https://x.m-${id}.${domain}/`,
    `https://${domain}/`,
    `javascript:alert(1)//m-${id}.${domain}`,
    `data:text/html,<script>1</script>`,
    `http://m-${id}.${domain}/`,
    `https://evil.example/`,
    `https://m-mch_000000000000000000zz.${domain}/`, // another machine
    `https://m-${id}x.${domain}/`,
    `https://user:pw@m-${id}.${domain}/`,
    `https://m-${id}.${domain}@evil.example/`, // userinfo trick: the host is evil.example
    `https://user@m-${id}.${domain}/`,
    `https://:pw@m-${id}.${domain}/`,
    `https://m-${id}.${domain}:8443/`,
    `//m-${id}.${domain}/`, // relative: no base, so it doesn't parse
    `/lab`,
    "https://",
    "",
  ]) {
    assert.equal(jupyterUrl(bad, id, domain), null, bad);
  }
  assert.equal(jupyterUrl(42, id, domain), null);
  assert.equal(jupyterUrl(null, id, domain), null);
  assert.equal(jupyterUrl(new URL(ok), id, domain), null); // only the API's string, never an object
  assert.equal(jupyterUrl(ok, id, ""), null); // no configured domain: nothing opens
  assert.equal(jupyterUrl(`https://m-${id}./`, id, ""), null); // ...not even a bare label
  assert.equal(jupyterUrl(ok, id, "Machines.Example.ORG"), ok); // the configured domain's case doesn't matter
  // Without a domain argument, the build's MACHINE_DOMAIN (the test default here).
  assert.equal(MACHINE_DOMAIN, TEST_MACHINE_DOMAIN);
  assert.equal(TEST_MACHINE_DOMAIN, "machines.invalid");
  assert.equal(jupyterUrl(`https://m-${id}.machines.invalid/x`, id), `https://m-${id}.machines.invalid/x`);
  assert.equal(jupyterUrl(ok, id), null);
});

test("meterView under byok: the rate without a service part", () => {
  const running = meter({ currentRatePerHour: { providerCost: 480_000, margin: 0, total: 480_000 } });
  assert.equal(meterView(running, "byok").rate, "$0.48/h");
  assert.equal(meterView(running).rate, "provider $0.48/h + service $0.00/h = $0.48/h"); // resold, the default
  assert.equal(meterView(meter(), "byok").rate, null);
});

test("a paused provider: the refusal and the refused start name it; the banner's reason only when asked to show it", () => {
  assert.equal(refusalText("credentialUnusable", COURSE, "vast"), "Launches on Vast.ai are paused: the organization's key for it isn't working.");
  assert.equal(refusalText("credentialUnusable", COURSE), "Launches are paused: the organization's provider key isn't working.");
  assert.equal(refusalText("noCapacity", COURSE, "vast"), refusalText("noCapacity", COURSE), "only credentialUnusable names a provider");
  assert.equal(pausedStartText("hyperstack", "api words"), "Launches on Hyperstack are paused for this organization until its key works again.");
  assert.equal(pausedStartText(undefined, "api words"), "api words");
  const now = Date.parse("2027-02-01T10:00:00.000Z");
  const pause = { provider: "runpod" as const, since: "2027-02-01T09:50:00.000Z", detail: { status: "rejected" as const, lastCheckedAt: "2027-02-01T09:57:00.000Z" } };
  const shown = pauseView(pause, true, now);
  assert.deepEqual(shown, {
    headline: "Launches on RunPod are paused for this organization. Machines already running keep running.",
    since: "Paused 10 min ago.",
    reason: "The organization's RunPod key was refused by the provider; last checked 3 min ago.",
  });
  // Not shown to this caller: no reason, even when the pause carries one.
  assert.deepEqual(pauseView(pause, false, now), { ...shown, reason: null });
  // Shown, but the server sent none: none.
  assert.equal(pauseView({ provider: "runpod", since: pause.since }, true, now).reason, null);
  assert.equal(pauseView({ ...pause, detail: { status: "revoked", lastCheckedAt: null } }, true, now).reason, "The organization's RunPod key was revoked at the provider; not checked since.");
  assert.equal(pauseView({ ...pause, detail: { status: "error", lastCheckedAt: pause.since } }, true, now).reason, "The organization's RunPod key couldn't be checked; last checked 10 min ago.");
});

test("storage levels: near from 90% of the quota, full at or over it (or with no quota); the meter's warnings", () => {
  const q = 50 * 1024 ** 3;
  assert.equal(STORAGE_NEAR_FRACTION, 0.9);
  assert.equal(storageLevel(0, q), "ok");
  assert.equal(storageLevel(0.9 * q - 1, q), "ok");
  assert.equal(storageLevel(0.9 * q, q), "near");
  assert.equal(storageLevel(q - 1, q), "near");
  assert.equal(storageLevel(q, q), "full");
  assert.equal(storageLevel(q + 1, q), "full");
  assert.equal(storageLevel(0, 0), "full", "a quota of 0 has no room");
  assert.equal(storageLevel(10, 100), "ok");
  assert.equal(storageLevel(90, 100), "near");
  assert.equal(storageWarning("ok", COURSE), null);
  assert.equal(storageWarning("near", COURSE), "Storage is nearly full. Delete files you don't need, or ask an instructor to raise the limit.");
  assert.equal(storageWarning("full", GENERIC_LABELS), "Storage is full: your workspace can't grow until you delete files or a manager raises the limit.");
});

test("a start that never came up: its own label, why in plain words, what it cost, and nothing to stop", () => {
  const spent = { providerCost: 8_000, margin: 2_400, total: 10_400 };
  const deadline = machine({ state: "failed", startFailure: "createDeadline", spent, startedAt: null });
  const exited = machine({ state: "failed", startFailure: "podExited", spent, startedAt: null });
  const lost = machine({ state: "failed", stopReason: "provider" });
  assert.equal(machineStateLabel(deadline), "Didn't start");
  assert.equal(machineStateLabel(exited), "Didn't start");
  assert.equal(machineStateLabel(lost), "Failed");
  assert.equal(startFailureText(deadline, "resold"), "The machine didn't start: the provider didn't have it ready in time. This machine was charged $0.01 while it was starting, and nothing after that. You can start a new one.");
  assert.equal(startFailureText(exited, "resold"), "The machine didn't start: it stopped on its own before it was ready. This machine was charged $0.01 while it was starting, and nothing after that. You can start a new one.");
  // byok: metered use only; the provider bills the organization
  assert.equal(
    startFailureText(exited, "byok"),
    "The machine didn't start: it stopped on its own before it was ready. Metered use while starting: $0.01. No further use is being metered for this machine. Your provider bills your organization separately. You can start a new one.",
  );
  assert.doesNotMatch(startFailureText(deadline, "byok")!, /charged/);
  for (const mode of ["resold", "byok"] as const) {
    assert.equal(startFailureText(lost, mode), null, mode);
    assert.equal(startFailureText(machine(), mode), null, mode);
  }
  assert.deepEqual(START_FAILURE_WORDS, { createDeadline: "the provider didn't have it ready in time", podExited: "it stopped on its own before it was ready" });
  assert.deepEqual([machineActions(deadline).stop, machineActions(deadline).delete, machineActions(deadline).restart], [false, true, false]);
  assert.deepEqual([machineActions(lost).stop, machineActions(lost).delete], [true, true], "a machine that failed later may still need stopping");
});

test("a refused start in plain words, by its code alone", () => {
  assert.equal(startRefusalText("priceCap", COURSE), "The price is now higher than the one you saw, or above the course's limit. Check the price and try again.");
  assert.equal(startRefusalText("allocationTooLow", COURSE), "Your allocation doesn't have enough left for this GPU's shortest run. Try a cheaper one, or ask an instructor for more.");
  assert.equal(startRefusalText("budgetExhausted", COURSE), "Your allocation is used up. Ask an instructor for more.");
  assert.equal(startRefusalText("invalidState", COURSE), "It can't start right now, perhaps while a restore of your workspace finishes. Try again in a moment.");
  assert.equal(startRefusalText("conflict", COURSE), "Several starts happened at once. Try again.");
  for (const code of ["projectNotStarted", "projectEnded", "noCapacity", "policy", "concurrencyCap"] as const) assert.equal(startRefusalText(code, COURSE), refusalText(code, COURSE), code);
  for (const code of ["credentialUnusable", "badRequest", "notFound", "internal", "unauthenticated", "forbidden"] as const) assert.equal(startRefusalText(code, COURSE), null, code);
});

test("how long the allocation lasts at an all-in price: whole hours from 10, tenths below, and less than an hour", () => {
  assert.equal(hoursOnAllocation(25_000_000, 624_000, "resold"), "Your allocation buys about 40 h at this price.");
  assert.equal(hoursOnAllocation(25_334_400, 624_000, "resold"), "Your allocation buys about 40 h at this price.", "40.6 h: rounded down, never promised");
  assert.equal(hoursOnAllocation(6_240_000, 624_000, "resold"), "Your allocation buys about 10 h at this price.");
  assert.equal(hoursOnAllocation(6_239_999, 624_000, "resold"), "Your allocation buys about 9.9 h at this price.");
  assert.equal(hoursOnAllocation(3_000_000, 624_000, "resold"), "Your allocation buys about 4.8 h at this price.");
  assert.equal(hoursOnAllocation(624_000, 624_000, "resold"), "Your allocation buys about 1.0 h at this price.");
  assert.equal(hoursOnAllocation(623_999, 624_000, "resold"), "Your allocation buys less than an hour at this price.");
  assert.equal(hoursOnAllocation(3_000_000, 624_000, "byok"), "Your allocation covers about 4.8 h of metered use at this price.");
  for (const [r, p] of [[0, 624_000], [-1, 624_000], [1_000_000, 0], [1_000_000, -5], [Number.NaN, 1], [1, Number.NaN]] as const) {
    assert.equal(hoursOnAllocation(r, p, "resold"), null, `${r} at ${p}`);
  }
});
