import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));
const noSource = (ts) => (ts || []).map(({ source, ...rest }) => rest);

async function withPage(html, fn, opts = {}) {
  const m = mount({
    html,
    ...opts,
    before: (w) => {
      w.document.elementFromPoint = () => w.document.getElementById("t");
      if (opts.before) opts.before(w);
    },
  });
  const { window } = m;
  const shadow = window.document.getElementById("__avis_host").shadowRoot;
  const ui = {
    shadow,
    pick() {
      shadow.querySelector("[data-act=point]").click();
      shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    },
    edit(id) {
      const mk = shadow.querySelector(`.marker[data-annotation-id="${id}"]`);
      mk.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: 1, clientY: 1 }));
      window.document.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true, clientX: 1, clientY: 1 }));
    },
    blocks: () => [...shadow.querySelectorAll(".popup-rule")],
    setColor(block, value) {
      const inp = block.querySelector('input[type="color"]');
      inp.value = value;
      inp.dispatchEvent(new window.Event("input"));
    },
    change(inp, value) {
      inp.value = value;
      inp.dispatchEvent(new window.Event("change"));
    },
    commit(text) {
      const ta = shadow.querySelector(".popup textarea");
      if (text != null) ta.value = text;
      ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    },
  };
  try { await fn({ ...m, ui }); } finally { await window.happyDOM.close(); }
}

const TWO = `<style>.card { color: #ff0000 } .card.hot { color: #0000ff }</style><div class="card hot" id="t">x</div>`;

test("a tweak is attributed to the rule block the user edited", () =>
  withPage(TWO, ({ avis, ui }) => {
    ui.pick();
    const [, hot] = ui.blocks();
    assert.equal(hot.querySelector(".popup-rule-selector").textContent, ".card.hot");
    ui.setColor(hot, "#00ff00");
    ui.commit("c");
    assert.deepEqual(noSource(plain(avis.summary())[0].styleTweaks),
      [{ selector: ".card.hot", property: "color", before: "#0000ff", after: "#00ff00" }]);
  }));

test("undo in one block keeps another block's tweak of the same property", () =>
  withPage(TWO, ({ avis, ui }) => {
    ui.pick();
    const [card, hot] = ui.blocks();
    ui.setColor(card, "#111111");
    ui.setColor(hot, "#222222");
    hot.querySelector(".popup-rule-undo").click();
    ui.commit("c");
    assert.deepEqual(noSource(plain(avis.summary())[0].styleTweaks),
      [{ selector: ".card", property: "color", before: "#ff0000", after: "#111111" }]);
  }));

test("editing rehydrates a saved tweak into the block with its selector", () =>
  withPage(TWO, ({ avis, ui }) => {
    ui.pick();
    ui.setColor(ui.blocks()[1], "#00ff00");
    ui.commit("c");
    const [s] = plain(avis.summary());
    ui.edit(s.id);
    const [card, hot] = ui.blocks();
    assert.equal(!!card.querySelector(".touched"), false);
    assert.equal(!!hot.querySelector(".touched"), true);
    ui.commit("c2");
    assert.deepEqual(plain(avis.summary())[0].styleTweaks, s.styleTweaks);
  }));

const SEEDED = [{ selector: ".gone", source: "app.css", property: "color", before: "red", after: "blue" }];
const seed = (w) => w.localStorage.setItem("avis:annotations", JSON.stringify([
  { id: "a1", comment: "old", url: "http://localhost:3000/a", elementPath: "#t", styleTweaks: SEEDED },
]));

test("editing keeps saved tweaks the popup could not rebuild (no matching rules)", () =>
  withPage(`<div id="t">x</div>`, ({ avis, ui }) => {
    ui.edit("a1");
    ui.commit("new text");
    const [s] = plain(avis.summary());
    assert.equal(s.comment, "new text");
    assert.deepEqual(s.styleTweaks, SEEDED);
  }, { before: seed }));

test("editing keeps saved tweaks whose rule is no longer listed", () =>
  withPage(`<style>#t { color: #ff0000 }</style><div id="t">x</div>`, ({ avis, ui }) => {
    ui.edit("a1");
    ui.commit("");
    const [s] = plain(avis.summary());
    assert.deepEqual(s.styleTweaks, SEEDED);
  }, { before: seed }));

test("editing an orphaned annotation keeps its tweaks", () =>
  withPage(`<div id="other">x</div>`, ({ avis, ui }) => {
    ui.edit("a1");
    ui.commit("still here");
    assert.deepEqual(plain(avis.summary())[0].styleTweaks, SEEDED);
  }, { before: seed }));

test("an edge cell with a different unit is rejected instead of rescaling the other sides", () =>
  withPage(`<style>.c { padding: 8px 16px }</style><div class="c" id="t">x</div>`, ({ avis, ui }) => {
    ui.pick();
    const top = ui.shadow.querySelector('.popup-edge-grid[data-prop="padding"] [data-side="top"]');
    ui.change(top, "1rem");
    assert.equal(top.value, "8");
    ui.commit("c");
    assert.equal(plain(avis.summary())[0].styleTweaks, undefined);
  }));

test("edge cells step by the unit's step", () =>
  withPage(`<style>.c { padding: 0.5rem 1rem }</style><div class="c" id="t">x</div>`, ({ window, avis, ui }) => {
    ui.pick();
    const top = ui.shadow.querySelector('.popup-edge-grid[data-prop="padding"] [data-side="top"]');
    top.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    ui.commit("c");
    assert.equal(plain(avis.summary())[0].styleTweaks[0].after, "0.55rem 1rem 0.5rem");
  }));

test("a zero side doesn't block folding mixed units into the edges editor", () =>
  withPage("", ({ t }) => {
    assert.deepEqual(plain(t.parseShorthand4("0px 1rem")), { values: [0, 1, 0, 1], unit: "rem" });
    assert.equal(t.parseShorthand4("1em 2px"), null);
  }));

test("a var() shorthand shows as one read-only row", () =>
  withPage("", ({ t }) => {
    const longhands = ["padding-top", "padding-right", "padding-bottom", "padding-left"];
    const style = { length: 5, getPropertyPriority: () => "" };
    [...longhands, "color"].forEach((p, i) => { style[i] = p; });
    style.getPropertyValue = (p) => p === "padding" ? "var(--s)" : p === "color" ? "#ffffff" : "";
    const decls = plain(t.readDeclarations({ rule: { style }, selectorText: ".x" }));
    assert.deepEqual(decls.map((d) => [d.property, d.value, d.kind]),
      [["padding", "var(--s)", "readonly"], ["color", "#ffffff", "color"]]);
  }));

test("editing a translucent color keeps its alpha", () =>
  withPage(`<style>#t { color: rgba(10, 20, 30, 0.5) }</style><div id="t">x</div>`, ({ avis, ui }) => {
    ui.pick();
    ui.setColor(ui.blocks()[0], "#ff0000");
    ui.commit("c");
    assert.equal(plain(avis.summary())[0].styleTweaks[0].after, "rgba(255, 0, 0, 0.5)");
  }));

// happy-dom has no canvas; stand in for the 2D context's color parsing.
const fakeCanvas = (w) => {
  const named = { red: "#ff0000", transparent: "rgba(0, 0, 0, 0)" };
  w.HTMLCanvasElement.prototype.getContext = () => {
    let fs = "#000000";
    return {
      get fillStyle() { return fs; },
      set fillStyle(v) { if (/^#/.test(v)) fs = v; else if (named[v]) fs = named[v]; },
    };
  };
};

test("named colors get a color control; transparent and currentcolor stay read-only", () =>
  withPage("", ({ t }) => {
    assert.equal(t.inferControl("red", "color").kind, "color");
    assert.equal(t.inferControl("red", "background-color").kind, "color");
    assert.equal(t.inferControl("transparent", "color").kind, "readonly");
    assert.equal(t.inferControl("currentcolor", "border-color").kind, "readonly");
    assert.equal(t.inferControl("bogus", "color").kind, "readonly");
    assert.equal(t.inferControl("block", "display").kind, "readonly");
  }, { before: fakeCanvas }));

test("the color picker starts at a named color's value", () =>
  withPage(`<style>#t { color: red }</style><div id="t">x</div>`, ({ ui }) => {
    ui.pick();
    assert.equal(ui.blocks()[0].querySelector('input[type="color"]').value, "#ff0000");
  }, { before: fakeCanvas }));

test("integer-only numbers step by 1, fractional ones by 0.01", () =>
  withPage("", ({ t }) => {
    assert.equal(t.inferControl("1", "z-index").step, 1);
    assert.equal(t.inferControl("0", "order").step, 1);
    assert.equal(t.inferControl("1", "column-count").step, 1);
    assert.equal(t.inferControl("1", "opacity").step, 0.01);
    assert.equal(t.inferControl("1", "flex-grow").step, 0.01);
    assert.equal(t.inferControl("1.5", "line-height").step, 0.01);
  }));
