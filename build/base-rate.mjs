// ─────────────────────────────────────────────────────────────────────────────
// BASE RATE — pure. The market's plain stablecoin lending rate, used by the Yield
// factor: a pool paying far above it must be taking risk somewhere.
//
//   baseRate(feed) → number (% APY)
//
// = the average 30-day mean yield of Aave V3 USDC and USDT on Ethereum, main market
// (the DefiLlama pools with no poolMeta; Umbrella / Prime / Horizon are other markets).
// It moves with the market, so the Yield cut lines (multiples of it) move too.
// A missing pool or mean throws: a wrong base rate would mis-rate every pool, so the
// build fails and the last snapshot stays.
// ─────────────────────────────────────────────────────────────────────────────

// Pinned by DefiLlama pool id (stable); if an id ever disappears, fall back to the single
// main-market pool (no poolMeta) for that symbol.
export const BASE_RATE_POOLS = [
  { symbol: "USDC", id: "aa70268e-4b52-42bf-a116-608b370f9501" },
  { symbol: "USDT", id: "f981a304-bb6c-45b8-b0c5-fd2f515ad23a" },
];

export function baseRate(feed) {
  const means = BASE_RATE_POOLS.map(({ symbol, id }) => {
    let hits = feed.filter((p) => p.pool === id);
    if (!hits.length) hits = feed.filter((p) => p.project === "aave-v3" && p.chain === "Ethereum" && p.symbol === symbol && p.poolMeta == null);
    if (hits.length !== 1) throw new Error(`base rate: expected 1 Aave V3 ${symbol} main-market pool on Ethereum, found ${hits.length}`);
    const m = hits[0].apyMean30d;
    if (!(Number.isFinite(m) && m > 0)) throw new Error(`base rate: Aave V3 ${symbol} has no 30-day mean (${m})`);
    // plausibility: a unit change (0.041 for 4.1%) or a bad spike would re-rate every pool
    if (m < 0.5 || m > 25) throw new Error(`base rate: Aave V3 ${symbol} 30-day mean ${m} outside 0.5–25%`);
    return m;
  });
  return Math.round((means.reduce((a, b) => a + b, 0) / means.length) * 100) / 100;
}
