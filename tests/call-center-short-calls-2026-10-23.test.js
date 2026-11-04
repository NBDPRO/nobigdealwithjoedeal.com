/**
 * tests/call-center-short-calls-2026-10-23.test.js
 *
 * Overnight-audit follow-up on the Horizon-3 filters:
 *   1. "Missed" was a promise the data cannot keep (nothing writes `answered`; an unanswered call often has no recording at all), so the
 *      chip and the saved view are SHOWN as "Short calls" / "Short calls today". The ids stay, so saved records keep working.
 *   2. Handled on the Needs attention tab can never show anything: the chip is off there and says why.
 *   3. If the filter module fails to load, the bar says so out loud instead of vanishing.
 * Faked clock (3 PM New York, 2026-10-21): no check depends on when CI runs.
 *
 * Run: node tests/call-center-short-calls-2026-10-23.test.js
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
const NOW = Date.parse('2026-10-21T19:00:00Z');
const H = 3600e3;

(async () => {
  console.log('\n1. honest labels');
  {
    const label = (id) => FX.STATUSES.filter((s) => s[0] === id)[0][1];
    ok('the status chip says "Short calls", not "Missed"', label('missed') === 'Short calls' && !FX.STATUSES.some((s) => /missed/i.test(s[1])));
    ok('the saved view says "Short calls today", not "Missed today"', FX.VIEWS.filter((v) => v.id === 'missed-today')[0].label === 'Short calls today' && !FX.VIEWS.some((v) => /missed/i.test(v.label)));
    ok('control: the other labels are untouched', label('unhandled') === 'Unhandled' && label('handled') === 'Handled' && label('urgent') === 'Urgent' && label('promise') === 'Has promise');
    ok('the ids are unchanged, so a record saved before this still loads and still means the same thing', FX.normalize({ status: 'missed' }).status === 'missed' && FX.applyView('missed-today', {}).status === 'missed');
    ok('the filter line names it honestly', FX.describe({ status: 'missed' }, '2026-10-21').join('|') === 'Short calls');
    ok('the module says why (no `answered` writer yet) so nobody relabels it back', /Short calls[\s\S]*nothing writes `answered`/.test(fs.readFileSync(path.join(ROOT, 'docs/pro/js/call-center-filters-logic.js'), 'utf8')));
    ok('the rule itself is unchanged: an inbound call under 15 s, unknown length is not short', FX.isMissed({ direction: 'inbound', durationSec: 8 }) && !FX.isMissed({ direction: 'inbound', durationSec: null }) && !FX.isMissed({ direction: 'inbound', durationSec: 15 }));
  }

  console.log('\n2. the screen');
  {
    class FakeDate extends Date {
      constructor(...a) { if (a.length) super(...a); else super(NOW); }
      static now() { return NOW; }
    }
    const rowsDb = { phone_calls: [
      { id: 'c_short', userId: 'U', bucket: 'unknown', phoneDigits: '5135550101', direction: 'inbound', status: 'noted', startedAtMs: NOW - H, durationSec: 4, urgent: true },
      { id: 'c_done', userId: 'U', bucket: 'unknown', phoneDigits: '5135550102', direction: 'inbound', status: 'noted', startedAtMs: NOW - 2 * H, durationSec: 80, handledAtMs: NOW - H },
    ], phone_text_days: [] };
    function boot(withFilters, saved) {
      const listeners = {}; const view = { innerHTML: '' }; const badge = { textContent: '', dn: false, classList: { toggle(c, on) { badge.dn = !!on; } } };
      const mem = saved ? { [FX.KEY]: JSON.stringify(saved) } : {};
      const document = { readyState: 'complete', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view : null), getElementById: (id) => (id === 'callsNavBadge' ? badge : null), activeElement: null };
      const win = { document, NBDTriageDeck: { open() {} }, _userClaims: {}, _user: { uid: 'U' }, _leads: [], db: {}, collection: (d, n) => n, where: () => null, orderBy: () => null, limit: () => null, query: (c) => c,
        getDocs: async (c) => ({ docs: (rowsDb[c] || []).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }), location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' }, _functions: {}, _httpsCallable: () => async () => ({ data: { items: [] } }),
        localStorage: { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } } };
      const sandbox = { window: win, document, console, setTimeout, Promise, URLSearchParams, Date: FakeDate, Object, Array, String, Number, JSON, Math, RegExp, CSS: { escape: (s) => String(s) }, history: { replaceState() {} } };
      win.history = sandbox.history; vm.createContext(sandbox);
      if (withFilters) vm.runInContext(read('docs/pro/js/call-center-filters-logic.js'), sandbox);
      vm.runInContext(read('docs/pro/js/call-center-view.js'), sandbox);
      const clickEl = (attrs) => ({ closest: (sel) => (sel === '[data-cc]' ? { getAttribute: (a) => (a in attrs ? attrs[a] : null), closest: () => true } : null) });
      return { CC: win.NBDCallCenter, view, mem, click(attrs) { (listeners.click || []).forEach((f) => f({ target: clickEl(attrs) })); } };
    }
    const handledBtn = (v) => (/<button[^>]*data-cc="status" data-arg="handled"[^>]*>/.exec(v.view.innerHTML) || [''])[0];

    const v = boot(true);
    await v.CC.reload();
    ok('the Needs attention tab is where it opens', /aria-selected="true" data-cc="filter" data-arg="attention"/.test(v.view.innerHTML));
    ok('on Needs attention the Handled chip is OFF (disabled) and carries the reason', /\sdisabled/.test(handledBtn(v)) && /aria-disabled="true"/.test(handledBtn(v)) && /never on Needs attention/.test(handledBtn(v)), handledBtn(v));
    ok('control: the other status chips are live there', ['unhandled', 'urgent', 'promise', 'missed'].every((s) => !/disabled/.test((new RegExp('<button[^>]*data-cc="status" data-arg="' + s + '"[^>]*>').exec(v.view.innerHTML) || [''])[0])));
    v.click({ 'data-cc': 'filter', 'data-arg': 'all' });
    ok('control: on the All tab Handled is live again, with no reason attached', handledBtn(v) !== '' && !/disabled/.test(handledBtn(v)) && !/title=/.test(handledBtn(v)), handledBtn(v));
    v.click({ 'data-cc': 'status', 'data-arg': 'handled' });
    ok('...and it shows the handled call there', /data-call-id="c_done"/.test(v.view.innerHTML) && !/data-call-id="c_short"/.test(v.view.innerHTML));
    v.click({ 'data-cc': 'filter', 'data-arg': 'attention' });
    ok('a saved "Handled" landing on Needs attention is explained (not a bare empty list), and another status chip is a way out', /Handled calls are never on Needs attention/.test(v.view.innerHTML.replace(/title="[^"]*"/g, '')) || /Open the All tab/.test(v.view.innerHTML.replace(/title="[^"]*"/g, '')), v.view.innerHTML.slice(v.view.innerHTML.indexOf('cc-empty'), v.view.innerHTML.indexOf('cc-empty') + 200));

    const down = boot(false);
    await down.CC.reload();
    ok('filter module missing: the page still lists calls...', /data-call-id="c_short"/.test(down.view.innerHTML));
    ok('...and says out loud that it is NOT filtered (role=alert), instead of the bar silently vanishing', /role="alert"[^>]*>Filters could not load, so the list below is NOT filtered/.test(down.view.innerHTML), down.view.innerHTML.slice(0, 200));
    ok('control: with the module loaded there is no such note', !/Filters could not load/.test(v.view.innerHTML));
    ok('no chips are drawn in the down state (nothing that cannot work)', !/data-cc="status"/.test(down.view.innerHTML) && !/data-cc="range"/.test(down.view.innerHTML));
  }

  console.log('\n3. wiring');
  {
    const view = read('docs/pro/js/call-center-view.js');
    ok('no inline handlers or styles in the new markup (CSP)', !/cc-filter-down[^>]*(onclick|style=)/.test(view));
    ok('the screen never says "Missed" to Jo any more', !/'Missed'|>Missed</.test(view) && !/Missed today/.test(read('docs/pro/js/call-center-filters-logic.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
