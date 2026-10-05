import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const HTML = `<h1 id="a">A</h1><h2 id="b">B</h2><h3 id="c">C</h3>`;

// Counts localStorage writes to the annotations key and render() calls.
async function withSpies(fn) {
  const counts = { writes: 0, renders: 0 };
  const m = mount({
    html: HTML,
    before: (w) => {
      const real = w.localStorage;
      const spy = {
        getItem: (k) => real.getItem(k),
        setItem: (k, v) => { if (k === "avis:annotations") counts.writes++; real.setItem(k, v); },
      };
      Object.defineProperty(w, "localStorage", { value: spy, configurable: true });
    },
  });
  // render() rewrites the copy count once per call; markers themselves are reused.
  const count = m.document.getElementById("__avis_host").shadowRoot.querySelector(".copy-count");
  let d = null;
  for (let p = count; p && !(d && d.set); p = Object.getPrototypeOf(p)) d = Object.getOwnPropertyDescriptor(p, "textContent");
  Object.defineProperty(count, "textContent", {
    configurable: true,
    get() { return d.get.call(this); },
    set(v) { counts.renders++; d.set.call(this, v); },
  });
  const ids = ["#a", "#b", "#c"].map((s) => m.avis.add(s, "fix " + s));
  counts.writes = 0; counts.renders = 0;
  try { await fn({ ...m, ids, counts }); } finally { await m.window.happyDOM.close(); }
}

const marker = (document, id) =>
  document.getElementById("__avis_host").shadowRoot.querySelector(`.marker[data-annotation-id="${id}"]`);

test("resolve([ids]) removes all with one write and one render", () =>
  withSpies(({ avis, ids, counts }) => {
    const out = avis.resolve([ids[0], "missing", ids[2]]);
    assert.deepEqual([...out], [true, false, true]);
    assert.deepEqual([...avis.summary().map((s) => s.id)], [ids[1]]);
    assert.equal(counts.writes, 1);
    assert.equal(counts.renders, 1);
  }));

test("dismiss([ids], reason) returns one record per id, one write, one render", () =>
  withSpies(({ avis, ids, counts }) => {
    const out = avis.dismiss([ids[0], ids[1]], "dup");
    assert.deepEqual(JSON.parse(JSON.stringify(out)), [
      { id: ids[0], comment: "fix #a", reason: "dup" },
      { id: ids[1], comment: "fix #b", reason: "dup" },
    ]);
    assert.equal(avis.summary().length, 1);
    assert.equal(counts.writes, 1);
    assert.equal(counts.renders, 1);
  }));

test("markWorking([ids]) sets status and marker class with one write and at most one render", () =>
  withSpies(({ document, avis, ids, counts }) => {
    const out = avis.markWorking(ids);
    assert.deepEqual([...out], [true, true, true]);
    assert.ok(avis.summary().every((s) => s.status === "working"));
    assert.ok(ids.every((id) => marker(document, id).classList.contains("working")));
    assert.equal(counts.writes, 1);
    assert.ok(counts.renders <= 1);
    counts.writes = 0;
    assert.deepEqual([...avis.unmarkWorking([ids[0], ids[1]])], [true, true]);
    assert.deepEqual([...avis.acknowledge([ids[2]])], [true]);
    assert.equal(counts.writes, 2);
    assert.deepEqual([...avis.summary().map((s) => s.status)], ["pending", "pending", "acknowledged"]);
  }));

test("a batch that changes nothing does not write", () =>
  withSpies(({ avis, counts }) => {
    assert.deepEqual([...avis.resolve(["x", "y"])], [false, false]);
    assert.deepEqual([...avis.markWorking([])], []);
    assert.equal(counts.writes, 0);
  }));

test("scalar calls still return a bool / record", () =>
  withSpies(({ avis, ids }) => {
    assert.equal(avis.markWorking(ids[0]), true);
    assert.equal(avis.resolve(ids[0]), true);
    assert.equal(avis.resolve(ids[0]), false);
    assert.equal(avis.dismiss(ids[1]).id, ids[1]);
  }));
