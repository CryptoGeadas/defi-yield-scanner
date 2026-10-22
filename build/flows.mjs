// ─────────────────────────────────────────────────────────────────────────────
// MONEY FLOWS LEDGER — pure. The rolling 30-day record behind the "Money flows" card:
// per vault, per UTC day, money in (Deposit), money out (Withdraw) and the biggest single
// exit, in the vault's stablecoin (read as dollars). The flows job (flows-run.mjs) adds
// each day's events from the SQD Portal (portal.mjs); the build turns the ledger into a
// `flows` object on every row. Flows are shown only: they never touch Level or any Factor.
//
//   emptyLedger() → ledger
//   addFlows(ledger, { chain, events, lastBlock, today, tracked, backfill }) → new ledger
//     `today` is the last COMPLETE UTC day the run read on that chain: it becomes the
//     chain's `asOf`. Later days are kept but not counted until a run completes them; that
//     chain's days before today − 29 are dropped.
//     `tracked` = [{ address, decimals }]. A vault first seen in a backfill run has data from
//     the backfill's first day (`backfill` = that "YYYY-MM-DD", or true for the full 30 days);
//     one first seen later has complete days only from tomorrow (`firstDay`).
//   flowsSummary(ledger, chain, address) → { in30, out30, net7, net30, maxOut30, asOf } | null
//   rowFlows(row, ledger) → { status: "untracked" | "unavailable" | "collecting" | "partial" | "full", since?, ...summary }
//     ledger null = it could not be read. Under 7 full days: "collecting" (no numbers);
//     7–29: "partial", numbers since `since`; 30+: "full". Missing days are never $0.
//
// Ledger: { asOf: "YYYY-MM-DD" | null, chains: { ethereum: { lastBlock, asOf } },
//           vaults: { "ethereum:0x…": { decimals, firstDay, days: { "YYYY-MM-DD": { in, out, maxOut } } } } }
// ─────────────────────────────────────────────────────────────────────────────

export const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;
export const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const cents = (n) => Math.round(n * 100) / 100;
const keyOf = (chain, address) => `${chain}:${String(address).toLowerCase()}`;

export const emptyLedger = () => ({ asOf: null, chains: {}, vaults: {} });

// Vaults the ledger already follows on a chain: [{ address, decimals }].
export const ledgerVaults = (ledger, chain) =>
  Object.entries(ledger?.vaults ?? {})
    .filter(([k, v]) => k.startsWith(`${chain}:`) && Number.isInteger(v.decimals))
    .map(([k, v]) => ({ address: k.slice(chain.length + 1), decimals: v.decimals }));

// `seen`: addresses in this run's snapshot; each gets lastSeen = today, so the job can drop a
// vault that has been out of the Scanner for 30 days (flows-job.mjs).
export function addFlows(ledger, { chain, events, lastBlock, today, tracked = [], backfill = false, newFrom = null, updatedAt = null, seen = [] }) {
  const next = structuredClone(ledger);
  // a backfill's vaults have data from the day it started reading (a "YYYY-MM-DD"; true =
  // the full 30 days), even when the run stopped short of today
  // `newFrom`: the first day this run read in full (from the job); never earlier than tomorrow
  const later = (a, b) => (a && a > b ? a : b);
  const firstDay = typeof backfill === "string" ? backfill : backfill ? shiftDay(today, -(KEEP_DAYS - 1)) : later(newFrom, shiftDay(today, 1));
  const vaultOf = (address) => (next.vaults[keyOf(chain, address)] ??= { firstDay, days: {} });
  for (const t of tracked) vaultOf(t.address).decimals = t.decimals;
  for (const a of seen) vaultOf(a).lastSeen = today;
  const touched = new Set();
  for (const e of events) {
    const d = (vaultOf(e.vault).days[e.day] ??= { in: 0, out: 0, maxOut: 0 });
    touched.add(d);
    if (e.kind === "in") d.in += e.amount;
    else {
      d.out += e.amount;
      d.maxOut = Math.max(d.maxOut, e.amount);
    }
  }
  // round once per day, after summing, so many small events don't lose cents
  for (const d of touched) for (const k of ["in", "out", "maxOut"]) d[k] = cents(d[k]);
  const oldest = shiftDay(today, -(KEEP_DAYS - 1));
  for (const [k, v] of Object.entries(next.vaults))
    if (k.startsWith(`${chain}:`)) for (const day of Object.keys(v.days)) if (day < oldest) delete v.days[day];
  // updatedAt: when this chain last read new data (the job passes the run time)
  next.chains[chain] = { ...next.chains[chain], lastBlock, asOf: today, ...(updatedAt ? { updatedAt } : {}) };
  next.asOf = today; // latest run of any chain; each chain's own day is chains[chain].asOf
  return next;
}

// the last complete day of one chain (older ledgers kept only the shared asOf)
const asOfFor = (ledger, chain) => ledger?.chains?.[chain]?.asOf ?? ledger?.asOf ?? null;

export function flowsSummary(ledger, chain, address) {
  const v = ledger?.vaults?.[keyOf(chain, address)];
  const asOf = asOfFor(ledger, chain);
  if (!v || !asOf) return null;
  // the window starts at the vault's first full day when that is later: a half day read
  // before the vault was first seen is never counted
  const window30 = shiftDay(asOf, -(KEEP_DAYS - 1));
  const from30 = v.firstDay && v.firstDay > window30 ? v.firstDay : window30, from7 = shiftDay(asOf, -6);
  const s = { in30: 0, out30: 0, net7: 0, net30: 0, maxOut30: 0 };
  if (!v.days || typeof v.days !== "object") return null; // damaged record: no numbers
  const num = (x) => typeof x === "number" && Number.isFinite(x);
  for (const [day, d] of Object.entries(v.days)) {
    if (day < from30 || day > asOf) continue;
    if (!d || !num(d.in) || !num(d.out) || !num(d.maxOut)) return null; // a damaged day is never a $0 day
    s.in30 += d.in;
    s.out30 += d.out;
    s.maxOut30 = Math.max(s.maxOut30, d.maxOut);
    if (day >= from7) s.net7 += d.in - d.out;
  }
  s.net30 = s.in30 - s.out30;
  for (const k of Object.keys(s)) s[k] = cents(s[k]);
  if (!Object.values(s).every(Number.isFinite)) return null; // a damaged day entry: no numbers, not NaN
  return { ...s, asOf };
}

// Coverage: how many full days the ledger holds for a vault decides what is shown.
export const MIN_DAYS = 7; // under this: "collecting", no numbers
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const daysFrom = (first, last) => Math.round((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY_MS) + 1;

// Freshness. Numbers are STALE (shown dimmed, with their "As of" day) when either
//   • the chain's last successful update (updatedAt) is over 36 h old — like the site's own
//     stale dot: the daily run is scheduled for 04:40 UTC but GitHub can start it hours late;
//   • or the data's own last day (asOf) ended over 48 h ago — this also covers ledgers with no
//     updatedAt and a chain that keeps reading only part of the way;
//   • or updatedAt is there but damaged (it cannot prove the numbers are current).
// The page runs the same rule with the viewer's clock (a snapshot that stops publishing).
// LATE: the flows job fails (red, so GitHub emails) once a chain has not updated for 72 h.
export const STALE_MS = 36 * 3_600_000;
export const DATA_STALE_MS = 48 * 3_600_000;
export const LATE_MS = 72 * 3_600_000;
const endOfDay = (day) => Date.parse(`${day}T00:00:00Z`) + DAY_MS;

// → { stale, updatedAt (valid ISO or null), ageMs (since the last good update, or the end of
//     the data's last day when updatedAt is unknown; NaN if neither is usable) }
export function freshness(chainInfo, fallbackAsOf, now) {
  const raw = chainInfo?.updatedAt, asOf = chainInfo?.asOf ?? fallbackAsOf;
  const at = typeof raw === "string" ? Date.parse(raw) : NaN;
  const dataEnd = typeof asOf === "string" && DAY.test(asOf) ? endOfDay(asOf) : NaN;
  const damaged = raw != null && !Number.isFinite(at);
  const stale = damaged || (Number.isFinite(at) && now - at > STALE_MS) || (Number.isFinite(dataEnd) && now - dataEnd > DATA_STALE_MS);
  return { stale, updatedAt: Number.isFinite(at) ? raw : null, ageMs: Number.isFinite(at) ? now - at : now - dataEnd };
}

// Why a row has no flows, in the reader's terms (the page turns the code into words).
// Every sentence must be TRUE for its row, so nothing is guessed:
//   • a Morpho / Euler / Yearn row carries the real reason from intake (row.flowsBlock);
//   • any other row: a DEX pool, a plain lending market (only a $1 coin, never a savings
//     token like sGHO or Aave's Umbrella staking), or else "not read for this protocol".
// lending markets (pools you lend into), as opposed to the vaults and fund tokens that share
// the "lend" bucket in trusted-protocols.json; a test checks every protocol there is classified
export const LENDING_MARKETS = new Set(["aave-v3", "aave-v4", "compound-v3", "compound-v2", "sparklend", "marginfi", "jupiter-lend", "save"]);
// stable types whose token amount reads as dollars; pipeline.mjs uses this same set to decide
// which vaults are tracked, so the two can never disagree
export const DOLLAR_TYPES = new Set(["fiat", "crypto", "synthetic"]);
export const UNTRACKED_REASONS = ["dex", "lending", "protocol", "chain", "coin", "unverified", "version"];
export function untrackedReason(row) {
  if (UNTRACKED_REASONS.includes(row.flowsBlock)) return row.flowsBlock;
  if (row.bucket === "LP") return "dex";
  const plainMarket = LENDING_MARKETS.has(row.project) && DOLLAR_TYPES.has(row.stableType) && !/umbrella/i.test(`${row.label ?? ""} ${row.poolMeta ?? ""}`);
  return plainMarket ? "lending" : "protocol";
}

export function rowFlows(row, ledger, now = Date.now()) {
  if (!row.vault) return { status: "untracked", reason: untrackedReason(row) };
  if (!ledger) return { status: "unavailable" };
  const v = ledger.vaults?.[keyOf(row.vault.chain, row.vault.address)];
  const asOf = asOfFor(ledger, row.vault.chain);
  if (!v) return { status: "collecting", since: null }; // the job has not read it yet
  if (typeof v !== "object" || !asOf) return { status: "unavailable" }; // a stored vault always has a chain day
  // a ledger entry without a well-formed first day or as-of date: no numbers, no guessed state
  if (!DAY.test(String(v.firstDay)) || !DAY.test(String(asOf))) return { status: "unavailable" };
  const covered = daysFrom(v.firstDay, asOf);
  if (!Number.isFinite(covered)) return { status: "unavailable" }; // a damaged date: no numbers, never a guessed state
  // stale only when true; updatedAt whenever known (the page re-checks with its own clock)
  const fr = freshness(ledger.chains?.[row.vault.chain], ledger.asOf, now);
  const fresh = { ...(fr.stale ? { stale: true } : {}), ...(fr.updatedAt ? { updatedAt: fr.updatedAt } : {}) };
  if (covered < MIN_DAYS) return { status: "collecting", since: v.firstDay, ...fresh };
  const s = flowsSummary(ledger, row.vault.chain, row.vault.address);
  if (!s) return { status: "unavailable" };
  return covered >= KEEP_DAYS ? { status: "full", ...s, ...fresh } : { status: "partial", since: v.firstDay, ...s, ...fresh };
}

// Build-log coverage: vaults tracked per venue, and a warning when a venue that has Ethereum
// rows tracks none (its registry, decimals or version data broke without failing anything).
export function flowsCoverage(rows) {
  const tracked = {};
  for (const x of rows) if (x.vault) tracked[x.project] = (tracked[x.project] || 0) + 1;
  const total = Object.values(tracked).reduce((a, b) => a + b, 0);
  const line = `flows: tracking ${total} vaults (${Object.entries(tracked).map(([p, n]) => `${p} ${n}`).join(" · ") || "none"})`;
  const warnings = ["morpho-blue", "yearn-finance", "euler-v2"]
    .filter((p) => rows.some((x) => x.project === p && x.chain === "Ethereum") && !tracked[p])
    .map((p) => `flows: no ${p} vault tracked on Ethereum — check its addresses / decimals / version data`);
  return { line, warnings };
}
