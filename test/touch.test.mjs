import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const HTML = `<section id="card"><h2>Plans</h2><button id="cta">Start</button></section>`;

async function withPick(fn, opts = {}) {
  const m = mount({
    html: HTML,
    ...opts,
    before: (w) => {
      w.document.elementsFromPoint = () => [w.document.getElementById("cta")];
      if (opts.before) opts.before(w);
    },
  });
  const { window, document } = m;
  const shadow = document.getElementById("__avis_host").shadowRoot;
  shadow.querySelector("[data-act=point]").click();
  shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
  const q = (s) => shadow.querySelector(s);
  try { await fn({ ...m, shadow, q }); } finally { await window.happyDOM.close(); }
}

test("the save button commits the popup", () =>
  withPick(({ avis, q }) => {
    q(".popup textarea").value = "bigger";
    q(".popup .save").click();
    assert.equal(q(".popup"), null);
    assert.equal(avis.annotations[0].comment, "bigger");
  }));

test("the discard button closes without saving and stays in point mode", () =>
  withPick(({ avis, q }) => {
    q(".popup textarea").value = "bigger";
    q(".popup .discard").click();
    assert.equal(q(".popup"), null);
    assert.equal(avis.annotations.length, 0);
    assert.ok(q(".overlay"));
  }));

test("parent widens the pick to the parent element and keeps the draft", () =>
  withPick(({ avis, q }) => {
    q(".popup textarea").value = "move this";
    q(".popup .up").click();
    assert.match(q(".popup .label").textContent, /section/);
    assert.equal(q(".popup textarea").value, "move this");
    // body is the last parent, so section's popup offers none.
    assert.equal(q(".popup .up"), null);
    q(".popup .save").click();
    assert.equal(avis.annotations[0].elementPath, "#card");
  }));

test("client.pointer reports coarse on a touch device", () =>
  withPick(({ avis, q }) => {
    q(".popup textarea").value = "x";
    q(".popup .save").click();
    assert.equal(avis.annotations[0].client.pointer, "coarse");
  }, {
    before: (w) => {
      const mm = w.matchMedia.bind(w);
      w.matchMedia = (s) => (s === "(pointer: coarse)" ? { matches: true } : mm(s));
    },
  }));

test("the popup slides up when the keyboard shrinks the visual viewport under it", () => {
  let vv;
  return withPick(({ window, q }) => {
    const popup = q(".popup");
    popup.style.top = "500px";
    popup.getBoundingClientRect = () => ({ top: 500, bottom: 640, left: 20, right: 280, width: 260, height: 140 });
    vv.height = 400;
    vv.dispatchEvent(new window.Event("resize"));
    assert.equal(popup.style.top, "252px");
  }, {
    before: (w) => {
      vv = Object.assign(new w.EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 375, height: 800 });
      Object.defineProperty(w, "visualViewport", { value: vv, configurable: true });
    },
  });
});
