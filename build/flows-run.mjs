// ─────────────────────────────────────────────────────────────────────────────
// FLOWS JOB CLI — runs once a day in its own GitHub Action (flows.yml), never inside the
// 6-hourly refresh, so a slow or busy SQD Portal can't hold up the rankings.
// Reads the published snapshot and the ledger, runs every chain (flows-job.mjs) and
// saves the ledger after each chain. A chain the Portal failed on is a WARNING, not a
// failed run (any other error fails it): its ledger entry stays as it was (or keeps what it read before failing),
// the card shows its "As of" date, and the next daily run continues from there.
//
//   runFlowsFile({ snapshotPath, ledgerPath, datasets, portal, now?, log? }) → exit code
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fetchVaultFlows, finalizedHead, blockAt } from "./portal.mjs";
import { emptyLedger, freshness, LATE_MS } from "./flows.mjs";
import { runFlows } from "./flows-job.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// chains the flows job reads. Ethereum only: Base is ~12 MB of events a day, far over the
// free Portal budget (measured 2026-10-22, #32). Each chain runs on its own (flows-job.mjs).
const DATASETS = { ethereum: "ethereum-mainnet" };

async function loadLedger(path) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return emptyLedger(); throw e; }
  // a broken or wrong-shaped ledger fails the run rather than being overwritten
  const j = JSON.parse(text);
  if (!j || typeof j !== "object" || Array.isArray(j) || !j.vaults || typeof j.vaults !== "object" || Array.isArray(j.vaults))
    throw new Error("flows-ledger.json is not a flows ledger — refusing to overwrite it");
  return j;
}

export async function runFlowsFile({ snapshotPath, ledgerPath, datasets = DATASETS, portal, now = Date.now(), log = console }) {
  const snap = JSON.parse(await readFile(snapshotPath, "utf8"));
  const rows = Object.values(snap.windows ?? {}).flat();
  const before = await loadLedger(ledgerPath);
  let saved = JSON.stringify(before);
  const save = async (ledger) => {
    const text = JSON.stringify(ledger);
    if (text === saved) return; // nothing read: the file is left exactly as it was
    await mkdir(dirname(ledgerPath), { recursive: true });
    // a temp file, then rename: a job killed mid-write never leaves half a ledger
    await writeFile(ledgerPath + ".tmp", text + "\n");
    await rename(ledgerPath + ".tmp", ledgerPath);
    saved = text;
  };
  const r = await runFlows({ ledger: before, rows, datasets, portal, now, log, onChainDone: save });
  log.log(`flows: ${(r.bytes / 1e6).toFixed(2)} MB from SQD Portal this run · ledger as of ${r.ledger.asOf}`);
  // our own error (a broken ledger state, a bug): fail the run so it is seen and fixed
  if (r.ownErrors.length) throw new Error(`flows failed on ${r.ownErrors.map((c) => `${c} (${r.reasons[c]})`).join(", ")} — not a Portal error; other chains were saved`);
  // GitHub reads "::warning::" from standard output and shows it on the run page; the run stays green
  for (const c of r.failed) log.log(`::warning::flows not updated for ${c}: ${r.reasons[c]}`);
  // …but a chain that has not updated for 72 h is an outage, not a bad day: fail, so GitHub emails
  // each chain by its own dates only (never another chain's); a chain that never read anything
  // ages from when it was first tried
  const ageOf = (c) => {
    const info = r.ledger.chains?.[c];
    const a = freshness(info, null, now).ageMs;
    return Number.isFinite(a) ? a : now - Date.parse(info?.firstTriedAt ?? "");
  };
  const late = Object.keys(datasets).filter((c) => ageOf(c) > LATE_MS);
  if (late.length) throw new Error(`flows have not updated for over 72 h on ${late.join(", ")} — check the SQD Portal`);
  return 0;
}

// run as a script (not when imported by tests)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runFlowsFile({
    snapshotPath: join(HERE, "..", "site", "data", "latest.json"),
    ledgerPath: join(HERE, "state", "flows-ledger.json"),
    portal: { fetchVaultFlows, finalizedHead, blockAt },
  }).then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
