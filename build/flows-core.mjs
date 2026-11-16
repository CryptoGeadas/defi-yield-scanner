// ─────────────────────────────────────────────────────────────────────────────
// FLOWS CORE (#61) — the part of money flows that is the same for every tool. A tool adds an
// adapter that says what it reads (which contracts, which events) and how it stores them.
// This file is shared: the Scanner holds the source, other tools keep a byte-for-byte copy
// (docs/adr/0001). It knows nothing about what the tracked contracts are.
//
// SQD Portal client (portal.sqd.dev, free, no key):
//   • finalized blocks only (/finalized-stream), so a chain reorg never reaches a ledger;
//   • a response is one batch, not the whole range: ask again from the last block + 1
//     until the range ends or the Portal answers 204 (no more data);
//   • rate-limit / overloaded answers and dropped connections: wait (Retry-After, at most
//     a minute) and repeat the same request, up to maxRetries in a row; any other error
//     stops at once. Errors are matched on error.code, never on the message (SQD rewords it).
//   • a failure part-way through throws with error.partial = what was read before it.
//
//   finalizedHead(dataset) → block number;  blockAt(dataset, unixSeconds) → block number
//   streamLogs({ dataset, logs, logFields?, fromBlock, toBlock, decode, fetchImpl?, sleep?, maxRetries? = 30, onBatch?, deadline? })
//     logs: the Portal log filters; logFields: extra log fields to ask for (e.g. transactionHash). decode(log, { number, timestamp, day }) → an event, or null
//     to skip it; it throws a PortalError for malformed data. deadline (ms): stop before the next
//     batch once past it and return what was read.
//     → { events, lastBlock, lastTimestamp, bytes }. An empty 200 or a block number out of
//     order is an error, not the end of the data.
//
// Ledger helpers: KEEP_DAYS, shiftDay, utcDay, cents, dropOldDays, markChain.
// Freshness: freshness(chainInfo, fallbackAsOf, now) and the 36 h / 48 h / 72 h rules.
// Run loop: runChains({ ledger, datasets, adapter, portal, now, log, onChainDone, readLimitMs }).
// ─────────────────────────────────────────────────────────────────────────────

const PORTAL = "https://portal.sqd.dev/datasets";
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

export async function streamLogs({ dataset, logs, logFields = {}, fromBlock, toBlock, decode, ...rest }) {
  const o = opts(rest);
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
          fields: { block: { number: true, timestamp: true }, log: { address: true, topics: true, data: true, ...logFields } },
          logs,
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
        const block = { number: n, timestamp: ts, day: utcDay(ts * 1000) };
        for (const l of b.logs ?? []) {
          const e = decode(l, block);
          if (e) batch.push(e);
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

// ── ledger helpers ───────────────────────────────────────────────────────────
export const KEEP_DAYS = 30;
export const DAY_MS = 86_400_000;
export const shiftDay = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const cents = (n) => Math.round(n * 100) / 100;

// Drops one chain's days older than the 30-day window ending `today`. items = the ledger's
// map of tracked contracts ({ "chain:0x…": { days: { "YYYY-MM-DD": … } } }).
export function dropOldDays(items, chain, today) {
  const oldest = shiftDay(today, -(KEEP_DAYS - 1));
  for (const [k, v] of Object.entries(items))
    if (k.startsWith(`${chain}:`)) for (const day of Object.keys(v.days)) if (day < oldest) delete v.days[day];
}

// After a read: the chain's last block and last complete day. updatedAt: when this chain last
// read new data (only a read that reached the head). ledger.asOf = latest run of any chain.
export function markChain(ledger, chain, { lastBlock, today, updatedAt = null }) {
  ledger.chains[chain] = { ...ledger.chains[chain], lastBlock, asOf: today, ...(updatedAt ? { updatedAt } : {}) };
  ledger.asOf = today;
}

// ── freshness ────────────────────────────────────────────────────────────────
// Numbers are STALE (shown dimmed, with their "As of" day) when either
//   • the chain's last successful update (updatedAt) is over 36 h old — the daily run is
//     scheduled early in the UTC day but GitHub can start it hours late;
//   • or the data's own last day (asOf) ended over 48 h ago — this also covers ledgers with no
//     updatedAt and a chain that keeps reading only part of the way;
//   • or updatedAt is there but damaged (it cannot prove the numbers are current).
// LATE: the flows job fails (red, so GitHub emails) once a chain has not updated for 72 h.
export const STALE_MS = 36 * 3_600_000;
export const DATA_STALE_MS = 48 * 3_600_000;
export const LATE_MS = 72 * 3_600_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const endOfDay = (day) => Date.parse(`${day}T00:00:00Z`) + DAY_MS;

// → { stale, updatedAt (valid ISO or null), ageMs (since the last good update, or the end of
//     the data's last day when updatedAt is unknown; NaN if neither is usable) }
export function freshness(chainInfo, fallbackAsOf, now) {
  const raw = chainInfo?.updatedAt, asOf = chainInfo?.asOf ?? fallbackAsOf;
  const at = typeof raw === "string" ? Date.parse(raw) : NaN;
  const dataEnd = typeof asOf === "string" && DAY.test(asOf) ? endOfDay(asOf) : NaN;
  const damaged = raw != null && !Number.isFinite(at);
  const stale = damaged || (Number.isFinite(at) && now - at > STALE_MS) || (Number.isFinite(dataEnd) && now - dataEnd > DATA_STALE_MS);
  return { stale, updatedAt: Number.isFinite(at) ? raw : null, ageMs: Number.isFinite(at) ? now - at : now - dataEnd };
}

// ── run loop ─────────────────────────────────────────────────────────────────
// One daily run over every chain. Each chain stands alone: a failure on one keeps what it
// read before failing and the other chains still run. onChainDone(ledger) runs after each
// chain (the CLI saves there, so a later chain that hangs cannot lose an earlier chain's work).
// `today` for the ledger = the last COMPLETE UTC day read (the day before the last block's
// day), so "30 days" is 30 whole days and a short read can't claim more.
//
// adapter (what the tool tracks; the core never looks inside it):
//   noun: what the tool calls its tracked contracts, plural (log lines only)
//   prepare({ ledger, chain, now, log }) → { ledger, items, known, add? } — items to read
//     (empty: the chain is skipped with a warning); known = how many the ledger already holds
//   read({ portal, dataset, items, fromBlock, toBlock, onBatch, deadline }) → streamLogs result
//   add(ledger, { chain, events, lastBlock, today, items, backfill, newFrom, updatedAt }) → new ledger (may be async)
//
//   → { ledger, failed: [chain], ownErrors: [chain], reasons, errors, bytes }  (errors: chain → the error itself)
//     failed = every chain that did not finish; ownErrors = those whose error was not the Portal's.
export async function runChains({ ledger, datasets, adapter, portal, now = Date.now(), log = console, onChainDone = async () => {}, readLimitMs = 300 * 60_000 }) {
  const jobStart = Date.now();
  const startOfToday = Date.parse(utcDay(now) + "T00:00:00Z");
  const failed = [], ownErrors = [], reasons = {}, errors = {};
  let bytes = 0;
  // an error from a Portal call is the Portal's (busy, down): the run stays green with a
  // warning. Any other error is ours (a broken ledger state, a bug) and fails the run.
  const fromPortal = async (fn) => { try { return await fn(); } catch (e) { e.fromPortal = true; throw e; } };

  for (const [chain, dataset] of Object.entries(datasets)) {
    const t0 = Date.now();
    try {
      const p = await adapter.prepare({ ledger, chain, now, log });
      ledger = p.ledger;
      const { items, known } = p;
      if (!items.length) { log.warn(`  ⚠ ${chain}: no tracked ${adapter.noun} — check that the snapshot carries ${adapter.noun.replace(/s$/, "")} fields`); continue; }

      const last = ledger.chains?.[chain]?.lastBlock;
      const backfill = !Number.isInteger(last);
      // a ledger with data but no block to continue from would double-count on a new backfill
      if (backfill && known) throw new Error(`flows-ledger.json: ${chain} has ${known} ${adapter.noun} but no lastBlock — refusing to backfill on top`);
      const head = await fromPortal(() => portal.finalizedHead(dataset));
      // first run: from the start of the oldest day the 30-day window keeps
      const fromBlock = backfill ? await fromPortal(() => portal.blockAt(dataset, (startOfToday - KEEP_DAYS * DAY_MS) / 1000)) : last + 1;
      if (fromBlock > head) { log.warn(`  ⚠ ${chain}: no new finalized blocks since ${last} — numbers stay as of ${ledger.chains?.[chain]?.asOf ?? ledger.asOf}`); continue; }

      // An item new to the ledger is read only from fromBlock, which sits inside the day after
      // the chain's last complete day: its first full day is the one after that. (Matters when
      // the job runs twice in a day: the second run starts mid-day.)
      const prevAsOf = ledger.chains?.[chain]?.asOf ?? ledger.asOf;
      const newFrom = !backfill && prevAsOf ? shiftDay(prevAsOf, 2) : null;
      // `complete`: the read reached the head. Only then is it the chain's last successful update;
      // a part-way read keeps its blocks but leaves updatedAt, so repeated failures turn stale.
      const merge = async (r, complete) => {
        if (r.lastBlock < fromBlock || r.lastTimestamp == null) return false;
        const today = shiftDay(utcDay(r.lastTimestamp * 1000), -1);
        // a backfill marks its items from the day it started, so one that stops short shows
        // only the days it read ("partial since …"), never 30 days padded with $0
        const from = backfill ? utcDay(startOfToday - KEEP_DAYS * DAY_MS) : false;
        ledger = await adapter.add(ledger, { chain, events: r.events, lastBlock: r.lastBlock, today, items, backfill: from, newFrom, updatedAt: complete ? new Date(now).toISOString() : null });
        return true;
      };
      // a progress line every 25 batches, so a long first backfill shows where it is
      let batches = 0;
      const onBatch = (pr) => {
        if (++batches % 25) return;
        // our own progress line must never fail a read (it would be blamed on the Portal)
        try {
          const done = Math.round((100 * (pr.lastBlock - fromBlock + 1)) / (head - fromBlock + 1));
          log.log(`    ${chain}: ${done}% · block ${pr.lastBlock} · ${pr.events} events · ${(pr.bytes / 1e6).toFixed(1)} MB · ${Math.round((Date.now() - t0) / 60_000)} min`);
        } catch (e) { log.error(`  ${chain}: progress line failed — ${e.message}`); }
      };
      let r;
      try { r = await fromPortal(() => adapter.read({ portal, dataset, items, fromBlock, toBlock: head, onBatch, deadline: jobStart + readLimitMs })); }
      catch (e) {
        // keep what was read before the failure, so the next run continues from there
        if (e.partial && await merge(e.partial, false)) {
          bytes += e.partial.bytes;
          log.error(`  ${chain}: failed at block ${e.partial.lastBlock + 1}; kept blocks ${fromBlock}–${e.partial.lastBlock} (${e.partial.events.length} events)`);
        }
        throw e;
      }
      if (!(await merge(r, r.lastBlock >= head))) log.warn(`  ⚠ ${chain}: the Portal returned no blocks from ${fromBlock} (head ${head}) — nothing read this run`);
      bytes += r.bytes;
      if (r.lastBlock < head) log.warn(`  ⚠ ${chain}: Portal stopped at block ${r.lastBlock}, before the finalized head ${head}`);
      log.log(`  ${chain}: ${items.length} ${adapter.noun} · blocks ${fromBlock}–${r.lastBlock}${backfill ? " (first run: 30-day backfill)" : ""} · ${r.events.length} events · ${(r.bytes / 1e6).toFixed(2)} MB · ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (e) {
      failed.push(chain);
      if (!e.fromPortal) ownErrors.push(chain);
      reasons[chain] = e.message;
      errors[chain] = e;
      log.error(`  ${chain}: FAILED — ${e.message}`);
      // a chain that has never read anything has no date to age from: record when it was
      // first tried, so the 72 h "late" rule can still turn the run red
      if (!ledger.chains?.[chain]) ledger = { ...ledger, chains: { ...ledger.chains, [chain]: { firstTriedAt: new Date(now).toISOString() } } };
    }
    await onChainDone(ledger);
  }
  return { ledger, failed, ownErrors, reasons, errors, bytes };
}
