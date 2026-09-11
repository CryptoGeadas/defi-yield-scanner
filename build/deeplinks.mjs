// ─────────────────────────────────────────────────────────────────────────────
// Exact deep-link builders, per protocol. Given a pipeline row, return the exact
// URL into the protocol's own app, or null if we don't have a verified scheme —
// in which case build.mjs falls back to the DefiLlama pool page (never a dead link).
//
// GROW THIS conservatively: only add a protocol here once its URL scheme is
// verified, otherwise the "exact" link 404s and defeats the point. The DefiLlama
// fallback already makes every row clickable, so an absent builder is safe.
// ─────────────────────────────────────────────────────────────────────────────

const firstToken = (row) => (row.underlyingTokens && row.underlyingTokens[0]) || null;

// Aave v3 — app.aave.com/reserve-overview/?underlyingAsset=<addr>&marketName=<market>
const AAVE_V3_MARKET = {
  Ethereum: "proto_mainnet_v3",
  Base: "proto_base_v3",
  Arbitrum: "proto_arbitrum_v3",
  Optimism: "proto_optimism_v3",
  Polygon: "proto_polygon_v3",
};
function aaveV3(row) {
  const market = AAVE_V3_MARKET[row.chain];
  const addr = firstToken(row);
  if (!market || !addr) return null;
  return `https://app.aave.com/reserve-overview/?underlyingAsset=${addr.toLowerCase()}&marketName=${market}`;
}

// Registry of verified builders, keyed by DefiLlama `project` slug.
const BUILDERS = {
  "aave-v3": aaveV3,
};

const dllPool = (row) => (row.pool ? `https://defillama.com/yields/pool/${row.pool}` : null);

// Official site fallbacks for the few protocols DefiLlama's config has no `url` for.
const SITE_FALLBACK = {
  "curve-dex": "https://curve.finance",
  "compound-v2": "https://app.compound.finance",
  "aerodrome-v1": "https://aerodrome.finance",
  "aerodrome-slipstream": "https://aerodrome.finance",
  "raydium-amm": "https://raydium.io",
};

// Link priority: exact deep link → protocol's own site → DefiLlama pool page (last
// resort). `siteUrl` is the protocol's official URL from DefiLlama config.
// Returns { url, kind }. kind: 'exact' | 'site' | 'defillama' | null (permissioned).
export function buildLink(row, siteUrl) {
  if (row.access === "permissioned") return { url: null, kind: null };

  const b = BUILDERS[row.project];
  if (b) {
    const exact = b(row);
    if (exact) return { url: exact, kind: "exact" };
  }

  const site = siteUrl || SITE_FALLBACK[row.project];
  if (site) return { url: site, kind: "site" };

  const dll = dllPool(row);
  return { url: dll, kind: dll ? "defillama" : null };
}
