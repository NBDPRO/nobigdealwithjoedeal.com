/**
 * tests/texting-r2-fixes-2026-10-06.test.js
 *
 * Review round 2, area 3 (texting compliance) — the FIXES Jo approved on
 * 2026-10-06 for the four bugs pinned as KNOWN BUG R2-3-1..4 in draft PR
 * #2243 (tests/review-r2-money-texting-2026-10-06.test.js, not edited here).
 * Each section below is that pin's repro, run against the fixed code, plus
 * the behaviour the fix adds:
 *
 *   R2-3-2  texts shared from the owner's phone ask the server first.
 *     A. phoneTextAction 'check' (functions/phone-text-check.js), the real
 *        handler in a fake world: STOP register (canonical AND legacy key),
 *        the company's Do Not Text list, consent === false, the company
 *        switch, texting hours in the homeowner's time, a read error (fail
 *        CLOSED), another company's lead, a viewer; a tenant with no texting
 *        registration may still text from its own phone.
 *     B. NBDPhoneShare.share (docs/pro/js/phone-share.js) in a vm: a "no"
 *        or an error opens NOTHING; a "yes" opens Messages and, once the
 *        owner confirms, logs the send ('sent' → one sms_log row with
 *        leadId + uid + date — the Comm Log contract); a crew text checks
 *        the sub's number only and is not logged on the customer.
 *     C. every phone-share caller names who the text is about, and the
 *        "Tomorrow's installs" 💬 Text is no longer a bare sms: link.
 *     D. nbd-comms.js's Messages fallback asks the same check: a "no" or an
 *        error never builds an sms: link.
 *   R2-3-4  E. the 5-a-day per-recipient 429 (code recipient_daily_cap) is a
 *        refusal ("Daily limit reached for this customer"), not a hand-off;
 *        the per-rep 429 still hands off; the server tags only that 429.
 *   R2-3-1  F. bot text drafts: the honest STOP line; agentDraftAction 'sent'
 *        re-checks the EDITED text (company name, STOP line, claim wording)
 *        and the customer (Do Not Text / quiet hours) and refuses BEFORE
 *        marking or logging anything; the inbox opens sms: only after the
 *        server said ok; "They replied STOP" ('stop') records the opt-out
 *        exactly like an inbound STOP (register + Do Not Text lists) and
 *        refuses a number that is not the customer's.
 *   R2-3-3  G. onAiDraftApproved sends only on pending → approved (the pin's
 *        stub repro: pending then a stale sent → approved = ONE text); the
 *        panel re-reads the status before approving. The rules half is in
 *        tests/firestore-rules.test.js section 57 (emulator).
 *
 * Source checks strip comments first and assert their anchor was FOUND
 * (rule-grep-guards-must-strip-comments). Section S proves the helpers can
 * fail.
 *
 * Needs functions/node_modules (like tests/sms-dnc-2026-10-05.test.js):
 *   node tests/texting-r2-fixes-2026-10-06.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const W = require('./lib/sms-compliance-world');

const ROOT = path.resolve(__dirname, '..');
const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0;
const fails = [];
function ok(msg, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + msg); }
  else { failed++; fails.push(msg); console.log('  ✗ ' + msg + (detail ? '\n      ' + detail : '')); }
}

// Line-oriented comment stripper (the #2243 helper).
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const line of String(src).split(/\r?\n/)) {
    let s = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const e = line.indexOf('*/', i);
        if (e === -1) { i = line.length; break; }
        i = e + 2; inBlock = false; continue;
      }
      let sl = line.indexOf('//', i);
      while (sl > 0 && line[sl - 1] === ':') sl = line.indexOf('//', sl + 2);
      const bl = line.indexOf('/*', i);
      if (sl !== -1 && (bl === -1 || sl < bl)) { s += line.slice(i, sl); i = line.length; break; }
      if (bl !== -1) { s += line.slice(i, bl); i = bl + 2; inBlock = true; continue; }
      s += line.slice(i); i = line.length;
    }
    out.push(s);
  }
  return out.join('\n');
}
function braceBlock(src, from) {
  const open = src.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return null;
}
function blockAt(src, needle) {
  const at = src.indexOf(needle);
  return at === -1 ? null : braceBlock(src, at + needle.length - 1);
}

const PHONE = '(859) 555-0134';
const KEY = '8595550134';
// 2026-10-05 16:00Z = noon Eastern (inside texting hours); 03:00Z = 11pm Eastern.
const NOON = Date.parse('2026-10-05T16:00:00Z');
const NIGHT = Date.parse('2026-10-06T03:00:00Z');
const LEAD = { userId: 'rep-1', companyId: 'co-1', phone: PHONE, firstName: 'Sam', address: '12 Main St, Covington, KY 41011' };
const REP = { uid: 'rep-1', companyId: 'co-1', role: 'sales_rep' };

async function callPhone(token, data, docs, wopts) {
  const w = W.makeWorld(Object.assign({ docs: docs || {} }, wopts || {}));
  let mod;
  try { mod = W.load(w, 'phone-text-check.js'); } catch (e) { return { w, err: e }; }
  try { return { w, out: await mod.phoneTextAction.__handler({ auth: token ? { uid: token.uid, token } : null, data }) }; }
  catch (e) { return { w, err: e }; }
}

(async () => {
  // ═══ A. phoneTextAction 'check' ═════════════════════════════════════════
  console.log('\nA. R2-3-2 server: "ok to text this customer from my phone?"');
  {
    const base = { 'leads/lead-1': LEAD };
    const chk = (extra, wopts, data) => callPhone(REP, Object.assign({ action: 'check', leadId: 'lead-1', phone: PHONE }, data || {}), Object.assign({}, base, extra || {}), wopts);
    let r = await chk();
    ok('a textable customer: ok, to the canonical number (a company with no texting registration may still text from its own phone)',
      r.out && r.out.ok === true && r.out.to === '+1' + KEY, JSON.stringify(r.out || (r.err && r.err.message)));
    ok('…and the business-line flag is reported, off (TWILIO_INBOUND_ENABLED unset — nothing enabled)', r.out && r.out.businessLine === false);
    r = await chk({ ['sms_opt_outs/' + KEY]: { phone: '+1' + KEY } });
    ok('STOP register (canonical key) → refused opted_out', r.out && r.out.ok === false && r.out.code === 'opted_out' && /replied STOP/.test(r.out.reason));
    r = await chk({ ['sms_opt_outs/1' + KEY]: { phone: '+1' + KEY } });
    ok('STOP register (legacy 11-digit key) → refused opted_out', r.out && r.out.ok === false && r.out.code === 'opted_out');
    r = await chk({ ['sms_dnc/co-1__' + KEY]: { companyId: 'co-1', key: KEY, source: 'manual' } });
    ok('the company\'s Do Not Text list → refused dnc', r.out && r.out.ok === false && r.out.code === 'dnc');
    r = await chk({ ['sms_dnc/co-2__' + KEY]: { companyId: 'co-2', key: KEY, source: 'manual' } });
    ok('another company\'s Do Not Text list does not apply', r.out && r.out.ok === true);
    r = await chk({ 'leads/lead-1': Object.assign({}, LEAD, { tcpaConsent: false }) });
    ok('the customer said NO on their consent form → refused declined', r.out && r.out.ok === false && r.out.code === 'declined');
    r = await chk({ 'sms_settings/co-1': { enabled: false } });
    ok('the company switched texting off → refused switched_off', r.out && r.out.ok === false && r.out.code === 'switched_off');
    r = await chk({}, { clockMs: NIGHT });
    ok('11pm in the homeowner\'s time → refused quiet_hours with the hours', r.out && r.out.ok === false && r.out.code === 'quiet_hours' && /texting hours/.test(r.out.reason), JSON.stringify(r.out));
    r = await chk({}, { readThrows: (p) => p.indexOf('sms_opt_outs/') === 0 });
    ok('the register cannot be read → refused unverified (fail CLOSED, "call instead")', r.out && r.out.ok === false && r.out.code === 'unverified' && /Call them instead/.test(r.out.reason));
    r = await chk({}, { readThrows: (p) => p.indexOf('sms_settings/') === 0 });
    ok('the switch cannot be read → refused unverified', r.out && r.out.ok === false && r.out.code === 'unverified');
    r = await chk({}, { readThrows: (p) => p.indexOf('leads/') === 0 });
    ok('the lead cannot be read → refused unverified', r.out && r.out.ok === false && r.out.code === 'unverified');
    r = await chk({ 'leads/lead-1': Object.assign({}, LEAD, { companyId: 'co-2', userId: 'x' }) });
    ok('another company\'s lead → refused, and no register read was made for it', r.out && r.out.ok === false && r.out.code === 'no_lead'
      && !r.w.events.some((e) => /sms_opt_outs|sms_dnc/.test(e)));
    r = await chk({}, null, { leadId: undefined });
    ok('a homeowner text with no lead → refused (no answer without the customer)', r.out && r.out.ok === false);
    r = await callPhone({ uid: 'v-1', companyId: 'co-1', role: 'viewer' }, { action: 'check', leadId: 'lead-1', phone: PHONE }, base);
    ok('a viewer is refused before any read', r.err && r.err.code === 'permission-denied' && !r.w.events.some((e) => /^get:/.test(e)));
    r = await callPhone(null, { action: 'check', leadId: 'lead-1', phone: PHONE }, base);
    ok('signed out → unauthenticated', r.err && r.err.code === 'unauthenticated');
    r = await callPhone(REP, { action: 'check', recipient: 'crew', phone: '(513) 555-0199' }, { 'sms_opt_outs/5135550199': { phone: 'x' } }, { clockMs: NIGHT });
    ok('a crew text (no lead) still checks the sub\'s number against the register', r.out && r.out.ok === false && r.out.code === 'opted_out');
    r = await callPhone(REP, { action: 'check', recipient: 'crew', phone: '(513) 555-0199' }, {}, { clockMs: NIGHT });
    ok('…but not homeowner hours (a sub is not a homeowner)', r.out && r.out.ok === true);
    let mod = null;
    try { mod = W.load(W.makeWorld({}), 'phone-text-check.js'); } catch (_) { mod = null; }
    ok('the callable enforces App Check, 256MiB', !!mod && mod.phoneTextAction.__opts.enforceAppCheck === true && mod.phoneTextAction.__opts.memory === '256MiB');
    const idx = stripComments(rd('functions/index.js'));
    ok('exported from functions/index.js', /exports\.phoneTextAction = require\('\.\/phone-text-check'\)\.phoneTextAction/.test(idx));
  }

  // ═══ B. NBDPhoneShare.share ═════════════════════════════════════════════
  console.log('\nB. R2-3-2 client: NBDPhoneShare asks before Messages opens');
  function loadShare(opts) {
    const o = opts || {};
    const opened = [], calls = [], toasts = [];
    const win = {
      navigator: o.nav || {},
      location: { assign: (h) => opened.push(h) },
      nbdConfirm: async () => o.confirm !== false,
      showToast: (m, t) => toasts.push({ m, t }),
      _functions: {},
      _httpsCallable: (fns, name) => async (data) => {
        calls.push({ name, data });
        if (o.throws) throw new Error('network');
        return { data: data.action === 'check' ? (o.check || { ok: true, to: '+1' + KEY }) : { ok: true } };
      },
    };
    const sb = { window: win, module: { exports: {} }, console, Date, Object, String, Promise };
    vm.createContext(sb);
    vm.runInContext(rd('docs/pro/js/phone-share.js').replace("typeof window !== 'undefined' ? window : null", 'window'), sb);
    return { api: sb.module.exports, opened, calls, toasts };
  }
  const flush = () => new Promise((r) => setImmediate(r));
  {
    const h = loadShare({ check: { ok: false, code: 'opted_out', reason: 'This customer replied STOP — they asked not to be texted.' } });
    const r = await h.api.share({ text: 'Hi Sam', url: 'https://x/deal/T', phone: PHONE, leadId: 'lead-1' });
    ok('a STOP\'d customer: nothing opens, the owner is told why', r.shared === false && r.blocked === true && r.code === 'opted_out' && h.opened.length === 0
      && h.toasts.some((t) => t.t === 'error' && /replied STOP/.test(t.m)));
    ok('…the check named the lead and the number', h.calls[0] && h.calls[0].name === 'phoneTextAction' && h.calls[0].data.action === 'check'
      && h.calls[0].data.leadId === 'lead-1' && h.calls[0].data.phone === PHONE);
  }
  {
    const h = loadShare({ nav: { share: async () => { throw new Error('should not be called'); } }, throws: true });
    const r = await h.api.share({ text: 'Hi', phone: PHONE, leadId: 'lead-1' });
    ok('the check errors → fail CLOSED: no share sheet, no Messages, "call them instead"', r.shared === false && r.blocked && r.code === 'unverified'
      && h.opened.length === 0 && h.toasts.some((t) => /Call them instead/.test(t.m)));
  }
  {
    let sheet = 0;
    const h = loadShare({ nav: { share: async () => { sheet++; } }, check: { ok: false, code: 'quiet_hours', reason: 'Not sent: it is outside texting hours' } });
    await h.api.share({ text: 'Hi', phone: PHONE, leadId: 'lead-1' });
    ok('a "no" also keeps the share sheet shut (it offers Messages)', sheet === 0);
  }
  {
    const h = loadShare({});
    const r = await h.api.share({ text: 'Hi', phone: PHONE });
    ok('a homeowner text that forgot its lead is blocked, not sent unchecked', r.shared === false && r.blocked && h.opened.length === 0 && h.calls.length === 0);
  }
  {
    const h = loadShare({ confirm: true });
    const r = await h.api.share({ text: 'Hi Sam', phone: PHONE, leadId: 'lead-1', source: 'estimate_followup' });
    await flush();
    const sent = h.calls.find((c) => c.data.action === 'sent');
    ok('ok → Messages opens with the text, and the confirmed send is logged (leadId, number, body, source)',
      r.shared === true && h.opened.length === 1 && /^sms:8595550134\?&body=Hi%20Sam$/.test(h.opened[0])
        && !!sent && sent.data.leadId === 'lead-1' && sent.data.body === 'Hi Sam' && sent.data.source === 'estimate_followup', JSON.stringify(h.calls));
  }
  {
    const h = loadShare({ confirm: false });
    await h.api.share({ text: 'Hi', phone: PHONE, leadId: 'lead-1' });
    await flush();
    ok('the owner says it did NOT go out → nothing is logged', !h.calls.some((c) => c.data.action === 'sent'));
  }
  {
    const h = loadShare({ confirm: true });
    await h.api.share({ text: 'Job sheet', phone: '(513) 555-0199', recipient: 'crew' });
    await flush();
    ok('a crew text: checked as crew (no lead), not logged on a customer', h.calls[0] && h.calls[0].data.recipient === 'crew' && !h.calls[0].data.leadId
      && !h.calls.some((c) => c.data.action === 'sent') && h.opened.length === 1);
  }
  {
    const h = loadShare({});
    if (typeof h.api.precheck === 'function') h.api.precheck({ phone: PHONE, leadId: 'lead-1' });
    await flush();
    await h.api.share({ text: 'Hi', phone: PHONE, leadId: 'lead-1' });
    ok('precheck + share ask the server ONCE (a yes is reused, so the share sheet keeps the tap)', h.calls.filter((c) => c.data.action === 'check').length === 1);
  }
  {
    const h = loadShare({ check: { ok: false, code: 'dnc', reason: 'Do Not Text' } });
    if (typeof h.api.checkText === 'function') await h.api.checkText({ phone: PHONE, leadId: 'lead-1' });
    if (typeof h.api.checkText === 'function') await h.api.checkText({ phone: PHONE, leadId: 'lead-1' });
    ok('a NO is not cached — asked again next time', h.calls.filter((c) => c.data.action === 'check').length === 2);
  }
  {
    const h = loadShare({});
    const r = await h.api.share({ text: 'Hi', email: 'sam@example.test', subject: 's' });
    ok('an email-only share has nothing to text and asks nothing', h.calls.length === 0 && /^mailto:/.test(h.opened[0] || '') && r.shared === true);
  }
  {
    const h = loadShare({});
    const r = typeof h.api.reportStop === 'function' ? await h.api.reportStop({ leadId: 'lead-1', logId: 'log-9' }) : {};
    ok('reportStop → phoneTextAction stop with the lead and the log row', r.ok === true && !!h.calls[0] && h.calls[0].data.action === 'stop' && h.calls[0].data.leadId === 'lead-1' && h.calls[0].data.logId === 'log-9');
  }

  // ═══ C. the callers ════════════════════════════════════════════════════
  console.log('\nC. R2-3-2: every phone-share caller names who the text is about');
  {
    const cb = stripComments(rd('docs/pro/js/close-board.js'));
    const shareFn = blockAt(cb, 'async function _shareDealFromPhone(dealId, deal, msg, shareUrl) {');
    ok('deal links (close-board): the share names the deal\'s lead (or the number alone for a deal with no card)',
      !!shareFn && /_dealTextWho\(deal\)/.test(shareFn) && /deal && deal\.leadId \? \{ leadId: deal\.leadId \} : \{ recipient: 'number' \}/.test(cb));
    const ef = stripComments(rd('docs/pro/js/estimate-followups.js'));
    const efShare = blockAt(ef, 'async function shareFor(leadId, text, opts) {');
    ok('estimate follow-ups pass leadId', !!efShare && /NBDPhoneShare\.share\(Object\.assign\(\{[\s\S]{0,200}leadId, source: 'estimate_followup'/.test(efShare));
    const cd = stripComments(rd('docs/pro/js/customer-documents.js'));
    const cdShare = blockAt(cd, 'async function _shareReview(docId, pend, btn) {');
    ok('document links (send for review) pass leadId', !!cdShare && /leadId: lead\.id \|\| window\._customerId/.test(cdShare));
    const pr = stripComments(rd('docs/pro/js/production.js'));
    const sheet = blockAt(pr, 'async function sendJobSheet(lead, orders) {');
    ok('crew job sheet: recipient crew', !!sheet && /recipient: 'crew'/.test(sheet));
    ok('tomorrow\'s installs: Share and 💬 Text both go through NBDPhoneShare with the lead', /act === 'tom-share' \|\| act === 'tom-text'/.test(pr)
      && /leadId: row\.id, source: 'install_reminder', preferSms: act === 'tom-text'/.test(pr));
    ok('…and no bare sms: link is rendered for a homeowner reminder any more', !/href="' \+ esc\(window\.NBDPhoneShare \? window\.NBDPhoneShare\.smsHref/.test(pr)
      && /data-pr-action="tom-text"/.test(pr));
    for (const page of ['docs/pro/customer.html', 'docs/pro/dashboard.html']) {
      const html = rd(page);
      const at = (re) => { const m = html.match(re); return m ? m.index : -1; };
      ok(page + ' loads phone-share.js (the check lives there) and nbd-comms.js',
        at(/<script defer src="js\/phone-share\.js\?v=\d+"><\/script>/) !== -1 && at(/<script defer src="js\/nbd-comms\.js\?v=\d+"><\/script>/) !== -1);
    }
  }

  // ═══ D + E. nbd-comms.js ════════════════════════════════════════════════
  console.log('\nD/E. R2-3-2 + R2-3-4: the Messages fallback in nbd-comms.js');
  function loadComms(respond, phoneCheck, noShare) {
    const toasts = [], opened = [], checks = [];
    const window = {
      _user: { getIdToken: async () => 'id-token' },
      showToast: (msg, type) => toasts.push({ msg, type }),
      dispatchEvent: () => {},
      location: { get href() { return 'https://nobigdealwithjoedeal.com/pro/dashboard.html'; }, set href(v) { opened.push(v); } },
    };
    if (!noShare) window.NBDPhoneShare = { checkText: async (o) => { checks.push(o); return phoneCheck ? phoneCheck(o) : { ok: true }; } };
    const document = {
      createElement: () => { const a = { style: {}, remove() {} }; a.click = () => opened.push(a.href); return a; },
      body: { appendChild() {} }, addEventListener() {},
    };
    const sandbox = {
      window, document, console, location: { hostname: 'nobigdealwithjoedeal.com' },
      fetch: async () => respond(), AbortController, setTimeout, clearTimeout,
      CustomEvent: function (type, init) { this.type = type; this.detail = init && init.detail; },
    };
    vm.createContext(sandbox);
    vm.runInContext(rd('docs/pro/js/nbd-comms.js'), sandbox, { filename: 'nbd-comms.js' });
    return { NBDComms: window.NBDComms, toasts, opened, checks };
  }
  const jsonRes = (status, body) => () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const sms = async (respond, phoneCheck, args, noShare) => {
    const h = loadComms(respond, phoneCheck, noShare);
    const result = await h.NBDComms.sendSMS(Object.assign({ to: PHONE, message: 'Hi Sam', leadId: 'lead-1' }, args || {}));
    return Object.assign(h, { result, smsLinks: h.opened.filter((u) => /^sms:/.test(String(u))) });
  };
  {
    let h = await sms(jsonRes(402, { error: 'An active paid subscription is required.' }), () => ({ ok: false, code: 'opted_out', reason: 'This customer replied STOP.' }));
    ok('402 hand-off: the server check says STOP → no sms: link, the reason shown', h.smsLinks.length === 0 && h.result.success === false && h.result.error === 'opted_out'
      && h.toasts.some((t) => t.type === 'error' && /replied STOP/.test(t.msg)));
    ok('…the check was asked with the lead', h.checks[0] && h.checks[0].leadId === 'lead-1' && h.checks[0].phone === PHONE);
    h = await sms(() => { throw new TypeError('Failed to fetch'); }, () => ({ ok: false, code: 'unverified', reason: 'Couldn\'t check — call them instead.' }));
    ok('offline (no outbox) hand-off: the check could not run → no sms: link', h.smsLinks.length === 0 && h.result.success === false && h.result.error === 'unverified');
    h = await sms(jsonRes(502, { code: 'provider_error', error: 'x' }), null, null, true);
    ok('the check is missing from the page → fail CLOSED (no sms: link)', h.smsLinks.length === 0 && h.result.success === false);
    h = await sms(jsonRes(402, { error: 'x' }), null, { forceHandoff: true });
    ok('forceHandoff is checked too, and opens Messages only after a yes', h.checks.length === 1 && h.smsLinks.length === 1);
    h = await sms(jsonRes(402, { error: 'x' }), null, { leadId: undefined, knockId: 'k1' });
    ok('a text with no lead (door knock) is checked by number', h.checks[0] && h.checks[0].recipient === 'number' && !h.checks[0].leadId);
  }
  {
    let h = await sms(jsonRes(429, { error: 'This recipient has received the maximum SMS for today. Try tomorrow or contact them directly.', code: 'recipient_daily_cap' }));
    ok('R2-3-4: the per-recipient 5/day cap is a refusal — no Messages hand-off', h.smsLinks.length === 0 && h.result.success === false && h.result.error === 'recipient_daily_cap');
    ok('…"Daily limit reached for this customer"', h.toasts.some((t) => t.type === 'error' && /Daily limit reached for this customer/.test(t.msg)) && !h.toasts.some((t) => /opening Messages/.test(t.msg)));
    ok('…and the phone check is not even asked', h.checks.length === 0);
    h = await sms(jsonRes(429, { error: 'Daily SMS limit exceeded' }));
    ok('the per-REP daily budget 429 (no code) still hands off, after the check', h.smsLinks.length === 1 && h.checks.length === 1);
    const smsf = stripComments(rd('functions/sms-functions.js'));
    const capSites = smsf.split("enforceRateLimit('sendSMS:to'").length - 1;
    const tagged = (smsf.match(/code: 'recipient_daily_cap'/g) || []).length;
    ok('server: both per-recipient caps (sendSMS + sendD2DSMS) answer code recipient_daily_cap', capSites === 2 && tagged === 2, capSites + ' caps, ' + tagged + ' tagged');
    const perUid = blockAt(smsf, "await enforceRateLimit('sendSMS:uid', decoded.uid, 100, 86_400_000);");
    ok('…and the per-rep cap does not', perUid === null || !/recipient_daily_cap/.test(smsf.slice(smsf.indexOf("'sendSMS:uid'"), smsf.indexOf("'sendSMS:uid'") + 300)));
  }

  // ═══ F. bot drafts ═════════════════════════════════════════════════════
  console.log('\nF. R2-3-1: bot text drafts');
  {
    const L = require(path.join(W.FUNCTIONS, 'agent-mcp-logic.js'));
    // On a tree without the fix the validator is absent: every check below fails, none crashes.
    if (typeof L.editedTextProblem !== 'function') L.editedTextProblem = () => 'MISSING editedTextProblem';
    const d = L.buildTextDraft({ body: 'Hi Sam, Joe from No Big Deal — your estimate is ready.', reason: 'follow-up' }, ['No Big Deal']);
    ok('the STOP line on a phone-sent draft is honest: "Reply STOP and we\'ll stop texting."', /\nReply STOP and we'll stop texting\.$/.test(d.body) && !/to opt out/.test(d.body), d.body);
    ok('editedTextProblem: ok text passes', L.editedTextProblem(d.body, ['No Big Deal']) === null);
    ok('…STOP line removed → refused', /STOP line/.test(L.editedTextProblem('Hi Sam, Joe from No Big Deal.', ['No Big Deal']) || ''));
    ok('…company name removed → refused', /company name/.test(L.editedTextProblem('Hi Sam. Reply STOP and we\'ll stop texting.', ['No Big Deal']) || ''));
    ok('…claim wording added → refused', /Kentucky rule/.test(L.editedTextProblem('No Big Deal here — we will handle your insurance claim. Reply STOP and we\'ll stop texting.', ['No Big Deal']) || ''));

    const OWNER = { uid: 'own-1', companyId: 'own-1' };
    const GOOD = 'Hi Sam, Joe from No Big Deal — Thursday works? Reply STOP and we\'ll stop texting.';
    const docs = (extra) => Object.assign({
      'companyProfile/own-1': { brand: { name: 'No Big Deal' } },
      'leads/lead-1': Object.assign({}, LEAD, { companyId: 'own-1', userId: 'own-1' }),
      'agent_inbox/d1': { companyId: 'own-1', kind: 'draft_text', status: 'pending', leadId: 'lead-1', text: GOOD, bot: 'Marcus' },
    }, extra || {});
    async function sent(body, extra, wopts) {
      const w = W.makeWorld(Object.assign({ docs: docs(extra) }, wopts || {}));
      const mod = W.load(w, 'agent-mcp.js');
      try { return { w, out: await mod.agentDraftAction.__handler({ auth: { uid: OWNER.uid, token: OWNER }, data: { action: 'sent', id: 'd1', body } }) }; }
      catch (e) { return { w, err: e }; }
    }
    const untouched = (w) => w.store.get('agent_inbox/d1').status === 'pending' && ![...w.store.keys()].some((k) => /^sms_log\//.test(k));
    let r = await sent('Hi Sam, Joe from No Big Deal — Thursday works?');
    ok('edited text WITHOUT the STOP line → refused; not marked sent, nothing logged', r.err && r.err.code === 'failed-precondition' && /STOP line/.test(r.err.message) && untouched(r.w), r.err && r.err.message);
    r = await sent('Hi Sam — Thursday works? Reply STOP and we\'ll stop texting.');
    ok('edited text WITHOUT the company name → refused, untouched', r.err && /company name/.test(r.err.message) && untouched(r.w));
    r = await sent('Hi Sam, No Big Deal here — we handle the insurance claim for you. Reply STOP and we\'ll stop texting.');
    ok('edited text WITH claim wording → refused, untouched', r.err && /Kentucky rule/.test(r.err.message) && untouched(r.w));
    r = await sent(GOOD, { ['sms_dnc/own-1__' + KEY]: { companyId: 'own-1', key: KEY, source: 'stop_reply' } });
    ok('the customer went on the Do Not Text list since the check → refused at "sent", untouched', r.err && r.err.code === 'failed-precondition' && untouched(r.w));
    r = await sent(GOOD, {}, { clockMs: NIGHT });
    ok('11pm in the homeowner\'s time → refused at "sent" (quiet hours), untouched', r.err && /texting hours/.test(r.err.message) && untouched(r.w));
    r = await sent(GOOD, {}, { readThrows: (p) => p.indexOf('sms_opt_outs/') === 0 });
    ok('the register cannot be read → refused unavailable (fail closed), untouched', r.err && r.err.code === 'unavailable' && untouched(r.w));
    r = await sent(GOOD);
    const rows = r.w ? [...r.w.store.entries()].filter(([k]) => /^sms_log\//.test(k)).map(([, v]) => v) : [];
    ok('a good edit → marked sent_by_owner and ONE sms_log row (leadId + uid + date)', r.out && r.out.ok === true && r.w.store.get('agent_inbox/d1').status === 'sent_by_owner'
      && rows.length === 1 && rows[0].leadId === 'lead-1' && rows[0].uid === 'own-1' && !!rows[0].date, JSON.stringify(r.err ? r.err.message : rows));

    const inbox = stripComments(rd('docs/pro/js/agent-inbox.js'));
    const click = blockAt(inbox, "if (act === 'text' || act === 'mailsent') {");
    ok('inbox: "Text from my phone" holds the sms: link (preventDefault) and opens it only after the server\'s "sent" answered ok',
      !!click && /if \(act === 'text'\) ev\.preventDefault\(\);/.test(click)
        && click.indexOf('await markSent(id)') !== -1 && click.indexOf('window.location.assign(href)') > click.indexOf('await markSent(id)'));
    ok('inbox: a refusal shows the server\'s reason on the draft', /flag\.textContent = why;/.test(inbox));
    ok('inbox: sent phone drafts carry "They replied STOP" → phoneTextAction stop', /data-ai-act="replied-stop"/.test(inbox) && /callable\('phoneTextAction', \{ action: 'stop', leadId: it\.leadId \}\)/.test(inbox));
    const ctl = stripComments(rd('docs/pro/js/customer-tasks-ui.js'));
    ok('Comm Log: an outbound text row carries "They replied STOP" (CSP: a delegated listener, no inline handler)',
      /data-comm-stop="\$\{esc\(comm\.id\)\}"/.test(ctl) && /closest\('\[data-comm-stop\]'\)/.test(ctl) && /PS\.reportStop\(\{ leadId: btn\.getAttribute\('data-comm-lead'\), logId: btn\.getAttribute\('data-comm-stop'\) \}\)/.test(ctl)
        && !/onclick=/.test(ctl.slice(ctl.indexOf('data-comm-stop'), ctl.indexOf('data-comm-stop') + 300)));
  }
  {
    console.log('  — "They replied STOP" (phoneTextAction stop)');
    const base = { 'leads/lead-1': LEAD };
    let r = await callPhone(REP, { action: 'stop', leadId: 'lead-1' }, base);
    const reg = r.w && r.w.store.get('sms_opt_outs/' + KEY);
    const dnc = r.w && r.w.store.get('sms_dnc/co-1__' + KEY);
    ok('records the STOP register under the canonical key, like an inbound STOP', r.out && r.out.ok === true && !!reg && reg.keyword === 'STOP' && reg.match === 'owner_reported' && reg.reportedBy === 'rep-1',
      JSON.stringify(r.err ? r.err.message : reg));
    ok('…and the company\'s Do Not Text list (source stop_reply — only their START lifts it)', !!dnc && dnc.source === 'stop_reply');
    const after = await callPhone(REP, { action: 'check', leadId: 'lead-1', phone: PHONE }, Object.fromEntries(r.w.store));
    ok('…after which the check refuses this customer', after.out && after.out.ok === false && after.out.code === 'opted_out');
    r = await callPhone(REP, { action: 'stop', leadId: 'lead-1', phone: '(513) 555-0100' }, base);
    ok('a number that is not the customer\'s (no lead phone, no log row) → refused, nothing recorded', r.err && r.err.code === 'failed-precondition' && !r.w.store.has('sms_opt_outs/5135550100'));
    r = await callPhone(REP, { action: 'stop', leadId: 'lead-1', logId: 'log-1' }, Object.assign({}, base, { 'sms_log/log-1': { leadId: 'lead-1', uid: 'rep-1', companyId: 'co-1', to: '+15135550100', toDigits: '5135550100' } }));
    ok('from a Comm Log row: the number that row was sent to', r.out && r.out.ok === true && r.w.store.has('sms_opt_outs/5135550100'));
    r = await callPhone(REP, { action: 'stop', leadId: 'lead-1', logId: 'log-1' }, Object.assign({}, base, { 'sms_log/log-1': { leadId: 'lead-9', uid: 'x', companyId: 'co-2', to: '+15135550100' } }));
    ok('another customer\'s / company\'s log row → refused', r.err && r.err.code === 'not-found' && !r.w.store.has('sms_opt_outs/5135550100'));
    r = await callPhone(REP, { action: 'stop', leadId: 'lead-1' }, { 'leads/lead-1': Object.assign({}, LEAD, { companyId: 'co-2', userId: 'x' }) });
    ok('another company\'s lead → refused', r.err && r.err.code === 'not-found' && !r.w.store.has('sms_opt_outs/' + KEY));
    r = await callPhone({ uid: 'v-1', companyId: 'co-1', role: 'viewer' }, { action: 'stop', leadId: 'lead-1' }, base);
    ok('a viewer cannot', r.err && r.err.code === 'permission-denied');
    r = await callPhone(REP, { action: 'sent', leadId: 'lead-1', phone: PHONE, body: 'Hi Sam', source: 'deal_link' }, base);
    const row = r.w && [...r.w.store.entries()].find(([k]) => /^sms_log\//.test(k));
    ok('"sent": one sms_log row per the Comm Log contract (leadId + uid + date, companyId, via owner_device)', r.out && r.out.ok && !!row
      && row[1].leadId === 'lead-1' && row[1].uid === 'rep-1' && row[1].date != null && row[1].companyId === 'co-1' && row[1].toDigits === KEY && row[1].via === 'owner_device' && row[1].source === 'deal_link' && row[1].body === 'Hi Sam',
      JSON.stringify(row));
    r = await callPhone(REP, { action: 'sent', leadId: 'lead-1', phone: PHONE, body: 'x' }, { 'leads/lead-1': Object.assign({}, LEAD, { companyId: 'co-2', userId: 'x' }) });
    ok('"sent" on another company\'s lead → refused, nothing logged', r.err && ![...r.w.store.keys()].some((k) => /^sms_log\//.test(k)));
  }

  // ═══ G. AI draft double send ═══════════════════════════════════════════
  console.log('\nG. R2-3-3: an AI reply already sent is never sent again');
  {
    const w = W.makeWorld({ docs: { 'leads/lead-1': LEAD, 'sms_settings/co-1': { registered: true } } });
    const mod = W.load(w, 'sms-functions.js');
    const after = { status: 'approved', draftText: 'Thanks Sam, Tuesday works.', customerPhone: PHONE, userId: 'rep-1', companyId: 'co-1', approvedBy: 'rep-1' };
    const fire = (beforeStatus) => mod.onAiDraftApproved.__handler({
      data: { before: { data: () => ({ status: beforeStatus }) }, after: { data: () => after } },
      params: { leadId: 'lead-1', draftId: 'draft-1' },
    });
    await fire('pending');
    const first = w.twilioCalls.length;
    await fire('sent');   // the #2243 repro: a stale second tab taps Approve again
    ok('the pin\'s repro: pending → approved sends one text', first === 1, 'twilio ' + first);
    ok('FIXED (was KNOWN BUG R2-3-3): a stale sent → approved sends NOTHING (one text total)', w.twilioCalls.length === 1, 'twilio ' + w.twilioCalls.length);
    for (const st of ['failed', 'approved', 'dismissed', undefined]) {
      const n = w.twilioCalls.length;
      await fire(st);
      ok('…' + String(st) + ' → approved sends nothing', w.twilioCalls.length === n);
    }
    const src = stripComments(rd('functions/sms-functions.js'));
    const trigAt = src.indexOf('exports.onAiDraftApproved = onDocumentUpdated(');
    const trig = trigAt === -1 ? null : blockAt(src.slice(trigAt), 'async (event) => {');
    ok('the trigger guard reads before.status !== \'pending\'', !!trig && /if \(before\.status !== 'pending'\) return;/.test(trig));
    const panel = stripComments(rd('docs/pro/js/customer-ai-drafts-panel.js'));
    const approve = blockAt(panel, "if (action === 'approve') {");
    const at = (s) => (approve ? approve.indexOf(s) : -1);
    ok('the panel re-reads the draft and approves only a pending one, BEFORE its write',
      !!approve && at('await window.getDoc(ref)') !== -1 && at("if (st !== 'pending')") > at('await window.getDoc(ref)')
        && at("status: 'approved'") > at("if (st !== 'pending')"));
    const rules = stripComments(rd('firestore.rules'));
    const drafts = blockAt(rules, 'match /ai_drafts/{draftId} {');
    ok('rules: approved only from pending; failed may go back to pending (emulator: firestore-rules.test.js §57)',
      !!drafts && /resource\.data\.status == 'pending'\s*&& request\.resource\.data\.status in \['approved', 'dismissed'\]/.test(drafts)
        && /resource\.data\.status == 'failed'\s*&& request\.resource\.data\.status in \['pending', 'dismissed'\]/.test(drafts));
  }

  // ═══ S. the helpers can fail ═══════════════════════════════════════════
  console.log('\nS — self-checks');
  {
    ok('S: the stripper drops a commented-out guard', !/before\.status !== 'pending'/.test(stripComments("// if (before.status !== 'pending') return;\r\nx();")));
    ok('S: blockAt scopes to the matching brace', blockAt('a { b { c } } d', 'a {') === '{ b { c } }');
    ok('S: a missing anchor is null (fails loudly, never an empty pass)', blockAt('x', 'nope {') === null);
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { console.error(e && e.stack); process.exit(1); });
