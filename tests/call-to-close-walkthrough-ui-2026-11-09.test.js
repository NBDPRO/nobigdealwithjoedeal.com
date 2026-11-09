/**
 * tests/call-to-close-walkthrough-ui-2026-11-09.test.js — Call to Close P2,
 * lane "walkthrough", the client half: "Brief this walkthrough" on a visit
 * row of the customer's timeline opens the SAME Call Brief sheet.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §4, §6 #11.
 *
 *   1. the gate (call-timeline.js fromActivity): a filed visit with notes, not
 *      personal, not failed; the recorder, a same-company company_admin /
 *      manager, or a platform admin. Never a viewer, never another rep
 *      (= functions/call-brief-logic.js canActOnVisit + visitBriefProblem)
 *   2. the button: customer-bootstrap.module.js renders it only on such a row,
 *      every value escaped, through the page's data-action delegate (no inline
 *      handler); a tap lazy-loads call-brief-ui.js (no new <script> tag)
 *   3. the sheet in walkthrough mode: callBrief / callBriefDecide get
 *      { visitId, visitUid } (never a callId); no "This call" / handled, no
 *      promise Add (a walkthrough's promises are already tasks); wording says
 *      walkthrough; the proposal's list says "From the walkthrough" and holds
 *      the grounded scope facts; Start estimate hands over visit_<visitId>;
 *      a stage move logs with the visit ids; nothing pre-ticked
 *
 * Run: node tests/call-to-close-walkthrough-ui-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('docs/pro/js/call-brief-ui.js');
const TL = read('docs/pro/js/call-timeline.js');
const BOOT = read('docs/pro/js/customer-bootstrap.module.js');
const L = require(path.join(ROOT, 'functions', 'call-brief-logic.js'));

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail)) : '')); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── call-timeline.js in a vm, with a window ──────────────────────────────
function timeline(win) {
  const ctx = vm.createContext({ window: win || {}, console, Promise });
  vm.runInContext(TL, ctx);
  return (win || ctx.window).NBDCallTimeline;
}
const ROW = { type: 'visit', label: 'Visit recording', summary: 'Walked the roof.', visitId: 'vWalk0000001', visitUid: 'jo', companyId: 'co1', durationSec: 1200, startedAtMs: Date.parse('2026-11-05T15:00:00Z'), visitType: 'inspection', notesPending: false, notesFailed: false, processingFailed: false };
const ID = 'visit-vWalk0000001';

// ── the sheet in a vm (the call-brief-ui suite's harness) ────────────────
function load(answer) {
  const listeners = {};
  const dlgEl = {
    className: '', innerHTML: '', open: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'open') this.open = false; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    showModal() { this.open = true; }, close() { this.open = false; (listeners.close || []).forEach((f) => f()); },
    contains() { return true; }, querySelector() { return null; },
  };
  const body = { kids: [], appendChild(x) { this.kids.push(x); }, contains(x) { return this.kids.includes(x); } };
  const calls = [];
  const store = {};
  const win = {
    ScriptLoader: { load: async () => {}, loadBundle: async () => {} },
    _functions: {}, _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: name === 'callBrief' ? clone(answer || {}) : { ok: true } }; },
    auth: { currentUser: { uid: 'jo' } },
    sessionStorage: { setItem: (k, v) => { store[k] = v; } },
    location: { href: '' },
  };
  const ctx = vm.createContext({ window: win, document: { createElement: () => dlgEl, body, querySelector: () => null }, console, setTimeout, Date, Event: function () {} });
  vm.runInContext(SRC, ctx);
  const click = async (attrs) => {
    const b = { disabled: false, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: () => b };
    for (const fn of listeners.click) fn({ target: b });
    await new Promise((r) => setTimeout(r, 5));
  };
  return { CB: win.NBDCallBrief, dlg: dlgEl, calls, win, store, click };
}
const BRIEF = {
  v: 1, transcriptOk: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'Walked the roof: hail, two layers.', quotes: ['The chimney flashing is pulling away'], inferred: false },
  fields: { insCarrier: { value: 'State Farm', quote: 'My insurance is State Farm', conf: 'said' }, claimNumber: null, dateOfLoss: null, adjusterName: null, adjusterMeetingYmd: null, damageType: { value: 'hail', quote: 'from the hail', conf: 'said' }, jobType: null, workKind: null },
  scope: { service: null, tierInterest: null, stories: { value: 2, quote: 'two stories' }, layers: { value: 2, quote: 'two layers of shingles' },
    mentions: { gutters: true, chimney: true, skylight: false, decking: false }, saidQuantities: [{ text: 'about twenty-eight squares', quote: 'about twenty-eight squares' }],
    visitFacts: [{ text: 'two stories', quote: 'two stories' }, { text: 'The chimney flashing is pulling away', quote: 'The chimney flashing is pulling away' }, { text: 'about twenty-eight squares', quote: 'about twenty-eight squares' }] },
  promises: [{ who: 'jo', text: 'Send the estimate', kind: 'estimate', dueSpoken: 'by Friday', dueYmd: '2026-11-06', quote: 'I will send you the estimate by Friday' }],
  followUp: null,
  stage: { targetKey: 'inspected', label: 'Inspected', role: 'active', reason: 'The roof was walked.', quote: 'we are up on the roof now' },
  drafts: { estimate: true, proposal: false, followUp: null },
  flags: { injection: false, unreliable: false, cutOff: false }, people: [], objections: [], competitor: null,
};
const LEAD = { firstName: 'Pat', lastName: 'Example', insCarrier: '', damageType: '', scopeOfWork: '' };
const OPEN = { visitId: 'vWalk0000001', visitUid: 'jo', visit: { startedAtMs: ROW.startedAtMs, durationSec: 1200 }, lead: LEAD, leadId: 'L1', page: 'customer' };

(async () => {
  console.log('\n1. The gate on a visit row');
  {
    const T = timeline({});
    const who = (role, uid, companyId) => ({ uid, role: role || '', companyId: companyId || '' });
    const vb = (row, w) => { const r = T.fromActivity(ID, Object.assign({}, ROW, row || {}), w); return r && r.visitBrief; };
    ok('the recorder → the row carries visitBrief { visitId, visitUid }', JSON.stringify(vb({}, who('', 'jo'))) === JSON.stringify({ visitId: 'vWalk0000001', visitUid: 'jo' }), vb({}, who('', 'jo')));
    ok('a same-company company_admin / manager → yes', !!vb({}, who('company_admin', 'ca', 'co1')) && !!vb({}, who('manager', 'mg', 'co1')));
    ok('a platform admin → yes', !!vb({}, who('admin', 'adm')));
    ok('a viewer → no (even the recorder)', !vb({}, who('viewer', 'v', 'co1')) && !vb({}, who('viewer', 'jo', 'co1')));
    ok('another rep of the company → no', !vb({}, who('sales_rep', 'rep', 'co1')));
    ok('another company\'s manager → no', !vb({}, who('manager', 'm2', 'co2')));
    ok('notes still pending → no', !vb({ notesPending: true }, who('', 'jo')));
    ok('notes failed → no (the server needs notes)', !vb({ notesFailed: true }, who('', 'jo')));
    ok('a failed recording → no', !vb({ processingFailed: true }, who('', 'jo')));
    ok('personal → no', !vb({ visitType: 'personal' }, who('', 'jo')));
    ok('no visit type (no notes) → no', !vb({ visitType: null }, who('', 'jo')));
    ok('a bad visit id / owner → no', !vb({ visitId: '../x' }, who('', 'jo')) && !vb({ visitUid: 'a/b' }, who('', 'jo')));
    ok('the row itself is unchanged otherwise (title, kind, summary)', T.fromActivity(ID, ROW, who('', 'jo')).kind === 'visit' && /Visit recording/.test(T.fromActivity(ID, ROW, who('', 'jo')).title));
    // The same rule as the server, case by case.
    const pairs = [[who('', 'jo')], [who('company_admin', 'ca', 'co1')], [who('manager', 'mg', 'co1')], [who('admin', 'adm')], [who('viewer', 'jo', 'co1')], [who('sales_rep', 'rep', 'co1')], [who('manager', 'm2', 'co2')]];
    const agree = pairs.every(([w]) => !!vb({}, w) === L.canActOnVisit({ uid: w.uid, token: { role: w.role, companyId: w.companyId } }, { ownerUid: 'jo', companyId: 'co1' }));
    ok('the client gate agrees with the server\'s canActOnVisit', agree);
    const T2 = timeline({ _userClaims: { role: 'manager', companyId: 'co1' }, auth: { currentUser: { uid: 'mg' } } });
    ok('with no who passed, the page\'s own claims and user decide', !!(T2.fromActivity(ID, ROW) || {}).visitBrief && !(timeline({ _userClaims: { role: 'viewer', companyId: 'co1' }, auth: { currentUser: { uid: 'jo' } } }).fromActivity(ID, ROW) || {}).visitBrief);
  }

  console.log('\n2. The button and the lazy load');
  {
    ok('the timeline renders "Brief this walkthrough" only for a row with visitBrief', /item\.visitBrief \?/.test(BOOT) && /Brief this walkthrough/.test(BOOT));
    ok('…through the page\'s data-action delegate with escaped ids (no inline handler)', /data-action="nbdVisitBrief" data-arg="\$\{esc\(item\.visitBrief\.visitId\)\}" data-arg2="\$\{esc\(item\.visitBrief\.visitUid\)\}"/.test(BOOT) && !/onclick/i.test(BOOT.split('Brief this walkthrough')[0].slice(-400)));
    const loads = []; const opened = [];
    const win = { ScriptLoader: { load: async (u) => { loads.push(u); win.NBDCallBrief = { openVisit: (o) => opened.push(o) }; } }, _leadDoc: { firstName: 'Pat' }, _customerId: 'L1' };
    timeline(win);
    ok('call-timeline.js defines window.nbdVisitBrief', typeof win.nbdVisitBrief === 'function');
    if (typeof win.nbdVisitBrief === 'function') {
      await win.nbdVisitBrief('vWalk0000001', 'jo');
      await new Promise((r) => setTimeout(r, 5));
      ok('a tap lazy-loads call-brief-ui.js through ScriptLoader', loads.length === 1 && /^\/pro\/js\/call-brief-ui\.js\?v=\d+$/.test(loads[0]), loads);
      ok('…then opens the walkthrough sheet for this customer', opened.length === 1 && opened[0].visitId === 'vWalk0000001' && opened[0].visitUid === 'jo' && opened[0].leadId === 'L1' && opened[0].page === 'customer' && opened[0].lead.firstName === 'Pat', opened);
    }
    for (const page of ['docs/pro/customer.html', 'docs/pro/dashboard.html']) ok(page + ' has no <script> tag for the sheet', !/<script[^>]+call-brief-ui\.js/.test(read(page)));
    const ver = (/call-brief-ui\.js\?v=(\d+)/.exec(TL) || [])[1];
    ok('the timeline loads the same sheet version as the call cards', ver && read('docs/pro/js/customer-calls.js').includes('call-brief-ui.js?v=' + ver), ver);
  }

  console.log('\n3. The sheet in walkthrough mode');
  {
    const { CB, dlg, calls, store, win, click } = load({ brief: clone(BRIEF), generatedAtMs: 1, decisions: [] });
    ok('NBDCallBrief.openVisit exists', typeof CB.openVisit === 'function');
    if (typeof CB.openVisit !== 'function') { finish(); return; }
    await CB.openVisit(clone(OPEN));
    const cb = calls.find((c) => c.name === 'callBrief');
    ok('callBrief gets { visitId, visitUid } and no callId', cb && cb.data.visitId === 'vWalk0000001' && cb.data.visitUid === 'jo' && !('callId' in cb.data), cb);
    const html = dlg.innerHTML;
    ok('the header says walkthrough', /From this walkthrough: Pat Example/.test(html), html.slice(0, 300));
    ok('no "This call" / Mark handled section', !/cbHandH|Mark handled/.test(html));
    ok('no promise Add or who toggle (a walkthrough\'s promises are already tasks)', !/data-cb-act="promise"|data-cb-act="who"/.test(html) && /already tasks on this customer/.test(html));
    ok('nothing pre-ticked: no checked box, no done / skipped row', !/\schecked[\s>=]/.test(html) && !/cb-done|cb-skipped/.test(html));
    ok('the field diff still asks Accept per field', (html.match(/data-cb-act="accept"/g) || []).length === 2);
    ok('the proposal list says "From the walkthrough" and lists the grounded facts', /From the walkthrough/.test(html) && /The chimney flashing is pulling away/.test(html) && !/From the call/.test(html));
    ok('…each fact once (the said quantity is not listed twice)', (html.match(/about twenty-eight squares/g) || []).length === 1, (html.match(/about twenty-eight squares/g) || []).length);
    ok('every word from the recording is escaped', !/<script|onerror/i.test(html));
    calls.length = 0;
    await click({ 'data-cb-act': 'skip', 'data-k': 'damageType' });
    const d = calls.find((c) => c.name === 'callBriefDecide');
    ok('a decision goes to callBriefDecide with the visit ids, never a callId', d && d.data.visitId === 'vWalk0000001' && d.data.visitUid === 'jo' && !('callId' in d.data) && d.data.item === 'field:damageType', d);
    calls.length = 0;
    await click({ 'data-cb-act': 'estimate' });
    const est = calls.find((c) => c.name === 'callBriefDecide');
    ok('Start estimate logs with the visit ids', est && est.data.item === 'draft:estimate' && est.data.visitId === 'vWalk0000001');
    const link = JSON.parse(store['nbd.callBriefLink'] || 'null');
    ok('…and hands the builder the brief under visit_<visitId> (the prefill reads stories / layers from it)', link && link.callId === 'visit_vWalk0000001' && link.brief.scope.stories.value === 2 && /callBrief=visit_vWalk0000001/.test(win.location.href), link);
  }
  {
    const { CB, calls, win, click } = load({ brief: clone(BRIEF), generatedAtMs: 1, decisions: [] });
    win._currentStage = 'contacted';
    win.progressStage = async function (target, opts) { win._moved = target; return true; };
    win.NBDCallToClose = { stagePlan: () => ({ kind: 'confirm', key: 'inspected', why: 'Inspected orders a measurement.' }), tenantStageOrders: () => [] };
    await CB.openVisit(clone(OPEN));
    await click({ 'data-cb-act': 'stage-ask' });
    calls.length = 0;
    await click({ 'data-cb-act': 'stage-yes' });
    await new Promise((r) => setTimeout(r, 10));
    const st = calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'stage');
    ok('a confirmed stage move is logged with the visit ids', win._moved === 'inspected' && st && st.data.visitId === 'vWalk0000001' && st.data.visitUid === 'jo' && !('callId' in st.data) && st.data.mode === 'confirmed', st);
  }
  {
    const { CB } = load();
    const dr = CB._followUpDraft([{ kind: 'followUp', ymd: '2026-11-10' }], { firstName: 'Pat', phone: '5135550100' }, 'Example Roofing', 'visit');
    ok('the follow-up message thanks them for the visit, not a call', dr && /thanks for having us out/i.test(dr.text) && !/the call/i.test(dr.text) && /Thanks for having us out/.test(dr.body), dr);
    const dc = CB._followUpDraft([{ kind: 'followUp', ymd: '2026-11-10' }], { firstName: 'Pat', phone: '5135550100' }, 'Example Roofing');
    ok('…a call\'s message is unchanged', dc && /thanks for the call/.test(dc.text));
    ok('CSP: no inline handler or style added to the sheet', !/\son[a-z]+=/i.test(SRC) && !/style="/.test(SRC));
  }
  finish();

  function finish() {
    console.log('\n' + passed + ' passed, ' + failed + ' failed');
    if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
  }
})().catch((e) => { console.error(e); process.exit(1); });
