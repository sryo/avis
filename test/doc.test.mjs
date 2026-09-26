import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
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

for (const file of ["SKILL.md", ...REFS]) {
  test(`${file}: every __avis.<name> exists on the mounted API`, () => {
    const names = new Set([...read(file).matchAll(/__avis\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
    const missing = [...names].filter((n) => !(n in avis));
    assert.deepEqual(missing, []);
  });

  test(`${file}: only names perch tools that exist, no stale perch contract`, () => {
    const text = read(file);
    const tools = [...text.matchAll(/mcp__perch__(\w+)/g)].map((m) => m[1]);
    assert.deepEqual(tools.filter((t) => !PERCH_TOOLS.has(t)), []);
    assert.doesNotMatch(text, /get_html|page_state|JSON\.stringify\(\s*(window\.)?__avis/);
  });

  test(`${file}: no em-dashes`, () => {
    assert.doesNotMatch(read(file), /—/);
  });
}
