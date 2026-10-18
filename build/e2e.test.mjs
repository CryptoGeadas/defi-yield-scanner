// End-to-end tests across modules: intake → pipeline → sticky → review sheet.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { intakePools } from "./intake.mjs";
import { runPipeline } from "./pipeline.mjs";
import { reviewSheet } from "./review-sheet.mjs";
import { vaultInfoFrom } from "./kamino-vaults.mjs";

const NOW = Date.parse("2026-10-16T00:00:00Z");
const DAY = 86_400_000;
const maps = {
  protocolMap: {
    "aave-v3": { bucket: "lend", access: "permissionless", level: 1 },
    "kamino-lend": { bucket: "lend", access: "permissionless", level: 1 },
    "uniswap-v3": { bucket: "LP", access: "permissionless", level: 1 },
  },
  stableMap: { USDC: { tier: 1, type: "fiat" }, USDT: { tier: 1, type: "fiat" } },
};
const feedPool = (o) => ({ project: "aave-v3", chain: "Ethereum", symbol: "USDC", poolMeta: null, stablecoin: true, underlyingTokens: ["0xa0b8"], tvlUsd: 500e6, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, count: 1000, ...o });
const factor = (row, name) => row.factors.find((f) => f.name === name);

test("intake → pipeline → sticky: Kamino and since dates reach the Age factor and the windows; state carries over", () => {
  const kamino = [{ address: "KV", name: "Young USDC", symbol: "USDC", mint: "EPj", tvl: 80e6, base: 4, reward: 0, mean30: 4, available: 60e6, createdAt: NOW - 10 * DAY }];
  const feed = [feedPool({ pool: "late", count: 20 })];
  const since = { pools: { late: "2024-01-01" } };
  const { pools } = intakePools(feed, { kamino }, { since, now: NOW });
  const cfg = (state) => ({ baseRate: 4, levelWindows: true, sticky: { state, now: NOW } });
  const r = runPipeline(pools, cfg({}), maps);
  const kv = r.windows[3].find((x) => x.pool === "KV");
  assert.equal(kv.levelDriver, "age", "a 10-day-old Kamino vault is Level 3 on Age");
  assert.equal(factor(r.windows[1].find((x) => x.pool === "late"), "age").level, 1, "the since date makes it old enough");
  assert.deepEqual(Object.keys(r.stickyState).sort(), ["KV", "late"]);
  const r2 = runPipeline(pools, cfg(r.stickyState), maps);
  assert.equal(r2.windows[3][0].pool, "KV");
});

test("Stability counts a reward jump; Yield ignores it", () => {
  const row = runPipeline([{ ...feedPool({ pool: "rw", apy: 8, apyBase: 4, apyReward: 4, apyMean30d: 4 }), legs: ["USDC"], ageDays: 1000 }], { baseRate: 4 }, maps).windows[1][0];
  assert.deepEqual([factor(row, "stability").value, factor(row, "stability").level], [100, 3]);
  assert.equal(factor(row, "yield").level, 1);
});

test("LP pools rate Yield on min(today, 30-day mean)", () => {
  const lp = (apy, apyMean30d) => runPipeline([{ ...feedPool({ pool: "lp", project: "uniswap-v3", symbol: "USDC-USDT", apy, apyBase: apy, apyMean30d, volumeUsd7d: 5e6 }), legs: ["USDC", "USDT"], ageDays: 1000 }], { baseRate: 4 }, maps).windows[1][0];
  assert.deepEqual([factor(lp(20, 5), "yield").value, factor(lp(20, 5), "yield").level], [1.25, 1]);
  assert.equal(factor(lp(3, 12), "yield").value, 0.75);
});

test("real pipeline output feeds the review sheet's near-cut flags", () => {
  const near = [
    feedPool({ pool: "size", tvlUsd: 48e6 }),
    feedPool({ pool: "age", ageDays: 170 }),
    feedPool({ pool: "yield", apy: 5.8, apyBase: 5.8, apyMean30d: 5.8 }), // 1.45×
    feedPool({ pool: "stab", apy: 5.12, apyBase: 5.12, apyMean30d: 4 }), // +28%
  ].map((p) => ({ ...p, legs: ["USDC"], ageDays: p.ageDays ?? 1000 }));
  const r = runPipeline(near, { baseRate: 4 }, maps);
  const shape = (w) => r.windows[w].map((x) => ({ ...x, poolId: x.pool, name: x.project }));
  const md = reviewSheet({ generatedAt: "t", baseRate: 4, config: r.config, windows: { 1: shape(1), 2: shape(2), 3: shape(3) } });
  for (const flag of ["size near $50.0m", "age near 180 days", "yield near 1.5×", "stability near +30%"]) assert.ok(md.includes(flag), flag);
});

test("Kamino vault rows: creationTimestamp seconds → ms; missing or 0 → null", () => {
  assert.equal(vaultInfoFrom({ state: { creationTimestamp: "1771118565" } }).createdAt, 1771118565000);
  assert.equal(vaultInfoFrom({ state: {} }).createdAt, null);
  assert.equal(vaultInfoFrom({ state: { creationTimestamp: 0 } }).createdAt, null);
  assert.equal(vaultInfoFrom({ state: { vaultAllocationStrategy: [{ reserve: "R", ctokenAllocation: "5" }] } }).allocations[0].ctokens, 5);
});

test("Stability +1 pp minimum survives pipeline → JSON → review sheet", () => {
  const pools = [
    feedPool({ pool: "tiny", apy: 0.18, apyBase: 0.18, apyMean30d: 0.09 }),
    feedPool({ pool: "big", apy: 6, apyBase: 6, apyMean30d: 4 }),
    feedPool({ pool: "edge", apy: 1.95, apyBase: 1.95, apyMean30d: 1 }),
  ].map((p) => ({ ...p, legs: ["USDC"], ageDays: 1000 }));
  const r = runPipeline(pools, { baseRate: 4, levelWindows: true }, maps);
  const all = [1, 2, 3].flatMap((w) => r.windows[w]);
  const st = (id) => factor(all.find((x) => x.pool === id), "stability");
  assert.deepEqual([st("tiny").value, st("tiny").level, st("tiny").risePp, st("tiny").belowMinPp], [100, 1, 0.09, true]);
  assert.equal(all.find((x) => x.pool === "tiny").level, 1, "a tiny rise alone no longer makes the pool Level 3");
  assert.equal(st("big").level, 2);
  const shape = (w) => r.windows[w].map((x) => ({ ...x, poolId: x.pool, name: x.project }));
  const data = JSON.parse(JSON.stringify({ generatedAt: "t", baseRate: 4, config: r.config, windows: { 1: shape(1), 2: shape(2), 3: shape(3) } }));
  assert.equal(data.config.riskCuts.stability.minPp, 1);
  const md = reviewSheet(data);
  assert.match(md, /rises under \+1 pp never count/);
  assert.equal(md.split("\n").filter((l) => /stability near \+1 pp/.test(l)).length, 1, "only the 0.95 pp pool is near the line");
});
