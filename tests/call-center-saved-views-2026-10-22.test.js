/**
 * tests/call-center-saved-views-2026-10-22.test.js
 *
 * Call Center Horizon 3, step 2: one-tap views ("Missed today", "Unhandled this week") on top of the one saved-filter record.
 * A view is not a second stored thing: tapping one sets the same record (nbd_cc_filters) the chips set.
 * The screen runs on a FAKED clock (3 PM New York, 2026-10-21) so no check depends on when CI runs (midnight-3am ET broke CI before).
 *
 * Run: node tests/call-center-saved-views-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const FX = require(path.join(ROOT, 'docs/pro/js/call-center-filters-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const NOW = Date.parse('2026-10-21T19:00:00Z'); // 3:00 PM EDT on 2026-10-21
const H = 3600e3, D = 86400e3;

(async () => {
  console.log('\n1. the views (pure)');
  {
    ok('two views, with the names Jo asked for', FX.VIEWS.map((v) => v.label).join('|') === 'Missed today|Unhandled this week');
    const m = FX.applyView('missed-today', FX.defaults());
    ok('Missed today = Today + Missed', m.range === 'today' && m.status === 'missed' && m.dir === 'all');
    const u = FX.applyView('unhandled-week', FX.defaults());
    ok('Unhandled this week = last 7 days + Unhandled', u.range === '7d' && u.status === 'unhandled');
    ok('control: an unknown view id is null, not a silent "clear"', FX.applyView('nope', FX.defaults()) === null && FX.applyView(undefined, FX.defaults()) === null);
    ok('a view replaces the old range / status / direction / dates but keeps the order', (function () { const r = FX.applyView('missed-today', { range: 'custom', from: '2026-10-01', to: '2026-10-02', dir: 'out', status: 'urgent', sort: 'old' }); return r.range === 'today' && r.from === '' && r.dir === 'all' && r.status === 'missed' && r.sort === 'old'; })());
    ok('matchView: a view\'s own filter matches it, in either order', FX.matchView(m) === 'missed-today' && FX.matchView(Object.assign({}, m, { sort: 'old' })) === 'missed-today' && FX.matchView(u) === 'unhandled-week');
    ok('control: change one thing and it is no longer that view (other status, other range, a direction)', FX.matchView(Object.assign({}, m, { status: 'urgent' })) === null && FX.matchView(Object.assign({}, m, { range: 'yesterday' })) === null && FX.matchView(Object.assign({}, m, { dir: 'in' })) === null);
    ok('control: no filter at all matches no view', FX.matchView(FX.defaults()) === null && FX.matchView(null) === null);
    ok('the views are plain, valid filters (survive normalize unchanged)', FX.VIEWS.every((v) => JSON.stringify(FX.normalize(v.filter)) === JSON.stringify(Object.assign(FX.defaults(), v.filter))));
  }

  console.log('\n2. the screen (faked clock)');
  {
    class FakeDate extends Date {
      constructor(...a) { if (a.length) super(...a); else super(NOW); }
      static now() { return NOW; }
    }
    const rowsDb = {
      phone_calls: [
        { id: 'c_miss_today', userId: 'U', bucket: 'unknown', phoneDigits: '5135550101', direction: 'inbound', status: 'noted', startedAtMs: NOW - 1 * H, durationSec: 0 },
        { id: 'c_miss_week', userId: 'U', bucket: 'unknown', phoneDigits: '5135550102', direction: 'inbound', status: 'noted', startedAtMs: NOW - 3 * D, durationSec: 5, urgent: true },
        { id: 'c_talk_today', userId: 'U', bucket: 'unknown', phoneDigits: '5135550103', direction: 'inbound', status: 'noted', startedAtMs: NOW - 2 * H, durationSec: 200 },
        { id: 'c_done_week', userId: 'U', bucket: 'unknown', phoneDigits: '5135550104', direction: 'inbound', status: 'noted', startedAtMs: NOW - 2 * D, durationSec: 90, handledAtMs: NOW - D },
        { id: 'c_open_old', userId: 'U', bucket: 'unknown', phoneDigits: '5135550105', direction: 'inbound', status: 'noted', startedAtMs: NOW - 20 * D, durationSec: 90 },
      ],
      phone_text_days: [],
    };
    function boot(saved) {
      const listeners = {}; const view = { innerHTML: '' }; const badge = { textContent: '', dn: false, classList: { toggle(c, on) { badge.dn = !!on; } } };
      const mem = saved ? { [FX.KEY]: JSON.stringify(saved) } : {};
      const document = { readyState: 'complete', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view : null), getElementById: (id) => (id === 'callsNavBadge' ? badge : null), activeElement: null };
      const win = { document, NBDTriageDeck: { open() {} }, _userClaims: {}, _user: { uid: 'U' }, _leads: [], db: {}, collection: (d, n) => n, where: () => null, orderBy: () => null, limit: () => null, query: (c) => c,
        getDocs: async (c) => ({ docs: (rowsDb[c] || []).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }), location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' }, _functions: {}, _httpsCallable: () => async () => ({ data: { items: [] } }),
        localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
      const sandbox = { window: win, document, console, setTimeout, Promise, URLSearchParams, Date: FakeDate, Object, Array, String, Number, JSON, Math, RegExp, CSS: { escape: (s) => String(s) }, history: { replaceState() {} } };
      win.history = sandbox.history; vm.createContext(sandbox);
      vm.runInContext(read('docs/pro/js/call-center-filters-logic.js'), sandbox);
      vm.runInContext(read('docs/pro/js/call-center-view.js'), sandbox);
      const clickEl = (attrs) => ({ closest: (sel) => (sel === '[data-cc]' ? { getAttribute: (a) => (a in attrs ? attrs[a] : null), closest: () => true } : null) });
      return { CC: win.NBDCallCenter, view, mem, badge, click(attrs) { (listeners.click || []).forEach((f) => f({ target: clickEl(attrs) })); } };
    }
    const ids = (v) => (v.view.innerHTML.match(/data-call-id="([^"]+)"/g) || []).map((m) => m.slice(14, -1)).sort();
    const rec = (v) => JSON.parse(v.mem[FX.KEY]);

    const v = boot();
    await v.CC.reload();
    ok('the view buttons are on the page, none pressed at first', /data-cc="view" data-arg="missed-today"/.test(v.view.innerHTML) && /data-cc="view" data-arg="unhandled-week"/.test(v.view.innerHTML) && !/aria-pressed="true" data-cc="view"/.test(v.view.innerHTML));
    v.click({ 'data-cc': 'view', 'data-arg': 'missed-today' });
    ok('Missed today: only the call that rang unanswered an hour ago (not the missed one from 3 days ago, not today\'s long call)', JSON.stringify(ids(v)) === '["c_miss_today"]', JSON.stringify(ids(v)));
    ok('it opened the All tab, even from Needs attention', /aria-selected="true" data-cc="filter" data-arg="all"/.test(v.view.innerHTML));
    ok('the view button is pressed and the summary says what it is', /aria-pressed="true" data-cc="view" data-arg="missed-today"/.test(v.view.innerHTML) && /Showing 1 of 5 · Today · Missed/.test(v.view.innerHTML), (v.view.innerHTML.match(/cc-filter-sum[^<]*/) || [''])[0]);
    ok('it wrote the ONE saved-filter record (no second record)', rec(v).range === 'today' && rec(v).status === 'missed' && Object.keys(v.mem).length === 1);
    v.click({ 'data-cc': 'view', 'data-arg': 'unhandled-week' });
    ok('Unhandled this week: today\'s two + the missed one from 3 days ago; not the handled one, not the 20-day-old one', JSON.stringify(ids(v)) === '["c_miss_today","c_miss_week","c_talk_today"]', JSON.stringify(ids(v)));
    ok('only the newly chosen view is pressed', /aria-pressed="true" data-cc="view" data-arg="unhandled-week"/.test(v.view.innerHTML) && /aria-pressed="false" data-cc="view" data-arg="missed-today"/.test(v.view.innerHTML));
    v.click({ 'data-cc': 'sort', 'data-arg': 'old' });
    ok('changing the order keeps the view on', /aria-pressed="true" data-cc="view" data-arg="unhandled-week"/.test(v.view.innerHTML) && rec(v).sort === 'old');
    v.click({ 'data-cc': 'view', 'data-arg': 'missed-today' });
    ok('switching view keeps the order Jo chose', rec(v).sort === 'old' && rec(v).status === 'missed');
    v.click({ 'data-cc': 'status', 'data-arg': 'handled' });
    ok('control: touching a chip means it is no longer the view (button unpressed), though the rest of the filter stays', !/aria-pressed="true" data-cc="view"/.test(v.view.innerHTML) && rec(v).range === 'today' && rec(v).status === 'handled');
    v.click({ 'data-cc': 'view', 'data-arg': 'missed-today' });
    v.click({ 'data-cc': 'view', 'data-arg': 'missed-today' });
    ok('tapping the view that is on turns it off: everything is back, the order is kept', ids(v).length === 5 && rec(v).range === 'all' && rec(v).status === 'all' && rec(v).sort === 'old' && !/cc-filter-sum/.test(v.view.innerHTML), JSON.stringify(rec(v)));
    v.click({ 'data-cc': 'view', 'data-arg': 'nope' });
    ok('control: an unknown view id changes nothing', ids(v).length === 5 && rec(v).range === 'all');

    // the real open list is never narrowed by a view
    v.CC.setFilter('attention');
    const badge0 = v.badge.textContent;
    v.click({ 'data-cc': 'view', 'data-arg': 'missed-today' });
    ok('the sidebar badge ignores the view (still ' + badge0 + ')', v.badge.textContent === badge0 && badge0 !== '' && badge0 !== '0', v.badge.textContent + ' vs ' + badge0);
    ok('"One at a time" ignores the view too', new RegExp('One at a time \\(' + badge0 + '\\)').test(v.view.innerHTML), (v.view.innerHTML.match(/One at a time \(\d+\)/) || ['none'])[0]);

    // persistence: a view survives a reload because it is just the saved record
    const v2 = boot({ range: 'today', status: 'missed', dir: 'all', sort: 'new' });
    await v2.CC.reload();
    ok('a saved record that equals a view comes back with that view pressed', /aria-pressed="true" data-cc="view" data-arg="missed-today"/.test(v2.view.innerHTML));
    const v3 = boot({ range: 'today', status: 'unhandled' });
    await v3.CC.reload();
    ok('control: a saved record that equals no view presses none', !/aria-pressed="true" data-cc="view"/.test(v3.view.innerHTML));

    // the clock really is faked: the day after, "today" is empty and the old missed call is no longer today's
    class LaterDate extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW + 2 * D); } static now() { return NOW + 2 * D; } }
    ok('the faked clock is what drives "today" (two days later the same call is not today)', FX.passes({ direction: 'inbound', durationSec: 0, startedAtMs: NOW - H }, FX.applyView('missed-today', {}), new LaterDate().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), NOW + 2 * D) === false);
  }

  console.log('\n3. wiring');
  {
    const view = read('docs/pro/js/call-center-view.js'), logic = read('docs/pro/js/call-center-filters-logic.js');
    ok('the click handler routes data-cc="view" to applyViewNow', /a === 'view'\) applyViewNow\(b\.getAttribute\('data-arg'\)\)/.test(view));
    ok('views are plain buttons (no inline handlers or styles - CSP)', !/cc-views[^>]*(onclick|style=)/.test(view));
    ok('the view definitions live in the pure module, not the screen', /const VIEWS = \[/.test(logic) && !/Missed today/.test(view));
    ok('no second storage key was added for views', (logic.match(/setItem\(/g) || []).length === 1 && !/localStorage\.setItem/.test(view));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
