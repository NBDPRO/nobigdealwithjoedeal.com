/**
 * tests/r6-texting-trio-2026-10-07.test.js
 *
 * Review round 6, texting (nbd-content/review-r6-2026-10-07.md §8, §12, §13):
 *
 *   R6-3-3  an approved AI reply whose Twilio outcome is UNKNOWN (a socket
 *           reset after Twilio took it, a failed note write after it went)
 *           was marked failed; the panel reverted it to pending and the
 *           rep's re-approval texted the homeowner twice. Now: the send is
 *           claimed on the draft before Twilio is called, only a definite
 *           Twilio refusal is 'failed', an unknown outcome is looked up at
 *           Twilio (found → sent) or marked 'send_uncertain' — never re-sent
 *           by itself, never reverted by the panel.
 *   R6-3-5  a START to NBD's Twilio number cleared every company's STOP,
 *           including company A's "They replied STOP" told to A's owner's own
 *           phone. Now each STOP records the sender it was told to, and a
 *           START lifts only that number's own STOPs (and NBD's own
 *           owner-phone STOP — the number is NBD's). Anything it can't
 *           attribute is kept and flagged.
 *   R6-3-6  the no-customer check ('number') skipped texting hours. Now it
 *           applies 8am–9pm with the documented no-location rule (Eastern);
 *           only 'crew' (a sub) skips hours.
 *
 * Every case drives the REAL functions/ modules through
 * tests/lib/sms-compliance-world.js (fake Firestore + fake Twilio; nothing
 * leaves the process), and the panel is vm-loaded with a fake DOM.
 *
 * Run: node tests/r6-texting-trio-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const W = require('./lib/sms-compliance-world');

const ROOT = path.join(__dirname, '..');
const NBD = '1phDvAVXHSg82wDLegAbQFq14Ci1';
const NOON_ET = Date.parse('2026-10-05T16:00:00Z');
const LATE_ET = Date.parse('2026-10-06T03:30:00Z'); // 11:30pm EDT on 10-05
const EVE_ET = Date.parse('2026-10-06T00:30:00Z');  // 8:30pm EDT
const KEY = '8595550134';

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; fails.push(label); console.log('  ✗ ' + label + (detail ? '\n      ' + detail : '')); }
}

// ── R6-3-3 scaffolding ──────────────────────────────────────────────────
const DRAFT = 'leads/L1/ai_drafts/D1';
const BASE = { userId: NBD, companyId: NBD, customerPhone: '+18595550134', draftText: 'Thanks — see you Tuesday.' };
const LEAD = { userId: NBD, companyId: NBD, phone: '(859) 555-0134', state: 'KY', zip: '41011' };
function aiWorld(opts) {
  const w = W.makeWorld(Object.assign({ clockMs: NOON_ET, docs: { 'leads/L1': LEAD } }, opts || {}));
  w.store.set(DRAFT, Object.assign({ status: 'approved' }, BASE));
  const m = W.load(w, 'sms-functions.js');
  return { w, h: m.onAiDraftApproved.__handler };
}
function approveEvent(id) {
  return {
    id: id || 'evt-1',
    params: { leadId: 'L1', draftId: 'D1' },
    data: {
      before: { data: () => Object.assign({ status: 'pending' }, BASE) },
      after: { data: () => Object.assign({ status: 'approved' }, BASE) },
    },
  };
}
const draftOf = (w) => w.store.get(DRAFT) || {};
const reset = () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; return e; };

(async () => {
  console.log('R6-3-3 — an AI reply whose send outcome is unknown is never sent twice');
  {
    // Unknown outcome, Twilio has no such message → send_uncertain, no resend.
    const { w, h } = aiWorld({ twilioError: reset() });
    await h(approveEvent());
    const d = draftOf(w);
    ok('a reset socket (no Twilio answer) → status send_uncertain, NOT failed', d.status === 'send_uncertain' && d.failureReason === 'send_uncertain'
      && d.sendClaim && d.sendClaim.state === 'uncertain', JSON.stringify({ status: d.status, reason: d.failureReason, claim: d.sendClaim }));
    ok('…Twilio was asked whether it took the message (lookup by number + text)', w.events.includes('twilio-list'));
    w.opts.twilioError = null;
    await h(approveEvent()); // the same event delivered again
    ok('…a second delivery of the approval event sends nothing (1 Twilio call in all)', w.twilioCalls.length === 1, 'calls=' + w.twilioCalls.length);
    ok('…and the draft is still send_uncertain (not overwritten, not sent)', draftOf(w).status === 'send_uncertain');
  }
  {
    // Unknown outcome, but Twilio DID take it → reconciled as sent with its SID.
    const { w, h } = aiWorld({ twilioError: reset(), twilioAccepted: true });
    await h(approveEvent());
    const d = draftOf(w);
    ok('Twilio took it before the socket dropped → found by the lookup: status sent with Twilio\'s SID', d.status === 'sent' && d.twilioSid === 'SM-test-1'
      && d.sendReconciled === true && d.sendClaim && d.sendClaim.state === 'sent', JSON.stringify({ status: d.status, sid: d.twilioSid, claim: d.sendClaim }));
    const notes = [...w.store.entries()].filter(([k, v]) => k.startsWith('leads/L1/notes/') && v.direction === 'outgoing');
    ok('…the outgoing note is filed with that SID', notes.length === 1 && notes[0][1].twilioSid === 'SM-test-1');
    w.opts.twilioError = null;
    await h(approveEvent());
    ok('…a re-delivered event sends nothing more', w.twilioCalls.length === 1);
  }
  {
    // The lookup itself fails → still uncertain (a miss is not proof of no send).
    const le = new Error('twilio 503'); le.status = 503;
    const { w, h } = aiWorld({ twilioError: reset(), twilioAccepted: true, twilioListError: le });
    await h(approveEvent());
    ok('the Twilio lookup fails → send_uncertain (never assumed unsent)', draftOf(w).status === 'send_uncertain');
  }
  {
    // A 5xx from Twilio is NOT a definite refusal.
    const e5 = new Error('Service unavailable'); e5.status = 503;
    const { w, h } = aiWorld({ twilioError: e5 });
    await h(approveEvent());
    ok('a Twilio 503 → send_uncertain, not failed', draftOf(w).status === 'send_uncertain');
  }
  {
    // A definite refusal (HTTP 400) → failed; the rep may edit and retry, and the retry sends.
    const e4 = new Error("The 'To' number is not a valid phone number."); e4.status = 400; e4.code = 21211;
    const { w, h } = aiWorld({ twilioError: e4 });
    await h(approveEvent());
    const d = draftOf(w);
    ok('a definite Twilio refusal (HTTP 400) → failed / twilio_error, claim marked rejected', d.status === 'failed' && d.failureReason === 'twilio_error'
      && d.sendClaim && d.sendClaim.state === 'rejected', JSON.stringify({ status: d.status, claim: d.sendClaim }));
    ok('…and no lookup was needed', !w.events.includes('twilio-list'));
    // The rep's "edit and try again": failed → pending → approved.
    w.opts.twilioError = null;
    w.store.set(DRAFT, Object.assign({}, draftOf(w), { status: 'approved' }));
    await h(approveEvent('evt-2'));
    ok('…the rep\'s retry after a definite refusal DOES send (2 calls, status sent)', w.twilioCalls.length === 2 && draftOf(w).status === 'sent', 'calls=' + w.twilioCalls.length);
  }
  {
    // 21610 (Twilio's STOP list) stays a definite refusal that records the opt-out.
    const e = new Error('unsubscribed'); e.status = 400; e.code = 21610;
    const { w, h } = aiWorld({ twilioError: e });
    await h(approveEvent());
    ok('21610 → failed / opted_out and copied into the register', draftOf(w).status === 'failed' && draftOf(w).failureReason === 'opted_out' && w.store.has('sms_opt_outs/' + KEY));
  }
  {
    // A send already in flight (claim present) → the second trigger sends nothing.
    const { w, h } = aiWorld();
    w.store.set(DRAFT, Object.assign({ status: 'approved', sendClaim: { state: 'sending', at: 1, eventId: 'evt-0' } }, BASE));
    await h(approveEvent('evt-dup'));
    ok('a claim already "sending" (an in-flight or duplicate trigger) → no Twilio call, draft untouched', w.twilioCalls.length === 0 && draftOf(w).status === 'approved');
  }
  {
    // The send succeeds but the note write after it fails → still 'sent'.
    const { w, h } = aiWorld();
    const origCollection = w.db.collection;
    w.db.collection = (n) => {
      const c = origCollection(n);
      if (n !== 'leads') return c;
      const od = c.doc;
      c.doc = (id) => {
        const d = od(id);
        const oc = d.collection;
        d.collection = (s) => { const cc = oc(s); if (s === 'notes') cc.add = async () => { throw new Error('14 UNAVAILABLE'); }; return cc; };
        return d;
      };
      return c;
    };
    await h(approveEvent());
    const d = draftOf(w);
    ok('a note write that fails AFTER the send leaves the draft sent (with its SID) — never failed', d.status === 'sent' && d.twilioSid === 'SM-test-1', JSON.stringify({ status: d.status, reason: d.failureReason }));
  }
  {
    // A normal send: unchanged.
    const { w, h } = aiWorld();
    await h(approveEvent());
    ok('a normal approval sends once and marks sent', w.twilioCalls.length === 1 && draftOf(w).status === 'sent' && draftOf(w).sendClaim.state === 'sent');
  }

  // ── The panel (vm-loaded): send_uncertain is shown, never reverted ──────
  console.log('\nR6-3-3 — the AI drafts panel');
  async function runPanel(statusSeq, action) {
    const writes = [];
    const toasts = [];
    let clickHandler = null;
    let calls = 0;
    const statusEl = { textContent: '' };
    const mainBtn = {
      attrs: { 'data-aidp-action': action || 'approve' },
      textContent: '✅ Approve & Send',
      getAttribute(k) { return this.attrs[k]; },
      setAttribute(k, v) { this.attrs[k] = v; },
      style: {}, disabled: false,
    };
    const card = {
      getAttribute: (k) => ({ 'data-aidp-id': 'D1', 'data-aidp-original': 'Thanks', 'data-aidp-portal': '0' })[k],
      querySelector: (sel) => (sel === '.aidp-status' ? statusEl : sel === '.aidp-text' ? { value: 'Thanks' }
        : sel === '[data-aidp-action="approve"]' ? (mainBtn.attrs['data-aidp-action'] === 'approve' ? mainBtn : null) : null),
      querySelectorAll: () => [mainBtn],
      remove() { this.removed = true; },
    };
    mainBtn.closest = (sel) => (sel === '.aidp-card' ? card : null);
    const win = {
      location: { pathname: '/pro/customer.html' },
      __NBD_LOADED: {},
      _currentLead: { id: 'L1' },
      db: {},
      doc: (...a) => ({ path: a.slice(1).join('/') }),
      getDoc: async () => {
        const st = statusSeq[Math.min(calls, statusSeq.length - 1)];
        calls++;
        return { exists: () => true, data: () => ({ status: st, failureReason: st === 'failed' ? 'twilio_error' : undefined }) };
      },
      updateDoc: async (ref, patch) => { writes.push(patch); },
      serverTimestamp: () => 'ts',
      showToast: (m, t) => toasts.push([t, m]),
      addEventListener() {},
      dispatchEvent() {},
    };
    const doc = {
      readyState: 'complete',
      addEventListener: (type, fn) => { if (type === 'click') clickHandler = fn; },
      querySelector: () => null,
      getElementById: () => null,
    };
    const sb = { window: win, document: doc, console: { log() {}, warn() {}, error() {} },
      setTimeout: (fn) => { Promise.resolve().then(fn); return 0; }, CustomEvent: function () {}, Promise };
    win.window = win;
    vm.createContext(sb);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'docs/pro/js/customer-ai-drafts-panel.js'), 'utf8'), sb, { filename: 'customer-ai-drafts-panel.js' });
    win.getDocs = async () => ({ docs: [] });
    win.collection = () => ({}); win.query = () => ({}); win.where = () => ({}); win.orderBy = () => ({});
    clickHandler({ target: { closest: () => mainBtn }, preventDefault() {} });
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    return { writes, toasts, statusEl, mainBtn };
  }
  {
    const r = await runPanel(['pending', 'approved', 'send_uncertain']);
    ok('approve → server answers send_uncertain: the panel does NOT write status pending (no auto re-queue)',
      r.writes.length === 1 && r.writes[0].status === 'approved', JSON.stringify(r.writes));
    ok('…it tells the rep to check the thread before re-sending', /may already have reached the homeowner/.test(r.statusEl.textContent) && /check/i.test(r.statusEl.textContent), r.statusEl.textContent);
    ok('…and the card\'s button becomes "back to drafts" (re-queue), not Approve', r.mainBtn.attrs['data-aidp-action'] === 'requeue');
  }
  {
    const r = await runPanel(['pending', 'failed']);
    ok('a definite failure is still put back to pending for "edit and try again"', r.writes.length === 2 && r.writes[1].status === 'pending', JSON.stringify(r.writes));
  }
  {
    const r = await runPanel(['send_uncertain'], 'requeue');
    ok('"back to drafts" on an uncertain card writes pending ONLY on the rep\'s tap (and sends nothing itself)',
      r.writes.length === 1 && r.writes[0].status === 'pending' && Object.keys(r.writes[0]).length === 1, JSON.stringify(r.writes));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nR6-3-5 — a START to NBD\'s number lifts only that number\'s STOPs');
  const handle = async (mod, token, data) => {
    try { return await mod._test.handle({ auth: { uid: token.uid, token }, data }); } catch (e) { return { threw: e.code || e.message }; }
  };
  const startVia = async (w, body) => {
    const s = W.load(w, 'sms-functions.js');
    return W.invoke(s.incomingSMS.__handler, { body: { From: '+18595550134', Body: body || 'START', MessageSid: 'SM' + Math.random().toString(36).slice(2) }, headers: { 'x-twilio-signature': 'sig' } });
  };
  const tokA = { uid: 'ownerA', companyId: 'coA', role: 'company_admin' };
  const tokN = { uid: NBD, companyId: NBD, role: 'company_admin' };
  const leadA = { userId: 'ownerA', companyId: 'coA', phone: '8595550134', phoneDigits: KEY, state: 'KY' };
  const leadN = { userId: NBD, companyId: NBD, phone: '8595550134', phoneDigits: KEY, state: 'KY' };
  {
    const w = W.makeWorld({ clockMs: NOON_ET, docs: { 'leads/LA': leadA, 'leads/LN': leadN } });
    let m = W.load(w, 'phone-text-check.js');
    const rec = await handle(m, tokA, { action: 'stop', leadId: 'LA' });
    const entry = w.store.get('sms_dnc/coA__' + KEY) || {};
    ok('"They replied STOP" (company A) → A\'s own Do Not Text entry, marked owner_phone', rec && rec.ok === true && entry.source === 'stop_reply'
      && entry.stopLine === 'owner_phone' && entry.stopCompanyId === 'coA', JSON.stringify({ rec, entry }));
    ok('…not the global register, and not another company\'s list (it was told to A only)', !w.store.has('sms_opt_outs/' + KEY) && !w.store.has('sms_dnc/' + NBD + '__' + KEY));
    const before = await handle(m, tokA, { action: 'check', phone: KEY, leadId: 'LA' });
    ok('…A\'s check now refuses, as "they replied STOP" (opted_out)', before && before.ok === false && before.code === 'opted_out', JSON.stringify(before));
    const res = await startVia(w);
    ok('the homeowner texts START to NBD\'s number → welcome-back reply as before', /Welcome back/.test(String(res.body || '')));
    m = W.load(w, 'phone-text-check.js');
    const after = await handle(m, tokA, { action: 'check', phone: KEY, leadId: 'LA' });
    ok('…company A still may NOT text them (its STOP was told to A, not to NBD\'s number)', after && after.ok === false && after.code === 'opted_out', JSON.stringify(after));
    ok('…A\'s entry is flagged: a START reached NBD\'s number (startSeenAt / startSeenLine)', !!w.store.get('sms_dnc/coA__' + KEY).startSeenAt && w.store.get('sms_dnc/coA__' + KEY).startSeenLine === 'incomingSMS');
    const nbd = await handle(m, tokN, { action: 'check', phone: KEY, leadId: 'LN' });
    ok('…NBD (the number\'s owner, never told STOP) can text them', nbd && nbd.ok === true, JSON.stringify(nbd));
  }
  {
    // A STOP to the number itself is still lifted by a START to it (CTIA).
    const w = W.makeWorld({ clockMs: NOON_ET, docs: { 'leads/LA': leadA, 'leads/LN': leadN, ['sms_dnc/coM__' + KEY]: { companyId: 'coM', key: KEY, source: 'manual' } } });
    await startVia(w, 'STOP');
    ok('STOP to NBD\'s number → register + a twilio-marked copy on every holding company', w.store.has('sms_opt_outs/' + KEY)
      && (w.store.get('sms_dnc/coA__' + KEY) || {}).stopLine === 'twilio' && (w.store.get('sms_dnc/' + NBD + '__' + KEY) || {}).stopLine === 'twilio');
    await startVia(w, 'START');
    ok('…START to the same number lifts the register and those copies (CTIA: the same sender)', !w.store.has('sms_opt_outs/' + KEY)
      && !w.store.has('sms_dnc/coA__' + KEY) && !w.store.has('sms_dnc/' + NBD + '__' + KEY));
    ok('…a company\'s MANUAL entry stays', (w.store.get('sms_dnc/coM__' + KEY) || {}).source === 'manual');
  }
  {
    // A had a copy of a line STOP; then A's owner records a phone STOP → it becomes A's own.
    const w = W.makeWorld({ clockMs: NOON_ET, docs: { 'leads/LA': leadA } });
    await startVia(w, 'STOP');
    const m = W.load(w, 'phone-text-check.js');
    await handle(m, tokA, { action: 'stop', leadId: 'LA' });
    ok('a phone STOP on top of a line-STOP copy upgrades A\'s entry to owner_phone', (w.store.get('sms_dnc/coA__' + KEY) || {}).stopLine === 'owner_phone');
    await startVia(w, 'START');
    ok('…START lifts the line STOP (register) but A\'s phone STOP stays', !w.store.has('sms_opt_outs/' + KEY) && w.store.has('sms_dnc/coA__' + KEY));
  }
  {
    // NBD's own phone STOP: a START to NBD's own number is the same sender → lifted.
    const w = W.makeWorld({ clockMs: NOON_ET, docs: { 'leads/LN': leadN } });
    let m = W.load(w, 'phone-text-check.js');
    await handle(m, tokN, { action: 'stop', leadId: 'LN' });
    await startVia(w);
    m = W.load(w, 'phone-text-check.js');
    const r = await handle(m, tokN, { action: 'check', phone: KEY, leadId: 'LN' });
    ok('NBD\'s own "They replied STOP" IS lifted by a START to NBD\'s number (same sender)', !w.store.has('sms_dnc/' + NBD + '__' + KEY) && r && r.ok === true, JSON.stringify(r));
  }
  {
    // Records from before this fix (no stopLine).
    const legacy = {
      ['sms_opt_outs/' + KEY]: { phone: '8595550134', keyword: 'STOP', match: 'owner_reported', reportedBy: 'ownerA', reportedCompanyId: 'coA' },
      ['sms_dnc/coA__' + KEY]: { companyId: 'coA', key: KEY, source: 'stop_reply', note: 'They replied STOP (recorded from the CRM)' },
      ['sms_dnc/coB__' + KEY]: { companyId: 'coB', key: KEY, source: 'stop_reply' },
    };
    const w = W.makeWorld({ clockMs: NOON_ET, docs: Object.assign({ 'leads/LA': leadA }, legacy) });
    await startVia(w);
    ok('legacy owner-reported register doc → leaves the register (it was A\'s STOP, not the number\'s)…', !w.store.has('sms_opt_outs/' + KEY));
    ok('…and A stays held on its own list (owner_phone)', (w.store.get('sms_dnc/coA__' + KEY) || {}).stopLine === 'owner_phone');
    ok('…an unmarked copy on B that can\'t be attributed is KEPT and flagged, not guessed at', w.store.has('sms_dnc/coB__' + KEY) && !!w.store.get('sms_dnc/coB__' + KEY).startSeenAt);

    const w2 = W.makeWorld({ clockMs: NOON_ET, docs: { ['sms_opt_outs/' + KEY]: { phone: KEY, match: 'owner_reported' } } });
    await startVia(w2);
    ok('a legacy owner-reported register doc with no company → kept and flagged', w2.store.has('sms_opt_outs/' + KEY) && !!w2.store.get('sms_opt_outs/' + KEY).startSeenAt);

    const w3 = W.makeWorld({ clockMs: NOON_ET, docs: {
      ['sms_opt_outs/' + KEY]: { phone: '+18595550134', keyword: 'STOP' },
      ['sms_dnc/coA__' + KEY]: { companyId: 'coA', key: KEY, source: 'stop_reply' },
    } });
    await startVia(w3);
    ok('a legacy line STOP (unmarked copy, no owner report) is still lifted by START', !w3.store.has('sms_opt_outs/' + KEY) && !w3.store.has('sms_dnc/coA__' + KEY));
  }
  {
    // NBD's Twilio line webhook uses the same lifter with NBD as the number's company.
    const src = fs.readFileSync(path.join(ROOT, 'functions/twilio-line.js'), 'utf8').replace(/\/\/.*$/gm, '');
    ok('twilio-line.js START calls liftStopOnLine with lineCompanyId NBD_OWNER_UID (no blanket clear)',
      /OptOut\.liftStopOnLine\(db, from, \{[^}]*lineCompanyId: NBD_OWNER_UID/.test(src) && !/clearStopReplyDnc\(/.test(src) && !/OptOut\.clearOptOut\(/.test(src));
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\nR6-3-6 — the no-customer check applies texting hours');
  {
    const token = { uid: NBD, companyId: NBD, role: 'company_admin' };
    const mk = (clockMs) => { const w = W.makeWorld({ clockMs, docs: { 'leads/L1': LEAD } }); return W.load(w, 'phone-text-check.js'); };
    let m = mk(LATE_ET);
    const withLead = await handle(m, token, { action: 'check', phone: KEY, leadId: 'L1', recipient: 'homeowner' });
    const numberOnly = await handle(m, token, { action: 'check', phone: KEY, recipient: 'number' });
    const crew = await handle(m, token, { action: 'check', phone: KEY, recipient: 'crew' });
    ok('11:30pm Eastern: the lead path refuses (quiet_hours)', withLead && withLead.code === 'quiet_hours');
    ok('…and so does the no-customer path now (quiet_hours, Eastern by the no-location rule)', numberOnly && numberOnly.ok === false && numberOnly.code === 'quiet_hours'
      && /8am–9pm/.test(numberOnly.reason), JSON.stringify(numberOnly));
    ok('…a crew text (a sub, not a homeowner) still skips hours', crew && crew.ok === true, JSON.stringify(crew));
    m = mk(EVE_ET);
    const eve = await handle(m, token, { action: 'check', phone: KEY, recipient: 'number' });
    ok('8:30pm Eastern: the no-customer path is allowed (inside 8am–9pm Eastern)', eve && eve.ok === true, JSON.stringify(eve));
    m = mk(NOON_ET);
    const noon = await handle(m, token, { action: 'check', phone: KEY, recipient: 'number' });
    ok('noon: allowed, with the number to text', noon && noon.ok === true && noon.to === '+1' + KEY);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
