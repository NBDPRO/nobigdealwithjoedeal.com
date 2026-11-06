/**
 * tests/concat-bundles-2026-11-04.test.js — Phase 2b: joining lazy ScriptLoader bundles at deploy time
 * (scripts/concat-shipped.js --bundles; script-loader.js reads window.__NBD_JOINED_BUNDLES). SWITCHED OFF: no workflow
 * passes --bundles yet.
 *
 * 1. Planner (fixture): the bundle list is read by running the real-shaped loader in a sandbox; a file shared by two
 *    bundles, a file that is also a page tag, and every CSS entry stay as their own steps (breaking the run); runs of
 *    2+ joinable JS become one segment; a run with a duplicate top-level name is kept separate, never joined.
 * 2. Loader runtime (the REAL script-loader.js in a vm, fake DOM):
 *    - with a map, loadBundle injects the joined file (not its parts), marks the parts loaded, isLoaded() is true, and
 *      a later load(part) injects nothing;
 *    - a direct load(part) while the joined file is still downloading waits for it (no second copy);
 *    - a part already loaded beforehand → the per-file path (the joined file is never used, nothing runs twice);
 *    - the joined file failing → its parts load one by one, in order;
 *    - no map → exactly the old per-file behaviour.
 * 3. The real tree: --check --bundles plans at least 15 segments and refuses nothing; no workflow passes --bundles.
 *
 * Zero deps. Run: node tests/concat-bundles-2026-11-04.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const C = require('../scripts/concat-shipped.js');
const LOADER = fs.readFileSync(path.join(ROOT, 'docs/pro/js/script-loader.js'), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

console.log('\n1. planner (fixture)');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundles-'));
  const w = (rel, text) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  w('docs/pro/explore/demo-sw.js', "const EMPTY_SCRIPTS = new Set([]);\nconst SWAPS = new Map([]);\n");
  w('docs/pro/js/script-loader.js', `(function(){ const BUNDLES = {
    one: ['js/a.js?v=1', 'js/b.js', 'css/x.css', 'js/c.js', 'js/d.js', 'js/shared.js', 'js/e.js'],
    two: ['js/shared.js', 'js/f.js', 'js/g.js'],
    dup: ['js/h.js', 'js/i.js'],
    paged: ['js/onpage.js', 'js/j.js'] };
  window.ScriptLoader = { bundles: BUNDLES }; })();`);
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'j', 'shared', 'onpage']) w(`docs/pro/js/${f}.js`, `(function(){ window.${f.toUpperCase()} = 1; })();`);
  w('docs/pro/js/h.js', 'function same(){}');
  w('docs/pro/js/i.js', 'function same(){}');
  w('docs/pro/css/x.css', '.x{}');
  const pageTags = [{ src: 'js/onpage.js' }];
  const bp = C.planBundles(dir, pageTags);
  const segs = bp.segments.map((s) => s.bundle + ':' + s.keys.join(','));
  ok('POSITIVE CONTROL: runs of 2+ joinable files become segments', segs.includes('one:js/a.js,js/b.js') && segs.includes('one:js/c.js,js/d.js') && segs.includes('two:js/f.js,js/g.js'), segs.join(' | '));
  ok('a CSS entry breaks the run (a,b | css | c,d)', segs.filter((s) => s.startsWith('one:')).length === 2);
  ok('a file shared by two bundles is never joined', !segs.some((s) => /shared\.js/.test(s)));
  ok('a lone joinable file between breakers stays a plain step (e)', bp.plans.one.steps.includes('js/e.js'));
  ok('a file that is also a page tag breaks the run (paged: nothing to join)', !bp.plans.paged && !segs.some((s) => s.startsWith('paged:')));
  ok('a run with a duplicate top-level name is kept separate, not joined', !bp.plans.dup && bp.skipped.some((s) => /^dup: kept separate/.test(s)), bp.skipped.join(' | '));
  ok('steps keep the bundle order', JSON.stringify(bp.plans.one.steps.map((s) => (typeof s === 'object' ? 'SEG' : s))) === JSON.stringify(['SEG', 'css/x.css', 'SEG', 'js/shared.js', 'js/e.js']));
}

console.log('\n2. loader runtime (real script-loader.js, fake DOM)');
function env(map, opts = {}) {
  const appended = [];
  const document = {
    baseURI: 'https://nobigdealwithjoedeal.com/pro/dashboard',
    createElement: (tag) => ({ tagName: tag.toUpperCase(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'src' ? this.src : this.href; } }),
    head: { appendChild(e) { appended.push(e); } },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const window = { __NBD_JOINED_BUNDLES: map, document };
  window.window = window;
  const ctx = vm.createContext({ window, document, console: { warn() {}, log() {} }, URL, setTimeout, clearTimeout, Promise });
  vm.runInContext(LOADER, ctx);
  const fire = async () => {
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setImmediate(r));
      const e = appended.find((x) => !x._done && (x.tagName === 'SCRIPT' || x.rel === 'stylesheet'));
      if (!e) { if (i > 8) break; continue; }
      e._done = true;
      const fail = opts.failing && (e.src || '').includes(opts.failing);
      if (fail) { if (e.onerror) e.onerror(); } else if (e.onload) e.onload();
    }
  };
  const scripts = () => appended.filter((e) => e.tagName === 'SCRIPT').map((e) => e.src);
  return { SL: window.ScriptLoader, scripts, fire };
}
(async () => {
  const B = 'callcenter';
  const parts = env(null).SL.bundles[B].filter((s) => /\.js/.test(s));
  ok(`fixture bundle "${B}" has 2+ JS parts`, parts.length >= 2, String(parts.length));
  const JOINED = 'js/_bundle-callcenter-1-abc.js';
  const map = { [B]: { steps: [JOINED], parts: { [JOINED]: parts } } };

  { // joined path
    const e = env(map);
    const p = e.SL.loadBundle(B); await e.fire(); await p;
    ok('POSITIVE CONTROL: with a map, only the joined file is injected', JSON.stringify(e.scripts()) === JSON.stringify([JOINED]), e.scripts().join(','));
    ok('…the parts are marked loaded (isLoaded true)', e.SL.isLoaded(B) && parts.every((s) => e.SL.isLoaded(s)));
    const q = e.SL.load(parts[0]); await e.fire(); await q;
    ok('…and a later load(part) injects nothing', e.scripts().length === 1);
  }
  { // load(part) while the joined file is downloading
    const e = env(map);
    const p = e.SL.loadBundle(B);
    const q = e.SL.load(parts[1]);
    await e.fire(); await p; await q;
    ok('a direct load(part) during the joined download waits for it (no second copy)', JSON.stringify(e.scripts()) === JSON.stringify([JOINED]), e.scripts().join(','));
  }
  { // a part already loaded → per-file path, joined file unused
    const e = env(map);
    const a = e.SL.load(parts[0]); await e.fire(); await a;
    const p = e.SL.loadBundle(B); await e.fire(); await p;
    ok('a part loaded beforehand → the joined file is never used (nothing runs twice)', !e.scripts().includes(JOINED) && new Set(e.scripts()).size === e.scripts().length && e.SL.isLoaded(B), e.scripts().join(','));
  }
  { // joined file fails → parts in order
    const e = env(map, { failing: '_bundle-callcenter' });
    const p = e.SL.loadBundle(B); await e.fire(); await p;
    ok('the joined file failing → its parts load one by one, in order', JSON.stringify(e.scripts()) === JSON.stringify([JOINED, ...parts]), e.scripts().join(','));
    ok('…and the bundle ends up loaded', e.SL.isLoaded(B));
  }
  { // no map → old behaviour
    const e = env(undefined);
    const p = e.SL.loadBundle(B); await e.fire(); await p;
    ok('no map → the per-file path, unchanged', JSON.stringify(e.scripts()) === JSON.stringify(parts), e.scripts().join(','));
  }

  console.log('\n3. the real tree');
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/concat-shipped.js'), '--check', '--bundles', '--json'], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))); } catch (e) {}
    ok('--check --bundles plans 15+ joined segments and refuses nothing', r.status === 0 && j && j.bundles && j.bundles.joined.length >= 15, (r.stderr || '').slice(0, 300) + (j ? ' segments=' + (j.bundles && j.bundles.joined.length) : ''));
    const wf = ['.github/workflows/firebase-deploy.yml', '.github/workflows/ci.yml'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    ok('switched off: no workflow passes --bundles yet', !/concat-shipped\.js[^\n]*--bundles/.test(wf));
  }

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(', ')); process.exit(1); }
  process.exit(0);
})();
