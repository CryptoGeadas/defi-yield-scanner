// Deposit panel (#39) — loaded by app.js the first time a Deposit button is pressed, so the
// page itself stays as light as before. It asks LI.FI's public quote API what the amount
// buys in this vault (the build already matched the row to the vault: row.deposit), and
// with a browser wallet (#42) runs approve → deposit → LI.FI status → done.
// Per-pool state lives here, not in the DOM: app.js re-renders the rows on every sort or
// filter, and a deposit that is running must survive that.

import { discoverWallets, safeIcon, callBalanceOf, sameChain, buildDepositTx, shortAddr, isRejection, readChain, waitForReceipt, resolvePayTokens, CHAIN_NAME, PAY_CHAINS, explorerAddress, addChainParams } from "./wallet.js";
import { esc, parseAmount, AMOUNT_HELP, readQuote, plainError, failureText, timeText, quoteFacts, fmt, fmtUnits } from "./deposit-text.js";
import { runDeposit, statusReader } from "./deposit-flow.js";
export { parseAmount, readQuote, failureText, bridgeOutcome, timeText, quoteFacts } from "./deposit-text.js";

const QUOTE = "https://li.quest/v1/quote";
const INTEGRATOR = "defi-yield-scanner"; // shows up in LI.FI's analytics; no fee is charged
const PREVIEW_ADDR = "0x000000000000000000000000000000000000dEaD"; // a quote needs a sender
const DEBOUNCE_MS = 600;
const TIMEOUT_MS = 20_000; // LI.FI can take 15 s+ on a cold route; past this, say so instead of waiting forever
const QUOTE_OLD_MS = 60_000; // past this the quote is marked old; it is never refreshed by itself
const INSTALL = '<a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> or <a href="https://rabby.io/" target="_blank" rel="noopener">Rabby</a>';
const DISCLAIMER = 'Not financial advice. You sign in your own wallet. Funds go straight to the vault through LI.FI; this site never holds them. <a href="./methodology.html#deposits">How deposits work</a>';


// ── state ────────────────────────────────────────────────────────────────────
// wallet: the connected wallet, shared by every panel. pools: poolId → panel state.
// phase: idle | quoting | approve | approving | confirm | depositing | bridging | done | failed | unknown
// fromChain: the chain the user pays on (null = the vault's chain); payTokens: chainId →
// the same coin on that chain | null, from LI.FI's token list (resolvePayTokens).
const W = { list: null, picking: false, wallet: null, account: null, chainId: null };
const pools = new Map();
const poolState = (id) => {
  if (!pools.has(id)) pools.set(id, { amount: "", quote: null, quoteMsg: null, phase: "idle", twoSteps: false, msg: null, hash: null, sent: null, lastTx: null, balance: null, balanceFailed: false, fromChain: null, payTokens: null });
  return pools.get(id);
};
let view = null; // the mounted panel: { slot, row, s, paint, refresh }
// A wallet can announce itself after the first look (slow extension, unlocked later): add
// it and redraw, so "No browser wallet found" never sticks. Listens once per page.
let lateListening = false;
function listenForLateWallets() {
  if (lateListening) return;
  lateListening = true;
  addEventListener("eip6963:announceProvider", (e) => {
    const w = e.detail;
    if (!w?.provider || !w.info?.uuid || !w.info?.name || !W.list || W.list.some((x) => x.info.uuid === w.info.uuid)) return;
    W.list = W.list.filter((x) => x.info.uuid !== "injected").concat(w);
    view?.paint();
  });
}
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
// A refused cross-chain quote the panel can route around (#43, #49): the bridge to leave
// out of the next quote, or null (same chain, no bridge named, or another refusal).
export function bridgeToAvoid(e, raw, payChainId, vaultChainId) {
  if (!(e?.needsGas || e?.otherRoute) || payChainId === vaultChainId) return null;
  return typeof raw?.tool === "string" && raw.tool ? raw.tool : null;
}

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
      <div class="dhead"><span class="dk">Deposit</span><span class="dep-into">${(() => {
        const url = explorerAddress(d.chainId, d.token);
        const v = `vault ${esc(shortAddr(d.token))}`;
        return `Into ${esc(row.symbol)} on ${esc(row.chain)} · ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Check the vault contract">${v} ↗</a>` : v}`;
      })()}</span></div>
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
        <p class="dep-note dep-disc">${DISCLAIMER}</p>
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
      s.quote ? quoteHtml(s.quote)
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
    else w.innerHTML = W.list && !W.list.length ? `<p class="dep-note">No browser wallet found. Install ${INSTALL} to deposit; quotes still work. <button type="button" class="dep-link" data-act="connect">Look again</button></p>` : "";
    // the one primary button
    const act = $(".dep-act");
    const amountLabel = !a.error && P ? ` ${fmtUnits(a.units, P.decimals)} ${P.symbol}` : "";
    if (busy()) act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" disabled>${esc(BUSY[s.phase](s))}</button>`;
    else if (s.phase === "done") act.innerHTML = `<button type="button" class="btn btn-sm" data-act="again">New deposit</button>`;
    else if (!W.account) act.innerHTML = W.picking || (W.list && !W.list.length) ? "" : `<button type="button" class="btn btn-primary btn-sm" data-act="connect">Connect wallet</button>`;
    else if (P && W.chainId && !sameChain(W.chainId, P.chainId)) act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" data-act="switch">Switch to ${esc(CHAIN_NAME[P.chainId])}</button>`;
    else if (P && !a.error && s.balanceUnits != null && s.balanceFor === `${P.chainId}|${W.account}` && a.units > s.balanceUnits) act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" disabled>Not enough ${esc(P.symbol)}</button>`;
    else act.innerHTML = `<button type="button" class="btn btn-primary btn-sm" data-act="deposit" ${s.quote ? "" : "disabled"}>Deposit${esc(amountLabel)}</button>`;
    // what happened
    $(".dep-msg").innerHTML = s.msg ? `<span class="${s.msg.kind === "ok" ? "dep-ok" : s.msg.kind === "warn" ? "dep-warn" : ""}">${s.msg.html}</span>` : "";
  }

  function quoteHtml(q) {
    const f = quoteFacts(q.raw, { payChainId: q.pay.chainId, vaultChainId: d.chainId });
    const money = (v) => (v == null ? "unknown" : v < 0.01 && v > 0 ? "under $0.01" : `$${v.toFixed(2)}`);
    const row = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
    return `<div class="dep-big">${fmt(q.read.amount)} <small>${esc(q.read.symbol)}</small> <span class="dep-shares">(vault shares)</span></div>`
      + `<p class="dep-note">worth ${q.read.usd != null ? money(q.read.usd) : "unknown"}</p>`
      + `<dl class="dep-facts">`
      + row("Minimum you get", f.minimum != null ? `${fmt(f.minimum)} ${esc(f.symbol)}` : "unknown")
      + row("LI.FI fee", f.feeUsd != null ? `${money(f.feeUsd)}${f.feePct != null ? ` (${f.feePct > 0 && f.feePct < 0.01 ? "under 0.01" : +f.feePct.toFixed(2)}%)` : ""}` : "unknown")
      + (f.otherFeeUsd != null ? row("Bridge and swap fees", money(f.otherFeeUsd)) : "")
      + (f.onTopUsd != null ? row("Paid on top", money(f.onTopUsd)) : "")
      + row("Network fee", money(f.gasUsd))
      + row("Time", esc(f.time))
      + row("Route", esc(f.route))
      + `</dl>`
      + ageHtml(q);
  }
  function ageHtml(q) {
    const age = Math.round((Date.now() - q.at) / 1000);
    return age * 1000 >= QUOTE_OLD_MS
      ? `<p class="dep-note dep-age dep-warn">This quote is over a minute old. <button type="button" class="dep-link" data-act="refresh">Refresh quote</button></p>`
      : `<p class="dep-note dep-age">Quote by LI.FI · ${age} s ago</p>`;
  }

  // ── quotes ──
  const stopQuote = () => { clearTimeout(timer); ctl?.abort(); ctl = null; };

  // A quote the panel can sign: fetched, then run through the signing checks. Bridges pick
  // different routes from one quote to the next; when the route also needs ETH for its fee
  // (which the panel doesn't send), or pays a receiver the page can't check (#49), ask once
  // more without that bridge.
  async function signableQuote(units, signal, P, from) {
    const check = (q) => buildDepositTx(q.raw, { from, chainId: P.chainId, toChainId: d.chainId, units, payToken: P.address, payDecimals: P.decimals, vaultToken: d.token });
    let q = await fetchQuote(units, signal, P);
    try { return { q, built: check(q) }; }
    catch (e) {
      const avoid = bridgeToAvoid(e, q.raw, P.chainId, d.chainId);
      if (!avoid) throw e;
      q = await fetchQuote(units, signal, P, [avoid]);
      return { q, built: check(q) };
    }
  }

  async function fetchQuote(units, signal, P = pay(), denyBridges = []) {
    if (!P) throw new Error(`${sym} is not available on that chain`);
    const u = new URL(QUOTE);
    for (const [k, v] of Object.entries({
      fromChain: P.chainId, toChain: d.chainId, fromToken: P.address, toToken: d.token,
      fromAmount: units.toString(), fromAddress: W.account || PREVIEW_ADDR, toAddress: W.account || PREVIEW_ADDR, integrator: INTEGRATOR,
    })) u.searchParams.set(k, v);
    for (const b of denyBridges) u.searchParams.append("denyBridges", b);
    const r = await fetch(u, { signal });
    const text = await r.text();
    let j = null;
    try { j = JSON.parse(text); } catch { /* handled below */ }
    if (!r.ok) {
      console.warn(`deposit quote: HTTP ${r.status}`, j?.message ?? text.slice(0, 200));
      if (r.status === 429) throw plainError("LI.FI is limiting quotes from this connection right now. Wait a few minutes, then change the amount to try again. The vault itself is fine.");
      if (r.status === 404 || /no (available )?(quotes|routes)/i.test(String(j?.message))) throw plainError("No route for this amount right now. Try another amount, or pay from another chain.");
      throw new Error(j?.message || `no route (HTTP ${r.status})`);
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
      if (!stale() && e.plain) { s.quote = null; s.quoteMsg = { warn: true, html: esc(e.quoteText ?? e.message) }; clearTimeout(late); return draw(); }
      if (stale()) return; // the user typed again or closed the panel
      const timedOut = mine.signal.reason?.name === "TimeoutError";
      if (!timedOut) console.warn("deposit quote failed:", e);
      s.quote = null;
      s.quoteMsg = { warn: true, html: timedOut ? "LI.FI took too long to answer. Change the amount to try again." : e.plain ? esc(e.message) : `No quote: ${esc(e.message)}` };
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
    const P = pay(), acct = W.account;
    if (!acct || !P) return;
    const stale = () => pay()?.chainId !== P.chainId || W.account !== acct; // another chain or account meanwhile
    try {
      const raw = await readChain(P.chainId, "eth_call", [{ to: P.address, data: callBalanceOf(acct) }, "latest"]);
      if (stale()) return;
      s.balanceUnits = BigInt(raw); s.balanceFor = `${P.chainId}|${acct}`; s.balance = fmtUnits(s.balanceUnits, P.decimals); s.balanceFailed = false;
    } catch (e) {
      if (stale()) return; // a read for the chain or account the user just left
      console.warn("deposit: balance read failed", e);
      s.balance = null; s.balanceUnits = null; s.balanceFailed = true;
    }
    draw();
  }

  async function connect(w) {
    W.picking = false;
    try {
      const [account] = await w.provider.request({ method: "eth_requestAccounts" });
      if (!account) throw new Error("the wallet returned no account");
      W.wallet = w; W.account = account; s.msg = null;
      W.chainId = await w.provider.request({ method: "eth_chainId" }).catch(() => null);
      if (!listening.has(w.provider)) {
        listening.add(w.provider);
        w.provider.on?.("accountsChanged", (acc) => onAccounts(w.provider, acc));
        w.provider.on?.("chainChanged", (id) => { if (W.wallet?.provider === w.provider) { W.chainId = id; view?.paint(); } });
      }
      readBalance();
      requote(); // quotes now use the real sender
    } catch (e) {
      s.msg = { kind: "warn", html: isRejection(e) ? "The wallet did not connect. Nothing was sent." : `The wallet did not connect: ${esc(e.message)}` };
      draw();
    }
  }

  async function onConnectClick() {
    // a fresh look, merged with the wallets already known (one that announced late may not answer again)
    const found = await discoverWallets(), known = (W.list || []).filter((x) => !found.some((f) => f.info.uuid === x.info.uuid));
    W.list = found.some((f) => f.info.uuid !== "injected") ? found.filter((f) => f.info.uuid !== "injected").concat(known) : found.concat(known);
    if (W.list.length === 1) return connect(W.list[0]);
    W.picking = W.list.length > 1;
    draw();
  }

  // Ask the wallet to switch to a chain; when it doesn't know the chain (4902), offer to add it.
  async function switchChain(p, chainId) {
    const hex = "0x" + chainId.toString(16);
    try { await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] }); }
    catch (e) {
      if (!(e?.code === 4902 || e?.data?.originalError?.code === 4902)) throw e;
      const params = addChainParams(chainId);
      if (!params) throw e;
      await p.request({ method: "wallet_addEthereumChain", params: [params] });
    }
    W.chainId = await p.request({ method: "eth_chainId" }).catch(() => W.chainId);
  }

  // A fresh quote for exactly this deposit, checked into the transaction to sign.
  async function freshTx(units, from, P) {
    const c = new AbortController(), late = setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
    try {
      const { q, built } = await signableQuote(units, c.signal, P, from);
      s.quoteMsg = null;
      return { raw: q.raw, ...built, quote: q };
    } catch (e) {
      if (c.signal.reason?.name === "TimeoutError") throw plainError("LI.FI took too long to answer, so nothing was signed. Try again.");
      throw e;
    } finally { clearTimeout(late); }
  }

  // ── deposit: the steps live in deposit-flow.js (#64); the panel hands it the wallet, the
  // chain reads and the quote source, and draws each step the flow reports.
  async function deposit() {
    const P = pay();
    if (!P) return;
    const a = parseAmount(s.amount, P.decimals);
    if (a.error || !W.account) return;
    stopQuote();
    const provider = W.wallet.provider;
    await runDeposit({
      wallet: { request: (r) => provider.request(r), account: () => W.account },
      chain: {
        read: readChain,
        receipt: (chainId, hash, opts) => waitForReceipt(chainId, hash, opts),
        switchTo: (chainId) => switchChain(provider, chainId),
      },
      quotes: { fresh: (units, from, pay) => freshTx(units, from, pay) },
      status: statusReader(),
      pay: P, vaultChainId: d.chainId, vaultToken: d.token, units: a.units, from: W.account,
      set: (patch) => { Object.assign(s, patch); draw(); },
    });
    if (["done", "failed"].includes(s.phase) && s.hash) readBalance(); // the money moved (or the fee was spent)
  }

  slot.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === "connect") onConnectClick();
    else if (act === "pick") connect(W.list[+b.dataset.i]);
    else if (act === "disconnect") { W.account = null; W.wallet = null; W.chainId = null; s.balance = null; s.balanceUnits = null; requote(); }
    else if (act === "deposit") deposit();
    else if (act === "refresh") requote();
    else if (act === "switch") {
      const P = pay();
      b.disabled = true; // a second request while the wallet shows the first one would fail
      switchChain(W.wallet.provider, P.chainId).then(() => { s.msg = null; draw(); }).catch((e) => {
        s.msg = { kind: "warn", html: isRejection(e) ? `Your wallet stayed on its network. Switch to ${esc(CHAIN_NAME[P.chainId])} to deposit.` : `The wallet could not switch: ${esc(e.message)}` };
        draw();
      });
    }
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

  if (W.list == null) discoverWallets().then((list) => { if (W.list == null) W.list = list; draw(); });
  listenForLateWallets();
  // the age line only (so focus elsewhere is kept); never a new quote
  const tick = setInterval(() => { const el = slot.querySelector(".dep-age"); if (s.quote && el && !busy()) el.outerHTML = ageHtml(s.quote); }, 5000);
  view = { slot, row, s, paint, refresh: () => { s.balance = null; s.balanceUnits = null; readBalance(); requote(); } };
  if (busy() || ["done", "failed", "unknown"].includes(s.phase)) draw(); // a deposit in progress: show it, don't re-quote
  else requote();
  if (W.account && s.balance == null) readBalance();
  if (focus) {
    // the whole panel in view on open (on a phone the button would sit below the fold), then the amount
    slot.scrollIntoView({ block: "nearest" });
    if (!busy()) input.focus({ preventScroll: true });
  }
  return () => { stopQuote(); clearInterval(tick); if (view?.slot === slot) view = null; };
}
