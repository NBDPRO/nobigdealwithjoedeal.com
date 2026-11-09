/**
 * tests/nbd-os-team-widget-2026-11-09.test.js - NBD OS P2 "Team": the owner's
 * Team widget on the NBD OS home (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §5, §8 P2).
 *
 * The widget reads the company's leaderboard rows (functions/leaderboard-aggregate.js;
 * one query on the companyId claim, at most 50 docs, at most every 5 minutes, only
 * while it is on screen) through team-board-logic.js, and shows the team's counted
 * doors, appointments, estimates sent and deals: S one number, M today's totals and
 * the top three, L today and this week with up to six people and the leaderboard
 * link. It is OWNER-only (catalog owner:true): the solo owner, the company-keyed
 * owner or a company_admin; a rep, manager or viewer never gets it painted, it is
 * left out of their Add sheet, and an owner-published home that holds it stays
 * saved for them untouched. Renderers live in os/team.js, the runtime ScriptLoader
 * bundle 'osteam' home.js registers and loads on first paint (layout-system.js
 * needs is full). No number that was not counted: stale rows say so with no
 * number, missing rows show a plain line, and a refused read shows Retry.
 *
 * Run: node tests/nbd-os-team-widget-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const tick = () => new Promise((r) => setImmediate(r));
const TEAM_JS = read('docs/pro/js/os/team.js');
const TEAM_CSS = read('docs/pro/css/os/team.css');
const HOME_JS = read('docs/pro/js/os/home.js');

// the harness clock: Mon Nov 9 2026, 1:05 PM local; the rows say today in the harness's own zone
const NOW = H.NOW;
const pad = (n) => (n < 10 ? '0' : '') + n;
const d = new Date(NOW);
const TODAY = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const M = (doors, appts, estimates, deals) => ({ doors, appts, estimates, deals });
const row = (uid, name, today, week, extra) => Object.assign({ companyId: 'c1', uid, name, tz: TZ, tzSet: true, dayKey: TODAY, weekKey: TODAY, today, week, asOfMs: NOW - 5 * 60000 }, extra || {});
const ROWS = [row('u1', 'Sam Owner', M(4, 1, 1, 0), M(20, 4, 3, 1)), row('u2', 'Riley <b>Rep</b>', M(9, 2, 0, 1), M(30, 5, 2, 2)), row('u3', 'Jordan', M(0, 0, 0, 0), M(6, 0, 1, 0))];

/** A home holding these items on the desk (or phone), the firestore globals answering with rows. */
async function mount(items, opts) {
  const o = opts || {};
  const phone = !!o.phone;
  const fsCalls = [];
  const T = makeWin(Object.assign({ surface: phone ? 'phone' : 'desk', loader: true, home: phone ? { phone: items, desk: [] } : { phone: [], desk: items } }, o));
  {
    {
      const W = T.W;
      W.collection = (db, name) => { fsCalls.push(['collection', name]); return { name }; };
      W.where = (f, op, v) => ({ where: [f, op, v] });
      W.limit = (n) => ({ limit: n });
      W.query = (c, ...cons) => ({ name: c.name, cons });
      W.doc = (db, ...p) => ({ path: p.join('/') });
      W.getDocs = (q) => {
        fsCalls.push(['getDocs', q.name, J(q.cons)]);
        if (o.fail) return Promise.reject(new Error('permission-denied'));
        const rows = o.rows === undefined ? ROWS : o.rows;
        return Promise.resolve({ docs: rows.map((r) => ({ id: r.uid, data: () => JSON.parse(JSON.stringify(r)) })) });
      };
      W.getDoc = (ref) => {
        fsCalls.push(['getDoc', ref.path]);
        const r = (o.rows || ROWS).find((x) => 'leaderboard/' + x.uid === ref.path);
        return Promise.resolve({ id: ref.path.split('/').pop(), exists: () => !!r, data: () => JSON.parse(JSON.stringify(r || {})) });
      };
    }
  }
  T.W._impl.mount({ surface: phone ? 'phone' : 'desktop' });
  for (let i = 0; i < 6; i++) await tick();
  const ph = phone ? T.document.getElementById('osPhone') : T.document.querySelector('.os-widgets');
  return { T, ph, fsCalls, card: (k) => byKey(ph, k) };
}

(async () => {
  console.log('\n1. the catalog entry');
  const c = HL && HL.CATALOG.teamboard;
  ok('teamboard (Team): sizes S/M/L, owner-only, its own bundle, in the Today group', !!c && J(c.sizes) === J(['s', 'm', 'l']) && c.owner === true && c.bundle === 'osteam' && c.cat === 'today', J(c));
  ok('declares its read cost: up to 50 docs (the company\'s rows), and the refresh floor', !!c && c.reads === 50 && c.refreshMin === 5, J(c));
  ok('its id is teamboard: .os-hw-team is already the layout\'s Publish / Lock group', !!HL && !HL.CATALOG.team);
  ok('listed in the catalog order (the Add sheet)', !!HL && HL.ids().indexOf('teamboard') !== -1);
  ok('a saved team widget survives normalize at each size', !!HL && ['s', 'm', 'l'].every((s) => J(HL.normalize({ v: 1, phone: [{ id: 'teamboard', s }], desk: [] }).phone) === J([{ id: 'teamboard', s }])));

  console.log('\n2. the owner sees the team');
  {
    const { T, card, fsCalls } = await mount([{ id: 'teamboard', s: 'l' }]);
    const el = card('teamboard-1');
    const t = text(el);
    ok('painted for the owner', !!el && /Team/.test(t), t);
    // (integration: the desk also loads the action runner's cmdrunner bundle at mount, os-p2-runner)
    ok('the bundle osteam loaded once: team-board-logic.js, os/team.js and its css', J(T.W.ScriptLoader.calls.filter((b) => b !== 'cmdrunner')) === J(['osteam']) && J(T.W.ScriptLoader.bundles.osteam.map((s) => s.replace(/\?.*$/, ''))) === J(['css/os/team.css', 'js/team-board-logic.js', 'js/os/team.js']));
    ok('one read: leaderboard where companyId == the claim, limit 50', J(fsCalls.filter((x) => x[0] === 'getDocs')) === J([['getDocs', 'leaderboard', J([{ where: ['companyId', '==', 'c1'] }, { limit: 50 }])]]), J(fsCalls));
    ok('L: today\'s totals (13 doors, 3 appointments, 1 estimate, 1 deal)', /13 doors/.test(t) && /3 appointments/.test(t) && /1 estimate(?!s)/.test(t) && /1 deal(?!s)/.test(t), t);
    ok('L: this week\'s totals (56 doors, 3 deals)', /56 doors/.test(t) && /3 deals/.test(t), t);
    ok('L: people ranked by doors this week (Riley 30, Sam 20, Jordan 6)', t.indexOf('Riley') < t.indexOf('Sam Owner') && t.indexOf('Sam Owner') < t.indexOf('Jordan'), t);
    ok('names escaped (the <b> in a name is text, not markup)', !!el && !el.querySelector('b') && /Riley <b>Rep<\/b>/.test(t), el && el.innerHTML.slice(0, 300));
    ok('L: a link to the full leaderboard', !!el && !!el.querySelector('a[href="/pro/leaderboard.html"]'));
    ok('L: when it was counted', /Updated/.test(t), t);
    const nums = (t.match(/\d+/g) || []).map(Number);
    ok('every number on it is a count from the rows (or the time)', nums.every((n) => [13, 3, 1, 56, 9, 2, 0, 4, 20, 30, 5, 6, 12, 7].indexOf(n) !== -1 || n < 60), J(nums));
    // repaint without a new read inside the 5-minute floor
    T.W.dispatchEvent(new T.W.CustomEvent('nbd:data-refreshed'));
    for (let i = 0; i < 4; i++) await tick();
    ok('a repaint inside 5 minutes reads nothing new', fsCalls.filter((x) => x[0] === 'getDocs').length === 1);
  }
  {
    const { card } = await mount([{ id: 'teamboard', s: 's' }]);
    const t = text(card('teamboard-1'));
    ok('S: one number, the team\'s doors today', /13/.test(t) && /doors today/.test(t) && !/56/.test(t), t);
  }
  {
    const { card } = await mount([{ id: 'teamboard', s: 'm' }]);
    const t = text(card('teamboard-1'));
    ok('M: today\'s totals and the top three by doors today', /13 doors/.test(t) && t.indexOf('Riley') < t.indexOf('Sam Owner') && /Jordan/.test(t) && !/this week/i.test(t), t);
  }
  {
    const { card } = await mount([{ id: 'teamboard', s: 'm' }], { phone: true });
    ok('it paints on the phone page too', /13 doors/.test(text(card('teamboard-1'))), text(card('teamboard-1')));
  }
  {
    const { fsCalls, card } = await mount([{ id: 'teamboard', s: 'm' }], { claims: {}, uid: 'u1' });
    ok('a solo owner (no claims) reads only their own row', J(fsCalls.filter((x) => x[0] !== 'collection')) === J([['getDoc', 'leaderboard/u1']]) && /4 doors/.test(text(card('teamboard-1'))), J(fsCalls));
  }

  console.log('\n3. no number that was not counted');
  {
    const stale = ROWS.map((r) => Object.assign({}, r, { dayKey: '2026-11-08', weekKey: '2026-11-02' }));
    const { card } = await mount([{ id: 'teamboard', s: 'l' }], { rows: stale });
    const t = text(card('teamboard-1'));
    ok('rows from an earlier week: a plain line, no number', !/\d/.test(t.replace(/Updated[^.]*$/, '')) && /not counted|no team numbers|not been counted/i.test(t), t);
  }
  {
    const y = ROWS.map((r) => Object.assign({}, r, { dayKey: '2026-11-08' }));
    const { card } = await mount([{ id: 'teamboard', s: 's' }], { rows: y });
    const t = text(card('teamboard-1'));
    ok('rows from yesterday: S says the week\'s doors, labelled this week (never yesterday\'s as today\'s)', /56/.test(t) && /this week/.test(t) && !/today/.test(t), t);
  }
  {
    const { card } = await mount([{ id: 'teamboard', s: 'm' }], { rows: [] });
    const t = text(card('teamboard-1'));
    ok('no rows yet: says so, no number', !/\d/.test(t) && /every 30 minutes|once they are counted/i.test(t), t);
  }
  {
    const { T, card, fsCalls } = await mount([{ id: 'teamboard', s: 'm' }], { fail: true });
    const el = card('teamboard-1');
    ok('a refused read: Couldn\'t load with Retry, no number', !!el && /Couldn.t load/.test(text(el)) && !!el.querySelector('[data-oshw-retry="team"]') && !/\d/.test(text(el)), text(el));
    if (el && el.querySelector('[data-oshw-retry="team"]')) click(T.dom, el.querySelector('[data-oshw-retry="team"]'));
    for (let i = 0; i < 4; i++) await tick();
    ok('Retry reads again', fsCalls.filter((x) => x[0] === 'getDocs').length === 2);
  }

  console.log('\n4. the role gate (owner only)');
  for (const role of ['sales_rep', 'manager', 'viewer']) {
    const { T, card, fsCalls } = await mount([{ id: 'glance', s: 'm' }, { id: 'teamboard', s: 'm' }], { claims: { role, companyId: 'c1' }, uid: 'u2' });
    ok(role + ': the Team widget is not painted and nothing is read', !card('teamboard-1') && !!card('glance-1') && fsCalls.length === 0 && !(T.W.ScriptLoader.calls || []).includes('osteam'), J(fsCalls));
    const L = T.W.NBDOSLayout.state();
    L.home.setEditing(true);
    L.home.openAdd();
    const dlg = T.document.querySelector('dialog.os-hw-add');
    ok(role + ': Team is not in the Add sheet', !!dlg && !dlg.querySelector('[data-oshw-add="teamboard"]'));
  }
  {
    const { T } = await mount([{ id: 'glance', s: 'm' }]);
    const L = T.W.NBDOSLayout.state();
    L.home.setEditing(true);
    L.home.openAdd();
    const dlg = T.document.querySelector('dialog.os-hw-add');
    const b = dlg && dlg.querySelector('[data-oshw-add="teamboard"]');
    const g = b && b.closest('.os-hw-add-group');
    ok('the owner finds Team in the Add sheet, under Today', !!b && text(g.querySelector('h3')) === 'Today');
  }
  {
    const { T } = await mount([{ id: 'teamboard', s: 'm' }, { id: 'glance', s: 'm' }], { claims: { role: 'company_admin', companyId: 'c1' }, uid: 'u7' });
    ok('a company_admin gets it', !!byKey(T.document.querySelector('.os-widgets'), 'teamboard-1'));
  }

  console.log('\n5. CSP, floors and boot');
  const code = noComments(TEAM_JS);
  ok('os/team.js exists; no style attribute, no inline handler, no el.style', !!TEAM_JS && !/style="|\son[a-z]+=|\.style\b/.test(code));
  ok('every value goes through esc', /esc\(/.test(TEAM_JS) && !/\+\s*r\.name\s*\+/.test(code));
  ok('team.css: no text under 11px, no motion', !!TEAM_CSS && !/font-size:\s*(?:[0-9]|10)(?:\.\d+)?px/.test(TEAM_CSS) && !/transition|animation/.test(TEAM_CSS));
  ok('home.js registers the bundle itself (no <script> tag, layout-system.js untouched)', /osteam/.test(HOME_JS) && !/team\.js/.test(read('docs/pro/dashboard.html')) && !/os\/team/.test(read('docs/pro/js/layout-system.js')));
  ok('reads at most every 5 minutes, only from a paint (no timer of its own)', /5 \* 60000|300000/.test(TEAM_JS) && !/setInterval/.test(code));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
