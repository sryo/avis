import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));

async function withPage(html, fn) {
  const m = mount({ html, before: (w) => { w.document.elementFromPoint = () => w.document.getElementById("t"); } });
  const { window } = m;
  const shadow = window.document.getElementById("__avis_host").shadowRoot;
  const ui = {
    shadow,
    pick() {
      shadow.querySelector("[data-act=point]").click();
      shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    },
    blocks: () => [...shadow.querySelectorAll(".popup-rule")],
    change(inp, value) { inp.value = value; inp.dispatchEvent(new window.Event("change")); },
    setColor(root, value) {
      const inp = root.querySelector('input[type="color"]');
      inp.value = value;
      inp.dispatchEvent(new window.Event("input"));
    },
    state: (name) => [...shadow.querySelectorAll(".popup-state")].find((b) => b.textContent === name).click(),
    undo() {
      shadow.querySelector(".popup .popup-rule input").dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, composed: true, cancelable: true }));
    },
    commit(text) {
      const ta = shadow.querySelector(".popup textarea");
      if (text != null) ta.value = text;
      ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    },
    sheetText: () => [...window.document.adoptedStyleSheets].map((s) => [...s.cssRules].map((r) => r.cssText).join(" ")).join(" "),
  };
  try { await fn({ ...m, ui }); } finally { await window.happyDOM.close(); }
}

const style = (document, css) => {
  const s = document.createElement("style");
  s.textContent = css;
  document.head.appendChild(s);
};

test("inferControl: a lone var() is a read-only chip that names its token", () =>
  withPage("", ({ t }) => {
    assert.deepEqual(plain(t.inferControl("var(--gap)", "gap")), { kind: "readonly", token: "--gap" });
    assert.deepEqual(plain(t.inferControl("var(--gap, 4px)", "gap")), { kind: "readonly", token: "--gap" });
    assert.deepEqual(plain(t.inferControl("calc(var(--gap) * 2)", "gap")), { kind: "readonly" });
  }));

test("findTokenRule names the rule that declares the token and the value it resolves to", () =>
  withPage(`<div id="t">x</div>`, ({ window, document, t }) => {
    style(document, `:root { --brand: #112233 } @media (max-width: 0px) { :root { --brand: #ffffff } } #t { color: var(--brand) }`);
    window.matchMedia = (q) => ({ matches: q !== "(max-width: 0px)" });
    window.getComputedStyle = () => ({ getPropertyValue: (n) => n === "--brand" ? " #112233" : "" });
    const el = document.getElementById("t");
    const tok = t.findTokenRule(el, "--brand");
    assert.equal(tok.selectorText, ":root");
    assert.equal(tok.declared, "#112233");
    assert.equal(tok.value, "#112233");
    assert.deepEqual([...tok.conds], []);
    assert.equal(t.findTokenRule(el, "--nope"), null);
  }));

test("a token row edits the declaring rule and previews on it", () =>
  withPage(`<div id="t">x</div>`, ({ window, document, avis, ui }) => {
    style(document, `:root { --brand: #112233 } #t { color: var(--brand) }`);
    window.getComputedStyle = () => ({ getPropertyValue: (n) => n === "--brand" ? "#112233" : "" });
    ui.pick();
    const [block] = ui.blocks();
    const tokenRow = block.querySelector(".popup-decl-token");
    assert.ok(tokenRow, "token row");
    assert.match(block.querySelector(".popup-decl-readonly").textContent, /var\(--brand\) = #112233/);
    ui.setColor(tokenRow, "#ff0000");
    assert.match(ui.sheetText(), /:root[^}]*--brand: #ff0000 !important/);
    ui.commit("c");
    const [tw] = plain(avis.summary())[0].styleTweaks;
    assert.deepEqual({ ...tw, source: undefined }, { selector: ":root", source: undefined, property: "--brand", before: "#112233", after: "#ff0000" });
  }));

test("a tweak on a media rule is named by its condition and previews inside it", () =>
  withPage(`<div id="t">x</div>`, ({ window, document, avis, ui }) => {
    window.matchMedia = () => ({ matches: true });
    style(document, `@media (min-width: 1px) { #t { color: #112233 } }`);
    ui.pick();
    const [block] = ui.blocks();
    ui.setColor(block, "#ff0000");
    assert.match(ui.sheetText(), /@media \(min-width: 1px\)/);
    ui.commit("c");
    assert.match(plain(avis.summary())[0].styleTweaks[0].source, /@media \(min-width: 1px\)$/);
  }));

test("each rule shows how many elements it reaches", () =>
  withPage(`<div class="c" id="t">x</div><div class="c">y</div><div class="c">z</div>`, ({ document, ui }) => {
    style(document, `.c { color: #112233 }`);
    ui.pick();
    assert.match(ui.blocks()[0].querySelector(".popup-rule-source").textContent, /· 3 on page/);
  }));

test("a state toggle lists that state's rules and records the pseudo-class selector", () =>
  withPage(`<a id="t" class="b">x</a>`, ({ document, avis, ui }) => {
    style(document, `.b { color: #112233 } .b:hover { color: #445566 } .b:focus-visible { color: #000000 } .z:hover { color: red }`);
    ui.pick();
    assert.deepEqual(ui.blocks().map((b) => b.querySelector(".popup-rule-selector").textContent), [".b"]);
    ui.state("hover");
    const blocks = ui.blocks();
    assert.deepEqual(blocks.map((b) => b.querySelector(".popup-rule-selector").textContent), [".b:hover"]);
    ui.setColor(blocks[0], "#ff0000");
    ui.state("default");
    ui.setColor(ui.blocks()[0], "#00ff00");
    ui.commit("c");
    const tweaks = plain(avis.summary())[0].styleTweaks.map(({ selector, after }) => [selector, after]);
    assert.deepEqual(tweaks, [[".b:hover", "#ff0000"], [".b", "#00ff00"]]);
  }));

test("a state with no rules says so", () =>
  withPage(`<a id="t" class="b">x</a>`, ({ document, ui }) => {
    style(document, `.b { color: #112233 }`);
    ui.pick();
    ui.state("active");
    assert.match(ui.shadow.querySelector(".popup-tweaks").textContent, /no :active rules/);
  }));

test("single-layer shadows get a control; layered, inset text and odd colors stay read-only", () =>
  withPage("", ({ t }) => {
    const kind = (v, p = "box-shadow") => t.inferControl(v, p).kind;
    assert.equal(kind("0 1px 2px rgba(0, 0, 0, 0.1)"), "shadow");
    assert.equal(kind("inset 0px 0px 0px 2px #ff0000"), "shadow");
    assert.equal(kind("#ff0000 1px 2px 3px", "text-shadow"), "shadow");
    assert.equal(kind("0 1px 2px #000, 0 2px 4px #000"), "readonly");
    assert.equal(kind("inset 1px 1px #000", "text-shadow"), "readonly");
    assert.equal(kind("0 1px 2px oklch(0.5 0.1 20)"), "readonly");
    assert.equal(kind("0 1px 2em #000"), "readonly");
    const s = t.parseShadow("0 1px 2px 3px #112233", "box-shadow");
    assert.equal(t.formatShadow({ ...s, nums: [0, 4, 8, 0] }, "box-shadow"), "0px 4px 8px #112233");
    assert.equal(t.formatShadow(s, "box-shadow"), "0px 1px 2px 3px #112233");
  }));

test("editing a shadow field emits the whole shadow", () =>
  withPage(`<div id="t">x</div>`, ({ document, avis, ui }) => {
    style(document, `#t { box-shadow: 0 1px 2px #112233 }`);
    ui.pick();
    const [block] = ui.blocks();
    ui.change(block.querySelector('input[aria-label="box-shadow blur"]'), "10");
    ui.commit("c");
    const [tw] = plain(avis.summary())[0].styleTweaks;
    assert.equal(tw.after, "0px 1px 10px #112233");
    assert.equal(tw.before, "0 1px 2px #112233");
  }));

test("Cmd+Z puts back the control's value from before its last run of edits", () =>
  withPage(`<div id="t">x</div>`, ({ document, avis, ui }) => {
    style(document, `#t { color: #112233 }`);
    ui.pick();
    const [block] = ui.blocks();
    ui.setColor(block, "#ff0000");
    ui.setColor(block, "#00ff00");
    assert.match(ui.sheetText(), /00ff00/);
    ui.undo();
    assert.equal(/00ff00|ff0000/.test(ui.sheetText()), false);
    assert.equal(block.querySelector(".popup-decl").classList.contains("touched"), false);
    ui.commit("c");
    assert.equal(plain(avis.summary())[0].styleTweaks, undefined);
  }));
