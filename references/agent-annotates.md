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
   - `get_text` for page text, or `get_text { html: true }` for markup. Output is capped at 20000 chars with a `[truncated: ...]` marker; page with `offset` / `maxChars`.
   - `accessibility_snapshot` for refs and roles.
   - `git log`, `git diff` and the source files for code context.
   - `screenshot` when the issue is visual.
   - While the user is away, read or screenshot it in a tab opened with `new_tab { url, loft: true }`, perch's own window on the loft (a hidden screen) in the user's profile. Pins live per profile, so pins made there reach the user, unlike in a room. To review at a given size (a breakpoint), make a loft that size first: `loft up 1280x800 --new --json`, then `new_tab { url, loft: "<id>" }`, and `loft down <id>` when done.
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
