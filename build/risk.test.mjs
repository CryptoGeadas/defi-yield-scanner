// Tests for pool risk levels, through rateRisk(facts) and runPipeline.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateRisk } from "./risk.mjs";

const factor = (r, name) => r.factors.find((f) => f.name === name);

test("Size: Level 1 from $50M, Level 2 from $5M, Level 3 below", () => {
  const lvl = (tvlUsd) => factor(rateRisk({ coinTier: 1, tvlUsd }), "size").level;
  assert.equal(lvl(50e6), 1);
  assert.equal(lvl(49.9e6), 2);
  assert.equal(lvl(5e6), 2);
  assert.equal(lvl(4.9e6), 3);
});

test("a pool takes its weakest factor (weakest link)", () => {
  assert.equal(rateRisk({ coinTier: 1, tvlUsd: 2e6 }).level, 3);
  assert.equal(rateRisk({ coinTier: 1, tvlUsd: 900e6, ageDays: 1000, yieldPct: 4, baseRate: 4, spotPct: 4, meanPct: 4, protocolLevel: 1 }).level, 1);
});

test("the coin Tier is a ceiling: a big pool is never safer than its riskiest coin", () => {
  const r = rateRisk({ coinTier: 3, coinDriver: "USDE", tvlUsd: 2e9 });
  assert.equal(r.level, 3);
  assert.equal(r.driver, "coin");
  assert.deepEqual(factor(r, "coin"), { name: "coin", value: "USDE", level: 3, unknown: false });
});

test("a missing fact counts as Level 2 and is marked unknown", () => {
  const r = rateRisk({ coinTier: 1, coinDriver: "USDC", tvlUsd: null });
  assert.deepEqual(factor(r, "size"), { name: "size", value: null, level: 2, unknown: true });
  assert.equal(r.level, 2);
});

test("ties go to the first factor in the fixed order Coin, Size, …", () => {
  const r = rateRisk({ coinTier: 2, coinDriver: "GHO", tvlUsd: 10e6 }); // coin 2, size 2
  assert.equal(r.driver, "coin");
  assert.deepEqual(r.factors.map((f) => f.name), ["coin", "size", "age", "yield", "stability", "protocol"]);
});

// ── pipeline: windows by level behind the switch ────────────────────────────
import { runPipeline } from "./pipeline.mjs";

const maps = {
  protocolMap: { "aave-v3": { bucket: "lend", access: "permissionless", level: 1 }, "morpho-blue": { bucket: "vault", access: "permissionless", level: 1 } },
  stableMap: { USDC: { tier: 1, type: "fiat" } },
};
const pool = (o) => ({
  project: "aave-v3", chain: "Ethereum", symbol: "USDC", pool: "p", stablecoin: true, legs: ["USDC"],
  tvlUsd: 500e6, ageDays: 1000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, ...o,
});
const pools = [pool({ pool: "aave" }), pool({ pool: "small", project: "morpho-blue", tvlUsd: 2e6 })];
const ids = (rows) => rows.map((r) => r.pool);

test("switch on: a $2M USDC vault lands in window 3, a $500M Aave USDC pool stays in window 1", () => {
  const r = runPipeline(pools, { baseRate: 4, levelWindows: true }, maps);
  assert.deepEqual(ids(r.windows[1]), ["aave"]);
  assert.deepEqual(ids(r.windows[3]), ["small"]);
  assert.equal(r.windows[3][0].level, 3);
  assert.equal(r.windows[3][0].levelDriver, "size");
  assert.equal(r.windows[3][0].tier, 1, "the coin tier stays on the row");
});

test("switch off (default): windows stay by coin tier, rows still carry their level", () => {
  const r = runPipeline(pools, { baseRate: 4 }, maps);
  assert.deepEqual(ids(r.windows[1]).sort(), ["aave", "small"]);
  const small = r.windows[1].find((x) => x.pool === "small");
  assert.equal(small.level, 3);
  assert.deepEqual(small.factors.map((f) => f.name), ["coin", "size", "age", "yield", "stability", "protocol"]);
});

test("custom Size cut lines from the config are used", () => {
  const r = runPipeline(pools, { baseRate: 4, levelWindows: true, riskCuts: { size: { level1: 1e6, level2: 0.5e6 } } }, maps);
  assert.deepEqual(ids(r.windows[1]).sort(), ["aave", "small"], "$2M is Level 1 under the custom Size cut lines");
  assert.deepEqual(r.config.riskCuts.size, { level1: 1e6, level2: 0.5e6 });
  assert.deepEqual(r.stats.perLevel, { 1: 2, 2: 0, 3: 0 });
});

test("a missing or non-numeric fact never rates as safe or as Level 3: it is unknown, Level 2", () => {
  const noCoin = rateRisk({ tvlUsd: 900e6 });
  assert.deepEqual(factor(noCoin, "coin"), { name: "coin", value: null, level: 2, unknown: true });
  assert.equal(noCoin.level, 2);
  assert.equal(noCoin.driver, "coin");
  assert.equal(factor(rateRisk({ coinTier: 1, tvlUsd: NaN }), "size").unknown, true);
});

test("the switch decides grouping both ways: tier-2 coin in a $2M pool", () => {
  const gho = pool({ pool: "gho", legs: ["GHO"], tvlUsd: 2e6 });
  const m = { ...maps, stableMap: { ...maps.stableMap, GHO: { tier: 2, type: "crypto" } } };
  assert.deepEqual(ids(runPipeline([gho], { baseRate: 4 }, m).windows[2]), ["gho"], "switch off → coin Tier window");
  assert.deepEqual(ids(runPipeline([gho], { baseRate: 4, levelWindows: true }, m).windows[3]), ["gho"], "switch on → Level window");
});

test("a malformed coin tier fails loudly instead of passing as unknown", () => {
  assert.throws(() => rateRisk({ coinTier: "3", coinDriver: "USDE", tvlUsd: 500e6 }), /coin tier must be 1, 2 or 3/);
  assert.throws(() => rateRisk({ coinTier: -Infinity, tvlUsd: 500e6 }), /coin tier/);
  const bad = { ...maps, stableMap: { USDC: { tier: "1", type: "fiat" } } };
  assert.throws(() => runPipeline(pools, { baseRate: 4, levelWindows: true }, bad), /coin tier/);
});

test("partial or reversed cut lines fail loudly", () => {
  assert.throws(() => runPipeline(pools, { baseRate: 4, riskCuts: { size: { level1: 50e6 } } }, maps), /cut lines for "size"/);
  assert.throws(() => runPipeline(pools, { baseRate: 4, riskCuts: { size: { level1: 1e6, level2: 5e6 } } }, maps), /level1 >= level2/);
});

// ── Age factor (#14) ────────────────────────────────────────────────────────
import { poolAge } from "./age.mjs";

const NOW = Date.parse("2026-10-15T00:00:00Z");
const DAY = 86_400_000;

test("pool age: pool since beats venue date beats protocol since beats DefiLlama count; none → unknown", () => {
  const since = { pools: { "p1": "2024-10-15" }, protocols: { "midas-rwa": "2025-10-15" } };
  const venueDate = NOW - 100 * DAY;
  assert.deepEqual(poolAge({ pool: "p1", project: "midas-rwa", startedAt: venueDate, count: 5 }, since, NOW), { days: 730, source: "since" });
  assert.deepEqual(poolAge({ pool: "p2", project: "midas-rwa", count: 5 }, since, NOW), { days: 365, source: "since" });
  assert.deepEqual(poolAge({ pool: "p3", project: "kamino-lend", startedAt: venueDate, count: 5 }, since, NOW), { days: 100, source: "venue" });
  assert.deepEqual(poolAge({ pool: "p4", project: "aave-v3", count: 1333 }, since, NOW), { days: 1333, source: "defillama" });
  assert.equal(poolAge({ pool: "p5", project: "aave-v3" }, since, NOW), null);
});

test("Age: Level 1 from 180 days, Level 2 from 30 days, Level 3 below; unknown → Level 2", () => {
  const lvl = (ageDays) => factor(rateRisk({ coinTier: 1, tvlUsd: 900e6, ageDays }), "age");
  assert.equal(lvl(180).level, 1);
  assert.equal(lvl(179).level, 2);
  assert.equal(lvl(30).level, 2);
  assert.equal(lvl(29).level, 3);
  assert.deepEqual(lvl(null), { name: "age", value: null, level: 2, unknown: true });
});

import { checkSince } from "./age.mjs";
test("since.json is checked at load: bad, loose, impossible or future dates fail loudly", () => {
  for (const bad of ["soon", "2024", 2024, "2024-6-1", "2024-02-30", "Oct 15 2024"])
    assert.throws(() => checkSince({ pools: { p: bad } }, NOW), /not a date/, String(bad));
  assert.throws(() => checkSince({ pools: { p: "2062-01-01" } }, NOW), /in the future/);
  assert.throws(() => checkSince({ pools: [] }, NOW), /must be an object/);
  assert.doesNotThrow(() => checkSince({ pools: { p: "2024-06-01" }, protocols: {} }, NOW));
});

test("a protocol since date never makes a newer pool older; bad venue dates are ignored", () => {
  const since = { protocols: { "midas-rwa": "2024-01-01" } };
  assert.deepEqual(poolAge({ pool: "new", project: "midas-rwa", startedAt: NOW - 7 * DAY }, since, NOW), { days: 7, source: "venue" });
  assert.equal(poolAge({ pool: "x", project: "y", startedAt: NOW + 50 * DAY, count: 40 }, {}, NOW).source, "defillama", "future venue date ignored");
  assert.equal(poolAge({ pool: "x", project: "y", startedAt: 1_700_000_000, count: 40 }, {}, NOW).source, "defillama", "seconds instead of ms (1970) ignored");
  assert.equal(poolAge({ pool: "x", project: "y", startedAt: NOW - 29.6 * DAY }, {}, NOW).days, 29, "partial days round down");
  assert.equal(poolAge({ pool: "x", project: "y", count: 0 }, {}, NOW), null, "count 0 is unknown, not 0 days");
});

test("age drives the pipeline: a young $500M tier-1 pool lands in window 3, set by age", () => {
  const r = runPipeline([pool({ pool: "young", ageDays: 10 })], { levelWindows: true }, maps);
  assert.equal(r.windows[3][0].pool, "young");
  assert.equal(r.windows[3][0].levelDriver, "age");
});

// ── Yield factor + base rate (#15) ──────────────────────────────────────────
import { baseRate } from "./base-rate.mjs";

const aave = (symbol, apyMean30d, o = {}) => ({ project: "aave-v3", chain: "Ethereum", symbol, poolMeta: null, apyMean30d, ...o });

test("base rate = average 30-day mean of Aave V3 USDC and USDT (main market, Ethereum)", () => {
  const feed = [aave("USDC", 4.4), aave("USDT", 3.8), aave("USDC", 9, { poolMeta: "Umbrella" }), aave("USDC", 9, { chain: "Base" })];
  assert.equal(baseRate(feed), 4.1);
});

test("base rate fails loudly when a pool or its mean is missing", () => {
  assert.throws(() => baseRate([aave("USDC", 4.4)]), /base rate/);
  assert.throws(() => baseRate([aave("USDC", 4.4), aave("USDT", null)]), /base rate/);
});

test("Yield: Level 1 up to 1.5× the base rate, Level 2 up to 2.5×, Level 3 above; no base rate → unknown", () => {
  const lvl = (y) => factor(rateRisk({ coinTier: 1, tvlUsd: 900e6, ageDays: 1000, yieldPct: y, baseRate: 4 }), "yield");
  assert.equal(lvl(6).level, 1);    // 1.5×
  assert.equal(lvl(6.04).level, 2);
  assert.equal(lvl(10).level, 2);   // 2.5×
  assert.equal(lvl(10.04).level, 3);
  assert.equal(lvl(6).value, 1.5, "value is the multiple of the base rate");
  assert.equal(factor(rateRisk({ coinTier: 1, yieldPct: 5 }), "yield").unknown, true);
});

test("the pipeline rates yield on the 30-day mean against config.baseRate", () => {
  const hot = pool({ pool: "hot", apy: 14, apyBase: 14, apyMean30d: 12 }); // 12 / 4 = 3×
  const r = runPipeline([hot], { levelWindows: true, baseRate: 4 }, maps);
  assert.equal(r.windows[3][0].levelDriver, "yield");
});

test("Yield uses the organic 30-day mean: rewards are taken out, a zero mean falls back to today's base", () => {
  const rewards = pool({ pool: "rew", apy: 12, apyBase: 4, apyReward: 8, apyMean30d: 12 }); // 4% organic = 1× base
  assert.equal(runPipeline([rewards], { baseRate: 4 }, maps).windows[1][0].factors.find((f) => f.name === "yield").value, 1);
  const fresh = pool({ pool: "new", apy: 25, apyBase: 25, apyMean30d: 0 }); // no history yet
  assert.equal(runPipeline([fresh], { baseRate: 4 }, maps).windows[1][0].factors.find((f) => f.name === "yield").level, 3);
});

test("base rate is pinned by pool id and falls back to the main-market match", () => {
  const pinned = [aave("USDC", 4, { pool: "aa70268e-4b52-42bf-a116-608b370f9501" }), aave("USDC", 9), aave("USDT", 4, { pool: "f981a304-bb6c-45b8-b0c5-fd2f515ad23a" }), aave("USDT", 9)];
  assert.equal(baseRate(pinned), 4, "two unlabeled markets, but the pinned ids win");
});

test("Yield reads the 30-day mean, not today's spike; no mean → today's base", () => {
  const yieldOf = (p) => runPipeline([p], { baseRate: 4 }, maps).windows[1][0].factors.find((f) => f.name === "yield");
  assert.deepEqual([yieldOf(pool({ pool: "spike", apy: 14, apyBase: 14, apyMean30d: 5 })).value, yieldOf(pool({ pool: "spike", apy: 14, apyBase: 14, apyMean30d: 5 })).level], [1.25, 1]);
  const noMean = yieldOf(pool({ pool: "nomean", apy: 12, apyBase: 12, apyMean30d: null }));
  assert.deepEqual([noMean.value, noMean.level], [3, 3]);
});

test("reversed Yield cut lines fail loudly; a zero or missing base rate makes Yield unknown", () => {
  assert.throws(() => runPipeline(pools, { baseRate: 4, riskCuts: { yield: { level1: 2.5, level2: 1.5 } } }, maps), /level1 <= level2/);
  for (const baseRate of [0, NaN, -1]) assert.equal(factor(rateRisk({ coinTier: 1, yieldPct: 5, baseRate }), "yield").unknown, true, String(baseRate));
});

test("bad inputs fail loudly: implausible base rate, bad baseRate config, unknown factor in cut lines", () => {
  assert.throws(() => baseRate([aave("USDC", 0.04), aave("USDT", 0.04)]), /outside 0.5–25%/);
  assert.throws(() => baseRate([aave("USDC", 4), aave("USDC", 5), aave("USDT", 4)]), /found 2/);
  assert.throws(() => runPipeline(pools, { baseRate: Infinity }, maps), /baseRate must be a positive number/);
  assert.throws(() => runPipeline(pools, { baseRate: 4, riskCuts: { yeild: { level1: 1, level2: 2 } } }, maps), /unknown factor "yeild"/);
});

test("the yield multiple is rated unrounded: 1.504× is Level 2", () => {
  assert.equal(factor(rateRisk({ coinTier: 1, yieldPct: 6.016, baseRate: 4 }), "yield").level, 2);
});

// ── Stability factor (#16) ──────────────────────────────────────────────────
test("Stability: rises only — Level 1 up to +30%, Level 2 up to +60%, Level 3 above; falls are Level 1", () => {
  const st = (spotPct, meanPct) => factor(rateRisk({ coinTier: 1, spotPct, meanPct }), "stability");
  assert.equal(st(13, 10).level, 1);   // +30%
  assert.equal(st(13.1, 10).level, 2);
  assert.equal(st(16, 10).level, 2);   // +60%
  assert.equal(st(16.1, 10).level, 3);
  assert.deepEqual([st(6, 10).value, st(6, 10).level], [-40, 1], "a −40% fall is Level 1; value is the signed %");
  assert.equal(st(5, null).unknown, true);
  assert.equal(st(5, 0).unknown, true, "no 30-day mean → unknown");
});

test("the pipeline rates stability on today's yield vs the 30-day mean (same number as the durability card)", () => {
  const row = runPipeline([pool({ pool: "s", apy: 5.9, apyBase: 5.9, apyMean30d: 2.5 })], { baseRate: 4 }, maps).windows[1][0];
  const st = row.factors.find((f) => f.name === "stability");
  assert.deepEqual([st.value, st.level], [136, 3]);
  assert.equal(st.value, Math.round(row.divRatio * 100));
});

test("Stability edge cases: no spot → unknown; flat or negative yield is Level 1; stability cut lines checked", () => {
  const st = (spotPct, meanPct) => factor(rateRisk({ coinTier: 1, spotPct, meanPct }), "stability");
  assert.equal(st(null, 10).unknown, true);
  assert.deepEqual([st(10, 10).value, st(10, 10).level], [0, 1]);
  assert.deepEqual([st(-2, 10).value, st(-2, 10).level], [-120, 1]);
  const row = runPipeline([pool({ pool: "nospot", apy: undefined, apyMean30d: 5 })], { baseRate: 4 }, maps).windows[1][0];
  assert.equal(row.factors.find((f) => f.name === "stability").unknown, true, "a pool with no spot APY is not rated safe");
  assert.throws(() => runPipeline(pools, { baseRate: 4, riskCuts: { stability: { level1: 0.6, level2: 0.3 } } }, maps), /level1 <= level2/);
  const custom = runPipeline([pool({ pool: "j", apy: 5, apyBase: 5, apyMean30d: 4 })], { baseRate: 4, riskCuts: { stability: { level1: 0.1, level2: 0.2 } } }, maps);
  assert.equal(custom.windows[1][0].factors.find((f) => f.name === "stability").level, 3, "+25% is Level 3 under custom cut lines");
});

// ── Protocol factor (#17) ───────────────────────────────────────────────────
test("Protocol: the hand-set level per protocol; a protocol without a level is unknown", () => {
  const pr = (protocolLevel) => factor(rateRisk({ coinTier: 1, protocol: "aave-v3", protocolLevel }), "protocol");
  assert.deepEqual(pr(1), { name: "protocol", value: "aave-v3", level: 1, unknown: false });
  assert.equal(pr(3).level, 3);
  assert.deepEqual(pr(undefined), { name: "protocol", value: null, level: 2, unknown: true });
  assert.throws(() => rateRisk({ coinTier: 1, protocol: "x", protocolLevel: 4 }), /protocol level/);
});

test("the pipeline reads the protocol level from trusted-protocols", () => {
  const m = { ...maps, protocolMap: { ...maps.protocolMap, "aave-v3": { bucket: "lend", access: "permissionless", level: 3 } } };
  const r = runPipeline([pool({ pool: "a" })], { baseRate: 4, levelWindows: true }, m);
  assert.equal(r.windows[3][0].levelDriver, "protocol");
});

import { checkProtocolLevels } from "./risk.mjs";
test("protocol levels: checked at load; bad values throw, missing ones are listed and rated unknown", () => {
  for (const bad of ["1", 0, 1.5, 4]) assert.throws(() => checkProtocolLevels({ x: { level: bad } }), /protocol level/, String(bad));
  assert.deepEqual(checkProtocolLevels({ a: { level: 1 }, b: {} }), ["b"]);
  const noLevel = { ...maps, protocolMap: { "aave-v3": { bucket: "lend", access: "permissionless" } } };
  const row = runPipeline([pool({ pool: "a" })], { baseRate: 4 }, noLevel).windows[1][0];
  assert.deepEqual(row.factors.find((f) => f.name === "protocol"), { name: "protocol", value: null, level: 2, unknown: true });
  const bad = { ...maps, protocolMap: { "aave-v3": { bucket: "lend", access: "permissionless", level: 5 } } };
  assert.throws(() => runPipeline([pool({ pool: "a" })], { baseRate: 4 }, bad), /protocol level.*trusted-protocols/);
});

// ── Stability minimum rise (#27) ────────────────────────────────────────────
import { DEFAULT_CUTS, checkCuts } from "./risk.mjs";
test("Stability: a rise under +1 percentage point never counts; at +1 pp or more the % cut lines apply", () => {
  const st = (spotPct, meanPct) => factor(rateRisk({ coinTier: 1, spotPct, meanPct }), "stability");
  assert.deepEqual([st(0.18, 0.09).value, st(0.18, 0.09).level], [100, 1], "+100% on 0.09% → 0.18% is Level 1; value stays the %");
  assert.equal(st(6, 4).level, 2, "+50% on 4% → 6% (+2 pp) is still Level 2");
  assert.equal(st(2, 1).level, 3, "exactly +1 pp counts");
  assert.equal(st(1.99, 1).level, 1, "just under +1 pp does not");
  assert.equal(st(4.1, 3.1).level, 2, "+32% at +1 pp (0.9999999999999996 in floating point) still counts");
  assert.equal(st(2.3, 1.3).level, 3);
  assert.equal(st(1.995, 1).level, 1, "+0.995 pp does not count");
  assert.equal(st(0.3, 0.1).risePp, 0.2, "the rise in percentage points is on the factor");
  assert.equal(DEFAULT_CUTS.stability.minPp, 1);
  assert.equal(st(0.18, 0.09).belowMinPp, true, "the factor says the rise did not count");
  assert.equal(st(1.0996, 0.1).belowMinPp, true, "0.9996 pp is below the line even though risePp rounds to 1");
  assert.equal(st(1.0996, 0.1).level, 1);
  assert.equal(st(1.1, 1).belowMinPp, false, "+10% is Level 1 anyway: nothing to explain");
  assert.equal(st(6, 4).belowMinPp, false);
  assert.equal(st(0.05, 0.1).level, 1, "a fall stays Level 1");
});

test("Stability minPp is checked; a custom stability cut without minPp has no minimum", () => {
  assert.throws(() => checkCuts({ stability: { level1: 0.3, level2: 0.6, minPp: -1 } }), /minPp/);
  assert.throws(() => checkCuts({ stability: { level1: 0.3, level2: 0.6, minPp: "1" } }), /minPp/);
  assert.throws(() => checkCuts({ size: { level1: 50e6, level2: 5e6, minPp: 1 } }), /only used by stability/);
  assert.equal(factor(rateRisk({ coinTier: 1, spotPct: 0.18, meanPct: 0.09 }, { ...DEFAULT_CUTS, stability: { level1: 0.3, level2: 0.6, minPp: 0 } }), "stability").level, 3, "minPp 0 = no minimum");
  const st = factor(rateRisk({ coinTier: 1, spotPct: 0.18, meanPct: 0.09 }, { ...DEFAULT_CUTS, stability: { level1: 0.3, level2: 0.6 } }), "stability");
  assert.equal(st.level, 3);
});

test("pipeline: tuning stability's % cut lines keeps the +1 pp minimum; minPp 0 drops it", () => {
  const tiny = [pool({ pool: "t", apy: 0.18, apyBase: 0.18, apyMean30d: 0.09 })];
  const lv = (stability) => runPipeline(tiny, { baseRate: 4, riskCuts: { stability } }, maps).windows[1][0].factors.find((f) => f.name === "stability").level;
  assert.equal(lv({ level1: 0.2, level2: 0.5 }), 1);
  assert.equal(lv({ level1: 0.3, level2: 0.6, minPp: 0 }), 3);
  assert.throws(() => lv({ minPp: 0 }), /cut lines for "stability"/, "a partial override still fails loudly");
});
