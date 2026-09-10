// Static site: read the Action-committed JSON and render the trust-filtered windows.
// No backend. Re-sort / filter happen client-side over the pre-filtered data.

const TIER_NAME = { 1: "Tier 1 · blue-chip", 2: "Tier 2 · crypto-backed", 3: "Tier 3 · synthetic" };
const state = { sort: "base", bucket: "all", showKyc: false, data: null };

const $ = (s) => document.querySelector(s);
const fmtPct = (n) => (n == null ? "—" : `${n.toFixed(2)}%`);
const fmtTvl = (n) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${Math.round(n / 1e3)}k`;
const flagClass = (f) => (f === "▲" ? "up" : f === "▼" ? "down" : f === "●" ? "steady" : "");

async function load() {
  try {
    const res = await fetch("./data/latest.json", { cache: "no-cache" });
    state.data = await res.json();
  } catch {
    $("#windows").innerHTML = `<p class="empty">No data yet — the refresh Action hasn't run. Run <code>npm run build</code> locally or trigger the workflow.</p>`;
    return;
  }
  render();
}

function rowsFor(tier) {
  let rows = (state.data.windows[tier] || []).slice();
  if (state.bucket !== "all") rows = rows.filter((r) => r.bucket === state.bucket);
  if (!state.showKyc) rows = rows.filter((r) => r.access !== "permissioned");
  const cmp = {
    base: (a, b) => b.base - a.base,
    total: (a, b) => b.total - a.total,
    mean30d: (a, b) => (b.mean30d ?? -1) - (a.mean30d ?? -1),
  }[state.sort];
  rows.sort(cmp);
  return rows;
}

function rowHtml(r, max) {
  const total = r.base + r.reward;
  const basePct = max > 0 ? (r.base / max) * 100 : 0;
  const rewPct = max > 0 ? (r.reward / max) * 100 : 0;
  const lock = r.access === "permissioned" ? `<span class="lock">🔒 KYC</span>` : "";
  return `<div class="row">
    <span class="badge ${r.bucket}">${r.bucket}</span>
    <span class="name"><span class="proj">${r.project}</span> <span class="sym">· ${r.symbol}</span> <span class="chain">· ${r.chain}</span>${lock}</span>
    <span class="bar" title="base ${fmtPct(r.base)} · reward ${fmtPct(r.reward)}"><span class="b" style="width:${basePct}%"></span><span class="r" style="width:${rewPct}%"></span></span>
    <span class="num base">${fmtPct(r.base)}</span>
    <span class="num mean">${fmtPct(r.mean30d)}</span>
    <span class="flag ${flagClass(r.divFlag)}">${r.divFlag}</span>
    <span class="tvl">${fmtTvl(r.tvlUsd)}</span>
  </div>`;
}

function windowHtml(tier) {
  const rows = rowsFor(tier);
  const max = rows.reduce((m, r) => Math.max(m, r.base + r.reward), 0);
  const body = rows.length
    ? `<div class="rows">${rows.map((r) => rowHtml(r, max)).join("")}</div>`
    : `<p class="empty">— no pools match —</p>`;
  return `<section class="window">
    <div class="wtitle t${tier}"><h2>${TIER_NAME[tier]}</h2><span class="count">${rows.length} pools</span></div>
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
      <span><span class="flag up">▲</span> spiking (>+20% vs 30d)</span>
      <span><span class="flag steady">●</span> steady</span>
      <span><span class="flag down">▼</span> decaying (<−20%)</span>
    </div>
    Kept <strong>${d.stats.kept}</strong> of ${d.stats.totalPools} pools ·
    tiers ${d.stats.perTier[1]}/${d.stats.perTier[2]}/${d.stats.perTier[3]} ·
    data ${ageH}h old (${when.toISOString().slice(0, 16).replace("T", " ")} UTC) ·
    source <a href="${d.source}">DefiLlama /pools</a> ·
    <a href="./data/latest.json">raw JSON</a>`;
}

function wireSeg(id, key) {
  $(`#${id}`).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state[key] = btn.dataset.v;
    $(`#${id}`).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === btn));
    render();
  });
}
wireSeg("sort", "sort");
wireSeg("bucket", "bucket");
$("#kyc").addEventListener("change", (e) => {
  state.showKyc = e.target.checked;
  render();
});

load();
