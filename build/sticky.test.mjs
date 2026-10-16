// Tests for sticky levels, through applySticky(state, rows, now) and runPipeline.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { applySticky } from "./sticky.mjs";
import { runPipeline } from "./pipeline.mjs";

const H = 3_600_000, DAY = 24 * H;
const T0 = Date.parse("2026-10-16T00:00:00Z");
const row = (id, level, tier = 1) => ({ id, level, tier });

// Run the same pool through a series of (computed level, time) steps; return shown levels.
function series(steps, start = { state: {} }) {
  let state = start.state;
  return steps.map(([level, t, tier = 1]) => {
    const r = applySticky(state, [row("p", level, tier)], t);
    state = r.state;
    return r.shown.get("p");
  });
}

test("a new pool starts at its computed level", () => {
  assert.deepEqual(series([[2, T0]]), [2]);
});

test("down: one worse run does not move a pool; two in a row do", () => {
  assert.deepEqual(series([[1, T0], [3, T0 + 6 * H], [1, T0 + 12 * H]]), [1, 1, 1], "one bad run, then back");
  assert.deepEqual(series([[1, T0], [3, T0 + 6 * H], [3, T0 + 12 * H]]), [1, 1, 3]);
  assert.deepEqual(series([[1, T0], [2, T0 + 6 * H], [3, T0 + 12 * H]]), [1, 1, 3], "two worse runs move to the latest level");
});

test("up: six better days do not promote; seven do; a broken streak resets", () => {
  const up = (days) => [[3, T0], ...Array.from({ length: days + 1 }, (_, d) => [1, T0 + 6 * H + d * DAY])];
  assert.equal(series(up(6)).at(-1), 3, "6 days after the first better run");
  assert.equal(series(up(7)).at(-1), 1, "7 days after the first better run");
  const broken = [[3, T0], [1, T0 + DAY], [3, T0 + 4 * DAY], [1, T0 + 5 * DAY], [1, T0 + 9 * DAY]];
  assert.equal(series(broken).at(-1), 3, "the streak restarted on day 5, so day 9 is only 4 days in");
});

test("a coin tier change moves the pool at once", () => {
  assert.deepEqual(series([[1, T0, 1], [3, T0 + 6 * H, 3]]), [1, 3]);
});

test("pools missing from the feed drop out of the state after 7 days", () => {
  const a = applySticky({}, [row("p", 1), row("q", 2)], T0);
  const b = applySticky(a.state, [row("p", 1)], T0 + 8 * DAY);
  assert.deepEqual(Object.keys(b.state), ["p"]);
});

test("the pipeline groups windows by the shown (sticky) level and returns the next state", () => {
  const maps = { protocolMap: { "aave-v3": { bucket: "lend", access: "permissionless", level: 1 } }, stableMap: { USDC: { tier: 1, type: "fiat" } } };
  const p = (tvlUsd) => ({ project: "aave-v3", chain: "Ethereum", symbol: "USDC", pool: "p", stablecoin: true, legs: ["USDC"], tvlUsd, ageDays: 1000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4 });
  const cfg = (state, now) => ({ baseRate: 4, levelWindows: true, sticky: { state, now } });
  const r1 = runPipeline([p(500e6)], cfg({}, T0), maps);
  assert.equal(r1.windows[1][0].level, 1);
  const r2 = runPipeline([p(2e6)], cfg(r1.stickyState, T0 + 6 * H), maps); // computed Level 3, first bad run
  assert.equal(r2.windows[1][0].level, 1, "still shown in Level 1");
  assert.equal(r2.windows[1][0].levelComputed, 3);
  const r3 = runPipeline([p(2e6)], cfg(r2.stickyState, T0 + 12 * H), maps);
  assert.equal(r3.windows[3][0].level, 3, "second bad run moves it");
});

test("re-runs minutes apart do not count as two worse runs; bad state entries start fresh", () => {
  assert.deepEqual(series([[1, T0], [3, T0 + 6 * H], [3, T0 + 6 * H + 10 * 60_000]]), [1, 1, 1], "a re-run 10 minutes later is not a second run");
  assert.deepEqual(series([[1, T0], [3, T0 + 6 * H], [3, T0 + 6 * H + 10 * 60_000], [3, T0 + 12 * H]]), [1, 1, 1, 3]);
  const bad = { p: { shown: 7, tier: 1, down: "x" } };
  assert.equal(applySticky(bad, [row("p", 2)], T0).shown.get("p"), 2);
});

test("more sticky rules: better coin Tier moves at once; mixed runs reset streaks; a one-run gap keeps the state", () => {
  assert.deepEqual(series([[3, T0, 3], [1, T0 + 6 * H, 1]]), [3, 1], "coin Tier improved → at once");
  assert.deepEqual(series([[1, T0], [3, T0 + 6 * H], [1, T0 + 12 * H], [3, T0 + 18 * H]]), [1, 1, 1, 1], "a better run resets the down count");
  const upBroken = [[3, T0], [1, T0 + DAY], [3, T0 + 3 * DAY], [1, T0 + 4 * DAY], [1, T0 + 8 * DAY]];
  assert.equal(series(upBroken).at(-1), 3, "a run back at the shown level resets the 7-day clock");
  const a = applySticky({}, [row("p", 3)], T0);
  const gap = applySticky(a.state, [], T0 + 6 * H);
  assert.ok("p" in gap.state, "kept while missing for one run");
  assert.equal(applySticky(gap.state, [row("p", 1)], T0 + 12 * H).shown.get("p"), 3, "back next run: still has to earn its way up");
  assert.ok(!("p" in applySticky(a.state, [], T0 + 8 * DAY).state), "dropped after 7 days missing");
  const r = applySticky({ p: { shown: 1, tier: 1, down: 0, upSince: "soon" } }, [row("p", 2)], T0);
  assert.equal(r.invalid, 1);
  assert.throws(() => applySticky({}, [row("p", 4)], T0), /must be 1, 2 or 3/);
});
