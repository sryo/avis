// The A/A fixture benches one toolbar.js against itself, so with bench/noise.json
// fium must call every metric the same.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { NOISE_ARGS } from "../scripts/bench.mjs";

const fix = (f) => fileURLToPath(new URL(`fixtures/${f}`, import.meta.url));
const noise = fileURLToPath(new URL("../bench/noise.json", import.meta.url));
const fium = process.env.FIUM || join(homedir(), "Documents/fium/fium");

test("fium compare calls the A/A run the same on every metric", { skip: !existsSync(fium) && "fium not installed" }, () => {
  const metrics = Object.keys(JSON.parse(readFileSync(fix("aa-fium.json"), "utf8")).metrics);
  const rows = JSON.parse(execFileSync(fium, ["compare", fix("aa-fium.base.json"), fix("aa-fium.json"), "--noise", noise, "--json"]).toString());
  const verdicts = Object.fromEntries(rows.filter((r) => metrics.includes(r.metric)).map((r) => [r.metric, r.verdict]));
  assert.deepEqual(verdicts, Object.fromEntries(metrics.map((m) => [m, "same"])));
});

// bench/noise.json is what fium noise writes from the A/A fixture, with the args the bench passes it.
test("fium noise writes bench/noise.json from the A/A run", { skip: !existsSync(fium) && "fium not installed" }, () => {
  const out = execFileSync(fium, ["noise", fix("aa-fium.base.json"), fix("aa-fium.json"), ...NOISE_ARGS]).toString();
  assert.equal(out, readFileSync(noise, "utf8"));
});
