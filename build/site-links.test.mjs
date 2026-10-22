// Checks that what the page links to really exists, read from site/ as text (the page has no
// unit tests; these catch silent breaks that a local browser check would not, like a file
// left out of a commit or a renamed anchor). Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";

const site = (p) => new URL(`../site/${p}`, import.meta.url);
const app = await readFile(site("app.js"), "utf8");

test("every ./assets/ file the page uses exists", async () => {
  const srcs = [...app.matchAll(/\.\/(assets\/[\w./-]+\.(?:svg|png|webp))/g)].map((m) => m[1]);
  assert.ok(srcs.includes("assets/logos/sqd-light.svg"), "the SQD credit logo is referenced");
  for (const s of srcs) await access(site(s)); // throws if missing
});

test("every methodology.html#anchor the page links to exists", async () => {
  const methodology = await readFile(site("methodology.html"), "utf8");
  const ids = [...app.matchAll(/methodology\.html#([\w-]+)/g)].map((m) => m[1]);
  assert.ok(ids.includes("flows"));
  for (const id of ids) assert.ok(methodology.includes(`id="${id}"`), `#${id}`);
});

test("the SQD logo is exactly the file the owner approved (SQD's light logo, unaltered)", async () => {
  // Downloaded from https://sqd.dev/brand/Logo_light.svg on 2026-10-22 with the owner's OK.
  // SQD's brand rules forbid changing it. If SQD updates its logo, ask the owner first, then
  // replace the file and this hash. Line endings are normalised (git may convert them).
  const svg = (await readFile(site("assets/logos/sqd-light.svg"), "utf8")).replace(/\r\n/g, "\n");
  assert.equal(createHash("sha256").update(svg).digest("hex"), "f671beba8837675509706fed801e02ab561836c3b9ca78508097c501fb2084d3");
});
