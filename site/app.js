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
const state = {
  bucket: "all",
  chains: new Set(CHAINS),
  showKyc: false,
  sortKey: "base",
  sortDir: "desc",
  data: null,
};

const $ = (s) => document.querySelector(s);
const fmtPct = (n) => (n == null ? "—" : `${n.toFixed(2)}%`);
const fmtSigned = (n) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
const fmtTvl = (n) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${Math.round(n / 1e3)}k`;
const divRatio = (r) => (r.mean30d && r.mean30d !== 0 ? (r.total - r.mean30d) / r.mean30d : null);
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
  if (key === "name") return `${r.project} ${r.symbol}`.toLowerCase();
  if (key === "divRatio") return divRatio(r) ?? -Infinity;
  return r[key] ?? -Infinity;
}

const protoLogo = (slug) => `./assets/logos/protocols/${slug}.webp`;
const chainLogo = (chain) => `./assets/logos/chains/${chain.toLowerCase()}.webp`;

function rowsFor(tier) {
  let rows = (state.data.windows[tier] || []).slice();
  if (state.bucket !== "all") rows = rows.filter((r) => r.bucket === state.bucket);
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
  return `<div class="thead grid"><span></span>${cells}</div>`;
}

function rowHtml(r, max) {
  const basePct = max > 0 ? (r.base / max) * 100 : 0;
  const rewPct = max > 0 ? (r.reward / max) * 100 : 0;
  const fm = flagMeta(r);
  const ratio = divRatio(r);
  const tip =
    ratio == null
      ? "No 30-day history yet"
      : `Spot ${fmtPct(r.total)} is ${fmtSigned(ratio)} vs 30d mean ${fmtPct(r.mean30d)} → ${fm.word}`;
  const initial = (r.project[0] || "?").toUpperCase();
  const logo = `<span class="logo"><span class="mono">${initial}</span><img class="ic" src="${protoLogo(r.project)}" alt="" loading="lazy" onerror="this.remove()"></span>`;
  const chainIc = `<img class="chic" src="${chainLogo(r.chain)}" alt="" title="${r.chain}" loading="lazy" onerror="this.remove()">`;
  const lock = r.access === "permissioned" ? `<span class="lock" title="Permissioned — KYC required">🔒</span>` : "";
  const ext = r.url
    ? `<a class="ext ${r.linkKind}" href="${r.url}" target="_blank" rel="noopener" title="${r.linkKind === "exact" ? "Open in " + r.project : "View on DefiLlama"}">↗</a>`
    : "";
  return `<div class="row grid">
    ${logo}
    <span class="name"><span class="line"><span class="proj">${r.project}</span><span class="sym">${r.symbol}</span>${chainIc}<span class="chain">${r.chain}</span>${lock}${ext}</span></span>
    <span class="bar hide-sm" title="base ${fmtPct(r.base)} · reward ${fmtPct(r.reward)}"><span class="b" style="width:${basePct}%"></span><span class="r" style="width:${rewPct}%"></span></span>
    <span class="num base">${fmtPct(r.base)}</span>
    <span class="num mean hide-sm">${fmtPct(r.mean30d)}</span>
    <span class="flag ${fm.cls}" data-tip="${tip}"><span class="g">${r.divFlag}</span></span>
    <span class="tvl">${fmtTvl(r.tvlUsd)}</span>
  </div>`;
}

function windowHtml(tier) {
  const rows = rowsFor(tier);
  const max = rows.reduce((m, r) => Math.max(m, r.base + r.reward), 0);
  const body = rows.length
    ? `${headerHtml()}<div class="rows">${rows.map((r) => rowHtml(r, max)).join("")}</div>`
    : `<p class="empty">— no pools match —</p>`;
  const t = TIER[tier];
  return `<section class="window ${t.cls}">
    <div class="wtitle ${t.cls}"><span class="dot"></span><h2>${t.name}</h2><span class="count">${rows.length} pools</span></div>
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
    source <a href="${d.source}">DefiLlama</a> · <a href="./data/latest.json">raw JSON</a>`;

  // wire sortable headers (re-bound each render)
  document.querySelectorAll(".th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const k = th.dataset.sort;
      if (state.sortKey === k) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      else { state.sortKey = k; state.sortDir = k === "name" ? "asc" : "desc"; }
      render();
    });
  });
}

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
  renderChips();
  render();
});

// controls
$("#bucket").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  state.bucket = b.dataset.v;
  $("#bucket").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
  render();
});
$("#kyc").addEventListener("change", (e) => { state.showKyc = e.target.checked; render(); });
$("#theme").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch {}
});

renderChips();
load();
