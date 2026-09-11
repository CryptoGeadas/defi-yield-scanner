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

// ── Morpho (MetaMorpho vaults) ────────────────────────────────────────────────
// DefiLlama lists MetaMorpho vaults as morpho-blue pools whose `symbol` is the
// vault share token (e.g. STEAKUSDC) — which our stable filter drops. We fetch the
// vault registry to (a) resolve each to its underlying asset so it can be tiered,
// and (b) build its exact URL app.morpho.org/<network>/vault/<address>.
export const MORPHO_NET = { 1: "ethereum", 8453: "base", 42161: "arbitrum", 10: "optimism", 137: "polygon" };
export const MORPHO_CHAINID = { Ethereum: 1, Base: 8453, Arbitrum: 42161, Optimism: 10, Polygon: 137 };

async function morphoGql(query) {
  const r = await fetch("https://blue-api.morpho.org/graphql", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }),
  });
  return r.json();
}

async function morphoSource() {
  // key: `${chainId}|${SYMBOL}|${assetAddr}` -> { address, assetSymbol, name, network, tvl }
  const map = new Map();
  try {
    let skip = 0;
    for (let page = 0; page < 30; page++) {
      const j = await morphoGql(
        `{ vaults(first:100, skip:${skip}) { items { address symbol name chain { id } asset { symbol address } state { totalAssetsUsd } } } }`
      );
      const items = j?.data?.vaults?.items;
      if (!items || items.length === 0) break;
      for (const v of items) {
        const network = MORPHO_NET[v.chain?.id];
        if (!network || !v.symbol || !v.asset?.address) continue;
        const k = `${v.chain.id}|${v.symbol.toUpperCase()}|${v.asset.address.toLowerCase()}`;
        const tvl = v.state?.totalAssetsUsd || 0;
        const prev = map.get(k);
        if (!prev || tvl > prev.tvl)
          map.set(k, { address: v.address, assetSymbol: v.asset.symbol, name: v.name, network, tvl });
      }
      if (items.length < 100) break;
      skip += 100;
    }
  } catch (e) {
    console.warn("  morpho source failed:", e.message);
  }
  return map;
}

// Build all sources up front (in parallel where independent).
export async function buildSources(chains) {
  const [curve, morpho] = await Promise.all([curveSource(chains), morphoSource()]);
  console.log(`  deeplink sources: curve=${curve.size} pools, morpho=${morpho.size} vaults`);
  return { curve, morpho };
}
