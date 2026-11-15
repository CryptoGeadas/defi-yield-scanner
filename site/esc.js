// The page's one HTML escape (#67): text from outside (pool names, source strings, error
// messages) goes through it before it is put into HTML. The table (app.js) and the deposit
// panel both import it from here.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
