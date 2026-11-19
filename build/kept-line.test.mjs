// The scan panel's kept line (#70). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { keptLine } from "../site/kept-line.js";

test("keptLine: names the KYC pools and whether they are hidden or shown", () => {
  assert.equal(keptLine({ totalPools: 14923 }, 15, false), "kept of 14,923 pools · 15 need KYC (hidden)");
  assert.equal(keptLine({ totalPools: 14923 }, 15, true), "kept of 14,923 pools · 15 need KYC (shown)");
  assert.equal(keptLine({ totalPools: 14923 }, 1, false), "kept of 14,923 pools · 1 needs KYC (hidden)");
  assert.equal(keptLine({ totalPools: 14923 }, 0, false), "kept of 14,923 pools", "no KYC pools: the line is unchanged");
});
