/**
 * tests/nbd-os-company-home-2026-11-09.test.js - NBD OS P1 "Company home"
 * (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §3.5, §8 P1).
 *
 *   1. home-logic resolveHome: company lock > own home > company default >
 *      built-in, per surface; the lock binds members, not owners/admins, and
 *      only a surface with a published home; a member on a company home gets
 *      only the business half of Coach and Daily Success
 *   2. setSurface: an edit replaces one surface of the member's own key, so a
 *      surface still on the company home stays on it
 *   3. the layout (real os.js + home.js over the fake DOM): a member on a
 *      locked home sees the company's widgets, gets no edit mode by any way in
 *      (long-press, Edit Home, the Control Center tile), sees why, and saves nothing
 *   4. an unlocked member starts on the company default; their first edit
 *      becomes their own home (copy on write) and the company's is not touched
 *   5. Daily Success on a company home shows the member's OWN business counts
 *      only: never the personal half, never another member's summary
 *   6. owners and admins in edit mode get "Publish to team" (a <dialog> asks
 *      first) and a "Lock team homes" switch, OFF by default; publishing writes
 *      only ids/sizes/cfg through LayoutEngine.saveCompany; reps, managers and
 *      viewers never see either control
 *   7. the owner's code is a lazy ScriptLoader bundle registered at runtime
 *      (no new <script> tag, no layout-system needs slot), escaped, no inline
 *      handlers or style attributes, 44px targets
 *
 * Run: node tests/nbd-os-company-home-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const vm = require('vm');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, byKey, hw, text, click, fire, noComments, NOW, DK } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const GA = async (fn) => { try { await fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const HL = require(path.join(ROOT, 'docs/pro/js/os/home-logic.js'));
const OS_JS = read('docs/pro/js/layouts/os.js');
const CO_JS = read('docs/pro/js/os/home-company.js');
const HOME_CSS = read('docs/pro/css/os/home.css');
const DASH = read('docs/pro/dashboard.html');
const LAYOUT_SYS = read('docs/pro/js/layout-system.js');

const CO_PHONE = [{ id: 'daily', s: 'm', cfg: { show: 'both' } }, { id: 'upnext', s: 'm' }];
const CO_DESK = [{ id: 'coach', s: 'l' }, { id: 'glance', s: 'm' }];
const OWN = { v: 1, phone: [{ id: 'glance', s: 's' }, { id: 'shortcuts', s: 's' }], desk: [{ id: 'upnext', s: 'l' }] };
const REP = { role: 'sales_rep', companyId: 'c1' };
const ADMIN = { role: 'company_admin', companyId: 'c1' };
const coDoc = (locked) => ({ defaultWidgets: { 'os-phone': CO_PHONE, 'os-desk': CO_DESK, bento: [{ widgetId: 'rev' }] }, homeLocked: !!locked });
const ids = (root) => hw(root).map((n) => n.getAttribute('data-oshw'));
const phoneOf = (T) => T.document.getElementById('osPhone');
const deskCol = (T) => T.document.getElementById('osDesk').querySelector('.os-widgets');
const homeSaves = (T) => (T.W._saves || []).filter((p) => p && p.layoutState && p.layoutState['os-home']);
const mount = (surface, o) => {
  const T = makeWin(Object.assign({ surface: surface === 'phone' ? 'phone' : 'desktop' }, o || {}));
  T.W._impl.mount({ surface: surface === 'phone' ? 'phone' : 'desktop' });
  return T;
};
// what the dashboard does at runtime: ScriptLoader.loadBundle runs the bundle's files
function withLoader(T) {
  T.loads = [];
  T.W.ScriptLoader = {
    bundles: {},
    loadBundle(name) {
      T.loads.push(name);
      (T.W.ScriptLoader.bundles[name] || []).forEach((f) => vm.runInContext(read('docs/pro/' + f.split('?')[0]), T.W, { filename: f }));
      return Promise.resolve();
    },
  };
  return T;
}
const tick = () => new Promise((r) => setImmediate(r));
// the focused element, only while it is still in the page (a repaint detaches the old node)
const live = (T) => { const a = T.document.activeElement; return a && a !== T.document.body && T.document.body.contains(a) ? a : null; };
const focusOf = (T) => { const a = T.document.activeElement; return a ? (a.tagName + ' ' + J(a.attrs) + ' live=' + !!live(T)) : 'null'; };
const summary = (uid, over) => JSON.stringify(Object.assign({ v: 1, uid, asOf: NOW - 20 * 60000, calls: 3, followUps: 5, jobs: 2 }, over || {}));
const snap = () => JSON.stringify({ asOf: NOW - 2 * 3600000, today: { dk: DK, floors: [{ met: true }, { met: true }, { met: false }] }, streak: { warned: false, broken: false }, week: { pct: 86 } });

// ═════════════════════════════════════════════════════════════════════════
console.log('\n1. resolveHome precedence: company lock > own home > company default > built-in');
G(() => {
  const co = coDoc(false).defaultWidgets;
  const r0 = HL.resolveHome({});
  ok('nothing anywhere: the built-in default on both surfaces', J(r0.phone) === J(HL.defaults().phone) && r0.src.phone === 'default' && r0.src.desk === 'default', J(r0));
  const r1 = HL.resolveHome({ company: co });
  ok('no home of my own: the company default', r1.src.phone === 'company-default' && J(r1.phone.map((x) => x.id)) === J(['daily', 'upnext']) && r1.src.desk === 'company-default', J(r1));
  const r2 = HL.resolveHome({ own: OWN, company: co });
  ok('my own home beats the company default', r2.src.phone === 'user' && J(r2.phone) === J(OWN.phone) && r2.src.desk === 'user', J(r2));
  const r3 = HL.resolveHome({ own: OWN, company: co, locked: true });
  ok('a company lock beats my own home', r3.src.phone === 'company-lock' && J(r3.phone.map((x) => x.id)) === J(['daily', 'upnext'])
    && r3.src.desk === 'company-lock' && J(r3.desk.map((x) => x.id)) === J(['coach', 'glance']), J(r3));
  const r4 = HL.resolveHome({ own: OWN, company: co, locked: true, admin: true });
  ok('the lock binds members, not the owner or admin who set it', r4.src.phone === 'user' && J(r4.phone) === J(OWN.phone), J(r4));
  const r5 = HL.resolveHome({ own: OWN, company: { 'os-phone': CO_PHONE }, locked: true });
  ok('a lock with no published desk home leaves my own desk home', r5.src.phone === 'company-lock' && r5.src.desk === 'user' && J(r5.desk) === J(HL.normalize(OWN).desk), J(r5));   // the desk gains its board cells (P1 board)
  const r6 = HL.resolveHome({ own: { v: 1, phone: [{ id: 'glance', s: 'm' }] }, company: co });
  ok('per surface: my phone is mine, my desk (never edited) follows the company', r6.src.phone === 'user' && r6.src.desk === 'company-default', J(r6.src));
  const r7 = HL.resolveHome({ own: { v: 1, phone: [] }, company: co, locked: false });
  ok('an empty own phone home is a choice, not a fallback', r7.src.phone === 'user' && r7.phone.length === 0);
  ok('a company home of garbage is no company home', HL.resolveHome({ company: { 'os-phone': [{ id: 'nope' }, 7] }, locked: true }).src.phone === 'default');
  ok('a non-array company home is ignored', HL.resolveHome({ company: { 'os-phone': { id: 'glance' } } }).src.phone === 'default');
  ok('the lock must be the boolean true', HL.resolveHome({ own: OWN, company: co, locked: 'yes' }).src.phone === 'user');
  ok('unknown widgets in a company home are dropped, sizes fixed to what the widget offers',
    J(HL.companyList({ 'os-desk': [{ id: 'coach', s: 's' }, { id: 'evil', s: 'm' }] }, 'desk')) === J([{ id: 'coach', s: 'm', x: 0, y: 0, w: 2, h: 1 }]));
  // business half only, for members
  const daily = r3.phone.filter((x) => x.id === 'daily')[0];
  ok('a member on a locked company home: Daily Success shows the business half only', daily && daily.cfg && daily.cfg.show === 'business', J(daily));
  const coach = r3.desk.filter((x) => x.id === 'coach')[0];
  ok('…and Coach the business half only', coach && coach.cfg && coach.cfg.show === 'business', J(coach));
  ok('…on an unlocked company default too', r1.phone[0].cfg.show === 'business' && r1.desk[0].cfg.show === 'business');
  ok('widgets with no personal half are left as published', J(r1.phone[1]) === J({ id: 'upnext', s: 'm' }));
  const ra = HL.resolveHome({ company: co, admin: true });
  ok('an admin previewing the company default sees it as published', J(ra.phone[0].cfg) === J({ show: 'both' }), J(ra.phone[0]));
  ok('the member\'s own home keeps its own Daily Success settings', HL.resolveHome({ own: { phone: [{ id: 'daily', s: 'm', cfg: { show: 'personal' } }] } }).phone[0].cfg.show === 'personal');
  ok('resolveHome never changes its inputs', J(co['os-phone']) === J(CO_PHONE));
});

console.log('\n2. setSurface: copy on write, one surface at a time');
G(() => {
  const k = HL.setSurface(null, 'phone', [{ id: 'glance', s: 'l' }]);
  ok('a first edit writes only the edited surface', J(k) === J({ v: 1, phone: [{ id: 'glance', s: 'l' }] }), J(k));
  ok('…so the desk stays on the company default', HL.resolveHome({ own: k, company: coDoc().defaultWidgets }).src.desk === 'company-default');
  const k2 = HL.setSurface(OWN, 'desk', [{ id: 'coach', s: 'm' }]);
  ok('an own surface already saved is kept', J(k2.phone) === J(OWN.phone) && J(k2.desk) === J([{ id: 'coach', s: 'm', x: 0, y: 0, w: 2, h: 1 }]), J(k2));
  ok('the list is cleaned (unknown ids dropped)', J(HL.setSurface({}, 'phone', [{ id: 'x' }, { id: 'upnext', s: 'l', junk: 1 }]).phone) === J([{ id: 'upnext', s: 'l' }]));
});

console.log('\n3. a member on a locked home: the company\'s widgets, no edit mode, and why');
G(() => {
  const T = mount('phone', { claims: REP, home: OWN, company: coDoc(true), system: true });
  const P = phoneOf(T);
  ok('the phone shows the company home, not the member\'s own', J(ids(P)) === J(['daily-1', 'upnext-1']), J(ids(P)));
  const card = byKey(P, 'daily-1');
  fire(T.dom, card, 'pointerdown', { pointerId: 3 });
  T.fire(550);
  ok('a long-press on a widget does not enter edit mode', !card.classList.contains('is-editing') && !P.querySelector('.os-hw-edit'));
  ok('…and says why', T.W.toasts.some((t) => /company set this home/i.test(t.msg)), J(T.W.toasts));
  const tile = (T.W.controls || []).filter((c) => c.id === 'os-home-edit')[0];
  T.fire(1500);
  if (tile) tile.run();
  ok('the Control Center Edit Home tile does not enter it either', !!tile && !P.querySelector('.os-hw-edit'));
  // a long-press on an icon still lets them move apps, but the widgets stay as set
  const icon = P.querySelector('.os-p-icon');
  fire(T.dom, icon, 'pointerdown', { pointerId: 4 });
  T.fire(550);
  ok('a long-press on an app still edits the apps', !!P.querySelector('.os-p-edit'), P.innerHTML.slice(0, 200));
  ok('…the widgets get no edit chrome', !P.querySelector('.os-hw-edit') && !byKey(P, 'daily-1').classList.contains('is-editing'));
  ok('…there is no Add widget button', !P.querySelector('[data-osp="homeadd"]'));
  ok('…and the bar says the company set the widgets', /company set the widgets/i.test(text(P.querySelector('.os-p-edit'))), text(P.querySelector('.os-p-edit')));
  ok('…a rep never sees Publish to team or the lock switch', !P.querySelector('[data-osp="homepublish"]') && !P.querySelector('[data-osp="homelock"]'));
  T.fire(700);
  ok('nothing was saved to the member\'s home', homeSaves(T).length === 0, J(T.W._saves));
  ok('nothing was written to the company', !(T.W._coSaves || []).length);

  const D = mount('desk', { claims: REP, home: OWN, company: coDoc(true) });
  const col = deskCol(D);
  ok('the desk shows the company desk home', J(ids(col)) === J(['coach-1', 'glance-1']), J(ids(col)));
  ok('the desk has no Edit Home button', !col.querySelector('[data-osdo="homeedit"]'));
  ok('…it says the company set this home instead', /company set this home/i.test(text(col.querySelector('.os-hw-locked'))));
  ok('…Wallpaper stays', !!col.querySelector('[data-osdo="wallpaper"]'));
  const coach = byKey(col, 'coach-1');
  fire(D.dom, coach, 'pointerdown', { pointerId: 5 });
  D.fire(550);
  ok('a long-press on a desk widget does not enter edit mode', !coach.classList.contains('is-editing'));
  ok('the locked Coach is the business half', /business/.test(J(D.W.NBDOSHomeLogic.resolveHome({ company: coDoc(true).defaultWidgets, locked: true }).desk[0].cfg)));
});

console.log('\n4. unlocked: a member starts on the company default and their first edit is theirs');
G(() => {
  const T = mount('desk', { claims: REP, company: coDoc(false) });
  const col = deskCol(T);
  ok('a new member sees the company desk home', J(ids(col)) === J(['coach-1', 'glance-1']), J(ids(col)));
  ok('Edit Home is there (no lock)', !!col.querySelector('[data-osdo="homeedit"]'));
  click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
  ok('edit mode is on', !!col.querySelector('.os-hw-edit'));
  ok('a rep in edit mode sees no Publish to team or lock switch', !col.querySelector('[data-osdo="homepublish"]') && !col.querySelector('[data-osdo="homelock"]'));
  click(T.dom, byKey(col, 'glance-1').querySelector('[data-oshw-ed="remove"]'));
  T.fire(700);
  const s = homeSaves(T);
  const key = s.length && s[s.length - 1].layoutState['os-home'];
  ok('the edit is saved as the member\'s own desk home', key && J(key.desk.map((x) => x.id)) === J(['coach']), J(key));
  ok('…the phone, never edited, is not copied in (it stays on the company home)', key && !('phone' in key), J(key));
  ok('…the business-only Coach went with it', key && key.desk[0].cfg && key.desk[0].cfg.show === 'business');
  ok('the company home was not written', !(T.W._coSaves || []).length);
  ok('the desk now shows their own', J(ids(col)) === J(['coach-1']));
});

console.log('\n5. Daily Success on a company home: the member\'s own business counts only');
G(() => {
  const store = { nbd_today_summary: summary('u2'), nbd_ds_snapshot: snap() };
  const T = mount('phone', { claims: REP, uid: 'u2', company: coDoc(true), store });
  const t = text(byKey(phoneOf(T), 'daily-1'));
  ok('the member\'s own calls / follow-ups left show', /3 calls/.test(t) && /5 follow-ups/.test(t), t);
  ok('the personal half (floors, streak, week %) does not', !/Floors|2\/3|86%|streak/i.test(t), t);
  ok('no "Open Daily Success" personal prompt either', !/Open Daily Success/.test(t), t);
  const other = mount('phone', { claims: REP, uid: 'u2', company: coDoc(true), store: { nbd_today_summary: summary('owner-uid', { calls: 41 }) } });
  const t2 = text(byKey(phoneOf(other), 'daily-1'));
  ok('another member\'s summary on this device never shows', !/41/.test(t2) && /load with your Today list/.test(t2), t2);
  ok('the company doc carries no numbers to show (ids, sizes and enum settings only)',
    HL.companyList({ 'os-phone': [{ id: 'daily', s: 'm', cfg: { show: 'both', calls: 41 }, met: 3 }] }, 'phone').every((x) => J(Object.keys(x)) === J(['id', 's', 'cfg']) && J(x.cfg) === J({ show: 'both' })));
  ok('read cost 0', T.reads.length === 0 && other.reads.length === 0, J(T.reads));
});

(async () => {
  console.log('\n6. owners and admins: Publish to team (asked first) and Lock team homes (off by default)');
  await GA(async () => {
    const T = withLoader(mount('desk', { claims: ADMIN, home: OWN, company: { defaultWidgets: { bento: [{ widgetId: 'rev' }] } } }));
    const col = deskCol(T);
    ok('not in edit mode: no team controls', !col.querySelector('[data-osdo="homepublish"]'));
    click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
    const pub = col.querySelector('[data-osdo="homepublish"]');
    const lock = col.querySelector('[data-osdo="homelock"]');
    ok('an admin in edit mode sees Publish to team', !!pub && /Publish to team/.test(text(pub)));
    ok('…and a Lock team homes switch', !!lock && lock.getAttribute('role') === 'switch' && /Lock team homes/.test(text(lock)));
    ok('the switch is OFF by default', lock && lock.getAttribute('aria-checked') === 'false' && !lock.classList.contains('is-on'));
    ok('nothing loads until a tap', !T.loads.length);
    click(T.dom, pub);
    await tick();
    ok('the first tap loads the oshomeco bundle at runtime', J(T.loads) === J(['oshomeco']) && J(T.W.ScriptLoader.bundles.oshomeco) === J(['js/os/home-company.js?v=1']));
    const d = T.document.querySelector('dialog.os-hw-pub');
    ok('a native <dialog> asks first (showModal)', !!d && d.modal === true);
    ok('nothing is written before the owner confirms', !(T.W._coSaves || []).length);
    ok('it names the surface and the widgets', d && /laptop home/.test(text(d)) && /Up Next/.test(text(d)), d && text(d));
    ok('it says no numbers are sent and members see the business half', d && /never your numbers/.test(text(d)) && /business half/.test(text(d)));
    ok('Cancel has focus (the safe choice)', T.document.activeElement && T.document.activeElement.getAttribute('data-oshw-pub') === 'cancel');
    click(T.dom, d.querySelector('[data-oshw-pub="cancel"]'));
    ok('Cancel closes it and writes nothing', !T.document.querySelector('dialog.os-hw-pub') && !(T.W._coSaves || []).length);
    const pubAgain = col.querySelector('[data-osdo="homepublish"]');
    pubAgain.focus();
    click(T.dom, pubAgain);
    await tick();
    const d2 = T.document.querySelector('dialog.os-hw-pub');
    click(T.dom, d2.querySelector('[data-oshw-pub="go"]'));
    await tick(); await tick();
    const w = (T.W._coSaves || [])[0];
    ok('Publish writes through LayoutEngine.saveCompany', !!w, J(T.W._coSaves));
    ok('…the desk home as the company os-desk default', w && J(w.defaultWidgets['os-desk']) === J(OWN.desk), w && J(w));
    ok('…ids and sizes only', w && w.defaultWidgets['os-desk'].every((x) => Object.keys(x).every((k) => ['id', 's', 'cfg'].indexOf(k) !== -1)));
    ok('…the Bento default board is kept', w && J(w.defaultWidgets.bento) === J([{ widgetId: 'rev' }]));
    ok('…and it does not touch the lock', w && !('homeLocked' in w));
    ok('the dialog closed and a toast says it published', !T.document.querySelector('dialog.os-hw-pub') && T.W.toasts.some((t) => /Published/.test(t.msg)), J(T.W.toasts));
    ok('after the publish repaint, focus is back on Publish to team (never dropped to <body>)', live(T) && live(T).getAttribute('data-osdo') === 'homepublish', focusOf(T));
    const lockBtn = col.querySelector('[data-osdo="homelock"]');
    lockBtn.focus();
    click(T.dom, lockBtn);
    await tick(); await tick();
    ok('after the lock repaint, focus is on the Lock team homes switch again', live(T) && live(T).getAttribute('data-osdo') === 'homelock' && live(T).getAttribute('aria-checked') === 'true', focusOf(T));
    const w2 = T.W._coSaves[T.W._coSaves.length - 1];
    ok('the lock switch writes homeLocked: true (no dialog)', w2 && J(w2) === J({ homeLocked: true }), J(w2));
    const lock2 = col.querySelector('[data-osdo="homelock"]');
    ok('the switch now reads ON', lock2 && lock2.getAttribute('aria-checked') === 'true' && lock2.classList.contains('is-on'));
    ok('the admin who locked it can still edit (lock binds members)', !!col.querySelector('.os-hw-edit'));
    click(T.dom, lock2);
    await tick(); await tick();
    ok('tapping it again turns it off', J(T.W._coSaves[T.W._coSaves.length - 1]) === J({ homeLocked: false }));
    ok('…and says members can change their own again', T.W.toasts.some((t) => /unlocked/i.test(t.msg)));

    const F = withLoader(mount('phone', { claims: { companyId: 'u1' }, uid: 'u1', home: OWN, coSaveFails: true, system: true }));
    const P = phoneOf(F);
    fire(F.dom, P.querySelector('.os-p-icon'), 'pointerdown', { pointerId: 6 });
    F.fire(550);
    const pp = P.querySelector('[data-osp="homepublish"]');
    ok('the solo owner (uid == companyId) gets the controls on the phone too', !!pp && !!P.querySelector('[data-osp="homelock"]'));
    ok('…in their own row under the edit bar', !!P.querySelector('.os-hw-team [data-osp="homepublish"]'));
    click(F.dom, pp);
    await tick();
    click(F.dom, F.document.querySelector('dialog.os-hw-pub [data-oshw-pub="go"]'));
    await tick(); await tick();
    ok('on the phone too, focus returns to Publish to team after the repaint', live(F) && live(F).getAttribute('data-osp') === 'homepublish', focusOf(F));
    const pl = P.querySelector('[data-osp="homelock"]');
    pl.focus();
    click(F.dom, pl);
    await tick(); await tick();
    ok('…and to the lock switch after a lock tap (even a refused one)', live(F) && live(F).getAttribute('data-osp') === 'homelock', focusOf(F));
    ok('a refused write says so (no false "Published")', F.W.toasts.some((t) => /Couldn't publish/.test(t.msg)) && !F.W.toasts.some((t) => /^Published/.test(t.msg)), J(F.W.toasts));
    ok('the phone publish targets os-phone', J(Object.keys(F.W._coSaves[0].defaultWidgets)) === J(['os-phone']));

    ['manager', 'viewer', 'sales_rep'].forEach((role) => {
      const R = mount('desk', { claims: { role, companyId: 'c1' }, company: coDoc(false) });
      const c = deskCol(R);
      const e = c.querySelector('[data-osdo="homeedit"]');
      if (e) click(R.dom, e);
      ok(role + ' never sees Publish to team or the lock', !c.querySelector('[data-osdo="homepublish"]') && !c.querySelector('[data-osdo="homelock"]'));
    });
    const M = mount('phone', { claims: { role: 'manager', companyId: 'c1' }, company: coDoc(false) });
    fire(M.dom, phoneOf(M).querySelector('.os-p-icon'), 'pointerdown', { pointerId: 7 });
    M.fire(550);
    ok('…nor on the phone', !phoneOf(M).querySelector('[data-osp="homepublish"]'));
  });

  console.log('\n7. settings that arrive after mount, and the wiring');
  await GA(async () => {
    const T = mount('desk', { claims: REP, home: OWN });
    const col = deskCol(T);
    click(T.dom, col.querySelector('[data-osdo="homeedit"]'));
    ok('editing their own home', !!col.querySelector('.os-hw-edit'));
    T.W.LayoutEngine.saveCompany({ defaultWidgets: { 'os-desk': CO_DESK }, homeLocked: true });
    await tick();
    (T.document.listeners['nbd:layout-prefs'] || []).forEach((f) => f({ type: 'nbd:layout-prefs' }));
    ok('a lock read after mount ends edit mode', !col.querySelector('.os-hw-edit'));
    ok('…and the company desk home shows', J(ids(col)) === J(['coach-1', 'glance-1']), J(ids(col)));
    ok('…with no Edit Home button', !col.querySelector('[data-osdo="homeedit"]'));
  });
  console.log('\n8. before the claims load, and a settings read that changes nothing');
  G(() => {
    const prefsEv = (T) => (T.document.listeners['nbd:layout-prefs'] || []).forEach((f) => f({ type: 'nbd:layout-prefs' }));
    // claims not loaded yet (window._userClaims unset): a member must not be treated as the owner
    const T = makeWin({ surface: 'desktop', uid: 'u2', home: OWN, company: coDoc(true) });
    T.W._userClaims = undefined;
    T.W._impl.mount({ surface: 'desktop' });
    const col = deskCol(T);
    ok('claims not loaded yet: the company lock still binds (the locked desk home shows)', J(ids(col)) === J(['coach-1', 'glance-1']), J(ids(col)));
    ok('…and there is no Edit Home way around it', !col.querySelector('[data-osdo="homeedit"]') && !!col.querySelector('.os-hw-locked'));
    T.W._userClaims = { companyId: 'u2' };   // they arrive: this is the solo owner
    prefsEv(T);
    ok('when the claims say owner, the next settings read gives them their own home', J(ids(col)) === J(['upnext-1']), J(ids(col)));
    ok('…with Edit Home back', !!col.querySelector('[data-osdo="homeedit"]'));
    T.W._userClaims = {};   // loaded, no companyId at all: still the solo owner (the CRM's rule)
    prefsEv(T);
    ok('loaded claims with no companyId are still the solo owner', J(ids(col)) === J(['upnext-1']));

    // a settings read that changes nothing (every hydrate fires the event, the first one included)
    const P = mount('phone', { claims: REP, home: OWN, company: coDoc(false) });
    const pages = phoneOf(P).querySelector('.os-p-pages');
    prefsEv(P);
    ok('phone: a settings read with nothing new does not repaint the home screen', phoneOf(P).querySelector('.os-p-pages') === pages);
    const D = mount('desk', { claims: REP, home: OWN, company: coDoc(false) });
    const tools = deskCol(D).querySelector('.os-hw-tools');
    const n = tools.innerHTMLWrites;
    prefsEv(D);
    ok('desk: …nor the desk column', tools.innerHTMLWrites === n, n + ' -> ' + tools.innerHTMLWrites);
    D.W.LayoutEngine.saveCompany({ homeLocked: true });
    prefsEv(D);
    ok('a read that does change something (a lock) still repaints', J(ids(deskCol(D))) === J(['coach-1', 'glance-1']), J(ids(deskCol(D))));
  });
  G(() => {
    ok('no new <script> tag for the owner code', !/home-company\.js/.test(DASH));
    ok('no layout-system needs slot taken', !/home-company/.test(LAYOUT_SYS));
    ok('os.js registers the bundle at runtime', /SL\.bundles\.oshomeco = \['js\/os\/home-company\.js\?v=1'\]/.test(OS_JS));
    const code = noComments(CO_JS);
    ok('home-company.js: no inline handlers or style attributes', !/\son[a-z]+=/i.test(code) && !/style=/.test(code) && !/\.style\./.test(code));
    ok('home-company.js: every innerHTML value is escaped or a literal', (code.match(/' \+ (?!esc\()[a-zA-Z_.]+ \+ '/g) || []).length === 0, J(code.match(/' \+ (?!esc\()[a-zA-Z_.]+ \+ '/g)));
    ok('home-company.js writes only through LayoutEngine.saveCompany', !/setDoc|updateDoc|addDoc|fetch\(|httpsCallable/.test(code) && /saveCompany\(/.test(code));
    ok('team controls and dialog buttons are 44px', /\.os-hw-team \.btn \{[^}]*min-height: 44px/.test(HOME_CSS) && /\.os-hw-pub-btn \{[^}]*min-height: 44px/.test(HOME_CSS));
    ok('the lock state is not colour alone (a filled dot + aria-checked)', /\.os-hw-lock\.is-on \.os-hw-lock-dot \{ background: currentColor; \}/.test(HOME_CSS));
    ok('no text under 11px in the new rules', !/font-size: (?:[0-9]|10)px/.test(HOME_CSS.slice(HOME_CSS.indexOf('company home (P1)'))));
    ok('no animation or transition in the new rules', !/animation|transition/.test(HOME_CSS.slice(HOME_CSS.indexOf('company home (P1)'), HOME_CSS.indexOf('by the width a widget got'))));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
