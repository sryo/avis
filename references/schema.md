# Annotation schema

Field names follow the [agentation v1.1 schema](https://www.agentation.com/schema) where the concepts overlap. `__avis.annotations` returns every field; `__avis.summary()` returns the compact projection below.

## `summary(opts)` projection

Fields: `id`, `comment`, `source`, `replyTo`, `sourceFile`, `reactComponents`, `element`, `elementPath`, `text`, `nearbyText`, `parentContext`, `priorClicks`, `url`, `styleTweaks`, `consoleCount`, `status`.

- Fields that are null, `""` or `[]` are omitted, and so are empty fields inside `parentContext`.
- `consoleCount` replaces `consoleLog` unless you pass `{console: true}`.
- `{page: true}` keeps only annotations whose `url` pathname matches the current page.
- `{status: "working"}` or `{status: ["pending", "acknowledged"]}` filters by status.

## Fields

| Field | Meaning |
|---|---|
| `id` | Stable id, e.g. `amuig57q...`. |
| `comment` | What the user (or agent) wrote. |
| `source` | `"user"` (toolbar) or `"agent"` (`__avis.add()`). |
| `replyTo` | Id of the annotation this one replies to. Flat link, no nested threads. |
| `sourceFile` | `"path:line"` from React `_debugSource`. React dev builds only; production strips it. |
| `reactComponents` | `"<App> <Layout> <NavItem>"`, any React build. Minified and wrapper names are skipped. |
| `element` | Tag name of the pinned element. |
| `elementPath` | Unique CSS selector: `data-testid`, `data-test`, `id`, `aria-label`, then a short class/nth-of-type path. |
| `text` | Visible text of the element (120 chars max). |
| `nearbyText` | Parent's text when it differs (80 chars max). |
| `parentContext` | `{element, text, accessibility}` of the parent. The fallback when the pinned node is unlabeled. |
| `accessibility` | `role`, `aria-label`, `name`, `placeholder`, `type` (full annotation only). |
| `consoleLog` | Up to 20 `{level, ts, msg}` entries from `console.log/warn/error` in the 60s before the pin. Each argument is capped at 200 chars and 64 property reads. avis's own `[avis]` lines are excluded. On pages whose CSP blocks inline scripts, Chrome-family browsers capture nothing here and `sourceFile`/`reactComponents` stay empty. |
| `priorClicks` | Last 3 page clicks as `{target, ts}`, to replay menus or overlays that were open. |
| `url`, `pageTitle` | Where the pin was made. |
| `styleTweaks` | Array of `{selector, source, property, before, after}`, present when the user edited values in the post-it's `tweak rules` panel. |
| `computedStyles`, `outerHTML`, `cssClasses` | Full annotation only. `outerHTML` is capped at 1000 chars. |
| `boundingBox`, `viewport`, `x`, `y`, `client`, `timestamp` | Geometry and environment at capture time (full annotation only). |
| `status` | `pending`, `acknowledged` or `working`. Resolved and dismissed annotations are deleted. |

## Locating the source

Priority: `sourceFile` → `reactComponents` + grep → `text` + `element` + grep → `parentContext.text` + `parentContext.element` → `elementPath`.

If `sourceFile` and `reactComponents` are both missing and `text` is empty or generic (3 chars or less, "div", "span"), grep for the `parentContext` values instead and tell the user that labeled elements make better pins.

## `styleTweaks`

Each entry names the CSS rule the user edited. `selector` is that rule's selector, `source` is the stylesheet basename, `<style>` or `inline`, and `before` is that rule's value. There is one entry per property: if the user edited the same property in two rules, the last edit wins, as it did in the preview. A translucent color keeps its alpha in `after` (`rgba(...)`). Edit that rule in that source rather than adding inline styles. For Tailwind or other utility CSS, use the closest utility class. `(inline)` means the original declaration lived in a `style="..."` attribute, so edit that attribute or the code that renders it. When a tweak arrives with no comment, the tweak itself is the request.

## Replies

Clicking an agent marker opens a reply popup. Committing it creates a user annotation with `replyTo` set to the agent's id. Answer with `__avis.add(selector, comment, { replyTo: <theirId> })`.
