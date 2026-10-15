// ─────────────────────────────────────────────────────────────────────────────
// POOL AGE — pure. How long a pool has been live, for the Age factor.
//
//   poolAge(pool, since, now) → { days, source } or null (unknown)
//
// Sources, first match wins:
//   1. since     a Since override for this pool (build/since.json "pools", by DefiLlama
//                pool id). A start date is a fact, so it never expires.
//   2. venue     the venue's own creation date on the pool (`startedAt`, epoch ms),
//                e.g. a Kamino vault's creationTimestamp. Ignored if outside 2018–now.
//   3. since     a Since override for the whole protocol ("protocols"). It comes after
//                the pool's own venue date, so a pool launched later is not made older.
//   4. defillama DefiLlama's `count` — days it has tracked the pool. It can only
//                undercount (a pool listed late looks young); never overcounts.
// since.json dates are checked once at load (checkSince); poolAge trusts them.
// ─────────────────────────────────────────────────────────────────────────────

const DAY = 86_400_000;
const EARLIEST = Date.parse("2018-01-01");
const daysSince = (ms, now) => Math.floor((now - ms) / DAY);
const sinceDays = (date, now) => ({ days: daysSince(Date.parse(date), now), source: "since" });

export function poolAge(pool, since = {}, now = Date.now()) {
  const own = since.pools?.[pool.pool];
  if (own != null) return sinceDays(own, now);
  if (Number.isFinite(pool.startedAt) && pool.startedAt >= EARLIEST && pool.startedAt <= now)
    return { days: daysSince(pool.startedAt, now), source: "venue" };
  const proto = since.protocols?.[pool.project];
  if (proto != null) return sinceDays(proto, now);
  if (Number.isFinite(pool.count) && pool.count > 0) return { days: pool.count, source: "defillama" };
  return null;
}

// A real calendar date in YYYY-MM-DD form (no "2024-02-30", no "2024", no local-time text).
const realDate = (d) => {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return NaN;
  const ms = Date.parse(d);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d ? ms : NaN;
};

// Validate since.json once: every date must be a real YYYY-MM-DD and not in the future.
// A bad entry fails the build at load, not weeks later when a matching pool appears.
export function checkSince(since, now = Date.now()) {
  for (const group of ["pools", "protocols"]) {
    const entries = since?.[group] ?? {};
    if (typeof entries !== "object" || Array.isArray(entries)) throw new Error(`since.json: "${group}" must be an object`);
    for (const [key, date] of Object.entries(entries)) {
      const ms = realDate(date);
      if (!Number.isFinite(ms)) throw new Error(`since.json: ${group}.${key} = ${JSON.stringify(date)} is not a date (use YYYY-MM-DD)`);
      if (ms > now) throw new Error(`since.json: ${group}.${key} = "${date}" is in the future`);
    }
  }
  return since;
}
