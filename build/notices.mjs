// ─────────────────────────────────────────────────────────────────────────────
// NOTICES — pure. Data the page must admit is missing at this refresh, so readers can
// tell "no pools" from "no data". Written to latest.json as `notices`; the site shows
// each one as a line above the windows, and the build prints a GitHub Actions warning.
//
//   venueNotices(venues) → [{ id, text }]
//   actionsWarnings(notices) → ["::warning title=id::text"]
//   noticeLog(notices, env) → lines for the build log (+ the Actions warnings in CI)
//
// Kamino: only a complete failure (no vaults at all) counts. Partial failures (some
// metrics or reserves missing) keep the vault and are logged by kamino-vaults.mjs.
// Euler: when no chain's labels could be read, every Euler row is hidden (fail closed);
// a single failed chain is only logged by euler-vaults.mjs.
// ─────────────────────────────────────────────────────────────────────────────

export function venueNotices(venues) {
  const notices = [];
  if (!venues.kamino?.length) notices.push({ id: "kamino-unavailable", text: "Kamino data unavailable at this refresh." });
  if (venues.euler instanceof Map && venues.euler.size && ![...venues.euler.values()].some(Boolean)) notices.push({ id: "euler-unavailable", text: "Euler data unavailable at this refresh — Euler pools hidden." });
  return notices;
}

// GitHub workflow commands: data escapes %, CR and LF; property values also : and ,.
const escapeData = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escapeProperty = (s) => escapeData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");

export function actionsWarnings(notices) {
  return notices.map((n) => `::warning title=${escapeProperty(n.id)}::${escapeData(n.text)}`);
}

export function noticeLog(notices, env = {}) {
  const lines = notices.map((n) => `  ⚠ notice: ${n.text}`);
  return env.GITHUB_ACTIONS === "true" ? [...lines, ...actionsWarnings(notices)] : lines;
}
