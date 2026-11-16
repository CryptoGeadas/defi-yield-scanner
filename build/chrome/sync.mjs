// Writes the site's shared header and footer, and the links between tools, into this tool's pages.
//   node build/chrome/sync.mjs           rewrite the pages
//   node build/chrome/sync.mjs --check   exit 1 if a page differs (nothing is written)
// header.html, footer.html, chrome.mjs and tools.mjs are copies of shared files (docs/adr/0001);
// shared.json records their content, and a test fails when a copy differs.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { applyChrome } from "./chrome.mjs";
import { applyToolNav } from "./tools.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE = join(HERE, "..", "..", "site");
export const TOOL = "defi-yield-scanner";
export const PAGES = [{ file: "index.html" }, { file: "methodology.html", back: true }];

export const loadChrome = async () => ({ header: await readFile(join(HERE, "header.html"), "utf8"), footer: await readFile(join(HERE, "footer.html"), "utf8") });
export const pageText = (file) => readFile(join(SITE, file), "utf8");
export const render = (html, chrome, page) => applyToolNav(applyChrome(html, chrome), TOOL, { back: page.back });

export async function syncChrome({ check = false } = {}) {
  const chrome = await loadChrome(), changed = [];
  for (const page of PAGES) {
    const html = await pageText(page.file), next = render(html, chrome, page);
    if (next === html) continue;
    changed.push(page.file);
    if (!check) await writeFile(join(SITE, page.file), next);
  }
  return changed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  const changed = await syncChrome({ check });
  console.log(changed.length ? `${check ? "differ" : "rewritten"}: ${changed.join(", ")}` : "every page has the shared header, footer and tool links");
  if (check && changed.length) process.exit(1);
}
