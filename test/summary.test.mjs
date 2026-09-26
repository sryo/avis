import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const HTML = `<section class="pricing"><h2>Plans</h2><button id="cta" class="btn primary">Start free trial</button></section>`;
const LEGACY_FIELDS = [
  "id", "comment", "source", "replyTo", "sourceFile", "reactComponents",
  "element", "elementPath", "text", "nearbyText", "parentContext",
  "consoleLog", "priorClicks", "url", "styleTweaks",
];
const plain = (v) => JSON.parse(JSON.stringify(v));

async function withPage(fn, opts = {}) {
  const m = mount({ html: HTML, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

// A dev page typically has a few framework/app logs in the minute before a pin.
function seedConsole(window) {
  window.console.log("[vite] connected.");
  window.console.warn("Warning: Each child in a list should have a unique \"key\" prop. Check the render method of `PlanList`.");
  window.console.log("fetch /api/plans", { status: 200, ms: 84 });
  window.console.error("Failed to load resource: the server responded with a status of 404 (Not Found)");
  window.console.log("analytics: page_view", { path: "/a" });
}

test("summary() strips null/empty fields and reports consoleCount instead of consoleLog", () =>
  withPage(({ window, avis }) => {
    seedConsole(window);
    const id = avis.add("#cta", "bigger");
    const [s] = plain(avis.summary());
    assert.equal(s.id, id);
    assert.equal(s.status, "pending");
    assert.equal("consoleLog" in s, false);
    assert.ok(s.consoleCount >= 5);
    for (const k of ["replyTo", "sourceFile", "reactComponents", "styleTweaks", "priorClicks"]) {
      assert.equal(k in s, false, k);
    }
    for (const v of Object.values(s)) {
      assert.ok(v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
    }
    assert.deepEqual(s.parentContext, { element: "section", text: "PlansStart free trial" });
  }));

test("summary() omits consoleCount when there were no logs", () =>
  withPage(({ avis }) => {
    avis.add("#cta", "x");
    assert.equal("consoleCount" in plain(avis.summary())[0], false);
  }, {
    // Every Date.now() call advances past the 60s console window, so nothing qualifies.
    before: (w) => { let t = 0; w.Date.now = () => (t += 61_000); },
  }));

test("summary({console:true}) includes consoleLog entries", () =>
  withPage(({ window, avis }) => {
    seedConsole(window);
    avis.add("#cta", "x");
    const [s] = plain(avis.summary({ console: true }));
    assert.ok(Array.isArray(s.consoleLog) && s.consoleLog.length >= 5);
    assert.equal("consoleCount" in s, false);
  }));

test("summary({page:true}) keeps only annotations on the current pathname", () =>
  withPage(({ avis }) => {
    const here = avis.add("#cta", "here");
    assert.equal(avis.summary().length, 2);
    assert.deepEqual(plain(avis.summary({ page: true })).map((s) => s.id), [here]);
  }, {
    before: (w) => w.localStorage.setItem("avis:annotations",
      JSON.stringify([{ id: "aold", comment: "elsewhere", url: "http://localhost:3000/b" }])),
  }));

test("summary({status}) filters by one status or a list", () =>
  withPage(({ avis }) => {
    const a = avis.add("#cta", "a");
    const b = avis.add("#cta", "b");
    avis.add("#cta", "c");
    avis.markWorking(a);
    avis.acknowledge(b);
    assert.deepEqual(plain(avis.summary({ status: "working" })).map((s) => s.id), [a]);
    assert.equal(avis.summary({ status: ["pending", "acknowledged"] }).length, 2);
  }));

test("summary() is at least 50% smaller than the legacy projection", () =>
  withPage(({ window, document, avis }) => {
    seedConsole(window);
    document.querySelector("h2").dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    avis.add("#cta", "Make the trial button more prominent than the secondary links");
    const legacy = JSON.stringify(avis.annotations.map((a) => ({
      ...Object.fromEntries(LEGACY_FIELDS.map((k) => [k, a[k]])),
      status: a.status || "pending",
    })));
    const now = JSON.stringify(avis.summary());
    assert.ok(now.length <= legacy.length * 0.5, `${now.length} vs legacy ${legacy.length}`);
  }));

test("info() reports version, page and counts; VERSION is exposed", () =>
  withPage(({ window, avis }) => {
    const a = avis.add("#cta", "a");
    avis.add("#cta", "b");
    avis.markWorking(a);
    assert.match(avis.VERSION, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(plain(avis.info()), {
      v: avis.VERSION,
      page: window.location.href,
      total: 3,
      onPage: 2,
      pending: 2,
      working: 1,
      persistOK: true,
    });
  }, {
    before: (w) => w.localStorage.setItem("avis:annotations",
      JSON.stringify([{ id: "aold", comment: "elsewhere", url: "http://localhost:3000/b" }])),
  }));
