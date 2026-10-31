import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readlinkSync } from "node:fs";
import { mount } from "./_mount.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");
const REFS = ["references/schema.md", "references/agent-annotates.md", "references/setup.md"];
const PERCH_TOOLS = new Set([
  "list_tabs", "new_tab", "activate_tab", "navigate", "eval_js", "wait", "screenshot", "get_text",
  "accessibility_snapshot", "console_capture", "notify", "file_upload", "click", "fill", "select",
]);

const { window, avis } = mount({ test: false });
after(() => window.happyDOM.close());

test("SKILL.md stays under 5000 bytes", () => {
  const bytes = Buffer.byteLength(read("SKILL.md"));
  assert.ok(bytes <= 5000, `${bytes} bytes`);
});

test("reference files exist and SKILL.md links each one", () => {
  const skill = read("SKILL.md");
  for (const ref of REFS) {
    assert.ok(existsSync(new URL(ref, root)), ref);
    assert.ok(skill.includes(ref), `SKILL.md links ${ref}`);
  }
});

test("frontmatter description carries the when-to-suggest guidance", () => {
  const fm = read("SKILL.md").split("---")[1];
  assert.match(fm, /^description: .*\bOffer\b/m);
  assert.doesNotMatch(read("SKILL.md"), /^## When to suggest/m);
});

test("SKILL.md's window.__avis line lists exactly the mounted API", () => {
  const line = read("SKILL.md").split("\n").find((l) => l.startsWith("`window.__avis`:"));
  const listed = [...line.slice(16).matchAll(/`([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  assert.deepEqual(listed.filter((n) => !(n in avis)), []);
  assert.deepEqual(Object.keys(avis).filter((k) => k !== "_t" && !listed.includes(k)), []);
});

for (const file of ["SKILL.md", ...REFS]) {
  test(`${file}: every __avis.<name> exists on the mounted API`, () => {
    const names = new Set([...read(file).matchAll(/__avis\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const missing = [...names].filter((n) => !(n in avis));
    assert.deepEqual(missing, []);
  });

  test(`${file}: only names perch tools that exist, no stale perch contract`, () => {
    const text = read(file);
    // Calls are written bare (`list_tabs { ... }`), prefixed only in examples of client naming.
    const calls = [...text.matchAll(/(?:^|[`\s])(?:mcp__perch__)?([a-z][a-z_]+) \{/gm)].map((m) => m[1]);
    const prefixed = [...text.matchAll(/mcp__perch__(\w+)/g)].map((m) => m[1]);
    assert.deepEqual([...calls, ...prefixed].filter((t) => !PERCH_TOOLS.has(t)), []);
    if (file === "SKILL.md") assert.ok(calls.includes("list_tabs") && calls.includes("eval_js"));
    assert.doesNotMatch(text, /get_html|page_state|JSON\.stringify\(\s*(window\.)?__avis/);
  });

  test(`${file}: no em-dashes`, () => {
    assert.doesNotMatch(read(file), /—/);
  });
}

test("SKILL.md activates an inactive tab before mounting instead of waiting for tab_not_visible", () => {
  const step1 = read("SKILL.md").split("2. **Mount")[0];
  assert.match(step1, /isn't `active`.*activate_tab \{ target \}/s);
});

test("SKILL.md resolves one group and marks the next working in a single call", () => {
  assert.match(read("SKILL.md"), /return \[__avis\.resolve\([^)]*\), __avis\.markWorking\(/);
});

test("SKILL.md reads back with a count and grouping, not one echoed line per annotation", () => {
  const step4 = read("SKILL.md").split("4. **Read back**")[1].split("5. **Act")[0];
  assert.doesNotMatch(step4, /one line per annotation/);
  assert.match(step4, /how many/);
});

test("frontmatter description stays short; it loads in every session", () => {
  const desc = read("SKILL.md").split("---")[1].match(/^description: (.*)$/m)[1];
  assert.ok(desc.length <= 220, `${desc.length} chars`);
});

test("SKILL.md marks schema.md as optional, so a normal pass doesn't read it", () => {
  assert.match(read("SKILL.md"), /only if a field is unclear: `references\/schema\.md`/);
});

test("CLAUDE.md is a symlink to AGENTS.md, so there is one copy to keep current", () => {
  assert.equal(readlinkSync(new URL("CLAUDE.md", root)), "AGENTS.md");
});

test("README has Install then Use", () => {
  const readme = read("README.md");
  assert.match(readme, /^## Install$[\s\S]*^## Use$/m);
});

// One copy in ~/.agents/skills (Codex, Copilot), linked into ~/.claude/skills, so
// every agent runs the same files and one `git pull` updates them all.
test("install clones once into ~/.agents/skills and links ~/.claude/skills to it", () => {
  for (const f of ["README.md", "index.html"]) {
    const doc = read(f);
    assert.ok(doc.includes("git clone https://github.com/sryo/avis ~/.agents/skills/avis"), `${f} clones into ~/.agents/skills`);
    assert.ok(doc.includes("ln -s ~/.agents/skills/avis ~/.claude/skills/avis"), `${f} links ~/.claude/skills`);
    assert.ok(!doc.includes("clone into") && !doc.includes("Clone wherever"), `${f} has one install path`);
  }
});
