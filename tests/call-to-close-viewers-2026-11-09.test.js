/**
 * tests/call-to-close-viewers-2026-11-09.test.js — Call to Close Q11, the
 * rest (Jo, 2026-11-09: "close all four"). A viewer sees no call or text
 * content anywhere:
 *
 *   1. thursday_calls: every client reader skips it for a viewer (the
 *      customer card, its timeline, the Thursday widget, Thursday-handled).
 *   2. phone_texts / phone_text_days: skipped for a viewer (Call Center,
 *      Inbox, Home strip, customer card), with the quiet "hidden for your
 *      role" note instead of "Could not load".
 *   3. Call / text summaries copied onto a customer: the customer page reads
 *      a viewer's activity through a query for the only sources the rule lets
 *      a viewer read, 'rep' and 'visit-capture' (proven in
 *      tests/firestore-rules.call-content-viewers.test.js), and the follow-up
 *      task the Call Center files no longer copies the AI summary (a task is
 *      readable by every role that reads the customer); a move scrubs an old
 *      task's copy as it goes.
 *   4. "Brief me": a viewer's brief carries no CALL / TEXTS / THURSDAY /
 *      PROMISE line, and never reads or writes the shared cache (which was
 *      built from them).
 *
 * Runs the real client functions against stubbed Firestore and the real
 * server modules with stubs; zero network. Run:
 *   node tests/call-to-close-viewers-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : '')); }
}
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
function slicer(SRC) {
  const EOL = SRC.includes('\r\n') ? '\r\n' : '\n';
  return function (start, end) {
    const s = SRC.indexOf(start);
    if (s < 0) return '';
    const e = SRC.indexOf(end.replace(/\n/g, EOL), s);
    return e < 0 ? '' : SRC.slice(s, e + end.length + (EOL.length - 1) * (end.split('\n').length - 1));
  };
}
const VIEWER_OK = ['rep', 'visit-capture'];

// A stub window with a Firestore that records every read.
function stubWin(role, queries, opts) {
  opts = opts || {};
  const win = {
    db: {}, auth: { currentUser: { uid: 'u1' } }, _user: { uid: 'u1' }, _leadDoc: { phone: '5550101000' },
    _userClaims: opts.late ? undefined : { role, companyId: 'co' },
    where: (f, op, v) => ({ f, op, v }), orderBy: () => ({}), limit: () => ({}),
    collection: (db, ...p) => ({ col: p.join('/') }),
    query: (c, ...fs) => ({ col: c.col, filters: fs.filter((x) => x && x.f) }),
    getDocs: async (q) => {
      queries.push(q);
      if (opts.late) win._userClaims = { role, companyId: 'co' };
      if (role === 'viewer' && /^(thursday_calls|phone_texts|phone_text_days|phone_calls)$/.test(q.col)) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; }
      return { docs: [] };
    },
  };
  return win;
}
const cols = (qs) => qs.map((q) => q.col);

(async () => {
  // ── 2. Call Center (call-center-view.js): texts ────────────────────────
  console.log('CALL CENTER (call-center-view.js)');
  const CCV = read('docs/pro/js/call-center-view.js');
  const FETCH_FROM = slicer(CCV)('  async function fetchFrom(name, channel) {', '\n  }\n');
  async function runCcv(role, late) {
    const queries = [];
    const win = stubWin(role, queries, { late });
    const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Object, Date, Infinity,
      state: { readFailed: [], error: '', cappedBefore: 0 }, LIMIT: 300, PROMISE_WINDOW_MS: 1,
      claims: () => win._userClaims || {}, isViewer: () => (win._userClaims || {}).role === 'viewer' };
    vm.createContext(sb);
    vm.runInContext(FETCH_FROM + '\nglobalThis.__f = fetchFrom;', sb);
    const texts = await sb.__f('phone_text_days', 'text');
    return { texts, queries, state: sb.state };
  }
  ok('fetchFrom is found (positive control)', /async function fetchFrom/.test(FETCH_FROM));
  {
    const v = await runCcv('viewer');
    ok('a viewer issues NO phone_text_days read', !cols(v.queries).includes('phone_text_days'), cols(v.queries).join(','));
    ok('…and sees no "Could not load your texts" banner', v.state.readFailed.length === 0 && !v.state.error, JSON.stringify(v.state));
    const m = await runCcv('manager');
    ok('a manager still reads phone_text_days by userId and companyId', m.queries.filter((q) => q.col === 'phone_text_days').length === 2);
    const s = await runCcv('');
    ok('a solo owner (no role) still reads own phone_text_days', s.queries.some((q) => q.col === 'phone_text_days'));
    const lv = await runCcv('viewer', true);
    ok('late claims: a texts read sent before the claims is denied without a "Could not load" banner', lv.queries.length > 0 && lv.state.readFailed.length === 0 && !lv.state.error, JSON.stringify(lv.state));
  }
  ok('the Call Center says "Calls and texts are hidden for your role." to a viewer', /isViewer\(\)\) body = '<div class="cc-empty cc-hidden-note" role="status">Calls and texts are hidden for your role\.<\/div>'/.test(CCV));
  ok('…and no longer says "Texts still show"', !/Texts still show/.test(CCV));
  // Final round (2026-11-09): at 375px the viewer's note sat below the search box,
  // 13 category tabs and the filter chips, all at 0. With nothing to search or
  // filter, a viewer gets the note without the toolbar.
  {
    const RENDER = slicer(CCV)('  function renderList() {', '\n  }\n');
    ok('renderList is found (positive control)', /function renderList\(\)/.test(RENDER));
    function runRender(role, calls) {
      const el = { innerHTML: '' };
      const win = { _userClaims: { role } };
      const sb = { window: win, document: { getElementById: () => null, activeElement: null }, Object, String, Number,
        root: () => el, leadsById: () => ({}), FX: null, flt: {}, FILTERS: [['all', 'All', () => true]],
        filtersNow: () => [['all', 'All', () => true], ['attention', 'Needs attention', () => true]],
        groupNeeds: () => [], matchesSearch: () => true, healthPanel: () => '', tagPanel: () => '', autoBriefPanel: () => '',
        esc: (s) => String(s), promises: { items: [], loaded: false }, readProblems: () => [], capBanner: () => '', readBanner: () => '',
        focusKeyOf: () => '', focusedCard() {}, a11yPass() {}, restoreFocus() {}, renderCall: () => '<div class="cc-card"></div>',
        groupPromises: () => [], isViewer: () => role === 'viewer', filterBar: () => '<div class="cc-fbar"></div>',
        state: { loaded: true, error: '', calls, filter: 'all', q: '', busy: {}, cappedBefore: 0, refocus: '' } };
      vm.createContext(sb);
      vm.runInContext(RENDER + '\nglobalThis.__r = renderList;', sb);
      sb.__r();
      return el.innerHTML;
    }
    const v = runRender('viewer', []);
    ok('Call Center, viewer: the hidden-for-your-role note shows', /cc-hidden-note/.test(v), v);
    ok('…with no search box, category tabs or filter chips above it', !/cc-toolbar|ccSearch|role="tab"|cc-fbar/.test(v), v);
    ok('…and the panel names no tab it is labelled by', !/aria-labelledby="ccTab-/.test(v), v);
    const m = runRender('manager', []);
    ok('Call Center, manager with no calls: the toolbar still shows (positive control)', /cc-toolbar/.test(m) && /role="tab"/.test(m) && /aria-labelledby="ccTab-all"/.test(m), m);
  }

  // ── 1 + 2. Customer card (customer-calls.js) ───────────────────────────
  console.log('CUSTOMER CARD (customer-calls.js)');
  const CC = read('docs/pro/js/customer-calls.js');
  const ccs = slicer(CC);
  const SRC_CC = ccs('  function leadDigits() {', '\n  }') + '\n' + ccs('  async function fetchCalls(leadId) {', '\n  }') + '\n' +
    ccs('  function callTime(c) {', '\n  }') + '\n' + ccs('  async function fetchTexts(leadId) {', '\n  }');
  async function runCc(role) {
    const queries = [];
    const win = stubWin(role, queries);
    const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Object, String, Number, Date,
      claims: () => win._userClaims || {}, isViewer: () => (win._userClaims || {}).role === 'viewer', toDate: () => null };
    vm.createContext(sb);
    vm.runInContext(SRC_CC + '\nglobalThis.__c = fetchCalls; globalThis.__t = fetchTexts;', sb);
    await sb.__c('L1');
    await sb.__t('L1');
    return { queries };
  }
  ok('fetchCalls and fetchTexts are found (positive control)', /async function fetchCalls/.test(SRC_CC) && /async function fetchTexts/.test(SRC_CC));
  {
    const v = await runCc('viewer');
    ok('a viewer issues NO thursday_calls read', !cols(v.queries).includes('thursday_calls'), cols(v.queries).join(','));
    ok('a viewer issues NO phone_texts read', !cols(v.queries).includes('phone_texts'), cols(v.queries).join(','));
    ok('a viewer issues no read at all on the card\'s Calls section', v.queries.length === 0, cols(v.queries).join(','));
    const m = await runCc('manager');
    ok('a manager still reads thursday_calls (own + company scope)', m.queries.filter((q) => q.col === 'thursday_calls').length === 2);
    ok('a manager still reads phone_texts', cols(m.queries).includes('phone_texts'));
    const s = await runCc('');
    ok('a solo owner still reads thursday_calls and phone_texts', cols(s.queries).includes('thursday_calls') && cols(s.queries).includes('phone_texts'));
  }
  // Final round (2026-11-09): the section subtitle promised a viewer a
  // "summary, transcript and recording" right above the hidden line.
  {
    const RENDER = ccs('  function render() {', '\n  }\n');
    ok('customer-calls render is found (positive control)', /function render\(\)/.test(RENDER));
    const HTML = read('docs/pro/customer.html');
    ok('the Calls subtitle has an id the script can find', /<div class="ui-note" id="callsSub">Calls Thursday answered for this customer: summary, transcript and recording\.<\/div>/.test(HTML));
    function runRender(role) {
      const el = { innerHTML: '' }, sub = { hidden: false };
      const win = { _userClaims: { role } };
      const sb = { window: win, document: { getElementById: (id) => (id === 'callsSub' ? sub : null) }, Object, String, Number, Date,
        root: () => el, esc: (s) => String(s), notice: '', noticeLead: '', calls: [], texts: [],
        claims: () => win._userClaims, isViewer: () => role === 'viewer' };
      vm.createContext(sb);
      vm.runInContext(RENDER + '\nglobalThis.__r = render;', sb);
      sb.__r();
      return { html: el.innerHTML, sub };
    }
    const v = runRender('viewer');
    ok('customer Calls, viewer: the subtitle is hidden', v.sub.hidden === true && /pc-hidden-note/.test(v.html), v);
    const m = runRender('manager');
    ok('customer Calls, manager: the subtitle still shows (positive control)', m.sub.hidden === false && /No calls yet/.test(m.html), m);
  }
  ok('the card tells a viewer calls and texts are hidden',/if \(isViewer\(\)\) top \+= '<div class="pc-meta pc-hidden-note" role="status">Calls and texts are hidden for your role\.<\/div>'/.test(CC));

  // ── 1. Thursday widget (widgets.js) + Thursday-handled ─────────────────
  console.log('THURSDAY WIDGET (widgets.js) / THURSDAY-HANDLED');
  const WG = read('docs/pro/js/widgets.js');
  const THU_FETCH = slicer(WG)('async function _thuFetch() {', '\n}\n');
  async function runThu(role) {
    const queries = [];
    const win = stubWin(role, queries);
    const sb = { window: win, console: { log() {}, warn() {}, error() {} }, Object,
      _thuClaims: () => win._userClaims || {}, _thuIsViewer: () => (win._userClaims || {}).role === 'viewer', _toMs: () => 0 };
    vm.createContext(sb);
    vm.runInContext(THU_FETCH + '\nglobalThis.__f = _thuFetch;', sb);
    await sb.__f();
    return queries;
  }
  ok('_thuFetch is found (positive control)', /async function _thuFetch/.test(THU_FETCH));
  ok('a viewer issues NO thursday_calls read from the widget', (await runThu('viewer')).length === 0);
  ok('a manager still reads thursday_calls from the widget', (await runThu('manager')).filter((q) => q.col === 'thursday_calls').length === 2);
  ok('the widget tells a viewer calls are hidden (not "No calls yet")', /if \(_thuIsViewer\(\)\) \{ el\.innerHTML = '<div class="w-empty" role="status">Calls are hidden for your role\.<\/div>'; return; \}/.test(WG));
  const TH = read('docs/pro/js/thursday-handled.js');
  ok('Thursday-handled never reads thursday_calls for a viewer', /function canRead\(\) \{ return !!\(uid\(\) && role\(\) !== 'sales_rep' && role\(\) !== 'viewer'\); \}/.test(TH));
  const CS = read('docs/pro/js/contact-suggest.js');
  const CL = read('docs/pro/js/contact-labels.js');
  ok('contact-suggest (reads thursday_calls) is already off for a viewer: it needs canWrite, which excludes viewers',
    /function canSuggest\(\) \{ return !!\(uid\(\) && w\.NBDContactLabels && w\.NBDContactLabels\.canWrite\(\)\); \}/.test(CS) && /function canWrite\(\) \{ return !!\(uid\(\) && role\(\) !== 'viewer'/.test(CL));
  // Final round (2026-11-09): contact-suggest checks the role itself before its
  // thursday_calls read, so a viewer never sends a read the rules deny, even if
  // canWrite were ever widened.
  async function runSuggest(role) {
    const queries = [];
    const win = stubWin(role, queries);
    win.NBDContactLabelsLogic = {}; win.NBDContactSuggestLogic = {};
    win.NBDContactLabels = { canWrite: () => true, current: () => ({}) };
    win.dispatchEvent = () => {}; win.addEventListener = () => {};
    const sb = { window: win, document: { addEventListener() {} }, console: { log() {}, warn() {}, error() {} }, CustomEvent: function () {}, setTimeout, clearTimeout, Date, Object, Array, String };
    vm.createContext(sb);
    vm.runInContext(CS, sb);
    await win.NBDContactSuggest.load(true);
    return cols(queries);
  }
  {
    const v = await runSuggest('viewer');
    ok('contact-suggest: a viewer sends NO thursday_calls read (role checked before the read)', !v.includes('thursday_calls'), v.join(','));
    const m = await runSuggest('manager');
    ok('contact-suggest: a manager still reads thursday_calls (positive control)', m.includes('thursday_calls'), m.join(','));
  }

  // ── 2. Home strip + Inbox ───────────────────────────────────────────────
  console.log('HOME STRIP (home-attention.js) / INBOX (layouts/inbox.js)');
  const HA = read('docs/pro/js/home-attention.js');
  ok('the Home strip skips its phone_text_days read for a viewer', /if \(!callsHidden\) jobs\.push\(qWin\('phone_text_days', READ\.recentTexts\)/.test(HA));
  const haText = (HA.match(/qWin\('phone_text_days'[\s\S]*?\.catch\(\(\) => \{[^\n]*\}\)\);/) || [''])[0];
  ok('…and a texts denial once the role reads viewer is not a failed read', /\.catch\(\(\) => \{ if \(!viewerNow\(\)\) out\.callsFailed = true; \}\)\);$/.test(haText), haText.slice(-80));
  const IB = read('docs/pro/js/layouts/inbox.js');
  ok('the Inbox skips its phone_text_days read for a viewer', /var b = \(claims\(\)\.role \|\| ''\) === 'viewer' \? Promise\.resolve\(\) : W\.getDocs\(W\.query\(W\.collection\(W\.db, 'phone_text_days'\)/.test(IB));
  ok('…a texts denial once the role reads viewer does not fail the feed', /'phone_text_days'[\s\S]{0,400}\.catch\(function \(e\) \{ if \(\(claims\(\)\.role \|\| ''\) === 'viewer'\) return; throw e; \}\);/.test(IB));
  ok('…and the Inbox says calls and texts are hidden for a viewer', /Calls and texts are hidden for your role\./.test(IB) && /role="status"/.test(IB));

  // ── 1 + 3. Customer timeline (customer-bootstrap + call-timeline) ───────
  console.log('CUSTOMER TIMELINE (customer-bootstrap.module.js, call-timeline.js)');
  const CB = read('docs/pro/js/customer-bootstrap.module.js');
  const thuBlock = (CB.match(/\/\/ Thursday \(Bland AI receptionist\) calls attached to this lead[\s\S]*?No Thursday calls for timeline/) || [''])[0];
  ok('the timeline\'s thursday_calls read is found (positive control)', /collection\(db, 'thursday_calls'\)/.test(thuBlock));
  ok('…and skipped for a viewer', /if \(\(claims\.role \|\| ''\) !== 'viewer'\) for \(const scope of scopes\)/.test(thuBlock), thuBlock.slice(0, 0));
  const actReads = CB.match(/getDocs\([^\n]*'activity'[^\n]*\)/g) || [];
  ok('the customer page reads activity in two places, both through NBDCallTimeline (positive control)', (CB.match(/const CT = window\.NBDCallTimeline;/g) || []).length === 2);
  ok('both activity reads go through NBDCallTimeline.activityDocs (the viewer-safe query, retried when claims were late)', (CB.match(/await CT\.activityDocs\(window, (db|window\.db), leadId\)/g) || []).length === 2 && actReads.length === 0, actReads.join(' | '));
  delete require.cache[require.resolve(path.join(ROOT, 'docs/pro/js/call-timeline.js'))];
  const CT = require(path.join(ROOT, 'docs/pro/js/call-timeline.js'));
  ok('call-timeline exports activityQuery and the viewer sources', typeof CT.activityQuery === 'function' && JSON.stringify(CT.VIEWER_SOURCES) === JSON.stringify(VIEWER_OK));
  if (typeof CT.activityQuery === 'function') {
    const W = (role) => ({ _userClaims: role == null ? undefined : { role }, collection: (db, ...p) => ({ col: p.join('/') }),
      query: (c, ...f) => ({ col: c.col, filters: f }), where: (f, op, v) => ({ f, op, v }) });
    const v = CT.activityQuery(W('viewer'), {}, 'L1');
    ok('a viewer\'s activity read asks for exactly the sources the rule allows a viewer', v.col === 'leads/L1/activity' && v.filters.length === 1 && v.filters[0].f === 'source' && v.filters[0].op === 'in' && JSON.stringify(v.filters[0].v) === JSON.stringify(VIEWER_OK), JSON.stringify(v));
    const m = CT.activityQuery(W('manager'), {}, 'L1');
    ok('a manager\'s activity read is the whole collection, as before', m.col === 'leads/L1/activity' && !m.filters);
    const s = CT.activityQuery(W(null), {}, 'L1');
    ok('a solo owner (no claims yet) reads the whole collection, as before', s.col === 'leads/L1/activity' && !s.filters);
  }
  if (typeof CT.activityDocs === 'function') {
    // A viewer whose claims had not loaded yet sends the unfiltered list, which
    // the rule refuses whole; activityDocs asks again with the viewer's sources.
    const runDocs = async (role, deniedUnfiltered) => {
      const sent = [];
      const W = { _userClaims: role == null ? undefined : { role }, collection: (db, ...p) => ({ col: p.join('/') }),
        query: (c, ...f) => ({ col: c.col, filters: f }), where: (f, op, v) => ({ f, op, v }),
        getDocs: async (q) => { sent.push(q); if (!q.filters && deniedUnfiltered) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; } return { docs: [{ id: 'note1' }] }; } };
      let out, err;
      try { out = await CT.activityDocs(W, {}, 'L1'); } catch (e) { err = e; }
      return { sent, out, err };
    };
    const late = await runDocs(null, true);
    ok('activityDocs: a viewer whose claims were late still gets the rows, through the viewer query', late.out && late.out.docs.length === 1 && late.sent.length === 2
      && late.sent[1].filters && late.sent[1].filters[0].op === 'in' && JSON.stringify(late.sent[1].filters[0].v) === JSON.stringify(VIEWER_OK), late);
    const own = await runDocs(null, false);
    ok('activityDocs: a solo owner reads once, the whole collection (positive control)', own.out && own.sent.length === 1 && !own.sent[0].filters, own.sent);
    const vw = await runDocs('viewer', true);
    ok('activityDocs: a viewer with claims asks once, filtered', vw.out && vw.sent.length === 1 && vw.sent[0].filters, vw.sent);
    const other = await (async () => { const W = { _userClaims: { role: 'manager' }, collection: (db, ...p) => ({ col: p.join('/') }), query: (c, ...f) => ({ col: c.col, filters: f }), where: (f, op, v) => ({ f, op, v }),
      getDocs: async () => { const e = new Error('unavailable'); e.code = 'unavailable'; throw e; } }; try { await CT.activityDocs(W, {}, 'L1'); return null; } catch (e) { return e.code; } })();
    ok('activityDocs: any other failure is passed on (the caller\'s catch decides)', other === 'unavailable', other);
  } else ok('call-timeline exports activityDocs', false);
  // Final round (2026-11-09): smart-followup's AI draft reads the customer
  // timeline for call / text / Thursday lines. A viewer can read none of those
  // rows, and the whole-collection list is refused, so it sends no read at all.
  {
    const SF = read('docs/pro/js/smart-followup.js');
    const sfs = slicer(SF);
    const LOAD = sfs('  async function _loadConversation(leadId) {', '\n  }\n');
    ok('smart-followup _loadConversation is found (positive control)', /async function _loadConversation/.test(LOAD));
    async function runSf(role) {
      const queries = [];
      const win = stubWin(role, queries);
      win.getDocs = async (q) => { queries.push(q); if (role === 'viewer' && !q.filters) { const e = new Error('denied'); e.code = 'permission-denied'; throw e; } return { forEach() {} }; };
      win.query = (c, ...f) => ({ col: c.col, filters: f.filter((x) => x && x.f).length ? f.filter((x) => x && x.f) : undefined });
      const sb = { window: win, Date, Map, Promise, Object, CONV_TTL_MS: 1, _convCache: new Map(),
        _conversationFrom: () => ({ calls: [], thursday: null, texts: [], promises: [] }) };
      vm.createContext(sb);
      vm.runInContext(LOAD + '\nglobalThis.__l = _loadConversation;', sb);
      const conv = await sb.__l('L1');
      return { conv, queries };
    }
    const v = await runSf('viewer');
    ok('smart-followup: a viewer sends no activity read (none of its rows are readable to a viewer)', !cols(v.queries).includes('leads/L1/activity'), cols(v.queries).join(','));
    ok('…and the draft goes on without a timeline (null), as when the read fails', v.conv === null, v.conv);
    const m = await runSf('manager');
    ok('smart-followup: a manager still reads the activity timeline (positive control)', cols(m.queries).includes('leads/L1/activity') && m.conv !== null, cols(m.queries).join(','));
  }
  const RULES = read('firestore.rules');
  const actRule = (RULES.match(/match \/activity\/\{activityId\} \{[\s\S]*?allow create/) || [''])[0];
  const ruleList = (actRule.match(/notViewer\(\) \|\| resource\.data\.source in (\[[^\]]*\])/) || [])[1];
  ok('the activity rule lets a viewer read the same sources the client asks for (an allowlist, bare field)', ruleList && JSON.stringify(JSON.parse(ruleList.replace(/'/g, '"'))) === JSON.stringify(VIEWER_OK), ruleList);
  for (const col of ['thursday_calls', 'phone_texts', 'phone_text_days']) {
    const b = (RULES.match(new RegExp('match \\/' + col + '\\/\\{docId\\} \\{[\\s\\S]*?\\n    \\}')) || [''])[0];
    ok(col + ' read requires notViewer()', /allow read: if notViewer\(\)\s*&& \(isOwner\(resource\.data\.userId\)/.test(b) && /allow write: if false;/.test(b));
  }

  // ── 3 + 4. Server ───────────────────────────────────────────────────────
  console.log('SERVER (call-center-logic.js, call-center.js, lead-brief)');
  const CCM = require(path.join(ROOT, 'functions/call-center.js'));   // real modules, like the call-center-action suite
  const silent = { info() {}, warn() {}, error() {}, debug() {} };
  const STUBS = {
    'firebase-functions/params': { defineSecret: (n) => ({ name: n, value: () => '' }) },
    'firebase-functions/v2': { logger: silent },
    'firebase-functions/v2/https': { onCall: (o, h) => ({ __opts: o, __handler: h }), onRequest: (o, h) => ({ __opts: o, __handler: h }),
      HttpsError: class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } } },
    'firebase-admin/firestore': { getFirestore: () => ({}), FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n) => n }, Timestamp: { fromMillis: (ms) => ({ toMillis: () => ms }) } },
    './integrations/killswitch': { isAiDisabled: async () => false },
  };
  const realLoad = Module._load;
  Module._load = function (request) { return Object.prototype.hasOwnProperty.call(STUBS, request) ? STUBS[request] : realLoad.apply(this, arguments); };
  const L = require(path.join(ROOT, 'functions/call-center-logic.js'));
  const NOW = Date.parse('2026-11-09T15:00:00Z');
  const notes = { summary: 'SECRET SUMMARY: hail on the north slope, adjuster Friday', promises: [{ who: 'jo', text: 'Send the estimate', due: '2026-11-12' }], followUpDate: null, urgent: false };
  const t = L.buildFollowUpTask({ call: { id: 'cube_X1', contactName: 'Kim', startedAtMs: NOW - 3600e3 }, notes, leadId: 'L1', ownerUid: 'U', todayYmd: '2026-11-09', nowMs: NOW });
  ok('a call still makes its follow-up task (positive control)', t && t.title === 'Send the estimate (Kim)' && t.source === 'cube-acr' && t.phoneCallId === 'cube_X1');
  ok('the task no longer copies the AI summary (every role that reads the customer reads its tasks)', t && !/SECRET SUMMARY/.test(JSON.stringify(t)), t && t.notes);
  ok('…it keeps what Jo said he would do', t && /You said you would:\n• Send the estimate \(by 2026-11-12\)/.test(t.notes));
  ok('…and points to where the summary lives', t && /summary is on the customer's timeline/.test(t.notes), t && t.notes);
  const td = L.buildTextDayTask({ day: { id: 'day1', contactName: 'Kim', startedAtMs: NOW - 3600e3 }, notes, leadId: 'L1', ownerUid: 'U', todayYmd: '2026-11-09', nowMs: NOW });
  ok('a day of texts: the task has no summary either', td && td.source === 'sms-backup' && !/SECRET SUMMARY/.test(JSON.stringify(td)));
  {
    // Thursday's own follow-up task (leads/{id}/tasks/thursday-{callId}) is read
    // by the same roles; it gets the same treatment as the cube / sms tasks.
    const TL = require(path.join(ROOT, 'functions/integrations/thursday-logic.js'));
    const ex = TL.sanitizeExtraction ? TL.sanitizeExtraction({ caller_name: 'Kim Nowicka', callback_number: '5135550100', issue: 'Leak over the kitchen',
      urgent: true, urgent_reason: 'URGENTSECRET water inside', callback_window: 'after 3pm', caller_type: 'homeowner' }) : null;
    const tt = ex && TL.buildTask({ extraction: ex, call: { callId: 'abc123', from: '+15135550100', summary: 'THURSDAYSECRET summary of the call' },
      route: { action: 'attach' }, leadId: 'L1', ownerUid: 'U', now: NOW });
    ok('a Thursday call still makes its task (positive control)', tt && tt.source === 'thursday' && tt.thursdayCallId === 'abc123' && tt.priority === 'high'
      && /Best time: after 3pm/.test(tt.notes) && /Number: \+15135550100/.test(tt.notes), tt);
    ok('the Thursday task no longer copies the AI summary or the urgent reason', tt && !/THURSDAYSECRET|URGENTSECRET/.test(JSON.stringify(tt)), tt && tt.notes);
    ok('…and points to where the summary lives', tt && tt.notes.indexOf(L.SUMMARY_POINTER || 'The summary is on the customer\'s timeline.') !== -1, tt && tt.notes);
    ok('scrubTaskSummary(notes, \'thursday\') drops an old Thursday task\'s Summary / Urgent lines',
      L.scrubTaskSummary('Best time: am\nNumber: +1513\nUrgent: SECRET\nSummary: SECRET', 'thursday') === 'Best time: am\nNumber: +1513');
    ok('…but only on a Thursday task (a cube task\'s lines are left alone)',
      L.scrubTaskSummary('Summary: typed by Jo', 'cube-acr') === 'Summary: typed by Jo' && L.scrubTaskSummary('Summary: typed by Jo') === 'Summary: typed by Jo');
  }
  ok('the timeline entry still carries the summary (rules keep it from viewers)', L.buildCallActivity({ call: { id: 'c' }, notes, ownerUid: 'U' }).summary === notes.summary);
  ok('scrubTaskSummary removes the old "Call: …" paragraph and keeps the rest',
    typeof L.scrubTaskSummary === 'function' && L.scrubTaskSummary('Call: SECRET\n\nYou said you would:\n• X') === 'You said you would:\n• X'
    && L.scrubTaskSummary('Call: SECRET') === '' && L.scrubTaskSummary('Typed by Jo') === 'Typed by Jo' && L.scrubTaskSummary(null) === null);
  // A real move through callCenterAction (in-memory Firestore, the shape
  // tests/call-center-action-2026-10-01.test.js uses).
  {
    const docs = new Map(Object.entries({
      'phone_calls/cube_MOVEA1': { userId: 'co1', companyId: 'co1', leadId: 'L1', phoneDigits: '5135550100', status: 'noted', startedAtMs: NOW - 3600e3, summary: 'SECRET SUMMARY', promises: [], bucket: 'customer', attachedBy: 'co1' },
      'leads/L1': { userId: 'co1', companyId: 'co1', firstName: 'Pat' },
      'leads/L2': { userId: 'co1', companyId: 'co1', firstName: 'Sam' },
      'leads/L1/activity/cube-cube_MOVEA1': { source: 'cube-acr', summary: 'SECRET SUMMARY' },
      'leads/L1/tasks/cube-cube_MOVEA1': { source: 'cube-acr', title: 'Send the estimate (Pat)', notes: 'Call: SECRET SUMMARY\n\nYou said you would:\n• Send the estimate', done: false },
      'phone_calls/cube_MOVEB2': { userId: 'co1', companyId: 'co1', leadId: 'L1', phoneDigits: '5135550101', status: 'noted', startedAtMs: NOW - 3600e3, summary: 's', promises: [], bucket: 'customer', attachedBy: 'co1' },
      'leads/L1/tasks/cube-cube_MOVEB2': { source: 'cube-acr', title: 'No notes task', done: false },
    }));
    const mk = (p) => ({ id: p.split('/').pop(), path: p,
      get: async () => ({ exists: docs.has(p), data: () => docs.get(p) }),
      set: async (v, o) => { if (Object.values(v).some((x) => x === undefined)) throw new Error('undefined field in ' + p); docs.set(p, o && o.merge ? Object.assign({}, docs.get(p) || {}, v) : v); },
      create: async (v) => { if (docs.has(p)) { const e = new Error('exists'); e.code = 6; throw e; } if (Object.values(v).some((x) => x === undefined)) throw new Error('undefined field in ' + p); docs.set(p, v); },
      delete: async () => { docs.delete(p); } });
    const query = (name, filters) => ({ where: (f, op, v) => query(name, filters.concat([[f, v]])), orderBy: () => query(name, filters), limit: () => query(name, filters),
      get: async () => { const depth = name.split('/').length + 1; const rows = [...docs.entries()].filter(([k, v]) => k.startsWith(name + '/') && k.split('/').length === depth && filters.every(([f, val]) => v[f] === val)).map(([k, v]) => ({ id: k.split('/').pop(), ref: mk(k), exists: true, data: () => v })); return { docs: rows, size: rows.length, empty: !rows.length, forEach: (fn) => rows.forEach(fn) }; } });
    const db = { docs, doc: mk, collection: (n) => Object.assign(query(n, []), { doc: (id) => mk(n + '/' + id) }),
      collectionGroup: () => ({ where: () => ({ get: async () => ({ docs: [] }) }) }),
      batch: () => { const ops = []; return { set: (r, v, o) => ops.push(() => r.set(v, o)), commit: async () => { for (const f of ops) await f(); } }; } };
    let err = null;
    for (const id of ['cube_MOVEA1', 'cube_MOVEB2']) {
      try { await CCM._test.callAction({ db, auth: { uid: 'co1', token: {} }, data: { id, action: 'move', leadId: 'L2' }, nowMs: NOW }); } catch (e) { err = e; }
    }
    const moved = docs.get('leads/L2/tasks/cube-cube_MOVEA1');
    ok('a move runs (positive control: the task reached the new customer)', !err && !!moved && !docs.has('leads/L1/tasks/cube-cube_MOVEA1'), err && err.message);
    ok('…and the moved copy drops the old "Call: <summary>" paragraph, keeping what Jo said', moved && moved.notes === 'You said you would:\n• Send the estimate', moved && moved.notes);
    const moved2 = docs.get('leads/L2/tasks/cube-cube_MOVEB2');
    ok('…a task with no notes moves without gaining a notes key', moved2 && !('notes' in moved2), moved2);
  }

  const B = require(path.join(ROOT, 'functions/lead-brief-logic.js'));
  const activity = [
    { type: 'call', source: 'cube-acr', phoneCallId: 'c1', summary: 'CALLSECRET', promises: [{ who: 'jo', text: 'PROMISESECRET' }], startedAtMs: NOW - 1e6 },
    { type: 'text', source: 'sms-backup', phoneTextDayId: 'd1', summary: 'TEXTSECRET', startedAtMs: NOW - 2e6 },
    { type: 'call', source: 'thursday', thursdayCallId: 't1', summary: 'THURSDAYSECRET', startedAtMs: NOW - 3e6 },
  ];
  const lead = { userId: 'jo', companyId: 'jo', firstName: 'Pat', stage: 'Estimate sent' };
  const full = B.buildPrompt(B.buildFacts({ lead, activity, tasks: [], nowMs: NOW }));
  ok('owner brief still carries CALL, TEXTS, THURSDAY and PROMISE lines (positive control)', /CALL .*CALLSECRET/.test(full) && /TEXTS .*TEXTSECRET/.test(full) && /THURSDAY .*THURSDAYSECRET/.test(full) && /PROMISE .*PROMISESECRET/.test(full));
  ok('mayReadCallContent: a viewer no; owner, manager, company_admin, admin yes',
    typeof B.mayReadCallContent === 'function' && !B.mayReadCallContent({ uid: 'v', token: { role: 'viewer', companyId: 'jo' } })
    && B.mayReadCallContent({ uid: 'jo', token: {} }) && B.mayReadCallContent({ uid: 'm', token: { role: 'manager', companyId: 'jo' } })
    && B.mayReadCallContent({ uid: 'a', token: { role: 'company_admin', companyId: 'jo' } }) && B.mayReadCallContent({ uid: 'x', token: { role: 'admin' } }));
  const vf = B.buildFacts({ lead, activity, tasks: [], nowMs: NOW, callContent: false });
  const vp = B.buildPrompt(vf);
  ok('a viewer\'s brief has no CALL / TEXTS / THURSDAY / PROMISE line', !/CALLSECRET|TEXTSECRET|THURSDAYSECRET|PROMISESECRET/.test(vp) && !/\n(CALL|TEXTS|THURSDAY|PROMISE)\b/.test(vp), vp);
  const fb = B.fallbackBrief(vf);
  ok('…nor does the no-AI fallback built from it', !/CALLSECRET|TEXTSECRET|THURSDAYSECRET|PROMISESECRET/.test(JSON.stringify(fb)));
  ok('…while the CRM record (stage, name) still briefs', /Estimate sent/.test(vp) && /Pat/.test(vp));
  ok('canReadLead is NOT widened (a viewer reads the lead, as the /leads rule says)', B.canReadLead({ uid: 'v', token: { role: 'viewer', companyId: 'jo' } }, lead) === true
    && B.canReadLead({ uid: 'r', token: { role: 'sales_rep', companyId: 'jo' } }, lead) === false);

  // The callable end to end with a fake Firestore: a viewer never sees the cached (call-built) brief, and never writes one.
  const LB = require(path.join(ROOT, 'functions/lead-brief.js'));
  function fakeDb(seed) {
    const store = new Map(Object.entries(seed));
    const reads = [], writes = [];
    const split = (p) => { const i = p.lastIndexOf('/'); return [p.slice(0, i), p.slice(i + 1)]; };
    const doc = (p) => ({ id: split(p)[1], path: p,
      get: async () => { reads.push(p); return { exists: store.has(p), id: split(p)[1], data: () => store.get(p) }; },
      set: async (d) => { writes.push(p); store.set(p, d); }, collection: (n) => coll(p + '/' + n) });
    const coll = (name) => { const q = { where: () => q, orderBy: () => q, limit: () => q, doc: (id) => doc(name + '/' + id),
      get: async () => { reads.push(name); const docs = [...store.keys()].filter((k) => split(k)[0] === name).map((k) => ({ id: split(k)[1], data: () => store.get(k) })); return { docs, forEach: (f) => docs.forEach(f), size: docs.length, empty: !docs.length }; } }; return q; };
    return { reads, writes, store, collection: coll, doc, runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, d) => r.set(d) }) };
  }
  const seed = {
    'leads/L1': lead,
    'lead_briefs/L1': { leadId: 'L1', oneLine: 'CACHEDSECRET from the call', bullets: ['CALLSECRET'], source: 'ai', generatedAtMs: NOW - 60e3 },
    'leads/L1/activity/cube-c1': activity[0], 'leads/L1/activity/sms-d1': activity[1],
    'subscriptions/jo': { plan: 'pro', status: 'active' },   // a paid tenant: the viewer's brief really goes to the model
  };
  const models = [];
  const model = async (req) => { models.push(req); return { content: [{ type: 'text', text: '{"oneLine":"Fresh","bullets":["a","b","c"]}' }], usage: { input_tokens: 1, output_tokens: 1 }, model: req.model }; };
  const callable = LB._test && LB._test.briefCallable;
  ok('the callable is reachable for the test (positive control)', typeof callable === 'function');
  if (typeof callable === 'function') {
    const db1 = fakeDb(seed);
    const own = await callable({ db: db1, auth: { uid: 'jo', token: { email_verified: true, role: 'admin' } }, data: { leadId: 'L1' }, nowMs: NOW, callModel: model, log: silent });
    ok('the owner still gets the cached brief (positive control)', own && own.cached === true && /CACHEDSECRET/.test(own.oneLine));
    const db2 = fakeDb(seed);
    models.length = 0;
    const vr = await callable({ db: db2, auth: { uid: 'v', token: { email_verified: true, role: 'viewer', companyId: 'jo' } }, data: { leadId: 'L1' }, nowMs: NOW, callModel: model, log: silent });
    ok('a viewer never gets the cached brief (it was built from the calls)', vr && !/CACHEDSECRET|CALLSECRET/.test(JSON.stringify(vr)), vr);
    ok('…does not even read the cache doc', !db2.reads.includes('lead_briefs/L1'), db2.reads);
    ok('…never writes the shared cache', !db2.writes.includes('lead_briefs/L1'), db2.writes);
    ok('…the viewer\'s brief did go to the model (positive control)', models.length === 1, models.length);
    ok('…and what was sent carries no call content', !/CALLSECRET|TEXTSECRET|PROMISESECRET/.test(JSON.stringify(models)));
  }
  // getThursdayRecording streams the call audio. A viewer reads no thursday_calls
  // doc, but can learn a callId from the task leads/{id}/tasks/thursday-{callId}
  // (its thursdayCallId field), so the callable must refuse a viewer itself.
  {
    const TL = require(path.join(ROOT, 'functions/integrations/thursday-logic.js'));
    const callId = 'C1-thursday-call';
    const recDocs = { ['thursday_calls/' + TL.callDocId(callId)]: { userId: 'jo', companyId: 'jo', recordingPath: 'thursday/jo/C1.mp3' } };
    const downloads = [];
    Object.assign(STUBS, {
      'firebase-functions/v2/firestore': { onDocumentWritten: (o, h) => ({ __opts: o, __handler: h }) },
      'firebase-admin/firestore': { getFirestore: () => ({ doc: (p) => ({ get: async () => ({ exists: !!recDocs[p], data: () => recDocs[p] }) }) }),
        FieldValue: { serverTimestamp: () => ({ __ts: true }), increment: (n) => n } },
      'firebase-admin/storage': { getStorage: () => ({ bucket: () => ({ file: (p) => ({
        getMetadata: async () => [{ size: 4, contentType: 'audio/mpeg' }],
        download: async () => { downloads.push(p); return [Buffer.from('AUDI')]; } }) }) }) },
    });
    const TH = require(path.join(ROOT, 'functions/integrations/thursday.js'));
    const rec = TH.getThursdayRecording && TH.getThursdayRecording.__handler;
    async function play(token, uid) {
      try { return { res: await rec({ auth: { uid: uid || 'x', token }, data: { callId, part: 0 } }) }; }
      catch (e) { return { err: e.code || e.message }; }
    }
    ok('getThursdayRecording is reachable for the test (positive control)', typeof rec === 'function');
    if (typeof rec === 'function') {
      const own = await play({ role: 'admin' }, 'jo');
      ok('the owner still plays the recording (positive control)', own.res && own.res.base64 === Buffer.from('AUDI').toString('base64'), own);
      const mgr = await play({ role: 'manager', companyId: 'jo' }, 'm');
      ok('…a same-company manager still plays it', mgr.res && mgr.res.parts === 1, mgr);
      const n0 = downloads.length;
      const vw = await play({ role: 'viewer', companyId: 'jo' }, 'v');
      ok('a same-company viewer is refused the call audio', vw.err === 'permission-denied', vw);
      ok('…and nothing was downloaded for them', downloads.length === n0, downloads);
    }
  }
  Module._load = realLoad;

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
