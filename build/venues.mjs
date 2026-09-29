// ─────────────────────────────────────────────────────────────────────────────
// VENUE DATA — the I/O half of pool intake. Fetches what each venue's own API knows
// that DefiLlama doesn't, in the shapes intake.mjs expects. Every source fails soft
// (empty map / list) so a flaky venue API never breaks the refresh; intake then
// simply leaves those pools with their default identity.
// ─────────────────────────────────────────────────────────────────────────────

import { buildSources, MORPHO_CHAINID } from "./deeplink-sources.mjs";
import { fetchKaminoVaults } from "./kamino-vaults.mjs";

// Yearn registry: `${chainId}|${vaultAddr}` → vault name, one call for all chains.
async function fetchYearnRegistry(chains) {
  const ids = chains.map((c) => MORPHO_CHAINID[c]).filter(Boolean).sort((a, b) => a - b);
  const map = new Map();
  try {
    const r = await fetch(`https://ydaemon.yearn.fi/vaults/all?chainIDs=${ids.join(",")}&limit=5000`);
    for (const v of (await r.json()) || []) {
      if (v?.address && v?.name) map.set(`${v.chainID}|${v.address.toLowerCase()}`, v.name);
    }
  } catch (e) {
    console.warn("  yearn registry failed:", e.message);
  }
  return map;
}

// → { curve, morpho, yearn, kamino }. `curve` feeds deep links (deeplinks.mjs);
// morpho / yearn / kamino feed intakePools.
export async function fetchVenues({ chains, stableSet, tvlFloor }) {
  const [sources, yearn, kamino] = await Promise.all([
    buildSources(chains),
    fetchYearnRegistry(chains),
    fetchKaminoVaults(stableSet, tvlFloor),
  ]);
  console.log(`  venues: yearn=${yearn.size} vaults, kamino=${kamino.length} vaults`);
  return { curve: sources.curve, morpho: sources.morpho, yearn, kamino };
}
