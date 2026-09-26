import { test } from "node:test";
import assert from "node:assert/strict";
import { mount } from "./_mount.mjs";

async function withPage(fn, opts = {}) {
  const m = mount({ html: `<button id="cta">Go</button>`, ...opts });
  try { await fn(m); } finally { await m.window.happyDOM.close(); }
}

// Proxy that counts property reads (get traps) on itself and every nested object.
function counted(target, counter) {
  return new Proxy(target, {
    get(t, k, r) {
      counter.reads++;
      const v = Reflect.get(t, k, r);
      return v && typeof v === "object" ? counted(v, counter) : v;
    },
  });
}

test("serializer keeps small values as JSON", () =>
  withPage(({ t }) => {
    assert.equal(t.serializeConsoleArg("hi"), "hi");
    assert.equal(t.serializeConsoleArg(3), "3");
    assert.equal(t.serializeConsoleArg(null), "null");
    assert.equal(t.serializeConsoleArg(undefined), "undefined");
    assert.equal(t.serializeConsoleArg({ status: 200, ms: 84 }), '{"status":200,"ms":84}');
    assert.equal(t.serializeConsoleArg([1, "a", { b: true }]), '[1,"a",{"b":true}]');
    assert.equal(t.serializeConsoleArg(new Error("boom")), "boom");
  }));

test("serializer reads at most 64 properties of a huge object", () =>
  withPage(({ t }) => {
    const wide = {};
    for (let i = 0; i < 10_000; i++) wide["k" + i] = { i, nested: { deep: [i, i, i] } };
    const counter = { reads: 0 };
    const out = t.serializeConsoleArg(counted(wide, counter));
    assert.ok(counter.reads <= 64, `reads=${counter.reads}`);
    assert.ok(out.length <= 201);
    assert.ok(out.endsWith("…"));
  }));

test("serializer caps output at 200 chars plus an ellipsis", () =>
  withPage(({ t }) => {
    const long = t.serializeConsoleArg({ text: "x".repeat(5000) });
    assert.equal(long.length, 201);
    assert.ok(long.endsWith("…"));
    const str = t.serializeConsoleArg("y".repeat(5000));
    assert.equal(str.length, 201);
  }));

test("serializer survives cycles and throwing getters", () =>
  withPage(({ t }) => {
    const a = { name: "a" };
    a.self = a;
    assert.match(t.serializeConsoleArg(a), /^\{"name":"a","self":/);
    const bad = { ok: 1, get boom() { throw new Error("nope"); } };
    assert.match(t.serializeConsoleArg(bad), /^\{"ok":1,"boom":/);
  }));

test("console entries stay bounded when the page logs a huge object", () =>
  withPage(({ window, avis }) => {
    const big = {};
    for (let i = 0; i < 5000; i++) big["k" + i] = "v".repeat(50);
    window.console.log("state", big);
    avis.add("#cta", "x");
    const [s] = JSON.parse(JSON.stringify(avis.summary({ console: true })));
    const entry = s.consoleLog.find((e) => e.msg.startsWith("state"));
    assert.ok(entry.msg.length <= "state ".length + 201);
  }));

test("avis's own [avis] logs reach the page console but not the capture buffer", () => {
  const seen = [];
  return withPage(({ window, avis }) => {
    const id = avis.add("#cta", "first");
    avis.dismiss(id, "dup");
    window.console.log("page log");
    avis.add("#cta", "second");
    const [s] = JSON.parse(JSON.stringify(avis.summary({ console: true })));
    assert.deepEqual(s.consoleLog.map((e) => e.msg), ["page log"]);
    assert.ok(seen.some((m) => m.startsWith("[avis] toolbar installed")));
    assert.ok(seen.some((m) => m.startsWith("[avis] dismissed")));
  }, {
    before: (w) => {
      const orig = w.console.log;
      w.console.log = function (...args) { seen.push(String(args[0])); return orig.apply(this, args); };
    },
  });
});
