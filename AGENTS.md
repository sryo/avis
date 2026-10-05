# avis

Architecture and invariants for the avis skill.

## Layout

```
.
├── SKILL.md              # lean core of the slash command (<= 5000 bytes, enforced by test/doc.test.mjs)
├── references/
│   ├── schema.md         # full annotation shape, summary() options, styleTweaks
│   ├── agent-annotates.md# reverse flow: the agent pins comments
│   └── setup.md          # perch tools, mounting fallbacks, install, permissions
├── toolbar.js            # vanilla-JS toolbar - self-mounts via Shadow DOM, exposes window.__avis
├── test/                 # node:test + happy-dom; `npm test`
│   └── _mount.mjs        # loads toolbar.js into a happy-dom window via window.eval
├── package.json          # devDependencies only (happy-dom); nothing ships from it
├── index.html            # site; loads toolbar.js with a plain <script>
├── README.md             # public-facing intro + install
├── AGENTS.md             # this file
├── CLAUDE.md             # pointer to AGENTS.md
└── LICENSE
```

## Tests

`npm install && npm test`. `test/_mount.mjs` evaluates `toolbar.js` in a fresh happy-dom window per test. Setting `window.__AVIS_TEST__` before the script runs adds `window.__avis._t` with internal helpers; without the flag `_t` does not exist. The doc test fails if SKILL.md or `references/*.md` mention an `__avis.<name>` that the API lacks, name a perch tool that doesn't exist, or push SKILL.md past 5000 bytes.

## Rules for changes

- **Vanilla JS, single file, no build.** No `import`, JSX, or anything needing compilation. `toolbar.js` must stay a classic script ending in `})();` (a contract test checks both). Past ~200 LOC of new code, consider a separate skill.
- **Assume an isolated world.** perch's `eval_js` on Chrome-family browsers runs toolbar.js in an isolated world: the DOM and `location` are shared, page JS globals are not. Patching `history` or reading page globals there sees nothing from the page, so route changes are detected by polling `location.href` (`checkNav`). The page's console and React's `__reactFiber$` expandos live in the main world, so toolbar.js injects a `<script>` (`mainWorldBridge`) that relays console entries as `avis:console` events (detail `"level:msg"`) and answers `avis:react` lookups with `avis:react-result`; DOM events cross worlds synchronously. Its source is built from `serializeConsoleArg`, `getReactInfo` and their helpers via `toString`, so keep those self-contained. When strict CSP blocks the script (no `avis:pong`), avis patches its own world as before.
- **No external runtime deps.** Not React, not lit, nothing. Style isolation comes from Shadow DOM.
- **Text + selector fallbacks are the contract.** React `_debugSource` and component-path heuristics are best-effort bonuses; `text`, `elementPath`, `accessibility`, and `parentContext` must always populate so plain HTML / Vue / Svelte / static pages still produce useful annotations.
- **Tweak controls reflect what the page sets, not a curated property list.** The popup's `tweak rules` reveal walks `document.styleSheets`, matches the element via `el.matches(selectorText)`, skips pseudo selectors and cross-origin sheets, and shows one block per matching author rule (plus a synthetic "(inline)" entry if the element has inline styles). Control kind is inferred from the declaration value - `color` for hex/rgb/hsl, `length` for `<number><unit>`, `number` for bare numbers; anything else (gradients, multi-value shadows, enums) renders as a read-only value chip. Live preview applies via a single override stylesheet keyed to the element's unique selector with `!important`; the page reverts on close. The diff stored in `styleTweaks` is an array of `{selector, source, property, before, after}` entries - keep the shape stable; agents grep for it.
- **Schema compatibility.** Share field names with [agentation v1.1](https://www.agentation.com/schema) where concepts overlap. Intentional divergences: flat `replyTo` (not nested `thread[]`), per-annotation `source: "user" | "agent"`, no transport / session / sync layer. Treat agentation as a naming reference, not a spec to track - new optional fields they add cost nothing to ignore, and a rename in their schema doesn't force a migration here.
