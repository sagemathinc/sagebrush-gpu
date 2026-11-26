// The first-run walkthrough for a class member: four short steps (start a machine, open Jupyter,
// save with a name, stop it), each ticked from what has really happened, never from clicks on
// the walkthrough itself. It can be skipped at any time.

import type { ListSnapshotsResponse, Machine } from "@sbgpu/api";

export interface TourStep {
  id: "start" | "jupyter" | "save" | "stop";
  title: string;
  hint: string;
  done: boolean;
}

export interface TourInput {
  machines: readonly Machine[];
  /** The member's own saves, or null before they're read (or without a member area). */
  memberSaves: ListSnapshotsResponse | null;
  /** Jupyter was opened from this page in this session. */
  jupyterOpened: boolean;
}

export function tourSteps(input: TourInput): TourStep[] {
  const machines = input.machines.filter((m) => m.state !== "deleted");
  return [
    {
      id: "start",
      title: "Start a machine",
      hint: "Pick a GPU below and press Start. It takes a minute or two to boot.",
      done: machines.length > 0,
    },
    {
      id: "jupyter",
      title: "Open Jupyter",
      hint: "When the machine is running, press Open Jupyter on its card.",
      done: input.jupyterOpened,
    },
    {
      id: "save",
      title: "Save with a name",
      hint: "Press Save with a name… on the machine's card, so you can find this point again.",
      done: input.memberSaves?.items.some((s) => s.name != null) === true,
    },
    {
      id: "stop",
      title: "Stop it when you're done",
      hint: "Press Stop: your work is saved first, and it stops using your allocation once it has stopped.",
      done: machines.some((m) => m.state === "stopped"),
    },
  ];
}

/** Where "hidden" is kept, per user (so a shared browser shows each person their own). */
export function tourPrefKey(userId: string): string {
  return `sbgpu.tour.hidden.${userId}`;
}
