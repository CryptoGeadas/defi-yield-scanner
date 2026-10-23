// ─────────────────────────────────────────────────────────────────────────────
// DEPOSIT TARGETS (#39) — which rows the site can deposit into through LI.FI.
// fetchEarnVaults: the I/O half. LI.FI's Earn API lists the vaults its routing can
//   deposit into; it needs the LIFI_API_KEY secret, so it only runs in the build and
//   the key never reaches the site. Like other venue data it fails soft: no key or any
//   error → an empty list, and every row simply gets no Deposit button.
// matchDeposit: pure. A row gets a target only on an exact vault-address match, and
//   fails closed on anything unsure (wrong chain, several underlying tokens, a coin
//   that isn't one of the row's legs). A wrong match would send money to the wrong vault.
// ─────────────────────────────────────────────────────────────────────────────

import { MORPHO_CHAINID as CHAIN_ID } from "./deeplink-sources.mjs"; // Scanner chain name → EVM chain id

const EARN = "https://earn.li.fi/v1/vaults";
const ADDR = /(?<![0-9a-f])0x[0-9a-f]{40}(?![0-9a-f])/gi; // whole addresses only (a 64-hex market id is not one)
const IS_ADDR = /^0x[0-9a-f]{40}$/i;
const MAX_PAGES = 50; // 5,000 vaults a chain; far above today's largest (Ethereum, ~400)
const lower = (s) => String(s ?? "").toLowerCase();
export const DEPOSIT_REASONS = ["nonEvm", "lp", "permissioned", "notTransactional", "noMatch"];
export const EARN_CHAIN_IDS = Object.values(CHAIN_ID);

// Every page of /vaults for each chain. One chain failing keeps the chains that worked.
// The key goes in a header only; warnings name the chain, never the URL or the key.
export async function fetchEarnVaults({ key, chainIds = EARN_CHAIN_IDS, fetchImpl = fetch, log = console } = {}) {
  if (!key) {
    log.warn("  ⚠ deposits: LIFI_API_KEY not set — no Deposit buttons this refresh");
    return [];
  }
  // chains in parallel; the result keeps the order of chainIds
  const perChain = await Promise.all(chainIds.map(async (chainId) => {
    const got = [];
    try {
      let cursor = null, page = 0;
      for (; page < MAX_PAGES; page++) {
        const u = new URL(EARN);
        u.searchParams.set("chainId", chainId);
        u.searchParams.set("limit", "100");
        if (cursor) u.searchParams.set("cursor", cursor);
        const r = await fetchImpl(u.toString(), { headers: { "x-lifi-api-key": key }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        if (!Array.isArray(j?.data)) throw new Error("unexpected response shape (no data list)");
        const data = j.data;
        got.push(...data);
        const next = data.length && j.nextCursor ? j.nextCursor : null;
        if (next && next === cursor) throw new Error("the cursor did not move");
        cursor = next;
        if (!cursor) break;
      }
      if (page === MAX_PAGES) log.warn(`  ⚠ deposits: LI.FI vault list for chain ${chainId} stopped at ${MAX_PAGES} pages — later vaults get no Deposit button`);
      return got;
    } catch (e) {
      log.warn(`  ⚠ deposits: LI.FI vault list for chain ${chainId} failed (${String(e?.message ?? e).replaceAll(key, "***")}) — no Deposit buttons on that chain`);
      return [];
    }
  }));
  return perChain.flat();
}

// address: chainId|address → Earn vault (exact-address lookup).
// protocol: chainId|LI.FI protocol id → its vaults (unique matches, #41).
export function depositIndex(vaults) {
  const address = new Map(), protocol = new Map();
  for (const v of vaults || []) {
    address.set(`${v.chainId}|${lower(v.address)}`, v);
    const k = `${v.chainId}|${v.protocol?.id}`;
    if (!protocol.has(k)) protocol.set(k, []);
    protocol.get(k).push(v);
  }
  return { address, protocol };
}

// Addresses in the path of an Exact URL. Query strings are skipped: they name other things
// (Aave's ?underlyingAsset= is the coin, not the vault). A guarded, site or DefiLlama link
// may name some other contract, so those are never read.
function urlAddresses(r) {
  if (r.linkKind !== "exact") return [];
  let path;
  try { path = new URL(r.url).pathname; } catch { return []; }
  return [...new Set((path.match(ADDR) || []).map(lower))];
}

// The row's own vault: the flows vault field, else the one path address LI.FI lists.
// Unsure → null: two listed vaults in the URL, or a URL vault that differs from the field.
function rowVault(r, chainId, index) {
  const listed = urlAddresses(r).map((a) => index.address.get(`${chainId}|${a}`)).filter(Boolean);
  if (r.vault?.address) {
    const own = lower(r.vault.address);
    if (listed.some((v) => lower(v.address) !== own)) return null;
    return index.address.get(`${chainId}|${own}`) ?? null;
  }
  return listed.length === 1 ? listed[0] : null;
}

const none = (depositReason) => ({ deposit: null, depositReason });
// any address in the row's vault field or link path, whatever the link kind: a row that
// names its own contract is never matched by a guess
function hasOwnAddress(r) {
  if (r.vault?.address) return true;
  try { return ADDR.test(new URL(r.url).pathname); } catch { return false; } finally { ADDR.lastIndex = 0; }
}
const upper = (x) => String(x ?? "").toUpperCase();
// The vault's single underlying token, when it is the row's coin: by token address when
// the row has DefiLlama's token addresses (USDC vs bridged USDC.e share a symbol), else by
// symbol (exact-address matches only; a unique match requires the address).
function underlyingOf(v, r, { needAddress = false } = {}) {
  const u = Array.isArray(v.underlyingTokens) && v.underlyingTokens.length === 1 ? v.underlyingTokens[0] : null;
  if (!u || !IS_ADDR.test(u.address ?? "") || !Number.isInteger(u.decimals)) return null;
  const tokens = (r.underlyingTokens || []).filter((t) => IS_ADDR.test(String(t))).map(lower);
  if (tokens.length) return tokens.includes(lower(u.address)) ? u : null;
  if (needAddress) return null;
  return new Set((r.legs || []).map(upper)).has(upper(u.symbol)) ? u : null;
}
const TVL_BAND = 2; // the Link guard's rule: a match whose TVL is more than 2× away is not trusted

// deposit-protocols.json → { project: { lifi, markets? } }; a wrong shape fails the build
// (an opinion file must never quietly switch matching off or on).
export function checkDepositProtocols(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (k.startsWith("_")) continue;
    if (!v || typeof v.lifi !== "string" || !v.lifi) throw new Error(`deposit-protocols.json: "${k}" needs a "lifi" protocol id`);
    if (v.markets != null && !(Array.isArray(v.markets) && v.markets.length && v.markets.every((m) => typeof m === "string" && m)))
      throw new Error(`deposit-protocols.json: "${k}".markets must be a non-empty list of market names`);
    out[k] = { lifi: v.lifi, markets: v.markets ?? null };
  }
  return out;
}

// Rows of one protocol + chain + coin that have no address of their own. A unique match is
// only allowed when this is 1: LI.FI may list one of several real markets (Aave Core vs
// Prime), and "the only one LI.FI lists" must not mean "the only one there is".
const siblingKey = (r) => `${r.project}|${r.chain}|${(r.legs || []).map(upper).join("+")}`;
export function uniqueSiblings(rows) {
  const n = new Map();
  for (const r of rows) if (!hasOwnAddress(r)) n.set(siblingKey(r), (n.get(siblingKey(r)) || 0) + 1);
  return n;
}
const marketOf = (r) => { try { return new URL(r.url).searchParams.get("marketName"); } catch { return null; } };

// No vault address on the row (e.g. Aave): exactly one LI.FI vault of the same protocol
// VERSION on the chain whose underlying token is the row's coin (by address), with TVL
// within 2×, the row's market allowed, and no other Scanner row it could also be.
function uniqueVault(r, chainId, index, { protocols = {}, siblings } = {}) {
  const p = Object.hasOwn(protocols, r.project) ? protocols[r.project] : null;
  if (!p || hasOwnAddress(r) || (r.legs || []).length !== 1 || siblings?.get(siblingKey(r)) !== 1) return null;
  if (p.markets && !p.markets.includes(marketOf(r))) return null;
  const c = (index.protocol.get(`${chainId}|${p.lifi}`) || []).filter((v) => underlyingOf(v, r, { needAddress: true }));
  if (c.length !== 1) return null;
  const ratio = Number(c[0].analytics?.tvl?.usd) / Number(r.tvlUsd);
  return Number.isFinite(ratio) && ratio > 0 && ratio <= TVL_BAND && ratio >= 1 / TVL_BAND ? c[0] : null;
}

// All published rows at once (the build's call): unique matches need the other rows.
// opts.protocols: checkDepositProtocols(deposit-protocols.json).
export function matchDeposits(rows, index, { protocols = {} } = {}) {
  const siblings = uniqueSiblings(rows);
  return rows.map((r) => matchDeposit(r, index, { protocols, siblings }));
}

// row: a published snapshot row (slim.mjs). → { deposit, depositReason }
// opts: { protocols, siblings } for unique matches; without them only exact addresses match.
export function matchDeposit(r, index, opts = {}) {
  const chainId = CHAIN_ID[r.chain];
  if (!chainId) return none("nonEvm");
  if (r.bucket === "LP") return none("lp");
  if (r.access === "permissioned") return none("permissioned");
  const byAddress = rowVault(r, chainId, index);
  const v = byAddress ?? uniqueVault(r, chainId, index, opts);
  if (!v) return none("noMatch");
  if (v.kyc === true) return none("permissioned");
  if (v.isTransactional !== true) return none("notTransactional");
  const u = underlyingOf(v, r);
  if (!u || !IS_ADDR.test(v.address ?? "")) return none("noMatch");
  return { deposit: { chainId, token: lower(v.address), underlying: { address: lower(u.address), symbol: u.symbol, decimals: u.decimals }, match: byAddress ? "address" : "unique" }, depositReason: null };
}

// One build-log line: rows with a target, then a count per reason.
export function depositLog(rows, vaultCount) {
  const n = rows.filter((r) => r.deposit).length;
  const by = {};
  for (const r of rows) if (!r.deposit) by[r.depositReason] = (by[r.depositReason] || 0) + 1;
  const reasons = DEPOSIT_REASONS.filter((k) => by[k]).map((k) => ` · ${k} ${by[k]}`).join("");
  const uniq = rows.filter((r) => r.deposit?.match === "unique").length;
  return `deposits: ${n}/${rows.length} rows have a target (address ${n - uniq} · unique ${uniq}; LI.FI vaults ${vaultCount})${reasons}`;
}
