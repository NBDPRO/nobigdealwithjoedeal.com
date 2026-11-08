/**
 * tests/lazy-onboarding-tour-2026-11-08.test.js — the first-run tour
 * (js/onboarding-tour.js) leaves the dashboard's boot path (boot-weight lane,
 * 2026-11-08).
 *
 * Before: an eager <script defer> on every dashboard boot, although on almost
 * every boot the file defined window.OnboardingTour and returned (the rep had
 * finished or skipped the tour). After: the lazy ScriptLoader bundle 'tour',
 * registered at runtime by dashboard-actions.js (script-loader.js is blocking
 * and at its byte ceiling), fetched at boot only when the tour can fire, and
 * by Settings → Help → "▶ Start Tour" on demand. Pins:
 *   - the REAL openers IIFE from dashboard-actions.js, run in a vm: a first-run
 *     rep or how-to.html's one-shot force flag loads the bundle at boot, once;
 *     a returning rep loads nothing; a throwing localStorage or no ScriptLoader
 *     throws nothing; the guard never consumes the force flag;
 *   - the boot guard fetches in exactly the localStorage states in which the
 *     REAL onboarding-tour.js would go on to do anything (its maybeAutoStart);
 *   - restartOnboardingTour loads the bundle, then starts the tour; a failed
 *     fetch toasts instead of throwing;
 *   - on the REAL script-loader.js: the bundle is registered there at runtime,
 *     injects js/onboarding-tour.js, and the tour runs when it lands after
 *     parse (readyState 'complete'): the forced and zero-leads paths start;
 *   - dashboard.html has no eager tag for it; the Start Tour button and the
 *     tour file's public API are unchanged.
 *
 * Run: node tests/lazy-onboarding-tour-2026-11-08.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '  -- ' + String(detail).slice(0, 300) : '')); }
}

const ACTIONS = read('docs/pro/js/dashboard-actions.js');
const TOUR = read('docs/pro/js/onboarding-tour.js');
const LOADER = read('docs/pro/js/script-loader.js');
const DONE = 'nbd-onboarding-complete';
const FORCE = 'nbd-tour-force';

// The one-off openers IIFE (Globals Tranche 2c-4c) that holds restartOnboardingTour:
// only declarations and the registry Object.assign run when it runs, so it runs as is.
const at = ACTIONS.indexOf('\nfunction restartOnboardingTour()');
const iifeStart = ACTIONS.lastIndexOf('\n(function () {\n', at);
const iifeEnd = ACTIONS.indexOf('\n})();\n', at);
const OPENERS = at > 0 && iifeStart > 0 && iifeEnd > at ? ACTIONS.slice(iifeStart + 1, iifeEnd + 6) : '';
ok('control: the openers IIFE holding restartOnboardingTour is found in dashboard-actions.js', /restartOnboardingTour: restartOnboardingTour/.test(OPENERS), OPENERS.length);

function makeStorage(init, throws) {
  const m = new Map(Object.entries(init || {}));
  const boom = () => { throw new Error('SecurityError: storage blocked'); };
  return throws
    ? { getItem: boom, setItem: boom, removeItem: boom, m }
    : { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); }, m };
}

// ── a window with a fake ScriptLoader ──────────────────────────────────────
function runOpeners(opts) {
  opts = opts || {};
  const loads = [];
  const toasts = [];
  const w = { loads, toasts };
  if (opts.loader !== false) {
    w.ScriptLoader = {
      bundles: {},
      loadBundle(name) {
        loads.push(name);
        if (opts.throwOnLoad) throw new Error('boom');
        if (typeof opts.onLoad === 'function') opts.onLoad(w);
        return Promise.resolve();
      },
    };
  }
  if (opts.tour) w.OnboardingTour = opts.tour;
  const ls = opts.storage || makeStorage(opts.ls, opts.throws);
  const ctx = { window: w, localStorage: ls, console, showToast: (m, t) => toasts.push([m, t]) };
  vm.createContext(ctx);
  vm.runInContext(OPENERS, ctx, { filename: 'dashboard-actions.js (openers IIFE)' });
  return { w, ls, loads, toasts, restart: w.__NBD_CALL_REGISTRY && w.__NBD_CALL_REGISTRY.restartOnboardingTour };
}
const tick = () => new Promise((r) => setImmediate(r));

console.log('\nTOUR: the boot guard in dashboard-actions.js');
{
  const r = runOpeners({ ls: {} });
  ok('first-run rep (no completion flag): the tour bundle loads at boot', r.loads.join() === 'tour', r.loads);
  ok('…it is registered at runtime as the one tour file, page-relative like the other bundles',
    JSON.stringify(r.w.ScriptLoader.bundles.tour) === JSON.stringify(['js/onboarding-tour.js?v=4']), JSON.stringify(r.w.ScriptLoader.bundles.tour));
}
{
  const r = runOpeners({ ls: { [DONE]: '1' } });
  ok('returning rep (completion flag "1", no force flag): nothing is fetched at boot', r.loads.length === 0, r.loads);
  ok('…the bundle is still registered (Start Tour loads it by name)', Array.isArray(r.w.ScriptLoader.bundles.tour));
}
{
  const r = runOpeners({ ls: { [DONE]: '1', [FORCE]: '1' } });
  ok('how-to.html "▶ Restart Tour" force flag: loads at boot even with the completion flag set', r.loads.join() === 'tour', r.loads);
  ok('…and the guard leaves the one-shot force flag for onboarding-tour.js to consume', r.ls.m.get(FORCE) === '1' && r.ls.m.get(DONE) === '1');
}
{
  const r = runOpeners({ ls: { [DONE]: '0' } });
  ok('a completion flag that is not "1" counts as not complete (as the tour reads it)', r.loads.join() === 'tour', r.loads);
}
{
  let threw = null;
  let r = null;
  try { r = runOpeners({ throws: true }); } catch (e) { threw = e; }
  ok('localStorage throws (private mode / blocked): nothing loads and nothing throws', !threw && r && r.loads.length === 0, threw || (r && r.loads));
}
{
  let threw = null;
  try { runOpeners({ loader: false, ls: {} }); } catch (e) { threw = e; }
  ok('no ScriptLoader on the page: nothing throws', !threw, threw);
  let threw2 = null;
  try { runOpeners({ throwOnLoad: true, ls: {} }); } catch (e) { threw2 = e; }
  ok('a loadBundle that throws at boot does not break the rest of dashboard-actions.js', !threw2, threw2);
}
{
  const r = runOpeners({ ls: {} });
  ok('restartOnboardingTour is still the registered Start Tour handler', typeof r.restart === 'function');
}

console.log('\nTOUR: the boot guard fetches exactly when the real tour would act');
{
  // The REAL onboarding-tour.js, run late (readyState 'complete', as a lazy load lands):
  // "acts" = its maybeAutoStart went past the early return and started the leads poll.
  function tourActs(storage) {
    let polls = 0;
    const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, getElementById: () => null };
    const ctx = { window: {}, document: doc, localStorage: storage, console, setInterval: () => { polls++; return polls; }, clearInterval() {}, setTimeout() {} };
    vm.createContext(ctx);
    vm.runInContext(TOUR, ctx, { filename: 'onboarding-tour.js' });
    return polls > 0;
  }
  const vals = [undefined, '1', '0'];
  const states = [];
  vals.forEach((d) => vals.forEach((f) => {
    const s = {};
    if (d !== undefined) s[DONE] = d;
    if (f !== undefined) s[FORCE] = f;
    states.push(s);
  }));
  const mismatch = [];
  states.forEach((s) => {
    const guard = runOpeners({ ls: s }).loads.length > 0;
    const acts = tourActs(makeStorage(s));
    if (guard !== acts) mismatch.push(JSON.stringify(s) + ' guard=' + guard + ' tour=' + acts);
  });
  const thr = runOpeners({ throws: true }).loads.length > 0;
  if (thr !== tourActs(makeStorage({}, true))) mismatch.push('throwing storage guard=' + thr);
  ok('over every completion × force state (and a throwing storage) the guard loads iff the tour would act (' + (states.length + 1) + ' states)', mismatch.length === 0, mismatch.join('; '));
}

console.log('\nTOUR: Settings → Help → "▶ Start Tour" (restartOnboardingTour)');
(async function () {
  {
    let restarts = 0;
    const r = runOpeners({ ls: { [DONE]: '1' }, tour: { forceRestart() { restarts++; } } });
    r.restart();
    ok('tour already loaded: it restarts at once, no fetch', restarts === 1 && r.loads.length === 0, r.loads);
  }
  {
    let restarts = 0;
    const r = runOpeners({ ls: { [DONE]: '1' }, onLoad: (w) => { w.OnboardingTour = { forceRestart() { restarts++; } }; } });
    r.restart();
    ok('not loaded yet: the click loads the tour bundle', r.loads.join() === 'tour', r.loads);
    ok('…and starts nothing until that load has resolved', restarts === 0);
    await tick();
    ok('…then starts the tour once the bundle has landed', restarts === 1 && r.toasts.length === 0, JSON.stringify(r.toasts));
  }
  {
    const r = runOpeners({ ls: { [DONE]: '1' } });
    let threw = null;
    try { r.restart(); await tick(); } catch (e) { threw = e; }
    ok('the fetch fails (loadBundle resolves, no OnboardingTour): a toast, no throw', !threw && r.toasts.length === 1 && r.toasts[0][1] === 'error', threw || JSON.stringify(r.toasts));
  }
  {
    const r = runOpeners({ loader: false, ls: { [DONE]: '1' } });
    r.restart();
    ok('no ScriptLoader: the existing toast fallback', r.toasts.length === 1, JSON.stringify(r.toasts));
  }

  console.log('\nTOUR: on the real script-loader.js, and the real tour landing late');
  {
    function realPage(ls, leads) {
      const appended = [];
      const doc = {
        readyState: 'complete', baseURI: 'https://x.test/pro/dashboard',
        querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
        createElement: (tag) => ({ tagName: String(tag).toUpperCase(), style: {} }),
        head: { appendChild(el) { appended.push(el); return el; } },
        body: { appendChild(el) { appended.push(el); return el; } },
        addEventListener() {}, removeEventListener() {},
      };
      const timers = [];
      const frames = [];
      const w = { addEventListener() {}, removeEventListener() {}, document: doc, _leadsLoaded: true, _leads: leads || [] };
      const ctx = {
        window: w, document: doc, localStorage: ls, console, URL,
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        setInterval: (fn, ms) => { timers.push({ fn, ms, every: true }); return timers.length; },
        clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
        requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; },
        showToast() {},
      };
      vm.createContext(ctx);
      vm.runInContext(LOADER, ctx, { filename: 'script-loader.js' });
      const before = ctx.window.ScriptLoader ? Object.keys(ctx.window.ScriptLoader.bundles).length : -1;
      const tourBefore = !!(ctx.window.ScriptLoader && ctx.window.ScriptLoader.bundles.tour);
      vm.runInContext(OPENERS, ctx, { filename: 'dashboard-actions.js (openers IIFE)' });
      const scripts = () => appended.filter((el) => el.tagName === 'SCRIPT').map((el) => el.src);
      // Land the injected tour file: run it in the page, then fire its onload.
      const land = () => {
        const el = appended.find((e) => e.tagName === 'SCRIPT' && /onboarding-tour\.js/.test(e.src));
        if (!el) return false;
        vm.runInContext(TOUR, ctx, { filename: 'onboarding-tour.js' });
        if (typeof el.onload === 'function') el.onload();
        return true;
      };
      const runTimers = () => { for (let i = 0; i < timers.length; i++) { const t = timers[i]; if (!t.cleared && !t.ran) { if (!t.every) t.ran = true; t.fn(); } } };
      return { ctx, w, ls, before, tourBefore, appended, scripts, land, timers, frames, runTimers };
    }

    const p0 = realPage(makeStorage({}));
    await tick(); // the real loadBundle injects inside its promise chain
    ok('control: script-loader.js itself has no tour bundle (it is a blocking script at its byte ceiling)', p0.before > 0 && !p0.tourBefore);
    ok('control: script-loader.js is untouched by this lane (no onboarding-tour entry)', !/onboarding-tour/.test(LOADER));
    ok('dashboard-actions.js adds exactly one bundle, tour, to the real ScriptLoader', Object.keys(p0.w.ScriptLoader.bundles).length === p0.before + 1 && !!p0.w.ScriptLoader.bundles.tour);
    ok('first-run boot: the real loader injects js/onboarding-tour.js?v=4', p0.scripts().join() === 'js/onboarding-tour.js?v=4', p0.scripts());

    // Zero leads, no flags: the tour lands after parse and still starts (1.5 s breath).
    ok('…it lands', p0.land());
    p0.runTimers(); // the leads poll: _leadsLoaded is already true
    const breath = p0.timers.find((t) => t.ms === 1500);
    ok('…a zero-leads first-run rep: the late tour sees leads already loaded and schedules its start', !!breath, p0.timers.map((t) => t.ms));
    p0.runTimers();
    ok('…and starts: styles injected and the first step queued for the next frame',
      p0.appended.some((el) => el.tagName === 'STYLE' && el.id === 'nbd-onb-css') && p0.frames.length >= 1);

    // how-to.html's Restart Tour: force flag, the rep HAS leads, completion flag cleared by how-to.js.
    const p1 = realPage(makeStorage({ [FORCE]: '1' }), [{ id: 'a' }]);
    await tick();
    ok('forced boot (how-to.html Restart Tour): the real loader injects the tour', p1.scripts().join() === 'js/onboarding-tour.js?v=4', p1.scripts());
    p1.land();
    ok('…the tour consumes the one-shot force flag', p1.ls.m.get(FORCE) === undefined);
    p1.runTimers();
    ok('…and, leads or not, schedules the forced start (500 ms)', p1.timers.some((t) => t.ms === 500), p1.timers.map((t) => t.ms));
    p1.runTimers();
    ok('…which runs', p1.appended.some((el) => el.tagName === 'STYLE' && el.id === 'nbd-onb-css'));

    // A rep with leads and no flags: the tour marks itself complete, so the next boot fetches nothing.
    const p2 = realPage(makeStorage({}), [{ id: 'a' }]);
    await tick();
    p2.land();
    p2.runTimers();
    ok('first boot of a rep who already has leads: the tour writes the completion flag and does not start',
      p2.ls.m.get(DONE) === '1' && !p2.appended.some((el) => el.tagName === 'STYLE'));
    const p2b = realPage(p2.ls, [{ id: 'a' }]);
    await tick();
    ok('…so the next boot fetches nothing', p2b.scripts().length === 0, p2b.scripts());

    // Returning rep: nothing at boot; Start Tour fetches, lands, then restarts.
    const p3 = realPage(makeStorage({ [DONE]: '1' }), [{ id: 'a' }]);
    await tick();
    ok('returning rep: the real loader injects nothing at boot', p3.scripts().length === 0, p3.scripts());
    p3.w.__NBD_CALL_REGISTRY.restartOnboardingTour();
    await tick();
    ok('…Start Tour injects js/onboarding-tour.js?v=4', p3.scripts().join() === 'js/onboarding-tour.js?v=4', p3.scripts());
    ok('…which lands', p3.land());
    await tick();
    ok('…and the tour restarts (completion flag cleared, styles injected)',
      p3.ls.m.get(DONE) === undefined && p3.appended.some((el) => el.tagName === 'STYLE' && el.id === 'nbd-onb-css'));
    p3.w.__NBD_CALL_REGISTRY.restartOnboardingTour();
    await tick();
    ok('…a second Start Tour reuses it (no second fetch)', p3.scripts().length === 1, p3.scripts());
  }

  console.log('\nTOUR: dashboard.html and the tour file');
  {
    const dash = read('docs/pro/dashboard.html');
    ok('no eager <script> tag for onboarding-tour.js any more', !/<script[^>]*src="[^"]*onboarding-tour\.js/.test(dash));
    const sl = dash.indexOf('<script src="js/script-loader.js');
    const da = dash.search(/<script defer src="js\/dashboard-actions\.js\?v=\d+"><\/script>/);
    ok('dashboard-actions.js (the registrar) is a deferred tag after the blocking script-loader.js', sl > 0 && da > sl);
    const v = (/js\/dashboard-actions\.js\?v=(\d+)/.exec(dash) || [])[1];
    ok('dashboard-actions.js cache-buster bumped for the change (v >= 20)', Number(v) >= 20, v);
    ok('the Settings → Help "▶ Start Tour" button still dispatches restartOnboardingTour',
      /<button[^>]*data-action="call"[^>]*data-fn="restartOnboardingTour"[^>]*>▶ Start Tour<\/button>/.test(dash));
    ok('the tour file keeps its public API (start / stop / forceRestart)',
      /window\.OnboardingTour = \{\s*start,\s*stop: complete,\s*forceRestart/.test(TOUR));
    ok('the tour still tolerates a late load (runs maybeAutoStart at once when the DOM is parsed)',
      /if \(document\.readyState === 'loading'\) \{[\s\S]{0,120}\} else \{\s*maybeAutoStart\(\);/.test(TOUR));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-onboarding-tour-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
