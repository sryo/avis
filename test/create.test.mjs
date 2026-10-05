import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const HTML = `<style>section > button { padding: 8px; color: #112233 }</style>
  <section><h2>Plans</h2><button id="cta">Start free trial</button></section>`;

// Drives the real toolbar UI: enter point mode, pick #cta, type, Cmd+Enter.
async function withPicker(fn) {
  const spies = { computed: 0, qsa: 0 };
  const m = mount({
    html: HTML,
    before: (w) => {
      w.document.elementsFromPoint = () => [w.document.getElementById("cta")];
      // happy-dom's innerText calls window.getComputedStyle per child; a browser doesn't.
      Object.defineProperty(w.HTMLElement.prototype, "innerText", { get() { return this.textContent; } });
      const gcs = w.getComputedStyle.bind(w);
      w.getComputedStyle = (...a) => { spies.computed++; return gcs(...a); };
      const qsa = w.document.querySelectorAll.bind(w.document);
      // getSelector's uniqueness probe for #cta; happy-dom's computed style runs its own queries.
      w.document.querySelectorAll = (...a) => { if (a[0] === "#cta") spies.qsa++; return qsa(...a); };
    },
  });
  const { window } = m;
  const shadow = window.document.getElementById("__avis_host").shadowRoot;
  const ui = {
    shadow,
    pick() {
      shadow.querySelector("[data-act=point]").click();
      spies.computed = 0; spies.qsa = 0;
      shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    },
    commit(text) {
      const ta = shadow.querySelector(".popup textarea");
      ta.value = text;
      ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    },
  };
  try { await fn({ ...m, ui, spies }); } finally { await window.happyDOM.close(); }
}

test("opening the popup does not capture; committing captures once", () =>
  withPicker(({ avis, ui, spies }) => {
    ui.pick();
    assert.ok(ui.shadow.querySelector(".popup"), "popup open");
    assert.ok(ui.shadow.querySelector(".marker.tentative"), "tentative marker shown");
    assert.equal(spies.computed, 0, "no getComputedStyle before commit");
    assert.equal(ui.shadow.querySelector(".popup-tweaks-toggle") !== null, true, "tweak rules mounted");
    const qsaAtOpen = spies.qsa;
    ui.commit("bigger please");
    assert.equal(spies.computed, 1, "one getComputedStyle at commit");
    assert.equal(spies.qsa, qsaAtOpen, "selector not recomputed at commit");
    const [s] = avis.summary();
    assert.equal(s.comment, "bigger please");
    assert.equal(s.elementPath, "#cta");
    assert.equal(s.source, "user");
    assert.equal(ui.shadow.querySelector(".marker.tentative"), null);
  }));

test("selector is computed once per create", () =>
  withPicker(({ ui, spies }) => {
    ui.pick();
    ui.commit("x");
    assert.equal(spies.qsa, 1);
  }));

test("capture honours opts.selector", () =>
  withPicker(({ document, t }) => {
    const a = t.capture(document.getElementById("cta"), "c", { selector: "section > button" });
    assert.equal(a.elementPath, "section > button");
  }));
