// The deposit flow (site/deposit-flow.js, #64) with a fake wallet, fake chain reads and fake
// quotes: every step the money takes, and every way it can stop. No page, no network, no waiting.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runDeposit, DEPOSIT_RECEIPT_MS, STATUS_MAX_MS, STATUS_EVERY_MS } from "../site/deposit-flow.js";
import { buildDepositTx } from "../site/wallet.js";

const FROM = "0x00000000000000000000000000000000000000a1";
const SPENDER = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const USDC_BASE = { chainId: 8453, address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 };
const USDT_ETH = { chainId: 1, address: "0xdac17f958d2ee523a2206206994597c13d831ec7", symbol: "USDT", decimals: 6 };
const VAULT = "0x00000000000000000000000000000000000000ee";
const HASH = (n) => "0x" + String(n).padStart(64, "0");
const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const timeout = () => Object.assign(new Error("timeout"), { name: "TimeoutError" });

// A world the flow runs in: a wallet that records every request, a chain, a quote source.
function world({ pay = USDC_BASE, vaultChainId = pay.chainId, allowance = 10n ** 30n, spender = SPENDER, walletChain = pay.chainId,
  receipts = {}, sendFails = null, reject = null, quotesThrow = null, status = [], switchFails = null } = {}) {
  const calls = [], steps = [], state = {};
  let chainId = walletChain, account = FROM, sends = 0, quotes = 0, statusReads = 0, sleeps = 0;
  const wallet = {
    account: () => account,
    async request({ method, params }) {
      calls.push(method === "eth_sendTransaction" ? { method, data: params[0].data, to: params[0].to } : { method });
      if (method === "eth_chainId") return "0x" + chainId.toString(16);
      if (method === "eth_sendTransaction") {
        if (reject === sends) { sends++; throw Object.assign(new Error("User rejected"), { code: 4001 }); }
        if (sendFails === sends) { sends++; throw new Error("nonce too low"); }
        return HASH(++sends);
      }
      throw new Error("unexpected " + method);
    },
  };
  const chain = {
    async read(c, method, params) { calls.push({ method: "read", data: params[0].data }); return word(allowance); },
    async receipt(c, hash, opts = {}) {
      calls.push({ method: "receipt", hash, maxMs: opts.maxMs ?? null });
      const r = receipts[hash] ?? true;
      if (r === "timeout") throw timeout();
      return r;
    },
    async switchTo(c) { calls.push({ method: "switch", c }); if (switchFails) throw switchFails; chainId = c; },
  };
  const quoteSource = {
    async fresh(units) {
      quotes++;
      calls.push({ method: "quote", n: quotes });
      if (quotesThrow) throw quotesThrow;
      return { raw: { tool: vaultChainId === pay.chainId ? "composer" : "across", estimate: { executionDuration: 120 } }, spender, tx: { from: FROM, data: "0xdeposit" + quotes }, quote: { n: quotes } };
    },
  };
  const run = (over = {}) => runDeposit({
    wallet, chain, quotes: quoteSource, pay, vaultChainId, vaultToken: VAULT, units: 250_000_000n, from: FROM,
    status: async () => { statusReads++; const s = status.shift(); if (s instanceof Error) throw s; return s ?? { status: "PENDING" }; },
    set: (p) => { Object.assign(state, p); steps.push(p.phase ?? null); },
    sleep: async () => { sleeps++; }, log: { warn() {} }, ...over,
  });
  return { run, calls, steps, state, setAccount: (a) => { account = a; }, setChain: (c) => { chainId = c; },
    counts: () => ({ sends, quotes, statusReads, sleeps }) };
}
const methods = (calls) => calls.map((c) => c.method);
const phases = (steps) => steps.filter(Boolean);

test("same chain, enough allowance: fresh quote → check → send → receipt → done", async () => {
  const w = world();
  await w.run();
  assert.deepEqual(phases(w.steps), ["quoting", "confirm", "depositing", "done"]);
  assert.deepEqual(methods(w.calls), ["quote", "eth_chainId", "eth_chainId", "read", "eth_chainId", "eth_sendTransaction", "receipt"]);
  assert.equal(w.calls.at(-1).maxMs, DEPOSIT_RECEIPT_MS, "the deposit's receipt is awaited 15 minutes");
  assert.match(w.state.msg.html, /^Deposited 250 USDC\. <a href="https:\/\/basescan\.org\/tx\/0x0+1"/);
  assert.equal(w.state.sent, "250 USDC");
  assert.match(w.state.lastTx, /^Your last deposit:/);
  assert.deepEqual(w.state.quote, { n: 1 });
});

test("an approval is needed: approve, wait for it, then a fresh quote before the deposit", async () => {
  const w = world({ allowance: 0n });
  await w.run();
  assert.deepEqual(phases(w.steps), ["quoting", "approve", "approving", "quoting", "confirm", "depositing", "done"]);
  assert.equal(w.state.twoSteps, true);
  const sent = w.calls.filter((c) => c.method === "eth_sendTransaction");
  assert.equal(sent.length, 2);
  assert.ok(sent[0].data.startsWith("0x095ea7b3"), "first the approve call");
  assert.ok(sent[0].data.endsWith(250_000_000n.toString(16).padStart(64, "0")), "for exactly the amount");
  assert.equal(sent[1].data, "0xdeposit2", "the deposit signs the second, fresh quote");
  assert.deepEqual(w.state.quote, { n: 2 });
});

test("USDT on Ethereum with an old allowance: back to 0 first, then the amount", async () => {
  const w = world({ pay: USDT_ETH, allowance: 5n });
  await w.run();
  const approvals = w.calls.filter((c) => c.method === "eth_sendTransaction" && c.data.startsWith("0x095ea7b3"));
  assert.equal(approvals.length, 2);
  assert.ok(approvals[0].data.endsWith("0".repeat(64)), "reset to 0");
  assert.ok(approvals[1].data.endsWith(250_000_000n.toString(16).padStart(64, "0")));
  assert.equal(w.state.phase, "done");
});

test("the wallet is on another chain: it is switched first; if it does not switch, nothing is signed", async () => {
  const ok = world({ walletChain: 1 });
  await ok.run();
  assert.ok(methods(ok.calls).includes("switch"));
  assert.equal(ok.state.phase, "done");
  const stuck = world({ walletChain: 1 });
  const chain = { read: async () => word(10n ** 30n), receipt: async () => true, switchTo: async () => {} }; // accepts, does not switch
  await stuck.run({ chain });
  assert.equal(stuck.counts().sends, 0);
  assert.equal(stuck.state.phase, "failed");
  assert.match(stuck.state.msg.html, /^Your wallet is not on Base\. Switch it to Base, then try again\. Nothing more was sent\.$/);
});

test("the account changes during the approval: the deposit is not signed, and the message says the approval went through", async () => {
  const w = world({ allowance: 0n });
  const chain = {
    read: async () => word(0n),
    receipt: async () => { w.setAccount("0x00000000000000000000000000000000000000b2"); return true; },
    switchTo: async () => {},
  };
  await w.run({ chain });
  assert.equal(w.counts().sends, 1, "only the approval was sent");
  assert.equal(w.state.phase, "failed");
  assert.match(w.state.msg.html, /The account changed in your wallet, so nothing more was sent\. The approval went through\./);
});

test("the chain changes in the wallet before the deposit is signed: stopped, nothing more sent", async () => {
  const w = world({ allowance: 0n });
  const chain = { read: async () => word(0n), receipt: async () => { w.setChain(1); return true; }, switchTo: async () => {} };
  await w.run({ chain });
  assert.equal(w.counts().sends, 1);
  assert.match(w.state.msg.html, /^Your wallet is not on Base/);
});

test("an approval that is not confirmed in time: stop, and keep the warning visible (it may still go through)", async () => {
  const w = world({ allowance: 0n, receipts: { [HASH(1)]: "timeout" } });
  await w.run();
  assert.equal(w.state.phase, "failed");
  assert.match(w.state.msg.html, /^The approval is still not confirmed\. It may still go through/);
  assert.equal(w.state.lastTx, w.state.msg.html, "sticky: stays after the user types a new amount");
  assert.equal(w.counts().sends, 1);
});

test("an approval that reverts: nothing was deposited", async () => {
  const w = world({ allowance: 0n, receipts: { [HASH(1)]: false } });
  await w.run();
  assert.match(w.state.msg.html, /^The approval failed on chain\. Nothing was deposited\./);
});

test("the deposit is not confirmed after 15 minutes: unknown, never 'failed' or 'nothing sent'", async () => {
  const w = world({ receipts: { [HASH(1)]: "timeout" } });
  await w.run();
  assert.equal(w.state.phase, "unknown");
  assert.match(w.state.msg.html, /^Not confirmed after 15 minutes\. It may still go through/);
  assert.equal(w.state.lastTx, w.state.msg.html);
});

test("the deposit reverts on chain: the money stayed in the wallet", async () => {
  const w = world({ receipts: { [HASH(1)]: false } });
  await w.run();
  assert.equal(w.state.phase, "failed");
  assert.match(w.state.msg.html, /^The deposit failed on chain\. Your USDC stayed in your wallet; only the network fee was spent\./);
});

test("rejected in the wallet: before or after the approval, the words say what happened", async () => {
  const first = world({ reject: 0 });
  await first.run();
  assert.equal(first.state.msg.html, "You rejected it in your wallet. Nothing was sent.");
  const second = world({ allowance: 0n, reject: 1 });
  await second.run();
  assert.equal(second.state.msg.html, "You rejected the deposit in your wallet. The approval went through, but nothing was deposited.");
});

test("a quote that does not match the deposit stops it before anything is signed", async () => {
  const mismatch = (() => { try { buildDepositTx({}, { from: FROM, chainId: 8453, units: 1n, payToken: USDC_BASE.address, vaultToken: VAULT }); } catch (e) { return e; } })();
  assert.equal(mismatch.code, "quote-mismatch", "errors carry a code");
  assert.equal(mismatch.quoteText, "The quote does not match this deposit (no transaction in it).", "and a short form for the quote line");
  const w = world({ quotesThrow: mismatch });
  await w.run();
  assert.equal(w.counts().sends, 0);
  assert.equal(w.state.msg.html, mismatch.message);
});

test("the panel never edits an error's wording: it reads the error's own short form", async () => {
  const panel = await readFile(new URL("../site/deposit.js", import.meta.url), "utf8");
  assert.doesNotMatch(panel, /\.message\.replace\(/);
  assert.match(panel, /e\.quoteText \?\? e\.message/);
});

test("a bridge: sent, then LI.FI's status until the vault's token arrives", async () => {
  const w = world({ pay: USDC_BASE, vaultChainId: 42161, status: [
    { status: "PENDING", substatus: "WAIT_DESTINATION_TRANSACTION" },
    { status: "DONE", substatus: "COMPLETED", receiving: { chainId: 42161, txHash: HASH(9), token: { address: VAULT, symbol: "vUSDC" } } },
  ] });
  await w.run();
  assert.deepEqual(phases(w.steps).slice(-3), ["depositing", "bridging", "done"]);
  assert.match(w.state.msg.html, /^Deposited 250 USDC on Arbitrum\./);
  assert.equal(w.counts().statusReads, 2);
});

test("a bridge that refunds: the money is back, said as a warning that stays visible", async () => {
  const w = world({ pay: USDC_BASE, vaultChainId: 42161, status: [{ status: "DONE", substatus: "REFUNDED", receiving: { chainId: 8453 } }] });
  await w.run();
  assert.equal(w.state.msg.kind, "warn");
  assert.match(w.state.msg.html, /refunded: your USDC is back in your wallet on Base/);
  assert.equal(w.state.lastTx, w.state.msg.html);
});

test("a bridge still running after 30 minutes: unknown, with a link to follow it", async () => {
  const w = world({ pay: USDC_BASE, vaultChainId: 42161 });
  await w.run();
  assert.equal(w.counts().statusReads, STATUS_MAX_MS / STATUS_EVERY_MS);
  assert.equal(w.state.phase, "unknown");
  assert.match(w.state.msg.html, /^The bridge is still not finished after 30 minutes\./);
  assert.match(w.state.msg.html, /scan\.li\.fi\/tx\//);
});

test("bridge status that cannot be read three times in a row says so, and keeps trying", async () => {
  const down = new Error("network");
  const w = world({ pay: USDC_BASE, vaultChainId: 42161, status: [down, down, down,
    { status: "DONE", substatus: "COMPLETED", receiving: { chainId: 42161, txHash: HASH(9), token: { address: VAULT } } }] });
  const seen = [];
  await w.run({ set: (p) => { Object.assign(w.state, p); if (p.msg) seen.push(p.msg.html); } });
  assert.ok(seen.some((h) => /^The bridge status can't be read right now; still trying\./.test(h)));
  assert.equal(w.state.phase, "done");
});

test("an error after the deposit was sent never says nothing was sent", async () => {
  const w = world();
  const chain = { read: async () => word(10n ** 30n), receipt: async () => { throw new Error("RPC down"); }, switchTo: async () => {} };
  await w.run({ chain });
  assert.equal(w.state.phase, "failed");
  assert.match(w.state.msg.html, /^Something went wrong after the deposit was sent: RPC down\. Check the transaction before trying again\.$/);
});

// #64: the panel's helpers moved to deposit-text.js; a name the panel uses but no longer
// imports would only fail in the browser. This finds it in Node.
test("every helper the panel uses from deposit-text.js is imported", async () => {
  const text = await readFile(new URL("../site/deposit-text.js", import.meta.url), "utf8");
  const panel = await readFile(new URL("../site/deposit.js", import.meta.url), "utf8");
  const defined = [...text.matchAll(/^export (?:const|function|async function) (\w+)/gm)].map((m) => m[1]);
  const imported = new Set(panel.match(/import \{([^}]*)\} from "\.\/deposit-text\.js"/)[1].split(",").map((x) => x.trim()));
  const own = new Set([...panel.matchAll(/\b(?:const|let|function) (\w+)/g)].map((m) => m[1]));
  const body = panel.replace(/^(import|export) .*$/gm, "");
  const missing = defined.filter((n) => new RegExp(`\\b${n}\\b`).test(body) && !imported.has(n) && !own.has(n));
  assert.deepEqual(missing, []);
});
