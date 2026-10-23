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

// chainId|address → Earn vault, for the exact-address lookup.
export const depositIndex = (vaults) => new Map((vaults || []).map((v) => [`${v.chainId}|${lower(v.address)}`, v]));

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
  const listed = urlAddresses(r).map((a) => index.get(`${chainId}|${a}`)).filter(Boolean);
  if (r.vault?.address) {
    const own = lower(r.vault.address);
    if (listed.some((v) => lower(v.address) !== own)) return null;
    return index.get(`${chainId}|${own}`) ?? null;
  }
  return listed.length === 1 ? listed[0] : null;
}

const none = (depositReason) => ({ deposit: null, depositReason });

// row: a published snapshot row (slim.mjs). → { deposit, depositReason }
export function matchDeposit(r, index) {
  const chainId = CHAIN_ID[r.chain];
  if (!chainId) return none("nonEvm");
  if (r.bucket === "LP") return none("lp");
  if (r.access === "permissioned") return none("permissioned");
  const v = rowVault(r, chainId, index);
  if (!v) return none("noMatch");
  if (v.kyc === true) return none("permissioned");
  if (v.isTransactional !== true) return none("notTransactional");
  const u = Array.isArray(v.underlyingTokens) && v.underlyingTokens.length === 1 ? v.underlyingTokens[0] : null;
  const legs = new Set((r.legs || []).map((l) => String(l).toUpperCase()));
  if (!u || !IS_ADDR.test(u.address ?? "") || !Number.isInteger(u.decimals) || !legs.has(String(u.symbol).toUpperCase())) return none("noMatch");
  return { deposit: { chainId, token: lower(v.address), underlying: { address: lower(u.address), symbol: u.symbol, decimals: u.decimals }, match: "address" }, depositReason: null };
}

// One build-log line: rows with a target, then a count per reason.
export function depositLog(rows, vaultCount) {
  const n = rows.filter((r) => r.deposit).length;
  const by = {};
  for (const r of rows) if (!r.deposit) by[r.depositReason] = (by[r.depositReason] || 0) + 1;
  const reasons = DEPOSIT_REASONS.filter((k) => by[k]).map((k) => ` · ${k} ${by[k]}`).join("");
  return `deposits: ${n}/${rows.length} rows have a target (LI.FI vaults ${vaultCount})${reasons}`;
}
