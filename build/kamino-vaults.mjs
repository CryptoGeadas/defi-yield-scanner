// ─────────────────────────────────────────────────────────────────────────────
// KAMINO LENDING VAULTS — on-chain source (DefiLlama only tracks Kamino's isolated
// markets, not the curated "Lend" vaults). We list the kvault program's VaultState
// accounts via a public Solana RPC — filtered server-side by the account
// discriminator and sliced to only the bytes we read, so the call stays small and is
// far likelier to be accepted by public/CI RPCs — then pull live APY/TVL from
// Kamino's public metrics API. Output is plain vault records; intake.mjs shapes them
// into pools for the normal pipeline. Best-effort: any failure returns [] and the build
// proceeds without Kamino vaults (never crashes the refresh).
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const KVAULT = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
];
const NAME_OFF = 58528, NAME_LEN = 40;            // VaultState.name (fixed offset)
const MINT_OFF = 80;                              // VaultState.tokenMint
const UA = { "User-Agent": "Mozilla/5.0 Chrome/124" };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const bs58 = (buf) => {
  let d = [0];
  for (const b of buf) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  let s = ""; for (const b of buf) { if (b === 0) s += "1"; else break; }
  return s + d.reverse().map((x) => B58[x]).join("");
};
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
// VaultState.name is a fixed [u8; N]; if the on-chain layout ever shifts, the bytes
// at NAME_OFF become garbage — only trust a clean printable-ASCII string.
const cleanName = (buf) => {
  const s = buf.toString("utf8").replace(/\0+$/, "").trim();
  return /^[\x20-\x7E]{1,40}$/.test(s) ? s : "";
};

async function rpcCall(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json", ...UA }, body, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) continue;                       // 4xx/5xx (rate-limit, blocked) → next RPC
      const j = await r.json();
      if (j.result != null) return j.result;     // JSON-RPC error (result absent) → next RPC
    } catch { /* network/parse error → next RPC */ }
  }
  return null;
}

// List all VaultState accounts, returning only address + token mint. Server-side
// memcmp on the 8-byte discriminator + a 32-byte dataSlice keeps this to a few KB.
async function listVaultMints() {
  const disc = crypto.createHash("sha256").update("account:VaultState").digest().subarray(0, 8);
  const res = await rpcCall("getProgramAccounts", [KVAULT, {
    encoding: "base64",
    filters: [{ memcmp: { offset: 0, bytes: bs58(disc) } }],
    dataSlice: { offset: MINT_OFF, length: 32 },
  }]);
  if (!res) return null;
  return res.map((a) => ({ address: a.pubkey, mint: bs58(Buffer.from(a.account.data[0], "base64")) }));
}

// Fetch just the name bytes for the given vaults (getMultipleAccounts, 100/call, sliced).
async function fetchNames(addresses) {
  const names = {};
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const res = await rpcCall("getMultipleAccounts", [chunk, { encoding: "base64", dataSlice: { offset: NAME_OFF, length: NAME_LEN } }]);
    const arr = res?.value || [];
    chunk.forEach((addr, idx) => {
      const b64 = arr[idx]?.data?.[0];
      if (b64) names[addr] = cleanName(Buffer.from(b64, "base64"));
    });
  }
  return names;
}

async function resolveSymbols(mints) {
  const map = {};
  let failed = 0, chunks = 0;
  for (let i = 0; i < mints.length; i += 40) {
    const chunk = mints.slice(i, i + 40).map((m) => "solana:" + m);
    chunks++;
    try {
      const r = await fetch("https://coins.llama.fi/prices/current/" + chunk.join(","), { headers: UA, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p = await r.json();
      for (const [k, v] of Object.entries(p.coins || {})) map[k.split(":")[1]] = (v.symbol || "").toUpperCase();
    } catch { failed++; /* leave unresolved */ }
  }
  if (failed) console.warn(`kamino: symbol lookup failed for ${failed}/${chunks} chunks (coins.llama.fi) — those vaults are skipped`);
  return map;
}

// Kamino's `apy` (== apyActual == apyTheoretical) is base lending yield only; farm
// rewards / incentives / reserve incentives are separate additive streams — verified
// against the app's "combined APY" — so summing them is correct, not a double-count.
async function fetchMetrics(address) {
  try {
    const m = await getJson(`https://api.kamino.finance/kvaults/${address}/metrics`);
    const idleUsd = num(m.tokensAvailableUsd), investedUsd = num(m.tokensInvestedUsd);
    const tvl = investedUsd + idleUsd;
    const base = num(m.apy) * 100;
    const reward = (num(m.apyFarmRewards) + num(m.apyIncentives) + num(m.apyReservesIncentives)) * 100;
    const mean30 = m.apy30d != null && Number.isFinite(Number(m.apy30d)) ? Number(m.apy30d) * 100 : null; // no history → null, not 0
    const apy7 = m.apy7d != null ? num(m.apy7d) * 100 : null;
    return { tvl, base, reward, mean30, apy7, idleUsd, investedUsd };
  } catch (e) { console.warn(`kamino: metrics failed for ${address} —`, e.message); return null; }
}

// ── exit liquidity ──────────────────────────────────────────────────────────
// A vault keeps a little idle cash and lends the rest through Kamino reserves. What
// a depositor can take out now = idle cash + for each reserve, the smaller of the
// vault's share in it and the reserve's free liquidity (supplied − borrowed). The
// vault's share per reserve is split from investedUsd by its cToken allocation. Both are
// approximations, fine for a $1M floor: cToken exchange rates differ between reserves,
// and a reserve's free liquidity is credited in full to every vault that uses it.
// Missing allocation or reserve data → null (unknown): the vault is kept, not hidden.
export function withdrawableUsd({ idleUsd, investedUsd, allocations, reserveFree }) {
  if (!(investedUsd > 0)) return idleUsd;
  if (!Array.isArray(allocations) || !reserveFree) return null;
  const live = allocations.filter((a) => a.ctokens > 0);
  const total = live.reduce((s, a) => s + a.ctokens, 0);
  if (!(total > 0)) return null;
  let out = idleUsd;
  for (const a of live) {
    const free = reserveFree.get(a.reserve);
    if (free == null) return null;
    out += Math.min((investedUsd * a.ctokens) / total, free);
  }
  return out;
}

// GET JSON, or throw with the HTTP status (so a rate limit reads as one in the log).
async function getJson(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// One vault-list row → { allocations: [{ reserve, ctokens }] | null, createdAt (ms) | null }.
// Kamino gives creationTimestamp in seconds; 0 / missing → null (Age unknown, not 1970).
export function vaultInfoFrom(v) {
  const al = v?.state?.vaultAllocationStrategy;
  const created = Number(v?.state?.creationTimestamp) * 1000;
  return {
    allocations: Array.isArray(al) ? al.map((a) => ({ reserve: a.reserve, ctokens: num(a.ctokenAllocation) })) : null,
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
  };
}

// address → vaultInfoFrom(row) for every vault in Kamino's vault list.
async function fetchAllocations() {
  try {
    const list = await getJson("https://api.kamino.finance/kvaults/vaults");
    const map = new Map();
    for (const v of list || []) {
      if (!v?.address) continue;
      map.set(v.address, vaultInfoFrom(v));
    }
    const withAlloc = [...map.values()].filter((v) => v.allocations).length;
    const withDate = [...map.values()].filter((v) => v.createdAt).length;
    if (!withAlloc) console.warn("kamino: vault list has no allocations — exit-liquidity check off for all vaults");
    if (!withDate) console.warn("kamino: vault list has no creationTimestamp — Age unknown for all Kamino vaults");
    return map;
  } catch (e) { console.warn("kamino: vault list failed — exit-liquidity check off and Age unknown for all Kamino vaults —", e.message); return null; }
}

// Reserve metrics rows → Map reserve → free liquidity (supplied − borrowed, USD). A row
// whose figures are missing, non-numeric or borrow > supply is left out (unknown), never
// read as 0 free — that would hide every vault using it. `bad` counts those rows.
export function reserveFreeFrom(rows, into = new Map()) {
  let bad = 0;
  for (const r of rows || []) {
    if (!r?.reserve) continue;
    const supply = Number(r.totalSupplyUsd), borrow = Number(r.totalBorrowUsd);
    if (!Number.isFinite(supply) || !Number.isFinite(borrow) || borrow > supply * 1.001) { bad++; continue; }
    into.set(r.reserve, Math.max(0, supply - borrow));
  }
  return { free: into, bad };
}

// reserve → free liquidity (USD) across every Kamino lending market. A market that fails
// is skipped; vaults using its reserves then get an unknown withdrawable figure.
async function fetchReserveFree() {
  try {
    const markets = await getJson("https://api.kamino.finance/v2/kamino-market");
    const ids = (markets || []).map((m) => m.lendingMarket).filter(Boolean);
    const free = new Map();
    let failed = 0, bad = 0;
    await mapLimit(ids, 8, async (id) => {
      try {
        const rs = await getJson(`https://api.kamino.finance/kamino-market/${id}/reserves/metrics`);
        bad += reserveFreeFrom(rs, free).bad;
      } catch { failed++; }
    });
    if (failed) console.warn(`kamino: reserve metrics failed for ${failed}/${ids.length} markets`);
    if (bad) console.warn(`kamino: ${bad} reserve rows had missing or inconsistent supply/borrow — left unknown`);
    if (!ids.length || !free.size) console.warn("kamino: no reserve liquidity data — exit-liquidity check off for all vaults");
    return free;
  } catch (e) { console.warn("kamino: market list failed —", e.message); return null; }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx]); }
  }));
  return out;
}

// Non-"Lend" products (Institutional / Private Credit are separate, access-gated tabs)
// and obvious test/staging vaults — matched as whole words to avoid excluding a real
// vault that merely contains one of these as a substring.
const EXCLUDE = /\b(?:institutional|private[ -]credit|test|staging|dev|e2e|example|demo)\b/i;

// Returns vault records { address, name, symbol, mint, tvl, base, reward, mean30, apy7, available, createdAt }
// for stable Kamino lending vaults above the TVL floor (APYs in %). intake.mjs shapes
// them into pools. `stableSet` = uppercased symbols we trust (from trusted-stables).
// Any unexpected error (e.g. an RPC answer in another shape) means no vaults, never a
// failed refresh: the build then publishes without Kamino and shows a notice (#29).
export async function fetchKaminoVaults(stableSet, tvlFloor = 1e6) {
  try { return await kaminoVaults(stableSet, tvlFloor); }
  catch (e) { console.warn("kamino: vault fetch failed —", e.message, "— publishing without Kamino"); return []; }
}

async function kaminoVaults(stableSet, tvlFloor) {
  const list = await listVaultMints();
  if (!list) { console.warn("kamino: getProgramAccounts failed on all RPCs — skipping vaults"); return []; }
  let nameOverrides = {};
  try { nameOverrides = JSON.parse(await readFile(join(HERE, "kamino-vault-names.json"), "utf8")).names || {}; } catch { /* none */ }

  // Resolve symbols and keep only trusted stables BEFORE fetching names/metrics.
  const symMap = await resolveSymbols([...new Set(list.map((v) => v.mint))]);
  let cand = list.map((v) => ({ ...v, symbol: symMap[v.mint] || "" })).filter((v) => stableSet.has(v.symbol));

  const nameMap = await fetchNames(cand.map((v) => v.address));
  cand = cand
    .map((v) => ({ ...v, name: nameOverrides[v.address] || nameMap[v.address] || v.symbol }))
    .filter((v) => !EXCLUDE.test(v.name));

  const [metrics, allocations, reserveFree] = await Promise.all([
    mapLimit(cand, 8, (v) => fetchMetrics(v.address)),
    fetchAllocations(),
    fetchReserveFree(),
  ]);
  const vaults = [];
  for (let k = 0; k < cand.length; k++) {
    const v = cand[k], m = metrics[k];
    if (!m || !(m.tvl >= tvlFloor)) continue;   // also drops NaN tvl
    const { idleUsd, investedUsd, ...rest } = m;
    const info = allocations?.get(v.address);
    const available = withdrawableUsd({ idleUsd, investedUsd, allocations: info?.allocations, reserveFree });
    vaults.push({ address: v.address, name: v.name, symbol: v.symbol, mint: v.mint, ...rest, available, createdAt: info?.createdAt ?? null });
  }
  const unknownVaults = vaults.filter((v) => v.available == null);
  const unknown = unknownVaults.length;
  if (unknown) console.warn(`kamino: withdrawable unknown (vault kept, exit check skipped): ${unknownVaults.map((v) => `${v.name} ${v.address}`).join("; ")}`);
  console.log(`  kamino vaults: ${vaults.length} stable lending vaults ≥ $${tvlFloor / 1e6}M (of ${list.length} on-chain) · withdrawable unknown for ${unknown}`);
  return vaults;
}
