// Input validation shared by the control plane's handlers.

// Same rules as the UI's invite-list parser: no quoted local parts, DNS-label domains.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EMAIL = new RegExp(`^[^\\s@<>,;"]+@${LABEL}(?:\\.${LABEL})+$`);
export function normalizeEmail(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const e = x.trim().toLowerCase();
  return e.length <= 254 && EMAIL.test(e) ? e : null;
}

