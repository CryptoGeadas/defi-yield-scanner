// ─────────────────────────────────────────────────────────────────────────────
// PROTOCOL REGISTRY (#66) — what the build knows about each protocol, read from
// trusted-protocols.json (one record per protocol, membership = trust). The other
// protocol files stay as they are: protocol-names.json (display name, needed for every
// protocol), deposit-protocols.json and since.json → protocols (only where they apply).
// Code reads protocol facts from here, never from its own list of slugs.
//
// Record fields:
//   bucket  lend | LP | vault                 (required)
//   access  permissionless | permissioned     (required)
//   level   1 | 2 | 3                         (required: the Protocol factor)
//   flows   "lending" | "vault"   (optional) a plain lending market, or a vault venue the
//           flows job reads; anything else gets the "not read for this protocol" reason
//   site    "https://…"           (optional) the protocol's own site when DefiLlama has none
//
//   PROTOCOLS → { slug: record };  withFlows(kind) → Set of slugs;  siteOf(slug) → url | null
//   protocolProblems(protocols, { names }) → [text]: every missing or wrong field
// ─────────────────────────────────────────────────────────────────────────────
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8"));
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("_")));

export const PROTOCOLS = strip(read("./trusted-protocols.json"));
export const NAMES = strip(read("./protocol-names.json"));

export const withFlows = (kind, protocols = PROTOCOLS) => new Set(Object.keys(protocols).filter((s) => protocols[s].flows === kind));
export const siteOf = (slug, protocols = PROTOCOLS) => protocols[slug]?.site ?? null;

const ALLOWED = {
  bucket: ["lend", "LP", "vault"],
  access: ["permissionless", "permissioned"],
  level: [1, 2, 3],
};
const OPTIONAL = { flows: ["lending", "vault"] };
const KNOWN = new Set([...Object.keys(ALLOWED), ...Object.keys(OPTIONAL), "site"]);

export function protocolProblems(protocols = PROTOCOLS, { names = NAMES } = {}) {
  const out = [];
  for (const [slug, p] of Object.entries(protocols)) {
    for (const [field, ok] of Object.entries(ALLOWED))
      if (!ok.includes(p[field])) out.push(`${slug}: ${field} must be one of ${ok.join(", ")}`);
    for (const [field, ok] of Object.entries(OPTIONAL))
      if (field in p && !ok.includes(p[field])) out.push(`${slug}: ${field} must be one of ${ok.join(", ")}`);
    if ("site" in p && !/^https:\/\/[^/\s]+/.test(String(p.site))) out.push(`${slug}: site must be an https link`);
    for (const k of Object.keys(p)) if (!KNOWN.has(k)) out.push(`${slug}: unknown field ${k}`);
    if (p.flows === "lending" && p.bucket !== "lend") out.push(`${slug}: a lending market must be in the lend bucket`);
    if (typeof names[slug] !== "string" || !names[slug].trim()) out.push(`${slug}: no display name in protocol-names.json`);
  }
  return out;
}
