import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

const HTML = `<div id="a">alpha</div><div id="b">beta</div><div id="q">question</div>`;

async function withUI(opts, fn) {
  let target = null;
  const m = mount({
    html: HTML,
    ...opts,
    before: (w) => {
      w.document.elementFromPoint = () => target || w.document.getElementById("a");
      if (opts.before) opts.before(w);
    },
  });
  const { window, document } = m;
  const shadow = document.getElementById("__avis_host").shadowRoot;
  const errors = [];
  window.addEventListener("error", (e) => errors.push(e.error || e.message));
  const mouse = (node, type, x = 0, y = 0) =>
    node.dispatchEvent(new window.MouseEvent(type, { bubbles: true, composed: true, clientX: x, clientY: y }));
  const key = (node, k, extra = {}) =>
    node.dispatchEvent(new window.KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true, ...extra }));
  const ui = {
    shadow, errors, mouse, key,
    pointAt(id) { target = id ? document.getElementById(id) : null; },
    marker: (id) => shadow.querySelector(`.marker[data-annotation-id="${id}"]`),
    pick() {
      shadow.querySelector("[data-act=point]").click();
      shadow.querySelector(".overlay").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
    },
  };
  try { await fn({ ...m, ui }); } finally { await window.happyDOM.close(); }
}

test("dragging a marker onto another element keeps source, replyTo, status and styleTweaks", () =>
  withUI({}, ({ avis, ui }) => {
    const q = avis.add("#q", "which one?");
    const id = avis.add("#a", "agent reply", { replyTo: q });
    avis.markWorking(id);
    const tweaks = [{ selector: "#a", source: "inline", property: "color", before: "red", after: "blue" }];
    avis.annotations.find((a) => a.id === id).styleTweaks = tweaks;
    ui.mouse(ui.marker(id), "mousedown", 0, 0);
    ui.pointAt("b");
    ui.mouse(document(ui), "mousemove", 40, 40);
    ui.mouse(document(ui), "mouseup", 40, 40);
    const a = avis.annotations.find((x) => x.id === id);
    assert.equal(a.elementPath, "#b");
    assert.equal(a.source, "agent");
    assert.equal(a.replyTo, q);
    assert.equal(a.status, "working");
    assert.deepEqual(a.styleTweaks, tweaks);
    assert.ok(ui.marker(id).classList.contains("agent"));
  }));

const document = (ui) => ui.shadow.host.ownerDocument;

test("Escape that closes the popup or exits point mode does not reach page listeners", () =>
  withUI({}, ({ window, ui }) => {
    let pageSaw = 0;
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") pageSaw++; });
    ui.pick();
    ui.key(ui.shadow.querySelector(".popup textarea"), "Escape");
    assert.equal(ui.shadow.querySelector(".popup"), null, "popup closed");
    assert.equal(pageSaw, 0, "page did not see the popup Escape");
    ui.key(document(ui).body, "Escape");
    assert.equal(ui.shadow.querySelector(".overlay"), null, "point mode exited");
    assert.equal(pageSaw, 0, "page did not see the point-mode Escape");
    ui.key(document(ui).body, "Escape");
    assert.equal(pageSaw, 1, "Escape avis does not consume reaches the page");
  }));

test("Escape during a marker drag cancels the drag and stays in point mode", () =>
  withUI({}, ({ avis, ui }) => {
    const id = avis.add("#a", "note");
    ui.shadow.querySelector("[data-act=point]").click();
    ui.mouse(ui.marker(id), "mousedown", 0, 0);
    ui.mouse(document(ui), "mousemove", 50, 50);
    assert.ok(ui.shadow.querySelector(".marker.dragging"), "dragging");
    ui.key(document(ui).body, "Escape");
    assert.equal(ui.shadow.querySelector(".marker.dragging"), null, "drag cancelled");
    assert.ok(ui.shadow.querySelector(".overlay"), "still pointing");
  }));

test("closing the popup mid label-drag detaches the drag listeners without errors", () =>
  withUI({}, ({ ui }) => {
    ui.pick();
    ui.mouse(ui.shadow.querySelector(".popup .label"), "mousedown", 5, 5);
    ui.key(ui.shadow.querySelector(".popup textarea"), "Escape");
    const doc = document(ui);
    ui.mouse(doc, "mousemove", 30, 30);
    ui.mouse(doc, "mouseup", 30, 30);
    ui.mouse(doc, "mouseup", 30, 30);
    assert.deepEqual(ui.errors, []);
  }));

test("a reply to an agent annotation whose element is gone is still saved", () =>
  withUI({}, ({ avis, ui }) => {
    const parent = avis.add("#a", "agent note");
    document(ui).getElementById("a").remove();
    const m = ui.marker(parent);
    ui.mouse(m, "mousedown", 0, 0);
    ui.mouse(document(ui), "mouseup", 0, 0);
    const ta = ui.shadow.querySelector(".popup textarea");
    assert.ok(ta, "reply popup open");
    ta.value = "my reply";
    ui.key(ta, "Enter", { metaKey: true });
    const reply = avis.summary().find((s) => s.comment === "my reply");
    assert.ok(reply, "reply saved");
    assert.equal(reply.source, "user");
    assert.equal(reply.replyTo, parent);
    assert.equal(reply.elementPath, "#a");
  }));

const OFFPAGE = [{ id: "x1", comment: "elsewhere", source: "user", elementPath: "#b", url: "http://localhost:3000/b" }];

test("copy counts, enables and copies every page's annotations", () =>
  withUI({
    before: (w) => {
      w.localStorage.setItem("avis:annotations", JSON.stringify(OFFPAGE));
      w.__copied = [];
      Object.defineProperty(w.navigator, "clipboard", { value: { writeText: async (s) => { w.__copied.push(s); } }, configurable: true });
    },
  }, async ({ window, avis, ui }) => {
    const btn = ui.shadow.querySelector("[data-act=copy]");
    const count = ui.shadow.querySelector(".copy-count");
    assert.equal(btn.disabled, false, "enabled with only off-page annotations");
    assert.equal(count.textContent, "1");
    avis.add("#a", "here");
    assert.equal(count.textContent, "2");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(JSON.parse(window.__copied[0]).length, Number(count.textContent));
  }));

test("acknowledged markers get a distinct class that clears on the next status", () =>
  withUI({}, ({ avis, ui }) => {
    const id = avis.add("#a", "note");
    avis.acknowledge(id);
    assert.ok(ui.marker(id).classList.contains("acknowledged"));
    avis.markWorking(id);
    assert.equal(ui.marker(id).classList.contains("acknowledged"), false);
    assert.ok(ui.marker(id).classList.contains("working"));
    avis.acknowledge(id);
    avis.reveal(id);
    avis.add("#b", "re-render");
    assert.ok(ui.marker(id).classList.contains("acknowledged"), "renderMarkers keeps it");
  }));
