// ─────────────────────────────────────────────────────────────────────────────
// POOL RISK LEVEL — pure. Rates one pool on its Factors and takes the weakest
// (weakest link): the pool's Level is the worst Factor Level.
//
//   rateRisk(facts, cuts?) → { level, driver, factors: [{ name, value, level, unknown }] }
//
// facts  what the pipeline knows about the pool: { coinTier, coinDriver, tvlUsd, ageDays,
//        yieldPct (30-day mean), baseRate, spotPct (today), meanPct (30-day mean) }.
// cuts   cut lines per Factor (DEFAULT_CUTS); the build config may override them.
//
// A Factor with no data counts as Level 2 and is marked unknown — a gap in our data
// is not evidence of risk, and not evidence of safety. The driver is the first
// Factor at the pool's Level, in FACTOR_ORDER, so ties never depend on input order.
// ─────────────────────────────────────────────────────────────────────────────

export const FACTOR_ORDER = ["coin", "size", "age", "yield", "stability", "protocol"];

export const DEFAULT_CUTS = {
  size: { level1: 50_000_000, level2: 5_000_000 }, // TVL (total deposits) at or above
  age: { level1: 180, level2: 30 },                 // days live at or above (age.mjs)
  yield: { level1: 1.5, level2: 2.5 },              // × base rate, at or below (base-rate.mjs)
  stability: { level1: 0.3, level2: 0.6 },          // rise of today vs 30-day mean, at or below
};

// "up": higher is safer (Level 1 at or above level1). "down": lower is safer (Level 1 at
// or below level1). checkCuts uses this to reject cut lines in the wrong order.
const DIRECTION = { size: "up", age: "up", yield: "down", stability: "down" };

const UNKNOWN_LEVEL = 2;

// Cut lines must be numbers in the factor's direction (level1 >= level2 when higher is
// safer, level1 <= level2 when lower is safer); anything else would quietly mis-rate
// every pool, so it throws and the build keeps the last snapshot.
export function checkCuts(cuts) {
  for (const [name, c] of Object.entries(cuts)) {
    if (!(name in DIRECTION)) throw new Error(`risk cut lines: unknown factor "${name}"`);
    const down = DIRECTION[name] === "down";
    const ordered = down ? c?.level1 <= c?.level2 : c?.level1 >= c?.level2;
    if (!(Number.isFinite(c?.level1) && Number.isFinite(c?.level2) && ordered))
      throw new Error(`risk cut lines for "${name}" must be numbers with level1 ${down ? "<=" : ">="} level2, got ${JSON.stringify(c)}`);
  }
  return cuts;
}
const atLeast = (v, { level1, level2 }) => (v >= level1 ? 1 : v >= level2 ? 2 : 3);
const atMost = (v, { level1, level2 }) => (v <= level1 ? 1 : v <= level2 ? 2 : 3);
const known = (v) => v != null && Number.isFinite(v);

// Each Factor: facts → { value, level } or null when the fact is missing.
const FACTORS = {
  coin: (f) => (known(f.coinTier) ? { value: f.coinDriver ?? null, level: f.coinTier } : null),
  size: (f, cuts) => (known(f.tvlUsd) ? { value: f.tvlUsd, level: atLeast(f.tvlUsd, cuts.size) } : null),
  age: (f, cuts) => (known(f.ageDays) ? { value: f.ageDays, level: atLeast(f.ageDays, cuts.age) } : null),
  yield: (f, cuts) => {
    if (!known(f.yieldPct) || !(Number.isFinite(f.baseRate) && f.baseRate > 0)) return null;
    const x = f.yieldPct / f.baseRate; // multiple of the base rate (rated unrounded)
    return { value: Math.round(x * 100) / 100, level: atMost(x, cuts.yield) };
  },
  // Today vs the 30-day mean. Only rises count: a jump signals high utilization or a
  // temporary incentive; a fall is not a safety risk. Value = signed % (as the durability card).
  stability: (f, cuts) => {
    if (!known(f.spotPct) || !(known(f.meanPct) && f.meanPct > 0)) return null;
    const d = (f.spotPct - f.meanPct) / f.meanPct;
    if (!Number.isFinite(d)) return null;
    return { value: Math.round(d * 100), level: atMost(Math.max(0, d), cuts.stability) };
  },
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
