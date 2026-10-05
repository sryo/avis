// The main-world bridge. Chrome runs perch's eval_js in an isolated world, so the
// page's console and React's fiber expandos are only reachable from a <script> the
// toolbar injects into the page, talking back over DOM events. happy-dom has one
// world, so these tests pin the event contract: they play the "other world" by
// dispatching and intercepting the same events a real main world would.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mount, reinject } from "./_mount.mjs";

const HTML = `<button id="cta">Go</button><div id="leaf">leaf</div>`;
async function withPage(fn, opts = {}) {
  const m = mount({ html: HTML, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}
// Strict CSP stand-in: the bridge <script> is appended but never runs.
function blockInlineScripts(window) {
  const { document } = window;
  for (const root of [document.head, document.documentElement]) {
    const orig = root.appendChild.bind(root);
    root.appendChild = (n) => (n.tagName === "SCRIPT" ? n : orig(n));
  }
}
function fakeFiber(el) {
  const App = function CheckoutPage() {};
  el["__reactFiber$test"] = { tag: 5, type: "div", return: { tag: 0, type: App, _debugSource: { fileName: "src/Checkout.tsx", lineNumber: 12 }, return: null } };
}
// JSON round trip: results come from the happy-dom realm, as they would over perch.
const consoleOf = (avis, id) => JSON.parse(JSON.stringify(avis.summary({ console: true }).find((a) => a.id === id).consoleLog || []));

test("bridge up: page console output reaches annotations exactly once", () =>
  withPage(({ window, avis, t }) => {
    assert.equal(t.bridged, true);
    window.console.log("page says", { a: 1 });
    const id = avis.add("#cta", "x");
    assert.deepEqual(consoleOf(avis, id).map((e) => [e.level, e.msg]), [["log", 'page says {"a":1}']]);
  }));

test("bridge up: level:msg entries relayed from another world are recorded, malformed ones dropped", () =>
  withPage(({ window, document, avis }) => {
    for (const detail of ["warn:from main world: ok", "nope", "info:skipped", "log", 42, null]) {
      document.dispatchEvent(new window.CustomEvent("avis:console", { detail }));
    }
    const id = avis.add("#cta", "x");
    assert.deepEqual(consoleOf(avis, id).map((e) => [e.level, e.msg]), [["warn", "from main world: ok"]]);
  }));

test("bridge up: the script leaves no element behind and re-injecting doesn't double-patch", () =>
  withPage(({ window, document, avis }) => {
    assert.equal(document.querySelectorAll("script").length, 0);
    const patched = window.console.log;
    delete window.__avis;
    document.getElementById("__avis_host").remove();
    reinject(window);
    assert.equal(window.console.log, patched);
    window.console.log("once");
    const id = window.__avis.add("#cta", "x");
    assert.deepEqual(consoleOf(window.__avis, id).map((e) => e.msg), ["once"]);
    void avis;
  }));

test("bridge up: React info comes from the main world's answer", () =>
  withPage(({ window, document, avis }) => {
    const leaf = document.getElementById("leaf");
    // Play the main world: answer before the real bridge listener can.
    let asked = 0;
    window.addEventListener("avis:react", (e) => {
      asked++;
      e.stopImmediatePropagation();
      document.dispatchEvent(new window.CustomEvent("avis:react-result", { detail: JSON.stringify({ source: { fileName: "src/Other.tsx", lineNumber: 3 }, componentPath: "<Other>" }) }));
    }, true);
    const id = avis.add("#leaf", "x");
    const a = avis.annotations.find((x) => x.id === id);
    assert.equal(asked, 1);
    assert.equal(a.reactComponents, "<Other>");
    assert.equal(a.sourceFile, "src/Other.tsx:3");
    void leaf;
  }));

test("bridge up: the real main-world handler walks the fiber", () =>
  withPage(({ document, avis }) => {
    fakeFiber(document.getElementById("leaf"));
    const id = avis.add("#leaf", "x");
    const a = avis.annotations.find((x) => x.id === id);
    assert.equal(a.reactComponents, "<CheckoutPage>");
    assert.equal(a.sourceFile, "src/Checkout.tsx:12");
  }));

test("CSP blocks the bridge: falls back to patching console and walking fibers locally", () =>
  withPage(({ window, document, avis, t }) => {
    assert.equal(t.bridged, false);
    let asked = 0;
    window.addEventListener("avis:react", () => asked++, true);
    fakeFiber(document.getElementById("leaf"));
    window.console.warn("local");
    const id = avis.add("#leaf", "x");
    const a = avis.annotations.find((x) => x.id === id);
    assert.equal(asked, 0);
    assert.equal(a.reactComponents, "<CheckoutPage>");
    assert.deepEqual(consoleOf(avis, id).map((e) => e.msg), ["local"]);
  }, { before: blockInlineScripts }));
