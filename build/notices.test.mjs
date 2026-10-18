// Tests for page notices (missing venue data) and their GitHub Actions warnings.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { venueNotices, actionsWarnings, noticeLog } from "./notices.mjs";
import { fetchKaminoVaults } from "./kamino-vaults.mjs";
import { intakePools } from "./intake.mjs";

test("Kamino returning no vaults → a notice; a normal run → none", () => {
  assert.deepEqual(venueNotices({ kamino: [] }), [{ id: "kamino-unavailable", text: "Kamino data unavailable at this refresh." }]);
  assert.deepEqual(venueNotices({ kamino: null }), venueNotices({ kamino: [] }), "a missing list counts as a full failure");
  assert.deepEqual(venueNotices({}), venueNotices({ kamino: [] }));
  assert.deepEqual(venueNotices({ kamino: [{ address: "KV" }] }), []);
});

test("each notice becomes one GitHub Actions warning line", () => {
  assert.deepEqual(actionsWarnings([{ id: "kamino-unavailable", text: "Kamino data unavailable at this refresh." }]),
    ["::warning title=kamino-unavailable::Kamino data unavailable at this refresh."]);
  assert.deepEqual(actionsWarnings([]), []);
  assert.deepEqual(actionsWarnings([{ id: "x", text: "a\nb%c" }]), ["::warning title=x::a%0Ab%25c"], "message is escaped for the workflow command");
});

test("warning titles escape : and , (workflow-command property rules)", () => {
  assert.deepEqual(actionsWarnings([{ id: "venue:x,y", text: "t" }]), ["::warning title=venue%3Ax%2Cy::t"]);
});

test("noticeLog: a log line per notice; the Actions warning only in CI", () => {
  const n = venueNotices({ kamino: [] });
  assert.deepEqual(noticeLog(n, {}), ["  ⚠ notice: Kamino data unavailable at this refresh."]);
  assert.deepEqual(noticeLog(n, { GITHUB_ACTIONS: "true" }), [
    "  ⚠ notice: Kamino data unavailable at this refresh.",
    "::warning title=kamino-unavailable::Kamino data unavailable at this refresh.",
  ]);
  assert.deepEqual(noticeLog(venueNotices({ kamino: [{}] }), { GITHUB_ACTIONS: "true" }), []);
});

// fetchKaminoVaults with fetch stubbed (no network): every failure ends as [] → the notice.
const stubFetch = (impl) => mock.method(globalThis, "fetch", impl);
const quiet = () => { mock.method(console, "warn", () => {}); mock.method(console, "log", () => {}); };
const json = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });

test("Kamino: all RPCs down → [] (no throw)", async (t) => {
  t.after(() => mock.restoreAll()); quiet();
  stubFetch(async () => { throw new Error("ECONNREFUSED"); });
  assert.deepEqual(await fetchKaminoVaults(new Set(["USDC"])), []);
});

test("Kamino: RPC answers with an unexpected shape → [] (no throw), so the build still publishes", async (t) => {
  t.after(() => mock.restoreAll()); quiet();
  stubFetch(async () => json({ result: { context: {}, value: [] } })); // not an array
  assert.deepEqual(await fetchKaminoVaults(new Set(["USDC"])), []);
  mock.restoreAll(); quiet();
  stubFetch(async () => json({ result: [{ pubkey: "X" }] })); // account without data
  assert.deepEqual(await fetchKaminoVaults(new Set(["USDC"])), []);
});

test("Kamino: RPC rate-limited (429) → []", async (t) => {
  t.after(() => mock.restoreAll()); quiet();
  stubFetch(async () => json({}, false, 429));
  assert.deepEqual(await fetchKaminoVaults(new Set(["USDC"])), []);
});

test("Kamino unavailable → a notice and no Kamino rows at all (DefiLlama isolated markets still dropped)", () => {
  const feed = [
    { pool: "km", project: "kamino-lend", chain: "Solana", symbol: "USDC", stablecoin: true, tvlUsd: 5e6, apy: 4, apyBase: 4 },
    { pool: "other", project: "aave-v3", chain: "Ethereum", symbol: "USDC", stablecoin: true, tvlUsd: 5e6, apy: 4, apyBase: 4 },
  ];
  for (const kamino of [[], undefined]) {
    const venues = { kamino };
    const { pools, report } = intakePools(feed, venues);
    assert.equal(venueNotices(venues).length, 1);
    assert.equal(pools.filter((p) => p.project === "kamino-lend").length, 0);
    assert.ok(pools.find((p) => p.pool === "other"));
    assert.deepEqual([report.kaminoDropped, report.kaminoAdded], [1, 0]);
  }
});
