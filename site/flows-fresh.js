// Flows freshness on the page: the same rule as the build (build/flows.mjs freshness), run again
// with the viewer's clock, so numbers never look current just because the snapshot stopped
// publishing. Stale when the build said so, the update stamp is damaged, the last update is over
// 36 h old, or the data's own day ended over 48 h ago.
const HOUR = 3_600_000;
export function flowsStale(f, now = Date.now()) {
  if (f.stale === true) return true;
  const at = typeof f.updatedAt === "string" ? Date.parse(f.updatedAt) : NaN;
  const dataEnd = typeof f.asOf === "string" ? Date.parse(`${f.asOf}T00:00:00Z`) + 24 * HOUR : NaN;
  const damaged = f.updatedAt != null && !Number.isFinite(at);
  return damaged || (Number.isFinite(at) && now - at > 36 * HOUR) || (Number.isFinite(dataEnd) && now - dataEnd > 48 * HOUR);
}

// The day of the last update, for "Not updated since …": null when the stamp is missing or
// damaged, so the card never prints "Invalid Date" (#67).
export function updatedDay(f) {
  return typeof f.updatedAt === "string" && Number.isFinite(Date.parse(f.updatedAt)) ? f.updatedAt.slice(0, 10) : null;
}
