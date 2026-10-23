// What the deposit panel shows about a quote (#44): the facts in plain words, the vault
// link and the chain a wallet is asked to add.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteFacts } from "../site/deposit.js";
import { explorerAddress, addChainParams } from "../site/wallet.js";

const raw = (est = {}) => ({
  action: { toToken: { symbol: "steakUSDC", decimals: 18 } },
  estimate: {
    toAmountMin: "236150000000000000000",
    feeCosts: [{ name: "LIFI Fixed Fee", percentage: "0.0025", amountUSD: "0.62", included: true }],
    gasCosts: [{ amountUSD: "0.01" }, { amountUSD: "0.004" }],
    executionDuration: 0,
    ...est,
  },
});

test("quoteFacts: minimum, LI.FI fee with percent, network fee, time, route in plain words", () => {
  const f = quoteFacts(raw(), { payChainId: 8453, vaultChainId: 8453 });
  assert.equal(f.minimum, 236.15);
  assert.equal(f.symbol, "steakUSDC");
  assert.equal(f.feeUsd, 0.62);
  assert.equal(f.feePct, 0.25);
  assert.ok(Math.abs(f.gasUsd - 0.014) < 1e-9);
  assert.equal(f.time, "under a minute");
  assert.equal(f.route, "Swap and deposit on Base");
});

test("quoteFacts: a cross-chain route says bridge, then deposit — never a tool name", () => {
  const f = quoteFacts(raw({ executionDuration: 300 }), { payChainId: 42161, vaultChainId: 8453 });
  assert.equal(f.route, "Bridge to Base, then deposit");
  assert.equal(f.time, "about 5 min");
  assert.doesNotMatch(JSON.stringify(f), /okx|across|composer|stargate/i);
});

test("quoteFacts: what LI.FI didn't give is null (shown as unknown), never 0", () => {
  const f = quoteFacts({ action: { toToken: {} }, estimate: {} }, { payChainId: 1, vaultChainId: 1 });
  assert.deepEqual([f.minimum, f.feeUsd, f.feePct, f.gasUsd, f.time], [null, null, null, null, "time unknown"]);
  assert.equal(quoteFacts(raw({ gasCosts: [{ amountUSD: "x" }] }), { payChainId: 1, vaultChainId: 1 }).gasUsd, null);
});

test("quoteFacts: LI.FI's own fee apart from bridge fees; a fee paid on top is shown, not dropped", () => {
  const f = quoteFacts(raw({ feeCosts: [
    { name: "LIFI Fixed Fee", percentage: "0.0025", amountUSD: "0.6255", included: true },
    { name: "Relayer fee", percentage: "0.0001", amountUSD: "0.025", included: true },
    { name: "Relayer gas fee", percentage: "0.000112", amountUSD: "0.0279", included: true },
    { name: "Bridge fee", amountUSD: "1.5", included: false },
  ] }), { payChainId: 42161, vaultChainId: 8453 });
  assert.ok(Math.abs(f.feeUsd - 0.6255) < 1e-9);
  assert.equal(f.feePct, 0.25, "the percent is LI.FI's own");
  assert.ok(Math.abs(f.otherFeeUsd - 0.0529) < 1e-9);
  assert.equal(f.onTopUsd, 1.5);
});

test("quoteFacts: an empty dollar value is unknown, never $0", () => {
  const f = quoteFacts(raw({ gasCosts: [{ amountUSD: "" }], feeCosts: [{ name: "LIFI Fixed Fee", amountUSD: "", percentage: "" }] }), { payChainId: 1, vaultChainId: 1 });
  assert.deepEqual([f.gasUsd, f.feeUsd, f.feePct], [null, null, null]);
  assert.deepEqual([f.otherFeeUsd, f.onTopUsd], [null, null], "no such fees → nothing to show");
});

test("explorerAddress: the vault contract on its chain's explorer; nothing for a bad address", () => {
  assert.equal(explorerAddress(8453, "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9"), "https://basescan.org/address/0xbeef0e0834849acc03f0089f01f4f1eeb06873c9");
  assert.equal(explorerAddress(8453, "0x123"), null);
  assert.equal(explorerAddress(999, "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9"), null);
});

test("addChainParams: what a wallet needs to add a chain it doesn't know", () => {
  assert.deepEqual(addChainParams(8453), { chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] });
  assert.equal(addChainParams(137).nativeCurrency.symbol, "POL");
  assert.equal(addChainParams(999), null);
});
