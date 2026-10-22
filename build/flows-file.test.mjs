// Tests for the build's read of the flows ledger (flows-file.mjs), with real temp files.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLedgerForBuild } from "./flows-file.mjs";
import { rowFlows as rowFlowsAt } from "./flows.mjs";
// a fixed clock: these tests must pass on any day (freshness compares dates with "now")
const TEST_NOW = Date.parse("2026-10-22T12:00:00Z");
const rowFlows = (row, ledger, now = TEST_NOW) => rowFlowsAt(row, ledger, now);
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
  const slim = makeSlim({}, {}, { curve: new Map(), morpho: new Map() }, {}, ledger, Date.parse("2026-10-22T12:00:00Z"));
  const base = { project: "morpho-blue", chain: "Ethereum", label: "V", legs: ["USDC"], stableType: "fiat", base: 4, reward: 0, total: 4, tvlUsd: 1e6, pool: "p" };
  assert.deepEqual(slim({ ...base, vault: { chain: "ethereum", address: "0xaa", decimals: 6 } }).flows, { status: "unavailable" });
  assert.deepEqual(slim({ ...base, vault: null, flowsBlock: "unverified" }).flows, { status: "untracked", reason: "unverified" });
  assert.deepEqual(rowFlows({ vault: { chain: "ethereum", address: "0xaa", decimals: 6 } }, null), { status: "unavailable" });
});

test("the build also rejects ledgers whose vaults are an array or that are an array", async () => {
  for (const [name, text] of [["arr-vaults.json", JSON.stringify({ vaults: [] })], ["arr.json", "[]"]]) {
    await writeFile(join(dir, name), text);
    const log = quiet();
    assert.equal(await loadLedgerForBuild(join(dir, name), log), null, name);
    assert.equal(log.warns.length, 1);
  }
});

test("a record that makes the flows code throw shows that row as unavailable; the refresh goes on", () => {
  const warn = console.warn; const seen = []; console.warn = (m) => seen.push(m);
  try {
    const ledger = { asOf: "2026-10-21", chains: {}, get vaults() { throw new Error("boom"); } };
    const slim = makeSlim({}, {}, { curve: new Map(), morpho: new Map() }, {}, ledger, Date.parse("2026-10-22T12:00:00Z"));
    const base = { project: "morpho-blue", chain: "Ethereum", label: "V", legs: ["USDC"], stableType: "fiat", base: 4, reward: 0, total: 4, tvlUsd: 1e6, pool: "p" };
    assert.deepEqual(slim({ ...base, vault: { chain: "ethereum", address: "0xaa", decimals: 6 } }).flows, { status: "unavailable" });
    assert.match(seen[0], /record for p unreadable/);
  } finally { console.warn = warn; }
});
