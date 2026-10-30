# /avis

`avis` is a skill that lets you leave comments directly on a page and have your agent see them in context. You can also flip it: ask the agent to annotate the page for you.

Pairs with a browser MCP server. [perch](https://github.com/sryo/perch) (macOS) is the reference backend.

## Install

```bash
git clone https://github.com/sryo/avis ~/.claude/skills/avis
```

That's Claude Code's skills folder. Codex and GitHub Copilot look in `~/.agents/skills`, so for those clone into `~/.agents/skills/avis` instead.

Start it with `/avis` (Claude Code, Copilot) or `$avis` (Codex). Restart your agent if it doesn't show up.

avis needs an agent running on your Mac. Cloud agents can't reach your browser.
