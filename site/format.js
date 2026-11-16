// Shared format helpers (#62): the HTML escape and the money, percent and date formatters.
// This file is shared between tools: the Scanner holds the source, other tools keep a byte-for-byte
// copy (docs/adr/0001). Edit it here, copy it over, and record the new hash.
// Money uses upper-case letters on every tool ($1.23B, $50.0M, $5K). A missing or non-number
// figure reads "unknown", never $NaN or $0.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const num = (n) => (typeof n === "number" && Number.isFinite(n) ? n : null);

// Large money: $1.23B, $50.0M, $5K.
export const fmtTvl = (n) => {
  n = num(n);
  if (n == null) return "unknown";
  const a = Math.abs(n), s = n < 0 ? "−" : "";
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(1)}M` : `${s}$${Math.round(a / 1e3)}K`;
};
// Any money amount, without sign: under $1,000 in whole dollars.
export const fmtUsd = (n) => {
  n = num(n);
  if (n == null) return "unknown";
  return Math.abs(n) < 1e3 ? `$${Math.round(Math.abs(n))}` : fmtTvl(Math.abs(n));
};
// A net flow: + for in, − for out.
export const fmtNet = (n) => (num(n) == null ? "unknown" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtUsd(n)}`);
export const fmtPct = (n) => (num(n) == null ? "—" : `${n.toFixed(2)}%`);
// "2026-11-16" → "16 Nov"
export const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
