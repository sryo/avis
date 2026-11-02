// scripts/bench.mjs --fium: an A/B run in fium's run format (fium RULES.md K2),
// one file per side, so `fium compare <base> <run>` judges the pair: each
// op's per-rep timings as a time metric, its result bytes and toolbar.js's sizes
// as bytes metrics. Reps of A and B ran back to back, so fium pairs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fiumSide, fiumFiles, outFile } from "../scripts/bench.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const common = execFileSync("git", ["-C", ROOT, "rev-parse", "--path-format=absolute", "--git-common-dir"]).toString().trim();
const RUNS = join(process.env.FIUM_HOME || join(homedir(), ".fium"), "runs", basename(dirname(common)));

const ab = {
  base: { rev: "a", static: { "toolbar.js bytes": 100, "toolbar.js gzip": 40 } },
  run: { rev: "b", static: { "toolbar.js bytes": 98, "toolbar.js gzip": 39 } },
  results: {
    "summary() x20 @100": { base: { p50: 1.3, bytes: 500, ms: [1.2, 1.3, 1.4] }, run: { p50: 1.2, bytes: 450, ms: [1.1, 1.2, 1.3] }, pairedRatio: 0.92 },
    mount: { base: { p50: 2, ms: [2, 2.1] }, run: { p50: 2.2, ms: [2.2, 2.3] }, pairedRatio: 1.1 },
    broken: { error: "boom" },
  },
};

test("fiumSide turns one side of an A/B run into fium metrics", () => {
  assert.deepEqual(fiumSide(ab, "run"), {
    metrics: {
      "toolbar.js bytes": { dir: "lower", kind: "bytes", samples: [98] },
      "toolbar.js gzip": { dir: "lower", kind: "bytes", samples: [39] },
      "summary() x20 @100 ms": { dir: "lower", kind: "time", samples: [1.1, 1.2, 1.3] },
      "summary() x20 @100 bytes": { dir: "lower", kind: "bytes", samples: [450] },
      "mount ms": { dir: "lower", kind: "time", samples: [2.2, 2.3] },
    },
    limits: {},
  });
});

test("an op that errored is left out of both sides, so fium reports it missing from neither", () => {
  for (const side of ["base", "run"]) assert.equal(fiumSide(ab, side).metrics["broken ms"], undefined);
});

test("fiumFiles names the base side next to the run", () => {
  const files = fiumFiles(ab, join(RUNS, "fium.json"));
  assert.deepEqual(Object.keys(files), [join(RUNS, "fium.base.json"), join(RUNS, "fium.json")]);
  assert.deepEqual(files[join(RUNS, "fium.base.json")].metrics["toolbar.js bytes"].samples, [100]);
});

// A run with no base (--no-base, --save-baseline) has its results flat: one file.
test("a single run writes one file, from its p50s", () => {
  const one = { static: { "toolbar.js bytes": 98, "toolbar.js gzip": 39 }, results: { mount: { p50: 2.2, min: 2, p90: 2.4 } } };
  const files = fiumFiles(one, join(RUNS, "one.json"));
  assert.deepEqual(Object.keys(files), [join(RUNS, "one.json")]);
  assert.deepEqual(files[join(RUNS, "one.json")].metrics["mount ms"].samples, [2.2]);
});

test("an op that measures only bytes (0ms every rep) has no time metric", () => {
  const out = { static: {}, results: { "storage bytes @100": { p50: 0, bytes: 9, ms: [0, 0] } } };
  assert.deepEqual(Object.keys(fiumSide(out, null).metrics), ["storage bytes @100 bytes"]);
});

// fium RULES.md K2: runs live outside the repo, in ${FIUM_HOME:-~/.fium}/runs/<repo>/.
test("the run goes to the fium runs folder unless --out names a file", () => {
  assert.equal(outFile(null), join(RUNS, "latest.json"));
  assert.equal(outFile("x/y.json"), resolve(ROOT, "x/y.json"));
});

test("FIUM_HOME moves the runs folder", () => {
  const was = process.env.FIUM_HOME;
  process.env.FIUM_HOME = "/tmp/fium-home";
  try { assert.equal(outFile(null), join("/tmp/fium-home/runs", basename(RUNS), "latest.json")); }
  finally { if (was === undefined) delete process.env.FIUM_HOME; else process.env.FIUM_HOME = was; }
});
