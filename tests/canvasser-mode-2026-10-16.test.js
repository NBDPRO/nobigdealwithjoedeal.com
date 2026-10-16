#!/usr/bin/env node
/**
 * tests/canvasser-mode-2026-10-16.test.js — Canvasser mode (canvasser-logic.js,
 * canvasser-ui.js). The rules half is tests/firestore-rules.canvassers.test.js.
 *
 *   A. per-rep numbers: doors (distinct), leads, appointments, closed jobs,
 *      money COLLECTED (by date received, refunds off; never contract value),
 *      commission = collected × % (capped 0-50), the period filter
 *   B. the leaderboard order
 *   C. the pre-knock checklist: per town, a banned town cannot start, KY
 *      cancel wording, hours, every line must be ticked, once per town per day
 *   D. the screens: escaped, owner-only controls, an honest line when a read
 *      fails, the door-list hand-off, no payout / payroll anywhere
 *   E. wiring: lazy bundle kicked after the claims, the panel mount, the rep's
 *      menu, tokens and 44 px targets, the rules blocks
 *
 * Run: node tests/canvasser-mode-2026-10-16.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const C = require(path.join(ROOT, 'docs/pro/js/canvasser-logic.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + String(detail).slice(0, 500) : '')); failed++; }
}
const T = (s) => Date.parse(s);

const data = {
  knocks: [
    { userId: 'r1', address: '1 Oak St', disposition: 'appointment', createdAt: T('2026-10-05T15:00:00Z') },
    { userId: 'r1', address: '1  oak st', disposition: 'not_home', createdAt: T('2026-10-06T15:00:00Z') },    // same door
    { userId: 'r1', lat: 39.1, lng: -84.5, disposition: 'interested', createdAt: T('2026-10-07T15:00:00Z') },  // GPS-only door
    { userId: 'r1', address: '9 Old St', disposition: 'appointment', createdAt: T('2026-08-01T15:00:00Z') },   // last period
    { userId: 'r2', address: '2 Elm St', disposition: 'appointment', createdAt: T('2026-10-08T15:00:00Z') },
  ],
  leads: [
    { id: 'L1', userId: 'r1', stage: 'contract_signed', createdAt: T('2026-10-05T16:00:00Z'), closedAt: T('2026-10-09T16:00:00Z'), jobValue: 18000 },
    { id: 'L2', userId: 'r1', stage: 'new', createdAt: T('2026-10-07T16:00:00Z') },
    { id: 'L3', userId: 'r1', stage: 'closed', createdAt: T('2026-07-01T16:00:00Z'), closedAt: T('2026-07-20T16:00:00Z') },
    { id: 'L4', userId: 'r2', stage: 'final_payment', createdAt: T('2026-10-01T16:00:00Z'), closedAt: T('2026-10-02T16:00:00Z') },
    { id: 'LX', userId: 'joe', stage: 'closed', createdAt: T('2026-10-01T16:00:00Z') },
  ],
  invoices: [
    { leadId: 'L1', status: 'partial', total: 18000, payments: [{ amount: 5000, at: T('2026-10-10T16:00:00Z') }, { amount: 1000.5, at: T('2026-10-12T16:00:00Z') }, { amount: 200, refund: true, at: T('2026-10-13T16:00:00Z') }] },
    { leadId: 'L3', status: 'paid', total: 9000, payments: [{ amount: 9000, at: T('2026-07-25T16:00:00Z') }] },
    { leadId: 'L4', status: 'paid', total: 4000, paidAt: T('2026-10-03T16:00:00Z') },
    { leadId: 'LX', status: 'paid', total: 99999, paidAt: T('2026-10-03T16:00:00Z') },
    { leadId: 'L1', status: 'void', total: 5000, payments: [{ amount: 5000, at: T('2026-10-10T16:00:00Z') }] },
  ],
};
const OCT = { from: T('2026-10-01T04:00:00Z'), to: T('2026-10-31T23:59:59Z') };

console.log('A. per-rep numbers');
{
  const s = C.repStats({ uid: 'r1', pct: 10, name: 'Ana' }, data, OCT);
  ok('doors: distinct doors (same address once, a GPS-only knock counts), this period only', s.doors === 2 && s.knocks === 3, JSON.stringify(s));
  ok('appointments set: the rep\'s Appointment Set knocks in the period', s.appointments === 1);
  ok('leads: the rep\'s own leads created in the period (never another rep\'s or Joe\'s)', s.leads === 2);
  ok('closed jobs: a signed contract or later, closed in the period', s.closed === 1);
  ok('collected: payments by date received, a refund subtracted, a void invoice ignored (5000 + 1000.50 - 200)', s.collectedCents === 580050, s.collectedCents);
  ok('commission = 10% of COLLECTED, not the $18,000 contract', s.commissionCents === 58005 && s.commissionCents !== 180000);
  const all = C.repStats({ uid: 'r1', pct: 10 }, data, {});
  ok('all time: every knock door and the July job and its money', all.doors === 3 && all.closed === 2 && all.collectedCents === 1480050, JSON.stringify(all));
  ok('a paid invoice with no payment ledger counts its total on its paid date', C.repStats({ uid: 'r2', pct: 5 }, data, OCT).collectedCents === 400000);
  ok('commission % is capped at 50 and floored at 0', C.clampPct(80) === 50 && C.clampPct(-3) === 0 && C.clampPct('12.5') === 12.5 && C.clampPct('x') === 0);
  ok('the stats carry no contract value field', !('jobValue' in s) && !/contract/i.test(Object.keys(s).join()));
  ok('sale test: contract signed / in production / won; new and lost are not', C.isSale({ stage: 'contract_signed' }) && C.isSale({ stage: 'install_in_progress' }) && C.isSale({ stage: 'Closed Won' }) && !C.isSale({ stage: 'new' }) && !C.isSale({ stage: 'lost' }) && C.isSale({ stage: 'custom', stageRole: 'won' }));
  ok('money format', C.fmtMoney(580050) === '$5,800.50' && C.fmtMoney(-200) === '-$2.00');
}

console.log('B. leaderboard');
{
  const lb = C.leaderboard([
    { name: 'A', closed: 1, collectedCents: 100, appointments: 9, doors: 90 },
    { name: 'B', closed: 2, collectedCents: 50, appointments: 1, doors: 10 },
    { name: 'C', closed: 1, collectedCents: 300, appointments: 0, doors: 5 },
  ]);
  ok('closed jobs first, then money collected, ranked 1..n', lb.map((x) => x.rank + x.name).join() === '1B,2C,3A');
}

console.log('C. the pre-knock checklist');
{
  const mason = C.checklistFor('mason-oh');
  ok('a permit town: the permit line names the town; four lines', mason.items.length === 4 && /My Mason, OH solicitor permit is on file and with me/.test(mason.items[0].label));
  ok('the town\'s own hours go on the quiet-hours line', /9 a\.m\. to 8 p\.m\. Apr-Oct/.test(mason.items[3].label) && /never at a No Soliciting sign/.test(mason.items[3].label));
  ok('Ohio: the 3-day cancel notice; Kentucky adds the 5-business-day insurance notice', /3-day cancel notice in duplicate/.test(mason.items[2].label) && /5-business-day notice/.test(C.checklistFor('union-ky').items[2].label));
  const bat = C.checklistFor('batavia-oh');
  ok('a town that bans door-to-door cannot be started', bat.blocked === true && bat.items.length === 0 && /banned/.test(bat.why));
  ok('an unverified hours rule falls back to the strictest default', C.checklistFor('florence-ky').hours === C.DEFAULT_HOURS);
  ok('another town: the generic permit line and both cancel notices', /checked this town's permit rule/.test(C.checklistFor('other').items[0].label) && /5-business-day/.test(C.checklistFor('other').items[2].label));
  const all = { permit: true, badge: true, cancelNotice: true, quietHours: true };
  const when = new Date(2026, 9, 16, 9, 30);
  const d = C.checkDoc('mason-oh', all, { uid: 'r1', companyId: 'co' }, when);
  ok('every line ticked → the saved doc', d && d.ymd === '2026-10-16' && d.townId === 'mason-oh' && d.town === 'Mason, OH' && d.userId === 'r1' && d.items.permit === true);
  ok('one line unticked → nothing saved', C.checkDoc('mason-oh', Object.assign({}, all, { badge: false }), { uid: 'r1' }, when) === null);
  ok('a banned town → nothing saved', C.checkDoc('batavia-oh', all, { uid: 'r1' }, when) === null);
  ok('once per town per day', C.checkedToday([d], 'r1', 'mason-oh', when) && !C.checkedToday([d], 'r1', 'loveland-oh', when) && !C.checkedToday([d], 'r2', 'mason-oh', when) && !C.checkedToday([d], 'r1', 'mason-oh', new Date(2026, 9, 17)));
  ok('every town in the list has a permit status, hours and a note', C.TOWNS.length >= 20 && C.TOWNS.every((t) => /^(yes|no|banned|check)$/.test(t.permit) && t.hours && t.note && /^(OH|KY)$/.test(t.state)));
}

console.log('D. the screens');
{
  const doc = { documentElement: { classList: { add() {}, remove() {} } }, addEventListener() {}, getElementById: () => null, createElement: () => ({ setAttribute() {}, addEventListener() {}, appendChild() {} }), body: { appendChild() {} } };
  const mk = (claims) => {
    const win = { NBDCanvasserLogic: C, _user: { uid: 'joe' }, _userClaims: claims, addEventListener() {} };
    const ctx = { window: win, document: doc, console, Promise, Date, Math, JSON, Object, Array, String, Number, setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, localStorage: { getItem: () => null, setItem() {} } };
    vm.createContext(ctx);
    vm.runInContext(read('docs/pro/js/canvasser-ui.js'), ctx);
    return win.NBDCanvasser;
  };
  const U = mk({ companyId: 'joe', role: 'company_admin' });
  const d = { canvassers: [{ uid: 'r1', name: 'Ana <b>', pct: 10, active: true }, { uid: 'r9', name: 'Gone', pct: 5, active: false }], members: [{ uid: 'r2', name: 'Ben', role: 'sales_rep', status: 'active' }, { uid: 'm1', name: 'Mo', role: 'manager', status: 'active' }],
    knocks: data.knocks, leads: data.leads, invoices: data.invoices, checks: [{ userId: 'r1', town: 'Mason, OH' }], lists: [{ id: 'DL1', name: 'Mason aging roofs', doors: [{}, {}], assignedTo: 'r1' }] };
  const h = U._panelHtml(d);
  ok('owner panel: the rep row, escaped, with collected and commission owed', /Ana &lt;b&gt;/.test(h) && !/<b>/.test(h) && /Commission owed/.test(h));
  ok('a stopped canvasser is not listed', !/Gone/.test(h));
  ok('today\'s checklist shows per rep', /✓ Mason, OH/.test(h));
  ok('owner controls: edit %, add a Sales Rep (not a manager), stop tracking', /data-cv-pct="r1"/.test(h) && /<option value="r2" data-name="Ben">Ben<\/option>/.test(h) && !/value="m1"/.test(h) && /data-cv="remove"/.test(h));
  ok('owner can hand a door list to a canvasser', /Give a door list to a canvasser/.test(h) && /Mason aging roofs · 2 doors · with Ana &lt;b&gt;/.test(h) && /data-cv="assign"/.test(h));
  ok('says tracking only, commission on money collected', /Tracking only: no payroll, no payouts\./.test(h) && /% of money collected on their jobs, never contract value/.test(h));
  const M = mk({ companyId: 'joe', role: 'manager' });
  const hm = M._panelHtml(d);
  ok('a manager sees the numbers but no edit controls', /Commission owed/.test(hm) && !/data-cv-pct=/.test(hm) && !/data-cv="add"/.test(hm) && !/data-cv="assign"/.test(hm));
  const hw = U._panelHtml(Object.assign({}, d, { knocks: null }));
  ok('a read the role cannot make → an honest line, not zeros passed off as real', /could not be read with your account's role/.test(hw));
  const ck = U._checklistHtml('batavia-oh');
  ok('the rep\'s sheet for a banned town: an alert and no Start button', /role="alert"/.test(ck) && !/data-cv="save"/.test(ck));
  const ck2 = U._checklistHtml('mason-oh');
  ok('the rep\'s sheet: four checkboxes, Start knocking starts disabled', (ck2.match(/data-cv-item=/g) || []).length === 4 && /data-cv="save" disabled>Start knocking/.test(ck2));
  const src = read('docs/pro/js/canvasser-ui.js') + read('docs/pro/js/canvasser-logic.js');
  ok('no payout, payroll or money movement anywhere', !/stripe|payout|payroll|transfer|httpsCallable|sendSms|sms:|mailto:/i.test(src.replace(/no payroll, no payouts|Tracking only: no payroll, no payouts|nothing here pays anyone|no payroll|no payouts/gi, '')));
  ok('the rep\'s knock sheet waits for today\'s checklist (wraps D2D.openQuickKnock)', /D\.openQuickKnock = gated/.test(src) && /if \(!S\.mode \|\| lsGet\(todayKey\(\)\)\) return orig\.apply/.test(src));
  ok('the rep\'s menu: Door-to-Door, Pipeline, Settings only (goTo redirects the rest)', /var ALLOWED_VIEWS = \{ d2d: 1, crm: 1, settings: 1 \};/.test(src) && /return orig\.call\(this, 'd2d'\)/.test(src));
}

console.log('E. wiring');
{
  const sl = read('docs/pro/js/script-loader.js');
  ok('lazy bundle: CSS, logic, UI, cache-busted', /canvasser: \[\n\s*'css\/canvasser\.css\?v=1',\n\s*'js\/canvasser-logic\.js\?v=2',\n\s*'js\/canvasser-ui\.js\?v=1'\n\s*\]/.test(sl));
  const boot = read('docs/pro/js/dashboard-bootstrap.module.js');
  ok('kicked once the claims are known, for reps / owners / managers', /window\._userClaims = tokenResult\.claims \|\| \{\};\n[\s\S]{0,1200}window\.ScriptLoader\.loadBundle\('canvasser'\)/.test(boot) && /\['sales_rep', 'company_admin', 'manager', 'admin'\]\.includes\(_cvRole\)/.test(boot));
  const dash = read('docs/pro/dashboard.html');
  ok('the Team tab has the panel mount; bootstrap and script-loader cache-busted', /<div class="panel mb-md" id="canvasserPanel" hidden><\/div>/.test(dash) && /dashboard-bootstrap\.module\.js\?v=42/.test(dash) && /script-loader\.js\?v=209/.test(dash));
  ok('no new boot <script> tag for canvasser mode', !/<script[^>]+canvasser/.test(dash));
  const css = read('docs/pro/css/canvasser.css');
  ok('44 px targets, accent / danger text tokens, the rep menu hidden by class', /\.cv-btn \{ min-height: 44px;/.test(css) && /\.cv-chip \{ min-height: 44px;/.test(css) && /\.cv-item \{[^}]*min-height: 44px;/.test(css) && /var\(--ui-accent-text/.test(css) && /var\(--ui-danger-text/.test(css) && /html\.nbd-canvasser \.ni\[data-target\]:not\(\[data-target="d2d"\]\)/.test(css));
  ok('no duration literal, no transition: all', !/transition:\s*all/.test(css) && !/\d+ms/.test(css));
  const rules = read('firestore.rules');
  ok('rules: canvassers written by the owner only, % capped at 50, checklists never edited', /match \/canvassers\/\{docId\}/.test(rules) && /d\.pct >= 0 && d\.pct <= 50/.test(rules) && /match \/canvass_checks\/\{checkId\}[\s\S]*?allow update: if false;/.test(rules));
  const ci = read('.github/workflows/ci.yml');
  ok('the rules suite runs in CI', /firestore-rules\.canvassers\.test\.js/.test(ci) && /firestore-rules\.canvassers\.test\.js/.test(read('.github/workflows/firebase-deploy.yml')));
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
