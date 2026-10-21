// End-to-end tests across modules: intake → pipeline → sticky → review sheet.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { intakePools } from "./intake.mjs";
import { runPipeline as run, DEFAULT_CONFIG } from "./pipeline.mjs";
// Row-value tests read the coin-Tier windows; tests about the switch set levelWindows themselves.
const runPipeline = (pools, config = {}, maps) => run(pools, { levelWindows: false, ...config }, maps);
import { reviewSheet } from "./review-sheet.mjs";
import { vaultInfoFrom } from "./kamino-vaults.mjs";
import { emptyLedger, addFlows } from "./flows.mjs";
import { makeSlim } from "./slim.mjs";

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

test("intake → pipeline → snapshot rows: every row has flows; a tracked vault carries its vault and numbers; flows never change levels", () => {
  const morpho = new Map([
    ["1|STEAKUSDC|0xa0b8", [{ address: "0xVAULT", assetSymbol: "USDC", assetDecimals: 6, name: "Steakhouse USDC", network: "ethereum", tvl: 500e6 }]],
    ["1|NEWUSDC|0xa0b8", [{ address: "0xNEW", assetSymbol: "USDC", assetDecimals: 6, name: "New USDC", network: "ethereum", tvl: 500e6 }]],
  ]);
  const fm = { ...maps, protocolMap: { ...maps.protocolMap, "morpho-blue": { bucket: "vault", access: "permissionless", level: 1 } } };
  const feed = [feedPool({ pool: "v", project: "morpho-blue", symbol: "STEAKUSDC" }), feedPool({ pool: "n", project: "morpho-blue", symbol: "NEWUSDC" }), feedPool({ pool: "a" })];
  const ledger = addFlows(emptyLedger(), {
    chain: "ethereum", today: "2026-10-21", lastBlock: 1, tracked: [{ address: "0xvault", decimals: 6 }], backfill: true,
    events: [{ vault: "0xvault", day: "2026-10-20", kind: "out", amount: 7e6 }],
  });
  const cfg = { baseRate: 4, levelWindows: true, sticky: { state: {}, now: NOW } };
  const withVault = runPipeline(intakePools(feed, { morpho }, { now: NOW }).pools, cfg, fm);
  const rows = [1, 2, 3].flatMap((w) => withVault.windows[w]);
  const slim = makeSlim({}, {}, { curve: new Map(), morpho: new Map() }, {}, ledger);
  const snap = Object.fromEntries(rows.map((r) => [r.pool, slim(r)]));
  assert.equal(Object.keys(snap).length, 3);
  assert.ok(Object.values(snap).every((s) => ["ok", "collecting", "untracked"].includes(s.flows?.status)), "every snapshot row has flows");
  assert.deepEqual(snap.v.vault, { chain: "ethereum", address: "0xvault", decimals: 6 }, "the flows job reads this list");
  assert.deepEqual(snap.v.flows, { status: "ok", in30: 0, out30: 7e6, net7: -7e6, net30: -7e6, maxOut30: 7e6, asOf: "2026-10-21" });
  assert.equal(snap.n.flows.status, "collecting", "tracked but not in the ledger yet");
  assert.deepEqual(snap.a.flows, { status: "untracked" });
  assert.equal(snap.a.vault, null);
  // same pools without the vault address: the levels are identical, so flows play no part in them
  const noVault = runPipeline(intakePools(feed, { morpho }, { now: NOW }).pools.map((p) => ({ ...p, vault: null })), cfg, fm);
  const lv = (r) => Object.fromEntries([1, 2, 3].flatMap((w) => r.windows[w]).map((x) => [x.pool, [x.level, x.levelDriver, JSON.stringify(x.factors)]]));
  assert.deepEqual(lv(withVault), lv(noVault));
  assert.equal(withVault.config.flowsCard, false, "the card switch is off by default");
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

// ── LP rows organic only (#28) ──────────────────────────────────────────────
test("LP rows: headline is organic only — min(today's apyBase, 30-day mean minus rewards); rewards in the rewards field", () => {
  const lp = (o) => runPipeline([{ ...feedPool({ pool: "lp", project: "uniswap-v3", symbol: "USDC-USDT", volumeUsd7d: 5e6, ...o }), legs: ["USDC", "USDT"], ageDays: 1000 }], { baseRate: 4 }, maps).windows[1][0];
  const slip = lp({ apy: 28.07, apyBase: 10.62, apyReward: 17.45, apyMean30d: 66.71 }); // Slipstream-like
  const r2 = (n) => Math.round(n * 100) / 100;
  assert.deepEqual([slip.base, r2(slip.reward)], [10.62, 17.45]);
  assert.equal(Math.round(slip.total * 100) / 100, 28.07);
  const v1 = lp({ apy: 46.71, apyBase: 0, apyReward: 46.71, apyMean30d: 26.01 }); // all rewards
  assert.deepEqual([v1.base, v1.reward], [0, 46.71], "a reward-only LP pool shows 0 organic, rewards in the tail");
  assert.equal(factor(v1, "yield").value, 0);
  const meanLow = lp({ apy: 12, apyBase: 8, apyReward: 4, apyMean30d: 9 }); // mean 9 − rewards 4 = 5 < 8
  assert.equal(meanLow.base, 5);
  assert.equal(factor(meanLow, "yield").value, 1.25, "Yield rates the same organic figure");
  const noBase = lp({ apy: 10, apyBase: null, apyReward: 3, apyMean30d: 20 }); // organic = apy − reward; today wins
  assert.deepEqual([noBase.base, noBase.reward], [7, 3]);
  assert.equal(lp({ apy: 10, apyBase: null, apyReward: 3, apyMean30d: 8 }).base, 5, "mean 8 − rewards 3 wins");
  assert.equal(meanLow.total, 9, "total = base + reward, not spot");
  assert.equal(v1.total, 46.71);
  const noMean = lp({ apy: 10, apyBase: 6, apyReward: 4, apyMean30d: null });
  assert.deepEqual([noMean.base, noMean.reward, noMean.total, factor(noMean, "yield").value], [6, 4, 10, 1.5], "no 30-day mean → today's organic");
  const fresh = lp({ apy: 10, apyBase: 6, apyReward: 4, apyMean30d: 3 }); // rewards started recently
  assert.equal(fresh.base, 6, "a mean not above today's rewards → today's organic, not 0");
  assert.equal(slip.divFlag, "▼", "the trend flag still compares total spot vs total mean");
  assert.equal(Math.round(slip.divRatio * 1000) / 1000, Math.round(((28.07 - 66.71) / 66.71) * 1000) / 1000);
  const jump = lp({ apy: 12, apyBase: 4, apyReward: 8, apyMean30d: 4 });
  assert.deepEqual([factor(jump, "stability").value, jump.base], [200, 4], "Stability counts a total rise; the headline stays organic");
});

test("LP rows without rewards are unchanged: min(today, 30-day mean)", () => {
  const lp = (apy, apyMean30d) => runPipeline([{ ...feedPool({ pool: "lp", project: "uniswap-v3", symbol: "USDC-USDT", apy, apyBase: apy, apyReward: null, apyMean30d, volumeUsd7d: 5e6 }), legs: ["USDC", "USDT"], ageDays: 1000 }], { baseRate: 4 }, maps).windows[1][0];
  assert.deepEqual([lp(20, 5).base, lp(20, 5).reward], [5, 0]);
  assert.deepEqual([lp(3, 12).base, lp(3, 12).reward, lp(3, 12).total], [3, 0, 3]);
  assert.deepEqual([lp(3, null).base, lp(3, null).reward, lp(3, null).total], [3, 0, 3], "no 30-day mean → today");
});

test("a reward-only LP row sorts below a plain lending row (ranked on organic yield)", () => {
  const lend = { ...feedPool({ pool: "lend", apy: 4, apyBase: 4, apyMean30d: 4 }), legs: ["USDC"], ageDays: 1000 };
  const lp = { ...feedPool({ pool: "lp", project: "uniswap-v3", symbol: "USDC-USDT", apy: 46.71, apyBase: 0, apyReward: 46.71, apyMean30d: 26.01, volumeUsd7d: 5e6 }), legs: ["USDC", "USDT"], ageDays: 1000 };
  assert.deepEqual(runPipeline([lp, lend], { baseRate: 4 }, maps).windows[1].map((x) => x.pool), ["lend", "lp"]);
});
