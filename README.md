# avis

Point at things on a webpage. Tell Claude Code what to fix.

`avis` is a skill that injects a floating annotation toolbar onto any Chrome tab. You click `+ avis`, point at an element, leave a comment, repeat. Hit **Send** and the annotations land back in your Claude Code conversation as a structured list of edits to make — with the source file and line number when it can find them.

## Install

The skill folder needs to be discoverable by Claude Code. Symlink it once:

```bash
ln -s "$(pwd)/skills/avis" ~/.claude/skills/avis
```

Restart Claude Code. `/avis` should show up.

You also need the [claude-in-chrome](https://www.claude.com/claude-code) MCP extension connected — that's what lets Claude run JavaScript in your active tab.

## Use it

```
/avis
```

Claude confirms which tab to target, injects the toolbar, and hands off to you. Click `+ avis`, point at elements, type your comments. When you're done, click **Send** in the toolbar (or just type `done` in the Claude chat). Claude reads the annotations and starts editing.

## What gets captured

Per annotation, in order of usefulness to an AI agent:

1. **Source file + line** — `src/components/NavItem.tsx:42` (dev React only)
2. **Component path** — `<App> <Layout> <NavItem>` (any React)
3. **Visible text + tag** — works on any framework
4. **Accessibility name + role** — strong signal when text is empty
5. **Nearby text** — disambiguates ("button next to 'Forgot password'")
6. **CSS selector** — fallback
7. **Viewport rect + URL** — context

If `sourceFile` is present, Claude opens it directly. Otherwise it greps your repo using the captured text and tag.

## Why it works on any project

`toolbar.js` is vanilla JavaScript injected via `javascript_tool` into your active tab. The host site doesn't need a package install, a `<script>` tag, or any config. Your project can be a Next.js dev server, a static HTML page, a Webflow draft, production at example.com — anywhere Chrome can load it, `/avis` can annotate it.