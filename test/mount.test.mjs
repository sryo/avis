// Mounting under hostile pages: Trusted Types, a throw mid-mount, and a toolbar
// already mounted by another JS world (shared DOM, separate window globals).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mount, reinject, TOOLBAR_SRC } from "./_mount.mjs";

const HTML = `<style>.card { padding: 8px 16px }</style><div class="card" id="card">x</div>`;
async function withPage(fn, opts = {}) {
  let m;
  try { m = mount({ html: HTML, ...opts }); } finally { unpatchAll(); }
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

// `require-trusted-types-for 'script'` stand-in: string assignments to script text and
// HTML sinks throw, as Chrome does on such a page in both the main and isolated worlds.
// happy-dom shares prototypes between windows, so every patch is undone in `finally`.
const restores = [];
function patch(proto, prop, desc) {
  const orig = Object.getOwnPropertyDescriptor(proto, prop);
  Object.defineProperty(proto, prop, { configurable: true, ...desc });
  restores.push(() => (orig ? Object.defineProperty(proto, prop, orig) : delete proto[prop]));
}
const unpatchAll = () => { while (restores.length) restores.pop()(); };
function enforceTrustedTypes(w) {
  const deny = (proto, prop, what) => patch(proto, prop, {
    get() { return ""; },
    set() { throw new w.TypeError(`This document requires '${what}' assignment.`); },
  });
  deny(w.HTMLScriptElement.prototype, "textContent", "TrustedScript");
  deny(w.HTMLScriptElement.prototype, "text", "TrustedScript");
  deny(w.Element.prototype, "innerHTML", "TrustedHTML");
  deny(w.ShadowRoot.prototype, "innerHTML", "TrustedHTML");
}

test("Trusted Types page: mounts fully, falls back to self-patching, popup and edges editor render", () =>
  withPage(({ window, document, avis, t }) => {
    assert.equal(typeof avis, "object");
    const shadow = document.getElementById("__avis_host").shadowRoot;
    assert.ok(shadow.querySelector("[data-act=copy] .copy-count"), "copy button rendered");
    assert.equal(shadow.querySelector(".brand").getAttribute("href"), "https://github.com/sryo/avis");
    assert.equal(t.bridged, false);
    window.console.log("self-patched");
    const id = avis.add("#card", "x");
    const log = avis.summary({ console: true }).find((a) => a.id === id).consoleLog || [];
    assert.deepEqual(JSON.parse(JSON.stringify(log.map((e) => e.msg))), ["self-patched"]);

    shadow.querySelector("[data-act=point]").click();
    shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    const popup = shadow.querySelector(".popup");
    assert.ok(popup.querySelector(".label") && popup.querySelector(".trail") && popup.querySelector(".hint"));
    assert.equal(popup.querySelector("textarea").getAttribute("placeholder"), "What should change?");
    assert.ok(shadow.querySelector(".popup-edge-diagram .d-outer .d-ring .d-inner"), "edges diagram rendered");
  }, { before: (w) => { enforceTrustedTypes(w); w.document.elementFromPoint = () => w.document.getElementById("card"); } }));

test("a throw mid-mount leaves no __avis and no host, so a later injection recovers", async () => {
  let fail = true;
  let threw = false;
  const { window, document } = (() => {
    try {
      return mount({
        html: HTML,
        before: (w) => {
          const orig = w.Element.prototype.attachShadow;
          patch(w.Element.prototype, "attachShadow", { writable: true, value: function (...a) {
            if (fail) throw new w.Error("boom");
            return orig.apply(this, a);
          } });
          globalThis.__lastWindow = w;
        },
      });
    } catch {
      threw = true;
      const w = globalThis.__lastWindow;
      return { window: w, document: w.document };
    }
  })();
  delete globalThis.__lastWindow;
  try {
    assert.equal(threw, true);
    assert.equal(window.__avis, undefined);
    assert.equal(document.getElementById("__avis_host"), null);
    fail = false;
    reinject(window);
    assert.equal(typeof window.__avis.add, "function");
    assert.ok(document.getElementById("__avis_host"));
  } finally { unpatchAll(); await window.happyDOM.close(); }
});

test("mounted by another world: re-running defines an __avis whose info() says so", () =>
  withPage(({ window, avis }) => {
    const v = avis.VERSION;
    delete window.__avis;
    reinject(window);
    assert.equal(typeof window.__avis, "object");
    assert.deepEqual({ ...window.__avis.info() }, { v, mountedElsewhere: true });
  }));

test("owning world: re-running keeps the real __avis", () =>
  withPage(({ window, avis }) => {
    reinject(window);
    assert.equal(window.__avis, avis);
    assert.equal(window.__avis.info().mountedElsewhere, undefined);
  }));

// Toggled with `.hidden`, so the UA's [hidden] { display: none } must win: no author rule
// may set display on them. (happy-dom has no UA [hidden] rule, so this is checked in source.)
test("elements hidden via .hidden get no author display rule", () =>
  withPage(({ window, document }) => {
    const shadow = document.getElementById("__avis_host").shadowRoot;
    shadow.querySelector("[data-act=point]").click();
    shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    assert.ok(shadow.querySelector(".popup-tweaks").hidden && shadow.querySelector(".popup-rule-undo").hidden);
    const start = TOOLBAR_SRC.indexOf("style.textContent = `");
    const css = TOOLBAR_SRC.slice(start, TOOLBAR_SRC.indexOf("`;", start));
    for (const cls of ["popup-tweaks", "popup-rule-undo"]) {
      const rules = [...css.matchAll(new RegExp(`\\.${cls}(?![\\w-])[^{]*\\{([^}]*)\\}`, "g"))];
      assert.ok(rules.length, cls);
      for (const [, body] of rules) assert.doesNotMatch(body, /(^|[;\s])display\s*:/, cls);
    }
  }, { before: (w) => { w.document.elementFromPoint = () => w.document.getElementById("card"); } }));
