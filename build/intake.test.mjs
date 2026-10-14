// Tests for pool intake, through its one interface: intakePools(feed, venues, curation).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { intakePools } from "./intake.mjs";
import { runPipeline } from "./pipeline.mjs";
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
