// ─────────────────────────────────────────────────────────────────────────────
// PURE PIPELINE — the bit worth keeping.
// (pools, config, maps) → { windows, rejects, missingProtocols, stats }
//
// No I/O, no console, no terminal codes. The TUI shell imports this and calls it.
// When the prototype has answered its question, THIS module lifts straight into
// the real GitHub Action build script; the TUI gets deleted.
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  tvlFloor: 1_000_000,
  sortKey: "base",              // 'base' | 'total' | 'mean30d'
  dropOutliers: true,
  chains: ["Ethereum", "Arbitrum", "Base", "Optimism", "Polygon", "Solana"],
  divUp: 0.20,                  // >+20% spot vs 30d mean → ▲ spiking
  divDown: -0.20,              // <−20% → ▼ decaying
  lpMinVol7d: 25000,           // LP with <$25k 7-day volume → inactive/dead
  lpMinVol1d: 5000,            // …or <$5k 1-day volume when 7d is unavailable
};

const norm = (s) => String(s ?? "").trim().toUpperCase();

// DefiLlama `symbol` → array of stable legs. "USDC-USDT" → ["USDC","USDT"].
export function parseLegs(symbol) {
  return norm(symbol)
    .split(/[-/+]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// tier = riskiest (max) leg; null if any leg is unmapped. driver = the leg that set
// it; driverType = that leg's stable type (fiat|crypto|yield|rwa|synthetic).
function classifyTier(legs, stableMap) {
  const unmatched = [];
  let tier = -Infinity;
  let driver = null;
  let driverType = null;
  for (const leg of legs) {
    const e = stableMap[leg];
    if (e === undefined) unmatched.push(leg);
    else if (e.tier > tier) { tier = e.tier; driver = leg; driverType = e.type; }
  }
  if (unmatched.length) return { tier: null, driver: null, driverType: null, unmatched };
  return { tier, driver, driverType, unmatched: [] };
}

// Organic-yield sort key with the fallback ladder from the spec.
export function baseSortKey(pool) {
  const apy = pool.apy ?? 0;
  const b = pool.apyBase;
  const r = pool.apyReward;
  if (b != null) return b;                 // apyBase present → use it
  if (r == null) return apy;               // both null → apy is organic
  return apy - r;                          // reward present → subtract it
}

function divergence(pool, cfg) {
  const m = pool.apyMean30d;
  if (m == null || m === 0) return { ratio: null, flag: "?" };
  const ratio = ((pool.apy ?? 0) - m) / m;
  const flag = ratio > cfg.divUp ? "▲" : ratio < cfg.divDown ? "▼" : "●";
  return { ratio, flag };
}

// Evaluate ONE pool. Returns {ok, reason?, row?}. Filters run in a fixed order so
// reject reasons are unambiguous.
function evaluate(pool, cfg, protocolMap, stableMap) {
  if (!pool.stablecoin) return { ok: false, reason: "not-stablecoin" };
  if (!cfg.chains.some((c) => norm(c) === norm(pool.chain)))
    return { ok: false, reason: "chain-excluded" };
  if (!(pool.tvlUsd > cfg.tvlFloor)) return { ok: false, reason: "below-tvl-floor" };
  if (cfg.dropOutliers && pool.outlier === true) return { ok: false, reason: "outlier" };

  const meta = protocolMap[pool.project];
  if (!meta) return { ok: false, reason: "protocol-not-trusted" };

  const legs = parseLegs(pool.symbol);
  const { tier, driver, driverType, unmatched } = classifyTier(legs, stableMap);
  if (tier == null) return { ok: false, reason: "unmapped-stable-leg", unmatched };

  // Liveness: drop pools that offer nothing to park for, or dead LP pools.
  const spot = pool.apy ?? 0;
  const mean = pool.apyMean30d ?? null;
  if (spot <= 0 && (mean ?? 0) <= 0) return { ok: false, reason: "zero-yield" };
  if (meta.bucket === "LP") {
    const v7 = pool.volumeUsd7d, v1 = pool.volumeUsd1d;
    const dead = v7 != null ? v7 < cfg.lpMinVol7d : v1 != null ? v1 < cfg.lpMinVol1d : false;
    if (dead) return { ok: false, reason: "inactive-lp" };
  }

  // Headline/sort number. Lend & vault APYs are stable, so use the spot organic base.
  // AMM/LP fee-APY is annualized from ~24h volume and swings hard (both up on volume
  // spikes and down as they fade), so for LP we lead with the CONSERVATIVE figure —
  // min(current spot, 30-day mean) — which never overstates what you'd earn today.
  // Spot is still shown in the panel; the ▲/▼ flag compares spot vs the 30-day mean.
  const spotBase = baseSortKey(pool);
  const isLP = meta.bucket === "LP";
  const base = isLP ? (mean != null ? Math.min(spot, mean) : spotBase) : spotBase;
  const reward = isLP ? 0 : Math.max(0, spot - spotBase);
  const total = base + reward;
  const { ratio, flag } = divergence(pool, cfg);

  return {
    ok: true,
    row: {
      project: pool.project,
      symbol: pool.symbol,
      chain: pool.chain,
      bucket: meta.bucket,
      access: meta.access,
      tier,
      tierDriver: driver,
      stableType: driverType,
      base,
      reward,
      total,
      spot,                       // current spot total APY (for the panel + divergence)
      mean30d: mean,
      divRatio: ratio,
      divFlag: flag,
      tvlUsd: pool.tvlUsd,
      legs,
      // passthroughs for links + detail panel (consumed downstream, not by ranking)
      exactUrl: pool.exactUrl ?? null,   // pre-resolved exact link (e.g. Morpho vault)
      displayName: pool.displayName ?? null, // override for the row label
      pool: pool.pool,
      underlyingTokens: pool.underlyingTokens ?? null,
      poolMeta: pool.poolMeta ?? null,
      exposure: pool.exposure ?? null,
      ilRisk: pool.ilRisk ?? null,
      apyReward: pool.apyReward ?? null,
      volumeUsd1d: pool.volumeUsd1d ?? null,
      volumeUsd7d: pool.volumeUsd7d ?? null,
      apyPct7D: pool.apyPct7D ?? null,
      apyPct30D: pool.apyPct30D ?? null,
    },
  };
}

export function runPipeline(pools, config = {}, maps) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { protocolMap, stableMap } = maps;

  const windows = { 1: [], 2: [], 3: [] };
  const rejects = {};                 // reason → { count, tvl }
  const missingByProject = {};        // project → { count, tvl } (passed everything but allowlist)

  for (const pool of pools) {
    const res = evaluate(pool, cfg, protocolMap, stableMap);
    if (res.ok) {
      windows[res.row.tier].push(res.row);
    } else {
      const rj = (rejects[res.reason] ??= { count: 0, tvl: 0 });
      rj.count++;
      rj.tvl += pool.tvlUsd ?? 0;
      if (res.reason === "protocol-not-trusted") {
        const m = (missingByProject[pool.project] ??= { count: 0, tvl: 0 });
        m.count++;
        m.tvl += pool.tvlUsd ?? 0;
      }
    }
  }

  const cmp = {
    base: (a, b) => b.base - a.base,
    total: (a, b) => b.total - a.total,
    mean30d: (a, b) => (b.mean30d ?? -1) - (a.mean30d ?? -1),
  }[cfg.sortKey];
  for (const t of [1, 2, 3]) windows[t].sort(cmp);

  const missingProtocols = Object.entries(missingByProject)
    .map(([project, v]) => ({ project, ...v }))
    .sort((a, b) => b.tvl - a.tvl);

  const stats = {
    totalPools: pools.length,
    kept: windows[1].length + windows[2].length + windows[3].length,
    perTier: { 1: windows[1].length, 2: windows[2].length, 3: windows[3].length },
  };

  return { windows, rejects, missingProtocols, stats, config: cfg };
}
