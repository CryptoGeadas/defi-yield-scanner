// Tests for the money-flows ledger (flows.mjs): pure, no network.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, addFlows, flowsSummary, rowFlows, ledgerVaults } from "./flows.mjs";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const ev = (day, kind, amount, vault = A) => ({ vault, day, kind, amount });
const tA = [{ address: A, decimals: 6 }];
// a first (backfill) run: the vaults in it have the full 30 days
const backfill = (events, today = "2026-10-21", tracked = tA) =>
  addFlows(emptyLedger(), { chain: "ethereum", today, lastBlock: 500, tracked, backfill: true, events });
const row = (address) => ({ vault: { chain: "ethereum", address, decimals: 6 } });

test("events are merged into UTC days per vault: in, out and the biggest single exit; the run's block and day are kept", () => {
  const l = backfill([ev("2026-10-20", "in", 100), ev("2026-10-20", "out", 30), ev("2026-10-20", "out", 50), ev("2026-10-21", "in", 10)]);
  assert.deepEqual(l.vaults[`ethereum:${A}`].days, {
    "2026-10-20": { in: 100, out: 80, maxOut: 50 },
    "2026-10-21": { in: 10, out: 0, maxOut: 0 },
  });
  assert.equal(l.vaults[`ethereum:${A}`].decimals, 6);
  assert.equal(l.chains.ethereum.lastBlock, 500);
  assert.equal(l.asOf, "2026-10-21");
});

test("two vaults in one run keep separate days and separate sums", () => {
  const l = backfill([ev("2026-10-20", "in", 100, A), ev("2026-10-20", "in", 7, B)], "2026-10-21", [...tA, { address: B, decimals: 18 }]);
  assert.equal(flowsSummary(l, "ethereum", A).in30, 100);
  assert.equal(flowsSummary(l, "ethereum", B).in30, 7);
  assert.deepEqual(ledgerVaults(l, "ethereum"), [{ address: A, decimals: 6 }, { address: B, decimals: 18 }]);
});

test("each chain keeps its own last block", () => {
  const l1 = backfill([]);
  const l2 = addFlows(l1, { chain: "base", today: "2026-10-21", lastBlock: 9, tracked: [], backfill: true, events: [] });
  assert.equal(l2.chains.ethereum.lastBlock, 500);
  assert.equal(l2.chains.base.lastBlock, 9);
  assert.deepEqual(ledgerVaults(l2, "base"), []);
});

test("a later run adds to the same day and never changes the input ledger", () => {
  const l1 = backfill([ev("2026-10-21", "out", 40)]);
  const before = JSON.stringify(l1);
  const l2 = addFlows(l1, { chain: "ethereum", today: "2026-10-21", lastBlock: 600, tracked: tA, events: [ev("2026-10-21", "out", 70), ev("2026-10-21", "in", 5)] });
  assert.deepEqual(l2.vaults[`ethereum:${A}`].days["2026-10-21"], { in: 5, out: 110, maxOut: 70 });
  assert.equal(l2.chains.ethereum.lastBlock, 600);
  assert.equal(JSON.stringify(l1), before);
});

test("exactly 30 days are kept: day −30 is dropped, day −29 stays (ledger and summary)", () => {
  const l = backfill([ev("2026-09-21", "in", 1), ev("2026-09-22", "in", 2)]);
  assert.deepEqual(Object.keys(l.vaults[`ethereum:${A}`].days), ["2026-09-22"]);
  // the summary has its own window: a stale day still in the file is not counted
  const stale = structuredClone(l);
  stale.vaults[`ethereum:${A}`].days["2026-09-21"] = { in: 1000, out: 0, maxOut: 0 };
  assert.equal(flowsSummary(stale, "ethereum", A).in30, 2);
});

test("summary: in, out, net over 7 and 30 days and the biggest exit, counted back from the ledger's day", () => {
  const l = backfill([
    ev("2026-09-25", "in", 1000), ev("2026-09-25", "out", 600),   // in the 30 days, not the 7
    ev("2026-10-15", "in", 50),                                    // first day of the 7 (15–21 Oct)
    ev("2026-10-14", "out", 20),                                   // just outside the 7
    ev("2026-10-21", "out", 100),
  ]);
  assert.deepEqual(flowsSummary(l, "ethereum", A), { in30: 1050, out30: 720, net7: -50, net30: 330, maxOut30: 600, asOf: "2026-10-21" });
});

test("events after the last complete day are kept for later runs but not counted yet", () => {
  const l = backfill([ev("2026-10-20", "in", 10), ev("2026-10-21", "in", 99)], "2026-10-20");
  assert.equal(flowsSummary(l, "ethereum", A).in30, 10, "21 Oct is still running");
  const l2 = addFlows(l, { chain: "ethereum", today: "2026-10-21", lastBlock: 600, tracked: tA, events: [] });
  assert.equal(flowsSummary(l2, "ethereum", A).in30, 109, "next day's run counts it");
});

test("rowFlows: untracked, unreadable ledger, not in the ledger yet, and a vault with its 30 days", () => {
  const l = backfill([ev("2026-10-21", "in", 5)]);
  assert.deepEqual(rowFlows({ vault: null }, l), { status: "untracked" });
  assert.deepEqual(rowFlows(row(A), null), { status: "unavailable" });
  assert.deepEqual(rowFlows(row(B), l), { status: "collecting" });
  assert.deepEqual(rowFlows(row(A.toUpperCase()), l), { status: "ok", in30: 5, out30: 0, net7: 5, net30: 5, maxOut30: 0, asOf: "2026-10-21" });
});

test("a vault with 30 full days and no events has a real $0", () => {
  const f = rowFlows(row(A), backfill([]));
  assert.equal(f.status, "ok");
  assert.equal(f.net30, 0);
});

test("a vault first tracked after the backfill is 'collecting', never a 30-day $0, until it has 30 full days", () => {
  let l = backfill([]);
  l = addFlows(l, { chain: "ethereum", today: "2026-10-22", lastBlock: 600, tracked: [...tA, { address: B, decimals: 6 }], events: [] });
  assert.equal(l.vaults[`ethereum:${B}`].firstDay, "2026-10-23", "its first complete day is the day after the run's day");
  assert.equal(rowFlows(row(B), l).status, "collecting");
  l = addFlows(l, { chain: "ethereum", today: "2026-11-20", lastBlock: 900, tracked: [], events: [] });
  assert.equal(rowFlows(row(B), l).status, "collecting", "23 Oct–20 Nov is 29 days");
  l = addFlows(l, { chain: "ethereum", today: "2026-11-21", lastBlock: 901, tracked: [], events: [] });
  assert.equal(rowFlows(row(B), l).status, "ok", "23 Oct–21 Nov is 30 full days");
});

test("a damaged day entry gives 'unavailable', never NaN", () => {
  const l = backfill([ev("2026-10-21", "in", 5)]);
  l.vaults[`ethereum:${A}`].days["2026-10-21"] = { in: 5 }; // out missing
  assert.deepEqual(rowFlows(row(A), l), { status: "unavailable" });
});

test("amounts are kept to the cent", () => {
  const l = backfill([ev("2026-10-21", "in", 1.234567), ev("2026-10-21", "in", 0.001)]);
  assert.equal(l.vaults[`ethereum:${A}`].days["2026-10-21"].in, 1.24);
});

test("a ledger from before per-chain days (no chains[chain].asOf) still reads with the shared day", () => {
  const l = { asOf: "2026-10-21", chains: { ethereum: { lastBlock: 500 } }, vaults: { [`ethereum:${A}`]: { decimals: 6, firstDay: "2026-09-22", days: { "2026-10-21": { in: 5, out: 0, maxOut: 0 } } } } };
  assert.equal(flowsSummary(l, "ethereum", A).asOf, "2026-10-21");
  assert.equal(flowsSummary(l, "ethereum", A).in30, 5);
  assert.equal(rowFlows(row(A), l).status, "ok");
});

test("each chain's own day sets its window and its 30-day check, not the latest run of another chain", () => {
  let l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-20", lastBlock: 1, tracked: tA, backfill: true, events: [ev("2026-10-21", "in", 9)] });
  l = addFlows(l, { chain: "base", today: "2026-10-21", lastBlock: 1, tracked: [{ address: B, decimals: 6 }], backfill: true, events: [] });
  assert.equal(l.asOf, "2026-10-21");
  assert.equal(flowsSummary(l, "ethereum", A).asOf, "2026-10-20");
  assert.equal(flowsSummary(l, "ethereum", A).in30, 0, "21 Oct is not complete on ethereum yet");
  l.vaults[`ethereum:${A}`].firstDay = "2026-09-21"; // = ethereum's day − 29: full there, not with base's day
  assert.equal(rowFlows(row(A), l).status, "ok");
});

test("a run on one chain only drops old days of its own vaults", () => {
  const behind = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-01", lastBlock: 1, tracked: tA, backfill: true, events: [ev("2026-09-05", "in", 1)] });
  const l = addFlows(behind, { chain: "base", today: "2026-10-21", lastBlock: 1, tracked: [], backfill: true, events: [] });
  assert.ok(l.vaults[`ethereum:${A}`].days["2026-09-05"], "base's run leaves ethereum's days alone");
  const l2 = addFlows(behind, { chain: "ethereum", today: "2026-10-21", lastBlock: 2, tracked: [], events: [] });
  assert.equal(l2.vaults[`ethereum:${A}`].days["2026-09-05"], undefined, "ethereum's own run drops them");
});
