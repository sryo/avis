import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

// One annotation on /b; the page mounts on /a and then routes to /b the way an SPA
// does from the main world, where avis can't intercept history calls.
const SEED = JSON.stringify([{ id: "ab", comment: "on b", url: "http://localhost:3000/b", elementPath: "#cta" }]);

async function withSpa(fn, before) {
  const intervals = [];
  const m = mount({
    html: `<button id="cta">Go</button>`,
    before: (w) => {
      w.localStorage.setItem("avis:annotations", SEED);
      if (before) before(w, intervals);
    },
  });
  const { window, document } = m;
  const marker = () => document.getElementById("__avis_host").shadowRoot.querySelector('.marker[data-annotation-id="ab"]');
  const routeTo = (path) => window.History.prototype.pushState.call(window.history, {}, "", path);
  const settle = () => new Promise((r) => window.setTimeout(r, 30));
  try { await fn({ ...m, marker, routeTo, settle, intervals }); } finally { await window.happyDOM.close(); }
}

test("history methods are left untouched", () =>
  withSpa(({ window }) => {
    assert.equal(Object.prototype.hasOwnProperty.call(window.history, "pushState"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(window.history, "replaceState"), false);
  }));

test("a 500ms interval notices a route change and re-renders markers", () =>
  withSpa(async ({ marker, routeTo, settle, intervals }) => {
    assert.equal(marker(), null);
    routeTo("/b");
    const nav = intervals.find((i) => i.ms === 500);
    assert.ok(nav, "500ms interval registered");
    nav.fn();
    await settle();
    assert.ok(marker(), "marker for /b rendered");
  }, (w, intervals) => { w.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; }; }));

test("a capture-phase mousedown re-checks the route after the click handlers run", () =>
  withSpa(async ({ window, document, marker, routeTo, settle }) => {
    document.getElementById("cta").addEventListener("mousedown", () => routeTo("/b"));
    document.getElementById("cta").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    await settle();
    assert.ok(marker());
  }, (w) => { w.setInterval = () => 0; }));

test("a click re-checks the route too", () =>
  withSpa(async ({ window, document, marker, routeTo, settle }) => {
    document.getElementById("cta").addEventListener("click", () => routeTo("/b"));
    document.getElementById("cta").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await settle();
    assert.ok(marker());
  }, (w) => { w.setInterval = () => 0; }));

test("popstate re-renders markers", () =>
  withSpa(async ({ window, marker, routeTo, settle }) => {
    routeTo("/b");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    await settle();
    assert.ok(marker());
  }, (w) => { w.setInterval = () => 0; }));
