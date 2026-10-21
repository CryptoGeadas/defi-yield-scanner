// ─────────────────────────────────────────────────────────────────────────────
// FLOWS JOB — runs once a day in its own GitHub Action (flows.yml), never inside the
// 6-hourly refresh, so a slow or busy SQD Portal can't hold up the rankings.
// Reads the tracked vaults (rows with a `vault` in the published snapshot, plus every
// vault the ledger already follows, so one snapshot that drops a vault leaves no gap),
// asks the Portal for their Deposit/Withdraw events since the last block read (30 days
// back on the first run), adds them to the ledger and writes it. The next refresh reads
// the ledger into each row's `flows`. If a read fails part-way, what was read before it
// is saved (batches are contiguous) and the run fails; the next run continues from there.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchVaultFlows, finalizedHead, blockAt } from "./portal.mjs";
import { emptyLedger, addFlows, ledgerVaults, shiftDay, KEEP_DAYS } from "./flows.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "..", "site", "data", "latest.json");
const LEDGER = join(HERE, "state", "flows-ledger.json");
const DATASET = { ethereum: "ethereum-mainnet" }; // chains the flows job reads
const DAY_MS = 86_400_000;
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

async function loadLedger() {
  let text;
  try { text = await readFile(LEDGER, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return emptyLedger(); throw e; }
  return JSON.parse(text); // a broken ledger fails the run rather than being overwritten
}

async function main() {
  const snap = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  const rows = Object.values(snap.windows ?? {}).flat();
  let ledger = await loadLedger();
  const startOfToday = Date.parse(utcDay(Date.now()) + "T00:00:00Z");
  let totalBytes = 0;
  const save = async () => {
    await mkdir(dirname(LEDGER), { recursive: true });
    await writeFile(LEDGER, JSON.stringify(ledger) + "\n");
  };

  for (const [chain, dataset] of Object.entries(DATASET)) {
    const inSnapshot = rows.filter((r) => r.vault?.chain === chain).map((r) => r.vault);
    const known = ledgerVaults(ledger, chain);
    const vaults = [...new Map([...known, ...inSnapshot].map((v) => [v.address.toLowerCase(), { address: v.address.toLowerCase(), decimals: v.decimals }])).values()];
    const missing = known.filter((k) => !inSnapshot.some((s) => s.address.toLowerCase() === k.address));
    if (missing.length) console.log(`  ${chain}: ${missing.length} vaults not in this snapshot are still read so their record has no gap`);
    if (!vaults.length) { console.log(`  ${chain}: no tracked vaults`); continue; }

    const last = ledger.chains?.[chain]?.lastBlock;
    const backfill = !Number.isInteger(last);
    // a ledger with data but no block to continue from would double-count on a new backfill
    if (backfill && known.length) throw new Error(`flows-ledger.json: ${chain} has ${known.length} vaults but no lastBlock — refusing to backfill on top`);
    const head = await finalizedHead(dataset);
    // first run: from the start of the oldest day the 30-day window keeps
    const fromBlock = backfill ? await blockAt(dataset, (startOfToday - KEEP_DAYS * DAY_MS) / 1000) : last + 1;
    if (fromBlock > head) { console.log(`  ${chain}: up to date at block ${last}`); continue; }

    // `today` for the ledger = the last COMPLETE UTC day of what was read (the day before
    // the last block's day), so "30 days" is 30 whole days and a short read can't claim more.
    const merge = (r) => {
      if (r.lastBlock < fromBlock || r.lastTimestamp == null) return false;
      const today = shiftDay(utcDay(r.lastTimestamp * 1000), -1);
      ledger = addFlows(ledger, { chain, events: r.events, lastBlock: r.lastBlock, today, tracked: vaults, backfill });
      return true;
    };
    const t0 = Date.now();
    let r;
    // a progress line every 25 batches, so a long first backfill shows where it is
    let batches = 0;
    const onBatch = (p) => {
      if (++batches % 25) return;
      const done = Math.round((100 * (p.lastBlock - fromBlock + 1)) / (head - fromBlock + 1));
      console.log(`    ${chain}: ${done}% · block ${p.lastBlock} · ${p.events} events · ${(p.bytes / 1e6).toFixed(1)} MB · ${Math.round((Date.now() - t0) / 60_000)} min`);
    };
    try { r = await fetchVaultFlows({ dataset, vaults, fromBlock, toBlock: head, onBatch }); }
    catch (e) {
      // keep what was read before the failure, so the next run continues from there
      if (e.partial && merge(e.partial)) {
        await save();
        console.error(`  ${chain}: failed at block ${e.partial.lastBlock + 1}; kept blocks ${fromBlock}–${e.partial.lastBlock} (${e.partial.events.length} events)`);
      }
      throw e;
    }
    merge(r);
    totalBytes += r.bytes;
    if (r.lastBlock < head) console.warn(`  ⚠ ${chain}: Portal stopped at block ${r.lastBlock}, before the finalized head ${head}`);
    console.log(`  ${chain}: ${vaults.length} vaults · blocks ${fromBlock}–${r.lastBlock}${backfill ? " (first run: 30-day backfill)" : ""} · ${r.events.length} events · ${(r.bytes / 1e6).toFixed(2)} MB · ${Math.round((Date.now() - t0) / 1000)}s`);
  }

  await save();
  console.log(`flows: ${(totalBytes / 1e6).toFixed(2)} MB from SQD Portal this run · ledger as of ${ledger.asOf}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
