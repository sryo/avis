---
name: avis
description: Point at elements on a webpage and send the feedback back to Claude. Use for design reviews, annotations, or any /avis pass on a Chrome tab.
allowed-tools: mcp__claude-in-chrome__* Read Bash(lsof:*)
---

# avis — feedback session

A floating toolbar gets injected onto the user's open page. They click `+ annotate`, point at elements, leave comments. When they type "done" in chat you read the annotations back, edit code, and resolve each one as you address it.

## Annotation shape

Shares field names with the [agentation v1.1 schema](https://www.agentation.com/schema) where concepts overlap. Avis-specific fields: `sourceFile` ("path:line", React dev builds only), `reactComponents` ("<App> <Layout> <NavItem>", any React build), `parentContext` ({element, text, accessibility} of the parent — fallback when the clicked node is unlabeled), `consoleLog` ([{level, ts, msg}], `console.*` entries from the ~60s before capture — useful when the user pins something right after the page errored), `outerHTML` (≤1000 chars), `cssClasses` (full class list), `pageTitle`, `client` ({userAgent, platform, devicePixelRatio, colorScheme}), `source` (`"user"` | `"agent"`), `replyTo` (id | null — flat reply link, no nested threading).

**Priority order for locating the source to edit**: `sourceFile` → `reactComponents` + grep → `text` + `element` + grep → `parentContext.text` + `parentContext.element` → `elementPath`.

## `window.__avis` API

```ts
window.__avis.annotations       // getter, full array across all pages (heavy)
window.__avis.summary()         // compact projection — use this in javascript_tool
                                // to avoid the chrome bridge's content filter
window.__avis.pageUrl           // getter, current page URL
window.__avis.reveal(id)        // smooth-scroll + pulse marker; no-op off-page
window.__avis.markWorking(id)   // spinner badge on the marker
window.__avis.unmarkWorking(id) // clear the spinner
window.__avis.resolve(id)       // remove one annotation; clears working state
window.__avis.clear()           // wipe all annotations
window.__avis.add(sel, comment, opts?)
                                // pin your own comment to an element. opts.replyTo
                                // threads under an existing annotation. Returns id.
window.__avis.persistOK()       // false if localStorage writes have failed (quota,
                                // private mode, etc.) — annotations won't survive reload.
```

**Source + replies.** `source` is `"user"` (toolbar) or `"agent"` (`__avis.add()`). Clicking an agent marker opens a reply popup; committing creates a new user annotation with `replyTo` set. Reply back the same way: `__avis.add(sel, comment, { replyTo: <userReplyId> })`.

**Per-page rendering.** Markers and the count only show annotations on the current `location.pathname`. The `annotations` getter still returns everything across pages.

## Steps

1. **Pick the target tab.** Call `mcp__claude-in-chrome__tabs_context_mcp`. Use a tab already on `localhost` / `127.0.0.1` / `0.0.0.0` if one's open. If the user named a URL, navigate. If the active tab is blank and you're in a code project, detect the dev server via `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(3000|3001|4173|4200|4321|5173|5174|8000|8080|8888)\b' | head -1` and/or `package.json` framework hints; navigate without asking if either hits. Otherwise ask. Tell the user one line about what you picked so they can redirect.

2. **Pick the inject path.** Run `git -C ~/.claude/skills/avis status --porcelain toolbar.js` and `git -C ~/.claude/skills/avis rev-parse HEAD` (in parallel with step 1). Clean status → CDN (3a). Dirty → inline (3b) and tell the user: *"Using inline inject — toolbar.js has uncommitted changes; commit + push to use the fast CDN path."*

3. **Inject.**

   **3a. CDN loader (fast).** Substitute `<SHA>` and pass to `javascript_tool`:
   ```js
   (function () {
     if (window.__avis || document.getElementById("__avis_host")) return "already-mounted";
     const x = new XMLHttpRequest();
     try { x.open("GET", "https://cdn.jsdelivr.net/gh/sryo/avis@<SHA>/toolbar.js", false); x.send(); }
     catch (e) { return "fetch-failed: " + e.message; }
     if (x.status !== 200) return "http-" + x.status;
     try { (new Function(x.responseText))(); } catch (e) { return "exec-failed: " + e.message; }
     return window.__avis ? "mounted" : "mount-failed";
   })();
   ```
   On any non-`"mounted"`/`"already-mounted"` result, fall through to 3b.

   **3b. Inline (fallback).** `Read` `toolbar.js` next to this SKILL.md, pass directly to `javascript_tool`. Idempotent.

4. **Hand off.** Tell the user: *"Toolbar is on the page (bottom-right). Click `+ annotate`, point at elements, leave comments. Type 'done' here when you're finished."* Then stop and wait. Existing annotations in `localStorage` are pending work — leave them. Only call `clear()` if the user explicitly asks ("start fresh", "reset").

5. **Read annotations back** when the user types `done` / `ready`. Run `JSON.stringify(window.__avis.summary())` via `javascript_tool` — returns the compact projection. Only fetch the full `window.__avis.annotations` if you need `computedStyles` / `outerHTML`. If empty, tell the user and stop. Echo one line per annotation so they see what you got.

6. **Act.** For each annotation:
   - If `sourceFile` is set, open it and edit at the captured line.
   - Else grep using `text` + `element`, narrowed by `reactComponents` when present.
   - **Weak-signal fallback.** If `sourceFile` and `reactComponents` are both null *and* `text` is empty/generic (≤3 chars, "div", "span"), shift the grep to `parentContext.text` + `parentContext.element` — the user often anchored on an unlabeled wrapper. Tell them so future annotations can land on labeled elements.
   - Group related annotations into one batch where it makes sense.

7. **⚠ Show your work, clean up as you go.** For each annotation:
   - `reveal(<id>)` to scroll the marker into view (skip in batch mode).
   - `markWorking(<id>)` while working — spinner appears.
   - `resolve(<id>)` once addressed — marker disappears.
   - If you skip an annotation (couldn't locate, ambiguous), `unmarkWorking(<id>)` and tell the user explicitly which ones and why.
   - For a fast batch pass, `clear()` at the end instead of per-id `resolve()`s.
   - Never leave addressed annotations on the page. A stale marker is a bug.

## Notes

- **`sourceFile` is React-dev-only.** Production builds (Next.js, Vite) strip `_debugSource`; `reactComponents` + `text` is the next-best locator.
- **Non-Chrome browsers.** This skill needs `claude-in-chrome`. Tell the user and stop.

## When the user asks you to annotate

The user can flip the direction — they ask you to pin comments instead of pointing them out. Trigger families (same mechanic, different reason):

- **Critique / review** — "what's wrong here", "critique this design"
- **Walkthrough / explain** — "annotate how this flow works"
- **Diff / changes** — "show me what changed in the last 10 commits"
- **Locate / map** — "where does X live"
- **Onboarding / docs** — "annotate the key parts for a new dev"

Flow: mount the toolbar (steps 1–3), pull whatever sources the request needs (`read_page` / `get_page_text`, `git log` / `git diff`, `Read`; ask for a screenshot if the issue is visual), then for each finding call `window.__avis.add('<selector>', '<comment>')` via `javascript_tool`. Use a selector specific enough to resolve to one element (prefer `[data-testid]` or stable classes). Batch multiple `add()` calls into one `javascript_tool` payload. Tell the user how many you placed and stop.

If the user replies on one of your annotations, you'll see their reply in `summary()` with `replyTo` pointing at your annotation's id — treat it as a follow-up question. Reply back with `__avis.add(sel, comment, { replyTo: <theirReplyId> })`.

Don't mix this with the user-driven flow in the same session unless asked.

## When to suggest using `/avis`

If the user is working on UI, mentions wanting feedback on a page, says "let me show you what's wrong," or asks for a design review on a live URL — offer to run `/avis`. Don't run it unsolicited.
