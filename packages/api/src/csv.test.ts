import { test } from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvDecimal, csvRow, toCsv } from "./csv.ts";

test("csvCell: empty and numbers", () => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(""), "");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(-1.5), "-1.5"); // our numbers are not neutralised
  assert.equal(csvCell(1234567), "1234567");
  assert.throws(() => csvCell(Number.NaN), RangeError);
  assert.throws(() => csvCell(Infinity), RangeError);
});

test("csvCell neutralises formula starts in text", () => {
  assert.equal(csvCell("=SUM(A1:A9)"), "'=SUM(A1:A9)");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-1.5"), "'-1.5");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("\tx"), "'\tx");
  assert.equal(csvCell("\rx"), "\"'\rx\"");
  assert.equal(csvCell("\n=1+1"), "\"'\n=1+1\"");
  assert.equal(csvCell("\uFF1D1+1"), "'\uFF1D1+1"); // full-width =
  assert.equal(csvCell("\uFF0B1"), "'\uFF0B1"); // full-width +
  assert.equal(csvCell("\uFF0D1"), "'\uFF0D1"); // full-width -
  assert.equal(csvCell("\uFF20SUM(A1)"), "'\uFF20SUM(A1)"); // full-width @
  assert.equal(csvCell("a\uFF1Db"), "a\uFF1Db");
  assert.equal(csvCell('=HYPERLINK("http://x")'), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(csvCell("a=b"), "a=b");
  assert.equal(csvCell("a-b"), "a-b");
});

test("csvCell neutralises a formula start after leading spaces, tabs, CR or LF", () => {
  for (const lead of [" ", "  ", "\t ", "\r\n", "\n", " \t"]) {
    for (const f of ["=", "+", "-", "@", "\uFF1D", "\uFF0B", "\uFF0D", "\uFF20"]) {
      const v = `${lead}${f}1+1`;
      const out = csvCell(v);
      assert.ok(out === `'${v}` || out === `"'${v.replace(/"/g, '""')}"`, JSON.stringify([v, out]));
    }
  }
  // (spaces before ordinary text: quoted for the spaces, never an apostrophe)
  assert.equal(csvCell(" plain"), '" plain"');
  assert.equal(csvCell("  a=b"), '"  a=b"');
  assert.equal(csvCell("\n x"), "\"'\n x\""); // (a leading line feed is itself a formula start)
});

test("csvCell quotes per RFC 4180", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("a;=1+1"), '"a;=1+1"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("two\nlines"), '"two\nlines"');
  assert.equal(csvCell("cr\rhere"), '"cr\rhere"');
  assert.equal(csvCell(" lead"), '" lead"');
  assert.equal(csvCell("trail "), '"trail "');
  assert.equal(csvCell("in side"), "in side");
});

test("csvRow and toCsv", () => {
  assert.equal(csvRow(["a", 1, null, "b,c"]), 'a,1,,"b,c"');
  assert.equal(toCsv([["a", 1], ["b", null]]), "a,1\r\nb,\r\n");
  assert.equal(toCsv([]), "");
});

test("csvDecimal: our exact decimals are written as numbers, a minus included; anything else is refused", () => {
  for (const d of ["0", "2", "-0.5", "0.000001", "-0.000001", "9007199254.740991", "-9007199254.740991"]) assert.equal(csvCell(csvDecimal(d)), d, d);
  assert.equal(csvRow(["-0.5", csvDecimal("-0.5")]), "'-0.5,-0.5", "text with a minus is still neutralised; the decimal isn't");
  for (const bad of ["", "-", "=1", "1e5", "01", "-0.50", "1.", ".5", " 1", "1,5", "+1", "0x10", "-=1"]) assert.throws(() => csvDecimal(bad), RangeError, bad);
  // (a hand-made value that skipped csvDecimal is checked again)
  assert.throws(() => csvCell({ decimal: "=HYPERLINK(1)" }), RangeError);
});
