/**
 * tests/estimate-follow-board-2026-10-19.test.js
 *
 * Open Estimates Follow-Up Board (docs/pro/js/estimate-follow-board.js, flag
 * estimateFollowBoard, functions/estimate-follow-templates.js). Pins:
 *   1. who is on the board: open estimate, N = 3 days out AND quiet, past the
 *      next cadence day, not snoozed / closed / do-not-contact; the cadence
 *      step math (3, 7, 14, 30) and how it advances after a send;
 *   2. grouping (cash / insurance / finance), sort (opened first, then value),
 *      value in cents from jobValue only, channel (text / email / call);
 *   3. the four server wordings: company name, STOP line, length, the Kentucky
 *      gate, no forbidden words (with a positive control so the scan can fail),
 *      the client email wording equals the server wording;
 *   4. results: counts are counts, signed value is PROJECTED, only the ledger
 *      sum is "collected";
 *   5. the REAL module in a vm sandbox: flag off = nothing renders / reads /
 *      writes (flag-on positive control); Draft calls fileLeadTextDraft with a
 *      template key and nothing else; "I sent it" goes through the Home card's
 *      stampNudge; nothing ever sends;
 *   6. source + wiring guards (comments stripped first). The new keys ride the
 *      existing callable and its gates (tests/pixel-draft-2026-10-11.test.js);
 *      here: the callable accepts them, still refuses prototype keys, and the
 *      callable file is untouched and never writes sms_log.
 *
 * Synthetic data only (public repo): ZZ_QA ids.
 * Run: node tests/estimate-follow-board-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC_PATH = path.join(ROOT, 'docs/pro/js/estimate-follow-board.js');
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

const B = require(SRC_PATH);
const EF = require(path.join(ROOT, 'docs/pro/js/estimate-followups.js'));
const T = require(path.join(ROOT, 'functions/estimate-follow-templates.js'));
const PD = require(path.join(ROOT, 'functions/pixel-draft-logic.js'));
const L = require(path.join(ROOT, 'functions/agent-mcp-logic.js'));

const DAY = 86400000;
const NOW = Date.UTC(2026, 9, 19, 15);          // 2026-10-19 15:00 UTC
const ago = (d) => NOW - d * DAY;
const est = (id, daysOut, over) => Object.assign({
  id, firstName: 'ZZ_QA', lastName: id, stage: 'estimate_sent_cash', lastSharedAt: ago(daysOut), jobValue: 10000,
  phone: '(859) 555-0101', email: 'zz_qa@example.com', tcpaConsent: true,
}, over || {});
const board = (leads, opts) => B.buildBoard(leads, NOW, opts);
const ids = (b) => [].concat.apply([], b.groups.map((g) => g.rows.map((r) => r.leadId)));
const rowOf = (b, id) => [].concat.apply([], b.groups.map((g) => g.rows)).filter((r) => r.leadId === id)[0];

// ── 1. who is on the board, and the cadence ─────────────────────────────
console.log('who is on the board (N = 3 days out and quiet)');
{
  ok('N is 3 and the cadence is 3, 7, 14, 30', B.MIN_DAYS === 3 && B.CADENCE.join() === '3,7,14,30');
  ok('a 2-day-old estimate is not on the board yet (the Home card owns day 2)', ids(board([est('a', 2)])).length === 0 && board([est('a', 2)]).notYet === 1);
  ok('3 days out is on it, with the day-3 step', rowOf(board([est('a', 3)]), 'a') && rowOf(board([est('a', 3)]), 'a').step.key === 'est_follow_d3');
  ok('6 days out, untouched: still the day-3 step (day 7 not reached)', rowOf(board([est('a', 6)]), 'a').step.index === 0);
  ok('7 days out: the day-7 step is not skipped to, because nothing was sent yet (latest passed day wins)', rowOf(board([est('a', 7)]), 'a').step.key === 'est_follow_d7');
  ok('14 days out untouched: day 14 wording', rowOf(board([est('a', 14)]), 'a').step.key === 'est_follow_d14');
  ok('46 days out untouched: the closing-the-file wording, never "making sure it came through"', rowOf(board([est('a', 46)]), 'a').step.key === 'est_follow_d30');

  // after a send
  const sent3 = est('a', 4, { lastEstimateNudgeAt: ago(1), estimateNudgeCount: 1 });
  ok('nudged yesterday (day 3 step): off the board, counted as waiting', ids(board([sent3])).length === 0 && board([sent3]).waiting === 1);
  const at7 = est('a', 8, { lastEstimateNudgeAt: ago(5), estimateNudgeCount: 1 });
  ok('one nudge 5 days ago, 8 days out: back with the day-7 step', rowOf(board([at7]), 'a') && rowOf(board([at7]), 'a').step.key === 'est_follow_d7');
  const tooSoon = est('a', 8, { lastEstimateNudgeAt: ago(2), estimateNudgeCount: 1 });
  ok('one nudge only 2 days ago: held until it has been quiet 3 days (no double prompt)', ids(board([tooSoon])).length === 0);
  const wait7 = est('a', 5, { lastEstimateNudgeAt: ago(3), estimateNudgeCount: 1 });
  ok('nudged at day 2, 5 days out: day 7 has not arrived, so not shown', ids(board([wait7])).length === 0);
  const twice = est('a', 15, { lastEstimateNudgeAt: ago(4), estimateNudgeCount: 2 });
  ok('two nudges done, 15 days out: day-14 step', rowOf(board([twice]), 'a').step.key === 'est_follow_d14');
  const fourth = est('a', 40, { lastEstimateNudgeAt: ago(10), estimateNudgeCount: 4 });
  ok('the day-30 closing message went out: the row drops off, counted as finished', ids(board([fourth])).length === 0 && board([fourth]).done === 1);
  const stale = est('a', 20, { lastEstimateNudgeAt: ago(30), estimateNudgeCount: 3 });
  ok('a nudge from BEFORE the estimate was re-sent does not count', rowOf(board([stale]), 'a') && rowOf(board([stale]), 'a').step.index === 2);
  const oldNudge = est('a', 9, { lastEstimateNudgeAt: ago(20), estimateNudgeCount: 3 });
  ok('...the cadence restarts for the new send', rowOf(board([oldNudge]), 'a').step.index === 1);

  console.log('who never appears');
  const never = [
    est('snz', 9, { snoozedUntil: NOW + DAY }),
    est('fu', 9, { followUp: '2026-10-25' }),
    est('won', 9, { stage: 'contract_signed' }),
    est('lost', 9, { stage: 'lost' }),
    est('role', 9, { stageRole: 'won' }),
    est('del', 9, { deleted: true }),
    est('arc', 9, { archived: true }),
    est('newlead', 9, { stage: 'new', lastSharedAt: null }),
    est('dnc', 9, { doNotContact: true }),
    est('future', -2),
  ];
  const nb = board(never.concat([est('control', 9)]));
  ok('snoozed, future follow-up date, signed, lost, won-role, deleted, archived, not-an-estimate, do-not-contact, future-dated: none shown', ids(nb).join() === 'control', ids(nb).join());
  ok('control: a plain estimate in the same list IS shown', rowOf(nb, 'control') !== undefined);
  ok('do-not-contact is counted as held back, not hidden silently', nb.held === 1);
  ok('minDays option moves N (clamped 1..30)', ids(board([est('a', 5)], { minDays: 7 })).length === 0 && ids(board([est('a', 5)], { minDays: 5 })).length === 1 && board([est('a', 5)], { minDays: 0 }).minDays === 3 && board([], { minDays: 999 }).minDays === 30);
}

// ── 2. grouping, sort, value, channel ───────────────────────────────────
console.log('grouping, sort, value, channel');
{
  const ls = [
    est('c_small', 9, { jobValue: 5000 }),
    est('c_big', 9, { jobValue: 21000 }),
    est('c_opened', 9, { jobValue: 4000, lastViewedAt: ago(1) }),
    est('i1', 9, { jobType: 'insurance', jobValue: 15000 }),
    est('f1', 9, { jobType: 'Finance', jobValue: 12000 }),
  ];
  const b = board(ls);
  ok('groups in order cash, insurance, finance', b.groups.map((g) => g.track).join() === 'cash,insurance,finance');
  ok('inside a group: opened-but-silent first, then biggest', b.groups[0].rows.map((r) => r.leadId).join() === 'c_opened,c_big,c_small');
  ok('totals are projected cents from jobValue', b.valueCents === (5000 + 21000 + 4000 + 15000 + 12000) * 100 && b.groups[0].valueCents === 30000 * 100 && b.total === 5);
  ok('track: jobType wins, then stage', B.trackOf({ jobType: 'Insurance Claim' }) === 'insurance' && B.trackOf({ jobType: 'finance' }) === 'finance' && B.trackOf({ stage: 'estimate_sent_cash' }) === 'cash' && B.trackOf({ jobType: 'cash', claimStatus: 'filed' }) === 'cash' && B.trackOf({ claimStatus: 'filed', stage: 'estimate_submitted' }) === 'insurance');
  ok('value reads jobValue only: no cost, margin or contractor field', B.valueCents({ jobValue: 100, materialCost: 99999, marginPct: 40, contractorCost: 5 }) === 10000 && B.valueCents({ materialCost: 5000 }) === 0 && B.valueCents({ jobValue: 'abc' }) === 0 && B.valueCents({ jobValue: -5 }) === 0);
  ok('money format', B.fmtMoney(1234500) === '$12,345' && B.fmtMoney(0) === '$0');
  ok('opened label comes from the Home card logic', rowOf(b, 'c_opened').opened === true && /Opened/.test(rowOf(b, 'c_opened').openedLabel) && rowOf(b, 'c_big').openedLabel === 'Not opened yet');
  ok('a draft already waiting in the inbox is flagged (one waiting draft per customer)', rowOf(board(ls, { waitingDraftIds: { c_big: true } }), 'c_big').draftWaiting === true && rowOf(b, 'c_big').draftWaiting === false);

  const ch = (over) => rowOf(board([est('x', 9, over)]), 'x').channel;
  ok('channel text with a phone and no refusal', ch({}) === 'text');
  ok('declined texting on the form -> email', ch({ tcpaConsent: false }) === 'email');
  ok('STOP / Do Not Text on the lead -> email', ch({ smsOptedOut: true }) === 'email' && ch({ doNotText: true }) === 'email' && ch({ smsOptOut: true }) === 'email');
  ok('no phone -> email; no phone and unsubscribed -> call', ch({ phone: '' }) === 'email' && ch({ phone: '', unsubscribed: true }) === 'call' && ch({ phone: '', email: '' }) === 'call');
  ok('a bad number is not textable', ch({ phone: '555' }) === 'email');
}

// ── 3. the four server wordings ─────────────────────────────────────────
console.log('the four wordings (server) and the copy-only email');
{
  const NAMES = ['No Big Deal Home Solutions'];
  ok('exactly four keys, matching the client list', T.TEMPLATE_KEYS.join() === 'est_follow_d3,est_follow_d7,est_follow_d14,est_follow_d30' && T.TEMPLATE_KEYS.join() === B.TEMPLATE_KEYS.join() && T.CADENCE_DAYS.join() === B.CADENCE.join());
  ok('Pixel World keeps its own four (TEMPLATE_KEYS unchanged); the callable accepts all eight', PD.TEMPLATE_KEYS.length === 4 && PD.ALL_TEMPLATES && Object.keys(PD.ALL_TEMPLATES).length === 8 && T.TEMPLATE_KEYS.every((k) => PD.isTemplateKey(k)));
  ok('prototype keys are still refused', ['__proto__', 'constructor', 'toString', 'hasOwnProperty'].every((k) => !PD.isTemplateKey(k)));

  // Extra words beyond the Pixel list: employment claims, "licensed", insurance-claim talk.
  const BAD = /\b(licensed|in-house|employees?|our (crew|crews|team|installers|staff)|w-?2|claims?|insur\w*|adjusters?|coverage|deductibles?|aob|assign\w*|negotiat\w*|handle|guarantee\w*|free|prices?|cost|discount|deposits?|waiv\w*|rebates?|deadline|limited time|act now|today only)\b|\$|[<>]/i;
  ok('positive control: the scan catches each banned idea', ['We handle your claim', 'We are licensed', 'our in-house crew', 'assignment of benefits', 'free estimate', 'limited time offer', 'your deductible', '$500'].every((s) => BAD.test(s)));
  T.TEMPLATE_KEYS.forEach((k) => {
    const t = T.TEMPLATES[k];
    const d = PD.buildLeadTextDraft(k, { firstName: 'ZZ_QA' }, NAMES);
    ok(k + ': builds, says the business name, STOP line, within the text limit', d.body && /No Big Deal Home Solutions/.test(d.body) && d.body.endsWith(L.STOP_LINE) && d.body.length <= L.SMS_MAX, JSON.stringify(d));
    ok(k + ': passes the Kentucky wording gate and has no banned word', !L.claimWordingProblem(d.body) && !BAD.test(t.line) && !PD.FORBIDDEN_IN_TEMPLATE.test(t.line) && !BAD.test(d.body.replace(/No Big Deal Home Solutions/, '').replace(L.STOP_LINE, '')));
    ok(k + ': a name-less lead still reads right; no company name set is refused', /^Hi, this is /.test(PD.buildLeadTextDraft(k, {}, NAMES).body) && PD.buildLeadTextDraft(k, {}, []).code === 'no_company_name');
  });
  ok('client email lines are the server lines, word for word', B.LINES.length === 4 && B.LINES.every((x, i) => x === T.TEMPLATES[T.TEMPLATE_KEYS[i]].line));
  for (let i = 0; i < 4; i++) {
    ['cash', 'insurance', 'finance'].forEach((track) => {
      const e = B.emailCopy(i, track, 'Maria', 'Acme Roofing', 'Pat');
      const all = e.subject + '\n' + e.body;
      ok('email step ' + i + ' ' + track + ': business name, no claim wording, no banned words, subject plain', /Acme Roofing/.test(e.body) && !L.claimWordingProblem(all) && !BAD.test(all.replace(B.FINANCE_LINE, '')) && e.subject === 'Your roof estimate' && /mailing address and an unsubscribe/.test(e.reminder));
    });
  }
  ok('finance adds the payment-options line on steps 1-3 only; insurance and cash do not', /payment options/.test(B.emailCopy(1, 'finance', 'A', 'Co', '').body) && !/payment options/.test(B.emailCopy(1, 'insurance', 'A', 'Co', '').body) && !/payment options/.test(B.emailCopy(1, 'cash', 'A', 'Co', '').body) && !/payment options/.test(B.emailCopy(3, 'finance', 'A', 'Co', '').body));
  ok('no business name known: a visible placeholder, never a hard-coded NBD name', /\[your business name\]/.test(B.emailCopy(0, 'cash', 'A', '', '').body) && !/No Big Deal/.test(CODE));
}

// ── 4. results: collected only ──────────────────────────────────────────
console.log('results (collected is the only revenue)');
{
  const ls = [
    est('s1', 20, { lastEstimateNudgeAt: ago(10), estimateNudgeCount: 2, stage: 'contract_signed', jobValue: 20000, lastReplyAt: ago(8), lastViewedAt: ago(9), contractSignedAt: ago(8) }),
    est('s2', 30, { lastEstimateNudgeAt: ago(25), estimateNudgeCount: 1, stage: 'lost', jobValue: 7000, lastInboundAt: ago(1) }),
    est('s3', 40, { lastEstimateNudgeAt: ago(200), estimateNudgeCount: 1, stage: 'contract_signed', jobValue: 99999 }),
    est('open1', 9, { jobValue: 9000 }),
    est('s4', 12, { lastEstimateNudgeAt: ago(3), estimateNudgeCount: 1, jobValue: 3000, lastViewedAt: ago(20), lastReplyAt: ago(6) }),
  ];
  const m = B.metrics(ls, NOW, { s1: 12500.5, s2: 100, s3: 5000 }, 90);
  ok('sent = nudged inside the window (the 200-day-old nudge is outside)', m.sent === 3 && m.touches === 4);
  ok('replied counts only a reply AFTER the last follow-up (s1, s2 yes; s4 replied before its nudge, no; s3 out of window)', m.replied === 2);
  ok('opened-after counts only an open AFTER the nudge', m.openedAfter === 1);
  ok('signed-since counts signed leads nudged in the window; value is projected', m.signed === 1 && m.signedProjectedCents === 2000000);
  ok('collected = the ledger sum for those signed leads only, in cents', m.collectedCents === 1250050);
  ok('days to close from sent to signed', m.medianDaysToSign === 12);
  ok('open pipeline is projected and counts only open estimates (not signed, not lost)', m.openCount === 2 && m.openProjectedCents === (9000 + 3000) * 100, JSON.stringify([m.openCount, m.openProjectedCents]));
  ok('no money data loaded: collected is null, never 0 and never a projection', B.metrics(ls, NOW, null, 90).collectedCents === null);
  ok('signed value never leaks into collected', B.metrics(ls, NOW, {}, 90).collectedCents === 0 && B.metrics(ls, NOW, {}, 90).signedProjectedCents === 2000000);
}

// ── 5. the real module in a sandbox ─────────────────────────────────────
function boot(opts) {
  opts = opts || {};
  const handlers = {};
  const created = [];
  const body = { children: [], appendChild(n) { n.parentNode = body; body.children.push(n); }, removeChild(n) { body.children = body.children.filter((c) => c !== n); n.parentNode = null; } };
  const btn = { id: 'estimateFollowBoardBtn', hidden: true, getAttribute() { return null; } };
  btn.closest = () => btn;
  const badge = { id: 'estimateFollowBoardBadge', hidden: true, textContent: '' };
  const document = {
    readyState: 'complete', body,
    getElementById: (id) => (id === 'estimateFollowBoardBtn' ? btn : id === 'estimateFollowBoardBadge' ? badge : null),
    createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, remove() { body.removeChild(n); } }; created.push(n); return n; },
    querySelector() { return null; },
    addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
  };
  const calls = [], stamps = [], fsReads = [], toasts = [];
  const win = {
    document,
    _leads: opts.leads || [],
    _userClaims: opts.claims || {},
    _user: { uid: 'u1', displayName: 'Jo Tester' },
    NBDFlags: opts.realFlags ? undefined : { enabled: (n) => !!opts.flag && n === 'estimateFollowBoard', load: () => Promise.resolve() },
    doc: (db, c, id) => ({ c, id }),
    getDoc: async (ref) => ({ exists: () => !!(opts.flagDocs && opts.flagDocs[ref.id]), data: () => (opts.flagDocs && opts.flagDocs[ref.id]) || {} }),
    NBDEstimateFollowups: Object.assign({}, EF, {
      callable: async (name, data) => { calls.push({ name, data }); return opts.callResult || { ok: true, status: 'filed', message: 'Draft filed. It is in the Agent inbox for the owner or an admin to send. Nothing was texted.' }; },
      stampNudge: async (id, via) => { stamps.push({ id, via }); return opts.stampResult === undefined ? true : opts.stampResult; },
    }),
    NBDRevenue: { loadInvoices: async () => { fsReads.push('invoices'); return []; }, collectedByLead: () => ({}) },
    getDocs: async () => { fsReads.push('agent_inbox'); return { docs: (opts.inbox || []).map((x) => ({ data: () => x })) }; },
    query: (...a) => a, where: (...a) => a, collection: (...a) => a, db: {},
    addEventListener() {},
    showToast: (m, t) => toasts.push([m, t]),
    _brand: () => ({ shortName: 'Acme Roofing' }),
  };
  const ctx = { window: win, document, setTimeout: () => 0, setInterval: () => 0, console, Date, Promise, Set, Math, JSON, parseInt, String, Object, Array, isFinite, Number, RegExp };
  win.window = win;
  if (opts.realFlags) vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/feature-flags.js'), 'utf8'), ctx, { filename: 'feature-flags.js' });
  vm.runInNewContext(SRC, ctx, { filename: 'estimate-follow-board.js' });
  const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
  const target = (attrs) => { const t = { id: '', getAttribute: (n) => (attrs[n] === undefined ? null : attrs[n]) }; t.closest = () => t; return t; };
  return {
    win, created, btn, badge, calls, stamps, fsReads, toasts, overlay: () => created[0],
    clickBtn: () => fire('click', { target: btn, preventDefault() {} }),
    act: (a, id, extra) => fire('click', { target: target(Object.assign({ 'data-efb-act': a, 'data-efb-id': id }, extra || {})), preventDefault() {} }),
    tab: (t) => fire('click', { target: target({ 'data-efb-tab': t }), preventDefault() {} }),
  };
}
const QL = () => [est('ZZ_QA_1', 9, { firstName: 'Big', lastName: 'Deal', jobValue: 20000 }), est('ZZ_QA_2', 9, { firstName: 'No', lastName: 'Text', tcpaConsent: false, jobValue: 8000 })];

(async () => {
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    console.log('flag off, viewer, member: nothing renders, reads or writes');
    {
      const e = boot({ flag: false, leads: QL() });
      e.win.NBDEstimateFollowBoard.sync();
      ok('button stays hidden, open() refuses', e.btn.hidden === true && (await e.win.NBDEstimateFollowBoard.open()) === false);
      e.clickBtn(); e.act('draft', 'ZZ_QA_1', { 'data-efb-key': 'est_follow_d7' }); e.act('sent', 'ZZ_QA_1');
      await tick();
      ok('no element, no callable, no stamp, no read', e.created.length === 0 && e.calls.length === 0 && e.stamps.length === 0 && e.fsReads.length === 0);
    }
    for (const role of ['viewer', 'member']) {
      const e = boot({ flag: true, claims: { role }, leads: QL() });
      e.win.NBDEstimateFollowBoard.sync(); e.clickBtn(); e.act('draft', 'ZZ_QA_1', { 'data-efb-key': 'est_follow_d7' });
      await tick();
      ok('flag on but ' + role + ': hidden, refuses, no callable, no read', e.btn.hidden === true && e.created.length === 0 && e.calls.length === 0 && e.fsReads.length === 0);
    }

    console.log('flag on, owner (positive control)');
    {
      const e = boot({ flag: true, leads: QL() });
      e.win.NBDEstimateFollowBoard.sync();
      ok('button shows with the count badge', e.btn.hidden === false && e.badge.textContent === '2' && e.badge.hidden === false);
      e.clickBtn();
      await until(() => e.created[0] && /efb-row/.test(e.overlay().innerHTML) && e.fsReads.length >= 1, 'board');
      const h = e.overlay().innerHTML;
      ok('both customers listed, biggest first, with value and the projected label', h.indexOf('Big Deal') < h.indexOf('No Text') && /\$20,000/.test(h) && /projected, not revenue/.test(h));
      ok('opens read-only: no callable, no stamp', e.calls.length === 0 && e.stamps.length === 0);
      ok('the one read is the Agent inbox (waiting drafts); no invoices until Results', e.fsReads.join() === 'agent_inbox');
      ok('text customer gets Draft text; the declined-texting one gets email wording, no draft button', /data-efb-act="draft" data-efb-id="ZZ_QA_1"/.test(h) && !/data-efb-act="draft" data-efb-id="ZZ_QA_2"/.test(h) && /data-efb-act="emailpanel" data-efb-id="ZZ_QA_2"/.test(h));
      ok('plain words on the page: nothing sends from here, send between 10am and 8pm', /Nothing sends from here/.test(h) && /10am and 8pm/.test(h));

      e.act('draft', 'ZZ_QA_1', { 'data-efb-key': 'est_follow_d7' });
      await until(() => e.calls.length === 1, 'draft call');
      ok('Draft calls fileLeadTextDraft with exactly a lead id and a template key', e.calls[0].name === 'fileLeadTextDraft' && Object.keys(e.calls[0].data).sort().join() === 'leadId,template' && e.calls[0].data.template === 'est_follow_d7' && e.calls[0].data.leadId === 'ZZ_QA_1');
      await until(() => /Draft waiting in your Agent inbox/.test(e.overlay().innerHTML), 'waiting note');
      ok('after a filed draft: the Draft button is gone for that customer (one waiting draft each)', !/data-efb-act="draft" data-efb-id="ZZ_QA_1"/.test(e.overlay().innerHTML));
      ok('still no stamp: filing a draft is not a send', e.stamps.length === 0);

      e.act('emailpanel', 'ZZ_QA_2');
      await tick();
      ok('email wording panel: copy-only text with the reminder, no mailto', /Subject: Your roof estimate/.test(e.overlay().innerHTML) && /Acme Roofing/.test(e.overlay().innerHTML) && /unsubscribe/.test(e.overlay().innerHTML) && !/mailto:/.test(e.overlay().innerHTML));

      e.act('sent', 'ZZ_QA_1', { 'data-efb-chan': 'text' });
      await until(() => e.stamps.length === 1, 'stamp');
      ok('"I sent it" goes through the Home card stamp, tagged with the board and channel', e.stamps[0].id === 'ZZ_QA_1' && e.stamps[0].via === 'board_text');
      ok('never more than one callable name was used, and it was the draft one', e.calls.every((c) => c.name === 'fileLeadTextDraft'));

      e.tab('results');
      await until(() => /Follow-ups you sent/.test(e.overlay().innerHTML), 'results');
      ok('results tab reads the money ledger only now, and says only collected is revenue', e.fsReads.indexOf('invoices') !== -1 && /Only collected money is revenue/.test(e.overlay().innerHTML));
    }

    console.log('server refusal is shown, not hidden');
    {
      const e = boot({ flag: true, leads: QL(), callResult: { ok: true, status: 'not_allowed', code: 'cannot_text', message: 'This customer is on the Do-Not-Text list (they replied STOP). No text draft — file a note instead.' } });
      e.clickBtn();
      await until(() => e.created[0] && /efb-row/.test(e.overlay().innerHTML), 'board');
      e.act('draft', 'ZZ_QA_1', { 'data-efb-key': 'est_follow_d7' });
      await until(() => /Do-Not-Text/.test(e.overlay().innerHTML), 'refusal');
      ok('the refusal text is on screen and the button stays (nothing was filed)', /data-efb-act="draft" data-efb-id="ZZ_QA_1"/.test(e.overlay().innerHTML) && !/Draft waiting in your Agent inbox/.test(e.overlay().innerHTML));
    }

    console.log('a failed stamp is not reported as success');
    {
      const e = boot({ flag: true, leads: QL(), stampResult: false });
      e.clickBtn();
      await until(() => e.created[0] && /efb-row/.test(e.overlay().innerHTML), 'board');
      e.act('sent', 'ZZ_QA_1', { 'data-efb-chan': 'text' });
      await until(() => e.stamps.length === 1 && /Could not save that/.test(e.overlay().innerHTML), 'failure message');
      ok('stamp failed: says so, never "Marked."', !/Marked\./.test(e.overlay().innerHTML) && /Nothing was marked/.test(e.overlay().innerHTML));
    }

    console.log('the real feature-flags.js: an absent flag is off, a set flag is on');
    {
      const off = boot({ realFlags: true, leads: QL(), flagDocs: { _default: { somethingElse: true } } });
      await off.win.NBDFlags.load();
      off.win.NBDEstimateFollowBoard.sync();
      ok('absent flag (real NBDFlags): hidden, open() refuses, nothing created', off.win.NBDFlags.enabled('estimateFollowBoard') === false && off.btn.hidden === true && (await off.win.NBDEstimateFollowBoard.open()) === false && off.created.length === 0);
      const on = boot({ realFlags: true, leads: QL(), flagDocs: { _default: { estimateFollowBoard: true } } });
      await on.win.NBDFlags.load();
      on.win.NBDEstimateFollowBoard.sync();
      ok('control: flag true in feature_flags/_default (real NBDFlags): button shows', on.win.NBDFlags.enabled('estimateFollowBoard') === true && on.btn.hidden === false);
      const mine = boot({ realFlags: true, leads: QL(), flagDocs: { _default: { estimateFollowBoard: true }, u1: { estimateFollowBoard: false } } });
      await mine.win.NBDFlags.load();
      mine.win.NBDEstimateFollowBoard.sync();
      ok('a per-user false overrides the default (real NBDFlags)', mine.btn.hidden === true);
    }

    console.log('hostile text never becomes markup');
    {
      const evil = '<img src=x onerror=alert(1)>';
      const ls = [
        est('a"><img src=x onerror=alert(2)>', 9, { firstName: evil, lastName: '<script>alert(3)</script>', jobType: evil, claimStatus: evil, tcpaConsent: false, email: 'zz_qa@example.com' }),
        est('b', 9, { firstName: 'Bee', name: '', lastName: '', jobType: 'insurance' }),
        est('c"><img src=x onerror=alert(5)>', 9, { firstName: 'Cee' }),
      ];
      const e = boot({ flag: true, leads: ls, callResult: { ok: true, status: 'filed', message: '<b>x</b><img src=y onerror=alert(4)>' } });
      e.win._brand = () => ({ shortName: evil + ' Roofing' });
      e.win._user.displayName = '<i>Jo</i>';
      e.clickBtn();
      await until(() => e.created[0] && /efb-row/.test(e.overlay().innerHTML), 'board');
      e.act('emailpanel', 'a"><img src=x onerror=alert(2)>');
      e.act('draft', 'b', { 'data-efb-key': 'est_follow_d7' });
      await until(() => /Draft waiting/.test(e.overlay().innerHTML), 'draft msg');
      const h = e.overlay().innerHTML;
      ok('no raw tag from a name, id, job type, brand, owner name or the server message', !/<img|<script|<b>|<i>/i.test(h.replace(/<(\/?)(div|span|a|ul|li|h[1-3]|p|b|section|button|label|textarea|table|tbody|tr|th|td)\b/gi, '')) && !/onerror=alert/.test(h.replace(/&lt;[^&]*&gt;/g, '')), h.slice(0, 300));
      ok('the hostile text IS on the page, escaped (positive control)', /&lt;img src=x onerror=alert\(1\)&gt;/.test(h) && /&lt;b&gt;x&lt;\/b&gt;/.test(h));
      ok('the id inside href / data attributes cannot break out of the attribute', !/data-efb-id="a"><img/.test(h) && !/id="a"><img/.test(h));
    }

    console.log('a rep sees only their own leads');
    {
      const ls = [est('mine', 9, { userId: 'u1' }), est('theirs', 9, { userId: 'u2' })];
      const e = boot({ flag: true, claims: { role: 'sales_rep' }, leads: ls });
      e.win.NBDEstimateFollowBoard.sync();
      ok('badge counts only the rep\'s own lead', e.badge.textContent === '1');
    }
  } finally { Date.now = realNow; }

  // ── 6. source + wiring guards ──────────────────────────────────────────
  console.log('source and wiring guards');
  {
    ok('no network, no beacon, no mailto, no sms_log, no twilio, no send call', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|mailto:|sms_log|twilio|sendSms|sendEmail|sendText|NBDPhoneShare|\.share\s*\(/i.test(CODE));
    ok('the only callable named is fileLeadTextDraft', (CODE.match(/callFn\(\s*'([^']+)'/g) || []).join() === "callFn('fileLeadTextDraft'" && !/callable\(\s*'(?!fileLeadTextDraft)/.test(CODE));
    ok('no Firestore write of its own (the stamp is the Home card\'s)', !/\b(updateDoc|setDoc|addDoc|deleteDoc|runTransaction|writeBatch)\b/.test(CODE));
    ok('flag name, gated on it', /estimateFollowBoard/.test(CODE) && /NBDFlags\.enabled\(FLAG\)/.test(CODE) && /return flagOn\(\) &&/.test(CODE));
    ok('no inline handlers, no cost/margin fields read', !/\bon[a-z]+\s*=\s*["']/.test(CODE) && !/materialCost|laborCost|margin|contractorCost|leadCost|miscCosts/.test(CODE));
    ok('every CRM string is escaped before innerHTML', /esc\(r\.name\)/.test(CODE) && /esc\(r\.leadId\)/.test(CODE) && /esc\(r\.openedLabel\)/.test(CODE) && !/\+\s*r\.name\s*\+/.test(CODE));
    const dash = fs.readFileSync(path.join(ROOT, 'docs/pro/dashboard.html'), 'utf8');
    const iBoard = dash.indexOf('<script defer src="js/estimate-follow-board.js'), iEF = dash.indexOf('<script defer src="js/estimate-followups.js');
    ok('dashboard: button hidden by default, css linked, script deferred AFTER estimate-followups.js', /id="estimateFollowBoardBtn"[^>]*\bhidden\b/.test(dash) && /css\/estimate-follow-board\.css/.test(dash) && /<script defer src="js\/estimate-follow-board\.js/.test(dash) && iEF > 0 && iBoard > iEF);
    const ef = fs.readFileSync(path.join(ROOT, 'docs/pro/js/estimate-followups.js'), 'utf8');
    ok('the Home card exports the one shared stamp and callable', /api\.stampNudge = stampNudge/.test(ef) && /api\.callable = callable/.test(ef));
    const pd = fs.readFileSync(path.join(ROOT, 'functions/pixel-draft.js'), 'utf8');
    ok('the callable file is untouched: still gates on isTemplateKey and never writes sms_log', /P\.isTemplateKey\(data\.template\)/.test(pd) && !/sms_log/.test(strip(pd)));
    const tpl = strip(fs.readFileSync(path.join(ROOT, 'functions/estimate-follow-templates.js'), 'utf8'));
    ok('template file is pure data: no require, no Firestore, no send', !/require\(|firebase|getFirestore|\.send\(|fetch/.test(tpl));
    const tracked = require('child_process').execSync('git ls-files docs functions firestore.rules firebase.json scripts', { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\n').filter((f) => /\.(js|mjs|json|html|rules)$/.test(f));
    const turnedOn = tracked.filter((f) => { try { return /estimateFollowBoard['"]?\]?\s*[:=]\s*(true|1)\b/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')); } catch (e) { return false; } });
    ok('flag is not turned on anywhere in docs/, functions/, scripts/ or the rules (' + tracked.length + ' files)', tracked.length > 500 && turnedOn.length === 0, turnedOn.join());
    ok('control: the same scan finds a flag that IS written on', /estimateFollowBoard['"]?\]?\s*[:=]\s*(true|1)\b/.test('x = { estimateFollowBoard: true }') && /estimateFollowBoard['"]?\]?\s*[:=]\s*(true|1)\b/.test("flags['estimateFollowBoard'] = true"));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
