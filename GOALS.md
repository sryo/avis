# avis: goals

## What avis is for
You leave comments right on a page and your agent sees them in context, or the agent pins its own for you. avis is a script dropped into pages you didn't write, so it has to load at once and never get in the page's way.

## Never traded
- **One plain script.** `toolbar.js` stays a single classic script with no build and no runtime dependencies.
- **The page keeps working.** avis never breaks or restyles the page it's on, under strict CSP and Trusted Types too.
- **Local.** Comments stay in the page's own storage and the agent's session. Nothing goes to a server.

## Goals, in priority order
1. **Comments the agent can act on.** Every comment carries its text, selector and surrounding context, on any framework or plain HTML.
2. **Loads at once.** Injecting avis is instant: the script stays as small as it is or smaller, and mounting it cold takes no longer.
3. **Never slows the page.** Hover, scroll, clicks and console logging feel the same with avis on.
4. **A light skill.** The agent reads as little as it needs to use avis.

## How we know
| Goal | Metric | Where | Run |
|---|---|---|---|
| 1 | annotation fields populate on every fixture | `npm test` | `npm test` |
| 2 | toolbar.js bytes and gzip; mount ms (cold parse and compile) | `node scripts/bench.mjs` | `node scripts/bench.mjs --no-base --out ~/.fium/runs/avis/done.raw.json --fium ~/.fium/runs/avis/done.json >&2 && echo ~/.fium/runs/avis/done.json` |
| 3 | hover, scroll reposition, page mousedown, console.warn ms | `node scripts/bench.mjs`: hover x300 ms, scroll reposition @100 ms, page mousedown x300 ms, console.warn x2000 (obj) ms | `node scripts/bench.mjs --no-base --out ~/.fium/runs/avis/done.raw.json --fium ~/.fium/runs/avis/done.json >&2 && echo ~/.fium/runs/avis/done.json` |
| 4 | SKILL.md at most 5000 bytes | `test/doc.test.mjs` | `node --test test/doc.test.mjs && wc -c < SKILL.md` |

Caps: `all=ask quality=hard bytes=ask+10% time=ask+10% toolbar.js*=ask summary*=ask mount*=ask`

## Non-goals
- Syncing comments between people or machines.
- Being a design tool: style tweaks are a preview, not an editor.
