# avis

A Claude Code skill that runs a feedback session on any webpage. The user invokes `/avis`, a floating toolbar gets injected onto their active Chrome tab, they point-and-comment on elements, and the annotations flow back into the conversation as structured items Claude acts on.

## Layout

```
.
├── CLAUDE.md          # this file
├── README.md          # public-facing intro + install
├── LICENSE
└── skills/
    └── avis/
        ├── SKILL.md   # the slash command's instructions for Claude
        └── toolbar.js # vanilla-JS toolbar, no build step, no deps
```

That's the whole project. Two files do the work.

## Architecture in one paragraph

`SKILL.md` tells Claude to: get the active tab via `claude-in-chrome`, `Read` `toolbar.js`, pass its contents to `javascript_tool` (the toolbar self-mounts via Shadow DOM), wait for the user's "done" signal (button on the toolbar *or* the word "done" in chat), then read `window.__avis.annotations` back and edit code. The toolbar captures React `_debugSource` (`src/file.tsx:42`) when available, falls back to component path, visible text, accessibility attributes, and a CSS selector — in that priority order — so Claude can locate the right source code regardless of framework.

## Rules for changes

- **`toolbar.js` is vanilla JS. No build step. No bundler.** It must remain a single file that runs as-is when pasted into a page. Don't add `import`, JSX, or anything that needs compilation.
- **No external runtime deps.** Not React, not lit, nothing. Style isolation comes from Shadow DOM.
- **Skill must work on any page**, not just one stack. React paths are best-effort; the toolbar must still produce useful annotations on plain HTML / Vue / Svelte / static sites via the text + selector fallbacks.
- **Keep it small.** This repo earned its place by being small. The toolbar is ~600 LOC; if you find yourself adding 200 more, ask whether the feature belongs in a separate skill.
