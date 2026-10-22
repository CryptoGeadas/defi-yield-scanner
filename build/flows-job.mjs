// ─────────────────────────────────────────────────────────────────────────────
// FLOWS JOB — one daily run over every chain the flows job reads. flows-run.mjs is the
// CLI around it (files + exit code); the Portal calls are passed in, so this is tested
// with a fake Portal.
//
//   runFlows({ ledger, rows, datasets, portal, now, log, onChainDone? }) → { ledger, failed: [chain], ownErrors: [chain], bytes }
//     failed = every chain that did not finish; ownErrors = those whose error was not the Portal's.
//     onChainDone(ledger) runs after each chain (the CLI saves there, so a later chain
//     that hangs until the job is killed cannot lose an earlier chain's progress).
//
// Per chain: read the vaults in the snapshot (rows with a `vault`) plus every vault the
// ledger already follows there (one snapshot that drops a vault must leave no gap), from
// the chain's last block + 1, or 30 days back on its first run. Each chain stands alone:
// a failure on one keeps what it read before failing and the other chains still run.
// `today` for the ledger = the last COMPLETE UTC day read (the day before the last block's
// day), so "30 days" is 30 whole days and a short read can't claim more.
// ─────────────────────────────────────────────────────────────────────────────

import { addFlows, ledgerVaults, shiftDay, KEEP_DAYS } from "./flows.mjs";

const DAY_MS = 86_400_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// readLimitMs: stop reading cleanly before the workflow's 330-minute timeout kills the job, so
// what was read is saved and the next run continues (a long backfill finishes over several days)
export async function runFlows({ ledger, rows, datasets, portal, now = Date.now(), log = console, onChainDone = async () => {}, readLimitMs = 300 * 60_000 }) {
  const jobStart = Date.now();
  const startOfToday = Date.parse(utcDay(now) + "T00:00:00Z");
  const failed = [], ownErrors = [], reasons = {};
  let bytes = 0;
  // an error from a Portal call is the Portal's (busy, down): the run stays green with a
  // warning. Any other error is ours (a broken ledger state, a bug) and fails the run.
  const fromPortal = async (call) => { try { return await call(); } catch (e) { e.fromPortal = true; throw e; } };

  for (const [chain, dataset] of Object.entries(datasets)) {
    const t0 = Date.now();
    try {
      const inSnapshot = rows.filter((r) => r.vault?.chain === chain).map((r) => r.vault);
      const inSnap = new Set(inSnapshot.map((v) => v.address.toLowerCase()));
      // A vault out of the snapshot is still read (no gap if it comes back), but not forever:
      // once it has been out for 30 days it is dropped from the ledger and no longer read.
      const cutoff = shiftDay(utcDay(now), -KEEP_DAYS);
      const gone = ledgerVaults(ledger, chain).filter((k) => {
        const v = ledger.vaults[`${chain}:${k.address}`];
        return !inSnap.has(k.address) && typeof v.lastSeen === "string" && v.lastSeen < cutoff; // no lastSeen yet (older ledger): keep
      });
      if (gone.length) {
        ledger = { ...ledger, vaults: Object.fromEntries(Object.entries(ledger.vaults).filter(([key]) => !gone.some((g) => key === `${chain}:${g.address}`))) };
        log.log(`  ${chain}: dropped ${gone.length} vaults out of the Scanner for 30+ days`);
      }
      const known = ledgerVaults(ledger, chain);
      const vaults = [...new Map([...known, ...inSnapshot].map((v) => [v.address.toLowerCase(), { address: v.address.toLowerCase(), decimals: v.decimals }])).values()];
      const missing = known.filter((k) => !inSnapshot.some((s) => s.address.toLowerCase() === k.address));
      if (missing.length) (missing.length === known.length && known.length ? log.warn : log.log)(`  ${chain}: ${missing.length} vaults not in this snapshot are still read so their record has no gap`);
      if (!vaults.length) { log.warn(`  ⚠ ${chain}: no tracked vaults — check that the snapshot carries vault fields`); continue; }

      const last = ledger.chains?.[chain]?.lastBlock;
      const backfill = !Number.isInteger(last);
      // a ledger with data but no block to continue from would double-count on a new backfill
      if (backfill && known.length) throw new Error(`flows-ledger.json: ${chain} has ${known.length} vaults but no lastBlock — refusing to backfill on top`);
      const head = await fromPortal(() => portal.finalizedHead(dataset));
      // first run: from the start of the oldest day the 30-day window keeps
      const fromBlock = backfill ? await fromPortal(() => portal.blockAt(dataset, (startOfToday - KEEP_DAYS * DAY_MS) / 1000)) : last + 1;
      if (fromBlock > head) { log.warn(`  ⚠ ${chain}: no new finalized blocks since ${last} — numbers stay as of ${ledger.chains?.[chain]?.asOf ?? ledger.asOf}`); continue; }

      // A vault new to the ledger is read only from fromBlock, which sits inside the day after
      // the chain's last complete day: its first full day is the one after that. (Matters when
      // the job runs twice in a day: the second run starts mid-day.)
      const prevAsOf = ledger.chains?.[chain]?.asOf ?? ledger.asOf;
      const newFrom = !backfill && prevAsOf ? shiftDay(prevAsOf, 2) : null;
      // `complete`: the read reached the head. Only then is it the chain's last successful update;
      // a part-way read keeps its blocks but leaves updatedAt, so repeated failures turn stale.
      const merge = (r, complete) => {
        if (r.lastBlock < fromBlock || r.lastTimestamp == null) return false;
        const today = shiftDay(utcDay(r.lastTimestamp * 1000), -1);
        // a backfill marks its vaults from the day it started, so one that stops short shows
        // only the days it read ("partial since …"), never 30 days padded with $0
        const from = backfill ? utcDay(startOfToday - KEEP_DAYS * DAY_MS) : false;
        ledger = addFlows(ledger, { chain, events: r.events, lastBlock: r.lastBlock, today, tracked: vaults, backfill: from, newFrom, updatedAt: complete ? new Date(now).toISOString() : null, seen: [...inSnap] });
        return true;
      };
      // a progress line every 25 batches, so a long first backfill shows where it is
      let batches = 0;
      const onBatch = (p) => {
        if (++batches % 25) return;
        // our own progress line must never fail a read (it would be blamed on the Portal)
        try {
          const done = Math.round((100 * (p.lastBlock - fromBlock + 1)) / (head - fromBlock + 1));
          log.log(`    ${chain}: ${done}% · block ${p.lastBlock} · ${p.events} events · ${(p.bytes / 1e6).toFixed(1)} MB · ${Math.round((Date.now() - t0) / 60_000)} min`);
        } catch (e) { log.error(`  ${chain}: progress line failed — ${e.message}`); }
      };
      let r;
      try { r = await fromPortal(() => portal.fetchVaultFlows({ dataset, vaults, fromBlock, toBlock: head, onBatch, deadline: jobStart + readLimitMs })); }
      catch (e) {
        // keep what was read before the failure, so the next run continues from there
        if (e.partial && merge(e.partial, false)) {
          bytes += e.partial.bytes;
          log.error(`  ${chain}: failed at block ${e.partial.lastBlock + 1}; kept blocks ${fromBlock}–${e.partial.lastBlock} (${e.partial.events.length} events)`);
        }
        throw e;
      }
      if (!merge(r, r.lastBlock >= head)) log.warn(`  ⚠ ${chain}: the Portal returned no blocks from ${fromBlock} (head ${head}) — nothing read this run`);
      bytes += r.bytes;
      if (r.lastBlock < head) log.warn(`  ⚠ ${chain}: Portal stopped at block ${r.lastBlock}, before the finalized head ${head}`);
      log.log(`  ${chain}: ${vaults.length} vaults · blocks ${fromBlock}–${r.lastBlock}${backfill ? " (first run: 30-day backfill)" : ""} · ${r.events.length} events · ${(r.bytes / 1e6).toFixed(2)} MB · ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      failed.push(chain);
      if (!e.fromPortal) ownErrors.push(chain);
      reasons[chain] = e.message;
      log.error(`  ${chain}: FAILED — ${e.message}`);
      // a chain that has never read anything has no date to age from: record when it was
      // first tried, so the 72 h "late" rule (flows-run.mjs) can still turn the run red
      if (!ledger.chains?.[chain]) ledger = { ...ledger, chains: { ...ledger.chains, [chain]: { firstTriedAt: new Date(now).toISOString() } } };
    }
    await onChainDone(ledger);
  }
  return { ledger, failed, ownErrors, reasons, bytes };
}
