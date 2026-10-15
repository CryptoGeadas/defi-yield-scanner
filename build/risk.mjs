// ─────────────────────────────────────────────────────────────────────────────
// POOL RISK LEVEL — pure. Rates one pool on its Factors and takes the weakest
// (weakest link): the pool's Level is the worst Factor Level.
//
//   rateRisk(facts, cuts?) → { level, driver, factors: [{ name, value, level, unknown }] }
//
// facts  what the pipeline knows about the pool: { coinTier, coinDriver, tvlUsd }.
// cuts   cut lines per Factor (DEFAULT_CUTS); the build config may override them.
//
// A Factor with no data counts as Level 2 and is marked unknown — a gap in our data
// is not evidence of risk, and not evidence of safety. The driver is the first
// Factor at the pool's Level, in FACTOR_ORDER, so ties never depend on input order.
// ─────────────────────────────────────────────────────────────────────────────

export const FACTOR_ORDER = ["coin", "size", "age", "yield", "stability", "protocol"];

export const DEFAULT_CUTS = {
  size: { level1: 50_000_000, level2: 5_000_000 }, // TVL (total deposits) at or above
};

const UNKNOWN_LEVEL = 2;

// Cut lines must be numbers with level1 at or above level2; anything else would
// quietly mis-rate every pool, so it throws and the build keeps the last snapshot.
export function checkCuts(cuts) {
  for (const [name, c] of Object.entries(cuts)) {
    if (!(Number.isFinite(c?.level1) && Number.isFinite(c?.level2) && c.level1 >= c.level2))
      throw new Error(`risk cut lines for "${name}" must be numbers with level1 >= level2, got ${JSON.stringify(c)}`);
  }
  return cuts;
}
const atLeast = (v, { level1, level2 }) => (v >= level1 ? 1 : v >= level2 ? 2 : 3);
const known = (v) => v != null && Number.isFinite(v);

// Each Factor: facts → { value, level } or null when the fact is missing.
const FACTORS = {
  coin: (f) => (known(f.coinTier) ? { value: f.coinDriver ?? null, level: f.coinTier } : null),
  size: (f, cuts) => (known(f.tvlUsd) ? { value: f.tvlUsd, level: atLeast(f.tvlUsd, cuts.size) } : null),
};

export function rateRisk(facts, cuts = DEFAULT_CUTS) {
  // A coin Tier is a ceiling, so a malformed one must never pass as "unknown" (Level 2).
  if (facts.coinTier != null && ![1, 2, 3].includes(facts.coinTier))
    throw new Error(`coin tier must be 1, 2 or 3, got ${JSON.stringify(facts.coinTier)} (${facts.coinDriver ?? "?"}) — check trusted-stables.json`);
  const factors = FACTOR_ORDER.filter((name) => FACTORS[name]).map((name) => {
    const r = FACTORS[name](facts, cuts);
    return r ? { name, value: r.value, level: r.level, unknown: false } : { name, value: null, level: UNKNOWN_LEVEL, unknown: true };
  });
  const level = Math.max(...factors.map((f) => f.level));
  const driver = factors.find((f) => f.level === level).name;
  return { level, driver, factors };
}
