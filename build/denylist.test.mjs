// Tests for the denylist review rule: checkDenylist(raw, now).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDenylist, denylistLog } from "./denylist.mjs";
import { intakePools } from "./intake.mjs";
import { readFileSync } from "node:fs";

const NOW = Date.parse("2026-10-19T12:00:00Z");
const entry = (o) => ({ id: "p1", reason: "deprecated by the venue", added: "2026-10-19", reviewBy: "2026-11-18", ...o });

test("dated entries load; plain string entries still load and are listed as undated", () => {
  const raw = {
    poolIds: [entry({ id: "dated" }), "plain-id"],
    keys: ["curve-dex|Ethereum|USDC-USDE", { key: "curve-dex|Base|USDC-USDT", reason: "dead pool", added: "2026-10-19", reviewBy: "2026-11-18" }],
    morphoVaults: [{ address: "0xBAD", reason: "deprecated", added: "2026-10-01", reviewBy: "2026-10-31" }],
  };
  const { denylist, expired, undated } = checkDenylist(raw, NOW);
  assert.deepEqual(expired, []);
  assert.deepEqual(denylist.keys, ["curve-dex|Ethereum|USDC-USDE", "curve-dex|Base|USDC-USDT"], "dated keys come out as plain strings");
  assert.deepEqual(denylist.morphoVaults, ["0xBAD"], "dated Morpho vaults come out as plain addresses");
  assert.deepEqual(undated.map((u) => u.value), ["plain-id", "curve-dex|Ethereum|USDC-USDE"]);
  // intake reads both forms
  const pool = (o) => ({ project: "aave-v3", chain: "Ethereum", symbol: "USDC", pool: "keep", underlyingTokens: [], tvlUsd: 5e6, apy: 4, ...o });
  const { pools } = intakePools([pool({}), pool({ pool: "dated" }), pool({ pool: "plain-id" })], {}, { denylist });
  assert.deepEqual(pools.map((p) => p.pool), ["keep"]);
});

test("an entry past its review-by date is listed as expired and its pool stays hidden", () => {
  const { denylist, expired } = checkDenylist({ poolIds: [entry({ id: "old", added: "2026-09-01", reviewBy: "2026-10-01" }), entry({ id: "today", reviewBy: "2026-10-19" })] }, NOW);
  assert.deepEqual(expired.map((e) => e.value), ["old"], "review-by today is not yet past");
  assert.equal(expired[0].reason, "deprecated by the venue");
  const pool = { project: "aave-v3", chain: "Ethereum", symbol: "USDC", pool: "old", underlyingTokens: [], tvlUsd: 5e6, apy: 4 };
  assert.equal(intakePools([pool], {}, { denylist }).pools.length, 0, "expiry never un-hides a pool");
});

test("a dated entry with a missing reason or a bad date fails at load", () => {
  assert.throws(() => checkDenylist({ poolIds: [entry({ reason: "" })] }, NOW), /reason/);
  assert.throws(() => checkDenylist({ poolIds: [entry({ reviewBy: "2026-13-01" })] }, NOW), /reviewBy/);
  assert.throws(() => checkDenylist({ poolIds: [entry({ added: "2026-12-01", reviewBy: "2026-12-31" })] }, NOW), /future/);
  assert.throws(() => checkDenylist({ poolIds: [entry({ reviewBy: "2026-10-01" })] }, NOW), /before/);
  assert.throws(() => checkDenylist({ keys: [{ reason: "x", added: "2026-10-19", reviewBy: "2026-11-18" }] }, NOW), /key/);
  assert.throws(() => checkDenylist({ poolIds: "abc" }, NOW), /array/);
  assert.throws(() => checkDenylist({ poolId: ["x"] }, NOW), /unknown list "poolId"/, "a misspelled list never hides nothing silently");
  assert.throws(() => checkDenylist({ poolIds: [entry({ reviewBy: "2099-01-01" })] }, NOW), /more than 30 days/);
  assert.doesNotThrow(() => checkDenylist({ poolIds: [entry({ reviewBy: "2026-11-18" })], _comment: "x" }, NOW));
  assert.throws(() => checkDenylist({ poolIds: ["  "] }, NOW), /blank/);
  assert.throws(() => checkDenylist({ poolIds: [entry({ id: " " })] }, NOW), /needs a "id"/);
  assert.throws(() => checkDenylist({ poolIds: [entry({ reason: "   " })] }, NOW), /reason/);
});

test("the build log names each expired entry, with a GitHub Actions warning in CI", () => {
  const { expired, undated } = checkDenylist({ poolIds: [entry({ id: "old", name: "Sky sDAI", added: "2026-09-01", reviewBy: "2026-10-01" })] }, NOW);
  assert.match(denylistLog(checkDenylist({ keys: ["a|b|c"] }, NOW), {})[1], /a|b|c has no reason or review-by date/);
  const local = denylistLog({ expired, undated }, {});
  assert.equal(local.length, 2);
  assert.match(local[0], /0 undated · 1 past review-by/);
  assert.match(local[1], /old.*Sky sDAI.*2026-10-01/);
  const ci = denylistLog({ expired, undated }, { GITHUB_ACTIONS: "true" });
  assert.ok(ci.some((l) => l.startsWith("::warning title=denylist-review::")));
  assert.deepEqual(denylistLog({ expired: [], undated: [] }, { GITHUB_ACTIONS: "true" }), ["  denylist: 0 undated · 0 past review-by"]);
});

test("the live denylist.json loads, every entry is dated and has a reason", () => {
  const raw = JSON.parse(readFileSync(new URL("./denylist.json", import.meta.url), "utf8"));
  const { denylist, undated } = checkDenylist(raw); // throws on a bad entry
  assert.deepEqual(undated, [], "no plain (undated) entries");
  for (const list of ["poolIds", "keys", "morphoVaults"])
    for (const e of raw[list]) assert.ok(e.reason.trim() && e.added && e.reviewBy, `${list} entry has reason + dates`);
  assert.ok(denylist.poolIds.every((x) => typeof x === "string"));
});
