// ─────────────────────────────────────────────────────────────────────────────
// NET — the one way the build calls an outside source (#63). Every call has a timeout, and a
// call that hangs, cannot connect, is rate-limited (429) or fails on the server side (5xx) is
// tried again after a wait. Retries are written to the log.
//
//   netFetch(url, init?, { timeoutMs?, tries?, fetchImpl?, sleep?, log? }) → Response
//     Returns the last Response, also when it is not ok (the caller decides what a 404 or a
//     final 500 means). Throws only when no answer came at all after every try.
//
// The SQD Portal client (portal.mjs) is not routed through here: it has its own retry,
// deadline and partial-read rules for long streamed reads.
// ─────────────────────────────────────────────────────────────────────────────
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_WAIT_MS = 30_000;
const RETRY_WAIT_MS = 5_000; // × the attempt number

const hostOf = (url) => { try { return new URL(url).host; } catch { return "source"; } };

export async function netFetch(url, init = {}, { timeoutMs = 60_000, tries = 3, fetchImpl = fetch, sleep = realSleep, log = console } = {}) {
  const host = hostOf(url); // never the full URL: a query can carry a key
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= tries;
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const why = e?.name === "TimeoutError" ? `no answer in ${Math.round(timeoutMs / 1000)}s` : e?.cause?.code || e?.message || "network error";
      if (last) throw new Error(`${host} unreachable after ${tries} ${tries === 1 ? "try" : "tries"} (${why})`);
      log.warn(`  net: ${host} ${why}, trying again (${attempt}/${tries})`);
      await sleep(RETRY_WAIT_MS * attempt);
      continue;
    }
    const busy = res.status === 429 || res.status >= 500;
    if (!busy || last) return res;
    const wait = res.status === 429 ? RATE_LIMIT_WAIT_MS : RETRY_WAIT_MS * attempt;
    log.warn(`  net: HTTP ${res.status} from ${host}${res.status === 429 ? " (rate limited)" : ""}, trying again in ${wait / 1000}s (${attempt}/${tries})`);
    await sleep(wait);
  }
}
