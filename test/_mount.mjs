import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";

export const TOOLBAR_PATH = fileURLToPath(new URL("../toolbar.js", import.meta.url));
export const TOOLBAR_SRC = readFileSync(TOOLBAR_PATH, "utf8");

// Fresh happy-dom window with toolbar.js evaluated in it.
// opts.html: body markup set before mount. opts.test: set __AVIS_TEST__ (default true).
// opts.before(window): hook to seed localStorage or stub APIs before the script runs.
export function mount(opts = {}) {
  const window = new Window({
    url: opts.url || "http://localhost:3000/a",
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  const { document } = window;
  if (opts.html) document.body.innerHTML = opts.html;
  if (opts.test !== false) window.__AVIS_TEST__ = true;
  if (typeof document.elementFromPoint !== "function") document.elementFromPoint = () => null;
  if (!window.CSS || typeof window.CSS.escape !== "function") {
    window.CSS = Object.assign(window.CSS || {}, { escape: (s) => String(s).replace(/[^\w-]/g, (c) => "\\" + c) });
  }
  if (opts.before) opts.before(window);
  window.eval(TOOLBAR_SRC);
  return { window, document, avis: window.__avis, t: window.__avis && window.__avis._t };
}

export function reinject(window) {
  window.eval(TOOLBAR_SRC);
}
