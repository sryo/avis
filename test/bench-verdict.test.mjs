// fium's verdict on the A/A fixture (one toolbar.js benched against itself) must
// match what scripts/compare.mjs said on the same run: every metric "same".
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare } from "../scripts/compare.mjs";

const fix = (f) => fileURLToPath(new URL(`fixtures/${f}`, import.meta.url));
const noise = fileURLToPath(new URL("../bench/noise.json", import.meta.url));
const fium = process.env.FIUM || join(homedir(), "Documents/fium/fium");

test("fium price compare gives the A/A run the verdicts compare.mjs gave", { skip: !existsSync(fium) && "fium not installed" }, () => {
  const old = Object.fromEntries(compare(JSON.parse(readFileSync(fix("aa.json"), "utf8")))
    .map((r) => [r.metric.replace(/ p50$/, " ms"), r.verdict]));
  const rows = JSON.parse(execFileSync(fium, ["price", "compare", fix("aa-house.base.json"), fix("aa-house.json"), "--noise", noise, "--json"]).toString());
  const now = Object.fromEntries(rows.filter((r) => old[r.metric]).map((r) => [r.metric, r.verdict]));
  assert.deepEqual(now, old);
});
