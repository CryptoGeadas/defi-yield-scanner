// Deposit panel (#39) — loaded by app.js the first time a Deposit button is pressed, so the
// page itself stays as light as before. It asks LI.FI's public quote API what the amount
// buys in this vault (the build already matched the row to the vault: row.deposit), and
// with a browser wallet (#42) runs approve → deposit → LI.FI status → done.
// Per-pool state lives here, not in the DOM: app.js re-renders the rows on every sort or
// filter, and a deposit that is running must survive that.

import { discoverWallets, safeIcon, callBalanceOf, callAllowance, callApprove, needsApproval, mustResetFirst, sameChain, buildDepositTx, explorerTx, shortAddr, isRejection, readChain, waitForReceipt, readStatus, resolvePayTokens, CHAIN_NAME, PAY_CHAINS } from "./wallet.js";

const QUOTE = "https://li.quest/v1/quote";
const INTEGRATOR = "defi-yield-scanner"; // shows up in LI.FI's analytics; no fee is charged
const PREVIEW_ADDR = "0x000000000000000000000000000000000000dEaD"; // a quote needs a sender
const DEBOUNCE_MS = 600;
const STATUS = "https://li.quest/v1/status";
const STATUS_EVERY_MS = 10_000, STATUS_MAX_MS = 30 * 60_000; // bridges take seconds to tens of minutes
const TIMEOUT_MS = 20_000; // LI.FI can take 15 s+ on a cold route; past this, say so instead of waiting forever

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
const AMOUNT_HELP = {
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
const plainError = (html) => Object.assign(new Error(html), { plain: true }); // a message already written for the user (may hold a link)

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
  const recvUrl = typeof got.txLink === "string" && /^https:\/\//.test(got.txLink) ? got.txLink : null;
  const recvLink = recvUrl ? ` <a href="${esc(recvUrl)}" target="_blank" rel="noopener">View on ${esc(gotChain ?? to)} ↗</a>` : "";
  const scan = /^0x[0-9a-f]{64}$/i.test(String(hash)) ? ` <a href="https://scan.li.fi/tx/${esc(hash)}" target="_blank" rel="noopener">Track on LI.FI ↗</a>` : "";
  const check = { phase: "unknown", kind: "warn", html: `Finished, but LI.FI reports a result this page doesn't know. Check where your ${esc(sym)} is before depositing again.${sourceLink}${recvLink}${scan}` };
  if (st.phase === "done") {
    const wrongChain = got.chainId != null && Number(got.chainId) !== Number(toChainId);
    const wrongToken = vaultToken && got.token?.address && String(got.token.address).toLowerCase() !== String(vaultToken).toLowerCase();
    if (wrongChain || wrongToken) return check;
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
const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 });
const fmtUnits = (units, decimals) => fmt(Number(units) / 10 ** decimals);

// ── state ────────────────────────────────────────────────────────────────────
// wallet: the connected wallet, shared by every panel. pools: poolId → panel state.
// phase: idle | quoting | approve | approving | confirm | depositing | bridging | done | failed | unknown
// fromChain: the chain the user pays on (null = the vault's chain); payTokens: chainId →
// the same coin on that chain | null, from LI.FI's token list (resolvePayTokens).
const W = { list: null, picking: false, wallet: null, account: null };
const pools = new Map();
const poolState = (id) => {
  if (!pools.has(id)) pools.set(id, { amount: "", quote: null, quoteMsg: null, phase: "idle", twoSteps: false, msg: null, hash: null, sent: null, lastTx: null, balance: null, balanceFailed: false, fromChain: null, payTokens: null });
  return pools.get(id);
};
let view = null; // the mounted panel: { slot, row, s, paint, refresh }
const listening = new WeakSet(); // providers we already follow for account changes

// The user switched or locked the account in the wallet: follow it, never deposit from
// an address the panel no longer shows.
function onAccounts(provider, accounts) {
  if (W.wallet?.provider !== provider) return;
  W.account = accounts?.[0] ?? null;
  if (!W.account) W.wallet = null;
  for (const st of pools.values()) st.balance = null;
  if (view && BUSY[view.s.phase] == null) view.refresh();
  else view?.paint();
}

const BUSY = {
  quoting: () => "Getting a fresh quote…",
  approve: () => "Approve in your wallet (step 1 of 2)…",
  approving: () => "Waiting for the approval (step 1 of 2)…",
  confirm: (s) => (s.twoSteps ? "Confirm the deposit in your wallet (step 2 of 2)…" : "Confirm the deposit in your wallet…"),
  depositing: () => "Depositing…",
  bridging: (s) => `Bridging to ${CHAIN_NAME[s.toChainId]}, then depositing…`,
};

// Mounts the panel for one row into `slot`. Returns unmount(), which stops any pending quote
// (a deposit already sent keeps going and shows again when the panel is mounted again).
// focus: true only when the user pressed Deposit, never when a re-render mounts it again.
export function mountDeposit(slot, row, { focus = false } = {}) {
  const d = row.deposit, sym = d.underlying.symbol, id = `dep-amt-${row.poolId}`, s = poolState(row.poolId);
  let timer = null, ctl = null;
  s.toChainId = d.chainId;
  // the token the user pays with now: the vault's own coin, on the chosen chain
  const pay = () => {
    const c = s.fromChain ?? d.chainId;
    const t = c === d.chainId ? d.underlying : s.payTokens?.get(c);
    return t ? { chainId: c, address: t.address.toLowerCase(), symbol: t.symbol, decimals: t.decimals } : null;
  };
  const chainOrder = [d.chainId, ...PAY_CHAINS.filter((c) => c !== d.chainId)];

  slot.innerHTML = `<div class="dcard wide dep-card">
      <div class="dhead"><span class="dk">Deposit</span><span class="dep-into">into ${esc(row.symbol)} on ${esc(row.chain)}</span></div>
      <div class="dep-cols">
        <div class="dep-pay">
          <fieldset class="dep-from"><legend class="dep-lbl">Pay with ${esc(sym)} on</legend><div class="dep-chains">${chainOrder.map((c) =>
            `<label class="cchip dep-chip"><input type="radio" name="dep-from-${esc(row.poolId)}" value="${c}"><img class="chic" src="./assets/logos/chains/${CHAIN_NAME[c].toLowerCase()}.webp" alt="" onerror="this.remove()"><span>${CHAIN_NAME[c]}</span></label>`).join("")}</div></fieldset>
          <label class="dep-lbl" for="${esc(id)}">You pay</label>
          <div class="dep-amt"><input id="${esc(id)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.00"><span class="dep-unit">${esc(sym)}</span></div>
          <p class="dep-note dep-bal"></p>
        </div>
        <div class="dep-get" aria-live="polite"></div>
      </div>
      <div class="dep-foot">
        <div class="dep-wallet"></div>
        <div class="dep-act"></div>
        <p class="dep-msg" role="status" aria-live="polite"></p>
      </div>
    </div>`;
  const $ = (sel) => slot.querySelector(sel);
  const input = $(".dep-amt input"); // the amount field (the chain picker has inputs too)
  const busy = () => BUSY[s.phase] != null;
  // steps that finish later (quote, approval, status) draw whichever panel shows this pool now
  const draw = () => (view?.s === s ? view.paint() : paint());

  function paint() {
    if (!slot.isConnected) return;
    input.disabled = busy();
    const P = pay();
    for (const r of slot.querySelectorAll(".dep-chains input")) {
      const c = +r.value, known = c === d.chainId || s.payTokens?.has(c), avail = c === d.chainId || s.payTokens?.get(c);
      r.checked = c === (s.fromChain ?? d.chainId);
      r.disabled = busy() || !avail;
      r.closest("label").classList.toggle("on", r.checked);
      r.closest("label").title = avail ? "" : known ? `${sym} is not on ${CHAIN_NAME[c]} at LI.FI` : s.payTokensChecked ? "Couldn't check this chain right now. Close and open the panel to try again." : "Checking…";
    }
    $(".dep-unit").textContent = P?.symbol ?? sym;
    // You get
    const a = parseAmount(s.amount, P?.decimals ?? d.underlying.decimals);
    $(".dep-get").innerHTML = `<span class="dep-lbl">You get</span>` + (
      s.quote ? `<div class="dep-big">${fmt(s.quote.read.amount)} <small>${esc(s.quote.read.symbol)}</small></div>` + (s.quote.read.usd != null ? `<p class="dep-note">worth $${s.quote.read.usd.toFixed(2)}</p>` : "")
        + (P && P.chainId !== d.chainId ? `<p class="dep-note">${esc(timeText(s.quote.raw.estimate?.executionDuration))}, bridging from ${esc(CHAIN_NAME[P.chainId])}</p>` : "")
      : s.quoteMsg ? `<p class="dep-note ${s.quoteMsg.warn ? "dep-warn" : ""}">${s.quoteMsg.html}</p>`
      : a.error === "empty" || !s.amount ? `<p class="dep-note">Enter an amount to see what you get</p>`
      : a.error ? `<p class="dep-note dep-warn">${esc(AMOUNT_HELP[a.error](P?.symbol ?? sym, P?.decimals ?? d.underlying.decimals))}</p>`
      : `<p class="dep-note">Getting a quote…</p>`);
    // balance under the amount
    $(".dep-bal").textContent = !W.account ? "" : s.balanceFailed ? "Your balance could not be read right now" : s.balance != null ? `Balance ${s.balance} ${P?.symbol ?? sym} on ${CHAIN_NAME[P?.chainId ?? d.chainId]}` : "Reading your balance…";
    // wallet line: connected address, or the picker when several wallets are installed
    const w = $(".dep-wallet");
    if (W.account) w.innerHTML = `<span class="dep-acct">${esc(W.wallet.info.name)} · ${esc(shortAddr(W.account))}</span> <button type="button" class="dep-link" data-act="disconnect" ${busy() ? "disabled" : ""}>Disconnect</button>`;
    else if (W.picking) w.innerHTML = `<p class="dep-lbl">Choose a wallet</p><div class="dep-pick">${W.list.map((x, i) => {
      const icon = safeIcon(x.info.icon);
      return `<button type="button" class="btn btn-sm dep-wbtn" data-act="pick" data-i="${i}">${icon ? `<img src="${esc(icon)}" alt="" width="18" height="18">` : ""}${esc(x.info.name)}</button>`;
    }).join("")}</div>`;
    else w.innerHTML = W.list && !W.list.length ? `<p class="dep-note">No browser wallet found. Quotes still work.</p>` : "";
    // the one primary button
    const act = $(".dep-act");
    const amountLabel = !a.error && P ? ` ${fmtUnits(a.units, P.decimals)} ${P.symbol}` : "";
    if (busy()) act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" disabled>${esc(BUSY[s.phase](s))}</button>`;
    else if (s.phase === "done") act.innerHTML = `<button type="button" class="btn btn-sm" data-act="again">New deposit</button>`;
    else if (!W.account) act.innerHTML = W.picking || (W.list && !W.list.length) ? "" : `<button type="button" class="btn btn-primary btn-sm" data-act="connect">Connect wallet</button>`;
    else act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" data-act="deposit" ${s.quote ? "" : "disabled"}>Deposit${esc(amountLabel)}</button>`;
    // what happened
    $(".dep-msg").innerHTML = s.msg ? `<span class="${s.msg.kind === "ok" ? "dep-ok" : s.msg.kind === "warn" ? "dep-warn" : ""}">${s.msg.html}</span>` : "";
  }

  // ── quotes ──
  const stopQuote = () => { clearTimeout(timer); ctl?.abort(); ctl = null; };

  // A quote the panel can sign: fetched, then run through the signing checks. Bridges pick
  // different routes from one quote to the next; when the route also needs ETH for its fee
  // (which the panel doesn't send), ask once more without that bridge.
  async function signableQuote(units, signal, P, from) {
    const check = (q) => buildDepositTx(q.raw, { from, chainId: P.chainId, toChainId: d.chainId, units, payToken: P.address, payDecimals: P.decimals, vaultToken: d.token });
    let q = await fetchQuote(units, signal, P);
    try { return { q, built: check(q) }; }
    catch (e) {
      if (!e.needsGas || P.chainId === d.chainId || !q.raw?.tool) throw e;
      q = await fetchQuote(units, signal, P, [q.raw.tool]);
      return { q, built: check(q) };
    }
  }

  async function fetchQuote(units, signal, P = pay(), denyBridges = []) {
    if (!P) throw new Error(`${sym} is not available on that chain`);
    const u = new URL(QUOTE);
    for (const [k, v] of Object.entries({
      fromChain: P.chainId, toChain: d.chainId, fromToken: P.address, toToken: d.token,
      fromAmount: units.toString(), fromAddress: W.account || PREVIEW_ADDR, integrator: INTEGRATOR,
    })) u.searchParams.set(k, v);
    for (const b of denyBridges) u.searchParams.append("denyBridges", b);
    const r = await fetch(u, { signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* handled below */ }
    if (!r.ok) {
      console.warn(`deposit quote: HTTP ${r.status}`, j?.message ?? text.slice(0, 200));
      throw new Error(r.status === 429 ? "too many quotes from this connection. Wait a few minutes, then try again" : j?.message || `no route (HTTP ${r.status})`);
    }
    return { raw: j, read: readQuote(j, d), units, pay: P, at: Date.now() };
  }

  async function quote(units) {
    const mine = (ctl = new AbortController());
    // AbortSignal.any is missing in older Safari / wallet browsers: time out by hand
    const late = setTimeout(() => mine.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
    // a newer quote or a closed panel aborts this one; its late answer must not show
    const stale = () => mine.signal.aborted && mine.signal.reason?.name !== "TimeoutError";
    try {
      // the signing checks run now too, so a route the panel would refuse never shows as a quote
      const P = pay();
      const { q } = await signableQuote(units, mine.signal, P, W.account || PREVIEW_ADDR);
      if (stale()) return;
      s.quote = q; s.quoteMsg = null;
    } catch (e) {
      if (!stale() && e.plain) { s.quote = null; s.quoteMsg = { warn: true, html: esc(e.message.replace(", so nothing was signed. Try again.", ".")) }; clearTimeout(late); return draw(); }
      if (stale()) return; // the user typed again or closed the panel
      const timedOut = mine.signal.reason?.name === "TimeoutError";
      if (!timedOut) console.warn("deposit quote failed:", e);
      s.quote = null;
      s.quoteMsg = { warn: true, html: timedOut ? "LI.FI took too long to answer. Change the amount to try again." : `No quote: ${esc(e.message)}` };
    } finally {
      clearTimeout(late);
    }
    draw();
  }

  function requote() {
    stopQuote();
    s.quote = null; s.quoteMsg = null;
    // a finished deposit's link (and, after a bridge problem, where the money is) stays until the next deposit starts
    if (["done", "failed", "unknown"].includes(s.phase)) { s.phase = "idle"; s.msg = s.lastTx ? { kind: "", html: s.lastTx } : null; }
    const P = pay(), a = parseAmount(s.amount, P?.decimals ?? d.underlying.decimals);
    draw();
    if (P && !a.error) timer = setTimeout(() => quote(a.units), DEBOUNCE_MS);
  }

  // ── wallet ──
  async function readBalance() {
    const P = pay();
    if (!W.account || !P) return;
    try {
      const raw = await readChain(P.chainId, "eth_call", [{ to: P.address, data: callBalanceOf(W.account) }, "latest"]);
      if (pay()?.chainId !== P.chainId) return; // the user picked another chain meanwhile
      s.balance = fmtUnits(BigInt(raw), P.decimals); s.balanceFailed = false;
    } catch (e) {
      if (pay()?.chainId !== P.chainId) return; // a read for the chain the user just left
      console.warn("deposit: balance read failed", e);
      s.balance = null; s.balanceFailed = true;
    }
    draw();
  }

  async function connect(w) {
    W.picking = false;
    try {
      const [account] = await w.provider.request({ method: "eth_requestAccounts" });
      if (!account) throw new Error("the wallet returned no account");
      W.wallet = w; W.account = account; s.msg = null;
      if (!listening.has(w.provider)) { listening.add(w.provider); w.provider.on?.("accountsChanged", (acc) => onAccounts(w.provider, acc)); }
      readBalance();
      requote(); // quotes now use the real sender
    } catch (e) {
      s.msg = { kind: "warn", html: isRejection(e) ? "The wallet did not connect. Nothing was sent." : `The wallet did not connect: ${esc(e.message)}` };
      draw();
    }
  }

  async function onConnectClick() {
    W.list = await discoverWallets();
    if (W.list.length === 1) return connect(W.list[0]);
    W.picking = W.list.length > 1;
    draw();
  }

  // A fresh quote for exactly this deposit, checked into the transaction to sign.
  async function freshTx(units, from, P) {
    const c = new AbortController(), late = setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
    try {
      const { q, built } = await signableQuote(units, c.signal, P, from);
      s.quote = q; s.quoteMsg = null;
      return { raw: q.raw, ...built };
    } catch (e) {
      if (c.signal.reason?.name === "TimeoutError") throw plainError("LI.FI took too long to answer, so nothing was signed. Try again.");
      throw e;
    } finally { clearTimeout(late); }
  }

  // ── deposit: fresh quote → wallet on the pay chain → approve if needed → (re-quote after
  // a slow approval) → send → its receipt. Same chain: one atomic transaction, so its
  // receipt is the answer. Another chain: then LI.FI's /status until the bridge and the
  // deposit on the vault's chain are done.
  async function deposit() {
    const P = pay();
    if (!P) return;
    const a = parseAmount(s.amount, P.decimals);
    if (!P || a.error || !W.account) return;
    stopQuote();
    const p = W.wallet.provider, from = W.account, hex = "0x" + P.chainId.toString(16), cross = P.chainId !== d.chainId;
    const ctx = { approved: false, sent: null };
    s.msg = null; s.twoSteps = false; s.hash = null; s.lastTx = null;
    // before every signature: still the same account, still on the vault's chain
    const guard = async () => {
      if (W.account !== from) throw plainError(`The account changed in your wallet, so nothing more was sent.${ctx.approved ? " The approval went through." : ""}`);
      if (!sameChain(await p.request({ method: "eth_chainId" }), P.chainId)) throw plainError(`Your wallet is not on ${CHAIN_NAME[P.chainId]}. Switch it to ${CHAIN_NAME[P.chainId]}, then try again. Nothing more was sent.`);
    };
    try {
      s.phase = "quoting"; draw();
      let { raw, spender, tx } = await freshTx(a.units, from, P); // always fresh before signing
      if (!sameChain(await p.request({ method: "eth_chainId" }), P.chainId)) {
        try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
        catch (e) { if (e?.code === 4902 || e?.data?.originalError?.code === 4902) throw plainError(`Your wallet doesn't have ${CHAIN_NAME[P.chainId]} yet. Add it in your wallet, then try again. Nothing was sent.`); throw e; }
      }
      await guard(); // some wallets accept the switch request without switching
      if (spender) {
        const allowance = await readChain(P.chainId, "eth_call", [{ to: P.address, data: callAllowance(from, spender) }, "latest"]);
        if (needsApproval(allowance, a.units)) {
          s.twoSteps = true;
          const approve = async (amount) => {
            s.phase = "approve"; draw();
            await guard();
            const ah = await p.request({ method: "eth_sendTransaction", params: [{ from, to: P.address, data: callApprove(spender, amount), chainId: hex }] });
            s.phase = "approving"; draw();
            let ok;
            try { ok = await waitForReceipt(P.chainId, ah); }
            catch (e) { if (e.name === "TimeoutError") throw plainError(`The approval is still not confirmed. It may still go through, so check it before pressing Deposit again.${txLinkHtml(ah, P.chainId)}`); throw e; }
            if (!ok) throw plainError(`The approval failed on chain. Nothing was deposited.${txLinkHtml(ah, P.chainId)}`);
          };
          if (mustResetFirst(P.chainId, P.address, allowance)) await approve(0n); // USDT: back to 0 first
          await approve(a.units);
          ctx.approved = true;
          s.phase = "quoting"; draw();
          ({ raw, tx } = await freshTx(a.units, from, P)); // the approval took a while: sign today's price
        }
      }
      s.phase = "confirm"; draw();
      await guard();
      const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
      const link = txLinkHtml(hash, P.chainId);
      s.hash = hash; ctx.sent = s.sent = `${fmtUnits(a.units, P.decimals)} ${P.symbol}`; s.phase = "depositing";
      s.lastTx = `Your last deposit:${link}`;
      s.msg = { kind: "", html: `Sent.${link}` };
      draw();
      let ok;
      try { ok = await waitForReceipt(P.chainId, hash, { maxMs: 15 * 60_000 }); }
      catch (e) {
        if (e.name !== "TimeoutError") throw e;
        s.phase = "unknown";
        s.msg = { kind: "warn", html: `Not confirmed after 15 minutes. It may still go through: check the transaction before depositing again.${link}` };
        return draw();
      }
      if (!ok) {
        s.phase = "failed";
        s.msg = { kind: "warn", html: `The deposit failed on chain. Your ${esc(P.symbol)} stayed in your wallet; only the network fee was spent.${link}` };
      } else if (!cross) {
        s.phase = "done";
        s.msg = { kind: "ok", html: `Deposited ${esc(ctx.sent)}.${link}` };
      } else {
        s.phase = "bridging";
        const eta = timeText(raw.estimate?.executionDuration);
        s.msg = { kind: "", html: `Sent from ${esc(CHAIN_NAME[P.chainId])}. ${eta === "time unknown" ? "Bridging can take a few minutes" : `LI.FI expects ${esc(eta)}`}; you can leave this panel open or closed.${link}` };
        draw();
        await followBridge(hash, raw, { sent: ctx.sent, sym: P.symbol, fromChainId: P.chainId, toChainId: d.chainId, sourceLink: link, vaultToken: d.token, hash });
        if (s.msg?.kind === "warn") s.lastTx = s.msg.html; // where the money is stays visible after typing a new amount
      }
      readBalance();
      draw();
    } catch (e) {
      s.phase = "failed";
      s.msg = { kind: "warn", html: failureText(e, ctx) };
      if (!e.plain && !isRejection(e)) console.warn("deposit failed:", e);
      draw();
    }
  }
  // LI.FI's /status until the bridge and the deposit are done (or 30 minutes). A failed
  // read is retried and logged once; the source transaction already succeeded.
  async function followBridge(hash, raw, ctx) {
    const u = new URL(STATUS);
    for (const [k, v] of Object.entries({ txHash: hash, fromChain: ctx.fromChainId, toChain: ctx.toChainId, bridge: raw.tool }))
      if (v != null && v !== "") u.searchParams.set(k, v); // an empty bridge would make LI.FI answer 400 every time
    const scan = ` <a href="https://scan.li.fi/tx/${esc(hash)}" target="_blank" rel="noopener">Track on LI.FI ↗</a>`;
    let logged = false, failedReads = 0;
    for (let t = 0; t < STATUS_MAX_MS; t += STATUS_EVERY_MS) {
      await new Promise((r) => setTimeout(r, STATUS_EVERY_MS));
      let j = null;
      try {
        const r = await fetch(u);
        j = r.ok || r.status === 404 ? await r.json() : null;
        if (!j && !logged) { logged = true; console.warn(`bridge status: HTTP ${r.status} (retrying)`); }
      } catch (e) { if (!logged) { logged = true; console.warn("bridge status read failed (retrying)", e); } }
      failedReads = j ? 0 : failedReads + 1;
      if (failedReads === 3) { s.msg = { kind: "warn", html: `The bridge status can't be read right now; still trying. You can follow it on LI.FI.${ctx.sourceLink}${scan}` }; draw(); }
      const out = bridgeOutcome(j, ctx);
      if (!out) {
        const step = readStatus(j).message;
        if (step) { s.msg = { kind: "", html: `${esc(step)}.${ctx.sourceLink}` }; draw(); }
        continue;
      }
      s.phase = out.phase; s.msg = { kind: out.kind, html: out.html };
      return;
    }
    s.phase = "unknown";
    s.msg = { kind: "warn", html: `The bridge is still not finished after 30 minutes. It may still arrive: check it before depositing again.${ctx.sourceLink}${scan}` };
  }
  const txLinkHtml = (hash, chainId = d.chainId) => {
    const link = explorerTx(chainId, hash);
    return link ? ` <a href="${esc(link)}" target="_blank" rel="noopener">View transaction ↗</a>` : "";
  };

  slot.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "connect") onConnectClick();
    else if (act === "pick") connect(W.list[+b.dataset.i]);
    else if (act === "disconnect") { W.account = null; W.wallet = null; s.balance = null; requote(); }
    else if (act === "deposit") deposit();
    else if (act === "again") { s.phase = "idle"; s.hash = null; s.msg = s.lastTx ? { kind: "", html: s.lastTx } : null; requote(); }
  });
  input.value = s.amount;
  input.addEventListener("input", () => { s.amount = input.value; requote(); });
  slot.querySelector(".dep-chains").addEventListener("change", (e) => {
    const c = +e.target.value;
    if (!Number.isFinite(c) || busy()) return;
    s.fromChain = c === d.chainId ? null : c;
    s.balance = null; s.balanceFailed = false;
    readBalance();
    requote();
  });
  // failed lookups are not stored, so a later mount asks again
  if (!s.payTokens || PAY_CHAINS.some((c) => !s.payTokens.has(c)))
    resolvePayTokens(d.chainId, d.underlying).then((m) => { s.payTokens = m; s.payTokensChecked = true; draw(); });

  view = { slot, row, s, paint, refresh: () => { s.balance = null; readBalance(); requote(); } };
  if (busy() || ["done", "failed", "unknown"].includes(s.phase)) draw(); // a deposit in progress: show it, don't re-quote
  else requote();
  if (W.account && s.balance == null) readBalance();
  if (focus && !busy()) input.focus();
  return () => { stopQuote(); if (view?.slot === slot) view = null; };
}
