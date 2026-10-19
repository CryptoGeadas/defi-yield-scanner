// ─────────────────────────────────────────────────────────────────────────────
// DENYLIST REVIEW — pure. Every hand-made denylist entry says why it was added, when,
// and a review-by date (30 days after it was added or last reviewed). The build lists
// entries past their review-by date as warnings; it never un-hides a pool by itself —
// a person renews the date or removes the entry.
//
//   checkDenylist(raw, now) → { denylist, expired, undated }
//     raw lists hold plain strings (old form) or { id | key | address, name?, reason, added, reviewBy };
//     a dated entry with a missing reason or a bad date throws, so it fails at load.
//   denylistLog({ expired, undated }, env) → lines for the build log (+ Actions warnings in CI)
// ─────────────────────────────────────────────────────────────────────────────
import { actionsWarnings } from "./notices.mjs";

export const REVIEW_DAYS = 30;
const LISTS = { poolIds: "id", keys: "key", morphoVaults: "address" };

const realDate = (d) => {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return NaN;
  const ms = Date.parse(d);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d ? ms : NaN;
};

export function checkDenylist(raw = {}, now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const unknown = Object.keys(raw).filter((k) => k !== "_comment" && !(k in LISTS));
  if (unknown.length) throw new Error(`denylist.json: unknown list ${unknown.map((k) => JSON.stringify(k)).join(", ")} (use ${Object.keys(LISTS).join(", ")})`);
  const latestReview = new Date(now + REVIEW_DAYS * 86400e3).toISOString().slice(0, 10);
  const denylist = { ...raw }, expired = [], undated = [];
  for (const [list, field] of Object.entries(LISTS)) {
    const entries = raw[list] ?? [];
    if (!Array.isArray(entries)) throw new Error(`denylist.json: "${list}" must be an array`);
    for (const [i, e] of entries.entries()) {
      const at = `denylist.json: ${list}[${i}]`;
      if (typeof e === "string") {
        if (!e.trim()) throw new Error(`${at} is blank`);
        undated.push({ list, value: e });
        continue;
      }
      const value = e?.[field];
      if (typeof value !== "string" || !value.trim()) throw new Error(`${at} needs a "${field}"`);
      if (typeof e.reason !== "string" || !e.reason.trim()) throw new Error(`${at} (${value}) needs a reason`);
      for (const k of ["added", "reviewBy"])
        if (!Number.isFinite(realDate(e[k]))) throw new Error(`${at} (${value}): ${k} = ${JSON.stringify(e[k])} is not a date (use YYYY-MM-DD)`);
      if (e.added > today) throw new Error(`${at} (${value}): added "${e.added}" is in the future`);
      if (e.reviewBy < e.added) throw new Error(`${at} (${value}): reviewBy "${e.reviewBy}" is before added "${e.added}"`);
      if (e.reviewBy > latestReview) throw new Error(`${at} (${value}): reviewBy "${e.reviewBy}" is more than ${REVIEW_DAYS} days out (latest ${latestReview})`);
      if (e.reviewBy < today) expired.push({ list, value, name: e.name, reason: e.reason, reviewBy: e.reviewBy });
    }
    denylist[list] = entries.map((e) => (typeof e === "string" ? e : e[field]));
  }
  return { denylist, expired, undated };
}

export function denylistLog({ expired, undated }, env = {}) {
  const lines = [`  denylist: ${undated.length} undated · ${expired.length} past review-by`];
  const label = (e) => `${e.list} ${e.value}${e.name ? ` (${e.name})` : ""}`;
  const notes = [
    ...expired.map((e) => ({ id: "denylist-review", text: `Denylist entry ${label(e)} was due for review on ${e.reviewBy} — renew the date or remove it. Reason: ${e.reason}` })),
    ...undated.map((e) => ({ id: "denylist-review", text: `Denylist entry ${label(e)} has no reason or review-by date — add them (review-by = ${REVIEW_DAYS} days out)` })),
  ];
  lines.push(...notes.map((n) => `  ⚠ ${n.text}`));
  return env.GITHUB_ACTIONS === "true" ? [...lines, ...actionsWarnings(notes)] : lines;
}
