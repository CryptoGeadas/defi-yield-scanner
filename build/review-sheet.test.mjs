// Tests for the review sheet, through nearCuts(factor, cuts) and reviewSheet(data).
// Run: node --test build/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { nearCuts, reviewSheet } from "./review-sheet.mjs";

const cuts = { size: { level1: 50e6, level2: 5e6 }, age: { level1: 180, level2: 30 }, yield: { level1: 1.5, level2: 2.5 }, stability: { level1: 0.3, level2: 0.6 } };

test("near-cut flag: within 10% of a cut line, on either side", () => {
  assert.deepEqual(nearCuts({ name: "size", value: 46e6 }, cuts), ["size near $50.0m"]);
  assert.deepEqual(nearCuts({ name: "size", value: 54e6 }, cuts), ["size near $50.0m"]);
  assert.deepEqual(nearCuts({ name: "size", value: 44e6 }, cuts), []);
  assert.deepEqual(nearCuts({ name: "age", value: 28 }, cuts), ["age near 30 days"]);
  assert.deepEqual(nearCuts({ name: "yield", value: 1.4 }, cuts), ["yield near 1.5×"]);
  assert.deepEqual(nearCuts({ name: "stability", value: 57 }, cuts), ["stability near +60%"], "stability value is a signed %");
  assert.deepEqual(nearCuts({ name: "age", value: null, unknown: true }, cuts), []);
  assert.deepEqual(nearCuts({ name: "coin", value: "USDC" }, cuts), []);
});

test("the sheet lists every pool, sorted by level then size, with driver, factors and near-cut flags", () => {
  const f = (o) => [
    { name: "coin", value: "USDC", level: 1 }, { name: "size", value: o.tvl, level: o.sl }, { name: "age", value: 400, level: 1 },
    { name: "yield", value: 1, level: 1 }, { name: "stability", value: 0, level: 1 }, { name: "protocol", value: "aave-v3", level: 1 },
  ];
  const row = (id, level, tvl, sl) => ({ poolId: id, name: "Aave V3", symbol: "USDC", chain: "Ethereum", level, levelComputed: level, levelDriver: sl > 1 ? "size" : "coin", tvlUsd: tvl, factors: f({ tvl, sl }) });
  const data = { generatedAt: "2026-10-16T00:00:00Z", baseRate: 4.1, config: { riskCuts: cuts }, windows: { 1: [row("a", 1, 900e6, 1), row("b", 1, 52e6, 1)], 2: [row("c", 2, 9e6, 2)], 3: [] } };
  const md = reviewSheet(data);
  const lines = md.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Level") && !l.startsWith("|---"));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^\| 1 \| Aave V3 USDC .*\$900\.0m/);
  assert.match(lines[1], /size near \$50\.0m/);
  assert.match(lines[2], /^\| 2 \|.*\| size \|/);
  assert.match(md, /Base rate 4\.1%/);
});

test("near-cut edges on both sides; falls never flagged", () => {
  for (const [v, want] of [[27, 1], [33, 1], [54, 1], [66, 1], [-30, 0], [26, 0]])
    assert.equal(nearCuts({ name: "stability", value: v }, cuts).length, want, String(v));
  for (const v of [1.35, 1.65]) assert.equal(nearCuts({ name: "yield", value: v }, cuts).length, 1, String(v));
});

test("sticky rows, escaping, lock and missing factors; bad data throws", () => {
  const base = { poolId: "s", name: "Odd | Pool", symbol: "USD\nC", chain: "Base", access: "permissioned", level: 2, levelComputed: 1, levelDriver: "coin", tvlUsd: 9e6,
    factors: [{ name: "coin", value: "USDC", level: 1 }, { name: "size", value: 9e6, level: 2 }] };
  const data = { generatedAt: "t", baseRate: 4, config: { riskCuts: cuts }, windows: { 1: [], 2: [base], 3: [] } };
  const line = reviewSheet(data).split("\n").find((l) => l.startsWith("| 2"));
  assert.match(line, /^\| 2 \(computed 1\) \| Odd \\\| Pool USD C 🔒 \| Base \| sticky \(computed: —\) \|/);
  assert.match(line, /\| — \|/, "a missing factor shows —");
  assert.throws(() => reviewSheet({ windows: {} }), /no windows/);
  assert.throws(() => reviewSheet({ ...data, config: {} }), /no cut lines/);
  assert.throws(() => reviewSheet({ ...data, windows: { 1: [{ ...base, level: undefined }], 2: [], 3: [] } }), /has level/);
});

test("near-cut: a rise near the +1 pp minimum is flagged when the % alone would count", () => {
  const c = { ...cuts, stability: { ...cuts.stability, minPp: 1 } };
  assert.deepEqual(nearCuts({ name: "stability", value: 100, risePp: 0.95 }, c), ["stability near +1 pp"]);
  assert.deepEqual(nearCuts({ name: "stability", value: 100, risePp: 1.08 }, c), ["stability near +1 pp"]);
  assert.deepEqual(nearCuts({ name: "stability", value: 100, risePp: 0.09 }, c), []);
  assert.deepEqual(nearCuts({ name: "stability", value: 10, risePp: 1 }, c), [], "a +10% rise is Level 1 anyway");
  assert.deepEqual(nearCuts({ name: "stability", value: 100, risePp: 1 }, cuts), [], "no minPp → no flag");
});

test("the sheet header states the +1 pp minimum only when it is set", () => {
  const data = (stab) => ({ generatedAt: "t", baseRate: 4, config: { riskCuts: { ...cuts, stability: stab } }, windows: { 1: [], 2: [], 3: [] } });
  assert.match(reviewSheet(data({ ...cuts.stability, minPp: 1 })), /rises under \+1 pp never count/);
  assert.doesNotMatch(reviewSheet(data(cuts.stability)), /never count/);
});

test("near +1 pp: inclusive band edges, coexists with a % flag, never on falls; belowMinPp always eligible", () => {
  const c = { ...cuts, stability: { ...cuts.stability, minPp: 1 } };
  for (const r of [0.9, 1.1]) assert.deepEqual(nearCuts({ name: "stability", value: 100, risePp: r }, c), ["stability near +1 pp"], String(r));
  for (const r of [0.89, 1.11]) assert.deepEqual(nearCuts({ name: "stability", value: 100, risePp: r }, c), [], String(r));
  assert.deepEqual(nearCuts({ name: "stability", value: 57, risePp: 1.05 }, c), ["stability near +60%", "stability near +1 pp"]);
  assert.deepEqual(nearCuts({ name: "stability", value: -50, risePp: -1 }, c), []);
  assert.deepEqual(nearCuts({ name: "stability", value: 30, risePp: 1.02 }, c), ["stability near +30%", "stability near +1 pp"], "a rounded 30% may be just over the line");
});
