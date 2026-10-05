#!/usr/bin/env node
// Judges an A/B run from scripts/bench.mjs. Every metric is lower-is-better.
// A time metric regresses when the median of paired per-rep ratios (run/base, reps run
// back to back) is above 1+REL and the p50s differ by more than ABS_MS; "better" mirrors
// that. A byte metric regresses on any increase. On this machine A/A pairs stay within
// ~±10%, so re-run a lone borderline WORSE with --only before believing it.
// Exits 1 on any regression, missing op, or op error.
//   node scripts/compare.mjs [bench/runs/latest.json]

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REL = 0.10, ABS_MS = 0.05;

export function verdict(kind, b, r, ratio) {
  const d = r - b;
  if (kind === "bytes") return d > 0 ? "worse" : d < 0 ? "better" : "same";
  if (Math.abs(d) <= ABS_MS) return "same";
  const q = ratio ?? (b ? r / b : 1);
  return q > 1 + REL ? "worse" : q < 1 - REL ? "better" : "same";
}

export function compare(ab) {
  const rows = [];
  const push = (metric, kind, b, r, ratio) => {
    if (b == null || r == null) { rows.push({ metric, kind, base: b, run: r, verdict: b == null ? "new" : "missing" }); return; }
    const delta = ratio != null ? ratio - 1 : b ? (r - b) / b : 0;
    rows.push({ metric, kind, base: b, run: r, delta, verdict: verdict(kind, b, r, ratio) });
  };
  for (const k of new Set([...Object.keys(ab.base.static), ...Object.keys(ab.run.static)])) {
    push(k, "bytes", ab.base.static[k], ab.run.static[k]);
  }
  for (const [op, v] of Object.entries(ab.results)) {
    if (v.error) { rows.push({ metric: op, kind: "ms", verdict: "error", error: v.error }); continue; }
    if (v.base.p50 || v.run.p50) push(op + " p50", "ms", v.base.p50, v.run.p50, v.pairedRatio);
    if (v.base.bytes != null || v.run.bytes != null) push(op + " bytes", "bytes", v.base.bytes, v.run.bytes);
  }
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ab = JSON.parse(readFileSync(resolve(ROOT, process.argv[2] || "bench/runs/latest.json"), "utf8"));
  if (!ab.base) { console.error("not an A/B run; rerun scripts/bench.mjs without --no-base"); process.exit(2); }
  const rows = compare(ab);
  const fmt = (v, kind) => v == null ? "-" : kind === "bytes" ? String(v) : v.toFixed(3);
  console.log(`base ${ab.base.rev} vs run ${ab.run.rev} (${ab.browser}, reps ${ab.reps})`);
  for (const r of rows) {
    const pctStr = r.delta == null ? "" : `${r.delta >= 0 ? "+" : ""}${(r.delta * 100).toFixed(1)}%`;
    console.log(`${r.verdict.toUpperCase().padEnd(7)} ${r.metric.padEnd(34)} ${fmt(r.base, r.kind).padStart(10)} → ${fmt(r.run, r.kind).padStart(10)} ${pctStr}${r.error ? " " + r.error.split("\n")[0] : ""}`);
  }
  const bad = rows.filter((r) => ["worse", "error", "missing"].includes(r.verdict));
  const good = rows.filter((r) => r.verdict === "better");
  console.log(`${good.length} better, ${bad.length} regression(s)`);
  process.exit(bad.length ? 1 : 0);
}
