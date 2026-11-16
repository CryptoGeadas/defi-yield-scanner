// Records the content of the shared files (run after copying a new version in):
//   node build/chrome/record.mjs
// chrome.test.mjs fails when a copy no longer matches this record (docs/adr/0001).
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export const SHARED = ["chrome.mjs", "header.html", "footer.html", "tools.mjs"];
// line endings are not content: a Windows checkout must hash the same
export const hashOf = async (name) => createHash("sha256").update((await readFile(new URL(name, import.meta.url), "utf8")).replace(/\r\n/g, "\n")).digest("hex");

if (process.argv[1]?.endsWith("record.mjs")) {
  const out = {};
  for (const f of SHARED) out[f] = await hashOf(f);
  await writeFile(new URL("shared.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
  console.log("recorded", Object.keys(out).join(", "));
}
