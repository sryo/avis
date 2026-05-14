// avis — feedback toolbar. Injected onto any page; captures point-and-comment
// annotations and exposes them on window.__avis for Claude Code to read back.
//
// Per annotation we capture, in order of usefulness to an AI agent:
//   1. React fiber _debugSource  -> exact src/file.tsx:line  (dev builds only)
//   2. React component path      -> <App> <Layout> <NavItem>  (any React build)
//   3. Visible text + tag        -> works on any framework / vanilla HTML
//   4. Accessibility name/role   -> strong signal when text is empty
//   5. Nearby text               -> disambiguates ("button next to 'Forgot'")
//   6. CSS path                  -> last-resort selector
//   7. Viewport rect + URL       -> screenshot / context

(function () {
  if (window.__avis || document.getElementById("__avis_host")) return;

  const STORAGE_KEY = "avis:annotations";
  const state = {
    annotations: load(),
    pointing: false,
  };

  const workingIds = new Set();

  const findAnnotation = (id) => state.annotations.find((a) => a.id === id);
  const findAnnotationIndex = (id) => state.annotations.findIndex((a) => a.id === id);

  window.__avis = {
    // Full array across all pages — Claude can see cross-page work.
    get annotations() { return state.annotations.slice(); },
    get pageUrl() { return location.href; },
    // Compact projection — same array, but only the fields needed to plan
    // edits. Drops outerHTML, computedStyles, cssClasses, accessibility,
    // boundingBox, viewport, x, y, timestamp. Use this in javascript_tool
    // to dodge the chrome bridge's content filter on large payloads.
    summary() {
      return state.annotations.map((a) => ({
        id: a.id,
        comment: a.comment,
        sourceFile: a.sourceFile,
        reactComponents: a.reactComponents,
        element: a.element,
        elementPath: a.elementPath,
        text: a.text,
        nearbyText: a.nearbyText,
        parentContext: a.parentContext,
        url: a.url,
      }));
    },
    // Smooth-scroll to an annotation and pulse its marker. Returns false if
    // the annotation isn't on the current page (no cross-page navigation).
    reveal(id) {
      const a = findAnnotation(id);
      if (!a || !isCurrentPage(a)) return false;
      const absY = a.boundingBox.y + a.viewport.scrollY;
      window.scrollTo({ top: Math.max(0, absY - 100), behavior: "smooth" });
      const m = markerLayer.querySelector(`.marker[data-annotation-id="${id}"]`);
      if (m) {
        m.classList.add("revealing");
        setTimeout(() => m.classList.remove("revealing"), 800);
      }
      return true;
    },
    // Visually mark an annotation as in-progress (spinner badge on the marker).
    markWorking(id) {
      if (!findAnnotation(id) || workingIds.has(id)) return false;
      workingIds.add(id);
      render();
      return true;
    },
    unmarkWorking(id) {
      if (!workingIds.delete(id)) return false;
      render();
      return true;
    },
    // Remove a single annotation by id once Claude has addressed it.
    // Returns true if removed, false if id wasn't found.
    resolve(id) {
      const i = findAnnotationIndex(id);
      if (i === -1) return false;
      state.annotations.splice(i, 1);
      workingIds.delete(id);
      persist();
      render();
      return true;
    },
    // Wipe everything. Call this when the whole batch has been handled.
    clear() {
      state.annotations = [];
      workingIds.clear();
      persist();
      render();
    },
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
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]").map(migrate); }
    catch { return []; }
  }
  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.annotations)); }
    catch {}
  }

  // ---------- React fiber walk ----------

  function getFiberKey(el) {
    for (const k in el) {
      if (k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$")) return k;
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
    // Walk up the DOM until we find an ancestor with a React fiber.
    // Server-rendered nodes (Next.js RSC, Astro islands, etc.) have no fiber;
    // their nearest hydrated parent does.
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

  // ---------- Element identification ----------

  function getSelector(el) {
    if (el.id && /^[a-z][\w-]*$/i.test(el.id)) return "#" + el.id;
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

  // Curated subset of computed styles worth capturing for visual reasoning.
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

  // Annotation shape: aligns with agentation v1.1 schema where it overlaps,
  // plus our extension fields (sourceFile, viewport, pageTitle).
  function capture(el, comment) {
    const r = el.getBoundingClientRect();
    const react = getReactInfo(el);
    const viewport = { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), scrollX: Math.round(scrollX) };
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
      url: location.href,
      pageTitle: document.title,
      viewport,
      timestamp: Date.now(),
    };
  }

  // Migrate older localStorage entries (rect / pageUrl / tag / selector …) to
  // the agentation v1.1 names so the rest of the code only deals with one shape.
  function migrate(a) {
    if (!a || a.boundingBox) return a;
    const v = a.viewport || { width: 0, height: 0, scrollY: 0, scrollX: 0 };
    const r = a.rect || { x: 0, y: 0, width: 0, height: 0 };
    return {
      ...a,
      element: a.element || a.tag,
      elementPath: a.elementPath || a.selector,
      reactComponents: a.reactComponents || a.componentPath,
      url: a.url || a.pageUrl,
      boundingBox: a.boundingBox || r,
      x: a.x !== undefined ? a.x : (v.width ? Math.round((r.x / v.width) * 100) : 0),
      y: a.y !== undefined ? a.y : Math.round(r.y + (v.scrollY || 0)),
      cssClasses: a.cssClasses || "",
      computedStyles: a.computedStyles || "",
      outerHTML: a.outerHTML || "",
      timestamp: a.timestamp || (a.createdAt ? new Date(a.createdAt).getTime() : Date.now()),
    };
  }

  // ---------- UI (Shadow DOM for style isolation) ----------

  const host = document.createElement("div");
  host.id = "__avis_host";
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  document.documentElement.appendChild(host);
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
        margin: -4px 4px;
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
        transform: rotate(-3deg) translateY(-1px);
        background: linear-gradient(180deg, #fff7a8 0%, #faea84 100%);
        box-shadow: 0 5px 10px rgba(0,0,0,.22);
      }
      .annotate-stack:hover::before {
        transform: rotate(-7deg) translate(-4px, 3px);
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
        background: #ef4444;
        color: #fff;
        border-radius: 6px;
        corner-bottom-right-shape: round;
        padding: 8px 12px;
        margin: 0;
        transform: none;
        box-shadow: none;
      }
      .btn[data-act=point].active:hover {
        background: #f05555;
      }
      .btn[data-act=point].active::after { display: none; }

      .count { padding: 0 6px; opacity: .65; font-variant-numeric: tabular-nums; }
      .brand {
        font-weight: 600; letter-spacing: .02em;
        padding: 0 6px 0 8px; opacity: .85;
        color: inherit; text-decoration: none; cursor: pointer;
      }
      .brand:hover { opacity: 1; }
      .btn.copied { background: #16a34a; }

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
      .popup.dragging { transition: none; }
      .popup.dragging .label { cursor: grabbing; }
      .popup textarea {
        width: 100%; background: transparent;
        border: 0; border-bottom: 1px dashed rgba(0,0,0,.18);
        padding: 4px 0; font: inherit; resize: none;
        field-sizing: content;
        min-height: 36px; max-height: 240px;
        outline: none; color: inherit;
        caret-color: #1a1a0e;
        overflow-y: auto;
      }
      .popup textarea:focus { border-bottom-color: rgba(0,0,0,.45); border-bottom-style: solid; }
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
      <span class="count">0</span>
      <button class="btn primary" data-act="copy">Copy</button>
    </div>
    <div class="marker-layer"></div>
  `;

  const pointBtn = shadow.querySelector("[data-act=point]");
  const copyBtn = shadow.querySelector("[data-act=copy]");
  const countSpan = shadow.querySelector(".count");
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
    countSpan.textContent = String(visibleCount);
    pointBtn.classList.toggle("active", state.pointing);
    pointBtn.textContent = state.pointing ? "Cancel" : "+ annotate";
    copyBtn.disabled = !hasAnnotations;
    renderMarkers();
  }

  function renderMarkers() {
    markerLayer.replaceChildren();
    const currentPage = currentPageAnnotations();
    const list = tentativeAnnotation
      ? [...currentPage, tentativeAnnotation]
      : currentPage;
    list.forEach((a, i) => {
      const m = document.createElement("div");
      m.className = "marker";
      if (a === tentativeAnnotation || a.id === editingId) m.classList.add("tentative");
      if (workingIds.has(a.id)) m.classList.add("working");
      m.textContent = String(i + 1);
      m.title = a.comment;
      m.dataset.absX = String(a.boundingBox.x + a.viewport.scrollX + a.boundingBox.width - 11);
      m.dataset.absY = String(a.boundingBox.y + a.viewport.scrollY - 11);
      m.dataset.annotationId = a.id;
      markerLayer.appendChild(m);
    });
    refreshMarkerCoords();
    positionMarkers();
    // If a drag is in flight when render fires (e.g. the skill called
    // markWorking on another annotation), rebind dragState.marker to the
    // freshly mounted DOM so the in-progress drag keeps working.
    if (dragState && dragState.id) {
      const live = markerLayer.querySelector(`.marker[data-annotation-id="${dragState.id}"]`);
      if (live) {
        dragState.marker = live;
        if (dragState.moved) live.classList.add("dragging");
      }
    }
  }

  // Re-resolve each marker's absolute page coords from the live DOM. Expensive
  // (one querySelector + reflow per element), so only called from layout events
  // (resize, render) — NOT scroll, which can fire 60×/sec. After natural
  // positioning, any markers that would visually overlap are bumped downward.
  function refreshMarkerCoords() {
    const markerEls = Array.from(markerLayer.querySelectorAll(".marker"));
    const byPath = new Map();
    markerEls.forEach((m) => {
      const a = m.dataset.annotationId ? findAnnotation(m.dataset.annotationId) : null;
      if (!a || !a.elementPath) return;
      if (!byPath.has(a.elementPath)) byPath.set(a.elementPath, []);
      byPath.get(a.elementPath).push(m);
    });
    byPath.forEach((markers, path) => {
      try {
        const el = document.querySelector(path);
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 && r.height <= 0) return;
        const baseX = Math.round(r.left + window.scrollX + r.width - 11);
        const baseY = Math.round(r.top + window.scrollY - 11);
        markers.forEach((m, idx) => {
          m.dataset.absX = String(baseX);
          m.dataset.absY = String(baseY + idx * 26);
        });
      } catch {}
    });

    // Collision pass: bump any marker that overlaps another. 22px marker +
    // small breathing gap. Cap iterations so a pathological page can't hang us.
    const HIT = 24;
    const BUMP = 26;
    for (let pass = 0; pass < 8; pass++) {
      markerEls.sort((a, b) => Number(a.dataset.absY) - Number(b.dataset.absY));
      let collided = false;
      for (let i = 0; i < markerEls.length; i++) {
        const ax = Number(markerEls[i].dataset.absX);
        const ay = Number(markerEls[i].dataset.absY);
        for (let j = i + 1; j < markerEls.length; j++) {
          const bx = Number(markerEls[j].dataset.absX);
          const by = Number(markerEls[j].dataset.absY);
          if (Math.abs(bx - ax) < HIT && Math.abs(by - ay) < HIT) {
            markerEls[j].dataset.absY = String(ay + BUMP);
            collided = true;
          }
        }
      }
      if (!collided) break;
    }
  }

  // Cheap path: just translate stored absolute coords by current scroll.
  function positionMarkers() {
    const sy = window.scrollY;
    const sx = window.scrollX;
    markerLayer.querySelectorAll(".marker").forEach((m) => {
      const left = (Number(m.dataset.absX) - sx) + "px";
      const top = (Number(m.dataset.absY) - sy) + "px";
      if (m.style.left !== left) m.style.left = left;
      if (m.style.top !== top) m.style.top = top;
    });
  }

  // Run document.elementFromPoint with our chrome (host + overlay + outline)
  // temporarily transparent so the call sees the real page underneath.
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

  function elementAtClick(clientX, clientY) {
    return elementBeneathPoint(clientX, clientY);
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
    if (e.key === "Escape") {
      e.preventDefault();
      if (popup) {
        closePopup();
        if (overlay) overlay.style.pointerEvents = "auto";
        if (state.pointing) exitPointMode();
      } else if (state.pointing) {
        exitPointMode();
      }
    }
  }

  function onHover(e) {
    const el = elementAtClick(e.clientX, e.clientY);
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
    const el = elementAtClick(e.clientX, e.clientY);
    if (!el) return;
    openPopup(el, e.clientX, e.clientY);
  }

  function openPopup(el, x, y, existing) {
    if (popup) closePopup();
    if (outline) outline.style.display = "none";
    if (overlay) overlay.style.pointerEvents = "none";
    const isEdit = !!existing;
    popup = document.createElement("div");
    popup.className = "popup";
    popup.innerHTML = `
      <div class="label"></div>
      <textarea placeholder="What should change?"></textarea>
      <div class="hint">click outside to save · esc to discard</div>
    `;
    popup.querySelector(".label").textContent = isEdit
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

    if (!isEdit) {
      tentativeAnnotation = capture(el, "");
    } else {
      editingId = existing.id;
    }
    render();

    const ta = popup.querySelector("textarea");
    if (isEdit) ta.value = existing.comment;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    // Drag the popup by its label.
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

    // Click anywhere outside the popup → commit (save / delete / no-op based on content).
    // Marker clicks are handled below in markerLayer's mousedown — let that
    // path commit so it can also start a drag on the same gesture.
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
      } else if (text) {
        state.annotations.push(capture(el, text));
      }
      persist();
      closePopup();
      if (!isEdit) exitPointMode();
      else if (overlay) overlay.style.pointerEvents = "auto";
      render();
    }
  }

  function closePopup() {
    if (popup) {
      if (popup._onOutside) document.removeEventListener("pointerdown", popup._onOutside, true);
      popup.remove();
      popup = null;
    }
    tentativeAnnotation = null;
    editingId = null;
  }

  // ---------- Marker click (edit) + drag (re-anchor) ----------

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
  });

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
    if (!dragState) return;
    const { id, marker, moved, dropOutline } = dragState;
    dragState = null;
    marker.classList.remove("dragging");
    if (dropOutline) dropOutline.remove();

    if (!moved) {
      // Click — open edit popup at the marker's position.
      const ann = findAnnotation(id);
      if (!ann) return;
      const r = marker.getBoundingClientRect();
      openPopup(null, r.left, r.bottom, ann);
      return;
    }

    // Drag-drop — find the element under the cursor, ignoring our own chrome.
    marker.style.pointerEvents = "none";
    const target = elementBeneathPoint(e.clientX, e.clientY, false);
    marker.style.pointerEvents = "auto";

    if (!target || target === host) {
      render(); // snap back to original position
      return;
    }

    const i = findAnnotationIndex(id);
    if (i === -1) return;
    const old = state.annotations[i];
    const updated = capture(target, old.comment);
    updated.id = old.id;
    updated.timestamp = old.timestamp;
    state.annotations[i] = updated;
    persist();
    render();
  }

  // ---------- Wire toolbar buttons ----------

  pointBtn.addEventListener("click", () => {
    state.pointing ? exitPointMode() : enterPointMode();
  });

  copyBtn.addEventListener("click", async () => {
    if (state.annotations.length === 0) return;
    const json = JSON.stringify(state.annotations, null, 2);
    try {
      await navigator.clipboard.writeText(json);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = json;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    copyBtn.textContent = "✓ copied";
    copyBtn.classList.add("copied");
    setTimeout(() => {
      copyBtn.classList.remove("copied");
      copyBtn.textContent = "Copy";
    }, 1400);
  });

  window.addEventListener("scroll", positionMarkers, { passive: true });
  window.addEventListener("resize", () => { refreshMarkerCoords(); positionMarkers(); });

  // Re-render on navigation (popstate + SPA pushState/replaceState). Coalesce
  // via rAF so back/forward + framework replaceState in the same tick don't
  // trigger a double render.
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
