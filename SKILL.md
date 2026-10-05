---
name: avis
description: Point at elements on a webpage and send the feedback back to Claude. Use for design reviews, annotations, or any /avis pass on a browser tab. Offer to run /avis (never unsolicited) when the user is working on UI, wants feedback on a page, says "let me show you what's wrong", or asks for a design review of a live URL.
allowed-tools: mcp__perch__* Read Bash(lsof:*)
---

# avis - feedback session

A floating toolbar goes onto the user's open page. They click `+ annotate`, point at elements and leave comments. When they type "done" you read the annotations back, edit code, and resolve each one as you go.

Needs [perch](https://github.com/sryo/perch). Install, permissions and fallbacks: `references/setup.md`. Annotation fields: `references/schema.md`. If the user asks *you* to annotate the page: `references/agent-annotates.md`.

## Steps

1. **Pick the tab.** `mcp__perch__list_tabs { urlContains: "localhost", limit: 10 }` returns `{tabs, total}`. If `total` is 0, call it bare and look for `127.0.0.1` / `0.0.0.0` or the active tab. If the user named a URL, `navigate` (then use the `tabId` it returns). If the active tab is blank and you're in a code project, detect the dev server with `lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -E ':(3000|3001|4173|4200|4321|5173|5174|8000|8080|8888)\b' | head -1` or `package.json` hints and navigate without asking. Otherwise ask. Tell the user in one line what you picked. Keep `target: {tabId}` from the row (or from `new_tab`/`navigate`) and pass it to every perch call below, so switching tabs mid-review doesn't redirect you. If a call returns `stale_tab`, re-pick the tab.

2. **Mount and verify in one call.** If any call returns `tab_not_visible`, `activate_tab { target }` and retry.
   ```
   mcp__perch__eval_js { script_path: "~/.claude/skills/avis/toolbar.js", script: "return __avis.info()", target }
   ```
   perch runs the file, then the script, in one body, so the toolbar source never enters your context. Re-injecting is a no-op. You get `{v, page, total, onPage, pending, working, persistOK}`. perch stringifies return values, so never wrap them in `JSON.stringify`. If `persistOK` is false, warn that annotations won't survive a reload. Existing annotations (`total > 0`) are pending work: leave them, and call `__avis.clear()` only if the user asks to start fresh.

3. **Hand off.** Say: *"Toolbar is on the page (bottom-right). Click `+ annotate`, point at elements, leave comments. Type 'done' here when you're finished."* Then stop and wait.

4. **Read back** on "done": `eval_js { script: "return __avis.summary()" }`. Empty and null fields are omitted, and console output is a `consoleCount`. Options: `summary({page: true})` for the current path only, `summary({status: "pending"})`, `summary({console: true})` for the log entries. Fetch `__avis.annotations` only when you need `computedStyles` or `outerHTML`. If nothing came back, say so and stop. Echo one line per annotation.

5. **Act.** Locate source in this order: `sourceFile` (open at the line) → `reactComponents` + grep → `text` + `element` grep → `parentContext.text` + `parentContext.element` → `elementPath`. If the first three are empty or generic, the user likely pinned an unlabeled wrapper; say so. `styleTweaks` is a literal CSS proposal: edit the rule named by `selector` in the file named by `source`, not an inline style (Tailwind: nearest utility class; `(inline)`: the `style` attribute). Group related annotations.

6. **Show your work, clean up as you go.** Status calls take one id or an array. An array does one write and one re-render and returns one result per id, so batch:
   ```
   return __avis.markWorking(["a1", "a2"])
   return __avis.resolve(["a1", "a2"])
   return __avis.dismiss(["a3"], "design intent")   // [{id, comment, reason}]
   ```
   - `__avis.reveal(id)` scrolls to one marker; skip it in batch passes.
   - `__avis.acknowledge(ids)` optionally marks "seen, will address".
   - `__avis.dismiss(ids, reason)` for false positives or won't-fix; report the reasons.
   - Skipped one (couldn't locate, ambiguous)? `__avis.unmarkWorking(ids)` and tell the user which and why.
   - `__avis.clear()` ends a fast full pass instead of per-id resolves.
   - Never leave addressed annotations on the page. A stale marker is a bug.

## API

`window.__avis`: `info()`, `summary(opts)`, `annotations` (full, heavy), `pageUrl`, `VERSION`, `reveal(id)`, `acknowledge(ids)`, `markWorking(ids)`, `unmarkWorking(ids)`, `resolve(ids)`, `dismiss(ids, reason)`, `add(selector, comment, {replyTo})`, `clear()`, `persistOK()`.

Markers and `info().onPage` only cover the current `location.pathname`; `summary()`, `annotations` and the copy button span all pages.
