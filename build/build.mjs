// ─────────────────────────────────────────────────────────────────────────────
// BUILD STEP — runs in the GitHub Action (cron */6h + workflow_dispatch).
// fetch DefiLlama + venue APIs → intakePools → runPipeline → write site/data/latest.json
// (committed to repo). The static site reads that JSON. No key, no backend, instant load.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runPipeline, DEFAULT_CONFIG } from "./pipeline.mjs";
import { intakePools } from "./intake.mjs";
import { checkSince } from "./age.mjs";
import { checkDenylist, denylistLog } from "./denylist.mjs";
import { baseRate } from "./base-rate.mjs";
import { checkProtocolLevels } from "./risk.mjs";
import { fetchVenues } from "./venues.mjs";
import { venueNotices, noticeLog } from "./notices.mjs";
import { buildLink } from "./deeplinks.mjs";
import { vendorLogos } from "./logos.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "site");
const OUT = join(SITE, "data", "latest.json");
// Sticky-level state (sticky.mjs): committed next to latest.json so the rule survives
// between 6-hourly runs. Missing → {} (every pool starts at its computed level).
const STATE = join(HERE, "state", "levels-state.json"); // not under site/: internal, never published
async function loadStickyState() {
  let j;
  try { j = JSON.parse(await readFile(STATE, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`levels-state.json unreadable: ${e.message}`, { cause: e }); }
  if (j === null || typeof j !== "object" || Array.isArray(j)) throw new Error("levels-state.json is not an object");
  return j;
}
const FEED = "https://yields.llama.fi/pools";

const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

async function loadMaps() {
  const protocolMap = strip(JSON.parse(await readFile(join(HERE, "trusted-protocols.json"), "utf8")));
  const stableRaw = strip(JSON.parse(await readFile(join(HERE, "trusted-stables.json"), "utf8")));
  const stableMap = {};
  for (const [k, v] of Object.entries(stableRaw)) stableMap[k.toUpperCase()] = v;
  return { protocolMap, stableMap };
}

const loadNames = async () => strip(JSON.parse(await readFile(join(HERE, "protocol-names.json"), "utf8")));

// Manual per-pool deposit-URL overrides (pool id → exact URL). Highest priority.
// Opinion files: a missing file is empty, but a broken one fails the build — a typo must
// never quietly bring back hidden pools or drop curated links.
async function readOpinion(name) {
  let text;
  try { text = await readFile(join(HERE, name), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return null; throw new Error(`${name} unreadable: ${e.message}`, { cause: e }); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${name} is not valid JSON: ${e.message}`, { cause: e }); }
}
async function loadPoolUrls() {
  return (await readOpinion("pool-urls.json"))?.urls || {};
}

// Since overrides: known start dates (facts, no expiry) for pools DefiLlama tracked late.
// Every date is checked here, so a bad entry fails the build at once.
async function loadSince() {
  let text;
  try { text = await readFile(join(HERE, "since.json"), "utf8"); }
  catch (e) { if (e.code === "ENOENT") return {}; throw new Error(`since.json unreadable: ${e.message}`, { cause: e }); }
  const j = JSON.parse(text);
  return checkSince({ pools: j?.pools ?? {}, protocols: j?.protocols ?? {} });
}

// Manual denylist for deprecated-but-functional pools the data can't detect.
// intake.mjs interprets it (pool ids, project|chain|SYMBOL keys, Morpho vaults).
// Each entry carries reason/added/reviewBy; a bad entry fails the build at once, and
// entries past review-by are logged (denylist.mjs) — they stay hidden until a person acts.
async function loadDenylist() {
  const { denylist, expired, undated } = checkDenylist((await readOpinion("denylist.json")) || {});
  for (const line of denylistLog({ expired, undated }, process.env)) console.log(line);
  return denylist;
}

// Map each protocol slug → its official site URL, from DefiLlama's config
// (slug derived from the logo path). Used as the primary deposit link.
async function loadSiteUrls() {
  try {
    const cfg = await (await fetch("https://api.llama.fi/config")).json();
    const arr = Array.isArray(cfg.protocols) ? cfg.protocols : Object.values(cfg.protocols || cfg);
    const map = {};
    for (const p of arr) {
      const slug = (p.logo || "").split("/").pop()?.split("?")[0];
      if (slug && p.url) map[slug] = p.url;
    }
    return map;
  } catch (e) {
    console.warn("config fetch failed, site links fall back:", e.message);
    return {};
  }
}

// Trim a pipeline row to what the site actually renders (+ link & detail fields).
const makeSlim = (names, siteUrls, sources, poolUrls) => (r) => {
  const { url, kind } = buildLink(r, { siteUrl: siteUrls[r.project], sources, override: poolUrls[r.pool] });
  return {
    project: r.project,
    name: names[r.project] || r.project,
    symbol: r.label, // row label from intake: venue's vault name, or symbol · market
    chain: r.chain,
    bucket: r.bucket,
    access: r.access,
    type: r.stableType, // fiat | crypto | yield | rwa | synthetic
    tier: r.tier, // coin Tier (the Coin factor) — independent of which window the row is in
    tierDriver: r.tierDriver,
    level: r.level, // risk Level shown (sticky rule applied, sticky.mjs)
    levelComputed: r.levelComputed, // this run's level before the sticky rule
    levelDriver: r.levelDriver,
    factors: r.factors,
    base: round(r.base),
    reward: round(r.reward),
    total: round(r.total),
    spot: r.spot == null ? null : round(r.spot),
    mean30d: r.mean30d == null ? null : round(r.mean30d),
    divFlag: r.divFlag,
    tvlUsd: Math.round(r.tvlUsd),
    legs: r.legs, // true stablecoin legs (classification), independent of display symbol
    url,
    linkKind: kind, // 'exact' | 'site' | 'defillama' | null
    // detail-panel fields (Phase 3)
    exposure: r.exposure,
    ilRisk: r.ilRisk,
    apyReward: r.apyReward == null ? null : round(r.apyReward),
    volumeUsd1d: r.volumeUsd1d == null ? null : Math.round(r.volumeUsd1d),
    volumeUsd7d: r.volumeUsd7d == null ? null : Math.round(r.volumeUsd7d),
    apyPct7D: r.apyPct7D == null ? null : round(r.apyPct7D),
    apyPct30D: r.apyPct30D == null ? null : round(r.apyPct30D),
    poolId: r.pool,
  };
};
const round = (n) => Math.round(n * 100) / 100;

async function main() {
  const maps = await loadMaps();
  const [names, siteUrls, denylist, poolUrls, since] = await Promise.all([loadNames(), loadSiteUrls(), loadDenylist(), loadPoolUrls(), loadSince()]);
  console.log("fetching", FEED, "…");
  const res = await fetch(FEED);
  if (!res.ok) throw new Error(`feed ${res.status}`);
  const { data: feed } = await res.json();

  const venues = await fetchVenues({
    chains: DEFAULT_CONFIG.chains,
    stableSet: new Set(Object.keys(maps.stableMap)),
    tvlFloor: DEFAULT_CONFIG.tvlFloor,
  });
  // Lending TVL = total deposits needs the lendBorrow feed. Without it every lending row
  // would quietly fall back to net-of-loans TVL (and drop under the floor), so keep the
  // last good snapshot instead, like the sanity floor below.
  // A short map (degraded upstream, renamed field) is as bad as an empty one. ~2,370 today.
  const MIN_LENDBORROW = 1000;
  const lb = venues.lendBorrow?.size ?? 0;
  if (lb < MIN_LENDBORROW)
    throw new Error(`lendBorrow feed has ${lb} pools (< ${MIN_LENDBORROW}) — lending TVL would be net of loans; refusing to overwrite`);
  // Venue data that failed completely is shown on the page, not only in this log.
  const notices = venueNotices(venues);
  for (const line of noticeLog(notices, process.env)) console.log(line);
  const { pools, report } = intakePools(feed, venues, { denylist, poolUrls, since, now: Date.now() });
  console.log(
    `  intake: denied ${report.denied} · lending TVL→deposits ${report.lendingTotals} · morpho vaults ${report.morphoVaults} · yearn named ${report.yearnNamed}` +
      ` · kamino −${report.kaminoDropped} isolated markets +${report.kaminoAdded} lending vaults`
  );
  if (report.sinceUnused.length) console.warn(`  since.json entries that match no pool (typo or stale?): ${report.sinceUnused.join(", ")}`);
  for (const g of report.morphoGuarded)
    console.warn(
      `  link guard: ${g.label} (${g.chain}) vault ${g.address} TVL $${Math.round(g.vaultTvl)} vs DefiLlama $${Math.round(g.llamaTvl)} → DefiLlama link`
    );

  // LEVEL_WINDOWS=1 turns the risk-level switch on for a local build only; the
  // committed default lives in DEFAULT_CONFIG.levelWindows.
  const levelsOn = process.env.LEVEL_WINDOWS ? process.env.LEVEL_WINDOWS === "1" : DEFAULT_CONFIG.levelWindows;
  if (process.env.LEVEL_WINDOWS && !["0", "1"].includes(process.env.LEVEL_WINDOWS))
    console.warn(`  LEVEL_WINDOWS=${process.env.LEVEL_WINDOWS} not recognised (use 1 or 0) — switch stays off`);
  if (process.env.LEVEL_WINDOWS === "1" && !DEFAULT_CONFIG.levelWindows) console.warn("  ⚠ LEVEL_WINDOWS=1: windows grouped by level — local check only, do NOT commit site/data/latest.json from this build");
  // Base rate for the Yield factor: Aave V3 USDC + USDT, 30-day mean (throws if missing).
  const rate = baseRate(feed);
  const noLevel = checkProtocolLevels(maps.protocolMap); // throws on a bad level
  if (noLevel.length) console.warn(`  ⚠ trusted-protocols.json: no level for ${noLevel.join(", ")} — Protocol factor unknown (Level 2) for their pools`);
  const stickyPrev = await loadStickyState();
  const r = runPipeline(pools, { baseRate: rate, sticky: { state: stickyPrev, now: Date.now() }, levelWindows: levelsOn }, maps);

  // Age data health over the rows we show: if an age source breaks (renamed field, API
  // change), every pool silently drops to "unknown" (Level 2). Warn loudly above 20%.
  const shown = [1, 2, 3].flatMap((w) => r.windows[w]);
  const ageUnknown = shown.filter((x) => x.factors.find((f) => f.name === "age")?.unknown).length;
  const ageMsg = `age unknown for ${ageUnknown}/${shown.length} shown pools`;
  if (ageUnknown > shown.length * 0.2) console.warn(`  ⚠ ${ageMsg} — check DefiLlama count / Kamino creationTimestamp`);
  else console.log(`  ${ageMsg}`);
  if (r.stickyInvalid) {
    const share = r.stickyInvalid / Math.max(1, shown.length);
    if (share > 0.1) throw new Error(`levels-state.json: ${r.stickyInvalid} entries invalid (${Math.round(share * 100)}%) — refusing to reset that many pools`);
    console.warn(`  ⚠ levels-state.json: ${r.stickyInvalid} invalid entries started fresh`);
  }
  const yieldUnknown = shown.filter((x) => x.factors.find((f) => f.name === "yield")?.unknown).length;
  const yieldMsg = `yield unknown for ${yieldUnknown}/${shown.length} shown pools`;
  if (yieldUnknown > shown.length * 0.2) console.warn(`  ⚠ ${yieldMsg} — check DefiLlama apyMean30d / Kamino apy30d`);
  else console.log(`  ${yieldMsg}`);

  // Sanity floor: never overwrite good data with a thin/partial feed. A healthy build
  // keeps 250+ pools; if the feed came back truncated, fail so the last snapshot stays.
  const MIN_KEPT = 100;
  if (r.stats.kept < MIN_KEPT)
    throw new Error(`sanity floor: only ${r.stats.kept} pools kept (< ${MIN_KEPT}); feed likely partial — refusing to overwrite`);

  const slim = makeSlim(names, siteUrls, venues, poolUrls);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: FEED,
    baseRate: r.config.baseRate, // % APY — Aave V3 USDC + USDT (Ethereum), 30-day mean
    config: { ...r.config, sticky: undefined }, // the sticky state lives in levels-state.json
    stats: r.stats,
    notices, // [{ id, text }]: missing venue data, shown above the windows
    windows: {
      1: r.windows[1].map(slim),
      2: r.windows[2].map(slim),
      3: r.windows[3].map(slim),
    },
    // small transparency block — what the opinion excluded, in aggregate
    rejects: Object.fromEntries(Object.entries(r.rejects).map(([k, v]) => [k, v.count])),
    missingTop: r.missingProtocols.slice(0, 10).map((m) => ({ project: m.project, tvlUsd: Math.round(m.tvl) })),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  // Only the CI refresh advances the sticky state (6-hourly runs); local builds would count
  // as extra runs and clash with the bot's push. A switch-on local check never writes it.
  if (process.env.GITHUB_ACTIONS === "true" && !process.env.LEVEL_WINDOWS) {
    await mkdir(dirname(STATE), { recursive: true });
    await writeFile(STATE, JSON.stringify(r.stickyState) + "\n");
  }
  else console.log("  levels-state.json not written (local build)");
  console.log(
    `wrote ${OUT}\n  kept ${r.stats.kept}/${r.stats.totalPools}  windows ${r.stats.perTier[1]}/${r.stats.perTier[2]}/${r.stats.perTier[3]} (${r.config.levelWindows ? "by level" : "by tier"}) · levels ${r.stats.perLevel[1]}/${r.stats.perLevel[2]}/${r.stats.perLevel[3]} · base rate ${r.config.baseRate}%` +
      `\n  inactive-lp ${r.rejects["inactive-lp"]?.count || 0} · zero-yield ${r.rejects["zero-yield"]?.count || 0}`
  );

  // vendor logos for every allowlisted protocol + configured chain (fetch-if-missing)
  const slugs = Object.keys(maps.protocolMap);
  const logo = await vendorLogos(SITE, slugs, r.config.chains);
  console.log(`  logos: ${slugs.length} protocols + ${r.config.chains.length} chains (${logo.fetched} newly fetched)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
