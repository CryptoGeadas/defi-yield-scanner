// Who gets the deposit (#49): buildDepositTx decodes the receiver from LI.FI's calldata
// (the swap's _receiver, or the bridge's BridgeData.receiver) instead of looking for the
// user's address anywhere in it. The calldata is real, from LI.FI quotes (lifi-calldata.json).
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildDepositTx, LIFI_DIAMOND } from "../site/wallet.js";
import { bridgeToAvoid } from "../site/deposit.js";

const SAMPLES = JSON.parse(readFileSync(new URL("./lifi-calldata.json", import.meta.url), "utf8"));
const SAMPLE_USER = "7777777777777777777777777777777777777777";
const OWNER = "0x1234567890abcdef1234567890abcdef12345678", OTHER = "9999999999999999999999999999999999999999";
const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";

// the sample's calldata, made out to OWNER
const dataOf = (name) => SAMPLES[name].data.replaceAll(SAMPLE_USER, OWNER.slice(2));
const quoteOf = (name, data = dataOf(name)) => {
  const s = SAMPLES[name];
  return {
    action: { fromChainId: s.fromChainId, toChainId: s.toChainId, fromToken: { address: s.fromToken }, toToken: { address: VAULT }, fromAmount: "250000000", fromAddress: OWNER, toAddress: OWNER },
    estimate: { approvalAddress: LIFI_DIAMOND[s.fromChainId] },
    transactionRequest: { to: LIFI_DIAMOND[s.fromChainId], data, value: "0x0", gasLimit: "0x5208", chainId: s.fromChainId },
  };
};
const ctxOf = (name) => {
  const s = SAMPLES[name];
  return { from: OWNER, chainId: s.fromChainId, toChainId: s.toChainId, units: 250_000_000n, payToken: s.fromToken, vaultToken: VAULT };
};
// one 32-byte word of the arguments (byte offset after the 4-byte selector), replaced
const setWord = (data, at, word) => data.slice(0, 10 + at * 2) + word + data.slice(10 + at * 2 + 64);
const refusal = (fn) => { try { fn(); } catch (e) { return e; } assert.fail("not refused"); };

// Where the receiver sits in each sample, read by hand from the calldata (2026-10-26).
const SUPPORTED = {
  okx: 96, kyberswap: 96, // swapTokensMultipleV3ERC20ToERC20: 4th argument, _receiver
  across: 0x60 + 160, stargateV2: 0x60 + 160, relaydepository: 0x80 + 160, // BridgeData.receiver (6th field)
};

test("receiver: each LI.FI function the deposits use is decoded, and the user is the receiver", () => {
  for (const name of Object.keys(SUPPORTED)) assert.equal(buildDepositTx(quoteOf(name), ctxOf(name)).tx.data, dataOf(name), name);
});

test("receiver: another receiver is refused, even when the user's address is elsewhere in the calldata", () => {
  for (const [name, at] of Object.entries(SUPPORTED)) {
    const data = setWord(dataOf(name), at, "0".repeat(24) + OTHER);
    if (name !== "okx" && name !== "kyberswap") assert.ok(data.includes(OWNER.slice(2)), `${name}: the user is still named (e.g. as refund address)`);
    const e = refusal(() => buildDepositTx(quoteOf(name, data), ctxOf(name)));
    assert.ok(e.plain && /nothing was signed/.test(e.message) && /receiver/.test(e.message), name);
  }
});

test("receiver: a bridge to another chain than the vault's is refused", () => {
  const data = setWord(dataOf("across"), 0x60 + 224, (1).toString(16).padStart(64, "0")); // BridgeData.destinationChainId
  assert.throws(() => buildDepositTx(quoteOf("across", data), ctxOf("across")), /nothing was signed/);
});

test("receiver: Mayan and Polymer pay a new deposit address, which can't be checked → refused; the panel asks again without that bridge", () => {
  for (const name of ["mayan", "polymerStandard"]) {
    const e = refusal(() => buildDepositTx(quoteOf(name), ctxOf(name)));
    assert.ok(e.plain && /nothing was signed/.test(e.message), name);
    assert.equal(e.otherRoute, true, name);
    assert.equal(bridgeToAvoid(e, { tool: name }, 42161, 8453), name);
  }
});

test("receiver: an unknown LI.FI function is refused (fail closed)", () => {
  const same = refusal(() => buildDepositTx(quoteOf("okx", "0xdeadbeef" + dataOf("okx").slice(10)), ctxOf("okx")));
  assert.ok(same.plain && /nothing was signed/.test(same.message));
  assert.equal(bridgeToAvoid(same, { tool: "okx" }, 8453, 8453), null, "same chain: no bridge to leave out");
  const cross = refusal(() => buildDepositTx(quoteOf("across", "0xdeadbeef" + dataOf("across").slice(10)), ctxOf("across")));
  assert.equal(bridgeToAvoid(cross, { tool: "across" }, 42161, 8453), "across");
});

test("receiver: a swap on a cross-chain quote, or a bridge on a same-chain one, is refused", () => {
  assert.throws(() => buildDepositTx(quoteOf("across", dataOf("okx")), ctxOf("across")), /nothing was signed/);
  assert.throws(() => buildDepositTx(quoteOf("okx", dataOf("across")), ctxOf("okx")), /nothing was signed/);
});

test("receiver: cut-off or malformed calldata is refused, never a crash", () => {
  for (const name of ["okx", "across"]) {
    for (const data of [dataOf(name).slice(0, 10 + 64), dataOf(name).slice(0, 10 + 64 * 3), dataOf(name).slice(0, 11)])
      assert.throws(() => buildDepositTx(quoteOf(name, data), ctxOf(name)), /nothing was signed/, `${name} cut to ${data.length}`);
  }
  // a BridgeData offset pointing past the end
  assert.throws(() => buildDepositTx(quoteOf("across", setWord(dataOf("across"), 0, "f".repeat(64))), ctxOf("across")), /nothing was signed/);
  // a receiver word that isn't an address (dirty high bytes)
  assert.throws(() => buildDepositTx(quoteOf("okx", setWord(dataOf("okx"), 96, "01" + "0".repeat(22) + OWNER.slice(2))), ctxOf("okx")), /nothing was signed/);
});

test("bridgeToAvoid: only cross-chain refusals the panel can route around", () => {
  const flagged = (o) => Object.assign(new Error("x"), o);
  assert.equal(bridgeToAvoid(flagged({ needsGas: true }), { tool: "across" }, 42161, 8453), "across");
  assert.equal(bridgeToAvoid(flagged({ otherRoute: true }), { tool: "mayan" }, 42161, 8453), "mayan");
  assert.equal(bridgeToAvoid(flagged({ needsGas: true }), { tool: "okx" }, 8453, 8453), null, "same chain");
  assert.equal(bridgeToAvoid(flagged({ otherRoute: true }), {}, 42161, 8453), null, "no tool named");
  assert.equal(bridgeToAvoid(flagged({}), { tool: "across" }, 42161, 8453), null, "another refusal");
});
