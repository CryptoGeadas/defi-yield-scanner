// The shared flows core (#61), on its own: a fake Portal and a fake adapter that tracks
// made-up "widgets", so nothing here depends on what the Scanner reads. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runChains, streamLogs, dropOldDays, markChain, freshness, LATE_MS, PortalError } from "./flows-core.mjs";

const NOW = Date.parse("2026-11-16T05:00:00Z");
const quiet = { log() {}, warn() {}, error() {} };
const ts = (day) => Date.parse(`${day}T12:00:00Z`) / 1000;

// a fake adapter: items come from the ledger's "widgets"; add() stores one count per day
function widgets(names = ["a", "b"]) {
  const calls = [];
  return {
    calls,
    noun: "widgets",
    prepare: ({ ledger }) => ({ ledger, items: names, known: Object.keys(ledger.widgets ?? {}).length }),
    read: async (args) => { calls.push(args); return args.portal.read(args); },
    add: (ledger, { chain, events, lastBlock, today, updatedAt }) => {
      const next = structuredClone(ledger);
      next.widgets ??= {};
      for (const e of events) ((next.widgets[`${chain}:${e.name}`] ??= { days: {} }).days[e.day] = (next.widgets[`${chain}:${e.name}`].days[e.day] ?? 0) + 1);
      markChain(next, chain, { lastBlock, today, updatedAt });
      return next;
    },
  };
}
const portal = (over = {}) => ({ finalizedHead: async () => 200, blockAt: async () => 100, read: async ({ toBlock }) => ({ events: [{ name: "a", day: "2026-11-15" }], lastBlock: toBlock, lastTimestamp: ts("2026-11-16"), bytes: 10 }), ...over });
const empty = () => ({ asOf: null, chains: {} });

test("the core file knows nothing about what a tool tracks", async () => {
  const src = await readFile(new URL("./flows-core.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(src, /vault|deposit|withdraw|mint|burn|redeem/i);
});

test("first run: backfill from 30 days back, the day before the last block is today, a full read is an update", async () => {
  const a = widgets();
  const r = await runChains({ ledger: empty(), datasets: { one: "one-mainnet" }, adapter: a, portal: portal(), now: NOW, log: quiet });
  assert.deepEqual(r.failed, []);
  assert.equal(a.calls[0].fromBlock, 100);
  assert.equal(a.calls[0].toBlock, 200);
  assert.deepEqual(a.calls[0].items, ["a", "b"]);
  assert.equal(r.ledger.chains.one.asOf, "2026-11-15");
  assert.equal(r.ledger.chains.one.updatedAt, new Date(NOW).toISOString());
  assert.equal(r.ledger.widgets["one:a"].days["2026-11-15"], 1);
});

test("a later run continues from the last block + 1; no new blocks reads nothing", async () => {
  const ledger = { asOf: "2026-11-14", chains: { one: { lastBlock: 150, asOf: "2026-11-14" } }, widgets: { "one:a": { days: {} } } };
  const a = widgets();
  await runChains({ ledger, datasets: { one: "x" }, adapter: a, portal: portal(), now: NOW, log: quiet });
  assert.equal(a.calls[0].fromBlock, 151);
  const b = widgets();
  await runChains({ ledger: { ...ledger, chains: { one: { lastBlock: 200 } } }, datasets: { one: "x" }, adapter: b, portal: portal(), now: NOW, log: quiet });
  assert.equal(b.calls.length, 0);
});

test("a Portal failure part-way keeps what was read, marks no update, and is the Portal's error", async () => {
  const fail = async () => { const e = new PortalError(503, "busy", "x"); e.partial = { events: [], lastBlock: 150, lastTimestamp: ts("2026-11-15"), bytes: 5 }; throw e; };
  const saved = [];
  const r = await runChains({ ledger: empty(), datasets: { one: "x", two: "y" }, adapter: widgets(), portal: portal({ read: fail }), now: NOW, log: quiet, onChainDone: async (l) => saved.push(l) });
  assert.deepEqual(r.failed, ["one", "two"]);
  assert.deepEqual(r.ownErrors, []);
  assert.equal(r.ledger.chains.one.lastBlock, 150);
  assert.equal(r.ledger.chains.one.updatedAt, undefined);
  assert.equal(saved.length, 2, "saved after each chain");
});

test("our own error fails the run; a ledger with data but no block is refused; a never-read chain records when it was tried", async () => {
  const r = await runChains({ ledger: { asOf: null, chains: {}, widgets: { "one:a": { days: {} } } }, datasets: { one: "x" }, adapter: widgets(), portal: portal(), now: NOW, log: quiet });
  assert.deepEqual(r.ownErrors, ["one"]);
  assert.match(r.reasons.one, /refusing to backfill/);
  assert.equal(r.ledger.chains.one.firstTriedAt, new Date(NOW).toISOString());
});

test("ledger helpers: old days dropped for one chain only; freshness and the 72 h rule", () => {
  const items = { "one:a": { days: { "2026-10-01": 1, "2026-11-15": 1 } }, "two:a": { days: { "2026-10-01": 1 } } };
  dropOldDays(items, "one", "2026-11-15");
  assert.deepEqual(Object.keys(items["one:a"].days), ["2026-11-15"]);
  assert.deepEqual(Object.keys(items["two:a"].days), ["2026-10-01"]);
  assert.equal(freshness({ asOf: "2026-11-15", updatedAt: "2026-11-16T04:00:00Z" }, null, NOW).stale, false);
  assert.equal(freshness({ asOf: "2026-11-10" }, null, NOW).stale, true);
  assert.ok(freshness({ updatedAt: "2026-11-12T00:00:00Z" }, null, NOW).ageMs > LATE_MS);
});

test("streamLogs: batches until the range ends, the decoder picks the events, a bad block keeps the progress", async () => {
  const lines = (blocks) => blocks.map((b) => JSON.stringify(b)).join("\n");
  const answers = [
    lines([{ header: { number: 10, timestamp: ts("2026-11-14") }, logs: [{ n: 1 }, { n: 2 }] }]),
    lines([{ header: { number: 20, timestamp: ts("2026-11-15") }, logs: [{ n: 3 }] }]),
  ];
  const fetchImpl = async () => new Response(answers.shift(), { status: 200 });
  const r = await streamLogs({ dataset: "x", logs: [], fromBlock: 1, toBlock: 20, decode: (l, b) => (l.n === 2 ? null : { n: l.n, day: b.day }), fetchImpl, sleep: async () => {} });
  assert.deepEqual(r.events, [{ n: 1, day: "2026-11-14" }, { n: 3, day: "2026-11-15" }]);
  assert.equal(r.lastBlock, 20);
  const bad = [lines([{ header: { number: 10, timestamp: ts("2026-11-14") } }]), lines([{ header: { number: 5, timestamp: 1 } }])];
  await assert.rejects(streamLogs({ dataset: "x", logs: [], fromBlock: 1, toBlock: 20, decode: () => null, fetchImpl: async () => new Response(bad.shift()), sleep: async () => {} }),
    (e) => e.code === "bad_block" && e.partial.lastBlock === 10);
});
