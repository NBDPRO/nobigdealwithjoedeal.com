/**
 * tests/lazy-schedule-planner-2026-11-08.test.js — Plan Jobs (js/schedule-planner.js)
 * loads on the first Schedule visit, not on every dashboard boot (boot-weight
 * lane, 2026-11-08).
 *
 * Before: an eager <script defer> on every boot (26 KB readable), though the
 * planner only paints #schedPlanPanel, which lives in <template
 * id="tpl-view-schedule"> and exists only after goTo('schedule') stamps it.
 * After: production.js (deferred, already the Schedule view's other half)
 * registers ScriptLoader bundle 'schedule' and view 'schedule' at runtime, so
 * goTo('schedule') → ScriptLoader.preloadForView('schedule') fetches it; the
 * planner renders itself on arrival. Pins:
 *   - the REAL production.js registers both on the REAL script-loader.js, and
 *     preloadForView('schedule') then injects the planner (views and bundles
 *     are the live maps the loader reads), once; no other view does; a failed
 *     fetch resolves (never rejects) and the next visit retries;
 *   - no ScriptLoader / an earlier registration: nothing throws, nothing is
 *     overwritten;
 *   - the REAL planner, arriving after load on #/schedule, renders the panel
 *     itself (also when the leads land later), and does nothing elsewhere;
 *   - every other reader of NBDSchedulePlannerUI is typeof-guarded;
 *   - dashboard.html has no planner tag; its rules, production-logic.js and
 *     production.js stay eager; goTo stamps the template before it preloads.
 *
 * Run: node tests/lazy-schedule-planner-2026-11-08.test.js
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
const tick = () => new Promise((r) => setImmediate(r));
const quiet = { log: console.log, error: console.error, warn() {} }; // the loader warns on the failed-fetch case below

const LOADER = read('docs/pro/js/script-loader.js');
const PROD = read('docs/pro/js/production.js');
const PLANNER = read('docs/pro/js/schedule-planner.js');

// ── the REAL script-loader.js (+ production.js) in a vm with a fake head ─────
function page(opts) {
  opts = opts || {};
  const head = [];
  const document = {
    readyState: 'complete', baseURI: 'https://x.test/pro/dashboard.html',
    addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), dataset: {}, setAttribute() {} }),
    head: { appendChild(el) { head.push(el); } },
  };
  const window = { addEventListener() {}, document };
  const ctx = { window, document, location: { hash: opts.hash || '', search: '' }, console: quiet, setTimeout: () => 0, clearTimeout() {}, URL, Promise };
  vm.createContext(ctx);
  if (opts.loader !== false) vm.runInContext(LOADER, ctx, { filename: 'script-loader.js' });
  if (opts.before) opts.before(window);
  vm.runInContext(PROD, ctx, { filename: 'production.js' });
  const scripts = () => head.filter((el) => el.tagName === 'SCRIPT');
  return { ctx, window, head, scripts };
}
const plannerTags = (p) => p.scripts().filter((el) => /(^|\/)js\/schedule-planner\.js(\?|$)/.test(el.src));

console.log('\nLAZY PLAN JOBS: registration on the real script-loader.js');
{
  const bare = page();
  const ctrl = { window: { addEventListener() {} }, document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), head: { appendChild() {} }, baseURI: 'https://x.test/pro/' }, console, setTimeout, URL };
  ctrl.window.document = ctrl.document;
  vm.createContext(ctrl);
  vm.runInContext(LOADER, ctrl, { filename: 'script-loader.js' });
  ok('control: script-loader.js itself has no schedule bundle or view (blocking, at its byte ceiling)', !ctrl.window.ScriptLoader.bundles.schedule && !ctrl.window.ScriptLoader.views.schedule);
  const SL = bare.window.ScriptLoader;
  const B = (SL && SL.bundles && SL.bundles.schedule) || [];
  ok('production.js registers bundle "schedule" = exactly the planner', B.length === 1 && /^js\/schedule-planner\.js\?v=\d+$/.test(B[0]), JSON.stringify(B));
  ok('…and view "schedule" → that bundle', !!SL.views.schedule && SL.views.schedule.join() === 'schedule', JSON.stringify(SL.views.schedule));
  ok('the registered planner file exists on disk', B.length === 1 && fs.existsSync(path.join(ROOT, 'docs/pro', B[0].split('?')[0])));
  ok('production.js still exposes NBDProduction', !!bare.window.NBDProduction && typeof bare.window.NBDProduction.rowExtrasHtml === 'function');
  ok('registering fetches nothing (no planner tag at boot)', plannerTags(bare).length === 0, bare.head.length);
}
(async () => {
  {
    const p = page();
    const SL = p.window.ScriptLoader;
    ['home', 'dash', 'crm', 'est', 'settings', 'calls'].forEach((v) => { SL.preloadForView(v); });
    await tick(); await tick();
    ok('no other view (home, dash, crm, est, settings, calls) loads the planner', plannerTags(p).length === 0, p.scripts().map((s) => s.src));
    let resolved = false;
    SL.preloadForView('schedule').then(() => { resolved = true; });
    await tick(); await tick();
    const tags = plannerTags(p);
    ok('goTo(\'schedule\') → preloadForView injects the planner, once, in order (async=false)', tags.length === 1 && tags[0].async === false, p.scripts().map((s) => s.src));
    ok('…from the registered entry (views/bundles are the live maps the loader reads)', tags.length === 1 && tags[0].src === SL.bundles.schedule[0]);
    if (tags[0] && tags[0].onload) tags[0].onload();
    await tick(); await tick();
    ok('the preload resolves once the planner has run', resolved === true);
    ok('ScriptLoader.isLoaded(\'schedule\') is true after it arrived', SL.isLoaded('schedule') === true);
    SL.preloadForView('schedule');
    await tick(); await tick();
    ok('a second Schedule visit fetches nothing', plannerTags(p).length === 1);
  }
  {
    const p = page();
    const SL = p.window.ScriptLoader;
    let settled = 'no';
    SL.preloadForView('schedule').then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
    await tick(); await tick();
    const t = plannerTags(p)[0];
    if (t && t.onerror) t.onerror();
    await tick(); await tick();
    ok('a failed planner fetch resolves, never rejects (goTo and the view carry on)', settled === 'resolved', settled);
    ok('…the planner is not marked loaded', SL.isLoaded('schedule') === false);
    SL.preloadForView('schedule');
    await tick(); await tick();
    ok('…and the next Schedule visit tries again', plannerTags(p).length === 2, plannerTags(p).length);
  }
  {
    let threw = null, p = null;
    try { p = page({ loader: false }); } catch (e) { threw = e; }
    ok('no ScriptLoader on the page: production.js runs, throws nothing, still exposes NBDProduction', !threw && !!p.window.NBDProduction, threw && threw.message);
    let threw2 = null;
    try { page({ loader: false, before: (w) => { w.ScriptLoader = { load() {} }; } }); } catch (e) { threw2 = e; }
    ok('a ScriptLoader with no bundles/views maps: nothing throws', !threw2, threw2 && threw2.message);
    const keep = page({ before: (w) => { w.ScriptLoader.bundles.schedule = ['js/other.js?v=1']; w.ScriptLoader.views.schedule = ['other']; } });
    ok('an earlier registration is never overwritten', keep.window.ScriptLoader.bundles.schedule.join() === 'js/other.js?v=1' && keep.window.ScriptLoader.views.schedule.join() === 'other');
    const twice = page();
    const before = JSON.stringify([twice.window.ScriptLoader.bundles.schedule, twice.window.ScriptLoader.views.schedule]);
    vm.runInContext(PROD, twice.ctx, { filename: 'production.js' });
    ok('running production.js twice changes nothing (sentinel)', JSON.stringify([twice.window.ScriptLoader.bundles.schedule, twice.window.ScriptLoader.views.schedule]) === before);
  }

  // ── the REAL planner, arriving after load ──────────────────────────────────
  console.log('\nLAZY PLAN JOBS: the planner renders itself on arrival');
  const P = require(path.join(ROOT, 'docs/pro/js/schedule-planner-logic.js'));
  function arrive(opts) {
    const timers = [];
    const loads = [];
    const els = opts.panel === false ? {} : { schedPlanPanel: { hidden: true }, schedPlanBody: { innerHTML: '' } };
    const document = {
      readyState: opts.readyState || 'complete',
      addEventListener() {}, getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [],
    };
    const win = {
      NBDSchedulePlanner: P, _userClaims: { role: opts.role || 'company_admin' }, _leads: opts.leads,
      ScriptLoader: { load(src) { loads.push(src); return Promise.resolve(); } },
      addEventListener() {},
    };
    const ctx = { window: win, document, location: { hash: opts.hash, search: '' }, console, CSS: undefined,
      setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {} };
    win.document = document;
    vm.createContext(ctx);
    vm.runInContext(PLANNER, ctx, { filename: 'schedule-planner.js' });
    const flush = (n) => { for (let i = 0; i < (n || 5) && timers.length; i++) timers.shift()(); };
    return { win, els, loads, flush, timers };
  }
  const lead = { id: 'L1', stage: 'contract_signed', firstName: 'ZZ_QA', lastName: 'Lazy', address: '1 Test St' };
  {
    const a = arrive({ hash: '#/schedule', leads: [lead] });
    ok('arriving on #/schedule after load: it starts its render wait at once (readyState is not "loading")', a.timers.length === 1);
    ok('…and lazy-loads the Calendar panel, as before', a.loads.indexOf('/pro/js/schedule-calendar-panel.js?v=1') >= 0, a.loads);
    a.flush(1);
    ok('…then paints Plan Jobs into the stamped template (panel shown, the job listed)', a.els.schedPlanPanel.hidden === false && /Needs a date/.test(a.els.schedPlanBody.innerHTML) && /data-id="L1"/.test(a.els.schedPlanBody.innerHTML), a.els.schedPlanBody.innerHTML.slice(0, 120));
    ok('the global is exposed for the guarded callers (production.js, layouts/crew.js)', !!a.win.NBDSchedulePlannerUI && typeof a.win.NBDSchedulePlannerUI.render === 'function');
  }
  {
    const a = arrive({ hash: '#/schedule', leads: undefined });
    a.flush(3);
    ok('a deep link where the planner beats the leads: it keeps waiting, paints nothing yet', a.els.schedPlanBody.innerHTML === '' && a.timers.length === 1);
    a.win._leads = [lead];
    a.flush(1);
    ok('…and paints once the leads land', /data-id="L1"/.test(a.els.schedPlanBody.innerHTML));
  }
  {
    const a = arrive({ hash: '#/crm', leads: [lead] });
    a.flush(5);
    ok('arriving after the rep already left Schedule: no render, no Calendar panel fetch', a.timers.length === 0 && a.loads.length === 0 && a.els.schedPlanBody.innerHTML === '');
  }
  {
    const a = arrive({ hash: '#/schedule', leads: [lead], role: 'viewer' });
    a.flush(1);
    ok('viewers: the panel stays hidden, unchanged', a.els.schedPlanPanel.hidden === true && a.els.schedPlanBody.innerHTML === '');
  }
  ok('the planner keeps its sentinel (a second load is harmless)', /\(function \(\) \{\s*'use strict';\s*if \(window\.NBDSchedulePlannerUI\) return;/.test(PLANNER));

  // ── every other reader stays guarded ───────────────────────────────────────
  console.log('\nLAZY PLAN JOBS: every reader of NBDSchedulePlannerUI is guarded');
  {
    const files = [];
    const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach((d) => {
      const rel = dir + '/' + d.name;
      if (d.isDirectory()) { if (!/vendor|node_modules/.test(d.name)) walk(rel); } else if (/\.(js|mjs|html)$/.test(d.name)) files.push(rel);
    });
    walk('docs/pro');
    const hits = [];
    files.filter((f) => f !== 'docs/pro/js/schedule-planner.js').forEach((f) => {
      read(f).split('\n').forEach((line, i) => { if (/NBDSchedulePlannerUI/.test(line)) hits.push([f + ':' + (i + 1), line]); });
    });
    ok('readers found (production.js ×2, layouts/crew.js)', hits.length >= 3, hits.map((h) => h[0]));
    const unguarded = hits.filter(([, line]) => !/NBDSchedulePlannerUI && typeof \w+\.NBDSchedulePlannerUI\.render === 'function'/.test(line));
    ok('each one checks the global and typeof render before calling it (absent until the first Schedule visit)', unguarded.length === 0, unguarded.map((h) => h[0]));
  }

  // ── the page ───────────────────────────────────────────────────────────────
  console.log('\nLAZY PLAN JOBS: dashboard.html');
  {
    const dash = read('docs/pro/dashboard.html');
    const live = dash.replace(/<!--[\s\S]*?-->/g, '');
    ok('no planner <script> tag on the dashboard any more', !/<script\b[^>]*schedule-planner\.js/.test(live));
    const tag = (n) => live.indexOf('<script defer src="js/' + n);
    const iW = tag('schedule-window.js'), iL = tag('schedule-planner-logic.js'), iPL = tag('production-logic.js'), iP = tag('production.js');
    ok('schedule-window, the planner rules, production-logic and production.js stay eager, in that order', iW > 0 && iL > iW && iPL > iL && iP > iPL, [iW, iL, iPL, iP].join());
    ok('production.js comes after the BLOCKING script-loader.js (the registration needs it)', /<script src="js\/script-loader\.js\?v=\d+"><\/script>/.test(live) && live.indexOf('js/script-loader.js') < iP);
    const tpl = dash.slice(dash.indexOf('<template id="tpl-view-schedule">'), dash.indexOf('</template>', dash.indexOf('<template id="tpl-view-schedule">')));
    ok('#schedPlanPanel / #schedPlanBody exist only inside the Schedule template (stamped by goTo)', /id="schedPlanPanel"/.test(tpl) && /id="schedPlanBody"/.test(tpl)
      && (dash.match(/id="schedPlanPanel"/g) || []).length === 1);
    const acts = read('docs/pro/js/dashboard-actions.js');
    const go = acts.slice(acts.indexOf('function goTo(name'), acts.indexOf('function goTo(name') + 6000);
    ok('goTo stamps the template BEFORE it preloads the view, so the planner finds its panel', go.indexOf('_hydrateViewTemplate(name);') > 0 && go.indexOf('_hydrateViewTemplate(name);') < go.indexOf('preloadForView(name)'));
    const cust = read('docs/pro/customer.html');
    ok('the customer page loads only the rules, as before', !/<script\b[^>]*schedule-planner\.js/.test(cust) && /schedule-planner-logic\.js\?v=\d+/.test(cust));
    ok('production.js cache-buster bumped on both pages (v=3)', /<script defer src="js\/production\.js\?v=3"><\/script>/.test(dash) && /<script defer src="js\/production\.js\?v=3"><\/script>/.test(cust));
    ok('script-loader.js is untouched by this lane', !/schedule-planner/.test(LOADER));
    ok('this suite is in the node bucket', read('tests/ci-manifest.json').indexOf('"lazy-schedule-planner-2026-11-08.test.js"') >= 0);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
