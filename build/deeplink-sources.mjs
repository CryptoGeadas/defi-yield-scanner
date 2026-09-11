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

// Build all sources up front (in parallel where independent).
export async function buildSources(chains) {
  const [curve] = await Promise.all([curveSource(chains)]);
  console.log(`  deeplink sources: curve=${curve.size} pools`);
  return { curve };
}
