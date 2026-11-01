// scripts/bench.mjs --house: an A/B run in fium's run format (fium RULES.md K2),
// one file per side, so `fium compare <base> <run>` judges the pair: each
// op's per-rep timings as a time metric, its result bytes and toolbar.js's sizes
// as bytes metrics. Reps of A and B ran back to back, so fium pairs them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { houseSide, houseFiles } from "../scripts/bench.mjs";

const ab = {
  base: { rev: "a", static: { "toolbar.js bytes": 100, "toolbar.js gzip": 40 } },
  run: { rev: "b", static: { "toolbar.js bytes": 98, "toolbar.js gzip": 39 } },
  results: {
    "summary() x20 @100": { base: { p50: 1.3, bytes: 500, ms: [1.2, 1.3, 1.4] }, run: { p50: 1.2, bytes: 450, ms: [1.1, 1.2, 1.3] }, pairedRatio: 0.92 },
    mount: { base: { p50: 2, ms: [2, 2.1] }, run: { p50: 2.2, ms: [2.2, 2.3] }, pairedRatio: 1.1 },
    broken: { error: "boom" },
  },
};

test("houseSide turns one side of an A/B run into house metrics", () => {
  assert.deepEqual(houseSide(ab, "run"), {
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

test("an op that errored is left out of both sides, so house reports it missing from neither", () => {
  for (const side of ["base", "run"]) assert.equal(houseSide(ab, side).metrics["broken ms"], undefined);
});

test("houseFiles names the base side next to the run", () => {
  const files = houseFiles(ab, "bench/runs/house.json");
  assert.deepEqual(Object.keys(files), ["bench/runs/house.base.json", "bench/runs/house.json"]);
  assert.deepEqual(files["bench/runs/house.base.json"].metrics["toolbar.js bytes"].samples, [100]);
});

// A run with no base (--no-base, --save-baseline) has its results flat: one file.
test("a single run writes one file, from its p50s", () => {
  const one = { static: { "toolbar.js bytes": 98, "toolbar.js gzip": 39 }, results: { mount: { p50: 2.2, min: 2, p90: 2.4 } } };
  const files = houseFiles(one, "bench/runs/one.json");
  assert.deepEqual(Object.keys(files), ["bench/runs/one.json"]);
  assert.deepEqual(files["bench/runs/one.json"].metrics["mount ms"].samples, [2.2]);
});

test("an op that measures only bytes (0ms every rep) has no time metric", () => {
  const out = { static: {}, results: { "storage bytes @100": { p50: 0, bytes: 9, ms: [0, 0] } } };
  assert.deepEqual(Object.keys(houseSide(out, null).metrics), ["storage bytes @100 bytes"]);
});
