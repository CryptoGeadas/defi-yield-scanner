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
//   rowFlows(row, ledger) → { status: "untracked" | "unavailable" | "collecting" | "ok", ... }
//     ledger null = it could not be read. Numbers show only once a vault has 30 full days
//     (shorter coverage reads "collecting", never a 30-day $0).
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

export function addFlows(ledger, { chain, events, lastBlock, today, tracked = [], backfill = false }) {
  const next = structuredClone(ledger);
  // a backfill's vaults have data from the day it started reading (a "YYYY-MM-DD"; true =
  // the full 30 days), even when the run stopped short of today
  const firstDay = typeof backfill === "string" ? backfill : backfill ? shiftDay(today, -(KEEP_DAYS - 1)) : shiftDay(today, 1);
  const vaultOf = (address) => (next.vaults[keyOf(chain, address)] ??= { firstDay, days: {} });
  for (const t of tracked) vaultOf(t.address).decimals = t.decimals;
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
  next.chains[chain] = { ...next.chains[chain], lastBlock, asOf: today };
  next.asOf = today; // latest run of any chain; each chain's own day is chains[chain].asOf
  return next;
}

// the last complete day of one chain (older ledgers kept only the shared asOf)
const asOfFor = (ledger, chain) => ledger?.chains?.[chain]?.asOf ?? ledger?.asOf ?? null;

export function flowsSummary(ledger, chain, address) {
  const v = ledger?.vaults?.[keyOf(chain, address)];
  const asOf = asOfFor(ledger, chain);
  if (!v || !asOf) return null;
  const from30 = shiftDay(asOf, -(KEEP_DAYS - 1)), from7 = shiftDay(asOf, -6);
  const s = { in30: 0, out30: 0, net7: 0, net30: 0, maxOut30: 0 };
  for (const [day, d] of Object.entries(v.days)) {
    if (day < from30 || day > asOf) continue;
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

export function rowFlows(row, ledger) {
  if (!row.vault) return { status: "untracked" };
  if (!ledger) return { status: "unavailable" };
  const v = ledger.vaults?.[keyOf(row.vault.chain, row.vault.address)];
  const asOf = asOfFor(ledger, row.vault.chain);
  const full = v && asOf && v.firstDay && v.firstDay <= shiftDay(asOf, -(KEEP_DAYS - 1));
  const s = full ? flowsSummary(ledger, row.vault.chain, row.vault.address) : null;
  if (full && !s) return { status: "unavailable" };
  return s ? { status: "ok", ...s } : { status: "collecting" };
}
