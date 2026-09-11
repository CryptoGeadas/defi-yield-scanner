// ─────────────────────────────────────────────────────────────────────────────
// Vendor protocol + chain logos locally so the public page never hotlinks a
// third party. Fetch-if-missing from DefiLlama's icon CDN into site/assets/logos/.
// Rarely changes → normally a no-op; only new protocols/chains get fetched.
// A missing/failed logo is fine: the front-end falls back to a monogram chip.
// ─────────────────────────────────────────────────────────────────────────────

import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const PROTO_ICON = (slug) => `https://icons.llamao.fi/icons/protocols/${slug}?w=48&h=48`;
const CHAIN_ICON = (chain) => `https://icons.llamao.fi/icons/chains/rsz_${chain.toLowerCase()}?w=48&h=48`;

const exists = (p) => access(p).then(() => true).catch(() => false);

async function fetchInto(url, dest) {
  if (await exists(dest)) return "skip";
  try {
    const res = await fetch(url);
    if (!res.ok) return `miss(${res.status})`;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 64) return "miss(empty)"; // guard against 1x1 placeholders
    await writeFile(dest, buf);
    return "fetch";
  } catch (e) {
    return `err(${e.message})`;
  }
}

export async function vendorLogos(siteDir, protocolSlugs, chains) {
  const protoDir = join(siteDir, "assets", "logos", "protocols");
  const chainDir = join(siteDir, "assets", "logos", "chains");
  await mkdir(protoDir, { recursive: true });
  await mkdir(chainDir, { recursive: true });

  let fetched = 0;
  for (const slug of protocolSlugs) {
    const r = await fetchInto(PROTO_ICON(slug), join(protoDir, `${slug}.webp`));
    if (r === "fetch") fetched++;
  }
  for (const chain of chains) {
    const r = await fetchInto(CHAIN_ICON(chain), join(chainDir, `${chain.toLowerCase()}.webp`));
    if (r === "fetch") fetched++;
  }
  return { fetched };
}
