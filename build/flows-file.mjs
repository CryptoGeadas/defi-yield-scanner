// The build's read of the money-flows ledger (written once a day by flows-run.mjs).
// It never fails the build: a missing, unreadable or wrong-shaped ledger returns null,
// so every tracked vault reads "unavailable" (flows.mjs rowFlows) — never a made-up state.
import { readFile } from "node:fs/promises";

export async function loadLedgerForBuild(path, log = console) {
  try {
    const j = JSON.parse(await readFile(path, "utf8"));
    if (!j || typeof j !== "object" || !j.vaults || typeof j.vaults !== "object") throw new Error("not a flows ledger");
    return j;
  } catch (e) {
    log.warn(`  ⚠ flows-ledger.json ${e.code === "ENOENT" ? "missing" : `unreadable (${e.message})`} — tracked vaults show flows unavailable`);
    return null;
  }
}
