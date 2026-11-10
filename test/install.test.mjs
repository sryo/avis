// install.sh, run as `curl ... | bash` runs it (the script on stdin), with a temp HOME and
// AVIS_REPO on a file:// clone of this repo: the clone and the Claude link land, a second run
// changes nothing, and a directory or a link to somewhere else is left in place.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readlinkSync, lstatSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let tmp, origin;

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "avis-install-"));
  origin = join(tmp, "origin.git");
  execFileSync("git", ["clone", "--quiet", "--bare", root, origin]);
});
after(() => rmSync(tmp, { recursive: true, force: true }));

function home() {
  const h = mkdtempSync(join(tmp, "home-"));
  return { h, skill: join(h, ".agents/skills/avis"), link: join(h, ".claude/skills/avis") };
}

function install(h) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AVIS_|GIT_)/.test(k)));
  const p = spawnSync("bash", [], {
    input: readFileSync(join(root, "install.sh")),
    env: { ...env, HOME: h, AVIS_REPO: `file://${origin}` },
    encoding: "utf8",
  });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return p.stdout;
}

test("install clones and links, and a second run is idempotent", () => {
  const { h, skill, link } = home();
  install(h);
  assert.ok(existsSync(join(skill, "SKILL.md")));
  assert.equal(readlinkSync(link), skill);
  const head = execFileSync("git", ["-C", skill, "rev-parse", "HEAD"], { encoding: "utf8" });
  const out = install(h);
  assert.match(out, /pulling latest/);
  assert.match(out, /already links to/);
  assert.equal(readlinkSync(link), skill);
  assert.equal(execFileSync("git", ["-C", skill, "rev-parse", "HEAD"], { encoding: "utf8" }), head);
});

test("install leaves a directory at the link path in place", () => {
  const { h, link } = home();
  mkdirSync(link, { recursive: true });
  const out = install(h);
  assert.ok(!lstatSync(link).isSymbolicLink());
  assert.match(out, /exists and isn't a link; leaving it/);
});

test("install leaves a link to somewhere else in place", () => {
  const { h, skill, link } = home();
  const other = join(h, "other");
  mkdirSync(join(h, ".claude/skills"), { recursive: true });
  symlinkSync(other, link);
  const out = install(h);
  assert.equal(readlinkSync(link), other);
  assert.ok(out.includes(`links to ${other}, not ${skill}; leaving it`));
});

test("install doesn't clone again over an install elsewhere", () => {
  const { h, skill, link } = home();
  const other = join(h, "Documents/avis");
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, "SKILL.md"), "");
  mkdirSync(join(h, ".claude/skills"), { recursive: true });
  symlinkSync(other, link);
  const out = install(h);
  assert.match(out, /already installed/);
  assert.ok(!existsSync(skill));
  assert.equal(readlinkSync(link), other);
});
