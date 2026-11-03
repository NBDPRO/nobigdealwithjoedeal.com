/**
 * tests/follow-up-board-2026-11-03.test.js
 *
 * The Follow-up board (docs/pro/js/follow-up-board-logic.js + follow-up-board.js,
 * functions/follow-up-templates.js, flag followUpBoard). Pins:
 *   1. ranking: section order (waiting, promised, quiet, stale), one section per
 *      lead, value then oldest inside a section;
 *   2. each rule at its boundary: 2h waiting, the 4h promise flag, a share
 *      clearing a promise (a stage move does not), 3 days at New;
 *   3. held back and counted, never shown: do-not-contact, snoozed; lost and
 *      signed leads are out; Thumbtack never gets an email channel;
 *   4. the fu_* wordings: banned words with a positive control, and the
 *      callable refuses them unless followUpBoard is on (server side, dark);
 *   5. the real DOM module in a vm sandbox: flag off = nothing renders, reads or
 *      writes; flag on draft sends only a template key; promise / replied write
 *      one field; nothing ever sends;
 *   6. strict CSP + wiring: no inline handler or script in the new files, the
 *      dashboard loads them in order.
 * Synthetic data only (ZZ_QA). Run: node tests/follow-up-board-2026-11-03.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const tick = () => new Promise((r) => setImmediate(r));
async function until(fn, what) {
  for (let i = 0; i < 400; i++) { if (fn()) return true; await tick(); }
  throw new Error('timed out waiting for ' + what);
}

const F = require(path.join(ROOT, 'docs/pro/js/follow-up-board-logic.js'));
const EB = require(path.join(ROOT, 'docs/pro/js/estimate-follow-board.js'));
const EF = require(path.join(ROOT, 'docs/pro/js/estimate-followups.js'));
const T = require(path.join(ROOT, 'functions/follow-up-templates.js'));
const PD = require(path.join(ROOT, 'functions/pixel-draft-logic.js'));

const H = 3600000, DAY = 86400000;
const NOW = Date.UTC(2026, 10, 3, 15);
const ids = (sec, d) => d.sections.filter((s) => s.key === sec)[0].rows.map((r) => r.leadId).join();
const base = (id, over) => Object.assign({ id, firstName: 'ZZ_QA', lastName: id, phone: '5135550100' }, over);
const waiting = (id, hoursAgo, over) => base(id, Object.assign({ stage: 'contacted', lastInboundAt: NOW - hoursAgo * H }, over));
const promised = (id, hoursAgo, over) => base(id, Object.assign({ stage: 'inspected', estimatePromisedAt: NOW - hoursAgo * H }, over));
const quiet = (id, daysOut, over) => base(id, Object.assign({ stage: 'estimate_sent_cash', lastSharedAt: NOW - daysOut * DAY, jobValue: 10000 }, over));
const stale = (id, daysOld, over) => base(id, Object.assign({ stage: 'new', stageRole: 'new', createdAt: NOW - daysOld * DAY }, over));

console.log('1. ranking');
{
  const d = F.buildFollowUps([stale('s1', 5), quiet('q1', 5), promised('p1', 6), waiting('w1', 3)], NOW);
  ok('sections come back in Jo\'s order: waiting, promised, quiet, stale', d.sections.map((s) => s.key).join() === 'waiting,promised,quiet,stale');
  ok('each lead lands in its own section', ids('waiting', d) === 'w1' && ids('promised', d) === 'p1' && ids('quiet', d) === 'q1' && ids('stale', d) === 's1');
  ok('total counts all four', d.total === 4);
  const both = F.buildFollowUps([waiting('x', 3, { estimatePromisedAt: NOW - 9 * H, stage: 'estimate_sent_cash', lastSharedAt: NOW - 8 * DAY })], NOW);
  ok('a lead that qualifies for several sections appears once, in the highest', both.total === 1 && ids('waiting', both) === 'x');
  const promisedAndQuiet = F.buildFollowUps([promised('y', 9, { stage: 'estimate_sent_cash', lastSharedAt: NOW - 20 * DAY })], NOW);
  ok('promised beats quiet when the promise is newer than the last share', ids('promised', promisedAndQuiet) === 'y' && ids('quiet', promisedAndQuiet) === '');
  const sorted = F.buildFollowUps([waiting('small_old', 30, { jobValue: 1000 }), waiting('big_new', 3, { jobValue: 20000 }), waiting('big_old', 9, { jobValue: 20000 }), waiting('none', 40)], NOW);
  ok('inside a section: biggest dollars first, then oldest', ids('waiting', sorted) === 'big_old,big_new,small_old,none');
  ok('values are projected cents from jobValue and summed per section', sorted.sections[0].valueCents === (20000 + 20000 + 1000) * 100 && sorted.valueCents === sorted.sections[0].valueCents);
}

console.log('2. boundaries');
{
  const w = (h) => ids('waiting', F.buildFollowUps([waiting('w', h)], NOW));
  ok('customer message 1h59m old: not waiting yet', ids('waiting', F.buildFollowUps([base('w', { lastInboundAt: NOW - (2 * H - 60000) })], NOW)) === '');
  ok('exactly 2h old: waiting', w(2) === 'w');
  ok('a portal message (lastHomeownerMessageAt) counts too', ids('waiting', F.buildFollowUps([base('w', { lastHomeownerMessageAt: NOW - 5 * H, lastInboundVia: 'portal' })], NOW)) === 'w');
  ok('Jo replied after the message (lastRepMessageAt / lastContactedAt / lastOutboundAt / nudge): not waiting',
    ['lastRepMessageAt', 'lastContactedAt', 'lastOutboundAt', 'lastEstimateNudgeAt'].every((k) => ids('waiting', F.buildFollowUps([waiting('w', 5, { [k]: NOW - 1 * H })], NOW)) === ''));
  ok('Jo\'s touch BEFORE the message does not answer it', ids('waiting', F.buildFollowUps([waiting('w', 5, { lastContactedAt: NOW - 9 * H })], NOW)) === 'w');
  ok('a message dated in the future is ignored', ids('waiting', F.buildFollowUps([base('w', { lastInboundAt: NOW + H })], NOW)) === '');

  const p = (h) => ids('promised', F.buildFollowUps([promised('p', h)], NOW));
  ok('promise 3h59m old: not flagged yet', ids('promised', F.buildFollowUps([base('p', { estimatePromisedAt: NOW - (4 * H - 60000) })], NOW)) === '');
  ok('promise exactly 4h old: flagged', p(4) === 'p');
  ok('promise 5 days old: still flagged', p(120) === 'p');
  ok('an estimate shared AFTER the promise clears it', p(6) === 'p' && ids('promised', F.buildFollowUps([promised('p', 6, { lastSharedAt: NOW - 1 * H })], NOW)) === '');
  ok('an estimate shared BEFORE the promise does not clear it', ids('promised', F.buildFollowUps([promised('p', 6, { lastSharedAt: NOW - 10 * H })], NOW)) === 'p');
  ok('estimateSentAt after the promise also clears it', ids('promised', F.buildFollowUps([promised('p', 6, { estimateSentAt: NOW - 1 * H })], NOW)) === '');
  ok('a stage move after the promise does NOT clear it', ids('promised', F.buildFollowUps([promised('p', 6, { stageStartedAt: NOW - 1 * H })], NOW)) === 'p');
  ok('clearing the promise (null) removes the row', ids('promised', F.buildFollowUps([promised('p', 6, { estimatePromisedAt: null })], NOW)) === '');
  const patch = F.promisePatch(NOW);
  ok('the one-tap writes estimatePromisedAt as ms and nothing else', Object.keys(patch).join() === 'estimatePromisedAt' && patch.estimatePromisedAt === NOW);

  const s = (d) => ids('stale', F.buildFollowUps([stale('s', d)], NOW));
  ok('New for 2 days: not stale', s(2) === '' && ids('stale', F.buildFollowUps([stale('s', 3 - 1 / 24)], NOW)) === '');
  ok('New for exactly 3 days: stale', s(3) === 's');
  ok('New and touched by Jo (call logged): not stale', ids('stale', F.buildFollowUps([stale('s', 5, { lastContactedAt: NOW - 4 * DAY })], NOW)) === '');
  ok('not at New: not stale', ids('stale', F.buildFollowUps([stale('s', 5, { stage: 'contacted', stageRole: 'contacted' })], NOW)) === '');
  ok('quiet estimate: the existing board rule (3 days out) still applies', ids('quiet', F.buildFollowUps([quiet('q', 2)], NOW)) === '' && ids('quiet', F.buildFollowUps([quiet('q', 3)], NOW)) === 'q');
}

console.log('3. held back, out, channels');
{
  const rows = [waiting('dnc', 5, { doNotContact: true }), waiting('snz', 5, { snoozedUntil: NOW + DAY }), waiting('fut', 5, { followUp: '2099-01-01' }),
    promised('pdnc', 9, { dnc: true }), stale('sdnc', 9, { doNotContact: true }), stale('ssnz', 9, { snoozedUntil: NOW + DAY })];
  const d = F.buildFollowUps(rows, NOW);
  ok('do-not-contact and snoozed leads are not shown', d.total === 0);
  ok('...but they are counted so nobody is silently dropped', d.held.dnc === 3 && d.held.snoozed === 3, JSON.stringify(d.held));
  const out = F.buildFollowUps([waiting('lost', 5, { stageRole: 'lost' }), waiting('won', 5, { stageRole: 'won' }), waiting('gone', 5, { deleted: true }), waiting('signed', 5, { stage: 'contract_signed' }), waiting('arch', 5, { archived: true })], NOW);
  ok('lost, won, deleted, archived and signed leads are out entirely', out.total === 0 && out.held.dnc === 0 && out.held.snoozed === 0);

  const tt = F.buildFollowUps([waiting('tt', 5, { source: 'Thumbtack', email: 'x@example.com', tcpaConsent: false }), waiting('tt2', 6, { source: 'Thumbtack', phone: '' , email: 'y@example.com' })], NOW);
  const chans = tt.sections[0].rows.map((r) => r.channel).sort().join();
  ok('a Thumbtack lead never gets the email channel: text if it has a phone it may text, else call', chans === 'call,call', chans);
  const okTT = F.buildFollowUps([waiting('tt', 5, { source: 'Thumbtack' })], NOW).sections[0].rows[0];
  ok('Thumbtack with a phone: text draft offered, source chip says Thumbtack', okTT.channel === 'text' && okTT.canDraft === true && okTT.source === 'Thumbtack' && okTT.templateKey === 'fu_reply_ack');
  const web = F.buildFollowUps([waiting('w', 5, { source: 'Website - inspect', phone: '', email: 'a@example.com' })], NOW).sections[0].rows[0];
  ok('a website lead with only an email: email channel, no draft button', web.channel === 'email' && web.canDraft === false && web.source === 'Website');
  const keys = F.buildFollowUps([waiting('w', 5), promised('p', 9), quiet('q', 8), stale('s', 9)], NOW).sections.map((s) => s.rows[0].templateKey).join();
  ok('each section drafts its own wording key', keys === 'fu_reply_ack,fu_promise_est,est_follow_d7,fu_new_checkin', keys);
  const dw = F.buildFollowUps([waiting('w', 5)], NOW, { waitingDraftIds: { w: true } }).sections[0].rows[0];
  ok('a lead with a draft already waiting says so', dw.draftWaiting === true);
}

console.log('4. wordings and the server flag');
{
  ok('three fu_* keys exist', T.TEMPLATE_KEYS.join() === 'fu_reply_ack,fu_promise_est,fu_new_checkin');
  T.TEMPLATE_KEYS.forEach((k) => {
    const t = T.TEMPLATES[k];
    ok(k + ': no banned word', !PD.FORBIDDEN_IN_TEMPLATE.test(t.line) && !PD.FORBIDDEN_IN_TEMPLATE.test(t.reason.replace(/Follow-up board:[^.]*\./, '')));
    const d = PD.buildLeadTextDraft(k, { firstName: 'Maria' }, ['Acme Roofing']);
    ok(k + ': builds a draft that passes the Kentucky wording gate, signed with the company', !d.error && /^Hi Maria, this is Acme Roofing\./.test(d.body) && /STOP/i.test(d.body), JSON.stringify(d));
  });
  ok('positive control: the banned-word scan can fail', PD.FORBIDDEN_IN_TEMPLATE.test('We will cover your deductible') === true);
  ok('the callable accepts the new keys and still refuses prototype keys', PD.isTemplateKey('fu_reply_ack') && !PD.isTemplateKey('__proto__') && !PD.isTemplateKey('constructor'));
}

// the callable: dark behind followUpBoard (server side)
let DB;
function fakeDb() {
  const docs = new Map();
  const snap = (p) => ({ id: p.split('/').pop(), exists: docs.has(p), data: () => docs.get(p) });
  const mk = (p) => ({ id: p.split('/').pop(), path: p, get: async () => snap(p), set: async (v) => { docs.set(p, Object.assign({}, v)); },
    create: async (v) => { if (docs.has(p)) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } docs.set(p, Object.assign({}, v)); } });
  return { docs, doc: mk };
}
DB = fakeDb();
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'firebase-admin/firestore') return { getFirestore: () => DB, FieldValue: { serverTimestamp: () => ({ toMillis: () => Date.now() }) } };
  if (request === 'firebase-admin/auth') return { getAuth: () => ({ getUser: async (uid) => ({ uid, disabled: false, customClaims: {} }) }) };
  if (/upstash-ratelimit$/.test(request)) return { enforceRateLimit: async () => ({ count: 1 }) };
  return origLoad.apply(this, arguments);
};
const M = require(path.join(ROOT, 'functions/pixel-draft.js'));
const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const call = async (data) => { try { return { r: await M.fileLeadTextDraft.run({ auth: { uid: NBD, token: {} }, data, rawRequest: {} }) }; } catch (e) { return { err: e }; } };
const inbox = () => [...DB.docs.keys()].filter((k) => /^agent_inbox\//.test(k));
function seed(flags) {
  DB = fakeDb();
  DB.docs.set('leads/ok1', { userId: NBD, companyId: NBD, firstName: 'Maria', phone: '(513) 555-0147', tcpaConsent: true, stage: 'contacted' });
  Object.keys(flags || {}).forEach((k) => DB.docs.set('feature_flags/' + k, flags[k]));
}

(async () => {
  console.log('4b. callable: fu_* refused unless followUpBoard is on');
  for (const [label, flags] of [['no flag docs', {}], ['flag false', { _default: { followUpBoard: false } }], ['estimateFollowBoard on is not enough', { _default: { estimateFollowBoard: true } }], ['per-user false beats default true', { _default: { followUpBoard: true }, [NBD]: { followUpBoard: false } }]]) {
    seed(flags);
    for (const k of T.TEMPLATE_KEYS) {
      const x = await call({ leadId: 'ok1', template: k });
      ok(label + ' / ' + k + ': not_allowed, nothing filed', x.r && x.r.status === 'not_allowed' && inbox().length === 0, JSON.stringify(x.r || (x.err && x.err.message)));
    }
  }
  seed({ _default: { followUpBoard: true } });
  const on = await call({ leadId: 'ok1', template: 'fu_reply_ack' });
  ok('flag on (positive control): files exactly one draft_text', on.r && on.r.status === 'filed' && inbox().length === 1 && DB.docs.get(inbox()[0]).kind === 'draft_text', JSON.stringify(on.r || (on.err && on.err.message)));
  ok('...and it is a draft for the owner, never a send', DB.docs.get(inbox()[0]).status === 'pending' && ![...DB.docs.keys()].some((k) => /^sms_log\//.test(k)));
  seed({ _default: { followUpBoard: true } });
  const est = await call({ leadId: 'ok1', template: 'est_follow_d3' });
  ok('followUpBoard does not unlock the estimate keys (they keep their own flag)', est.r && est.r.status === 'not_allowed');

  console.log('5. the DOM module in a sandbox');
  const SRC = read('docs/pro/js/follow-up-board.js');
  function boot(opts) {
    opts = opts || {};
    const handlers = {};
    const created = [];
    const body = { appendChild(n) { n.parentNode = body; }, removeChild(n) { n.parentNode = null; } };
    const btn = { id: 'followUpBoardBtn', hidden: true, getAttribute() { return null; } };
    btn.closest = () => btn;
    const badge = { id: 'followUpBoardBadge', hidden: true, textContent: '' };
    const document = {
      readyState: 'complete', body,
      getElementById: (id) => (id === 'followUpBoardBtn' ? btn : id === 'followUpBoardBadge' ? badge : null),
      createElement() { const n = { className: '', innerHTML: '', scrollTop: 0, setAttribute() {}, querySelector() { return null; } }; created.push(n); return n; },
      addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
      activeElement: null,
    };
    const calls = [], writes = [], stamps = [], snoozes = [], reads = [];
    const win = {
      document, _leads: opts.leads || [], _userClaims: opts.claims || {}, _user: { uid: 'u1' },
      NBDFlags: { enabled: (n) => !!opts.flag && n === 'followUpBoard', load: () => Promise.resolve() },
      NBDEstimateFollowups: Object.assign({}, EF, {
        callable: async (name, data) => { calls.push({ name, data }); return { ok: true, status: 'filed', message: 'Draft filed. Nothing was texted.' }; },
        stampNudge: async (id, via) => { stamps.push({ id, via }); return true; },
      }),
      NBDEstimateFollowBoard: { _pure: EB },
      NBDFollowUpLogic: F,
      LeadSnooze: { snooze: async (id, until, why) => { snoozes.push({ id, until, why }); } },
      db: {}, doc: (db, c, id) => ({ c, id }), serverTimestamp: () => 'SERVER_TS',
      updateDoc: async (ref, patch) => { writes.push({ ref, patch }); },
      getDocs: async () => { reads.push('agent_inbox'); return { docs: [] }; },
      query: (...a) => a, where: (...a) => a, collection: (...a) => a,
      addEventListener() {}, showToast() {},
    };
    win.window = win;
    const ctx = { window: win, document, setTimeout: () => 0, setInterval: () => 0, console, Date, Promise, Math, JSON, String, Object, Array, Number };
    vm.runInNewContext(SRC, ctx, { filename: 'follow-up-board.js' });
    const fire = (type, ev) => (handlers[type] || []).forEach((fn) => fn(ev));
    const target = (attrs) => { const t = { id: '', getAttribute: (n) => (attrs[n] === undefined ? null : attrs[n]) }; t.closest = () => t; return t; };
    return { win, created, btn, badge, calls, writes, stamps, snoozes, reads, overlay: () => created[0],
      clickBtn: () => fire('click', { target: btn, preventDefault() {} }),
      act: (a, id, extra) => fire('click', { target: target(Object.assign({ 'data-fub-act': a, 'data-fub-id': id }, extra || {})), preventDefault() {} }) };
  }
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    const leads = () => [waiting('ZZ_W', 5, { firstName: 'Wanda', lastName: 'Waits', jobValue: 7000 }), stale('ZZ_S', 6, { firstName: 'Sam', lastName: 'Stale' }), base('ZZ_P', { stage: 'inspected', firstName: 'Pat', lastName: 'Plain' })];
    {
      const e = boot({ flag: false, leads: leads() });
      e.win.NBDFollowUpBoard.sync();
      ok('flag off: button hidden, open() refuses', e.btn.hidden === true && (await e.win.NBDFollowUpBoard.open()) === false);
      e.clickBtn(); e.act('draft', 'ZZ_W', { 'data-fub-key': 'fu_reply_ack' }); e.act('replied', 'ZZ_W'); e.act('promisedpick', 'ZZ_P');
      await tick();
      ok('flag off: nothing rendered, no callable, no write, no read', e.created.length === 0 && e.calls.length === 0 && e.writes.length === 0 && e.reads.length === 0);
    }
    for (const role of ['viewer', 'member']) {
      const e = boot({ flag: true, claims: { role }, leads: leads() });
      e.win.NBDFollowUpBoard.sync(); e.clickBtn(); e.act('replied', 'ZZ_W');
      await tick();
      ok('flag on but ' + role + ': hidden, refuses, no write, no read', e.btn.hidden === true && e.created.length === 0 && e.writes.length === 0 && e.reads.length === 0);
    }
    {
      const e = boot({ flag: true, leads: leads() });
      e.win.NBDFollowUpBoard.sync();
      ok('flag on (positive control): button shows with a count of 2', e.btn.hidden === false && e.badge.textContent === '2');
      e.clickBtn();
      await until(() => e.created[0] && /fub-row/.test(e.overlay().innerHTML) && e.reads.length >= 1, 'board');
      const h = e.overlay().innerHTML;
      ok('waiting section is first, then new leads; both customers named', h.indexOf('Customers waiting on your reply') < h.indexOf('New leads nobody has touched') && /Wanda Waits/.test(h) && /Sam Stale/.test(h));
      ok('plain words: nothing sends from here', /Nothing sends from here/.test(h));
      ok('opening only reads the Agent inbox: no callable, no write', e.calls.length === 0 && e.writes.length === 0 && e.reads.join() === 'agent_inbox');

      e.act('draft', 'ZZ_W', { 'data-fub-key': 'fu_reply_ack' });
      await until(() => e.calls.length === 1, 'draft');
      ok('Draft sends exactly a lead id and a template key to fileLeadTextDraft', e.calls[0].name === 'fileLeadTextDraft' && Object.keys(e.calls[0].data).sort().join() === 'leadId,template' && e.calls[0].data.template === 'fu_reply_ack');
      await until(() => /Draft waiting in your Agent inbox/.test(e.overlay().innerHTML), 'waiting note');
      ok('filing a draft writes nothing to the lead', e.writes.length === 0 && e.stamps.length === 0);

      e.act('replied', 'ZZ_W');
      await until(() => e.writes.length === 1, 'replied write');
      ok('"I replied" writes only lastOutboundAt on that lead', e.writes[0].ref.id === 'ZZ_W' && Object.keys(e.writes[0].patch).join() === 'lastOutboundAt');
      await until(() => !/Wanda Waits/.test(e.overlay().innerHTML), 'row removed');
      ok('...and the row leaves the board', true);

      e.act('promisepanel');
      e.act('promisedpick', 'ZZ_P');
      await until(() => e.writes.length === 2, 'promise write');
      ok('"I promised an estimate" writes only estimatePromisedAt (ms) on that lead', e.writes[1].ref.id === 'ZZ_P' && Object.keys(e.writes[1].patch).join() === 'estimatePromisedAt' && e.writes[1].patch.estimatePromisedAt === NOW);
      e.act('snooze', 'ZZ_S');
      await until(() => e.snoozes.length === 1, 'snooze');
      ok('Snooze uses the existing LeadSnooze for 3 days', e.snoozes[0].id === 'ZZ_S' && e.snoozes[0].until.getTime() === NOW + 3 * DAY);
      ok('nothing in this module can send: no sms/email/message sink was called', e.calls.every((c) => c.name === 'fileLeadTextDraft'));
    }
  } finally { Date.now = realNow; }

  console.log('6. strict CSP and wiring');
  const code = strip(SRC), logic = strip(read('docs/pro/js/follow-up-board-logic.js')), css = read('docs/pro/css/follow-up-board.css');
  ok('no inline event handler in the new markup', !/\son[a-z]+\s*=\s*["']/i.test(code) && !/\son[a-z]+\s*=\s*["']/i.test(logic));
  ok('no inline script, eval or new Function', !/<script|\beval\(|new Function\(/.test(code + logic));
  ok('one delegated click listener on the document', /doc\.addEventListener\('click'/.test(code));
  ok('no network sink of its own (no fetch / XHR / sendBeacon / mailto / sms:)', !/\bfetch\(|XMLHttpRequest|sendBeacon|mailto:|sms:/.test(code + logic));
  ok('no cost / margin field is read', !/\b(cost|margin|contractor)\w*/i.test(code + logic));
  ok('every CRM string is escaped before it reaches innerHTML', /esc\(r\.name\)/.test(code) && /esc\(r\.lastAction\)/.test(code) && /esc\(r\.source\)/.test(code));
  ok('44px touch targets and an sr-only label in the css', /min-height: 44px/.test(css) && /\.fub-sr/.test(css));
  const dash = read('docs/pro/dashboard.html');
  const iBoard = dash.indexOf('<script defer src="js/estimate-follow-board.js'), iLogic = dash.indexOf('<script defer src="js/follow-up-board-logic.js'), iDom = dash.indexOf('<script defer src="js/follow-up-board.js');
  ok('dashboard loads estimate board, then the logic, then the screen, all deferred', iBoard > 0 && iLogic > iBoard && iDom > iLogic && /<script defer src="js\/follow-up-board\.js/.test(dash) && /<script defer src="js\/follow-up-board-logic\.js/.test(dash));
  ok('dashboard has the hidden toolbar button and the stylesheet', /id="followUpBoardBtn"[^>]*\bhidden\b/.test(dash) && /css\/follow-up-board\.css/.test(dash));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
