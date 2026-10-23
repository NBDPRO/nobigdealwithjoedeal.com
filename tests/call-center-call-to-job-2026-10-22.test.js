/**
 * tests/call-center-call-to-job-2026-10-22.test.js
 *
 * Call Center Horizon 3, step 3: the call-to-job loop.
 *   - Calls match customers by the NUMBER (phoneDigits / the lead's phone fields), never by the call's own leadId (null until filed).
 *   - One match = a one-tap "File on X". Two matches (a couple, a duplicate lead) = "which one?" with a button each - never a
 *     silent pick of the first. Three or more = a relay line: nothing suggested.
 *   - The card says what filing will set (the follow-up reminder the SERVER writes on attach); that wording is pinned equal to the
 *     server's own buildFollowUpTask. Nothing here writes or sends anything by itself.
 * The screen runs on a FAKED clock (3 PM New York, 2026-10-21): no check depends on when CI runs.
 *
 * Run: node tests/call-center-call-to-job-2026-10-22.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => stripComments(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const LP = require(path.join(ROOT, 'docs/pro/js/call-center-loop-logic.js'));
const SERVER = require(path.join(ROOT, 'functions/call-center-logic.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}
const NOW = Date.parse('2026-10-21T19:00:00Z'); // 3:00 PM EDT on 2026-10-21
const TODAY = '2026-10-21';
const H = 3600e3, D = 86400e3;

(async () => {
  console.log('\n1. which customers a number points at (pure)');
  {
    const leads = [
      { id: 'A', firstName: 'Ann', lastName: 'Lee', phone: '(513) 555-0101' },
      { id: 'B', firstName: 'Bob', phone: '513-555-0102', altPhone: '513-555-0199' },
      { id: 'C', firstName: 'Cy', phoneDigits: '5135550103' },
      { id: 'D', firstName: 'Deleted', phone: '513-555-0104', deleted: true },
      { id: 'E', address: '9 Elm St', mobilePhone: '+1 513 555 0105' },
    ];
    const one = (n) => LP.candidatesForNumber(leads, n);
    ok('one customer on the number: one candidate with the name, not a proxy', JSON.stringify(one('5135550101')) === '{"candidates":[{"leadId":"A","name":"Ann Lee"}],"proxy":false}', JSON.stringify(one('5135550101')));
    ok('formatting and a leading 1 do not matter', one('1 (513) 555-0101').candidates[0].leadId === 'A' && one('+15135550101').candidates[0].leadId === 'A');
    ok('it also finds the lead\'s other phone fields (alt, mobile) and phoneDigits', one('5135550199').candidates[0].leadId === 'B' && one('5135550103').candidates[0].leadId === 'C' && one('5135550105').candidates[0].leadId === 'E');
    ok('a lead with no name falls back to its address', one('5135550105').candidates[0].name === '9 Elm St');
    ok('control: a deleted lead never matches', one('5135550104').candidates.length === 0);
    ok('control: an unknown number, a short number and junk match nothing (and are not "proxy")', [one('5135559999'), one('12345'), one(''), one(null), one(undefined)].every((r) => r.candidates.length === 0 && r.proxy === false));
    const two = leads.concat([{ id: 'A2', firstName: 'Ann', lastName: 'Lee (dup)', phone: '513.555.0101' }]);
    const r2 = LP.candidatesForNumber(two, '5135550101');
    ok('two customers share the number: BOTH are listed, in order, not proxy', r2.candidates.map((c) => c.leadId).join() === 'A,A2' && r2.proxy === false);
    const three = two.concat([{ id: 'A3', firstName: 'Relay', phone: '5135550101' }]);
    const r3 = LP.candidatesForNumber(three, '5135550101');
    ok('three or more is a relay line: no candidates, flagged proxy', r3.candidates.length === 0 && r3.proxy === true);
    ok('a lead listed twice (same id) counts once', LP.candidatesForNumber([leads[0], leads[0], leads[0]], '5135550101').candidates.length === 1);
    ok('junk lead rows are safe', LP.candidatesForNumber([null, {}, { id: '' }, { id: 'Z' }, undefined], '5135550101').candidates.length === 0 && LP.candidatesForNumber(null, '5135550101').candidates.length === 0);
  }

  console.log('\n2. the reminder filing sets (pure) - and it is the server\'s rule');
  {
    const call = (extra) => Object.assign({ id: 'cube_X1', status: 'noted', direction: 'inbound', contactName: 'Kim', startedAtMs: NOW - 2 * H, promises: [], followUpDate: null, urgent: false, summary: 's' }, extra || {});
    const prev = (c) => LP.followUpPreview(c, NOW, TODAY);
    const server = (c) => SERVER.buildFollowUpTask({ call: c, notes: { summary: c.summary || '', promises: c.promises || [], followUpDate: c.followUpDate || null, urgent: !!c.urgent }, leadId: 'L1', ownerUid: 'U', todayYmd: TODAY, nowMs: NOW });
    const cases = {
      'a promise of Jo\'s': call({ promises: [{ who: 'jo', text: 'Send the estimate', due: '2026-10-23' }] }),
      'a promise with no date (due today)': call({ promises: [{ who: 'jo', text: 'Call back' }] }),
      'two promises: the earliest date wins': call({ promises: [{ who: 'jo', text: 'A', due: '2026-10-28' }, { who: 'jo', text: 'B', due: '2026-10-24' }] }),
      'a follow-up date only': call({ followUpDate: '2026-10-25' }),
      'a promise and a sooner follow-up date': call({ promises: [{ who: 'jo', text: 'Mail it', due: '2026-10-30' }], followUpDate: '2026-10-26' }),
      'urgent is high priority': call({ urgent: true, followUpDate: '2026-10-22' }),
      'no contact name': call({ contactName: '', followUpDate: '2026-10-22' }),
      'a very long promise is clipped': call({ promises: [{ who: 'jo', text: 'x'.repeat(400) }] }),
      'only the caller promised (nothing for Jo)': call({ promises: [{ who: 'caller', text: 'Will pay Friday' }] }),
      'nothing promised, no date': call(),
      'a call from 20 days ago': call({ startedAtMs: NOW - 20 * D, promises: [{ who: 'jo', text: 'Old one' }] }),
      'a call from exactly 14 days ago': call({ startedAtMs: NOW - 14 * D, promises: [{ who: 'jo', text: 'Edge' }] }),
      'a call 14 days and 1 second ago': call({ startedAtMs: NOW - 14 * D - 1000, promises: [{ who: 'jo', text: 'Just past' }] }),
      'a call from 13 days ago': call({ startedAtMs: NOW - 13 * D, promises: [{ who: 'jo', text: 'Inside' }] }),
    };
    let allSame = true, why = '';
    Object.keys(cases).forEach((k) => {
      const p = prev(cases[k]), s = server(cases[k]);
      const same = (p === null && s === null) || (p && s && p.title === s.title && p.dueDate === s.dueDate && (p.high ? 'high' : 'normal') === s.priority);
      if (!same) { allSame = false; why += ' [' + k + ': ' + JSON.stringify(p) + ' vs ' + JSON.stringify(s && { t: s.title, d: s.dueDate, p: s.priority }) + ']'; }
    });
    ok('parity: for every case above, the preview equals the task the server\'s buildFollowUpTask makes (title, due date, priority)', allSame, why);
    ok('control: the matrix really covers both outcomes (some make a reminder, some do not)', Object.keys(cases).some((k) => server(cases[k])) && Object.keys(cases).some((k) => !server(cases[k])));
    ok('a promise gives "<what> (<who>)" due on its date', prev(cases['a promise of Jo\'s']).title === 'Send the estimate (Kim)' && prev(cases['a promise of Jo\'s']).dueDate === '2026-10-23');
    ok('a follow-up date alone gives "Follow up with <who>"', prev(cases['a follow-up date only']).title === 'Follow up with Kim');
    ok('control: a caller-only promise, an old call and a bare call make no reminder', prev(cases['only the caller promised (nothing for Jo)']) === null && prev(cases['a call from 20 days ago']) === null && prev(cases['nothing promised, no date']) === null);
    ok('the 14-day edge matches the server (exactly 14 days and 13 days are in; one second past 14 days is out)', prev(cases['a call from exactly 14 days ago']) !== null && prev(cases['a call from 13 days ago']) !== null && prev(cases['a call 14 days and 1 second ago']) === null);
    ok('a day of texts and a call whose notes are not written yet make none here (the server files it when the notes land)', prev(call({ channel: 'text', followUpDate: '2026-10-22' })) === null && prev(call({ status: 'stored', followUpDate: '2026-10-22' })) === null);
    ok('junk is safe', prev(null) === null && prev(undefined) === null && prev({}) === null);
    ok('the window is the server\'s window', LP.TASK_WINDOW_MS === 14 * D);
  }

  console.log('\n3. the screen (faked clock)');
  {
    class FakeDate extends Date {
      constructor(...a) { if (a.length) super(...a); else super(NOW); }
      static now() { return NOW; }
    }
    const rowsDb = { phone_calls: [], phone_text_days: [] };
    const calls = [];
    const leads = [
      { id: 'SOLO', firstName: 'Pat', lastName: 'Solo', phone: '(513) 555-0201' },
      { id: 'COUP1', firstName: 'Jo', lastName: 'Couple', phone: '(513) 555-0301' },
      { id: 'COUP2', firstName: 'Sam', lastName: 'Couple', phone: '513-555-0301' },
      { id: 'RLY1', firstName: 'R1', phone: '5135550401' }, { id: 'RLY2', firstName: 'R2', phone: '5135550401' }, { id: 'RLY3', firstName: 'R3', phone: '5135550401' },
    ];
    const noted = (id, extra) => Object.assign({ id, userId: 'U', companyId: 'U', bucket: 'unknown', direction: 'inbound', status: 'noted', startedAtMs: NOW - 2 * H, durationSec: 100, leadId: null, promises: [], summary: 'sum' }, extra);
    rowsDb.phone_calls.push(
      noted('c_solo', { phoneDigits: '5135550201', promises: [{ who: 'jo', text: 'Send the estimate', due: '2026-10-23' }], contactName: 'Pat' }),
      noted('c_solo_plain', { phoneDigits: '5135550201', startedAtMs: NOW - 3 * H }),
      noted('c_couple', { phoneDigits: '5135550301', followUpDate: '2026-10-25', contactName: 'The Couples' }),
      noted('c_relay', { phoneDigits: '5135550401' }),
      noted('c_unknown', { phoneDigits: '5135550999' }),
      noted('c_old', { phoneDigits: '5135550201', startedAtMs: NOW - 20 * D, promises: [{ who: 'jo', text: 'Old promise' }] }),
      noted('c_filed', { phoneDigits: '5135550201', leadId: 'SOLO', bucket: 'customer' })
    );
    const listeners = {}; const view = { innerHTML: '' }; const slots = {};
    const document = { readyState: 'complete', addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); }, querySelector: (sel) => (sel === '#view-calls .view-scroll' ? view : null), getElementById: () => null, activeElement: null,
      querySelectorAll: (sel) => { const m = /status="([^"]+)"/.exec(sel); if (!m) return []; const id = m[1]; return [{ set textContent(v) { slots[id] = v; }, get textContent() { return slots[id]; } }]; } };
    const win = { document, NBDTriageDeck: { open() {} }, _userClaims: {}, _user: { uid: 'U' }, _leads: leads, db: {}, collection: (d, n) => n, where: () => null, orderBy: () => null, limit: () => null, query: (c) => c,
      getDocs: async (c) => ({ docs: (rowsDb[c] || []).map((r) => ({ id: r.id, data: () => Object.assign({}, r) })) }), location: { search: '', pathname: '/pro/dashboard.html', hash: '#/calls' },
      _functions: {}, _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: { ok: true, leadId: data && data.leadId } }; },
      localStorage: { getItem: () => null, setItem() {} } };
    const sandbox = { window: win, document, console, setTimeout, Promise, URLSearchParams, Date: FakeDate, Object, Array, String, Number, JSON, Math, RegExp, CSS: { escape: (s) => String(s) }, history: { replaceState() {} } };
    win.history = sandbox.history; vm.createContext(sandbox);
    ['call-center-filters-logic.js', 'call-center-loop-logic.js', 'call-center-view.js'].forEach((f) => vm.runInContext(read('docs/pro/js/' + f), sandbox));
    const CC = win.NBDCallCenter;
    await CC.reload();
    CC.setFilter('all');
    const html = () => view.innerHTML;
    const card = (id) => { const i = html().indexOf('data-call-id="' + id + '"'); if (i < 0) return ''; const n = html().indexOf('data-call-id="', i + 10); return html().slice(i, n < 0 ? undefined : n); };
    const button = (attrs) => { const a = Object.assign({}, attrs); const b = { disabled: false, hidden: false, textContent: '', remove() {}, getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); },
      closest: (sel) => { if (sel === '#view-calls') return {}; const keys = (sel.match(/\[([a-z-]+)(?:="([^"]+)")?\]/g) || []).map((s) => /\[([a-z-]+)(?:="([^"]+)")?\]/.exec(s)); return keys.some((k) => k[1] in a && (k[2] == null || a[k[1]] === k[2])) ? b : null; } }; return b; };
    const flush = () => new Promise((r) => setTimeout(r, 0));

    const solo = card('c_solo');
    ok('one customer on the number: a single one-tap "File on Pat Solo" (matched by the NUMBER - the call has no leadId)', /data-ccp="suggest"[^>]*data-lead="SOLO"[^>]*>File on Pat Solo</.test(solo) && /this number is already on them/.test(solo), solo.slice(0, 300));
    ok('...and it says what filing sets: "Reminder: Send the estimate (Pat) · due Oct 23"', /Reminder: Send the estimate \(Pat\) · due Oct 23/.test(solo));
    ok('control: a call with no promise and no follow-up date shows no reminder line', /File on Pat Solo/.test(card('c_solo_plain')) && !/Reminder:/.test(card('c_solo_plain')));
    ok('control: a call older than 14 days still offers the customer but promises no reminder (the server makes none)', /File on Pat Solo/.test(card('c_old')) && !/Reminder:/.test(card('c_old')));
    ok('control: a call already filed shows no suggestion row at all', !/cc-suggest/.test(card('c_filed')));
    const couple = card('c_couple');
    ok('two customers on the number: the card asks "which one?" and offers BOTH, one button each', /This number is on <b>2 customers<\/b> — which one\?/.test(couple) && /data-lead="COUP1"[^>]*>File on Jo Couple</.test(couple) && /data-lead="COUP2"[^>]*>File on Sam Couple</.test(couple), couple.slice(0, 400));
    ok('...and never picks the first for you (no "Looks like" line on a shared number)', !/Looks like/.test(couple));
    ok('...with the follow-up date shown as the reminder it will set', /Reminder: Follow up with The Couples · due Oct 25/.test(couple));
    ok('the screen helpers agree: fileTarget is null for a shared number, fileChoices lists both', CC._fileTarget({ id: 'c_couple', phoneDigits: '5135550301' }) === null && CC._fileChoices({ id: 'c_couple', phoneDigits: '5135550301' }).length === 2);
    ok('control: a relay line (3 customers) suggests nobody', !/cc-suggest/.test(card('c_relay').replace(/cc-suggest-btn/g, '')) || (!/File on R1/.test(card('c_relay')) && !/File on R2/.test(card('c_relay'))), card('c_relay').slice(0, 200));
    ok('control: an unknown number suggests nobody', !/File on /.test(card('c_unknown')));

    // tapping: the right customer goes to the server, nothing else is called
    calls.length = 0;
    await Promise.all(listeners.click.map((f) => f({ target: button({ 'data-ccp': 'suggest', 'data-id': 'c_couple', 'data-lead': 'COUP2', 'data-name': 'Sam Couple' }) })));
    await flush();
    ok('tapping "File on Sam Couple" sends ONE attach for that customer and nothing else', calls.length === 1 && calls[0].name === 'callCenterAction' && calls[0].data.action === 'attach' && calls[0].data.id === 'c_couple' && calls[0].data.leadId === 'COUP2', JSON.stringify(calls));
    ok('...and the status line says where it went and which reminder was set', /Filed on Sam Couple\./.test(slots['c_couple'] || '') && /Reminder: Follow up with The Couples · due Oct 25/.test(slots['c_couple'] || ''), slots['c_couple']);
    ok('nothing was sent to a customer: the only server action in this flow is "attach"', calls.every((c) => c.data.action === 'attach'));
    CC.setFilter('all');
    ok('after filing, that card no longer offers the choice', !/which one\?/.test(card('c_couple')));
  }

  console.log('\n4. wiring');
  {
    const view = read('docs/pro/js/call-center-view.js'), loader = read('docs/pro/js/script-loader.js'), logic = read('docs/pro/js/call-center-loop-logic.js');
    ok('the loop module loads before the view in the lazy callcenter bundle', /call-center-loop-logic\.js\?v=1',\s*'js\/call-center-view\.js/.test(loader));
    ok('the pure module never writes or sends (no fetch / callable / Firestore / storage)', !/fetch\(|httpsCallable|_httpsCallable|setDoc|addDoc|localStorage|XMLHttpRequest/.test(logic));
    ok('the view still works without the module (guarded)', /var LP = window\.NBDCallCenterLoop;\s*if \(!LP\) \{ var o = leadForNumber/.test(view) && /if \(!LP \|\| !c\) return '';/.test(view));
    ok('no inline handlers or styles in the new markup (CSP)', !/cc-suggest-many[^>]*(onclick|style=)/.test(view) && !/cc-suggest-note[^>]*(onclick|style=)/.test(view));
    ok('the deck no longer takes the first of two matches', /numberMatch\(anchor\.phoneDigits\)\.one/.test(view) && !/anchor \? leadForNumber\(anchor\.phoneDigits\)/.test(view));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
