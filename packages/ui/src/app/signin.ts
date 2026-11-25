// The browser's side of sign-in through WorkOS AuthKit (see @sbgpu/api's signin.ts): the
// button is a plain link to startSignIn, and the callback comes back with ?signin=<outcome>
// when it didn't work.

import { ROUTES, SIGN_IN_OUTCOME_PARAM, isSafeReturnPath, isSignInOutcome, type SignInOutcome } from "@sbgpu/api";

/** The sign-in link, asking to come back to `returnTo` when the server would keep it. */
export function signInHref(returnTo: string): string {
  const start = ROUTES.startSignIn.path;
  return returnTo !== "/" && isSafeReturnPath(returnTo) ? `${start}?return=${encodeURIComponent(returnTo)}` : start;
}

/**
 * The sign-in outcome in a page's query string, and the query string without it (to put
 * back in the address bar), or null when there is none. An unknown outcome is still
 * removed, and reads as null.
 */
export function takeSignInOutcome(search: string): { outcome: SignInOutcome | null; search: string } | null {
  const params = new URLSearchParams(search);
  if (!params.has(SIGN_IN_OUTCOME_PARAM)) return null;
  const value = params.get(SIGN_IN_OUTCOME_PARAM);
  params.delete(SIGN_IN_OUTCOME_PARAM);
  return { outcome: isSignInOutcome(value) ? value : null, search: params.size > 0 ? `?${params}` : "" };
}
