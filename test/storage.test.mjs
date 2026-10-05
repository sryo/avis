import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const KEY = "avis:annotations";
const HTML = `<h1 id="title">Hello</h1><button id="cta">Buy</button><p id="note">fine print</p>`;

async function withPage(fn, opts = {}) {
  const m = mount({ html: HTML, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

const ann = (id, extra = {}) => ({ id, comment: id, url: "http://localhost:3000/a", elementPath: "#cta", ...extra });
const seed = (list) => ({ before: (w) => w.localStorage.setItem(KEY, JSON.stringify(list)) });
const stored = (window) => JSON.parse(window.localStorage.getItem(KEY));
const storedIds = (window) => stored(window).map((a) => a.id).sort();
const host = (window) => window.document.getElementById("__avis_host").shadowRoot;
const tick = (window) => new Promise((r) => window.setTimeout(r, 0));
const marker = (window, id) => host(window).querySelector(`.marker[data-annotation-id="${id}"]`);

// Another tab writes the shared key and bumps the revision; same-window setItem fires
// no storage event, so these exercise the merge persist() does before it writes.
const otherTab = (window, list) => {
  window.localStorage.setItem(KEY, JSON.stringify(list));
  window.localStorage.setItem("avis:rev", "other");
};
test("a write from another tab survives this tab's next add", () =>
  withPage(({ window, avis }) => {
    otherTab(window, [ann("other")]);
    const id = avis.add("#cta", "mine");
    assert.deepEqual(storedIds(window), [id, "other"].sort());
    assert.ok(avis.annotations.some((a) => a.id === "other"));
  }));

test("this tab's resolve is not undone by another tab's stale copy", () =>
  withPage(({ window, avis }) => {
    otherTab(window, [ann("x"), ann("y"), ann("z")]);
    assert.equal(avis.resolve("x"), true);
    assert.deepEqual(storedIds(window), ["y", "z"]);
    assert.deepEqual([...avis.annotations.map((a) => a.id).sort()], ["y", "z"]);
  }, seed([ann("x"), ann("y")])));

test("another tab's removal is not undone by this tab's write", () =>
  withPage(({ window, avis }) => {
    otherTab(window, [ann("y")]);
    avis.markWorking("y");
    assert.deepEqual(storedIds(window), ["y"]);
    assert.equal(stored(window)[0].status, "working");
  }, seed([ann("x"), ann("y")])));

test("clear() drops what this tab knew, keeps what another tab added since", () =>
  withPage(({ window, avis }) => {
    otherTab(window, [ann("x"), ann("z")]);
    avis.clear();
    assert.deepEqual(storedIds(window), ["z"]);
  }, seed([ann("x")])));

test("a storage event from another tab reloads annotations and markers", () =>
  withPage(async ({ window, avis }) => {
    await tick(window);
    const next = JSON.stringify([ann("x", { status: "working" }), ann("w")]);
    window.localStorage.setItem(KEY, next);
    window.dispatchEvent(new window.StorageEvent("storage", { key: KEY, newValue: next, storageArea: window.localStorage }));
    assert.deepEqual([...avis.annotations.map((a) => a.id)], ["x", "w"]);
    assert.equal(avis.summary()[0].status, "working");
    assert.ok(marker(window, "w"));
    assert.equal(avis.info().total, 2);
  }, seed([ann("x")])));

test("a storage event keeps an open popup and its tentative marker", () =>
  withPage(async ({ window, document, avis }) => {
    await tick(window);
    const sh = host(window);
    sh.querySelector("[data-act=point]").click();
    document.elementFromPoint = () => document.getElementById("title");
    sh.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    assert.ok(sh.querySelector(".popup"));
    const next = JSON.stringify([ann("w")]);
    window.localStorage.setItem(KEY, next);
    window.dispatchEvent(new window.StorageEvent("storage", { key: KEY, newValue: next, storageArea: window.localStorage }));
    assert.ok(sh.querySelector(".popup"));
    assert.ok(sh.querySelector(".marker.tentative"));
    assert.ok(marker(window, "w"));
    assert.equal(avis.annotations.length, 1);
  }));

test("a storage event for another key or area leaves annotations alone", () =>
  withPage(async ({ window, avis }) => {
    await tick(window);
    window.dispatchEvent(new window.StorageEvent("storage", { key: null, newValue: null }));
    window.dispatchEvent(new window.StorageEvent("storage", { key: "other", newValue: "1" }));
    assert.deepEqual([...avis.annotations.map((a) => a.id)], ["x"]);
  }, seed([ann("x")])));

for (const bad of ["{}", "null", "42", '"str"', "not json"]) {
  test(`mounts cleanly over a non-array store (${bad})`, () =>
    withPage(({ avis }) => {
      assert.equal(avis.info().total, 0);
      assert.ok(avis.add("#cta", "x"));
      assert.equal(avis.info().total, 1);
    }, { before: (w) => w.localStorage.setItem(KEY, bad) }));
}

test("load() drops entries that are not objects with an id", () =>
  withPage(({ avis }) => {
    assert.deepEqual([...avis.annotations.map((a) => a.id)], ["ok"]);
  }, { before: (w) => w.localStorage.setItem(KEY, JSON.stringify([null, 3, "s", {}, ann("ok")])) }));

test("persistOK is false at mount when storage writes throw", () =>
  withPage(({ window, avis }) => {
    assert.equal(avis.info().persistOK, false);
    assert.equal(avis.persistOK(), false);
    assert.ok(host(window).querySelector(".toolbar").classList.contains("persist-broken"));
  }, {
    before: (w) => {
      const throwing = { getItem: () => null, setItem: () => { throw new Error("quota"); }, removeItem: () => {} };
      Object.defineProperty(w, "localStorage", { value: throwing, configurable: true });
    },
  }));

test("persistOK recovers after a later write succeeds", () => {
  let fail = false;
  const data = new Map();
  return withPage(({ window, avis }) => {
    assert.equal(avis.persistOK(), true);
    fail = true;
    avis.add("#cta", "x");
    assert.equal(avis.persistOK(), false);
    assert.ok(host(window).querySelector(".toolbar").classList.contains("persist-broken"));
    fail = false;
    avis.clear();
    assert.equal(avis.persistOK(), true);
    assert.equal(avis.info().persistOK, true);
    assert.ok(!host(window).querySelector(".toolbar").classList.contains("persist-broken"));
  }, {
    before: (w) => {
      const flaky = {
        getItem: (k) => (data.has(k) ? data.get(k) : null),
        setItem: (k, v) => { if (fail) throw new Error("quota"); data.set(k, String(v)); },
        removeItem: (k) => { data.delete(k); },
      };
      Object.defineProperty(w, "localStorage", { value: flaky, configurable: true });
    },
  });
});

test("stored value always matches annotations after in-place status changes", () =>
  withPage(({ window, avis }) => {
    const ids = ["#title", "#cta", "#note"].map((s) => avis.add(s, "c " + s));
    avis.markWorking(ids[1]);
    assert.equal(window.localStorage.getItem(KEY), JSON.stringify(avis.annotations));
    avis.acknowledge(ids);
    avis.unmarkWorking(ids[0]);
    assert.equal(window.localStorage.getItem(KEY), JSON.stringify(avis.annotations));
  }));

// Map-backed localStorage stand-in that counts writes.
function spyStore() {
  const data = new Map();
  const store = {
    writes: 0,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { store.writes++; data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
  return { store, before: (w) => Object.defineProperty(w, "localStorage", { value: store, configurable: true }) };
}

test("closing a new popup with no text writes nothing", () => {
  const spy = spyStore();
  return withPage(({ window, document }) => {
    const sh = host(window);
    sh.querySelector("[data-act=point]").click();
    document.elementFromPoint = () => document.getElementById("title");
    sh.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true, clientX: 5, clientY: 5 }));
    assert.ok(sh.querySelector(".popup"));
    const before = spy.store.writes;
    document.body.dispatchEvent(new window.PointerEvent("pointerdown", { bubbles: true, composed: true }));
    assert.equal(sh.querySelector(".popup"), null);
    assert.equal(sh.querySelector(".marker.tentative"), null);
    assert.equal(spy.store.writes, before);
  }, { before: spy.before });
});

test("persistOK() probes without rewriting the store or bumping its revision", async () => {
  const stored = JSON.stringify([{ id: "x", comment: "c", url: "http://localhost:3000/a" }, { bogus: 1 }]);
  const { window, avis } = mount({ before: (w) => w.localStorage.setItem("avis:annotations", stored) });
  const rev = window.localStorage.getItem("avis:rev");
  assert.equal(avis.persistOK(), true);
  assert.equal(window.localStorage.getItem("avis:annotations"), stored);
  assert.equal(window.localStorage.getItem("avis:rev"), rev);
  await window.happyDOM.close();
});

test("persist() skips the write when nothing changed", () =>
  withPage(({ window, avis }) => {
    const rev = () => window.localStorage.getItem("avis:rev");
    avis.clear();
    const r = rev();
    avis.clear();
    assert.equal(rev(), r, "second clear left the revision, so other tabs don't wake");
    avis.add("#cta", "x");
    assert.notEqual(rev(), r);
  }));
