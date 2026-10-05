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

test("every class toggled or assigned in JS is styled in the shadow <style>", () => {
  const start = TOOLBAR_SRC.indexOf("style.textContent = `");
  assert.ok(start > 0, "shadow <style> source found");
  const style = TOOLBAR_SRC.slice(start, TOOLBAR_SRC.indexOf("`;", start));
  const styled = new Set([...style.matchAll(/\.([a-z][\w-]*)/gi)].map((m) => m[1]));
  const literals = (code) => [...code.matchAll(/"([^"]*)"/g)].flatMap((m) => m[1].trim().split(/\s+/)).filter(Boolean);
  const used = new Set([
    ...[...TOOLBAR_SRC.matchAll(/classList\.(?:add|toggle|remove)\(([^;]*?)\)/g)].flatMap((m) => literals(m[1])),
    ...[...TOOLBAR_SRC.matchAll(/\.className\s*=\s*([^;]+);/g)].flatMap((m) => literals(m[1])),
  ]);
  const missing = [...used].filter((c) => !styled.has(c));
  assert.deepEqual(missing, []);
});
