// Deposit panel (#39) — loaded by app.js the first time a Deposit button is pressed, so the
// page itself stays as light as before. It asks LI.FI's public quote API what the amount
// buys in this vault; the build already matched the row to the vault (row.deposit).
// No wallet yet (#42): quotes use a placeholder sender address.

const QUOTE = "https://li.quest/v1/quote";
const INTEGRATOR = "defi-yield-scanner"; // shows up in LI.FI's analytics; no fee is charged
const PREVIEW_ADDR = "0x000000000000000000000000000000000000dEaD"; // a quote needs a sender
const DEBOUNCE_MS = 600;
const TIMEOUT_MS = 20_000; // LI.FI can take 15 s+ on a cold route; past this, say so instead of waiting forever

const amounts = new Map(); // poolId → the amount typed, kept while the page is open
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// What the user typed → { units } (a BigInt in the token's smallest unit) or { error }:
// "empty" | "format" | "decimals" (more digits than the token has) | "zero".
// A comma works as the decimal mark ("1,5"), as people type it in much of Europe.
export function parseAmount(text, decimals) {
  const t = String(text ?? "").trim().replace(",", ".");
  if (!t) return { error: "empty" };
  const m = t.match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) return { error: "format" };
  const frac = m[2] || "";
  if (frac.length > decimals) return { error: "decimals" };
  const units = BigInt((m[1] || "0") + frac.padEnd(decimals, "0"));
  return units > 0n ? { units } : { error: "zero" };
}
const AMOUNT_HELP = {
  format: () => "Use digits and one decimal mark, e.g. 250.5",
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
const fmt = (n) => n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 6 : 2 });

// Mounts the panel for one row into `slot`. Returns unmount(), which stops any pending quote.
// focus: true only when the user pressed Deposit, never when a re-render mounts it again.
export function mountDeposit(slot, row, { focus = false } = {}) {
  const d = row.deposit, sym = d.underlying.symbol, id = `dep-amt-${row.poolId}`;
  let timer = null, ctl = null;

  slot.innerHTML = `<div class="dcard wide dep-card">
      <div class="dhead"><span class="dk">Deposit</span><span class="dep-into">into ${esc(row.symbol)} on ${esc(row.chain)}</span></div>
      <div class="dep-cols">
        <div class="dep-pay">
          <label class="dep-lbl" for="${esc(id)}">You pay</label>
          <div class="dep-amt"><input id="${esc(id)}" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="0.00"><span class="dep-unit">${esc(sym)}</span></div>
        </div>
        <div class="dep-get" aria-live="polite"></div>
      </div>
    </div>`;
  const input = slot.querySelector("input"), out = slot.querySelector(".dep-get");
  const show = (html) => { out.innerHTML = `<span class="dep-lbl">You get</span>${html}`; };
  const stop = () => { clearTimeout(timer); ctl?.abort(); ctl = null; };

  async function quote(units) {
    const mine = (ctl = new AbortController());
    const u = new URL(QUOTE);
    for (const [k, v] of Object.entries({
      fromChain: d.chainId, toChain: d.chainId, fromToken: d.underlying.address, toToken: d.token,
      fromAmount: units.toString(), fromAddress: PREVIEW_ADDR, integrator: INTEGRATOR,
    })) u.searchParams.set(k, v);
    show(`<p class="dep-note">Getting a quote…</p>`);
    // AbortSignal.any is missing in older Safari / wallet browsers: time out by hand
    const late = setTimeout(() => mine.abort(new DOMException("timeout", "TimeoutError")), TIMEOUT_MS);
    // a newer quote or a closed panel aborts this one; its late answer must not show
    const stale = () => mine.signal.aborted && mine.signal.reason?.name !== "TimeoutError";
    try {
      const r = await fetch(u, { signal: mine.signal });
      const text = await r.text();
      if (stale()) return;
      let j = null;
      try { j = JSON.parse(text); } catch { /* handled below */ }
      if (!r.ok) {
        console.warn(`deposit quote: HTTP ${r.status}`, j?.message ?? text.slice(0, 200));
        throw new Error(r.status === 429 ? "too many quotes from this connection. Wait a few minutes, then try again" : j?.message || `no route (HTTP ${r.status})`);
      }
      const q = readQuote(j, d);
      show(`<div class="dep-big">${fmt(q.amount)} <small>${esc(q.symbol)}</small></div>` +
        (q.usd != null ? `<p class="dep-note">worth $${q.usd.toFixed(2)}</p>` : ""));
    } catch (e) {
      if (stale()) return; // the user typed again or closed the panel
      const timedOut = mine.signal.reason?.name === "TimeoutError";
      if (!timedOut) console.warn("deposit quote failed:", e);
      show(`<p class="dep-note dep-warn">${timedOut ? "LI.FI took too long to answer. Change the amount to try again." : `No quote: ${esc(e.message)}`}</p>`);
    } finally {
      clearTimeout(late);
    }
  }

  function onInput() {
    stop();
    amounts.set(row.poolId, input.value);
    const a = parseAmount(input.value, d.underlying.decimals);
    if (a.error === "empty") return show(`<p class="dep-note">Enter an amount to see what you get</p>`);
    if (a.error) return show(`<p class="dep-note dep-warn">${esc(AMOUNT_HELP[a.error](sym, d.underlying.decimals))}</p>`);
    show(`<p class="dep-note">Getting a quote…</p>`); // during the pause too, so an old message never lingers
    timer = setTimeout(() => quote(a.units), DEBOUNCE_MS);
  }

  input.value = amounts.get(row.poolId) ?? "";
  input.addEventListener("input", onInput);
  onInput();
  if (focus) input.focus();
  return stop;
}
