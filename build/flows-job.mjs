// ─────────────────────────────────────────────────────────────────────────────
// FLOWS JOB — one daily run over every chain the flows job reads. flows-run.mjs is the
// CLI around it (files + exit code); the Portal calls are passed in, so this is tested
// with a fake Portal.
//
//   runFlows({ ledger, rows, datasets, portal, now, log, onChainDone? }) → { ledger, failed: [chain], bytes }
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

export async function runFlows({ ledger, rows, datasets, portal, now = Date.now(), log = console, onChainDone = async () => {} }) {
  const startOfToday = Date.parse(utcDay(now) + "T00:00:00Z");
  const failed = [];
  let bytes = 0;

  for (const [chain, dataset] of Object.entries(datasets)) {
    const t0 = Date.now();
    try {
      const inSnapshot = rows.filter((r) => r.vault?.chain === chain).map((r) => r.vault);
      const known = ledgerVaults(ledger, chain);
      const vaults = [...new Map([...known, ...inSnapshot].map((v) => [v.address.toLowerCase(), { address: v.address.toLowerCase(), decimals: v.decimals }])).values()];
      const missing = known.filter((k) => !inSnapshot.some((s) => s.address.toLowerCase() === k.address));
      if (missing.length) log.log(`  ${chain}: ${missing.length} vaults not in this snapshot are still read so their record has no gap`);
      if (!vaults.length) { log.log(`  ${chain}: no tracked vaults`); continue; }

      const last = ledger.chains?.[chain]?.lastBlock;
      const backfill = !Number.isInteger(last);
      // a ledger with data but no block to continue from would double-count on a new backfill
      if (backfill && known.length) throw new Error(`flows-ledger.json: ${chain} has ${known.length} vaults but no lastBlock — refusing to backfill on top`);
      const head = await portal.finalizedHead(dataset);
      // first run: from the start of the oldest day the 30-day window keeps
      const fromBlock = backfill ? await portal.blockAt(dataset, (startOfToday - KEEP_DAYS * DAY_MS) / 1000) : last + 1;
      if (fromBlock > head) { log.warn(`  ⚠ ${chain}: no new finalized blocks since ${last} — numbers stay as of ${ledger.chains?.[chain]?.asOf ?? ledger.asOf}`); continue; }

      const merge = (r) => {
        if (r.lastBlock < fromBlock || r.lastTimestamp == null) return false;
        const today = shiftDay(utcDay(r.lastTimestamp * 1000), -1);
        // a backfill marks its vaults from the day it started, so one that stops short is
        // "collecting" until the window really holds 30 days, never padded with $0 days
        const from = backfill ? utcDay(startOfToday - KEEP_DAYS * DAY_MS) : false;
        ledger = addFlows(ledger, { chain, events: r.events, lastBlock: r.lastBlock, today, tracked: vaults, backfill: from });
        return true;
      };
      // a progress line every 25 batches, so a long first backfill shows where it is
      let batches = 0;
      const onBatch = (p) => {
        if (++batches % 25) return;
        const done = Math.round((100 * (p.lastBlock - fromBlock + 1)) / (head - fromBlock + 1));
        log.log(`    ${chain}: ${done}% · block ${p.lastBlock} · ${p.events} events · ${(p.bytes / 1e6).toFixed(1)} MB · ${Math.round((Date.now() - t0) / 60_000)} min`);
      };
      let r;
      try { r = await portal.fetchVaultFlows({ dataset, vaults, fromBlock, toBlock: head, onBatch }); }
      catch (e) {
        // keep what was read before the failure, so the next run continues from there
        if (e.partial && merge(e.partial)) {
          bytes += e.partial.bytes;
          log.error(`  ${chain}: failed at block ${e.partial.lastBlock + 1}; kept blocks ${fromBlock}–${e.partial.lastBlock} (${e.partial.events.length} events)`);
        }
        throw e;
      }
      if (!merge(r)) log.warn(`  ⚠ ${chain}: the Portal returned no blocks from ${fromBlock} (head ${head}) — nothing read this run`);
      bytes += r.bytes;
      if (r.lastBlock < head) log.warn(`  ⚠ ${chain}: Portal stopped at block ${r.lastBlock}, before the finalized head ${head}`);
      log.log(`  ${chain}: ${vaults.length} vaults · blocks ${fromBlock}–${r.lastBlock}${backfill ? " (first run: 30-day backfill)" : ""} · ${r.events.length} events · ${(r.bytes / 1e6).toFixed(2)} MB · ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      failed.push(chain);
      log.error(`  ${chain}: FAILED — ${e.message}`);
    }
    await onChainDone(ledger);
  }
  return { ledger, failed, bytes };
}
