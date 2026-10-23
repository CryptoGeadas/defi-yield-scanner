// Deposit panel (#39) — loaded by app.js the first time a Deposit button is pressed, so the
// page itself stays as light as before. It asks LI.FI's public quote API what the amount
// buys in this vault (the build already matched the row to the vault: row.deposit), and
// with a browser wallet (#42) runs approve → deposit → LI.FI status → done.
// Per-pool state lives here, not in the DOM: app.js re-renders the rows on every sort or
// filter, and a deposit that is running must survive that.

import { discoverWallets, safeIcon, callBalanceOf, callAllowance, callApprove, needsApproval, mustResetFirst, sameChain, buildDepositTx, explorerTx, shortAddr, isRejection, readChain, waitForReceipt } from "./wallet.js";

const QUOTE = "https://li.quest/v1/quote";
const INTEGRATOR = "defi-yield-scanner"; // shows up in LI.FI's analytics; no fee is charged
const PREVIEW_ADDR = "0x000000000000000000000000000000000000dEaD"; // a quote needs a sender
const DEBOUNCE_MS = 600;
const TIMEOUT_MS = 20_000; // LI.FI can take 15 s+ on a cold route; past this, say so instead of waiting forever
const CHAIN_NAME = { 1: "Ethereum", 8453: "Base", 42161: "Arbitrum", 10: "Optimism", 137: "Polygon" };

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
const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 });
const fmtUnits = (units, decimals) => fmt(Number(units) / 10 ** decimals);

// ── state ────────────────────────────────────────────────────────────────────
// wallet: the connected wallet, shared by every panel. pools: poolId → panel state.
// phase: idle | quoting | approve | approving | confirm | depositing | done | failed | unknown
const W = { list: null, picking: false, wallet: null, account: null };
const pools = new Map();
const poolState = (id) => {
  if (!pools.has(id)) pools.set(id, { amount: "", quote: null, quoteMsg: null, phase: "idle", twoSteps: false, msg: null, hash: null, sent: null, lastTx: null, balance: null, balanceFailed: false });
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
};

// Mounts the panel for one row into `slot`. Returns unmount(), which stops any pending quote
// (a deposit already sent keeps going and shows again when the panel is mounted again).
// focus: true only when the user pressed Deposit, never when a re-render mounts it again.
export function mountDeposit(slot, row, { focus = false } = {}) {
  const d = row.deposit, sym = d.underlying.symbol, id = `dep-amt-${row.poolId}`, s = poolState(row.poolId);
  let timer = null, ctl = null;

  slot.innerHTML = `<div class="dcard wide dep-card">
      <div class="dhead"><span class="dk">Deposit</span><span class="dep-into">into ${esc(row.symbol)} on ${esc(row.chain)}</span></div>
      <div class="dep-cols">
        <div class="dep-pay">
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
  const input = $("input");
  const busy = () => BUSY[s.phase] != null;
  // steps that finish later (quote, approval, status) draw whichever panel shows this pool now
  const draw = () => (view?.s === s ? view.paint() : paint());

  function paint() {
    if (!slot.isConnected) return;
    input.disabled = busy();
    // You get
    const a = parseAmount(s.amount, d.underlying.decimals);
    $(".dep-get").innerHTML = `<span class="dep-lbl">You get</span>` + (
      s.quote ? `<div class="dep-big">${fmt(s.quote.read.amount)} <small>${esc(s.quote.read.symbol)}</small></div>` + (s.quote.read.usd != null ? `<p class="dep-note">worth $${s.quote.read.usd.toFixed(2)}</p>` : "")
      : s.quoteMsg ? `<p class="dep-note ${s.quoteMsg.warn ? "dep-warn" : ""}">${s.quoteMsg.html}</p>`
      : a.error === "empty" || !s.amount ? `<p class="dep-note">Enter an amount to see what you get</p>`
      : a.error ? `<p class="dep-note dep-warn">${esc(AMOUNT_HELP[a.error](sym, d.underlying.decimals))}</p>`
      : `<p class="dep-note">Getting a quote…</p>`);
    // balance under the amount
    $(".dep-bal").textContent = !W.account ? "" : s.balanceFailed ? "Your balance could not be read right now" : s.balance != null ? `Balance ${s.balance} ${sym}` : "Reading your balance…";
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
    const amountLabel = !a.error ? ` ${fmtUnits(a.units, d.underlying.decimals)} ${sym}` : "";
    if (busy()) act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" disabled>${esc(BUSY[s.phase](s))}</button>`;
    else if (s.phase === "done") act.innerHTML = `<button type="button" class="btn btn-sm" data-act="again">New deposit</button>`;
    else if (!W.account) act.innerHTML = W.picking || (W.list && !W.list.length) ? "" : `<button type="button" class="btn btn-primary btn-sm" data-act="connect">Connect wallet</button>`;
    else act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" data-act="deposit" ${s.quote ? "" : "disabled"}>Deposit${esc(amountLabel)}</button>`;
    // what happened
    $(".dep-msg").innerHTML = s.msg ? `<span class="${s.msg.kind === "ok" ? "dep-ok" : s.msg.kind === "warn" ? "dep-warn" : ""}">${s.msg.html}</span>` : "";
  }

  // ── quotes ──
  const stopQuote = () => { clearTimeout(timer); ctl?.abort(); ctl = null; };

  async function fetchQuote(units, signal) {
    const u = new URL(QUOTE);
    for (const [k, v] of Object.entries({
      fromChain: d.chainId, toChain: d.chainId, fromToken: d.underlying.address, toToken: d.token,
      fromAmount: units.toString(), fromAddress: W.account || PREVIEW_ADDR, integrator: INTEGRATOR,
    })) u.searchParams.set(k, v);
    const r = await fetch(u, { signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* handled below */ }
    if (!r.ok) {
      console.warn(`deposit quote: HTTP ${r.status}`, j?.message ?? text.slice(0, 200));
      throw new Error(r.status === 429 ? "too many quotes from this connection. Wait a few minutes, then try again" : j?.message || `no route (HTTP ${r.status})`);
    }
    return { raw: j, read: readQuote(j, d), units, at: Date.now() };
  }

  async function quote(units) {
    const mine = (ctl = new AbortController());
    // AbortSignal.any is missing in older Safari / wallet browsers: time out by hand
    const late = setTimeout(() => mine.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
    // a newer quote or a closed panel aborts this one; its late answer must not show
    const stale = () => mine.signal.aborted && mine.signal.reason?.name !== "TimeoutError";
    try {
      const q = await fetchQuote(units, mine.signal);
      if (stale()) return;
      s.quote = q; s.quoteMsg = null;
    } catch (e) {
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
    // a finished deposit's link stays until the next deposit starts
    if (["done", "failed", "unknown"].includes(s.phase)) { s.phase = "idle"; s.msg = s.lastTx ? { kind: "", html: s.lastTx } : null; }
    const a = parseAmount(s.amount, d.underlying.decimals);
    draw();
    if (!a.error) timer = setTimeout(() => quote(a.units), DEBOUNCE_MS);
  }

  // ── wallet ──
  async function readBalance() {
    if (!W.account) return;
    try {
      const raw = await readChain(d.chainId, "eth_call", [{ to: d.underlying.address, data: callBalanceOf(W.account) }, "latest"]);
      s.balance = fmtUnits(BigInt(raw), d.underlying.decimals); s.balanceFailed = false;
    } catch (e) {
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
  async function freshTx(units, from) {
    const c = new AbortController(), late = setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
    try {
      const q = await fetchQuote(units, c.signal);
      s.quote = q; s.quoteMsg = null;
      return buildDepositTx(q.raw, { from, chainId: d.chainId, units, payToken: d.underlying.address, vaultToken: d.token });
    } catch (e) {
      if (c.signal.reason?.name === "TimeoutError") throw plainError("LI.FI took too long to answer, so nothing was signed. Try again.");
      throw e;
    } finally { clearTimeout(late); }
  }

  // ── deposit (same chain): fresh quote → right chain → approve if needed → (re-quote
  // after a slow approval) → deposit → its receipt. Same-chain routes are one atomic
  // transaction, so its receipt is the answer; LI.FI's /status is for bridges (#43).
  async function deposit() {
    const a = parseAmount(s.amount, d.underlying.decimals);
    if (a.error || !W.account) return;
    stopQuote();
    const p = W.wallet.provider, from = W.account, hex = "0x" + d.chainId.toString(16);
    const ctx = { approved: false, sent: null };
    s.msg = null; s.twoSteps = false; s.hash = null; s.lastTx = null;
    // before every signature: still the same account, still on the vault's chain
    const guard = async () => {
      if (W.account !== from) throw plainError(`The account changed in your wallet, so nothing more was sent.${ctx.approved ? " The approval went through." : ""}`);
      if (!sameChain(await p.request({ method: "eth_chainId" }), d.chainId)) throw plainError(`Your wallet is not on ${CHAIN_NAME[d.chainId]}. Switch it to ${CHAIN_NAME[d.chainId]}, then try again. Nothing more was sent.`);
    };
    try {
      s.phase = "quoting"; draw();
      let { spender, tx } = await freshTx(a.units, from); // always fresh before signing
      if (!sameChain(await p.request({ method: "eth_chainId" }), d.chainId)) await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
      await guard(); // some wallets accept the switch request without switching
      if (spender) {
        const allowance = await readChain(d.chainId, "eth_call", [{ to: d.underlying.address, data: callAllowance(from, spender) }, "latest"]);
        if (needsApproval(allowance, a.units)) {
          s.twoSteps = true;
          const approve = async (amount) => {
            s.phase = "approve"; draw();
            await guard();
            const ah = await p.request({ method: "eth_sendTransaction", params: [{ from, to: d.underlying.address, data: callApprove(spender, amount), chainId: hex }] });
            s.phase = "approving"; draw();
            let ok;
            try { ok = await waitForReceipt(d.chainId, ah); }
            catch (e) { if (e.name === "TimeoutError") throw plainError(`The approval is still not confirmed. It may still go through, so check it before pressing Deposit again.${txLinkHtml(ah)}`); throw e; }
            if (!ok) throw plainError(`The approval failed on chain. Nothing was deposited.${txLinkHtml(ah)}`);
          };
          if (mustResetFirst(d.chainId, d.underlying.address, allowance)) await approve(0n); // USDT: back to 0 first
          await approve(a.units);
          ctx.approved = true;
          s.phase = "quoting"; draw();
          ({ tx } = await freshTx(a.units, from)); // the approval took a while: sign today's price
        }
      }
      s.phase = "confirm"; draw();
      await guard();
      const hash = await p.request({ method: "eth_sendTransaction", params: [tx] });
      s.hash = hash; ctx.sent = s.sent = `${fmtUnits(a.units, d.underlying.decimals)} ${sym}`; s.phase = "depositing";
      s.lastTx = `Your last deposit:${txLinkHtml(hash)}`;
      s.msg = { kind: "", html: `Sent.${txLinkHtml(hash)}` };
      draw();
      let ok;
      try { ok = await waitForReceipt(d.chainId, hash, { maxMs: 15 * 60_000 }); }
      catch (e) {
        if (e.name !== "TimeoutError") throw e;
        s.phase = "unknown";
        s.msg = { kind: "warn", html: `Not confirmed after 15 minutes. It may still go through: check the transaction before depositing again.${txLinkHtml(hash)}` };
        return draw();
      }
      s.phase = ok ? "done" : "failed";
      s.msg = ok ? { kind: "ok", html: `Deposited ${esc(ctx.sent)}.${txLinkHtml(hash)}` }
        : { kind: "warn", html: `The deposit failed on chain. Your ${esc(sym)} stayed in your wallet; only the network fee was spent.${txLinkHtml(hash)}` };
      readBalance();
      draw();
    } catch (e) {
      s.phase = "failed";
      s.msg = { kind: "warn", html: failureText(e, ctx) };
      if (!e.plain && !isRejection(e)) console.warn("deposit failed:", e);
      draw();
    }
  }
  const txLinkHtml = (hash) => {
    const link = explorerTx(d.chainId, hash);
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
    else if (act === "again") { s.phase = "idle"; s.hash = null; requote(); }
  });
  input.value = s.amount;
  input.addEventListener("input", () => { s.amount = input.value; requote(); });

  view = { slot, row, s, paint, refresh: () => { s.balance = null; readBalance(); requote(); } };
  if (busy() || ["done", "failed", "unknown"].includes(s.phase)) draw(); // a deposit in progress: show it, don't re-quote
  else requote();
  if (W.account && s.balance == null) readBalance();
  if (focus && !busy()) input.focus();
  return () => { stopQuote(); if (view?.slot === slot) view = null; };
}
