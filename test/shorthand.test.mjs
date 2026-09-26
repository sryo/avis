import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));

async function withPage(html, fn, opts = {}) {
  const m = mount({ html, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

// CSSStyleDeclaration stand-in listing longhands the way Chrome enumerates them.
function fakeEntry(decls) {
  const style = { length: decls.length };
  decls.forEach(([p], i) => { style[i] = p; });
  const find = (p) => decls.find((d) => d[0] === p) || [];
  style.getPropertyValue = (p) => find(p)[1] || "";
  style.getPropertyPriority = (p) => find(p)[2] || "";
  return { rule: { style }, selectorText: ".x", matched: [".x"] };
}
const sides = (prefix, vals, suffix = "", prio = []) =>
  ["top", "right", "bottom", "left"].map((s, i) => [`${prefix}${s}${suffix}`, vals[i], prio[i] || ""]);

test("readDeclarations folds complete longhand groups back into shorthands", () =>
  withPage(`<div class="card">x</div>`, ({ document, t }) => {
    const style = document.createElement("style");
    style.textContent = `.card { padding: 8px 16px; color: #ff0000; margin: 1px 2px 3px; border-radius: 4px 6px; border-width: 2px }`;
    document.head.appendChild(style);
    const [entry] = t.discoverMatchedRules(document.querySelector(".card")).rules;
    const decls = plain(t.readDeclarations(entry));
    assert.deepEqual(decls.map((d) => d.property), ["padding", "color", "margin", "border-radius", "border-width"]);
    const by = Object.fromEntries(decls.map((d) => [d.property, d]));
    assert.deepEqual(by.padding, { property: "padding", value: "8px 16px", kind: "edges", shape: "sides", values: [8, 16, 8, 16], unit: "px" });
    assert.equal(by.margin.value, "1px 2px 3px");
    assert.equal(by["border-radius"].shape, "corners");
    assert.deepEqual(by["border-radius"].values, [4, 6, 4, 6]);
    assert.equal(by["border-width"].value, "2px");
  }));

test("Chrome-style inset longhands (top/right/bottom/left) group into inset", () =>
  withPage("", ({ t }) => {
    const decls = plain(t.readDeclarations(fakeEntry(sides("", ["0", "4px", "0", "4px"]))));
    assert.deepEqual(decls.map((d) => [d.property, d.value, d.kind]), [["inset", "0px 4px", "edges"]]);
  }));

test("incomplete, mixed-priority, mixed-unit or non-numeric groups stay as longhands", () =>
  withPage(`<div style="padding-top: 3px">x</div>`, ({ document, t }) => {
    const [inline] = t.discoverMatchedRules(document.querySelector("div")).rules;
    assert.deepEqual(plain(t.readDeclarations(inline)).map((d) => d.property), ["padding-top"]);
    const cases = [
      sides("margin-", ["1px", "1px", "1px", "1px"], "", ["important"]),
      sides("margin-", ["1em", "2px", "1em", "2px"]),
      sides("margin-", ["auto", "0", "auto", "0"]),
      [["border-top-left-radius", "4px 8px"], ["border-top-right-radius", "4px 8px"],
        ["border-bottom-right-radius", "4px 8px"], ["border-bottom-left-radius", "4px 8px"]],
    ];
    for (const decls of cases) {
      const out = plain(t.readDeclarations(fakeEntry(decls)));
      assert.equal(out.length, 4, JSON.stringify(decls));
    }
  }));

test("the popup's edges editor is reachable and records a shorthand tweak", () =>
  withPage(`<style>.card { padding: 8px 16px }</style><div class="card" id="card">x</div>`, ({ window, document, avis }) => {
    const shadow = document.getElementById("__avis_host").shadowRoot;
    shadow.querySelector("[data-act=point]").click();
    shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 5, clientY: 5 }));
    const grid = shadow.querySelector('.popup-edge-grid[data-prop="padding"]');
    assert.ok(grid, "edges grid for padding");
    const top = grid.querySelector('.popup-edge-input[data-side="top"]');
    top.value = "12";
    top.dispatchEvent(new window.Event("change"));
    const ta = shadow.querySelector(".popup textarea");
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    const [s] = plain(avis.summary());
    // `source` is left out: happy-dom doesn't link rules to their <style> owner node.
    const tweaks = s.styleTweaks.map(({ source, ...rest }) => rest);
    assert.deepEqual(tweaks, [{ selector: ".card", property: "padding", before: "8px 16px", after: "12px 16px 8px" }]);
  }, { before: (w) => { w.document.elementFromPoint = () => w.document.getElementById("card"); } }));
