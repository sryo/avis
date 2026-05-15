// avis — feedback toolbar. Injected onto any page; exposes annotations on
// window.__avis for an AI agent to read back, edit, and reply to.

(function () {
  if (window.__avis || document.getElementById("__avis_host")) return;

  const STORAGE_KEY = "avis:annotations";
  const CONSOLE_BUFFER_MAX = 200;
  const CONSOLE_WINDOW_MS = 60_000;
  const CONSOLE_LOG_PER_ANNOTATION = 20;

  // Fields exposed via window.__avis.summary(). Source of truth — SKILL.md mirrors this list.
  const SUMMARY_FIELDS = [
    "id", "comment", "source", "replyTo",
    "sourceFile", "reactComponents",
    "element", "elementPath", "text", "nearbyText",
    "parentContext", "consoleLog", "url",
  ];

  // Ring buffer of recent console.* output, sliced into each annotation at capture.
  const consoleBuffer = [];
  function serializeConsoleArg(a) {
    if (a == null) return String(a);
    const t = typeof a;
    if (t === "string") return a;
    if (t === "number" || t === "boolean") return String(a);
    if (a instanceof Error) return a.message;
    try {
      const s = JSON.stringify(a);
      return s == null ? "[unserializable]" : (s.length > 200 ? s.slice(0, 200) + "…" : s);
    } catch { return "[unserializable]"; }
  }
  // log/warn/error only — debug/info on chatty pages would dominate the buffer.
  for (const lvl of ["log", "warn", "error"]) {
    const orig = console[lvl];
    if (typeof orig !== "function") continue;
    console[lvl] = function (...args) {
      try {
        consoleBuffer.push({ level: lvl, ts: Date.now(), msg: args.map(serializeConsoleArg).join(" ") });
        if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
      } catch {}
      return orig.apply(console, args);
    };
  }
  const state = {
    annotations: load(),
    pointing: false,
  };

  const workingIds = new Set();

  const findAnnotation = (id) => state.annotations.find((a) => a.id === id);
  const findAnnotationIndex = (id) => state.annotations.findIndex((a) => a.id === id);
  const resolveTarget = (path) => {
    if (!path) return null;
    try { return document.querySelector(path); } catch { return null; }
  };

  window.__avis = {
    get annotations() { return state.annotations.slice(); },
    get pageUrl() { return location.href; },
    // Use this in javascript_tool to dodge the chrome bridge's content filter on large payloads.
    summary() {
      return state.annotations.map((a) =>
        Object.fromEntries(SUMMARY_FIELDS.map((k) => [k, a[k]]))
      );
    },
    reveal(id) {
      const a = findAnnotation(id);
      if (!a || !isCurrentPage(a)) return false;
      const el = resolveTarget(a.elementPath);
      if (el) {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } else {
        const absY = a.boundingBox.y + a.viewport.scrollY;
        window.scrollTo({ top: Math.max(0, absY - 100), behavior: "smooth" });
      }
      const m = markerLayer.querySelector(`.marker[data-annotation-id="${id}"]`);
      if (m) {
        m.classList.add("revealing");
        setTimeout(() => m.classList.remove("revealing"), 800);
      }
      return true;
    },
    // Surgical: avoid a full render() — the skill calls markWorking/resolve
    // per annotation in a tight loop, and render() is O(N) per call.
    markWorking(id) {
      if (!findAnnotation(id) || workingIds.has(id)) return false;
      workingIds.add(id);
      const m = markerLayer.querySelector(`.marker[data-annotation-id="${id}"]`);
      if (m) m.classList.add("working");
      return true;
    },
    unmarkWorking(id) {
      if (!workingIds.delete(id)) return false;
      const m = markerLayer.querySelector(`.marker[data-annotation-id="${id}"]`);
      if (m) m.classList.remove("working");
      return true;
    },
    resolve(id) {
      const i = findAnnotationIndex(id);
      if (i === -1) return false;
      state.annotations.splice(i, 1);
      workingIds.delete(id);
      persist();
      render();
      return true;
    },
    add(selectorOrEl, comment, opts = {}) {
      if (!comment) return null;
      const el = typeof selectorOrEl === "string" ? resolveTarget(selectorOrEl) : selectorOrEl;
      if (!el || el.nodeType !== 1) return null;
      const a = capture(el, comment, { source: "agent", replyTo: opts.replyTo || null });
      state.annotations.push(a);
      persist();
      render();
      return a.id;
    },
    clear() {
      state.annotations = [];
      workingIds.clear();
      persist();
      render();
    },
    persistOK() { return !persistBroken; },
  };

  function isCurrentPage(a) {
    if (!a || !a.url) return false;
    try { return new URL(a.url).pathname === location.pathname; }
    catch { return false; }
  }

  function currentPageAnnotations() {
    return state.annotations.filter(isCurrentPage);
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
    catch { return []; }
  }
  let persistBroken = false;
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.annotations)); }
    catch (e) {
      if (!persistBroken) console.warn("[avis] persist failed — annotations won't survive a reload.", e);
      persistBroken = true;
      const tb = typeof shadow !== "undefined" && shadow.querySelector(".toolbar");
      if (tb) tb.classList.add("persist-broken");
    }
  }

  function getFiberKey(el) {
    for (const k in el) {
      if (k.startsWith("__reactFiber$")) return k;
    }
    return null;
  }

  // React fiber tags we want to skip when collecting component names.
  // HostComponent (5), HostText (6), HostHoistable (26), HostSingleton (27) = DOM nodes.
  // Fragment/Mode/Profiler/Suspense/Context/etc = internal wrappers.
  const SKIP_TAGS = new Set([3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 18, 19, 21, 22, 23, 24, 25, 26, 27]);
  const SKIP_NAMES = /^(Provider|Consumer|.+Boundary|.+Router|Outlet|Fragment|Suspense|Hot|Hot.*Reload|.*Overlay|.*Handler|Root|.*Wrapper|StrictMode|Profiler)$/;

  function isMinified(name) {
    if (!name) return true;
    if (name.length <= 2) return true;
    if (name.length <= 3 && name === name.toLowerCase()) return true;
    return false;
  }

  function getReactInfo(el) {
    // Walk up the DOM until we find a React fiber. SSR nodes (Next.js RSC,
    // Astro islands, etc.) have no fiber — their nearest hydrated parent does.
    let node = el;
    let key = getFiberKey(node);
    while (!key && node && node.parentElement) {
      node = node.parentElement;
      key = getFiberKey(node);
    }
    if (!key) return null;
    let fiber = node[key];
    let source = null;
    const components = [];
    let depth = 0;
    while (fiber && depth < 30 && components.length < 6) {
      if (!source) {
        const s = fiber._debugSource || (fiber._debugOwner && fiber._debugOwner._debugSource);
        if (s && s.fileName && s.lineNumber) {
          source = { fileName: s.fileName, lineNumber: s.lineNumber };
        }
      }
      if (!SKIP_TAGS.has(fiber.tag)) {
        const t = fiber.type || fiber.elementType;
        let name = null;
        if (t) name = t.displayName || t.name || null;
        if (name && !isMinified(name) && !SKIP_NAMES.test(name)) {
          if (components[components.length - 1] !== name) components.push(name);
        }
      }
      fiber = fiber.return;
      depth++;
    }
    return {
      source,
      componentPath: components.length
        ? components.slice().reverse().map((c) => `<${c}>`).join(" ")
        : null,
    };
  }

  const isUnique = (sel, el) => {
    try {
      const matches = document.querySelectorAll(sel);
      return matches.length === 1 && matches[0] === el;
    } catch { return false; }
  };

  function getSelector(el) {
    // Prefer stable test/aria/id attrs; each candidate must uniquely identify el.
    // JSON.stringify on attr values handles the `\` and `"` escapes correctly for [attr="..."].
    const testid = el.getAttribute("data-testid");
    if (testid) {
      const sel = `[data-testid=${JSON.stringify(testid)}]`;
      if (isUnique(sel, el)) return sel;
    }
    const test = el.getAttribute("data-test");
    if (test) {
      const sel = `[data-test=${JSON.stringify(test)}]`;
      if (isUnique(sel, el)) return sel;
    }
    if (el.id && /^[a-z][\w-]*$/i.test(el.id)) {
      const sel = "#" + el.id;
      if (isUnique(sel, el)) return sel;
    }
    const aria = el.getAttribute("aria-label");
    if (aria && aria.length < 80) {
      const sel = `${el.tagName.toLowerCase()}[aria-label=${JSON.stringify(aria)}]`;
      if (isUnique(sel, el)) return sel;
    }
    // Path cascade — short-circuit at the first depth that's already unique.
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && cur.nodeType === 1 && depth < 4) {
      let part = cur.tagName.toLowerCase();
      if (cur.classList && cur.classList.length) {
        const cls = Array.from(cur.classList)
          .filter((c) => c.length < 30 && !/^(css-|_|sc-)/.test(c))
          .slice(0, 2)
          .map((c) => CSS.escape(c))
          .join(".");
        if (cls) part += "." + cls;
      }
      if (cur.parentElement) {
        const sibs = Array.from(cur.parentElement.children).filter((s) => s.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (isUnique(candidate, el)) return candidate;
      cur = cur.parentElement;
      depth++;
    }
    return parts.join(" > ");
  }

  function visibleText(el, max = 120) {
    const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  function nearbyText(el) {
    const own = visibleText(el, 200);
    const parts = [];
    const parent = el.parentElement;
    if (parent) {
      const pt = visibleText(parent, 200);
      if (pt && pt !== own) parts.push(pt.slice(0, 80));
    }
    return parts.join(" | ");
  }

  function a11y(el) {
    const out = [];
    const role = el.getAttribute("role");
    const label = el.getAttribute("aria-label");
    const name = el.getAttribute("name");
    const placeholder = el.getAttribute("placeholder");
    if (role) out.push(`role=${role}`);
    if (label) out.push(`aria-label="${label}"`);
    if (name) out.push(`name=${name}`);
    if (placeholder) out.push(`placeholder="${placeholder}"`);
    if (el.tagName === "INPUT" && el.getAttribute("type")) out.push(`type=${el.getAttribute("type")}`);
    return out.join(" ");
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const t = visibleText(el, 40);
    return t ? `<${tag}> "${t}"` : `<${tag}>`;
  }

  const RICH_STYLE_PROPS = [
    "display", "position", "flex-direction", "justify-content", "align-items", "gap",
    "padding", "margin", "color", "background-color", "background-image",
    "font-size", "font-weight", "font-family", "line-height",
    "border", "border-radius", "box-shadow", "opacity",
    "transform", "z-index", "overflow", "width", "height",
  ];

  function serializeComputedStyles(el) {
    const cs = window.getComputedStyle(el);
    return RICH_STYLE_PROPS
      .map((p) => [p, cs.getPropertyValue(p)])
      .filter(([, v]) => v && v !== "none" && v !== "normal")
      .map(([p, v]) => `${p}: ${v.trim()}`)
      .join("; ");
  }

  function capture(el, comment, opts = {}) {
    const r = el.getBoundingClientRect();
    const react = getReactInfo(el);
    const viewport = { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), scrollX: Math.round(scrollX) };
    const client = {
      userAgent: navigator.userAgent,
      platform: navigator.userAgentData?.platform || navigator.platform,
      devicePixelRatio: window.devicePixelRatio,
      colorScheme: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    };
    const boundingBox = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
    const parent = el.parentElement;
    const parentContext = parent ? {
      element: parent.tagName.toLowerCase(),
      text: visibleText(parent, 80),
      accessibility: a11y(parent),
    } : null;
    return {
      id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      comment,
      source: opts.source || "user",
      replyTo: opts.replyTo || null,
      element: el.tagName.toLowerCase(),
      elementPath: getSelector(el),
      cssClasses: el.classList ? Array.from(el.classList).join(" ") : "",
      x: viewport.width ? Math.round((r.left / viewport.width) * 100) : 0,
      y: Math.round(r.top + viewport.scrollY),
      boundingBox,
      text: visibleText(el),
      nearbyText: nearbyText(el),
      parentContext,
      accessibility: a11y(el),
      computedStyles: serializeComputedStyles(el),
      outerHTML: (el.outerHTML || "").slice(0, 1000),
      reactComponents: react ? react.componentPath : null,
      sourceFile: react && react.source ? `${react.source.fileName}:${react.source.lineNumber}` : null,
      consoleLog: consoleBuffer
        .filter((e) => e.ts >= Date.now() - CONSOLE_WINDOW_MS)
        .slice(-CONSOLE_LOG_PER_ANNOTATION),
      url: location.href,
      pageTitle: document.title,
      viewport,
      client,
      timestamp: Date.now(),
    };
  }

  const host = document.createElement("div");
  host.id = "__avis_host";
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  document.documentElement.appendChild(host);
  // Shadow DOM for style isolation.
  const shadow = host.attachShadow({ mode: "open" });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, system-ui, "Segoe UI", sans-serif; }
      .toolbar {
        position: fixed; bottom: 16px; right: 16px;
        background: #111; color: #fff;
        border-radius: 10px; padding: 6px;
        font-size: 13px; line-height: 1;
        display: flex; gap: 4px; align-items: center;
        box-shadow: 0 6px 20px rgba(0,0,0,.25);
        z-index: 100; pointer-events: auto;
      }
      .toolbar.persist-broken::before {
        content: "!";
        position: absolute; top: -6px; left: -6px;
        width: 16px; height: 16px;
        background: #b91c1c; color: #fff;
        border-radius: 50%;
        font: 700 11px/16px -apple-system, system-ui, sans-serif;
        text-align: center;
        box-shadow: 0 2px 4px rgba(0,0,0,.3);
      }
      .btn {
        background: #2a2a2a; color: #fff; border: 0;
        padding: 8px 12px; border-radius: 6px;
        cursor: pointer; font: inherit; transition: background .1s;
      }
      .btn:hover { background: #3a3a3a; }
      .btn.primary { background: #3b82f6; }
      .btn.primary:hover { background: #4d8ff9; }
      .btn.primary:disabled { background: #1e3a66; cursor: default; }
      .btn.active { background: #ef4444; }
      .btn.active:hover { background: #f05555; }

      .annotate-stack {
        position: relative;
        display: inline-flex;
        align-items: center;
        margin: -4px 0;
      }
      .annotate-stack::before {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(180deg, #fde675 0%, #e8d05c 100%);
        transform: rotate(-7deg) translate(-3px, 2px);
        transform-origin: center;
        box-shadow: 0 2px 5px rgba(0,0,0,.15);
        z-index: 0;
        transition: transform .12s ease;
      }
      .annotate-stack:has(.btn.active)::before { display: none; }

      .btn[data-act=point] {
        --fold-x: 10px;
        --fold-y: 8px;
        position: relative;
        z-index: 1;
        background: linear-gradient(180deg, #fff59d 0%, #f7e373 100%);
        color: #1a1a0e;
        border-radius: 0;
        border-bottom-right-radius: var(--fold-x) var(--fold-y);
        corner-bottom-right-shape: bevel;
        overflow: clip;
        padding: 12px 14px;
        font-weight: 500;
        transform: rotate(-3deg);
        transform-origin: center;
        box-shadow: 0 3px 7px rgba(0,0,0,.18);
        transition: transform .12s ease, box-shadow .12s ease, background .12s ease;
      }
      .btn[data-act=point]:hover {
        transform: rotate(-3deg) translateY(-3px);
        background: linear-gradient(180deg, #fff7a8 0%, #faea84 100%);
        box-shadow: 0 5px 10px rgba(0,0,0,.22);
      }
      .btn[data-act=point]::after {
        content: "";
        background: inherit;
        width: var(--fold-x); height: var(--fold-y);
        position: absolute;
        inset: auto 0 0 auto;
        corner-top-left-shape: bevel;
        border-top-left-radius: calc(100% - var(--fold-y)) 100%;
        box-shadow: 0 0 calc((var(--fold-x) + var(--fold-y)) / 3) rgba(0,0,0,.2);
        pointer-events: none;
      }
      .btn[data-act=point].active {
        background: #2a2a2a;
        color: #fff;
        border-radius: 6px;
        corner-bottom-right-shape: round;
        padding: 8px 12px;
        margin: 0;
        transform: none;
        box-shadow: none;
      }
      .btn[data-act=point].active:hover {
        background: #3a3a3a;
      }
      .btn[data-act=point].active::after { display: none; }

      .brand {
        font-weight: 600; letter-spacing: .02em;
        padding: 0 6px 0 8px; opacity: .85;
        color: inherit; text-decoration: none; cursor: pointer;
      }
      .brand:hover { opacity: 1; }
      .btn.copied { background: #16a34a; }
      .btn.copy-failed { background: #b91c1c; }

      .copy-stack { display: inline-grid; }
      .copy-stack > .copy-state {
        grid-area: 1 / 1;
        display: inline-flex; align-items: center; gap: 6px;
        justify-self: center;
      }
      .copy-stack > .copy-state.copied,
      .copy-stack > .copy-state.failed { visibility: hidden; }
      .btn.copied .copy-stack > .copy-state.normal { visibility: hidden; }
      .btn.copied .copy-stack > .copy-state.copied { visibility: visible; }
      .btn.copy-failed .copy-stack > .copy-state.normal { visibility: hidden; }
      .btn.copy-failed .copy-stack > .copy-state.failed { visibility: visible; }
      .copy-count { font-variant-numeric: tabular-nums; opacity: .75; }
      .copy-count:empty { display: none; }

      .overlay {
        position: fixed; inset: 0;
        cursor: crosshair; pointer-events: auto;
        z-index: 50; background: rgba(0,0,0,.001);
      }
      .outline {
        position: fixed; pointer-events: none;
        border: 2px solid #3b82f6; background: rgba(59,130,246,.10);
        z-index: 55; transition: all .04s linear;
      }
      .outline.drop {
        border-color: #16a34a; background: rgba(22,163,74,.12);
        z-index: 90;
      }

      .popup {
        --fold-x: 18px;
        --fold-y: 14px;
        position: fixed;
        background: linear-gradient(180deg, #fff59d 0%, #f7e373 100%);
        color: #1a1a0e;
        border-radius: 0; padding: 14px; width: 260px;
        font-size: 13px; line-height: 1.4;
        font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
        box-shadow: 0 6px 14px rgba(0,0,0,.18), 0 2px 4px rgba(0,0,0,.08);
        transform: rotate(-2deg); transform-origin: top left;
        z-index: 110; pointer-events: auto;
        border-bottom-right-radius: var(--fold-x) var(--fold-y);
        corner-bottom-right-shape: bevel;
        overflow: clip;
      }
      .popup::before {
        content: "";
        background: inherit;
        width: var(--fold-x); height: var(--fold-y);
        position: absolute;
        inset: auto 0 0 auto;
        corner-top-left-shape: bevel;
        border-top-left-radius: calc(100% - var(--fold-y)) 100%;
        box-shadow: 0 0 calc((var(--fold-x) + var(--fold-y)) / 3) rgba(0,0,0,.25);
        pointer-events: none;
      }
      .popup .label {
        font-size: 11px; opacity: .55; margin-bottom: 10px;
        word-break: break-all; font-family: ui-monospace, monospace;
        color: #1a1a0e;
        cursor: grab; user-select: none;
      }
      /* Reply: quote the agent's parent comment in a lavender block inside the
         yellow user paper — gives the visual cue "this is replying to an agent
         post-it" without restructuring the popup. */
      .popup.reply .label {
        background: linear-gradient(180deg, #f0e7ff 0%, #e2d4ff 100%);
        color: #2a1f4d;
        padding: 8px 10px;
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 12px;
        opacity: 1;
        word-break: normal;
      }
      .popup.dragging { transition: none; }
      .popup.dragging .label { cursor: grabbing; }
      .popup textarea {
        width: 100%; background: transparent;
        border: 0;
        padding: 4px 0; font: inherit; resize: none;
        field-sizing: content;
        min-height: 36px; max-height: 240px;
        outline: none; color: inherit;
        caret-color: #1a1a0e;
        overflow-y: auto;
      }
      .popup .hint { font-size: 10px; opacity: .45; margin-top: 10px; color: #1a1a0e; }

      .marker {
        position: fixed;
        width: 22px; height: 22px;
        border-radius: 50%;
        background: #3b82f6; color: #fff;
        font: 600 11px/22px -apple-system, system-ui, sans-serif;
        text-align: center;
        box-shadow: 0 2px 6px rgba(0,0,0,.25);
        pointer-events: auto; cursor: grab;
        z-index: 95;
        user-select: none;
      }
      .marker:hover { background: #4d8ff9; }
      .marker.agent { background: #8b5cf6; }
      .marker.agent:hover { background: #a07bf8; }
      .marker.orphaned {
        background: #94a3b8;
        outline: 2px dashed rgba(0,0,0,.4);
        outline-offset: -2px;
        opacity: .75;
      }
      .marker.orphaned:hover { background: #a3aec0; opacity: 1; }
      .marker.dragging { cursor: grabbing; transition: none; opacity: .85; }
      .marker.tentative {
        background: #f7e373; color: #1a1a0e;
        cursor: default;
      }
      .marker.tentative:hover { background: #fde675; }
      .marker.working::before {
        content: "";
        position: absolute;
        inset: -4px;
        border-radius: 50%;
        border: 2px solid transparent;
        border-top-color: #3b82f6;
        border-right-color: #3b82f6;
        animation: avis-spin .8s linear infinite;
        pointer-events: none;
      }
      .marker.revealing {
        animation: avis-reveal .8s ease;
      }
      @keyframes avis-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes avis-reveal {
        0%, 100% { transform: scale(1); box-shadow: 0 2px 6px rgba(0,0,0,.25); }
        50% { transform: scale(1.35); box-shadow: 0 0 0 8px rgba(59,130,246,.3), 0 4px 10px rgba(0,0,0,.3); }
      }
    </style>
    <div class="toolbar" role="toolbar" aria-label="avis">
      <a class="brand" href="https://github.com/sryo/avis" target="_blank" rel="noopener noreferrer">avis</a>
      <span class="annotate-stack">
        <button class="btn" data-act="point">+ annotate</button>
      </span>
      <button class="btn primary" data-act="copy">
        <span class="copy-stack">
          <span class="copy-state normal">copy<span class="copy-count"></span></span>
          <span class="copy-state copied">✓ copied</span>
          <span class="copy-state failed">✗ copy failed</span>
        </span>
      </button>
    </div>
    <div class="marker-layer"></div>
  `;

  const pointBtn = shadow.querySelector("[data-act=point]");
  const copyBtn = shadow.querySelector("[data-act=copy]");
  const copyCount = shadow.querySelector(".copy-count");
  const markerLayer = shadow.querySelector(".marker-layer");
  let tentativeAnnotation = null;
  let editingId = null;
  let overlay = null;
  let outline = null;
  let popup = null;
  let lastHoverEl = null;

  function render() {
    const currentPage = currentPageAnnotations();
    const visibleCount = currentPage.length + (tentativeAnnotation ? 1 : 0);
    const hasAnnotations = currentPage.length > 0;
    copyCount.textContent = visibleCount > 0 ? String(visibleCount) : "";
    pointBtn.classList.toggle("active", state.pointing);
    pointBtn.textContent = state.pointing ? "done" : "+ annotate";
    copyBtn.disabled = !hasAnnotations;
    renderMarkers();
  }

  function renderMarkers() {
    markerLayer.replaceChildren();
    const currentPage = currentPageAnnotations();
    const list = tentativeAnnotation
      ? [...currentPage, tentativeAnnotation]
      : currentPage;
    const stackByEl = new Map();
    list.forEach((a, i) => {
      const m = document.createElement("div");
      m.className = "marker";
      if (a.source === "agent") m.classList.add("agent");
      if (a === tentativeAnnotation || a.id === editingId) m.classList.add("tentative");
      if (workingIds.has(a.id)) m.classList.add("working");
      m.textContent = String(i + 1);
      m.title = a.comment;
      m.dataset.annotationId = a.id;
      const target = resolveTarget(a.elementPath);
      m._targetEl = target;
      m._elementPath = a.elementPath || null;
      // Stash absolute page coords from capture-time geometry as an orphan
      // fallback for positionMarkers when the live element can't be resolved.
      const bb = a.boundingBox;
      const vp = a.viewport;
      if (bb && vp) {
        m._orphanAbsX = bb.x + (vp.scrollX || 0) + bb.width - 11;
        m._orphanAbsY = bb.y + (vp.scrollY || 0) - 11;
      }
      const stackIdx = target ? (stackByEl.get(target) || 0) : 0;
      m._stackIndex = stackIdx;
      if (target) stackByEl.set(target, stackIdx + 1);
      markerLayer.appendChild(m);
    });
    positionMarkers();
    // Re-attach in-flight drag to the freshly mounted marker DOM.
    if (dragState && dragState.id) {
      const live = markerLayer.querySelector(`.marker[data-annotation-id="${dragState.id}"]`);
      if (live) {
        dragState.marker = live;
        if (dragState.moved) live.classList.add("dragging");
      }
    }
  }

  // rAF-batched: scroll events firing 60×/sec collapse into one read/write pass.
  let positionPending = false;
  function positionMarkers() {
    if (positionPending) return;
    positionPending = true;
    requestAnimationFrame(() => {
      positionPending = false;
      const markers = markerLayer.querySelectorAll(".marker");
      const reads = [];
      markers.forEach((m) => {
        // Detached cached nodes return zero rects; re-resolve so markers don't silently freeze.
        if (!m._targetEl || !m._targetEl.isConnected) {
          m._targetEl = resolveTarget(m._elementPath);
        }
        const el = m._targetEl;
        if (!el) { reads.push(null); return; }
        const r = el.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) { reads.push(null); return; }
        reads.push(r);
      });
      markers.forEach((m, i) => {
        const r = reads[i];
        let left, top, orphaned;
        if (r) {
          left = Math.round(r.right - 11) + "px";
          top = Math.round(r.top - 11 + (m._stackIndex || 0) * 26) + "px";
          orphaned = false;
        } else if (m._orphanAbsX !== undefined) {
          // Element is gone — render at the saved capture-time position so the
          // comment doesn't silently vanish. Marker gets an `orphaned` class
          // so it reads as stale (dashed outline, muted color).
          left = Math.round(m._orphanAbsX - window.scrollX) + "px";
          top = Math.round(m._orphanAbsY - window.scrollY + (m._stackIndex || 0) * 26) + "px";
          orphaned = true;
        } else {
          return;
        }
        if (m.style.left !== left) m.style.left = left;
        if (m.style.top !== top) m.style.top = top;
        m.classList.toggle("orphaned", orphaned);
      });
    });
  }

  // Hide our chrome so elementFromPoint sees the host page underneath.
  function elementBeneathPoint(clientX, clientY, hideOutline = true) {
    const ov = overlay && overlay.style.pointerEvents;
    if (overlay) overlay.style.pointerEvents = "none";
    if (hideOutline && outline) outline.style.display = "none";
    host.style.pointerEvents = "none";
    const el = document.elementFromPoint(clientX, clientY);
    host.style.pointerEvents = "";
    if (overlay) overlay.style.pointerEvents = ov || "auto";
    if (hideOutline && outline) outline.style.display = "block";
    return el;
  }

  function enterPointMode() {
    if (state.pointing) return;
    state.pointing = true;
    overlay = document.createElement("div");
    overlay.className = "overlay";
    outline = document.createElement("div");
    outline.className = "outline";
    outline.style.display = "none";
    shadow.appendChild(overlay);
    shadow.appendChild(outline);
    overlay.addEventListener("mousemove", onHover);
    overlay.addEventListener("click", onPick);
    overlay.addEventListener("contextmenu", (e) => { e.preventDefault(); exitPointMode(); });
    document.addEventListener("keydown", onKeydown, true);
    render();
  }

  function exitPointMode() {
    state.pointing = false;
    if (overlay) { overlay.remove(); overlay = null; }
    if (outline) { outline.remove(); outline = null; }
    lastHoverEl = null;
    document.removeEventListener("keydown", onKeydown, true);
    render();
  }

  function onKeydown(e) {
    if (e.key !== "Escape") return;
    e.preventDefault();
    // Staged: first Escape closes the popup (stays in point mode if active so
    // the user can pick another element). Second Escape exits point mode.
    if (popup) {
      closePopup();
      if (overlay) overlay.style.pointerEvents = "auto";
      // Replay hover so the outline reappears under the cursor immediately,
      // instead of waiting for the next mousemove to redraw.
      if (state.pointing) { lastHoverEl = null; onHover({ clientX: lastHoverX, clientY: lastHoverY }); }
    } else if (state.pointing) {
      exitPointMode();
    }
  }

  let lastHoverX = 0, lastHoverY = 0;
  function onHover(e) {
    lastHoverX = e.clientX; lastHoverY = e.clientY;
    const el = elementBeneathPoint(e.clientX, e.clientY);
    if (!el) {
      if (lastHoverEl !== null) { outline.style.display = "none"; lastHoverEl = null; }
      return;
    }
    if (el === lastHoverEl) return;
    lastHoverEl = el;
    const r = el.getBoundingClientRect();
    outline.style.display = "block";
    outline.style.left = r.left + "px";
    outline.style.top = r.top + "px";
    outline.style.width = r.width + "px";
    outline.style.height = r.height + "px";
  }

  function onPick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = elementBeneathPoint(e.clientX, e.clientY);
    if (!el) return;
    openPopup(el, e.clientX, e.clientY);
  }

  function openPopup(el, x, y, existing) {
    if (popup) closePopup();
    if (outline) outline.style.display = "none";
    if (overlay) overlay.style.pointerEvents = "none";
    // Click on agent marker → reply (creates a new user annotation linked via replyTo).
    // Click on user marker → edit. New element click → create.
    const isReply = !!existing && existing.source === "agent";
    const isEdit = !!existing && !isReply;
    const isCreate = !existing;
    // Reply needs a fresh element to anchor to; resolve from the parent's selector.
    if (isReply && !el) el = resolveTarget(existing.elementPath);
    // Edit path bypasses point mode's keydown install — own it here, release in closePopup.
    const ownsKeydown = !state.pointing;
    if (ownsKeydown) document.addEventListener("keydown", onKeydown, true);
    popup = document.createElement("div");
    popup.className = "popup" + (isReply ? " reply" : "");
    popup._ownsKeydown = ownsKeydown;
    popup.innerHTML = `
      <div class="label"></div>
      <textarea placeholder="${isReply ? "reply…" : "What should change?"}"></textarea>
      <div class="hint">click outside to save · esc to discard</div>
    `;
    popup.querySelector(".label").textContent = isReply
      ? `↪ ${(existing.comment || "").slice(0, 60)}`
      : isEdit
      ? `<${existing.element}> "${(existing.text || "").slice(0, 40)}"`
      : describe(el);
    const W = 260, H_EST = 140;
    let px = x + 12, py = y + 12;
    if (px + W > innerWidth - 8) px = innerWidth - W - 8;
    if (py + H_EST > innerHeight - 8) py = Math.max(8, y - H_EST - 12);
    if (px < 8) px = 8;
    if (py < 8) py = 8;
    popup.style.left = px + "px";
    popup.style.top = py + "px";
    shadow.appendChild(popup);

    if (isEdit) {
      editingId = existing.id;
    } else if (el) {
      tentativeAnnotation = capture(el, "", isReply ? { replyTo: existing.id } : undefined);
    }
    render();

    const ta = popup.querySelector("textarea");
    if (isEdit) ta.value = existing.comment;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    const labelEl = popup.querySelector(".label");
    let drag = null;
    labelEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
      drag = {
        startX: e.clientX,
        startY: e.clientY,
        baseLeft: parseFloat(popup.style.left) || 0,
        baseTop: parseFloat(popup.style.top) || 0,
      };
      popup.classList.add("dragging");
      document.addEventListener("mousemove", onPopupDrag);
      document.addEventListener("mouseup", onPopupDragEnd);
    });
    function onPopupDrag(e) {
      if (!drag) return;
      const nx = drag.baseLeft + e.clientX - drag.startX;
      const ny = drag.baseTop + e.clientY - drag.startY;
      popup.style.left = Math.max(-200, Math.min(innerWidth - 60, nx)) + "px";
      popup.style.top = Math.max(0, Math.min(innerHeight - 30, ny)) + "px";
    }
    function onPopupDragEnd() {
      drag = null;
      popup.classList.remove("dragging");
      document.removeEventListener("mousemove", onPopupDrag);
      document.removeEventListener("mouseup", onPopupDragEnd);
    }

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
    });

    // Marker clicks are handled by markerLayer's mousedown — let that path commit so the same gesture can also start a drag.
    function onOutside(e) {
      if (!popup) return;
      const path = e.composedPath();
      if (path.includes(popup)) return;
      if (path.some((n) => n.classList && n.classList.contains("marker"))) return;
      commit();
    }
    document.addEventListener("pointerdown", onOutside, true);
    popup._onOutside = onOutside;
    popup._commit = commit;

    function commit() {
      const text = ta.value.trim();
      if (isEdit) {
        const i = findAnnotationIndex(existing.id);
        if (i !== -1) {
          if (!text) {
            state.annotations.splice(i, 1);
            workingIds.delete(existing.id);
          } else if (text !== existing.comment) {
            state.annotations[i] = { ...state.annotations[i], comment: text };
          }
        }
      } else if (text && el) {
        state.annotations.push(capture(el, text, isReply ? { replyTo: existing.id } : undefined));
      }
      persist();
      closePopup();
      // Stay in point mode after a create so the user can keep batch-annotating.
      // Esc (now staged: closes popup first, exits point mode on second press) is the way out.
      if (overlay) overlay.style.pointerEvents = "auto";
      render();
    }
  }

  function closePopup() {
    if (popup) {
      if (popup._onOutside) document.removeEventListener("pointerdown", popup._onOutside, true);
      if (popup._ownsKeydown) document.removeEventListener("keydown", onKeydown, true);
      popup.remove();
      popup = null;
    }
    tentativeAnnotation = null;
    editingId = null;
  }

  let dragState = null;

  markerLayer.addEventListener("mousedown", (e) => {
    let m = e.target.closest(".marker");
    if (!m) return;
    const id = m.dataset.annotationId;
    // If a popup is open (likely editing this same marker), commit it first
    // and rebind to the freshly rendered marker DOM.
    if (popup && popup._commit) {
      popup._commit();
      m = markerLayer.querySelector(`.marker[data-annotation-id="${id}"]`);
      if (!m) return;
    }
    e.preventDefault();
    e.stopPropagation();
    dragState = {
      id,
      marker: m,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    document.addEventListener("mousemove", onMarkerDragMove);
    document.addEventListener("mouseup", onMarkerDragEnd);
    document.addEventListener("keydown", onMarkerDragKey, true);
  });

  function onMarkerDragKey(e) {
    if (e.key !== "Escape" || !dragState) return;
    e.preventDefault();
    e.stopPropagation();
    cancelMarkerDrag();
  }
  function cancelMarkerDrag() {
    if (!dragState) return;
    document.removeEventListener("mousemove", onMarkerDragMove);
    document.removeEventListener("mouseup", onMarkerDragEnd);
    document.removeEventListener("keydown", onMarkerDragKey, true);
    if (dragState.dropOutline) dragState.dropOutline.remove();
    dragState.marker.classList.remove("dragging");
    dragState = null;
    render();
  }

  function onMarkerDragMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) > 5) {
      dragState.moved = true;
      dragState.marker.classList.add("dragging");
      dragState.dropOutline = document.createElement("div");
      dragState.dropOutline.className = "outline drop";
      dragState.dropOutline.style.display = "none";
      shadow.appendChild(dragState.dropOutline);
    }
    if (!dragState.moved) return;
    dragState.marker.style.left = (e.clientX - 11) + "px";
    dragState.marker.style.top = (e.clientY - 11) + "px";

    dragState.marker.style.pointerEvents = "none";
    const target = elementBeneathPoint(e.clientX, e.clientY, false);
    dragState.marker.style.pointerEvents = "auto";

    if (target && target !== host && target !== dragState.lastTarget) {
      dragState.lastTarget = target;
      const r = target.getBoundingClientRect();
      dragState.dropOutline.style.display = "block";
      dragState.dropOutline.style.left = r.left + "px";
      dragState.dropOutline.style.top = r.top + "px";
      dragState.dropOutline.style.width = r.width + "px";
      dragState.dropOutline.style.height = r.height + "px";
    } else if (!target || target === host) {
      dragState.dropOutline.style.display = "none";
      dragState.lastTarget = null;
    }
  }

  function onMarkerDragEnd(e) {
    document.removeEventListener("mousemove", onMarkerDragMove);
    document.removeEventListener("mouseup", onMarkerDragEnd);
    document.removeEventListener("keydown", onMarkerDragKey, true);
    if (!dragState) return;
    const { id, marker, moved, dropOutline } = dragState;
    dragState = null;
    marker.classList.remove("dragging");
    if (dropOutline) dropOutline.remove();

    if (!moved) {
      const ann = findAnnotation(id);
      if (!ann) return;
      const r = marker.getBoundingClientRect();
      openPopup(null, r.left, r.bottom, ann);
      return;
    }

    marker.style.pointerEvents = "none";
    const target = elementBeneathPoint(e.clientX, e.clientY, false);
    marker.style.pointerEvents = "auto";

    if (!target || target === host) {
      render();
      return;
    }

    const i = findAnnotationIndex(id);
    if (i === -1) return;
    const old = state.annotations[i];
    const updated = capture(target, old.comment);
    updated.id = old.id;
    updated.timestamp = old.timestamp;
    // Preserve the console window from the original pin — re-anchoring shouldn't
    // overwrite the runtime context the user pinned to.
    updated.consoleLog = old.consoleLog;
    state.annotations[i] = updated;
    persist();
    render();
  }

  pointBtn.addEventListener("click", () => {
    state.pointing ? exitPointMode() : enterPointMode();
  });

  copyBtn.addEventListener("click", async () => {
    if (state.annotations.length === 0) return;
    const json = JSON.stringify(state.annotations, null, 2);
    let ok = true;
    try { await navigator.clipboard.writeText(json); }
    catch { ok = false; }
    copyBtn.classList.add(ok ? "copied" : "copy-failed");
    setTimeout(() => copyBtn.classList.remove(ok ? "copied" : "copy-failed"), 1400);
  });

  // Capture-phase: scroll events don't bubble, but capture catches them from
  // any scrolling element (window, sidebar, inner overflow container, etc.).
  document.addEventListener("scroll", positionMarkers, { passive: true, capture: true });
  window.addEventListener("resize", positionMarkers);

  // Coalesce navigation re-renders via rAF — back/forward + framework replaceState can fire in the same tick.
  let navPending = false;
  function scheduleRender() {
    if (navPending) return;
    navPending = true;
    requestAnimationFrame(() => { navPending = false; render(); });
  }
  window.addEventListener("popstate", scheduleRender);
  const _push = history.pushState;
  history.pushState = function () { _push.apply(this, arguments); scheduleRender(); };
  const _replace = history.replaceState;
  history.replaceState = function () { _replace.apply(this, arguments); scheduleRender(); };

  render();
  console.log("[avis] toolbar installed — click '+ annotate' to point at an element. Existing annotations:", state.annotations.length);
})();
