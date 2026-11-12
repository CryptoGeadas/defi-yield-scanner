// Tests for the build's one fetch helper (net.mjs), with a fake fetch and no real waiting.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { netFetch } from "./net.mjs";

const quiet = () => { const lines = []; return { lines, warn: (l) => lines.push(l) }; };
const waits = () => { const ms = []; return { ms, sleep: async (n) => { ms.push(n); } }; };
const answer = (status) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ status }) });

test("a good answer is returned at once, with a timeout signal on the call", async () => {
  let init;
  const res = await netFetch("https://a.example/x", { headers: { h: "1" } }, { fetchImpl: async (_u, i) => { init = i; return answer(200); } });
  assert.equal(res.status, 200);
  assert.equal(init.headers.h, "1");
  assert.ok(init.signal instanceof AbortSignal);
});

test("a slow source times out instead of hanging, is tried again, then reported", async () => {
  const log = quiet(), w = waits();
  let calls = 0;
  const hang = (_u, i) => new Promise((_res, rej) => { calls++; i.signal.addEventListener("abort", () => rej(i.signal.reason)); });
  const alive = setInterval(() => {}, 10); // a timeout signal's own timer does not keep Node running
  try {
    await assert.rejects(netFetch("https://slow.example/feed?key=secret", {}, { timeoutMs: 20, tries: 3, fetchImpl: hang, sleep: w.sleep, log }),
      /slow\.example unreachable after 3 tries \(no answer in 0s\)/);
  } finally { clearInterval(alive); }
  assert.equal(calls, 3);
  assert.deepEqual(w.ms, [5_000, 10_000]);
  assert.equal(log.lines.length, 2);
  assert.ok(log.lines.every((l) => !l.includes("secret")), "the log names the host, never the full URL");
});

test("a rate-limited source waits longer and is tried again; the good answer is returned", async () => {
  const log = quiet(), w = waits();
  const seq = [answer(429), answer(503), answer(200)];
  const res = await netFetch("https://busy.example/x", {}, { fetchImpl: async () => seq.shift(), sleep: w.sleep, log });
  assert.equal(res.status, 200);
  assert.deepEqual(w.ms, [30_000, 10_000]);
  assert.match(log.lines[0], /HTTP 429 from busy\.example \(rate limited\)/);
  assert.match(log.lines[1], /HTTP 503 from busy\.example/);
});

test("a source that keeps failing hands back its last answer, so the caller reports the status", async () => {
  const w = waits();
  let calls = 0;
  const res = await netFetch("https://down.example/x", {}, { fetchImpl: async () => { calls++; return answer(500); }, sleep: w.sleep, log: quiet() });
  assert.equal(res.status, 500);
  assert.equal(calls, 3);
});

test("a client error (404) is not retried", async () => {
  let calls = 0;
  const res = await netFetch("https://a.example/missing", {}, { fetchImpl: async () => { calls++; return answer(404); }, sleep: async () => assert.fail("no wait"), log: quiet() });
  assert.equal(res.status, 404);
  assert.equal(calls, 1);
});

test("a network error is tried again and then thrown with the host and the reason", async () => {
  const w = waits();
  const down = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); };
  await assert.rejects(netFetch("https://gone.example/x", {}, { tries: 2, fetchImpl: down, sleep: w.sleep, log: quiet() }), /gone\.example unreachable after 2 tries \(ECONNRESET\)/);
  assert.deepEqual(w.ms, [5_000]);
});

test("every build fetch goes through the net module", async () => {
  const dir = new URL("./", import.meta.url);
  // portal.mjs keeps its own retry and deadline rules for long streamed reads
  const exempt = new Set(["net.mjs", "portal.mjs"]);
  const direct = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".mjs") || name.endsWith(".test.mjs") || exempt.has(name)) continue;
    const text = await readFile(new URL(name, dir), "utf8");
    text.split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "");
      if (/(^|[^.\w])fetch\(/.test(code) || /fetchImpl = fetch\b/.test(code)) direct.push(`${name}:${i + 1}`);
    });
  }
  assert.deepEqual(direct, [], "call netFetch (net.mjs) instead of fetch");
});
