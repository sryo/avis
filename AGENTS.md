# avis

Architecture and invariants for the avis skill.

## Layout

```
.
├── SKILL.md      # the slash command's instructions for Claude
├── toolbar.js    # vanilla-JS toolbar — self-mounts via Shadow DOM, exposes window.__avis
├── README.md     # public-facing intro + install
├── AGENTS.md     # this file
├── CLAUDE.md     # pointer to AGENTS.md
└── LICENSE
```

## Rules for changes

- **Vanilla JS, single file, no build.** No `import`, JSX, or anything needing compilation. Past ~200 LOC of new code, consider a separate skill.
- **No external runtime deps.** Not React, not lit, nothing. Style isolation comes from Shadow DOM.
- **Text + selector fallbacks are the contract.** React `_debugSource` and component-path heuristics are best-effort bonuses; `text`, `elementPath`, `accessibility`, and `parentContext` must always populate so plain HTML / Vue / Svelte / static pages still produce useful annotations.
- **Schema compatibility.** Share field names with [agentation v1.1](https://www.agentation.com/schema) where concepts overlap. Intentional divergences: flat `replyTo` (not nested `thread[]`), per-annotation `source: "user" | "agent"`, no transport / session / sync layer. Treat agentation as a naming reference, not a spec to track — new optional fields they add cost nothing to ignore, and a rename in their schema doesn't force a migration here.
