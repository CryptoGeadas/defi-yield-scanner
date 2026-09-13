// ─────────────────────────────────────────────────────────────────────────────
// KAMINO LENDING VAULTS — on-chain source (DefiLlama only tracks Kamino's isolated
// markets, not the curated "Lend" vaults). We list the kvault program's VaultState
// accounts via a public Solana RPC, decode name + token + address, then pull live
// APY/TVL from Kamino's public metrics API. Output is shaped like DefiLlama pools so
// it flows through the normal pipeline. Best-effort: any failure returns [] and the
// build proceeds without Kamino vaults (never crashes the refresh).
// ─────────────────────────────────────────────────────────────────────────────
import crypto from "node:crypto";

const KVAULT = "KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd";
const RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
];
const NAME_OFF = 58528, NAME_LEN = 40;            // VaultState.name (fixed offset)
const MINT_OFF = 80, DEC_OFF = 112;               // tokenMint, tokenMintDecimals
const UA = { "User-Agent": "Mozilla/5.0 Chrome/124" };

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const bs58 = (buf) => {
  let d = [0];
  for (const b of buf) { let c = b; for (let i = 0; i < d.length; i++) { c += d[i] << 8; d[i] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
  let s = ""; for (const b of buf) { if (b === 0) s += "1"; else break; }
  return s + d.reverse().map((x) => B58[x]).join("");
};
const u64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) + BigInt(b[o + i]); return v; };

async function rpcGetProgramAccounts() {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getProgramAccounts", params: [KVAULT, { encoding: "base64" }] });
  for (const rpc of RPCS) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json", ...UA }, body });
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j.result) && j.result.length) return j.result;
    } catch { /* try next RPC */ }
  }
  return null;
}

function decodeVaults(accounts) {
  const disc = crypto.createHash("sha256").update("account:VaultState").digest().subarray(0, 8);
  const out = [];
  for (const a of accounts) {
    const data = Buffer.from(a.account.data[0], "base64");
    if (data.length < NAME_OFF + NAME_LEN || !data.subarray(0, 8).equals(disc)) continue;
    const name = data.subarray(NAME_OFF, NAME_OFF + NAME_LEN).toString("utf8").replace(/\0+$/, "").trim();
    out.push({ address: a.pubkey, mint: bs58(data.subarray(MINT_OFF, MINT_OFF + 32)), decimals: Number(u64(data, DEC_OFF)), name });
  }
  return out;
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

async function fetchMetrics(address) {
  try {
    const m = await (await fetch(`https://api.kamino.finance/kvaults/${address}/metrics`, { headers: UA })).json();
    const tvl = Number(m.tokensInvestedUsd || 0) + Number(m.tokensAvailableUsd || 0);
    const base = Number(m.apy || 0) * 100;
    const reward = (Number(m.apyFarmRewards || 0) + Number(m.apyIncentives || 0) + Number(m.apyReservesIncentives || 0)) * 100;
    const mean30 = Number(m.apy30d || 0) * 100;
    const apy7 = m.apy7d != null ? Number(m.apy7d) * 100 : null;
    if (!Number.isFinite(tvl)) return null;
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

// Returns synthetic DefiLlama-shaped pool objects for stable Kamino lending vaults
// above the TVL floor. `stableSet` = uppercased symbols we trust (from trusted-stables).
export async function fetchKaminoVaults(stableSet, tvlFloor = 1e6) {
  const accounts = await rpcGetProgramAccounts();
  if (!accounts) { console.warn("kamino: getProgramAccounts failed on all RPCs — skipping vaults"); return []; }
  const vaults = decodeVaults(accounts);
  const symMap = await resolveSymbols([...new Set(vaults.map((v) => v.mint))]);
  // Exclude non-"Lend" products (Institutional / Private Credit are separate,
  // access-gated tabs) and obvious test/staging vaults.
  const EXCLUDE = /institutional|private credit|\btest|staging|\bdev\b|e2e|\bexample\b/i;
  const stable = vaults
    .map((v) => ({ ...v, symbol: symMap[v.mint] || "" }))
    .filter((v) => stableSet.has(v.symbol) && !EXCLUDE.test(v.name));
  const metrics = await mapLimit(stable, 8, (v) => fetchMetrics(v.address));
  const pools = [];
  for (let k = 0; k < stable.length; k++) {
    const v = stable[k], m = metrics[k];
    if (!m || m.tvl < tvlFloor) continue;
    pools.push({
      project: "kamino-lend",
      chain: "Solana",
      symbol: v.symbol,
      poolMeta: null,
      displayName: v.name || v.symbol,      // real vault name → row label
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
  console.log(`  kamino vaults: ${pools.length} stable lending vaults ≥ $${(tvlFloor / 1e6)}M (of ${vaults.length} on-chain)`);
  return pools;
}
