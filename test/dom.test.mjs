import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

async function withPage(html, fn, opts = {}) {
  const m = mount({ html, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

test("getSelector round-trips to the same element", () =>
  withPage(`
    <button data-testid="save">Save</button>
    <a data-test="home" href="/">Home</a>
    <div id="main"><p>one</p><p class="lead intro">two</p></div>
    <nav><button aria-label="Close menu">x</button></nav>
    <ul><li>a</li><li>b</li><li>c</li></ul>
  `, ({ document, t }) => {
    const cases = [
      ["[data-testid=save]", '[data-testid="save"]'],
      ["[data-test=home]", '[data-test="home"]'],
      ["#main", "#main"],
      ["button[aria-label]", 'button[aria-label="Close menu"]'],
      ["p.lead", null],
      ["li:nth-child(2)", null],
    ];
    for (const [q, expected] of cases) {
      const el = document.querySelector(q);
      const sel = t.getSelector(el);
      if (expected) assert.equal(sel, expected);
      assert.equal(document.querySelector(sel), el, `${q} -> ${sel}`);
    }
  }));

test("a11y lists role, label, name, placeholder, type", () =>
  withPage(`<input role="searchbox" aria-label="Find" name="q" placeholder="Search…" type="search">`, ({ document, t }) => {
    assert.equal(t.a11y(document.querySelector("input")),
      'role=searchbox aria-label="Find" name=q placeholder="Search…" type=search');
  }));

test("nearbyText returns the parent's text when it differs", () =>
  withPage(`<div class="card"><h2>Pricing</h2><span>per month</span></div>`, ({ document, t }) => {
    const span = document.querySelector("span");
    assert.match(t.nearbyText(span), /Pricing/);
    assert.ok(t.nearbyText(span).length <= 80);
  }));

test("nearbyText is empty when the parent adds no text", () =>
  withPage(`<p><b>only</b></p>`, ({ document, t }) => {
    assert.equal(t.nearbyText(document.querySelector("b")), "");
  }));

test("getReactInfo walks a fake fiber: skips host/minified nodes, finds _debugSource", () =>
  withPage(`<main><div id="leaf">hi</div></main>`, ({ document, t }) => {
    const main = document.querySelector("main");
    main["__reactFiber$abc"] = {
      tag: 5, type: "main",
      return: {
        tag: 0, type: { name: "NavItem" }, _debugSource: { fileName: "src/Nav.tsx", lineNumber: 12 },
        return: {
          tag: 0, type: { name: "xy" },
          return: {
            tag: 0, type: { name: "Layout" },
            return: { tag: 10, type: { name: "Provider" }, return: { tag: 1, type: { displayName: "App" }, return: null } },
          },
        },
      },
    };
    const info = t.getReactInfo(document.getElementById("leaf"));
    assert.equal(info.componentPath, "<App> <Layout> <NavItem>");
    assert.deepEqual({ ...info.source }, { fileName: "src/Nav.tsx", lineNumber: 12 });
    assert.equal(t.getReactInfo(document.body), null);
  }));

test("discoverMatchedRules: default-state author rules + inline, skips pseudo and non-matching media", () =>
  withPage(`<div class="card" style="opacity: 0.5">x</div>`, ({ document, t }) => {
    const style = document.createElement("style");
    style.textContent = `.card { color: #ff0000 } .card:hover { color: blue } .other, .card { margin: 4px }
      @media (min-width: 1px) { .card { gap: 2px } } @media (max-width: 0px) { .card { gap: 9px } }`;
    document.head.appendChild(style);
    const { rules, unreadable } = t.discoverMatchedRules(document.querySelector(".card"));
    assert.equal(unreadable, 0);
    assert.deepEqual([...rules.map((r) => r.selectorText)], [".card", ".other, .card", ".card", "(inline)"]);
  }));
