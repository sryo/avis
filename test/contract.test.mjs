import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { mount, reinject, TOOLBAR_SRC } from "./_mount.mjs";

test("toolbar.js parses as a classic script with no import/export", () => {
  assert.doesNotThrow(() => new vm.Script(TOOLBAR_SRC, { filename: "toolbar.js" }));
  assert.doesNotMatch(TOOLBAR_SRC, /^\s*(import|export)\b/m);
});

test("toolbar.js ends with the IIFE close", () => {
  assert.ok(TOOLBAR_SRC.trimEnd().endsWith("})();"));
});

test("re-injecting a mounted page is a no-op", async () => {
  const { window, avis } = mount();
  avis.add("body", "keep me");
  reinject(window);
  assert.equal(window.__avis, avis);
  assert.equal(window.document.querySelectorAll("#__avis_host").length, 1);
  assert.equal(window.__avis.summary().length, 1);
  await window.happyDOM.close();
});

test("_t test hook exists only when __AVIS_TEST__ is set", async () => {
  const on = mount();
  assert.equal(typeof on.avis._t, "object");
  const off = mount({ test: false });
  assert.equal(off.avis._t, undefined);
  await on.window.happyDOM.close();
  await off.window.happyDOM.close();
});
