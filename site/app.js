// Static site: read the Action-committed JSON and render the trust-filtered windows.
// No backend. Sort / filter happen client-side over the pre-filtered data.

const TIER = {
  1: { name: "Tier 1 · blue-chip", cls: "t1" },
  2: { name: "Tier 2 · crypto-backed", cls: "t2" },
  3: { name: "Tier 3 · synthetic", cls: "t3" },
};

const COLS = [
  { key: "name", label: "Pool", cls: "" },
  { key: null, label: "Base · reward", cls: "hide-sm" },
  { key: "base", label: "Base APY", cls: "num" },
  { key: "mean30d", label: "30d mean", cls: "num hide-sm" },
  { key: "divRatio", label: "Trend", cls: "center" },
  { key: "tvlUsd", label: "TVL", cls: "num" },
];

const CHAINS = ["Ethereum", "Arbitrum", "Base", "Optimism", "Polygon", "Solana"];
const PAGE = 15; // rows shown per tier before "Load more"
const state = {
  bucket: "all",
  type: "all",
  chains: new Set(CHAINS),
  showKyc: false,
  sortKey: "base",
  sortDir: "desc",
  openId: null,
  limits: { 1: PAGE, 2: PAGE, 3: PAGE },
  data: null,
};
const resetLimits = () => { state.limits = { 1: PAGE, 2: PAGE, 3: PAGE }; };

const $ = (s) => document.querySelector(s);
// HTML-escape any externally-sourced string before it goes into innerHTML/attrs.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
// Only allow http(s) links; anything else (javascript:, data:, malformed) → null.
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const fmtPct = (n) => (n == null ? "—" : `${n.toFixed(2)}%`);
const fmtSigned = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
const fmtTvl = (n) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${Math.round(n / 1e3)}k`;
// divergence compares the current spot APY to the 30-day mean (spot is r.spot;
// for LP pools r.total is the durable mean, so always use r.spot here).
const spotOf = (r) => (r.spot != null ? r.spot : r.total);
const divRatio = (r) => (r.mean30d && r.mean30d !== 0 ? (spotOf(r) - r.mean30d) / r.mean30d : null);
const flagMeta = (r) => {
  const f = r.divFlag;
  if (f === "▲") return { cls: "up", word: "spiking" };
  if (f === "▼") return { cls: "down", word: "decaying" };
  if (f === "●") return { cls: "steady", word: "steady" };
  return { cls: "", word: "no 30d history" };
};

async function load() {
  try {
    const res = await fetch("./data/latest.json", { cache: "no-cache" });
    state.data = await res.json();
  } catch {
    $("#windows").innerHTML = `<p class="empty">No data yet — run the refresh workflow.</p>`;
    return;
  }
  render();
}

function sortVal(r, key) {
  if (key === "name") return `${r.name || r.project} ${r.symbol}`.toLowerCase();
  if (key === "divRatio") return divRatio(r) ?? -Infinity;
  return r[key] ?? -Infinity;
}

const protoLogo = (slug) => `./assets/logos/protocols/${slug}.webp`;
const chainLogo = (chain) => `./assets/logos/chains/${chain.toLowerCase()}.webp`;

function rowsFor(tier) {
  let rows = (state.data.windows[tier] || []).slice();
  if (state.bucket !== "all") rows = rows.filter((r) => r.bucket === state.bucket);
  if (state.type !== "all") rows = rows.filter((r) => r.type === state.type);
  if (state.chains.size < CHAINS.length) rows = rows.filter((r) => state.chains.has(r.chain));
  if (!state.showKyc) rows = rows.filter((r) => r.access !== "permissioned");
  const dir = state.sortDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const va = sortVal(a, state.sortKey), vb = sortVal(b, state.sortKey);
    return va < vb ? -dir : va > vb ? dir : 0;
  });
  return rows;
}

function headerHtml() {
  const cells = COLS.map((c) => {
    if (!c.key) return `<span class="th ${c.cls}">${c.label}</span>`;
    const active = state.sortKey === c.key;
    const caret = active ? (state.sortDir === "asc" ? "▲" : "▼") : "";
    return `<span class="th sortable ${c.cls} ${active ? "active" : ""}" data-sort="${c.key}">${c.label}<span class="caret">${caret}</span></span>`;
  }).join("");
  return `<div class="thead grid"><span></span>${cells}<span></span></div>`;
}

function rowHtml(r, max, tier) {
  const basePct = max > 0 ? (r.base / max) * 100 : 0;
  const rewPct = max > 0 ? (r.reward / max) * 100 : 0;
  const fm = flagMeta(r);
  const ratio = divRatio(r);
  const tip =
    ratio == null
      ? "No 30-day history yet"
      : `Spot ${fmtPct(spotOf(r))} is ${fmtSigned(ratio)} vs 30d mean ${fmtPct(r.mean30d)} → ${fm.word}`;
  const label = r.name || r.project;
  const initial = (String(label)[0] || "?").toUpperCase();
  const logo = `<span class="logo"><span class="mono">${esc(initial)}</span><img class="ic" src="${esc(protoLogo(r.project))}" alt="" loading="lazy" onerror="this.remove()"></span>`;
  const chainIc = `<img class="chic" src="${esc(chainLogo(r.chain))}" alt="" title="${esc(r.chain)}" loading="lazy" onerror="this.remove()">`;
  const lock = r.access === "permissioned" ? `<span class="lock" title="Permissioned — KYC required">🔒</span>` : "";
  const safe = safeUrl(r.url);
  const extTitle = r.linkKind === "defillama" ? "View on DefiLlama" : "Open " + label;
  const ext = safe
    ? `<a class="ext ${esc(r.linkKind)}" href="${esc(safe)}" target="_blank" rel="noopener" title="${esc(extTitle)}">↗</a>`
    : "";
  const open = state.openId === r.poolId;
  return `<div class="row grid ${open ? "open" : ""}" data-id="${esc(r.poolId)}" role="button" tabindex="0" aria-expanded="${open}">
    ${logo}
    <span class="name"><span class="line"><span class="proj">${esc(label)}</span><span class="sym">${esc(r.symbol)}</span>${r.meta ? `<span class="meta">${esc(r.meta)}</span>` : ""}${chainIc}<span class="chain">${esc(r.chain)}</span>${lock}${ext}</span></span>
    <span class="bar hide-sm" title="base ${fmtPct(r.base)} · reward ${fmtPct(r.reward)}"><span class="b" style="width:${basePct}%"></span><span class="r" style="width:${rewPct}%"></span></span>
    <span class="num base">${fmtPct(r.base)}</span>
    <span class="num mean hide-sm">${fmtPct(r.mean30d)}</span>
    <span class="flag ${fm.cls}" data-tip="${esc(tip)}"><span class="g">${r.divFlag}</span></span>
    <span class="tvl">${fmtTvl(r.tvlUsd)}</span>
    <span class="chev" aria-hidden="true">›</span>
  </div>${open ? detailHtml(r, tier) : ""}`;
}

const fmtVol = (n) => (n == null ? null : fmtTvl(n));
const fmtChange = (n) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(2)}pp`);

function detailHtml(r, tier) {
  const ratio = divRatio(r);
  const fm = flagMeta(r);
  const durability =
    ratio == null
      ? "No 30-day history yet — too new to judge durability."
      : `Spot <b>${fmtPct(spotOf(r))}</b> is <b>${fmtSigned(ratio)}</b> versus its 30-day mean of <b>${fmtPct(r.mean30d)}</b> → <b class="${fm.cls}">${fm.word}</b>.`;
  const label = r.name || r.project;
  // true stablecoin legs come from the classification symbol, carried as r.legs;
  // fall back to splitting the display symbol only if the field is absent.
  const legs = Array.isArray(r.legs) ? r.legs : String(r.symbol).split(/[-/+]/).filter(Boolean);
  const rewardLine = r.reward > 0 ? ` · <span class="rew">+${fmtPct(r.reward)} rewards</span>` : "";
  const vol = fmtVol(r.volumeUsd7d);

  const safe = safeUrl(r.url);
  const dllHref = `https://defillama.com/yields/pool/${encodeURIComponent(r.poolId ?? "")}`;
  const actions =
    r.url == null
      ? `<span class="dnote">🔒 Permissioned — KYC required; no public deposit link.</span>`
      : r.linkKind === "defillama"
        ? `<a class="btn btn-primary btn-sm" href="${esc(safe || dllHref)}" target="_blank" rel="noopener">Verify on DefiLlama ↗</a>`
        : `<a class="btn btn-primary btn-sm" href="${esc(safe || dllHref)}" target="_blank" rel="noopener">Open ${esc(label)} ↗</a>
           <a class="btn btn-secondary btn-sm" href="${esc(dllHref)}" target="_blank" rel="noopener">DefiLlama ↗</a>`;

  const composition =
    legs.length > 1
      ? `<div class="dcard wide">
          <div class="dk">Composition</div>
          <div class="dline">${legs.map(esc).join(" + ")} → <b>Tier ${esc(tier ?? "?")}</b>, set by <b>${esc(r.tierDriver || legs[legs.length - 1])}</b> (its riskiest stablecoin leg).</div>
        </div>`
      : "";

  return `<div class="detail">
    <div class="dgrid">
      <div class="dcard">
        <div class="dk">APY</div>
        <div class="dbig">${fmtPct(r.total)}</div>
        <div class="dsub">${r.bucket === "LP" ? `${fmtPct(r.base)} conservative fee APY (lower of current & 30-day avg)` : `${fmtPct(r.base)} organic base${rewardLine}`}</div>
      </div>
      <div class="dcard">
        <div class="dk">Durability</div>
        <div class="dline">${durability}</div>
        <div class="dsub">Change: 7d ${fmtChange(r.apyPct7D)} · 30d ${fmtChange(r.apyPct30D)}</div>
      </div>
      <div class="dcard">
        <div class="dk">Risk</div>
        <div class="dline">Exposure: <b>${esc(r.exposure ?? "—")}</b></div>
        <div class="dsub">Impermanent-loss risk: ${esc(r.ilRisk ?? "—")}</div>
      </div>
      <div class="dcard">
        <div class="dk">Size</div>
        <div class="dline">TVL <b>${fmtTvl(r.tvlUsd)}</b></div>
        <div class="dsub">${vol ? `7d volume ${vol}` : "volume n/a"}</div>
      </div>
      ${composition}
    </div>
    <div class="dactions">${actions}</div>
  </div>`;
}

function windowHtml(tier) {
  const rows = rowsFor(tier);
  // scale bars over the whole filtered set so they don't rescale as you load more
  const max = rows.reduce((m, r) => Math.max(m, r.base + r.reward), 0);
  const limit = state.limits[tier] || PAGE;
  const shown = rows.slice(0, limit);
  const remaining = rows.length - shown.length;
  const t = TIER[tier];
  let body;
  if (!rows.length) {
    body = `<p class="empty">— no pools match —</p>`;
  } else {
    const loadMore =
      remaining > 0
        ? `<button class="loadmore" data-tier="${tier}">Load ${Math.min(PAGE, remaining)} more · ${remaining} left</button>`
        : "";
    body = `${headerHtml()}<div class="rows">${shown.map((r) => rowHtml(r, max, tier)).join("")}</div>${loadMore}`;
  }
  const countLabel = rows.length > shown.length ? `${shown.length} of ${rows.length}` : `${rows.length}`;
  return `<section class="window ${t.cls}">
    <div class="wtitle ${t.cls}"><span class="dot"></span><h2>${t.name}</h2><span class="count">${countLabel} pools</span></div>
    ${body}
  </section>`;
}

function render() {
  $("#windows").innerHTML = [1, 2, 3].map(windowHtml).join("");
  const d = state.data;
  const when = new Date(d.generatedAt);
  const ageH = Math.round((Date.now() - when) / 3.6e6);
  $("#foot").innerHTML = `
    <div class="legend">
      <span><span class="g up">▲</span> spiking — spot >20% above its 30-day mean (a spike; may not last)</span>
      <span><span class="g steady">●</span> steady — within ±20% (durable)</span>
      <span><span class="g down">▼</span> decaying — spot >20% below its mean (fading)</span>
    </div>
    Kept <strong>${d.stats.kept}</strong> of ${d.stats.totalPools} pools ·
    tiers ${d.stats.perTier[1]}/${d.stats.perTier[2]}/${d.stats.perTier[3]} ·
    data ${ageH}h old (${when.toISOString().slice(0, 16).replace("T", " ")} UTC) ·
    source <a href="${esc(safeUrl(d.source) || "https://defillama.com/yields")}">DefiLlama</a> · <a href="./data/latest.json">raw JSON</a>`;
}

function toggleRow(id) {
  state.openId = state.openId === id ? null : id;
  render();
}

// one delegated listener on the container survives re-renders
function onWindowsClick(e) {
  if (e.target.closest("a")) return; // let outbound / footer links work
  const more = e.target.closest(".loadmore");
  if (more) {
    const t = +more.dataset.tier;
    state.limits[t] = (state.limits[t] || PAGE) + PAGE;
    return render();
  }
  const th = e.target.closest(".th.sortable");
  if (th) {
    const k = th.dataset.sort;
    if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    else { state.sortKey = k; state.sortDir = k === "name" ? "asc" : "desc"; }
    resetLimits(); // re-sort → start each window from the top again
    return render();
  }
  const row = e.target.closest(".row");
  if (row) return toggleRow(row.dataset.id);
}
$("#windows").addEventListener("click", onWindowsClick);
$("#windows").addEventListener("keydown", (e) => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList?.contains("row")) {
    e.preventDefault();
    toggleRow(e.target.dataset.id);
  }
});

// chain filter chips (multi-select toggles; all-on = no filter)
function renderChips() {
  $("#chain").innerHTML = CHAINS.map(
    (c) =>
      `<button class="chip ${state.chains.has(c) ? "on" : ""}" data-chain="${c}">
        <img class="chic" src="${chainLogo(c)}" alt="" onerror="this.remove()"><span>${c}</span>
      </button>`
  ).join("");
}
$("#chain").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  const c = b.dataset.chain;
  if (state.chains.has(c)) state.chains.delete(c);
  else state.chains.add(c);
  if (state.chains.size === 0) state.chains = new Set(CHAINS); // never empty
  resetLimits();
  renderChips();
  render();
});

// single-select segmented controls (bucket, type)
function wireSeg(id, key) {
  $(id).addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    state[key] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    resetLimits();
    render();
  });
}
wireSeg("#bucket", "bucket");
wireSeg("#type", "type");
$("#kyc").addEventListener("change", (e) => { state.showKyc = e.target.checked; resetLimits(); render(); });
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

renderChips();
load();
