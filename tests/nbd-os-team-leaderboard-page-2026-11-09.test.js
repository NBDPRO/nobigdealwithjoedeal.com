/**
 * tests/nbd-os-team-leaderboard-page-2026-11-09.test.js - NBD OS P2 "Team":
 * the Leaderboard page reads the team aggregate.
 *
 * Before: pages/leaderboard.js read EVERY lead, knock and invoice the rep owns
 * plus every job (four unbounded queries, ~93-109) and could only rank the rep
 * against themself. Now it first reads the company's leaderboard rows
 * (functions/leaderboard-aggregate.js; one query, N docs) and, for Today and
 * This week on Doors or Deals, ranks the whole team from them with the same
 * board UI. It opens on This week when the rows are current. The old path is
 * the fallback, run only when it is needed: no row for this member (the
 * aggregate has not run, or is off), a row from an earlier day / week, This
 * month / All time, or the Revenue tab (rows carry no money).
 *
 * The shared logic is docs/pro/js/team-board-logic.js (window.NBDTeamBoard),
 * also read by the OS Team widget: zone day keys, current-period numbers, a
 * ranked board. The page module runs here for real over a fake SDK and DOM.
 *
 * Run: node tests/nbd-os-team-leaderboard-page-2026-11-09.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 500) : '')); }
}
const J = (v) => JSON.stringify(v);
const tick = () => new Promise((r) => setImmediate(r));
const Z = (iso) => Date.parse(iso);
let TB = null;
try { TB = require(path.join(ROOT, 'docs/pro/js/team-board-logic.js')); } catch (e) { TB = null; }

const NOW = Z('2026-11-10T20:00:00Z');   // Tue Nov 10 2026, 3 PM in New York
const M = (doors, appts, estimates, deals) => ({ doors, appts, estimates, deals });
const row = (uid, name, today, week, extra) => Object.assign({ companyId: 'co-a', uid, name, tz: 'America/New_York', tzSet: true, dayKey: '2026-11-10', weekKey: '2026-11-09', today, week, asOfMs: NOW - 600000 }, extra || {});

/** Run pages/leaderboard.js over a fake SDK + DOM. data: { leaderboard:[rows], leads, knocks, invoices }. */
async function page(opts) {
  const o = opts || {};
  const reads = [];
  const els = {};
  const el = (id) => els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, querySelectorAll: () => [] });
  const btn = (cls, key, val, active) => ({
    dataset: { [key]: val }, _l: [], cls: new Set(active ? [cls, 'active'] : [cls]),
    classList: { add(c) { this._o.cls.add(c); }, remove(c) { this._o.cls.delete(c); }, contains(c) { return this._o.cls.has(c); } },
    addEventListener(t, f) { this._l.push(f); }, click() { this._l.forEach((f) => f()); },
  });
  const periods = ['day', 'week', 'month', 'all'].map((p) => btn('period-btn', 'period', p, p === 'all'));
  const tabs = ['doors', 'deals', 'revenue'].map((t) => btn('tab-btn', 'tab', t, t === 'doors'));
  periods.concat(tabs).forEach((b) => { b.classList._o = b; });
  const document = {
    documentElement: { style: {} },
    getElementById: el,
    querySelectorAll: (s) => (s === '.period-btn' ? periods : s === '.tab-btn' ? tabs : []),
  };
  const data = Object.assign({ leaderboard: [], leads: [], knocks: [], invoices: [] }, o.data || {});
  const snap = (arr) => ({ docs: arr.map((d, i) => ({ id: d.id || d.uid || String(i), data: () => Object.assign({}, d), ref: { parent: { parent: null } } })) });
  let authCb = null;
  const sdk = {
    app: { initializeApp: () => ({}) },
    auth: { getAuth: () => ({}), onAuthStateChanged: (a, cb) => { authCb = cb; } },
    firestore: {
      getFirestore: () => ({}),
      collection: (db, name) => ({ name }),
      collectionGroup: (db, name) => ({ name: 'group:' + name }),
      where: (f, op, v) => ({ where: [f, op, v] }),
      limit: (n) => ({ limit: n }),
      query: (c, ...cons) => ({ name: c.name, cons }),
      doc: (db, ...p) => ({ path: p.join('/') }),
      getDocs: async (q) => {
        reads.push({ kind: 'getDocs', name: q.name, cons: q.cons || [] });
        if (o.aggThrows && q.name === 'leaderboard') throw new Error('permission-denied');
        if (q.name === 'leaderboard') {
          const w = (q.cons || []).find((c) => c.where);
          return snap(data.leaderboard.filter((r) => !w || r[w.where[0]] === w.where[2]));
        }
        return snap(data[q.name] || []);
      },
      getDoc: async (ref) => {
        reads.push({ kind: 'getDoc', path: ref.path });
        const m = /^leaderboard\/(.+)$/.exec(ref.path);
        const d = m ? data.leaderboard.find((r) => r.uid === m[1]) : null;
        return { id: m ? m[1] : '', exists: () => !!d, data: () => Object.assign({}, d || {}) };
      },
    },
    emu: { connectEmulatorsIfLocal: async () => {} },
  };
  const W = {
    document, console: { log() {}, warn() {}, error() {} }, Date: class extends Date { constructor(...a) { if (a.length) super(...a); else super(NOW); } static now() { return NOW; } },
    Intl, Promise, setTimeout, __sdk: sdk,
  };
  W.window = W;
  const ctx = vm.createContext(W);
  ['docs/pro/js/numbers-logic.js', 'docs/pro/js/team-board-logic.js'].forEach((f) => { const s = read(f); if (s) vm.runInContext(s, ctx, { filename: f }); });
  let src = read('docs/pro/js/pages/leaderboard.js');
  src = src.replace(/import\s*\{([^}]*)\}\s*from\s*'[^']*firebase-(\w+)\.js';/g, (m, names, mod) => 'const {' + names + '} = __sdk.' + mod + ';')
    .replace(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/nbd-emulator-connect\.js';/, 'const {$1} = __sdk.emu;');
  vm.runInContext('(async () => {\n' + src + '\n})().catch((e) => { window.__err = e; });', ctx, { filename: 'leaderboard.js' });
  await tick();
  const user = { uid: o.uid || 'u1', displayName: 'Me', getIdTokenResult: async () => ({ claims: o.claims === undefined ? { companyId: 'co-a', role: 'sales_rep' } : o.claims }) };
  if (authCb) authCb(user);
  for (let i = 0; i < 8; i++) await tick();
  const active = (list) => (list.find((b) => b.cls.has('active')) || {}).dataset;
  return { W: ctx, reads, els, el, periods, tabs, active: () => ({ period: active(periods).period, tab: active(tabs).tab }), settle: async () => { for (let i = 0; i < 8; i++) await tick(); } };
}
const fanOut = (reads) => reads.filter((r) => ['leads', 'knocks', 'invoices', 'group:jobs'].indexOf(r.name) !== -1);

(async () => {
  console.log('\n1. the shared logic (team-board-logic.js)');
  ok('docs/pro/js/team-board-logic.js loads (window.NBDTeamBoard, require-able)', !!TB && ['ymdInZone', 'mondayOf', 'current', 'board', 'totals', 'usable'].every((k) => typeof TB[k] === 'function'));
  if (TB) {
    ok('the zone day key: 11:30 PM Sun Nov 1 in New York is still Nov 1 (UTC says Nov 2)', TB.ymdInZone(Z('2026-11-02T04:30:00Z'), 'America/New_York') === '2026-11-01' && TB.ymdInZone(Z('2026-11-02T04:30:00Z'), 'UTC') === '2026-11-02');
    ok('weeks start Monday', TB.mondayOf('2026-11-15') === '2026-11-09' && TB.mondayOf('2026-11-09') === '2026-11-09');
    const r = row('u1', 'Riley', M(3, 1, 0, 1), M(12, 3, 2, 2));
    ok('a row from today and this week: both periods', J(TB.current(r, NOW)) === J({ today: M(3, 1, 0, 1), week: M(12, 3, 2, 2) }));
    ok('a row from yesterday: no today numbers (never yesterday\'s as today\'s), the week still counts', J(TB.current(row('u1', 'R', M(3, 1, 0, 1), M(12, 3, 2, 2), { dayKey: '2026-11-09' }), NOW)) === J({ today: null, week: M(12, 3, 2, 2) }));
    ok('a row from last week: nothing', J(TB.current(row('u1', 'R', M(3, 1, 0, 1), M(12, 3, 2, 2), { dayKey: '2026-11-06', weekKey: '2026-11-02' }), NOW)) === J({ today: null, week: null }));
    ok('a number that is not a whole count makes that period nothing (no made-up number)', TB.current(row('u1', 'R', M(1.5, 0, 0, 0), M(-1, 0, 0, 0)), NOW).today === null && TB.current(row('u1', 'R', M(1, 0, 0, 0), { doors: '4' }), NOW).week === null);
    const rows = [row('u1', 'Riley', M(3, 1, 0, 1), M(12, 3, 2, 2)), row('u2', 'Jordan', M(5, 0, 1, 0), M(9, 1, 1, 3)), row('u3', 'Old', M(9, 9, 9, 9), M(9, 9, 9, 9), { weekKey: '2026-11-02', dayKey: '2026-11-06' })];
    ok('the board ranks the current rows by the field, stale rows left out', J(TB.board(rows, 'week', NOW, 'doors').map((x) => x.uid)) === J(['u1', 'u2']) && J(TB.board(rows, 'day', NOW, 'doors').map((x) => x.uid)) === J(['u2', 'u1']));
    ok('totals add up the board', J(TB.totals(TB.board(rows, 'week', NOW))) === J(M(21, 4, 3, 5)));
    ok('usable: Today / This week on Doors or Deals with this member\'s row current', TB.usable(rows, 'u1', 'week', 'doors', NOW) && TB.usable(rows, 'u1', 'day', 'deals', NOW));
    ok('not usable: This month, All time, the Revenue tab, no row for this member, or their row stale',
      !TB.usable(rows, 'u1', 'month', 'doors', NOW) && !TB.usable(rows, 'u1', 'all', 'doors', NOW) && !TB.usable(rows, 'u1', 'week', 'revenue', NOW)
      && !TB.usable(rows, 'u9', 'week', 'doors', NOW) && !TB.usable(rows, 'u3', 'week', 'doors', NOW) && !TB.usable(null, 'u1', 'week', 'doors', NOW));
  }

  console.log('\n2. the page with the aggregate (N reads, no fan-out)');
  const LB = read('docs/pro/js/pages/leaderboard.js');
  ok('leaderboard.html loads team-board-logic.js before the module', /<script defer src="js\/team-board-logic\.js\?v=\d+"><\/script>[\s\S]*<script type="module" src="js\/pages\/leaderboard\.js/.test(read('docs/pro/leaderboard.html')));
  {
    const rows = [row('u1', 'Riley', M(3, 1, 0, 1), M(12, 3, 2, 2)), row('u2', '<img src=x onerror=alert(1)>', M(5, 0, 1, 0), M(20, 1, 1, 3)), row('zz', 'Other Co', M(99, 0, 0, 0), M(99, 0, 0, 0), { companyId: 'co-b' })];
    const P = await page({ data: { leaderboard: rows, leads: [{ id: 'L1', userId: 'u1' }], knocks: [{ userId: 'u1' }] } });
    ok('the page ran', !P.W.__err, P.W.__err && P.W.__err.stack);
    const lb = P.reads.filter((r) => r.name === 'leaderboard');
    ok('one query of the company\'s rows: leaderboard where companyId == the claim, limited', lb.length === 1 && J(lb[0].cons) === J([{ where: ['companyId', '==', 'co-a'] }, { limit: 50 }]), J(lb));
    ok('no lead, knock, invoice or job read', fanOut(P.reads).length === 0, J(P.reads));
    ok('it opens on This week', P.active().period === 'week', J(P.active()));
    const board = P.el('board').innerHTML;
    ok('the whole team is on the board, ranked by doors this week (Jordan 20, Riley 12)', board.indexOf('20') !== -1 && board.indexOf('Riley') > board.indexOf('&lt;img'), board.slice(0, 300));
    ok('another company\'s row never shows', !/Other Co/.test(board));
    ok('a teammate\'s name is escaped', !/<img/.test(board) && /&lt;img/.test(board));
    ok('the summary is the team\'s: 32 doors, 5 deals; revenue and close rate are not claimed', P.el('sumKnocks').textContent === '32' && P.el('sumDeals').textContent === '5' && P.el('sumRevenue').textContent === '—' && P.el('sumRate').textContent === '—', J([P.el('sumKnocks').textContent, P.el('sumDeals').textContent, P.el('sumRevenue').textContent, P.el('sumRate').textContent]));
    ok('my rank banner: #2 with 12 doors', /#2/.test(P.el('my-rank-banner').innerHTML) && /12/.test(P.el('my-rank-banner').innerHTML), P.el('my-rank-banner').innerHTML);
    ok('each row says appointments and estimates sent (counted), never a close rate it does not have', /appointments/.test(board) && /estimates sent/.test(board) && !/close rate/.test(board) && !/NaN|undefined|null/.test(board), board.slice(0, 400));
    P.periods[0].click(); await P.settle();
    ok('Today: ranked by today (Jordan 5, Riley 3), still no fan-out', fanOut(P.reads).length === 0 && /5/.test(P.el('board').innerHTML) && P.el('sumKnocks').textContent === '8');
    P.tabs[1].click(); await P.settle();
    ok('Deals today from the rows (1)', P.el('sumDeals').textContent === '1' && fanOut(P.reads).length === 0);
    P.periods[2].click(); await P.settle();
    ok('This month falls back to the rep\'s own records (the old reads, once)', fanOut(P.reads).length >= 3 && P.reads.filter((r) => r.name === 'leads').length === 1, J(fanOut(P.reads)));
    P.periods[3].click(); await P.settle();
    ok('All time reuses them (no second fan-out)', P.reads.filter((r) => r.name === 'leads').length === 1);
    P.periods[1].click(); await P.settle();
    ok('back on This week the team board returns', /Riley/.test(P.el('board').innerHTML) && P.el('sumKnocks').textContent === '32');
    P.tabs[2].click(); await P.settle();
    ok('the Revenue tab is the rep\'s own collected (rows carry no money)', P.el('sumRevenue').textContent !== '—' && !/Riley/.test(P.el('board').innerHTML), P.el('board').innerHTML.slice(0, 200));
  }

  console.log('\n3. the fallback when the aggregate doc is missing');
  {
    const P = await page({ data: { leaderboard: [], leads: [{ id: 'L1', userId: 'u1', createdAt: { seconds: NOW / 1000 } }], knocks: [{ userId: 'u1', createdAt: { seconds: NOW / 1000 }, disposition: 'appointment' }] } });
    ok('no rows: the old reads run on open and the page stays on All time', fanOut(P.reads).length >= 3 && P.active().period === 'all', J(P.reads));
    ok('and shows the rep\'s own numbers as before (1 door)', P.el('sumKnocks').textContent === '1', P.el('sumKnocks').textContent);
  }
  {
    const P = await page({ data: { leaderboard: [row('u1', 'Riley', M(3, 1, 0, 1), M(12, 3, 2, 2), { dayKey: '2026-11-06', weekKey: '2026-11-02' })] } });
    ok('a row from last week (the aggregate stopped): the old reads, never last week\'s numbers', fanOut(P.reads).length >= 3 && P.active().period === 'all' && P.el('sumKnocks').textContent !== '12');
  }
  {
    const P = await page({ aggThrows: true, data: { knocks: [{ userId: 'u1', createdAt: { seconds: NOW / 1000 } }] } });
    ok('a refused aggregate read: the old reads, the page still works', !P.W.__err && fanOut(P.reads).length >= 3 && P.el('sumKnocks').textContent === '1');
  }
  {
    const P = await page({ claims: {}, uid: 'solo', data: { leaderboard: [Object.assign(row('solo', 'Solo', M(2, 0, 0, 0), M(4, 0, 0, 0)), { companyId: 'solo' })] } });
    const lb = P.reads.filter((r) => r.path === 'leaderboard/solo');
    ok('a solo owner (no companyId claim) reads only their own row (one getDoc), no fan-out', lb.length === 1 && fanOut(P.reads).length === 0 && P.el('sumKnocks').textContent === '4', J(P.reads));
  }
  ok('the four fan-out queries are still there for the fallback', /where\('userId', '==', uid\)/.test(LB) && /collectionGroup\(db, 'jobs'\)/.test(LB));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
