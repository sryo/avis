# When the user asks you to annotate

The user can flip the direction and ask you to pin comments. Typical requests:

- **Critique / review**: "what's wrong here", "critique this design"
- **Walkthrough / explain**: "annotate how this flow works"
- **Diff / changes**: "show me what changed in the last 10 commits"
- **Locate / map**: "where does X live"
- **Onboarding / docs**: "annotate the key parts for a new dev"

## Flow

1. Pick the tab and mount the toolbar (SKILL.md steps 1 and 2).
2. Gather what the request needs:
   - `mcp__perch__get_text` for page text, or `get_text { html: true }` for markup. Output is capped at 20000 chars with a `[truncated: ...]` marker; page with `offset` / `maxChars`.
   - `mcp__perch__accessibility_snapshot` for refs and roles.
   - `git log`, `git diff` and `Read` for code context.
   - `mcp__perch__screenshot` when the issue is visual.
3. Pin every finding in one `eval_js` call:
   ```
   return [
     __avis.add('[data-testid="plan-card"]', "Card padding is tighter than the grid gutter"),
     __avis.add("nav a.active", "Active link has no focus ring"),
   ]
   ```
   Use selectors that resolve to exactly one element (prefer `[data-testid]` or stable classes). Each `add()` returns the new id, or `null` when the selector matched nothing.
4. For each `null` (hover-only state, a dynamic overlay, anything visible in the screenshot but absent from the static DOM), still report the finding with a short description of what you saw and roughly where.
5. Tell the user how many were placed and which couldn't be anchored, then stop.

## Replies

A user reply shows up in `__avis.summary()` with `replyTo` set to your annotation's id. Treat it as a follow-up question and answer with `__avis.add(selector, comment, { replyTo: <theirReplyId> })`.

Don't mix this with the user-driven flow in the same session unless asked.
