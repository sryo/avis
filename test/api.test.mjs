import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const HTML = `<h1 id="title">Hello</h1><button id="cta">Buy</button><p id="note">fine print</p>`;

async function withPage(fn, opts = {}) {
  const m = mount({ html: HTML, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

const marker = (window, id) =>
  window.document.getElementById("__avis_host").shadowRoot.querySelector(`.marker[data-annotation-id="${id}"]`);

test("add returns an id; rejects missing comment or unresolved selector", () =>
  withPage(({ avis }) => {
    const id = avis.add("#cta", "make it bigger");
    assert.match(id, /^a[0-9a-z]+$/);
    assert.equal(avis.add("#cta", ""), null);
    assert.equal(avis.add("#nope", "x"), null);
    const [s] = avis.summary();
    assert.equal(s.id, id);
    assert.equal(s.comment, "make it bigger");
    assert.equal(s.source, "agent");
    assert.equal(s.elementPath, "#cta");
    assert.equal(s.status, "pending");
  }));

test("status transitions return bool and toggle the marker class", () =>
  withPage(({ window, avis }) => {
    const id = avis.add("#cta", "x");
    assert.equal(avis.markWorking(id), true);
    assert.equal(avis.markWorking(id), false);
    assert.equal(avis.summary()[0].status, "working");
    assert.ok(marker(window, id).classList.contains("working"));
    assert.equal(avis.acknowledge(id), true);
    assert.equal(avis.summary()[0].status, "acknowledged");
    assert.ok(!marker(window, id).classList.contains("working"));
    assert.equal(avis.unmarkWorking(id), true);
    assert.equal(avis.summary()[0].status, "pending");
    assert.equal(avis.markWorking("missing"), false);
  }));

test("resolve / dismiss / clear remove annotations", () =>
  withPage(({ window, avis }) => {
    const a = avis.add("#title", "one");
    const b = avis.add("#cta", "two");
    const c = avis.add("#note", "three");
    assert.equal(avis.resolve(a), true);
    assert.equal(avis.resolve(a), false);
    assert.equal(marker(window, a), null);
    assert.deepEqual({ ...avis.dismiss(b, "by design") }, { id: b, comment: "two", reason: "by design" });
    assert.equal(avis.dismiss(b), false);
    assert.deepEqual([...avis.summary().map((s) => s.id)], [c]);
    avis.clear();
    assert.equal(avis.summary().length, 0);
  }));

test("replyTo threads under an existing annotation", () =>
  withPage(({ avis }) => {
    const a = avis.add("#cta", "q");
    const b = avis.add("#cta", "a", { replyTo: a });
    assert.equal(avis.summary().find((s) => s.id === b).replyTo, a);
  }));

test("annotations persist to localStorage and load on the next mount", async () => {
  let stored;
  await withPage(({ window, avis }) => {
    avis.add("#cta", "persist me");
    stored = window.localStorage.getItem("avis:annotations");
    assert.equal(JSON.parse(stored).length, 1);
  });
  await withPage(({ avis }) => {
    assert.equal(avis.summary()[0].comment, "persist me");
    assert.equal(avis.persistOK(), true);
  }, { before: (w) => w.localStorage.setItem("avis:annotations", stored) });
});

test("persistOK is false when localStorage writes throw", () =>
  withPage(({ avis }) => {
    avis.add("#cta", "x");
    assert.equal(avis.persistOK(), false);
  }, {
    before: (w) => {
      const throwing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
      Object.defineProperty(w, "localStorage", { value: throwing, configurable: true });
    },
  }));

test("reveal is false off-page; pageUrl reflects location", () =>
  withPage(({ avis }) => {
    const id = avis.add("#cta", "x");
    assert.equal(avis.pageUrl, "http://localhost:3000/a");
    assert.equal(avis.reveal(id), true);
    assert.equal(avis.reveal("missing"), false);
  }));

test("markers only render for the current pathname", async () => {
  const other = JSON.stringify([{ id: "aold", comment: "elsewhere", url: "http://localhost:3000/b", elementPath: "#cta" }]);
  await withPage(({ window, avis }) => {
    assert.equal(avis.annotations.length, 1);
    assert.equal(marker(window, "aold"), null);
    assert.equal(avis.reveal("aold"), false);
  }, { before: (w) => w.localStorage.setItem("avis:annotations", other) });
});
