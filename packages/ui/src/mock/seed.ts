// A demo world for the mock: one organization, one project in progress, people in every
// role, two teams and a price list with each kind of refusal reachable. All names are made
// up; prices are illustrative, not any provider's.

import type { BillingMode, Offer } from "@sbgpu/api";
import { toIso } from "@sbgpu/api";
import { MockBackend } from "./backend.ts";

export const DEMO_START = Date.parse("2027-02-01T09:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

export interface Demo {
  backend: MockBackend;
  orgId: string;
  projectId: string;
  emails: { owner: string; manager: string; assistant: string; member: string; lowMember: string; teamMember: string };
}

export function demoOffers(observedAt: string): Offer[] {
  const offer = (provider: Offer["provider"], gpuType: string, dataCenter: string, country: string, cost: number, stock: Offer["stock"]): Offer => ({
    provider,
    gpuType,
    gpuCount: 1,
    dataCenter,
    country,
    providerCostPerHour: cost,
    stock,
    observedAt,
  });
  return [
    offer("runpod", "L4", "EU-SE-1", "SE", 480_000, "high"),
    offer("hyperstack", "L4", "CANADA-1", "CA", 550_000, "medium"),
    offer("runpod", "A6000", "US-TX-3", "US", 790_000, "low"),
    offer("hyperstack", "A6000", "NORWAY-1", "NO", 800_000, "none"),
    offer("runpod", "A100-80GB", "EU-RO-1", "RO", 1_890_000, "medium"),
    offer("nebius", "H100", "eu-north1", "FI", 2_950_000, "high"),
    offer("runpod", "A10", "US-KS-2", "US", 400_000, "none"),
  ];
}

/** billingMode "byok": the organization uses its own provider keys (at margin 0). */
export function seedDemo(options: { billingMode?: BillingMode } = {}): Demo {
  const b = new MockBackend({ startMs: DEMO_START });
  const org = options.billingMode === "byok" ? b.addOrg("Example Org", 0, 5_000_000_000, "byok") : b.addOrg("Example Org", 3000, 5_000_000_000);
  const emails = {
    owner: "owner@example.org",
    manager: "manager@example.org",
    assistant: "assistant@example.org",
    member: "ada@example.org",
    lowMember: "grace@example.org",
    teamMember: "alan@example.org",
  };
  const owner = b.addUser(emails.owner, "Olive Owner");
  b.setOrgRole(org.id, owner.id, "owner");
  const project = b.addProject(org.id, {
    name: "Fine-tuning lab",
    budget: 2_000_000_000,
    startsAt: toIso(DEMO_START - DAY),
    endsAt: toIso(DEMO_START + 60 * DAY),
    labels: { project: "course", member: "student", manager: "instructor", assistant: "TA", team: "team" },
    policy: {
      allowedGpuTypes: ["L4", "A6000", "A100-80GB", "A10"],
      allowedProviders: ["runpod", "hyperstack"],
      maxPricePerHour: 2_000_000,
      setupScript: "pip install transformers peft datasets",
    },
  });
  b.offers = demoOffers(toIso(DEMO_START));
  const person = (email: string, name: string, role: "member" | "assistant" | "manager", allocation: number) => {
    const user = b.addUser(email, name);
    return b.addMember(project.id, { email, name, role, allocation, userId: user.id });
  };
  b.addMember(project.id, { email: emails.owner, name: "Olive Owner", role: "owner", userId: owner.id });
  person(emails.manager, "Morgan Manager", "manager", 0);
  person(emails.assistant, "Ash Assistant", "assistant", 0);
  const ada = person(emails.member, "Ada", "member", 25_000_000);
  person(emails.lowMember, "Grace", "member", 200_000);
  const alan = person(emails.teamMember, "Alan", "member", 25_000_000);
  const edsger = person("edsger@example.org", "Edsger", "member", 25_000_000);
  b.addMember(project.id, { email: "barbara@example.org", allocation: 25_000_000 });
  b.addTeam(project.id, "Team Llama", [alan.id, edsger.id], 50_000_000);
  b.addTeam(project.id, "Team Qwen", [ada.id], 50_000_000);
  return { backend: b, orgId: org.id, projectId: project.id, emails };
}
