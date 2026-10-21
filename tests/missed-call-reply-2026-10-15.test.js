#!/usr/bin/env node
/**
 * Speed-to-lead on a missed call (2026-10-15):
 *   functions/missed-call-reply-logic.js   the reply draft + the auto-text pre-flight
 *   functions/missed-call-autotext.js      the auto-text I/O (dark: MISSED_CALL_AUTOTEXT_ENABLED)
 *   call-center-logic.js buildCallDoc      every missed inbound call carries replyDraft
 *   call-watch-logic.js newNeeds/alertFor  the bell + push carry the sms: link
 *   push-functions.js / firebase-messaging-sw.js   "Text back" push button
 *   notif-bell.js / call-center-view.js    the bell row + the Call Center card
 *
 * Pure Node, no emulator. Run: node tests/missed-call-reply-2026-10-15.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const R = require(path.join(FN, 'missed-call-reply-logic.js'));
const CCL = require(path.join(FN, 'call-center-logic.js'));
const W = require(path.join(FN, 'call-watch-logic.js'));
const OptOut = require(path.join(FN, 'sms-optout.js'));
const AT = require(path.join(FN, 'missed-call-autotext.js'));

let passed = 0, failed = 0;
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); failed++; }
}

// A minimal Firestore double: doc().get/set, collection().doc(), runTransaction.
function fakeDb(seed) {
  const store = new Map(Object.entries(Object.assign({}, require('./lib/messaging-controls-open').OPEN_CONTROLS, seed || {})));
  let reads = 0;
  const ref = (p) => ({
    id: p.split('/').pop(), path: p,
    async create(v) { if (store.has(p)) { const e = new Error('6 ALREADY_EXISTS'); e.code = 6; throw e; } store.set(p, v); },
    async get() { reads++; const v = store.get(p); return { exists: v !== undefined, id: p.split('/').pop(), data: () => (v === undefined ? undefined : JSON.parse(JSON.stringify(v))) }; },
    async set(v, o) { store.set(p, o && o.merge ? Object.assign({}, store.get(p) || {}, v) : v); },
    async update(v) { if (!store.has(p)) throw new Error('missing'); store.set(p, Object.assign({}, store.get(p), v)); },
    collection: (c) => coll(p + '/' + c),
  });
  // where(...).where(...).limit(n).get() over the direct children of a collection
  // (the declined-consent decision's lead and inbound scans).
  const query = (c, filters, lim) => ({
    where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim),
    orderBy: () => query(c, filters, lim),
    limit: (n) => query(c, filters, n),
    async get() {
      reads++;
      const docs = [];
      for (const [k, v] of store) {
        if (k.indexOf(c + '/') !== 0 || k.slice(c.length + 1).indexOf('/') !== -1) continue;
        if (!filters.every(([f, op, x]) => (op === '==' ? v[f] === x : op === '>=' ? v[f] >= x : true))) continue;
        docs.push({ id: k.split('/').pop(), data: () => JSON.parse(JSON.stringify(v)) });
      }
      return { docs: lim ? docs.slice(0, lim) : docs, empty: !docs.length, size: docs.length };
    },
  });
  const coll = (c) => Object.assign({ doc: (id) => ref(c + '/' + id) }, query(c, [], 0));
  return {
    store, get reads() { return reads; },
    doc: ref, collection: coll,
    async runTransaction(fn) {
      return fn({ get: (r) => r.get(), set: (r, v, o) => { r.set(v, o); } });
    },
  };
}

(async () => {
  // Thursday 2026-10-15, 2:00 PM Eastern.
  const NOW = Date.parse('2026-10-15T18:00:00Z');
  const MIN = 60000, H = 3600000;

  console.log('A. the reply bodies');
  ok('manual reply is under 160 characters', R.REPLY_BODY.length <= 160, String(R.REPLY_BODY.length));
  ok('auto reply is under 160 characters', R.AUTO_BODY.length <= 160, String(R.AUTO_BODY.length));
  // eslint-disable-next-line no-control-regex
  const gsmSafe = (s) => /^[\x20-\x7e]+$/.test(s);
  ok('both bodies are plain ASCII (one GSM-7 segment, no em dash)', gsmSafe(R.REPLY_BODY) && gsmSafe(R.AUTO_BODY));
  ok('manual reply: Joe, NBD, sorry I missed your call, the /inspect link', /Joe/.test(R.REPLY_BODY) && /No Big Deal Home Solutions/.test(R.REPLY_BODY) && /missed your call/.test(R.REPLY_BODY) && /nobigdealwithjoedeal\.com\/inspect/.test(R.REPLY_BODY));
  ok('manual reply carries no STOP line (a personal text Jo sends himself)', !/STOP/.test(R.REPLY_BODY));
  ok('the automated text carries "Reply STOP to opt out"', /Reply STOP to opt out\./.test(R.AUTO_BODY));

  console.log('B. a missed call gets a draft (buildCallDoc)');
  const file = { id: 'f1', name: 'x.m4a', size: 100, mimeType: 'audio/mp4' };
  const parsed = (dir) => ({ startedAtMs: NOW - 20 * MIN, ymd: '2026-10-15', direction: dir, phoneDigits: '5135550100', contactName: '', savedContact: false, tags: [], ext: 'm4a' });
  const missed = CCL.buildCallDoc({ ownerUid: 'O', file, parsed: parsed('inbound'), match: { leadId: 'L1' }, bucket: 'customer', storedPath: 'p', nowMs: NOW, durationSec: 4 });
  ok('missed inbound call → status short + replyDraft', missed.status === 'short' && !!missed.replyDraft, JSON.stringify(missed.replyDraft));
  ok('draft is manual, body = the reply, created now', missed.replyDraft.kind === 'manual' && missed.replyDraft.body === R.REPLY_BODY && missed.replyDraft.createdAtMs === NOW);
  ok('draft link is sms:+1<number>?body=<the reply>', missed.replyDraft.smsHref === 'sms:+15135550100?body=' + encodeURIComponent(R.REPLY_BODY), missed.replyDraft.smsHref);
  ok('the link decodes back to the exact reply', decodeURIComponent(missed.replyDraft.smsHref.split('?body=')[1]) === R.REPLY_BODY);
  ok('the link passes the shared safe-href check', R.isSafeSmsHref(missed.replyDraft.smsHref) && R.draftHref(missed) === missed.replyDraft.smsHref);
  const out = CCL.buildCallDoc({ ownerUid: 'O', file, parsed: parsed('outbound'), match: null, bucket: 'unknown', storedPath: 'p', nowMs: NOW, durationSec: 4 });
  const talked = CCL.buildCallDoc({ ownerUid: 'O', file, parsed: parsed('inbound'), match: null, bucket: 'unknown', storedPath: 'p', nowMs: NOW, durationSec: 300 });
  const nonum = CCL.buildCallDoc({ ownerUid: 'O', file, parsed: Object.assign(parsed('inbound'), { phoneDigits: '' }), match: null, bucket: 'unknown', storedPath: 'p', nowMs: NOW, durationSec: 4 });
  ok('no draft for an outbound short call, an answered call, or no number', !out.replyDraft && !talked.replyDraft && !nonum.replyDraft);
  ok('safe-href check refuses other schemes and injected quotes', !R.isSafeSmsHref('javascript:alert(1)') && !R.isSafeSmsHref('sms:+15135550100?body=a" onclick="x') && !R.isSafeSmsHref('sms:+1513555010?body=hi'));

  console.log('C. the bell + push carry the link (call-watch-logic)');
  const call = Object.assign({ id: 'cube_1', createdAtMs: NOW - 10 * MIN, contactName: 'Pat Jones', leadId: 'L1' }, missed);
  const needs = W.newNeeds([call], [], [], NOW - H, NOW, null, null);
  ok('the missed call is news and carries its smsHref', needs.length === 1 && needs[0].why === 'missed call' && needs[0].smsHref === missed.replyDraft.smsHref, JSON.stringify(needs));
  const alert = W.alertFor(needs, [], NOW);
  ok('one missed call → alert.smsHref (bell row + push "Text back")', alert && alert.smsHref === missed.replyDraft.smsHref);
  const two = W.alertFor(needs.concat([{ id: 'call:x', key: 'num:8595550111', who: 'Bob', why: 'urgent' }]), [], NOW);
  ok('two people → no single reply link', two && two.smsHref === '');
  const urgentOnly = W.newNeeds([Object.assign({}, call, { urgent: true })], [], [], NOW - H, NOW, null, null);
  ok('a call told for another reason carries no reply link', urgentOnly.length === 1 && urgentOnly[0].why === 'urgent' && !('smsHref' in urgentOnly[0]));
  const cwSrc = read('functions/call-watch.js');
  ok('callWatch puts smsHref on the bell doc and type missedCall + smsUrl on the push', /alert\.smsHref \? \{ smsHref: alert\.smsHref \}/.test(cwSrc) && /type: 'missedCall', smsUrl: pa\.smsHref/.test(cwSrc));

  console.log('D. the push button (server list = worker list; worker opens sms:)');
  const PF = fs.readFileSync(path.join(FN, 'push-functions.js'), 'utf8');
  ok('server offers Text back + Open for missedCall', /case 'missedCall':[\s\S]{0,200}action: 'text', title: 'Text back'/.test(PF));
  const listeners = {};
  const sandbox = {
    importScripts() {}, firebase: { initializeApp() {}, messaging: () => ({ onBackgroundMessage() {} }) },
    console: { log() {}, warn() {}, error() {} }, clients: {}, JSON, String, Object, Array, Promise, Date, RegExp, Error,
  };
  sandbox.self = { addEventListener: (ev, fn) => { listeners[ev] = fn; }, registration: { showNotification() {} }, skipWaiting() {} };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('docs/pro/firebase-messaging-sw.js'), sandbox);
  const href = missed.replyDraft.smsHref;
  const p1 = sandbox.resolveNotificationAction('text', { smsUrl: href, clickUrl: '/pro/dashboard.html?call=cube_1#/calls' });
  ok('worker: Text back → kind text with the sms: link', p1.kind === 'text' && p1.sms === href, JSON.stringify(p1));
  const p2 = sandbox.resolveNotificationAction('text', { smsUrl: 'javascript:alert(1)' });
  ok('worker: an unsafe smsUrl falls back to opening the CRM', p2.kind === 'navigate');
  ok('worker list for missedCall = Text back, Open', JSON.stringify(sandbox.getNotificationActions('missedCall')) === JSON.stringify([{ action: 'text', title: 'Text back' }, { action: 'view', title: 'Open' }]));
  const opened = [];
  sandbox.clients = { openWindow: async (u) => { opened.push(u); return {}; }, matchAll: async () => [] };
  let waited = null;
  listeners.notificationclick({ action: 'text', notification: { close() {}, data: { smsUrl: href, clickUrl: '/pro/dashboard.html#/calls' } }, waitUntil: (p) => { waited = p; } });
  await waited;
  ok('worker click opens the sms: link itself', opened[0] === href, JSON.stringify(opened));
  ok('worker: a missedCall push keeps its own Call Center card URL', sandbox.getClickUrl({ type: 'missedCall', clickUrl: '/pro/dashboard.html?call=cube_1#/calls' }) === '/pro/dashboard.html?call=cube_1#/calls'
    && sandbox.getClickUrl({ type: 'missedCall', clickUrl: 'https://evil.example/' }) === '/pro/dashboard.html#/calls');

  console.log('E. the bell row + the Call Center card show "Text back"');
  const bell = read('docs/pro/js/notif-bell.js');
  ok('bell keeps a safe smsHref from the doc and renders a Text back link', /smsHref:\s+SMS_HREF_RE\.test/.test(bell) && /notif-textback" href="\$\{escapeHtml\(n\.smsHref\)\}"/.test(bell));
  const ccv = read('docs/pro/js/call-center-view.js');
  ok('Call Center card leads with Text back on an open missed call', /c\.replyDraft && SMS_HREF_RE\.test/.test(ccv) && /cc-textback" href="' \+ esc\(c\.replyDraft\.smsHref\)/.test(ccv) && /var actions = textBack \+ reachButtons/.test(ccv));
  ok('no inline handler in the new markup', !/notif-textback[^>]*\son[a-z]+=/.test(bell) && !/cc-textback[^>]*\son[a-z]+=/.test(ccv));
  ok('cache-busts bumped (notif-bell v8, phone-calls.css v12, call-center-view v23)', /js\/notif-bell\.js\?v=8/.test(read('docs/pro/dashboard.html')) && /css\/phone-calls\.css\?v=12/.test(read('docs/pro/dashboard.html'))
    && /css\/phone-calls\.css\?v=12/.test(read('docs/pro/customer.html')) && /js\/call-center-view\.js\?v=23/.test(read('docs/pro/js/script-loader.js')));
  ok('styles live in phone-calls.css', /\.notif-textback\s*\{/.test(read('docs/pro/css/phone-calls.css')) && /\.cc-textback\s*\{/.test(read('docs/pro/css/phone-calls.css')));
  ok('the Twilio line\'s missed-call bell carries the link too', /smsHref: require\('\.\/missed-call-reply-logic'\)\.smsHref\(from\)/.test(read('functions/twilio-line.js')));

  console.log('F. the auto-text: OFF by default, consent-gated');
  const ON = { MISSED_CALL_AUTOTEXT_ENABLED: 'true' };
  const consented = { userId: 'O', companyId: 'O', phone: '(513) 555-0100', tcpaConsent: true, tcpaConsentText: 'tcpa-v2-2026-10-05', state: 'OH' };
  const fresh = Object.assign({}, call, { startedAtMs: NOW - 20 * MIN });
  const plan = (env, lead, c, now) => R.planAutoText({ env, call: c || fresh, lead, nowMs: now || NOW });
  ok('flag unset → off', plan({}, consented).reason === 'flag_disabled');
  ok('flag "false" / "TRUE" / "1" → off (only the literal "true")', ['false', 'TRUE', '1', 'yes'].every((v) => plan({ MISSED_CALL_AUTOTEXT_ENABLED: v }, consented).reason === 'flag_disabled'));
  const envFile = fs.readFileSync(path.join(FN, '.env.nobigdeal-pro'), 'utf8');
  ok('.env.nobigdeal-pro ships it false', /^MISSED_CALL_AUTOTEXT_ENABLED=false\s*$/m.test(envFile) && !/^MISSED_CALL_AUTOTEXT_ENABLED=true/m.test(envFile));
  ok('consented customer, in hours, fresh call → send to +1 number with the STOP body', (() => { const p = plan(ON, consented); return p.send && p.to === '+15135550100' && p.body === R.AUTO_BODY; })());
  ok('cold caller (no customer on file) → refused', plan(ON, null, Object.assign({}, fresh, { leadId: null })).reason === 'no_lead');
  ok('customer without consent → refused', plan(ON, Object.assign({}, consented, { tcpaConsent: undefined })).reason === 'no_consent');
  ok('consent declined → refused', plan(ON, Object.assign({}, consented, { tcpaConsent: false })).reason === 'no_consent');
  ok('"true" as a string is not consent', plan(ON, Object.assign({}, consented, { tcpaConsent: 'true' })).reason === 'no_consent');
  ok('tcpaConsent true without a web-form consent version (hand-set) → refused', plan(ON, Object.assign({}, consented, { tcpaConsentText: undefined })).reason === 'no_consent'
    && plan(ON, Object.assign({}, consented, { tcpaConsentText: 'rep-said-ok' })).reason === 'no_consent');
  ok('number not the consenting customer\'s → refused', plan(ON, Object.assign({}, consented, { phone: '8595550199' })).reason === 'number_mismatch');
  ok('do-not-contact / dnc → refused', plan(ON, Object.assign({}, consented, { doNotContact: true })).reason === 'do_not_contact' && plan(ON, Object.assign({}, consented, { dnc: 'yes' })).reason === 'do_not_contact');
  ok('deleted lead → refused', plan(ON, Object.assign({}, consented, { deleted: true })).reason === 'deleted');
  const night = Date.parse('2026-10-16T02:30:00Z'); // 10:30 PM Eastern
  ok('10:30 PM homeowner time → quiet hours', plan(ON, consented, Object.assign({}, fresh, { startedAtMs: night - 10 * MIN }), night).reason === 'quiet_hours');
  const ky8 = Date.parse('2026-10-15T12:30:00Z'); // 8:30 AM Eastern = 7:30 AM Central
  ok('Kentucky lead at 8:30 AM Eastern → quiet hours (KY spans Central)', plan(ON, Object.assign({}, consented, { state: 'KY' }), Object.assign({}, fresh, { startedAtMs: ky8 - 5 * MIN }), ky8).reason === 'quiet_hours');
  ok('a backfilled call from 4 hours ago → stale, never texted', plan(ON, consented, Object.assign({}, fresh, { startedAtMs: NOW - 4 * H })).reason === 'stale');
  ok('an answered call → not a missed call', plan(ON, consented, Object.assign({}, fresh, { status: 'stored' })).reason === 'not_missed');

  console.log('G. the auto-text I/O (missed-call-autotext.js)');
  const sent = [];
  const send = async (m) => { sent.push(m); return { sid: 'SM' + sent.length }; };
  const quiet = { info() {}, warn() {} };
  const seed = () => ({ 'leads/L1': consented });
  let db = fakeDb(seed());
  let r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: {}, send, tenantKey: 'O', logger: quiet });
  ok('flag off → no send and not one read', r.sent === false && r.reason === 'flag_disabled' && sent.length === 0 && db.reads === 0);
  db = fakeDb({ 'leads/L1': Object.assign({}, consented, { tcpaConsent: undefined }) });
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('flag on, unconsented customer → refused, nothing sent', r.reason === 'no_consent' && sent.length === 0);
  db = fakeDb({});
  r = await AT.maybeAutoTextMissedCall({ db, call: Object.assign({}, fresh, { leadId: null }), nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('flag on, cold caller → refused before any read', r.reason === 'no_lead' && sent.length === 0 && db.reads === 0);
  db = fakeDb(Object.assign(seed(), { ['sms_opt_outs/' + OptOut.optOutKey('+15135550100')]: { phone: '+15135550100' } }));
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('number on the STOP register → refused', r.reason === 'opted_out' && sent.length === 0);
  db = fakeDb(Object.assign(seed(), { ['sms_dnc/O__' + OptOut.optOutKey('+15135550100')]: { phone: '+15135550100' } }));
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('number on the company Do Not Text list → refused', r.reason === 'opted_out' && sent.length === 0, r.reason);
  // The same number said NO on a later form for this tenant: the declined-consent
  // decision (kind 'automated', no inbound exemption) refuses before Twilio.
  db = fakeDb(Object.assign(seed(), {
    'leads/L1': Object.assign({}, consented, { phoneDigits: '5135550100', tcpaConsentAt: NOW - 30 * 24 * H, createdAt: NOW - 30 * 24 * H }),
    'leads/L2': { userId: 'O', companyId: 'O', phoneDigits: '5135550100', tcpaConsent: false, createdAt: NOW - 2 * 24 * H },
    'sms_settings/O': { registered: true },
  }));
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('a later "no" on another of this tenant\'s forms for the number → consent_declined, nothing sent', r.reason === 'consent_declined' && sent.length === 0, r.reason);
  db = fakeDb(Object.assign(seed(), { 'sms_settings/O': { registered: true, enabled: false } }));
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('company texting switch off → refused', r.reason === 'texting_switched_off' && sent.length === 0, r.reason);
  db = fakeDb(Object.assign(seed(), { 'sms_settings/O': { registered: true } }));
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('all clear → ONE text, to the caller, STOP body', r.sent === true && sent.length === 1 && sent[0].to === '+15135550100' && sent[0].body === R.AUTO_BODY);
  ok('claim stamped, call doc stamped, lead timeline row written', (db.store.get('missed_call_autotext/O__5135550100') || {}).lastSentAtMs === NOW
    && ((db.store.get('phone_calls/cube_1') || {}).autoText || {}).sid === 'SM1' && !!db.store.get('leads/L1/activity/autotext-cube_1'));
  r = await AT.maybeAutoTextMissedCall({ db, call: Object.assign({}, fresh, { id: 'cube_2', startedAtMs: NOW + 2 * H - 10 * MIN }), nowMs: NOW + 2 * H, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('a second missed call 2 h later → cooldown, no second text', r.reason === 'cooldown' && sent.length === 1);
  r = await AT.maybeAutoTextMissedCall({ db, call: Object.assign({}, fresh, { id: 'cube_3', startedAtMs: NOW + 25 * H - 10 * MIN }), nowMs: NOW + 25 * H, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('25 h later → allowed again (one per 24 h)', r.sent === true && sent.length === 2);
  db = fakeDb(Object.assign(seed(), { 'sms_settings/O': { registered: true } }));
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send: async () => { throw new Error('twilio down'); }, tenantKey: 'O', logger: quiet });
  ok('a failed send is reported, never thrown, and the claim stays (no retry storm)', r.reason === 'send_failed' && !!db.store.get('missed_call_autotext/O__5135550100'));
  db = { doc() { throw new Error('boom'); } };
  r = await AT.maybeAutoTextMissedCall({ db, call: fresh, nowMs: NOW, env: ON, send, tenantKey: 'O', logger: quiet });
  ok('an unreadable lead fails closed (no text, no throw)', r.sent === false && r.reason === 'error' && sent.length === 2);
  const cc = read('functions/call-center.js');
  ok('ingest calls it only behind the flag and only for a call with a draft', /if \(callDoc\.replyDraft && process\.env\.MISSED_CALL_AUTOTEXT_ENABLED === 'true'\)/.test(cc));

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
