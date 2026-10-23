// Deposit targets (#39): the Earn vault reader and the pure matcher.
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fetchEarnVaults, depositIndex, matchDeposit, matchDeposits, checkDepositProtocols, depositLog } from "./deposits.mjs";

const VAULT = "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9";
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const earn = (o = {}) => ({
  address: VAULT, chainId: 8453, isTransactional: true, protocol: { id: "morpho" },
  analytics: { tvl: { usd: 146e6 } }, underlyingTokens: [{ symbol: "USDC", address: USDC_BASE, decimals: 6 }], ...o,
});
const row = (o = {}) => ({
  project: "morpho-blue", chain: "Base", bucket: "vault", access: "permissionless", legs: ["USDC"], tvlUsd: 146e6,
  url: `https://app.morpho.org/base/vault/${VAULT}`, linkKind: "exact", vault: null, ...o,
});
const target = { chainId: 8453, token: VAULT, underlying: { address: USDC_BASE, symbol: "USDC", decimals: 6 }, match: "address" };

test("exact address from the flows vault field → deposit target", () => {
  const r = row({ chain: "Ethereum", url: null, linkKind: "site", vault: { chain: "ethereum", address: VAULT, decimals: 6 } });
  const idx = depositIndex([earn({ chainId: 1 })]);
  assert.deepEqual(matchDeposit(r, idx), { deposit: { ...target, chainId: 1 }, depositReason: null });
});

test("exact address taken from the row's Exact URL → deposit target", () => {
  assert.deepEqual(matchDeposit(row(), depositIndex([earn()])), { deposit: target, depositReason: null });
});

test("an address in a non-exact link is never used (a guarded or site link may name another contract)", () => {
  const r = row({ linkKind: "defillama" });
  assert.deepEqual(matchDeposit(r, depositIndex([earn()])), { deposit: null, depositReason: "noMatch" });
});

test("addresses match whatever their letter case", () => {
  const r = row({ url: `https://app.morpho.org/base/vault/${VAULT.toUpperCase().replace("0X", "0x")}` });
  assert.equal(matchDeposit(r, depositIndex([earn({ address: VAULT.toUpperCase().replace("0X", "0x") })])).deposit?.token, VAULT);
});

test("the same address on another chain is not a match", () => {
  assert.equal(matchDeposit(row(), depositIndex([earn({ chainId: 1 })])).depositReason, "noMatch");
});

test("reasons: Solana → nonEvm, LP → lp, permissioned → permissioned", () => {
  const idx = depositIndex([earn()]);
  assert.equal(matchDeposit(row({ chain: "Solana" }), idx).depositReason, "nonEvm");
  assert.equal(matchDeposit(row({ bucket: "LP" }), idx).depositReason, "lp");
  assert.equal(matchDeposit(row({ access: "permissioned" }), idx).depositReason, "permissioned");
});

test("reasons: a KYC vault → permissioned, a non-transactional vault → notTransactional", () => {
  assert.equal(matchDeposit(row(), depositIndex([earn({ kyc: true })])).depositReason, "permissioned");
  assert.equal(matchDeposit(row(), depositIndex([earn({ isTransactional: false })])).depositReason, "notTransactional");
});

test("fail closed: a vault with several (or no) underlying tokens, or without decimals, is no target", () => {
  const two = earn({ underlyingTokens: [earn().underlyingTokens[0], { symbol: "USDT", address: "0x1", decimals: 6 }] });
  assert.equal(matchDeposit(row(), depositIndex([two])).depositReason, "noMatch");
  assert.equal(matchDeposit(row(), depositIndex([earn({ underlyingTokens: [] })])).depositReason, "noMatch");
  assert.equal(matchDeposit(row(), depositIndex([earn({ underlyingTokens: [{ symbol: "USDC", address: USDC_BASE }] })])).depositReason, "noMatch");
});

test("fail closed: the vault's underlying token must be one of the row's legs", () => {
  const dai = earn({ underlyingTokens: [{ symbol: "DAI", address: "0x50c5725949a6f0c72e6c4a641f24049a917db0cb", decimals: 18 }] });
  assert.equal(matchDeposit(row(), depositIndex([dai])).depositReason, "noMatch");
});

test("fail closed: a malformed underlying address (too long) is no target", () => {
  const bad = earn({ underlyingTokens: [{ symbol: "USDC", address: USDC_BASE + "00", decimals: 6 }] });
  assert.equal(matchDeposit(row(), depositIndex([bad])).depositReason, "noMatch");
});

test("a vault without isTransactional is treated as not transactional", () => {
  const v = earn(); delete v.isTransactional;
  assert.equal(matchDeposit(row(), depositIndex([v])).depositReason, "notTransactional");
});

test("the flows vault field wins; a URL naming a different listed vault makes the row unsure", () => {
  const OTHER = "0x1111111111111111111111111111111111111111";
  const idx = depositIndex([earn({ chainId: 1 }), earn({ chainId: 1, address: OTHER })]);
  const base = { chain: "Ethereum", vault: { chain: "ethereum", address: VAULT, decimals: 6 } };
  assert.equal(matchDeposit(row({ ...base, url: `https://app.morpho.org/ethereum/vault/${VAULT}` }), idx).deposit?.token, VAULT);
  assert.equal(matchDeposit(row({ ...base, url: `https://app.morpho.org/ethereum/vault/${OTHER}` }), idx).depositReason, "noMatch");
});

test("only addresses in the URL path count: a query parameter or a 64-hex market id is never read as the vault", () => {
  const idx = depositIndex([earn()]);
  assert.equal(matchDeposit(row({ url: `https://app.aave.com/reserve-overview/?underlyingAsset=${VAULT}` }), idx).depositReason, "noMatch");
  assert.equal(matchDeposit(row({ url: `https://app.morpho.org/base/market/${VAULT}${"ab".repeat(12)}` }), idx).depositReason, "noMatch");
});

test("a URL naming two listed vaults is unsure → noMatch", () => {
  const OTHER = "0x2222222222222222222222222222222222222222";
  const idx = depositIndex([earn(), earn({ address: OTHER })]);
  assert.equal(matchDeposit(row({ url: `https://example.org/vault/${VAULT}/compare/${OTHER}` }), idx).depositReason, "noMatch");
});

test("empty Earn list → every row has no target, no throw", () => {
  const idx = depositIndex([]);
  for (const r of [row(), row({ chain: "Solana" }), row({ bucket: "LP" })]) assert.equal(matchDeposit(r, idx).deposit, null);
  assert.equal(matchDeposit(row(), idx).depositReason, "noMatch");
});

test("depositLog counts targets and each reason", () => {
  const rows = [{ deposit: target, depositReason: null }, { deposit: null, depositReason: "lp" }, { deposit: null, depositReason: "lp" }, { deposit: null, depositReason: "nonEvm" }];
  assert.equal(depositLog(rows, 514), "deposits: 1/4 rows have a target (address 1 · unique 0; LI.FI vaults 514) · nonEvm 1 · lp 2");
  assert.equal(depositLog([], 0), "deposits: 0/0 rows have a target (address 0 · unique 0; LI.FI vaults 0)");
  assert.match(depositLog([{ deposit: { ...target, match: "unique" } }, { deposit: target }], 9), /address 1 · unique 1;/);
});

// ── unique matches (#41): rows without a vault address, e.g. Aave ──────────────
const ATOKEN = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c", USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PROTOS = { "aave-v3": { lifi: "aave", markets: ["proto_mainnet_v3"] } };
const aave = (o = {}) => earn({ address: ATOKEN, chainId: 1, protocol: { id: "aave" }, analytics: { tvl: { usd: 2.0e9 } }, underlyingTokens: [{ symbol: "USDC", address: USDC_ETH, decimals: 6 }], ...o });
const aaveUrl = (market = "proto_mainnet_v3") => `https://app.aave.com/reserve-overview/?underlyingAsset=${USDC_ETH}&marketName=${market}`;
const aaveRow = (o = {}) => row({ project: "aave-v3", chain: "Ethereum", bucket: "lend", url: aaveUrl(), linkKind: "exact", tvlUsd: 2.39e9, underlyingTokens: [USDC_ETH], ...o });
// the build's call: every row at once
const one = (rows, vaults, protocols = PROTOS) => matchDeposits(rows, depositIndex(vaults), { protocols });
const first = (rows, vaults, protocols) => one(rows, vaults, protocols)[0];

test("unique: one vault of the same protocol version, coin (by address) and chain, TVL within 2× → match: unique", () => {
  assert.deepEqual(first([aaveRow()], [aave()]), {
    deposit: { chainId: 1, token: ATOKEN, underlying: { address: USDC_ETH, symbol: "USDC", decimals: 6 }, match: "unique" }, depositReason: null,
  });
});

test("unique: never without the other rows (matchDeposit alone only matches exact addresses)", () => {
  assert.equal(matchDeposit(aaveRow(), depositIndex([aave()]), { protocols: PROTOS }).depositReason, "noMatch");
});

test("unique: two Scanner rows of the same protocol, chain and coin → neither matches (LI.FI may list only one market)", () => {
  const out = one([aaveRow(), aaveRow({ url: aaveUrl("proto_lido_v3"), tvlUsd: 2.2e9 })], [aave()]);
  assert.deepEqual(out.map((m) => m.depositReason), ["noMatch", "noMatch"]);
});

test("unique: a market that isn't on the protocol's list → noMatch", () => {
  assert.equal(first([aaveRow({ url: aaveUrl("proto_lido_v3") })], [aave()]).depositReason, "noMatch");
  assert.equal(first([aaveRow({ url: "https://aave.com", linkKind: "site" })], [aave()]).depositReason, "noMatch", "no market named");
});

test("unique: two candidates → noMatch", () => {
  assert.equal(first([aaveRow()], [aave(), aave({ address: "0x2a1fbcb52ed4d9b23dad17e1e8aed4bb0e6079b8" })]).depositReason, "noMatch");
});

test("unique: TVL more than 2× away (either way), or missing → noMatch", () => {
  assert.equal(first([aaveRow()], [aave({ analytics: { tvl: { usd: 140e6 } } })]).depositReason, "noMatch");
  assert.equal(first([aaveRow({ tvlUsd: 100e6 })], [aave()]).depositReason, "noMatch");
  assert.equal(first([aaveRow()], [aave({ analytics: {} })]).depositReason, "noMatch", "no TVL is no proof");
  assert.equal(first([aaveRow({ tvlUsd: 0 })], [aave()]).depositReason, "noMatch");
});

test("unique: protocol version mismatch — an Aave V4 pool never matches LI.FI's Aave (V3) aToken", () => {
  assert.equal(first([aaveRow({ project: "aave-v4" })], [aave()]).depositReason, "noMatch");
  assert.equal(first([aaveRow()], [aave()], {}).depositReason, "noMatch", "a protocol not in the map gets no unique match");
});

test("unique: the coin is compared by token address, not symbol (USDC vs bridged USDC.e)", () => {
  const bridged = aave({ underlyingTokens: [{ symbol: "USDC", address: "0x7f5c764cbc14f9669b88837ca1490cca17c31607", decimals: 6 }] });
  assert.equal(first([aaveRow()], [bridged]).depositReason, "noMatch");
  assert.equal(first([aaveRow({ underlyingTokens: null })], [aave()]).depositReason, "noMatch", "no token address on the row → no unique match");
});

test("unique: another coin or chain, a candidate with several coins, or a row with several legs → noMatch", () => {
  assert.equal(first([aaveRow({ legs: ["USDT"], underlyingTokens: ["0xdac17f958d2ee523a2206206994597c13d831ec7"] })], [aave()]).depositReason, "noMatch");
  assert.equal(first([aaveRow({ chain: "Base" })], [aave()]).depositReason, "noMatch");
  const multi = aave({ underlyingTokens: [aave().underlyingTokens[0], { symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7", decimals: 6 }] });
  assert.equal(first([aaveRow()], [multi]).depositReason, "noMatch");
  assert.equal(first([aaveRow({ legs: ["USDC", "USDT"] })], [aave()]).depositReason, "noMatch");
});

test("exact address wins: a row that names its own contract never falls back to a unique guess", () => {
  const OWN = "0x1111111111111111111111111111111111111111";
  const byUrl = aaveRow({ url: `https://app.morpho.org/ethereum/vault/${OWN}` });
  assert.equal(first([byUrl], [aave()]).depositReason, "noMatch", "own address in the link, not listed at LI.FI");
  assert.equal(first([byUrl], [aave({ address: OWN }), aave()]).deposit?.match, "address");
  const byField = aaveRow({ vault: { chain: "ethereum", address: OWN, decimals: 6 } });
  assert.equal(first([byField], [aave()]).depositReason, "noMatch", "own address in the vault field");
  const guarded = aaveRow({ url: `https://defillama.com/yields/pool/${OWN}`, linkKind: "defillama" });
  assert.equal(first([guarded], [aave()]).depositReason, "noMatch", "an address in a non-exact link still counts as its own");
});

test("unique: a KYC or non-transactional single candidate keeps its reason", () => {
  assert.equal(first([aaveRow()], [aave({ kyc: true })]).depositReason, "permissioned");
  assert.equal(first([aaveRow()], [aave({ isTransactional: false })]).depositReason, "notTransactional");
});

test("exact address match also compares the coin by address when the row has it", () => {
  const r = row({ underlyingTokens: ["0x7f5c764cbc14f9669b88837ca1490cca17c31607"] }); // the row's coin is another token named USDC
  assert.equal(matchDeposit(r, depositIndex([earn()])).depositReason, "noMatch");
  assert.equal(matchDeposit(row({ underlyingTokens: [USDC_BASE] }), depositIndex([earn()])).deposit?.match, "address");
});

test("checkDepositProtocols: a wrong shape fails loudly; '_' keys are notes", () => {
  assert.deepEqual(checkDepositProtocols({ _: "note", "aave-v3": { lifi: "aave", markets: ["m"] } }), { "aave-v3": { lifi: "aave", markets: ["m"] } });
  assert.deepEqual(checkDepositProtocols(null), {});
  assert.throws(() => checkDepositProtocols({ "aave-v3": "aave" }), /needs a "lifi"/);
  assert.throws(() => checkDepositProtocols({ "aave-v3": { lifi: "aave", markets: [] } }), /markets/);
  assert.throws(() => checkDepositProtocols({ "aave-v3": { lifi: "aave", markets: [3] } }), /markets/);
});

test("the real deposit-protocols.json: valid, Aave V3 limited to Core markets, no Aave V4", () => {
  const real = checkDepositProtocols(JSON.parse(readFileSync(new URL("./deposit-protocols.json", import.meta.url), "utf8")));
  assert.ok(real["aave-v3"]?.markets?.includes("proto_mainnet_v3"));
  assert.ok(!real["aave-v3"].markets.includes("proto_lido_v3"), "Prime is not Core");
  assert.equal(real["aave-v4"], undefined);
});

// ── reader ──────────────────────────────────────────────────────────────────
const quiet = { warn: () => {} };

test("reader: no key → empty list, no request made", async () => {
  let calls = 0;
  const out = await fetchEarnVaults({ key: "", chainIds: [8453], fetchImpl: async () => { calls++; }, log: quiet });
  assert.deepEqual([out, calls], [[], 0]);
});

test("reader: a failed fetch → empty list (the build goes on)", async () => {
  const out = await fetchEarnVaults({ key: "k", chainIds: [8453], fetchImpl: async () => { throw new Error("network down"); }, log: quiet });
  assert.deepEqual(out, []);
});

test("reader: HTTP error → empty list", async () => {
  const out = await fetchEarnVaults({ key: "k", chainIds: [8453], fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }), log: quiet });
  assert.deepEqual(out, []);
});

test("reader: follows the cursor on every chain and sends the key in the header", async () => {
  const seen = [];
  const pages = { "8453|": { data: [earn()], nextCursor: "c1" }, "8453|c1": { data: [earn({ address: "0x2" })], nextCursor: "c2" }, "8453|c2": { data: [] }, "1|": { data: [earn({ chainId: 1 })] } };
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    seen.push(opts.headers["x-lifi-api-key"]);
    return { ok: true, status: 200, json: async () => pages[`${u.searchParams.get("chainId")}|${u.searchParams.get("cursor") ?? ""}`] };
  };
  const out = await fetchEarnVaults({ key: "k", chainIds: [8453, 1], fetchImpl, log: quiet });
  assert.deepEqual(out.map((v) => `${v.chainId}|${v.address}`), [`8453|${VAULT}`, "8453|0x2", `1|${VAULT}`]);
  assert.ok(seen.every((k) => k === "k"));
});

test("reader: one chain failing keeps the chains that worked", async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).searchParams.get("chainId") === "1") throw new Error("boom");
    return { ok: true, status: 200, json: async () => ({ data: [earn()] }) };
  };
  const out = await fetchEarnVaults({ key: "k", chainIds: [1, 8453], fetchImpl, log: quiet });
  assert.deepEqual(out.map((v) => v.chainId), [8453]);
});

test("reader: a failure after page 1 drops that chain only, with a warning", async () => {
  const lines = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.searchParams.get("chainId") === "1" && u.searchParams.get("cursor")) throw new Error("page 2 down");
    return { ok: true, status: 200, json: async () => (u.searchParams.get("chainId") === "1" ? { data: [earn({ chainId: 1 })], nextCursor: "c1" } : { data: [earn()] }) };
  };
  const out = await fetchEarnVaults({ key: "k", chainIds: [1, 8453], fetchImpl, log: { warn: (l) => lines.push(l) } });
  assert.deepEqual(out.map((v) => v.chainId), [8453]);
  assert.ok(lines.some((l) => l.includes("chain 1 failed")));
});

test("reader: an unexpected response shape is a failure for that chain, not an empty success", async () => {
  const lines = [];
  const out = await fetchEarnVaults({ key: "k", chainIds: [8453], fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ items: [earn()] }) }), log: { warn: (l) => lines.push(l) } });
  assert.deepEqual(out, []);
  assert.ok(lines.some((l) => l.includes("unexpected response shape")));
});

test("reader: a cursor that does not move stops with a warning instead of looping", async () => {
  const lines = [];
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, json: async () => ({ data: [earn()], nextCursor: "same" }) }; };
  await fetchEarnVaults({ key: "k", chainIds: [8453], fetchImpl, log: { warn: (l) => lines.push(l) } });
  assert.ok(calls <= 3, `stopped after ${calls} calls`);
  assert.ok(lines.some((l) => l.includes("cursor did not move")));
});

test("reader: the key never appears in a warning", async () => {
  const lines = [];
  await fetchEarnVaults({ key: "secret-key-123", chainIds: [8453], fetchImpl: async (u) => { throw new Error(`failed ${u}`); }, log: { warn: (...a) => lines.push(a.join(" ")) } });
  assert.ok(lines.length > 0 && lines.every((l) => !l.includes("secret-key-123")));
});
