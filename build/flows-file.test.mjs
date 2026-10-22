// Tests for the build's read of the flows ledger (flows-file.mjs), with real temp files.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLedgerForBuild } from "./flows-file.mjs";
import { rowFlows } from "./flows.mjs";
import { makeSlim } from "./slim.mjs";

const quiet = () => { const o = { warns: [], warn(m) { o.warns.push(m); } }; return o; };
const dir = await mkdtemp(join(tmpdir(), "flows-file-"));

test("a missing, broken or wrong-shaped ledger gives null with a warning, never a thrown error", async () => {
  await writeFile(join(dir, "broken.json"), "{ not json");
  await writeFile(join(dir, "shape.json"), JSON.stringify({ hello: 1 }));
  for (const f of ["missing.json", "broken.json", "shape.json"]) {
    const log = quiet();
    assert.equal(await loadLedgerForBuild(join(dir, f), log), null, f);
    assert.match(log.warns[0], /tracked vaults show flows unavailable/, f);
  }
  const good = { asOf: "2026-10-21", chains: {}, vaults: {} };
  await writeFile(join(dir, "good.json"), JSON.stringify(good));
  assert.deepEqual(await loadLedgerForBuild(join(dir, "good.json"), quiet()), good);
});

test("with no ledger, every tracked row's flows is 'unavailable'; untracked rows still say untracked", async () => {
  const ledger = await loadLedgerForBuild(join(dir, "missing.json"), quiet());
  const slim = makeSlim({}, {}, { curve: new Map(), morpho: new Map() }, {}, ledger);
  const base = { project: "morpho-blue", chain: "Ethereum", label: "V", legs: ["USDC"], base: 4, reward: 0, total: 4, tvlUsd: 1e6, pool: "p" };
  assert.deepEqual(slim({ ...base, vault: { chain: "ethereum", address: "0xaa", decimals: 6 } }).flows, { status: "unavailable" });
  assert.deepEqual(slim({ ...base, vault: null }).flows, { status: "untracked" });
  assert.deepEqual(rowFlows({ vault: { chain: "ethereum", address: "0xaa", decimals: 6 } }, null), { status: "unavailable" });
});
