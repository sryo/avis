# Setup, permissions and fallbacks

## perch tools avis uses

| Need | perch tool |
|---|---|
| find the tab | `list_tabs` (always `{tabs, total}`; rows carry a stable `tabId`) |
| bring a tab to the front (`tab_not_visible`) | `activate_tab` |
| open or move a tab | `new_tab`, `navigate` |
| mount, verify, read back, update status | `eval_js` |
| page text or markup | `get_text` (`html: true` for markup) |

Clients may prefix the names; Claude Code shows them as `mcp__perch__list_tabs` and so on.

## Mounting

```
mcp__perch__eval_js { script_path: "~/.claude/skills/avis/toolbar.js", script: "return __avis.info()", target: { tabId } }
```

Pass the picked tab's `{ tabId }` (from its `list_tabs` row, `new_tab` or `navigate`) as `target` on every call. Without it perch uses whatever tab is active, which changes if the user switches tabs while annotating. `navigate` returns the tab's `tabId`, which can change, so use the returned one afterwards.

perch reads `script_path` server-side and runs it, then `script`, in a single function body. The return value is stringified by perch; return objects directly.

- **`tab_not_visible`**: the call needs the tab its window is showing. Call `mcp__perch__activate_tab { target }` (it takes focus) and retry, or retry later. If the user switches away mid-review, the next call errors this way instead of hitting another tab.
- **`stale_tab`**: the tab is gone. Re-run `list_tabs` and pick again.
- **Nonstandard install path**: if `script_path` errors, `Read` the `toolbar.js` next to SKILL.md and pass its contents followed by `return __avis.info()` as `script`.
- **Already mounted**: `toolbar.js` returns early when `window.__avis` exists, so re-running the call is safe and just reports `info()`.
- **`mountedElsewhere: true`**: the page loaded `toolbar.js` itself (a plain `<script>`, like the avis site), so the toolbar lives in the page's JS world, not perch's. `__avis` here is a stub with only `info()` and `VERSION`; read annotations from the page's own `window.__avis` instead, or review a page that doesn't embed avis.
- **`persistOK: false`**: `localStorage` writes are failing (quota, private mode). Annotations live until the page reloads.

## Installing perch

If perch isn't wired up (macOS only), explain what install does: it clones to `~/.perch`, asks for browser permission toggles on first use, auto-registers with `claude mcp add` on Claude Code, and prints config snippets for other MCP clients. Get consent, then run:

```
curl -fsSL https://raw.githubusercontent.com/sryo/perch/main/install.sh | bash
```

The user restarts Claude Code before running `/avis` again.

## Browser permissions

The first call may return a permission hint. Pass it to the user verbatim; they have to flip the toggle themselves. Common ones:

- Chromium-family browsers: `View > Developer > Allow JavaScript from Apple Events`.
- Safari: the equivalent option in the Develop menu.
