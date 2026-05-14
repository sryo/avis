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
  if (window.__avis) return;

  const STORAGE_KEY = "avis:annotations";
  const state = {
    annotations: load(),
    pointing: false,
    done: false,
  };

  window.__avis = {
    get annotations() { return state.annotations.slice(); },
    get done() { return state.done; },
    get pageUrl() { return location.href; },
    // Remove a single annotation by id once Claude has addressed it.
    // Returns true if removed, false if id wasn't found.
    resolve(id) {
      const i = state.annotations.findIndex((a) => a.id === id);
      if (i === -1) return false;
      state.annotations.splice(i, 1);
      if (state.annotations.length === 0) state.done = false;
      persist();
      render();
      return true;
    },
    // Wipe everything. Call this when the whole batch has been handled.
    clear() {
      state.annotations = [];
      state.done = false;
      persist();
      render();
    },
  };

  function load() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); }
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

  function capture(el, comment) {
    const r = el.getBoundingClientRect();
    const react = getReactInfo(el);
    return {
      id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      comment,
      sourceFile: react && react.source ? `${react.source.fileName}:${react.source.lineNumber}` : null,
      componentPath: react ? react.componentPath : null,
      selector: getSelector(el),
      tag: el.tagName.toLowerCase(),
      text: visibleText(el),
      nearbyText: nearbyText(el),
      accessibility: a11y(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      pageUrl: location.href,
      pageTitle: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollY: Math.round(scrollY), scrollX: Math.round(scrollX) },
      createdAt: new Date().toISOString(),
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

      .btn[data-act=point] {
        position: relative;
        background: linear-gradient(180deg, #fff59d 0%, #f7e373 100%);
        color: #1a1a0e;
        border-radius: 0;
        padding: 12px 14px;
        margin: -4px 4px -4px 4px;
        font-weight: 500;
        transform: rotate(-3deg);
        transform-origin: center;
        box-shadow:
          -3px 3px 0 0 #e8d05c,
          -3px 3px 0 1px rgba(0,0,0,.1),
          0 4px 8px rgba(0,0,0,.18);
        transition: transform .12s ease, box-shadow .12s ease, background .12s ease;
      }
      .btn[data-act=point]:hover {
        transform: rotate(-3deg) translateY(-1px);
        background: linear-gradient(180deg, #fff7a8 0%, #faea84 100%);
        box-shadow:
          -4px 4px 0 0 #e8d05c,
          -4px 4px 0 1px rgba(0,0,0,.1),
          0 6px 12px rgba(0,0,0,.22);
      }
      .btn[data-act=point]::after {
        content: "";
        position: absolute;
        bottom: 0; right: 0;
        width: 8px; height: 8px;
        background: linear-gradient(135deg, transparent 50%, rgba(0,0,0,.12) 50%);
        pointer-events: none;
      }
      .btn[data-act=point].active {
        background: #ef4444;
        color: #fff;
        border-radius: 6px;
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
      .btn.done-mode { background: #16a34a; color: #fff; min-width: 70px; }
      .btn.done-mode:hover { background: #2a2a2a; }
      .btn.done-mode.copied { background: #16a34a; }

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
        position: fixed;
        background: linear-gradient(180deg, #fff59d 0%, #f7e373 100%);
        color: #1a1a0e;
        border-radius: 0; padding: 14px; width: 260px;
        font-size: 13px; line-height: 1.4;
        font-family: -apple-system, system-ui, "Segoe UI", sans-serif;
        box-shadow: 0 6px 14px rgba(0,0,0,.18), 0 2px 4px rgba(0,0,0,.08);
        transform: rotate(-1.5deg); transform-origin: top left;
        z-index: 110; pointer-events: auto;
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
        outline: 2px dashed rgba(0,0,0,.3); outline-offset: 2px;
        cursor: default;
      }
      .marker.tentative:hover { background: #fde675; }
    </style>
    <div class="toolbar" role="toolbar" aria-label="avis">
      <a class="brand" href="https://github.com/sryo/avis" target="_blank" rel="noopener noreferrer">avis</a>
      <button class="btn" data-act="point">+ annotate</button>
      <span class="count">0</span>
      <button class="btn primary" data-act="send">Done</button>
    </div>
    <div class="marker-layer"></div>
  `;

  const pointBtn = shadow.querySelector("[data-act=point]");
  const sendBtn = shadow.querySelector("[data-act=send]");
  const countSpan = shadow.querySelector(".count");
  const markerLayer = shadow.querySelector(".marker-layer");
  const isTouch = window.matchMedia("(hover: none)").matches;
  let tentativeAnnotation = null;
  let overlay = null;
  let outline = null;
  let popup = null;
  let lastHoverEl = null;

  function render() {
    const visibleCount = state.annotations.length + (tentativeAnnotation ? 1 : 0);
    const hasAnnotations = state.annotations.length > 0;
    countSpan.textContent = String(visibleCount);
    pointBtn.classList.toggle("active", state.pointing);
    pointBtn.textContent = state.pointing ? "Cancel" : "+ annotate";
    if (state.done) {
      sendBtn.textContent = isTouch ? "Copy" : (sendBtn.matches(":hover") ? "Copy" : "✓ done");
      sendBtn.disabled = false;
      sendBtn.classList.remove("primary");
      sendBtn.classList.add("done-mode");
    } else {
      sendBtn.textContent = "Done";
      sendBtn.disabled = !hasAnnotations;
      sendBtn.classList.add("primary");
      sendBtn.classList.remove("done-mode");
    }
    renderMarkers();
  }

  function renderMarkers() {
    markerLayer.replaceChildren();
    const list = tentativeAnnotation
      ? [...state.annotations, tentativeAnnotation]
      : state.annotations;
    list.forEach((a, i) => {
      const m = document.createElement("div");
      m.className = "marker";
      if (a === tentativeAnnotation) m.classList.add("tentative");
      m.textContent = String(i + 1);
      m.title = a.comment;
      m.dataset.absX = String(a.rect.x + a.viewport.scrollX + a.rect.width - 11);
      m.dataset.absY = String(a.rect.y + a.viewport.scrollY - 11);
      m.dataset.annotationId = a.id;
      markerLayer.appendChild(m);
    });
    positionMarkers();
  }

  function positionMarkers() {
    const sy = window.scrollY;
    const sx = window.scrollX;
    markerLayer.querySelectorAll(".marker").forEach((m) => {
      m.style.left = (Number(m.dataset.absX) - sx) + "px";
      m.style.top = (Number(m.dataset.absY) - sy) + "px";
    });
  }

  function elementAtClick(clientX, clientY) {
    // Hide our chrome briefly so elementFromPoint sees the real page.
    if (overlay) overlay.style.pointerEvents = "none";
    if (outline) outline.style.display = "none";
    host.style.pointerEvents = "none";
    const el = document.elementFromPoint(clientX, clientY);
    host.style.pointerEvents = "";
    if (overlay) overlay.style.pointerEvents = "auto";
    if (outline) outline.style.display = "block";
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
    if (e.key === "Escape") {
      e.preventDefault();
      if (popup) {
        // Discard — leave annotation unchanged.
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
      ? `<${existing.tag}> "${(existing.text || "").slice(0, 40)}"`
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
      render();
    }

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
    function onOutside(e) {
      if (!popup) return;
      if (e.composedPath().includes(popup)) return;
      commit();
    }
    document.addEventListener("pointerdown", onOutside, true);
    popup._onOutside = onOutside;

    function commit() {
      const text = ta.value.trim();
      if (isEdit) {
        const i = state.annotations.findIndex((a) => a.id === existing.id);
        if (i !== -1) {
          if (!text) {
            state.annotations.splice(i, 1);
            if (state.annotations.length === 0) state.done = false;
          } else if (text !== existing.comment) {
            state.annotations[i] = { ...state.annotations[i], comment: text };
          }
        }
      } else if (text) {
        state.annotations.push(capture(el, text));
        state.done = false;
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
  }

  // ---------- Marker click (edit) + drag (re-anchor) ----------

  let dragState = null;

  markerLayer.addEventListener("mousedown", (e) => {
    const m = e.target.closest(".marker");
    if (!m) return;
    e.preventDefault();
    e.stopPropagation();
    dragState = {
      id: m.dataset.annotationId,
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
    host.style.pointerEvents = "none";
    const target = document.elementFromPoint(e.clientX, e.clientY);
    host.style.pointerEvents = "";
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
      const ann = state.annotations.find((a) => a.id === id);
      if (!ann) return;
      const r = marker.getBoundingClientRect();
      openPopup(null, r.left, r.bottom, ann);
      return;
    }

    // Drag-drop — find the element under the cursor, ignoring our own chrome.
    marker.style.pointerEvents = "none";
    host.style.pointerEvents = "none";
    const target = document.elementFromPoint(e.clientX, e.clientY);
    host.style.pointerEvents = "";
    marker.style.pointerEvents = "auto";

    if (!target || target === host) {
      render(); // snap back to original position
      return;
    }

    const i = state.annotations.findIndex((a) => a.id === id);
    if (i === -1) return;
    const old = state.annotations[i];
    const updated = capture(target, old.comment);
    updated.id = old.id;
    updated.createdAt = old.createdAt;
    state.annotations[i] = updated;
    persist();
    render();
  }

  // ---------- Wire toolbar buttons ----------

  pointBtn.addEventListener("click", () => {
    state.pointing ? exitPointMode() : enterPointMode();
  });

  sendBtn.addEventListener("click", () => {
    if (state.done) {
      copyAnnotations();
    } else {
      if (state.annotations.length === 0) return;
      state.done = true;
      render();
    }
  });

  if (!isTouch) {
    sendBtn.addEventListener("mouseenter", () => {
      if (state.done && sendBtn.textContent === "✓ done") sendBtn.textContent = "Copy";
    });
    sendBtn.addEventListener("mouseleave", () => {
      if (state.done && sendBtn.textContent === "Copy") sendBtn.textContent = "✓ done";
    });
  }

  async function copyAnnotations() {
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
    sendBtn.textContent = "✓ copied";
    sendBtn.classList.add("copied");
    setTimeout(() => {
      sendBtn.classList.remove("copied");
      if (state.done) {
        sendBtn.textContent = isTouch ? "Copy" : (sendBtn.matches(":hover") ? "Copy" : "✓ done");
      } else {
        sendBtn.textContent = "Done";
      }
    }, 1400);
  }

  window.addEventListener("scroll", positionMarkers, { passive: true });
  window.addEventListener("resize", positionMarkers);

  render();
  console.log("[avis] toolbar installed — click '+ annotate' to point at an element. Existing annotations:", state.annotations.length);
})();
