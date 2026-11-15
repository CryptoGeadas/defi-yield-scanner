// ─────────────────────────────────────────────────────────────────────────────
// NET — the one way the build calls an outside source (#63). Every call has a timeout, and a
// call that hangs, cannot connect, is rate-limited (429) or fails on the server side (5xx) is
// tried again after a wait. Retries are written to the log.
//
//   netFetch(url, init?, { timeoutMs?, bodyTimeoutMs?, tries?, retryWaitMs?, rateLimitWaitMs?, fetchImpl?, sleep?, log? }) → Response
//     Returns the last Response, also when it is not ok (the caller decides what a 404 or a
//     final 500 means). Throws only when no answer came at all after every try.
//     timeoutMs is the wait for the answer to START (its status and headers). The download of
//     the body then gets its own, longer limit (bodyTimeoutMs): a large feed on a slow line must
//     not be cut off by the short limit, where no retry could save it.
//     retryWaitMs × the attempt number is the wait after a hang or a 5xx.
//
// The SQD Portal client (portal.mjs) is not routed through here: it has its own retry,
// deadline and partial-read rules for long streamed reads.
// ─────────────────────────────────────────────────────────────────────────────
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeoutError = () => new DOMException("The operation timed out", "TimeoutError");

const hostOf = (url) => { try { return new URL(url).host; } catch { return "source"; } };

export async function netFetch(url, init = {}, { timeoutMs = 60_000, bodyTimeoutMs = 10 * 60_000, tries = 3, retryWaitMs = 5_000, rateLimitWaitMs = 30_000, fetchImpl = fetch, sleep = realSleep, log = console } = {}) {
  const host = hostOf(url); // never the full URL: a query can carry a key
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= tries;
    let res;
    // our own timer (not AbortSignal.timeout): it is cleared once the answer starts, and it
    // keeps Node running while it waits
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(timeoutError()), timeoutMs);
    try {
      res = await fetchImpl(url, { ...init, signal: ctl.signal });
    } catch (e) {
      const why = e?.name === "TimeoutError" ? `no answer in ${Math.round(timeoutMs / 1000)}s` : e?.cause?.code || e?.message || "network error";
      if (last) throw new Error(`${host} unreachable after ${tries} ${tries === 1 ? "try" : "tries"} (${why})`);
      log.warn(`  net: ${host} ${why}, trying again (${attempt}/${tries})`);
      await sleep(retryWaitMs * attempt);
      continue;
    } finally {
      clearTimeout(timer);
    }
    const busy = res.status === 429 || res.status >= 500;
    if (!busy || last) {
      // the download's own limit; it must not hold the process open once the caller is done
      setTimeout(() => ctl.abort(timeoutError()), bodyTimeoutMs).unref?.();
      return res;
    }
    // release the answer we will not read, so its connection can be used again
    try { await res.body?.cancel(); } catch { /* nothing to release */ }
    const wait = res.status === 429 ? rateLimitWaitMs : retryWaitMs * attempt;
    log.warn(`  net: HTTP ${res.status} from ${host}${res.status === 429 ? " (rate limited)" : ""}, trying again in ${wait / 1000}s (${attempt}/${tries})`);
    await sleep(wait);
  }
}
