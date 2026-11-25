// Moving budget between an organization and one of its projects (an org owner's, on the
// organization's page): how much can go each way, and the amount typed, checked before it
// is sent, as the control plane will check it. Adding is bounded by what the organization
// hasn't assigned yet; returning, by the part of the project's budget not allocated (the
// budget never drops below its allocations).

import type { Micros, Organization, Project } from "@sbgpu/api";
import { formatUsd, parseUsd } from "./money.ts";

export interface MoveBounds {
  /** The most that can be added to the project's budget. */
  maxAdd: Micros;
  /** The most that can be returned to the organization. */
  maxReturn: Micros;
}

export function moveBounds(org: Pick<Organization, "unassignedCredit">, project: Pick<Project, "budget" | "allocated">): MoveBounds {
  return { maxAdd: org.unassignedCredit, maxReturn: Math.max(0, project.budget - project.allocated) };
}

export type MoveDirection = "add" | "return";

/** Dollars, to the cent, or exactly when there's less than a cent in it: a bound must be shown as it is. */
export function exactUsd(micro: Micros): string {
  return micro % 10_000 === 0 ? formatUsd(micro) : formatUsd(micro, 6).replace(/0+$/, "");
}

/**
 * The signed amount to send (positive adds, negative returns), or why not. The words
 * name no "credit": under byok these figures are a budget the organization grants itself.
 */
export function checkMove(text: string, direction: MoveDirection, bounds: MoveBounds): { ok: true; amount: Micros } | { ok: false; reason: string } {
  const micro = parseUsd(text);
  if (micro === null) return { ok: false, reason: "Enter an amount in dollars, with at most six decimals." };
  if (micro === 0) return { ok: false, reason: "Enter more than $0." };
  if (direction === "add" && micro > bounds.maxAdd) {
    return { ok: false, reason: `The organization has ${exactUsd(bounds.maxAdd)} not yet assigned.` };
  }
  if (direction === "return" && micro > bounds.maxReturn) {
    return { ok: false, reason: `Only ${exactUsd(bounds.maxReturn)} of this project's budget isn't allocated.` };
  }
  return { ok: true, amount: direction === "add" ? micro : -micro };
}
