---
name: avis
description: Point at elements on a webpage and send the feedback back to Claude. Use for design reviews, annotations, or any /avis pass on a Chrome tab.
allowed-tools: mcp__claude-in-chrome__* Read Bash(lsof:*)
---

# avis — feedback session

A floating toolbar gets injected onto whatever page the user has open. They click `+ annotate`, point at an element, leave a comment, repeat. When they hit **Done** (or type "done" in chat), you read the annotations back and act on them — and you are responsible for clearing each one as you address it.

## What gets captured per annotation

Annotation shape aligns with the [agentation v1.1 schema](https://www.agentation.com/schema), plus a few avis extensions:

```ts
{
  // Identity + content
  id,                // "a<base36>" — unique per annotation
  comment,           // user's text feedback
  timestamp,         // Unix ms

  // Element identification (agentation v1.1)
  element,           // tag name, e.g. "button"
  elementPath,       // CSS selector path
  cssClasses,        // space-separated class list (avis: full list, not just selector-friendly)
  text,              // truncated visible text
  nearbyText,        // visible text from parent — disambiguator
  parentContext,     // avis: { element, text, accessibility } of the parent — fallback when this element is unlabeled
  accessibility,     // role / aria-label / name / placeholder / input type
  computedStyles,    // serialized key CSS properties (display, padding, color, …)
  outerHTML,         // up to 1000 chars of the element's outerHTML (avis extension)

  // Position (agentation v1.1)
  x,                 // % of viewport width
  y,                 // absolute px from document top
  boundingBox,       // { x, y, width, height } — viewport-relative at click time
  url,               // page URL
  viewport,          // { width, height, scrollY, scrollX } at click time

  // avis extensions
  sourceFile,        // "src/components/NavItem.tsx:42" (dev React only — may be null)
  reactComponents,   // "<App> <Layout> <NavItem>" (any React build — may be null)
  pageTitle,         // document.title
}
```

**Priority order for locating the source to edit**: `sourceFile` → `reactComponents` + grep → `text` + `element` + grep → `parentContext.text` + `parentContext.element` (see step 9) → `elementPath`. If `sourceFile` is present, open that file/line directly. Otherwise grep the repo for `text`, narrowed by `element` and `reactComponents`.

## `window.__avis` API surface

After injection, the toolbar exposes:

```ts
window.__avis.annotations       // getter, full array across all pages (heavy)
window.__avis.summary()         // compact projection — same array, only the
                                // fields needed to plan edits. Prefer this in
                                // javascript_tool calls to avoid the chrome
                                // bridge's content filter on large payloads.
window.__avis.pageUrl           // getter, current page URL
window.__avis.reveal(id)        // smooth-scroll to the annotation + pulse its marker.
                                // No-ops if the annotation isn't on the current page.
window.__avis.markWorking(id)   // show a spinner badge on the marker while you work.
window.__avis.unmarkWorking(id) // clear the spinner (rarely needed — resolve clears it too).
window.__avis.resolve(id)       // remove one annotation by id once you've addressed it.
                                // Implicitly clears its working state.
window.__avis.clear()           // wipe all annotations. Use when the whole batch is done.
```

**Per-page rendering.** Markers and the count only show annotations whose `pageUrl` matches the *current* `location.pathname`. The `annotations` getter still returns everything across all pages — so when the user navigates between pages while you're working, you can still see their full backlog. Don't be surprised if `annotations.length` is larger than the toolbar's count.

## Steps

> **Latency note.** Each chrome MCP call is a round-trip. Issue independent calls in the same turn (parallel tool use). At minimum, fire `tabs_context_mcp` (step 1), `git status --porcelain toolbar.js`, and `git rev-parse HEAD` (step 2) in the same turn — they don't depend on each other.

1. **Pick the target tab — try to skip the question.** Call `mcp__claude-in-chrome__tabs_context_mcp` to list open tabs. Resolve the URL in this order, only falling through to the next step when the previous misses:
   - **User named a URL** in chat → navigate there. Use `tabs_create_mcp` for a new tab, or `navigate` on an existing one.
   - **A tab is already on `localhost` / `127.0.0.1` / `0.0.0.0`** → use it, no ask.
   - **Active tab is blank / `about:blank` / `chrome://newtab`** and you're working inside a code project → detect the running dev server before asking. Run `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(3000|3001|4173|4200|4321|5173|5174|8000|8080|8888)\b' | head -1` (Bash). If it returns a port, navigate the blank tab to `http://localhost:<port>` and proceed.
   - **Combine with project context.** If `package.json` exists in the cwd and lists `next` / `vite` / `astro` / `remix` / `react-scripts` etc. in dependencies, that's stronger evidence than `lsof` alone — proceed without confirmation. Optionally peek at the `dev` / `start` script for an explicit `--port` flag.
   - **Nothing detected** → ask the user where to point it, suggesting `http://localhost:3000` as the most common default.

   Tell the user one line about what you picked ("Opening http://localhost:5173 — looks like Vite is running.") so they can redirect if you guessed wrong.

2. **Pick the inject path — CDN vs inline.** The bottleneck for `javascript_tool` is the model's output speed: dictating 35 KB of `toolbar.js` as a tool argument costs ~140 s. The CDN loader path is ~1 s. Decide which one to use:

   - Run `Bash: git -C ~/.claude/skills/avis status --porcelain toolbar.js` and `Bash: git -C ~/.claude/skills/avis rev-parse HEAD`.
   - **Empty status** (clean and pushed) → CDN loader (step 3a).
   - **Non-empty status** (uncommitted edits) → inline (step 3b). Tell the user: "Using inline inject — toolbar.js has uncommitted changes; commit + push to use the fast CDN path."

3. **Inject the toolbar.**

   **3a. CDN loader (fast).** Substitute the SHA from step 2 into this code, then pass to `mcp__claude-in-chrome__javascript_tool` as the `code` argument:

   ```js
   (function () {
     if (window.__avis || document.getElementById("__avis_host")) return "already-mounted";
     const x = new XMLHttpRequest();
     try {
       x.open("GET", "https://cdn.jsdelivr.net/gh/sryo/avis@<SHA>/toolbar.js", false);
       x.send();
     } catch (e) { return "fetch-failed: " + e.message; }
     if (x.status !== 200) return "http-" + x.status;
     try { (new Function(x.responseText))(); } catch (e) { return "exec-failed: " + e.message; }
     return window.__avis ? "mounted" : "mount-failed";
   })();
   ```

   The tool returns one of: `"mounted"`, `"already-mounted"`, `"fetch-failed: …"`, `"http-404"`, `"exec-failed: …"`, `"mount-failed"`. On any non-`"mounted"`/`"already-mounted"` result, fall through to 3b. (The synchronous XHR is intentional — it makes the inject a single `javascript_tool` call that returns only after the toolbar is mounted.)

   **3b. Inline inject (fallback, slow).** `Read` `toolbar.js` next to this SKILL.md, pass its contents directly to `javascript_tool` as the `code` argument. The toolbar self-installs and exposes `window.__avis`. It's idempotent.

4. **Don't auto-clear.** Existing annotations in `localStorage` are pending work — anything you addressed in a prior session was already removed via `resolve()`. Just continue. **Only call `window.__avis.clear()` if the user explicitly asks** ("start fresh," "clear," "reset"). Don't prompt them about it.

5. **Hand off to the user.** Tell them: *"Toolbar is on the page (bottom-right). Click `+ annotate`, point at elements, leave comments. Type 'done' here when you're finished. (Copy button on the toolbar dumps the JSON to clipboard if you want it.)"* Then stop and wait.

6. **Wait for the done signal.** Resume when the user types `done` / `ready` / similar in chat. Don't poll the page — Claude Code is turn-based, and any polling burns tokens without buying responsiveness.

7. **Read annotations back.** Run `JSON.stringify(window.__avis.summary())` via `javascript_tool` — it returns the compact projection (id, comment, sourceFile, reactComponents, element, elementPath, text, nearbyText, parentContext, url), which is enough to plan edits and won't trip the chrome bridge's content filter on large payloads. Parse the JSON. Only fetch the full `window.__avis.annotations` if you genuinely need `computedStyles` / `outerHTML` to reason about visuals. If the array is empty, tell the user and stop.

8. **Echo a compact summary** to the user so they can see what you received. One line per annotation: index, short identifier (sourceFile or selector), the comment. Don't dump the full JSON unless asked.

9. **Act on the annotations.** Treat them as a prioritized list of edits. For each:
   - If `sourceFile` is set, open it and edit at the captured line region.
   - Else, grep using `text` + `element` (narrowed by `reactComponents` if present) to find the source, then edit.
   - **Weak signal fallback.** If `sourceFile` and `reactComponents` are both null *and* `text` is empty / generic (≤ 3 chars, a single word like "div"/"span"), shift the grep to `parentContext.text` + `parentContext.element`. The user often anchored an overlay/wrapper inside a labeled component; the parent has the real name.
   - Tell the user when you fell back to weak-signal mode so they know future annotations on the same element would be cleaner if anchored on a button/heading instead.
   - Group related annotations into a single batch of edits where it makes sense.

10. **⚠ REQUIRED — show your work and clean up as you go.**
    - **Before starting** on an annotation, call `window.__avis.reveal(<id>)` to scroll it into view and pulse the marker. The user gets to watch you work through the list. Skip this if you're processing many annotations as a single batch.
    - **While working** on an annotation, call `window.__avis.markWorking(<id>)` so a spinner appears on that marker. The user sees in real time which dots you're currently handling.
    - **After successfully addressing** an annotation, call `window.__avis.resolve(<id>)`. The marker disappears (spinner clears too).
    - If you address the whole batch in one fast pass, you may call `window.__avis.clear()` at the end instead of individual `resolve()` calls.
    - **Never leave addressed annotations on the page.** A stale marker is a bug.
    - If you couldn't address an annotation (couldn't locate the code, ambiguous, needs user clarification), **call `unmarkWorking(<id>)`**, leave the annotation in place, and tell the user explicitly which ones you skipped and why.

11. **Optional toolbar removal.** When the user is fully done, you may run `document.getElementById("__avis_host")?.remove(); delete window.__avis;` to take the toolbar off the page. Leave it otherwise — they may want another round.

## Notes

- **Stacking / overlays.** The toolbar uses Shadow DOM at `z-index: 2147483647`. If the host site has elements *above* that (rare; only sites that explicitly use the max int z-index), the toolbar may be hidden. Tell the user to check.
- **`sourceFile` is dev-only.** Next.js production, Vite production, etc. strip `_debugSource`. In those cases `componentPath` is your best signal — combined with `text`, it locates components reliably.
- **Frameworks other than React.** `sourceFile` and `componentPath` will be null. Vue/Svelte/static HTML still get `text` + `nearbyText` + `selector` + `accessibility` — enough for a competent grep.
- **Non-Chrome browsers.** This skill needs `claude-in-chrome`. Tell the user so and stop.
- **Persistence.** Annotations live in `localStorage` under `avis:annotations` and survive refreshes. Only `resolve(id)` and `clear()` actually remove them — they're not auto-deleted on Done.

## When to suggest using `/avis`

If the user is working on UI, mentions wanting feedback on a page, says "let me show you what's wrong," or asks for a design review on a live URL — offer to run `/avis`. Don't run it unsolicited.
