// Tests for pool intake, through its one interface: intakePools(feed, venues, curation).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { intakePools } from "./intake.mjs";
import { runPipeline as run, DEFAULT_CONFIG } from "./pipeline.mjs";
// Row-value tests read the coin-Tier windows; tests about the switch set levelWindows themselves.
const runPipeline = (pools, config = {}, maps) => run(pools, { levelWindows: false, ...config }, maps);
import { buildLink } from "./deeplinks.mjs";

const pool = (o) => ({
  project: "aave-v3", chain: "Ethereum", symbol: "USDC", poolMeta: null, pool: "p-" + Math.random(),
  underlyingTokens: ["0xa0b8"], stablecoin: true, tvlUsd: 5e6, apy: 4, apyBase: 4, apyReward: null,
  apyMean30d: 4, ...o,
});
const byId = (pools, id) => pools.find((p) => p.pool === id);

test("plain pools get legs from their symbol and a symbol · market label", () => {
  const feed = [
    pool({ pool: "a", symbol: "USDC-USDT", poolMeta: null }),
    pool({ pool: "b", symbol: "USDC", poolMeta: "Core" }),
    pool({ pool: "c", symbol: "USDC", poolMeta: "usdc" }),
  ];
  const before = JSON.stringify(feed);
  const { pools } = intakePools(feed);
  assert.deepEqual(byId(pools, "a").legs, ["USDC", "USDT"]);
  assert.equal(byId(pools, "a").label, "USDC-USDT");
  assert.equal(byId(pools, "b").label, "USDC · Core");
  assert.equal(byId(pools, "c").label, "USDC", "meta that repeats the symbol is dropped");
  assert.equal(byId(pools, "a").exactUrl, null);
  assert.equal(JSON.stringify(feed), before, "the feed is never mutated");
});

test("denylist hides pools by id or project|chain|SYMBOL, case-insensitively", () => {
  const feed = [pool({ pool: "KEEP" }), pool({ pool: "Gone-1" }), pool({ pool: "x", project: "curve-dex", symbol: "USDC-USDE" })];
  const { pools, report } = intakePools(feed, {}, { denylist: { poolIds: ["gone-1"], keys: ["CURVE-DEX|ethereum|usdc-usde"] } });
  assert.deepEqual(pools.map((p) => p.pool), ["KEEP"]);
  assert.equal(report.denied, 2);
});

test("Morpho share tokens resolve to their underlying stable, vault name and URL", () => {
  const morpho = new Map([
    ["1|STEAKUSDC|0xa0b8", [{ address: "0xV1", assetSymbol: "USDC", name: "Steakhouse USDC", network: "ethereum", tvl: 9e6 }]],
    ["1|GTUSDC|0xa0b8", [{ address: "0xBAD", assetSymbol: "USDC", name: "Gauntlet USDC Frontier", network: "ethereum", tvl: 5e6 }]],
  ]);
  const feed = [
    pool({ pool: "big", project: "morpho-blue", symbol: "STEAKUSDC", tvlUsd: 9e6 }),
    pool({ pool: "small", project: "morpho-blue", symbol: "steakUSDC", tvlUsd: 2e6 }),
    pool({ pool: "denied", project: "morpho-blue", symbol: "GTUSDC" }),
  ];
  const { pools, report } = intakePools(feed, { morpho }, { denylist: { morphoVaults: ["0xbad"] } });

  const big = byId(pools, "big");
  assert.deepEqual(big.legs, ["USDC"]);
  assert.equal(big.label, "Steakhouse USDC");
  assert.equal(big.exactUrl, "https://app.morpho.org/ethereum/vault/0xV1");
  assert.equal(big.symbol, "STEAKUSDC", "the raw symbol is left alone");
  assert.deepEqual(byId(pools, "small").legs, ["STEAKUSDC"], "one pool per vault: the largest wins");
  assert.equal(byId(pools, "denied"), undefined, "denylisted vault is dropped");
  assert.equal(report.morphoVaults, 1);
});

test("Morpho: a V1 and V2 vault sharing a symbol resolve to the one whose TVL matches DefiLlama", () => {
  const vault = (address, tvl) => ({ address, assetSymbol: "USDC", name: "Kabu USDC", network: "ethereum", tvl });
  const morpho = new Map([["1|KABUUSDC|0xa0b8", [vault("0xOLDV1", 0.03), vault("0xNEWV2", 1.37e6)]]]);
  const { pools } = intakePools([pool({ pool: "k", project: "morpho-blue", symbol: "KABUUSDC", tvlUsd: 1.368e6 })], { morpho });
  assert.equal(byId(pools, "k").exactUrl, "https://app.morpho.org/ethereum/vault/0xNEWV2");
  assert.equal(byId(pools, "k").linkGuarded, false);
});

test("Morpho link guard: a vault whose TVL is >2x away from DefiLlama's gets no exact URL", () => {
  const vault = (address, tvl) => [{ address, assetSymbol: "USDC", name: "Some USDC", network: "base", tvl }];
  const morpho = new Map([
    ["8453|LOWUSDC|0xa0b8", vault("0xLOW", 9e3)],     // DefiLlama 462m, vault 9k
    ["8453|HIGHUSDC|0xa0b8", vault("0xHIGH", 30e6)],  // DefiLlama 10m, vault 30m
    ["8453|EDGEUSDC|0xa0b8", vault("0xEDGE", 2e6)],   // exactly 2x → still trusted
    ["8453|NOTVL|0xa0b8", vault("0xNOTVL", 0)],       // unknown TVL → fail closed
  ]);
  const feed = [
    pool({ pool: "low", chain: "Base", project: "morpho-blue", symbol: "LOWUSDC", tvlUsd: 462e6 }),
    pool({ pool: "high", chain: "Base", project: "morpho-blue", symbol: "HIGHUSDC", tvlUsd: 10e6 }),
    pool({ pool: "edge", chain: "Base", project: "morpho-blue", symbol: "EDGEUSDC", tvlUsd: 1e6 }),
    pool({ pool: "notvl", chain: "Base", project: "morpho-blue", symbol: "NOTVL", tvlUsd: 1e6 }),
  ];
  const { pools, report } = intakePools(feed, { morpho });
  for (const id of ["low", "high", "notvl"]) {
    assert.equal(byId(pools, id).exactUrl, null, id);
    assert.equal(byId(pools, id).linkGuarded, true, id);
    assert.deepEqual(byId(pools, id).legs, ["USDC"], "a guarded pool is still tiered on its asset");
  }
  assert.equal(byId(pools, "edge").exactUrl, "https://app.morpho.org/base/vault/0xEDGE");
  assert.deepEqual(report.morphoGuarded.map((g) => g.address).sort(), ["0xHIGH", "0xLOW", "0xNOTVL"]);

  const link = buildLink({ ...byId(pools, "low"), access: "permissionless" }, { siteUrl: "https://app.morpho.org" });
  assert.deepEqual(link, { url: "https://defillama.com/yields/pool/low", kind: "defillama" }, "guarded → DefiLlama, not the site");
});

test("Yearn vaults are named from the registry via their curated deposit URL", () => {
  const yearn = new Map([["1|0xabc", "Morpho Yearn OG USDC Compounder"]]);
  const feed = [pool({ pool: "y1", project: "yearn-finance" }), pool({ pool: "y2", project: "yearn-finance" })];
  const { pools, report } = intakePools(feed, { yearn }, { poolUrls: { y1: "https://yearn.fi/v3/1/0xABC" } });
  assert.equal(byId(pools, "y1").label, "Morpho Yearn OG USDC Compounder");
  assert.equal(byId(pools, "y2").label, "USDC", "no curated URL → default label");
  assert.deepEqual(byId(pools, "y1").legs, ["USDC"]);
  assert.equal(report.yearnNamed, 1);
});

test("Kamino isolated markets are replaced by the on-chain lending vaults", () => {
  const feed = [pool({ pool: "km", project: "kamino-lend", chain: "Solana" }), pool({ pool: "other" })];
  const kamino = [
    { address: "KV1", name: "Steakhouse USDC", symbol: "USDC", mint: "EPj", tvl: 3e6, base: 5, reward: 1.5, mean30: 5.2, apy7: 5.1 },
    { address: "KV2", name: "Allez USDG", symbol: "USDG", mint: "2u1", tvl: 2e6, base: 4, reward: 0, mean30: 4, apy7: null },
    { address: "KV3", name: "Hidden", symbol: "USDC", mint: "EPj", tvl: 2e6, base: 4, reward: 0, mean30: 4 },
  ];
  const { pools, report } = intakePools(feed, { kamino }, { denylist: { poolIds: ["kv3"] } });
  assert.equal(byId(pools, "km"), undefined);
  const v1 = byId(pools, "KV1");
  assert.deepEqual(v1.legs, ["USDC"]);
  assert.equal(v1.label, "Steakhouse USDC");
  assert.equal(v1.exactUrl, "https://app.kamino.finance/lend/KV1");
  assert.equal(v1.apy, 6.5);
  assert.equal(byId(pools, "KV2").apyReward, null, "zero rewards read as no rewards");
  assert.equal(byId(pools, "KV3"), undefined, "denylist applies to venue-added pools too");
  assert.deepEqual([report.kaminoDropped, report.kaminoAdded], [1, 2]);
});

test("lending pools show total deposits as TVL, other pools keep DefiLlama's TVL", () => {
  const feed = [
    pool({ pool: "aave", tvlUsd: 376e6 }),                                   // net of loans in the feed
    pool({ pool: "uni", project: "uniswap-v3", symbol: "USDC-USDT", tvlUsd: 9e6 }), // not a lending pool
    pool({ pool: "odd", tvlUsd: 50e6 }),                                     // supply below net → bad data
  ];
  const lendBorrow = new Map([["aave", 2829e6], ["odd", 10e6]]);
  const before = JSON.stringify(feed);
  const { pools, report } = intakePools(feed, { lendBorrow });
  assert.equal(byId(pools, "aave").tvlUsd, 2829e6);
  assert.equal(byId(pools, "uni").tvlUsd, 9e6);
  assert.equal(byId(pools, "odd").tvlUsd, 50e6, "a total below the net figure is ignored");
  assert.equal(report.lendingTotals, 1);
  assert.equal(JSON.stringify(feed), before, "the feed is never mutated");
});

test("a kept lending row carries total deposits as its TVL", () => {
  const maps = { protocolMap: { "aave-v3": { bucket: "lend", access: "permissionless" } }, stableMap: { USDC: { tier: 1, type: "fiat" } } };
  const feed = [pool({ pool: "busy", tvlUsd: 1.2e6 })]; // most of it is lent out, $1.2M still withdrawable
  const { pools } = intakePools(feed, { lendBorrow: new Map([["busy", 3e6]]) });
  const kept = runPipeline(pools, {}, maps).windows[1];
  assert.equal(kept.length, 1);
  assert.equal(kept[0].tvlUsd, 3e6, "the row the site shows and sorts by carries the total");
});

test("a lending pool needs $1M available to withdraw, not only $1M of deposits", () => {
  const maps = {
    protocolMap: { "euler-v2": { bucket: "lend", access: "permissionless" }, "uniswap-v3": { bucket: "LP", access: "permissionless" } },
    stableMap: { USDC: { tier: 1, type: "fiat" }, USDT: { tier: 1, type: "fiat" } },
  };
  const feed = [
    pool({ pool: "drained", project: "euler-v2", tvlUsd: 0, apy: 17.5, apyBase: 17.5, apyMean30d: 17.5 }), // 100% borrowed
    pool({ pool: "thin", project: "euler-v2", tvlUsd: 0.3e6 }),
    pool({ pool: "ok", project: "euler-v2", tvlUsd: 1.5e6 }),
    pool({ pool: "lp", project: "uniswap-v3", symbol: "USDC-USDT", tvlUsd: 2e6, volumeUsd7d: 1e6 }),
  ];
  const lendBorrow = new Map([["drained", 1.46e6], ["thin", 2.6e6], ["ok", 9e6]]);
  const r = runPipeline(intakePools(feed, { lendBorrow }).pools, {}, maps);
  assert.deepEqual(r.windows[1].map((x) => x.pool).sort(), ["lp", "ok"]);
  assert.equal(r.rejects["no-exit-liquidity"].count, 2);
  assert.equal(r.windows[1].find((x) => x.pool === "ok").tvlUsd, 9e6, "TVL still shows total deposits");
});

test("missing venue data degrades to default identities, never throws", () => {
  const feed = [pool({ pool: "m", project: "morpho-blue", symbol: "STEAKUSDC" }), pool({ pool: "y", project: "yearn-finance" })];
  const { pools } = intakePools(feed, { morpho: new Map(), yearn: undefined, kamino: undefined });
  assert.deepEqual(byId(pools, "m").legs, ["STEAKUSDC"]);
  assert.equal(byId(pools, "y").label, "USDC");
});

test("the pipeline tiers on identity legs, not on the symbol", () => {
  const maps = {
    protocolMap: { "morpho-blue": { bucket: "vault", access: "permissionless" } },
    stableMap: { USDC: { tier: 1, type: "fiat" } },
  };
  const morpho = new Map([["1|STEAKUSDC|0xa0b8", [{ address: "0xV1", assetSymbol: "USDC", name: "Steakhouse USDC", network: "ethereum", tvl: 5e6 }]]]);
  const { pools } = intakePools([pool({ pool: "v", project: "morpho-blue", symbol: "STEAKUSDC" })], { morpho });
  const r = runPipeline(pools, {}, maps);
  assert.equal(r.windows[1].length, 1);
  assert.equal(r.windows[1][0].label, "Steakhouse USDC");

  const bare = runPipeline([{ ...pools[0], legs: undefined }], {}, maps);
  assert.equal(bare.rejects["missing-identity"].count, 1, "a pool without identity is rejected, not guessed");
});

// ── Kamino exit liquidity (#24) ─────────────────────────────────────────────
import { withdrawableUsd } from "./kamino-vaults.mjs";

test("Kamino withdrawable = idle cash + what each reserve can pay back", () => {
  const reserveFree = new Map([["R1", 50e6], ["R2", 0.1e6]]);
  // $20M invested, split 3:1 by cToken share → $15M in R1, $5M in R2 (only $0.1M free)
  const allocations = [{ reserve: "R1", ctokens: 3 }, { reserve: "R2", ctokens: 1 }];
  assert.equal(withdrawableUsd({ idleUsd: 0.08e6, investedUsd: 20e6, allocations, reserveFree }), 0.08e6 + 15e6 + 0.1e6);
});

test("Kamino withdrawable is unknown (null) when allocation or reserve data is missing", () => {
  const reserveFree = new Map([["R1", 50e6]]);
  assert.equal(withdrawableUsd({ idleUsd: 1, investedUsd: 20e6, allocations: null, reserveFree }), null);
  assert.equal(withdrawableUsd({ idleUsd: 1, investedUsd: 20e6, allocations: [{ reserve: "RX", ctokens: 1 }], reserveFree }), null);
  assert.equal(withdrawableUsd({ idleUsd: 2e6, investedUsd: 0, allocations: [], reserveFree }), 2e6, "nothing invested → idle cash");
});

test("a Kamino vault with < $1M withdrawable is rejected; unknown withdrawable keeps the vault", () => {
  const maps = { protocolMap: { "kamino-lend": { bucket: "lend", access: "permissionless" } }, stableMap: { USDC: { tier: 1, type: "fiat" } } };
  const v = (address, available) => ({ address, name: address, symbol: "USDC", mint: "EPj", tvl: 20e6, base: 5, reward: 0, mean30: 5, available });
  const { pools } = intakePools([], { kamino: [v("DRAINED", 0.2e6), v("OK", 15e6), v("UNKNOWN", null)] });
  const r = runPipeline(pools, {}, maps);
  assert.deepEqual(r.windows[1].map((x) => x.pool).sort(), ["OK", "UNKNOWN"]);
  assert.equal(r.rejects["no-exit-liquidity"].count, 1);
});

test("Kamino withdrawable edge cases: failed reserve data, empty slots, invested with no cTokens", () => {
  const R1 = new Map([["R1", 0.2e6]]);
  assert.equal(withdrawableUsd({ idleUsd: 1, investedUsd: 20e6, allocations: [{ reserve: "R1", ctokens: 1 }], reserveFree: null }), null, "reserve fetch failed → unknown");
  assert.equal(
    withdrawableUsd({ idleUsd: 0.1e6, investedUsd: 20e6, allocations: [{ reserve: "R1", ctokens: 1 }, { reserve: "RX", ctokens: 0 }], reserveFree: R1 }),
    0.3e6,
    "an empty slot with no reserve data is ignored, so a drained vault is still caught"
  );
  assert.equal(withdrawableUsd({ idleUsd: 2e6, investedUsd: 20e6, allocations: [], reserveFree: new Map() }), null, "invested but no cTokens → unknown");
});

import { reserveFreeFrom } from "./kamino-vaults.mjs";
test("reserve rows with missing or inconsistent figures are unknown, never 0 free", () => {
  const { free, bad } = reserveFreeFrom([
    { reserve: "OK", totalSupplyUsd: "10", totalBorrowUsd: "4" },
    { reserve: "NOSUPPLY", totalBorrowUsd: "4" },
    { reserve: "NOBORROW", totalSupplyUsd: "10" },
    { reserve: "OVERBORROWED", totalSupplyUsd: "10", totalBorrowUsd: "50" },
  ]);
  assert.deepEqual([...free], [["OK", 6]]);
  assert.equal(bad, 3);
});

// ── pool age (#14) ──────────────────────────────────────────────────────────
test("intake gives every pool its age: since override, Kamino creation date, DefiLlama count, or unknown", () => {
  const now = Date.parse("2026-10-15T00:00:00Z");
  const feed = [pool({ pool: "tracked", count: 400 }), pool({ pool: "late", count: 20 }), pool({ pool: "new" })];
  const kamino = [
    { address: "KV", name: "Steakhouse USDC", symbol: "USDC", mint: "EPj", tvl: 3e6, base: 5, reward: 0, mean30: 5, createdAt: now - 560 * 86_400_000 },
    { address: "KV0", name: "No Date USDC", symbol: "USDC", mint: "EPj", tvl: 3e6, base: 5, reward: 0, mean30: 5, createdAt: null },
  ];
  const since = { pools: { late: "2024-10-15" } };
  const { pools } = intakePools(feed, { kamino }, { since, now });
  const age = (id) => [byId(pools, id).ageDays, byId(pools, id).ageSource];
  assert.deepEqual(age("tracked"), [400, "defillama"]);
  assert.deepEqual(age("late"), [730, "since"]);
  assert.deepEqual(age("new"), [null, null]);
  assert.deepEqual(age("KV"), [560, "venue"]);
  assert.deepEqual(age("KV0"), [null, null], "a vault with no creation date is unknown, not ancient");
});

test("since.json keys that match no pool are reported", () => {
  const { report } = intakePools([pool({ pool: "a" })], {}, { since: { pools: { a: "2024-01-01", typo: "2024-01-01" }, protocols: { midas: "2024-01-01" } }, now: Date.parse("2026-10-15") });
  assert.deepEqual(report.sinceUnused, ["pools.typo", "protocols.midas"]);
});
