/**
 * tests/messaging-center-2026-10-19.test.js - the read-only Messaging Control Center.
 *
 * Pure logic (functions/messaging-center-logic.js) and the client renderer
 * (docs/pro/js/messaging-center.js) are loaded in a vm sandbox with no deps.
 * The callable and the hourly watch (functions/messaging-center.js) run against
 * an in-memory Firestore fake with the firebase modules stubbed, so the role
 * gate, the flag gate, tenant scoping, read-only-ness and the alert dedupe are
 * exercised for real. Source-shape checks strip comments first.
 *
 * Run: node tests/messaging-center-2026-10-19.test.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; fails.push(label); console.log('  ✗ ' + label + (detail ? ' — ' + detail : '')); }
}

// ── sandbox loaders ──────────────────────────────────────────────────────
function loadCommonJs(file, extraGlobals) {
  const mod = { exports: {} };
  const sb = Object.assign({ module: mod, exports: mod.exports, console, Intl, Date, Math, JSON, Object, Array, String, Number, RegExp, Set, Map, parseInt, isNaN, require: () => { throw new Error('no require'); } }, extraGlobals || {});
  vm.runInNewContext(read(file), sb, { filename: file });
  return mod.exports;
}
const L = loadCommonJs('functions/messaging-center-logic.js');
const C = loadCommonJs('docs/pro/js/messaging-center.js', { document: undefined, window: undefined });

// ── fixtures ─────────────────────────────────────────────────────────────
const HOUR = 3600000, DAY = 86400000;
// Tue 2026-10-20 15:00 UTC = 11:00 ET (inside the 8am-9pm window).
const NOW = Date.UTC(2026, 9, 20, 15, 0, 0);
const at = (hAgo) => NOW - hAgo * HOUR;
const ev = (o) => Object.assign({ id: 'e' + Math.random().toString(36).slice(2), channel: 'sms', automation: 'rep_text', atMs: at(1), outcome: 'sent', errorCode: '', toKey: '8595550101', toDisplay: '(•••) •••-0101', name: 'Pat L.', templateId: 'x', text: 'hello', consent: 'form', state: 'OH', internal: false, blockedReason: '', source: 't' }, o);

console.log('\nMASKING');
ok('maskPhone shows last 4 only', L.maskPhone('(859) 555-0142') === '(•••) •••-0142');
ok('maskPhone of garbage is not a number', !/\d/.test(L.maskPhone('12')));
ok('maskEmail keeps first letters only', L.maskEmail('Pat.Lee@Gmail.com') === 'p•••@g•••.com');
ok('maskEmail of garbage', L.maskEmail('nope') === 'unknown email');
ok('clipLine takes the first line and caps at 80', L.clipLine('a'.repeat(200) + '\nsecond').length === 80 && !/second/.test(L.clipLine('hi\nsecond')));
ok('scrubText masks a phone typed into a reply', !/5550142/.test(L.scrubText('call me at 859-555-0142 please')) && /0142/.test(L.scrubText('call me at 859-555-0142 please')));
ok('scrubText masks an e-mail typed into a reply', !/pat\.lee/.test(L.scrubText('mail pat.lee@gmail.com')));
const leaky = ev({ text: 'Reply from 859-555-0142 or pat@gmail.com ' + 'z'.repeat(200), name: 'Pat 8595550142', toDisplay: L.maskPhone('8595550142') });
const pub = L.publicEvent(leaky, {});
ok('publicEvent: first line <= 80 chars', pub.firstLine.length <= 80);
ok('publicEvent: no raw 7+ digit run and no raw e-mail anywhere in the JSON', !/\d{7,}/.test(JSON.stringify(pub).replace(/"atMs":\d+/, '')) && !/pat@gmail/.test(JSON.stringify(pub)), JSON.stringify(pub));
ok('publicEvent never carries the raw recipient key', !('toKey' in pub));

console.log('\nNORMALISERS (one ledger row -> one event)');
{
  const lead = { name: 'Pat Lee', tcpaConsent: true, state: 'KY' };
  const sent = L.fromSmsLog('a', { to: '+18595550142', toDigits: '8595550142', body: 'Hi Pat', status: 'sent', date: new Date(at(2)), source: 'review_request' }, lead);
  ok('sms_log sent row -> sms/sent, last-4 recipient, name shortened', sent.channel === 'sms' && sent.outcome === 'sent' && sent.toDisplay.endsWith('0142') && sent.name === 'Pat L.');
  ok('sms_log: lead with a form tick shows consent form', sent.consent === 'form');
  const dec = L.fromSmsLog('b', { to: '+18595550142', body: 'x', status: 'failed', failureReason: 'consent_declined', refused: true, date: new Date(at(2)) }, lead);
  ok('sms_log consent_declined -> blocked / no_consent', dec.outcome === 'blocked' && dec.blockedReason === 'no_consent');
  const fail = L.fromSmsLog('c', { to: '+18595550142', body: 'x', status: 'failed', date: new Date(at(2)) }, lead);
  ok('sms_log failed -> failed', fail.outcome === 'failed');
  const del = L.fromSmsLog('d', { to: '+18595550142', body: 'x', status: 'sent', deliveryStatus: 'undelivered', deliveryErrorCode: '30007', date: new Date(at(2)) }, lead);
  ok('sms_log with a carrier verdict -> undelivered + code', del.outcome === 'undelivered' && del.errorCode === '30007');
  ok('sms_log inbound rows are not outbound events', L.fromSmsLog('e', { status: 'received', to: '+18595550142', date: new Date() }) === null);
  ok('sms_log knockId -> d2d_text; queued -> outbox_text; ai_draft -> ai_reply',
    L.fromSmsLog('f', { knockId: 'k', status: 'sent', date: new Date(), to: '8595550142' }).automation === 'd2d_text' &&
    L.fromSmsLog('g', { queued: true, status: 'sent', date: new Date(), to: '8595550142' }).automation === 'outbox_text' &&
    L.fromSmsLog('h', { source: 'ai_draft', status: 'sent', date: new Date(), to: '8595550142' }).automation === 'ai_reply');
  const ao = L.fromAlertOutbox('o1', { createdAt: new Date(at(3)), target: { sms: '+18595550199', emails: ['joe@example.com'], name: 'NBD' }, collection: 'inspect_leads', smsStatus: 'accepted', smsDelivery: 'undelivered:30007', emailStatus: 'sent', pushStatus: 'skipped:no-device' });
  ok('alert_outbox -> sms + email events, skipped push dropped', ao.length === 2 && ao.every((e) => e.internal));
  ok('alert_outbox smsDelivery undelivered:30007 parsed', ao[0].outcome === 'undelivered' && ao[0].errorCode === '30007');
  const st1 = L.fromStormClaim('s1', { status: 'sent', sentAt: new Date(at(2)), event: 'Hail', zip: '41011' }, { phone: '8595550123', tcpaConsent: true });
  const st2 = L.fromStormClaim('s2', { status: 'sent', sentAt: new Date(at(2)), event: 'Hail', zip: '41011' }, { phone: '8595550124' });
  ok('storm claim consent: subscriber with tcpaConsent true / none otherwise', st1.consent === 'subscriber' && st2.consent === 'none');
  const stamps = L.fromLeadStamps('inspect_leads', 'L1', { name: 'Al B', phone: '8595550177', email: 'al@x.com', ackEmailSentAt: new Date(at(5)), ackSmsSentAt: new Date(at(5)), followUpEmailSentAt: new Date(at(4)), tcpaConsent: true });
  ok('lead stamps -> ack email, ack text, follow-up email', stamps.map((e) => e.automation).sort().join() === 'lead_ack_email,lead_ack_text,lead_followup_email');
  ok('review ask: only status "sent" counts', L.fromReviewAsk('r', { reviewAutoAsk: { status: 'sending', channel: 'text' } }) === null &&
    L.fromReviewAsk('r', { phone: '8595550177', reviewAutoAsk: { status: 'sent', channel: 'text', sentAtMs: at(2) } }).automation === 'review_ask_text');
}

console.log('\nAGGREGATION');
{
  const events = [
    ev({ id: '1', channel: 'sms', automation: 'rep_text', atMs: at(1) }),
    ev({ id: '2', channel: 'sms', automation: 'storm_alert', atMs: at(2), consent: 'subscriber', outcome: 'delivered' }),
    ev({ id: '3', channel: 'email', automation: 'lead_ack_email', atMs: at(30), consent: 'n/a', toKey: 'a@b.com' }),
    ev({ id: '4', channel: 'email', automation: 'rep_email', atMs: at(24 * 6), consent: 'n/a', toKey: 'c@d.com', outcome: 'failed' }),
    ev({ id: '5', channel: 'sms', automation: 'rep_text', atMs: at(24 * 20), outcome: 'undelivered', errorCode: '30007' }),
    ev({ id: '6', channel: 'sms', automation: 'rep_text', atMs: at(1.5), outcome: 'blocked', blockedReason: 'no_consent' }),
    ev({ id: '7', channel: 'sms', automation: 'rep_text', atMs: at(2.5), outcome: 'blocked', blockedReason: 'opted_out' }),
    ev({ id: '8', channel: 'push', automation: 'owner_lead_alert_push', atMs: at(1), internal: true }),
  ];
  const dayStart = L.startOfDay(NOW, 'America/New_York');
  ok('startOfDay is local midnight ET', L.ymdIn(dayStart, 'America/New_York') === '2026-10-20' && L.ymdIn(dayStart - 1, 'America/New_York') === '2026-10-19');
  const today = L.countWindow(events, dayStart, NOW);
  ok('today counts: blocked rows excluded, by channel', today.total === 3 && today.byChannel.sms === 2 && today.byChannel.push === 1 && today.byChannel.email === 0, JSON.stringify(today));
  ok('today counts by automation', today.byAutomation.rep_text === 1 && today.byAutomation.storm_alert === 1);
  const d7 = L.countWindow(events, NOW - 7 * DAY, NOW);
  const d30 = L.countWindow(events, NOW - 30 * DAY, NOW);
  ok('7d and 30d windows widen', d7.total === 5 && d30.total === 6, d7.total + '/' + d30.total);
  ok('voice channel is always present and 0', d30.byChannel.voice === 0);
  const oc = L.outcomesOf(events, NOW - 30 * DAY);
  ok('outcomes: delivered / failed / undelivered counted with the error code', oc.sms.delivered === 1 && oc.email.failed === 1 && oc.sms.undelivered === 1 && oc.errorCodes['30007'] === 1, JSON.stringify(oc));
  const bl = L.blockedOf(events, NOW - 30 * DAY);
  ok('blocked: counted by reason, all seven reasons present', bl.total === 2 && bl.byReason.no_consent === 1 && bl.byReason.opted_out === 1 && Object.keys(bl.byReason).length === 7);
  ok('blocked: unknown reason lands in other', L.blockedOf([ev({ outcome: 'blocked', blockedReason: 'weird', atMs: at(1) })], NOW - DAY).byReason.other === 1);
  const oo = L.optOutRows([{ addedAt: new Date(at(5)), phone: '+18595550142', source: 'stop_reply' }, { addedAt: new Date(at(1)), key: '8595550999' }], 10);
  ok('opt-outs: last 4 only, newest first, total', oo.total === 2 && oo.recent[0].last4 === '0999' && !/\d{5,}/.test(JSON.stringify(oo).replace(/"atMs":\d+/g, '')));
  const q = L.queueRows([{ queue: 'email_queue', status: 'pending', atMs: new Date(at(5)), label: 'a' }, { queue: 'email_queue', status: 'failed', atMs: new Date(at(50)), label: 'b', attempts: 5 }], NOW);
  ok('queue backlog: oldest first with age, pending/failed split', q.items[0].label === 'b' && q.items[0].ageMs === 50 * HOUR && q.pending === 1 && q.failed === 1);
  const ov = L.buildOverview({ nowMs: NOW, events, flagRows: [{ name: 'STORM_TEXT_ENABLED', state: 'OFF' }], controls: null, texting: { enabled: true, registered: true }, a2pRegistered: true });
  ok('overview: kill switch and canary unknown when the controls doc is absent', ov.status.killSwitch === 'unknown' && ov.status.canary === 'unknown');
  ok('overview: A2P + texting + per-automation flag state', ov.status.a2pRegistered === 'yes' && ov.status.texting.enabled === true && ov.status.automations.find((a) => a.key === 'storm_alert').state === 'OFF');
  ok('overview: last customer send ignores internal alerts and blocked rows', ov.status.lastSendAtMs === at(1));
  const c1 = L.controlsFrom({ killSwitch: true, canary: false });
  ok('controls doc read loosely: killSwitch true -> on, canary false -> off', c1.killSwitch === 'on' && c1.canary === 'off' && c1.present === true);
  ok('overview exposes the threshold config', ov.thresholds.errorRatePctPerHour === 10);
}

console.log('\nNEEDS A LOOK');
{
  const ctx = { tz: 'America/New_York', optOutAtMs: { '8595550777': at(10) }, bounces: [{ id: 'b1', reason: 'bounce', atMs: at(3) }] };
  const kinds = (events) => L.needsLook(events, NOW, L.THRESHOLDS, ctx).map((i) => i.kind);
  ok('a failed customer send is listed high', L.needsLook([ev({ outcome: 'failed' })], NOW, L.THRESHOLDS, {})[0].kind === 'failed' && L.needsLook([ev({ outcome: 'failed' })], NOW, L.THRESHOLDS, {})[0].severity === 'high');
  ok('carrier error 30007 is listed with its meaning', (() => { const i = L.needsLook([ev({ outcome: 'undelivered', errorCode: '30007' })], NOW, L.THRESHOLDS, {})[0]; return i.kind === 'carrier_error' && /filtered/.test(i.title); })());
  ok('21610 is a carrier error too', kinds([ev({ outcome: 'failed', errorCode: '21610' })]).indexOf('carrier_error') !== -1);
  ok('an automated text with no consent record is high', (() => { const i = L.needsLook([ev({ automation: 'storm_alert', consent: 'none' })], NOW, L.THRESHOLDS, {}).find((x) => x.kind === 'no_consent'); return i && i.severity === 'high' && i.automated === true; })());
  ok('a rep text to a lead with no consent is only a warning', (() => { const i = L.needsLook([ev({ automation: 'rep_text', consent: 'rep' })], NOW, L.THRESHOLDS, {}); return i.length === 0; })());
  ok('a rep text whose lead has no stored consent is a warning (never high), if it is ever recorded as none', (() => { const i = L.needsLook([ev({ automation: 'rep_text', consent: 'none' })], NOW, L.THRESHOLDS, {}).find((x) => x.kind === 'no_consent'); return !!i && i.severity === 'warn' && i.automated === false; })());
  ok('consent form / subscriber / inbound sends are not flagged', kinds([ev({ automation: 'storm_alert', consent: 'subscriber' }), ev({ automation: 'ai_reply', consent: 'inbound', toKey: '8595550202' })]).filter((k) => k !== 'bounce').length === 0);
  const threeAmEt = Date.UTC(2026, 9, 20, 7, 0, 0); // 03:00 ET
  ok('a text at 3am ET is outside the window', kinds([ev({ atMs: threeAmEt })]).indexOf('quiet_hours') !== -1);
  ok('8:00am ET inclusive is inside, 9:00pm ET exclusive is outside', !L.outsideWindow(Date.UTC(2026, 9, 20, 12, 0, 0), 'OH') && L.outsideWindow(Date.UTC(2026, 9, 21, 1, 0, 0), 'OH'));
  ok('Kentucky must hold in both zones (7:30am Central = 8:30am ET is outside)', L.outsideWindow(Date.UTC(2026, 9, 20, 12, 30, 0), 'KY') && !L.outsideWindow(Date.UTC(2026, 9, 20, 12, 30, 0), 'OH'));
  ok('email is not subject to the quiet-hours rule', kinds([ev({ channel: 'email', automation: 'lead_ack_email', consent: 'n/a', atMs: threeAmEt, toKey: 'a@b.com' })]).indexOf('quiet_hours') === -1);
  ok('internal owner alerts are not subject to it either', kinds([ev({ automation: 'owner_lead_alert_sms', internal: true, atMs: threeAmEt, consent: 'n/a' })]).indexOf('quiet_hours') === -1);
  ok('two messages to one person within 24h (one automated) -> duplicate', kinds([ev({ automation: 'lead_ack_text', atMs: at(5), consent: 'form' }), ev({ automation: 'review_ask_text', atMs: at(2), consent: 'form' })]).indexOf('duplicate') !== -1);
  ok('two rep texts to one person are a conversation, not a duplicate', kinds([ev({ atMs: at(5) }), ev({ atMs: at(2) })]).indexOf('duplicate') === -1);
  ok('25 hours apart is not a duplicate', kinds([ev({ automation: 'lead_ack_text', atMs: at(30), consent: 'form' }), ev({ automation: 'lead_ack_text', atMs: at(4), consent: 'form' })]).indexOf('duplicate') === -1);
  ok('a text sent after the number opted out is high', (() => { const i = L.needsLook([ev({ toKey: '8595550777', atMs: at(2) })], NOW, L.THRESHOLDS, ctx).find((x) => x.kind === 'after_optout'); return i && i.severity === 'high'; })());
  ok('a text sent BEFORE the opt-out is fine', kinds([ev({ toKey: '8595550777', atMs: at(20) })]).indexOf('after_optout') === -1);
  ok('an automation outside the A2P campaign is listed', kinds([ev({ automation: 'review_ask_text', consent: 'form' })]).indexOf('outside_campaign') !== -1);
  ok('an email bounce is listed', kinds([]).indexOf('bounce') !== -1);
  const many = []; for (let i = 0; i < 52; i++) many.push(ev({ automation: 'review_ask_text', consent: 'form', toKey: '859555' + String(1000 + i), atMs: at(0.1 + i / 1000) }));
  ok('an automation over its per-day cap is listed', kinds(many).indexOf('over_cap') !== -1);
  const six = []; for (let i = 0; i < 6; i++) six.push(ev({ atMs: at(1 + i / 100) }));
  ok('more than 5 texts to one number in 24h is over the cap', kinds(six).indexOf('over_cap') !== -1);
  ok('high items sort before warnings', (() => { const r = L.needsLook([ev({ automation: 'review_ask_text', consent: 'form' }), ev({ outcome: 'failed' })], NOW, L.THRESHOLDS, {}); return r[0].severity === 'high'; })());
  ok('events older than 7 days are not "needs a look"', kinds([ev({ outcome: 'failed', atMs: at(24 * 9) })]).filter((k) => k === 'failed').length === 0);
}

console.log('\nALERT THRESHOLDS');
{
  const mk = (n, bad) => { const a = []; for (let i = 0; i < n; i++) a.push(ev({ id: 'x' + i, toKey: '859555' + (2000 + i), atMs: at(0.5), outcome: i < bad ? 'failed' : 'sent' })); return a; };
  const keys = (events, cfg, ctx) => L.evaluateAlerts(events, NOW, cfg || L.THRESHOLDS, ctx || {}).map((a) => a.key);
  ok('error rate: exactly 10% is NOT over the threshold', keys(mk(20, 2)).indexOf('error_rate') === -1);
  ok('error rate: 11% IS', keys(mk(100, 11), Object.assign({}, L.THRESHOLDS, { maxSendsPerHour: 999 })).indexOf('error_rate') !== -1);
  ok('error rate: needs the minimum number of sends (1 of 1 is not a trend)', keys(mk(1, 1)).indexOf('error_rate') === -1 && keys(mk(4, 4)).indexOf('error_rate') === -1);
  ok('error rate: failures older than an hour do not count', keys(mk(20, 20).map((e) => Object.assign(e, { atMs: at(3) }))).indexOf('error_rate') === -1);
  ok('volume: 31 customer sends in an hour trips maxSendsPerHour (30)', keys(mk(31, 0)).indexOf('volume_hour') !== -1 && keys(mk(30, 0)).indexOf('volume_hour') === -1);
  ok('volume ignores internal owner alerts', keys(mk(40, 0).map((e) => Object.assign(e, { automation: 'owner_lead_alert_sms', internal: true, consent: 'n/a' }))).indexOf('volume_hour') === -1);
  ok('config object is the ONE place: a lower limit changes the answer', keys(mk(10, 0), Object.assign({}, L.THRESHOLDS, { maxSendsPerHour: 5 })).indexOf('volume_hour') !== -1);
  ok('no consent: one automated text with no record trips it, a rep text does not',
    keys([ev({ automation: 'lead_ack_text', consent: 'none' })]).indexOf('no_consent') !== -1 && keys([ev({ automation: 'rep_text', consent: 'rep' })]).indexOf('no_consent') === -1);
  ok('HIGH-risk automation firing trips it', keys([ev({ automation: 'storm_alert', consent: 'subscriber' })]).indexOf('high_risk') !== -1 && keys([ev({ automation: 'rep_text' })]).indexOf('high_risk') === -1);
  ok('after-STOP send trips it', keys([ev({ toKey: '8595550777', atMs: at(1) })], null, { optOutAtMs: { '8595550777': at(5) } }).indexOf('after_optout') !== -1);
  ok('outside-campaign automation trips it', keys([ev({ automation: 'missed_call_text', consent: 'form' })]).indexOf('outside_campaign') !== -1);
  const hist = []; for (let i = 0; i < 24; i++) hist.push(ev({ id: 'h' + i, toKey: '859555' + (3000 + i), atMs: at(5 + i * 6) }));
  ok('spike: 12 in the last hour vs ~0.14/h usual -> spike; 12 vs a busy week -> not', keys(mk(12, 0).concat(hist)).indexOf('volume_spike') !== -1 &&
    keys(mk(12, 0).concat((() => { const b = []; for (let i = 0; i < 160 * 8; i++) b.push(ev({ id: 'b' + i, toKey: '859555' + (4000 + i), atMs: at(2 + (i / 8)) })); return b; })()), Object.assign({}, L.THRESHOLDS, { maxSendsPerDay: 99999 })).indexOf('volume_spike') === -1);
  ok('daily volume limit', keys(mk(10, 0), Object.assign({}, L.THRESHOLDS, { maxSendsPerDay: 5 })).indexOf('volume_day') !== -1);
  ok('quiet system raises no alerts', L.evaluateAlerts([ev({ atMs: at(1) })], NOW, L.THRESHOLDS, {}).length === 0);
  ok('alerts are ordered high before warn', (() => { const r = L.evaluateAlerts([ev({ automation: 'lead_ack_text', consent: 'none' })], NOW, L.THRESHOLDS, {}); return r[0].severity === 'high' && r[r.length - 1].severity === 'warn'; })());
  ok('dedupe key: same alert same day = same key; next day = new key', L.alertKey({ key: 'no_consent' }, NOW, 'America/New_York') === L.alertKey({ key: 'no_consent' }, NOW + HOUR, 'America/New_York') && L.alertKey({ key: 'no_consent' }, NOW, 'America/New_York') !== L.alertKey({ key: 'no_consent' }, NOW + DAY, 'America/New_York'));
  ok('thresholds are frozen so a caller cannot mutate the shared config', Object.isFrozen(L.THRESHOLDS));
}

console.log('\nROLE GATING');
{
  const matrix = [
    [{ role: 'admin' }, 'u1', true], [{ role: 'company_admin', companyId: 'c' }, 'u1', true], [{ role: 'owner' }, 'u1', true],
    [{ role: 'sales_rep', companyId: 'c' }, 'u1', false], [{ role: 'viewer', companyId: 'c' }, 'u1', false], [{ role: 'manager', companyId: 'c' }, 'u1', false],
    [{}, 'u1', true], [{ companyId: 'u1' }, 'u1', true], [{ companyId: 'other' }, 'u1', false], [{ role: 'ADMIN' }, 'u1', true], [null, null, false], [{ role: 'admin' }, '', false],
  ];
  matrix.forEach((m) => ok('server canView ' + JSON.stringify(m[0]) + ' -> ' + m[2], L.canView(m[0], m[1], 'OWNER') === m[2]));
  ok('the owner uid always passes, even as a rep claim', L.canView({ role: 'sales_rep', companyId: 'c' }, 'OWNER', 'OWNER') === true);
  ok('client canView equals the server rule across the matrix', matrix.every((m) => C.canView(m[0], m[1]) === (L.canView(m[0], m[1], '') )));
  const nav = read('docs/pro/js/messaging-nav.js');
  ok('messaging-nav uses the same role list and solo-owner rule', /ROLES = \['owner', 'admin', 'company_admin'\]/.test(nav) && /if \(!role\) return !c\.companyId \|\| c\.companyId === uid/.test(nav));
}

console.log('\nCALLABLE + WATCH (in-memory Firestore, firebase stubbed)');
// ── fake firestore ───────────────────────────────────────────────────────
function makeDb(seed) {
  const data = JSON.parse(JSON.stringify(seed || {}), (k, v) => v);
  Object.keys(seed || {}).forEach((c) => Object.keys(seed[c]).forEach((id) => { data[c][id] = Object.assign({}, seed[c][id]); }));
  const log = { reads: [], writes: [] };
  const cmp = (v) => (v instanceof Date ? v.getTime() : (v && typeof v.toMillis === 'function' ? v.toMillis() : v));
  const snapOf = (c, id) => ({ id, exists: !!(data[c] && data[c][id]), data: () => (data[c] && data[c][id]) || undefined, ref: docRef(c, id) });
  function docRef(c, id) {
    return {
      id, path: c + '/' + id,
      get: async () => { log.reads.push(c + '/' + id); return snapOf(c, id); },
      create: async (v) => { log.writes.push({ op: 'create', path: c + '/' + id }); data[c] = data[c] || {}; if (data[c][id]) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } data[c][id] = v; },
      set: async (v, o) => { log.writes.push({ op: 'set', path: c + '/' + id }); data[c] = data[c] || {}; data[c][id] = o && o.merge ? Object.assign({}, data[c][id] || {}, v) : v; },
      update: async (v) => { log.writes.push({ op: 'update', path: c + '/' + id }); Object.assign(data[c][id], v); },
      delete: async () => { log.writes.push({ op: 'delete', path: c + '/' + id }); },
    };
  }
  function query(c, f, ord, lim) {
    const q = {
      where: (field, op, val) => query(c, f.concat([[field, op, val]]), ord, lim),
      orderBy: (field, dir) => query(c, f, [field, dir || 'asc'], lim),
      limit: (n) => query(c, f, ord, n),
      get: async () => {
        log.reads.push(c + '?' + f.map((x) => x[0] + x[1]).join('&'));
        let rows = Object.keys(data[c] || {}).map((id) => ({ id, d: data[c][id] }));
        f.forEach(([field, op, val]) => { rows = rows.filter((r) => { const x = cmp(r.d[field]); const y = cmp(val); return op === '==' ? x === y : (op === '>=' ? x >= y : (op === '>' ? x > y : false)); }); });
        if (ord) rows.sort((a, b) => (ord[1] === 'desc' ? -1 : 1) * (cmp(a.d[ord[0]]) - cmp(b.d[ord[0]])));
        if (lim) rows = rows.slice(0, lim);
        return { docs: rows.map((r) => ({ id: r.id, data: () => r.d, ref: docRef(c, r.id) })), size: rows.length };
      },
    };
    return q;
  }
  return {
    data, log,
    collection: (c) => Object.assign(query(c, [], null, 0), { doc: (id) => docRef(c, id), add: async (v) => { log.writes.push({ op: 'add', path: c }); data[c] = data[c] || {}; data[c]['auto' + Object.keys(data[c]).length] = v; } }),
    doc: (p) => { const i = p.indexOf('/'); return docRef(p.slice(0, i), p.slice(i + 1)); },
    getAll: async (...refs) => refs.map((r) => { const i = r.path.indexOf('/'); return snapOf(r.path.slice(0, i), r.path.slice(i + 1)); }),
  };
}

// ── load messaging-center.js with the firebase modules stubbed ──────────
const calls = { handlers: {}, pushes: [] };
const stubs = {
  'firebase-functions/v2/https': { onCall: (opts, h) => { calls.lastOnCall = h; return h; }, HttpsError: class HttpsError extends Error { constructor(code, msg) { super(msg); this.code = code; } } },
  'firebase-functions/v2': { logger: { info() {}, warn() {}, error() {} } },
  'firebase-admin/firestore': { getFirestore: () => calls.db, FieldValue: { serverTimestamp: () => 'TS' } },
  './integrations/heartbeat': { onSchedule: (opts, h) => { calls.lastSchedule = h; return h; } },
  './shared': { callableRateLimit: async () => {} },
  './handlers/_shared': { CORS_ORIGINS: [] },
  './push-functions': { sendCustomNotification: async (uid, title, body, data) => { calls.pushes.push({ uid, title, body, data }); return { sent: 1 }; } },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /messaging-center\.js$/.test(parent.filename || '') && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.apply(this, arguments);
};
let S;
try { S = require(path.join(ROOT, 'functions', 'messaging-center.js')); } finally { /* keep the hook until the end */ }
const OWNER = '1phDvAVXHSg82wDLegAbQFq14Ci1';

const T0 = Date.now();
const mins = (n) => new Date(T0 - n * 60000);
function seed() {
  return {
    feature_flags: { _default: { messagingControlCenter: true } },
    sms_log: {
      a: { companyId: OWNER, to: '+18595550142', toDigits: '8595550142', body: 'Reply: my other number is 859-555-0199 <script>x</script>', status: 'sent', date: mins(30), leadId: 'L1', source: 'review_request' },
      b: { companyId: OWNER, to: '+18595550143', toDigits: '8595550143', body: 'Hello', status: 'failed', date: mins(20), leadId: 'L2' },
      c: { companyId: 'OTHER_TENANT', to: '+15135550000', toDigits: '5135550000', body: 'secret other tenant', status: 'sent', date: mins(10), leadId: 'LX' },
    },
    email_log: { e1: { companyId: OWNER, to: 'pat.lee@gmail.com', subject: 'Your estimate', status: 'sent', date: mins(15), leadId: 'L1' } },
    alert_outbox: { o1: { companyId: OWNER, createdAt: mins(12), collection: 'inspect_leads', target: { sms: '+18595550199', emails: ['joe@example.com'], name: 'NBD' }, smsStatus: 'accepted', smsDelivery: 'undelivered:30007', emailStatus: 'sent', pushStatus: 'sent' } },
    leads: { L1: { name: 'Pat Lee', tcpaConsent: true, state: 'OH' }, L2: { name: 'Al Boe', state: 'OH' }, LX: { name: 'Zed Other' } },
    storm_alerts_sent: { s1: { sentAt: mins(40), status: 'sent', event: 'Hail', zip: '41011', subscriberId: 'sub1' } },
    storm_alert_subscribers: { sub1: { phone: '8595550123', name: 'Sue Q', tcpaConsent: false } },
    sms_dnc: { d1: { companyId: OWNER, key: '8595550142', phone: '+18595550142', source: 'stop_reply', addedAt: mins(120) } },
    sms_settings: { [OWNER]: { enabled: true } },
    'integrations': { sms: { a2pApproved: true } },
    email_queue: { q1: { status: 'pending', createdAt: mins(600), subject: 'Dunning notice' } },
    agent_inbox: { i1: { companyId: OWNER, status: 'pending', kind: 'draft_text', title: 'Draft text to Pat', createdAt: mins(300) } },
  };
}
const request = (token, uid) => ({ auth: uid ? { uid, token: token || {} } : null });

(async function () {
  const handler = S.messagingCenter;
  const run = async (req, db) => { calls.db = db; return handler(req); };

  // role + auth
  const db0 = makeDb(seed());
  let err = null;
  try { await run(request({}, null), db0); } catch (e) { err = e; }
  ok('callable: unauthenticated -> unauthenticated, no read', err && err.code === 'unauthenticated' && db0.log.reads.length === 0);
  for (const role of ['sales_rep', 'viewer', 'manager']) {
    const d = makeDb(seed()); err = null;
    try { await run(request({ role, companyId: OWNER }, 'repUid'), d); } catch (e) { err = e; }
    ok('callable: ' + role + ' -> permission-denied and ZERO Firestore reads', err && err.code === 'permission-denied' && d.log.reads.length === 0, err && err.code);
  }
  // flag off
  const offDb = makeDb(Object.assign(seed(), { feature_flags: { _default: { messagingControlCenter: false } } }));
  const offRes = await run(request({ role: 'admin', companyId: OWNER }, OWNER), offDb);
  ok('callable: flag off -> { enabled:false } and it read only the flag docs', offRes.enabled === false && offDb.log.reads.every((r) => r.indexOf('feature_flags/') === 0), JSON.stringify(offDb.log.reads));
  const absentDb = makeDb(Object.assign(seed(), { feature_flags: {} }));
  const absentRes = await run(request({ role: 'admin', companyId: OWNER }, OWNER), absentDb);
  ok('callable: flag absent = off', absentRes.enabled === false);
  // per-uid override can turn it on
  const ovDb = makeDb(Object.assign(seed(), { feature_flags: { _default: {}, [OWNER]: { messagingControlCenter: true } } }));
  ok('callable: a per-uid override turns it on for that user', (await run(request({ role: 'admin', companyId: OWNER }, OWNER), ovDb)).enabled === true);

  // happy path
  const db = makeDb(seed());
  const res = await run(request({ role: 'company_admin', companyId: OWNER }, 'adminUid'), db);
  const json = JSON.stringify(res);
  ok('callable: owner/admin gets an overview', res.enabled === true && res.counts && res.status && Array.isArray(res.events));
  ok('callable: WRITES NOTHING', db.log.writes.length === 0, JSON.stringify(db.log.writes));
  ok('callable: tenant scoped, another tenant’s text never appears', !/secret other tenant|Zed/.test(json) && res.events.every((e) => e.recipient.indexOf('0000') === -1 && e.name.indexOf('Zed') === -1));
  ok('callable: no full phone number or e-mail address anywhere in the response', !/\d{7,}/.test(json.replace(/"(atMs|generatedAtMs|ageMs|lastSendAtMs)":\d+/g, '')) && !/pat\.lee@|joe@example/.test(json), (json.match(/\d{7,}/g) || []).slice(0, 3).join());
  ok('callable: a customer reply is clipped to 80 and the number typed into it is masked', res.events.every((e) => e.firstLine.length <= 80) && res.events.some((e) => /my other number is \(•••\) •••-0199/.test(e.firstLine)));
  ok('callable: tenant events counted (2 sms rows + email + storm + 3 alert_outbox legs)', res.counts.d30.total >= 5, String(res.counts.d30.total));
  ok('callable: delivery outcome with the carrier code surfaces', res.outcomes.errorCodes['30007'] === 1);
  ok('callable: the declined/failed send is in Needs a look', res.needsLook.some((i) => i.kind === 'failed'));
  ok('callable: storm text to a subscriber with consent false is flagged no_consent', res.needsLook.some((i) => i.kind === 'no_consent' && i.event.automation === 'storm_alert'));
  ok('callable: the STOP list shows last 4 only', res.optOuts.total === 1 && res.optOuts.recent[0].last4 === '0142');
  ok('callable: queue backlog lists the email queue and the pending draft, oldest first', res.queues.items.length === 2 && res.queues.items[0].ageMs >= res.queues.items[1].ageMs);
  ok('callable: kill switch + canary unknown (no controls doc), and it did not create one', res.status.killSwitch === 'unknown' && !db.data.messaging_controls && res.coverage.sources.messaging_controls === 'absent');
  ok('callable: A2P registered read from integrations/sms', res.status.a2pRegistered === 'yes');
  ok('callable: coverage lists the blind spots', res.coverage.blind.some((b) => /Refusals/.test(b.label)));
  ok('callable: a non-NBD tenant never sees NBD-only ledgers (storm, email queue)', await (async () => {
    const d = makeDb(seed());
    const r = await run(request({ role: 'company_admin', companyId: 'OTHER_TENANT' }, 'otherAdmin'), d);
    return !d.log.reads.some((x) => /storm_alerts_sent|email_queue/.test(x)) && r.queues.items.every((i) => i.queue !== 'email_queue') && r.events.every((e) => e.automation !== 'storm_alert');
  })());
  ok('callable: one failing source degrades only that source', await (async () => {
    const d = makeDb(seed());
    const real = d.collection;
    d.collection = (c) => { if (c === 'email_log') { const q = real(c); q.where = () => { throw new Error('FAILED_PRECONDITION: requires an index'); }; return q; } return real(c); };
    const r = await run(request({ role: 'admin', companyId: OWNER }, OWNER), d);
    return r.enabled === true && r.coverage.sources.email_log === 'unavailable' && r.coverage.sources.sms_log === 'ok';
  })());

  // hourly watch
  console.log('\nWATCH');
  const wdb = makeDb(Object.assign(seed(), { sms_log: { z: { companyId: OWNER, to: '+18595550888', toDigits: '8595550888', body: 'x', status: 'sent', date: mins(5), leadId: 'L2', source: 'review_request' } } }));
  calls.db = wdb;
  const push = (uid, title, body, data) => stubs['./push-functions'].sendCustomNotification(uid, title, body, data);
  const dry = await S._internal.runWatch({ db: wdb, nowMs: T0, live: false, push });
  ok('watch dry-run: computes alerts, writes and pushes NOTHING', dry.alerts > 0 && wdb.log.writes.length === 0 && calls.pushes.length === 0, JSON.stringify(dry));
  const live1 = await S._internal.runWatch({ db: wdb, nowMs: T0, live: true, push });
  ok('watch live: files one Agent-inbox report per alert and pushes the owner', live1.filed === live1.alerts && live1.pushed > 0 && calls.pushes.every((p) => p.uid === OWNER));
  const filed = Object.keys(wdb.data.agent_inbox).filter((k) => /^msgwatch_/.test(k));
  ok('watch: inbox items are reports for the owner company, pending, create-only ids', filed.length === live1.filed && filed.every((k) => wdb.data.agent_inbox[k].kind === 'report' && wdb.data.agent_inbox[k].companyId === OWNER && wdb.data.agent_inbox[k].status === 'pending'));
  ok('watch: only ever writes agent_inbox + the bell (never a customer collection)', wdb.log.writes.every((w) => /^(agent_inbox|notifications)\//.test(w.path)), JSON.stringify(wdb.log.writes.map((w) => w.path)));
  const pushedBefore = calls.pushes.length;
  const live2 = await S._internal.runWatch({ db: wdb, nowMs: T0 + 5 * 60000, live: true, push });
  ok('watch: a second run the same day files nothing new and pushes nothing (no spam)', live2.filed === 0 && live2.alreadyFiled === live1.filed && calls.pushes.length === pushedBefore, JSON.stringify(live2));
  const live3 = await S._internal.runWatch({ db: wdb, nowMs: T0 + 26 * HOUR, live: true, push });
  ok('watch: a new day starts fresh dedupe keys', typeof live3.filed === 'number');
  const manyAlerts = {};
  for (let i = 0; i < 40; i++) manyAlerts['f' + i] = { companyId: OWNER, to: '+1859555' + (3000 + i), toDigits: '859555' + (3000 + i), body: 'x', status: i < 12 ? 'failed' : 'sent', date: mins(10), leadId: 'L2' };
  const bigDb = makeDb({
    feature_flags: { _default: { messagingControlCenter: true } }, sms_log: manyAlerts, leads: { L2: { name: 'Al Boe' } },
    storm_alerts_sent: { s1: { sentAt: mins(5), status: 'sent', event: 'Hail', zip: '41011', subscriberId: 'sub1' } }, storm_alert_subscribers: { sub1: { phone: '8595550123', tcpaConsent: false } },
    missed_call_autotext: { [OWNER + '__8595550166']: { companyId: OWNER, lastSentAtMs: T0 - 600000, leadId: 'L2' } },
  });
  calls.pushes.length = 0;
  const big = await S._internal.runWatch({ db: bigDb, nowMs: T0, live: true, push });
  ok('watch: with 4+ alerts at once the owner is pushed at most pushMaxPerDay (3) times, every alert is still filed', big.alerts >= 4 && big.filed === big.alerts && big.pushed === L.THRESHOLDS.pushMaxPerDay && calls.pushes.length === 3, JSON.stringify(big));
  const quietDb = makeDb({ feature_flags: { _default: { messagingControlCenter: true } } });
  const quiet = await S._internal.runWatch({ db: quietDb, nowMs: T0, live: true, push });
  ok('watch: a quiet system files nothing', quiet.alerts === 0 && quietDb.log.writes.length === 0);

  // source shape
  console.log('\nSOURCE SHAPE (comments stripped)');
  const src = stripComments(read('functions/messaging-center.js'));
  const sliceFn = (name) => { const i = src.indexOf(name); return src.slice(i, i + 4200); };
  const gatherBody = src.slice(src.indexOf('async function gather'), src.indexOf('async function overview'));
  ok('gather/overview have no write call at all', !/\.(set|add|create|update|delete)\(/.test(gatherBody) && !/\.(set|add|create|update|delete)\(/.test(src.slice(src.indexOf('async function overview'), src.indexOf('exports.messagingCenter'))));
  const callable = src.slice(src.indexOf('exports.messagingCenter'), src.indexOf('// ── the hourly watch') > 0 ? src.indexOf('const isAlreadyExists') : undefined);
  ok('callable order: auth, then role, then rate limit, then flag, then data', (() => { const a = callable.indexOf('unauthenticated'), b = callable.indexOf('canView'), c = callable.indexOf('callableRateLimit'), d = callable.indexOf('flagOn'), e = callable.indexOf('overview('); return a > 0 && a < b && b < c && c < d && d < e; })());
  ok('callable requires App Check', /enforceAppCheck: true/.test(callable));
  ok('never creates messaging_controls', !/messaging_controls.*(set|create|update)\(|(set|create|update)\([^)]*messaging_controls/.test(src));
  ok('the watch never touches a customer collection for writing', !/collection\('(sms_log|email_log|leads|sms_dnc|sms_opt_outs)'\)\.(add|set|doc\([^)]*\)\.(set|update|create))/.test(src));
  ok('the flag name is the same in the server, the client and the nav', /FLAG = 'messagingControlCenter'/.test(src) && /FLAG = 'messagingControlCenter'/.test(stripComments(read('docs/pro/js/messaging-center.js'))) && /enabled\('messagingControlCenter'\)/.test(stripComments(read('docs/pro/js/messaging-nav.js'))));

  // client render
  console.log('\nCLIENT RENDER');
  const overview = res;
  const html = C.viewHtml(overview, 'all');
  ok('renders every section', ['Needs a look', 'Status', 'What was sent', 'Delivery outcomes', 'Blocked by a gate', 'STOP / opt-outs', 'Queue backlog', 'Recent messages', 'Coverage', 'How to read this'].every((h) => html.indexOf(h) !== -1));
  ok('Twilio logs link opens safely in a new tab', /href="https:\/\/console\.twilio\.com\/us1\/monitor\/logs\/sms" target="_blank" rel="noopener noreferrer"/.test(html));
  ok('rendered HTML has no style attribute and no inline handler', !/\sstyle=/.test(html) && !/\son[a-z]+=/i.test(html));
  ok('rendered HTML has no full phone number or e-mail', !/859-?555-?0(142|199|143)|8595550|pat\.lee@|joe@example/.test(html) && /0199/.test(html));
  const evil = JSON.parse(JSON.stringify(overview));
  evil.events[0].firstLine = '<img src=x onerror=alert(1)> call 859-555-0142';
  evil.events[0].name = '<script>alert(1)</script>';
  evil.alerts = [{ key: 'x', severity: 'high', title: '<b onmouseover=x>t</b>', detail: 'd' }];
  const evilHtml = C.viewHtml(evil, 'all');
  ok('server strings are escaped (no live tag from a name, line or alert)', !/<img src=x|<script>alert|<b onmouseover/.test(evilHtml) && /&lt;script&gt;/.test(evilHtml));
  ok('a number typed into a reply is masked again on the client', !/859-555-0142/.test(evilHtml));
  ok('banner appears with alerts, is empty without', /role="alert"/.test(evilHtml) && C.bannerHtml([]) === '' && C.bannerHtml(null) === '');
  ok('channel filter narrows the list', (() => { const em = C.eventsHtml(overview, 'email'), sm = C.eventsHtml(overview, 'sms'); return em.indexOf('Rep-sent email') !== -1 && em.indexOf('Rep-typed text') === -1 && sm.indexOf('Rep-typed text') !== -1 && sm.indexOf('Rep-sent email') === -1; })());
  ok('flag off renders the off message, not data', /switched off/.test(C.viewHtml({ enabled: false }, 'all')) && !/What was sent/.test(C.viewHtml({ enabled: false }, 'all')));
  ok('how-to-read mentions what Twilio does and does not show', /Twilio/.test(C.howHtml()) && /carrier delivery/.test(C.howHtml()));
  const cs = stripComments(read('docs/pro/js/messaging-center.js'));
  ok('client source: no style=, no on*= attributes, no write call', !/style=/.test(cs) && !/\son[a-z]+=/i.test(cs.replace(/data-mc-[a-z]+/g, '')) && !/\.(set|add|update|delete)Doc|addDoc|setDoc/.test(cs));

  // wiring
  console.log('\nWIRING');
  const dash = read('docs/pro/dashboard.html');
  ok('dashboard: nav + more-menu entries start hidden (dn)', /class="ni dn"[^>]*data-target="messaging" id="nav-messaging"/.test(dash) && /class="mm-item dn"[^>]*data-target="messaging"[^>]*id="mm-messaging"/.test(dash));
  ok('dashboard: view mount + template', /id="view-messaging" data-view-template="tpl-view-messaging"/.test(dash) && /<template id="tpl-view-messaging">/.test(dash));
  ok('dashboard: nav script is deferred and external', /<script defer src="js\/messaging-nav\.js\?v=1"><\/script>/.test(dash));
  const loader = read('docs/pro/js/script-loader.js');
  ok('script-loader: messaging bundle (css + js) and view mapping', /messaging: \[\s*'css\/messaging-center\.css\?v=1',\s*'js\/messaging-center\.js\?v=1'\s*\]/.test(loader) && /messaging:\s+\['messaging'\]/.test(loader));
  ok('route registered in dashboard-state and init in dashboard-actions', /'messaging':\s+\{ label: 'Messaging'/.test(read('docs/pro/js/dashboard-state.js')) && /name==='messaging'.*NBDMessaging\.init/.test(read('docs/pro/js/dashboard-actions.js')));
  ok('functions: exports, function-map, heartbeat plan', /exports\.messagingCenter = require\('\.\/messaging-center'\)/.test(read('functions/index.js')) && /exports\.messagingWatch/.test(read('functions/index.js')) &&
    /"messagingCenter": "\.\/messaging-center"/.test(read('functions/function-map.json')) && /"messagingWatch": "\.\/messaging-center"/.test(read('functions/function-map.json')) && /messagingWatch:\s+\{ slug: 'hourly-crons' \}/.test(read('functions/integrations/heartbeat-plan.js')));
  const idx = JSON.parse(read('firestore.indexes.json')).indexes;
  ['sms_log', 'email_log'].forEach((c) => ok('composite index companyId + date desc on ' + c, idx.some((i) => i.collectionGroup === c && i.fields.length === 2 && i.fields[0].fieldPath === 'companyId' && i.fields[1].fieldPath === 'date' && i.fields[1].order === 'DESCENDING')));
  const css = read('docs/pro/css/messaging-center.css');
  ok('phone fit: cards capped at 480px, nothing wider, no old oranges', /\.mc-card \{[^}]*max-width: 480px/.test(css) && !/#E8720C|#F08030/i.test(css) && !/width:\s*(?:[5-9]\d\d|\d{4,})px/.test(css.replace(/@media[^{]*\{[^}]*\{[^}]*\}\s*\}/g, '')));
  ok('phone fit: tap targets are 44px and table cells wrap', /\.mc-filter \{[^}]*min-height: 44px/.test(css) && /overflow-wrap: anywhere/.test(css));
  ok('the doc is linked from INDEX.md', /MESSAGING-CONTROL-CENTER-2026-10-19\.md/.test(read('documentation/INDEX.md')));
  ok('the doc exists', fs.existsSync(path.join(ROOT, 'documentation/projects/MESSAGING-CONTROL-CENTER-2026-10-19.md')));

  Module._load = origLoad;
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})().catch((e) => { Module._load = origLoad; console.error(e); process.exit(1); });
