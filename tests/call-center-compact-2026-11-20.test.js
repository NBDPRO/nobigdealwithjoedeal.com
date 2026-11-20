#!/usr/bin/env node
/**
 * tests/call-center-compact-2026-11-20.test.js — the Call Center's compact phone view (feature flag callCenterCompact).
 *
 * Phone sweep 2026-11-20: at 393 px the first call started 1,197 px down the page and each call card was 400+ px tall. With the
 * flag on: a slim header, four tabs plus More, ONE Sort / Filter row that opens a bottom sheet, and each call a collapsed row
 * (Call / Text / Handled / More) that opens the full card. With the flag off nothing changes.
 *
 * The real view (docs/pro/js/call-center-view.js + call-center-filters-logic.js) runs in a vm over a stub window, the same way
 * tests/call-center-filters-2026-10-21.test.js runs it.
 *
 * Run: node tests/call-center-compact-2026-11-20.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const FX = require('../docs/pro/js/call-center-filters-logic.js');

let failed = 0;
function ok(name, cond, detail) { console.log((cond ? 'ok   ' : 'FAIL ') + name + (!cond && detail ? ' :: ' + String(detail).slice(0, 240) : '')); if (!cond) failed++; }

const H = 3600e3;
const rowsDb = {
  phone_calls: [
    { id: 'c_urgent', userId: 'U', bucket: 'unknown', phoneDigits: '5135550101', contactName: 'Dana Whitfield', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 2 * H, summary: 'roof leak over the kitchen', urgent: true, durationSec: 150, promises: [{ who: 'jo', text: 'send a crew', due: 'today' }] },
    { id: 'c_out', userId: 'U', bucket: 'unknown', phoneDigits: '5135550102', contactName: 'Marcus Bell', direction: 'outbound', status: 'noted', startedAtMs: Date.now() - 5 * H, summary: 'called back', durationSec: 40 },
    { id: 'c_week', userId: 'U', bucket: 'unknown', phoneDigits: '5135550103', contactName: 'amy adams', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 4 * 24 * H, summary: 'gutters', durationSec: 400 },
    { id: 'c_dana2', userId: 'U', bucket: 'unknown', phoneDigits: '5135550101', contactName: 'Dana Whitfield', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 3 * 24 * H, summary: 'earlier call from the same person', durationSec: 60, promises: [{ who: 'jo', text: 'follow up on the estimate' }] },
    { id: 'c_tom', userId: 'U', bucket: 'unknown', phoneDigits: '5135550105', contactName: 'Tom Okafor', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 30 * H, summary: 'wants gutters added', durationSec: 30, promises: [{ who: 'jo', text: 'add a gutter line', due: 'tomorrow' }] },
    { id: 'c_beth', userId: 'U', bucket: 'unknown', phoneDigits: '5135550106', contactName: 'Beth Carlson', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 6 * 24 * H, summary: 'asked for a call back', durationSec: 20, promises: [{ who: 'jo', text: 'call her back' }] },
    { id: 'c_ins', userId: 'U', bucket: 'insurance', phoneDigits: '5135550104', contactName: 'Hartman Insurance', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 6 * H, summary: 'adjuster visit Thursday', durationSec: 90 },
  ],
  phone_text_days: [],
};

function boot(flagOn, saved) {
  const listeners = {}; const winListeners = {};
  const view = { innerHTML: '' };
  const badge = { textContent: '', classList: { toggle() {} } };
  const mem = saved ? Object.assign({}, saved) : {};
  const document = { readyState: 'complete', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view : null), getElementById: (id) => (id === 'callsNavBadge' ? badge : null), activeElement: null };
  const win = { document, NBDTriageDeck: { open() {} }, _userClaims: {}, _user: { uid: 'U' }, _leads: [], db: {}, collection: (d, n) => n, where: () => null, orderBy: () => null, limit: () => null, query: (c) => c,
    getDocs: async (c) => ({ docs: (rowsDb[c] || []).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }), location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' }, _functions: {}, _httpsCallable: () => async () => ({ data: { items: [] } }),
    addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); },
    NBDFlags: { enabled: (n) => flagOn && n === 'callCenterCompact' },
    localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
  const sandbox = { window: win, document, console, setTimeout, Promise, URLSearchParams, Date, Object, Array, String, Number, JSON, Math, RegExp, CSS: { escape: (s) => String(s) }, history: { replaceState() {} } };
  win.history = sandbox.history;
  vm.createContext(sandbox);
  vm.runInContext(read('docs/pro/js/call-center-filters-logic.js'), sandbox);
  vm.runInContext(read('docs/pro/js/call-center-view.js'), sandbox);
  const clickEl = (attrs) => ({ closest: (sel) => (sel === '[data-cc]' ? { getAttribute: (a) => (a in attrs ? attrs[a] : null), closest: () => true } : null) });
  return {
    CC: win.NBDCallCenter, view, mem,
    click(attrs) { (listeners.click || []).forEach((f) => f({ target: clickEl(attrs) })); },
    key(k) { (listeners.keydown || []).forEach((f) => f({ key: k })); },
  };
}
const html = (v) => v.view.innerHTML;
const rowIds = (v) => (html(v).match(/data-call-id="([^"]+)"/g) || []).map((m) => m.slice(14, -1));
const count = (s, re) => (s.match(re) || []).length;

(async () => {
  // ── flag off: the layout is unchanged ─────────────────────────────────
  console.log('flag off');
  {
    const v = boot(false);
    await v.CC.reload();
    ok('no compact wrapper, the explainer is shown, the old filter rows are on the page', !/cc-compact/.test(html(v)) && /class="cc-sub"/.test(html(v)) && /data-cc="range" data-arg="today"/.test(html(v)));
    ok('every tab is a pill in the row (Customers, Insurance, Texts...), no More button', /data-arg="customer"/.test(html(v)) && /data-arg="texts"/.test(html(v)) && !/data-cc="moretabs"/.test(html(v)));
    ok('the full call cards are used (a Promise button on each), not collapsed rows', /data-cc="promise"/.test(html(v)) && !/cc-row-main/.test(html(v)));
    ok('no new saved record is written just by looking', !('nbd_cc_sort2' in v.mem));
  }

  // ── flag on ───────────────────────────────────────────────────────────
  console.log('flag on: header and tabs');
  const v = boot(true);
  await v.CC.reload();
  ok('the compact wrapper is on', /class="cc-wrap cc-compact"/.test(html(v)));
  ok('the explainer is behind an info button, not on the page', /data-cc="info"/.test(html(v)) && !/class="cc-sub"/.test(html(v)));
  v.click({ 'data-cc': 'info' });
  ok('...and the info button shows it', /class="cc-sub"/.test(html(v)));
  v.click({ 'data-cc': 'info' });
  ok('only the four main tabs show, plus a More button (Customers, Insurance... are not pills)', /data-arg="attention"/.test(html(v)) && /data-arg="all"/.test(html(v)) && /data-cc="moretabs"/.test(html(v)) && !/data-cc="filter" data-arg="customer"/.test(html(v)) && !/data-cc="filter" data-arg="insurance"/.test(html(v)));
  v.click({ 'data-cc': 'moretabs' });
  ok('More opens the other categories as a list', /data-cc="filter" data-arg="insurance"/.test(html(v)) && /data-cc="filter" data-arg="customer"/.test(html(v)));
  v.click({ 'data-cc': 'filter', 'data-arg': 'insurance' });
  ok('picking one closes the list and the More button names it', !/cc-more-tabs/.test(html(v)) && /cc-tab-more is-on" data-cc="moretabs"[^>]*>Insurance/.test(html(v)), (html(v).match(/cc-tab-more[^<]*<?[^<]*/) || [''])[0]);
  ok('Insurance shows only the insurance call', JSON.stringify(rowIds(v)) === '["c_ins"]', JSON.stringify(rowIds(v)));

  console.log('flag on: sort and filter');
  v.click({ 'data-cc': 'filter', 'data-arg': 'all' });
  ok('one Sort / Filter row, not four rows of chips: the old rows are not on the page', /data-cc="sheet" data-arg="sort"/.test(html(v)) && /data-cc="sheet" data-arg="filter"/.test(html(v)) && !/cc-fbar/.test(html(v)) && !/data-cc="range"/.test(html(v)));
  ok('the sort button says what is on (Newest first on All)', /Sort: Newest first/.test(html(v)));
  ok('All starts newest first', JSON.stringify(rowIds(v)) === '["c_urgent","c_out","c_ins","c_tom","c_dana2","c_week","c_beth"]', JSON.stringify(rowIds(v)));
  v.click({ 'data-cc': 'sheet', 'data-arg': 'sort' });
  ok('the Sort sheet lists the nine call orders with the current one marked', count(html(v), /class="cc-sheet-opt/g) === 9 && /aria-checked="true" data-cc="cxsort" data-arg="new"/.test(html(v)) && /role="dialog"/.test(html(v)));
  v.click({ 'data-cc': 'cxsort', 'data-arg': 'long' });
  ok('Longest call: the 400 s call is first, then 150 s, 90 s', JSON.stringify(rowIds(v).slice(0, 3)) === '["c_week","c_urgent","c_ins"]', JSON.stringify(rowIds(v)));
  ok('choosing closes the sheet and the choice is saved in its own record, not in the filters', !/cc-sheet"/.test(html(v)) && JSON.parse(v.mem[FX.SORT_KEY]).list === 'long' && !('sort2' in JSON.parse(v.mem[FX.KEY] || '{}')));
  v.click({ 'data-cc': 'sheet', 'data-arg': 'sort' });
  v.click({ 'data-cc': 'cxsort', 'data-arg': 'name' });
  ok('Name A to Z uses the contact name, case-insensitive, same name newest first (amy, Beth, Dana, Dana, Hartman, Marcus, Tom)', JSON.stringify(rowIds(v)) === '["c_week","c_beth","c_urgent","c_dana2","c_ins","c_out","c_tom"]', JSON.stringify(rowIds(v)));
  v.click({ 'data-cc': 'sheet', 'data-arg': 'filter' });
  ok('the Filter sheet holds When, direction and status; no Sort row in it', /role="dialog"/.test(html(v)) && /data-cc="range" data-arg="7d"/.test(html(v)) && /data-cc="status"/.test(html(v)) && !/data-cc="sort"/.test(html(v)));
  v.click({ 'data-cc': 'range', 'data-arg': '24h' });
  ok('a filter applies at once with the sheet still open, and the button counts it', /Filter \(1\)/.test(html(v)) && /Showing 3 of 7/.test(html(v)), (html(v).match(/Filter[^<]{0,12}/) || [''])[0]);
  v.key('Escape');
  ok('Escape closes the sheet', !/cc-sheet"/.test(html(v)));
  v.click({ 'data-cc': 'clearfilters' });
  ok('Clear brings everything back', rowIds(v).length === 7 && !/cc-filter-sum/.test(html(v)));

  console.log('flag on: Needs attention (people)');
  v.click({ 'data-cc': 'filter', 'data-arg': 'attention' });
  ok('it opens on Smart and says so', /Sort: Smart/.test(html(v)));
  const people = rowIds(v);
  ok('Smart: the urgent person first (Dana, two open calls as one row), then the promise due soonest (Tom), then the undated promise (Beth)', JSON.stringify(people) === '["c_urgent","c_tom","c_beth"]' && /data-group="/.test(html(v)) && /2 open/.test(html(v)), JSON.stringify(people));
  ok('...with a plain reason on the others (Promise due ..., Has a promise)', /cc-chip-why[^>]*>Promise due /.test(html(v)) && /cc-chip-why[^>]*>Has a promise/.test(html(v)), (html(v).match(/cc-chip-why[^<]*<?[^<]{0,20}/) || [''])[0]);
  v.click({ 'data-cc': 'sheet', 'data-arg': 'sort' });
  ok('on Needs attention the sheet lists the eight people orders, Smart marked', count(html(v), /class="cc-sheet-opt/g) === 8 && /aria-checked="true" data-cc="cxsort" data-arg="smart"/.test(html(v)));
  v.click({ 'data-cc': 'cxsort', 'data-arg': 'new' });
  ok('the people choice is saved apart from the list choice', JSON.parse(v.mem[FX.SORT_KEY]).people === 'new' && JSON.parse(v.mem[FX.SORT_KEY]).list === 'name');

  console.log('flag on: collapsed rows');
  v.click({ 'data-cc': 'filter', 'data-arg': 'all' });
  const rows = html(v).split('class="panel pc-card cc-card cc-row').slice(1);
  ok('every call is a collapsed row with at most four buttons (Call, Text, Handled, More) and no transcript or promise button', rows.length === 7 && rows.every((r) => count(r.split('cc-row-acts')[1] || '', /<(button|a) /g) <= 4) && !/data-cc="promise"/.test(html(v)) && !/data-cc="attachopen"/.test(html(v)), rows.map((r) => count(r.split('cc-row-acts')[1] || '', /<(button|a) /g)).join());
  const dana = rows.filter((r) => /data-call-id="c_urgent"/.test(r))[0] || '';
  ok('a row shows the name, the time, the chips and the summary', /Dana Whitfield/.test(dana) && /roof leak/.test(dana) && /cc-chip-urgent/.test(dana) && /Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct/.test(dana));
  v.click({ 'data-cc': 'expand', 'data-id': 'c:c_urgent' });
  ok('More opens the full card for that call (Promise, Attach...) with a Show less button', /class="cc-exp"/.test(html(v)) && /data-cc="promise"/.test(html(v)) && /data-cc="expand" data-id="c:c_urgent">Show less/.test(html(v)));
  ok('only that call opened', count(html(v), /class="cc-exp"/g) === 1 && count(html(v), /cc-row-main/g) === 6);
  v.click({ 'data-cc': 'expand', 'data-id': 'c:c_urgent' });
  ok('Show less folds it back', !/class="cc-exp"/.test(html(v)) && count(html(v), /cc-row-main/g) === 7);

  console.log('flag on: what is never touched');
  ok('the saved FILTER record never gained a sort2 or flag field (still the six original keys)', JSON.stringify(Object.keys(JSON.parse(v.mem[FX.KEY] || JSON.stringify(FX.defaults())))) === JSON.stringify(Object.keys(FX.defaults())));
  ok('the other half of the screen is not hidden by the compact view: the search box and the One at a time button are still there', /id="ccSearch"/.test(html(v)) && /data-cc="deck"/.test(html(v)));
  const off = boot(false, { [FX.SORT_KEY]: v.mem[FX.SORT_KEY] });
  await off.CC.reload();
  ok('the flag is read at draw time: with it off (and a saved compact sort lying around) the old layout is back', !/cc-compact/.test(off.view.innerHTML) && /data-cc="range" data-arg="today"/.test(off.view.innerHTML));

  if (failed) { console.log('\n' + failed + ' failed'); process.exit(1); }
  console.log('\nall passed');
})().catch((e) => { console.error(e); process.exit(1); });
