// The connected wallet's position in one vault (#68): how many vault shares it holds and
// what they are worth in the vault's coin. Read-only calls to the vault contract on its own
// chain (through the public RPC the panel already uses); nothing is signed.
// A read that fails is "unknown", never 0: 0 would wrongly say the wallet holds nothing.

import { callBalanceOf } from "./wallet.js";
import { fmtUnits } from "./deposit-text.js";

const DECIMALS = "0x313ce567";
const callConvertToAssets = (shares) => "0x07a2d13a" + shares.toString(16).padStart(64, "0");

// How a row's vault token counts the wallet's money:
//   erc4626 — shares; convertToAssets() gives their value (Morpho, Yearn v3, Spark, Euler)
//   atoken  — Aave v3 aTokens: the balance already is the coin amount
export const positionKind = (project) => (project === "aave-v3" ? "atoken" : "erc4626");

const toBig = (hex) => {
  if (typeof hex !== "string" || !/^0x[0-9a-f]+$/i.test(hex)) throw new Error(`not a number: ${String(hex).slice(0, 20)}`);
  return BigInt(hex);
};

// read(chainId, method, params) → hex result (readChain in the page, a fake in tests).
// → { status: "held", shares, shareDecimals, assets, assetDecimals } (assets null = value unknown)
//   | { status: "none" } | { status: "unknown", reason }
export async function readPosition({ read, chainId, vault, account, kind, assetDecimals }) {
  const call = (data) => read(chainId, "eth_call", [{ to: vault, data }, "latest"]);
  let balance;
  try { balance = toBig(await call(callBalanceOf(account))); }
  catch (e) { return { status: "unknown", reason: e.message }; }
  if (balance === 0n) return { status: "none" };
  if (kind === "atoken") return { status: "held", shares: null, shareDecimals: null, assets: balance, assetDecimals };

  let shareDecimals;
  try { shareDecimals = Number(toBig(await call(DECIMALS))); }
  catch (e) { return { status: "unknown", reason: e.message }; }
  let assets = null;
  try { assets = toBig(await call(callConvertToAssets(balance))); }
  catch (e) { console.warn("position: the vault did not value its shares", e); }
  return { status: "held", shares: balance, shareDecimals, assets, assetDecimals };
}

export function positionText(p, symbol) {
  if (!p) return "";
  if (p.status === "none") return "You hold no shares in this vault";
  if (p.status !== "held") return "Your position: unknown (could not be read right now)";
  const shares = p.shares != null ? `${fmtUnits(p.shares, p.shareDecimals)} shares` : null;
  if (p.assets == null) return `Your position: ${shares} (value unknown)`;
  const value = `${fmtUnits(p.assets, p.assetDecimals)} ${symbol}`;
  return `Your position: ${value}${shares ? ` (${shares})` : ""}`;
}

// Keeps one vault's position for the connected account. load() reads once per account;
// invalidate() (after a deposit) makes the next load read again. An answer for an account
// the panel no longer shows is dropped.
export class PositionReader {
  constructor({ read, chainId, vault, kind, assetDecimals }) {
    Object.assign(this, { read, chainId, vault, kind, assetDecimals });
    this.account = null;
    this.position = null; // null = no wallet, or still reading
    this.fresh = false;
  }

  invalidate() { this.fresh = false; }

  async load(account) {
    if (!account) { this.account = null; this.position = null; this.fresh = false; return; }
    if (account === this.account && this.fresh) return;
    if (account !== this.account) this.position = null;
    this.account = account;
    this.fresh = true;
    const p = await readPosition({ read: this.read, chainId: this.chainId, vault: this.vault, account, kind: this.kind, assetDecimals: this.assetDecimals });
    if (this.account === account) this.position = p;
  }
}
