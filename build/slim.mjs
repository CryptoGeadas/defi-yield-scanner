// Trim a pipeline row to what the site actually renders (+ link, detail & flows fields).
// The published snapshot row. Pure apart from buildLink; tested in e2e.test.mjs.
import { buildLink } from "./deeplinks.mjs";
import { rowFlows } from "./flows.mjs";

const round = (n) => Math.round(n * 100) / 100;
// one damaged ledger record must never stop the whole refresh: that row reads "unavailable"
const safeFlows = (r, ledger, now) => {
  try { return rowFlows(r, ledger, now); }
  catch (e) { console.warn(`  ⚠ flows: record for ${r.pool} unreadable (${e.message}) — shown as unavailable`); return { status: "unavailable" }; }
};

// `now`: the clock freshness is judged by (the build passes Date.now(); tests a fixed time)
export const makeSlim = (names, siteUrls, sources, poolUrls, ledger, now = Date.now()) => (r) => {
  const { url, kind } = buildLink(r, { siteUrl: siteUrls[r.project], sources, override: poolUrls[r.pool] });
  return {
    project: r.project,
    name: names[r.project] || r.project,
    symbol: r.label, // row label from intake: venue's vault name, or symbol · market
    chain: r.chain,
    bucket: r.bucket,
    access: r.access,
    type: r.stableType, // fiat | crypto | yield | rwa | synthetic
    tier: r.tier, // coin Tier (the Coin factor) — independent of which window the row is in
    tierDriver: r.tierDriver,
    level: r.level, // risk Level shown (sticky rule applied, sticky.mjs)
    levelComputed: r.levelComputed, // this run's level before the sticky rule
    levelDriver: r.levelDriver,
    factors: r.factors,
    base: round(r.base),
    reward: round(r.reward),
    total: round(r.total),
    spot: r.spot == null ? null : round(r.spot),
    mean30d: r.mean30d == null ? null : round(r.mean30d),
    divFlag: r.divFlag,
    tvlUsd: Math.round(r.tvlUsd),
    legs: r.legs, // true stablecoin legs (classification), independent of display symbol
    // the legs' token addresses (DefiLlama): deposit matching compares coins by address (#41)
    underlyingTokens: Array.isArray(r.underlyingTokens) ? r.underlyingTokens.map((t) => String(t).toLowerCase()) : null,
    url,
    linkKind: kind, // 'exact' | 'site' | 'defillama' | null
    // detail-panel fields (Phase 3)
    exposure: r.exposure,
    ilRisk: r.ilRisk,
    apyReward: r.apyReward == null ? null : round(r.apyReward),
    volumeUsd1d: r.volumeUsd1d == null ? null : Math.round(r.volumeUsd1d),
    volumeUsd7d: r.volumeUsd7d == null ? null : Math.round(r.volumeUsd7d),
    apyPct7D: r.apyPct7D == null ? null : round(r.apyPct7D),
    apyPct30D: r.apyPct30D == null ? null : round(r.apyPct30D),
    poolId: r.pool,
    vault: r.vault ?? null, // { chain, address, decimals } when flows are tracked — the flows job reads this list
    flows: safeFlows(r, ledger, now), // money flows (#30): shown only, never part of Level or any Factor
  };
};
