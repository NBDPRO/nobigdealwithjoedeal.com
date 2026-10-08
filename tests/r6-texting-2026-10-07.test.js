/**
 * tests/r6-texting-2026-10-07.test.js
 *
 * Review round 6, texting (Jo approved the fix 2026-10-07):
 *
 *   R6-3-1  "Not interested. Stop.", "No thanks stop", "Please stop. Not
 *           interested", "stop sending these", "I no longer want texts from
 *           you" were NOT opt-outs: incomingSMS recorded nothing and wrote an
 *           AI reply draft a rep could send in one tap. The FCC's revocation
 *           rule: consent is revoked by any reasonable means.
 *           Now a STOP-family word as its own clause / first word / last word
 *           after courtesy, or next to a refusal, is a stop; an ambiguous one
 *           ("thanks but stop") is 'possible_stop' — nothing recorded, but NO
 *           AI draft and a high-priority bell + flagged note for the rep.
 *           Negative controls: "can you stop by tomorrow", "I'll stop at the
 *           store" stay ordinary customer messages (AI draft still runs).
 *
 *   R6-3-2  Pre-filled customer texts that opened Messages with no STOP / Do
 *           Not Text / texting-hours check: Text Portal, the portal-link
 *           share, Text Booking Link, Care Plan "Text it", plus the kanban
 *           booking text (crm-portal-bridge.js). Each now waits for the
 *           server's "ok to text?" (NBDPhoneShare.checkText → phoneTextAction)
 *           and, on a no, shows the reason and opens nothing. A check that
 *           can't run blocks too. (The V2 estimate share box is covered in
 *           tests/close-flow-2026-10-03.test.js, section D.)
 *
 * Every check RUNS the real code: the functions modules are required, the
 * browser files are vm-loaded (or, for a handler inside a large ES module,
 * the handler's own source is cut out by brace matching and run).
 *
 * Run: node tests/r6-texting-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const W = require('./lib/sms-compliance-world');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
const tick = () => new Promise((r) => setImmediate(r));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
/** Run one section; a section that cannot even find its code is a FAILED check, not a crash. */
async function guard(name, fn) {
  try { await fn(); } catch (e) { ok(name + ': section ran', false, e && e.message); }
}

/** Cut `marker … { … }` (plus the rest of that statement, up to `;`, unless
 *  it is a function declaration) out of src. */
function cut(src, marker) {
  const decl = /^(async )?function /.test(marker);
  const at = src.indexOf(marker);
  if (at < 0) throw new Error('marker not found: ' + marker);
  let i = src.indexOf('{', at);
  let depth = 0;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  if (decl) return src.slice(at, i + 1);
  const semi = src.indexOf(';', i);
  return src.slice(at, semi + 1);
}

const STOPPED = { ok: false, code: 'opted_out', reason: 'This customer replied STOP — they asked not to be texted. Call or email instead.' };
const DNC = { ok: false, code: 'dnc', reason: 'This number is on your company\'s Do Not Text list. Call or email instead.' };
const LATE = { ok: false, code: 'quiet_hours', reason: 'It is 11:30 PM for this homeowner — texting hours are 8am–9pm their time.' };
function fakePS(answer, calls) {
  return { checkText: async (o) => { calls.push(['checkText', o]); return answer; } };
}

(async () => {
  // ═══ A. R6-3-1 — the classifier ════════════════════════════════════════
  console.log('A. R6-3-1 — classifyInbound: a STOP inside a longer reply');
  const S = require(path.join(W.FUNCTIONS, 'sms-stop-intent.js'));
  const cls = (m) => S.classifyInbound(m).intent;

  const NOW_STOPS = [
    'Not interested. Stop.', 'No thanks stop', 'Please stop. Not interested', 'stop sending these',
    'I no longer want texts from you', 'Stop wasting my time', 'STOP I am not interested', 'please just stop',
    'ok stop', 'Stop - wrong person', 'not interested, cancel', 'Hi. Stop. Thanks', 'I want you to stop',
    'no thank you, unsubscribe', 'Stop it',
  ];
  for (const m of NOW_STOPS) ok('R6-3-1 opt-out: ' + JSON.stringify(m), cls(m) === 'stop', 'got ' + cls(m));

  const POSSIBLE = ['thanks but stop', 'when will the crew stop', 'I want to cancel', 'I said stop already', 'Thursday is out. Cancel.'];
  for (const m of POSSIBLE) ok('R6-3-1 ambiguous → possible_stop (a person reads it): ' + JSON.stringify(m), cls(m) === 'possible_stop', 'got ' + cls(m));

  const NOT = [
    'can you stop by tomorrow', "I'll stop at the store", 'Can you stop by Tuesday?', 'Please stop by after 5',
    'I need you to stop by Friday', 'Cancel my Thursday appointment', 'I want to cancel the estimate',
    'end of the day works', 'The leak wont stop', 'stop the water damage first', 'we need a gravel stop replaced',
    'is there a stop sign near you', 'the rain should stop soon', 'Stop by whenever', 'Sounds good', 'yes',
  ];
  for (const m of NOT) ok('negative control, NOT an opt-out and NOT flagged: ' + JSON.stringify(m), cls(m) === null, 'got ' + cls(m));
  ok('possible_stop carries the word and match "ambiguous" (nothing to record)',
    S.classifyInbound('thanks but stop').keyword === 'STOP' && S.classifyInbound('thanks but stop').match === 'ambiguous');

  // ═══ B. R6-3-1 — the real incomingSMS ═════════════════════════════════
  console.log('\nB. R6-3-1 — incomingSMS: an in-message STOP opts out; an ambiguous one drafts nothing and is flagged');
  const FROM = '+18595550134';
  const KEY = '8595550134';
  const LEAD = { userId: 'rep-1', companyId: 'co-1', phone: '(859) 555-0134', phoneDigits: KEY, firstName: 'Sam' };
  async function inbound(body, docs) {
    const w = W.makeWorld({ docs: docs || { 'leads/lead-1': LEAD } });
    const mod = W.load(w, 'sms-functions.js');
    const res = await W.invoke(mod.incomingSMS.__handler, {
      headers: { 'x-twilio-signature': 'sig' },
      body: { From: FROM, Body: body, MessageSid: 'SM' + Math.random().toString(36).slice(2, 10) },
    });
    return { w, res };
  }
  const keys = (w, pre) => [...w.store.keys()].filter((k) => k.startsWith(pre));

  for (const m of ['Not interested. Stop.', 'No thanks stop', 'stop sending these', 'I no longer want texts from you']) {
    const { w, res } = await inbound(m);
    ok('R6-3-1: ' + JSON.stringify(m) + ' → opt-out recorded + unsubscribed TwiML', !!w.store.get('sms_opt_outs/' + KEY) && /unsubscribed/i.test(String(res.body || '')));
    ok('R6-3-1: ' + JSON.stringify(m) + ' → NO AI draft', w.aiDrafts.length === 0, 'drafts=' + w.aiDrafts.length);
  }

  {
    const { w } = await inbound('thanks but stop');
    const notes = keys(w, 'leads/lead-1/notes/').map((k) => w.store.get(k));
    const bells = keys(w, 'notifications/').map((k) => w.store.get(k));
    ok('R6-3-1: "thanks but stop" → NOT an opt-out (nothing recorded)', !w.store.has('sms_opt_outs/' + KEY) && !w.store.has('sms_dnc/co-1__' + KEY));
    ok('R6-3-1: …NO AI reply draft is written', w.aiDrafts.length === 0, 'drafts=' + w.aiDrafts.length);
    ok('R6-3-1: …the inbound note is filed and flagged possibleStop', notes.length === 1 && notes[0].possibleStop === true && notes[0].possibleStopKeyword === 'STOP', JSON.stringify(notes));
    const b = bells.find((x) => x && x.type === 'sms_possible_stop');
    ok('R6-3-1: …a high-priority "may be asking you to stop" bell for the lead\'s rep', !!b && b.userId === 'rep-1' && b.priority === 'high' && b.leadId === 'lead-1'
      && /may be asking you to stop/.test(b.title) && /No AI reply was drafted/.test(b.message), JSON.stringify(bells));
  }
  {
    const { w } = await inbound('thanks but stop', {});
    const rows = keys(w, 'unmatched_sms/').map((k) => w.store.get(k));
    ok('R6-3-1: unknown number + ambiguous STOP → the unmatched_sms row is flagged possibleStop', rows.length === 1 && rows[0].possibleStop === true, JSON.stringify(rows));
  }
  for (const m of ['can you stop by tomorrow', "I'll stop at the store"]) {
    const { w } = await inbound(m);
    ok('negative control: ' + JSON.stringify(m) + ' → no opt-out, AI draft step runs, no possible-STOP bell',
      !w.store.has('sms_opt_outs/' + KEY) && w.aiDrafts.length === 1 && !keys(w, 'notifications/').some((k) => (w.store.get(k) || {}).type === 'sms_possible_stop'),
      'drafts=' + w.aiDrafts.length);
  }

  // ═══ C. R6-3-2 — pre-filled text links ask "ok to text?" first ═════════
  console.log('\nC. R6-3-2 — every pre-filled customer text waits for the server check');

  // C1. Text Portal (customer-gallery-share.js quickSmsPortalLink), whole file in a vm.
  await guard("C1 Text Portal", async () => {
    const SRC = read('docs/pro/js/customer-gallery-share.js');
    const run = async (ps) => {
      const calls = [];
      const els = {};
      ['quickCopyPortalBtn', 'quickSmsPortalBtn', 'quickEmailPortalBtn', 'quickPreviewPortalBtn', 'fullPortalUrl', 'gallerySharePanel']
        .forEach((id) => { els[id] = { value: '', innerHTML: '', disabled: false, style: {}, focus() {}, select() {} }; });
      const ctx = {
        console: { warn() {}, log() {}, error() {} }, setTimeout, clearTimeout,
        document: { getElementById: (id) => els[id] || null, createElement: () => ({ style: {} }), body: { appendChild() {}, removeChild() {} }, execCommand: () => false },
        navigator: { clipboard: { writeText: async () => {} } },
        showToast: (m, t) => calls.push(['toast', m, t]),
      };
      ctx.window = ctx; ctx.location = { href: '' };
      ctx._customerId = 'lead-123';
      ctx._currentLead = { id: 'lead-123', firstName: 'Dana', phone: '5135550123' };
      ctx.PortalLinkHelpers = { resolveUrl: async () => 'https://x.test/pro/portal?token=TOK', recordShare: (id, via) => calls.push(['recorded', via]) };
      if (ps !== undefined) ctx.NBDPhoneShare = ps === null ? undefined : fakePS(ps, calls);
      vm.createContext(ctx);
      vm.runInContext(SRC, ctx);
      await ctx.quickSmsPortalLink();
      return { calls, href: ctx.location.href };
    };
    for (const [label, ans] of [['replied STOP', STOPPED], ['on the Do Not Text list', DNC], ['outside texting hours', LATE]]) {
      const r = await run(ans);
      ok('C1 Text Portal, customer ' + label + ' → Messages NOT opened, reason shown, no share recorded',
        !/^sms:/.test(r.href) && r.calls.some((c) => c[0] === 'toast' && c[1] === ans.reason && c[2] === 'error') && !r.calls.some((c) => c[0] === 'recorded'), JSON.stringify(r));
    }
    const nochk = await run(null);
    ok('C1 Text Portal, check unavailable → blocked with a message (never an unchecked hand-off)', !/^sms:/.test(nochk.href) && nochk.calls.some((c) => c[0] === 'toast' && /Couldn.t check/.test(c[1])));
    const yes = await run({ ok: true });
    ok('C1 Text Portal, ok → Messages opens with the portal link, check asked for THIS lead', /^sms:5135550123\?body=/.test(yes.href)
      && yes.calls.some((c) => c[0] === 'checkText' && c[1].leadId === 'lead-123') && yes.calls.some((c) => c[0] === 'recorded' && c[1] === 'sms'), yes.href);
  });

  // C2. Portal-link share (dashboard-api.js window._sharePortalLink), the function run on its own.
  await guard("C2 portal-link share", async () => {
    const fnSrc = cut(read('docs/pro/js/dashboard-api.js'), 'window._sharePortalLink = async function');
    const run = async (ps) => {
      const calls = [];
      const ctx = {
        console: { error() {}, warn() {} },
        navigator: { clipboard: { writeText: async (v) => calls.push(['copied', v]) } },
        showToast: (m, t) => calls.push(['toast', m, t]),
        location: { origin: 'https://x.test' },
      };
      ctx.window = ctx;
      ctx._leads = [{ id: 'L9', firstName: 'Ana', phone: '(513) 555-0199' }];
      ctx._mintPortalUrl = async () => 'https://x.test/pro/portal.html?token=T';
      ctx.open = (u) => calls.push(['open', u]);
      ctx.prompt = () => {};
      ctx.PortalLinkHelpers = { recordShare: (id, via) => calls.push(['recorded', via]) };
      if (ps !== undefined) ctx.NBDPhoneShare = ps === null ? undefined : fakePS(ps, calls);
      vm.createContext(ctx);
      vm.runInContext(fnSrc, ctx);
      await ctx._sharePortalLink('L9');
      return calls;
    };
    const blocked = await run(STOPPED);
    ok('C2 portal-link share, customer replied STOP → no sms: opened, reason shown, link still copied, recorded as copy',
      !blocked.some((c) => c[0] === 'open') && blocked.some((c) => c[0] === 'toast' && c[1].indexOf(STOPPED.reason) === 0 && c[2] === 'error')
      && blocked.some((c) => c[0] === 'copied') && blocked.some((c) => c[0] === 'recorded' && c[1] === 'copy'), JSON.stringify(blocked));
    const nochk = await run(null);
    ok('C2 portal-link share, check unavailable → blocked with a message', !nochk.some((c) => c[0] === 'open') && nochk.some((c) => c[0] === 'toast' && /Couldn.t check/.test(c[1])));
    const yes = await run({ ok: true });
    ok('C2 portal-link share, ok → Messages opens to that number, check asked for THIS lead',
      yes.some((c) => c[0] === 'open' && /^sms:5135550199\?body=/.test(c[1])) && yes.some((c) => c[0] === 'checkText' && c[1].leadId === 'L9') && yes.some((c) => c[0] === 'recorded' && c[1] === 'sms'));
  });

  // C3. Text Booking Link (customer-bootstrap.module.js) — the click handler's own source.
  await guard("C3 Text Booking Link", async () => {
    const handlerSrc = cut(read('docs/pro/js/customer-bootstrap.module.js'), "smsBooking.addEventListener('click', async (ev) => {");
    const run = async (ps) => {
      const calls = [];
      let listener = null;
      const smsBooking = {
        dataset: {},
        getAttribute: () => 'sms:8595550134?body=Hey%20Sam%2C%20pick%20a%20time',
        addEventListener: (t, fn) => { if (t === 'click') listener = fn; },
      };
      const win = { _customerId: 'lead-7', _currentLead: { id: 'lead-7', phone: '(859) 555-0134' }, location: { href: '' },
        showToast: (m, t) => calls.push(['toast', m, t]) };
      if (ps !== undefined) win.NBDPhoneShare = ps === null ? undefined : fakePS(ps, calls);
      const ctx = { window: win, smsBooking, lead: win._currentLead, id: 'lead-7',
        logCommunication: (lid, type, text) => calls.push(['logged', lid, type, text]) };
      vm.createContext(ctx);
      vm.runInContext(handlerSrc, ctx);
      let prevented = false;
      await listener({ preventDefault: () => { prevented = true; } });
      return { calls, href: win.location.href, prevented };
    };
    const blocked = await run(LATE);
    ok('C3 Text Booking Link, outside texting hours → tap held, Messages NOT opened, reason shown, nothing logged',
      blocked.prevented && blocked.href === '' && blocked.calls.some((c) => c[0] === 'toast' && c[1] === LATE.reason) && !blocked.calls.some((c) => c[0] === 'logged'), JSON.stringify(blocked));
    const dnc = await run(DNC);
    ok('C3 Text Booking Link, Do Not Text → blocked with the reason', dnc.href === '' && dnc.calls.some((c) => c[0] === 'toast' && c[1] === DNC.reason));
    const nochk = await run(null);
    ok('C3 Text Booking Link, check unavailable → blocked with a message', nochk.href === '' && nochk.calls.some((c) => c[0] === 'toast' && /Couldn.t check/.test(c[1])));
    const yes = await run({ ok: true });
    ok('C3 Text Booking Link, ok → Messages opens with the booking text, the send is logged, check for THIS lead',
      /^sms:8595550134\?body=/.test(yes.href) && yes.calls.some((c) => c[0] === 'logged' && c[1] === 'lead-7' && c[2] === 'sms')
      && yes.calls.some((c) => c[0] === 'checkText' && c[1].leadId === 'lead-7'), JSON.stringify(yes));
  });

  // C4. Care Plan "Text it" (care-plan-crm.js), whole IIFE in a vm.
  await guard("C4 Care Plan \"Text it\"", async () => {
    const SRC = read('docs/pro/js/care-plan-crm.js');
    const run = async (ps) => {
      const calls = [];
      const byId = {};
      let dlgClick = null;
      const mkEl = (tag) => ({
        tagName: String(tag).toUpperCase(), id: '', className: '', innerHTML: '', dataset: {}, style: {},
        addEventListener(t, fn) { if (tag === 'dialog' && t === 'click') dlgClick = fn; },
        setAttribute() {}, getAttribute() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; },
        showModal() {}, close() {}, appendChild(ch) { if (ch && ch.id) byId[ch.id] = ch; return ch; },
      });
      const document = { body: mkEl('body'), createElement: mkEl, getElementById: (id) => byId[id] || null, querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener() {} };
      const win = { document, location: { href: '' }, showToast: (m, t) => calls.push(['toast', m, t]) };
      win.window = win;
      if (ps !== undefined) win.NBDPhoneShare = ps === null ? undefined : fakePS(ps, calls);
      const ctx = { window: win, document, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, navigator: {}, Promise };
      vm.createContext(ctx);
      vm.runInContext(SRC, ctx);
      win.NBDCarePlan.openLinkDialog({ kind: 'invite', url: 'https://buy.stripe.test/x', name: 'Sam Lee', phone: '(859) 555-0134', email: '', leadId: 'lead-cp' });
      const dlg = byId.cpDialog;
      const btn = { getAttribute: (a) => (a === 'data-cp-dlg' ? 'text' : null) };
      dlgClick({ target: { closest: () => btn } });
      await settle();
      return { calls, href: win.location.href, html: dlg ? dlg.innerHTML : '' };
    };
    const blocked = await run(STOPPED);
    ok('C4 Care Plan "Text it" is a button, not a pre-filled sms: link', /data-cp-dlg="text"/.test(blocked.html) && !/href="sms:/.test(blocked.html), blocked.html.slice(0, 200));
    ok('C4 Care Plan "Text it", customer replied STOP → Messages NOT opened, reason shown',
      blocked.href === '' && blocked.calls.some((c) => c[0] === 'toast' && c[1] === STOPPED.reason && c[2] === 'error'), JSON.stringify(blocked.calls));
    const nochk = await run(null);
    ok('C4 Care Plan "Text it", check unavailable → blocked with a message', nochk.href === '' && nochk.calls.some((c) => c[0] === 'toast' && /Couldn.t check/.test(c[1])));
    const yes = await run({ ok: true });
    ok('C4 Care Plan "Text it", ok → Messages opens with the sign-up link, check for THIS lead',
      /^sms:8595550134\?&body=/.test(yes.href) && /buy\.stripe\.test/.test(decodeURIComponent(yes.href)),
      yes.href);
    ok('C4 …the check was asked for the lead the link is for', yes.calls.some((c) => c[0] === 'checkText' && c[1].leadId === 'lead-cp'));
  });

  // C5. Kanban "Text booking link" (crm-portal-bridge.js sendBookingSMS) — found while enumerating.
  await guard("C5 kanban booking text", async () => {
    const SRC = read('docs/pro/js/crm-portal-bridge.js');
    const fnSrc = cut(SRC, 'async function _okToTextFromPhone(') + '\n' + cut(SRC, 'window.sendBookingSMS = async function(');
    const run = async (ps) => {
      const calls = [];
      const ctx = { showToast: (m, t) => calls.push(['toast', m, t]), encodeURIComponent };
      ctx.window = ctx;
      ctx._repBookingUrl = () => 'https://cal.test/book';
      ctx._brand = () => ({ legalName: 'No Big Deal Home Solutions' });
      ctx.open = (u) => calls.push(['open', u]);
      if (ps !== undefined) ctx.NBDPhoneShare = ps === null ? undefined : fakePS(ps, calls);
      vm.createContext(ctx);
      vm.runInContext(fnSrc, ctx);
      await ctx.sendBookingSMS('L5', '(513) 555-0111', 'Kim');
      return calls;
    };
    const blocked = await run(DNC);
    ok('C5 kanban booking text, Do Not Text → no sms: opened, reason shown', !blocked.some((c) => c[0] === 'open') && blocked.some((c) => c[0] === 'toast' && c[1] === DNC.reason), JSON.stringify(blocked));
    const nochk = await run(null);
    ok('C5 kanban booking text, check unavailable → blocked with a message', !nochk.some((c) => c[0] === 'open') && nochk.some((c) => c[0] === 'toast' && /Couldn.t check/.test(c[1])));
    const yes = await run({ ok: true });
    ok('C5 kanban booking text, ok → Messages opens, check for THIS lead', yes.some((c) => c[0] === 'open' && /^sms:5135550111\?body=/.test(c[1])) && yes.some((c) => c[0] === 'checkText' && c[1].leadId === 'L5'));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
