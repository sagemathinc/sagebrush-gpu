// Placement for the start and quote routes: the offers a project's policy allows, listed fresh
// from the providers that have a launch path, ranked (cheapest first), and stamped with control's
// clock so admission can tell how old they are. A provider whose list fails or is late is named
// as unavailable and its offers are left out; the others' offers stand. A late answer changes
// nothing: only what each call returned within its deadline is used.

import { rankAllowed, rankOffers, type Offer, type OfferQuery, type PlacementPolicy, type ProviderId } from "@sbgpu/providers";
import type { ListedOffer } from "./start.ts";
import { withDeadline } from "./vm.ts";

/** The one call placement makes on a provider. */
export interface OfferLister {
  listOffers(query: OfferQuery): Promise<Offer[]>;
}

export interface PlacementDeps {
  /** The adapters of providers with a launch path (today RunPod, in container mode), by provider. */
  listers: Partial<Record<ProviderId, OfferLister>>;
  /** Control's clock. */
  clock: () => number;
}

export interface Placement {
  /** Ranked best first, every one stamped with the same listing time. */
  offers: ListedOffer[];
  /** Providers the policy allows that have a launch path but couldn't be listed now, in order. */
  unavailableProviders: ProviderId[];
}

/**
 * The offers for `gpuCount` GPUs (of `gpuType`, or of any allowed type when it's null): one list
 * call to each provider the policy allows and that has a launch path, at the same time and each
 * within its deadline. Offers a provider returns for another provider are dropped. They are
 * stamped with the clock after every call has answered or timed out, then ranked.
 */
export async function listPlacement(deps: PlacementDeps, policy: PlacementPolicy, gpuCount: number, gpuType: string | null): Promise<Placement> {
  const providers = [...new Set(policy.allowedProviders)].filter((p) => deps.listers[p] !== undefined).sort();
  const lists = await Promise.all(
    providers.map((p) => withDeadline<Offer[] | "unavailable">(() => deps.listers[p]!.listOffers({ gpuCount }).then((x) => (Array.isArray(x) ? [...x] : "unavailable")), "unavailable")),
  );
  const listedAtMs = deps.clock();
  const offers: Offer[] = [];
  const unavailableProviders: ProviderId[] = [];
  lists.forEach((list, i) => {
    const p = providers[i]!;
    if (list === "unavailable") unavailableProviders.push(p);
    // (one entry at a time: a list of any length, and an entry that isn't an object, never throw)
    else for (const o of list) if (typeof o === "object" && o !== null && o.provider === p) offers.push(o);
  });
  const ranked = gpuType === null ? rankAllowed(offers, policy, gpuCount) : rankOffers(offers, policy, { gpuType, gpuCount });
  return { offers: ranked.map((offer) => ({ offer, listedAtMs })), unavailableProviders };
}
