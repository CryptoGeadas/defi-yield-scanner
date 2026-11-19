// The connected wallet's position in a vault (#68): shares and their value, read from the
// vault contract. Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readPosition, positionText, positionKind, PositionReader } from "../site/position.js";

const VAULT = "0xbeef088055857739c12cd3765f20b7679def0f51";
const ACCT = "0x1111111111111111111111111111111111111111";
const hex = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");

// A fake chain: answers eth_call by the 4-byte selector of the call data.
function chain(answers, calls = []) {
  return async (chainId, method, [{ to, data }]) => {
    calls.push({ chainId, method, to, sel: data.slice(0, 10) });
    const a = answers[data.slice(0, 10)];
    if (a instanceof Error) throw a;
    if (a === undefined) throw new Error("execution reverted");
    return typeof a === "function" ? a(data) : a;
  };
}
const BAL = "0x70a08231", DEC = "0x313ce567", C2A = "0x07a2d13a";

test("ERC-4626: shares and their value in the vault's coin", async () => {
  const calls = [];
  const read = chain({ [BAL]: hex(1_198_200_000_000_000_000_000n), [DEC]: hex(18), [C2A]: (d) => {
    assert.equal(BigInt("0x" + d.slice(10)), 1_198_200_000_000_000_000_000n, "asks the value of exactly the held shares");
    return hex(1_234_560_000n);
  } }, calls);
  const p = await readPosition({ read, chainId: 1, vault: VAULT, account: ACCT, kind: "erc4626", assetDecimals: 6 });
  assert.deepEqual(p, { status: "held", shares: 1_198_200_000_000_000_000_000n, shareDecimals: 18, assets: 1_234_560_000n, assetDecimals: 6 });
  assert.ok(calls.every((c) => c.chainId === 1 && c.to === VAULT && c.method === "eth_call"));
  assert.equal(positionText(p, "USDC"), "Your position: 1,234.56 USDC (1,198.2 shares)");
});

test("zero shares is a real answer: no position", async () => {
  const read = chain({ [BAL]: hex(0) });
  const p = await readPosition({ read, chainId: 1, vault: VAULT, account: ACCT, kind: "erc4626", assetDecimals: 6 });
  assert.deepEqual(p, { status: "none" });
  assert.equal(positionText(p, "USDC"), "You hold no shares in this vault");
});

test("a failed read is unknown, never 0", async () => {
  const p = await readPosition({ read: chain({ [BAL]: new Error("RPC HTTP 503") }), chainId: 1, vault: VAULT, account: ACCT, kind: "erc4626", assetDecimals: 6 });
  assert.equal(p.status, "unknown");
  assert.match(positionText(p, "USDC"), /unknown/i);
  assert.doesNotMatch(positionText(p, "USDC"), /\b0\b/);
});

test("a vault that cannot value its shares: shares shown, value unknown", async () => {
  const read = chain({ [BAL]: hex(5n * 10n ** 18n), [DEC]: hex(18) }); // convertToAssets reverts
  const p = await readPosition({ read, chainId: 1, vault: VAULT, account: ACCT, kind: "erc4626", assetDecimals: 6 });
  assert.deepEqual(p, { status: "held", shares: 5n * 10n ** 18n, shareDecimals: 18, assets: null, assetDecimals: 6 });
  assert.equal(positionText(p, "USDC"), "Your position: 5 shares (value unknown)");
});

test("a bad answer (not a number) is unknown", async () => {
  const p = await readPosition({ read: chain({ [BAL]: "0x" }), chainId: 1, vault: VAULT, account: ACCT, kind: "erc4626", assetDecimals: 6 });
  assert.equal(p.status, "unknown");
});

test("Aave v3: the aToken balance is the coin amount", async () => {
  const calls = [];
  const read = chain({ [BAL]: hex(250_500_000n) }, calls);
  const p = await readPosition({ read, chainId: 8453, vault: VAULT, account: ACCT, kind: "atoken", assetDecimals: 6 });
  assert.deepEqual(p, { status: "held", shares: null, shareDecimals: null, assets: 250_500_000n, assetDecimals: 6 });
  assert.deepEqual(calls.map((c) => c.sel), [BAL], "no share price to ask");
  assert.equal(positionText(p, "USDC"), "Your position: 250.5 USDC");
});

test("which way to read a row", () => {
  assert.equal(positionKind("aave-v3"), "atoken");
  for (const p of ["morpho-blue", "yearn-finance", "spark-savings", "euler-v2"]) assert.equal(positionKind(p), "erc4626");
});

test("reader: reads once per account, again after a deposit or an account change", async () => {
  let n = 0;
  const read = chain({ [BAL]: () => { n++; return hex(0); } });
  const r = new PositionReader({ read, chainId: 1, vault: VAULT, kind: "erc4626", assetDecimals: 6 });
  await r.load(ACCT);
  await r.load(ACCT);
  assert.equal(n, 1, "the same account is not read twice");
  r.invalidate(); // a deposit finished
  await r.load(ACCT);
  assert.equal(n, 2);
  await r.load("0x2222222222222222222222222222222222222222"); // the wallet switched account
  assert.equal(n, 3);
  r.load(null);
  assert.equal(r.position, null, "no wallet: no line");
});

test("reader: a late answer for an old account is dropped", async () => {
  let release;
  const read = async () => { await new Promise((r) => (release = r)); return hex(7n * 10n ** 6n); };
  const r = new PositionReader({ read, chainId: 1, vault: VAULT, kind: "atoken", assetDecimals: 6 });
  const first = r.load(ACCT);
  r.load(null); // disconnected while the read was running
  release();
  await first;
  assert.equal(r.position, null);
});
