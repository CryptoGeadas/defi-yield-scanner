// ─────────────────────────────────────────────────────────────────────────────
// FLOWS JOB — one daily run over every chain the flows job reads. flows-run.mjs is the
// CLI around it (files + exit code); the Portal calls are passed in, so this is tested
// with a fake Portal.
//
// The run loop, the Portal client and the freshness rule are the shared flows core
// (flows-core.mjs, #61). This file is the Scanner's adapter: which vaults to read and how
// their Deposit and Withdraw events go into the ledger.
//
//   runFlows({ ledger, rows, datasets, portal, now, log, onChainDone? }) → { ledger, failed: [chain], ownErrors: [chain], reasons, bytes }
//
// Per chain: read the vaults in the snapshot (rows with a `vault`) plus every vault the
// ledger already follows there (one snapshot that drops a vault must leave no gap), from
// the chain's last block + 1, or 30 days back on its first run.
// ─────────────────────────────────────────────────────────────────────────────

import { runChains, shiftDay, utcDay, KEEP_DAYS } from "./flows-core.mjs";
import { addFlows, ledgerVaults } from "./flows.mjs";

// The Scanner's adapter for the flows core. rows = the snapshot's rows.
export function vaultAdapter(rows) {
  const seenOn = {};
  return {
    noun: "vaults",
    prepare({ ledger, chain, now, log }) {
      const inSnapshot = rows.filter((r) => r.vault?.chain === chain).map((r) => r.vault);
      const inSnap = new Set(inSnapshot.map((v) => v.address.toLowerCase()));
      seenOn[chain] = [...inSnap];
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
      const items = [...new Map([...known, ...inSnapshot].map((v) => [v.address.toLowerCase(), { address: v.address.toLowerCase(), decimals: v.decimals }])).values()];
      const missing = known.filter((k) => !inSnapshot.some((s) => s.address.toLowerCase() === k.address));
      if (missing.length) (missing.length === known.length && known.length ? log.warn : log.log)(`  ${chain}: ${missing.length} vaults not in this snapshot are still read so their record has no gap`);
      return { ledger, items, known: known.length };
    },
    read: ({ portal, items, ...rest }) => portal.fetchVaultFlows({ vaults: items, ...rest }),
    add: (ledger, { items, ...rest }) => addFlows(ledger, { ...rest, tracked: items, seen: seenOn[rest.chain] }),
  };
}

// readLimitMs: stop reading cleanly before the workflow's 330-minute timeout kills the job, so
// what was read is saved and the next run continues (a long backfill finishes over several days)
export const runFlows = ({ rows, ...rest }) => runChains({ ...rest, adapter: vaultAdapter(rows) });
