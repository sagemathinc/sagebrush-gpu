// RFC 4180 CSV with spreadsheet formula-injection neutralising (OWASP "CSV Injection").
// Shared by the UI and the control plane's spend export: managers open these files in
// spreadsheets, and member-controlled text (names, team names) must never run as a formula.

/** An exact decimal amount of ours (money: never member text), written as the number it is. Made by csvDecimal. */
export interface CsvDecimal {
  readonly decimal: string;
}

export type CsvValue = string | number | CsvDecimal | null | undefined;

// (canonical: an optional minus, no leading zeros, and a fraction that doesn't end in zero)
const DECIMAL = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;

/** A trusted exact decimal cell, such as usdDecimal's "-0.5": written as a number (no apostrophe), unlike text. */
export function csvDecimal(text: string): CsvDecimal {
  if (typeof text !== "string" || !DECIMAL.test(text)) throw new RangeError(`not a canonical decimal: ${String(text)}`);
  return { decimal: text };
}

// Characters that make a spreadsheet treat a cell as a formula when they start it:
// OWASP's list, including line feed and the full-width forms.
const FORMULA_START = new Set(["=", "+", "-", "@", "\t", "\r", "\n", "\uFF1D", "\uFF0B", "\uFF0D", "\uFF20"]);

export function csvCell(value: CsvValue): string {
  if (value == null) return "";
  let text: string;
  if (typeof value === "object") {
    // (checked again here: only a canonical decimal is ever written unescaped)
    if (typeof value.decimal !== "string" || !DECIMAL.test(value.decimal)) throw new RangeError(`not a canonical decimal: ${String(value.decimal)}`);
    return value.decimal;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RangeError(`not a finite number: ${value}`);
    // Numbers are ours, not member text: -1.5 stays a number.
    text = String(value);
  } else {
    text = value;
    // (the first character, or the first after any leading spaces, tabs, CR or LF: spreadsheets
    // skip those before deciding a cell is a formula)
    const first = text.replace(/^[ \t\r\n]+/, "").charAt(0);
    if (FORMULA_START.has(text.charAt(0)) || FORMULA_START.has(first)) text = "'" + text;
  }
  // Semicolons too: spreadsheets in some locales split fields on them.
  if (/[",;\r\n]/.test(text) || text !== text.trim()) {
    text = '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

export function csvRow(cells: readonly CsvValue[]): string {
  return cells.map(csvCell).join(",");
}

// Every row ends with CRLF, as RFC 4180 says.
export function toCsv(rows: readonly (readonly CsvValue[])[]): string {
  return rows.map((row) => csvRow(row) + "\r\n").join("");
}
