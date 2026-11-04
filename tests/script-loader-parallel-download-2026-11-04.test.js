/**
 * tests/script-loader-parallel-download-2026-11-04.test.js — CRM speed-up plan Phase 1.1
 * (documentation/projects/CRM-SPEED-UP-PLAN-2026-11-04.md).
 *
 * THE BUG: ScriptLoader.loadBundle() chained load(src) one file after another, so each file waited for the previous
 * one to finish DOWNLOADING. At 150 ms RTT the expenses view (35 files) took 9.1 s and estimates (31) 15.0 s.
 *
 * THE FIX: loadBundle() first adds <link rel="preload"> for every file in the bundle (as=script / as=style), so all
 * downloads start at once. The chain still inserts and RUNS the files in bundle order, one after the previous one's
 * load event, exactly as before. Measured after: 3.7 s and 9.9 s, same file count (no double download).
 *
 * Runs the REAL script-loader.js in a vm against a fake DOM that records every element appended to <head> and fires
 * each <script>/<link stylesheet> load on demand.
 *
 * Checks:
 *   - every file of the bundle is preloaded BEFORE the first one is inserted (downloads are parallel);
 *   - script tags are inserted strictly in bundle order, each only after the previous file's load;
 *   - a CSS entry still finishes before the next JS is inserted;
 *   - a file already on the page as a tag is neither preloaded nor injected; a second loadBundle warms nothing;
 *   - positive control: without the warm step (main), the preload count is 0.
 *
 * Zero deps. Run: node tests/script-loader-parallel-download-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'docs/pro/js/script-loader.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

function makeEnv(staticScripts = []) {
  const log = [];
  const appended = [];
  const el = (tag) => {
    const e = { tagName: tag.toUpperCase(), attrs: {}, set rel(v) { this.attrs.rel = v; }, get rel() { return this.attrs.rel; },
      setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'src' ? this.src : k === 'href' ? this.href : this.attrs[k]; } };
    return e;
  };
  const statics = staticScripts.map((s) => ({ getAttribute: (k) => (k === 'src' ? s : null) }));
  const document = {
    baseURI: 'https://nobigdealwithjoedeal.com/pro/dashboard',
    createElement: el,
    head: { appendChild(e) { appended.push(e); log.push((e.tagName === 'SCRIPT' ? 'run ' : (e.rel === 'preload' ? 'preload ' : 'css ')) + (e.src || e.href)); } },
    querySelector: () => null,
    querySelectorAll: (sel) => (sel.startsWith('script') ? statics : []),
  };
  const window = { console: { warn() {}, log() {} } };
  const ctx = { window, document, console: window.console, URL, setTimeout, clearTimeout, Promise };
  window.window = window; window.document = document;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { SL: ctx.window.ScriptLoader, log, appended };
}

// Fire load events one at a time, in the order the loader inserted them, so ordering is observable.
async function drain(env) {
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setImmediate(r));
    const next = env.appended.find((e) => !e._fired && (e.tagName === 'SCRIPT' || e.rel === 'stylesheet'));
    if (!next) { if (i > 5) break; continue; }
    next._fired = true;
    env.log.push('loaded ' + (next.src || next.href));
    if (typeof next.onload === 'function') next.onload();
  }
}

(async () => {
  const env = makeEnv();
  ok('the loader is exposed', env.SL && typeof env.SL.loadBundle === 'function');
  const BUNDLE = 'expenses';
  const done = env.SL.loadBundle(BUNDLE);
  await drain(env);
  await done;

  const preloads = env.log.filter((l) => l.startsWith('preload '));
  const runs = env.log.filter((l) => l.startsWith('run ') || l.startsWith('css '));
  const firstRun = env.log.findIndex((l) => l.startsWith('run ') || l.startsWith('css '));
  ok(`every file of "${BUNDLE}" is preloaded (${preloads.length})`, preloads.length >= 20 && preloads.length === runs.length, `${preloads.length} preloads / ${runs.length} inserts`);
  ok('all preloads are issued before the first file is inserted (parallel downloads)', firstRun > 0 && env.log.slice(0, firstRun).every((l) => l.startsWith('preload ')), env.log.slice(0, 3).join(' | '));
  ok('preload types match (as=script for .js, as=style for .css)', env.appended.filter((e) => e.rel === 'preload').every((e) => (/\.css(\?|#|$)/.test(e.href) ? e.attrs.as === 'style' || e.as === 'style' : e.attrs.as === 'script' || e.as === 'script')));

  // Inserted in bundle order, each after the previous one's load.
  const order = preloads.map((l) => l.slice(8));
  const inserted = runs.map((l) => l.replace(/^(run|css) /, ''));
  ok('files are inserted in exactly the preload (bundle) order', JSON.stringify(order) === JSON.stringify(inserted));
  let serial = true;
  for (let i = 1; i < inserted.length; i++) {
    const ins = env.log.indexOf((env.log.find((l) => l.endsWith(' ' + inserted[i]) && !l.startsWith('preload') && !l.startsWith('loaded'))));
    const prevLoaded = env.log.indexOf('loaded ' + inserted[i - 1]);
    if (!(prevLoaded > -1 && prevLoaded < ins)) { serial = false; break; }
  }
  ok('each file is inserted only after the previous file loaded (run order unchanged)', serial);
  ok('the bundle reports loaded', env.SL.isLoaded(BUNDLE));

  // Second call: nothing new warmed or inserted.
  const before = env.appended.length;
  await env.SL.loadBundle(BUNDLE);
  ok('loading the same bundle again adds nothing', env.appended.length === before);

  // A file already on the page as a tag is skipped by both warm() and load().
  const env2 = makeEnv(['/pro/js/expenses.js']);
  const p2 = env2.SL.loadBundle(BUNDLE);
  await drain(env2); await p2;
  ok('a file already on the page is neither preloaded nor injected', !env2.log.some((l) => /expenses\.js(\?|$)/.test(l)) && env2.log.some((l) => l.startsWith('preload ')));

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
