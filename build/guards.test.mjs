// The build's release guards (guards.mjs, #66): each one passes a healthy build and refuses or
// warns on a broken one. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { lendBorrowGuard, keptGuard, unknownGuard, stickyGuard, earnGuard, featureSwitch, MIN_LENDBORROW, MIN_KEPT, MIN_EARN } from "./guards.mjs";

const rows = (n, unknown, factor = "age") => Array.from({ length: n }, (_, i) => ({ factors: [{ name: factor, unknown: i < unknown }] }));

test("lendBorrow feed: a full map passes; a short or missing one refuses to overwrite", () => {
  assert.deepEqual(lendBorrowGuard(2370), {});
  assert.deepEqual(lendBorrowGuard(MIN_LENDBORROW), {});
  assert.match(lendBorrowGuard(999).refuse, /lendBorrow feed has 999 pools \(< 1000\).*refusing to overwrite/);
  assert.match(lendBorrowGuard(undefined).refuse, /has 0 pools/);
});

test("sanity floor: 100+ kept pools pass; fewer refuse to overwrite", () => {
  assert.deepEqual(keptGuard(217), {});
  assert.deepEqual(keptGuard(MIN_KEPT), {});
  assert.match(keptGuard(99).refuse, /sanity floor: only 99 pools kept \(< 100\)/);
});

test("unknown age or yield: up to 20% is a status line; above is a warning, never a refusal", () => {
  assert.deepEqual(unknownGuard("age", rows(100, 20)), { log: "age unknown for 20/100 shown pools" });
  const age = unknownGuard("age", rows(100, 21));
  assert.equal(age.refuse, undefined);
  assert.match(age.warn, /^age unknown for 21\/100 shown pools — check DefiLlama count/);
  assert.match(unknownGuard("yield", rows(10, 5, "yield")).warn, /^yield unknown for 5\/10 shown pools — check DefiLlama apyMean30d/);
  assert.deepEqual(unknownGuard("age", []), { log: "age unknown for 0/0 shown pools" });
});

test("sticky levels: none invalid passes; a few start fresh with a warning; over 10% refuses", () => {
  assert.deepEqual(stickyGuard(0, 200), {});
  assert.match(stickyGuard(20, 200).warn, /20 invalid entries started fresh/);
  assert.match(stickyGuard(21, 200).refuse, /21 entries invalid \(11%\) — refusing to reset that many pools/);
  assert.ok(stickyGuard(1, 0).refuse, "no shown rows: any invalid entry is too many");
});

test("LI.FI vault list: short with a key set warns; without a key it says nothing", () => {
  assert.deepEqual(earnGuard(500, true), {});
  assert.deepEqual(earnGuard(MIN_EARN, true), {});
  assert.match(earnGuard(49, true).warn, /LI\.FI listed only 49 vaults \(< 50\) — check the LIFI_API_KEY secret/);
  assert.deepEqual(earnGuard(0, false), {}, "a local build without a key is expected to list none");
});

test("feature switches: the committed default rules unless the env says 1 or 0; a local 'on' warns", () => {
  assert.deepEqual(featureSwitch("FLOWS_CARD", undefined, true, "x"), { on: true });
  assert.deepEqual(featureSwitch("FLOWS_CARD", "", false, "x"), { on: false });
  assert.deepEqual(featureSwitch("FLOWS_CARD", "0", true, "x"), { on: false });
  assert.deepEqual(featureSwitch("FLOWS_CARD", "1", true, "x"), { on: true }, "on by default already: nothing to warn");
  const local = featureSwitch("DEPOSITS", "1", false, "Deposit button");
  assert.equal(local.on, true);
  assert.match(local.warn, /^DEPOSITS=1: Deposit button on — local check only, do NOT commit/);
  const bad = featureSwitch("LEVEL_WINDOWS", "yes", true, "x");
  assert.equal(bad.on, false, "an unknown value turns the switch off");
  assert.match(bad.warn, /LEVEL_WINDOWS=yes not recognised \(use 1 or 0\)/);
});

test("the build acts on every guard and keeps none of its own", async () => {
  const build = await readFile(new URL("./build.mjs", import.meta.url), "utf8");
  for (const g of ["lendBorrowGuard(", "keptGuard(", 'unknownGuard("age"', 'unknownGuard("yield"', "stickyGuard(", "earnGuard(", 'featureSwitch("LEVEL_WINDOWS"', 'featureSwitch("FLOWS_CARD"', 'featureSwitch("DEPOSITS"'])
    assert.ok(build.includes(g), g);
  assert.doesNotMatch(build, /const MIN_(KEPT|EARN|LENDBORROW) =/);
  assert.doesNotMatch(build, /shown\.length \* 0\.2/);
});
