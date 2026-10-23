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
import { vendorLogos } from "./logos.mjs";
import { loadLedgerForBuild } from "./flows-file.mjs";
import { flowsCoverage } from "./flows.mjs";
import { makeSlim } from "./slim.mjs";
import { fetchEarnVaults, depositIndex, matchDeposit, depositLog } from "./deposits.mjs";

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
// Money-flows ledger (flows.mjs), written once a day by the flows job (flows-run.mjs).
const FLOWS = join(HERE, "state", "flows-ledger.json");
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
  const eu = report.euler;
  console.log(`  euler: kept ${eu.kept} · dropped deprecated ${eu.deprecated} · hidden by Euler ${eu.hidden} · not in Euler's labels ${eu.unlisted}` +
    ` · ambiguous ${eu.ambiguous} · on chains not covered ${eu.otherChains}` +
    (eu.unavailable ? ` · labels unavailable ${eu.unavailable} (${eu.unavailableChains.join(", ")})` : ""));
  // Each Euler problem also becomes a GitHub Actions warning in CI (not a page notice).
  const euWarn = [];
  if (eu.unavailable) euWarn.push({ id: "euler-labels", text: `euler: no labels for ${eu.unavailableChains.join(", ")} — ${eu.unavailable} Euler pools hidden (fail closed)` });
  if (eu.noMatchChains.length) euWarn.push({ id: "euler-match", text: `euler: labels loaded but no pool matched on ${eu.noMatchChains.join(", ")} — check DefiLlama poolMeta vs on-chain vault names` });
  if (eu.ambiguous) euWarn.push({ id: "euler-ambiguous", text: `euler: ${eu.ambiguous} pools share a vault name + asset with another pool — dropped` });
  for (const line of noticeLog(euWarn, process.env)) console.warn(line);
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
  // FLOWS_CARD=1 shows the Money flows card for a local build only (like LEVEL_WINDOWS).
  const flowsOn = process.env.FLOWS_CARD ? process.env.FLOWS_CARD === "1" : DEFAULT_CONFIG.flowsCard;
  if (process.env.FLOWS_CARD === "1" && !DEFAULT_CONFIG.flowsCard) console.warn("  ⚠ FLOWS_CARD=1: Money flows card on — local check only, do NOT commit site/data/latest.json from this build");
  // DEPOSITS=1 shows the Deposit button for a local build only (like FLOWS_CARD).
  const depositsOn = process.env.DEPOSITS ? process.env.DEPOSITS === "1" : DEFAULT_CONFIG.deposits;
  if (process.env.DEPOSITS === "1" && !DEFAULT_CONFIG.deposits) console.warn("  ⚠ DEPOSITS=1: Deposit button on — local check only, do NOT commit site/data/latest.json from this build");
  const r = runPipeline(pools, { baseRate: rate, sticky: { state: stickyPrev, now: Date.now() }, levelWindows: levelsOn, flowsCard: flowsOn, deposits: depositsOn }, maps);

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
  // Money flows coverage: vaults tracked per protocol. A venue whose decimals, version or
  // address check broke drops to 0 without failing anything, so say it loudly.
  const cov = flowsCoverage(shown);
  console.log(`  ${cov.line}`);
  for (const w of cov.warnings) console.warn(`  ⚠ ${w}`);
  const yieldUnknown = shown.filter((x) => x.factors.find((f) => f.name === "yield")?.unknown).length;
  const yieldMsg = `yield unknown for ${yieldUnknown}/${shown.length} shown pools`;
  if (yieldUnknown > shown.length * 0.2) console.warn(`  ⚠ ${yieldMsg} — check DefiLlama apyMean30d / Kamino apy30d`);
  else console.log(`  ${yieldMsg}`);

  // Sanity floor: never overwrite good data with a thin/partial feed. A healthy build
  // keeps 250+ pools; if the feed came back truncated, fail so the last snapshot stays.
  const MIN_KEPT = 100;
  if (r.stats.kept < MIN_KEPT)
    throw new Error(`sanity floor: only ${r.stats.kept} pools kept (< ${MIN_KEPT}); feed likely partial — refusing to overwrite`);

  const ledger = await loadLedgerForBuild(FLOWS);
  const toRow = makeSlim(names, siteUrls, venues, poolUrls, ledger, Date.now());
  // Deposit targets (#39): LI.FI's vault list, matched per published row. Always computed,
  // so the data can be checked before the switch goes on; the site shows them only when on.
  const earnVaults = await fetchEarnVaults({ key: process.env.LIFI_API_KEY });
  // ~500 listed today; far fewer means an expired key or a broken API, so flag it in CI
  const MIN_EARN = 50;
  if (process.env.LIFI_API_KEY && earnVaults.length < MIN_EARN)
    console.warn(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "  ⚠ "}deposits: LI.FI listed only ${earnVaults.length} vaults (< ${MIN_EARN}) — check the LIFI_API_KEY secret; rows lose their Deposit button`);
  const earnIndex = depositIndex(earnVaults);
  const slim = (x) => { const s = toRow(x); return { ...s, ...matchDeposit(s, earnIndex) }; };
  const windows = { 1: r.windows[1].map(slim), 2: r.windows[2].map(slim), 3: r.windows[3].map(slim) };
  console.log(`  ${depositLog([1, 2, 3].flatMap((w) => windows[w]), earnVaults.length)}`);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: FEED,
    baseRate: r.config.baseRate, // % APY — Aave V3 USDC + USDT (Ethereum), 30-day mean
    config: { ...r.config, sticky: undefined }, // the sticky state lives in levels-state.json
    stats: r.stats,
    notices, // [{ id, text }]: missing venue data, shown above the windows
    windows,
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
