/**
 * tests/nbd-os-urgency-frecency-2026-11-09.test.js - NBD OS P1: the urgency ring
 * (#5) and frecency (#13) (documentation/projects/NBD-OS-HOME-DESIGN-2026-11-09.md §6).
 *
 * Urgency: a new inbound lead (stage role new, created in the last 24 h) with no
 * firstRespondedAt rings the CRM icon, but only while the speedToLead feature is
 * on (only then is a reply stamped); with it off, the 30-minute call-back rule's
 * missed calls in the Today plan ring Calls. The ring is a word ("New" / "Call")
 * and the icon's accessible name, never colour alone; nothing when the data is
 * absent. Frecency: palette "go to" counts (nbd_cmd_usage_v1) plus the OS's
 * recent list order the phone's icons and Start's apps, most used lately first;
 * once the member has arranged the phone icons their order wins, and frecency
 * never re-sorts under the member's finger (only on a return Home).
 *
 * Run: node tests/nbd-os-urgency-frecency-2026-11-09.test.js
 */
'use strict';
const path = require('path');
const H = require('./lib/nbd-os-home-harness.js');
const { ROOT, read, makeWin, NOW, text, click, noComments } = H;

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (detail !== undefined ? '\n      ' + String(detail).slice(0, 400) : '')); }
}
const J = (v) => JSON.stringify(v);
const G = (fn) => { try { fn(); } catch (e) { ok('section ran without throwing', false, e && e.stack); } };
const req = (p) => { try { return require(path.join(ROOT, p)); } catch (e) { return null; } };
const HL = req('docs/pro/js/os/home-logic.js');
const OS_JS = read('docs/pro/js/layouts/os.js');
const HOME_CSS = read('docs/pro/css/os/home.css');
const MIN = 60000;
const lead = (over) => Object.assign({ id: 'N1', firstName: 'Nia', stage: 'new', createdAt: NOW - 12 * MIN }, over || {});
const flags = (on) => ({ enabled: (n) => on && n === 'speedToLead' });

console.log('\n1. urgency(): who is waiting, from data in memory');
G(() => {
  ok('a new lead with no reply, speedToLead on -> lead, 12 min', J(HL.urgency({ leads: [lead()], now: NOW, stamped: true })) === J({ kind: 'lead', n: 1, oldestMin: 12, leadId: 'N1' }));
  ok('…a stamped reply ends it', HL.urgency({ leads: [lead({ firstRespondedAt: { seconds: (NOW - MIN) / 1000 } })], now: NOW, stamped: true }) === null);
  ok('…older than 24 h, deleted, a prospect or past New: not new inbound', [{ createdAt: NOW - 25 * 3600000 }, { deleted: true }, { isProspect: true }, { stage: 'contacted' }]
    .every((o) => HL.urgency({ leads: [lead(o)], now: NOW, stamped: true }) === null));
  ok('…a CSV-imported lead (data-import.js: meter import, importedAt) never rings: it was never inbound',
    HL.urgency({ leads: [lead({ meter: 'import' })], now: NOW, stamped: true }) === null
    && HL.urgency({ leads: [lead({ importedAt: { seconds: (NOW - MIN) / 1000 } })], now: NOW, stamped: true }) === null
    && J(HL.urgency({ leads: [lead({ id: 'I1', meter: 'import' }), lead()], now: NOW, stamped: true })) === J({ kind: 'lead', n: 1, oldestMin: 12, leadId: 'N1' }));
  ok('…the tenant\'s stage role decides "new" (own stage names)', !!HL.urgency({ leads: [lead({ stage: 'fresh_web' })], now: NOW, stamped: true, roleOf: (k) => (k === 'fresh_web' ? 'new' : '') }));
  ok('…two waiting: n 2, the oldest\'s minutes, no single lead id', J(HL.urgency({ leads: [lead(), lead({ id: 'N2', createdAt: NOW - 40 * MIN })], now: NOW, stamped: true })) === J({ kind: 'lead', n: 2, oldestMin: 40, leadId: '' }));
  ok('speedToLead off: leads are not read (no stamp could exist), missed calls under 30 min are', HL.urgency({ leads: [lead()], now: NOW, stamped: false, plan: { calls: [] } }) === null
    && J(HL.urgency({ now: NOW, stamped: false, plan: { calls: [{ missed: true, latestMs: NOW - 8 * MIN, leadId: 'L2' }] } })) === J({ kind: 'call', n: 1, oldestMin: 8, leadId: 'L2' }));
  ok('…a missed call 31 min old, or one that was not missed: nothing', HL.urgency({ now: NOW, plan: { calls: [{ missed: true, latestMs: NOW - 31 * MIN }, { missed: false, latestMs: NOW }] } }) === null);
  // a manager's / owner's _leads holds the team's leads: a teammate's new lead is not waiting on THIS member
  ok('…with uid: a teammate\'s new lead (userId or assignedTo someone else) is not counted', HL.urgency({ leads: [lead({ userId: 'rep2' }), lead({ id: 'N3', assignedTo: 'rep2' })], now: NOW, stamped: true, uid: 'u1' }) === null);
  ok('…the member\'s own (userId, else assignedTo) and an unowned one are', J(HL.urgency({ leads: [lead({ userId: 'u1' }), lead({ id: 'N2', assignedTo: 'u1', createdAt: NOW - 20 * MIN }), lead({ id: 'N4', createdAt: NOW - 30 * MIN }), lead({ id: 'N5', userId: 'rep2', createdAt: NOW - 50 * MIN })], now: NOW, stamped: true, uid: 'u1' }))
    === J({ kind: 'lead', n: 3, oldestMin: 30, leadId: '' }));
  ok('no data -> nothing (no leads loaded, no plan, no clock)', HL.urgency({ leads: null, now: NOW, stamped: true }) === null && HL.urgency({ now: NOW }) === null && HL.urgency({ leads: [lead()], stamped: true }) === null);
  ok('urgencyText: words, never colour only', J(HL.urgencyText({ kind: 'lead', n: 2 })) === J({ app: 'crm', pill: 'New', text: '2 new leads waiting for a reply' })
    && J(HL.urgencyText({ kind: 'call', n: 1 })) === J({ app: 'calls', pill: 'Call', text: '1 missed call to return' }) && HL.urgencyText(null) === null);
});

console.log('\n2. the ring on the phone and the desktop');
G(() => {
  const T = makeWin({ surface: 'phone', leads: [lead()] });
  T.W.NBDFlags = flags(true);
  T.W._impl.mount({ surface: 'phone' });
  const ph = () => T.document.getElementById('osPhone');
  const crm = () => ph().querySelector('.os-p-icon[data-id="crm"]');
  ok('the CRM icon rings: a class, a visible word and its accessible name', crm().classList.contains('is-urgent') && text(crm().querySelector('.os-urgent-pill')) === 'New'
    && crm().getAttribute('aria-label') === 'CRM, 1 new lead waiting for a reply', crm().getAttribute('aria-label'));
  ok('only one icon rings', ph().querySelectorAll('.is-urgent').length === 1);
  T.W._leads[0].firstRespondedAt = NOW - MIN;
  T.W.dispatchEvent(new T.W.CustomEvent('nbd:data-refreshed'));
  ok('a reply stamped -> the ring goes on the next event', !ph().querySelector('.is-urgent') && !crm().hasAttribute('aria-label'));
  const Tt = makeWin({ surface: 'phone', uid: 'u1', leads: [lead({ userId: 'rep2' })] });
  Tt.W.NBDFlags = flags(true);
  Tt.W._impl.mount({ surface: 'phone' });
  ok('a teammate\'s new lead in a manager\'s _leads does not ring the CRM icon', !Tt.document.getElementById('osPhone').querySelector('.is-urgent'));
  const T2 = makeWin({ surface: 'phone', leads: [lead()], plan: Object.assign(H.plan(), { calls: [{ key: 'c', missed: true, latestMs: NOW - 5 * MIN, phone: '5135550199' }] }) });
  T2.W.NBDFlags = flags(false);
  T2.W._impl.mount({ surface: 'phone' });
  const calls = T2.document.getElementById('osPhone').querySelector('.os-p-icon[data-id="calls"]');
  ok('speedToLead off: the fresh missed call rings Calls, "Call"', calls && calls.classList.contains('is-urgent') && text(calls.querySelector('.os-urgent-pill')) === 'Call', calls && calls.getAttribute('aria-label'));
  const T3 = makeWin({ surface: 'phone', leads: [lead()] });
  T3.W._impl.mount({ surface: 'phone' });
  ok('no flags loaded and no fresh missed call: no ring (nothing to go on)', !T3.document.getElementById('osPhone').querySelector('.is-urgent'));
  const T4 = makeWin({ surface: 'desk', leads: [lead()] });
  T4.W.NBDFlags = flags(true);
  T4.W._impl.mount({ surface: 'desktop' });
  const dIcon = T4.document.querySelector('.os-icon[data-osapp="crm"]');
  ok('the desktop icon rings the same way', dIcon && dIcon.classList.contains('is-urgent') && /1 new lead waiting/.test(dIcon.getAttribute('aria-label')));
  ok('the ring is a box-shadow and a word: no filled orange, words at 11px+', /\.os-urgent-pill \{[^}]*font-size: 11px/.test(HOME_CSS) && !/background:\s*var\(--orange\)/.test(HOME_CSS));
  ok('read cost 0', T.reads.length === 0 && T2.reads.length === 0 && T4.reads.length === 0);
  ok('os.js repaints the ring only when it changed (ringKey) and on the home\'s own events (one listener set)',
    /ringKey\(u\) === ringKey\(S\.urg\)/.test(OS_JS) && /onEvent: function \(\) \{ safe\(checkRing\); \}/.test(OS_JS) && (T.winListeners['nbd:data-refreshed'] || []).length === 1);
});

console.log('\n3. frecency(): most used lately first, the rest in their own order');
G(() => {
  const apps = ['home', 'crm', 'schedule', 'calls', 'money', 'photos'].map((id) => ({ id }));
  const ids = (l) => l.map((a) => a.id);
  ok('nothing used -> the order is unchanged', J(ids(HL.frecency(apps, {}, []))) === J(ids(apps)));
  ok('palette uses (go-<id>) lift an app', ids(HL.frecency(apps, { 'go-photos': 2 }, []))[0] === 'photos');
  ok('the recent list lifts too, newest highest', J(ids(HL.frecency(apps, {}, ['money', 'calls'])).slice(0, 2)) === J(['money', 'calls']));
  ok('frequent beats a single recent open (3 per use, 10 for the newest)', ids(HL.frecency(apps, { 'go-schedule': 5 }, ['money']))[0] === 'schedule');
  ok('ties keep the original order; unused apps keep theirs', J(ids(HL.frecency(apps, { 'go-money': 1, 'go-crm': 1 }, []))) === J(['crm', 'money', 'home', 'schedule', 'calls', 'photos']));
  ok('parseUsage keeps positive counts only', J(HL.parseUsage('{"go-crm":3,"x":-1,"y":"z","go-a":0}')) === J({ 'go-crm': 3 }) && J(HL.parseUsage('nope')) === J({}) && J(HL.parseUsage(null)) === J({}));
});

console.log('\n4. frecency on the phone and in Start; the member\'s own order wins');
G(() => {
  const usage = JSON.stringify({ 'go-photos': 4, 'go-money': 1 });
  const T = makeWin({ surface: 'phone', store: { nbd_cmd_usage_v1: usage } });
  T.W._impl.mount({ surface: 'phone' });
  const order = (T0) => T0.document.getElementById('osPhone').querySelectorAll('.os-p-page .os-p-icon[data-osp="app"]').map((b) => b.getAttribute('data-id'));
  ok('page 1 starts with the most used apps (Photos, then Money)', J(order(T).slice(0, 2)) === J(['photos', 'money']), J(order(T)));
  T.store.nbd_cmd_usage_v1 = JSON.stringify({ 'go-schedule': 20 });
  T.W.dispatchEvent(new T.W.CustomEvent('nbd:data-refreshed'));
  T.W.NBDOSLayout.state().home && T.fire(3000);   // the app-list refresh repaints the phone
  ok('…and never re-sorts under the member\'s finger (only a return Home re-ranks)', J(order(T).slice(0, 2)) === J(['photos', 'money']), J(order(T)));
  click(T.dom, T.document.getElementById('osBar').querySelector('[data-osp="home"]'));
  ok('…a return Home re-ranks (Schedule first now)', order(T)[0] === 'schedule', J(order(T)));
  const T2 = makeWin({ surface: 'phone', store: { nbd_cmd_usage_v1: usage } });
  T2.W.LayoutEngine.prefs = () => ({ user: { layoutState: { os: { v: 1, icons: ['settings', 'home', 'crm', 'schedule', 'calls', 'money', 'photos'] } } }, hydrated: true });
  T2.W._impl.mount({ surface: 'phone' });
  ok('a member who arranged the icons keeps their order exactly', J(order(T2)) === J(['settings', 'home', 'crm', 'schedule', 'calls', 'money', 'photos']), J(order(T2)));
  const T3 = makeWin({ surface: 'desk', store: { nbd_cmd_usage_v1: usage } });
  T3.W._impl.mount({ surface: 'desktop' });
  click(T3.dom, T3.document.querySelector('.os-start-btn') || T3.document.querySelector('[data-osdo="start"]'));
  const rows = T3.document.querySelectorAll('.os-start-list .os-start-app[data-osapp]').map((b) => b.getAttribute('data-osapp'));
  ok('Start (empty search) lists the most used apps first', J(rows.slice(0, 2)) === J(['photos', 'money']), J(rows));
  ok('the usage store is the palette\'s own key, read only', /USAGE_KEY = 'nbd_cmd_usage_v1'/.test(OS_JS) && !/setItem\(USAGE_KEY/.test(noComments(OS_JS)));
  ok('the phone edit swap starts from the order on screen', /var order = phoneOrder\(\)\.map/.test(OS_JS));
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
