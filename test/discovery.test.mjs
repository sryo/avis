import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

async function withPage(html, fn, opts = {}) {
  const m = mount({ html, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

const addStyle = (document, css) => {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
};
const selectors = (t, el) => [...t.discoverMatchedRules(el).rules.map((r) => r.selectorText)];

// CSSOM stand-ins for what happy-dom's parser drops (:is() lists, nesting, @import, @starting-style).
const styleRule = (selectorText, length = 1, cssRules) => ({ type: 1, selectorText, style: { length }, ...(cssRules ? { cssRules } : {}) });
const fakeSheets = (document, sheets) =>
  Object.defineProperty(document, "styleSheets", { get: () => sheets, configurable: true });

test("selector lists split only on top-level commas", () =>
  withPage(`<div class="a"><i class="t" data-x="a,b">x</i></div>`, ({ document, t }) => {
    fakeSheets(document, [{ cssRules: [styleRule(":is(.a,.b) .t"), styleRule('.t[data-x="a,b"]'), styleRule(".z, .t:not(.p,.q)")] }]);
    assert.deepEqual(selectors(t, document.querySelector(".t")), [":is(.a,.b) .t", '.t[data-x="a,b"]', ".z, .t:not(.p,.q)"]);
    assert.deepEqual(selectors(t, document.querySelector(".a")), []);
  }));

test("resting-state pseudo-classes are left to el.matches; interaction states and pseudo-elements are skipped", () =>
  withPage(`<button class="btn" disabled>x</button><input type="checkbox" checked>`, ({ document, t }) => {
    addStyle(document, `button:disabled { opacity: 0.4 } .btn:hover { color: red } .btn::before { color: red }
      .btn:focus-visible { color: red } .btn:active { color: red } .btn:not(:disabled) { color: blue }
      input:checked { margin: 2px } .btn:enabled { color: green }`);
    assert.deepEqual(selectors(t, document.querySelector("button")), ["button:disabled"]);
    assert.deepEqual(selectors(t, document.querySelector("input")), ["input:checked"]);
  }));

test("rules inside a false @supports and inside @starting-style are skipped", () =>
  withPage(`<i class="t">x</i>`, ({ window, document, t }) => {
    // happy-dom answers true for any declaration and builds a fresh CSS object per read.
    Object.getPrototypeOf(window.CSS).supports = (c) => !/nonsense/.test(c);
    addStyle(document, `@supports (display: nonsense) { .t { color: blue } } @supports (display: block) { .t { color: green } }`);
    const sheet = document.styleSheets[0];
    class CSSStartingStyleRule { constructor() { this.cssRules = [styleRule(".t")]; } }
    fakeSheets(document, [sheet, { cssRules: [new CSSStartingStyleRule()] }]);
    const rules = t.discoverMatchedRules(document.querySelector(".t")).rules;
    assert.equal(rules.length, 1);
    assert.equal(rules[0].rule.style.getPropertyValue("color"), "green");
  }));

test("@import sheets are walked, cross-origin imports count as unreadable, import media is honored", () =>
  withPage(`<i class="t">x</i>`, ({ window, document, t }) => {
    window.matchMedia = (q) => ({ matches: q !== "print" });
    const crossOrigin = { get cssRules() { throw new Error("SecurityError"); } };
    fakeSheets(document, [{ cssRules: [
      { type: 3, media: { mediaText: "" }, styleSheet: { cssRules: [styleRule(".t")] } },
      { type: 3, media: { mediaText: "print" }, styleSheet: { cssRules: [styleRule("i")] } },
      { type: 3, media: { mediaText: "" }, styleSheet: crossOrigin },
    ] }]);
    const { rules, unreadable } = t.discoverMatchedRules(document.querySelector(".t"));
    assert.deepEqual([...rules.map((r) => r.selectorText)], [".t"]);
    assert.equal(unreadable, 1);
  }));

test("nested style rules resolve against the parent selector; declaration-less parents are dropped", () =>
  withPage(`<div class="card"><i class="t">x</i></div>`, ({ document, t }) => {
    fakeSheets(document, [{ cssRules: [
      styleRule(".card", 0, [styleRule("& .t"), styleRule(".t"), styleRule("&:hover .t"), { type: 4, conditionText: "all", cssRules: [{ type: 0, style: { length: 1 } }] }]),
    ] }]);
    assert.deepEqual(selectors(t, document.querySelector(".t")), [":is(.card) .t", ":is(.card) .t"]);
    assert.deepEqual(selectors(t, document.querySelector(".card")), [".card"], "nested declarations belong to the parent");
  }));

test("adopted stylesheets are walked, avis's own preview sheet is not", () =>
  withPage(`<style>.card { padding: 8px }</style><div class="card" id="card">x</div>`, ({ window, document, t }) => {
    const sheet = new window.CSSStyleSheet();
    sheet.replaceSync(".card { color: #ff0000 }");
    document.adoptedStyleSheets = [sheet];
    const shadow = document.getElementById("__avis_host").shadowRoot;
    shadow.querySelector("[data-act=point]").click();
    shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    assert.equal(document.adoptedStyleSheets.length, 2, "preview sheet attached");
    assert.deepEqual(selectors(t, document.getElementById("card")), [".card", ".card"]);
  }, { before: (w) => { w.document.elementFromPoint = () => w.document.getElementById("card"); } }));

test("@media conditions are only evaluated when a rule inside them matches", () =>
  withPage(`<div class="card">x</div>`, ({ window, document, t }) => {
    let calls = 0;
    window.matchMedia = (q) => { calls++; return { matches: q !== "(max-width: 0px)" }; };
    addStyle(document, Array.from({ length: 50 }, () => `@media (min-width: 1px) { .other { color: red } }`).join("\n")
      + ` .card { padding: 1px } @media (max-width: 0px) { .card { gap: 9px } } @media (min-width: 1px) { .card { gap: 2px } }`);
    const rules = t.discoverMatchedRules(document.querySelector(".card")).rules;
    assert.deepEqual([...rules.map((r) => r.selectorText)], [".card", ".card"]);
    assert.equal(rules[1].rule.style.getPropertyValue("gap"), "2px");
    assert.equal(calls, 2);
  }));

test("rule entries carry only rule and selectorText", () =>
  withPage(`<div class="card" style="opacity: 0.5">x</div>`, ({ document, t }) => {
    addStyle(document, `.card { color: red }`);
    for (const entry of t.discoverMatchedRules(document.querySelector(".card")).rules) {
      assert.deepEqual(Object.keys(entry).sort(), ["rule", "selectorText"]);
    }
  }));

test("ruleSourceLabel emits the values schema.md documents", () =>
  withPage(``, ({ t }) => {
    const label = (parentStyleSheet, extra = {}) => t.ruleSourceLabel({ rule: { parentStyleSheet, ...extra } });
    assert.equal(label({ href: "http://localhost:3000/css/site.css?v=2" }), "site.css");
    assert.equal(label({ ownerNode: { localName: "style", tagName: "STYLE", id: "" } }), "<style>");
    assert.equal(label({ ownerNode: { localName: "style", tagName: "STYLE", id: "theme" } }), `<style id="theme">`);
    assert.equal(label({ ownerNode: { localName: "style", tagName: "style", id: "" } }), "<style>", "SVG <style>");
    assert.equal(label({ ownerNode: null }), "(stylesheet)", "constructed / adopted sheet");
    assert.equal(label(null, { _inline: true }), "inline");
  }));
