// Parse a pasted invite list: emails separated by commas, semicolons or newlines,
// optionally in "Name <email>" form.

export interface InviteList {
  valid: string[];
  duplicates: string[];
  invalid: string[];
}

export const MAX_EMAIL_LENGTH = 254;

// The local part: anything but whitespace and the list/quote punctuation (no quoted forms).
// The domain: two or more DNS labels of letters, digits and inner hyphens, each 1..63 long
// (no IP literals). Punycode (xn--...) labels pass.
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const EMAIL = new RegExp(`^[^\\s@<>,;"]+@${LABEL}(?:\\.${LABEL})+$`, "i");

export function isEmail(text: string): boolean {
  return text.length <= MAX_EMAIL_LENGTH && EMAIL.test(text);
}

export function parseInviteList(text: string): InviteList {
  const valid: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[,;\r\n]+/)) {
    const entry = raw.trim();
    if (entry === "") continue;
    const bracketed = /<([^<>]*)>$/.exec(entry);
    // Addresses are compared and stored lowercased.
    const email = (bracketed?.[1] ?? entry).trim().toLowerCase();
    if (!isEmail(email)) invalid.push(entry);
    else if (seen.has(email)) duplicates.push(email);
    else {
      seen.add(email);
      valid.push(email);
    }
  }
  return { valid, duplicates, invalid };
}
