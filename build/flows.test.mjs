// Tests for the money-flows ledger (flows.mjs): pure, no network.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyLedger, addFlows, flowsSummary, rowFlows, ledgerVaults, shiftDay, untrackedReason, UNTRACKED_REASONS } from "./flows.mjs";

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
  assert.deepEqual(rowFlows({ vault: null, project: "aave-v3", stableType: "fiat" }, l), { status: "untracked", reason: "lending" });
  assert.deepEqual(rowFlows(row(A), null), { status: "unavailable" });
  assert.deepEqual(rowFlows(row(B), l), { status: "collecting", since: null });
  assert.deepEqual(rowFlows(row(A.toUpperCase()), l), { status: "full", in30: 5, out30: 0, net7: 5, net30: 5, maxOut30: 0, asOf: "2026-10-21" });
});

test("a vault with 30 full days and no events has a real $0", () => {
  const f = rowFlows(row(A), backfill([]));
  assert.equal(f.status, "full");
  assert.equal(f.net30, 0);
});

// a vault first seen by the run on `seen` (no backfill): its first full day is that day
const seenOn = (seen, events = []) => {
  const l = backfill([]);
  return addFlows(l, { chain: "ethereum", today: shiftDay(seen, -1), lastBlock: 600, tracked: [...tA, { address: B, decimals: 6 }], events });
};
const until = (l, today, events = []) => addFlows(l, { chain: "ethereum", today, lastBlock: 900, tracked: [], events });

test("a vault seen for the first time starts on that day, with no backfill of its own", () => {
  const l = seenOn("2026-10-23", [ev("2026-10-22", "in", 50, B)]);
  assert.equal(l.vaults[`ethereum:${B}`].firstDay, "2026-10-23", "the run on 23 Oct (reading up to 22 Oct) first saw it");
  const s = rowFlows(row(B), until(l, "2026-10-30"));
  assert.equal(s.status, "partial");
  assert.equal(s.in30, 0, "the half day read before it was seen is not counted");
});

test("coverage: under 7 days 'collecting', 7 to 29 days 'partial', 30 days or more 'full', each with its since date", () => {
  const l = seenOn("2026-10-23", [ev("2026-10-25", "in", 10, B)]);
  assert.deepEqual(rowFlows(row(B), until(l, "2026-10-28")), { status: "collecting", since: "2026-10-23" }, "6 days: no numbers at all");
  const p = rowFlows(row(B), until(l, "2026-10-29"));
  assert.equal(p.status, "partial", "7 days");
  assert.equal(p.since, "2026-10-23");
  assert.equal(p.in30, 10);
  assert.equal(rowFlows(row(B), until(l, "2026-11-20")).status, "partial", "23 Oct–20 Nov is 29 days");
  const f = rowFlows(row(B), until(l, "2026-11-21"));
  assert.equal(f.status, "full", "23 Oct–21 Nov is 30 days");
  assert.equal(f.since, undefined, "a full 30 days needs no since date");
});

test("a tracked vault with 10 days and no events has a real $0; one first seen 3 days ago is 'collecting', never $0", () => {
  const ten = rowFlows(row(B), until(seenOn("2026-10-23"), "2026-11-01"));
  assert.equal(ten.status, "partial");
  assert.deepEqual([ten.in30, ten.out30, ten.net7, ten.net30, ten.maxOut30], [0, 0, 0, 0, 0]);
  const three = rowFlows(row(B), until(seenOn("2026-10-23"), "2026-10-25"));
  assert.deepEqual(three, { status: "collecting", since: "2026-10-23" });
});

test("a vault that leaves the list and comes back within 30 days keeps its stored days", () => {
  let l = seenOn("2026-10-23", [ev("2026-10-24", "out", 70, B)]);
  l = until(l, "2026-10-26"); // runs while it is out of the snapshot: not in `tracked`
  l = until(l, "2026-11-05");
  assert.deepEqual(l.vaults[`ethereum:${B}`].days["2026-10-24"], { in: 0, out: 70, maxOut: 70 });
  assert.equal(rowFlows(row(B), l).maxOut30, 70);
});

test("a tracked vault the flows job has not seen yet is 'collecting' with no date", () => {
  assert.deepEqual(rowFlows(row("0x00000000000000000000000000000000000000cc"), backfill([])), { status: "collecting", since: null });
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
  assert.equal(rowFlows(row(A), l).status, "full");
});

test("each chain's own day sets its window and its 30-day check, not the latest run of another chain", () => {
  let l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-20", lastBlock: 1, tracked: tA, backfill: true, events: [ev("2026-10-21", "in", 9)] });
  l = addFlows(l, { chain: "base", today: "2026-10-21", lastBlock: 1, tracked: [{ address: B, decimals: 6 }], backfill: true, events: [] });
  assert.equal(l.asOf, "2026-10-21");
  assert.equal(flowsSummary(l, "ethereum", A).asOf, "2026-10-20");
  assert.equal(flowsSummary(l, "ethereum", A).in30, 0, "21 Oct is not complete on ethereum yet");
  l.vaults[`ethereum:${A}`].firstDay = "2026-09-21"; // = ethereum's day − 29: full there, not with base's day
  assert.equal(rowFlows(row(A), l).status, "full");
});

test("a run on one chain only drops old days of its own vaults", () => {
  const behind = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-01", lastBlock: 1, tracked: tA, backfill: true, events: [ev("2026-09-05", "in", 1)] });
  const l = addFlows(behind, { chain: "base", today: "2026-10-21", lastBlock: 1, tracked: [], backfill: true, events: [] });
  assert.ok(l.vaults[`ethereum:${A}`].days["2026-09-05"], "base's run leaves ethereum's days alone");
  const l2 = addFlows(behind, { chain: "ethereum", today: "2026-10-21", lastBlock: 2, tracked: [], events: [] });
  assert.equal(l2.vaults[`ethereum:${A}`].days["2026-09-05"], undefined, "ethereum's own run drops them");
});

test("a damaged first day gives 'unavailable', never a guessed state", () => {
  const l = backfill([ev("2026-10-21", "in", 5)]);
  l.vaults[`ethereum:${A}`].firstDay = "2026-13-01";
  assert.deepEqual(rowFlows(row(A), l), { status: "unavailable" });
});

test("a vault that leaves and comes back (back in `tracked`) keeps its first day, its days and its state", () => {
  let l = seenOn("2026-10-23", [ev("2026-10-24", "out", 70, B)]);
  l = until(l, "2026-10-26"); // out of the snapshot
  l = addFlows(l, { chain: "ethereum", today: "2026-11-05", lastBlock: 950, tracked: [...tA, { address: B, decimals: 6 }], events: [] }); // back
  assert.equal(l.vaults[`ethereum:${B}`].firstDay, "2026-10-23");
  assert.deepEqual(rowFlows(row(B), l), { status: "partial", since: "2026-10-23", in30: 0, out30: 70, net7: 0, net30: -70, maxOut30: 70, asOf: "2026-11-05" });
});

test("coverage edges: the day it is seen is 'collecting'; 29 days still names its since date; past 30 days the window moves on", () => {
  assert.deepEqual(rowFlows(row(B), seenOn("2026-10-23")), { status: "collecting", since: "2026-10-23" }, "0 days");
  assert.equal(rowFlows(row(B), until(seenOn("2026-10-23"), "2026-11-20")).since, "2026-10-23");
  const late = until(seenOn("2026-10-23", [ev("2026-10-25", "in", 10, B)]), "2026-12-31");
  assert.equal(rowFlows(row(B), late).status, "full");
  assert.equal(rowFlows(row(B), late).in30, 0, "25 Oct is outside 2 Dec–31 Dec");
});

test("a first day or as-of date in the wrong shape, or missing on a stored vault, gives 'unavailable'", () => {
  for (const bad of ["2026-9-22", "x", undefined]) {
    const l = backfill([ev("2026-10-21", "in", 5)]);
    l.vaults[`ethereum:${A}`].firstDay = bad;
    assert.deepEqual(rowFlows(row(A), l), { status: "unavailable" }, String(bad));
  }
});

test("each chain stores when it last updated; a row is stale once that is more than 36 hours old (exactly 36 h is not)", () => {
  const l = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-21", lastBlock: 1, tracked: tA, backfill: true, events: [], updatedAt: "2026-10-22T05:00:00.000Z" });
  assert.equal(l.chains.ethereum.updatedAt, "2026-10-22T05:00:00.000Z");
  const at = (iso) => rowFlows(row(A), l, Date.parse(iso));
  assert.equal(at("2026-10-23T16:00:00Z").stale, undefined, "35 h: a late schedule is not stale");
  assert.equal(at("2026-10-23T17:00:00Z").stale, undefined, "exactly 36 h: not yet");
  assert.equal(at("2026-10-23T17:00:00.001Z").stale, true, "just over 36 h");
  assert.equal(at("2026-10-23T18:00:00Z").updatedAt, "2026-10-22T05:00:00.000Z");
  assert.equal(at("2026-10-23T18:00:00Z").asOf, "2026-10-21", "the summary's as-of is the last complete day read");
});

test("staleness also follows the data's own day: a ledger with no update time, or a chain that keeps reading only part of the way", () => {
  const old = backfill([]); // asOf 21 Oct, no updatedAt
  assert.equal(rowFlows(row(A), old, Date.parse("2026-10-23T23:00:00Z")).stale, undefined, "47 h after 21 Oct ended");
  assert.equal(rowFlows(row(A), old, Date.parse("2026-10-24T01:00:00Z")).stale, true, "49 h after 21 Oct ended");
  const creeping = addFlows(emptyLedger(), { chain: "ethereum", today: "2026-10-03", lastBlock: 1, tracked: tA, backfill: true, events: [], updatedAt: "2026-10-28T05:00:00.000Z" });
  assert.equal(rowFlows(row(A), creeping, Date.parse("2026-10-28T06:00:00Z")).stale, true, "updated an hour ago, but the data ends on 3 Oct");
});

test("a damaged update time is stale, never fresh; collecting and partial rows carry staleness too", () => {
  for (const bad of ["garbage", 123, ""]) {
    const l = backfill([]); l.chains.ethereum.updatedAt = bad;
    const f = rowFlows(row(A), l, Date.parse("2026-10-22T06:00:00Z"));
    assert.equal(f.stale, true, String(bad));
    assert.equal(f.updatedAt, undefined, "no date shown from a damaged value");
  }
  const late = Date.parse("2026-11-10T00:00:00Z");
  const collecting = until(seenOn("2026-10-23"), "2026-10-25");
  assert.equal(rowFlows(row(B), collecting, late).status, "collecting");
  assert.equal(rowFlows(row(B), collecting, late).stale, true);
  const partial = until(seenOn("2026-10-23"), "2026-11-01");
  assert.equal(rowFlows(row(B), partial, late).status, "partial");
  assert.equal(rowFlows(row(B), partial, late).stale, true);
});

test("an untracked row says why: intake's reason for vault venues; DEX pool, plain lending market or protocol for the rest", () => {
  const r = (o) => untrackedReason({ project: "aave-v3", bucket: "lend", chain: "Ethereum", legs: ["USDC"], stableType: "fiat", flowsBlock: null, ...o });
  for (const b of ["chain", "coin", "unverified", "version", "lending"]) assert.equal(r({ project: "morpho-blue", flowsBlock: b }), b, "intake knows: " + b);
  assert.equal(r({ project: "uniswap-v3", bucket: "LP", chain: "Base", legs: ["USDC", "USDT"] }), "dex", "a DEX pool on any chain");
  assert.equal(r({}), "lending");
  assert.equal(r({ chain: "Base" }), "lending", "a lending market on Base is still a lending market");
  assert.equal(r({ legs: ["SGHO"], stableType: "yield", label: "SGHO" }), "protocol", "Aave's sGHO savings token is not a lending market");
  assert.equal(r({ label: "USDC · Umbrella", poolMeta: "Umbrella" }), "protocol", "Aave Umbrella staking is not a lending market");
  assert.equal(r({ project: "blackrock-buidl", stableType: "rwa" }), "protocol", "a fund token is not called a lending market");
  assert.equal(r({ project: "kamino-lend", chain: "Solana" }), "protocol");
  assert.equal(r({ project: "spark-savings", bucket: "vault" }), "protocol");
  assert.equal(r({ flowsBlock: "made-up" }), "lending", "an unknown code from intake is ignored, never shown");
});

test("every protocol in trusted-protocols.json gets an intended reason when it has no vault", async () => {
  const { readFile } = await import("node:fs/promises");
  const protocols = JSON.parse(await readFile(new URL("./trusted-protocols.json", import.meta.url), "utf8"));
  const lending = ["aave-v3", "aave-v4", "compound-v3", "compound-v2", "sparklend", "marginfi", "jupiter-lend", "save"];
  const vaultVenues = ["morpho-blue", "yearn-finance", "euler-v2"]; // reasons come from intake (flowsBlock)
  for (const [slug, p] of Object.entries(protocols)) {
    if (slug.startsWith("_")) continue;
    const got = untrackedReason({ project: slug, bucket: p.bucket, chain: "Ethereum", legs: ["USDC"], stableType: "fiat", flowsBlock: vaultVenues.includes(slug) ? "unverified" : null });
    const want = p.bucket === "LP" ? "dex" : lending.includes(slug) ? "lending" : vaultVenues.includes(slug) ? "unverified" : "protocol";
    assert.equal(got, want, slug + " — add it to the right list in flows.mjs on purpose");
  }
});

test("every untracked reason code has words on the page", async () => {
  const { readFile } = await import("node:fs/promises");
  const app = await readFile(new URL("../site/app.js", import.meta.url), "utf8");
  const block = app.slice(app.indexOf("const NOT_TRACKED = {"), app.indexOf("};", app.indexOf("const NOT_TRACKED = {")));
  for (const code of UNTRACKED_REASONS) assert.ok(block.includes(`  ${code}: "`), code);
});
