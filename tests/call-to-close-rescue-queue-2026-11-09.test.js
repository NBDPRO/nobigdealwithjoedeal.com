/**
 * tests/call-to-close-rescue-queue-2026-11-09.test.js — Call to Close P1: the
 * lost-lead rescue queue ("Needs a next step" on the Call Center).
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §6 #7
 * ("A business call with no promise, follow-up or next stage surfaces after
 * 2 days"), §9 P1.
 *
 *   1. the rule (docs/pro/js/call-rescue-logic.js, pure): a noted business call
 *      on a customer, 2+ days old, with no promise (the notes' promises, a
 *      captured promise, a promise task), no follow-up date (the call's or a
 *      customer follow-up on or after the call) and no stage move since the
 *      call, and not dismissed. One row per customer (their newest contact);
 *      a later call or text from the same customer means it is not lost.
 *      Never a personal / spam / supplier / sub call, a text, a closed
 *      customer, a deleted customer, or a call older than the 30-day window.
 *      The count is the list's length: nothing is invented.
 *   2. the dismiss: callCenterAction 'rescueDismiss' / 'rescueUndismiss'
 *      records it on the call (rescueDismissedAtMs / By), with the same role
 *      test as every callCenterAction (viewer and other tenants refused)
 *   3. the view (call-center-view.js): a "Needs a next step" tab counted from
 *      the calls already loaded (no new query), hidden for a viewer, each row
 *      with one-tap Brief (only when the brief gate says draft), Follow-up
 *      (the existing promise sheet) and Dismiss (callCenterAction); the
 *      logic is fetched when the Call Center opens, never at boot
 *
 * Run: node tests/call-to-close-rescue-queue-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}

const DAY = 86400000;
const NOW = Date.parse('2026-11-09T17:00:00Z');
const base = (over) => Object.assign({ id: 'cube_R1', channel: 'call', status: 'noted', callType: 'customer', leadId: 'L1', userId: 'jo', companyId: 'co1',
  startedAtMs: NOW - 3 * DAY, promises: [], followUpDate: null, summary: 'Asked about a roof.' }, over || {});
const LEADS = { L1: { id: 'L1', firstName: 'Pat', stage: 'new' }, L2: { id: 'L2', firstName: 'Sam', stage: 'new' } };

(async () => {
  console.log('\n1. The rule');
  const R = exists('docs/pro/js/call-rescue-logic.js') ? require(path.join(ROOT, 'docs/pro/js/call-rescue-logic.js')) : null;
  ok('docs/pro/js/call-rescue-logic.js exists and exports list()', !!R && typeof R.list === 'function');
  if (R) {
    const list = (calls, leads, o) => R.list(calls, leads || LEADS, Object.assign({ nowMs: NOW }, o || {}));
    ok('a 3-day-old customer call with no next step → listed', list([base()]).length === 1 && list([base()])[0].call.id === 'cube_R1');
    ok('a 1-day-old call → not yet (2 days first)', list([base({ startedAtMs: NOW - 1 * DAY })]).length === 0);
    ok('exactly 2 days old → listed', list([base({ startedAtMs: NOW - 2 * DAY })]).length === 1);
    ok('older than the 30-day window → not listed', list([base({ startedAtMs: NOW - 31 * DAY })]).length === 0);
    ok('the notes heard a promise → not listed', list([base({ promises: [{ who: 'jo', text: 'Send the estimate' }] })]).length === 0);
    ok('a promise was captured on the call (promiseTaskId) → not listed', list([base({ promiseTaskId: 'promise-cube_R1' })]).length === 0);
    ok('a promise rides on the call (promise) → not listed', list([base({ promise: { kind: 'promise', dueDate: '2026-11-20' } })]).length === 0);
    ok('the call has a follow-up date → not listed', list([base({ followUpDate: '2026-11-12' })]).length === 0);
    ok('the customer has a follow-up on or after the call → not listed', list([base()], { L1: { id: 'L1', stage: 'new', followUp: '2026-11-07' } }).length === 0);
    ok('…a follow-up from before the call does not count', list([base()], { L1: { id: 'L1', stage: 'new', followUp: '2026-10-01' } }).length === 1);
    ok('the customer\'s stage moved after the call (stageStartedAt) → not listed', list([base()], { L1: { id: 'L1', stage: 'inspected', stageStartedAt: { seconds: Math.floor((NOW - DAY) / 1000) } } }).length === 0);
    ok('…a stage move from before the call does not count', list([base()], { L1: { id: 'L1', stage: 'inspected', stageStartedAt: { toMillis: () => NOW - 10 * DAY } } }).length === 1);
    ok('a closed customer (the page says so) → not listed', list([base()], LEADS, { isClosed: (l) => l.id === 'L1' }).length === 0);
    ok('a deleted customer → not listed', list([base()], { L1: { id: 'L1', deleted: true } }).length === 0);
    ok('a customer not loaded on this page → not listed (nothing guessed)', list([base({ leadId: 'L9' })]).length === 0);
    ok('a call on no customer → not here (it is already on Needs attention)', list([base({ leadId: null })]).length === 0);
    for (const t of ['personal', 'spam', 'supplier', 'sub']) ok('a ' + t + ' call → not listed', list([base({ callType: t })]).length === 0);
    ok('a call with no notes yet (no callType) → not listed', list([base({ callType: null })]).length === 0);
    ok('a short / stored call → not listed', list([base({ status: 'short' })]).length === 0 && list([base({ status: 'stored' })]).length === 0);
    ok('a day of texts is never itself a row', list([base({ channel: 'text', id: 'txt_1' })]).length === 0);
    ok('insurance, lead and other calls on a customer are business calls → listed', ['insurance', 'lead', 'other'].every((t) => list([base({ callType: t })]).length === 1));
    ok('dismissed → not listed', list([base({ rescueDismissedAtMs: NOW - DAY })]).length === 0);
    const newer = base({ id: 'cube_R2', startedAtMs: NOW - 1 * DAY });
    ok('a newer call from the same customer → the older one is not lost', list([newer, base()]).length === 0);
    ok('a newer text day with the same customer → not lost either', list([base({ id: 'txt_9', channel: 'text', startedAtMs: NOW - DAY }), base()]).length === 0);
    const two = list([base(), base({ id: 'cube_R3', leadId: 'L2', startedAtMs: NOW - 4 * DAY })]);
    ok('one row per customer, newest call first', two.length === 2 && two[0].call.id === 'cube_R1' && two[1].call.id === 'cube_R3');
    ok('each row says how many days it has waited', two[0].days === 3 && two[1].days === 4, two.map((x) => x.days));
    const many = [];
    for (let i = 0; i < 40; i++) many.push(base({ id: 'cube_M' + i, leadId: 'M' + i, startedAtMs: NOW - (3 + (i % 20)) * DAY }));
    const ml = {}; for (let i = 0; i < 40; i++) ml['M' + i] = { id: 'M' + i, stage: 'new' };
    ok('the count is the list: 40 lost customers → 40 rows (no cap, no invented total)', list(many, ml).length === 40);
    ok('pure: no DOM, no network (require()-able, no window use at load)', !/document\.|fetch\(|getDocs|httpsCallable/.test(read('docs/pro/js/call-rescue-logic.js')));
  }

  console.log('\n2. The dismiss (callCenterAction)');
  {
    const M = require(path.join(ROOT, 'functions', 'call-center.js'));
    const { callAction, COLLECTION } = M._test;
    const docs = new Map();
    const mk = (p) => ({ get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }), set: async (v, o) => { docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); } });
    const db = { doc: mk, collection: (n) => ({ doc: (id) => mk(n + '/' + id) }) };
    const ID = 'cube_RESCUE01';
    docs.set(COLLECTION + '/' + ID, { userId: 'jo', companyId: 'co1', status: 'noted', leadId: 'L1', callType: 'customer' });
    const run = async (auth, data) => { try { return { r: await callAction({ db, auth, data: Object.assign({ id: ID }, data), nowMs: NOW }) }; } catch (e) { return { e }; } };
    const d1 = await run({ uid: 'jo', token: {} }, { action: 'rescueDismiss' });
    const c1 = docs.get(COLLECTION + '/' + ID);
    ok('rescueDismiss records rescueDismissedAtMs + By on the call', d1.r && d1.r.ok === true && c1.rescueDismissedAtMs === NOW && c1.rescueDismissedBy === 'jo', d1.e && d1.e.message);
    ok('…and changes nothing else (not handled, no task, no stage)', c1.handledAtMs === undefined && Object.keys(c1).filter((k) => /^rescue/.test(k)).length === 2);
    const d2 = await run({ uid: 'jo', token: {} }, { action: 'rescueUndismiss' });
    ok('rescueUndismiss puts it back', d2.r && docs.get(COLLECTION + '/' + ID).rescueDismissedAtMs === null);
    const v = await run({ uid: 'v', token: { role: 'viewer', companyId: 'co1' } }, { action: 'rescueDismiss' });
    ok('a viewer is refused', v.e && v.e.code === 'permission-denied');
    const rep = await run({ uid: 'rep', token: { role: 'sales_rep', companyId: 'co1' } }, { action: 'rescueDismiss' });
    ok('a sales rep who does not own the call is refused', rep.e && rep.e.code === 'permission-denied');
    const other = await run({ uid: 'x', token: { role: 'company_admin', companyId: 'co2' } }, { action: 'rescueDismiss' });
    ok('another tenant is refused', other.e && other.e.code === 'permission-denied');
    const mgr = await run({ uid: 'mg', token: { role: 'manager', companyId: 'co1' } }, { action: 'rescueDismiss' });
    ok('a same-company manager may dismiss', mgr.r && mgr.r.ok === true);
    // The list never shows a day of texts, so the action takes calls only.
    const TXT = 'txt_5135550100_20261105';
    docs.set('phone_text_days/' + TXT, { userId: 'jo', companyId: 'co1', status: 'noted', leadId: 'L1', channel: 'text' });
    const tx = await run({ uid: 'jo', token: {} }, { id: TXT, action: 'rescueDismiss' });
    ok('a day of texts (txt_ id) is refused and not written', tx.e && tx.e.code === 'invalid-argument' && docs.get('phone_text_days/' + TXT).rescueDismissedAtMs === undefined, tx.e ? tx.e.message : tx.r);
  }

  console.log('\n3. The view');
  {
    const cv = read('docs/pro/js/call-center-view.js');
    const sl = read('docs/pro/js/script-loader.js');
    ok('the logic is fetched lazily when the Call Center opens (ScriptLoader.load from init), not added to any page or bundle', /init: function \(\) \{[^}]*loadRescue\(\)/.test(cv) && /ScriptLoader\.load\('\/pro\/js\/call-rescue-logic\.js\?v=1'\)/.test(cv) && !/call-rescue-logic/.test(sl));
    ok('no <script> tag for it in dashboard.html or customer.html', !/call-rescue-logic/.test(read('docs/pro/dashboard.html')) && !/call-rescue-logic/.test(read('docs/pro/customer.html')));
    ok('a "Needs a next step" tab', /\['rescue', 'Needs a next step'/.test(cv));
    ok('…hidden for a viewer', /function rescueOn\(\) \{[^}]*isViewer\(\)/.test(cv));
    ok('…counted from the calls already loaded (NBDCallRescue.list over state.calls, no new query)', /NBDCallRescue\.list\(state\.calls/.test(cv) && !/where\('rescueDismissedAtMs'/.test(cv));
    ok('each row: Brief only when the brief gate says draft', /rescueRow[\s\S]*?briefGate\(c\) === 'draft'[\s\S]*?data-cc="brief"/.test(cv));
    ok('each row: Follow-up opens the existing promise sheet (data-cc="promise")', /rescueRow[\s\S]*?data-cc="promise"[\s\S]*?Follow-up/.test(cv));
    ok('each row: Dismiss goes through callCenterAction rescueDismiss', /data-cc="rescuedismiss"/.test(cv) && /act\(id, 'rescueDismiss'\)/.test(cv));
    ok('a dismiss is mirrored on the loaded call and offers Undo', /action === 'rescueDismiss'/.test(cv) && /rescueUndismiss/.test(cv));
    const rows = (cv.match(/function rescueRow[\s\S]*?\n  \}\n/) || [''])[0];
    ok('rows escape every string and carry no inline style or handler', rows.length > 0 && !/style=|\son[a-z]+=/.test(rows) && /esc\(/.test(rows));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
