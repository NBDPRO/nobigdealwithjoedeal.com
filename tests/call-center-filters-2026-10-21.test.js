/**
 * tests/call-center-filters-2026-10-21.test.js
 *
 * Call Center date / direction / sort filters (Jo, 2026-10-21: "a full filter system for the call center ... date
 * selection or range, click today or most recent"). Pins the pure module (call-center-filters-logic.js) and drives the
 * real view (call-center-view.js) through the same VM harness the other Call Center tests use.
 *
 * Run: node tests/call-center-filters-2026-10-21.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
// Pins read the source with comments removed: a commented-out line must not satisfy a pin (vacuous-test audit, 2026-10-21).
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const FX = require(path.join(ROOT, 'docs/pro/js/call-center-filters-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
// America/New_York: 2026-10-21 is EDT (UTC-4). 2026-11-01 02:00 EDT -> 01:00 EST (DST ends).
const et = (ymd, hh, mm) => Date.parse(ymd + 'T' + String(hh).padStart(2, '0') + ':' + String(mm || 0).padStart(2, '0') + ':00-04:00');
const TODAY = '2026-10-21';
const NOW = et(TODAY, 15, 0);
const call = (id, ms, extra) => Object.assign({ id, startedAtMs: ms, direction: 'inbound' }, extra || {});

(async () => {
  console.log('\n1. days and presets');
  {
    ok('ymdOf uses the New York calendar day (11:30 PM EDT is still the 20th, though it is the 21st in UTC)', FX.ymdOf(et('2026-10-20', 23, 30)) === '2026-10-20' && FX.ymdOf(Date.parse('2026-10-21T03:30:00Z')) === '2026-10-20');
    ok('...and 12:30 AM is the 21st', FX.ymdOf(et('2026-10-21', 0, 30)) === '2026-10-21');
    ok('ymdOf: a missing / bad time is empty, never "1970-01-01"', FX.ymdOf(null) === '' && FX.ymdOf(0) === '' && FX.ymdOf('x') === '' && FX.ymdOf(undefined) === '');
    ok('addDays crosses month and year ends', FX.addDays('2026-10-31', 1) === '2026-11-01' && FX.addDays('2026-01-01', -1) === '2025-12-31' && FX.addDays('2026-03-01', -1) === '2026-02-28');
    ok('rangeOf: today, yesterday, 7 days (today + 6 before), 30 days', JSON.stringify(FX.rangeOf({ range: 'today' }, TODAY)) === '{"from":"2026-10-21","to":"2026-10-21"}' && FX.rangeOf({ range: 'yesterday' }, TODAY).from === '2026-10-20' && FX.rangeOf({ range: '7d' }, TODAY).from === '2026-10-15' && FX.rangeOf({ range: '30d' }, TODAY).from === '2026-09-22');
    ok('rangeOf: any time and the rolling 24h have no calendar range', FX.rangeOf({ range: 'all' }, TODAY) === null && FX.rangeOf({ range: '24h' }, TODAY) === null);
  }

  console.log('\n2. normalize / persistence');
  {
    ok('defaults are "any time, all calls, newest first"', JSON.stringify(FX.defaults()) === '{"range":"all","from":"","to":"","dir":"all","status":"all","sort":"new"}');
    ok('junk becomes the defaults', JSON.stringify(FX.normalize(null)) === JSON.stringify(FX.defaults()) && JSON.stringify(FX.normalize('x')) === JSON.stringify(FX.defaults()) && FX.normalize({ range: 'forever', dir: 'sideways', sort: 'random' }).range === 'all');
    ok('a reversed custom range is swapped, not emptied', (function () { const n = FX.normalize({ range: 'custom', from: '2026-10-20', to: '2026-10-10' }); return n.from === '2026-10-10' && n.to === '2026-10-20'; })());
    ok('invalid dates are dropped (Feb 30, wrong shape)', FX.normalize({ range: 'custom', from: '2026-02-30', to: '10/21/2026' }).range === 'all');
    ok('"Pick dates" with no dates is no filter (so an empty pick never hides everything)', FX.normalize({ range: 'custom' }).range === 'all' && FX.isActive({ range: 'custom' }) === false);
    ok('only one end is fine (open-ended)', FX.normalize({ range: 'custom', from: '2026-10-15' }).range === 'custom' && FX.normalize({ range: 'custom', to: '2026-10-15' }).range === 'custom');
    ok('dates are cleared when a preset is chosen', FX.normalize({ range: 'today', from: '2026-10-01', to: '2026-10-02' }).from === '');
    ok('isActive: a range or a direction counts; sort alone does not (it only reorders)', FX.isActive({ range: 'today' }) && FX.isActive({ dir: 'in' }) && !FX.isActive({ sort: 'old' }) && !FX.isActive(FX.defaults()));
    const mem = {}; const storage = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
    FX.save(storage, { range: '7d', dir: 'out', sort: 'old' });
    ok('save then load round-trips', JSON.stringify(FX.load(storage)) === JSON.stringify({ range: '7d', from: '', to: '', dir: 'out', status: 'all', sort: 'old' }));
    mem[FX.KEY] = '{not json';
    ok('corrupt saved JSON loads as defaults, no throw', JSON.stringify(FX.load(storage)) === JSON.stringify(FX.defaults()));
    ok('no storage at all (private mode / null) is safe', JSON.stringify(FX.load(null)) === JSON.stringify(FX.defaults()) && (function () { try { FX.save(null, { range: 'today' }); return true; } catch (e) { return false; } })());
    ok('a storage that throws on write is ignored', (function () { try { FX.save({ setItem() { throw new Error('quota'); } }, { range: 'today' }); return true; } catch (e) { return false; } })());
  }

  console.log('\n3. which calls pass');
  {
    const c0 = call('today', et(TODAY, 9, 0)), cLate = call('lastnight', et('2026-10-20', 23, 59)), cEarly = call('earlier', et('2026-10-14', 8, 0)), cOld = call('old', et('2026-09-01', 8, 0));
    const day = (f) => [c0, cLate, cEarly, cOld].filter((c) => FX.passes(c, f, TODAY, NOW)).map((c) => c.id).join(',');
    ok('any time passes everything', day({ range: 'all' }) === 'today,lastnight,earlier,old');
    ok('Today: only today (11:59 PM last night is yesterday)', day({ range: 'today' }) === 'today');
    ok('Yesterday: only yesterday', day({ range: 'yesterday' }) === 'lastnight');
    ok('Last 7 days includes today and the 6 days before (Oct 15-21), not Oct 14', day({ range: '7d' }) === 'today,lastnight');
    ok('Last 30 days reaches Sep 22, not Sep 1', day({ range: '30d' }) === 'today,lastnight,earlier');
    ok('a custom range is inclusive on both ends', day({ range: 'custom', from: '2026-10-14', to: '2026-10-20' }) === 'lastnight,earlier');
    ok('open-ended: only "from" runs to the future, only "to" runs from the past', day({ range: 'custom', from: '2026-10-20' }) === 'today,lastnight' && day({ range: 'custom', to: '2026-10-14' }) === 'earlier,old');
    ok('Last 24 hours is a rolling window from now (3 PM): 9 AM today yes, 11:59 PM last night (15 h) yes, 8 AM Oct 14 no', day({ range: '24h' }) === 'today,lastnight');
    ok('24h edges: exactly 24 h ago is out, 23 h 59 m ago is in, the future is out', FX.passes(call('a', NOW - 86400000), { range: '24h' }, TODAY, NOW) === false && FX.passes(call('b', NOW - 86340000), { range: '24h' }, TODAY, NOW) === true && FX.passes(call('c', NOW + 60000), { range: '24h' }, TODAY, NOW) === false);
    ok('a call with no time cannot be placed in a range (but shows under any time)', FX.passes({ id: 'x' }, { range: 'today' }, TODAY, NOW) === false && FX.passes({ id: 'x' }, { range: 'all' }, TODAY, NOW) === true);
    ok('DST: the day the clocks fall back, 1:30 AM EST on Nov 1 is still Nov 1', FX.ymdOf(Date.parse('2026-11-01T06:30:00Z')) === '2026-11-01' && FX.passes(call('d', Date.parse('2026-11-01T06:30:00Z')), { range: 'custom', from: '2026-11-01', to: '2026-11-01' }, '2026-11-05', NOW) === true);
    const inb = call('in', et(TODAY, 8, 0)), out = call('out', et(TODAY, 8, 5), { direction: 'outbound' }), txt = { id: 'txt', channel: 'text', direction: 'inbound', startedAtMs: et(TODAY, 8, 10) }, unk = call('unk', et(TODAY, 8, 20), { direction: null });
    const dir = (d) => [inb, out, txt, unk].filter((c) => FX.passes(c, { dir: d }, TODAY, NOW)).map((c) => c.id).join(',');
    ok('direction: all passes everything', dir('all') === 'in,out,txt,unk');
    ok('They called = inbound calls only; texts and unknown-direction calls are left out', dir('in') === 'in');
    ok('You called = outbound calls only', dir('out') === 'out');
    ok('date and direction combine (both must pass)', FX.passes(out, { range: 'today', dir: 'in' }, TODAY, NOW) === false && FX.passes(inb, { range: 'today', dir: 'in' }, TODAY, NOW) === true && FX.passes(inb, { range: 'yesterday', dir: 'in' }, TODAY, NOW) === false);
    ok('a null call never passes', FX.passes(null, {}, TODAY, NOW) === false);
  }

  console.log('\n4. order and wording');
  {
    const rows = [call('b', 200), call('none', null), call('a', 100), call('c', 300)];
    ok('newest first', FX.sortCalls(rows, 'new').map((c) => c.id).join(',') === 'c,b,a,none');
    ok('oldest first (calls with no time stay last either way)', FX.sortCalls(rows, 'old').map((c) => c.id).join(',') === 'a,b,c,none');
    ok('sorting never mutates the list it was given', rows.map((c) => c.id).join(',') === 'b,none,a,c' && FX.sortCalls(null, 'new').length === 0);
    ok('describe: presets', FX.describe({ range: 'today' }, TODAY).join() === 'Today' && FX.describe({ range: '24h' }, TODAY).join() === 'Last 24 hours' && FX.describe({ range: '7d', dir: 'in' }, TODAY).join(' | ') === 'Last 7 days | They called');
    ok('describe: custom ranges read naturally', FX.describe({ range: 'custom', from: '2026-10-14', to: '2026-10-20' }, TODAY)[0] === 'Oct 14 – Oct 20' && FX.describe({ range: 'custom', from: '2026-10-14', to: '2026-10-14' }, TODAY)[0] === 'Oct 14' && FX.describe({ range: 'custom', from: '2026-10-14' }, TODAY)[0] === 'Since Oct 14' && FX.describe({ range: 'custom', to: '2026-10-14' }, TODAY)[0] === 'Through Oct 14');
    ok('describe: nothing active -> no words', FX.describe(FX.defaults(), TODAY).length === 0);
  }

  console.log('\n5. the real view');
  {
    const H = 3600e3;
    // "Today" calls must be in today's New York day whatever time the suite runs: CI hit this at 00:13 ET, when "1 / 2 / 3 hours ago" are
    // all yesterday. Offsets are fractions of the time since New York midnight (plus 1 s so today is never empty), newest first.
    const etp = {};
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date()).forEach((p) => { etp[p.type] = +p.value; });
    const sinceMidnight = (etp.hour * 3600 + etp.minute * 60 + etp.second) * 1000 + 1000;
    const todayAt = (frac) => Date.now() - Math.floor(sinceMidnight * frac);
    const rowsDb = {
      phone_calls: [
        { id: 'c_today_in', userId: 'U', bucket: 'unknown', phoneDigits: '5135550101', direction: 'inbound', status: 'noted', startedAtMs: todayAt(0.2), summary: 'roof leak', urgent: true },
        { id: 'c_today_out', userId: 'U', bucket: 'unknown', phoneDigits: '5135550102', direction: 'outbound', status: 'noted', startedAtMs: todayAt(0.4), summary: 'called back' },
        { id: 'c_week_in', userId: 'U', bucket: 'unknown', phoneDigits: '5135550103', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 4 * 24 * H, summary: 'gutters' },
        { id: 'c_today_in_old', userId: 'U', bucket: 'unknown', phoneDigits: '5135550101', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 10 * 24 * H, summary: 'earlier call from the same person', urgent: true },
        { id: 'c_old_in', userId: 'U', bucket: 'unknown', phoneDigits: '5135550104', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 40 * 24 * H, summary: 'ancient' },
      ],
      phone_text_days: [{ id: 'txt_5135550105_1', userId: 'U', channel: 'text', phoneDigits: '5135550105', status: 'noted', startedAtMs: todayAt(0.6), messageCount: 2, contactName: 'Kim' }],
    };
    function boot(saved, throwingStorage) {
      const listeners = {}; const view = { innerHTML: '' }; const badge = { textContent: '', dn: false, classList: { toggle(c, on) { badge.dn = !!on; } } };
      const mem = saved ? { [FX.KEY]: JSON.stringify(saved) } : {};
      const document = { readyState: 'complete', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view : null), getElementById: (id) => (id === 'callsNavBadge' ? badge : null), activeElement: null };
      const win = { document, NBDTriageDeck: { open() {} }, _userClaims: {}, _user: { uid: 'U' }, _leads: [], db: {}, collection: (d, n) => n, where: () => null, orderBy: () => null, limit: () => null, query: (c) => c,
        getDocs: async (c) => ({ docs: (rowsDb[c] || []).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }), location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' }, _functions: {}, _httpsCallable: () => async () => ({ data: { items: [] } }),
        localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
      if (throwingStorage) Object.defineProperty(win, 'localStorage', { get() { throw new Error('SecurityError'); } });
      const sandbox = { window: win, document, console, setTimeout, Promise, URLSearchParams, Date, Object, Array, String, Number, JSON, Math, RegExp, CSS: { escape: (s) => String(s) }, history: { replaceState() {} } };
      win.history = sandbox.history; vm.createContext(sandbox);
      vm.runInContext(read('docs/pro/js/call-center-filters-logic.js'), sandbox);
      vm.runInContext(read('docs/pro/js/call-center-view.js'), sandbox);
      const clickEl = (attrs) => ({ closest: (sel) => (sel === '[data-cc]' ? { getAttribute: (a) => (a in attrs ? attrs[a] : null), closest: () => true } : null) });
      return {
        CC: win.NBDCallCenter, view, mem, badge,
        click(attrs) { (listeners.click || []).forEach((f) => f({ target: clickEl(attrs) })); },
        date(which, value) { (listeners.change || []).forEach((f) => f({ target: { getAttribute: (a) => (a === 'data-cc-date' ? which : null), value, closest: () => true } })); },
      };
    }
    const ids = (v) => (v.view.innerHTML.match(/data-call-id="([^"]+)"/g) || []).map((m) => m.slice(14, -1));
    const v = boot();
    await v.CC.reload();
    v.CC.setFilter('all');
    ok('the filter bar is on the page: when chips, direction chips and order chips', /data-cc="range" data-arg="today"/.test(v.view.innerHTML) && /data-cc="range" data-arg="24h"/.test(v.view.innerHTML) && /data-cc="range" data-arg="custom"/.test(v.view.innerHTML) && /data-cc="dir" data-arg="in"/.test(v.view.innerHTML) && /data-cc="sort" data-arg="old"/.test(v.view.innerHTML));
    ok('nothing is filtered at first: all six rows, no summary line', ids(v).length === 6 && !/cc-filter-sum/.test(v.view.innerHTML));
    v.click({ 'data-cc': 'range', 'data-arg': 'today' });
    const today = ids(v);
    ok('Today: only the three from the last few hours (two calls + the text day)', today.length === 3 && today.includes('c_today_in') && today.includes('c_today_out') && !today.includes('c_week_in'), JSON.stringify(today));
    ok('the summary says what is showing and offers Clear', /Showing 3 of 6 · Today/.test(v.view.innerHTML) && /data-cc="clearfilters"/.test(v.view.innerHTML), (v.view.innerHTML.match(/cc-filter-sum[^<]*/) || [''])[0]);
    ok('the tab counts follow the filter (All says 3)', /data-arg="all">All <span class="cc-count">3<\/span>/.test(v.view.innerHTML), (v.view.innerHTML.match(/data-arg="all">All <span class="cc-count">\d+/) || [''])[0]);
    ok('the choice is saved', JSON.parse(v.mem[FX.KEY]).range === 'today');
    v.click({ 'data-cc': 'dir', 'data-arg': 'in' });
    ok('Today + They called: just the one inbound call (the text day has no direction)', JSON.stringify(ids(v)) === '["c_today_in"]', JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'range', 'data-arg': '7d' });
    ok('Last 7 days + They called: two inbound calls', ids(v).sort().join() === 'c_today_in,c_week_in');
    v.click({ 'data-cc': 'sort', 'data-arg': 'old' });
    ok('oldest first reverses the list', ids(v).join() === 'c_week_in,c_today_in');
    v.click({ 'data-cc': 'clearfilters' });
    ok('Clear brings everything back (and keeps nothing saved)', ids(v).length === 6 && !/cc-filter-sum/.test(v.view.innerHTML) && JSON.parse(v.mem[FX.KEY]).range === 'all');
    v.click({ 'data-cc': 'range', 'data-arg': 'custom' });
    ok('"Pick dates" shows two date boxes without hiding anything yet', /data-cc-date="from"/.test(v.view.innerHTML) && /data-cc-date="to"/.test(v.view.innerHTML) && ids(v).length === 6);
    const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    v.date('from', ymd(Date.now() - 5 * 24 * H));
    ok('picking only a start date runs from then to now: the 4-day-old call and today\'s', ids(v).sort().join() === 'c_today_in,c_today_out,c_week_in,txt_5135550105_1' && /Since /.test(v.view.innerHTML), JSON.stringify(ids(v)));
    v.date('to', ymd(Date.now() - 3 * 24 * H));
    ok('...and an end date makes it a window: only the 4-day-old call', JSON.stringify(ids(v)) === '["c_week_in"]', JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'range', 'data-arg': 'yesterday' });
    ok('an empty result says so and offers a way out', /No calls match these filters/.test(v.view.innerHTML) && /data-cc="clearfilters"/.test(v.view.innerHTML));
    v.click({ 'data-cc': 'clearfilters' });

    // Switching category tabs through the real tab click keeps the date filter (a tab click that cleared it would pass every setFilter-driven check)
    v.CC.setFilter('all');
    v.click({ 'data-cc': 'range', 'data-arg': 'today' });
    v.click({ 'data-cc': 'filter', 'data-arg': 'attention' });
    v.click({ 'data-cc': 'filter', 'data-arg': 'all' });
    ok('a category tab click keeps the saved date filter (Today still on, three rows)', JSON.parse(v.mem[FX.KEY]).range === 'today' && ids(v).length === 3 && /Showing 3 of 6 · Today/.test(v.view.innerHTML), JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'clearfilters' });
    ok('control: and Clear still empties it (the check above is not just "nothing ever resets")', JSON.parse(v.mem[FX.KEY]).range === 'all' && ids(v).length === 6);

    // Needs attention counts PEOPLE and the filters narrow what is shown but never the real open list
    v.CC.setFilter('attention');
    const badgeAll = v.badge.textContent;
    v.click({ 'data-cc': 'range', 'data-arg': 'today' });
    ok('one person, two open calls (today and 10 days ago): under Today the group card holds only today\'s call', ids(v).indexOf('c_today_in') > -1 && ids(v).indexOf('c_today_in_old') === -1, JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'clearfilters' });
    ok('...and with no filter both of that person\'s calls are on the card', ids(v).indexOf('c_today_in') > -1 && ids(v).indexOf('c_today_in_old') > -1, JSON.stringify(ids(v)));
    const before = (v.view.innerHTML.match(/data-arg="attention">Needs attention <span class="cc-count">(\d+)/) || [])[1];
    v.click({ 'data-cc': 'range', 'data-arg': 'yesterday' });
    const after = (v.view.innerHTML.match(/data-arg="attention">Needs attention <span class="cc-count">(\d+)/) || [])[1];
    ok('Needs attention under a filter counts the people in range (' + before + ' -> ' + after + ')', Number(after) <= Number(before) && after === '0', before + ' -> ' + after);
    ok('...but "One at a time" still shows the real open count (' + before + ')', new RegExp('One at a time \\(' + before + '\\)').test(v.view.innerHTML) || before === '0');
    ok('the sidebar badge keeps the real open count while a filter is on (' + badgeAll + ')', v.badge.textContent === badgeAll && badgeAll !== '' && badgeAll !== '0', v.badge.textContent + ' vs ' + badgeAll);
    ok('sort chips are hidden on Needs attention (it is grouped by person)', !/data-cc="sort"/.test(v.view.innerHTML));
    v.click({ 'data-cc': 'clearfilters' });

    // review fixes (independent silent-failure review, 2026-10-21)
    v.CC.setFilter('attention');
    v.click({ 'data-cc': 'range', 'data-arg': 'today' });
    ok('Needs attention reports PEOPLE in its filter line, not a row count', /Showing 1 person · Today/.test(v.view.innerHTML) && !/Showing \d+ of /.test(v.view.innerHTML), (v.view.innerHTML.match(/cc-filter-sum[^<]*/) || [''])[0]);
    v.click({ 'data-cc': 'clearfilters' });
    v.CC.setFilter('all');
    v.click({ 'data-cc': 'range', 'data-arg': '30d' });
    ok('other tabs still say "of N" and count the rows shown', /Showing 5 of 6 · Last 30 days/.test(v.view.innerHTML), (v.view.innerHTML.match(/cc-filter-sum[^<]*/) || [''])[0]);
    v.click({ 'data-cc': 'clearfilters' });
    const extra = [];
    for (let i = 0; i < 155; i++) extra.push({ id: 'bulk_' + i, userId: 'U', bucket: 'unknown', phoneDigits: '51355599' + String(10 + (i % 80)), direction: 'inbound', status: 'noted', startedAtMs: Date.now() - (100 + i) * H, summary: 'bulk ' + i });
    rowsDb.phone_calls.push.apply(rowsDb.phone_calls, extra);
    await v.CC.reload(); v.CC.setFilter('all');
    ok('the 150-row cap says "newest" under Newest first', /Showing the newest 150\./.test(v.view.innerHTML));
    v.click({ 'data-cc': 'sort', 'data-arg': 'old' });
    ok('...and "oldest" under Oldest first (it showed the oldest 150 but still said newest)', /Showing the oldest 150\./.test(v.view.innerHTML) && !/Showing the newest 150/.test(v.view.innerHTML));
    rowsDb.phone_calls.splice(rowsDb.phone_calls.length - 155, 155);
    v.click({ 'data-cc': 'clearfilters' });
    await v.CC.reload();

    // a browser where touching window.localStorage THROWS (Safari with storage blocked) must not kill the view at load
    const vs = boot(null, true);
    ok('with a throwing localStorage the Call Center module still defines itself', !!vs.CC && typeof vs.CC.reload === 'function');
    await vs.CC.reload(); vs.CC.setFilter('all');
    ok('...loads and lists the calls', ids(vs).length === 6, JSON.stringify(ids(vs)));
    vs.click({ 'data-cc': 'range', 'data-arg': 'today' });
    ok('...filters still work for the visit (they just are not saved)', ids(vs).length === 3 && /Showing 3 of 6/.test(vs.view.innerHTML));

    // a saved choice is restored at boot
    const v2 = boot({ range: '7d', dir: 'in', sort: 'new' });
    await v2.CC.reload(); v2.CC.setFilter('all');
    ok('a saved filter comes back on the next visit', JSON.stringify(ids(v2).sort()) === '["c_today_in","c_week_in"]' && /Last 7 days · They called/.test(v2.view.innerHTML), JSON.stringify(ids(v2)));
    const v3 = boot({ range: 'today' });
    await v3.CC.reload();
    v3.CC.setFilter('all');
    ok('a ?call= deep link drops the filters so the card it points at is on screen', (function () { v3.CC.focusCall('c_old_in'); return true; })());
    await new Promise((r) => setTimeout(r, 400));
    ok('...the old call is visible and the filters are cleared', ids(v3).includes('c_old_in') && JSON.stringify(v3.CC._flt()) === JSON.stringify(FX.defaults()), JSON.stringify([ids(v3), v3.CC._flt()]));
  }

  console.log('\n6. wiring');
  {
    const view = read('docs/pro/js/call-center-view.js'), css = read('docs/pro/css/phone-calls.css'), loader = read('docs/pro/js/script-loader.js'), dash = read('docs/pro/dashboard.html');
    ok('the filter module loads before the view, in the lazy callcenter bundle (view version bumped)', /callcenter: \[\s*'js\/call-center-filters-logic\.js\?v=4',\s*'js\/call-center-loop-logic\.js\?v=1',\s*'js\/call-center-view\.js\?v=27'\s*\]/.test(loader));
    ok('the stylesheet version was bumped for the new rules', /css\/phone-calls\.css\?v=13/.test(dash) && /\.cc-fbar \{/.test(css));
    ok('chips, date boxes and Clear are 44px targets', /\.cc-date \{[^}]*min-height: 44px/.test(css) && /\.cc-clear \{[^}]*min-height: 44px/.test(css) && /\.cc-tab \{\s*min-height: 44px/.test(css));
    ok('no inline handlers or inline styles in the new markup (CSP)', !/cc-fchip[^>]*(onclick|style=)/.test(view) && !/cc-date[^>]*(onclick|style=)/.test(view));
    ok('the view still works without the filter module (guarded by FX)', /var FX = window\.NBDCallCenterFilters \|\| null;/.test(view) && /if \(!FX\) return '<div class="cc-filter-sum cc-filter-down" role="alert">/.test(view));
    ok('the sidebar badge is computed from the unfiltered list', /var navCount = base === state\.calls \? counts\.attention : groupNeeds\(state\.calls\)\.length;/.test(view));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
