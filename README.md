# avis

Point at things on a webpage. Tell Claude Code what to fix.

`avis` is a Claude Code skill that drops a floating annotation toolbar onto any Chrome tab via [claude-in-chrome](https://claude.ai/chrome). You click `+ annotate`, point at an element, leave a comment, repeat. Hit **Done** and the annotations come back as a structured list of edits, with the source file and line number when it can find them.

## Install

```bash
git clone https://github.com/sryo/avis
ln -s "$(pwd)/avis/skills/avis" ~/.claude/skills/avis
```

`/avis` should appear in your slash-command list. Restart Claude Code if it doesn't.

## Use it

```
/avis
```

Claude confirms which tab to target, injects the toolbar, and hands off. Click `+ annotate`, point at things, type your comments. When you're done, click **Done** in the toolbar (or just type `done` in the chat). Claude reads the annotations and starts editing.

## What gets captured

For each annotation, in order of how useful it is to an agent:

1. **Source file + line** — `src/components/NavItem.tsx:42` (dev React only)
2. **Component path** — `<App> <Layout> <NavItem>` (any React)
3. **Visible text + tag** — works on any framework
4. **Accessibility name + role** — useful when the visible text is empty
5. **Nearby text** — disambiguates ("button next to 'Forgot password'")
6. **CSS selector** — fallback
7. **Viewport rect + URL** — context

If `sourceFile` is present, Claude opens it directly. Otherwise it greps your repo using the captured text and tag.

## Why it works on any project

`toolbar.js` is vanilla JavaScript injected via `javascript_tool` into your active tab. The host site doesn't need a package, a script tag, or any config. Next.js dev server, static HTML, a Webflow draft, production at example.com. If Chrome can load it, `/avis` can annotate it.