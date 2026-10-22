// Tests for venue data shaping (venues.mjs). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { yearnEntry } from "./venues.mjs";

test("yearnEntry: v3 only for version 3.x; decimals from the underlying token, not the share", () => {
  assert.deepEqual(yearnEntry({ name: "A", version: "3.0.4", decimals: 18, token: { decimals: 6, address: "0xA0B8" }, tvl: { tvl: 5e6 } }), { name: "A", decimals: 6, v3: true, asset: "0xa0b8", tvl: 5e6 });
  assert.deepEqual(yearnEntry({ name: "B", version: "0.4.6", token: { decimals: 18 } }), { name: "B", decimals: 18, v3: false, asset: null, tvl: null });
  assert.deepEqual(yearnEntry({ name: "C" }), { name: "C", decimals: null, v3: false, asset: null, tvl: null });
  assert.equal(yearnEntry({ name: "D", version: "3.0.1", token: { decimals: "6" } }).decimals, null, "a non-integer decimals is unknown");
});
