// ─────────────────────────────────────────────────────────────────────────────
// EULER V2 VAULTS — Euler's curated labels (github.com/euler-xyz/euler-labels):
// per chain, products.json lists each product's live `vaults`, its `deprecatedVaults`
// and whether the Euler app hides it (`notExplorable`); earn-vaults.json lists Euler
// Earn vaults. Labels carry addresses only, so each vault's name() and asset() are
// read on-chain (batched eth_call, public RPCs that accept batches of 100; each RPC
// is tried twice before the next one).
//
//   fetchEulerVaults(chains) → Map chainId → [{ address, name, asset, product, earn, status }] | null
//
// A chain whose labels or RPC fail maps to null; intake.mjs then hides that
// chain's Euler rows (fail closed: an unverifiable permissionless vault is not shown).
// ─────────────────────────────────────────────────────────────────────────────
import { MORPHO_CHAINID as CHAIN_ID } from "./deeplink-sources.mjs";

const LABELS = "https://raw.githubusercontent.com/euler-xyz/euler-labels/master";
const RPCS = {
  1: ["https://ethereum-rpc.publicnode.com", "https://rpc.mevblocker.io"],
  8453: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  42161: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
};
const NAME = "0x06fdde03", ASSET = "0x38d52e0f"; // name(), asset()
const BATCH = 100, TRIES = 2;

// products + earn list → [{ address (lower), product, earn, status }]; deprecated wins.
const RANK = { live: 0, hidden: 1, deprecated: 2 };
export function labelEntries(products = {}, earn = []) {
  // Shape check: a renamed field must not turn hidden or deprecated vaults into live ones.
  if (!products || typeof products !== "object" || Array.isArray(products)) throw new Error("products.json is not an object");
  for (const [k, p] of Object.entries(products)) {
    if (!Array.isArray(p?.vaults) || typeof p?.name !== "string") throw new Error(`products.json: "${k}" has no name or vaults list — format changed?`);
    const odd = Object.keys(p).filter((f) => /deprecat|explor|hidden/i.test(f) && !["deprecatedVaults", "deprecationReason", "notExplorable"].includes(f));
    if (odd.length) throw new Error(`products.json: "${k}" has unknown field(s) ${odd.join(", ")} — format changed?`);
  }
  if (!Array.isArray(earn)) throw new Error("earn-vaults.json is not a list");
  const by = new Map();
  const put = (address, product, isEarn, status) => {
    const a = String(address).toLowerCase(), prev = by.get(a);
    if (!prev || RANK[status] > RANK[prev.status]) by.set(a, { address: a, product, earn: isEarn, status });
  };
  for (const p of Object.values(products)) {
    for (const a of p.vaults || []) put(a, p.name, false, p.notExplorable ? "hidden" : "live");
    for (const a of p.deprecatedVaults || []) put(a, p.name, false, "deprecated");
  }
  for (const e of earn || []) {
    const o = typeof e === "string" ? { address: e } : e;
    if (o?.address) put(o.address, null, true, o.deprecated ? "deprecated" : o.notExplorable ? "hidden" : "live");
  }
  return [...by.values()];
}

// ABI-encoded `string` / `address` return values.
export function decodeString(hex) {
  if (typeof hex !== "string" || hex.length < 130) return null;
  const len = parseInt(hex.slice(66, 130), 16);
  if (!Number.isFinite(len) || hex.length < 130 + len * 2) return null;
  return Buffer.from(hex.slice(130, 130 + len * 2), "hex").toString("utf8");
}
export function decodeAddress(hex) {
  return typeof hex === "string" && hex.length === 66 ? "0x" + hex.slice(26).toLowerCase() : null;
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function rpcBatch(urls, calls) {
  let last;
  for (const url of urls.flatMap((u) => Array(TRIES).fill(u))) {
    try {
      const out = [];
      for (let i = 0; i < calls.length; i += BATCH) {
        const res = await getJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(calls.slice(i, i + BATCH)) });
        if (!Array.isArray(res)) throw new Error(`not a batch answer: ${JSON.stringify(res).slice(0, 120)}`);
        if (!res.some((x) => x?.result)) throw new Error(`every call failed: ${JSON.stringify(res[0]?.error ?? res[0]).slice(0, 120)}`);
        out.push(...res);
      }
      return new Map(out.map((x) => [x.id, x.result]));
    } catch (e) { last = e; }
  }
  throw last;
}

async function fetchChain(cid) {
  const [products, earn] = await Promise.all([
    getJson(`${LABELS}/${cid}/products.json`),
    getJson(`${LABELS}/${cid}/earn-vaults.json`).catch((e) => { console.warn(`  euler: earn-vaults.json for chain ${cid} failed (${e.message}) — Earn vaults hidden there`); return []; }),
  ]);
  const entries = labelEntries(products, earn);
  const calls = entries.flatMap((v, i) => [NAME, ASSET].map((data, k) => ({ jsonrpc: "2.0", id: i * 2 + k, method: "eth_call", params: [{ to: v.address, data }, "latest"] })));
  const res = await rpcBatch(RPCS[cid], calls);
  const out = [];
  let unread = 0;
  entries.forEach((v, i) => {
    const name = decodeString(res.get(i * 2)), asset = decodeAddress(res.get(i * 2 + 1));
    if (name && asset) out.push({ ...v, name, asset });
    else unread++;
  });
  if (!out.length) throw new Error(`no vault could be read on-chain (${entries.length} listed)`);
  if (unread) console.warn(`  euler: chain ${cid}: ${unread}/${entries.length} listed vaults unreadable on-chain — hidden`);
  return out;
}

export async function fetchEulerVaults(chains) {
  const map = new Map();
  const ids = chains.map((c) => CHAIN_ID[c]).filter((id) => RPCS[id]);
  const skipped = chains.filter((c) => CHAIN_ID[c] && !RPCS[CHAIN_ID[c]]);
  if (skipped.length) console.log(`  euler: no labels/RPC set up for ${skipped.join(", ")} — Euler pools there are not shown`); // Euler has no labels for Optimism/Polygon
  await Promise.all(ids.map(async (cid) => {
    try { map.set(cid, await fetchChain(cid)); }
    catch (e) { map.set(cid, null); console.warn(`  euler: labels for chain ${cid} failed — its Euler rows are hidden —`, e.message); }
  }));
  return map;
}
