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
  assert.equal(rateRisk({ coinTier: 1, tvlUsd: 900e6 }).level, 1);
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
  assert.deepEqual(r.factors.map((f) => f.name), ["coin", "size"]);
});

// ── pipeline: windows by level behind the switch ────────────────────────────
import { runPipeline } from "./pipeline.mjs";

const maps = {
  protocolMap: { "aave-v3": { bucket: "lend", access: "permissionless" }, "morpho-blue": { bucket: "vault", access: "permissionless" } },
  stableMap: { USDC: { tier: 1, type: "fiat" } },
};
const pool = (o) => ({
  project: "aave-v3", chain: "Ethereum", symbol: "USDC", pool: "p", stablecoin: true, legs: ["USDC"],
  tvlUsd: 500e6, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, ...o,
});
const pools = [pool({ pool: "aave" }), pool({ pool: "small", project: "morpho-blue", tvlUsd: 2e6 })];
const ids = (rows) => rows.map((r) => r.pool);

test("switch on: a $2M USDC vault lands in window 3, a $500M Aave USDC pool stays in window 1", () => {
  const r = runPipeline(pools, { levelWindows: true }, maps);
  assert.deepEqual(ids(r.windows[1]), ["aave"]);
  assert.deepEqual(ids(r.windows[3]), ["small"]);
  assert.equal(r.windows[3][0].level, 3);
  assert.equal(r.windows[3][0].levelDriver, "size");
  assert.equal(r.windows[3][0].tier, 1, "the coin tier stays on the row");
});

test("switch off (default): windows stay by coin tier, rows still carry their level", () => {
  const r = runPipeline(pools, {}, maps);
  assert.deepEqual(ids(r.windows[1]).sort(), ["aave", "small"]);
  const small = r.windows[1].find((x) => x.pool === "small");
  assert.equal(small.level, 3);
  assert.deepEqual(small.factors.map((f) => f.name), ["coin", "size"]);
});

test("custom Size cut lines from the config are used", () => {
  const r = runPipeline(pools, { levelWindows: true, riskCuts: { size: { level1: 1e6, level2: 0.5e6 } } }, maps);
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
  assert.deepEqual(ids(runPipeline([gho], {}, m).windows[2]), ["gho"], "switch off → coin Tier window");
  assert.deepEqual(ids(runPipeline([gho], { levelWindows: true }, m).windows[3]), ["gho"], "switch on → Level window");
});

test("a malformed coin tier fails loudly instead of passing as unknown", () => {
  assert.throws(() => rateRisk({ coinTier: "3", coinDriver: "USDE", tvlUsd: 500e6 }), /coin tier must be 1, 2 or 3/);
  assert.throws(() => rateRisk({ coinTier: -Infinity, tvlUsd: 500e6 }), /coin tier/);
  const bad = { ...maps, stableMap: { USDC: { tier: "1", type: "fiat" } } };
  assert.throws(() => runPipeline(pools, { levelWindows: true }, bad), /coin tier/);
});

test("partial or reversed cut lines fail loudly", () => {
  assert.throws(() => runPipeline(pools, { riskCuts: { size: { level1: 50e6 } } }, maps), /cut lines for "size"/);
  assert.throws(() => runPipeline(pools, { riskCuts: { size: { level1: 1e6, level2: 5e6 } } }, maps), /level1 >= level2/);
});
