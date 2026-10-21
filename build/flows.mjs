// ─────────────────────────────────────────────────────────────────────────────
// MONEY FLOWS LEDGER — pure. The rolling 30-day record behind the "Money flows" card:
// per vault, per UTC day, money in (Deposit), money out (Withdraw) and the biggest single
// exit, in the vault's stablecoin (read as dollars). The flows job (flows-run.mjs) adds
// each day's events from the SQD Portal (portal.mjs); the build turns the ledger into a
// `flows` object on every row. Flows are shown only: they never touch Level or any Factor.
//
//   emptyLedger() → ledger
//   addFlows(ledger, { chain, events, lastBlock, today, tracked, backfill }) → new ledger
//     `today` is the last COMPLETE UTC day the run read: it becomes `asOf`. Later days are
//     kept but not counted until a run completes them; days before today − 29 are dropped.
//     `tracked` = [{ address, decimals }]. A vault first seen in a backfill run has the full
//     30 days; one first seen later has complete days only from tomorrow (`firstDay`).
//   flowsSummary(ledger, chain, address) → { in30, out30, net7, net30, maxOut30, asOf } | null
//   rowFlows(row, ledger) → { status: "untracked" | "unavailable" | "collecting" | "ok", ... }
//     ledger null = it could not be read. Numbers show only once a vault has 30 full days
//     (shorter coverage reads "collecting", never a 30-day $0).
//
// Ledger: { asOf: "YYYY-MM-DD" | null, chains: { ethereum: { lastBlock } },
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
  const firstDay = backfill ? shiftDay(today, -(KEEP_DAYS - 1)) : shiftDay(today, 1);
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
  for (const v of Object.values(next.vaults))
    for (const day of Object.keys(v.days)) if (day < oldest) delete v.days[day];
  next.chains[chain] = { ...next.chains[chain], lastBlock };
  next.asOf = today;
  return next;
}

export function flowsSummary(ledger, chain, address) {
  const v = ledger?.vaults?.[keyOf(chain, address)];
  if (!v || !ledger.asOf) return null;
  const from30 = shiftDay(ledger.asOf, -(KEEP_DAYS - 1)), from7 = shiftDay(ledger.asOf, -6);
  const s = { in30: 0, out30: 0, net7: 0, net30: 0, maxOut30: 0 };
  for (const [day, d] of Object.entries(v.days)) {
    if (day < from30 || day > ledger.asOf) continue;
    s.in30 += d.in;
    s.out30 += d.out;
    s.maxOut30 = Math.max(s.maxOut30, d.maxOut);
    if (day >= from7) s.net7 += d.in - d.out;
  }
  s.net30 = s.in30 - s.out30;
  for (const k of Object.keys(s)) s[k] = cents(s[k]);
  if (!Object.values(s).every(Number.isFinite)) return null; // a damaged day entry: no numbers, not NaN
  return { ...s, asOf: ledger.asOf };
}

export function rowFlows(row, ledger) {
  if (!row.vault) return { status: "untracked" };
  if (!ledger) return { status: "unavailable" };
  const v = ledger.vaults?.[keyOf(row.vault.chain, row.vault.address)];
  const full = v && ledger.asOf && v.firstDay && v.firstDay <= shiftDay(ledger.asOf, -(KEEP_DAYS - 1));
  const s = full ? flowsSummary(ledger, row.vault.chain, row.vault.address) : null;
  if (full && !s) return { status: "unavailable" };
  return s ? { status: "ok", ...s } : { status: "collecting" };
}
