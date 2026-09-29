/**
 * tests/daily-success-sync-2026-09-29.test.js
 *
 * Daily tracker revamp, Phase 0 (documentation/projects/
 * DAILY-TRACKER-REVAMP-PLAN-2026-09-29.md): the live bugs in the Daily
 * Success program's cloud sync and rendering.
 *
 *   1. deleted pages came back on the next sign-in      → tombstones
 *   2. the older cloud copy overwrote a newer local edit → per-page `mt`
 *   3. one 500-write batch held EVERY page               → changed-only, ≤400
 *   4. settings + goal targets died at every sign-out    → userSettings/{uid}
 *   5. user text went into innerHTML unescaped           → E()
 *
 * The rules live in docs/pro/daily-success/js/ds-sync-logic.js and are driven
 * directly; the wiring in app.js / ds-firebase-sync.js / widgets.js is pinned
 * by source shape, each absence check paired with a presence control.
 *
 * Run: node tests/daily-success-sync-2026-09-29.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const L = require(path.join(ROOT, 'docs', 'pro', 'daily-success', 'js', 'ds-sync-logic.js'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const pg = (id, dk, extra) => Object.assign({ id, dk, data: {} }, extra || {});

console.log('\n1. stamping only what changed');
{
  const snap = new Map();
  const pages = [pg(1, '2026-09-01', { data: { a: '1' } }), pg(2, '2026-09-02', { mt: 50 })];
  L.seedSnapshots(pages, snap);
  ok('a save with no edits stamps nothing', L.stampChanged(pages, snap, 1000).length === 0);
  pages[0].data.a = '2';
  const s1 = L.stampChanged(pages, snap, 2000);
  ok('an edited page is stamped', s1.length === 1 && s1[0] === '1' && pages[0].mt === 2000);
  ok('an untouched page keeps its stamp', pages[1].mt === 50);
  ok('stamping does not make the page look changed again', L.stampChanged(pages, snap, 3000).length === 0 && pages[0].mt === 2000);
  pages.push(pg(3, '2026-09-03'));
  const s2 = L.stampChanged(pages, snap, 4000);
  ok('a brand-new page is stamped', s2.length === 1 && s2[0] === '3' && pages[2].mt === 4000);
  const legacy = [pg(9, '2025-01-01')];
  const snap2 = L.seedSnapshots(legacy, new Map());
  ok('an old unstamped page stays unstamped until edited', L.stampChanged(legacy, snap2, 5000).length === 0 && legacy[0].mt === undefined);
}

console.log('\n2. merging: deletes stick, the newer copy wins');
{
  const local = [pg(1, '2026-09-01', { mt: 300, data: { x: 'local' } }), pg(2, '2026-09-02', { mt: 100 }), pg(4, '2026-09-04')];
  const cloud = [pg(1, '2026-09-01', { mt: 200, data: { x: 'cloud' } }), pg(2, '2026-09-02', { mt: 150 }), pg(3, '2026-09-03', { mt: 1 }),
    { id: 5, deleted: true }];
  const m = L.mergePages(local, cloud, []);
  const byId = (id) => m.pages.find((p) => String(p.id) === String(id));
  ok('a newer local edit beats the older cloud copy (the old code lost it)', byId(1).data.x === 'local');
  ok('a newer cloud copy beats the older local one', byId(2).mt === 150);
  ok('a cloud-only page arrives', !!byId(3));
  ok('a local-only page is kept (it will be pushed)', !!byId(4));
  ok('pages come back sorted by day', m.pages.map((p) => p.dk).join() === '2026-09-01,2026-09-02,2026-09-03,2026-09-04');

  const tie = L.mergePages([pg(7, 'd', { data: { v: 'L' } })], [pg(7, 'd', { data: { v: 'C' } })], []);
  ok('two unstamped copies: the cloud wins, same as before this change', tie.pages[0].data.v === 'C');

  const del = L.mergePages([pg(8, 'd'), pg(9, 'e')], [pg(8, 'd'), { id: 9, dk: 'e', deleted: true }], []);
  ok('a page the cloud has tombstoned is dropped from this device', del.pages.length === 1 && del.pages[0].id === 8);
  ok('...and reported as removed + cloud-deleted', del.removed.join() === '9' && del.cloudDeleted.join() === '9');

  // After sign-out the device is empty, so loadPages() makes a blank today
  // page before the cloud answers — the old merge kept it beside the real one.
  const blank = { id: 111, dk: '2026-09-29', suf: 1, name: '', data: {}, kpi: { doors: 0, closes: 0 }, exercises: [], objections: [], commissions: [] };
  const real = { id: 222, dk: '2026-09-29', suf: 1, name: '', data: { 'l-win': 'closed Kim' }, kpi: { doors: 40 } };
  const signIn = L.mergePages([blank], [real], []);
  ok('sign-in: the blank auto page does not duplicate the real day from the cloud',
    signIn.pages.length === 1 && signIn.pages[0].id === 222 && signIn.removed.join() === '111');
  ok('a blank page on a day the cloud has NO page is kept', L.mergePages([blank], [pg(5, '2026-09-28')], []).pages.length === 2);
  ok('a page with anything typed is never treated as blank',
    !L.isBlankAutoPage(Object.assign({}, blank, { data: { 'l-p1': 'x' } })) && !L.isBlankAutoPage(Object.assign({}, blank, { kpi: { doors: 1 } }))
    && !L.isBlankAutoPage(Object.assign({}, blank, { exercises: [{ name: 'Bench', sets: '' }] })));
  ok('a deliberate second entry (suf 2) or a named page is never treated as blank',
    !L.isBlankAutoPage(Object.assign({}, blank, { suf: 2 })) && !L.isBlankAutoPage(Object.assign({}, blank, { name: 'Gym' })));
  ok('the same blank page already IN the cloud is left alone (merge never drops cloud data)',
    L.mergePages([blank], [blank], []).pages.length === 1);

  const localTomb = L.mergePages([pg(8, 'd')], [pg(8, 'd'), pg(10, 'f')], ['10']);
  ok('a page deleted here (tombstone not yet pushed) is NOT resurrected by the cloud', localTomb.pages.map((p) => p.id).join() === '8');
}

console.log('\n3. pushing only what changed, in small batches');
{
  const ledger = new Map([['1', 300], ['2', 0]]);
  const pages = [pg(1, 'a', { mt: 300 }), pg(2, 'b'), pg(3, 'c'), pg(4, 'd', { mt: 9 })];
  const ch = L.changedSince(pages, ledger).map((p) => p.id);
  ok('a page the cloud holds at the same mt is skipped', !ch.includes(1));
  ok('an unstamped page the cloud already has is skipped', !ch.includes(2));
  ok('a page the cloud has never seen is pushed', ch.includes(3) && ch.includes(4));
  ledger.set('4', 5);
  ok('a page stamped since the cloud last saw it is pushed', L.changedSince([pg(4, 'd', { mt: 9 })], ledger).length === 1);

  const big = Array.from({ length: 1001 }, (_, i) => i);
  const parts = L.chunk(big, L.CHUNK);
  ok('1001 writes split into batches of at most 400', parts.length === 3 && parts.every((p) => p.length <= 400) && parts.flat().length === 1001);
  ok('the chunker never exceeds Firestore\'s 500-write batch limit', L.chunk(big, 900).every((p) => p.length <= 499));
  ok('no writes → no batches', L.chunk([], 400).length === 0);
}

console.log('\n4. settings: the newer copy wins');
{
  ok('only the cloud has settings (a fresh sign-in) → restore', L.pickSettings({ value: null, at: 0 }, { value: { a: 1 }, at: 5 }) === 'cloud');
  ok('only this device has them (never backed up) → push', L.pickSettings({ value: { a: 1 }, at: 0 }, { value: null, at: 0 }) === 'local');
  ok('the cloud copy is newer → restore', L.pickSettings({ value: { a: 1 }, at: 10 }, { value: { a: 2 }, at: 20 }) === 'cloud');
  ok('this device is newer → push', L.pickSettings({ value: { a: 1 }, at: 30 }, { value: { a: 2 }, at: 20 }) === 'local');
  ok('neither side has a value → nothing', L.pickSettings({ value: null }, { value: null }) === 'none');
  ok('parseJson survives junk', L.parseJson('{oops') === null && L.parseJson(null) === null && L.parseJson('"str"') === null);
  const w = L.widgetCfgFrom({ northStar: { category: 'Make more money', target: '$250k', deadline: '2026-12-31' },
    floors: [{ label: 'Doors', targetValue: '60', unit: 'doors' }], goose: 'Beach day' });
  ok('widget config is rebuilt from a restored config', w.northStar === '$250k' && w.northStarDeadline === '2026-12-31'
    && w.floors[0].target === 60 && w.floors[0].unit === 'doors' && w.goldenGoose === 'Beach day');
}

console.log('\n5. escaping in app.js');
{
  const app = read('docs/pro/daily-success/js/app.js');
  const line = (app.match(/^const E=.*$/m) || [])[0];
  ok('app.js defines the E() escape helper', !!line);
  const sb = {};
  vm.runInNewContext(line.replace(/^const E=/, 'E='), sb);
  ok('E escapes & < > " \'', sb.E('<a href="x">&\'') === '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  ok('E renders null/undefined as empty', sb.E(null) === '' && sb.E(undefined) === '');
  ok('a note cannot close its own textarea', !sb.E('</textarea><img src=x>').includes('<'));
  // Absence check with a positive control: every d[...] field goes through E.
  const wrapped = (app.match(/\$\{E\(d\[/g) || []).length;
  const raw = (app.match(/\$\{d\[/g) || []).length;
  ok('the 31 field interpolations are wrapped (positive control)', wrapped === 31, 'got ' + wrapped);
  ok('no raw ${d[...]} interpolation remains', raw === 0, 'got ' + raw);
  ok('page names are escaped in the tab bar', /class="tlbl">\$\{E\(tlbl\(p\)\)\}/.test(app));
  ok('floor labels are escaped', (app.match(/\$\{E\(f\.label\)\}/g) || []).length === 2 && !/\$\{f\.label\}/.test(app));
  ok('search input and results are escaped', /No results for "\$\{E\(q\)\}"/.test(app) && /E\(h\.preview\)/.test(app));
}

console.log('\n6. wiring');
{
  const app = read('docs/pro/daily-success/js/app.js');
  const sync = read('docs/pro/daily-success/ds-firebase-sync.js');
  const html = read('docs/pro/daily-success/index.html');
  const widgets = read('docs/pro/js/widgets.js');
  const actions = read('docs/pro/js/dashboard-actions.js');
  ok('index.html loads ds-sync-logic.js before app.js',
    html.indexOf('js/ds-sync-logic.js') > -1 && html.indexOf('js/ds-sync-logic.js') < html.indexOf('js/app.js'));
  ok('savePages stamps changed pages', /function savePages\(\)\{[^}]*stampChanged\(pages,_dsSnap/.test(app));
  ok('loadPages seeds the snapshots', /function loadPages\(\)\{[\s\S]{0,120}seedSnapshots\(pages,_dsSnap\)/.test(app));
  ok('doDelete tombstones the page', /function doDelete\(\)\{[^\n]*dsTombstone\(gone\.id\)/.test(app));
  ok('both config writers and the goal-target writer stamp + push',
    (app.match(/setItem\(NBD_CFG,JSON\.stringify\(config\)\);dsSettingsChanged\(NBD_CFG\)/g) || []).length === 2
    && /setItem\(GT_KEY,JSON\.stringify\(gt\)\);dsSettingsChanged\(GT_KEY\)/.test(app));
  ok('the push is chunked through ds-sync-logic', /L\(\)\.chunk\(writes/.test(sync) && /changedSince\(pages, _ledger\)/.test(sync));
  ok('the old single all-pages batch is gone', !/for \(const page of pages\)/.test(sync));
  ok('a delete is a soft delete, never deleteDoc', /deleted: true/.test(sync) && !/deleteDoc/.test(sync));
  ok('settings sync to userSettings with timestamps', /'userSettings'/.test(sync) && /field \+ 'At'/.test(sync));
  ok('the CRM settings save also writes userSettings.dsConfig', /dsConfig: config, dsConfigAt/.test(actions));
  ok('the CRM Home restores nbd_ds_config after sign-out', /\['nbd_user_config', 'dsConfig'\]/.test(widgets) && /_writeLocal\('nbd_ds_config'/.test(widgets));
}

console.log('\n7. collectPage never reads a page that is not on screen');
{
  // The bug: after boot / a cloud sync the dashboard was showing while `cur`
  // still pointed at a page; the next tab tap ran collectPage() against a DOM
  // with no exercise rows and saved exercises:[] over that day's log.
  const app = read('docs/pro/daily-success/js/app.js');
  const start = app.indexOf('function collectPage(silent){');
  let i = app.indexOf('{', start), depth = 0;
  for (; i < app.length; i++) { if (app[i] === '{') depth++; else if (app[i] === '}' && --depth === 0) break; }
  const src = app.slice(start, i + 1);
  function run(shownId) {
    const ctx = {
      pages: [{ id: 7, data: { 'l-win': 'kept' }, exercises: [{ name: 'Bench', sets: '3' }] }], cur: 0, exCount: 0,
      document: { getElementById: () => ({ dataset: { dsPage: shownId } }), querySelectorAll: () => [], querySelector: () => null },
      savePages() { ctx.saved = true; }, markSaved() {},
    };
    vm.runInNewContext(src + '\ncollectPage(true);', ctx);
    return ctx;
  }
  const off = run('');
  ok('dashboard on screen: the page\'s Exercise Log is untouched', off.pages[0].exercises.length === 1 && off.pages[0].exercises[0].name === 'Bench' && !off.saved);
  const on = run('7');
  ok('positive control: with the page on screen the same call DOES collect (so the guard is what saved it)', on.saved === true && on.pages[0].exercises.length === 0);
  const other = run('8');
  ok('a different page on screen is not collected into this one', other.pages[0].exercises.length === 1 && !other.saved);
  ok('renderPage stamps the page on screen; renderDash clears it',
    /const p=pages\[cur\];\r?\nmain\.dataset\.dsPage=String\(p&&p\.id\);/.test(app) && /function renderDash\(\)\{\r?\nkillCharts\(\);const main=document\.getElementById\('main'\);main\.innerHTML='';main\.dataset\.dsPage='';/.test(app));
  ok('boot opens on the dashboard with cur=-1 (tabs and screen agree)', /loadPages\(\);cur=-1;renderTabs\(\);renderDash\(\);/.test(app));
  const sync = read('docs/pro/daily-success/ds-firebase-sync.js');
  const code = sync.replace(/^\s*\/\/.*$/gm, '');
  ok('the sync re-renders the current view, never a bare renderDash()', /dsRefreshView\(\)/.test(code) && !/renderDash\(\)/.test(code));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
