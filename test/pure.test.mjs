import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const { window, t } = mount();
after(() => window.happyDOM.close());

test("rgbToHex", () => {
  assert.equal(t.rgbToHex("rgb(255, 0, 16)"), "#ff0010");
  assert.equal(t.rgbToHex("rgba(1,2,3,0.5)"), "#010203");
  assert.equal(t.rgbToHex("#ABCDEF"), "#abcdef");
  assert.equal(t.rgbToHex("#abc"), "#aabbcc");
  assert.equal(t.rgbToHex("#abcd"), "#aabbcc");
  assert.equal(t.rgbToHex("#11223380"), "#112233");
  assert.equal(t.rgbToHex(""), "#000000");
  assert.equal(t.rgbToHex("red"), "#000000");
});

test("parseDimension", () => {
  assert.deepEqual({ ...t.parseDimension("8") }, { n: 8, unit: "px" });
  assert.deepEqual({ ...t.parseDimension("1.5rem") }, { n: 1.5, unit: "rem" });
  assert.deepEqual({ ...t.parseDimension("-4PX") }, { n: -4, unit: "px" });
  assert.deepEqual({ ...t.parseDimension("auto") }, { raw: "auto" });
  assert.deepEqual({ ...t.parseDimension("3", "") }, { n: 3, unit: "px" });
  assert.equal(t.parseDimension(""), null);
  assert.equal(t.parseDimension(null), null);
  assert.equal(t.parseDimension("calc(1px + 2px)"), null);
});

test("parseShorthand4 expands 1-4 tokens to [t,r,b,l]", () => {
  const v = (s) => { const p = t.parseShorthand4(s); return p && [[...p.values], p.unit]; };
  assert.deepEqual(v("8px"), [[8, 8, 8, 8], "px"]);
  assert.deepEqual(v("8px 16px"), [[8, 16, 8, 16], "px"]);
  assert.deepEqual(v("1px 2px 3px"), [[1, 2, 3, 2], "px"]);
  assert.deepEqual(v("1em 2em 3em 4em"), [[1, 2, 3, 4], "em"]);
  assert.equal(t.parseShorthand4("8px 1em"), null);
  assert.equal(t.parseShorthand4("auto 8px"), null);
  assert.equal(t.parseShorthand4("1px 2px 3px 4px 5px"), null);
});

test("formatShorthand4 picks the shortest form and round-trips", () => {
  assert.equal(t.formatShorthand4([8, 8, 8, 8], "px"), "8px");
  assert.equal(t.formatShorthand4([8, 16, 8, 16], "px"), "8px 16px");
  assert.equal(t.formatShorthand4([1, 2, 3, 2], "px"), "1px 2px 3px");
  assert.equal(t.formatShorthand4([1, 2, 3, 4], "rem"), "1rem 2rem 3rem 4rem");
  for (const s of ["8px", "8px 16px", "1px 2px 3px", "1px 2px 3px 4px"]) {
    const p = t.parseShorthand4(s);
    assert.equal(t.formatShorthand4(p.values, p.unit), s);
  }
});

test("inferControl", () => {
  assert.equal(t.inferControl("#fff", "color").kind, "color");
  assert.equal(t.inferControl("rgb(0,0,0)", "color").kind, "color");
  assert.equal(t.inferControl("hsl(0 0% 0%)", "color").kind, "color");
  const edges = t.inferControl("8px 16px", "padding");
  assert.equal(edges.kind, "edges");
  assert.equal(edges.shape, "sides");
  assert.deepEqual([...edges.values], [8, 16, 8, 16]);
  assert.equal(t.inferControl("4px", "border-radius").shape, "corners");
  const len = t.inferControl("1.5rem", "font-size");
  assert.deepEqual({ ...len }, { kind: "length", unit: "rem", step: 0.05 });
  assert.equal(t.inferControl("12px", "width").step, 1);
  assert.deepEqual({ ...t.inferControl("0.5", "opacity") }, { kind: "number", step: 0.01 });
  assert.equal(t.inferControl("400", "font-weight").step, 1);
  assert.equal(t.inferControl("linear-gradient(red, blue)", "background").kind, "readonly");
});

test("isMinified", () => {
  assert.equal(t.isMinified(""), true);
  assert.equal(t.isMinified("a"), true);
  assert.equal(t.isMinified("Ab"), true);
  assert.equal(t.isMinified("abc"), true);
  assert.equal(t.isMinified("App"), false);
  assert.equal(t.isMinified("NavItem"), false);
});
