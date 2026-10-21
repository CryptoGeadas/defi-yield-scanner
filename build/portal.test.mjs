// Tests for the SQD Portal client (portal.mjs), against a fake Portal.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import sha3 from "js-sha3";
import { fetchVaultFlows, finalizedHead, blockAt, PortalError, DEPOSIT, WITHDRAW } from "./portal.mjs";

const VAULT = "0x00000000000000000000000000000000000000aa";
const VAULT18 = "0x00000000000000000000000000000000000000cc";
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
// A Deposit/Withdraw log as the Portal returns it: assets is the first data word.
const log = (topic0, assets, address = VAULT) => ({ address, topics: [topic0], data: "0x" + word(assets) + word(1n) });
const block = (number, timestamp, logs = []) => ({ header: { number, timestamp }, logs });
const DAY1 = Date.parse("2026-10-20T10:00:00Z") / 1000;
const DAY2 = Date.parse("2026-10-21T10:00:00Z") / 1000;

// fake Portal: answers each call with the next scripted response and records the requests.
function fakePortal(responses) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body) : null });
    const r = responses.shift();
    if (!r) throw new Error("no more scripted responses");
    const text = r.raw ?? (r.lines ? r.lines.map((l) => JSON.stringify(l)).join("\n") + "\n" : JSON.stringify(r.body ?? ""));
    return new Response(r.status === 204 ? null : text, { status: r.status ?? 200, headers: r.headers ?? {} });
  };
  return { fetchImpl, calls };
}
const noSleep = async () => {};
const vaults = [{ address: VAULT, decimals: 6 }];
const read = (fetchImpl, more = {}) => fetchVaultFlows({ dataset: "ethereum-mainnet", vaults, fromBlock: 100, toBlock: 200, fetchImpl, sleep: noSleep, ...more });
const busy = (status = 529, code = "overloaded", headers = {}) => ({ status, headers, body: { error: { type: "rate_limit_error", code, message: "busy" } } });

test("the event topics are the ERC-4626 Deposit and Withdraw signatures", () => {
  assert.equal(DEPOSIT, "0x" + sha3.keccak256("Deposit(address,address,uint256,uint256)"));
  assert.equal(WITHDRAW, "0x" + sha3.keccak256("Withdraw(address,address,address,uint256,uint256)"));
});

test("reads Deposit as in and Withdraw as out, in asset units, on the block's UTC day, and continues across batches to the end of the range", async () => {
  const { fetchImpl, calls } = fakePortal([
    { lines: [block(100, DAY1, [log(DEPOSIT, 5_000_000n)]), block(150, DAY1)] },
    { lines: [block(160, DAY2, [log(WITHDRAW, 2_500_000n)]), block(200, DAY2)] },
  ]);
  const r = await read(fetchImpl);
  assert.deepEqual(r.events, [
    { vault: VAULT, day: "2026-10-20", kind: "in", amount: 5 },
    { vault: VAULT, day: "2026-10-21", kind: "out", amount: 2.5 },
  ]);
  assert.equal(r.lastBlock, 200);
  assert.equal(r.lastTimestamp, DAY2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.fromBlock, 151, "the next request starts after the last block received");
  assert.match(calls[0].url, /\/datasets\/ethereum-mainnet\/finalized-stream$/, "finalized blocks only");
  assert.deepEqual(calls[0].body.logs, [{ address: [VAULT], topic0: [DEPOSIT, WITHDRAW] }], "one query for all vaults");
  assert.ok(r.bytes > 0);
});

test("reports progress after each batch", async () => {
  const seen = [];
  const { fetchImpl } = fakePortal([{ lines: [block(150, DAY1, [log(DEPOSIT, 1n)])] }, { lines: [block(200, DAY2)] }]);
  await read(fetchImpl, { onBatch: (p) => seen.push([p.lastBlock, p.events]) });
  assert.deepEqual(seen, [[150, 1], [200, 1]]);
});

test("each vault's own decimals; addresses matched whatever their case; the day is UTC around midnight", async () => {
  const before = Date.parse("2026-10-20T23:59:59Z") / 1000, after = Date.parse("2026-10-21T00:00:00Z") / 1000;
  const { fetchImpl, calls } = fakePortal([{ lines: [
    block(150, before, [log(DEPOSIT, 3_000_000n, VAULT.toUpperCase().replace("0X", "0x"))]),
    block(200, after, [log(WITHDRAW, 1_234_567n * 10n ** 18n, VAULT18)]),
  ] }]);
  const r = await fetchVaultFlows({ dataset: "ethereum-mainnet", vaults: [...vaults, { address: VAULT18, decimals: 18 }], fromBlock: 100, toBlock: 200, fetchImpl, sleep: noSleep });
  assert.deepEqual(r.events, [
    { vault: VAULT, day: "2026-10-20", kind: "in", amount: 3 },
    { vault: VAULT18, day: "2026-10-21", kind: "out", amount: 1234567 },
  ]);
  assert.deepEqual(calls[0].body.logs[0].address, [VAULT, VAULT18]);
});

test("stops when the Portal says there is no more data", async () => {
  const { fetchImpl, calls } = fakePortal([{ lines: [block(120, DAY1)] }, { status: 204 }]);
  const r = await read(fetchImpl);
  assert.equal(r.lastBlock, 120);
  assert.equal(calls.length, 2);
});

test("an empty 200 or a block out of order is an error, not the end of the data", async () => {
  await assert.rejects(read(fakePortal([{ raw: "" }]).fetchImpl), (e) => e.code === "empty_batch");
  await assert.rejects(read(fakePortal([{ lines: [block(150, DAY1), block(140, DAY1)] }]).fetchImpl), (e) => e.code === "bad_block");
  await assert.rejects(read(fakePortal([{ lines: [{ header: { timestamp: DAY1 } }] }]).fetchImpl), (e) => e.code === "bad_block");
  const bad = { address: VAULT, topics: [DEPOSIT], data: "0x" };
  await assert.rejects(read(fakePortal([{ lines: [block(150, DAY1, [bad])] }]).fetchImpl), (e) => e.code === "bad_log" && /block 150/.test(e.message));
});

test("waits for Retry-After and tries again on 429, 503 and 529; 5 s when there is no usable header; a huge value is capped at a minute", async () => {
  const waits = [];
  const { fetchImpl, calls } = fakePortal([
    busy(529, "overloaded", { "retry-after": "3" }),
    busy(429, "rate_limited", { "retry-after": "3600" }),
    busy(503, "unavailable"),
    busy(429, "rate_limited", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
    { lines: [block(200, DAY1)] },
  ]);
  const r = await read(fetchImpl, { sleep: async (ms) => waits.push(ms) });
  assert.equal(r.lastBlock, 200);
  assert.deepEqual(waits, [3000, 60000, 5000, 5000]);
  assert.ok(calls.every((c) => c.body.fromBlock === 100), "a retry repeats the same request");
});

test("a dropped connection is retried", async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1 ? Promise.reject(new TypeError("fetch failed")) : new Response(JSON.stringify(block(200, DAY1)) + "\n"));
  const r = await read(fetchImpl);
  assert.equal(r.lastBlock, 200);
  assert.equal(n, 2);
});

test("gives up after exactly the retry limit with a PortalError naming the Portal's code", async () => {
  const sleeps = [];
  const { fetchImpl, calls } = fakePortal(Array.from({ length: 10 }, () => busy()));
  await assert.rejects(read(fetchImpl, { maxRetries: 3, sleep: async (ms) => sleeps.push(ms) }),
    (e) => e instanceof PortalError && e.status === 529 && e.code === "overloaded" && /overloaded/.test(e.message));
  assert.equal(calls.length, 4, "1 try + 3 retries");
  assert.equal(sleeps.length, 3);
});

test("an error that is not worth retrying stops at once; the code decides, not the wording", async () => {
  for (const message of ["Field x is invalid", "completely reworded"]) {
    const { fetchImpl, calls } = fakePortal([{ status: 400, body: { error: { type: "invalid_request_error", code: "invalid_field", message } } }]);
    await assert.rejects(read(fetchImpl), (e) => e.code === "invalid_field");
    assert.equal(calls.length, 1);
  }
  const { fetchImpl } = fakePortal([{ status: 500, raw: "<html>proxy error</html>" }]);
  await assert.rejects(read(fetchImpl), (e) => e.code === "http_500");
});

test("a failure part-way through hands back what was read before it", async () => {
  const { fetchImpl } = fakePortal([{ lines: [block(120, DAY1, [log(DEPOSIT, 1_000_000n)])] }, busy(), busy()]);
  await assert.rejects(read(fetchImpl, { maxRetries: 1 }),
    (e) => e.code === "overloaded" && e.partial.lastBlock === 120 && e.partial.lastTimestamp === DAY1 && e.partial.events.length === 1);
});

test("logs from other addresses or events are ignored", async () => {
  const other = log(DEPOSIT, 9n, "0x00000000000000000000000000000000000000bb");
  const transfer = { address: VAULT, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], data: "0x" + word(9n) };
  const { fetchImpl } = fakePortal([{ lines: [block(200, DAY1, [other, transfer])] }]);
  assert.deepEqual((await read(fetchImpl)).events, []);
});

test("finalized head and block-at-time read their numbers, retry when busy, and reject a reply without one", async () => {
  let f = fakePortal([busy(), { body: { number: 26_000_000, hash: "0x1" } }]);
  assert.equal(await finalizedHead("ethereum-mainnet", { fetchImpl: f.fetchImpl, sleep: noSleep }), 26_000_000);
  assert.match(f.calls[1].url, /ethereum-mainnet\/finalized-head$/);
  f = fakePortal([{ body: { block_number: 25_800_000 } }]);
  assert.equal(await blockAt("ethereum-mainnet", 1792540800.7, { fetchImpl: f.fetchImpl, sleep: noSleep }), 25_800_000);
  assert.match(f.calls[0].url, /timestamps\/1792540800\/block$/, "seconds, floored");
  await assert.rejects(finalizedHead("x", { fetchImpl: fakePortal([{ body: {} }]).fetchImpl }), (e) => e.code === "bad_head");
  await assert.rejects(blockAt("x", 1, { fetchImpl: fakePortal([{ body: {} }]).fetchImpl }), (e) => e.code === "bad_block");
});
