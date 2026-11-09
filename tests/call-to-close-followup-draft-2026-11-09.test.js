/**
 * tests/call-to-close-followup-draft-2026-11-09.test.js — Call to Close P1:
 * the follow-up draft and the objection / competitor tags in the Call Brief
 * sheet (docs/pro/js/call-brief-ui.js), run in a vm with a tiny DOM stub.
 * Design: documentation/projects/CALL-TO-CLOSE-DESIGN-2026-11-09.md §5.3,
 * §6 #6, §7, §9 P1; Q4 (objections stay in the brief, never lead fields).
 *
 *   1. built ONLY from items the person accepted in the sheet (or accepted
 *      earlier on this brief): a skipped or untouched item never shows, and
 *      with nothing accepted there is no draft, only "accept first"
 *   2. fixed phrases only: no summary, quote or promise text from the model,
 *      no money; the customer's first name and the company come from the
 *      CRM, the dates from what the person accepted
 *   3. a text needs written texting consent on file (tcpaConsent true with
 *      the server's tcpaConsentAt stamp); no consent, an unstamped yes, a
 *      decline or Do Not Text → the text draft refuses and says why, and a
 *      spoken "you can text me" in the brief changes nothing
 *   4. nothing sends by itself: a text goes through NBDPhoneShare.share (the
 *      existing ok-to-text check: STOP, Do Not Text, consent, texting switch,
 *      quiet hours, then the phone's Messages with the text written); an
 *      email opens the mail app with the draft written (no CRM email sender,
 *      email_system.js untouched); each is one tap, and only a confirmed send
 *      is logged (callBriefDecide draft:followupText / draft:followupEmail)
 *   5. objections and a named competitor render as tags with the words that
 *      were said and a playbook reply from fixed phrases (tenant overrides
 *      read from the company profile), which Copy puts on the clipboard;
 *      nothing is sent, nothing is written to the lead
 *   6. escaping, CSP, no new <script> tag
 *
 * Run: node tests/call-to-close-followup-draft-2026-11-09.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const SRC = read('docs/pro/js/call-brief-ui.js');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail.slice(0, 300) : JSON.stringify(detail)) : '')); }
}

function load(opts) {
  const o = opts || {};
  const listeners = {};
  const dlgEl = {
    className: '', innerHTML: '', open: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; if (k === 'open') this.open = false; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    showModal() { this.open = true; }, close() { this.open = false; (listeners.close || []).forEach((f) => f()); },
    contains() { return true; }, querySelector() { return null; },
  };
  const body = { kids: [], appendChild(x) { this.kids.push(x); }, contains(x) { return this.kids.includes(x); } };
  const calls = [];
  const shares = [];
  const copied = [];
  const win = {
    ScriptLoader: { load: async () => {}, loadBundle: async () => {} },
    _functions: {}, _httpsCallable: (_f, name) => async (data) => { calls.push({ name, data }); return { data: name === 'callCenterAction' ? { ok: true, dueDate: data.dueYmd || '2026-11-06' } : { ok: true } }; },
    auth: { currentUser: { uid: 'jo' } },
    _companyProfile: o.profile || { companyName: 'Example Roofing Co' },
    NBDPhoneShare: o.noShare ? undefined : { share: async (x) => { shares.push(x); return o.shareResult || { shared: true, via: x.phone ? 'sms' : 'email' }; } },
    navigator: { clipboard: { writeText: async (t) => { copied.push(t); } } },
  };
  const ctx = vm.createContext({ window: win, document: { createElement: () => dlgEl, body, querySelector: () => null }, console, setTimeout, Date, Event: function () {} });
  vm.runInContext(SRC, ctx);
  const click = async (attrs) => {
    const b = { disabled: false, getAttribute: (k) => (k in attrs ? attrs[k] : null), closest: () => b };
    for (const fn of listeners.click) fn({ target: b });
    await new Promise((r) => setTimeout(r, 5));
  };
  return { CB: win.NBDCallBrief, dlg: dlgEl, calls, shares, copied, listeners, win, click };
}

const BRIEF = {
  v: 1, transcriptOk: { reliable: true, cutOff: false, why: '' },
  summary: { text: 'MODEL SUMMARY hail leak, you can text me.', quotes: ['you can text me anytime'], inferred: false },
  fields: {
    insCarrier: null, claimNumber: null, dateOfLoss: null, adjusterName: null,
    adjusterMeetingYmd: { value: '2026-11-12', spoken: 'next Thursday', quote: 'the adjuster comes next Thursday', conf: 'said' },
    damageType: null, jobType: null, workKind: null,
  },
  scope: { service: null, tierInterest: null, stories: null, layers: null, mentions: {}, saidQuantities: [{ text: '28 squares', quote: 'about twenty-eight squares' }] },
  promises: [
    { who: 'jo', text: 'MODEL PROMISE send the estimate for $12,000', kind: 'estimate', dueSpoken: 'by Friday', dueYmd: '2026-11-06', quote: 'I will send you the estimate by Friday' },
    { who: 'them', text: 'MODEL PROMISE adjuster report', kind: 'waiting', dueSpoken: '', dueYmd: '', quote: 'I will send you the adjuster report' },
    { who: 'jo', text: 'MODEL PROMISE call back', kind: 'callback', dueSpoken: 'Monday', dueYmd: '2026-11-09', quote: 'I will call you Monday' },
  ],
  followUp: { value: '2026-11-10', spoken: 'Tuesday', quote: 'call me Tuesday', conf: 'said' },
  stage: null, drafts: { estimate: false, proposal: false, followUp: 'text' },
  flags: { injection: false }, people: [],
  objections: [
    { kind: 'price', quote: 'that seems like a lot <script>x</script>' },
    { kind: 'spouse', quote: 'I need to ask my husband' },
    { kind: 'bogus', quote: 'not a kind' },
  ],
  competitor: { named: true, quote: 'ABC Roofing already gave me a quote' },
};
const CALL = { startedAtMs: Date.parse('2026-11-05T15:00:00Z'), durationSec: 312, attachedBy: 'jo', leadId: 'L1' };
const CONSENT = { tcpaConsent: true, tcpaConsentAt: { seconds: 1762000000 } };
const LEAD = Object.assign({ firstName: 'Pat', lastName: 'Example', phone: '(513) 555-0100', email: 'pat@example.com', followUp: '2026-11-08' }, CONSENT);
const clone = (x) => JSON.parse(JSON.stringify(x));
const GEN = 1762380000000;
// A follow-up accepted in the sheet is on the customer (NBDFollowUpDeck wrote it).
const FU_LEAD = () => Object.assign(clone(LEAD), { followUp: '2026-11-10' });
const open = (CB, over) => CB._showWith(Object.assign({ callId: 'cube_ABCDE12345', brief: clone(BRIEF), call: CALL, lead: clone(LEAD), leadId: 'L1', page: 'customer', generatedAtMs: GEN }, over || {}));
const section = (html, id) => { const i = html.indexOf('id="' + id + '"'); return i < 0 ? '' : html.slice(i, html.indexOf('cb-sec-title', i + 20) > 0 ? html.indexOf('cb-sec-title', i + 20) : undefined); };
// The draft as a person reads it (apostrophes are escaped in the HTML).
const words = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"');

(async () => {
  console.log('\n1. Built only from what was accepted');
  {
    const { CB } = load();
    ok('the sheet exports the follow-up helpers', typeof CB._followUpItems === 'function' && typeof CB._followUpDraft === 'function' && typeof CB._textConsent === 'function');
    open(CB);
    const html = CB._render();
    const sec = section(html, 'cbMsgH');
    ok('a "Follow-up message" section renders', sec.length > 0, html.slice(-600));
    ok('…with nothing accepted: no draft, it says to accept first', /Accept a promise, the follow-up date or the adjuster meeting/.test(sec) && !/data-cb-act="msg-text"|data-cb-act="msg-email"/.test(sec) && !/<textarea[^>]*data-cb-input="msg/.test(sec));
  }
  {
    const { CB, click, dlg } = load();
    open(CB);
    await click({ 'data-cb-act': 'promise', 'data-i': '0' });
    await click({ 'data-cb-act': 'promise-yes', 'data-i': '0' });
    const sec = words(section(dlg.innerHTML, 'cbMsgH'));
    ok('accept the estimate promise in the sheet → the draft names it in fixed words, with its date', /I'll send over your estimate by Fri, Nov 6\./.test(sec), sec.slice(0, 900));
    ok('…greets the customer by the CRM first name', /Hi Pat,/.test(sec));
    ok('…signs with the company from the profile', /Example Roofing Co/.test(sec));
    ok('…leaves out what was not accepted (the waiting chase, the call back, the follow-up date, the meeting)', !/send over what we talked about|call you back|check in with you|adjuster meeting/.test(sec));
    ok('…carries none of the model\'s words (summary, promise text, quotes) and no money', !/MODEL|you can text me|\$|12,000|twenty-eight|squares/i.test(sec));
    await click({ 'data-cb-act': 'promise-skip', 'data-i': '2' });
    ok('a skipped promise never joins the draft', !/call you back/.test(section(dlg.innerHTML, 'cbMsgH')));
  }
  {
    const { CB } = load();
    // The accepted follow-up was written to the customer (NBDFollowUpDeck), so
    // the lead carries it: the draft reads it only while it is still there.
    open(CB, { lead: Object.assign(clone(LEAD), { followUp: '2026-11-10' }), decisions: [
      { item: 'promise:1', decision: 'accept', finalValue: 'them waiting 2026-11-12', gen: GEN, slot: 1 },
      { item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN },
      { item: 'field:adjusterMeetingYmd', decision: 'accept', finalValue: '2026-11-12', gen: GEN },
      { item: 'promise:2', decision: 'skip', finalValue: '', gen: GEN },
      { item: 'promise:0', decision: 'accept', finalValue: 'jo estimate 2026-11-06', gen: 1 },
    ] });
    const items = CB._followUpItems();
    ok('accepted earlier on this brief (decisions) count: the waiting chase, the follow-up date, the meeting', items.some((x) => x.kind === 'waiting' && x.ymd === '2026-11-12') && items.some((x) => x.kind === 'followUp' && x.ymd === '2026-11-10') && items.some((x) => x.kind === 'meeting' && x.ymd === '2026-11-12'), items);
    ok('…a decision made on an older brief (another gen) does not', !items.some((x) => x.kind === 'estimate'));
    const sec = words(section(CB._render(), 'cbMsgH'));
    ok('the waiting chase is a fixed ask, never the model\'s words', /send over what we talked about by Thu, Nov 12\./.test(sec) && !/adjuster report/.test(sec), sec.slice(0, 900));
    ok('the follow-up date and the adjuster meeting read as fixed lines', /I'll check in with you on Tue, Nov 10\./.test(sec) && /See you at the adjuster meeting on Thu, Nov 12\./.test(sec));
    const d = CB._followUpDraft(items, { firstName: 'Pat' }, 'Example Roofing Co');
    ok('_followUpDraft is pure and fixed: text ends with the STOP line, email has a subject', /Reply STOP to opt out\.$/.test(d.text) && d.subject === 'Following up on our call' && /Hi Pat,/.test(d.body));
    ok('…with no company and no name it still reads cleanly', /^Hi,/.test(CB._followUpDraft(items, {}, '').text) && !/undefined|null/.test(JSON.stringify(CB._followUpDraft(items, {}, ''))));
    ok('…no items → no draft', CB._followUpDraft([], { firstName: 'Pat' }, 'X') === null);
    ok('…a company name ending in a period is not doubled ("Co..")', !/\.\./.test(CB._followUpDraft(items, { firstName: 'Pat' }, 'Sample Roofing Co.').text));
  }

  {
    // The follow-up's Undo puts the customer's old date back but is not
    // logged, so the brief still holds the accept. Reopened, the draft must
    // not promise a check-in date the customer no longer has.
    const { CB } = load();
    open(CB, { decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    ok('a follow-up accepted then undone (the customer is back on 2026-11-08) never joins the draft', !CB._followUpItems().some((x) => x.kind === 'followUp'), CB._followUpItems());
    const { CB: CB2 } = load();
    open(CB2, { lead: Object.assign(clone(LEAD), { followUp: '2026-11-10T00:00:00' }), decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    ok('…while one still on the customer does (any stored date shape)', CB2._followUpItems().some((x) => x.kind === 'followUp' && x.ymd === '2026-11-10'), CB2._followUpItems());
  }

  console.log('\n2. Texting consent');
  {
    const { CB } = load();
    const c = CB._textConsent;
    ok('stored, stamped form consent → ok', c(LEAD).ok === true);
    ok('no consent on file → refused, and says a call is not consent', c({ phone: '5135550100' }).ok === false && /consent/i.test(c({ phone: '5135550100' }).why) && /you can text me/i.test(c({ phone: '5135550100' }).why));
    ok('an unstamped yes (hand-typed / imported) → refused, as the server does', c({ phone: '5135550100', tcpaConsent: true }).ok === false);
    ok('a declined form → refused', c(Object.assign({}, LEAD, { tcpaConsent: false })).ok === false);
    for (const k of ['doNotContact', 'dnc', 'doNotText', 'smsOptOut', 'smsOptedOut']) ok(k + ' → refused', c(Object.assign({}, LEAD, { [k]: true })).ok === false);
    ok('no phone → refused', c(Object.assign({}, LEAD, { phone: '' })).ok === false && /phone/i.test(c(Object.assign({}, LEAD, { phone: '' })).why));
  }
  {
    const { CB, click, dlg, shares } = load();
    open(CB, { lead: { firstName: 'Pat', phone: '5135550100', email: '', followUp: '2026-11-10' }, decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CB._render();
    await click({ 'data-cb-act': 'msg-channel', 'data-ch': 'text' });
    const sec = section(dlg.innerHTML, 'cbMsgH');
    ok('no consent + a brief that heard "you can text me" → the text draft refuses and says why', /No written texting consent/.test(sec) && /not consent/.test(sec) && !/data-cb-act="msg-text"/.test(sec), sec.slice(0, 900));
    await click({ 'data-cb-act': 'msg-text' });
    ok('…and nothing can be handed to Messages', shares.length === 0);
    const { CB: CBe, dlg: dlgE } = load();
    open(CBe, { lead: { firstName: 'Pat', phone: '5135550100', email: 'pat@example.com', followUp: '2026-11-10' }, decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CBe._render();
    const esec = section(dlgE.innerHTML, 'cbMsgH');
    ok('no texting consent but an email on file → opens on the email draft and still says why there is no text', /data-cb-act="msg-email"/.test(esec) && /No written texting consent/.test(esec));
    ok('…with no email either, the email draft says so', (await (async () => { await click({ 'data-cb-act': 'msg-channel', 'data-ch': 'email' }); return /No email address/.test(section(dlg.innerHTML, 'cbMsgH')); })()));
  }

  console.log('\n3. Nothing sends by itself');
  {
    const { CB, click, dlg, shares, calls } = load();
    open(CB, { lead: FU_LEAD(), decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CB._render();
    ok('rendering the draft hands nothing anywhere', shares.length === 0 && !calls.some((c) => /draft:followup/.test((c.data || {}).item || '')));
    ok('the text channel is the default when consent is on file', /data-cb-act="msg-text"/.test(section(dlg.innerHTML, 'cbMsgH')));
    ok('the button says it checks first and opens Messages (you press Send there)', /Check and open in Messages/.test(dlg.innerHTML) && /You press Send there/.test(dlg.innerHTML));
    await click({ 'data-cb-act': 'msg-text' });
    const s = shares[0] || {};
    ok('one tap → NBDPhoneShare.share (the ok-to-text check, then Messages), with the lead, the phone and the draft', shares.length === 1 && s.leadId === 'L1' && s.phone === LEAD.phone && s.preferSms === true && s.source === 'call_brief_followup' && /I'll check in with you on Tue, Nov 10\./.test(s.text), s);
    ok('…never NBDComms.sendSMS / a send callable', !/NBDComms|sendSMS|sendEmail/.test(SRC));
    const logged = calls.find((c) => c.name === 'callBriefDecide' && c.data.item === 'draft:followupText');
    ok('a confirmed send is logged as draft:followupText with the words sent', logged && logged.data.decision === 'accept' && /check in with you/.test(logged.data.value), logged);
  }
  {
    const { CB, click, dlg, shares, calls } = load({ shareResult: { shared: false, via: null, blocked: true, reason: 'Texting hours: 8am-9pm their time.' } });
    open(CB, { lead: FU_LEAD(), decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CB._render();
    await click({ 'data-cb-act': 'msg-text' });
    ok('…shown as a refusal (cb-err), not as done', /cb-err[^>]*>Texting hours/.test(dlg.innerHTML));
    ok('the check says no (quiet hours) → the reason shows, nothing logged', shares.length === 1 && /Texting hours/.test(dlg.innerHTML) && !calls.some((c) => c.data && c.data.item === 'draft:followupText'));
  }
  {
    const { CB, click, dlg, calls } = load({ shareResult: { shared: false, via: null, cancelled: true } });
    open(CB, { lead: FU_LEAD(), decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CB._render();
    await click({ 'data-cb-act': 'msg-text' });
    ok('the person says it did not go out → a plain note (not an error, not done), nothing logged', /cb-meta[^>]*>Not sent\. The message is still here\./.test(dlg.innerHTML) && !/cb-(err|done)[^>]*>Not sent/.test(dlg.innerHTML) && !calls.some((c) => c.data && c.data.item === 'draft:followupText'));
  }
  {
    const { CB, click, dlg, shares, calls } = load();
    open(CB, { lead: FU_LEAD(), decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CB._render();
    await click({ 'data-cb-act': 'msg-channel', 'data-ch': 'email' });
    const sec = section(dlg.innerHTML, 'cbMsgH');
    ok('email: a subject and a body you can edit', /data-cb-input="msg-subject"/.test(sec) && /data-cb-input="msg-body"/.test(sec) && /Following up on our call/.test(sec));
    ok('…says it opens your mail app and you send it there', /Open in Mail/.test(sec) && /You press Send there/.test(sec));
    await click({ 'data-cb-act': 'msg-email' });
    const s = shares[0] || {};
    ok('one tap → the mail app with the draft written (NBDPhoneShare, email only, no phone)', shares.length === 1 && s.email === 'pat@example.com' && !s.phone && s.subject === 'Following up on our call' && /check in with you/.test(s.text), s);
    ok('…logged as draft:followupEmail only after it went', calls.some((c) => c.name === 'callBriefDecide' && c.data.item === 'draft:followupEmail'));
    ok('email_system.js is not used', !/email_system|emailSystem/.test(SRC));
  }
  {
    const { CB, click, shares, listeners } = load();
    open(CB, { lead: FU_LEAD(), decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CB._render();
    const ta = { getAttribute: (k) => ({ 'data-cb-input': 'msg-text' })[k] || null, value: 'Hi Pat, my own words. Reply STOP to opt out.' };
    for (const fn of listeners.input || []) fn({ type: 'input', target: ta });
    await click({ 'data-cb-act': 'msg-text' });
    ok('an edit is kept: the person\'s own words are what is handed to Messages', shares.length === 1 && shares[0].text === ta.value, shares[0]);
  }
  {
    const { CB, click, copied, shares } = load();
    open(CB, { lead: FU_LEAD(), decisions: [{ item: 'followUp', decision: 'accept', finalValue: '2026-11-10', gen: GEN }] });
    CB._render();
    await click({ 'data-cb-act': 'msg-copy' });
    ok('Copy → the clipboard holds the draft, nothing handed to Messages', copied.length === 1 && /check in with you/.test(copied[0]) && shares.length === 0);
  }

  console.log('\n4. Objections and the competitor');
  {
    const { CB, click, copied, calls, dlg } = load();
    open(CB);
    const html = CB._render();
    const sec = section(html, 'cbObjH');
    ok('an "Objections on the call" section renders', sec.length > 0);
    ok('each known objection is a tag with what was said (price, spouse)', /cb-tag[^>]*>Price</.test(sec) && /cb-tag[^>]*>Spouse or partner</.test(sec) && /I need to ask my husband/.test(sec), sec.slice(0, 900));
    ok('an unknown kind is not shown', !/not a kind/.test(sec));
    ok('a named competitor is a tag too, with its quote', /cb-tag[^>]*>Competitor named</.test(sec) && /ABC Roofing already gave me a quote/.test(sec));
    ok('quotes are escaped (no markup from the call)', !/<script>x<\/script>/.test(sec) && /&lt;script&gt;/.test(sec));
    const tags = CB._objectionTags(BRIEF, null);
    ok('_objectionTags: price, spouse, competitor, each with a playbook reply', tags.length === 3 && tags.every((t) => t.reply && t.label && t.quote), tags);
    ok('playbook replies are fixed phrases with no number, price or claim promise', tags.every((t) => !/\d|\$|percent|discount|negotiat|deductible/i.test(t.reply)), tags.map((t) => t.reply));
    ok('every default kind has a reply', ['price', 'timing', 'trust', 'insurance', 'spouse', 'competitor', 'other'].every((k) => typeof CB.PLAYBOOK[k] === 'string' && CB.PLAYBOOK[k].length > 20));
    ok('the replies do not name any one company (tenant-neutral)', !/NBD|No Big Deal|Joe/i.test(JSON.stringify(CB.PLAYBOOK)));
    const own = CB._objectionTags(BRIEF, { price: 'Our own price reply.', spouse: 42, competitor: 'x'.repeat(900) });
    ok('a tenant override (company profile callPlaybook) replaces a reply; a non-string or too-long one is ignored', own[0].reply === 'Our own price reply.' && own[1].reply === CB.PLAYBOOK.spouse && own[2].reply === CB.PLAYBOOK.competitor);
    ok('the replies are copy-only: a Copy button per tag, no send button', (sec.match(/data-cb-act="obj-copy"/g) || []).length === 3 && !/obj-send|sendSMS/.test(sec));
    await click({ 'data-cb-act': 'obj-copy', 'data-i': '0' });
    ok('Copy → the reply on the clipboard, no server call', copied.length === 1 && copied[0] === CB.PLAYBOOK.price && calls.length === 0);
    ok('…and says Copied', /Copied/.test(dlg.innerHTML));
    const none = clone(BRIEF); none.objections = []; none.competitor = null;
    const { CB: CB2 } = load();
    open(CB2, { brief: none });
    ok('no objections and no competitor → no section', section(CB2._render(), 'cbObjH') === '');
    const unrel = clone(BRIEF); unrel.transcriptOk = { reliable: false, why: 'Spanish' }; unrel.objections = []; unrel.competitor = null; unrel.promises = [];
    const { CB: CB3 } = load();
    open(CB3, { brief: unrel });
    ok('objections are never written to the lead (no decide call, no lead field)', !/objection/i.test(JSON.stringify(require(path.join(ROOT, 'functions', 'call-brief-logic.js')).LEAD_FIELD)));
  }

  console.log('\n5. CSP and boot');
  {
    ok('no inline handler or style attribute in the sheet', !/\son[a-z]+=|style=/.test(SRC));
    ok('no new <script> tag for the sheet in dashboard.html / customer.html', !/call-brief-ui/.test(read('docs/pro/dashboard.html')) && !/call-brief-ui/.test(read('docs/pro/customer.html')));
    ok('the clipboard and the share sheet are reached through window (testable, no globals)', /window\.navigator/.test(SRC) && /window\.NBDPhoneShare/.test(SRC));
    const css = read('docs/pro/css/call-brief.css');
    ok('the tag style lives in call-brief.css, on tokens', /\.cb-tag\b/.test(css));
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  ' + fails.join('\n  ')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
