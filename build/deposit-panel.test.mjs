// The deposit panel's pure parts (site/deposit.js, #40): the amount parser and the quote
// reader. The panel itself is checked in the browser (qa-pass).
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAmount, readQuote } from "../site/deposit.js";

test("parseAmount: plain amounts become the token's smallest unit", () => {
  assert.deepEqual(parseAmount("12.5", 6), { units: 12_500_000n });
  assert.deepEqual(parseAmount(".5", 6), { units: 500_000n });
  assert.deepEqual(parseAmount("1.", 6), { units: 1_000_000n });
  assert.deepEqual(parseAmount("  250 ", 6), { units: 250_000_000n });
  assert.deepEqual(parseAmount("3", 0), { units: 3n });
  assert.deepEqual(parseAmount("1.000000000000000001", 18), { units: 1_000_000_000_000_000_001n });
});

test("parseAmount: a comma works as the decimal mark", () => {
  assert.deepEqual(parseAmount("1,5", 6), { units: 1_500_000n });
});

test("parseAmount: each bad input says why", () => {
  assert.deepEqual(parseAmount("", 6), { error: "empty" });
  assert.deepEqual(parseAmount("   ", 6), { error: "empty" });
  assert.deepEqual(parseAmount("abc", 6), { error: "format" });
  assert.deepEqual(parseAmount("1e3", 6), { error: "format" });
  assert.deepEqual(parseAmount("1.2.3", 6), { error: "format" });
  assert.deepEqual(parseAmount(".", 6), { error: "format" });
  assert.deepEqual(parseAmount("1.1234567", 6), { error: "decimals" }, "never cut digits off silently");
  assert.deepEqual(parseAmount("0", 6), { error: "zero" });
  assert.deepEqual(parseAmount("0.000", 6), { error: "zero" });
});

const DEP = { token: "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9" };
const answer = (o = {}) => ({
  action: { toToken: { address: "0xBEEF0E0834849ACC03F0089F01F4F1EEB06873C9", symbol: "steakUSDC", decimals: 18 } },
  estimate: { toAmount: "238540000000000000000", toAmountUSD: "248.08" }, ...o,
});

test("readQuote: reads what the user gets, whatever the address case", () => {
  assert.deepEqual(readQuote(answer(), DEP), { amount: 238.54, symbol: "steakUSDC", usd: 248.08 });
});

test("readQuote: a route that ends in another token is blocked", () => {
  const other = answer({ action: { toToken: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 } } });
  assert.throws(() => readQuote(other, DEP), /does not end in this vault's token/);
});

test("readQuote: a broken answer gives a plain message, not a TypeError", () => {
  for (const bad of [null, {}, answer({ estimate: null }), answer({ estimate: { toAmount: "1.5e20" } }), answer({ action: { toToken: { address: DEP.token, decimals: "18" } } })])
    assert.throws(() => readQuote(bad, DEP), /can't read/);
});

test("readQuote: a missing dollar value is null, not NaN", () => {
  assert.equal(readQuote(answer({ estimate: { toAmount: "1000000000000000000" } }), DEP).usd, null);
});
