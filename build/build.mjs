// ─────────────────────────────────────────────────────────────────────────────
// BUILD STEP — runs in the GitHub Action (cron */6h + workflow_dispatch).
// fetch DefiLlama → runPipeline → write site/data/latest.json (committed to repo).
// The static site reads that JSON. No key, no backend, instant load.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline, DEFAULT_CONFIG } from "./pipeline.mjs";
import { buildLink } from "./deeplinks.mjs";
import { buildSources, MORPHO_CHAINID } from "./deeplink-sources.mjs";
import { vendorLogos } from "./logos.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "site");
const OUT = join(SITE, "data", "latest.json");
const FEED = "https://yields.llama.fi/pools";

const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

async function loadMaps() {
  const protocolMap = strip(JSON.parse(await readFile(join(HERE, "trusted-protocols.json"), "utf8")));
  const stableRaw = strip(JSON.parse(await readFile(join(HERE, "trusted-stables.json"), "utf8")));
  const stableMap = {};
  for (const [k, v] of Object.entries(stableRaw)) stableMap[k.toUpperCase()] = v;
  return { protocolMap, stableMap };
}

const loadNames = async () => strip(JSON.parse(await readFile(join(HERE, "protocol-names.json"), "utf8")));

// Surface MetaMorpho vaults: DefiLlama lists them under morpho-blue with the vault
// share symbol (STEAKUSDC) which our stable filter drops. Rewrite matched pools to
// their underlying asset (so they tier correctly), label them with the vault name,
// and attach the exact vault URL. Mutates pools in place.
function preprocessMorpho(pools, morpho) {
  if (!morpho || morpho.size === 0) return 0;
  // collect candidate (pool, vault) matches, then keep one pool per vault address
  const byVault = new Map(); // address -> { pool, hit }
  for (const p of pools) {
    if (p.project !== "morpho-blue" || (p.underlyingTokens || []).length !== 1) continue;
    const cid = MORPHO_CHAINID[p.chain];
    if (!cid) continue;
    const hit = morpho.get(`${cid}|${String(p.symbol).toUpperCase()}|${p.underlyingTokens[0].toLowerCase()}`);
    if (!hit) continue;
    const prev = byVault.get(hit.address);
    if (!prev || (p.tvlUsd || 0) > (prev.pool.tvlUsd || 0)) byVault.set(hit.address, { pool: p, hit });
  }
  for (const { pool, hit } of byVault.values()) {
    pool.displayName = hit.name;              // e.g. "Steakhouse USDC"
    pool.symbol = hit.assetSymbol;            // reclassify + tier by the real asset
    pool.exactUrl = `https://app.morpho.org/${hit.network}/vault/${hit.address}`;
  }
  return byVault.size;
}

// Map each protocol slug → its official site URL, from DefiLlama's config
// (slug derived from the logo path). Used as the primary deposit link.
async function loadSiteUrls() {
  try {
    const cfg = await (await fetch("https://api.llama.fi/config")).json();
    const arr = Array.isArray(cfg.protocols) ? cfg.protocols : Object.values(cfg.protocols || cfg);
    const map = {};
    for (const p of arr) {
      const slug = (p.logo || "").split("/").pop()?.split("?")[0];
      if (slug && p.url) map[slug] = p.url;
    }
    return map;
  } catch (e) {
    console.warn("config fetch failed, site links fall back:", e.message);
    return {};
  }
}

// Trim a pipeline row to what the site actually renders (+ link & detail fields).
const makeSlim = (names, siteUrls, sources) => (r) => {
  const { url, kind } = buildLink(r, { siteUrl: siteUrls[r.project], sources });
  return {
    project: r.project,
    name: names[r.project] || r.project,
    symbol: r.displayName || r.symbol,
    chain: r.chain,
    bucket: r.bucket,
    access: r.access,
    tierDriver: r.tierDriver,
    base: round(r.base),
    reward: round(r.reward),
    total: round(r.total),
    mean30d: r.mean30d == null ? null : round(r.mean30d),
    divFlag: r.divFlag,
    tvlUsd: Math.round(r.tvlUsd),
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
  };
};
const round = (n) => Math.round(n * 100) / 100;

async function main() {
  const maps = await loadMaps();
  const [names, siteUrls] = await Promise.all([loadNames(), loadSiteUrls()]);
  console.log("fetching", FEED, "…");
  const res = await fetch(FEED);
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const { data: pools } = await res.json();

  const sources = await buildSources(DEFAULT_CONFIG.chains);
  preprocessMorpho(pools, sources.morpho);

  const r = runPipeline(pools, {}, maps);
  const slim = makeSlim(names, siteUrls, sources);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: FEED,
    config: r.config,
    stats: r.stats,
    windows: {
      1: r.windows[1].map(slim),
      2: r.windows[2].map(slim),
      3: r.windows[3].map(slim),
    },
    // small transparency block — what the opinion excluded, in aggregate
    rejects: Object.fromEntries(Object.entries(r.rejects).map(([k, v]) => [k, v.count])),
    missingTop: r.missingProtocols.slice(0, 10).map((m) => ({ project: m.project, tvlUsd: Math.round(m.tvl) })),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `wrote ${OUT}\n  kept ${r.stats.kept}/${r.stats.totalPools}  tiers ${r.stats.perTier[1]}/${r.stats.perTier[2]}/${r.stats.perTier[3]}`
  );

  // vendor logos for every allowlisted protocol + configured chain (fetch-if-missing)
  const slugs = Object.keys(maps.protocolMap);
  const logo = await vendorLogos(SITE, slugs, r.config.chains);
  console.log(`  logos: ${slugs.length} protocols + ${r.config.chains.length} chains (${logo.fetched} newly fetched)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
