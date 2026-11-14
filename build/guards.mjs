// ─────────────────────────────────────────────────────────────────────────────
// RELEASE GUARDS (#66) — the checks that decide whether a build may overwrite the published
// snapshot, as pure functions so tests reach them. build.mjs calls each one and acts on the
// answer; nothing here reads files, the network or the clock.
//
// Each guard → { refuse?: message } (throw: keep the last good snapshot), { warn?: message }
// (log it, publish anyway) and/or { log?: message } (a plain status line).
// ─────────────────────────────────────────────────────────────────────────────

// Lending TVL = total deposits needs the lendBorrow feed. A short map (degraded upstream, renamed
// field) would quietly turn every lending row's TVL into net-of-loans. ~2,370 pools today.
export const MIN_LENDBORROW = 1000;
export function lendBorrowGuard(size) {
  const n = size ?? 0;
  return n < MIN_LENDBORROW ? { refuse: `lendBorrow feed has ${n} pools (< ${MIN_LENDBORROW}) — lending TVL would be net of loans; refusing to overwrite` } : {};
}

// Sanity floor: a healthy build keeps 250+ pools; fewer means the feed came back partial.
export const MIN_KEPT = 100;
export function keptGuard(kept) {
  return kept < MIN_KEPT ? { refuse: `sanity floor: only ${kept} pools kept (< ${MIN_KEPT}); feed likely partial — refusing to overwrite` } : {};
}

// Age or yield data health over the shown rows: if a source breaks, every pool silently drops to
// "unknown" (Level 2). Over 20% unknown is said loudly; the build still publishes.
export const UNKNOWN_SHARE = 0.2;
const HINT = { age: "check DefiLlama count / Kamino creationTimestamp", yield: "check DefiLlama apyMean30d / Kamino apy30d" };
export function unknownGuard(factor, shown) {
  const unknown = shown.filter((x) => x.factors?.find((f) => f.name === factor)?.unknown).length;
  const msg = `${factor} unknown for ${unknown}/${shown.length} shown pools`;
  return unknown > shown.length * UNKNOWN_SHARE ? { warn: `${msg} — ${HINT[factor]}` } : { log: msg };
}

// Sticky levels: a few invalid saved entries start fresh; over 10% means the state file broke,
// and resetting that many pools at once is refused.
export const STICKY_INVALID_SHARE = 0.1;
export function stickyGuard(invalid, shownCount) {
  if (!invalid) return {};
  const share = invalid / Math.max(1, shownCount);
  if (share > STICKY_INVALID_SHARE) return { refuse: `levels-state.json: ${invalid} entries invalid (${Math.round(share * 100)}%) — refusing to reset that many pools` };
  return { warn: `levels-state.json: ${invalid} invalid entries started fresh` };
}

// LI.FI lists ~500 vaults today; far fewer with a key set means an expired key or a broken API.
export const MIN_EARN = 50;
export function earnGuard(count, hasKey) {
  return hasKey && count < MIN_EARN ? { warn: `deposits: LI.FI listed only ${count} vaults (< ${MIN_EARN}) — check the LIFI_API_KEY secret; rows lose their Deposit button` } : {};
}

// Feature switches: an env value ("1" on, "0" off) overrides the committed default for a local
// check only. A switch turned on locally must never be committed, so it says so.
export function featureSwitch(name, envValue, committedDefault, what) {
  if (envValue == null || envValue === "") return { on: committedDefault };
  if (!["0", "1"].includes(envValue)) return { on: false, warn: `${name}=${envValue} not recognised (use 1 or 0) — switch stays off` };
  const on = envValue === "1";
  return on && !committedDefault ? { on, warn: `${name}=1: ${what} on — local check only, do NOT commit site/data/latest.json from this build` } : { on };
}
