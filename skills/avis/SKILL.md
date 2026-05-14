---
name: avis
description: Run a feedback session on a webpage. Injects a floating annotation toolbar onto the active Chrome tab so the user can point at elements and leave comments, then reads those annotations back into the conversation as structured items to act on. Use whenever the user asks for "feedback," "annotate," "design review," "let me point at things," or wants a quick `/avis` pass on their dev server, staging, or any URL. Requires the claude-in-chrome MCP extension to be connected.
allowed-tools: mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__javascript_tool, mcp__claude-in-chrome__navigate, Read
---

# avis — feedback session

A floating toolbar gets injected onto whatever page the user has open. They click `+ annotate`, point at an element, leave a comment, repeat. When they hit **Done** (or type "done" in chat), you read the annotations back and act on them — and you are responsible for clearing each one as you address it.

## What gets captured per annotation

```ts
{
  id, comment, createdAt,
  sourceFile,        // e.g. "src/components/NavItem.tsx:42"  (dev React only — may be null)
  componentPath,     // e.g. "<App> <Layout> <NavItem>"        (any React build — may be null)
  selector,          // e.g. "main > section.hero > h1"
  tag, text,         // visible tag + truncated visible text
  nearbyText,        // text from the parent — disambiguator
  accessibility,     // role / aria-label / name / placeholder / input type
  rect,              // viewport-relative bounding box at click time
  pageUrl, pageTitle,
  viewport           // size + scroll position
}
```

**Priority order for locating the source to edit**: `sourceFile` → `componentPath` + grep → `text` + `tag` + grep → `selector`. If `sourceFile` is present, open that file/line directly. Otherwise grep the repo for `text`, narrowed by `tag` and `componentPath`.

## `window.__avis` API surface

After injection, the toolbar exposes:

```ts
window.__avis.annotations  // getter, copy of the current array
window.__avis.done         // getter, true once the user clicked Done
window.__avis.pageUrl      // getter, current page URL
window.__avis.resolve(id)  // remove one annotation by id. Use this after editing.
window.__avis.clear()      // wipe all annotations. Use when the whole batch is done.
```

## Steps

1. **Confirm the target tab.** Call `mcp__claude-in-chrome__tabs_context_mcp` to list open tabs. If the user named a URL, navigate to it (`tabs_create_mcp` for a new tab, or `navigate` on an existing one). Otherwise ask which tab — or default to the active one if obvious.

2. **Load the toolbar source.** Use `Read` on `toolbar.js` next to this SKILL.md. The file is ~600 LOC of vanilla JS, no deps.

3. **Inject.** Pass the file contents to `mcp__claude-in-chrome__javascript_tool` as the `code` argument. The toolbar self-installs and exposes `window.__avis`. It's idempotent — re-running does nothing.

4. **Don't auto-clear.** Existing annotations in `localStorage` are pending work — anything you addressed in a prior session was already removed via `resolve()`. Just continue. **Only call `window.__avis.clear()` if the user explicitly asks** ("start fresh," "clear," "reset"). Don't prompt them about it.

5. **Hand off to the user.** Tell them: *"Toolbar is on the page (bottom-right). Click `+ annotate`, point at elements, leave comments. Hit **Done** when finished, or type 'done' here."* Then stop and wait.

6. **Wait for the done signal.** Resume on either:
   - The user types `done` / `ready` / similar in chat.
   - Or, if the user asks you to poll, run `javascript_tool` with `window.__avis.done` every ~15–30s until it returns `true`. **Don't poll without being asked** — it burns tokens.

7. **Read annotations back.** Run `JSON.stringify(window.__avis.annotations)` via `javascript_tool`. Parse the JSON. If the array is empty, tell the user and stop.

8. **Echo a compact summary** to the user so they can see what you received. One line per annotation: index, short identifier (sourceFile or selector), the comment. Don't dump the full JSON unless asked.

9. **Act on the annotations.** Treat them as a prioritized list of edits. For each:
   - If `sourceFile` is set, open it and edit at the captured line region.
   - Else, grep using `text` + `tag` (narrowed by `componentPath` if present) to find the source, then edit.
   - Group related annotations into a single batch of edits where it makes sense.

10. **⚠ REQUIRED — clean up as you go.** This is the contract you owe the user.
    - **After each annotation you successfully address**, call `window.__avis.resolve(<id>)` via `javascript_tool` to remove its marker from the page. The user can watch markers disappear and trust that the dot still on screen means "not yet handled."
    - If you address the whole batch in one pass, you may call `window.__avis.clear()` at the end instead of individual `resolve()` calls.
    - **Never leave addressed annotations on the page.** A stale marker is a bug.
    - If you couldn't address an annotation (couldn't locate the code, ambiguous, needs user clarification), **leave it** and tell the user explicitly which ones you skipped and why.

11. **Optional toolbar removal.** When the user is fully done, you may run `document.getElementById("__avis_host")?.remove(); delete window.__avis;` to take the toolbar off the page. Leave it otherwise — they may want another round.

## Notes

- **Stacking / overlays.** The toolbar uses Shadow DOM at `z-index: 2147483647`. If the host site has elements *above* that (rare; only sites that explicitly use the max int z-index), the toolbar may be hidden. Tell the user to check.
- **`sourceFile` is dev-only.** Next.js production, Vite production, etc. strip `_debugSource`. In those cases `componentPath` is your best signal — combined with `text`, it locates components reliably.
- **Frameworks other than React.** `sourceFile` and `componentPath` will be null. Vue/Svelte/static HTML still get `text` + `nearbyText` + `selector` + `accessibility` — enough for a competent grep.
- **Non-Chrome browsers.** This skill needs `claude-in-chrome`. Tell the user so and stop.
- **Persistence.** Annotations live in `localStorage` under `avis:annotations` and survive refreshes. Only `resolve(id)` and `clear()` actually remove them — they're not auto-deleted on Done.

## When to suggest using `/avis`

If the user is working on UI, mentions wanting feedback on a page, says "let me show you what's wrong," or asks for a design review on a live URL — offer to run `/avis`. Don't run it unsolicited.
