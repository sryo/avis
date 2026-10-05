#!/usr/bin/env node
// Benchmarks toolbar.js in headless Chrome (CDP over a pipe, no deps) with bench/suite.js.
// A/B by default: the working-tree toolbar.js against `--base` (a git ref, default the
// ref in bench/baseline.json), reps interleaved in one browser so machine noise hits
// both alike. Absolute numbers swing ±50% between runs on a busy Mac; the ratio doesn't.
//   node scripts/bench.mjs [--base <ref>|--no-base] [--reps 15] [--src toolbar.js]
//                          [--only "op|op"] [--out bench/runs/latest.json] [--chrome path]
//                          [--save-baseline]
// --save-baseline runs the working tree alone and records it in bench/baseline.json.
// Then `node scripts/compare.mjs` judges the run (exit 1 on a regression).

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const a = { reps: 15, src: "toolbar.js", base: undefined, out: null, only: null, chrome: null, saveBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--reps") a.reps = +argv[++i];
    else if (k === "--src") a.src = argv[++i];
    else if (k === "--base") a.base = argv[++i];
    else if (k === "--no-base") a.base = null;
    else if (k === "--out") a.out = argv[++i];
    else if (k === "--only") a.only = argv[++i].split("|").map((s) => s.trim());
    else if (k === "--chrome") a.chrome = argv[++i];
    else if (k === "--save-baseline") { a.saveBaseline = true; a.base = null; }
    else throw new Error("unknown arg " + k);
  }
  if (!Number.isInteger(a.reps) || a.reps < 1) throw new Error("--reps must be a positive integer");
  return a;
}

const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);

const r3 = (x) => Math.round(x * 1000) / 1000;
export function stats(ms) {
  if (!ms.length) return { p50: null, min: null, p90: null };
  const s = ms.slice().sort((a, b) => a - b), m = s.length >> 1;
  const p50 = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return { p50: r3(p50), min: r3(s[0]), p90: r3(s[Math.min(s.length - 1, Math.ceil(s.length * 0.9) - 1)]) };
}

const git = (...args) => execFileSync("git", ["-C", ROOT, ...args]).toString();
const staticOf = (src) => ({ "toolbar.js bytes": Buffer.byteLength(src), "toolbar.js gzip": gzipSync(src).length });

// Minimal CDP client over --remote-debugging-pipe (fd 3 write, fd 4 read, NUL-framed JSON).
function cdp(proc) {
  let id = 0, buf = "";
  const pending = new Map();
  proc.stdio[4].on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let i;
    while ((i = buf.indexOf("\0")) !== -1) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    }
  });
  return (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { res, rej });
    proc.stdio[3].write(JSON.stringify(msg) + "\0");
  });
}

function serve() {
  const suite = readFileSync(join(ROOT, "bench/suite.js"), "utf8");
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>avis bench</title></head><body><script>${suite}</script></body></html>`;
  const server = createServer((req, res) => {
    // Cross-origin isolation lifts performance.now() to ~5µs resolution.
    res.writeHead(200, {
      "content-type": "text/html",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
    });
    res.end(page);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

// Runs every source through the suite; returns {browser, results:{op:[{p50,min,p90,bytes?}|{error}]}}.
export async function runSources(srcs, opts) {
  const chrome = opts.chrome || CHROME_CANDIDATES.find((p) => existsSync(p));
  if (!chrome) throw new Error("no Chrome found; pass --chrome or set CHROME");
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = mkdtempSync(join(tmpdir(), "avis-bench-"));
  const proc = spawn(chrome, [
    "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--window-size=1400,900", "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const send = cdp(proc);
  try {
    const version = await send("Browser.getVersion");
    const { targetId } = await send("Target.createTarget", { url });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      const r = await send("Runtime.evaluate", { expression: "typeof window.runSuite", returnByValue: true }, sessionId);
      ready = r.result.value === "function";
      if (!ready) await new Promise((r) => setTimeout(r, 50));
    }
    if (!ready) throw new Error("bench page never loaded");
    const expr = `runSuite(${JSON.stringify(srcs)}, ${opts.reps}, ${JSON.stringify(opts.only)})`;
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 1800000 }, sessionId);
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
    const results = {};
    for (const [op, v] of Object.entries(r.result.value)) {
      results[op] = v.error ? { error: v.error }
        : v.map((x) => ({ ...stats(x.ms), ...(x.bytes != null ? { bytes: x.bytes } : {}), ms: x.ms.map(r3) }));
    }
    return { browser: version.product, results };
  } finally {
    proc.kill();
    server.close();
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

function baselineRef() {
  try { return JSON.parse(readFileSync(join(ROOT, "bench/baseline.json"), "utf8")).rev; } catch { return "HEAD"; }
}

export async function run(opts) {
  const src = readFileSync(resolve(ROOT, opts.src), "utf8");
  let rev = "unknown", dirty = false;
  try { rev = git("rev-parse", "--short", "HEAD").trim(); } catch {}
  try { dirty = git("status", "--porcelain", "--", opts.src).trim() !== ""; } catch {}
  const runInfo = { rev: rev + (dirty ? "+dirty" : ""), static: staticOf(src) };
  if (opts.base === null) {
    const { browser, results } = await runSources([src], opts);
    const flat = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.error ? v : (({ ms, ...rest }) => rest)(v[0])]));
    return { date: new Date().toISOString(), browser, reps: opts.reps, ...runInfo, results: flat };
  }
  const baseRef = opts.base || baselineRef();
  const baseSrc = git("show", `${baseRef}:${opts.src}`);
  const { browser, results } = await runSources([baseSrc, src], opts);
  const ab = {};
  for (const [op, v] of Object.entries(results)) {
    if (v.error) { ab[op] = v; continue; }
    // Reps of A and B ran back to back, so their ratio cancels drift that independent p50s keep.
    const ratios = v[1].ms.map((x, i) => (v[0].ms[i] > 0 ? x / v[0].ms[i] : 1));
    ab[op] = { base: v[0], run: v[1], pairedRatio: r3(stats(ratios).p50 ?? 1) };
  }
  return {
    date: new Date().toISOString(), browser, reps: opts.reps,
    base: { rev: git("rev-parse", "--short", baseRef).trim(), static: staticOf(baseSrc) },
    run: runInfo,
    results: ab,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const out = await run(opts);
  const file = opts.saveBaseline ? join(ROOT, "bench/baseline.json")
    : resolve(ROOT, opts.out || "bench/runs/latest.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`${out.browser} reps ${out.reps} → ${file}`);
  if (out.base) console.log(`A/B: base ${out.base.rev} vs run ${out.run.rev}; judge with: node scripts/compare.mjs ${file}`);
  else for (const [op, v] of Object.entries(out.results)) {
    console.log(v.error ? `${op.padEnd(28)} ERROR ${v.error.split("\n")[0]}`
      : `${op.padEnd(28)} p50 ${String(v.p50).padStart(9)}ms  min ${String(v.min).padStart(9)}ms${v.bytes != null ? `  ${v.bytes}B` : ""}`);
  }
}
