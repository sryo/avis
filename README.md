# /avis

avis lets you leave comments directly on a page and have your agent see them in context. You can also flip it: ask the agent to annotate the page for you.

Needs [perch](https://github.com/sryo/perch) (macOS); your agent offers to install it the first time.

## Install

```bash
git clone https://github.com/sryo/avis ~/.agents/skills/avis
mkdir -p ~/.claude/skills && ln -sfn ~/.agents/skills/avis ~/.claude/skills/avis
```

One copy serves Codex, GitHub Copilot and Claude Code.

Restart your agent if it doesn't show up.

avis needs an agent running on your Mac. Cloud agents can't reach your browser.

## Use

With your page open, type `/avis` (Claude Code, Copilot) or `$avis` (Codex). Click `+ annotate`, point at what's wrong, and leave a comment. Type `done` in the chat with your agent when you're finished, and it fixes each one and clears it from the page.

To flip it, ask for something like `/avis critique this design` or `/avis annotate how this flow works`.
