// ─────────────────────────────────────────────────────────────────────────────
// Exact deep-link builders, per protocol. Given a pipeline row, return the exact
// URL into the protocol's own app, or null if we don't have a verified scheme —
// in which case build.mjs falls back to the DefiLlama pool page (never a dead link).
//
// GROW THIS conservatively: only add a protocol here once its URL scheme is
// verified, otherwise the "exact" link 404s and defeats the point. The DefiLlama
// fallback already makes every row clickable, so an absent builder is safe.
// ─────────────────────────────────────────────────────────────────────────────

import { addrKey, CURVE_CHAIN } from "./deeplink-sources.mjs";
import pkg from "js-sha3";
const { keccak256 } = pkg;

const firstToken = (row) => (row.underlyingTokens && row.underlyingTokens[0]) || null;

// EIP-55 checksum an 0x address.
function checksum(addr) {
  const a = addr.toLowerCase().replace(/^0x/, "");
  const h = keccak256(a);
  let out = "0x";
  for (let i = 0; i < a.length; i++) out += parseInt(h[i], 16) >= 8 ? a[i].toUpperCase() : a[i];
  return out;
}

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

// Curve — match DL pool → Curve pool address by underlying-token set (sources.curve).
function curveDex(row, sources) {
  const slug = CURVE_CHAIN[row.chain];
  if (!slug || !sources?.curve) return null;
  const hit = sources.curve.get(`${slug}|${addrKey(row.underlyingTokens)}`);
  return hit ? `https://curve.finance/dex/${slug}/pools/${hit.address}` : null;
}

// Uniswap V3 — pool address is deterministic: CREATE2(factory, keccak(token0,
// token1, fee), initCodeHash). We have both tokens + the fee tier (poolMeta),
// so no API needed. URL: app.uniswap.org/explore/pools/<chain>/<poolAddress>.
const UNI_CHAIN = { Ethereum: "ethereum", Arbitrum: "arbitrum", Base: "base", Optimism: "optimism", Polygon: "polygon" };
const V3_FACTORY = {
  Ethereum: "1f98431c8ad98523631ae4a59f267346ea31f984",
  Arbitrum: "1f98431c8ad98523631ae4a59f267346ea31f984",
  Optimism: "1f98431c8ad98523631ae4a59f267346ea31f984",
  Polygon: "1f98431c8ad98523631ae4a59f267346ea31f984",
  Base: "33128a8fc17869897dce68ed026d694621f6fdfd",
};
const V3_INIT = "e34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";
const pad32 = (h) => h.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function uniswapV3(row) {
  const chain = UNI_CHAIN[row.chain];
  const factory = V3_FACTORY[row.chain];
  const toks = row.underlyingTokens || [];
  if (!chain || !factory || toks.length !== 2 || !row.poolMeta) return null;
  const feeBips = Math.round(parseFloat(row.poolMeta) * 10000); // "0.01%" → 100
  if (!Number.isFinite(feeBips) || feeBips <= 0) return null;
  let [t0, t1] = toks.map((t) => t.toLowerCase());
  if (BigInt(t0) > BigInt(t1)) [t0, t1] = [t1, t0];
  const salt = keccak256(Buffer.from(pad32(t0) + pad32(t1) + pad32(feeBips.toString(16)), "hex"));
  const addr = keccak256(Buffer.from("ff" + factory + salt + V3_INIT, "hex")).slice(-40);
  return `https://app.uniswap.org/explore/pools/${chain}/${checksum(addr)}`;
}

// Registry of verified builders, keyed by DefiLlama `project` slug.
// A builder takes (row, sources) and returns an exact URL or null.
const BUILDERS = {
  "aave-v3": aaveV3,
  "curve-dex": curveDex,
  "uniswap-v3": uniswapV3,
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
// resort). ctx = { siteUrl, sources }. siteUrl = protocol's official URL (config).
// Returns { url, kind }. kind: 'exact' | 'site' | 'defillama' | null (permissioned).
export function buildLink(row, ctx = {}) {
  if (row.access === "permissioned") return { url: null, kind: null };

  // pre-resolved exact URL (set during build pre-processing, e.g. Morpho vaults)
  if (row.exactUrl) return { url: row.exactUrl, kind: "exact" };

  const b = BUILDERS[row.project];
  if (b) {
    const exact = b(row, ctx.sources);
    if (exact) return { url: exact, kind: "exact" };
  }

  const site = ctx.siteUrl || SITE_FALLBACK[row.project];
  if (site) return { url: site, kind: "site" };

  const dll = dllPool(row);
  return { url: dll, kind: dll ? "defillama" : null };
}
