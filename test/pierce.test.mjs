import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

async function withPage(html, fn, opts = {}) {
  const m = mount({ html, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

const shadowOf = (document) => document.getElementById("__avis_host").shadowRoot;

// <x-card id="card"> with an open shadow root holding two buttons.
function addCard(document) {
  const card = document.createElement("x-card");
  card.id = "card";
  document.body.appendChild(card);
  const root = card.attachShadow({ mode: "open" });
  root.innerHTML = `<style>.buy { color: #112233 }</style><button class="buy">Buy</button><button class="buy">Gift</button>`;
  return { card, root, gift: root.querySelectorAll("button")[1] };
}

// happy-dom gives frames a document but no frameElement link back.
async function addFrame(window, document) {
  const frame = document.createElement("iframe");
  frame.id = "preview";
  document.body.appendChild(frame);
  await new Promise((r) => setTimeout(r, 20));
  const doc = frame.contentDocument;
  Object.defineProperty(doc.defaultView, "frameElement", { value: frame });
  doc.body.innerHTML = `<main><h1>Title</h1><p class="lede">Hello</p></main>`;
  return { frame, doc };
}

function pickAt(window, document) {
  const sh = shadowOf(document);
  sh.querySelector("[data-act=point]").click();
  const overlay = sh.querySelector(".overlay");
  overlay.dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
  const ta = sh.querySelector(".popup textarea");
  ta.value = "fix";
  ta.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
}

test("getSelector crosses an open shadow root with >>> and resolveTarget follows it", () =>
  withPage("", ({ document, t }) => {
    const { gift } = addCard(document);
    const sel = t.getSelector(gift);
    assert.equal(sel, "#card >>> button.buy:nth-of-type(2)");
    assert.equal(t.resolveTarget(sel), gift);
  }));

test("getSelector crosses a same-origin iframe and resolveTarget follows it", () =>
  withPage("", async ({ window, document, t }) => {
    const { doc } = await addFrame(window, document);
    const p = doc.querySelector("p");
    const sel = t.getSelector(p);
    assert.equal(sel, "#preview >>> p.lede");
    assert.equal(t.resolveTarget(sel), p);
  }));

test("resolveTarget keeps a quoted >>> inside one part", () =>
  withPage(`<button aria-label="a >>> b">x</button>`, ({ document, t }) => {
    const sel = t.getSelector(document.querySelector("button"));
    assert.equal(t.resolveTarget(sel), document.querySelector("button"));
  }));

test("resolveTarget returns null when a part has no inner tree", () =>
  withPage(`<div id="plain"><p>x</p></div>`, ({ t }) => {
    assert.equal(t.resolveTarget("#plain >>> p"), null);
  }));

test("picking descends into a shadow root and keeps the host as parent context", () =>
  withPage("", ({ window, document, avis }) => {
    const { card, root, gift } = addCard(document);
    root.elementsFromPoint = () => [document.getElementById("__avis_host"), gift, card, document.body];
    document.elementsFromPoint = () => [card, document.body];
    pickAt(window, document);
    const [a] = avis.annotations;
    assert.equal(a.elementPath, "#card >>> button.buy:nth-of-type(2)");
    assert.equal(a.text, "Gift");
    assert.equal(a.parentContext.element, "x-card");
  }));

test("picking descends into a same-origin iframe, mapping the point into it", () =>
  withPage("", async ({ window, document, avis }) => {
    const { frame, doc } = await addFrame(window, document);
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 300, height: 200, right: 400, bottom: 250 });
    Object.defineProperty(frame, "offsetWidth", { value: 300 });
    let seen;
    doc.elementFromPoint = (x, y) => { seen = [x, y]; return doc.querySelector("h1"); };
    document.elementsFromPoint = () => [frame, document.body];
    pickAt(window, document);
    assert.deepEqual(seen, [-90, -40]);
    assert.equal(avis.annotations[0].elementPath, "#preview >>> h1");
  }));

test("viewRect offsets a frame's content by the iframe's box", () =>
  withPage("", async ({ window, document, t }) => {
    const { frame, doc } = await addFrame(window, document);
    frame.getBoundingClientRect = () => ({ left: 100, top: 50, width: 600, height: 400 });
    Object.defineProperty(frame, "offsetWidth", { value: 300 });
    const h1 = doc.querySelector("h1");
    h1.getBoundingClientRect = () => ({ left: 10, top: 20, width: 30, height: 40 });
    assert.deepEqual({ ...t.viewRect(h1) }, { left: 120, top: 90, width: 60, height: 80, right: 180, bottom: 170 });
  }));

test("tweak rules read the shadow root's own sheets", () =>
  withPage("", ({ document, t }) => {
    const { root, gift } = addCard(document);
    // happy-dom has no ShadowRoot.styleSheets; browsers list the root's <style> there.
    if (!root.styleSheets) Object.defineProperty(root, "styleSheets", { value: [root.querySelector("style").sheet] });
    const { rules } = t.discoverMatchedRules(gift);
    assert.deepEqual([...rules.map((r) => r.selectorText)], [".buy"]);
  }));
