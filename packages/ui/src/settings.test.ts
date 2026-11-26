import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, MAX_LABEL_LENGTH, MAX_SETUP_SCRIPT_LENGTH, type Project } from "@sbgpu/api";
import { MAX_PROJECT_NAME_LENGTH, microToDollars, settingsForm, settingsRequest, type SettingsForm } from "./settings.ts";

const GIB = 1024 ** 3;

function project(over: Partial<Project> = {}): Project {
  return {
    id: "prj_1",
    orgId: "org_1",
    billingMode: "resold",
    name: "Fine-tuning lab",
    labels: null,
    startsAt: "2027-01-01T00:00:00.000Z",
    endsAt: "2027-06-01T00:00:00.000Z",
    marginBpsOverride: null,
    budget: 100_000_000,
    allocated: 0,
    spent: { providerCost: 0, margin: 0, total: 0 },
    policy: { ...DEFAULT_POLICY, allowedGpuTypes: ["L4", "A6000"], allowedProviders: ["runpod", "nebius"], allowedCountries: ["GB", "SE"] },
    createdAt: "2026-12-01T00:00:00.000Z",
    ...over,
  };
}

/** The request after `edit` changes a fresh form. */
function after(edit: (f: SettingsForm) => void, p = project()) {
  const base = settingsForm(p);
  const form = structuredClone(base);
  edit(form);
  return settingsRequest(form, base);
}

test("microToDollars: exact, at least two decimals", () => {
  assert.equal(microToDollars(0), "0.00");
  assert.equal(microToDollars(2_000_000), "2.00");
  assert.equal(microToDollars(2_500_000), "2.50");
  assert.equal(microToDollars(1_234_567), "1.234567");
  assert.equal(microToDollars(1_000_000_000), "1000.00");
  assert.equal(microToDollars(10), "0.00001");
});

test("the form shows the project as strings", () => {
  const f = settingsForm(project({ labels: { project: "course", member: "student", manager: "instructor", assistant: "TA", team: "group" } }));
  assert.equal(f.name, "Fine-tuning lab");
  assert.equal(f.customLabels, true);
  assert.equal(f.labels.member, "student");
  assert.equal(f.allowedGpuTypes, "L4, A6000");
  assert.deepEqual(f.allowedProviders, ["runpod", "nebius"]);
  assert.equal(f.locality, "any");
  assert.equal(f.allowedCountries, "GB, SE");
  assert.equal(f.maxPricePerHour, "2.00");
  assert.deepEqual(f.whole, {
    maxConcurrentMachines: "10",
    maxMachinesPerMember: "1",
    idleStopMinutes: "30",
    maxSessionMinutes: "480",
    minStartMinutes: "15",
    finalSaveReserveMinutes: "10",
    snapshotKeepLast: "10",
    snapshotNamedMax: "5",
  });
  assert.deepEqual(f.gib, { storageQuotaBytesPerMember: "50", storageQuotaBytesPerTeam: "50" });
  assert.equal(f.maxGpusPerTeam, "");
  assert.equal(f.setupScript, "");
  assert.equal(settingsForm(project({ policy: { ...DEFAULT_POLICY, maxGpusPerTeam: 3 } })).maxGpusPerTeam, "3");
  const g = settingsForm(project({ policy: { ...DEFAULT_POLICY, allowedCountries: null, setupScript: "pip install peft" } }));
  assert.equal(g.customLabels, false);
  assert.equal(g.labels.member, "member"); // the generic words, ready to edit
  assert.equal(g.allowedCountries, "");
  assert.equal(g.setupScript, "pip install peft");
});

test("nothing changed: an empty request", () => {
  assert.deepEqual(after(() => {}), { ok: true, value: {} });
  // Editing a field back to what it was is no change either.
  assert.deepEqual(after((f) => {
    f.whole.idleStopMinutes = "45";
    f.whole.idleStopMinutes = "30";
  }), { ok: true, value: {} });
});

test("only the edited fields are sent", () => {
  assert.deepEqual(after((f) => (f.whole.idleStopMinutes = " 45 ")), { ok: true, value: { policy: { idleStopMinutes: 45 } } });
  assert.deepEqual(after((f) => (f.name = "  Spring lab ")), { ok: true, value: { name: "Spring lab" } });
  assert.deepEqual(after((f) => (f.maxPricePerHour = "$3.5")), { ok: true, value: { policy: { maxPricePerHour: 3_500_000 } } });
  assert.deepEqual(after((f) => (f.allowedGpuTypes = "L4,A100-80GB  H100")), { ok: true, value: { policy: { allowedGpuTypes: ["L4", "A100-80GB", "H100"] } } });
  assert.deepEqual(after((f) => (f.allowedGpuTypes = "")), { ok: true, value: { policy: { allowedGpuTypes: [] } } });
  assert.deepEqual(after((f) => (f.allowedGpuTypes = "L4")), { ok: true, value: { policy: { allowedGpuTypes: ["L4"] } } });
  // The order is the order members see them in: a reordering is a change.
  assert.deepEqual(after((f) => (f.allowedGpuTypes = "A6000, L4")), { ok: true, value: { policy: { allowedGpuTypes: ["A6000", "L4"] } } });
  assert.deepEqual(after((f) => (f.locality = "uk")), { ok: true, value: { policy: { locality: "uk" } } });
  assert.deepEqual(after((f) => (f.allowedCountries = "gb no")), { ok: true, value: { policy: { allowedCountries: ["GB", "NO"] } } });
  assert.deepEqual(after((f) => (f.allowedCountries = " ")), { ok: true, value: { policy: { allowedCountries: null } } });
  assert.deepEqual(after((f) => (f.gib.storageQuotaBytesPerTeam = "1.5")), { ok: true, value: { policy: { storageQuotaBytesPerTeam: 1.5 * GIB } } });
  assert.deepEqual(after((f) => (f.setupScript = "pip install x\n")), { ok: true, value: { policy: { setupScript: "pip install x\n" } } });
  // Spacing alone is no change.
  assert.deepEqual(after((f) => (f.setupScript = "  \n")), { ok: true, value: {} });
  assert.deepEqual(after((f) => (f.whole.idleStopMinutes = " 30 ")), { ok: true, value: {} });
  assert.deepEqual(after((f) => (f.maxPricePerHour = " 2.00")), { ok: true, value: {} });
  assert.deepEqual(after((f) => (f.gib.storageQuotaBytesPerMember = "50 ")), { ok: true, value: {} });
  assert.deepEqual(after((f) => (f.name = " Fine-tuning lab ")), { ok: true, value: {} });
  assert.deepEqual(after((f) => (f.allowedGpuTypes = "L4,A6000")), { ok: true, value: {} });
  assert.deepEqual(after((f) => (f.allowedCountries = "gb, se")), { ok: true, value: {} });
});

test("providers: a change in the set is sent, in the contract's order; a reordering isn't", () => {
  assert.deepEqual(after((f) => (f.allowedProviders = ["nebius", "shadeform", "runpod"])), {
    ok: true,
    value: { policy: { allowedProviders: ["runpod", "shadeform", "nebius"] } },
  });
  assert.deepEqual(after((f) => (f.allowedProviders = ["nebius", "runpod"])), { ok: true, value: {} });
  assert.deepEqual(after((f) => (f.allowedProviders = ["runpod"])), { ok: true, value: { policy: { allowedProviders: ["runpod"] } } });
  assert.deepEqual(after((f) => (f.allowedProviders = ["shadeform", "runpod"])), { ok: true, value: { policy: { allowedProviders: ["runpod", "shadeform"] } } });
});

test("the setup script: emptied means none; whitespace alone is none too", () => {
  const p = project({ policy: { ...DEFAULT_POLICY, setupScript: "pip install peft" } });
  assert.deepEqual(after((f) => (f.setupScript = ""), p), { ok: true, value: { policy: { setupScript: null } } });
  assert.deepEqual(after((f) => (f.setupScript = " \n "), p), { ok: true, value: { policy: { setupScript: null } } });
  assert.deepEqual(after((f) => (f.setupScript = "x".repeat(MAX_SETUP_SCRIPT_LENGTH)), p).ok, true);
  assert.deepEqual(after((f) => (f.setupScript = "x".repeat(MAX_SETUP_SCRIPT_LENGTH + 1)), p), {
    ok: false,
    reason: `Setup script: at most ${MAX_SETUP_SCRIPT_LENGTH} characters`,
  });
});

test("the words: custom words are trimmed and checked; switching them off sends null", () => {
  assert.deepEqual(after((f) => {
    f.customLabels = true;
    f.labels = { project: " course", member: "student ", manager: "instructor", assistant: "TA", team: "group" };
  }), { ok: true, value: { labels: { project: "course", member: "student", manager: "instructor", assistant: "TA", team: "group" } } });
  const custom = project({ labels: { project: "course", member: "student", manager: "instructor", assistant: "TA", team: "group" } });
  assert.deepEqual(after((f) => (f.customLabels = false), custom), { ok: true, value: { labels: null } });
  assert.deepEqual(after((f) => (f.labels.team = "section"), custom), {
    ok: true,
    value: { labels: { project: "course", member: "student", manager: "instructor", assistant: "TA", team: "section" } },
  });
  // Words edited while custom words are off aren't sent.
  assert.deepEqual(after((f) => (f.labels.team = "section")), { ok: true, value: {} });
  for (const bad of ["", "  ", "x".repeat(MAX_LABEL_LENGTH + 1)]) {
    assert.deepEqual(after((f) => (f.labels.member = bad), custom), { ok: false, reason: `Words: each 1 to ${MAX_LABEL_LENGTH} characters` }, JSON.stringify(bad));
  }
  assert.equal(after((f) => (f.labels.member = "x".repeat(MAX_LABEL_LENGTH)), custom).ok, true);
});

test("the name: trimmed, 1 to the control plane's limit", () => {
  assert.deepEqual(after((f) => (f.name = "   ")), { ok: false, reason: `Name: 1 to ${MAX_PROJECT_NAME_LENGTH} characters` });
  assert.deepEqual(after((f) => (f.name = "x".repeat(MAX_PROJECT_NAME_LENGTH + 1))), { ok: false, reason: `Name: 1 to ${MAX_PROJECT_NAME_LENGTH} characters` });
  assert.deepEqual(after((f) => (f.name = ` ${"x".repeat(MAX_PROJECT_NAME_LENGTH)} `)), { ok: true, value: { name: "x".repeat(MAX_PROJECT_NAME_LENGTH) } });
});

test("numbers outside their bounds, or not numbers, say which field and the range", () => {
  const whole = (k: keyof SettingsForm["whole"], v: string) => after((f) => (f.whole[k] = v));
  assert.deepEqual(whole("idleStopMinutes", "4"), { ok: false, reason: "Stop when idle for (minutes): a whole number from 5 to 1440" });
  assert.deepEqual(whole("idleStopMinutes", "5"), { ok: true, value: { policy: { idleStopMinutes: 5 } } });
  assert.deepEqual(whole("idleStopMinutes", "1440"), { ok: true, value: { policy: { idleStopMinutes: 1440 } } });
  assert.deepEqual(whole("idleStopMinutes", "1441"), { ok: false, reason: "Stop when idle for (minutes): a whole number from 5 to 1440" });
  for (const bad of ["", "1.5", "-5", "30m", "1e2"]) {
    assert.deepEqual(whole("maxMachinesPerMember", bad), { ok: false, reason: "Machines running at once, per person: a whole number from 0 to 16" }, bad);
  }
  assert.deepEqual(whole("maxMachinesPerMember", "0"), { ok: true, value: { policy: { maxMachinesPerMember: 0 } } });
  assert.deepEqual(whole("maxMachinesPerMember", "17"), { ok: false, reason: "Machines running at once, per person: a whole number from 0 to 16" });

  const team = (v: string, p = project()) => after((f) => (f.maxGpusPerTeam = v), p);
  assert.deepEqual(team("2"), { ok: true, value: { policy: { maxGpusPerTeam: 2 } } });
  assert.deepEqual(team(" 0 "), { ok: true, value: { policy: { maxGpusPerTeam: 0 } } });
  assert.deepEqual(team("1000"), { ok: true, value: { policy: { maxGpusPerTeam: 1000 } } });
  assert.deepEqual(team("  "), { ok: true, value: {} }); // still one per member: no change
  const capped = project({ policy: { ...DEFAULT_POLICY, maxGpusPerTeam: 3 } });
  assert.deepEqual(team("", capped), { ok: true, value: { policy: { maxGpusPerTeam: null } } });
  assert.deepEqual(team("3", capped), { ok: true, value: {} });
  for (const bad of ["1001", "1.5", "-1", "two", "1e2"]) {
    assert.deepEqual(team(bad), { ok: false, reason: "GPUs running at once, per team: empty for one per member, or a whole number from 0 to 1000" }, bad);
  }

  const price = (v: string) => after((f) => (f.maxPricePerHour = v));
  assert.deepEqual(price("1000"), { ok: true, value: { policy: { maxPricePerHour: 1_000_000_000 } } });
  assert.deepEqual(price("0"), { ok: true, value: { policy: { maxPricePerHour: 0 } } });
  for (const bad of ["1000.000001", "-1", "abc", ""]) {
    assert.deepEqual(price(bad), { ok: false, reason: "Highest price per hour: a dollar amount from $0 to $1000" }, bad);
  }

  const gib = (v: string) => after((f) => (f.gib.storageQuotaBytesPerMember = v));
  assert.deepEqual(gib("1024"), { ok: true, value: { policy: { storageQuotaBytesPerMember: 1024 * GIB } } });
  assert.deepEqual(gib("0"), { ok: true, value: { policy: { storageQuotaBytesPerMember: 0 } } });
  assert.deepEqual(gib("0.1"), { ok: true, value: { policy: { storageQuotaBytesPerMember: Math.round(0.1 * GIB) } } }); // whole bytes
  for (const bad of ["1024.5", "-1", "", "1e3", "ten", ".5"]) {
    assert.deepEqual(gib(bad), { ok: false, reason: "Storage per person (GiB): a number from 0 to 1024" }, bad);
  }
});

test("a quota that isn't a whole number of GiB shows exactly and isn't sent unless edited", () => {
  const p = project({ policy: { ...DEFAULT_POLICY, storageQuotaBytesPerMember: 1_000_000_000 } });
  const f = settingsForm(p);
  assert.equal(Math.round(Number(f.gib.storageQuotaBytesPerMember) * GIB), 1_000_000_000);
  assert.deepEqual(after((g) => (g.whole.idleStopMinutes = "40"), p), { ok: true, value: { policy: { idleStopMinutes: 40 } } });
});

test("the contract's list rules, in the form's words", () => {
  assert.deepEqual(after((f) => (f.allowedGpuTypes = "L4 L4")), { ok: false, reason: "GPU types allowed: at most 64 distinct GPU types" });
  assert.deepEqual(after((f) => (f.allowedGpuTypes = "L4 bad/type")), { ok: false, reason: "GPU types allowed: at most 64 distinct GPU types" });
  assert.deepEqual(after((f) => (f.allowedCountries = "GB GBR")), { ok: false, reason: "Only these countries: null, or distinct ISO 3166 alpha-2 codes" });
  assert.deepEqual(after((f) => (f.allowedCountries = "GB gb")), { ok: false, reason: "Only these countries: null, or distinct ISO 3166 alpha-2 codes" });
});

test("several edits together, and the first problem wins", () => {
  assert.deepEqual(
    after((f) => {
      f.name = "Lab 2";
      f.locality = "europe";
      f.whole.maxConcurrentMachines = "20";
    }),
    { ok: true, value: { name: "Lab 2", policy: { locality: "europe", maxConcurrentMachines: 20 } } },
  );
  assert.deepEqual(
    after((f) => {
      f.name = "";
      f.whole.maxConcurrentMachines = "x";
    }).ok,
    false,
  );
});
