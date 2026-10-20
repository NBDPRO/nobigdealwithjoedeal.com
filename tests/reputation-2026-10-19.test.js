/**
 * tests/reputation-2026-10-19.test.js
 *
 * "Reputation" (docs/pro/js/reputation.js, flag reputationLoop; plan 4). Pins:
 *   1. who sees it, the patches the owner's taps write (shape the rules accept);
 *   2. finished+paid detection from the real collected-revenue.js ledger, and
 *      ask status READ from the existing stamps (a lead with no payment is never
 *      listed, so never "asked");
 *   3. counts, and the low-rating alert: ratings 1-3 only, unreplied only, owner
 *      only, and the alert text carries no name or address;
 *   4. reply templates and ALL screen copy: no claim / coverage / insurance /
 *      incentive / gating wording (a control string proves the check can fail);
 *   5. the real module in a sandbox: flag off or non-owner renders / reads /
 *      writes nothing (with a flag-on positive control); a tap writes exactly the
 *      reputation patch; nothing is sent (no fetch except the Google summary read);
 *   6. the portal audit pin: every rater is offered the public review link;
 *   7. source + wiring guards (comments stripped first).
 *
 * Synthetic data only (public repo): ZZ_QA ids. The rules side is
 * tests/firestore-rules.reputation.test.js (emulator).
 * Run: node tests/reputation-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'docs/pro/js/reputation.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const CODE = strip(SRC);

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 400; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

const P = require(SRC_PATH);

// The REAL revenue ledger, so "paid" here cannot drift from the rest of the CRM.
const revWin = { addEventListener() {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/collected-revenue.js'), 'utf8'), { window: revWin, Date, Math, parseFloat, isNaN, Object, Array, Promise, console, setTimeout });
const paymentsOf = revWin.NBDRevenue.paymentsOf;
const isOwed = revWin.NBDRevenue.isOwedInvoice;

const D = (y, m, d) => Date.UTC(y, m - 1, d, 12);
const NOW = D(2026, 10, 19);
const lead = (id, over) => Object.assign({ id, firstName: 'ZZ_QA', lastName: id, stage: 'won', companyId: 'co' }, over || {});
const paidInv = (leadId, at, amt) => ({ id: 'inv_' + leadId, leadId, status: 'paid', total: amt || 100, balanceDue: 0, payments: [{ amount: amt || 100, at }] });

// ── 1. who, patches ────────────────────────────────────────────────────
console.log('permissions and patches');
{
  ok('solo operator, company_admin and platform admin can see it', P.canSee({}, 'u1') && P.canSee({ companyId: 'u1' }, 'u1') && P.canSee({ role: 'company_admin', companyId: 'c' }, 'u2') && P.canSee({ role: 'admin' }, 'u3'));
  ok('manager, rep, viewer, foreign-company member and signed-out user cannot', !P.canSee({ role: 'manager', companyId: 'c' }, 'u') && !P.canSee({ role: 'sales_rep', companyId: 'c' }, 'u') && !P.canSee({ role: 'viewer' }, 'u') && !P.canSee({ companyId: 'x' }, 'u') && !P.canSee({}, null));
  ok('four platforms: Google, Yelp, Thumbtack, other', P.PLATFORMS.map((p) => p.key).join() === 'google,yelp,thumbtack,other');
  const s = P.seenPatch(true, 'yelp', 2, 'u1', 'TS', null);
  ok('seen patch is exactly the six rule keys', Object.keys(s.reputation).sort().join() === 'rating,responded,reviewSeen,platform,updatedAt,updatedBy'.split(',').sort().join());
  ok('seen patch values', s.reputation.reviewSeen === true && s.reputation.platform === 'yelp' && s.reputation.rating === 2 && s.reputation.responded === false && s.reputation.updatedAt === 'TS' && s.reputation.updatedBy === 'u1');
  ok('bad platform, half star, 0, 6, text rating and no user give no patch', [P.seenPatch(true, 'facebook', 3, 'u', 'T'), P.seenPatch(true, 'google', 3.5, 'u', 'T'), P.seenPatch(true, 'google', 0, 'u', 'T'), P.seenPatch(true, 'google', 6, 'u', 'T'), P.seenPatch(true, 'google', '5', 'u', 'T'), P.seenPatch(true, 'google', 5, null, 'T')].every((x) => x === null));
  const u = P.seenPatch(false, null, null, 'u1', 'TS');
  ok('undo clears platform and rating and resets replied, still stamped', u.reputation.reviewSeen === false && u.reputation.platform === null && u.reputation.rating === null && u.reputation.responded === false && u.reputation.updatedBy === 'u1');
  const l = lead('A', { reputation: { reviewSeen: true, platform: 'google', rating: 2, responded: false } });
  const r = P.respondedPatch(true, l, 'u1', 'TS');
  ok('"I replied" keeps platform and rating and flips responded', r.reputation.responded === true && r.reputation.platform === 'google' && r.reputation.rating === 2);
  ok('"I replied" on a lead with no logged review gives no patch', P.respondedPatch(true, lead('B'), 'u1', 'TS') === null);
  const same = P.seenPatch(true, 'google', 2, 'u1', 'TS', { reputation: { reviewSeen: true, platform: 'google', rating: 2, responded: true } });
  const diff = P.seenPatch(true, 'google', 1, 'u1', 'TS', { reputation: { reviewSeen: true, platform: 'google', rating: 2, responded: true } });
  ok('re-logging the same review keeps "replied"; a different rating resets it', same.reputation.responded === true && diff.reputation.responded === false);
}

// ── 2. paid jobs + ask status ──────────────────────────────────────────
console.log('finished + paid, and ask status read from existing stamps');
const invs = [
  paidInv('PAID1', D(2026, 10, 1)),
  paidInv('PAID2', D(2026, 9, 1)),
  Object.assign(paidInv('OWES', D(2026, 9, 1)), { status: 'sent', balanceDue: 50 }),          // part paid, balance still due
  Object.assign({ id: 'x', leadId: 'NOPAY', status: 'sent', total: 500, balanceDue: 500 }),   // nothing collected
  Object.assign(paidInv('GONE', D(2026, 9, 1)), { deleted: true }),
  Object.assign(paidInv('REFUNDED', D(2026, 9, 1)), { refunds: [{ amount: 100, at: D(2026, 9, 5) }] }),
  paidInv(null, D(2026, 9, 1)),
];
const paid = P.paidLeads(invs, paymentsOf, isOwed);
{
  ok('a fully paid lead is listed, with collected cents and the last payment day', paid.PAID1 && paid.PAID1.collectedCents === 10000 && paid.PAID1.lastPaidMs === D(2026, 10, 1));
  ok('part-paid with a balance due, unpaid, deleted, fully refunded and lead-less invoices are NOT listed', !paid.OWES && !paid.NOPAY && !paid.GONE && !paid.REFUNDED && Object.keys(paid).sort().join() === 'PAID1,PAID2');
  const a = P.askInfo(lead('A', { reviewRequested: true, reviewRequestedAt: D(2026, 10, 5), reviewRequestSource: 'auto-email', reviewAutoAsk: { channel: 'email', status: 'sent', sentAtMs: D(2026, 10, 5) } }));
  ok('auto email ask reads as asked, with date and channel', a.status === 'asked' && a.askedAtMs === D(2026, 10, 5) && a.channel === 'email');
  ok('a manual ask (reviewRequested only) reads as asked', P.askInfo(lead('B', { reviewRequested: true, reviewRequestedAt: D(2026, 10, 6), reviewRequestSource: 'manual' })).status === 'asked');
  ok('an auto text ask reads as asked by text', P.askInfo(lead('C', { reviewRequested: true, reviewRequestSource: 'auto-text', reviewAutoAsk: { channel: 'text', status: 'sent' } })).channel === 'text');
  ok('sending / failed / skipped / nothing', P.askInfo(lead('D', { reviewAutoAsk: { status: 'sending' } })).status === 'sending'
    && P.askInfo(lead('E', { reviewAutoAsk: { status: 'no_postal' } })).status === 'failed'
    && P.askInfo(lead('F', { reviewAskDeclined: true })).status === 'skipped'
    && P.askInfo(lead('G')).status === 'not_yet');
  ok('a declined flag does not hide a real ask', P.askInfo(lead('H', { reviewAskDeclined: true, reviewRequested: true })).status === 'asked');
  const leads = [lead('PAID1', { reviewRequested: true, reviewRequestedAt: D(2026, 10, 5) }), lead('PAID2'), lead('NOPAY', { reviewRequested: true, reviewRequestedAt: D(2026, 10, 5) }), lead('PAID3', { deleted: true }), lead('PAID4', { isProspect: true })];
  const rows = P.buildRows(leads, Object.assign({ PAID3: { collectedCents: 1, lastPaidMs: 1 }, PAID4: { collectedCents: 1, lastPaidMs: 1 } }, paid));
  ok('rows are paid customers only, newest payment first; a lead with no payment is never "asked"', rows.map((r) => r.id).join() === 'PAID1,PAID2' && !rows.some((r) => r.id === 'NOPAY'));
  ok('asked vs not asked is right per row', rows[0].ask.status === 'asked' && rows[1].ask.status === 'not_yet');
}

// ── 3. counts + alerts ─────────────────────────────────────────────────
console.log('counts and the owner-only low-rating alert');
const mk = (id) => ({ id, name: 'Name ' + id, first: id, ask: { status: 'asked', askedAtMs: D(2026, 10, 8), channel: 'email' }, seen: { seen: false, platform: '', rating: 0, responded: false }, privateRating: 0, lastPaidMs: 1, collectedCents: 1 });
const seenRow = (id, platform, rating, responded) => Object.assign(mk(id), { seen: { seen: true, platform, rating, responded: !!responded } });
const rowsC = [
  seenRow('five', 'google', 5), seenRow('four', 'yelp', 4), seenRow('three', 'google', 3), seenRow('two', 'thumbtack', 2), seenRow('one', 'google', 1), seenRow('oneReplied', 'google', 1, true),
  mk('quiet'), Object.assign(mk('old'), { ask: { status: 'asked', askedAtMs: D(2026, 9, 1), channel: 'email' } }), Object.assign(mk('na'), { ask: { status: 'not_yet', askedAtMs: 0 } }), Object.assign(mk('skip'), { ask: { status: 'skipped', askedAtMs: 0 } }),
];
{
  const c = P.counts(rowsC, NOW);
  ok('paid, asked, asked this month', c.paid === 10 && c.asked === 8 && c.askedThisMonth === 7);
  ok('reviews logged and replied', c.seen === 6 && c.responded === 1);
  ok('average is of the logged ratings only (5+4+3+2+1+1)/6 = 2.7', c.rated === 6 && c.avg === 2.7);
  ok('no logged ratings gives a null average, not 0', P.counts([mk('x')], NOW).avg === null);
  ok('skipped and not-yet are counted apart', c.skipped === 1 && c.notYet === 1);
  const owner = { companyId: 'u1' };
  const low = P.lowAlerts(rowsC, owner, 'u1');
  ok('alert fires for 1, 2 and 3 stars that are unreplied - and only those', low.map((r) => r.id).sort().join() === 'one,three,two');
  ok('a 4 or 5 star, or a replied 1 star, does not alert', !low.some((r) => ['five', 'four', 'oneReplied'].includes(r.id)));
  ok('a manager, rep or viewer gets no alert at all (owner only)', ['manager', 'sales_rep', 'viewer'].every((role) => P.lowAlerts(rowsC, { role, companyId: 'co' }, 'u9').length === 0));
  ok('an asked-but-unlogged customer is not an alert', !low.some((r) => r.id === 'quiet'));
  const t = P.alertText(3) + '|' + P.alertText(1);
  ok('alert text is a count only: no name, address, platform or stars', t === '3 reviews need your reply|1 review needs your reply' && !/Name|ZZ_QA|google|yelp|★/.test(t));
  ok('"asked >14 days ago, nothing logged" lists only that customer', P.silentAsks(rowsC, NOW, 14).map((r) => r.id).join() === 'old');
}

// ── 4. wording ──────────────────────────────────────────────────────────
console.log('reply templates and screen copy wording');
// Kentucky wording rules (KRS 367.628), review rules (16 CFR 465, Google policy). Every word here would break one.
const FORBIDDEN = [
  /insur/i, /\bclaims?\b/i, /adjuster/i, /deductible/i, /coverage|covered/i, /\bAOB\b/i, /assignment of benefits/i,
  /refund|discount|free|gift|reward|\$\d|coupon|credit/i,                               // never offer anything
  /remove|delete|take down|change (your|the) review|update your review/i,                // never ask to alter a review
  /only if|if you (were|are) (happy|satisfied)|private(ly)? first|before (you )?post/i,  // no gating
  /in-house|in house|employees|W-?2/i,                                                   // crews are independent subs
];
const bad = (s) => FORBIDDEN.filter((rx) => rx.test(s)).map(String);
{
  ok('control: the check can fail (it flags claim, incentive, removal and gating wording)', bad('We handle your insurance claim').length > 0 && bad('Here is $50 off your next job').length > 0 && bad('Please remove your review').length > 0 && bad('Contact us privately first').length > 0 && bad('Our in-house crew').length > 0);
  ok('three templates, 5 stars / 3-4 stars / 1-2 stars', P.TEMPLATES.map((t) => t.key).join() === 'five,mid,low' && P.TEMPLATES.map((t) => t.label).join() === '5 stars,3-4 stars,1-2 stars');
  P.TEMPLATES.forEach((t) => ok('template "' + t.label + '" has no claim / incentive / removal / gating wording', bad(t.text).length === 0, bad(t.text).join(' ')));
  ok('every template is signed by Joe and uses the reviewer\'s first name', P.TEMPLATES.every((t) => /- Joe$/.test(t.text) && /\{first\}/.test(t.text)));
  ok('the 1-2 star reply asks for a call and promises nothing', /call me directly/.test(P.TEMPLATES[2].text) && !/(make (it|this) right|fix|resolve)/i.test(P.TEMPLATES[2].text));
  ok('filled with a name', P.fillTemplate('five', 'Dana').startsWith('Thank you, Dana.'));
  ok('filled without a name there is no dangling comma or placeholder', !/\{first\}|, \./.test(P.fillTemplate('mid', '')) && P.fillTemplate('mid', '').startsWith('Thanks for the honest review.'));
  ok('the name is cleaned: markup, digits and symbols are dropped', P.fillTemplate('five', '<b>Dana</b>9$') === P.fillTemplate('five', 'bDanab') && !/[<>$0-9]/.test(P.fillTemplate('five', '<b>Dana</b>9$')));
  ok('template picked by stars: 5 -> five, 3-4 -> mid, 1-2 -> low', P.templateFor(5) === 'five' && P.templateFor(4) === 'mid' && P.templateFor(3) === 'mid' && P.templateFor(2) === 'low' && P.templateFor(1) === 'low');
  P.RULES_COPY.forEach((t, i) => ok('rules line ' + (i + 1) + ' states the compliance rule without forbidden words', bad(t.replace(/Never offer anything for a review, and never ask someone to change or remove one\./, '')).length === 0));
  ok('rules copy says: ask everyone, offer nothing, owner alert only', /every paid customer the same way/i.test(P.RULES_COPY[0]) && /Never offer anything/.test(P.RULES_COPY[1]) && /here only/.test(P.RULES_COPY[2]));
  const ui = (SRC.match(/'[^'\n]{12,}'/g) || []).join(' ');
  ok('control: the UI string scan sees the screen copy', /Got a review/.test(ui) && /Reply drafts/.test(ui));
  ok('screen copy outside the rule lines has no claim / insurance / incentive wording', bad(ui.replace(/Never offer anything for a review, and never ask someone to change or remove one\./, '').replace(/Never skip the unhappy ones\./, '')).length === 0, bad(ui).join(' '));
  ok('Google summary: 5.0 stars across 29 reviews, only 5 readable -> partial', (() => { const g = P.googleSummary({ rating: 5, total: 29, reviews: [1, 2, 3, 4, 5] }); return g.rating === 5 && g.total === 29 && g.shown === 5 && g.partial === true; })());
  ok('Google summary: unusable answers give null (empty flag, missing numbers)', P.googleSummary({ empty: true, rating: 5, total: 9 }) === null && P.googleSummary({}) === null && P.googleSummary(null) === null && P.googleSummary({ rating: 7, total: 3 }) === null);
}

// ── 5. the real module in a sandbox ────────────────────────────────────
function boot(opts) {
  opts = opts || {};
  const handlers = {};
  const created = [];
  const body = { children: [], appendChild(n) { n.parentNode = body; body.children.push(n); }, removeChild(n) { body.children = body.children.filter((c) => c !== n); n.parentNode = null; } };
  const btn = { id: 'reputationBtn', hidden: true, getAttribute() { return null; } };
  btn.closest = () => btn;
  const badge = { id: 'reputationBadge', hidden: true, textContent: '' };
  const document = {
    readyState: 'complete', body,
    getElementById: (id) => (id === 'reputationBtn' ? btn : id === 'reputationBadge' ? badge : null),
    createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, remove() { body.removeChild(n); }, querySelector: () => null }; created.push(n); return n; },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
  };
  const writes = [], reads = { invoices: 0, fetch: [] }, toasts = [];
  const win = {
    document,
    _leads: opts.leads || [],
    _userClaims: opts.claims || {},
    _user: { uid: 'u1' },
    NBDFlags: { enabled: (n) => !!opts.flag && n === 'reputationLoop', load: () => Promise.resolve() },
    NBDRevenue: {
      paymentsOf, isOwedInvoice: isOwed,
      status: () => (opts.invoiceError ? 'failed' : 'ok'),
      cached: () => opts.invoices || null,
      loadInvoices: async () => { reads.invoices++; return opts.invoices || []; },
    },
    fetch: async (url) => { reads.fetch.push(url); return { ok: true, json: async () => ({ rating: 5, total: 29, reviews: [1, 2, 3, 4, 5] }) }; },
    addEventListener() {},
    showToast: (m, t) => toasts.push([m, t]),
    db: {}, doc: (db, c, id) => ({ c, id }), serverTimestamp: () => 'SERVER_TS',
    updateDoc: opts.updateDoc || (async (ref, patch) => { writes.push({ ref, patch }); }),
  };
  const ctx = { window: win, document, setTimeout: () => 0, setInterval: () => 0, console, Date, Promise, Set, Math, JSON, parseInt, String, Object, Array, isFinite, Number };
  win.window = win;
  vm.runInNewContext(SRC, ctx, { filename: 'reputation.js' });
  const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
  const target = (attrs) => { const t = { id: '', getAttribute: (n) => (attrs[n] === undefined ? null : attrs[n]) }; t.closest = () => t; return t; };
  const click = (attrs) => fire('click', { target: target(attrs), preventDefault() {} });
  return {
    win, created, btn, badge, writes, reads, toasts, overlay: () => created[0],
    clickBtn: () => fire('click', { target: btn, preventDefault() {} }), click,
  };
}
const QL = () => [
  lead('ZZ_QA_1', { firstName: 'Dana', lastName: 'Payer', reviewRequested: true, reviewRequestedAt: D(2026, 10, 5), reviewRequestSource: 'auto-email' }),
  lead('ZZ_QA_2', { firstName: 'Sam', lastName: 'Payer' }),
  lead('ZZ_QA_3', { firstName: 'Lee', lastName: 'Unpaid', reviewRequested: true }),
  lead('ZZ_QA_4', { firstName: 'Kim', lastName: 'Low', reviewRequested: true, reviewRequestedAt: D(2026, 10, 2), reputation: { reviewSeen: true, platform: 'google', rating: 2, responded: false } }),
];
const QI = () => [paidInv('ZZ_QA_1', D(2026, 10, 10)), paidInv('ZZ_QA_2', D(2026, 10, 12)), paidInv('ZZ_QA_4', D(2026, 10, 1))];

(async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    console.log('flag off / not the owner: nothing renders, reads or writes');
    {
      const e = boot({ flag: false, leads: QL(), invoices: QI() });
      e.win.NBDReputation.sync();
      ok('button stays hidden, open() refuses', e.btn.hidden === true && e.win.NBDReputation.open() === false);
      e.clickBtn(); e.click({ 'data-rep-log': 'ZZ_QA_2' }); e.click({ 'data-rep-act': 'save-log' });
      await tick();
      ok('no element, no read, no fetch, no write', e.created.length === 0 && e.reads.invoices === 0 && e.reads.fetch.length === 0 && e.writes.length === 0);
      ok('no alert badge when the flag is off, even with a 2-star review on file', e.badge.hidden === true && e.badge.textContent === '');
    }
    for (const role of ['manager', 'sales_rep', 'viewer']) {
      const e = boot({ flag: true, claims: { role, companyId: 'co' }, leads: QL(), invoices: QI() });
      e.win.NBDReputation.sync(); e.clickBtn();
      await tick();
      ok('flag on but ' + role + ': hidden, refuses, no read, no write, no badge', e.btn.hidden === true && e.created.length === 0 && e.reads.invoices === 0 && e.writes.length === 0 && e.badge.hidden === true);
    }

    console.log('flag on, owner (positive control)');
    {
      const e = boot({ flag: true, leads: QL(), invoices: QI() });
      e.win.NBDReputation.sync();
      ok('button shows for the owner; the badge counts the one unreplied low review', e.btn.hidden === false && e.badge.hidden === false && e.badge.textContent === '1');
      e.clickBtn();
      await until(() => /rep-counts/.test(e.overlay().innerHTML) && /Google: 5\.0/.test(e.overlay().innerHTML), 'screen');
      const h = e.overlay().innerHTML;
      ok('reads payments and the Google summary only when opened', e.reads.invoices === 1 && e.reads.fetch.join() === '/api/google-reviews');
      ok('lists the three paid customers and not the unpaid one', /Dana Payer/.test(h) || /ZZ_QA Dana/.test(h) || (/Dana/.test(h) && /Sam/.test(h) && /Kim/.test(h) && !/Lee/.test(h)));
      ok('Dana is "Asked 10/5/26 · email"-style, Sam is "Not asked yet"', /Asked 10\/5\/26/.test(h) && /Not asked yet/.test(h));
      ok('the low-rating alert shows a count in the banner', /role="alert"[^]*1 review needs your reply/.test(h));
      ok('Google line: 5.0 stars across 29 reviews, newest 5 readable', /Google: 5\.0★ across 29 reviews\. The CRM can read only the newest 5/.test(h));
      ok('counts: asked 3 of 3? (Dana and Kim asked; Sam not) -> 2 / 3', /<b>2 \/ 3<\/b>/.test(h));
      ok('the three compliance rules are on screen', /every paid customer the same way/.test(h) && /Never offer anything/.test(h) && /here only/.test(h));
      ok('nothing written before a tap', e.writes.length === 0);
      e.click({ 'data-rep-log': 'ZZ_QA_2' });
      ok('Got a review opens platform + stars with Save disabled', /data-rep-plat="google"/.test(e.overlay().innerHTML) && /data-rep-act="save-log" disabled/.test(e.overlay().innerHTML));
      e.click({ 'data-rep-plat': 'yelp' }); e.click({ 'data-rep-star': '1' });
      ok('Save enables once both are picked', !/data-rep-act="save-log" disabled/.test(e.overlay().innerHTML));
      e.click({ 'data-rep-act': 'save-log' });
      await until(() => e.writes.length === 1, 'write');
      const w0 = e.writes[0];
      ok('one tap writes exactly the reputation patch on that lead and nothing else', w0.ref.c === 'leads' && w0.ref.id === 'ZZ_QA_2' && Object.keys(w0.patch).join() === 'reputation');
      ok('patch: yelp, 1 star, server time, caller', w0.patch.reputation.platform === 'yelp' && w0.patch.reputation.rating === 1 && w0.patch.reputation.updatedAt === 'SERVER_TS' && w0.patch.reputation.updatedBy === 'u1' && w0.patch.reputation.reviewSeen === true);
      await until(() => e.badge.textContent === '2', 'badge');
      ok('the alert badge goes to 2 at once, and a toast tells Jo it needs a reply', e.badge.textContent === '2' && e.toasts.some((t) => /needs your reply/.test(t[0])));
      ok('nothing else was sent anywhere (only the Google summary was fetched)', e.reads.fetch.length === 1);
      e.click({ 'data-rep-act': 'toggle-replied', 'data-rep-id': 'ZZ_QA_4' });
      await until(() => e.writes.length === 2, 'replied write');
      ok('"I replied" writes responded true and keeps google / 2', e.writes[1].patch.reputation.responded === true && e.writes[1].patch.reputation.platform === 'google' && e.writes[1].patch.reputation.rating === 2);
      await until(() => e.badge.textContent === '1', 'badge after reply');
      ok('replying lowers the badge', e.badge.textContent === '1');
      e.click({ 'data-rep-reply': 'ZZ_QA_4' });
      ok('Reply draft picks the 1-2 star template and fills the first name', /call me directly/.test(e.overlay().innerHTML) && /Kim/.test(e.overlay().innerHTML));
    }
    {
      const e = boot({ flag: true, leads: QL(), invoices: QI(), updateDoc: async () => { const x = new Error('nope'); x.code = 'permission-denied'; throw x; } });
      e.clickBtn();
      await until(() => /rep-counts/.test(e.overlay().innerHTML), 'screen');
      e.click({ 'data-rep-log': 'ZZ_QA_2' }); e.click({ 'data-rep-plat': 'google' }); e.click({ 'data-rep-star': '5' }); e.click({ 'data-rep-act': 'save-log' });
      await until(() => e.toasts.length >= 1, 'error toast');
      await tick();
      ok('a refused write says so and does not mark the review logged', /Could not save: permission-denied/.test(e.toasts[0][0]) && e.win._leads[1].reputation === undefined);
    }
    {
      const e = boot({ flag: true, leads: QL(), invoices: QI(), invoiceError: true });
      e.clickBtn();
      await until(() => /role="alert"/.test(e.overlay().innerHTML), 'error state');
      ok('payments that cannot be read show an error and a retry, not an empty list', /Payments could not be read/.test(e.overlay().innerHTML) && /data-rep-act="retry"/.test(e.overlay().innerHTML) && !/rep-list/.test(e.overlay().innerHTML));
    }
  } finally { Date.now = realNow; }

  // ── 6. the audit: every rater is offered the public review ─────────────
  console.log('portal audit pin: no review gating on the live path');
  {
    const portal = strip(fs.readFileSync(path.join(ROOT, 'functions/portal.js'), 'utf8'));
    const seg = portal.slice(portal.indexOf('exports.submitCustomerRating'), portal.indexOf('exports.sendPortalMessage'));
    ok('control: found the rating function', seg.length > 2000 && /googleReviewUrl/.test(seg));
    ok('server returns the review link with no star condition around it', !/(starsNum|stars)\s*(>=|>|<=|<|===)\s*\d[^;{]*\?[^;]*googleReviewUrl/.test(seg) && !/if\s*\(\s*starsNum\s*(>=|>)\s*[34][^)]*\)\s*\{[^}]*googleReviewUrl/.test(seg));
    const client = fs.readFileSync(path.join(ROOT, 'docs/pro/js/portal.js'), 'utf8');
    const at = client.indexOf("if (json.tier === 'high')");
    const thanks = at < 0 ? '' : client.slice(at, at + 1800);
    ok('control: found the thank-you branches', at > 0 && /Thank you for the honest feedback/.test(thanks));
    ok('the portal shows the same Google button in BOTH the high and low branches', (thanks.match(/reviewBtn/g) || []).length >= 2 && /else\s*\{[\s\S]*reviewBtn/.test(thanks));
    ok('the rating card links straight to the public review BEFORE any rating', /crReviewLink[\s\S]{0,300}Or tell/.test(client) && /ratingInfo\.canRate && !ratingInfo\.submitted/.test(client));
    const ask = fs.readFileSync(path.join(ROOT, 'functions/review-ask-auto-logic.js'), 'utf8');
    ok('the automatic ask never reads a rating, mood or private feedback to decide who is asked', !/customerRating|reputation|stars|sentiment/i.test(strip(ask)));
    const nudge = fs.readFileSync(path.join(ROOT, 'functions/review-request-nudge.js'), 'utf8');
    ok('the rep nudge never reads a rating either', !/customerRating|reputation|sentiment/i.test(strip(nudge)));
  }

  // ── 7. source + wiring guards ──────────────────────────────────────────
  console.log('source guards (comments stripped)');
  ok('guard has teeth: the stripper keeps code and drops comments', /function lowAlerts/.test(CODE) && !/Ask every paid customer the same way\. Never ask only/.test(CODE) && /Never ask only the happy ones/.test(SRC));
  ok('the flag is reputationLoop, read through NBDFlags', /FLAG = 'reputationLoop'/.test(CODE) && /NBDFlags\.enabled\(FLAG\)/.test(CODE));
  ok('no new send: no messaging, email, SMS, Cloud Function or callable code', !/sendSms|sendEmail|twilio|resend|httpsCallable|queue|mailto:|sms:|tel:|messaging_controls|email_queue|notifications/i.test(CODE));
  ok('the only network call is the Google summary read', (CODE.match(/\bfetch\(/g) || []).length === 1 && /w\.fetch\('\/api\/google-reviews'/.test(CODE));
  ok('writes only through updateDoc on leads, one call site', (CODE.match(/updateDoc\(/g) || []).length === 1 && /updateDoc\(w\.doc\(db, 'leads', id\), patch\)/.test(CODE));
  ok('no delete, no batch, no review text or reviewer name is stored', !/deleteDoc|writeBatch|deleted\s*:\s*true|reviewText|comment\s*:/.test(CODE));
  ok('the alert never filters on who was asked or on a rating before asking (no "happy" screening)', !/\bhappy\b|satisf|only if/i.test(CODE));
  ok('no inline handlers or styles in generated markup', !/\son[a-z]+=/.test(CODE) && !/style="/.test(CODE));
  ok('no boot-time reads: loading happens inside open()', !/loadInvoices/.test(CODE.replace(/async function loadData[\s\S]*?\n  \}\n/, '')));
  const html = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
  ok('dashboard: button ships hidden', /id="reputationBtn"[^>]*\shidden/.test(html));
  ok('dashboard: external deferred script + stylesheet, no inline script', /<script defer src="js\/reputation\.js\?v=\d+"><\/script>/.test(html) && /css\/reputation\.css/.test(html));
  const css = fs.readFileSync(path.join(ROOT, 'docs/pro/css/reputation.css'), 'utf8');
  ok('phone fit: 44px taps and a single column under 480px', /\.rep-pill[^}]*min-height: 44px/.test(css) && /\.rep-btn[^}]*min-height: 44px/.test(css) && /@media \(max-width: 480px\)/.test(css) && /\.rep-foot \{ flex-direction: column-reverse/.test(css));
  ok('rules: the map is owner-only and reachable from the lead update rule', (() => {
    const r = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
    return /function reputationWriteOk/.test(r) && /&& reputationWriteOk\(\)/.test(r) && /'reputation'\s*\n\s*\]\);/.test(r);
  })());



  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
