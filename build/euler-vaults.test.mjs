// Tests for the pure parts of the Euler labels fetcher. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { labelEntries, decodeString, decodeAddress } from "./euler-vaults.mjs";

test("labels → one entry per vault with its product and status", () => {
  const products = {
    k3: { name: "K3 Capital Prime Market", vaults: ["0xA", "0xB"], deprecatedVaults: ["0xC"] },
    old: { name: "Old Market", vaults: ["0xD"], notExplorable: true },
    rez: { name: "Rezerve Markets", vaults: [], deprecatedVaults: ["0xE"], notExplorable: true },
  };
  const earn = ["0xF", { address: "0xG", deprecated: true }, { address: "0xH", notExplorable: true }];
  const by = Object.fromEntries(labelEntries(products, earn).map((e) => [e.address, e]));
  assert.deepEqual(by["0xa"], { address: "0xa", product: "K3 Capital Prime Market", earn: false, status: "live" });
  assert.equal(by["0xc"].status, "deprecated");
  assert.equal(by["0xd"].status, "hidden");
  assert.equal(by["0xe"].status, "deprecated");
  assert.deepEqual(by["0xf"], { address: "0xf", product: null, earn: true, status: "live" });
  assert.equal(by["0xg"].status, "deprecated");
  assert.equal(by["0xh"].status, "hidden");
});

test("a products.json whose format changed fails the chain instead of guessing", () => {
  assert.throws(() => labelEntries({ a: { name: "A", vaults: ["0xA"], notExplorableLend: true } }, []), /unknown field/);
  assert.throws(() => labelEntries({ a: { name: "A", liveVaults: ["0xA"] } }, []), /no name or vaults/);
  assert.throws(() => labelEntries([], []), /not an object/);
});

test("a vault listed live in one product and deprecated in another counts as deprecated", () => {
  const e = labelEntries({ a: { name: "A", vaults: ["0xA"] }, b: { name: "B", vaults: [], deprecatedVaults: ["0xa"] } }, []);
  assert.equal(e.length, 1);
  assert.equal(e[0].status, "deprecated");
});

test("ABI string and address results decode; anything else is null", () => {
  const str = "0x" + "20".padStart(64, "0") + "12".padStart(64, "0") + Buffer.from("EVK Vault eUSDC-22").toString("hex").padEnd(64, "0");
  assert.equal(decodeString(str), "EVK Vault eUSDC-22");
  assert.equal(decodeString("0x"), null);
  assert.equal(decodeString(undefined), null);
  assert.equal(decodeAddress("0x" + "0".repeat(24) + "A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"), "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.equal(decodeAddress("0x"), null);
});

// ── fetchEulerVaults with a stubbed fetch ───────────────────────────────────
import { mock } from "node:test";
import { fetchEulerVaults } from "./euler-vaults.mjs";

const enc = (s) => "0x" + "20".padStart(64, "0") + Buffer.from(s).length.toString(16).padStart(64, "0") + Buffer.from(s).toString("hex").padEnd(64, "0");
const addr = (a) => "0x" + "0".repeat(24) + a.slice(2).padStart(40, "0");
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// labels: products {A live, B live (unreadable on-chain)}; earn {E}; rpc answers per address.
function stub({ products = { p: { name: "P", vaults: ["0xa", "0xb"] } }, earn = ["0xe"], rpc = {}, rpcFail = new Set(), productsFail = false, earnFail = false } = {}) {
  const calls = [];
  mock.method(globalThis, "fetch", async (url, init) => {
    calls.push(url);
    if (url.endsWith("/products.json")) return productsFail ? json(null, 500) : json(products);
    if (url.endsWith("/earn-vaults.json")) return earnFail ? json(null, 404) : json(earn);
    if (rpcFail.has(url)) return json({ error: "rate limited" }, 200);
    const body = JSON.parse(init.body);
    return json(body.map((c) => ({ id: c.id, result: rpc[c.params[0].to]?.[c.params[0].data === "0x06fdde03" ? 0 : 1] })));
  });
  return calls;
}
const rpc = { "0xa": [enc("EVK Vault eUSDC-1"), addr("0xa0b8")], "0xe": [enc("K3 Earn USDC"), addr("0xa0b8")] };

test("fetchEulerVaults: readable vaults are returned with name and asset; unreadable ones are left out", async (t) => {
  t.after(() => mock.restoreAll());
  stub({ rpc });
  const m = await fetchEulerVaults(["Ethereum"]);
  const v = m.get(1);
  assert.deepEqual(v.map((x) => [x.address, x.name, x.asset, x.earn]), [["0xa", "EVK Vault eUSDC-1", "0x" + "0".repeat(36) + "a0b8", false], ["0xe", "K3 Earn USDC", "0x" + "0".repeat(36) + "a0b8", true]]);
});

test("fetchEulerVaults: products.json failing, or no vault readable, makes the chain null (fail closed)", async (t) => {
  t.after(() => mock.restoreAll());
  stub({ rpc, productsFail: true });
  assert.equal((await fetchEulerVaults(["Ethereum"])).get(1), null);
  mock.restoreAll();
  stub({ rpc: {} });
  assert.equal((await fetchEulerVaults(["Ethereum"])).get(1), null, "never an empty list that would read as 'labels fine'");
});

test("fetchEulerVaults: earn-vaults.json failing hides only Earn vaults", async (t) => {
  t.after(() => mock.restoreAll());
  stub({ rpc, earnFail: true });
  assert.deepEqual((await fetchEulerVaults(["Ethereum"])).get(1).map((x) => x.address), ["0xa"]);
});

test("fetchEulerVaults: an RPC answering only errors is skipped for the next one; chains without labels are not fetched", async (t) => {
  t.after(() => mock.restoreAll());
  const calls = stub({ rpc, rpcFail: new Set(["https://ethereum-rpc.publicnode.com"]) });
  const m = await fetchEulerVaults(["Ethereum", "Optimism", "Solana"]);
  assert.equal(m.get(1).length, 2);
  assert.deepEqual([...m.keys()], [1]);
  assert.equal(calls.filter((u) => u === "https://ethereum-rpc.publicnode.com").length, 2, "tried twice");
  assert.ok(calls.includes("https://rpc.mevblocker.io"));
});
