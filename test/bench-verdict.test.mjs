// The A/A fixture benches one toolbar.js against itself, so with bench/noise.json
// fium must call every metric the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const fix = (f) => fileURLToPath(new URL(`fixtures/${f}`, import.meta.url));
const noise = fileURLToPath(new URL("../bench/noise.json", import.meta.url));
const fium = process.env.FIUM || join(homedir(), "Documents/fium/fium");

test("fium price compare calls the A/A run the same on every metric", { skip: !existsSync(fium) && "fium not installed" }, () => {
  const metrics = Object.keys(JSON.parse(readFileSync(fix("aa-house.json"), "utf8")).metrics);
  const rows = JSON.parse(execFileSync(fium, ["price", "compare", fix("aa-house.base.json"), fix("aa-house.json"), "--noise", noise, "--json"]).toString());
  const verdicts = Object.fromEntries(rows.filter((r) => metrics.includes(r.metric)).map((r) => [r.metric, r.verdict]));
  assert.deepEqual(verdicts, Object.fromEntries(metrics.map((m) => [m, "same"])));
});
