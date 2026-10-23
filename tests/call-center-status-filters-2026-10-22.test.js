/**
 * tests/call-center-status-filters-2026-10-22.test.js
 *
 * Call Center Horizon 3, step 1: status filters (Unhandled / Handled / Urgent / Has promise / Missed) on top of the
 * date / direction / order filters. Jo has NOT confirmed the exact status set; these five are the first cut.
 * Pins the pure module and drives the real view through the VM harness. No test here depends on the clock.
 *
 * Run: node tests/call-center-status-filters-2026-10-22.test.js
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
const TODAY = '2026-10-21', NOW = Date.parse('2026-10-21T19:00:00Z');
const inb = (id, extra) => Object.assign({ id, direction: 'inbound', startedAtMs: NOW - 3600e3 }, extra || {});
const pass = (c, status) => FX.passes(c, { status }, TODAY, NOW);

(async () => {
  console.log('\n1. Missed (pure)');
  {
    ok('an inbound call under 15 s is missed', FX.isMissed(inb('a', { durationSec: 8 })) && FX.isMissed(inb('a', { durationSec: 14.9 })));
    ok('no answer (0 s) is missed', FX.isMissed(inb('a', { durationSec: 0 })));
    ok('the phone saying answered:false is missed whatever the length', FX.isMissed(inb('a', { answered: false, durationSec: 90 })));
    ok('control: exactly 15 s and a real conversation are NOT missed', !FX.isMissed(inb('a', { durationSec: 15 })) && !FX.isMissed(inb('a', { durationSec: 240 })));
    ok('control: an unknown length (null / missing / "") is NOT missed - it is unknown, not zero', !FX.isMissed(inb('a', { durationSec: null })) && !FX.isMissed(inb('a')) && !FX.isMissed(inb('a', { durationSec: '' })) && !FX.isMissed(inb('a', { durationSec: false })));
    ok('control: a short OUTBOUND call is not missed (you hung up, nobody missed you)', !FX.isMissed({ id: 'o', direction: 'outbound', durationSec: 3 }));
    ok('control: a day of texts is never missed', !FX.isMissed({ id: 't', channel: 'text', direction: 'inbound', durationSec: 0 }));
    ok('junk is safe (null, negative, NaN length)', !FX.isMissed(null) && !FX.isMissed(inb('a', { durationSec: -4 })) && !FX.isMissed(inb('a', { durationSec: 'abc' })));
    ok('the cut-off is the server\'s "short call" cut-off', FX.MISSED_UNDER_SEC === require(path.join(ROOT, 'functions/call-center-logic.js')).SHORT_CALL_SEC);
  }

  console.log('\n2. The other four statuses (pure)');
  {
    const open = inb('o'), done = inb('d', { handledAtMs: NOW - 1000 }), personal = inb('p', { status: 'personal' }), spam = inb('s', { callType: 'spam' }), taskDone = inb('t', { taskDone: true });
    ok('Unhandled: an open call passes', pass(open, 'unhandled'));
    ok('control: handled, personal, spam and task-done calls are NOT unhandled', !pass(done, 'unhandled') && !pass(personal, 'unhandled') && !pass(spam, 'unhandled') && !pass(taskDone, 'unhandled'));
    ok('Handled: only the handled call passes', pass(done, 'handled') && !pass(open, 'handled'));
    ok('Urgent: urgent === true passes; control: false / missing / the string "true" do not', pass(inb('u', { urgent: true }), 'urgent') && !pass(open, 'urgent') && !pass(inb('u', { urgent: false }), 'urgent') && !pass(inb('u', { urgent: 'true' }), 'urgent'));
    ok('Has promise: a non-empty promises list passes; control: [] / missing / non-array do not', pass(inb('p', { promises: [{ who: 'jo', text: 'x' }] }), 'promise') && !pass(inb('p', { promises: [] }), 'promise') && !pass(open, 'promise') && !pass(inb('p', { promises: 'x' }), 'promise'));
    ok('a promise from the OTHER side counts too (Has promise is not "Jo owes")', pass(inb('p', { promises: [{ who: 'caller', text: 'x' }] }), 'promise'));
    ok('All statuses: everything passes (the default is no filter)', ['all', 'bogus', undefined].every((s) => pass(done, s) && pass(open, s)));
    ok('status composes with direction and range (AND, not OR)', FX.passes(inb('m', { durationSec: 3 }), { status: 'missed', dir: 'out' }, TODAY, NOW) === false && FX.passes(inb('m', { durationSec: 3 }), { status: 'missed', dir: 'in', range: 'today' }, TODAY, NOW) === true && FX.passes(inb('m', { durationSec: 3, startedAtMs: NOW - 5 * 86400e3 }), { status: 'missed', range: 'today' }, TODAY, NOW) === false);
    ok('a text day can be handled / unhandled but not missed', pass({ id: 't', channel: 'text', handledAtMs: 1 }, 'handled') && pass({ id: 't', channel: 'text' }, 'unhandled') && !pass({ id: 't', channel: 'text' }, 'missed'));
  }

  console.log('\n3. normalize / describe / isActive');
  {
    ok('junk status falls back to "all"; a good one survives', FX.normalize({ status: 'sideways' }).status === 'all' && FX.normalize({ status: 'missed' }).status === 'missed' && FX.normalize(null).status === 'all');
    ok('status alone makes the filter active (so Clear, the summary and the empty-state show)', FX.isActive({ status: 'urgent' }) && !FX.isActive({ status: 'all' }));
    ok('describe names the status', FX.describe({ status: 'promise' }, TODAY).join('|') === 'Has promise' && FX.describe({ range: 'today', dir: 'in', status: 'missed' }, TODAY).join('|') === 'Today|They called|Missed');
    const mem = {}; const st = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
    FX.save(st, { status: 'unhandled' });
    ok('status is saved with the rest of the one saved-filter record', FX.load(st).status === 'unhandled' && Object.keys(mem).length === 1);
    mem[FX.KEY] = JSON.stringify({ range: 'today', dir: 'in', sort: 'old' });
    ok('an old saved record (no status) loads as status "all"', FX.load(st).status === 'all' && FX.load(st).range === 'today');
  }

  console.log('\n4. the screen');
  {
    const H = 3600e3;
    const rowsDb = {
      phone_calls: [
        { id: 'c_noans', userId: 'U', bucket: 'unknown', phoneDigits: '5135550101', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 1 * H, durationSec: 0 },
        { id: 'c_short', userId: 'U', bucket: 'unknown', phoneDigits: '5135550102', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 2 * H, durationSec: 8 },
        { id: 'c_talk', userId: 'U', bucket: 'unknown', phoneDigits: '5135550103', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 3 * H, durationSec: 120, promises: [{ who: 'jo', text: 'send the estimate' }] },
        { id: 'c_nodur', userId: 'U', bucket: 'unknown', phoneDigits: '5135550104', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 4 * H, durationSec: null },
        { id: 'c_out', userId: 'U', bucket: 'unknown', phoneDigits: '5135550105', direction: 'outbound', status: 'noted', startedAtMs: Date.now() - 5 * H, durationSec: 3 },
        { id: 'c_done', userId: 'U', bucket: 'unknown', phoneDigits: '5135550106', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 6 * H, durationSec: 60, handledAtMs: Date.now() - H },
        { id: 'c_urg', userId: 'U', bucket: 'unknown', phoneDigits: '5135550107', direction: 'inbound', status: 'noted', startedAtMs: Date.now() - 7 * H, durationSec: 40, urgent: true },
      ],
      phone_text_days: [{ id: 'txt_5135550108_1', userId: 'U', channel: 'text', phoneDigits: '5135550108', status: 'noted', startedAtMs: Date.now() - 8 * H, messageCount: 2, contactName: 'Kim' }],
    };
    function boot() {
      const listeners = {}; const view = { innerHTML: '' }; const badge = { textContent: '', dn: false, classList: { toggle(c, on) { badge.dn = !!on; } } };
      const mem = {};
      const document = { readyState: 'complete', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view : null), getElementById: (id) => (id === 'callsNavBadge' ? badge : null), activeElement: null };
      const win = { document, NBDTriageDeck: { open() {} }, _userClaims: {}, _user: { uid: 'U' }, _leads: [], db: {}, collection: (d, n) => n, where: () => null, orderBy: () => null, limit: () => null, query: (c) => c,
        getDocs: async (c) => ({ docs: (rowsDb[c] || []).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }), location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' }, _functions: {}, _httpsCallable: () => async () => ({ data: { items: [] } }),
        localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
      const sandbox = { window: win, document, console, setTimeout, Promise, URLSearchParams, Date, Object, Array, String, Number, JSON, Math, RegExp, CSS: { escape: (s) => String(s) }, history: { replaceState() {} } };
      win.history = sandbox.history; vm.createContext(sandbox);
      vm.runInContext(read('docs/pro/js/call-center-filters-logic.js'), sandbox);
      vm.runInContext(read('docs/pro/js/call-center-view.js'), sandbox);
      const clickEl = (attrs) => ({ closest: (sel) => (sel === '[data-cc]' ? { getAttribute: (a) => (a in attrs ? attrs[a] : null), closest: () => true } : null) });
      return { CC: win.NBDCallCenter, view, mem, badge, click(attrs) { (listeners.click || []).forEach((f) => f({ target: clickEl(attrs) })); } };
    }
    const ids = (v) => (v.view.innerHTML.match(/data-call-id="([^"]+)"/g) || []).map((m) => m.slice(14, -1)).sort();
    const v = boot();
    await v.CC.reload();
    v.CC.setFilter('all');
    ok('the status chips are on the page, one per status', ['all', 'unhandled', 'handled', 'urgent', 'promise', 'missed'].every((s) => new RegExp('data-cc="status" data-arg="' + s + '"').test(v.view.innerHTML)));
    ok('control: nothing filtered at first - all eight rows, no summary line', ids(v).length === 8 && !/cc-filter-sum/.test(v.view.innerHTML), String(ids(v).length));
    v.click({ 'data-cc': 'status', 'data-arg': 'missed' });
    ok('Missed: the 0 s and the 8 s inbound calls - not the unknown-length one, not the short outbound, not the texts', JSON.stringify(ids(v)) === '["c_noans","c_short"]', JSON.stringify(ids(v)));
    ok('the summary says Missed and counts rows', /Showing 2 of 8 · Missed/.test(v.view.innerHTML), (v.view.innerHTML.match(/cc-filter-sum[^<]*/) || [''])[0]);
    ok('the active chip is pressed, the others are not', /aria-pressed="true" data-cc="status" data-arg="missed"/.test(v.view.innerHTML) && /aria-pressed="false" data-cc="status" data-arg="all"/.test(v.view.innerHTML));
    ok('the choice is saved in the one record', JSON.parse(v.mem[FX.KEY]).status === 'missed');
    v.click({ 'data-cc': 'status', 'data-arg': 'handled' });
    ok('Handled: just the handled call', JSON.stringify(ids(v)) === '["c_done"]', JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'status', 'data-arg': 'urgent' });
    ok('Urgent: just the urgent call', JSON.stringify(ids(v)) === '["c_urg"]', JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'status', 'data-arg': 'promise' });
    ok('Has promise: just the call with a promise', JSON.stringify(ids(v)) === '["c_talk"]', JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'status', 'data-arg': 'unhandled' });
    ok('Unhandled: everything except the handled call', ids(v).length === 7 && ids(v).indexOf('c_done') === -1, JSON.stringify(ids(v)));
    v.click({ 'data-cc': 'dir', 'data-arg': 'out' });
    v.click({ 'data-cc': 'status', 'data-arg': 'missed' });
    ok('Missed + You called is empty (outbound is never missed) and says so with a way out', ids(v).length === 0 && /No calls match these filters/.test(v.view.innerHTML) && /data-cc="clearfilters"/.test(v.view.innerHTML));
    v.click({ 'data-cc': 'clearfilters' });
    ok('Clear resets the status too', ids(v).length === 8 && JSON.parse(v.mem[FX.KEY]).status === 'all');

    // people, not rows, on Needs attention; the real open list is never narrowed
    v.CC.setFilter('attention');
    const badge0 = v.badge.textContent;
    const att0 = (v.view.innerHTML.match(/data-arg="attention">Needs attention <span class="cc-count">(\d+)/) || [])[1];
    v.click({ 'data-cc': 'status', 'data-arg': 'handled' });
    const att1 = (v.view.innerHTML.match(/data-arg="attention">Needs attention <span class="cc-count">(\d+)/) || [])[1];
    ok('Needs attention under a status filter counts the people left (' + att0 + ' -> ' + att1 + ')', Number(att1) < Number(att0) && att1 === '0', att0 + ' -> ' + att1);
    ok('...but the sidebar badge keeps the real open count (' + badge0 + ')', v.badge.textContent === badge0 && badge0 !== '' && badge0 !== '0', v.badge.textContent + ' vs ' + badge0);
    ok('...and "One at a time" keeps the real open count', new RegExp('One at a time \\(' + att0 + '\\)').test(v.view.innerHTML), (v.view.innerHTML.match(/One at a time \(\d+\)/) || ['none'])[0]);
    v.click({ 'data-cc': 'clearfilters' });
    // a category tab click keeps the status
    v.CC.setFilter('all');
    v.click({ 'data-cc': 'status', 'data-arg': 'urgent' });
    v.click({ 'data-cc': 'filter', 'data-arg': 'attention' });
    v.click({ 'data-cc': 'filter', 'data-arg': 'all' });
    ok('a category tab click keeps the saved status filter', JSON.parse(v.mem[FX.KEY]).status === 'urgent' && JSON.stringify(ids(v)) === '["c_urg"]', JSON.stringify(ids(v)));
  }

  console.log('\n5. wiring');
  {
    const view = read('docs/pro/js/call-center-view.js'), loader = read('docs/pro/js/script-loader.js'), logic = read('docs/pro/js/call-center-filters-logic.js');
    ok('the click handler routes data-cc="status" into setFlt', /a === 'status'\) setFlt\(\{ status: b\.getAttribute\('data-arg'\) \}\)/.test(view));
    ok('status chips are plain buttons (no inline handlers or styles - CSP)', !/cc-status[^>]*(onclick|style=)/.test(view));
    ok('versions bumped so phones fetch the new files', /call-center-filters-logic\.js\?v=3/.test(loader) && /call-center-view\.js\?v=25/.test(loader));
    ok('the missed rule lives in the pure module, not the view', /function isMissed/.test(logic) && !/isMissed/.test(view));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
