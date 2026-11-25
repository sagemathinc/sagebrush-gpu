// The words for an organization's billing mode, everywhere the UI speaks of money: the
// organization's page, and the project's pages (from Project.billingMode). Under byok the
// provider bills the organization and the meter only counts against budgets, so there is
// no service line and spend is "metered use".

import type { BillingMode } from "@sbgpu/api";

/** The words for each billing mode. Never "no charge" or "no markup": byok has a fee by agreement. */
export const BILLING_WORDS: {
  readonly [M in BillingMode]: { about: string; unassigned: string; total: string; spent: string; costSoFar: string; billedBy: string | null };
} = {
  resold: {
    about: "Credit is bought from us and assigned to projects as budgets.",
    unassigned: "Credit not yet assigned to projects",
    total: "Credit bought in all",
    spent: "Spent",
    costSoFar: "Cost so far",
    billedBy: null,
  },
  byok: {
    about:
      "Machines run on your organization's own provider accounts, which the providers bill. Our flat fee is set in your agreement. Project budgets limit what each project may spend.",
    unassigned: "Budget not yet assigned to projects",
    total: "Budget granted in all",
    spent: "Metered use",
    costSoFar: "Metered so far",
    billedBy: "billed by the provider to your organization",
  },
};
