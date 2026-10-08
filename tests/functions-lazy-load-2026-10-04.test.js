/**
 * tests/functions-lazy-load-2026-10-04.test.js
 *
 * functions/index.js gained a FUNCTION_TARGET fast path: a running instance
 * exports only its own function, loaded from only its own module (looked up in
 * functions/function-map.json), instead of requiring ~116 modules for 237
 * exports on every cold start. Deploy discovery runs without FUNCTION_TARGET
 * and takes the unchanged full path.
 *
 * What would go wrong, and the assertion that catches it:
 *   - a function added/moved without regenerating the map → its instance
 *     silently pays the full load (or, if the map points at the wrong module,
 *     serves the wrong object). MAP: the committed map equals a fresh build,
 *     and every entry is re-proved by OBJECT IDENTITY against the full load.
 *   - the deploy stops seeing a function. DISCOVERY: firebase-functions' own
 *     loader (the code path `firebase deploy` uses) yields exactly the map's
 *     names, and exactly the set the deploy workflow's export grep derives.
 *   - the fast path serves something different from the full path. LAZY: for
 *     EVERY one of the 237 targets, a cold load with FUNCTION_TARGET set
 *     exports exactly [target], its endpoint (trigger, region, memory,
 *     secrets, schedule…) is identical to the full load's, and it loaded a
 *     small fraction of the modules the full load does.
 *   - an unknown target breaks the instance. FALLBACK: it gets the full load.
 *
 * Needs functions/node_modules (CI's unit-suite job installs it).
 * Run: node tests/functions-lazy-load-2026-10-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'functions');
const INDEX = path.join(FUNCTIONS, 'index.js');

// ── child mode: cold-load index.js once per target in a single process ─────
if (process.argv[2] === '--child') {
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'nobigdeal-pro';
  const noop = () => {};
  console.log = noop; console.info = noop; console.warn = noop;
  process.stdout.write = ((w) => function (chunk, ...rest) { return /^\{"severity"/.test(String(chunk)) ? true : w.call(process.stdout, chunk, ...rest); })(process.stdout.write);
  // index.js calls admin.initializeApp() at load; re-loading it in one process
  // would throw "default app already exists". firebase-admin lives in
  // node_modules (never evicted below), so delete the default app between loads.
  const { getApps, deleteApp } = require(require.resolve('firebase-admin/app', { paths: [FUNCTIONS] }));
  const own = () => Object.keys(require.cache).filter((f) => f.startsWith(FUNCTIONS + path.sep) && !f.includes(path.sep + 'node_modules' + path.sep));
  const evictSync = () => { for (const f of own()) delete require.cache[f]; };
  const evict = async () => { evictSync(); for (const a of getApps()) await deleteApp(a); };
  (async () => {
  const ep = (fn) => JSON.stringify(fn && fn.__endpoint);
  const out = { full: {}, fullModules: 0, lazy: {}, unknown: null };
  delete process.env.FUNCTION_TARGET;
  await evict();
  const full = require(INDEX);
  out.fullModules = own().length;
  const names = Object.keys(full).filter((k) => typeof full[k] === 'function' && full[k].__endpoint);
  for (const n of names) out.full[n] = ep(full[n]);
  for (const n of names) {
    await evict();
    process.env.FUNCTION_TARGET = n;
    const m = require(INDEX);
    out.lazy[n] = { keys: Object.keys(m), ep: ep(m[n]), modules: own().length };
  }
  await evict();
  process.env.FUNCTION_TARGET = 'definitelyNotAFunction';
  const u = require(INDEX);
  out.unknown = { keys: Object.keys(u).length, modules: own().length };
  delete process.env.FUNCTION_TARGET;
  fs.writeFileSync(process.env.NBD_LAZY_RESULT_FILE, JSON.stringify(out));
  process.exit(0);
  })().catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
  return;
}

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

(async () => {
  const gen = require(path.join(ROOT, 'scripts', 'gen-function-map.js'));
  const committed = JSON.parse(fs.readFileSync(path.join(FUNCTIONS, 'function-map.json'), 'utf8'));

  console.log('\nMAP — committed == fresh build from a full load');
  const quiet = console.log; let fresh;
  console.log = () => {};
  const stdoutWrite = process.stdout.write;
  process.stdout.write = function (c, ...r) { return /^\{"severity"/.test(String(c)) ? true : stdoutWrite.call(process.stdout, c, ...r); };
  try { fresh = gen.buildMap(); } finally { console.log = quiet; process.stdout.write = stdoutWrite; }
  {
    const a = Object.keys(committed).sort(), b = Object.keys(fresh).sort();
    const missing = b.filter((n) => !committed[n]);
    const extra = a.filter((n) => !fresh[n]);
    const moved = b.filter((n) => committed[n] && committed[n] !== fresh[n]);
    ok('no exported function is missing from function-map.json', missing.length === 0, missing.join(', ') + ' — run node scripts/gen-function-map.js');
    ok('no stale name in function-map.json', extra.length === 0, extra.join(', '));
    ok('every entry points at the module that defines it', moved.length === 0, moved.map((n) => n + ': ' + committed[n] + ' → ' + fresh[n]).join(', '));
    ok('at least 200 functions mapped (237 on 2026-10-04)', b.length >= 200, String(b.length));
  }
  console.log('\nMAP — identity: require(map[name])[name] IS the full load\'s export');
  {
    const full = require(INDEX); // already loaded by buildMap (no FUNCTION_TARGET)
    const bad = Object.entries(committed).filter(([n, rel]) => { try { return require(path.join(FUNCTIONS, rel))[n] !== full[n]; } catch (_) { return true; } });
    ok('all ' + Object.keys(committed).length + ' entries resolve to the identical object', bad.length === 0, bad.map(([n]) => n).slice(0, 10).join(', '));
  }

  console.log('\nDISCOVERY — the loader `firebase deploy` uses sees exactly the mapped set');
  {
    // By file path: the package's "exports" map hides lib/runtime, but this is
    // the exact loader its own `firebase-functions` bin runs for discovery.
    const loader = require(path.join(FUNCTIONS, 'node_modules', 'firebase-functions', 'lib', 'runtime', 'loader.js'));
    let stack;
    console.log = () => {};
    process.stdout.write = function (c, ...r) { return /^\{"severity"/.test(String(c)) ? true : stdoutWrite.call(process.stdout, c, ...r); };
    try { stack = await loader.loadStack(FUNCTIONS); } finally { console.log = quiet; process.stdout.write = stdoutWrite; }
    const eps = Object.keys(stack.endpoints).sort();
    const mapped = Object.keys(committed).sort();
    ok('discovered endpoints == function-map.json names', JSON.stringify(eps) === JSON.stringify(mapped),
      'only discovered: ' + eps.filter((n) => !committed[n]).join(',') + ' | only mapped: ' + mapped.filter((n) => !stack.endpoints[n]).join(','));
    // The deploy workflow builds its --only list by grepping module sources.
    const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'firebase-deploy.yml'), 'utf8');
    const alt = (wf.match(/\^exports\\\.\[a-zA-Z_\]\[a-zA-Z0-9_\]\* \*= \*\(([^)]+)\)/) || [])[1];
    ok('found the deploy workflow\'s export grep alternation', !!alt);
    if (alt) {
      const re = new RegExp('^exports\\.([a-zA-Z_][a-zA-Z0-9_]*) *= *(' + alt.replace(/\\\\/g, '\\') + ')', 'm');
      const files = [];
      for (const d of ['', 'integrations', 'handlers']) {
        for (const f of fs.readdirSync(path.join(FUNCTIONS, d))) if (f.endsWith('.js')) files.push(path.join(FUNCTIONS, d, f));
      }
      files.push(path.join(FUNCTIONS, 'migrations', 'runner.js'));
      const grepped = new Set();
      const reG = new RegExp(re.source, 'gm');
      for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(reG)) grepped.add(m[1]);
      const g = [...grepped].sort();
      ok('deploy workflow grep == discovered endpoints (the --only list deploys every function)', JSON.stringify(g) === JSON.stringify(eps),
        'grep-only: ' + g.filter((n) => !stack.endpoints[n]).join(',') + ' | discovered-only: ' + eps.filter((n) => !grepped.has(n)).join(','));
    }
  }

  console.log('\nLAZY — every target, cold, in a child process');
  {
    // The child hands its result back through a FILE: on Linux a pipe write
    // is async and process.exit() truncated a stderr handoff (CI: "Unexpected
    // end of JSON input"), while Windows pipes are synchronous.
    const resultFile = path.join(require('os').tmpdir(), 'nbd-lazy-load-' + process.pid + '.json');
    try { fs.unlinkSync(resultFile); } catch (_) {}
    const r = spawnSync(process.execPath, [__filename, '--child'], { cwd: FUNCTIONS, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: Object.assign({}, process.env, { FUNCTION_TARGET: '', NBD_LAZY_RESULT_FILE: resultFile }) });
    const have = fs.existsSync(resultFile);
    ok('child ran', r.status === 0 && have, (r.stderr || '').slice(-600));
    if (have) {
      const res = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      try { fs.unlinkSync(resultFile); } catch (_) {}
      const names = Object.keys(res.full);
      const wrongKeys = names.filter((n) => JSON.stringify(res.lazy[n].keys) !== JSON.stringify([n]));
      const diffEp = names.filter((n) => res.lazy[n].ep !== res.full[n]);
      const maxMods = Math.max(...names.map((n) => res.lazy[n].modules));
      const avgMods = names.reduce((s, n) => s + res.lazy[n].modules, 0) / names.length;
      ok('full load: ' + names.length + ' functions from ' + res.fullModules + ' functions/ modules', names.length >= 200 && res.fullModules > 100);
      ok('every target exports exactly itself', wrongKeys.length === 0, wrongKeys.slice(0, 10).join(', '));
      ok('every target\'s endpoint is identical to the full load\'s', diffEp.length === 0, diffEp.slice(0, 10).join(', '));
      ok('every target loads ≤ half the modules of the full load (max ' + maxMods + ', avg ' + avgMods.toFixed(1) + ' vs ' + res.fullModules + ')', maxMods <= res.fullModules / 2);
      ok('unknown FUNCTION_TARGET falls back to the full load', res.unknown.keys >= names.length && res.unknown.modules >= res.fullModules /* +1: function-map.json */, JSON.stringify(res.unknown));
    }
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.log('  ✗ crashed: ' + (e && e.stack || e)); process.exit(1); });
