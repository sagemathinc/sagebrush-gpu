import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_ALPHABET, newId } from "@sbgpu/api";
import { MAX_MACHINE_NAME_LENGTH, MAX_NAME_INCARNATION, isInstallation, machineName, parseMachineName, sameMachineName, specNameMatches } from "./machine-name.ts";

const BODY = "0a7km2x6veews5590ctj";
const MID = `mch_${BODY}`;

// ---------------------------------------------------------------- round trips

test("names round-trip exactly: every valid triple to one name and back", () => {
  const triples: Array<[string, string, number]> = [
    ["prod", MID, 0],
    ["prod", MID, 1],
    ["abcd1234", MID, MAX_NAME_INCARNATION],
    ["0000", "mch_00000000000000000000", 10],
    ["z9z9", "mch_zzzzzzzzzzzzzzzzzzzz", 999],
  ];
  for (let i = 0; i < 200; i++) triples.push(["s1t2", newId("machine"), i * 7_919_999_999 % (MAX_NAME_INCARNATION + 1)]);
  for (const [installation, machineId, incarnation] of triples) {
    const name = machineName(installation, machineId, incarnation);
    assert.match(name, /^[a-z0-9-]+$/);
    assert.ok(name.length <= MAX_MACHINE_NAME_LENGTH, name);
    assert.deepEqual(parseMachineName(name), { installation, machineId, incarnation }, name);
    assert.equal(machineName(installation, machineId, incarnation), name);
  }
  assert.equal(machineName("prod", MID, 0), `sbg-prod-${BODY}-0`);
  assert.equal(machineName("abcd1234", MID, 42), `sbg-abcd1234-${BODY}-42`);
});

test("the longest name is exactly 46 characters and parses; 47 never does", () => {
  const longest = machineName("abcdefgh", MID, MAX_NAME_INCARNATION);
  assert.equal(longest.length, 46);
  assert.equal(longest, `sbg-abcdefgh-${BODY}-999999999999`);
  assert.deepEqual(parseMachineName(longest), { installation: "abcdefgh", machineId: MID, incarnation: MAX_NAME_INCARNATION });
  for (const n47 of [`sbg-abcdefgh-${BODY}-1000000000000`, `sbg-abcdefghi-${BODY}-999999999999`, `${longest}0`]) {
    assert.equal(n47.length, 47);
    assert.equal(parseMachineName(n47), null, n47);
  }
});

// ---------------------------------------------------------------- the parse refuses (null)

test("parse: the strict shape: sbg- and exactly three non-empty fields, [a-z0-9-] only", () => {
  const ok = `sbg-prod-${BODY}-7`;
  assert.notEqual(parseMachineName(ok), null);
  for (const bad of [
    "", "sbg-", "sbg--", "sbg---", `sbg-prod-${BODY}`, `sbg-prod-${BODY}-`, `sbg--${BODY}-7`, `sbg-prod--7`, `sbg-prod-${BODY}-7-1`,
    `sbg-prod-${BODY}--7`, `sbg-prod--${BODY}-7`, `sbgprod-${BODY}-7`, `SBG-prod-${BODY}-7`, `xbg-prod-${BODY}-7`, ` sbg-prod-${BODY}-7`, `sbg-prod-${BODY}-7 `,
    `sbg-prod-${BODY}-7\n`, `sbg-prod_${BODY}-7`, `sbg-prod-${BODY}_7`, `sbg-prod-mch_${BODY}-7`, `sbg-prod-${BODY}-+7`, `sbg-prod-${BODY}-7.0`,
    `sbg-prod-${BODY}-0x7`, `sbg-prod-${BODY}-٧`, `sbg-${BODY}-7`, `sbg-${MID}`,
  ]) {
    assert.equal(parseMachineName(bad), null, JSON.stringify(bad));
  }
  for (const x of [null, undefined, 7, {}, ["sbg-prod"]]) assert.equal(parseMachineName(x), null);
});

test("parse: the installation is [a-z0-9]{4,8}", () => {
  for (const inst of ["abcd", "abcdefgh", "0000", "a1b2c3"]) assert.notEqual(parseMachineName(`sbg-${inst}-${BODY}-1`), null, inst);
  for (const inst of ["abc", "abcdefghi", "Prod", "pr_d", "pr.d", "prød", ""]) assert.equal(parseMachineName(`sbg-${inst}-${BODY}-1`), null, inst);
});

test("parse: the body is exactly 20 characters of the id alphabet, a machine id with mch_ re-added", () => {
  assert.equal(ID_ALPHABET.length, 32);
  for (const excluded of ["i", "l", "o", "u"]) {
    assert.ok(!ID_ALPHABET.includes(excluded));
    assert.equal(parseMachineName(`sbg-prod-${excluded}${BODY.slice(1)}-1`), null, excluded);
  }
  for (const body of [BODY.slice(1), `${BODY}0`, BODY.toUpperCase(), `${BODY.slice(0, 19)}_`, `${BODY.slice(0, 19)}-`]) {
    assert.equal(parseMachineName(`sbg-prod-${body}-1`), null, body);
  }
  // a body starting with 0 is a body like any other (1 in 32 random ids does)
  assert.deepEqual(parseMachineName("sbg-prod-0aaaaaaaaaaaaaaaaaaa-1")?.machineId, "mch_0aaaaaaaaaaaaaaaaaaa");
});

test("parse: the incarnation is 0, or 1 to 12 digits without a leading zero", () => {
  for (const [inc, n] of [["0", 0], ["1", 1], ["10", 10], ["999999999999", MAX_NAME_INCARNATION]] as const) {
    assert.equal(parseMachineName(`sbg-prod-${BODY}-${inc}`)?.incarnation, n, inc);
  }
  for (const inc of ["00", "01", "007", "1000000000000", "0000000000001", "-1", "1e3", ""]) {
    assert.equal(parseMachineName(`sbg-prod-${BODY}-${inc}`), null, inc);
  }
});

// ---------------------------------------------------------------- the builder refuses (throws), never truncates

test("builder: refuses a bad installation, a non-mch_ id, or an incarnation outside 0..10^12 - 1; never echoes the input", () => {
  const refuses = (f: () => string, why: string) =>
    assert.throws(f, (e: unknown) => e instanceof RangeError && !e.message.includes("zzz") && !e.message.includes("prj_"), why);
  for (const inst of ["abc", "abcdefghi", "Prod", "pr-d", "", "zzz"]) refuses(() => machineName(inst, MID, 1), `installation ${inst}`);
  for (const id of [`prj_${BODY}`, BODY, `mch_${BODY.slice(1)}`, `mch_${BODY}0`, `mch_i${BODY.slice(1)}`, `MCH_${BODY}`, "mch_zzz"]) refuses(() => machineName("prod", id, 1), `id ${id}`);
  for (const inc of [-1, MAX_NAME_INCARNATION + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) refuses(() => machineName("prod", MID, inc), `incarnation ${inc}`);
  assert.equal(machineName("prod", MID, MAX_NAME_INCARNATION).length, 42);
});

test("isInstallation: exactly the slug rule", () => {
  assert.deepEqual(["abcd", "abcdefgh", "a1b2"].map(isInstallation), [true, true, true]);
  assert.deepEqual(["abc", "abcdefghi", "ABCD", "ab-d", null, 1234].map(isInstallation), [false, false, false, false, false, false]);
});

// ---------------------------------------------------------------- a launch spec's name

test("specNameMatches: the spec's name is its own machine and incarnation, nothing else", () => {
  const name = machineName("prod", MID, 3);
  assert.ok(specNameMatches({ name, machineId: MID, incarnation: 3 }));
  assert.equal(specNameMatches({ name, machineId: MID, incarnation: 2 }), false, "a stale incarnation");
  assert.equal(specNameMatches({ name, machineId: newId("machine"), incarnation: 3 }), false, "another machine");
  assert.equal(specNameMatches({ name: `sbg-${MID}`, machineId: MID, incarnation: 3 }), false, "the old form");
  assert.equal(specNameMatches({ name: `${name}x`, machineId: MID, incarnation: 3 }), false);
});

test("sameMachineName: exactly the same installation, machine and incarnation; anything else, or nothing parsed, is not", () => {
  const p = parseMachineName(machineName("prod", MID, 3));
  assert.ok(sameMachineName(p, machineName("prod", MID, 3)));
  for (const other of [machineName("prdo", MID, 3), machineName("prod", newId("machine"), 3), machineName("prod", MID, 4), `sbg-${MID}`, "my-pod"]) {
    assert.equal(sameMachineName(p, other), false, other);
  }
  assert.equal(sameMachineName(null, machineName("prod", MID, 3)), false);
});
