// Tests for the daily flows job (flows-job.mjs) with a fake Portal, two chains.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { runFlows } from "./flows-job.mjs";
import { emptyLedger, addFlows, rowFlows, flowsSummary } from "./flows.mjs";

const E = "0x00000000000000000000000000000000000000e1", B = "0x00000000000000000000000000000000000000b1";
const NOW = Date.parse("2026-10-22T04:40:00Z");
const TS = Date.parse("2026-10-22T04:25:00Z") / 1000; // last finalized block of the run
const rows = [
  { vault: { chain: "ethereum", address: E, decimals: 6 } },
  { vault: { chain: "base", address: B, decimals: 6 } },
  { vault: null },
];
const datasets = { ethereum: "ethereum-mainnet", base: "base-mainnet" };
const quiet = { log() {}, warn() {}, error() {} };
// a ledger that already read both chains up to 21 Oct
const ledger0 = () => {
  let l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-20", lastBlock: 1000, tracked: [{ address: E, decimals: 6 }], backfill: true, events: [] });
  return addFlows(l, { chain: "base", today: "2026-10-20", lastBlock: 5000, tracked: [{ address: B, decimals: 6 }], backfill: true, events: [] });
};

function fakePortal({ fail = {}, heads = { "ethereum-mainnet": 1100, "base-mainnet": 5400 } } = {}) {
  const calls = [];
  return {
    calls,
    finalizedHead: async (ds) => heads[ds],
    blockAt: async (ds) => (ds === "base-mainnet" ? 4000 : 900),
    fetchVaultFlows: async ({ dataset, vaults, fromBlock, toBlock }) => {
      calls.push({ dataset, fromBlock, toBlock, vaults: vaults.map((v) => v.address) });
      const vault = vaults[0].address;
      if (fail[dataset]) {
        const e = new Error(`${dataset} overloaded`);
        e.partial = fail[dataset] === "partial" ? { events: [{ vault, day: "2026-10-21", kind: "in", amount: 1 }], lastBlock: fromBlock + 10, lastTimestamp: TS, bytes: 10 } : undefined;
        throw e;
      }
      return { events: [{ vault, day: "2026-10-21", kind: "out", amount: 7 }], lastBlock: toBlock, lastTimestamp: TS, bytes: 100 };
    },
  };
}

test("each chain is read from its own last block + 1 to its own head, and keeps its own last block", async () => {
  const portal = fakePortal();
  const r = await runFlows({ ledger: ledger0(), rows, datasets, portal, now: NOW, log: quiet });
  assert.deepEqual(portal.calls.map((c) => [c.dataset, c.fromBlock, c.toBlock]), [["ethereum-mainnet", 1001, 1100], ["base-mainnet", 5001, 5400]]);
  assert.equal(r.ledger.chains.ethereum.lastBlock, 1100);
  assert.equal(r.ledger.chains.base.lastBlock, 5400);
  assert.deepEqual(r.failed, []);
  assert.equal(r.bytes, 200);
  assert.equal(r.ledger.chains.base.asOf, "2026-10-21", "the day before the last block's day");
  assert.equal(r.ledger.chains.base.updatedAt, "2026-10-22T04:40:00.000Z", "the run time: the last successful update");
});

test("a failure on one chain does not stop or reset the other", async () => {
  const portal = fakePortal({ fail: { "ethereum-mainnet": "total" } });
  const before = ledger0();
  const r = await runFlows({ ledger: before, rows, datasets, portal, now: NOW, log: quiet });
  assert.deepEqual(r.failed, ["ethereum"]);
  assert.equal(r.ledger.chains.ethereum.lastBlock, 1000, "ethereum stays where it was, to be read again tomorrow");
  assert.equal(r.ledger.chains.ethereum.asOf, "2026-10-20", "and keeps its own day");
  assert.equal(r.ledger.chains.ethereum.updatedAt, undefined, "a failed chain keeps its last successful update time");
  assert.equal(r.ledger.chains.base.lastBlock, 5400, "base still ran");
  assert.equal(flowsSummary(r.ledger, "base", B).out30, 7);
});

test("a chain that fails part-way keeps what it read; the next run continues from there", async () => {
  const r = await runFlows({ ledger: ledger0(), rows, datasets, portal: fakePortal({ fail: { "base-mainnet": "partial" } }), now: NOW, log: quiet });
  assert.deepEqual(r.failed, ["base"]);
  assert.equal(r.ledger.chains.base.lastBlock, 5011);
  assert.equal(r.ledger.vaults[`base:${B}`].days["2026-10-21"].in, 1);
  const portal = fakePortal();
  await runFlows({ ledger: r.ledger, rows, datasets, portal, now: NOW, log: quiet });
  assert.equal(portal.calls.find((c) => c.dataset === "base-mainnet").fromBlock, 5012);
});

test("first run on a chain backfills from 30 days back; vaults found there have their full 30 days", async () => {
  const l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-20", lastBlock: 1000, tracked: [{ address: E, decimals: 6 }], backfill: true, events: [] });
  const portal = fakePortal();
  const r = await runFlows({ ledger: l, rows, datasets, portal, now: NOW, log: quiet });
  assert.deepEqual(portal.calls.find((c) => c.dataset === "base-mainnet").fromBlock, 4000, "blockAt(30 days back)");
  assert.equal(rowFlows(rows[1], r.ledger).status, "full");
});

test("the ledger is handed over after each chain, so a later chain cannot lose an earlier one", async () => {
  const saved = [];
  await runFlows({ ledger: ledger0(), rows, datasets, portal: fakePortal(), now: NOW, log: quiet, onChainDone: async (l) => saved.push([l.chains.ethereum.lastBlock, l.chains.base.lastBlock]) });
  assert.deepEqual(saved, [[1100, 5000], [1100, 5400]]);
});

test("no new finalized blocks: the chain is skipped with a warning and keeps its day", async () => {
  const warns = [];
  const portal = fakePortal({ heads: { "ethereum-mainnet": 1000, "base-mainnet": 5000 } });
  const r = await runFlows({ ledger: ledger0(), rows, datasets, portal, now: NOW, log: { ...quiet, warn: (m) => warns.push(m) } });
  assert.equal(warns.length, 2);
  assert.match(warns[0], /no new finalized blocks since 1000/);
  assert.equal(r.ledger.chains.ethereum.asOf, "2026-10-20");
});

test("a vault the ledger follows is still read when the snapshot drops it", async () => {
  const portal = fakePortal();
  await runFlows({ ledger: ledger0(), rows: [{ vault: null }], datasets, portal, now: NOW, log: quiet });
  assert.deepEqual(portal.calls.map((c) => c.vaults), [[E], [B]]);
});

test("a chain with vault data but no last block fails instead of backfilling on top", async () => {
  const l = ledger0();
  delete l.chains.base.lastBlock;
  const portal = fakePortal();
  const r = await runFlows({ ledger: l, rows, datasets, portal, now: NOW, log: quiet });
  assert.deepEqual(r.failed, ["base"]);
  assert.ok(!portal.calls.some((c) => c.dataset === "base-mainnet"));
  assert.equal(r.ledger.chains.ethereum.lastBlock, 1100, "ethereum unaffected");
});

test("a first run starts at the start of the day 30 days back; a chain whose Portal calls fail is the only one failed", async () => {
  const asked = [];
  const l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-20", lastBlock: 1000, tracked: [{ address: E, decimals: 6 }], backfill: true, events: [] });
  const portal = { ...fakePortal(), blockAt: async (ds, ts) => { asked.push(ts); return 4000; } };
  await runFlows({ ledger: l, rows, datasets, portal, now: NOW, log: quiet });
  assert.deepEqual(asked, [Date.parse("2026-09-22T00:00:00Z") / 1000]);
  const broken = { ...fakePortal(), finalizedHead: async (ds) => { if (ds === "ethereum-mainnet") throw new Error("down"); return 5400; } };
  const r = await runFlows({ ledger: ledger0(), rows, datasets, portal: broken, now: NOW, log: quiet });
  assert.deepEqual(r.failed, ["ethereum"]);
  assert.equal(r.ledger.chains.base.lastBlock, 5400);
});

test("a first backfill that stops short marks its vaults from the day it started: 'partial' since then, never padded with $0 days", async () => {
  const l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-20", lastBlock: 1000, tracked: [{ address: E, decimals: 6 }], backfill: true, events: [] });
  const stopTs = Date.parse("2026-10-02T10:00:00Z") / 1000; // read only 22 Sep → 2 Oct
  const portal = { ...fakePortal(), fetchVaultFlows: async ({ fromBlock }) => ({ events: [], lastBlock: fromBlock + 50, lastTimestamp: stopTs, bytes: 1 }) };
  const r = await runFlows({ ledger: l, rows, datasets, portal, now: NOW, log: quiet });
  assert.equal(r.ledger.vaults[`base:${B}`].firstDay, "2026-09-22");
  assert.equal(r.ledger.chains.base.asOf, "2026-10-01");
  const f = rowFlows(rows[1], r.ledger);
  assert.equal(f.status, "partial", "10 days read: shown as 10 days since 22 Sep, never as 30");
  assert.equal(f.since, "2026-09-22");
});

test("a new vault on a chain already followed gets no backfill: read from the chain's last block, 'collecting' from today", async () => {
  const N = "0x00000000000000000000000000000000000000f9";
  const portal = fakePortal();
  const r = await runFlows({ ledger: ledger0(), rows: [...rows, { vault: { chain: "ethereum", address: N, decimals: 6 } }], datasets, portal, now: NOW, log: quiet });
  assert.equal(portal.calls.find((c) => c.dataset === "ethereum-mainnet").fromBlock, 1001, "not 30 days back");
  assert.equal(r.ledger.vaults[`ethereum:${N}`].firstDay, "2026-10-22");
  assert.deepEqual(rowFlows({ vault: { chain: "ethereum", address: N, decimals: 6 } }, r.ledger, NOW), { status: "collecting", since: "2026-10-22", updatedAt: "2026-10-22T04:40:00.000Z" });
});

test("a vault dropped from the snapshot and back keeps its first day and days through the job", async () => {
  let r = await runFlows({ ledger: ledger0(), rows: [{ vault: null }], datasets, portal: fakePortal(), now: NOW, log: quiet });
  r = await runFlows({ ledger: r.ledger, rows, datasets, portal: fakePortal({ heads: { "ethereum-mainnet": 1200, "base-mainnet": 5500 } }), now: NOW, log: quiet });
  assert.equal(r.ledger.vaults[`ethereum:${E}`].firstDay, ledger0().vaults[`ethereum:${E}`].firstDay);
  assert.equal(rowFlows(rows[0], r.ledger).status, "full");
});

test("a second run on the same day: a vault new in it starts the day after, since part of today was read before it", async () => {
  const N = "0x00000000000000000000000000000000000000f8";
  const first = await runFlows({ ledger: ledger0(), rows, datasets, portal: fakePortal(), now: NOW, log: quiet }); // reads up to 22 Oct 04:25
  assert.equal(first.ledger.chains.ethereum.asOf, "2026-10-21");
  const noon = Date.parse("2026-10-22T11:50:00Z") / 1000;
  const portal = { ...fakePortal({ heads: { "ethereum-mainnet": 1200, "base-mainnet": 5500 } }), fetchVaultFlows: async ({ toBlock }) => ({ events: [], lastBlock: toBlock, lastTimestamp: noon, bytes: 1 }) };
  const r = await runFlows({ ledger: first.ledger, rows: [...rows, { vault: { chain: "ethereum", address: N, decimals: 6 } }], datasets, portal, now: NOW, log: quiet });
  assert.equal(r.ledger.vaults[`ethereum:${N}`].firstDay, "2026-10-23", "22 Oct was read only from 04:25 for it");
});

test("a chain that fails keeps its last successful update time, and turns stale over the days", async () => {
  const l = ledger0();
  l.chains.ethereum.updatedAt = "2026-10-21T04:40:00.000Z";
  const r = await runFlows({ ledger: l, rows, datasets, portal: fakePortal({ fail: { "ethereum-mainnet": "total" } }), now: NOW, log: quiet });
  assert.equal(r.ledger.chains.ethereum.updatedAt, "2026-10-21T04:40:00.000Z");
  assert.equal(rowFlows(rows[0], r.ledger, NOW + 37 * 3_600_000).stale, true);
  assert.deepEqual(r.reasons, { ethereum: "ethereum-mainnet overloaded" });
  assert.deepEqual(r.ownErrors, [], "a Portal error, not ours");
});
