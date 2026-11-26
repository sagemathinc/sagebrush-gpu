import { test } from "node:test";
import assert from "node:assert/strict";
import type { ListSnapshotsResponse, Machine, Snapshot } from "@sbgpu/api";
import { tourPrefKey, tourSteps } from "./tour.ts";

const m = (state: Machine["state"]) => ({ state }) as Machine;
const saves = (...names: Array<string | null>): ListSnapshotsResponse => ({
  items: names.map((name, i) => ({ id: `snp_${i}`, name }) as Snapshot),
  keepLast: 10,
  namedMax: 5,
});
const done = (input: Parameters<typeof tourSteps>[0]) => Object.fromEntries(tourSteps(input).map((s) => [s.id, s.done]));

test("the four steps, in order, each with a title and a hint", () => {
  const steps = tourSteps({ machines: [], memberSaves: null, jupyterOpened: false });
  assert.deepEqual(steps.map((s) => s.id), ["start", "jupyter", "save", "stop"]);
  assert.deepEqual(steps.map((s) => s.title), ["Start a machine", "Open Jupyter", "Save with a name", "Stop it when you're done"]);
  assert.deepEqual(steps.map((s) => s.hint), [
    "Pick a GPU below and press Start. It takes a minute or two to boot.",
    "When the machine is running, press Open Jupyter on its card.",
    "Press Save with a name… on the machine's card, so you can find this point again.",
    "Press Stop: your work is saved first, and it stops using your allocation once it has stopped.",
  ]);
  assert.deepEqual(done({ machines: [], memberSaves: null, jupyterOpened: false }), { start: false, jupyter: false, save: false, stop: false });
});

test("each step is ticked by what really happened", () => {
  assert.equal(done({ machines: [m("starting")], memberSaves: null, jupyterOpened: false }).start, true);
  assert.equal(done({ machines: [m("deleted")], memberSaves: null, jupyterOpened: false }).start, false, "a deleted machine doesn't count");
  assert.equal(done({ machines: [], memberSaves: null, jupyterOpened: true }).jupyter, true);
  assert.equal(done({ machines: [], memberSaves: saves(null, null), jupyterOpened: false }).save, false, "unnamed saves don't count");
  assert.equal(done({ machines: [], memberSaves: saves(null, "before I break it"), jupyterOpened: false }).save, true);
  for (const state of ["starting", "running", "saving", "stopping", "failed"] as const) {
    assert.equal(done({ machines: [m(state)], memberSaves: null, jupyterOpened: false }).stop, false, state);
  }
  assert.equal(done({ machines: [m("running"), m("stopped")], memberSaves: null, jupyterOpened: false }).stop, true);
});

test("hidden is kept per person", () => {
  assert.equal(tourPrefKey("usr_a"), "sbgpu.tour.hidden.usr_a");
  assert.notEqual(tourPrefKey("usr_a"), tourPrefKey("usr_b"));
});
