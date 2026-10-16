// ─────────────────────────────────────────────────────────────────────────────
// STICKY LEVELS — pure. Stops pools jumping between windows from one refresh to the
// next: bad news shows fast, good news has to hold.
//
//   applySticky(state, rows, now) → { shown: Map(id → level), state, invalid }
//
// rows   [{ id, level (computed this run, 1–3), tier (coin Tier) }]
// state  { [id]: { shown, tier, down, upSince, lastDown, lastSeen } } from the previous
//        run (site/data/levels-state.json, written by the CI refresh); {} on the first run.
//
// Rules:
//   - a pool new to the state starts at its computed level;
//   - down: after DOWN_RUNS runs in a row computed worse than shown (~12h at 6-hourly
//     refreshes), it moves to the latest computed level. A worse run only counts if it is
//     MIN_GAP_MS after the last counted one, so a re-run cannot speed this up;
//   - up: after UP_MS of runs in a row computed better than shown (7 days, from the first
//     better run), it moves to the latest computed level;
//   - a coin Tier change moves it at once (a denylisted pool leaves the feed at once);
//   - a pool missing from a run keeps its state for UP_MS (a pool that drops out for one
//     run must not skip the 7-day rule), then drops out.
// `invalid` counts state entries that could not be trusted (they start fresh); the build
// warns about them. Moves are not announced on the page; the methodology explains the rule.
// ─────────────────────────────────────────────────────────────────────────────

export const DOWN_RUNS = 2;
export const UP_MS = 7 * 24 * 3_600_000;
export const MIN_GAP_MS = 3 * 3_600_000;

const finiteOrNull = (v) => v == null || Number.isFinite(v);
const valid = (p) => p && [1, 2, 3].includes(p.shown) && Number.isInteger(p.down) && p.down >= 0 &&
  finiteOrNull(p.upSince) && finiteOrNull(p.lastDown) && finiteOrNull(p.lastSeen);

export function applySticky(state = {}, rows, now) {
  const shown = new Map();
  const next = {};
  let invalid = 0;
  for (const { id, level, tier } of rows) {
    if (![1, 2, 3].includes(level)) throw new Error(`sticky: computed level for ${id} must be 1, 2 or 3, got ${JSON.stringify(level)}`);
    const raw = state[id];
    if (raw != null && !valid(raw)) invalid++;
    const prev = valid(raw) ? raw : null;
    const fresh = { shown: level, tier, down: 0, upSince: null, lastDown: null };
    let s;
    if (!prev || prev.tier !== tier) {
      s = fresh;                                                    // new pool or coin Tier change
    } else if (level > prev.shown) {
      const counts = prev.lastDown == null || now - prev.lastDown >= MIN_GAP_MS; // worse: count runs
      const down = counts ? prev.down + 1 : prev.down;
      const lastDown = counts ? now : prev.lastDown;
      s = down >= DOWN_RUNS ? fresh : { ...prev, down, lastDown, upSince: null };
    } else if (level < prev.shown) {
      const upSince = prev.upSince ?? now;                          // better: time the streak
      s = now - upSince >= UP_MS ? fresh : { ...prev, down: 0, lastDown: null, upSince };
    } else {
      s = { ...prev, down: 0, upSince: null, lastDown: null };      // same: streaks reset
    }
    next[id] = { ...s, lastSeen: now };
    shown.set(id, s.shown);
  }
  // keep recently seen pools that are missing from this run, so a one-run gap is no reset
  for (const [id, p] of Object.entries(state)) {
    if (!(id in next) && valid(p) && Number.isFinite(p.lastSeen) && now - p.lastSeen < UP_MS) next[id] = p;
  }
  return { shown, state: next, invalid };
}
