// ─────────────────────────────────────────────────────────────────────────────
// REVIEW SHEET — a table of every pool's risk level, for the owner's review before
// go-live and after any change to cut lines or protocol levels. Not published.
//
//   node build/review-sheet.mjs   (after a build)  →  review/levels-review.md
//
// Reads site/data/latest.json (rows carry level, levelDriver and factors). Each row
// lists the level, the deciding factor, every factor's value, and flags any value
// within 10% of a cut line ("near"), where a small change would move the pool.
// nearCuts and reviewSheet are pure.
// ─────────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkCuts } from "./risk.mjs";

const NEAR = 0.1;
const money = (n) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}b` : `$${(n / 1e6).toFixed(1)}m`);
const LABEL = {
  size: (c) => money(c),
  age: (c) => `${c} days`,
  yield: (c) => `${c}×`,
  stability: (c) => `+${Math.round(c * 100)}%`,
};
// stability's value is a signed % (e.g. 57 for +57%); its cut lines are ratios (0.6)
const comparable = (f) => (f.name === "stability" ? f.value / 100 : f.value);

export function nearCuts(f, cuts) {
  const c = cuts?.[f.name];
  if (!c || f.unknown || !Number.isFinite(f.value) || !LABEL[f.name]) return [];
  const v = comparable(f);
  const near = [c.level1, c.level2].filter((cut) => Math.abs(v - cut) <= Math.abs(cut) * NEAR + 1e-9).map((cut) => `${f.name} near ${LABEL[f.name](cut)}`);
  // the +minPp floor only matters when the % alone would count
  if (f.name === "stability" && c.minPp > 0 && (f.belowMinPp || v >= c.level1) && Number.isFinite(f.risePp) && Math.abs(f.risePp - c.minPp) <= c.minPp * NEAR + 1e-9)
    near.push(`stability near +${c.minPp} pp`);
  return near;
}

const NUMERIC = new Set(["size", "age", "yield", "stability"]);
const text = (f) => {
  if (f.unknown || (NUMERIC.has(f.name) && !Number.isFinite(f.value))) return "unknown";
  if (f.name === "size") return money(f.value);
  if (f.name === "age") return `${f.value}d`;
  if (f.name === "yield") return `${f.value}×`;
  if (f.name === "stability") return `${f.value > 0 ? "+" : ""}${f.value}%`;
  return String(f.value ?? "");
};
const cell = (s) => String(s ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");

export function reviewSheet(data) {
  // Bad or changed data must fail loudly, not give a sheet that looks valid.
  if (![1, 2, 3].every((w) => Array.isArray(data?.windows?.[w]))) throw new Error("review sheet: latest.json has no windows 1/2/3 — run the build first");
  const cuts = checkCuts(data.config?.riskCuts ?? {});
  for (const n of ["size", "age", "yield", "stability"]) if (!cuts[n]) throw new Error(`review sheet: no cut lines for ${n} in latest.json`);
  const rows = [1, 2, 3].flatMap((w) => data.windows[w]);
  for (const r of rows)
    if (![1, 2, 3].includes(r.level) || !Number.isFinite(r.tvlUsd)) throw new Error(`review sheet: pool ${r.poolId} has level ${r.level} / TVL ${r.tvlUsd}`);
  rows.sort((a, b) => a.level - b.level || b.tvlUsd - a.tvlUsd);
  const order = ["coin", "size", "age", "yield", "stability", "protocol"];
  const counts = [1, 2, 3].map((l) => rows.filter((r) => r.level === l).length);
  const out = [
    `# Risk levels — review sheet`,
    ``,
    `Data ${data.generatedAt} · Base rate ${data.baseRate}% · Levels 1/2/3: ${counts.join(" / ")} · ${rows.length} pools`,
    ``,
    `Cut lines: size L1 ≥ ${money(cuts.size?.level1)}, L2 ≥ ${money(cuts.size?.level2)} · age L1 ≥ ${cuts.age?.level1}d, L2 ≥ ${cuts.age?.level2}d · yield L1 ≤ ${cuts.yield?.level1}×, L2 ≤ ${cuts.yield?.level2}× · stability L1 ≤ +${Math.round((cuts.stability?.level1 ?? 0) * 100)}%, L2 ≤ +${Math.round((cuts.stability?.level2 ?? 0) * 100)}%${cuts.stability?.minPp ? `, rises under +${cuts.stability.minPp} pp never count` : ""}`,
    ``,
    `"Near" = within ${NEAR * 100}% of a cut line. Factor cells show value (Level); values are rounded, levels use the unrounded value. "sticky" = the shown level is held by the sticky rule.`,
    ``,
    `| Level | Pool | Chain | Set by | ${order.map((n) => n[0].toUpperCase() + n.slice(1)).join(" | ")} | Near a cut line |`,
    `|---|---|---|---|${order.map(() => "---").join("|")}|---|`,
  ];
  for (const r of rows) {
    const fs = Object.fromEntries((r.factors ?? []).map((f) => [f.name, f]));
    const near = (r.factors ?? []).flatMap((f) => nearCuts(f, cuts));
    const held = r.levelComputed != null && r.levelComputed !== r.level;
    const lvl = held ? `${r.level} (computed ${r.levelComputed})` : `${r.level}`;
    const setBy = held ? `sticky (computed: ${(r.levelComputed > 1 && r.levelDriver) || "—"})` : r.level > 1 ? r.levelDriver : "";
    out.push(
      `| ${lvl} | ${cell(`${r.name} ${r.symbol}`)}${r.access === "permissioned" ? " 🔒" : ""} | ${cell(r.chain)} | ${cell(setBy)} | ${order
        .map((n) => (fs[n] ? `${cell(text(fs[n]))} (${fs[n].level ?? "?"})` : "—"))
        .join(" | ")} | ${near.join(", ")} |`
    );
  }
  return out.join("\n") + "\n";
}

// CLI: node build/review-sheet.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const HERE = dirname(fileURLToPath(import.meta.url));
  let data;
  try { data = JSON.parse(await readFile(join(HERE, "..", "site", "data", "latest.json"), "utf8")); }
  catch (e) { console.error(`run the build first: site/data/latest.json not found or invalid (${e.message})`); process.exit(1); }
  const dir = join(HERE, "..", "review");
  await mkdir(dir, { recursive: true });
  const file = join(dir, "levels-review.md");
  await writeFile(file, reviewSheet(data));
  console.log(`wrote ${file}`);
}
