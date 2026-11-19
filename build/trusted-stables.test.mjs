// The hand-kept stablecoin list (build/trusted-stables.json): tiers that must agree.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const STABLES = JSON.parse(readFileSync(new URL("./trusted-stables.json", import.meta.url), "utf8"));

test("DAI is crypto-backed Tier 2, like its successor USDS and its savings form sDAI (#69)", () => {
  for (const coin of ["DAI", "DAI.E"]) assert.deepEqual(STABLES[coin], { tier: 2, type: "crypto" }, coin);
  assert.equal(STABLES.DAI.tier, STABLES.USDS.tier);
  assert.equal(STABLES.DAI.tier, STABLES.SDAI.tier);
});

test("only coins held 1:1 in reserve are fiat-backed", () => {
  const fiat = Object.entries(STABLES).filter(([k, v]) => !k.startsWith("_") && v.type === "fiat").map(([k]) => k);
  assert.ok(!fiat.some((k) => /^DAI/.test(k)), `DAI must not be fiat: ${fiat.join(", ")}`);
});
