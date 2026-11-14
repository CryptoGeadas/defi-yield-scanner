// Deposit flow (#64): the steps that move the user's money, with no page code, so every step is
// tested in Node with a fake wallet, fake chain reads and fake quotes (build/deposit-flow.test.mjs).
// The panel (deposit.js) only draws what the flow reports.
//
//   runDeposit({ wallet, chain, quotes, status, pay, vaultChainId, vaultToken, units, from, set, sleep?, now? })
//     wallet   { request({ method, params }), account() }: the connected provider, and the
//              account the panel shows now (it changes when the user switches in the wallet)
//     chain    { read(chainId, method, params), receipt(chainId, hash, { maxMs }), switchTo(chainId) }
//              receipt → true (success) | false (reverted); throws a TimeoutError past maxMs
//     quotes   { fresh(units, from, pay) → { raw, spender, tx, quote } }: a fresh quote checked into
//              the transaction to sign (buildDepositTx); throws a plain error when it doesn't match
//     status   (url) → LI.FI /status JSON | null: one read of a bridge's progress
//     pay      { chainId, address, symbol, decimals }: what the user pays with
//     set      (patch) → void: the panel merges the patch into its state and redraws.
//              patch keys: phase, msg, twoSteps, hash, sent, lastTx, quote
//   Order: fresh quote → wallet on the pay chain → approve if needed (USDT back to 0 first) →
//   fresh quote again after an approval → send → its receipt (15 min) → for a bridge, LI.FI's
//   /status until done (30 min). Before every signature: still the same account, still on the
//   pay chain. Never says "nothing was sent" once a transaction went out (failureText).
import { callAllowance, callApprove, needsApproval, mustResetFirst, sameChain, explorerTx, isRejection, readStatus, CHAIN_NAME } from "./wallet.js";
import { failureText, bridgeOutcome, timeText, plainError, fmtUnits, esc } from "./deposit-text.js";

export const DEPOSIT_RECEIPT_MS = 15 * 60_000;
export const STATUS_EVERY_MS = 10_000, STATUS_MAX_MS = 30 * 60_000; // bridges take seconds to tens of minutes
const STATUS = "https://li.quest/v1/status";
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

const txLinkHtml = (hash, chainId) => {
  const link = explorerTx(chainId, hash);
  return link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">View transaction ↗</a>` : "";
};

export async function runDeposit({ wallet, chain, quotes, status, pay: P, vaultChainId, vaultToken, units, from, set, sleep = realSleep, log = console }) {
  const hex = "0x" + P.chainId.toString(16), cross = P.chainId !== vaultChainId;
  const ctx = { approved: false, sent: null };
  let msg = null;
  const update = (patch) => { if ("msg" in patch) msg = patch.msg; set(patch); };
  const req = (method, params) => wallet.request({ method, params });
  update({ msg: null, twoSteps: false, hash: null, lastTx: null });
  // before every signature: still the same account, still on the pay chain
  const guard = async () => {
    if (wallet.account() !== from) throw plainError(`The account changed in your wallet, so nothing more was sent.${ctx.approved ? " The approval went through." : ""}`);
    if (!sameChain(await req("eth_chainId"), P.chainId)) throw plainError(`Your wallet is not on ${CHAIN_NAME[P.chainId]}. Switch it to ${CHAIN_NAME[P.chainId]}, then try again. Nothing more was sent.`);
  };
  const fresh = async () => { const r = await quotes.fresh(units, from, P); update({ quote: r.quote }); return r; };
  try {
    update({ phase: "quoting" });
    let { raw, spender, tx } = await fresh(); // always fresh before signing
    if (!sameChain(await req("eth_chainId"), P.chainId)) await chain.switchTo(P.chainId);
    await guard(); // some wallets accept the switch request without switching
    if (spender) {
      const allowance = await chain.read(P.chainId, "eth_call", [{ to: P.address, data: callAllowance(from, spender) }, "latest"]);
      if (needsApproval(allowance, units)) {
        update({ twoSteps: true });
        const approve = async (amount) => {
          update({ phase: "approve" });
          await guard();
          const ah = await req("eth_sendTransaction", [{ from, to: P.address, data: callApprove(spender, amount), chainId: hex }]);
          update({ phase: "approving" });
          let ok;
          try { ok = await chain.receipt(P.chainId, ah); }
          catch (e) { if (e.name === "TimeoutError") throw Object.assign(plainError(`The approval is still not confirmed. It may still go through, so check it before pressing Deposit again.${txLinkHtml(ah, P.chainId)}`), { sticky: true }); throw e; }
          if (!ok) throw plainError(`The approval failed on chain. Nothing was deposited.${txLinkHtml(ah, P.chainId)}`);
        };
        if (mustResetFirst(P.chainId, P.address, allowance)) await approve(0n); // USDT: back to 0 first
        await approve(units);
        ctx.approved = true;
        update({ phase: "quoting" });
        ({ raw, tx } = await fresh()); // the approval took a while: sign today's price
      }
    }
    update({ phase: "confirm" });
    await guard();
    const hash = await req("eth_sendTransaction", [tx]);
    const link = txLinkHtml(hash, P.chainId);
    ctx.sent = `${fmtUnits(units, P.decimals)} ${P.symbol}`;
    update({ hash, sent: ctx.sent, phase: "depositing", lastTx: `Your last deposit:${link}`, msg: { kind: "", html: `Sent.${link}` } });
    let ok;
    try { ok = await chain.receipt(P.chainId, hash, { maxMs: DEPOSIT_RECEIPT_MS }); }
    catch (e) {
      if (e.name !== "TimeoutError") throw e;
      const html = `Not confirmed after 15 minutes. It may still go through: check the transaction before depositing again.${link}`;
      update({ phase: "unknown", msg: { kind: "warn", html }, lastTx: html });
      return;
    }
    if (!ok) update({ phase: "failed", msg: { kind: "warn", html: `The deposit failed on chain. Your ${esc(P.symbol)} stayed in your wallet; only the network fee was spent.${link}` } });
    else if (!cross) update({ phase: "done", msg: { kind: "ok", html: `Deposited ${esc(ctx.sent)}.${link}` } });
    else {
      const eta = timeText(raw.estimate?.executionDuration);
      update({ phase: "bridging", msg: { kind: "", html: `Sent from ${esc(CHAIN_NAME[P.chainId])}. ${eta === "time unknown" ? "Bridging can take a few minutes" : `LI.FI expects ${esc(eta)}`}; you can leave this panel open or closed.${link}` } });
      await followBridge({ hash, raw, status, sleep, log, update,
        ctx: { sent: ctx.sent, sym: P.symbol, fromChainId: P.chainId, toChainId: vaultChainId, sourceLink: link, vaultToken, hash } });
      if (msg?.kind === "warn") update({ lastTx: msg.html }); // where the money is stays visible after typing a new amount
    }
  } catch (e) {
    const html = failureText(e, ctx);
    update({ phase: "failed", msg: { kind: "warn", html }, ...(e.sticky ? { lastTx: html } : {}) }); // e.g. an approval that may still confirm
    if (!e.plain && !isRejection(e)) log.warn("deposit failed:", e);
  }
}

// LI.FI's /status until the bridge and the deposit are done (or 30 minutes). A failed read is
// retried and logged once; the source transaction already succeeded.
async function followBridge({ hash, raw, ctx, status, sleep, log, update }) {
  const u = new URL(STATUS);
  for (const [k, v] of Object.entries({ txHash: hash, fromChain: ctx.fromChainId, toChain: ctx.toChainId, bridge: raw.tool }))
    if (v != null && v !== "") u.searchParams.set(k, v); // an empty bridge would make LI.FI answer 400 every time
  const scan = ` <a href="https://scan.li.fi/tx/${esc(hash)}" target="_blank" rel="noopener">Track on LI.FI ↗</a>`;
  let logged = false, failedReads = 0;
  for (let t = 0; t < STATUS_MAX_MS; t += STATUS_EVERY_MS) {
    await sleep(STATUS_EVERY_MS);
    let j = null;
    try { j = await status(u.toString()); }
    catch (e) { if (!logged) { logged = true; log.warn("bridge status read failed (retrying)", e); } }
    failedReads = j ? 0 : failedReads + 1;
    if (failedReads === 3) update({ msg: { kind: "warn", html: `The bridge status can't be read right now; still trying. You can follow it on LI.FI.${ctx.sourceLink}${scan}` } });
    const out = bridgeOutcome(j, ctx);
    if (!out) {
      const step = readStatus(j).message;
      if (step) update({ msg: { kind: "", html: `${esc(step)}.${ctx.sourceLink}` } });
      continue;
    }
    update({ phase: out.phase, msg: { kind: out.kind, html: out.html } });
    return;
  }
  update({ phase: "unknown", msg: { kind: "warn", html: `The bridge is still not finished after 30 minutes. It may still arrive: check it before depositing again.${ctx.sourceLink}${scan}` } });
}
