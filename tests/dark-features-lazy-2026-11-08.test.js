/**
 * tests/dark-features-lazy-2026-11-08.test.js — the six flag-gated toolbar
 * features (stale-leads clean-up, lead-source fixer, speed to lead, reputation,
 * the estimate follow-up board and the Follow-ups board) load only when their
 * flag is on (boot-weight lane, 2026-11-08).
 *
 * Before: nine deferred <script> tags on every dashboard boot, about 100 KB
 * shipped, each polling its flag every minute. After: six ScriptLoader bundles
 * and js/dark-features.js, which loads a bundle the first time NBDFlags
 * reports its flag on. Pins:
 *   - the loader runs in a vm with fakes and loads exactly the enabled flags'
 *     bundles, once, on nbd:flags-loaded (and again for a flag turned on later);
 *   - with no ScriptLoader or no flags it does nothing and throws nothing;
 *   - the loader's flag → bundle map matches each feature file's own FLAG;
 *   - the bundles exist in the REAL script-loader.js with the load-bearing
 *     order (estimate board → logic → Follow-ups screen → Thumbtack cards);
 *   - dashboard.html carries the loader tag and none of the nine eager tags,
 *     while the hidden toolbar buttons and late stylesheets are unchanged.
 *
 * Run: node tests/dark-features-lazy-2026-11-08.test.js
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

const SRC = read('docs/pro/js/dark-features.js');
const FEATURES = {
  bulkCloseStaleLeads: ['staleleads', 'docs/pro/js/stale-leads-cleanup.js'],
  leadSourceFixer: ['leadsourcefixer', 'docs/pro/js/lead-source-fixer.js'],
  speedToLead: ['speedtolead', 'docs/pro/js/speed-to-lead.js'],
  reputationLoop: ['reputation', 'docs/pro/js/reputation.js'],
  estimateFollowBoard: ['estimatefollowboard', 'docs/pro/js/estimate-follow-board.js'],
  followUpBoard: ['followupboard', 'docs/pro/js/follow-up-board.js'],
};

// ── a window with a fake ScriptLoader and NBDFlags ──────────────────────────
function makeWindow(opts) {
  opts = opts || {};
  const listeners = {};
  const loads = [];
  const flags = Object.assign({}, opts.flags || {});
  const w = {
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatch(type) { (listeners[type] || []).forEach((fn) => fn({ type })); },
    loads, flags, listeners,
  };
  if (opts.loader !== false) {
    w.ScriptLoader = { loadBundle(name) { loads.push(name); if (opts.throwOn === name) throw new Error('boom'); return Promise.resolve(); } };
  }
  if (opts.noFlags !== true) {
    w.NBDFlags = { enabled: (n) => !!flags[n], isLoaded: () => !!opts.loaded };
  }
  return w;
}
function run(w) {
  const ctx = { window: w, console };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'dark-features.js' });
  return w;
}

console.log('\nDARK FEATURES: the loader');
{
  const w = run(makeWindow({ flags: { reputationLoop: true, speedToLead: true } }));
  ok('nothing is fetched before the flags arrive', w.loads.length === 0, w.loads);
  ok('it listens for nbd:flags-loaded', Array.isArray(w.listeners['nbd:flags-loaded']) && w.listeners['nbd:flags-loaded'].length === 1);
  w.dispatch('nbd:flags-loaded');
  ok('on nbd:flags-loaded only the enabled flags\' bundles load', w.loads.slice().sort().join() === 'reputation,speedtolead', w.loads);
  w.dispatch('nbd:flags-loaded');
  ok('a second flags load does not fetch them again', w.loads.length === 2, w.loads);
  w.flags.followUpBoard = true;
  w.dispatch('nbd:flags-loaded');
  ok('a flag turned on later loads its bundle on the next flags read', w.loads.slice(2).join() === 'followupboard', w.loads);
  ok('the API is exposed once, with the map', w.NBDDarkFeatures && w.NBDDarkFeatures.__sentinel === 'nbd-dark-features-v1' && typeof w.NBDDarkFeatures.sync === 'function' && Object.keys(w.NBDDarkFeatures.flags).length === 6);
}
{
  const w = run(makeWindow({ flags: { bulkCloseStaleLeads: true }, loaded: true }));
  ok('flags already loaded when the file runs: it syncs at once', w.loads.join() === 'staleleads', w.loads);
}
{
  const w = run(makeWindow({ flags: {}, loaded: true }));
  w.dispatch('nbd:flags-loaded');
  ok('every flag off (the default): nothing loads', w.loads.length === 0, w.loads);
}
{
  let threw = false;
  try { const w = run(makeWindow({ loader: false, flags: { reputationLoop: true }, loaded: true })); w.dispatch('nbd:flags-loaded'); } catch (e) { threw = true; }
  ok('no ScriptLoader on the page: nothing happens and nothing throws', !threw);
  let threw2 = false;
  try { const w = run(makeWindow({ noFlags: true })); w.dispatch('nbd:flags-loaded'); ok('no NBDFlags: nothing loads', w.loads.length === 0); } catch (e) { threw2 = true; }
  ok('no NBDFlags on the page: nothing throws', !threw2);
}
{
  const w = run(makeWindow({ flags: { leadSourceFixer: true, reputationLoop: true }, throwOn: 'leadsourcefixer' }));
  w.dispatch('nbd:flags-loaded');
  ok('a loadBundle that throws does not stop the other bundles', w.loads.indexOf('reputation') >= 0, w.loads);
  w.dispatch('nbd:flags-loaded');
  ok('...and that bundle is retried on the next flags read', w.loads.filter((n) => n === 'leadsourcefixer').length === 2, w.loads);
}
{
  const w = run(makeWindow({ flags: { reputationLoop: true } }));
  run(w);
  w.dispatch('nbd:flags-loaded');
  ok('running the file twice registers one listener (sentinel)', w.listeners['nbd:flags-loaded'].length === 1 && w.loads.length === 1, w.loads);
}

console.log('\nDARK FEATURES: the map matches the feature files');
{
  const map = run(makeWindow({})).NBDDarkFeatures.flags;
  Object.keys(FEATURES).forEach((flag) => {
    const [bundle, file] = FEATURES[flag];
    const code = read(file);
    const m = /var FLAG = '([A-Za-z]+)'/.exec(code);
    ok(flag + ' → ' + bundle + ': the feature file gates on that flag', m && m[1] === flag && map[flag] === bundle, m && m[1]);
  });
  const opp = read('docs/pro/js/opp-approval.js');
  ok('the Thumbtack cards keep their own second flag (thumbtackOpportunities) inside the followupboard bundle', /var FLAG = 'thumbtackOpportunities'/.test(opp));
}

console.log('\nDARK FEATURES: the bundles registered on the real script-loader.js');
{
  const ctx = { window: { addEventListener() {} }, document: { querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), head: { appendChild() {} }, baseURI: 'https://x.test/pro/' }, console, setTimeout, URL };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/script-loader.js'), ctx, { filename: 'script-loader.js' });
  const before = Object.keys(ctx.window.ScriptLoader.bundles).length;
  ok('control: script-loader.js itself does not carry the six bundles (it is a blocking script at its byte ceiling)', !ctx.window.ScriptLoader.bundles.followupboard && !ctx.window.ScriptLoader.bundles.reputation);
  vm.runInContext(SRC, ctx, { filename: 'dark-features.js' });
  const B = ctx.window.ScriptLoader && ctx.window.ScriptLoader.bundles;
  ok('dark-features.js registers exactly six bundles on the real ScriptLoader, like today-home.js registers promise', !!B && Object.keys(B).length === before + 6);
  vm.runInContext(SRC, ctx, { filename: 'dark-features.js' });
  ok('running it again adds nothing (sentinel + registered-once guard)', Object.keys(B).length === before + 6);
  const base = (s) => String(s).split('?')[0];
  Object.keys(FEATURES).forEach((flag) => {
    const [bundle, file] = FEATURES[flag];
    const list = (B && B[bundle]) || [];
    ok('bundle ' + bundle + ' holds ' + path.basename(file), list.map(base).indexOf('js/' + path.basename(file)) >= 0, list);
  });
  const fub = ((B && B.followupboard) || []).map(base);
  const order = ['js/estimate-follow-board.js', 'js/follow-up-board-logic.js', 'js/follow-up-board.js', 'js/opp-approval-logic.js', 'js/opp-approval.js'];
  ok('followupboard loads the estimate board, then the logic, then the screen, then the Thumbtack logic and cards, in that order', fub.join() === order.join(), fub);
  ok('no feature file in a bundle has a .css entry (their sheets are already late-loaded from dashboard.html)', Object.keys(FEATURES).every((f) => (B[FEATURES[f][0]] || []).every((s) => !/\.css/.test(s))));
}

console.log('\nDARK FEATURES: dashboard.html');
{
  const dash = read('docs/pro/dashboard.html');
  ok('the loader is a deferred external tag', /<script defer src="js\/dark-features\.js\?v=\d+"><\/script>/.test(dash));
  const eager = ['stale-leads-cleanup', 'lead-source-fixer', 'reputation', 'speed-to-lead', 'estimate-follow-board', 'follow-up-board-logic', 'follow-up-board', 'opp-approval-logic', 'opp-approval']
    .filter((n) => new RegExp('<script[^>]*src="js/' + n + '\\.js').test(dash));
  ok('none of the nine feature files is an eager tag any more', eager.length === 0, eager);
  ok('estimate-followups.js (the Home card the boards read) is still eager', /<script defer src="js\/estimate-followups\.js/.test(dash));
  const btns = ['staleLeadsBtn', 'leadSourceFixerBtn', 'speedToLeadBtn', 'estimateFollowBoardBtn', 'followUpBoardBtn', 'reputationBtn'];
  ok('the six toolbar buttons are still in the page, hidden by default', btns.every((id) => new RegExp('id="' + id + '"[^>]*\\bhidden\\b').test(dash)));
  const sheets = ['stale-leads-cleanup', 'lead-source-fixer', 'reputation', 'speed-to-lead', 'estimate-follow-board', 'follow-up-board'];
  ok('their stylesheets are still linked (late, media="print")', sheets.every((n) => new RegExp('media="print" data-late-css href="css/' + n + '\\.css').test(dash)));
  ok('the loader comes after the blocking script-loader.js (registration needs it); feature-flags.js may land either side, the listener waits', dash.indexOf('js/dark-features.js') > dash.indexOf('js/script-loader.js') && dash.indexOf('js/script-loader.js') > 0);
  ok('script-loader.js is untouched by this lane: no feature bundle inside the blocking file', !/followupboard|staleleads|leadsourcefixer|speedtolead|estimatefollowboard/.test(read('docs/pro/js/script-loader.js')));
  const manifest = read('tests/ci-manifest.json');
  ok('this suite is in the node bucket', manifest.indexOf('"dark-features-lazy-2026-11-08.test.js"') >= 0);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
