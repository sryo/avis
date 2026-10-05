// Benchmark suite for toolbar.js, run inside a real browser page by scripts/bench.mjs.
// Each rep mounts avis into a fresh same-origin iframe holding a generated fixture,
// with requestAnimationFrame captured so deferred marker positioning is timed too.
// window.runSuite([src...], reps) resolves to {op: [{ms:[...], bytes?} per src]}.

(function () {
  const W = 1280, H = 800;

  // Deterministic PRNG so every run builds the same page.
  function rng(seed) {
    return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  // ~3500 elements, 2000 author rules (mostly non-matching), a few media blocks.
  function buildFixture(doc) {
    const rand = rng(7);
    const words = "river path closed water drops crews reopen week weather north gate volunteers gloves hat tools trail bank".split(" ");
    const text = (n) => Array.from({ length: n }, () => words[(rand() * words.length) | 0]).join(" ");
    const css = [];
    for (let i = 0; i < 1800; i++) css.push(`.x${i} .y${i % 37} { color: #${(i * 2654435761 >>> 8).toString(16).padStart(6, "0").slice(0, 6)}; padding: ${i % 9}px; }`);
    css.push(".card { padding: 8px 12px; margin: 0 0 8px; border-radius: 6px; background-color: #fafafa; }");
    css.push(".card h3 { font-size: 16px; line-height: 1.3; color: rgb(20, 20, 20); }");
    css.push(".card p { margin: 4px 0; opacity: 0.9; }");
    css.push(".card li { padding-top: 2px; padding-right: 4px; padding-bottom: 2px; padding-left: 4px; }");
    css.push(".card button, .card a { border-width: 1px; font-weight: 600; }");
    for (let i = 0; i < 150; i++) css.push(`@media (min-width: ${300 + i}px) { .card.c${i % 7} { margin-bottom: ${i % 5}px; } }`);
    for (let i = 0; i < 50; i++) css.push(`.card:hover .z${i}, .card:focus-within .z${i} { color: red; }`);
    const style = doc.createElement("style");
    style.textContent = css.join("\n");
    doc.head.appendChild(style);
    const main = doc.createElement("main");
    let html = "";
    for (let s = 0; s < 12; s++) {
      html += `<section class="sec s${s}"><h2>Section ${s}</h2>`;
      for (let c = 0; c < 25; c++) {
        const id = s * 25 + c;
        html += `<article class="card c${id % 7}"${id % 10 === 0 ? ` data-testid="card-${id}"` : ""}>`
          + `<h3>${text(3)}</h3><p>${text(18)}</p><ul>`
          + Array.from({ length: 5 }, () => `<li><span>${text(2)}</span> ${text(4)}</li>`).join("")
          + `</ul><button aria-label="Open ${id}">open</button><a href="#a${id}">more</a></article>`;
      }
      html += "</section>";
    }
    main.innerHTML = html;
    doc.body.appendChild(main);
  }

  function frame() {
    const f = document.createElement("iframe");
    f.style.cssText = `width:${W}px;height:${H}px;border:0;position:absolute;left:0;top:0`;
    document.body.appendChild(f);
    const win = f.contentWindow, doc = f.contentDocument;
    doc.open(); doc.write("<!doctype html><html><head><title>avis bench</title></head><body></body></html>"); doc.close();
    buildFixture(doc);
    win.localStorage.clear();
    const queue = [];
    win.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
    win.__flushRAF = () => { while (queue.length) queue.splice(0).forEach((cb) => cb(performance.now())); };
    win.__AVIS_TEST__ = true;
    // No-op sinks: the console op times avis's wrapper, not the browser's console.
    for (const lvl of ["log", "warn", "error"]) win.console[lvl] = function () {};
    return { f, win, doc };
  }

  // A unique trailing comment per eval defeats V8's compile cache, so every rep
  // parses and compiles toolbar.js cold, as a fresh inject into a page does.
  let evalSeq = 0;
  const cold = (src) => src + "\n//" + (++evalSeq);

  function mount(src) {
    const env = frame();
    env.win.eval(cold(src));
    env.win.__flushRAF();
    env.avis = env.win.__avis;
    env.t = env.avis._t;
    return env;
  }

  const time = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  const center = (el) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
  const mouse = (win, target, type, p, extra = {}) =>
    target.dispatchEvent(new win.MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: p.x, clientY: p.y, ...extra }));

  function addMany(env, n) {
    const lis = env.doc.querySelectorAll("li");
    for (let i = 0; i < n; i++) env.avis.add(lis[(i * 37) % lis.length], "note " + i + " " + "x".repeat(40));
    env.win.__flushRAF();
  }

  // Each op returns {ms} or {ms, bytes}; the env is torn down after.
  const OPS = {
    "mount": (src) => {
      const env = frame();
      env.doc.body.getBoundingClientRect();
      // Includes the toolbar's first style recalc and layout, which a real page pays on the next frame.
      const ms = time(() => {
        env.win.eval(cold(src));
        env.win.__flushRAF();
        env.doc.getElementById("__avis_host").shadowRoot.querySelector(".toolbar").getBoundingClientRect();
      });
      return { env, ms };
    },
    "reinject (no-op)": (src) => {
      const env = mount(src);
      return { env, ms: time(() => env.win.eval(cold(src))) };
    },
    "getSelector x200": (src) => {
      const env = mount(src);
      const els = [...env.doc.querySelectorAll("li span, p, button, h3")].filter((_, i) => i % 13 === 0).slice(0, 200);
      return { env, ms: time(() => els.forEach((el) => env.t.getSelector(el))) };
    },
    "capture x50": (src) => {
      const env = mount(src);
      const els = [...env.doc.querySelectorAll("li")].filter((_, i) => i % 29 === 0).slice(0, 50);
      for (let i = 0; i < 30; i++) env.win.console.warn("warning " + i, { i, list: [1, 2, 3] });
      return { env, ms: time(() => els.forEach((el) => env.t.capture(el, "c"))) };
    },
    "add x100 (+render)": (src) => {
      const env = mount(src);
      return { env, ms: time(() => addMany(env, 100)) };
    },
    "summary() x20 @100": (src) => {
      const env = mount(src);
      addMany(env, 100);
      let out;
      const ms = time(() => { for (let i = 0; i < 20; i++) out = env.avis.summary(); });
      return { env, ms, bytes: JSON.stringify(out).length };
    },
    "storage bytes @100": (src) => {
      const env = mount(src);
      addMany(env, 100);
      return { env, ms: 0, bytes: (env.win.localStorage.getItem("avis:annotations") || "").length };
    },
    "markWorking+unmark @100": (src) => {
      const env = mount(src);
      addMany(env, 100);
      const ids = env.avis.annotations.map((a) => a.id);
      return { env, ms: time(() => { env.avis.markWorking(ids); env.avis.unmarkWorking(ids); }) };
    },
    "resolve x100 one by one": (src) => {
      const env = mount(src);
      addMany(env, 100);
      const ids = env.avis.annotations.map((a) => a.id);
      return { env, ms: time(() => { ids.forEach((id) => env.avis.resolve(id)); env.win.__flushRAF(); }) };
    },
    "scroll reposition @100": (src) => {
      const env = mount(src);
      addMany(env, 100);
      return {
        env, ms: time(() => {
          for (let i = 0; i < 20; i++) {
            env.win.scrollTo(0, i * 50);
            env.doc.dispatchEvent(new env.win.Event("scroll"));
            env.win.__flushRAF();
          }
        }),
      };
    },
    "scroll reposition @100 orphans": (src) => {
      const env = mount(src);
      addMany(env, 100);
      env.doc.querySelectorAll("li").forEach((li) => li.remove());
      env.win.__flushRAF();
      return {
        env, ms: time(() => {
          for (let i = 0; i < 20; i++) {
            env.win.scrollTo(0, i * 50);
            env.doc.dispatchEvent(new env.win.Event("scroll"));
            env.win.__flushRAF();
          }
        }),
      };
    },
    "discoverMatchedRules x20": (src) => {
      const env = mount(src);
      const els = [...env.doc.querySelectorAll(".card li")].slice(0, 20);
      return { env, ms: time(() => els.forEach((el) => env.t.discoverMatchedRules(el))) };
    },
    "open popup x10": (src) => {
      const env = mount(src);
      const sh = env.doc.getElementById("__avis_host").shadowRoot;
      sh.querySelector("[data-act=point]").click();
      const overlay = sh.querySelector(".overlay");
      const targets = [...env.doc.querySelectorAll(".card li")].slice(0, 10).map(center);
      const esc = () => env.doc.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return {
        env, ms: time(() => targets.forEach((p) => { mouse(env.win, overlay, "click", p); env.win.__flushRAF(); esc(); env.win.__flushRAF(); })),
      };
    },
    "hover x300": (src) => {
      const env = mount(src);
      const sh = env.doc.getElementById("__avis_host").shadowRoot;
      sh.querySelector("[data-act=point]").click();
      const overlay = sh.querySelector(".overlay");
      return {
        env, ms: time(() => { for (let i = 0; i < 300; i++) mouse(env.win, overlay, "mousemove", { x: 20 + (i * 53) % 1200, y: 20 + (i * 31) % 700 }); }),
      };
    },
    "page mousedown x300": (src) => {
      const env = mount(src);
      const targets = [env.doc.querySelector("main"), ...env.doc.querySelectorAll("section")].slice(0, 6);
      return {
        env, ms: time(() => { for (let i = 0; i < 300; i++) mouse(env.win, targets[i % targets.length], "mousedown", { x: 5, y: 5 }); }),
      };
    },
    "console.warn x2000 (obj)": (src) => {
      const env = mount(src);
      const payload = { user: { id: 1, name: "ada", roles: ["a", "b"] }, items: Array.from({ length: 50 }, (_, i) => ({ i })) };
      return { env, ms: time(() => { for (let i = 0; i < 2000; i++) env.win.console.warn("evt", i, payload); }) };
    },
  };

  // srcs: one or more toolbar.js sources. Reps interleave them (A B, B A, ...) so machine
  // noise lands on every source alike and A/B ratios stay meaningful.
  window.runSuite = async function (srcs, reps = 15, only) {
    const out = {};
    const unknown = (only || []).filter((n) => !(n in OPS));
    if (unknown.length) throw new Error("unknown op(s): " + unknown.join(", ") + "; known: " + Object.keys(OPS).join(" | "));
    const names = Object.keys(OPS).filter((n) => !only || only.includes(n));
    for (const name of names) {
      const per = srcs.map(() => ({ ms: [], bytes: undefined }));
      let error = null;
      // Rep 0 is a warm-up so JIT state is comparable across ops and sources.
      for (let r = 0; r <= reps && !error; r++) {
        const order = srcs.map((_, i) => i);
        if (r % 2) order.reverse();
        for (const i of order) {
          let res;
          try { res = OPS[name](srcs[i]); }
          catch (e) { error = `src ${i}: ` + String(e && e.stack || e); break; }
          if (r > 0) per[i].ms.push(res.ms);
          if (res.bytes != null) per[i].bytes = res.bytes;
          res.env.f.remove();
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      out[name] = error ? { error } : per.map((p) => (p.bytes == null ? { ms: p.ms } : p));
    }
    return out;
  };
})();
