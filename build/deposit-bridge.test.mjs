// Paying from another chain (#43): the same coin on each chain, the cross-chain transaction
// check, what a finished bridge means for the user, and the time text.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolvePayTokens, buildDepositTx, LIFI_DIAMOND } from "../site/wallet.js";
import { bridgeOutcome, timeText } from "../site/deposit.js";

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9", OWNER = "0x1234567890abcdef1234567890abcdef12345678";
const UNDER = { address: USDC_BASE, symbol: "USDC", decimals: 6 };

// a fake LI.FI /v1/token: by chain, the token LI.FI resolves for an address or symbol
const tokenApi = (table) => async (url) => {
  const u = new URL(url), hit = table[`${u.searchParams.get("chain")}|${u.searchParams.get("token").toLowerCase()}`];
  return hit === "fail" ? (() => { throw new Error("down"); })() : { ok: !!hit, status: hit ? 200 : 404, json: async () => hit ?? { message: "Token not found" } };
};
const dec6 = async () => 6; // the on-chain decimals() read, faked
const tok = (chainId, address, coinKey = "USDC", decimals = 6, symbol = "USDC") => ({ chainId, address, coinKey, decimals, symbol });

test("resolvePayTokens: the same coin (same coinKey) on each chain; the vault chain's token is the row's own", async () => {
  const fetchImpl = tokenApi({
    [`8453|${USDC_BASE}`]: tok(8453, USDC_BASE),
    "42161|usdc": tok(42161, USDC_ARB),
    "1|usdc": tok(1, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    "10|usdc": tok(10, "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", "USDCe", 6, "USDC"), // a look-alike: another coinKey
  });
  const m = await resolvePayTokens(8453, UNDER, { chainIds: [8453, 42161, 1, 10, 137], decimalsOf: dec6, fetchImpl });
  assert.deepEqual(m.get(8453), UNDER);
  assert.deepEqual(m.get(42161), { address: USDC_ARB.toLowerCase(), symbol: "USDC", decimals: 6 });
  assert.ok(m.get(1));
  assert.equal(m.get(10), null, "same symbol, other coin → not offered");
  assert.equal(m.get(137), null, "not listed → not offered");
});

test("resolvePayTokens: a failed lookup is left out (\"couldn't check\"), never stored as \"not listed\"", async () => {
  const m = await resolvePayTokens(8453, UNDER, { chainIds: [8453, 42161], decimalsOf: dec6, fetchImpl: tokenApi({ [`8453|${USDC_BASE}`]: "fail", "42161|usdc": tok(42161, USDC_ARB) }) });
  assert.deepEqual([...m.keys()], [8453], "vault token lookup failed: nothing else could be checked");
  const m2 = await resolvePayTokens(8453, UNDER, { chainIds: [8453, 42161, 1], decimalsOf: dec6, fetchImpl: tokenApi({ [`8453|${USDC_BASE}`]: tok(8453, USDC_BASE), "42161|usdc": "fail" }) });
  assert.equal(m2.has(42161), false, "a failing chain is left out");
  assert.equal(m2.get(1), null, "a 404 is 'not listed'");
});

test("resolvePayTokens: decimals that differ on chain → not offered", async () => {
  const m = await resolvePayTokens(8453, UNDER, { chainIds: [8453, 42161], decimalsOf: async () => 18, fetchImpl: tokenApi({ [`8453|${USDC_BASE}`]: tok(8453, USDC_BASE), "42161|usdc": tok(42161, USDC_ARB) }) });
  assert.equal(m.get(42161), null);
});

test("resolvePayTokens: an answer for another chain or with a bad address is ignored", async () => {
  const m = await resolvePayTokens(8453, UNDER, { chainIds: [8453, 42161, 1], decimalsOf: dec6, fetchImpl: tokenApi({
    [`8453|${USDC_BASE}`]: tok(8453, USDC_BASE), "42161|usdc": tok(1, USDC_ARB), "1|usdc": tok(1, "0x1234"),
  }) });
  assert.equal(m.get(42161), null);
  assert.equal(m.get(1), null);
});

const cross = (o = {}, tr = {}) => ({
  action: { fromChainId: 42161, toChainId: 8453, fromToken: { address: USDC_ARB }, toToken: { address: VAULT }, fromAmount: "250000000", fromAddress: OWNER, ...o },
  estimate: { approvalAddress: LIFI_DIAMOND[42161] },
  transactionRequest: { to: LIFI_DIAMOND[42161], data: "0xdeadbeef00", value: "0x0", gasLimit: "0x5208", chainId: 42161, ...tr },
});
const ctx = { from: OWNER, chainId: 42161, toChainId: 8453, units: 250_000_000n, payToken: USDC_ARB, vaultToken: VAULT };

test("buildDepositTx cross-chain: signed on the pay chain, ending in the vault on the vault chain", () => {
  assert.equal(buildDepositTx(cross(), ctx).tx.chainId, "0xa4b1");
});

test("buildDepositTx cross-chain: the wrong pay or vault chain is refused", () => {
  for (const q of [cross({ toChainId: 42161 }), cross({ fromChainId: 8453 }), cross({}, { chainId: 8453 }), cross({ fromToken: { address: USDC_BASE } })])
    assert.throws(() => buildDepositTx(q, ctx), /nothing was signed/);
});

const C = { sent: "250 USDC", sym: "USDC", fromChainId: 42161, toChainId: 8453, sourceLink: " <a>src</a>" };

test("bridgeOutcome: still running → null", () => {
  assert.equal(bridgeOutcome({ status: "PENDING" }, C), null);
  assert.equal(bridgeOutcome(null, C), null);
});

test("bridgeOutcome: completed → Deposited on the vault chain, with both links", () => {
  const o = bridgeOutcome({ status: "DONE", substatus: "COMPLETED", receiving: { txLink: "https://basescan.org/tx/0xabc" } }, C);
  assert.equal(o.phase, "done"); assert.equal(o.kind, "ok");
  assert.match(o.html, /^Deposited 250 USDC on Base\./);
  assert.match(o.html, /src/); assert.match(o.html, /View on Base/);
});

test("bridgeOutcome: partial → says the tokens are in the wallet on the vault chain, not in the vault", () => {
  const o = bridgeOutcome({ status: "DONE", substatus: "PARTIAL", receiving: { chainId: 8453, token: { symbol: "USDC" } } }, C);
  assert.equal(o.kind, "warn");
  assert.match(o.html, /you have USDC in your wallet on Base, not vault shares/);
});

test("bridgeOutcome: refunded → back in the wallet on the chain it was refunded to; nothing deposited", () => {
  assert.match(bridgeOutcome({ status: "DONE", substatus: "REFUNDED", receiving: { chainId: 42161 } }, C).html, /back in your wallet on Arbitrum\. Nothing was deposited/);
  assert.match(bridgeOutcome({ status: "DONE", substatus: "REFUNDED" }, C).html, /on Arbitrum/, "no chain in the answer → the pay chain");
});

test("bridgeOutcome: failed → says so and links the transaction; unknown result → check it", () => {
  const f = bridgeOutcome({ status: "FAILED" }, C);
  assert.deepEqual([f.phase, /transfer failed/.test(f.html), /src/.test(f.html)], ["failed", true, true]);
  assert.equal(bridgeOutcome({ status: "DONE", substatus: "NEW_THING" }, C).phase, "unknown");
});

test("bridgeOutcome: 'Deposited' only when the vault's token arrived on the vault's chain", () => {
  const V = { ...C, vaultToken: "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9" };
  assert.equal(bridgeOutcome({ status: "DONE", substatus: "COMPLETED", receiving: { chainId: 8453, token: { address: "0xBEEF0E0834849ACC03F0089F01F4F1EEB06873C9" } } }, V).phase, "done");
  assert.equal(bridgeOutcome({ status: "DONE", substatus: "COMPLETED", receiving: { chainId: 8453, token: { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" } } }, V).phase, "unknown");
  assert.equal(bridgeOutcome({ status: "DONE", substatus: "COMPLETED", receiving: { chainId: 1 } }, V).phase, "unknown");
});

test("bridgeOutcome: links name the chain they point to; problems add LI.FI's tracker", () => {
  const H = { ...C, hash: "0x" + "ab".repeat(32) };
  const ref = bridgeOutcome({ status: "DONE", substatus: "REFUNDED", receiving: { chainId: 42161, txLink: "https://arbiscan.io/tx/0x1" } }, H);
  assert.match(ref.html, /View on Arbitrum/);
  assert.match(ref.html, /scan\.li\.fi\/tx\/0xabab/);
  assert.match(bridgeOutcome({ status: "FAILED" }, H).html, /Track on LI\.FI/);
});

test("bridgeOutcome: a receiving link that isn't https is dropped (it goes into the page)", () => {
  const o = bridgeOutcome({ status: "DONE", substatus: "COMPLETED", receiving: { txLink: "javascript:alert(1)" } }, C);
  assert.doesNotMatch(o.html, /javascript:/);
});

test("timeText", () => {
  assert.equal(timeText(30), "under a minute");
  assert.equal(timeText(240), "about 4 min");
  assert.equal(timeText(null), "time unknown");
  assert.equal(timeText("x"), "time unknown");
});
