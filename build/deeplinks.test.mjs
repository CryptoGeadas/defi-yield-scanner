// Tests for deposit links, through buildLink(row, ctx).
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLink, isHomepage } from "./deeplinks.mjs";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const GHO = "0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f";
const aave = (o) => ({
  project: "aave-v3", chain: "Ethereum", symbol: "USDC", poolMeta: null, pool: "p1",
  access: "permissionless", underlyingTokens: [USDC], ...o,
});
const SITE = { siteUrl: "https://app.aave.com" };

test("Aave V3 Core pools link to their reserve on the chain's Core market", () => {
  assert.deepEqual(buildLink(aave(), SITE), {
    url: `https://app.aave.com/reserve-overview/?underlyingAsset=${USDC.toLowerCase()}&marketName=proto_mainnet_v3`,
    kind: "exact",
  });
  assert.match(buildLink(aave({ chain: "Base" }), SITE).url, /marketName=proto_base_v3$/);
});

test("Aave V3 named markets link to that market, never Core", () => {
  assert.match(buildLink(aave({ poolMeta: "Prime Instance" }), SITE).url, /marketName=proto_lido_v3$/);
  assert.match(buildLink(aave({ symbol: "GHO", poolMeta: "Aave Horizon Market", underlyingTokens: [GHO] }), SITE).url, /marketName=proto_horizon_v3$/);
});

test("Aave V3 stake tokens, sGHO and unknown markets get the protocol site, not a guessed reserve", () => {
  for (const row of [
    aave({ poolMeta: "Umbrella" }),
    aave({ symbol: "SGHO", underlyingTokens: [GHO] }),
    aave({ poolMeta: "Some New Market" }),
  ]) {
    assert.deepEqual(buildLink(row, SITE), { url: "https://app.aave.com", kind: "site" }, `${row.symbol} ${row.poolMeta}`);
  }
});

test("a curated override is exact, unless it is only a homepage", () => {
  const row = { project: "save", chain: "Solana", pool: "p2", access: "permissionless" };
  assert.equal(buildLink(row, { override: "https://save.finance/" }).kind, "site");
  assert.equal(buildLink(row, { override: "https://www.app.ethena.fi" }).kind, "site");
  assert.equal(buildLink(row, { override: "https://app.compound.xyz/markets/usdc-mainnet" }).kind, "exact");
  assert.equal(buildLink(row, { override: "https://app.sky.money/earn/savings?network=ethereum" }).kind, "exact");
});

test("isHomepage: only a bare origin counts", () => {
  assert.equal(isHomepage("https://pro.aave.com/"), true);
  assert.equal(isHomepage("https://aerodrome.finance"), true);
  assert.equal(isHomepage("https://app.sky.money/?network=base"), false);
  assert.equal(isHomepage("https://jup.ag/lend/earn/USDC/deposit"), false);
  assert.equal(isHomepage("not a url"), false);
});
