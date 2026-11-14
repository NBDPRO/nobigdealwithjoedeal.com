/**
 * daily-polish-2026-11-14.test.js — wave-1 small fixes, each run for real.
 *
 *   daily #5  agent-inbox loadSentPhone: limit(50) with no order could cut off
 *             this week's sent texts (so their STOP could not be recorded);
 *             now orderBy decidedAt desc, falling back while the index builds
 *   daily #7  What's new: every item had aged out, so the bell opened an empty
 *             "0 items" panel; no bell while there is nothing new
 *   daily #9  the stage-tile filter dropped on every lead reload (tab return)
 *   daily #11 "on your Google Calendar in a few seconds" was said to every
 *             account, connected or not
 *   daily #12 legacy estimate search: a query with no digits matched EVERY
 *             estimate (total.includes(''))
 *   daily #13 the list-view sort reset on every reload
 *   field #11 iOS has no vibrate: the Field camera now counts shots
 *
 * <NAME>_SRC=<file> (AGENT, WHATSNEW, CRM, PLANNER, SEARCH, LIST, FIELD) runs
 * a section against another copy.
 *
 * Run: node tests/daily-polish-2026-11-14.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');

const R = (env, rel) => fs.readFileSync(process.env[env] || path.join(H.ROOT, rel), 'utf8');
let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + String(detail).slice(0, 300) : '')); }
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
function slice(text, start, endMarker) {
  const i = text.indexOf(start);
  if (i < 0) return '';
  if (endMarker) { const j = text.indexOf(endMarker, i); return j > i ? text.slice(i, j) : ''; }
  const open = text.indexOf('{', i);
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}') { depth--; if (depth === 0) return text.slice(i, k + 1); }
  }
  return '';
}

(async () => {
  console.log('\ndaily-polish — wave-1 small fixes\n');

  // ── daily #5 ──
  {
    const AG = R('AGENT_SRC', 'docs/pro/js/agent-inbox.js');
    function run(failCode) {
      const calls = [];
      const ctx = vm.createContext({
        window: {
          db: {}, collection: (db, c) => c, where: (f, op, v) => ({ where: f }), limit: (n) => ({ limit: n }),
          orderBy: (f, d) => ({ orderBy: f + ':' + d }),
          query: (...p) => p,
          getDocs: async (q) => { calls.push(q.slice(1)); if (failCode && q.some((x) => x && x.orderBy)) { const e = new Error('x'); e.code = failCode; throw e; } return { docs: [] }; },
        },
        console: { log() {}, warn() {}, error() {} }, Date, Object, Array,
        companyKey: () => 'co1', COLL: 'agent_inbox', recentPhoneSent: (r) => r,
      });
      vm.runInContext(slice(AG, 'async function loadSentPhone(') + '\nthis.load = loadSentPhone;', ctx);
      return { ctx, calls };
    }
    let T = run(null);
    await T.ctx.load();
    ok('STOP list: newest sent texts first (orderBy decidedAt desc, limit 50)',
      T.calls.length === 1 && T.calls[0].some((x) => x.orderBy === 'decidedAt:desc') && T.calls[0].some((x) => x.limit === 50), JSON.stringify(T.calls));
    T = run('failed-precondition');
    await T.ctx.load();
    ok('...index still building: falls back to the old read', T.calls.length === 2 && !T.calls[1].some((x) => x.orderBy), JSON.stringify(T.calls));
    T = run('permission-denied');
    let threw = false;
    try { await T.ctx.load(); } catch (_) { threw = true; }
    ok('...a real refusal is not hidden by the fallback', threw);
    const idx = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'firestore.indexes.json'), 'utf8')).indexes;
    ok('...and its composite index is declared', idx.some((i) => i.collectionGroup === 'agent_inbox'
      && i.fields.map((f) => f.fieldPath + ':' + f.order).join(',') === 'companyId:ASCENDING,status:ASCENDING,decidedAt:DESCENDING'));
  }

  // ── daily #7 ──
  {
    const WN = R('WHATSNEW_SRC', 'docs/pro/js/whats-new.js');
    function boot(nowIso) {
      const dom = H.makeDom();
      const anchor = dom.document.createElement('div'); anchor.setAttribute('id', 'userAvatar');
      dom.document.body.appendChild(anchor);
      const q = [];
      const RealDate = Date;
      const fixed = RealDate.parse(nowIso);
      function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(fixed); }
      FakeDate.now = () => fixed; FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC; FakeDate.prototype = RealDate.prototype;
      const W = { document: dom.document, console: { log() {}, warn() {}, error() {} }, Date: FakeDate, JSON, Object, Array, String, Math,
        localStorage: { getItem: () => null, setItem() {} }, setTimeout: (f) => { q.push(f); return 0; }, setInterval: (f) => { q.push(f); return 1; }, clearInterval() {},
        addEventListener() {}, location: { pathname: '/pro/dashboard.html' } };
      const ctx = vm.createContext(W); ctx.window = ctx;
      dom.document.readyState = 'complete';
      vm.runInContext(WN, ctx, { filename: 'whats-new.js' });
      for (let n = 0; n < 5 && q.length; n++) q.splice(0).forEach((fn) => fn());
      return dom;
    }
    ok('What\'s new: no bell when every item has aged out (today)', !boot('2026-11-14T12:00:00Z').document.getElementById('nbd-whats-new-bell'));
    ok('...positive control: the bell is there while items are fresh', !!boot('2026-05-10T12:00:00Z').document.getElementById('nbd-whats-new-bell'));
  }

  // ── daily #9 ──
  {
    const CRM = R('CRM_SRC', 'docs/pro/js/crm.js');
    const REG = fs.readFileSync(path.join(H.ROOT, 'docs/pro/js/lead-filter-registry.js'), 'utf8');
    const renders = [];
    const listeners = {};
    const search = { value: '' };
    const count = { textContent: '' };
    const W = {
      _leads: [{ id: 'a', stage: 'new' }, { id: 'b', stage: 'won' }, { id: 'c', stage: 'new' }],
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      renderLeads: (all, subset) => renders.push(subset ? subset.map((l) => l.id).join(',') : 'ALL'),
    };
    const ctx = vm.createContext({ window: W, console: { log() {}, warn() {}, error() {} },
      document: { getElementById: (id) => (id === 'crmSearch' ? search : id === 'crmSearchCount' ? count : null) },
      renderLeads: W.renderLeads });
    vm.runInContext(REG, ctx);
    const block = slice(CRM, 'let _stageFilterKey', 'window.handleCardClick') || slice(CRM, 'window.filterByStage = function', 'window.handleCardClick');
    vm.runInContext(block, ctx);
    W.filterByStage('new');
    ok('(stage tile filters the board)', renders[renders.length - 1] === 'a,c', renders.join(' | '));
    // Tab return: the lead reload re-renders the whole book, then says so.
    W.renderLeads(W._leads);
    (listeners['nbd:data-refreshed'] || []).forEach((fn) => fn({ detail: { source: 'leads' } }));
    ok('stage filter survives a lead reload', renders[renders.length - 1] === 'a,c', renders.join(' | '));
    ok('...and the "N in stage" label stays', /^2 in stage$/.test(count.textContent), count.textContent);
    search.value = 'smith';
    W.renderLeads(W._leads);
    (listeners['nbd:data-refreshed'] || []).forEach((fn) => fn({ detail: { source: 'leads' } }));
    ok('...but a search typed since then wins (the stage filter steps aside)', renders[renders.length - 1] === 'ALL', renders.join(' | '));
  }

  // ── daily #11 ──
  {
    const PL = R('PLANNER_SRC', 'docs/pro/js/schedule-planner.js');
    const fn = slice(PL, 'function gcalSyncing(');
    ok('Google Calendar line is gated (gcalSyncing exists and the toast uses it)', !!fn && /'Scheduled ✓' \+ \(gcalSyncing\(\)/.test(PL));
    if (fn) {
      const t = (status) => { const c = vm.createContext({ window: { NBDGoogleCalendarUI: { status: () => status } } }); vm.runInContext(fn + '\nthis.r = gcalSyncing();', c); return c.r; };
      ok('...said only when connected and on', t({ configured: true }) === true && t({ configured: false }) === false
        && t({ configured: true, disabled: true }) === false && t(null) === false && t({ error: 'x' }) === false);
    }
    const GU = fs.readFileSync(path.join(H.ROOT, 'docs/pro/js/google-calendar-ui.js'), 'utf8');
    ok('...google-calendar-ui exposes its status read-only', /window\.NBDGoogleCalendarUI = \{ status: \(\) => _status,/.test(GU));
  }

  // ── daily #12 ──
  {
    const GS = R('SEARCH_SRC', 'docs/pro/js/global-search.js');
    const W = { _leads: [{ id: 'L1', firstName: 'Ann', lastName: 'Lee' }], _estimates: [{ id: 'e1', leadId: 'L1', total: 12500 }, { id: 'e2', leadId: 'L9', total: 8000 }],
      addEventListener() {} };
    const ctx = vm.createContext({ window: W, document: { addEventListener() {}, readyState: 'complete', getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {} }), body: { appendChild() {} }, head: { appendChild() {} } },
      console: { log() {}, warn() {}, error() {} }, setTimeout: () => 0, localStorage: { getItem: () => null, setItem() {} }, navigator: { platform: '' } });
    vm.runInContext(GS, ctx, { filename: 'global-search.js' });
    const res = W.NbdGlobalSearch.search('zzz');
    ok('legacy search: a word matches no estimate by amount', res.filter((r) => r.type === 'estimate').length === 0, JSON.stringify(res.map((r) => r.estimate && r.estimate.id)));
    ok('...a number still finds the estimate by amount', W.NbdGlobalSearch.search('125').some((r) => r.type === 'estimate' && r.estimate.id === 'e1'));
  }

  // ── daily #13 ──
  {
    const LV = R('LIST_SRC', 'docs/pro/js/crm-list-view.js');
    const block = slice(LV, "  let _sortKey = 'activity';", '  let _lastList');
    const store = { 'nbd-crm-list-sort': JSON.stringify({ key: 'value', dir: -1 }) };
    const ctx = vm.createContext({ JSON, localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } } });
    vm.runInContext(block + '\nthis.k = _sortKey; this.d = _sortDir; this.save = typeof _saveSort === "function" ? _saveSort : null;', ctx);
    ok('list sort: a saved sort is restored on load', ctx.k === 'value' && ctx.d === -1, ctx.k + '/' + ctx.d);
    ok('...and both sort controls save it', (LV.match(/_saveSort\(\);/g) || []).length >= 2);
  }

  // ── field #11 ──
  {
    const K = require(path.join(H.ROOT, 'docs/pro/js/layouts/kit.js'));
    const win = { NBDLayoutKit: K, LayoutEngine: { implement() {} }, addEventListener() {} };
    const ctx = vm.createContext({ window: win, document: { documentElement: { classList: { contains: () => false } } }, console, JSON, Math, Date, Object, Array, String, Number, Promise,
      setTimeout: () => 1, setInterval: () => 1, localStorage: { getItem: () => null, setItem() {} }, navigator: { onLine: true } });
    vm.runInContext(R('FIELD_SRC', 'docs/pro/js/layouts/field.js'), ctx);
    const F = win.NBDFieldApp;
    ok('Field camera: the queue line counts the shots taken', F && typeof F._queueLine === 'function' && (F._state.shots = 3, F._state.queued = 0, F._state.online = true, /^3 photos · All uploaded$/.test(F._queueLine())),
      F && F._queueLine && F._queueLine());
    ok('...and the shutter flashes', /flashShutter\(\);\s*\n\s*c\.toBlob/.test(R('FIELD_SRC', 'docs/pro/js/layouts/field.js')));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
