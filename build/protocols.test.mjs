// The protocol registry (#66): one record per protocol in trusted-protocols.json, a check that
// fails when a record lacks a field a build step needs, and no slug lists left in the code.
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PROTOCOLS, protocolProblems, withFlows, siteOf } from "./protocols.mjs";
import { BUILDERS } from "./deeplinks.mjs";

test("every protocol record is complete", () => {
  assert.deepEqual(protocolProblems(), []);
});

test("adding a protocol means adding one record (and its display name)", () => {
  const protocols = { ...PROTOCOLS, "new-lend": { bucket: "lend", access: "permissionless", level: 2, flows: "lending", site: "https://new.example" } };
  assert.deepEqual(protocolProblems(protocols, { names: { ...Object.fromEntries(Object.keys(PROTOCOLS).map((s) => [s, s])), "new-lend": "New Lend" } }), []);
  assert.ok(withFlows("lending", protocols).has("new-lend"), "flows reads it as a lending market");
  assert.equal(siteOf("new-lend", protocols), "https://new.example", "links read its site");
});

test("a record without a field a build step needs fails the check", () => {
  const names = { x: "X" };
  const ok = { bucket: "lend", access: "permissionless", level: 1 };
  assert.deepEqual(protocolProblems({ x: ok }, { names }), []);
  for (const field of ["bucket", "access", "level"]) {
    const { [field]: _, ...rest } = ok;
    assert.match(protocolProblems({ x: rest }, { names }).join("\n"), new RegExp(`x: ${field} must be`));
  }
  assert.match(protocolProblems({ x: ok }, { names: {} }).join(), /no display name/);
  assert.match(protocolProblems({ x: { ...ok, flows: "maybe" } }, { names }).join(), /flows must be/);
  assert.match(protocolProblems({ x: { ...ok, bucket: "LP", flows: "lending" } }, { names }).join(), /lend bucket/);
  assert.match(protocolProblems({ x: { ...ok, site: "curve.fi" } }, { names }).join(), /https link/);
  assert.match(protocolProblems({ x: { ...ok, levle: 1 } }, { names }).join(), /unknown field levle/);
});

test("no hard-coded protocol lists remain in the flows, link and intake code", async () => {
  const slug = `"[a-z0-9]+(?:-[a-z0-9]+)+"`;
  const list = new RegExp(`\\[\\s*${slug}\\s*,|new Set\\(\\[\\s*${slug}|${slug}\\s*:\\s*"https`);
  for (const f of ["flows.mjs", "deeplinks.mjs", "intake.mjs"]) {
    const src = await readFile(new URL(`./${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, list, f);
  }
  // exact link builders are code, keyed by slug: each must be a real record or a known extra
  for (const s of Object.keys(BUILDERS)) assert.ok(s in PROTOCOLS || s === "curve-dex", `link builder for unknown protocol ${s}`);
});
