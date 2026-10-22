// ─────────────────────────────────────────────────────────────────────────────
// SQD PORTAL CLIENT — the I/O half of money flows. Reads vaults' ERC-4626 Deposit and
// Withdraw events from the free public Portal (portal.sqd.dev, no key) and returns them
// as plain in/out amounts per UTC day. Everything about talking to the Portal lives here:
//   • finalized blocks only (/finalized-stream), so a chain reorg never reaches the ledger;
//   • one query for all vaults of a chain (cost follows the number of events, not vaults);
//   • a response is one batch, not the whole range: ask again from the last block + 1
//     until the range ends or the Portal answers 204 (no more data);
//   • rate-limit / overloaded answers and dropped connections: wait (Retry-After, at most
//     a minute) and repeat the same request, up to maxRetries in a row; any other error
//     stops at once. Errors are matched on error.code, never on the message (SQD rewords it).
//   • a failure part-way through throws with error.partial = what was read before it.
//
//   fetchVaultFlows({ dataset, vaults: [{ address, decimals }], fromBlock, toBlock, fetchImpl?, sleep?, maxRetries? = 30, onBatch?({ lastBlock, events, bytes }), deadline? })
//     deadline (ms): stop before the next batch once past it and return what was read.
//     → { events: [{ vault, day: "YYYY-MM-DD", kind: "in" | "out", amount }], lastBlock, lastTimestamp, bytes }
//     An empty 200, a block number out of order, or malformed log data is an error, not
//     the end of the data.
//   finalizedHead(dataset) → block number;  blockAt(dataset, unixSeconds) → block number
// ─────────────────────────────────────────────────────────────────────────────

const PORTAL = "https://portal.sqd.dev/datasets";
export const DEPOSIT = "0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7"; // Deposit(address,address,uint256,uint256)
export const WITHDRAW = "0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db"; // Withdraw(address,address,address,uint256,uint256)
const RETRY = new Set([429, 503, 529]);
const DEFAULT_WAIT_S = 5;
const MAX_WAIT_S = 60; // a huge Retry-After must not stall the daily job for hours
const REQUEST_TIMEOUT_MS = 120_000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class PortalError extends Error {
  constructor(status, code, message) {
    super(`SQD Portal ${status} ${code}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

// One HTTP call with the retry rule. Returns the Response (2xx or 204). A dropped or hung
// connection (fetch throws, or no answer in REQUEST_TIMEOUT_MS) counts as a retryable try.
async function call(url, init, { fetchImpl, sleep, maxRetries }) {
  for (let tries = 0; ; tries++) {
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }); }
    catch (e) {
      if (tries >= maxRetries) throw new PortalError(0, "network_error", e.message);
      await sleep(1000 * DEFAULT_WAIT_S);
      continue;
    }
    if (res.ok || res.status === 204) return res;
    let code = `http_${res.status}`, message = "";
    try { const j = await res.json(); code = j?.error?.code ?? code; message = j?.error?.message ?? ""; } catch { /* not the error envelope */ }
    if (!RETRY.has(res.status) || tries >= maxRetries) throw new PortalError(res.status, code, message || res.statusText || "no message");
    const wait = Number(res.headers.get("retry-after"));
    await sleep(1000 * Math.min(MAX_WAIT_S, Number.isFinite(wait) && wait > 0 ? wait : DEFAULT_WAIT_S));
  }
}
const opts = (o) => ({ fetchImpl: o.fetchImpl ?? fetch, sleep: o.sleep ?? realSleep, maxRetries: o.maxRetries ?? 30, onBatch: o.onBatch, deadline: o.deadline });

export async function finalizedHead(dataset, o = {}) {
  const res = await call(`${PORTAL}/${dataset}/finalized-head`, {}, opts(o));
  const n = (await res.json())?.number;
  if (!Number.isInteger(n)) throw new PortalError(res.status, "bad_head", `no block number for ${dataset}`);
  return n;
}

export async function blockAt(dataset, unixSeconds, o = {}) {
  const res = await call(`${PORTAL}/${dataset}/timestamps/${Math.floor(unixSeconds)}/block`, {}, opts(o));
  const n = (await res.json())?.block_number;
  if (!Number.isInteger(n)) throw new PortalError(res.status, "bad_block", `no block at ${unixSeconds} on ${dataset}`);
  return n;
}

const utcDay = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export async function fetchVaultFlows({ dataset, vaults, fromBlock, toBlock, ...rest }) {
  const o = opts(rest);
  const decimals = new Map(vaults.map((v) => [v.address.toLowerCase(), v.decimals]));
  const events = [];
  let bytes = 0, lastBlock = fromBlock - 1, lastTimestamp = null, from = fromBlock;
  try {
    while (from <= toBlock) {
      if (o.deadline && Date.now() > o.deadline) break; // time limit: return what was read; the caller saves it
      const res = await call(`${PORTAL}/${dataset}/finalized-stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "evm", fromBlock: from, toBlock,
          fields: { block: { number: true, timestamp: true }, log: { address: true, topics: true, data: true } },
          logs: [{ address: [...decimals.keys()], topic0: [DEPOSIT, WITHDRAW] }],
        }),
      }, o);
      if (res.status === 204) break;
      const text = await res.text();
      bytes += Buffer.byteLength(text);
      const blocks = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      // a 200 with nothing in it would end the read short of toBlock without a word
      if (!blocks.length) throw new PortalError(200, "empty_batch", `no blocks from ${from} on ${dataset}`);
      const batch = [];
      let prev = from - 1;
      for (const b of blocks) {
        const n = b.header?.number, ts = b.header?.timestamp;
        if (!Number.isInteger(n) || n <= prev || n > toBlock || !Number.isFinite(ts))
          throw new PortalError(200, "bad_block", `block header ${JSON.stringify(b.header)} after ${prev} on ${dataset}`);
        prev = n;
        for (const l of b.logs ?? []) {
          const vault = String(l.address).toLowerCase(), t0 = l.topics?.[0];
          if (!decimals.has(vault) || (t0 !== DEPOSIT && t0 !== WITHDRAW)) continue;
          const data = String(l.data);
          if (!/^0x[0-9a-fA-F]{64}/.test(data)) throw new PortalError(200, "bad_log", `block ${n} vault ${vault}: data ${data.slice(0, 20)}…`);
          const assets = BigInt(data.slice(0, 66)); // first data word = assets
          batch.push({ vault, day: utcDay(ts), kind: t0 === DEPOSIT ? "in" : "out", amount: Number(assets) / 10 ** decimals.get(vault) });
        }
      }
      // the whole batch checked out: only now does it count as read
      events.push(...batch);
      lastBlock = prev;
      lastTimestamp = blocks[blocks.length - 1].header.timestamp;
      from = lastBlock + 1;
      o.onBatch?.({ lastBlock, events: events.length, bytes });
    }
  } catch (e) {
    // batches are contiguous, so everything up to lastBlock is complete: hand it back
    // with the error so the caller can keep that progress instead of starting over.
    e.partial = { events, lastBlock, lastTimestamp, bytes };
    throw e;
  }
  return { events, lastBlock, lastTimestamp, bytes };
}
