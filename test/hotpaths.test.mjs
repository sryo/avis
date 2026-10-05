// Hot paths: marker rendering and positioning, selector building, the page mousedown
// label and hover hit-testing. These pin observable output while the implementations
// stay cheap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

async function withPage(html, fn, opts = {}) {
  const m = mount({ html, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}
// Waits out rAF-deferred positioning: polls until ok() holds or ~2s pass.
async function until(window, ok) {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => window.setTimeout(r, 10));
}
const shadowOf = (document) => document.getElementById("__avis_host").shadowRoot;
const markers = (document) => [...shadowOf(document).querySelectorAll(".marker")];
const markerFor = (document, id) => shadowOf(document).querySelector(`.marker[data-annotation-id="${id}"]`);
const seed = (list) => (w) => w.localStorage.setItem("avis:annotations", JSON.stringify(list));
const getter = (obj, prop) => {
  for (let p = obj; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, prop);
    if (d && d.get) return d;
  }
  return null;
};

test("an orphaned marker sits at its capture-time page position, following scroll", () =>
  withPage(`<div style="height:4000px"></div>`, async ({ window, document }) => {
    const m = markerFor(document, "o1");
    await until(window, () => m.style.left);
    assert.equal(m.style.left, "129px");
    assert.equal(m.style.top, "239px");
    window.scrollTo(0, 100);
    document.dispatchEvent(new window.Event("scroll"));
    await until(window, () => m.style.top !== "239px");
    assert.equal(m.style.top, Math.round(239 - window.scrollY) + "px");
  }, {
    before: seed([{
      id: "o1", comment: "gone", url: "http://localhost:3000/a", elementPath: "#gone",
      boundingBox: { x: 100, y: 50, width: 40, height: 20 }, viewport: { scrollX: 0, scrollY: 200 },
    }]),
  }));

test("page mousedown records a 40-char text label without reading the whole subtree", () => {
  const words = Array.from({ length: 400 }, (_, i) => `  word${i}\n\t`).join("<span> nested </span>");
  return withPage(`<main id="big">\n   ${words}</main><p id="short">  hi   there </p><div id="empty">  </div>`, ({ window, document, avis }) => {
    const label = (el) => {
      const t = el.textContent.trim().replace(/\s+/g, " ").slice(0, 40);
      return t ? `<${el.tagName.toLowerCase()}> "${t}"` : `<${el.tagName.toLowerCase()}>`;
    };
    const big = document.getElementById("big");
    const expected = ["big", "short", "empty"].map((id) => label(document.getElementById(id)));
    const d = getter(big, "textContent");
    let reads = 0;
    Object.defineProperty(big, "textContent", { configurable: true, get() { reads++; return d.get.call(this); } });
    for (const id of ["big", "short", "empty"]) {
      document.getElementById(id).dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
    }
    assert.equal(reads, 0, "no full textContent read of the clicked element");
    const id = avis.add("#short", "x");
    const clicks = avis.annotations.find((a) => a.id === id).priorClicks.map((c) => c.target);
    assert.deepEqual([...clicks], expected);
  });
});

test("getSelector probes non-unique candidates without materializing every match", () => {
  const list = Array.from({ length: 50 }, (_, i) => `<li>item ${i}</li>`).join("");
  return withPage(`<div><ul>${list}</ul><ul>${list}</ul><ul>${list}</ul></div>`, ({ window, document, t }) => {
    const target = document.querySelectorAll("ul")[1].children[40];
    const qsa = window.document.querySelectorAll;
    let calls = 0;
    document.querySelectorAll = function (...a) { calls++; return qsa.apply(this, a); };
    const sel = t.getSelector(target);
    document.querySelectorAll = qsa;
    assert.equal(sel, "ul:nth-of-type(2) > li:nth-of-type(41)");
    assert.equal(calls, 1, "only the unique candidate is counted in full");
  });
});

test("getSelector(body) is 'body'", () =>
  withPage(`<p>x</p>`, ({ document, t }) => {
    assert.equal(t.getSelector(document.body), "body");
  }));

test("getSelector stays unique past four levels of identical nesting", () => {
  const tree = `<section><div><div><div><div><span>s</span></div></div></div></div></section>`;
  return withPage(tree + tree, ({ document, t }) => {
    const target = document.querySelectorAll("span")[1];
    const sel = t.getSelector(target);
    assert.equal(document.querySelectorAll(sel).length, 1, sel);
    assert.ok(document.querySelector(sel) === target, sel);
  });
});

test("add() keeps existing marker nodes and doesn't re-resolve their targets", () =>
  withPage(`<h1 id="a">A</h1><h2 id="b">B</h2><h3 id="c">C</h3><h4 id="d">D</h4>`, ({ window, document, avis }) => {
    const ids = ["#a", "#b", "#c"].map((s) => avis.add(s, "fix " + s));
    const first = markerFor(document, ids[0]);
    const qs = window.document.querySelector;
    let reresolved = 0;
    document.querySelector = function (...a) { if (["#a", "#b", "#c"].includes(a[0])) reresolved++; return qs.apply(this, a); };
    const id4 = avis.add("#d", "fix #d");
    document.querySelector = qs;
    assert.ok(markerFor(document, ids[0]) === first, "same node");
    assert.equal(reresolved, 0);
    assert.deepEqual(markers(document).map((m) => [m.dataset.annotationId, m.textContent, m.title]),
      [[ids[0], "1", "fix #a"], [ids[1], "2", "fix #b"], [ids[2], "3", "fix #c"], [id4, "4", "fix #d"]]);
  }));

test("render renumbers, reorders and restyles reused markers", () =>
  withPage(`<h1 id="a">A</h1><h2 id="b">B</h2><h3 id="c">C</h3>`, ({ document, avis }) => {
    const ids = ["#a", "#b", "#c"].map((s) => avis.add(s, "fix " + s));
    const b = markerFor(document, ids[1]);
    avis.markWorking(ids[2]);
    avis.resolve(ids[0]);
    assert.ok(markerFor(document, ids[0]) === null);
    assert.ok(markerFor(document, ids[1]) === b, "same node");
    assert.deepEqual(markers(document).map((m) => [m.dataset.annotationId, m.textContent, m.className]),
      [[ids[1], "1", "marker agent"], [ids[2], "2", "marker agent working"]]);
  }));

test("markers on one element stack in order across renders", () =>
  withPage(`<h1 id="a">A</h1>`, ({ document, avis }) => {
    const ids = [avis.add("#a", "one"), avis.add("#a", "two"), avis.add("#a", "three")];
    assert.deepEqual(ids.map((id) => markerFor(document, id)._stackIndex), [0, 1, 2]);
    avis.resolve(ids[0]);
    assert.deepEqual(ids.slice(1).map((id) => markerFor(document, id)._stackIndex), [0, 1]);
  }));

test("a render parses each annotation's url once, not once for the toolbar and again for markers", () => {
  let built = 0;
  return withPage(`<h1 id="a">A</h1>`, ({ document }) => {
    built = 0;
    shadowOf(document).querySelector("[data-act=point]").click();
    assert.equal(built, 3);
  }, {
    before: (w) => {
      seed([1, 2, 3].map((i) => ({ id: "u" + i, comment: "c", url: "http://localhost:3000/a?q=" + i, elementPath: "#a" })))(w);
      const U = w.URL;
      w.URL = class extends U { constructor(...a) { super(...a); built++; } };
    },
  });
});

// elementsFromPoint stand-ins: the document reports the host first while any avis
// chrome sits on top; the shadow root says which piece of chrome that is.
function hitStubs(w, hits) {
  w.document.elementsFromPoint = () => hits.doc();
  w.ShadowRoot.prototype.elementsFromPoint = () => hits.shadow();
}

test("hover and pick see through the overlay to the page element", () => {
  const hits = {};
  return withPage(`<section><button id="cta">Start</button></section>`, ({ window, document, avis }) => {
    const sh = shadowOf(document);
    const host = document.getElementById("__avis_host");
    sh.querySelector("[data-act=point]").click();
    const overlay = sh.querySelector(".overlay");
    hits.doc = () => [host, document.getElementById("cta"), document.body, document.documentElement];
    hits.shadow = () => [overlay];
    overlay.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
    assert.equal(sh.querySelector(".outline").style.display, "block");
    overlay.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    const ta = sh.querySelector(".popup textarea");
    ta.value = "hi";
    ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    assert.equal(avis.summary()[0].elementPath, "#cta");
  }, { before: (w) => hitStubs(w, hits) });
});

test("hovering avis's own toolbar hides the outline instead of boxing the host", () => {
  const hits = {};
  return withPage(`<section><button id="cta">Start</button></section>`, ({ window, document }) => {
    const sh = shadowOf(document);
    const host = document.getElementById("__avis_host");
    sh.querySelector("[data-act=point]").click();
    const overlay = sh.querySelector(".overlay");
    hits.doc = () => [host, document.getElementById("cta"), document.body];
    hits.shadow = () => [overlay];
    overlay.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
    assert.equal(sh.querySelector(".outline").style.display, "block");
    hits.shadow = () => [sh.querySelector(".toolbar")];
    overlay.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 900, clientY: 700 }));
    assert.equal(sh.querySelector(".outline").style.display, "none");
  }, { before: (w) => hitStubs(w, hits) });
});

test("dropping a dragged marker on the toolbar keeps its anchor; on the page re-anchors it", () => {
  const hits = {};
  return withPage(`<h1 id="a">A</h1><h2 id="b">B</h2>`, ({ window, document, avis }) => {
    const sh = shadowOf(document);
    const host = document.getElementById("__avis_host");
    const id = avis.add("#a", "move me");
    const drag = (to) => {
      markerFor(document, id).dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: 0, clientY: 0 }));
      document.dispatchEvent(new window.MouseEvent("mousemove", { clientX: 40, clientY: 40 }));
      hits.doc = to;
      document.dispatchEvent(new window.MouseEvent("mouseup", { clientX: 50, clientY: 50 }));
    };
    hits.shadow = () => [sh.querySelector(".toolbar")];
    hits.doc = () => [host, document.body];
    drag(() => [host, document.body]);
    assert.equal(avis.summary()[0].elementPath, "#a");
    hits.shadow = () => [];
    drag(() => [document.getElementById("b"), document.body]);
    assert.equal(avis.summary()[0].elementPath, "#b");
  }, { before: (w) => hitStubs(w, hits) });
});

test("a marker whose element mounts late moves onto it without a scroll", () => {
  const intervals = [];
  return withPage(`<div id="app"></div>`, async ({ window, document }) => {
    const m = markerFor(document, "late1");
    await until(window, () => m.style.left);
    assert.equal(m.style.left, "129px", "orphan position first");
    const late = document.createElement("div");
    late.id = "late";
    late.getBoundingClientRect = () => ({ left: 150, right: 200, top: 60, bottom: 80, width: 50, height: 20 });
    document.getElementById("app").appendChild(late);
    intervals.find((i) => i.ms === 500).fn();
    await until(window, () => markerFor(document, "late1").style.left === "189px");
    assert.equal(markerFor(document, "late1").style.left, "189px");
    assert.equal(markerFor(document, "late1").style.top, "49px");
  }, {
    before: (w) => {
      seed([{
        id: "late1", comment: "late", url: "http://localhost:3000/a", elementPath: "#late",
        boundingBox: { x: 100, y: 50, width: 40, height: 20 }, viewport: { scrollX: 0, scrollY: 0 },
      }])(w);
      w.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
    },
  });
});
