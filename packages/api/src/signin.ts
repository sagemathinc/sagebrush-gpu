// Sign-in through WorkOS AuthKit, as the UI sees it: a full-page navigation to
// startSignIn (GET /v1/auth/start?return=<path>), and back from the callback with a 302
// either to the return path, signed in, or to "/?signin=<outcome>" when it didn't work.

/** Why a sign-in ended without a session: the value of the `signin` query parameter. */
export const SIGN_IN_OUTCOMES = Object.freeze(["refused", "error", "expired", "unavailable"] as const);
export type SignInOutcome = (typeof SIGN_IN_OUTCOMES)[number];
//   refused      the account isn't admitted here (no invitation): don't retry on your own
//   error        WorkOS or its token said no
//   expired      the sign-in took over 10 minutes, or the browser lost its state
//   unavailable  WorkOS (or the service) is down for the moment

export const SIGN_IN_OUTCOME_PARAM = "signin";
export const MAX_RETURN_PATH_LENGTH = 1024;

export function isSignInOutcome(x: unknown): x is SignInOutcome {
  return typeof x === "string" && (SIGN_IN_OUTCOMES as readonly string[]).includes(x);
}

/**
 * Whether `x` is a return path the server keeps (else it uses "/"): a relative URL on the
 * app's own origin (path, query and fragment), starting with exactly one "/", with no
 * backslash or control character, at most MAX_RETURN_PATH_LENGTH characters.
 */
export function isSafeReturnPath(x: unknown): x is string {
  if (typeof x !== "string" || x.length < 1 || x.length > MAX_RETURN_PATH_LENGTH) return false;
  if (x[0] !== "/" || x[1] === "/" || /[\\\u0000-\u001f\u007f]/.test(x)) return false;
  const base = "https://origin.invalid";
  try {
    return new URL(x, base).origin === base;
  } catch {
    return false;
  }
}
