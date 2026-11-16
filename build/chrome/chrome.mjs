// Site chrome: the header (ticker + nav) and the footer, defined once in header.html and
// footer.html next to this file and written into every page as plain HTML, so pages are complete
// with JavaScript off. sync.mjs writes them; chrome.test.mjs fails when a page differs.
//
// A page states only what differs:
//   <body data-nav="/tools/">   which nav link is the current section (none on the home page)
//   the inside of its footer's <span class="data-line">…</span> (its own sources line)
//
//   applyChrome(html, { header, footer }) → the page with the shared header and footer written in
//   pageParts(html) → { nav, dataLine } read from a page
const HEADER = /<header class="site-header">[\s\S]*?<\/header>/;
const FOOTER = /<footer class="site-footer">[\s\S]*?<\/footer>/;
const DATA_LINE = /<span class="data-line">([\s\S]*?)<\/span>(?=\s*<span class="credit">)/;
const MARK = "<!-- data-line -->";

export function pageParts(html) {
  const footer = html.match(FOOTER)?.[0] ?? "";
  return { nav: html.match(/<body[^>]*\sdata-nav="([^"]*)"/)?.[1] ?? null, dataLine: footer.match(DATA_LINE)?.[1] ?? null };
}

// The header with the current section marked for sight and for screen readers alike.
export function headerFor(header, nav) {
  if (!nav) return header;
  const link = `<a href="${nav}">`;
  if (!header.includes(link)) throw new Error(`data-nav="${nav}" matches no link in the site nav`);
  return header.replace(link, `<a href="${nav}" aria-current="page">`);
}

export function applyChrome(html, { header, footer }) {
  if (!HEADER.test(html) || !FOOTER.test(html)) throw new Error("page has no site header or footer to replace");
  const { nav, dataLine } = pageParts(html);
  if (dataLine == null) throw new Error("page footer has no data line");
  if (!footer.includes(MARK)) throw new Error("footer.html has lost its data-line marker");
  // the shared text takes the page's own line endings, so a sync never rewrites a whole file
  const eol = html.includes("\r\n") ? "\r\n" : "\n";
  const fit = (text) => text.trim().replace(/\r?\n/g, eol);
  return html.replace(HEADER, () => fit(headerFor(header, nav))).replace(FOOTER, () => fit(footer).replace(MARK, () => dataLine));
}
