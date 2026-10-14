// ─────────────────────────────────────────────────────────────────────────────
// Per-protocol deep-link SOURCES. Some protocols key their URL off an internal
// pool/vault address DefiLlama doesn't give us — so at build time we fetch the
// protocol's own API and build a lookup (matched by underlying-token-address set)
// that deeplinks.mjs consults. Each source fails soft: on any error the protocol
// simply falls back to its site link. Verified against the live apps.
// ─────────────────────────────────────────────────────────────────────────────

// key = sorted, lowercased set of underlying token addresses (identifies a pool)
export const addrKey = (addrs) =>
  (addrs || []).map((a) => String(a).toLowerCase()).sort().join(",");

// ── Curve ────────────────────────────────────────────────────────────────────
// URL: https://curve.finance/dex/<chain>/pools/<poolAddress>  (verified live)
export const CURVE_CHAIN = {
  Ethereum: "ethereum", Arbitrum: "arbitrum", Base: "base",
  Optimism: "optimism", Polygon: "polygon",
};

async function curveSource(chains) {
  const map = new Map(); // `${slug}|${addrKey}` -> { slug, address, usd }
  for (const chain of chains) {
    const slug = CURVE_CHAIN[chain];
    if (!slug) continue;
    try {
      const j = await (await fetch(`https://api.curve.finance/api/getPools/all/${slug}`)).json();
      for (const p of j?.data?.poolData || []) {
        const addrs = (p.coins || []).map((c) => c.address).filter(Boolean);
        if (!addrs.length || !p.address) continue;
        const k = `${slug}|${addrKey(addrs)}`;
        const prev = map.get(k);
        if (!prev || (p.usdTotal || 0) > prev.usd) map.set(k, { slug, address: p.address, usd: p.usdTotal || 0 });
      }
    } catch (e) {
      console.warn(`  curve source ${slug} failed:`, e.message);
    }
  }
  return map;
}

// ── Morpho (MetaMorpho V1 + V2 vaults) ───────────────────────────────────────
// DefiLlama lists MetaMorpho vaults as morpho-blue pools whose `symbol` is the
// vault share token (e.g. STEAKUSDC) — which our stable filter drops. We fetch the
// vault registry to (a) resolve each to its underlying asset so it can be tiered,
// and (b) build its exact URL app.morpho.org/<network>/vault/<address>.
// Curators reuse a V1 vault's name + symbol for its V2 successor (Kabu USDC), so a
// key can hold several vaults; intake picks the one whose TVL matches DefiLlama's.
export const MORPHO_NET = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism", 137: "polygon" };
export const MORPHO_CHAINID = { Ethereum: 1, Base: 8453, Arbitrum: 42161, Optimism: 10, Polygon: 137 };

async function morphoGql(query) {
  const r = await fetch("https://blue-api.morpho.org/graphql", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  });
  return r.json();
}

// Page through one vault list. `field` is the GraphQL list (vaults | vaultV2s);
// `tvlOf` reads TVL from an item (V1 nests it under state, V2 does not).
async function morphoVaults(field, fields, tvlOf) {
  const out = [];
  const chainIds = Object.keys(MORPHO_NET).join(",");
  for (let skip = 0, page = 0; page < 60; page++, skip += 500) {
    const j = await morphoGql(
      `{ ${field}(first:500, skip:${skip}, where:{ chainId_in:[${chainIds}] }) { items { address symbol name chain { id } asset { symbol address } ${fields} } } }`
    );
    const items = j?.data?.[field]?.items;
    if (!items) throw new Error(`${field}: ${JSON.stringify(j?.errors ?? j).slice(0, 200)}`);
    for (const v of items) out.push({ ...v, tvl: tvlOf(v) || 0 });
    if (items.length < 500) break;
  }
  return out;
}

async function morphoSource() {
  // key: `${chainId}|${SYMBOL}|${assetAddr}` -> [{ address, assetSymbol, name, network, tvl }]
  const map = new Map();
  try {
    const [v1, v2] = await Promise.all([
      morphoVaults("vaults", "state { totalAssetsUsd }", (v) => v.state?.totalAssetsUsd),
      morphoVaults("vaultV2s", "totalAssetsUsd", (v) => v.totalAssetsUsd),
    ]);
    for (const v of [...v1, ...v2]) {
      const network = MORPHO_NET[v.chain?.id];
      if (!network || !v.symbol || !v.asset?.address) continue;
      const k = `${v.chain.id}|${v.symbol.toUpperCase()}|${v.asset.address.toLowerCase()}`;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ address: v.address, assetSymbol: v.asset.symbol, name: v.name, network, tvl: v.tvl });
    }
  } catch (e) {
    console.warn("  morpho source failed:", e.message);
    return new Map(); // all or nothing: a V1-only registry is what caused wrong links
  }
  return map;
}

// Build all sources up front (in parallel where independent).
export async function buildSources(chains) {
  const [curve, morpho] = await Promise.all([curveSource(chains), morphoSource()]);
  console.log(`  deeplink sources: curve=${curve.size} pools, morpho=${morpho.size} vaults`);
  return { curve, morpho };
}
