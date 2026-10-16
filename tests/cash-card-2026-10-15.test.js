#!/usr/bin/env node
/**
 * tests/cash-card-2026-10-15.test.js — the "Cash collected" card.
 *
 *   A. one definition of collected: the numbers come from NBDRevenue (collected-revenue.js)
 *   B. open invoices, the oldest one, and where Collect goes
 *   C. the goal: per user (userSettings.monthlyGoal), none = no ring; Settings saves it
 *   D. honest states: checking / failed is never shown as $0
 *   E. wiring: lazy bundle, a slot in the five layouts that showed no money, CSP-clean
 *
 * Run: node tests/cash-card-2026-10-15.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}

// The REAL collected-revenue.js, loaded the way the dashboard loads it.
function revenue() {
  const win = { addEventListener() {}, dispatchEvent() {}, setTimeout, CustomEvent: function () {} };
  const ctx = { window: win, console, Date, Math, JSON, Promise, setTimeout, CustomEvent: function () {} };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/collected-revenue.js'), ctx);
  return win.NBDRevenue;
}

function sandbox(o) {
  const opt = o || {};
  const listeners = {};
  const slot = { hidden: true, firstChild: null, getAttribute: (a) => (a === 'data-cash-variant' ? (opt.variant || null) : null) };
  Object.defineProperty(slot, 'innerHTML', { set(v) { this._h = v; this.firstChild = v ? {} : null; }, get() { return this._h || ''; } });
  const input = { value: '', __ccFilled: false };
  const store = Object.assign({}, opt.storage || {});
  const writes = [];
  const toasts = [];
  const doc = {
    activeElement: null,
    getElementById: (id) => (id === 'cashGoalInput' && opt.withInput ? input : null),
    querySelectorAll: (sel) => (sel === '[data-cash-slot]' ? [slot] : []),
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    body: {},
  };
  const R = opt.R;
  const win = {
    document: doc,
    NBDRevenue: R,
    _userClaims: { role: opt.role || 'owner' },
    _user: { uid: 'u1' },
    db: {},
    doc: (db, c, id) => c + '/' + id,
    getDoc: () => Promise.resolve({ exists: () => opt.remoteGoal != null, data: () => ({ monthlyGoal: opt.remoteGoal }) }),
    setDoc: (ref, data, o2) => { writes.push({ ref, data, o2 }); return opt.setDocFails ? Promise.reject(new Error('x')) : Promise.resolve(); },
    showToast: (m, t) => toasts.push([m, t]),
    goTo: (v) => { win._went = v; },
    addEventListener: () => {},
    dispatchEvent: () => {},
    requestAnimationFrame: (f) => f(),
  };
  const ctx = {
    window: win, document: doc, console, CustomEvent: function (n, d) { this.type = n; this.detail = d && d.detail; },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    setTimeout: (f) => { f(); return 1; }, clearTimeout() {},
    Date, JSON, Math, String, Number, Array, Object, Promise, isFinite, encodeURIComponent, parseFloat,
  };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/cash-card.js'), ctx);
  const click = (attrs) => {
    const t = { getAttribute: (a) => (a in attrs ? attrs[a] : null) };
    t.closest = () => t;
    (listeners.click || []).forEach((f) => f({ target: t, preventDefault() {} }));
  };
  return { win, slot, input, store, writes, toasts, click, flush: () => new Promise((r) => setImmediate(r)) };
}

const NOW = Date.now();
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const monthStart = new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), 1).getTime();
const weekStart = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); })();
const invs = [
  // paid this week (after Monday) and inside this month
  { id: 'a', leadId: 'La', customerName: 'Ann Lee', total: 1000, balanceDue: 0, status: 'paid', payments: [{ amount: 1000, at: iso(Math.max(weekStart, monthStart) + 3600000) }] },
  // paid before this month: not this week, not this month
  { id: 'b', leadId: 'Lb', total: 500, balanceDue: 0, status: 'paid', payments: [{ amount: 500, at: iso(monthStart - 2 * DAY) }] },
  // partial: owes 600, the oldest open invoice
  { id: 'c', leadId: 'Lc', customerName: 'Cara Diaz', total: 1000, balanceDue: 600, status: 'partial', createdAt: iso(NOW - 40 * DAY), payments: [] },
  // sent, owes 2000, newer
  { id: 'd', leadId: 'Ld', customerName: 'Dev Patel', total: 2000, balanceDue: 2000, status: 'sent', createdAt: iso(NOW - 3 * DAY) },
  // paid the day before Monday: inside a rolling 7 days, NOT this week
  { id: 'g', leadId: 'Lg', total: 300, balanceDue: 0, status: 'paid', payments: [{ amount: 300, at: iso(weekStart - DAY) }] },
  // a draft and a void are never "open"
  { id: 'e', leadId: 'Le', total: 900, balanceDue: 900, status: 'draft', createdAt: iso(NOW - 90 * DAY) },
  { id: 'f', leadId: 'Lf', total: 900, balanceDue: 0, status: 'void', createdAt: iso(NOW - 90 * DAY) },
];

(async () => {
  const R = revenue();
  R.cached = () => invs;
  R.status = () => 'ok';
  ok('the real NBDRevenue loaded', R && typeof R.collectedBetween === 'function');

  console.log('\nA. one definition of collected');
  {
    const sb = sandbox({ R });
    const m = sb.win.NBDCashCard._summarize(invs, R, NOW, null);
    ok('this month = NBDRevenue.collectedBetween(month start, now)', m.month === R.collectedBetween(invs, monthStart, NOW).total, JSON.stringify(m));
    ok('this week = NBDRevenue.collectedBetween(Monday 12 am, now), not a rolling 7 days', m.week === R.collectedBetween(invs, weekStart, NOW).total && m.week !== R.collectedBetween(invs, NOW - 7 * DAY, NOW).total && sb.win.NBDCashCard._weekStart(NOW) === weekStart, m.week);
    ok('a payment from last month is not this month', m.month === R.collectedBetween(invs, monthStart, NOW).total && m.month !== R.collectedBetween(invs, null, NOW).total);
    const src = read('docs/pro/js/cash-card.js');
    ok('no second calculation: no payments/balance math of its own', !/\.payments\b|balanceDue|amountPaid/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')));
    ok('it reads collectedBetween / isOwedInvoice / owedDollarsOf from NBDRevenue', /R\.collectedBetween\(/.test(src) && /R\.isOwedInvoice\(/.test(src) && /R\.owedDollarsOf\(/.test(src));
  }

  console.log('\nB. open invoices and Collect');
  {
    const sb = sandbox({ R });
    const m = sb.win.NBDCashCard._summarize(invs, R, NOW, null);
    ok('open = owed by the one owed rule (draft and void excluded)', m.open.count === 2 && m.open.total === 2600, JSON.stringify(m.open));
    ok('the oldest open invoice is picked for Collect', m.oldest && m.oldest.id === 'c' && m.oldest.leadId === 'Lc', JSON.stringify(m.oldest));
    ok('Collect opens the existing Record payment flow for it', sb.win.NBDCashCard._collectHref(m.oldest, false) === '/pro/customer.html?id=Lc&pay=c');
    ok('a viewer gets no pay link (falls back to the invoices list)', sb.win.NBDCashCard._collectHref(m.oldest, true) === '');
    sb.win.NBDCashCard.render();
    const h = sb.slot.innerHTML;
    ok('the card shows week, month, open count + total and Collect', /this week/.test(h) && /this month/.test(h) && /2 open invoices · \$2,600 owed/.test(h) && /href="\/pro\/customer\.html\?id=Lc&amp;pay=c"/.test(h) && /Collect · Cara/.test(h), h);
    const v = sandbox({ R, role: 'viewer' });
    v.win.NBDCashCard.render();
    ok('viewer: "Open invoices" goes to Money', /data-cc="money"/.test(v.slot.innerHTML) && !/pay=/.test(v.slot.innerHTML));
    v.click({ 'data-cc': 'money' });
    ok('…and the button opens the Money view', v.win._went === 'money');
    const none = sandbox({ R: Object.assign({}, R, { cached: () => [invs[0]] }) });
    none.win.NBDCashCard.render();
    ok('nothing owed: "No open invoices" and no Collect', /No open invoices/.test(none.slot.innerHTML) && !/cc-btn/.test(none.slot.innerHTML));
    const ev = sandbox({ R: Object.assign({}, R, { cached: () => [Object.assign({}, invs[2], { customerName: '<b>x</b>' })] }) });
    ev.win.NBDCashCard.render();
    ok('names are escaped', !/<b>x/.test(ev.slot.innerHTML));
  }

  console.log('\nC. the goal');
  {
    const nog = sandbox({ R });
    nog.win.NBDCashCard.render();
    ok('no goal set: no ring, and it says where to set one', !/cc-ring/.test(nog.slot.innerHTML) && /Set a monthly goal in Settings/.test(nog.slot.innerHTML));
    ok('no goal is never assumed (no $50k default here)', !/50000|50k/.test(read('docs/pro/js/cash-card.js')));
    const g = sandbox({ R, storage: { nbd_monthly_goal: '4000' } });
    g.win.NBDCashCard.render();
    const pct = Math.min(100, Math.round(R.collectedBetween(invs, monthStart, NOW).total / 4000 * 100));
    ok('a goal draws the ring and "N% of $goal goal"', /cc-ring/.test(g.slot.innerHTML) && new RegExp(pct + '% of \\$4,000 goal').test(g.slot.innerHTML), g.slot.innerHTML.slice(0, 400));
    const remote = sandbox({ R, remoteGoal: 9000 });
    remote.win.NBDCashCard.render();
    await remote.flush();
    ok('a goal saved on another device (userSettings.monthlyGoal) is picked up', remote.store.nbd_monthly_goal === '9000');

    const s = sandbox({ R, withInput: true });
    s.input.value = '$12,500';
    s.click({ 'data-cc': 'goal-save' });
    await s.flush();
    ok('Settings: Save writes userSettings/{uid}.monthlyGoal (merge) and the local copy', s.writes.length === 1 && s.writes[0].ref === 'userSettings/u1' && s.writes[0].data.monthlyGoal === 12500 && s.writes[0].o2.merge === true && s.store.nbd_monthly_goal === '12500', JSON.stringify(s.writes));
    s.click({ 'data-cc': 'goal-clear' });
    await s.flush();
    ok('Clear removes the goal (monthlyGoal 0 = none) and the local copy', s.writes[1].data.monthlyGoal === 0 && !('nbd_monthly_goal' in s.store));
    s.input.value = 'abc';
    s.click({ 'data-cc': 'goal-save' });
    ok('junk is refused with a message, nothing written', s.writes.length === 2 && s.toasts.some((t) => /dollar amount/.test(t[0])));
    const f = sandbox({ R, withInput: true, setDocFails: true });
    f.input.value = '5000';
    f.click({ 'data-cc': 'goal-save' });
    await f.flush();
    ok('a failed save says so (kept on this device only)', f.toasts.some((t) => /did not save to your account/.test(t[0]) && t[1] === 'error'));
    const dash = read('docs/pro/dashboard.html');
    ok('Settings > Profile has the goal panel with a labelled input and 44px buttons', /id="cashGoalPanel"/.test(dash) && /<label for="cashGoalInput"/.test(dash) && /data-cc="goal-save"/.test(dash) && /\.cc-goal-btn\{min-height:44px;\}/.test(read('docs/pro/css/cash-card.css')));
    ok('the goal panel sits in the Profile tab', dash.indexOf('id="cashGoalPanel"') > dash.indexOf('id="stab-panel-profile"') && dash.indexOf('id="cashGoalPanel"') < dash.indexOf('/stab-panel-profile'));
  }

  console.log('\nD. honest states');
  {
    const chk = sandbox({ R: Object.assign({}, R, { cached: () => null, status: () => 'checking', loadInvoices: () => new Promise(() => {}) }) });
    chk.win.NBDCashCard.render();
    ok('still loading: "Checking your invoices…", never $0', /Checking your invoices/.test(chk.slot.innerHTML) && !/\$0/.test(chk.slot.innerHTML));
    const bad = sandbox({ R: Object.assign({}, R, { cached: () => null, status: () => 'failed' }) });
    bad.win.NBDCashCard.render();
    ok('a failed load says so and that it is not $0', /Could not load your invoices/.test(bad.slot.innerHTML) && /This is not \$0/.test(bad.slot.innerHTML));
    let asks = 0;
    const loop = sandbox({ R: Object.assign({}, R, { cached: () => null, status: () => 'checking', loadInvoices: () => { asks++; return Promise.resolve([]); } }) });
    loop.win.NBDCashCard.render();
    await loop.flush(); await loop.flush(); await loop.flush();
    ok('an unconfirmed read is asked for at most once a minute (no load loop)', asks === 1, asks);
  }

  console.log('\nE. wiring');
  {
    const sl = read('docs/pro/js/script-loader.js');
    ok('lazy bundle "cashcard" (css + card, ?v=), no boot <script> tag', /cashcard: \[\s*'css\/cash-card\.css\?v=\d+',\s*'js\/cash-card\.js\?v=\d+'\s*\]/.test(sl) && !/<script[^>]*cash-card/.test(read('docs/pro/dashboard.html')));
    ok('today-home.js kicks it at Home boot', /loadBundle\('cashcard'\)/.test(read('docs/pro/js/today-home.js')));
    ['field', 'crew', 'focus', 'inbox', 'mission'].forEach((id) => {
      ok(id + ' carries a compact [data-cash-slot]', new RegExp('data-cash-slot="' + id + '" data-cash-variant="compact"').test(read('docs/pro/js/layouts/' + id + '.js')));
    });
    ['bento', 'island'].forEach((id) => ok(id + ' has no cash slot (it already shows money / the Classic Home)', !/data-cash-slot/.test(read('docs/pro/js/layouts/' + id + '.js'))));
    const js = read('docs/pro/js/cash-card.js'), css = read('docs/pro/css/cash-card.css');
    ok('CSP: no inline handlers or style attributes', !/\son[a-z]+=/i.test(js) && !/style=/.test(js));
    ok('Collect and the card buttons are 44px', /\.cc-btn\{[^}]*min-height:44px/.test(css));
    const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok('labelled collected, never "revenue" or a projection', /Cash collected/.test(code) && !/[Rr]evenue/.test(code.replace(/NBDRevenue/g, '')) && !/projected/i.test(code));
    ok('nothing charges or sends: no fetch, no callable, no Stripe', !/fetch\(|httpsCallable|stripe/i.test(js));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
