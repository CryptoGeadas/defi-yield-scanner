// ─────────────────────────────────────────────────────────────────────────────
// KAMINO LENDING VAULTS — on-chain source (DefiLlama only tracks Kamino's isolated
// markets, not the curated "Lend" vaults). We list the kvault program's VaultState
// accounts via a public Solana RPC — filtered server-side by the account
// discriminator and sliced to only the bytes we read, so the call stays small and is
// far likelier to be accepted by public/CI RPCs — then pull live APY/TVL from
// Kamino's public metrics API. Output is shaped like DefiLlama pools so it flows
// through the normal pipeline. Best-effort: any failure returns [] and the build
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
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json", ...UA }, body });
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
  for (let i = 0; i < mints.length; i += 40) {
    const chunk = mints.slice(i, i + 40).map((m) => "solana:" + m);
    try {
      const p = await (await fetch("https://coins.llama.fi/prices/current/" + chunk.join(","), { headers: UA })).json();
      for (const [k, v] of Object.entries(p.coins || {})) map[k.split(":")[1]] = (v.symbol || "").toUpperCase();
    } catch { /* leave unresolved */ }
  }
  return map;
}

// Kamino's `apy` (== apyActual == apyTheoretical) is base lending yield only; farm
// rewards / incentives / reserve incentives are separate additive streams — verified
// against the app's "combined APY" — so summing them is correct, not a double-count.
async function fetchMetrics(address) {
  try {
    const m = await (await fetch(`https://api.kamino.finance/kvaults/${address}/metrics`, { headers: UA })).json();
    const tvl = num(m.tokensInvestedUsd) + num(m.tokensAvailableUsd);
    const base = num(m.apy) * 100;
    const reward = (num(m.apyFarmRewards) + num(m.apyIncentives) + num(m.apyReservesIncentives)) * 100;
    const mean30 = num(m.apy30d) * 100;
    const apy7 = m.apy7d != null ? num(m.apy7d) * 100 : null;
    return { tvl, base, reward, mean30, apy7 };
  } catch { return null; }
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

// Returns synthetic DefiLlama-shaped pool objects for stable Kamino lending vaults
// above the TVL floor. `stableSet` = uppercased symbols we trust (from trusted-stables).
export async function fetchKaminoVaults(stableSet, tvlFloor = 1e6) {
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

  const metrics = await mapLimit(cand, 8, (v) => fetchMetrics(v.address));
  const pools = [];
  for (let k = 0; k < cand.length; k++) {
    const v = cand[k], m = metrics[k];
    if (!m || !(m.tvl >= tvlFloor)) continue;   // also drops NaN tvl
    pools.push({
      project: "kamino-lend",
      chain: "Solana",
      symbol: v.symbol,
      poolMeta: null,
      displayName: v.name,                  // real vault name → row label
      exactUrl: `https://app.kamino.finance/lend/${v.address}`,
      pool: v.address,                      // stable id (override + history key)
      underlyingTokens: [v.mint],
      stablecoin: true,
      outlier: false,
      exposure: "single",
      ilRisk: "no",
      tvlUsd: m.tvl,
      apyBase: m.base,
      apyReward: m.reward > 0 ? m.reward : null,
      apy: m.base + (m.reward > 0 ? m.reward : 0),
      apyMean30d: m.mean30,
      apyPct7D: m.apy7,
      apyPct30D: null,
      volumeUsd1d: null,
      volumeUsd7d: null,
    });
  }
  console.log(`  kamino vaults: ${pools.length} stable lending vaults ≥ $${tvlFloor / 1e6}M (of ${list.length} on-chain)`);
  return pools;
}
