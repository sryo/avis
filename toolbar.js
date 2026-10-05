// avis - feedback toolbar. Injected onto any page; exposes annotations on
// window.__avis for an AI agent to read back, edit, and reply to.

(function () {
  const VERSION = "2.1.0";
  const hosted = document.getElementById("__avis_host");
  // A stub stands down once the owning world's host is gone.
  if (window.__avis && (hosted || !window.__avis.info().mountedElsewhere)) return;
  // Host but no __avis: another JS world (page <script>, isolated world) owns the toolbar.
  if (hosted) {
    window.__avis = { VERSION, info: () => ({ v: VERSION, mountedElsewhere: true }) };
    return;
  }
  const STORAGE_KEY = "avis:annotations";
  const REV_KEY = "avis:rev";
  const CONSOLE_BUFFER_MAX = 200;
  const CONSOLE_WINDOW_MS = 60_000;
  const CONSOLE_LOG_PER_ANNOTATION = 20;

  const SUMMARY_FIELDS = [
    "id", "comment", "source", "replyTo",
    "sourceFile", "reactComponents",
    "element", "elementPath", "text", "nearbyText",
    "parentContext", "consoleLog", "priorClicks", "url",
    "styleTweaks",
  ];

  const TWEAKS_OPEN_KEY = "avis:controlsOpen";

  // Interaction states can't hold while the overlay has the pointer.
  const PSEUDO_SELECTOR_RE = /:(hover|focus|active|visited)|::/i;

  function rgbToHex(str) {
    if (!str) return "#000000";
    const s = String(str).trim();
    const m = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) return "#" + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, "0")).join("");
    if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(s)) return "#" + s.slice(1).split("").map((c) => c + c).join("").toLowerCase();
    return namedHex(s) || "#000000";
  }
  // Resolves named colors via canvas; null unless opaque.
  let colorCtx;
  function namedHex(v) {
    try {
      colorCtx = colorCtx || document.createElement("canvas").getContext("2d");
      colorCtx.fillStyle = "#010203";
      colorCtx.fillStyle = v;
      const h = colorCtx.fillStyle;
      return h[0] === "#" && h !== "#010203" && !/^current/i.test(v) ? h : null;
    } catch { return null; }
  }
  // Ring buffer of recent console.* output, sliced into each annotation at capture.
  const consoleBuffer = [];

  // Last N real user clicks (outside the toolbar), captured into each annotation so
  // an agent reading it back can reproduce overlay/menu state by replaying the chain.
  const PRIOR_CLICKS_MAX = 3;
  const clickChain = [];
  const CONSOLE_ARG_MAX = 200;
  const CONSOLE_ARG_READS = 64;
  // JSON-ish rendering that stops after CONSOLE_ARG_READS property reads or CONSOLE_ARG_MAX
  // chars, so logging a store or a DOM-heavy object can't stall the page.
  function serializeConsoleArg(a) {
    if (a == null) return String(a);
    const t = typeof a;
    if (t === "string") return clip(a);
    if (t !== "object") return t === "function" ? "[function]" : String(a);
    if (Object.prototype.toString.call(a) === "[object Error]") return clip(String(a.message));
    let out = "";
    let reads = 0;
    const seen = new Set();
    const full = () => out.length > CONSOLE_ARG_MAX || reads >= CONSOLE_ARG_READS;
    function walk(v, depth) {
      if (v === null || typeof v !== "object") {
        out += typeof v === "string" ? JSON.stringify(v.slice(0, CONSOLE_ARG_MAX))
          : typeof v === "function" ? '"[function]"'
          : v === undefined ? "null" : String(v);
        return;
      }
      if (Object.prototype.toString.call(v) === "[object Date]") { out += JSON.stringify(isNaN(v) ? "Invalid Date" : v.toISOString()); return; }
      const isArr = Array.isArray(v);
      if (seen.has(v) || depth > 4) { out += isArr ? '"[…]"' : '"{…}"'; return; }
      seen.add(v);
      let keys;
      try { keys = isArr ? null : Object.keys(v); } catch { out += '"[unserializable]"'; return; }
      reads++;
      const n = isArr ? v.length : keys.length;
      out += isArr ? "[" : "{";
      for (let i = 0; i < n; i++) {
        if (full()) return;
        if (i) out += ",";
        if (!isArr) out += JSON.stringify(keys[i]) + ":";
        reads++;
        let x;
        try { x = isArr ? v[i] : v[keys[i]]; } catch { x = "[threw]"; }
        walk(x, depth + 1);
      }
      out += isArr ? "]" : "}";
    }
    walk(a, 0);
    return full() || out.length > CONSOLE_ARG_MAX ? out.slice(0, CONSOLE_ARG_MAX) + "…" : out;
  }
  function clip(s) {
    return s.length > CONSOLE_ARG_MAX ? s.slice(0, CONSOLE_ARG_MAX) + "…" : s;
  }
  // avis's own logs go through the unpatched methods so they never land in consoleBuffer.
  // A main-world re-run (host removed, or a mount threw) sees the bridge's patch; __avisOrig is the real one.
  const pageConsole = { log: console.log.__avisOrig || console.log, warn: console.warn.__avisOrig || console.warn };
  const avisLog = (...args) => pageConsole.log.apply(console, args);
  const avisWarn = (...args) => pageConsole.warn.apply(console, args);
  function pushConsole(level, msg) {
    consoleBuffer.push({ level, ts: Date.now(), msg });
    if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
  }
  // The store as this tab last read or wrote it, and the token every write puts under
  // REV_KEY: persist() re-reads the store only when another tab changed the token.
  let storedRaw = null, rev = null;
  try { storedRaw = localStorage.getItem(STORAGE_KEY); rev = localStorage.getItem(REV_KEY); } catch {}
  const state = {
    annotations: load(storedRaw),
    pointing: false,
  };

  const findAnnotation = (id) => state.annotations.find((a) => a.id === id);
  const findAnnotationIndex = (id) => state.annotations.findIndex((a) => a.id === id);

  // Scalar id → scalar result; array of ids → array of results. `apply` mutates
  // state and returns the per-id result; `commit` runs once if anything changed.
  function batch(ids, apply, commit) {
    const list = Array.isArray(ids) ? ids : [ids];
    const results = list.map(apply);
    if (results.some(Boolean)) commit();
    return Array.isArray(ids) ? results : results[0];
  }

  const markerFor = (id) => markerLayer.querySelector(`.marker[data-annotation-id="${id}"]`);

  // Inline marker update instead of render() - status changes run in tight loops; render() is O(N).
  function setStatus(ids, status) {
    const next = status || undefined;
    const changed = [];
    return batch(ids, (id) => {
      const a = findAnnotation(id);
      if (!a || (a.status || undefined) === next) return false;
      if (next) a.status = next; else delete a.status;
      changed.push(a);
      return true;
    }, () => {
      persist();
      for (const a of changed) {
        const m = markerFor(a.id);
        if (m) {
          m.classList.toggle("working", a.status === "working");
          m.classList.toggle("acknowledged", a.status === "acknowledged");
        }
      }
    });
  }

  function removeAnnotations(ids, toResult) {
    return batch(ids, (id) => {
      const i = findAnnotationIndex(id);
      if (i === -1) return false;
      const [a] = state.annotations.splice(i, 1);
      return toResult(a);
    }, () => { persist(); render(); });
  }
  const resolveTarget = (path) => {
    if (!path) return null;
    try { return document.querySelector(path); } catch { return null; }
  };

  const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

  const api = {
    VERSION,
    get annotations() { return state.annotations.slice(); },
    get pageUrl() { return location.href; },
    summary(opts = {}) {
      const statuses = opts.status == null ? null : [].concat(opts.status);
      const list = opts.page ? currentPageAnnotations() : state.annotations;
      return list
        .filter((a) => !statuses || statuses.includes(a.status || "pending"))
        .map((a) => {
          const out = {};
          for (const k of SUMMARY_FIELDS) {
            if (k === "consoleLog" && !opts.console) continue;
            const v = a[k];
            if (isEmpty(v)) continue;
            out[k] = v && typeof v === "object" && !Array.isArray(v)
              ? Object.fromEntries(Object.entries(v).filter(([, x]) => !isEmpty(x)))
              : v;
          }
          if (!opts.console && a.consoleLog && a.consoleLog.length) out.consoleCount = a.consoleLog.length;
          out.status = a.status || "pending";
          return out;
        });
    },
    info() {
      const count = (status) => state.annotations.filter((a) => (a.status || "pending") === status).length;
      return {
        v: VERSION,
        page: location.href,
        total: state.annotations.length,
        onPage: currentPageAnnotations().length,
        pending: count("pending"),
        working: count("working"),
        persistOK: persistOK(),
      };
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
      const m = markerFor(id);
      if (m) {
        m.classList.add("revealing");
        setTimeout(() => m.classList.remove("revealing"), 800);
      }
      return true;
    },
    acknowledge(ids) { return setStatus(ids, "acknowledged"); },
    markWorking(ids) { return setStatus(ids, "working"); },
    unmarkWorking(ids) { return setStatus(ids, null); },
    resolve(ids) { return removeAnnotations(ids, () => true); },
    dismiss(ids, reason) {
      return removeAnnotations(ids, (a) => {
        avisLog("[avis] dismissed " + a.id + (reason ? ": " + reason : ""));
        return { id: a.id, comment: a.comment, reason: reason || null };
      });
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
      persist();
      render();
    },
    persistOK,
  };

  function isCurrentPage(a) {
    if (!a || !a.url) return false;
    try { return new URL(a.url).pathname === location.pathname; }
    catch { return false; }
  }

  function currentPageAnnotations() {
    return state.annotations.filter(isCurrentPage);
  }

  function load(raw) {
    try {
      const v = JSON.parse(raw || "[]");
      return Array.isArray(v) ? v.filter((a) => a && a.id) : [];
    } catch { return []; }
  }
  // Another tab wrote since storedRaw: keep ids it added, drop ids either side removed,
  // and keep our copy of ids both still have.
  function merge(raw) {
    const ids = (list) => new Set(list.map((a) => a.id));
    const theirs = load(raw), base = ids(load(storedRaw)), ours = ids(state.annotations), kept = ids(theirs);
    state.annotations = state.annotations.filter((a) => kept.has(a.id) || !base.has(a.id))
      .concat(theirs.filter((a) => !base.has(a.id) && !ours.has(a.id)));
  }
  let persistBroken = null; // unknown until the first write or persistOK()'s probe
  function persist() {
    const was = persistBroken;
    persistBroken = true;
    try {
      if (localStorage.getItem(REV_KEY) !== rev) {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw !== storedRaw) { merge(raw); scheduleRender(); }
      }
      const next = JSON.stringify(state.annotations);
      localStorage.setItem(STORAGE_KEY, next);
      localStorage.setItem(REV_KEY, rev = "" + Math.random());
      storedRaw = next;
      persistBroken = false;
    } catch (e) {
      if (!was) avisWarn("[avis] persist failed - annotations won't survive a reload.", e);
    }
    const tb = shadow.querySelector(".toolbar");
    if (tb) tb.classList.toggle("persist-broken", persistBroken);
  }
  // Probes with a scratch key so asking never rewrites the store or wakes other tabs' reloads.
  function persistOK() {
    if (persistBroken == null) {
      try { localStorage.setItem("avis:probe", "1"); localStorage.removeItem("avis:probe"); persistBroken = false; }
      catch { persistBroken = true; }
      shadow.querySelector(".toolbar").classList.toggle("persist-broken", persistBroken);
    }
    return !persistBroken;
  }
  // Chrome spends a few ms registering a storage listener, so it waits out the inject.
  setTimeout(() => addEventListener("storage", () => {
    // A tab that can't write keeps what it has rather than trading it for the other tab's copy.
    if (persistBroken) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== storedRaw) { state.annotations = load(storedRaw = raw); render(); }
  }));

  function getFiberKey(el) {
    for (const k in el) {
      if (k.startsWith("__reactFiber$")) return k;
    }
    return null;
  }

  // Fiber tags that aren't user components: host nodes (5, 6, 26, 27) and internal wrappers.
  const SKIP_TAGS = new Set([3, 4, 5, 6, 7, 8, 9, 10, 12, 13, 18, 19, 21, 22, 23, 24, 25, 26, 27]);
  const SKIP_NAMES = /^(Provider|Consumer|.+Boundary|.+Router|Outlet|Fragment|Suspense|Hot|Hot.*Reload|.*Overlay|.*Handler|Root|.*Wrapper|StrictMode|Profiler)$/;

  function isMinified(name) {
    return !name || name.length <= 2 || (name.length <= 3 && name === name.toLowerCase());
  }

  function getReactInfo(el) {
    // SSR nodes (RSC, Astro islands) have no fiber; their nearest hydrated ancestor does.
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
        const name = t && (t.displayName || t.name);
        if (!isMinified(name) && !SKIP_NAMES.test(name)) {
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

  // Runs in the main world via a <script> (see AGENTS.md, isolated world) and talks back
  // over DOM events. Built from the helpers above via toString: keep them self-contained.
  // Under strict CSP avis patches its own world instead.
  function mainWorldBridge() {
    if (window.__avisBridge) return;
    window.__avisBridge = true;
    // log/warn/error only - debug/info on chatty pages would dominate the buffer.
    for (const lvl of ["log", "warn", "error"]) {
      const orig = console[lvl];
      if (typeof orig !== "function") continue;
      console[lvl] = function (...args) {
        try {
          document.dispatchEvent(new CustomEvent("avis:console", { detail: lvl + ":" + args.map(serializeConsoleArg).join(" ") }));
        } catch {}
        return orig.apply(this, args);
      };
      console[lvl].__avisOrig = orig;
    }
    document.addEventListener("avis:react", (e) => {
      let info = null;
      try { info = getReactInfo(e.target); } catch {}
      document.dispatchEvent(new CustomEvent("avis:react-result", { detail: JSON.stringify(info) }));
    });
    document.addEventListener("avis:ping", () => document.dispatchEvent(new CustomEvent("avis:pong")));
  }

  document.addEventListener("avis:console", (e) => {
    const m = /^(log|warn|error):([^]*)/.exec(e.detail);
    if (m) pushConsole(m[1], m[2]);
  });
  let reactReply = null;
  document.addEventListener("avis:react-result", (e) => { reactReply = e.detail; });

  function installBridge() {
    const src = [
      `const CONSOLE_ARG_MAX = ${CONSOLE_ARG_MAX}, CONSOLE_ARG_READS = ${CONSOLE_ARG_READS};`,
      `const SKIP_TAGS = new Set(${JSON.stringify([...SKIP_TAGS])}), SKIP_NAMES = ${SKIP_NAMES};`,
      clip, serializeConsoleArg, getFiberKey, isMinified, getReactInfo, mainWorldBridge,
      "mainWorldBridge();",
    ].join("\n");
    try {
      const script = document.createElement("script");
      script.textContent = `(function () {\n${src}\n})();`;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    } catch { return false; }
    // The script ran synchronously if the main world answers a ping.
    let up = false;
    const pong = () => { up = true; };
    document.addEventListener("avis:pong", pong);
    document.dispatchEvent(new CustomEvent("avis:ping"));
    document.removeEventListener("avis:pong", pong);
    return up;
  }

  const bridged = installBridge();
  if (!bridged) {
    for (const lvl of ["log", "warn", "error"]) {
      const orig = console[lvl];
      if (typeof orig !== "function") continue;
      console[lvl] = function (...args) {
        try { pushConsole(lvl, args.map(serializeConsoleArg).join(" ")); } catch {}
        return orig.apply(console, args);
      };
    }
  }

  function reactInfo(el) {
    if (!bridged) return getReactInfo(el);
    reactReply = null;
    el.dispatchEvent(new CustomEvent("avis:react", { bubbles: true }));
    try { return reactReply ? JSON.parse(reactReply) : null; } catch { return null; }
  }

  const isUnique = (sel, el) => {
    try { return document.querySelector(sel) === el && document.querySelectorAll(sel).length === 1; }
    catch { return false; }
  };

  function getSelector(el) {
    // Prefer stable test/aria/id attrs; each candidate must uniquely identify el.
    // JSON.stringify on attr values handles the `\` and `"` escapes correctly for [attr="..."].
    const attr = (a, pre = "", v = el.getAttribute(a)) => v && `${pre}[${a}=${JSON.stringify(v)}]`;
    const aria = el.getAttribute("aria-label");
    for (const sel of [
      attr("data-testid"), attr("data-test"),
      /^[a-z][\w-]*$/i.test(el.id) && "#" + el.id,
      aria && aria.length < 80 && attr("aria-label", el.tagName.toLowerCase()),
    ]) if (sel && isUnique(sel, el)) return sel;
    // Path cascade - short-circuit at the first depth that's already unique.
    const parts = [];
    let cur = el;
    while (cur && cur !== document.body && cur.nodeType === 1) {
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
    }
    if (cur) parts.unshift("body");
    return parts.join(" > ");
  }

  function visibleText(el, max = 120) {
    const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  function nearbyText(el) {
    const pt = el.parentElement ? visibleText(el.parentElement, 200) : "";
    return pt && pt !== visibleText(el, 200) ? pt.slice(0, 80) : "";
  }

  function a11y(el) {
    const out = [];
    const add = (a, q = "") => { const v = el.getAttribute(a); if (v) out.push(`${a}=${q}${v}${q}`); };
    add("role"); add("aria-label", '"'); add("name"); add("placeholder", '"');
    if (el.tagName === "INPUT") add("type");
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

  const newId = () => "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function capture(el, comment, opts = {}) {
    const r = el.getBoundingClientRect();
    const react = reactInfo(el);
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
      id: newId(),
      comment,
      source: opts.source || "user",
      replyTo: opts.replyTo || null,
      element: el.tagName.toLowerCase(),
      elementPath: opts.selector || getSelector(el),
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
      priorClicks: clickChain.slice(),
      url: location.href,
      pageTitle: document.title,
      viewport,
      client,
      timestamp: Date.now(),
    };
  }

  // Just enough for renderMarkers to place the in-progress marker; capture() runs on commit.
  function placeholderAnnotation(el, selector) {
    const r = el.getBoundingClientRect();
    return {
      id: "tentative",
      comment: "",
      source: "user",
      elementPath: selector,
      boundingBox: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      viewport: { scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
    };
  }

  const host = document.createElement("div");
  host.id = "__avis_host";
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  // Shadow DOM for style isolation. The host joins the page once mount succeeds.
  const shadow = host.attachShadow({ mode: "open" });
  // Nodes, not innerHTML: Trusted Types pages reject HTML strings.
  function h(tag, cls, attrs, ...kids) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    e.append(...kids);
    return e;
  }

  const style = document.createElement("style");
  style.textContent = `
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
    .copy-state.copied, .copy-state.failed,
    .btn.copied .normal, .btn.copy-failed .normal { visibility: hidden; }
    .btn.copied .copied, .btn.copy-failed .failed { visibility: visible; }
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
      cursor: grab; user-select: none;
    }
    /* Reply: the agent's parent comment quoted in lavender on the yellow paper. */
    .popup.reply .label {
      background: linear-gradient(180deg, #f0e7ff 0%, #e2d4ff 100%);
      color: #2a1f4d;
      padding: 8px 10px;
      font-family: -apple-system, system-ui, sans-serif;
      font-size: 12px;
      opacity: 1;
      word-break: normal;
    }
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
    .popup .hint { font-size: 10px; opacity: .45; margin-top: 10px; }
    .popup .trail {
      font-size: 10px;
      opacity: .6;
      margin-bottom: 6px;
      font-family: ui-monospace, monospace;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .popup .trail:empty { display: none; }

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
    .marker.dragging { cursor: grabbing; opacity: .85; }
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
    .marker.acknowledged { opacity: .6; }
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

    .popup-tweaks-toggle {
      margin-top: 10px; background: transparent; border: 0; padding: 0;
      font: 11px/1.2 ui-monospace, monospace;
      color: #1a1a0e; opacity: .55;
      cursor: pointer; user-select: none;
      display: flex; align-items: center; gap: 6px; width: 100%;
    }
    .popup-tweaks-toggle:hover { opacity: 1; }
    .popup-tweaks-toggle .popup-tweaks-leader { flex: 1; opacity: .35; overflow: hidden; }
    .popup-tweaks-toggle .popup-tweaks-chevron { font-size: 9px; }
    .popup-tweaks {
      margin-top: 8px;
      max-height: 240px; overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: rgba(26,26,14,.35) transparent;
    }
    .popup-rule {
      margin-bottom: 8px;
      border-top: 1px dashed rgba(26,26,14,.22);
      padding-top: 6px;
    }
    .popup-rule:first-child { border-top: 0; padding-top: 0; }
    .popup-rule-selector {
      font: 600 11px/1.2 ui-monospace, monospace;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .popup-rule-source {
      font: italic 9px/1.2 -apple-system, system-ui, sans-serif;
      opacity: .45;
      margin-bottom: 4px;
    }
    .popup-decl {
      display: grid; grid-template-columns: 76px 1fr 32px;
      gap: 6px; align-items: center;
      padding: 2px 0;
    }
    .popup-decl-edges {
      grid-template-columns: 76px 1fr 18px;
      align-items: stretch;
    }
    .popup-decl-label {
      font: 10px/1.2 ui-monospace, monospace;
      opacity: .65;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      align-self: center;
    }
    .popup-decl input[type=color] {
      width: 100%; height: 18px; padding: 0;
      border: 1px solid rgba(26,26,14,.25); border-radius: 2px;
      background: transparent; cursor: pointer;
    }
    .popup-length-input,
    .popup-edge-all,
    .popup-edge-input {
      width: 100%; min-width: 0;
      font: 10px/1.2 ui-monospace, monospace;
      color: #1a1a0e;
      background: transparent;
      border: 1px solid rgba(26,26,14,.22);
      border-radius: 2px;
      padding: 2px 4px;
    }
    .popup-length-input:focus,
    .popup-edge-all:focus,
    .popup-edge-input:focus {
      outline: none; border-color: #7a6a2e;
    }
    .popup-edge-input { text-align: center; padding: 1px 2px; }
    .popup-length-unit {
      font: 10px/1 ui-monospace, monospace;
      opacity: .45;
      text-align: left;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .popup-decl .popup-decl-readonly {
      grid-column: 2 / 4;
      font: 10px/1.2 ui-monospace, monospace;
      opacity: .45;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .popup-decl.touched .popup-decl-label,
    .popup-decl.touched .popup-length-unit {
      opacity: 1; font-weight: 600;
    }
    .popup-edge-link {
      background: transparent; border: 0; padding: 0;
      font: 13px/1 ui-monospace, monospace;
      color: #1a1a0e; opacity: .35; cursor: pointer;
      align-self: center;
    }
    .popup-edge-link:hover { opacity: 1; }
    .popup-edge-link[aria-pressed="true"] { opacity: .7; }
    .popup-edge-grid {
      display: grid;
      grid-template-areas:
        ".    top    ."
        "left box right"
        ".   bottom  .";
      grid-template-columns: 1fr 1fr 1fr;
      gap: 2px;
      align-items: center;
      justify-items: stretch;
    }
    .popup-edge-grid[data-shape="corners"] {
      grid-template-areas:
        "tl  .  tr"
        " . box  ."
        "bl  .  br";
    }
    .popup-edge-diagram {
      grid-area: box;
      position: relative;
      align-self: center; justify-self: center;
      width: 28px; height: 22px;
    }
    .popup-edge-diagram .d-outer,
    .popup-edge-diagram .d-ring,
    .popup-edge-diagram .d-inner {
      position: absolute; inset: 0;
      border: 1px solid rgba(26,26,14,.22);
    }
    .popup-edge-diagram .d-ring  { inset: 3px; background: rgba(26,26,14,.04); }
    .popup-edge-diagram .d-inner { inset: 6px; background: rgba(26,26,14,.10); border: 0; border-radius: 1px; }
    /* The focused input highlights its edge: a border side on the outer box (margin,
       inset) or ring (border-width), an inset shadow on the inner box otherwise.
       Unset --s makes box-shadow invalid at computed time, i.e. none. */
    .popup-edge-grid[data-active=top] { --t: #7a6a2e; --s: 0 1px; }
    .popup-edge-grid[data-active=right] { --r: #7a6a2e; --s: -1px 0; }
    .popup-edge-grid[data-active=bottom] { --b: #7a6a2e; --s: 0 -1px; }
    .popup-edge-grid[data-active=left] { --l: #7a6a2e; --s: 1px 0; }
    .popup-edge-grid[data-active=tl] { --s: 1px 1px; }
    .popup-edge-grid[data-active=tr] { --s: -1px 1px; }
    .popup-edge-grid[data-active=bl] { --s: 1px -1px; }
    .popup-edge-grid[data-active=br] { --s: -1px -1px; }
    .popup-edge-grid:is([data-prop=margin], [data-prop=inset]) .d-outer,
    .popup-edge-grid[data-prop=border-width] .d-ring {
      border-color: var(--t, rgba(26,26,14,.22)) var(--r, rgba(26,26,14,.22)) var(--b, rgba(26,26,14,.22)) var(--l, rgba(26,26,14,.22));
    }
    .popup-edge-grid:is([data-prop=padding], [data-prop=border-radius]) .d-inner { box-shadow: inset var(--s) 0 0 #7a6a2e; }
    /* Each corner input rounds its own corner of the inner rect, live. */
    .popup-edge-grid[data-prop=border-radius] .d-inner {
      border-radius: var(--r-tl, 1px) var(--r-tr, 1px) var(--r-br, 1px) var(--r-bl, 1px);
    }
    .popup-rule-undo {
      background: transparent; border: 0; padding: 2px 0;
      font: 10px/1 ui-monospace, monospace;
      color: #1a1a0e; opacity: .5; cursor: pointer;
      margin-top: 2px;
    }
    .popup-rule-undo:hover { opacity: 1; text-decoration: underline; }
    .popup-tweaks-unreadable {
      font: 9px/1.2 ui-monospace, monospace;
      opacity: .4;
      margin-top: 6px;
    }
  `;
  shadow.append(
    style,
    h("div", "toolbar", { role: "toolbar", "aria-label": "avis" },
      h("a", "brand", { href: "https://github.com/sryo/avis", target: "_blank", rel: "noopener noreferrer" }, "avis"),
      h("span", "annotate-stack", 0, h("button", "btn", { "data-act": "point" }, "+ annotate")),
      h("button", "btn primary", { "data-act": "copy" },
        h("span", "copy-stack", 0,
          h("span", "copy-state normal", 0, "copy", h("span", "copy-count")),
          h("span", "copy-state copied", 0, "✓ copied"),
          h("span", "copy-state failed", 0, "✗ copy failed")))),
    h("div", "marker-layer"));

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
    const total = state.annotations.length, n = total + (tentativeAnnotation ? 1 : 0);
    copyCount.textContent = n ? String(n) : "";
    pointBtn.classList.toggle("active", state.pointing);
    pointBtn.textContent = state.pointing ? "done" : "+ annotate";
    copyBtn.disabled = !total;
    renderMarkers(currentPageAnnotations());
  }

  function renderMarkers(currentPage) {
    const list = tentativeAnnotation
      ? [...currentPage, tentativeAnnotation]
      : currentPage;
    const old = new Map();
    for (const m of markerLayer.children) old.set(m.dataset.annotationId, m);
    const stackByEl = new Map();
    markerLayer.replaceChildren(...list.map((a, i) => {
      const m = old.get(a.id) || document.createElement("div");
      m.className = "marker";
      if (a.source === "agent") m.classList.add("agent");
      if (a === tentativeAnnotation || a.id === editingId) m.classList.add("tentative");
      if (a.status === "working" || a.status === "acknowledged") m.classList.add(a.status);
      m.textContent = String(i + 1);
      m.title = a.comment;
      m.dataset.annotationId = a.id;
      let target = m._targetEl;
      if (!target || !target.isConnected || m._elementPath !== a.elementPath || !target.matches(a.elementPath)) target = resolveTarget(a.elementPath);
      m._targetEl = target;
      m._elementPath = a.elementPath || null;
      const bb = a.boundingBox;
      const vp = a.viewport;
      if (bb && vp) {
        m._orphanAbsX = bb.x + (vp.scrollX || 0) + bb.width - 11;
        m._orphanAbsY = bb.y + (vp.scrollY || 0) - 11;
      }
      const stackIdx = target ? (stackByEl.get(target) || 0) : 0;
      m._stackIndex = stackIdx;
      if (target) stackByEl.set(target, stackIdx + 1);
      if (dragState && dragState.id === a.id) {
        dragState.marker = m;
        if (dragState.moved) m.classList.add("dragging");
      }
      return m;
    }));
    positionMarkers();
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
        const r = el && el.getBoundingClientRect();
        // Gone or hidden: the capture-time spot, read before any write.
        reads.push(r && (r.width > 0 || r.height > 0) ? { x: r.right - 11, y: r.top - 11 }
          : m._orphanAbsX === undefined ? null : { x: m._orphanAbsX - scrollX, y: m._orphanAbsY - scrollY });
      });
      markers.forEach((m, i) => {
        const p = reads[i];
        if (!p) return;
        const left = Math.round(p.x) + "px";
        const top = Math.round(p.y + (m._stackIndex || 0) * 26) + "px";
        if (m.style.left !== left) m.style.left = left;
        if (m.style.top !== top) m.style.top = top;
      });
    });
  }

  // Over our chrome (not the overlay) this is host: no target.
  function elementBeneathPoint(x, y) {
    const els = document.elementsFromPoint(x, y);
    if (els[0] === host && shadow.elementsFromPoint(x, y)[0] !== overlay) return host;
    return els.find((el) => el !== host) || null;
  }

  function enterPointMode() {
    if (state.pointing) return;
    state.pointing = true;
    overlay = h("div", "overlay");
    outline = h("div", "outline");
    outline.style.display = "none";
    shadow.append(overlay, outline);
    overlay.addEventListener("mousemove", onHover);
    overlay.addEventListener("click", onPick);
    overlay.addEventListener("contextmenu", (e) => { e.preventDefault(); exitPointMode(); });
    window.addEventListener("keydown", onKeydown, true);
    render();
  }

  function exitPointMode() {
    state.pointing = false;
    if (overlay) { overlay.remove(); overlay = null; }
    if (outline) { outline.remove(); outline = null; }
    lastHoverEl = null;
    window.removeEventListener("keydown", onKeydown, true);
    render();
  }

  function onKeydown(e) {
    // Staged: a marker drag owns Escape (onMarkerDragKey), then the popup, then point mode.
    if (e.key !== "Escape" || dragState) return;
    if (popup) {
      closePopup();
      if (overlay) overlay.style.pointerEvents = "auto";
      // Replay hover so the outline reappears without waiting for a mousemove.
      if (state.pointing) { lastHoverEl = null; onHover({ clientX: lastHoverX, clientY: lastHoverY }); }
    } else if (state.pointing) {
      exitPointMode();
    } else return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  let lastHoverX = 0, lastHoverY = 0;
  function onHover(e) {
    lastHoverX = e.clientX; lastHoverY = e.clientY;
    const el = elementBeneathPoint(e.clientX, e.clientY);
    if (!el || el === host) {
      if (lastHoverEl !== null) { outline.style.display = "none"; lastHoverEl = null; }
      return;
    }
    if (el === lastHoverEl) return;
    lastHoverEl = el;
    showBox(outline, el);
  }

  const showBox = (o, el) => {
    const r = el.getBoundingClientRect();
    Object.assign(o.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  };

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
    const selector = el ? getSelector(el) : null;
    // Outside point mode the popup owns the Escape listener.
    const ownsKeydown = !state.pointing;
    if (ownsKeydown) window.addEventListener("keydown", onKeydown, true);
    popup = h("div", "popup" + (isReply ? " reply" : ""), 0,
      h("div", "trail"),
      h("div", "label"),
      h("textarea", 0, { placeholder: isReply ? "reply…" : "What should change?" }),
      h("div", "hint", 0, "click outside to save · esc to discard"));
    popup._ownsKeydown = ownsKeydown;
    popup.querySelector(".label").textContent = isReply
      ? `↪ ${(existing.comment || "").slice(0, 60)}`
      : isEdit
      ? `<${existing.element}> "${(existing.text || "").slice(0, 40)}"`
      : describe(el);
    // Breadcrumb of the clicks that led here; a create reads clickChain, capture() waits for commit.
    const trail = isCreate ? clickChain.slice() : ((existing && existing.priorClicks) || []);
    if (trail.length) {
      popup.querySelector(".trail").textContent = trail.map((c) => c.target).join(" › ");
    }
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
      tentativeAnnotation = placeholderAnnotation(el, selector);
    }
    render();

    // Tweak rules, not for replies. An edit (el = null) resolves the saved selector;
    // with no matching rules the toggle never mounts.
    let previewSheet = null;
    const ruleBlocks = [];
    // "block|property" → styleTweak; newest per property wins. Unplaceable saved tweaks stay as-is.
    const edits = new Map();
    let kept = isEdit && Array.isArray(existing.styleTweaks) ? existing.styleTweaks : [];
    if (!isReply) {
      const targetEl = el || resolveTarget(existing && existing.elementPath);
      if (targetEl) {
        const { rules, unreadable } = discoverMatchedRules(targetEl);
        if (rules.length) {
          previewSheet = createPreviewSheet();
          previewSheet.attach(selector || getSelector(targetEl));

          const chev = h("span", "popup-tweaks-chevron");
          const toggle = h("button", "popup-tweaks-toggle", { type: "button" }, chev,
            h("span", 0, 0, `tweak rules · ${rules.length} rule${rules.length === 1 ? "" : "s"}`),
            h("span", "popup-tweaks-leader", 0, "·".repeat(60)));
          const tweaksRoot = h("div", "popup-tweaks");

          rules.forEach((entry, i) => {
            const source = ruleSourceLabel(entry);
            const rb = buildRuleBlock(entry, source, (decl, after) => {
              const k = i + "|" + decl.property;
              edits.delete(k);
              edits.set(k, { selector: entry.selectorText, source, property: decl.property, before: decl.value, after });
              previewSheet.set(decl.property, after);
            }, (property) => {
              edits.delete(i + "|" + property);
              const last = [...edits.values()].filter((t) => t.property === property).pop();
              last ? previewSheet.set(property, last.after) : previewSheet.clear(property);
            });
            ruleBlocks.push({ selector: entry.selectorText, hydrateTweak: rb.hydrateTweak });
            tweaksRoot.appendChild(rb.block);
          });

          if (unreadable) {
            tweaksRoot.appendChild(h("div", "popup-tweaks-unreadable", 0,
              `· ${unreadable} stylesheet${unreadable === 1 ? "" : "s"} unreadable (cross-origin)`));
          }

          let isOpen = false;
          try { isOpen = localStorage.getItem(TWEAKS_OPEN_KEY) === "1"; } catch {}
          const applyOpen = (open) => {
            isOpen = open;
            chev.textContent = open ? "▾" : "▸";
            tweaksRoot.hidden = !open;
          };
          applyOpen(isOpen);
          toggle.addEventListener("click", () => {
            applyOpen(!isOpen);
            try { localStorage.setItem(TWEAKS_OPEN_KEY, isOpen ? "1" : "0"); } catch {}
          });

          const hint = popup.querySelector(".hint");
          popup.insertBefore(toggle, hint);
          popup.insertBefore(tweaksRoot, hint);

          kept = kept.filter((t) => !(typeof t.after === "string" &&
            ruleBlocks.some((rb) => rb.selector === t.selector && rb.hydrateTweak(t.property, t.after))));
        }
      }
    }
    popup._previewSheet = previewSheet;

    function collectTweaks() {
      const byProp = new Map();
      for (const t of edits.values()) { byProp.delete(t.property); byProp.set(t.property, t); }
      return [...kept, ...byProp.values()];
    }

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
      document.removeEventListener("mousemove", onPopupDrag);
      document.removeEventListener("mouseup", onPopupDragEnd);
      drag = null;
      popup.classList.remove("dragging");
    }
    popup._endDrag = onPopupDragEnd;

    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) commit();
    });

    // A marker's own mousedown commits, so the same gesture can start a drag.
    function onOutside(e) {
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
      const tweaks = collectTweaks();
      const hasTweaks = tweaks.length > 0;
      // Detach the preview sheet before capture() reads computedStyles so the snapshot
      // reflects the baseline page, not the in-progress overrides.
      if (previewSheet) previewSheet.detach();
      let changed = true;
      if (isEdit) {
        const i = findAnnotationIndex(existing.id);
        if (i !== -1) {
          if (!text && !hasTweaks) {
            state.annotations.splice(i, 1);
          } else {
            const updated = { ...state.annotations[i], comment: text };
            if (hasTweaks) updated.styleTweaks = tweaks;
            else delete updated.styleTweaks;
            state.annotations[i] = updated;
          }
        }
      } else if (text || hasTweaks) {
        // A reply whose parent's element is gone anchors to the parent's saved geometry.
        const { element, elementPath, x, y, boundingBox, viewport } = existing || {};
        const ann = el
          ? capture(el, text, { replyTo: isReply ? existing.id : null, selector })
          : { id: newId(), comment: text, source: "user", replyTo: existing.id, element, elementPath, x, y, boundingBox, viewport, url: location.href, timestamp: Date.now() };
        if (hasTweaks) ann.styleTweaks = tweaks;
        state.annotations.push(ann);
      } else changed = false;
      if (changed) persist();
      closePopup();
      // Stay in point mode after a create so the user can keep batch-annotating.
      if (overlay) overlay.style.pointerEvents = "auto";
      render();
    }
  }

  function closePopup() {
    if (popup) {
      if (popup._previewSheet) popup._previewSheet.detach();
      if (popup._endDrag) popup._endDrag();
      if (popup._onOutside) document.removeEventListener("pointerdown", popup._onOutside, true);
      if (popup._ownsKeydown) window.removeEventListener("keydown", onKeydown, true);
      popup.remove();
      popup = null;
    }
    tentativeAnnotation = null;
    editingId = null;
  }

  // Commas in quotes, [] or up to two levels of () don't split.
  const splitSelectors = (s) =>
    (s.match(/(?:\((?:\([^()]*\)|[^()])*\)|\[[^\]]*\]|"[^"]*"|'[^']*'|\\.|[^,])+/g) || []).map((p) => p.trim());

  // Block conditions are checked only once a rule inside matched.
  function discoverMatchedRules(el) {
    const rules = [];
    let unreadable = 0;
    const matches = (s) => { try { return el.matches(s); } catch {} };
    function walk(rule, parent) {
      const mark = rules.length;
      let sel = parent;
      // Typeless with a style: CSSNestedDeclarations.
      if (rule.type === 1 || (parent && !rule.type && rule.style)) {
        sel = rule.selectorText ?? parent;
        if (parent && rule.selectorText) sel = splitSelectors(sel).map((s) => (/&/.test(s) ? s : "& " + s).replace(/&/g, `:is(${parent})`)).join(", ");
        if (rule.style.length && matches(sel) !== false &&
            splitSelectors(sel).some((s) => !PSEUDO_SELECTOR_RE.test(s) && matches(s))) rules.push({ rule, selectorText: sel });
      }
      if (rule.constructor.name === "CSSStartingStyleRule") return;
      let list;
      try { list = rule.type === 3 ? rule.styleSheet?.cssRules : rule.cssRules; } catch { unreadable++; }
      if (list) for (const r of list) walk(r, sel);
      const q = rule.media?.mediaText;
      if (rules.length > mark && (rule.type === 12 ? !CSS.supports(rule.conditionText) : q && !matchMedia(q).matches)) rules.length = mark;
    }
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      if (!ownSheets.has(sheet.ownerNode || sheet)) walk(sheet);
    }
    if (el.style.length) rules.push({ rule: { style: el.style, _inline: true }, selectorText: "(inline)" });
    return { rules, unreadable };
  }

  function ruleSourceLabel(entry) {
    if (entry.rule._inline) return "inline";
    const sheet = entry.rule.parentStyleSheet;
    if (sheet.href) return new URL(sheet.href).pathname.split("/").pop() || sheet.href;
    const owner = sheet.ownerNode;
    if (owner?.localName === "style") return owner.id ? `<style id="${owner.id}">` : "<style>";
    return "(stylesheet)";
  }

  // CSSOM lists `padding: 8px 16px` as four longhands; these fold back into one edges
  // control. Longhand order matches the shorthand's value order.
  const LONGHAND_GROUPS = [
    ["padding", ["padding-top", "padding-right", "padding-bottom", "padding-left"]],
    ["margin", ["margin-top", "margin-right", "margin-bottom", "margin-left"]],
    ["inset", ["top", "right", "bottom", "left"]],
    ["border-width", ["border-top-width", "border-right-width", "border-bottom-width", "border-left-width"]],
    ["border-radius", ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"]],
  ];

  function readDeclarations(entry) {
    const s = entry.rule.style;
    const raw = [];
    for (let i = 0; i < s.length; i++) {
      let property = s[i];
      let value = s.getPropertyValue(property).trim();
      // var() in a shorthand leaves its longhands "": show the shorthand.
      if (!value) {
        const g = LONGHAND_GROUPS.find((x) => x[1].includes(property));
        for (let p = g ? g[0] + "-" : property; !value && p.includes("-"); property = p) {
          p = p.replace(/-[^-]*$/, "");
          value = s.getPropertyValue(p).trim();
        }
        if (!value || raw.some((d) => d.property === property)) continue;
      }
      raw.push({ property, value, priority: s.getPropertyPriority(property) });
    }
    const byProp = new Map(raw.map((d) => [d.property, d]));
    const shorthandAt = new Map();
    const folded = new Set();
    for (const [shorthand, longhands] of LONGHAND_GROUPS) {
      const parts = longhands.map((p) => byProp.get(p));
      if (parts.some((d) => !d) || parts.some((d) => d.priority !== parts[0].priority)) continue;
      const parsed = parseShorthand4(parts.map((d) => d.value).join(" "));
      if (!parsed) continue;
      shorthandAt.set(raw.find((d) => longhands.includes(d.property)), {
        property: shorthand,
        value: formatShorthand4(parsed.values, parsed.unit),
      });
      for (const p of longhands) folded.add(p);
    }
    const out = [];
    for (const d of raw) {
      const decl = shorthandAt.get(d) || (folded.has(d.property) ? null : d);
      if (decl) out.push({ property: decl.property, value: decl.value, ...inferControl(decl.value, decl.property) });
    }
    return out;
  }

  // "8" → {n:8,unit:fallback}; "8px" → {n:8,unit:"px"}; "auto" → {raw:"auto"}.
  function parseDimension(text, fallbackUnit = "px") {
    const s = String(text ?? "").trim();
    if (!s) return null;
    if (/^(auto|inherit|initial|unset)$/.test(s)) return { raw: s };
    const m = s.match(/^(-?\d*\.?\d+)\s*(px|rem|em|%|vw|vh|fr|ch|ex)?$/i);
    if (!m) return null;
    return { n: parseFloat(m[1]), unit: (m[2] || fallbackUnit || "px").toLowerCase() };
  }

  // "8px 16px 12px 4px" → {values:[t,r,b,l], unit}. Null on mixed nonzero units, auto, or invalid.
  function parseShorthand4(value) {
    const tokens = String(value).trim().split(/\s+/);
    if (tokens.length > 4) return null;
    const parsed = tokens.map((t) => parseDimension(t, "px"));
    if (parsed.some((p) => !p || p.n == null)) return null;
    const units = new Set(parsed.filter((p) => p.n).map((p) => p.unit));
    if (units.size > 1) return null;
    const unit = [...units][0] || parsed[0].unit;
    const [t, r = t, b = t, l = r] = parsed.map((p) => p.n);
    return { values: [t, r, b, l], unit };
  }

  const round3 = (n) => Math.round(n * 1000) / 1000;
  // [t,r,b,l] → shortest CSS form: "8px", "8px 16px", "8px 16px 12px", "8px 16px 12px 4px".
  function formatShorthand4(values, unit) {
    const [t, r, b, l] = values;
    const n = l !== r ? 4 : b !== t ? 3 : r !== t ? 2 : 1;
    return values.slice(0, n).map((v) => round3(v) + unit).join(" ");
  }

  const unitStep = (unit) => /^(r?em|ch|ex)$/.test(unit) ? 0.05 : 1;

  // → {kind, ...range/unit info}
  function inferControl(value, property) {
    const v = value.trim();
    if (/^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$|(rgb|hsl)a?\()/i.test(v) ||
        (/color|fill|stroke/.test(property) && /^[a-z]+$/i.test(v) && namedHex(v))) return { kind: "color" };
    const parsed = LONGHAND_GROUPS.some((g) => g[0] === property) && parseShorthand4(v);
    if (parsed) return { kind: "edges", shape: property === "border-radius" ? "corners" : "sides", ...parsed };
    const lenMatch = v.match(/^(-?\d+(?:\.\d+)?)(px|rem|em|%|vw|vh|fr|ch|ex)$/i);
    if (lenMatch) {
      const unit = lenMatch[2].toLowerCase();
      return { kind: "length", unit, step: unitStep(unit) };
    }
    if (/^-?\d+(?:\.\d+)?$/.test(v)) {
      const n = parseFloat(v);
      const isFractional = !Number.isInteger(n) || (n >= 0 && n <= 1 && !/^(z-index|order|orphans|widows|.*-count)$/.test(property));
      return { kind: "number", step: isFractional ? 0.01 : 1 };
    }
    return { kind: "readonly" };
  }

  // A constructable sheet, or a <style> where CSP rejects one; !important on the
  // element's unique selector beats author rules without touching them.
  const ownSheets = new WeakSet();
  function createPreviewSheet() {
    const tweaks = new Map(); // property → formatted value
    let selector = null;
    let sheet = null; // CSSStyleSheet, or the <style> fallback
    function flush() {
      if (!selector || !sheet) return;
      const body = [...tweaks].map(([p, v]) => `${p}: ${v} !important;`).join(" ");
      const css = body ? `${selector} { ${body} }` : "";
      if (sheet.replaceSync) sheet.replaceSync(css);
      else sheet.textContent = css;
    }
    return {
      attach(sel) {
        selector = sel;
        if (!sheet) {
          try {
            sheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
          } catch {
            document.head.appendChild(sheet = document.createElement("style"));
          }
          ownSheets.add(sheet);
        }
        flush();
      },
      set(prop, formatted) { tweaks.set(prop, formatted); flush(); },
      clear(prop) { tweaks.delete(prop); flush(); },
      detach() {
        if (sheet && sheet.remove) sheet.remove();
        else if (sheet) document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
        sheet = selector = null;
        tweaks.clear();
      },
    };
  }

  const textInput = (cls, attrs) => h("input", cls, { type: "text", spellcheck: "false", ...attrs });

  // Enter commits. With `read`, ArrowUp/Down hand read() ± step() (Shift = 10x) to write().
  function stepKeys(input, step, read, write) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); return; }
      const dir = e.key === "ArrowUp" ? 1 : e.key === "ArrowDown" ? -1 : 0;
      if (!dir || !read) return;
      const cur = read();
      if (Number.isNaN(cur)) return;
      e.preventDefault();
      write(round3(cur + dir * step() * (e.shiftKey ? 10 : 1)));
    });
  }

  // Each control fills `row` after its label and returns setValue.
  function lengthControl(row, decl, onChange) {
    const unit = decl.kind === "length" ? decl.unit : "";
    const input = textInput("popup-length-input", { inputmode: "decimal" });
    input.value = decl.value;
    row.append(input, h("span", "popup-length-unit", 0, unit));
    function emit() {
      const p = parseDimension(input.value, unit);
      if (!p) return;
      if (p.raw) return onChange(p.raw);
      onChange(input.value = unit ? round3(p.n) + p.unit : String(round3(p.n)));
    }
    let p;
    input.addEventListener("change", emit);
    stepKeys(input, () => decl.step || 1, () => (p = parseDimension(input.value, unit)) ? +p.n : NaN,
      (n) => { input.value = unit ? n + p.unit : String(n); emit(); });
    return (v) => { input.value = v; };
  }

  // Four sides or corners, linked or separate; emits one shorthand string.
  function edgeControl(row, decl, onChange) {
    const corners = decl.shape === "corners";
    const keys = corners ? ["tl", "tr", "br", "bl"] : ["top", "right", "bottom", "left"];
    let values = decl.values.slice(), unit = decl.unit;
    const allInput = textInput("popup-edge-all");
    const grid = h("div", "popup-edge-grid", { "data-shape": decl.shape, "data-prop": decl.property, "data-active": "" });
    const inputs = keys.map((key, i) => {
      const inp = textInput("popup-edge-input", { inputmode: "decimal", [corners ? "data-corner" : "data-side"]: key });
      inp.style.gridArea = key;
      // Focus drives the diagram highlight; change parses one cell.
      inp.addEventListener("focus", () => { grid.dataset.active = key; });
      inp.addEventListener("blur", () => { grid.dataset.active = ""; });
      inp.addEventListener("change", () => {
        const p = parseDimension(inp.value, unit);
        // Sides share one unit: another unit only while the other sides are 0.
        const ok = p && p.n != null && !(p.n && p.unit !== unit && values.some((v, j) => v && j !== i));
        if (ok) { values[i] = p.n; if (p.n) unit = p.unit; }
        inp.value = String(values[i]);
        if (ok) emit();
      });
      stepKeys(inp, () => unitStep(unit), () => parseFloat(inp.value), (n) => { values[i] = n; inp.value = String(n); emit(); });
      return inp;
    });
    grid.append(...inputs, h("div", "popup-edge-diagram", 0, h("div", "d-outer", 0, h("div", "d-ring", 0, h("div", "d-inner")))));
    const link = h("button", "popup-edge-link", { type: "button", title: "link / unlink sides" }, "⛓");
    row.append(link); // setMode puts allInput or grid before it

    function syncRadius() {
      if (corners) keys.forEach((k, i) => grid.style.setProperty("--r-" + k, Math.min(Math.max(values[i] / 4, 0), 6) + "px"));
    }
    function emit() {
      onChange(formatShorthand4(values, unit));
      syncRadius();
    }
    function setMode(linked) {
      const show = linked ? allInput : grid;
      row.dataset.mode = linked ? "linked" : "separate";
      (linked ? grid : allInput).remove();
      if (show.parentNode !== row) row.insertBefore(show, link);
      if (linked) allInput.value = formatShorthand4(values, unit);
      else inputs.forEach((inp, i) => { inp.value = String(values[i]); });
      link.setAttribute("aria-pressed", linked);
    }
    function autoMode() {
      setMode(values.every((v) => v === values[0]));
      syncRadius();
    }
    function take(v) {
      const p = parseShorthand4(v);
      if (p) ({ values, unit } = p);
      return p;
    }
    allInput.addEventListener("change", () => {
      const ok = take(allInput.value);
      allInput.value = formatShorthand4(values, unit);
      if (ok) emit();
    });
    stepKeys(allInput);
    link.addEventListener("click", () => setMode(row.dataset.mode !== "linked"));
    autoMode();
    return (v) => { take(v); autoMode(); };
  }

  function colorControl(row, decl, onChange) {
    const input = h("input", 0, { type: "color" });
    const badge = h("span", "popup-length-unit");
    const setValue = (v) => { input.value = rgbToHex(v); badge.textContent = input.value; };
    setValue(decl.value);
    // The picker has no alpha; keep the original's.
    const alpha = decl.value.match(/(?:(?:[^,]*,){3}|\/)\s*([\d.]+)(%?)\s*\)$/);
    const a = alpha ? alpha[1] / (alpha[2] ? 100 : 1) : 1;
    input.addEventListener("input", () => {
      const v = input.value;
      badge.textContent = v;
      onChange(a < 1 ? `rgba(${[1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).join(", ")}, ${a})` : v);
    });
    row.append(input, badge);
    return setValue;
  }

  function buildDeclarationRow(decl, onChange) {
    const { kind, value } = decl;
    const row = h("div", kind === "edges" ? "popup-decl popup-decl-edges" : "popup-decl", 0,
      h("span", "popup-decl-label", 0, decl.property));
    if (kind === "readonly") {
      row.append(h("span", "popup-decl-readonly", { title: value }, value));
      return { row, setValue() {} };
    }
    const control = kind === "edges" ? edgeControl : kind === "color" ? colorControl : lengthControl;
    return { row, setValue: control(row, decl, onChange) };
  }

  function buildRuleBlock(entry, source, onTweak, onClear) {
    const block = h("div", "popup-rule", 0,
      h("div", "popup-rule-selector", { title: entry.selectorText }, entry.selectorText),
      h("div", "popup-rule-source", 0, source));
    const undoBtn = h("button", "popup-rule-undo", { type: "button", hidden: "" }, "↩ undo tweaks");
    const touch = (info, v) => {
      info.row.classList.add("touched");
      undoBtn.hidden = false;
      onTweak(info.decl, v);
    };
    const rows = new Map();
    for (const decl of readDeclarations(entry)) {
      const info = { decl, ...buildDeclarationRow(decl, (v) => touch(info, v)) };
      rows.set(decl.property, info);
      block.append(info.row);
    }
    undoBtn.addEventListener("click", () => {
      for (const [prop, info] of rows) {
        if (info.row.classList.contains("touched")) {
          info.row.classList.remove("touched");
          info.setValue(info.decl.value);
          onClear(prop);
        }
      }
      undoBtn.hidden = true;
    });
    block.append(undoBtn);

    return {
      block,
      hydrateTweak(property, after) {
        const info = rows.get(property);
        if (!info || info.decl.kind === "readonly") return false;
        info.setValue(after);
        touch(info, after);
        return true;
      },
    };
  }

  let dragState = null;

  markerLayer.addEventListener("mousedown", (e) => {
    let m = e.target.closest(".marker");
    if (!m) return;
    const id = m.dataset.annotationId;
    // Commit an open popup first, then rebind to the re-rendered marker.
    if (popup && popup._commit) {
      popup._commit();
      m = markerFor(id);
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
    markerDragListeners("addEventListener");
  });
  function markerDragListeners(f) {
    document[f]("mousemove", onMarkerDragMove);
    document[f]("mouseup", onMarkerDragEnd);
    document[f]("keydown", onMarkerDragKey, true);
  }

  function onMarkerDragKey(e) {
    if (e.key !== "Escape" || !dragState) return;
    e.preventDefault();
    e.stopPropagation();
    cancelMarkerDrag();
  }
  function cancelMarkerDrag() {
    if (!dragState) return;
    markerDragListeners("removeEventListener");
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
      shadow.appendChild(dragState.dropOutline = h("div", "outline drop"));
      dragState.dropOutline.style.display = "none";

    }
    if (!dragState.moved) return;
    dragState.marker.style.left = (e.clientX - 11) + "px";
    dragState.marker.style.top = (e.clientY - 11) + "px";

    dragState.marker.style.pointerEvents = "none";
    const target = elementBeneathPoint(e.clientX, e.clientY);
    dragState.marker.style.pointerEvents = "auto";

    if (target && target !== host && target !== dragState.lastTarget) {
      dragState.lastTarget = target;
      showBox(dragState.dropOutline, target);
    } else if (!target || target === host) {
      dragState.dropOutline.style.display = "none";
      dragState.lastTarget = null;
    }
  }

  function onMarkerDragEnd(e) {
    markerDragListeners("removeEventListener");
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
    const target = elementBeneathPoint(e.clientX, e.clientY);
    marker.style.pointerEvents = "auto";

    if (!target || target === host) {
      render();
      return;
    }

    const i = findAnnotationIndex(id);
    if (i === -1) return;
    const old = state.annotations[i];
    const updated = capture(target, old.comment, { source: old.source, replyTo: old.replyTo });
    // Re-anchoring moves the pin; the note, thread, status and runtime context stay.
    for (const k of ["id", "timestamp", "consoleLog", "priorClicks", "status", "styleTweaks"]) if (old[k] !== undefined) updated[k] = old[k];
    state.annotations[i] = updated;
    persist();
    render();
  }

  pointBtn.addEventListener("click", () => {
    state.pointing ? exitPointMode() : enterPointMode();
  });

  copyBtn.addEventListener("click", async () => {
    const json = JSON.stringify(state.annotations, null, 2);
    let ok = true;
    try { await navigator.clipboard.writeText(json); }
    catch { ok = false; }
    copyBtn.classList.add(ok ? "copied" : "copy-failed");
    setTimeout(() => copyBtn.classList.remove(ok ? "copied" : "copy-failed"), 1400);
  });

  // Scroll doesn't bubble; capture catches it from any scrolling element.
  document.addEventListener("scroll", positionMarkers, { passive: true, capture: true });
  window.addEventListener("resize", positionMarkers);

  // Feeds clickChain. Reads text nodes only up to the label's length: no layout, no whole-subtree string.
  document.addEventListener("mousedown", (e) => {
    const el = e.target;
    if (!el || el.nodeType !== 1 || host.contains(el)) return;
    const tag = el.tagName.toLowerCase();
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let txt = "";
    while (txt.length < 42 && w.nextNode()) txt = (txt + w.currentNode.data).replace(/\s+/g, " ");
    txt = txt.trim().slice(0, 40);
    clickChain.push({ target: txt ? `<${tag}> "${txt}"` : `<${tag}>`, ts: Date.now() });
    if (clickChain.length > PRIOR_CLICKS_MAX) clickChain.shift();
  }, { passive: true, capture: true });

  // Coalesce navigation re-renders via rAF - back/forward + framework replaceState can fire in the same tick.
  let navPending = false;
  function scheduleRender() {
    if (navPending) return;
    navPending = true;
    requestAnimationFrame(() => { navPending = false; render(); });
  }
  // Polls location: from an isolated world a history patch never sees the page's
  // pushState. Late-mounting orphan targets (async routes) re-render too.

  let lastHref = location.href;
  function checkNav() {
    if (location.href === lastHref && ![...markerLayer.children].some((m) => !m._targetEl && resolveTarget(m._elementPath))) return;
    lastHref = location.href;
    scheduleRender();
  }
  const checkNavSoon = () => setTimeout(checkNav, 0);
  window.addEventListener("popstate", checkNav);
  document.addEventListener("mousedown", checkNavSoon, { passive: true, capture: true });
  document.addEventListener("click", checkNavSoon, { passive: true, capture: true });
  setInterval(checkNav, 500);

  document.documentElement.appendChild(host);
  window.__avis = api;
  if (window.__AVIS_TEST__) {
    api._t = {
      rgbToHex, parseDimension, parseShorthand4, formatShorthand4, inferControl, isMinified,
      getSelector, a11y, nearbyText, getReactInfo, discoverMatchedRules, ruleSourceLabel, readDeclarations, capture,
      serializeConsoleArg, bridged,
    };
  }

  render();
  avisLog("[avis] toolbar installed - click '+ annotate' to point at an element. Existing annotations:", state.annotations.length);
})();
