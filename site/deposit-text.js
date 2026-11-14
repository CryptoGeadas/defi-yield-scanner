// Deposit text and pure readers (#64): what the user types, what LI.FI answers, and the words the
// panel shows. Shared by the panel (deposit.js) and the deposit flow (deposit-flow.js); no page code.
import { explorerTx, isRejection, readStatus, CHAIN_NAME } from "./wallet.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// What the user typed → { units } (a BigInt in the token's smallest unit) or { error }:
// "empty" | "format" | "decimals" (more digits than the token has) | "zero".
// A comma works as the decimal mark ("1,5"), as people type it in much of Europe.
export function parseAmount(text, decimals) {
  let t = String(text ?? "").trim();
  if (/^\d{1,3},\d{3}$/.test(t)) return { error: "format" }; // "1,000": a thousands mark or a decimal? don't guess
  t = t.replace(",", ".");
  if (!t) return { error: "empty" };
  const m = t.match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) return { error: "format" };
  const frac = m[2] || "";
  if (frac.length > decimals) return { error: "decimals" };
  const units = BigInt((m[1] || "0") + frac.padEnd(decimals, "0"));
  return units > 0n ? { units } : { error: "zero" };
}
export const AMOUNT_HELP = {
  format: () => "Use digits and one decimal mark, e.g. 250.5 (no thousands separators)",
  decimals: (sym, dec) => `${sym} has at most ${dec} decimals`,
  zero: () => "Enter an amount above 0",
};

// LI.FI's /quote answer → { amount, symbol, usd } for this deposit, or throws an Error
// with a plain message. The route must end in this vault's own token, whatever tool
// built it (same-chain routes often run through a DEX aggregator, not Composer).
export function readQuote(j, deposit) {
  const to = j?.action?.toToken, est = j?.estimate;
  if (!to || !est) throw new Error("LI.FI sent an answer this page can't read");
  if (String(to.address).toLowerCase() !== deposit.token) throw new Error("the route does not end in this vault's token, so it is blocked");
  if (!/^\d+$/.test(String(est.toAmount)) || !Number.isInteger(to.decimals)) throw new Error("LI.FI sent an answer this page can't read");
  const usd = Number(est.toAmountUSD);
  return { amount: Number(BigInt(est.toAmount)) / 10 ** to.decimals, symbol: String(to.symbol ?? ""), usd: Number.isFinite(usd) ? usd : null };
}
export const plainError = (html) => Object.assign(new Error(html), { plain: true }); // a message already written for the user (may hold a link)

// What the user reads when a deposit stops with an error. Never says "nothing was sent"
// once a transaction went out. ctx: { approved, sent } — sent is set once the deposit is sent.
export function failureText(e, { approved = false, sent = null } = {}) {
  if (isRejection(e))
    return approved ? "You rejected the deposit in your wallet. The approval went through, but nothing was deposited." : "You rejected it in your wallet. Nothing was sent.";
  if (e?.plain) return e.message;
  const what = esc(String(e?.message ?? e ?? "unknown error").replace(/\.$/, ""));
  return sent ? `Something went wrong after the deposit was sent: ${what}. Check the transaction before trying again.`
    : `The deposit did not go through: ${what}.${approved ? " The approval went through, but nothing was deposited." : " Nothing was deposited."}`;
}
// LI.FI's /status answer for a cross-chain deposit → { phase, kind, html } (null while it
// is still running). ctx: { sent ("250 USDC"), sym, fromChainId, toChainId, sourceLink }.
// ctx.vaultToken: "Deposited" only when LI.FI says the vault's own token arrived on the
// vault's chain. ctx.hash: for LI.FI's explorer, which follows both chains.
export function bridgeOutcome(j, { sent, sym, fromChainId, toChainId, sourceLink = "", vaultToken = null, hash = null }) {
  const st = readStatus(j);
  if (st.phase === "pending") return null;
  const to = CHAIN_NAME[toChainId] ?? "the vault's chain", got = j?.receiving ?? {};
  const gotChain = CHAIN_NAME[Number(got.chainId)] ?? null;
  // built from the chain's own explorer, never LI.FI's link text (a bad answer must not show a stranger's page)
  const recvUrl = explorerTx(Number(got.chainId), got.txHash);
  const recvLink = recvUrl ? ` <a href="${esc(recvUrl)}" target="_blank" rel="noopener">View on ${esc(gotChain ?? to)} ↗</a>` : "";
  const scan = /^0x[0-9a-f]{64}$/i.test(String(hash)) ? ` <a href="https://scan.li.fi/tx/${esc(hash)}" target="_blank" rel="noopener">Track on LI.FI ↗</a>` : "";
  const check = { phase: "unknown", kind: "warn", html: `Finished, but LI.FI reports a result this page doesn't know. Check where your ${esc(sym)} is before depositing again.${sourceLink}${recvLink}${scan}` };
  if (st.phase === "done") {
    const rightChain = got.chainId != null && Number(got.chainId) === Number(toChainId);
    const rightToken = !vaultToken || (got.token?.address && String(got.token.address).toLowerCase() === String(vaultToken).toLowerCase());
    if (!rightChain || !rightToken) return check;
    return { phase: "done", kind: "ok", html: `Deposited ${esc(sent)} on ${esc(to)}.${sourceLink}${recvLink}` };
  }
  if (st.phase === "partial")
    return { phase: "done", kind: "warn", html: `The bridge worked, but the deposit did not: you have ${esc(got.token?.symbol || "tokens")} in your wallet on ${esc(gotChain ?? to)}, not vault shares. You can deposit them from there.${sourceLink}${recvLink}${scan}` };
  if (st.phase === "refunded") {
    const where = gotChain ?? CHAIN_NAME[fromChainId] ?? "the chain you paid from";
    return { phase: "done", kind: "warn", html: `The transfer was refunded: your ${esc(sym)} is back in your wallet on ${esc(where)}. Nothing was deposited.${sourceLink}${recvLink}${scan}` };
  }
  if (st.phase === "failed") return { phase: "failed", kind: "warn", html: `The transfer failed. Check the transaction to see where your ${esc(sym)} is.${sourceLink}${scan}` };
  return check;
}
// LI.FI's estimate in seconds → "under a minute" | "about 4 min" | "time unknown"
export function timeText(secs) {
  const n = Number(secs);
  if (secs == null || !Number.isFinite(n) || n < 0) return "time unknown";
  return n < 60 ? "under a minute" : `about ${Math.round(n / 60)} min`;
}
// LI.FI's quote → the facts the panel shows, in plain words. Tool names (OKX, Across,
// Composer) are not shown: the route is described by what happens.
// → { minimum, symbol, feeUsd, feePct (LI.FI's own fee), otherFeeUsd (bridge/DEX fees in the
// route), onTopUsd (fees paid on top of the amount), gasUsd, time, route }; a number is null
// when LI.FI gave none (shown as unknown, never $0).
export function quoteFacts(raw, { payChainId, vaultChainId }) {
  const est = raw?.estimate ?? {}, to = raw?.action?.toToken ?? {};
  const num = (v) => (v == null || v === "" ? NaN : Number(v)); // "" is no value, not 0
  const usd = (xs) => (xs.length ? (((v) => (Number.isFinite(v) ? v : null))(xs.reduce((t, x) => t + num(x?.amountUSD), 0))) : null);
  const all = Array.isArray(est.feeCosts) ? est.feeCosts : [];
  const lifi = (x) => /li\.?fi/i.test(String(x?.name ?? ""));
  const fees = all.filter((x) => x?.included !== false && lifi(x));
  const other = all.filter((x) => x?.included !== false && !lifi(x));
  const onTop = all.filter((x) => x?.included === false);
  const pct = fees.reduce((t, x) => t + num(x?.percentage), 0);
  const min = /^\d+$/.test(String(est.toAmountMin)) && Number.isInteger(to.decimals) ? Number(BigInt(est.toAmountMin)) / 10 ** to.decimals : null;
  const vault = CHAIN_NAME[vaultChainId] ?? "the vault's chain";
  return {
    minimum: min, symbol: String(to.symbol ?? ""),
    feeUsd: usd(fees), feePct: fees.length && Number.isFinite(pct) ? pct * 100 : null,
    otherFeeUsd: usd(other), onTopUsd: usd(onTop),
    gasUsd: usd(Array.isArray(est.gasCosts) ? est.gasCosts : []),
    time: timeText(est.executionDuration),
    route: payChainId === vaultChainId ? `Swap and deposit on ${vault}` : `Bridge to ${vault}, then deposit`,
  };
}
export const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 });
export const fmtUnits = (units, decimals) => fmt(Number(units) / 10 ** decimals);
