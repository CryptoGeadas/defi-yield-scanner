// ─────────────────────────────────────────────────────────────────────────────
// FLOWS JOB CLI — runs once a day in its own GitHub Action (flows.yml), never inside the
// 6-hourly refresh, so a slow or busy SQD Portal can't hold up the rankings.
// Reads the published snapshot and the ledger, runs every chain (flows-job.mjs), writes
// the ledger — including what a failing chain read before it failed — and exits 1 if
// any chain failed. The next refresh reads the ledger into each row's `flows`.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fetchVaultFlows, finalizedHead, blockAt } from "./portal.mjs";
import { emptyLedger } from "./flows.mjs";
import { runFlows } from "./flows-job.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = join(HERE, "..", "site", "data", "latest.json");
const LEDGER = join(HERE, "state", "flows-ledger.json");
// chains the flows job reads. Ethereum only: Base is ~12 MB of events a day, far over the
// free Portal budget (measured 2026-10-22, #32). Each chain runs on its own (flows-job.mjs).
const DATASETS = { ethereum: "ethereum-mainnet" };

async function loadLedger() {
  let text;
  try { text = await readFile(LEDGER, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return emptyLedger(); throw e; }
  return JSON.parse(text); // a broken ledger fails the run rather than being overwritten
}

async function main() {
  const snap = JSON.parse(await readFile(SNAPSHOT, "utf8"));
  const rows = Object.values(snap.windows ?? {}).flat();
  const save = async (ledger) => {
    await mkdir(dirname(LEDGER), { recursive: true });
    await writeFile(LEDGER, JSON.stringify(ledger) + "\n");
  };
  // saved after every chain, so a chain that hangs until the job is killed loses no other
  const r = await runFlows({ ledger: await loadLedger(), rows, datasets: DATASETS, portal: { fetchVaultFlows, finalizedHead, blockAt }, onChainDone: save });
  console.log(`flows: ${(r.bytes / 1e6).toFixed(2)} MB from SQD Portal this run · ledger as of ${r.ledger.asOf}`);
  if (r.failed.length) throw new Error(`flows failed on ${r.failed.join(", ")} — other chains were saved`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
