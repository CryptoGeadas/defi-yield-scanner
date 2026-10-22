// Tests for the flows job CLI (flows-run.mjs) with real files in a temp folder and a fake Portal.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFlowsFile } from "./flows-run.mjs";
import { emptyLedger, addFlows } from "./flows.mjs";

const E = "0x00000000000000000000000000000000000000e1";
const NOW = Date.parse("2026-10-22T04:40:00Z");
const datasets = { ethereum: "ethereum-mainnet" };
const quiet = () => { const out = { logs: [], log(m) { out.logs.push(m); }, error() {}, warn() {} }; return out; };
const annotations = (log) => log.logs.filter((m) => m.startsWith("::warning::"));

async function files() {
  const dir = await mkdtemp(join(tmpdir(), "flows-run-"));
  const snapshotPath = join(dir, "latest.json"), ledgerPath = join(dir, "ledger.json");
  await writeFile(snapshotPath, JSON.stringify({ windows: { 1: [{ vault: { chain: "ethereum", address: E, decimals: 6 } }] } }));
  const l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-20", lastBlock: 1000, tracked: [{ address: E, decimals: 6 }], backfill: true, events: [] });
  const ledgerText = JSON.stringify(l, null, 1) + "\n"; // a byte layout the job would not write itself
  await writeFile(ledgerPath, ledgerText);
  return { snapshotPath, ledgerPath, ledgerText };
}
const portal = (fetchVaultFlows) => ({ finalizedHead: async () => 1100, blockAt: async () => 900, fetchVaultFlows });

test("when the Portal fails, the ledger file is left exactly as it was and the run ends green with a warning", async () => {
  const f = await files();
  const log = quiet();
  const code = await runFlowsFile({ ...f, datasets, now: NOW, log, portal: portal(async () => { throw Object.assign(new Error("overloaded"), { code: "overloaded" }); }) });
  assert.equal(code, 0);
  assert.equal(await readFile(f.ledgerPath, "utf8"), f.ledgerText, "byte for byte");
  assert.equal(annotations(log).length, 1, "on standard output, where GitHub reads it");
  assert.match(annotations(log)[0], /^::warning::flows not updated for ethereum/);
});

test("a normal run writes the new ledger and has no warning", async () => {
  const f = await files();
  const log = quiet();
  const ts = Date.parse("2026-10-22T04:25:00Z") / 1000;
  const code = await runFlowsFile({ ...f, datasets, now: NOW, log, portal: portal(async ({ toBlock }) => ({ events: [], lastBlock: toBlock, lastTimestamp: ts, bytes: 10 })) });
  assert.equal(code, 0);
  assert.equal(JSON.parse(await readFile(f.ledgerPath, "utf8")).chains.ethereum.lastBlock, 1100);
  assert.deepEqual(annotations(log), []);
});

test("a broken or wrong-shaped ledger fails the run, is never overwritten, and the Portal is never asked", async () => {
  for (const bad of ["{ not json", JSON.stringify({ hello: 1 }), JSON.stringify({ vaults: [] })]) {
    const f = await files();
    await writeFile(f.ledgerPath, bad);
    let asked = false;
    await assert.rejects(runFlowsFile({ ...f, datasets, now: NOW, log: quiet(), portal: portal(async () => { asked = true; }) }));
    assert.equal(await readFile(f.ledgerPath, "utf8"), bad);
    assert.equal(asked, false);
  }
});

test("a part-way Portal failure saves what was read, ends green with the reason, and does not count as an update", async () => {
  const f = await files();
  const log = quiet();
  const ts = Date.parse("2026-10-21T12:00:00Z") / 1000;
  const fail = async () => { throw Object.assign(new Error("SQD Portal 529 overloaded: busy"), { code: "overloaded", partial: { events: [{ vault: E, day: "2026-10-21", kind: "in", amount: 5 }], lastBlock: 1010, lastTimestamp: ts, bytes: 10 } }); };
  assert.equal(await runFlowsFile({ ...f, datasets, now: NOW, log, portal: portal(fail) }), 0);
  const saved = JSON.parse(await readFile(f.ledgerPath, "utf8"));
  assert.equal(saved.chains.ethereum.lastBlock, 1010, "the next run continues from block 1011");
  assert.equal(saved.chains.ethereum.updatedAt, undefined, "a part-way read is not a successful update");
  assert.match(annotations(log)[0], /^::warning::flows not updated for ethereum: SQD Portal 529 overloaded/);
});

test("an error that is not the Portal's fails the run (red), with the reason", async () => {
  const f = await files();
  const l = JSON.parse(f.ledgerText);
  delete l.chains.ethereum.lastBlock; // vault data but nowhere to continue from
  await writeFile(f.ledgerPath, JSON.stringify(l));
  await assert.rejects(runFlowsFile({ ...f, datasets, now: NOW, log: quiet(), portal: portal(async () => ({})) }), /not a Portal error/);
});

test("no update for over 72 h fails the run so GitHub emails; a quiet day with no new blocks leaves the file as it was", async () => {
  const f = await files(); // asOf 20 Oct, no updatedAt
  const quietDay = { finalizedHead: async () => 1000, blockAt: async () => 900, fetchVaultFlows: async () => assert.fail("not called") };
  assert.equal(await runFlowsFile({ ...f, datasets, now: NOW, log: quiet(), portal: quietDay }), 0);
  assert.equal(await readFile(f.ledgerPath, "utf8"), f.ledgerText);
  const fourDays = Date.parse("2026-10-25T00:00:01Z"); // 72 h after 20 Oct ended
  await assert.rejects(runFlowsFile({ ...f, datasets, now: fourDays, log: quiet(), portal: quietDay }), /not updated for over 72 h on ethereum/);
});

test("a chain that never read anything turns the run red 72 h after it was first tried", async () => {
  const f = await files();
  const l = JSON.parse(f.ledgerText);
  await writeFile(f.ledgerPath, JSON.stringify({ asOf: "2026-10-22", chains: { ethereum: { firstTriedAt: "2026-10-22T04:40:00.000Z" } }, vaults: {} }));
  const down = { finalizedHead: async () => { throw new Error("dataset unknown"); }, blockAt: async () => 900, fetchVaultFlows: async () => ({}) };
  assert.equal(await runFlowsFile({ ...f, datasets, now: NOW + 71 * 3_600_000, log: quiet(), portal: down }), 0, "71 h: still a warning");
  await assert.rejects(runFlowsFile({ ...f, datasets, now: NOW + 73 * 3_600_000, log: quiet(), portal: down }), /over 72 h on ethereum/, "73 h: red, even though the ledger-wide asOf looks recent");
});
