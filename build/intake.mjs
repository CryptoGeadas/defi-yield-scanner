// ─────────────────────────────────────────────────────────────────────────────
// POOL INTAKE — pure. Turns the raw DefiLlama feed into the pools the ranking
// pipeline judges, and gives every pool an explicit identity.
//
//   intakePools(feed, venues, curation) → { pools, report }
//
// feed     DefiLlama `/pools` data array (not mutated).
// venues   what build.mjs fetched from each venue's own API (see venues.mjs):
//            morpho  Map `${chainId}|${SHARE_SYMBOL}|${assetAddr}` → { address, assetSymbol, name, network, tvl }
//            yearn   Map `${chainId}|${vaultAddr}` → vault name
//            kamino  [{ address, name, symbol, mint, tvl, base, reward, mean30, apy7 }]
//          Any of these may be missing/empty (a fetch failed) — intake degrades, never throws.
// curation the hand-kept opinion files: { denylist, poolUrls }.
//
// Every returned pool carries its IDENTITY alongside the DefiLlama fields:
//   legs      the stablecoin tickers it actually holds — what the pipeline tiers on.
//             Never the share-token symbol of a vault (STEAKUSDC → ["USDC"]).
//   label     the row label a person would recognise on the venue's own app.
//   exactUrl  a venue-verified deposit URL, or null (deeplinks.mjs then decides).
//
// Venue corrections run in a fixed order, all inside this module:
//   1. drop denylisted feed pools
//   2. Morpho  — resolve MetaMorpho share tokens to their underlying asset + vault
//   3. Yearn   — name same-asset vaults (DefiLlama gives no vault name or address)
//   4. Kamino  — replace DefiLlama's kamino-lend (isolated borrow markets) with the
//                curated Lending Vaults read on-chain
//   5. identity for everything else: legs from the symbol, label from symbol + poolMeta
// ─────────────────────────────────────────────────────────────────────────────


import { MORPHO_CHAINID as CHAIN_ID } from "./deeplink-sources.mjs"; // chain name → EVM chain id

const norm = (s) => String(s ?? "").trim().toUpperCase();
const lower = (s) => String(s ?? "").toLowerCase();

// "USDC-USDT" → ["USDC","USDT"]. The default way a plain pool's legs are known.
export function parseLegs(symbol) {
  return norm(symbol).split(/[-/+]/).map((x) => x.trim()).filter(Boolean);
}

// Default row label: fold the venue's own market/product name (poolMeta) into the
// symbol so same-symbol rows are distinguishable — "USDC · SOL/BTC Market" (Kamino
// markets), "USDC · mFONE" (Midas), "USDC · Core" (Aave V4).
function defaultLabel(p) {
  const meta = String(p.poolMeta ?? "").trim();
  if (!meta || meta.toLowerCase() === "null") return p.symbol;
  if (norm(meta) === norm(p.symbol)) return p.symbol;
  return `${p.symbol} · ${meta}`;
}

// ── denylist ────────────────────────────────────────────────────────────────
// Three ways to name a pool to hide: DefiLlama pool id, `project|chain|SYMBOL`
// (raw DefiLlama symbol), or a Morpho vault address. Case-insensitive.
function denyChecker(denylist = {}) {
  const set = (xs) => new Set((xs || []).map(lower));
  const ids = set(denylist.poolIds), keys = set(denylist.keys), vaults = set(denylist.morphoVaults);
  return {
    pool: (p) => ids.has(lower(p.pool)) || keys.has(lower(`${p.project}|${p.chain}|${p.symbol}`)),
    morphoVault: (address) => vaults.has(lower(address)),
  };
}

// ── Morpho ──────────────────────────────────────────────────────────────────
// DefiLlama lists MetaMorpho vaults under morpho-blue with the vault's SHARE
// symbol (STEAKUSDC). Match each to the Morpho registry by chain + share symbol +
// underlying token; several DefiLlama pools can hit one vault, so keep the largest.
// Returns Map(pool → identity) and the set of pools to drop (denylisted vaults).
function morphoIdentities(pools, registry, deny) {
  const byVault = new Map(); // address → { pool, hit }
  const drop = new Set();
  if (!registry?.size) return { ids: new Map(), drop };
  for (const p of pools) {
    if (p.project !== "morpho-blue" || (p.underlyingTokens || []).length !== 1) continue;
    const cid = CHAIN_ID[p.chain];
    if (!cid) continue;
    const hit = registry.get(`${cid}|${norm(p.symbol)}|${lower(p.underlyingTokens[0])}`);
    if (!hit) continue;
    if (deny.morphoVault(hit.address)) { drop.add(p); continue; }
    const prev = byVault.get(hit.address);
    if (!prev || (p.tvlUsd || 0) > (prev.pool.tvlUsd || 0)) byVault.set(hit.address, { pool: p, hit });
  }
  const ids = new Map();
  for (const { pool, hit } of byVault.values()) {
    ids.set(pool, {
      legs: parseLegs(hit.assetSymbol),
      label: hit.name, // "Steakhouse USDC"
      exactUrl: `https://app.morpho.org/${hit.network}/vault/${hit.address}`,
    });
  }
  return { ids, drop };
}

// ── Yearn ───────────────────────────────────────────────────────────────────
// DefiLlama gives Yearn vaults neither a name nor the vault address, so same-asset
// vaults collide as "USDC" ×N. The vault address is known only where a curated
// deposit URL (pool-urls.json) points at it: yearn.fi/v3/<chainId>/<address> or
// yearn.fi/vaults/<chainId>/<address>. Name those from the Yearn registry.
const YEARN_URL = /yearn\.fi\/(?:v3|vaults)\/(\d+)\/(0x[0-9a-fA-F]+)/;
function yearnLabels(pools, registry, poolUrls = {}) {
  const labels = new Map();
  if (!registry?.size) return labels;
  for (const p of pools) {
    if (p.project !== "yearn-finance") continue;
    const m = String(poolUrls[p.pool] || "").match(YEARN_URL);
    const name = m && registry.get(`${m[1]}|${lower(m[2])}`);
    if (name) labels.set(p, name);
  }
  return labels;
}

// ── Kamino ──────────────────────────────────────────────────────────────────
// Shape a Kamino Lending Vault record into a DefiLlama-like pool so it flows
// through the normal pipeline. Kamino's `apy` is base lending yield; rewards are
// separate additive streams (summed by the fetcher).
function kaminoPool(v) {
  const reward = v.reward > 0 ? v.reward : null;
  return {
    project: "kamino-lend",
    chain: "Solana",
    symbol: v.symbol,
    poolMeta: null,
    pool: v.address, // stable id (override + history key)
    underlyingTokens: [v.mint],
    stablecoin: true,
    outlier: false,
    exposure: "single",
    ilRisk: "no",
    tvlUsd: v.tvl,
    apyBase: v.base,
    apyReward: reward,
    apy: v.base + (reward ?? 0),
    apyMean30d: v.mean30,
    apyPct7D: v.apy7 ?? null,
    apyPct30D: null,
    volumeUsd1d: null,
    volumeUsd7d: null,
    legs: parseLegs(v.symbol),
    label: v.name || v.symbol,
    exactUrl: `https://app.kamino.finance/lend/${v.address}`,
  };
}

export function intakePools(feed, venues = {}, curation = {}) {
  const deny = denyChecker(curation.denylist);
  const report = { feed: feed.length, denied: 0, morphoVaults: 0, yearnNamed: 0, kaminoDropped: 0, kaminoAdded: 0 };

  // 1. denylist (feed)
  let pools = feed.filter((p) => !deny.pool(p));
  report.denied = feed.length - pools.length;

  // 2–3. venue identities for feed pools
  const morpho = morphoIdentities(pools, venues.morpho, deny);
  if (morpho.drop.size) {
    pools = pools.filter((p) => !morpho.drop.has(p));
    report.denied += morpho.drop.size;
  }
  report.morphoVaults = morpho.ids.size;
  const yearn = yearnLabels(pools, venues.yearn, curation.poolUrls);
  report.yearnNamed = yearn.size;

  // 4. Kamino: DefiLlama's kamino-lend are isolated borrow markets, not the passive
  // "Lend" product — always drop them; add the on-chain Lending Vaults we fetched.
  const kept = pools.filter((p) => p.project !== "kamino-lend");
  report.kaminoDropped = pools.length - kept.length;
  const kamino = (venues.kamino || []).map(kaminoPool).filter((p) => !deny.pool(p));
  report.kaminoAdded = kamino.length;

  // 5. identity for every feed pool (new objects — the feed is never mutated)
  const out = kept.map((p) => {
    const id = morpho.ids.get(p);
    return {
      ...p,
      legs: id?.legs ?? parseLegs(p.symbol),
      label: id?.label ?? yearn.get(p) ?? defaultLabel(p),
      exactUrl: id?.exactUrl ?? null,
    };
  });

  return { pools: [...out, ...kamino], report };
}
