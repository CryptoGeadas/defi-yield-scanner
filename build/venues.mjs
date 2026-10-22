// ─────────────────────────────────────────────────────────────────────────────
// VENUE DATA — the I/O half of pool intake. Fetches what each venue's own API knows
// that DefiLlama doesn't, in the shapes intake.mjs expects. Every source fails soft
// (empty map / list) so a flaky venue API never breaks the refresh; intake then
// simply leaves those pools with their default identity. One exception: lendBorrow —
// build.mjs refuses to overwrite the snapshot when it comes back short, because without
// it lending TVL would silently mean "net of loans" and ~50 rows would drop off.
// Euler fails soft too, but intake then hides Euler rows (permissionless vaults are
// only shown when Euler's own labels list them).
// ─────────────────────────────────────────────────────────────────────────────

import { buildSources, MORPHO_CHAINID } from "./deeplink-sources.mjs";
import { fetchKaminoVaults } from "./kamino-vaults.mjs";
import { fetchEulerVaults } from "./euler-vaults.mjs";

// One ydaemon vault → registry entry: { name, decimals (of the underlying token, not the
// share), v3 (version 3.x = ERC-4626, the only kind money flows can read) }.
// asset + tvl let intake check that a curated URL's vault is really the pool's vault.
export const yearnEntry = (v) => ({
  name: v.name,
  decimals: Number.isInteger(v.token?.decimals) ? v.token.decimals : null,
  v3: /^3\./.test(String(v.version ?? "")),
  asset: typeof v.token?.address === "string" ? v.token.address.toLowerCase() : null,
  tvl: Number.isFinite(v.tvl?.tvl) ? v.tvl.tvl : null,
});

// Yearn registry: `${chainId}|${vaultAddr}` → yearnEntry, one call for all chains.
async function fetchYearnRegistry(chains) {
  const ids = chains.map((c) => MORPHO_CHAINID[c]).filter(Boolean).sort((a, b) => a - b);
  const map = new Map();
  try {
    const r = await fetch(`https://ydaemon.yearn.fi/vaults/all?chainIDs=${ids.join(",")}&limit=5000`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    for (const v of (await r.json()) || []) {
      if (v?.address && v?.name)
        map.set(`${v.chainID}|${v.address.toLowerCase()}`, yearnEntry(v));
    }
  } catch (e) {
    console.warn("  yearn registry failed:", e.message);
  }
  return map;
}

// DefiLlama's lending feed: pool id → total supplied (USD). The /pools feed counts
// lending pools net of loans; intake swaps in this total so TVL means deposits on
// every row. Empty on failure; build.mjs then refuses to overwrite the snapshot.
async function fetchLendBorrow() {
  const map = new Map();
  try {
    const r = await fetch("https://yields.llama.fi/lendBorrow", { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    for (const p of (await r.json()) || []) {
      if (p?.pool && Number.isFinite(p.totalSupplyUsd)) map.set(p.pool, p.totalSupplyUsd);
    }
  } catch (e) {
    console.warn("  lendBorrow feed failed:", e.message);
  }
  return map;
}

// → { curve, morpho, yearn, kamino, lendBorrow, euler }. `curve` feeds deep links (deeplinks.mjs);
// morpho / yearn / kamino / lendBorrow / euler feed intakePools.
export async function fetchVenues({ chains, stableSet, tvlFloor }) {
  const [sources, yearn, kamino, lendBorrow, euler] = await Promise.all([
    buildSources(chains),
    fetchYearnRegistry(chains),
    fetchKaminoVaults(stableSet, tvlFloor),
    fetchLendBorrow(),
    fetchEulerVaults(chains),
  ]);
  console.log(`  venues: yearn=${yearn.size} vaults, kamino=${kamino.length} vaults, lendBorrow=${lendBorrow.size} pools, euler=${[...euler.values()].reduce((n, v) => n + (v?.length ?? 0), 0)} labelled vaults on ${[...euler.values()].filter(Boolean).length}/${euler.size} chains`);
  return { curve: sources.curve, morpho: sources.morpho, yearn, kamino, lendBorrow, euler };
}
