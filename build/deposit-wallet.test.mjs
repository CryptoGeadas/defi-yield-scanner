// Browser-wallet helpers for the deposit panel (site/wallet.js, #42): EIP-6963 discovery,
// ERC-20 call data, the approval rule and LI.FI's transfer status. The wallet itself
// (real signing) is checked by the owner at go-live (#48).
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverWallets, safeIcon, callBalanceOf, callAllowance, callApprove, needsApproval, readStatus, explorerTx, shortAddr, isRejection, sameChain, buildDepositTx, mustResetFirst, LIFI_DIAMOND } from "../site/wallet.js";

const OWNER = "0x1234567890abcdef1234567890ABCDEF12345678";
const SPENDER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

// a stand-in for window: an EventTarget that answers requestProvider like wallets do
function fakeWindow(wallets, injected) {
  const t = new EventTarget();
  t.ethereum = injected;
  t.addEventListener("eip6963:requestProvider", () => {
    for (const w of wallets) t.dispatchEvent(Object.assign(new Event("eip6963:announceProvider"), { detail: w }));
  });
  return t;
}
const wallet = (uuid, name) => ({ info: { uuid, name, icon: "data:image/svg+xml;base64,PHN2Zy8+", rdns: `io.${name.toLowerCase()}` }, provider: { name } });

test("discovery: every announced wallet once, in the order announced", async () => {
  const w = fakeWindow([wallet("a", "Rabby"), wallet("b", "MetaMask"), wallet("a", "Rabby")]);
  const found = await discoverWallets({ target: w, waitMs: 10 });
  assert.deepEqual(found.map((x) => x.info.name), ["Rabby", "MetaMask"]);
});

test("discovery: no announcement → the injected window.ethereum as one wallet", async () => {
  const found = await discoverWallets({ target: fakeWindow([], { isMetaMask: true }), waitMs: 10 });
  assert.equal(found.length, 1);
  assert.equal(found[0].info.name, "MetaMask");
});

test("discovery: no wallet at all → empty list", async () => {
  assert.deepEqual(await discoverWallets({ target: fakeWindow([], undefined), waitMs: 10 }), []);
});

test("discovery: an announcement without a provider or a name is ignored", async () => {
  const w = fakeWindow([{ info: { uuid: "x", name: "Bad" } }, { info: { uuid: "y" }, provider: {} }, wallet("z", "Good")]);
  assert.deepEqual((await discoverWallets({ target: w, waitMs: 10 })).map((x) => x.info.name), ["Good"]);
});

test("safeIcon: only image data URIs pass (a wallet's icon string goes into the page)", () => {
  assert.equal(safeIcon("data:image/png;base64,iVBOR"), "data:image/png;base64,iVBOR");
  assert.equal(safeIcon("data:image/svg+xml;base64,PHN2Zy8+"), "data:image/svg+xml;base64,PHN2Zy8+");
  assert.equal(safeIcon("javascript:alert(1)"), null);
  assert.equal(safeIcon("https://evil.example/x.png"), null);
  assert.equal(safeIcon('data:image/png;base64,x" onerror="alert(1)'), null);
  assert.equal(safeIcon(undefined), null);
});

test("ERC-20 call data: balanceOf, allowance, approve", () => {
  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  assert.equal(callBalanceOf(OWNER), "0x70a08231" + pad(OWNER));
  assert.equal(callAllowance(OWNER, SPENDER), "0xdd62ed3e" + pad(OWNER) + pad(SPENDER));
  assert.equal(callApprove(SPENDER, 250_000_000n), "0x095ea7b3" + pad(SPENDER) + (250_000_000n).toString(16).padStart(64, "0"));
});

test("callApprove refuses an amount out of range", () => {
  assert.throws(() => callApprove(SPENDER, -1n), /out of range/);
  assert.throws(() => callApprove(SPENDER, 2n ** 256n), /out of range/);
  assert.throws(() => callApprove(SPENDER, 0n), /out of range/);
});

test("ERC-20 call data refuses a malformed address", () => {
  assert.throws(() => callBalanceOf("0x1234"), /address/);
  assert.throws(() => callApprove("not-an-address", 1n), /address/);
});

test("needsApproval: only when the allowance is below the amount", () => {
  assert.equal(needsApproval("0x0", 1n), true);
  assert.equal(needsApproval("0x" + (99n).toString(16), 100n), true);
  assert.equal(needsApproval("0x" + (100n).toString(16), 100n), false);
  assert.equal(needsApproval("0x", 100n), true, "an empty answer is treated as no allowance");
  assert.equal(needsApproval(undefined, 1n), true);
  assert.equal(needsApproval("0x" + "f".repeat(64), 10n ** 30n), false, "an unlimited allowance is enough");
});

test("readStatus: LI.FI's status → what the panel shows", () => {
  assert.deepEqual(readStatus({ status: "DONE", substatus: "COMPLETED" }), { phase: "done" });
  assert.deepEqual(readStatus({ status: "DONE", substatus: "PARTIAL" }), { phase: "partial" });
  assert.deepEqual(readStatus({ status: "DONE", substatus: "REFUNDED" }), { phase: "refunded" });
  assert.deepEqual(readStatus({ status: "DONE", substatus: "SOMETHING_NEW" }), { phase: "check" }, "never claim success on a status we don't know");
  assert.deepEqual(readStatus({ status: "INVALID" }), { phase: "pending", message: null });
  assert.deepEqual(readStatus({ status: "FAILED" }), { phase: "failed" });
  assert.deepEqual(readStatus({ status: "PENDING", substatusMessage: "Waiting for confirmations" }), { phase: "pending", message: "Waiting for confirmations" });
  assert.deepEqual(readStatus({ status: "NOT_FOUND" }), { phase: "pending", message: null });
  assert.deepEqual(readStatus(null), { phase: "pending", message: null });
});

test("explorerTx: a link on the right explorer, none for an unknown chain or a bad hash", () => {
  const h = "0x" + "ab".repeat(32);
  assert.equal(explorerTx(8453, h), `https://basescan.org/tx/${h}`);
  assert.equal(explorerTx(1, h), `https://etherscan.io/tx/${h}`);
  assert.equal(explorerTx(999, h), null);
  assert.equal(explorerTx(1, "0xnothash"), null);
});

test("shortAddr and isRejection", () => {
  assert.equal(shortAddr(OWNER), "0x1234…5678");
  assert.equal(isRejection({ code: 4001 }), true);
  assert.equal(isRejection({ code: "ACTION_REJECTED" }), true);
  assert.equal(isRejection({ message: "User rejected the request." }), true);
  assert.equal(isRejection({ code: -32000, message: "insufficient funds" }), false);
});

test("discovery: with announcements, the injected wallet is not added again", async () => {
  const found = await discoverWallets({ target: fakeWindow([wallet("a", "Rabby")], { isMetaMask: true }), waitMs: 10 });
  assert.deepEqual(found.map((x) => x.info.name), ["Rabby"]);
});

test("isRejection: a refusal wrapped in an RPC error, or 'User denied', still counts", () => {
  assert.equal(isRejection({ code: -32603, message: "Internal error", data: { originalError: { code: 4001 } } }), true);
  assert.equal(isRejection({ code: -32603, cause: { code: 4001 } }), true);
  assert.equal(isRejection({ message: "MetaMask Tx Signature: User denied transaction signature." }), true);
  assert.equal(isRejection({ code: -32603, data: { originalError: { code: -32000 } } }), false);
});

test("sameChain: hex in either case, or a number", () => {
  assert.equal(sameChain("0x2105", 8453), true);
  assert.equal(sameChain("0X2105", 8453), true);
  assert.equal(sameChain(8453, 8453), true);
  assert.equal(sameChain("8453", 8453), true);
  assert.equal(sameChain("0x1", 8453), false);
  assert.equal(sameChain(undefined, 8453), false);
});

test("mustResetFirst: only USDT on Ethereum with a non-zero allowance", () => {
  const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  assert.equal(mustResetFirst(1, USDT, "0x5"), true);
  assert.equal(mustResetFirst(1, USDT, "0x0"), false);
  assert.equal(mustResetFirst(1, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0x5"), false);
});

// ── buildDepositTx: the one place that decides what gets signed ──
const D = LIFI_DIAMOND[8453], PAY = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
const ctx = { from: OWNER, chainId: 8453, units: 250_000_000n, payToken: PAY, vaultToken: VAULT };
const quote = (o = {}, tr = {}) => ({
  action: { fromChainId: 8453, toChainId: 8453, fromToken: { address: PAY }, toToken: { address: VAULT }, fromAmount: "250000000", fromAddress: OWNER.toLowerCase(), ...o },
  estimate: { approvalAddress: D },
  transactionRequest: { to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0xdeadbeef00", value: "0x0", gasLimit: "0x5208", chainId: 8453, ...tr },
});

test("buildDepositTx: a matching quote → the transaction, with the chain id the wallet must sign on", () => {
  assert.deepEqual(buildDepositTx(quote(), ctx), {
    spender: D,
    tx: { from: OWNER, to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0xdeadbeef00", value: "0x0", gas: "0x5208", chainId: "0x2105" },
  });
  assert.equal(buildDepositTx(quote({}, { gasLimit: 21000, value: 0 }), ctx).tx.gas, "0x5208", "numbers become hex");
});

test("buildDepositTx: anything that is not exactly this deposit is refused, with a plain message", () => {
  const OTHER = "0x9999999999999999999999999999999999999999";
  const bad = {
    "no transaction": { ...quote(), transactionRequest: undefined },
    "another chain": quote({ toChainId: 1 }),
    "another source chain": quote({ fromChainId: 1 }),
    "another pay token": quote({ fromToken: { address: OTHER } }),
    "another amount": quote({ fromAmount: "250000001" }),
    "another sender": quote({ fromAddress: OTHER }),
    "another destination": quote({ toToken: { address: OTHER } }),
    "another contract": quote({}, { to: OTHER }),
    "sends ETH too": quote({}, { value: "0x1" }),
    "tx chain id differs": quote({}, { chainId: 1 }),
    "no call data": quote({}, { data: "0x" }),
    "another spender": { ...quote(), estimate: { approvalAddress: OTHER } },
  };
  for (const [why, q] of Object.entries(bad)) {
    let err;
    try { buildDepositTx(q, ctx); } catch (e) { err = e; }
    assert.ok(err?.plain && /nothing was signed/.test(err.message), why);
  }
});

test("buildDepositTx: no approval address (nothing to approve) is fine", () => {
  assert.equal(buildDepositTx({ ...quote(), estimate: {} }, ctx).spender, null);
});
