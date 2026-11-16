// The links between tools at the foot of a tool page, defined once (shared by the three tools,
// byte for byte; see docs/adr/0001 in the DeFi Yield Scanner).
//   toolNav(current) → the <nav> for the tool's own page: the other tools
//   toolNav(current, { back: true }) → for its methodology page: back to the tool
export const TOOLS = [
  { id: "defi-yield-scanner", name: "DeFi Yield Scanner" },
  { id: "tokenized-rwa-tracker", name: "Tokenized RWA Tracker" },
  { id: "crypto-fundamentals", name: "Crypto Fundamentals" },
];
const NAV = /<nav class="tool-nav" aria-label="Other tools">[\s\S]*?<\/nav>/;

export function toolNav(current, { back = false } = {}) {
  const me = TOOLS.find((t) => t.id === current);
  if (!me) throw new Error(`unknown tool "${current}"`);
  const links = back ? `<a href="./">${me.name} →</a>` : TOOLS.filter((t) => t !== me).map((t) => `<a href="/${t.id}/">${t.name} →</a>`).join("");
  return `<nav class="tool-nav" aria-label="Other tools">\n      <a href="/tools/">← All tools</a>\n      <span>${links}</span>\n    </nav>`;
}

// The page with its tool links rewritten; the page's own line endings are kept.
export function applyToolNav(html, current, opts) {
  if (!NAV.test(html)) throw new Error("page has no tool links to replace");
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  return html.replace(NAV, () => toolNav(current, opts).replace(/\n/g, eol));
}
