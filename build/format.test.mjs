// The shared format helpers (#62): one copy on the page, the same money letters on every tool,
// and a missing figure reads unknown. Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { esc, fmtTvl, fmtUsd, fmtNet, fmtPct, fmtDay } from "../site/format.js";

const site = new URL("../site/", import.meta.url);

test("money uses upper-case letters, the same form as the other tools", () => {
  assert.equal(fmtTvl(1.234e9), "$1.23B");
  assert.equal(fmtTvl(50e6), "$50.0M");
  assert.equal(fmtTvl(5e3), "$5K");
  assert.equal(fmtUsd(420), "$420");
  assert.equal(fmtNet(-2.5e6), "−$2.5M");
  assert.equal(fmtNet(3e3), "+$3K");
  assert.equal(fmtPct(4.5), "4.50%");
  assert.equal(fmtDay("2026-11-16"), "16 Nov");
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

test("a missing or non-number figure is shown as unknown, never $NaN or $0", () => {
  for (const bad of [null, undefined, NaN, Infinity, "12", {}]) {
    assert.equal(fmtTvl(bad), "unknown");
    assert.equal(fmtUsd(bad), "unknown");
    assert.equal(fmtNet(bad), "unknown");
  }
  assert.equal(fmtPct(null), "—");
});

test("no page script keeps its own copy of the escape or the money and date formatters", async () => {
  const local = /(?:const|function|let)\s+(esc|fmtTvl|fmtUsd|fmtNet|fmtPct|fmtDay)\b/;
  const found = [];
  for (const f of await readdir(site)) {
    if (!f.endsWith(".js") || f === "format.js") continue;
    const m = (await readFile(new URL(f, site), "utf8")).match(local);
    if (m) found.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(found, []);
  const html = (await readFile(new URL("app.js", site), "utf8"));
  assert.ok(!/\$\{\(n \/ 1e9\)\.toFixed\(2\)\}b/.test(html), "no lower-case money letters");
});
