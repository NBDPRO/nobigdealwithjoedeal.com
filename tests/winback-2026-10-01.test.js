/**
 * tests/winback-2026-10-01.test.js
 *
 * The Past Customers (win-back) list, 2026-10-01. Jo's rule: nothing is sent
 * automatically — the rep reviews/edits the draft and taps Send.
 *
 * Pins:
 *   1. who qualifies (docs/pro/js/winback-logic.js pastCustomers): won and
 *      done, nothing open, 6+ months since the last completion, a phone or
 *      email, not reached in the last 90 days; anniversary + sort order;
 *      every timestamp shape Firestore hands back.
 *   2. the drafts (buildWinbackMessage): first name, months, STOP line, no
 *      money and no insurance-claim wording (Kentucky KRS 367.628).
 *   3. the send path (winback.js), run in a vm against a fake NBDComms: the
 *      lead is recorded ONLY on a real send — not on success:false, not on a
 *      queued text, not on a mailto handoff; viewers are refused.
 *   4. wiring: lazy bundle, view mapping, mount, nav (sidebar + More), init,
 *      route label, esc() on everything rendered.
 *
 * Run: node tests/winback-2026-10-01.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PRO = path.join(ROOT, 'docs', 'pro');
const L = require(path.join(PRO, 'js', 'winback-logic.js'));
const Jobs = require(path.join(PRO, 'js', 'jobs-store.js'));

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; fails.push(label); }
}

const NOW = new Date(2026, 9, 1, 10);            // Oct 1 2026
const DAY = 86400000;
const monthsAgo = (n, extraDays) => { const d = new Date(NOW); d.setMonth(d.getMonth() - n); d.setDate(d.getDate() - (extraDays || 0)); return d; };
const WON = new Set(['closed', 'install_complete', 'final_payment', 'final_photos', 'deductible_collected', 'collections', 'warranty_claim']);
const roleOf = (k) => { const s = String(k || '').toLowerCase(); return WON.has(s) ? 'won' : s === 'lost' ? 'lost' : 'active'; };
// No isOpen injected — the view doesn't inject one either (win-back's own
// "neither won nor lost" rule; jobs-store's paid-in-full isOpen emptied the
// list on production data, 2026-10-01).
const opts = { roleOf };

const doneJob = (id, at, extra) => Object.assign({ id, stage: 'closed', stageRole: 'won', closedAt: at, paidInFull: true, title: 'Roof replacement' }, extra || {});
const lead = (id, extra) => Object.assign({ id, firstName: 'Pat', lastName: 'Lee', phone: '5135550100', email: 'pat@example.test', address: '1 Main St, Florence, KY' }, extra || {});

function run(leads, jobsByLead, o) {
  return L.pastCustomers(leads, (id) => (jobsByLead[id] || []), NOW, Object.assign({}, opts, o || {}));
}

console.log('\n1. who qualifies');
{
  const r = run([lead('a', { activeJobId: 'j1', stage: 'closed', stageRole: 'won', closedAt: monthsAgo(8) })], { a: [doneJob('j1', monthsAgo(8))] });
  ok('a won + paid-in-full customer 8 months out qualifies', r.length === 1 && r[0].leadId === 'a' && r[0].monthsSince === 8, JSON.stringify(r));
  ok('row carries name, firstName, phone, email, job title, job count',
    r[0] && r[0].name === 'Pat Lee' && r[0].firstName === 'Pat' && r[0].phone && r[0].email && r[0].lastJobTitle === 'Roof replacement' && r[0].jobCount === 1);
}
{
  const r = run([lead('b', { activeJobId: 'j2' })], { b: [doneJob('j1', monthsAgo(10)), { id: 'j2', stage: 'contract_signed', stageRole: 'active', title: 'Gutters' }] });
  ok('a customer with an open second job is excluded', r.length === 0);
}
{
  const r = run([lead('c', { activeJobId: 'j1' })], { c: [doneJob('j1', monthsAgo(10), { paidInFull: false })] });
  ok('a won job NOT flagged paid-in-full still qualifies (production: 25 won customers, 1 flagged paid)', r.length === 1);
  const rs = run([lead('c2', { activeJobId: 'j1' })], { c2: [doneJob('j1', monthsAgo(10), { paidInFull: false })] }, { isOpen: Jobs.isOpen });
  ok('…whereas jobs-store\'s strict isOpen would have hidden it (why the view does not inject it)', rs.length === 0);
}
{
  const r = run([lead('d', { stage: 'lost', stageRole: 'lost', closedAt: monthsAgo(12) })], {});
  ok('a lost-only customer is excluded', r.length === 0);
  const r2 = run([lead('d2', { activeJobId: 'j1' })], { d2: [{ id: 'j1', stage: 'lost', stageRole: 'lost', closedAt: monthsAgo(12) }] });
  ok('a customer whose only job was lost is excluded', r2.length === 0);
}
{
  const r = run([lead('e', { activeJobId: 'j1' })], { e: [doneJob('j1', monthsAgo(2))] });
  ok('a completion under 3 months ago (the default) is excluded', r.length === 0);
  const r2 = run([lead('e2', { activeJobId: 'j1' })], { e2: [doneJob('j1', monthsAgo(4))] });
  ok('…and 4 months out is included by default', r2.length === 1);
  const r3 = run([lead('e3', { activeJobId: 'j1' })], { e3: [doneJob('j1', monthsAgo(4))] }, { minMonths: 6 });
  ok('…but not when opts.minMonths is raised to 6', r3.length === 0);
}
{
  const r = run([lead('f', { activeJobId: 'j1', lastWinbackAt: new Date(NOW.getTime() - 30 * DAY) })], { f: [doneJob('j1', monthsAgo(9))] });
  ok('a customer reached 30 days ago is excluded (90-day cooldown)', r.length === 0);
  const r2 = run([lead('g', { activeJobId: 'j1', lastWinbackAt: new Date(NOW.getTime() - 100 * DAY) })], { g: [doneJob('j1', monthsAgo(9))] });
  ok('a customer reached 100 days ago is back on the list', r2.length === 1 && r2[0].lastWinbackAt === NOW.getTime() - 100 * DAY);
}
{
  const r = run([lead('h', { activeJobId: 'j1', phone: '', email: '' })], { h: [doneJob('j1', monthsAgo(9))] });
  ok('no phone and no email → excluded', r.length === 0);
  const r2 = run([lead('h2', { activeJobId: 'j1', phone: '' })], { h2: [doneJob('j1', monthsAgo(9))] });
  ok('email only is enough', r2.length === 1);
}
{
  const r = run([lead('i', { deleted: true, activeJobId: 'j1' }), lead('k', { isProspect: true, activeJobId: 'j1' })],
    { i: [doneJob('j1', monthsAgo(9))], k: [doneJob('j1', monthsAgo(9))] });
  ok('deleted and prospect leads are excluded', r.length === 0);
}
{
  // Pre-jobs customer: no subcollection, judged on the lead itself.
  const r = run([lead('m', { stage: 'closed', stageRole: 'won', closedAt: monthsAgo(14), paidInFull: true })], {});
  ok('a customer with no jobs subcollection is judged on the lead', r.length === 1 && r[0].monthsSince === 14);
  const r2 = run([lead('m2', { stage: 'Closed', closedAt: monthsAgo(14), paidInFull: true })], {});
  ok('the won role comes from the injected roleOf when no stageRole is stamped', r2.length === 1);
}
{
  // The ACTIVE job is judged on the lead's fields (the mirror may lag).
  const r = run([lead('n', { activeJobId: 'j1', stage: 'install_in_progress', stageRole: 'job' })], { n: [doneJob('j1', monthsAgo(9))] });
  ok('the lead\'s own stage wins over a lagging active-job mirror', r.length === 0);
}

console.log('\n2. anniversary + sort');
{
  const firstDone = new Date(NOW.getTime() + 20 * DAY); firstDone.setFullYear(firstDone.getFullYear() - 1);  // 1 yr ago, minus 20 days
  const r = run([lead('p', { activeJobId: 'j1' })], { p: [doneJob('j1', firstDone)] });
  ok('anniversarySoon when the first-completion anniversary is 20 days out', r.length === 1 && r[0].anniversarySoon === true, JSON.stringify(r[0]));
  const far = new Date(NOW.getTime() + 60 * DAY); far.setFullYear(far.getFullYear() - 1);
  const r2 = run([lead('q', { activeJobId: 'j1' })], { q: [doneJob('j1', far)] });
  ok('not anniversarySoon when it is 60 days out', r2.length === 1 && r2[0].anniversarySoon === false);
  // Anniversary comes from the FIRST completion, months from the LAST.
  const r3 = run([lead('q2')], { q2: [doneJob('j1', firstDone), doneJob('j2', monthsAgo(7))] });
  ok('anniversary uses the first completion; monthsSince the last', r3.length === 1 && r3[0].anniversarySoon && r3[0].monthsSince === 7 && r3[0].jobCount === 2);

  const rows = run([
    lead('s7', { activeJobId: 'j1' }), lead('s30', { activeJobId: 'j1' }), lead('ann', { activeJobId: 'j1' }), lead('s12', { activeJobId: 'j1' }),
  ], {
    s7: [doneJob('j1', monthsAgo(7))], s30: [doneJob('j1', monthsAgo(30, 45))], ann: [doneJob('j1', firstDone)], s12: [doneJob('j1', monthsAgo(15))],
  });
  ok('sort: anniversary soon first, then longest-since first', rows.map((x) => x.leadId).join(',') === 'ann,s30,s12,s7', rows.map((x) => x.leadId).join(','));
}

console.log('\n3. timestamp shapes');
{
  const at = monthsAgo(9);
  const shapes = {
    'Date': at,
    'ISO string': at.toISOString(),
    'Firestore Timestamp (toMillis)': { toMillis: () => at.getTime(), toDate: () => at },
    '{seconds}': { seconds: Math.floor(at.getTime() / 1000), nanoseconds: 0 },
    'ms number': at.getTime(),
  };
  Object.keys(shapes).forEach((k) => {
    const r = run([lead('t', { activeJobId: 'j1' })], { t: [doneJob('j1', shapes[k])] });
    ok('closedAt as ' + k + ' is read', r.length === 1 && r[0].monthsSince === 9);
  });
  ok('completion falls back closedAt → completedAt → installCompletedAt → stageStartedAt',
    L.completedMs({ completedAt: 5 }) === 5 && L.completedMs({ installCompletedAt: 6 }) === 6 && L.completedMs({ stageStartedAt: 7 }) === 7
    && L.completedMs({ closedAt: 4, completedAt: 5 }) === 4);
  ok('a won job with no readable date does not qualify',
    run([lead('u', { activeJobId: 'j1' })], { u: [{ id: 'j1', stage: 'closed', stageRole: 'won', paidInFull: true }] }).length === 0);
}

console.log('\n4. the drafts');
{
  const row = { firstName: 'Dana', monthsSince: 8 };
  const CLAIM = /insur|claim|adjust|negotiat|deductible|carrier|supplement|\bAOB\b|assignment of benefits/i;
  L.KINDS.forEach((kind) => {
    const m = L.buildWinbackMessage(row, { company: 'No Big Deal Home Solutions', repName: 'Joe', kind });
    ok(kind + ': has the first name', /\bDana\b/.test(m.text));
    ok(kind + ': says about 8 months since we worked on your home', /about 8 months since we worked on your home/.test(m.text));
    ok(kind + ': ends with "Reply STOP to opt out."', m.text.endsWith('Reply STOP to opt out.'));
    ok(kind + ': no "$" and no money talk', !/\$|\bbonus\b|\breward\b|\bcash\b|\bgift card\b|\bpay\b/i.test(m.text + ' ' + m.subject));
    ok(kind + ': no insurance-claim wording', !CLAIM.test(m.text + ' ' + m.subject));
    ok(kind + ': has a subject', m.subject.length > 5 && m.kind === kind);
  });
  ok('checkin offers the free roof/gutter check after storm season', /free roof and gutter check/.test(L.buildWinbackMessage(row, { kind: 'checkin' }).text) && /storm season/.test(L.buildWinbackMessage(row, { kind: 'checkin' }).text));
  ok('referral asks about a neighbor who needs a roofer', /neighbor[^.]*needs a roofer/.test(L.buildWinbackMessage(row, { kind: 'referral' }).text));
  ok('maintenance is about gutters', /gutters cleaned and checked/.test(L.buildWinbackMessage(row, { kind: 'maintenance' }).text));
  ok('years read as years', /about 3 years since/.test(L.buildWinbackMessage({ firstName: 'A', monthsSince: 37 }).text) && /about a year since/.test(L.buildWinbackMessage({ firstName: 'A', monthsSince: 13 }).text));
  ok('no first name → plain "Hi,"', /^Hi, this is/.test(L.buildWinbackMessage({ monthsSince: 8 }, { company: 'X' }).text));
  ok('unknown kind falls back to checkin', L.buildWinbackMessage(row, { kind: 'spam' }).kind === 'checkin');
  ok('emailText drops the SMS-only STOP line', !/STOP/.test(L.emailText(L.buildWinbackMessage(row, {}).text)) && /Dana/.test(L.emailText(L.buildWinbackMessage(row, {}).text)));
}

console.log('\n5. send path (winback.js in a vm, fake NBDComms)');
const UI_SRC = fs.readFileSync(path.join(PRO, 'js', 'winback.js'), 'utf8');
const LOGIC_SRC = fs.readFileSync(path.join(PRO, 'js', 'winback-logic.js'), 'utf8');
function sandbox(comms, viewer) {
  const writes = [], toasts = [];
  const document = { getElementById: () => null, querySelector: () => null, createElement: () => ({}) };
  const win = {
    document,
    _leads: [{ id: 'L1', firstName: 'Pat', winbackCount: 2 }],
    showToast: (m, t) => toasts.push([m, t]),
    NBDComms: comms,
    NBDRole: { isViewer: () => !!viewer, guard: () => !viewer },
    db: {}, doc: (db, col, id) => col + '/' + id,
    updateDoc: async (ref, patch) => { writes.push([ref, patch]); },
    console,
  };
  win.window = win;
  const ctx = vm.createContext(Object.assign(win, { Array, Object, Date, Number, String, Math, JSON, Promise, Error }));
  vm.runInContext(LOGIC_SRC, ctx);
  vm.runInContext(UI_SRC, ctx);
  return { win, writes, toasts };
}
const fakeSheet = () => ({ querySelectorAll: () => [] });
const ROW = { leadId: 'L1', phone: '5135550100', email: 'pat@example.test' };
(async () => {
  {
    let args = null;
    const s = sandbox({ sendSMS: async (a) => { args = a; return { success: true, mode: 'platform' }; } });
    await s.win.NBDWinback._send(ROW, 'checkin', 'Subj', 'sms', 'Hi Pat. Reply STOP to opt out.', fakeSheet());
    ok('SMS goes through NBDComms.sendSMS with source winback + leadId', args && args.to === ROW.phone && args.message && args.leadId === 'L1' && args.source === 'winback' && args.sourceRef === 'L1');
    ok('a real SMS send records lastWinbackAt / lastWinbackKind / winbackCount n+1 on the lead',
      s.writes.length === 1 && s.writes[0][0] === 'leads/L1' && s.writes[0][1].lastWinbackAt instanceof s.win.Date
      && s.writes[0][1].lastWinbackKind === 'checkin' && s.writes[0][1].winbackCount === 3, JSON.stringify(s.writes));
  }
  {
    const s = sandbox({ sendSMS: async () => ({ success: true, mode: 'queued' }) });
    await s.win.NBDWinback._send(ROW, 'checkin', 'Subj', 'sms', 'Hi', fakeSheet());
    ok('a queued (offline) text is NOT recorded', s.writes.length === 0 && s.toasts.some((t) => /queued/i.test(t[0])));
  }
  {
    const s = sandbox({ sendSMS: async () => ({ success: false, mode: 'platform', message: 'Opted out' }) });
    await s.win.NBDWinback._send(ROW, 'checkin', 'Subj', 'sms', 'Hi', fakeSheet());
    ok('success:false is NOT recorded and shows an error toast', s.writes.length === 0 && s.toasts.some((t) => t[1] === 'error' && /Opted out/.test(t[0])));
  }
  {
    let args = null;
    const s = sandbox({ sendEmail: async (a) => { args = a; return { success: true, mode: 'platform' }; } });
    await s.win.NBDWinback._send(ROW, 'referral', 'Thank you', 'email', 'Hi Pat <b>x</b>. Reply STOP to opt out.', fakeSheet());
    ok('email goes through NBDComms.sendEmail with kind winback (commercial: unsubscribe gate + footer)',
      args && args.kind === 'winback' && args.to === ROW.email && args.subject === 'Thank you' && args.leadId === 'L1');
    ok('the email html is escaped and drops the SMS STOP line', args && /&lt;b&gt;/.test(args.html) && !/STOP/.test(args.html));
    ok('a real email send is recorded', s.writes.length === 1 && s.writes[0][1].lastWinbackKind === 'referral');
  }
  {
    const s = sandbox({ sendEmail: async () => ({ success: true, mode: 'mailto' }) });
    await s.win.NBDWinback._send(ROW, 'checkin', 'S', 'email', 'Hi', fakeSheet());
    ok('a mailto handoff is NOT recorded', s.writes.length === 0 && s.toasts.some((t) => /mail app/i.test(t[0])));
  }
  {
    let called = false;
    const s = sandbox({ sendSMS: async () => { called = true; return { success: true, mode: 'platform' }; } }, true);
    await s.win.NBDWinback._send(ROW, 'checkin', 'S', 'sms', 'Hi', fakeSheet());
    ok('a viewer is refused by NBDRole.guard() — nothing sent, nothing recorded', !called && s.writes.length === 0);
  }

  console.log('\n6. wiring');
  const loader = fs.readFileSync(path.join(PRO, 'js', 'script-loader.js'), 'utf8');
  const dash = fs.readFileSync(path.join(PRO, 'dashboard.html'), 'utf8');
  const cust = fs.readFileSync(path.join(PRO, 'customer.html'), 'utf8');
  const actions = fs.readFileSync(path.join(PRO, 'js', 'dashboard-actions.js'), 'utf8');
  const state = fs.readFileSync(path.join(PRO, 'js', 'dashboard-state.js'), 'utf8');
  ok('script-loader has the winback bundle, logic before UI',
    // (the view's stylesheet may ride first — reskin 2026-10-03)
    /winback:\s*\[\s*(?:'css\/[\w-]+\.css\?v=\d+',\s*)?'js\/winback-logic\.js\?v=\d+',\s*(?:'css\/[\w-]+\.css\?v=\d+',\s*)?'js\/winback\.js\?v=\d+'\s*\]/.test(loader));
  ok('the winback view maps to the winback bundle', /winback:\s*\['winback'\]/.test(loader));
  const v1 = (dash.match(/js\/script-loader\.js\?v=(\d+)/) || [])[1], v2 = (cust.match(/js\/script-loader\.js\?v=(\d+)/) || [])[1];
  ok('dashboard.html and customer.html load the same script-loader version', v1 && v1 === v2, v1 + ' vs ' + v2);
  ok('dashboard has the template-hydrated view-winback mount',
    /id="view-winback" data-view-template="tpl-view-winback"/.test(dash) && /<template id="tpl-view-winback"><div class="view-scroll" id="winbackScroll"><\/div><\/template>/.test(dash));
  ok('desktop sidebar has the Past Customers nav item', /class="ni"[^>]*data-action="goTo" data-target="winback" id="nav-winback"/.test(dash));
  ok('phone More drawer has the Past Customers item', /class="mm-item" data-action="mobileNav" data-target="winback"/.test(dash));
  ok('goTo inits NBDWinback after the lazy preload', /if\(name==='winback'\)\s*\{\s*_lazyPreload\.then\(\(\) => \{ if \(window\.NBDWinback\)\s*window\.NBDWinback\.init\(\);/.test(actions));
  ok('routeConfig labels the view "Past Customers"', /'winback':\s*\{\s*label:\s*'Past Customers'/.test(state));
  const code = UI_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok('winback.js defines and uses esc()', /const esc = \(s\) =>/.test(code) && (code.match(/esc\(/g) || []).length >= 15);
  ok('every rendered row value goes through esc()',
    /esc\(r\.name\)/.test(code) && /esc\(r\.address\)/.test(code) && /esc\(r\.lastJobTitle\)/.test(code) && /esc\(href\)/.test(code) && /esc\(r\.leadId\)/.test(code));
  // The 44px lives in css/winback-view.css since the reskin (2026-10-03):
  // follow the button's wbx- class to its rule rather than an inline style.
  const reachBtn = (code.match(/isViewer\(\) \? '' : '<button[^\n]*data-wb-action="reach"[^\n]*/) || [''])[0];
  const reachCls = (reachBtn.match(/\b(wbx-[\w-]+)/) || [])[1];
  const wbCss = (() => { try { return fs.readFileSync(path.join(__dirname, '..', 'docs', 'pro', 'css', 'winback-view.css'), 'utf8'); } catch (_) { return ''; } })();
  const reachRule = reachCls ? (wbCss.split(/\r?\n/).find((l) => l.startsWith('.' + reachCls + '.')) || '') : '';
  ok('the Reach out button is at least 44px tall and hidden from viewers',
    !!reachBtn && (/min-height:44px/.test(reachBtn) || /min-height:\s*44px/.test(reachRule)), reachCls + ' → ' + reachRule.slice(0, 80));
  ok('no inline handlers in winback.js', !/\son[a-z]+=/i.test(UI_SRC));
  ok('nothing sends on load: sendSMS/sendEmail are only reached from send()',
    (code.match(/\.sendSMS\(/g) || []).length === 1 && (code.match(/\.sendEmail\(/g) || []).length === 1);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('Failures:'); fails.forEach((x) => console.log('  - ' + x)); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
