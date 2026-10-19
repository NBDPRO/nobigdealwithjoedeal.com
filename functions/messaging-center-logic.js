'use strict';
/**
 * messaging-center-logic.js (2026-10-19): the PURE half of the read-only
 * Messaging Control Center. No Firestore, no network, no clock: callers pass
 * rows and `nowMs`. Zero deps, so tests/messaging-center-2026-10-19.test.js
 * loads it in a vm sandbox.
 *
 * It does not invent a log. Every outbound sender already leaves a ledger
 * (sms_log, email_log, alert_outbox, storm_alerts_sent, missed_call_autotext,
 * the lead stamps ackEmailSentAt / ackSmsSentAt / followUpEmailSentAt /
 * reviewAutoAsk); `from*` turn one row of each into a normalised event, and
 * everything after that (counts, outcomes, blocked reasons, "needs a look",
 * alert thresholds) is computed over those events.
 *
 * PRIVACY: events carry the raw recipient key only inside the server.
 * `publicEvent` is the ONLY way an event leaves; it returns a masked phone
 * (last 4) or masked email, the lead's name, a template id and the first line
 * (<= 80 chars). Customer reply bodies are clipped to 80 chars.
 */

const HOUR = 3600000;
const DAY = 86400000;
const DEFAULT_TZ = 'America/New_York';
const CENTRAL_TZ = 'America/Chicago';
const WINDOW_START_H = 8;   // 8am inclusive (sms-outbox-guard SEND_WINDOW)
const WINDOW_END_H = 21;    // 9pm exclusive
const LINE_MAX = 80;

/** Roles that may open the view (client AND the callable use the same list). */
const VIEW_ROLES = Object.freeze(['owner', 'admin', 'company_admin']);

/**
 * ALL alert thresholds live here (Jo: one config object). The scheduled watch
 * and the on-screen banner read the same numbers.
 */
const THRESHOLDS = Object.freeze({
  errorRatePctPerHour: 10,     // failed / attempted in the last hour, over this = alert
  errorRateMinSends: 5,        // ...but only with at least this many attempts (1 of 1 is not a trend)
  maxSendsPerHour: 30,         // customer-facing sends (SMS + email) in the last hour
  noConsentMax: 0,             // automated customer texts with no consent record
  highRiskFiredMax: 0,         // any HIGH-risk automation firing at all
  afterOptOutMax: 0,           // a text sent after the number opted out
  outsideCampaignMax: 0,       // a text from an automation the A2P campaign does not cover
  spikeFactor: 3,              // last hour vs the average hour of the prior 7 days
  spikeMinSends: 10,           // ...only counted above this many sends in the hour
  maxSendsPerDay: 150,         // all customer-facing sends in the local day
  duplicateWindowH: 24,        // same person, same channel
  perRecipientPerDaySms: 5,    // mirrors sendSMS' own 5/day/recipient cap
  pushMaxPerDay: 3,            // the watch never pushes Jo more than this a day
});

const CARRIER_CODES = Object.freeze({
  '21610': 'Recipient replied STOP (carrier blocked it)',
  '21211': 'Not a valid phone number',
  '21614': 'Not a mobile number',
  '30003': 'Handset unreachable',
  '30004': 'Recipient blocked the sender',
  '30005': 'Unknown destination',
  '30006': 'Landline or unreachable carrier',
  '30007': 'Carrier filtered the message as spam',
  '30008': 'Unknown carrier error',
  '30034': 'Number not registered for A2P 10DLC',
});
const LOOK_CODE_RE = /^(21\d{3}|30\d{3})$/;

/**
 * Every outbound sender the inventory (2026-10-19) lists that this center can
 * see, plus the ones it cannot. customer: reaches a homeowner. campaign:
 * 'registered' = inside the approved A2P campaign, 'outside' = NOT covered by
 * it, 'manual' = a human typed it. auto: no per-message human approval.
 */
const AUTOMATIONS = Object.freeze({
  rep_text:           { label: 'Rep-typed text',                 channel: 'sms',   risk: 'MED',  customer: true,  auto: false, campaign: 'manual',     perDay: 100 },
  outbox_text:        { label: 'Offline outbox text',            channel: 'sms',   risk: 'MED',  customer: true,  auto: false, campaign: 'manual',     perDay: 100 },
  d2d_text:           { label: 'Door-knock template text',       channel: 'sms',   risk: 'MED',  customer: true,  auto: false, campaign: 'manual',     perDay: 100 },
  ai_reply:           { label: 'AI reply (rep approved)',        channel: 'sms',   risk: 'MED',  customer: true,  auto: false, campaign: 'registered', perDay: 100 },
  storm_alert:        { label: 'Storm alert text',               channel: 'sms',   risk: 'HIGH', customer: true,  auto: true,  campaign: 'registered', perDay: 2000 },
  lead_ack_text:      { label: 'Estimate-request ack text',      channel: 'sms',   risk: 'HIGH', customer: true,  auto: true,  campaign: 'registered', perDay: 100 },
  missed_call_text:   { label: 'Missed-call auto text',          channel: 'sms',   risk: 'HIGH', customer: true,  auto: true,  campaign: 'outside',    perDay: 50 },
  review_ask_text:    { label: 'Review ask text',                channel: 'sms',   risk: 'HIGH', customer: true,  auto: true,  campaign: 'outside',    perDay: 50 },
  owner_lead_alert_sms:   { label: 'New-lead text to owner',     channel: 'sms',   risk: 'LOW',  customer: false, auto: true,  campaign: 'manual',     perDay: 60 },
  lead_ack_email:     { label: 'Lead ack email',                 channel: 'email', risk: 'HIGH', customer: true,  auto: true,  campaign: 'manual',     perDay: 100 },
  lead_followup_email:{ label: '20-48h follow-up email',         channel: 'email', risk: 'HIGH', customer: true,  auto: true,  campaign: 'manual',     perDay: 100 },
  review_ask_email:   { label: 'Review ask email',               channel: 'email', risk: 'HIGH', customer: true,  auto: true,  campaign: 'manual',     perDay: 50 },
  rep_email:          { label: 'Rep-sent email (CRM)',           channel: 'email', risk: 'MED',  customer: true,  auto: false, campaign: 'manual',     perDay: 200 },
  owner_lead_alert_email: { label: 'New-lead email to owner',    channel: 'email', risk: 'LOW',  customer: false, auto: true,  campaign: 'manual',     perDay: 60 },
  owner_lead_alert_push:  { label: 'New-lead push to owner',     channel: 'push',  risk: 'LOW',  customer: false, auto: true,  campaign: 'manual',     perDay: 60 },
});

/** Automations whose sends the center cannot see yet (no ledger row exists). */
const BLIND_SPOTS = Object.freeze([
  { key: 'funnel_recovery_email', label: 'Abandoned-estimate recovery email', note: 'Claim doc only; dark until FUNNEL_RECOVERY_ENABLED.' },
  { key: 'otp_sms', label: 'Verification code texts (Twilio Verify)', note: 'Twilio Verify keeps its own log: use Twilio console.' },
  { key: 'queue_email', label: 'Dunning, trial, erasure and health emails (email_queue)', note: 'Shown under Queue backlog, not in counts.' },
  { key: 'refusals', label: 'Refusals that write no row (STOP, DNC, quiet hours, master switch, daily cap)', note: 'Returned to the caller as an error; nothing is stored. Closing this needs one shared ledger (follow-up).' },
  { key: 'voice', label: 'Outbound voice', note: 'No outbound calling code exists in the repo.' },
]);

const BLOCK_REASONS = Object.freeze(['no_consent', 'opted_out', 'quiet_hours', 'kill_switch', 'daily_cap', 'dnc', 'other']);
const BLOCK_LABELS = Object.freeze({
  no_consent: 'No consent', opted_out: 'Opted out (STOP)', quiet_hours: 'Quiet hours', kill_switch: 'Kill switch / texting off',
  daily_cap: 'Daily cap', dnc: 'Do-not-text list', other: 'Other refusal',
});

/** Env flag name -> automation key, so the status strip can show ON/OFF per automation. */
const AUTOMATION_FLAGS = Object.freeze({
  storm_alert: ['STORM_TEXT_ENABLED'],
  lead_ack_text: ['LEAD_ACK_SMS_ENABLED'],
  missed_call_text: ['MISSED_CALL_AUTOTEXT_ENABLED'],
  review_ask_text: ['REVIEW_ASK_AUTO_TEXT_ENABLED'],
  review_ask_email: ['REVIEW_ASK_AUTO_EMAIL_ENABLED'],
  lead_followup_email: ['LEAD_FOLLOWUP_ENABLED'],
});

// ── tiny helpers ──────────────────────────────────────────────────────────
const str = (v) => (v == null ? '' : String(v));
const digits = (v) => str(v).replace(/\D/g, '');
/** Canonical last-10 key (same shape as sms-optout.optOutKey). */
function phoneKey(v) { const d = digits(v); return d.length >= 10 ? d.slice(-10) : ''; }
function toMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return v > 0 ? v : 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

function maskPhone(v) {
  const d = digits(v);
  return d.length >= 4 ? '(•••) •••-' + d.slice(-4) : 'unknown number';
}
function maskEmail(v) {
  const s = str(v).trim().toLowerCase();
  const m = /^([^@\s]+)@([^@\s]+)\.([a-z0-9-]{2,})$/.exec(s);
  if (!m) return 'unknown email';
  return m[1].charAt(0) + '•••@' + m[2].charAt(0) + '•••.' + m[3];
}
/** First line of a message, hard-clipped. Never more than `max` chars. */
function clipLine(text, max) {
  const n = max || LINE_MAX;
  const line = str(text).replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean)[0] || '';
  return line.length > n ? line.slice(0, n - 1).trimEnd() + '…' : line;
}
/** Mask any e-mail or phone-looking run inside free text (a customer can type their number into a reply). */
function scrubText(t) {
  return str(t)
    .replace(/[^\s@<>()]+@[^\s@<>()]+\.[a-z]{2,}/gi, (m) => maskEmail(m))
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (m) => (digits(m).length >= 7 ? maskPhone(m) : m));
}
function shortName(n) {
  const s = str(n).trim().replace(/\s+/g, ' ');
  if (!s || /@/.test(s)) return '';
  const p = s.split(' ');
  return p.length > 1 ? p[0] + ' ' + p[p.length - 1].charAt(0) + '.' : p[0];
}

function canView(claims, uid, ownerUid) {
  if (!uid) return false;
  if (ownerUid && uid === ownerUid) return true;
  const c = claims || {};
  const role = str(c.role).toLowerCase();
  if (VIEW_ROLES.indexOf(role) !== -1) return true;
  // A solo owner carries no role claim and is their own company (same rule as prod-flags-panel.js).
  if (!role) return !c.companyId || c.companyId === uid;
  return false;
}

// ── time zone ─────────────────────────────────────────────────────────────
function hourIn(ms, tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const h = p.find((x) => x.type === 'hour');
    return h ? Number(h.value) : NaN;
  } catch (_) { return NaN; }
}
function ymdIn(ms, tz) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms)); }
  catch (_) { return new Date(ms).toISOString().slice(0, 10); }
}
/** Start of the local day containing `ms` in `tz` (ms). */
function startOfDay(ms, tz) {
  const ymd = ymdIn(ms, tz);
  // Walk back to local midnight: at most 26 steps of one hour.
  let t = ms - (ms % HOUR);
  for (let i = 0; i < 26; i++) {
    if (ymdIn(t - HOUR, tz) !== ymd) return t;
    t -= HOUR;
  }
  return t;
}
/** Zones a recipient's local-time window must hold in (KY straddles two). */
function zonesFor(state) {
  const s = str(state).toUpperCase();
  return s === 'KY' ? [DEFAULT_TZ, CENTRAL_TZ] : [DEFAULT_TZ];
}
function outsideWindow(ms, state) {
  return zonesFor(state).some((tz) => {
    const h = hourIn(ms, tz);
    return !(h >= WINDOW_START_H && h < WINDOW_END_H);
  });
}

// ── consent ───────────────────────────────────────────────────────────────
/** What the stored record says about texting this person. */
function consentOf(rec) {
  if (!rec) return 'none';
  if (rec.tcpaConsent === true || rec.smsConsent === true) return 'form';
  return 'none';
}

// ── status / outcome ──────────────────────────────────────────────────────
function codeOf(v) { const c = digits(v); return c ? c.slice(0, 8) : ''; }
function smsOutcome(status, deliveryStatus, errorCode) {
  const d = str(deliveryStatus).toLowerCase();
  if (d === 'delivered') return 'delivered';
  if (d === 'undelivered') return 'undelivered';
  if (d === 'failed') return 'failed';
  const s = str(status).toLowerCase();
  if (s === 'failed' || s === 'send_failed') return 'failed';
  if (s === 'sent' || s === 'accepted' || s === 'queued') return 'sent';
  if (errorCode) return 'failed';
  return 'unknown';
}
/** alert_outbox smsDelivery 'delivered' | 'undelivered:<code>' | 'failed:<code>'. */
function parseDelivery(v) {
  const m = /^(delivered|undelivered|failed)(?::(\d+))?$/.exec(str(v));
  return m ? { status: m[1], code: m[2] || '' } : { status: '', code: '' };
}

// ── normalisers: one ledger row -> one event ──────────────────────────────
function base(o) {
  return Object.assign({
    id: '', channel: 'sms', automation: 'rep_text', atMs: 0, outcome: 'unknown', errorCode: '', toKey: '',
    toDisplay: '', name: '', templateId: '', text: '', consent: 'n/a', state: '', internal: false,
    blockedReason: '', source: '',
  }, o);
}

function smsAutomation(d) {
  if (d.knockId) return 'd2d_text';
  const src = str(d.source);
  if (src === 'ai_draft') return 'ai_reply';
  if (d.queued === true) return 'outbox_text';
  return 'rep_text';
}

/** blocked reason for a refusal that DID leave a row. '' when the row is not a refusal. */
function blockedReasonOf(failureReason, errorCode, status) {
  const f = str(failureReason);
  if (f === 'consent_declined') return 'no_consent';
  if (f === 'opted_out' || errorCode === '21610') return 'opted_out';
  if (f === 'consent_check_unverified') return 'other';
  if (/quiet/.test(f)) return 'quiet_hours';
  if (/texting_|switched_off|kill/.test(f)) return 'kill_switch';
  if (/cap|limit/.test(f)) return 'daily_cap';
  if (/dnc/.test(f)) return 'dnc';
  if (status === 'suppressed') return 'opted_out';
  if (status === 'blocked_no_postal_address') return 'other';
  return '';
}

function fromSmsLog(id, d, lead) {
  if (!d || str(d.status) === 'received') return null;
  const code = codeOf(d.deliveryErrorCode || d.errorCode);
  const reason = blockedReasonOf(d.failureReason, code, str(d.status));
  const automation = smsAutomation(d);
  const consentRec = consentOf(lead);
  return base({
    id: 'sms_' + id, channel: 'sms', automation, atMs: toMs(d.sentAt || d.date), errorCode: code,
    outcome: reason ? 'blocked' : smsOutcome(d.status, d.deliveryStatus, code),
    blockedReason: reason, toKey: phoneKey(d.toDigits || d.to), toDisplay: maskPhone(d.toDigits || d.to),
    name: shortName(lead && (lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' '))),
    templateId: str(d.source) || (automation === 'd2d_text' ? 'd2d_template' : 'rep_typed'),
    text: str(d.body), state: str(lead && lead.state),
    // Rep-typed texts need no stored consent; a form tick, when present, is shown.
    consent: automation === 'ai_reply' ? 'inbound' : (consentRec === 'form' ? 'form' : 'rep'),
    source: 'sms_log',
  });
}

function fromEmailLog(id, d, lead) {
  if (!d) return null;
  const status = str(d.status);
  const reason = blockedReasonOf('', '', status);
  return base({
    id: 'em_' + id, channel: 'email', automation: 'rep_email', atMs: toMs(d.sentAt || d.date),
    outcome: reason ? 'blocked' : (status === 'sent' ? 'sent' : (status === 'failed' ? 'failed' : 'unknown')),
    blockedReason: reason, toKey: str(d.to).trim().toLowerCase(), toDisplay: maskEmail(d.to),
    name: shortName(lead && (lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' '))),
    templateId: str(d.kind) || 'rep_email', text: str(d.subject), consent: 'n/a', source: 'email_log',
  });
}

/** alert_outbox row -> up to three internal events (sms / email / push to the owner). */
function fromAlertOutbox(id, d) {
  if (!d) return [];
  const atMs = toMs(d.createdAt);
  const out = [];
  const t = d.target || {};
  const label = (t.name ? t.name + ' ' : '') + str(d.collection);
  if (d.smsStatus && !/^skipped/.test(str(d.smsStatus))) {
    const dl = parseDelivery(d.smsDelivery);
    const code = dl.code;
    out.push(base({
      id: 'ao_sms_' + id, channel: 'sms', automation: 'owner_lead_alert_sms', atMs, errorCode: code, internal: true,
      outcome: dl.status || smsOutcome(d.smsStatus, '', ''), toKey: phoneKey(t.sms), toDisplay: maskPhone(t.sms),
      name: 'Owner', templateId: 'lead-alert', text: 'New lead: ' + label.trim(), source: 'alert_outbox',
    }));
  }
  if (d.emailStatus && !/^skipped/.test(str(d.emailStatus))) {
    const e = str(d.emailStatus);
    const emails = Array.isArray(t.emails) ? t.emails : [t.emails];
    out.push(base({
      id: 'ao_em_' + id, channel: 'email', automation: 'owner_lead_alert_email', atMs, internal: true,
      outcome: e === 'sent' ? 'sent' : (/^failed/.test(e) ? 'failed' : 'unknown'),
      toKey: str(emails[0]).toLowerCase(), toDisplay: maskEmail(emails[0]), name: 'Owner', templateId: 'lead-alert',
      text: 'New lead: ' + label.trim(), source: 'alert_outbox',
    }));
  }
  if (d.pushStatus && !/^skipped/.test(str(d.pushStatus))) {
    const p = str(d.pushStatus);
    out.push(base({
      id: 'ao_push_' + id, channel: 'push', automation: 'owner_lead_alert_push', atMs, internal: true,
      outcome: p === 'sent' ? 'sent' : (/^failed/.test(p) ? 'failed' : 'unknown'),
      toDisplay: 'owner devices', name: 'Owner', templateId: 'lead-alert', text: 'New lead: ' + label.trim(), source: 'alert_outbox',
    }));
  }
  return out;
}

/** storm_alerts_sent claim (+ its subscriber doc for the number and consent). */
function fromStormClaim(id, d, sub) {
  if (!d) return null;
  const st = str(d.status);
  return base({
    id: 'storm_' + id, channel: 'sms', automation: 'storm_alert', atMs: toMs(d.sentAt || d.claimedAt),
    outcome: st === 'failed' ? 'failed' : (st === 'sent' ? 'sent' : 'sent'),
    errorCode: '', toKey: phoneKey(sub && sub.phone), toDisplay: maskPhone(sub && sub.phone), name: shortName(sub && sub.name),
    templateId: 'storm_alert', text: 'Storm Alert: ' + str(d.event) + ' near ' + str(d.zip),
    consent: sub && sub.tcpaConsent === true ? 'subscriber' : 'none', state: str(sub && sub.state), source: 'storm_alerts_sent',
  });
}

function fromMissedCallClaim(id, d, lead) {
  if (!d || !toMs(d.lastSentAtMs)) return null;
  const key = phoneKey(str(id).split('__')[1] || '');
  return base({
    id: 'mc_' + id, channel: 'sms', automation: 'missed_call_text', atMs: toMs(d.lastSentAtMs), outcome: 'sent',
    toKey: key, toDisplay: maskPhone(key), name: shortName(lead && (lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' '))),
    templateId: 'missed_call_reply', text: 'Sorry I missed your call', consent: consentOf(lead), state: str(lead && lead.state),
    source: 'missed_call_autotext',
  });
}

/** Public lead doc stamps: ack email / ack text / follow-up email. */
function fromLeadStamps(collection, id, d) {
  const out = [];
  if (!d) return out;
  const phone = d.phone || d.phoneNumber;
  const name = shortName(d.name || [d.firstName, d.lastName].filter(Boolean).join(' '));
  const common = { name, state: str(d.state), source: collection };
  if (d.ackEmailSentAt) {
    out.push(base(Object.assign({}, common, { id: 'ack_em_' + collection + '_' + id, channel: 'email', automation: 'lead_ack_email', atMs: toMs(d.ackEmailSentAt),
      outcome: 'sent', toKey: str(d.email).trim().toLowerCase(), toDisplay: maskEmail(d.email), templateId: 'lead_ack', text: 'Got it — Joe here. What happens next' })));
  }
  if (d.ackSmsSentAt) {
    out.push(base(Object.assign({}, common, { id: 'ack_sms_' + collection + '_' + id, channel: 'sms', automation: 'lead_ack_text', atMs: toMs(d.ackSmsSentAt),
      outcome: 'sent', toKey: phoneKey(phone), toDisplay: maskPhone(phone), templateId: 'lead_ack_sms', text: 'Got your estimate request',
      consent: consentOf(d) })));
  }
  if (d.followUpEmailSentAt) {
    out.push(base(Object.assign({}, common, { id: 'fu_em_' + collection + '_' + id, channel: 'email', automation: 'lead_followup_email', atMs: toMs(d.followUpEmailSentAt),
      outcome: str(d.followUpEmailStatus) === 'failed' ? 'failed' : 'sent', toKey: str(d.email).trim().toLowerCase(), toDisplay: maskEmail(d.email),
      templateId: 'lead_followup', text: "We haven't connected yet — Joe" })));
  }
  return out;
}

/** leads/{id}.reviewAutoAsk (status 'sent' only; a 'sending' claim is not a send). */
function fromReviewAsk(id, d) {
  const a = d && d.reviewAutoAsk;
  if (!a || a.status !== 'sent') return null;
  const text = a.channel === 'text';
  const phone = d.phone || d.phoneNumber;
  return base({
    id: 'rv_' + id + '_' + str(a.jobId), channel: text ? 'sms' : 'email', automation: text ? 'review_ask_text' : 'review_ask_email',
    atMs: toMs(a.sentAtMs) || toMs(d.reviewRequestedAt), outcome: 'sent',
    toKey: text ? phoneKey(phone) : str(d.email).trim().toLowerCase(), toDisplay: text ? maskPhone(phone) : maskEmail(d.email),
    name: shortName(d.name || [d.firstName, d.lastName].filter(Boolean).join(' ')), templateId: text ? 'review_ask_text' : 'review_ask_email',
    text: 'Would you leave us a Google review?', consent: text ? consentOf(d) : 'n/a', state: str(d.state), source: 'leads',
  });
}

// ── gate result for one event ─────────────────────────────────────────────
function gateOf(ev, ctx) {
  const c = ctx || {};
  const notes = [];
  let result = 'pass';
  const bump = (r) => { if (r === 'fail' || (r === 'warn' && result === 'pass')) result = r; };
  const spec = AUTOMATIONS[ev.automation] || {};
  if (ev.outcome === 'blocked') return { result: 'blocked', notes: ['Refused: ' + (BLOCK_LABELS[ev.blockedReason] || 'refused')] };
  if (spec.customer && ev.channel === 'sms') {
    if (ev.consent === 'none') { notes.push('no consent record'); bump(spec.auto ? 'fail' : 'warn'); }
    else if (ev.consent === 'form') notes.push('consent: website form');
    else if (ev.consent === 'subscriber') notes.push('consent: storm signup');
    else if (ev.consent === 'inbound') notes.push('customer texted first');
    else notes.push('rep-initiated');
    if (ev.atMs && outsideWindow(ev.atMs, ev.state)) { notes.push('outside 8am-9pm'); bump('fail'); }
    else notes.push('in hours');
    if (c.optOutAtMs && ev.toKey && c.optOutAtMs[ev.toKey] && ev.atMs > c.optOutAtMs[ev.toKey]) { notes.push('sent after STOP'); bump('fail'); }
    if (spec.campaign === 'outside') { notes.push('not in A2P campaign'); bump('warn'); }
  } else if (!spec.customer) notes.push('internal alert');
  else notes.push('commercial gate applies');
  return { result, notes };
}

// ── masked, client-safe event ─────────────────────────────────────────────
function publicEvent(ev, ctx) {
  const spec = AUTOMATIONS[ev.automation] || { label: ev.automation, risk: 'MED' };
  const g = gateOf(ev, ctx);
  return {
    id: ev.id, atMs: ev.atMs, channel: ev.channel, automation: ev.automation, automationLabel: spec.label, risk: spec.risk,
    internal: !!ev.internal, name: scrubText(ev.name || ''), recipient: ev.toDisplay || '', templateId: ev.templateId,
    firstLine: clipLine(scrubText(ev.text), LINE_MAX), outcome: ev.outcome, errorCode: ev.errorCode || '',
    errorLabel: CARRIER_CODES[ev.errorCode] || '', gate: g.result, gateNotes: g.notes, consent: ev.consent,
  };
}

// ── aggregation ───────────────────────────────────────────────────────────
function emptyChannels() { return { sms: 0, email: 0, push: 0, voice: 0 }; }

function countWindow(events, sinceMs, untilMs) {
  const byChannel = emptyChannels();
  const byAutomation = {};
  let total = 0;
  for (const e of events) {
    if (e.outcome === 'blocked') continue;
    if (e.atMs < sinceMs || e.atMs > untilMs) continue;
    byChannel[e.channel] = (byChannel[e.channel] || 0) + 1;
    byAutomation[e.automation] = (byAutomation[e.automation] || 0) + 1;
    total++;
  }
  return { total, byChannel, byAutomation };
}

function outcomesOf(events, sinceMs) {
  const mk = () => ({ sent: 0, delivered: 0, failed: 0, undelivered: 0, unknown: 0 });
  const out = { sms: mk(), email: mk(), push: mk(), errorCodes: {} };
  for (const e of events) {
    if (e.atMs < sinceMs || e.outcome === 'blocked') continue;
    const bucket = out[e.channel];
    if (!bucket) continue;
    bucket[e.outcome] = (bucket[e.outcome] || 0) + 1;
    if (e.errorCode) out.errorCodes[e.errorCode] = (out.errorCodes[e.errorCode] || 0) + 1;
  }
  return out;
}

function blockedOf(events, sinceMs) {
  const byReason = {};
  BLOCK_REASONS.forEach((r) => { byReason[r] = 0; });
  let total = 0;
  for (const e of events) {
    if (e.atMs < sinceMs || e.outcome !== 'blocked') continue;
    byReason[BLOCK_REASONS.indexOf(e.blockedReason) === -1 ? 'other' : e.blockedReason]++;
    total++;
  }
  return { total, byReason };
}

function lastSendAt(events) {
  let m = 0;
  for (const e of events) if (e.outcome !== 'blocked' && !e.internal && e.atMs > m) m = e.atMs;
  return m || null;
}

// ── "needs a look" ────────────────────────────────────────────────────────
function lookItem(kind, severity, title, ev, ctx, extra) {
  return Object.assign({ id: kind + ':' + ev.id, kind, severity, title, atMs: ev.atMs, event: publicEvent(ev, ctx) }, extra || {});
}

function needsLook(events, nowMs, cfg, ctx) {
  const t = cfg || THRESHOLDS;
  const items = [];
  const since = nowMs - 7 * DAY;
  const recent = events.filter((e) => e.atMs >= since);

  for (const e of recent) {
    const spec = AUTOMATIONS[e.automation] || {};
    if (e.outcome === 'failed' || e.outcome === 'undelivered') {
      const carrier = e.errorCode && LOOK_CODE_RE.test(e.errorCode);
      items.push(lookItem(carrier ? 'carrier_error' : 'failed', e.internal ? 'warn' : 'high',
        (carrier ? 'Carrier error ' + e.errorCode + (CARRIER_CODES[e.errorCode] ? ': ' + CARRIER_CODES[e.errorCode] : '') : 'Send failed') +
        ' (' + (spec.label || e.automation) + ')', e, ctx));
    } else if (e.errorCode && LOOK_CODE_RE.test(e.errorCode)) {
      items.push(lookItem('carrier_error', 'high', 'Carrier error ' + e.errorCode + ' (' + (spec.label || e.automation) + ')', e, ctx));
    }
    if (spec.customer && e.channel === 'sms' && e.outcome !== 'blocked') {
      if (e.consent === 'none') {
        items.push(lookItem('no_consent', spec.auto ? 'high' : 'warn',
          (spec.auto ? 'Automated text to a number with no consent record' : 'Rep text to a lead with no stored consent') + ' (' + spec.label + ')', e, ctx, { automated: !!spec.auto }));
      }
      if (e.atMs && outsideWindow(e.atMs, e.state)) items.push(lookItem('quiet_hours', 'high', 'Text sent outside 8am-9pm recipient time (' + spec.label + ')', e, ctx));
      if (ctx && ctx.optOutAtMs && e.toKey && ctx.optOutAtMs[e.toKey] && e.atMs > ctx.optOutAtMs[e.toKey]) {
        items.push(lookItem('after_optout', 'high', 'Text sent after the number opted out (' + spec.label + ')', e, ctx));
      }
      if (spec.campaign === 'outside') items.push(lookItem('outside_campaign', 'warn', spec.label + ' is not covered by the registered A2P campaign', e, ctx));
    }
  }
  for (const b of (ctx && ctx.bounces) || []) {
    if (b.atMs >= since) items.push({ id: 'bounce:' + b.id, kind: 'bounce', severity: 'warn', title: 'Email ' + (b.reason === 'complaint' ? 'spam complaint' : 'bounced') + ' (address suppressed)', atMs: b.atMs, event: null });
  }

  // Same person, same channel, within the duplicate window, at least one automated.
  const groups = {};
  for (const e of recent) {
    const spec = AUTOMATIONS[e.automation] || {};
    if (!spec.customer || e.outcome === 'blocked' || !e.toKey) continue;
    (groups[e.channel + ':' + e.toKey] = groups[e.channel + ':' + e.toKey] || []).push(e);
  }
  const win = (t.duplicateWindowH || 24) * HOUR;
  Object.keys(groups).forEach((k) => {
    const g = groups[k].sort((a, b) => a.atMs - b.atMs);
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      const auto = (AUTOMATIONS[a.automation] || {}).auto || (AUTOMATIONS[b.automation] || {}).auto;
      if (b.atMs - a.atMs < win && auto) {
        items.push(lookItem('duplicate', 'warn', 'Two messages to the same person within ' + (t.duplicateWindowH || 24) + 'h (' + (AUTOMATIONS[a.automation] || {}).label + ' then ' + (AUTOMATIONS[b.automation] || {}).label + ')', b, ctx));
      }
    }
    // Per-recipient daily SMS cap.
    const sms = g.filter((x) => x.channel === 'sms');
    for (let i = 0; i < sms.length; i++) {
      const inDay = sms.filter((x) => x.atMs >= sms[i].atMs && x.atMs < sms[i].atMs + DAY).length;
      if (inDay > t.perRecipientPerDaySms) { items.push(lookItem('over_cap', 'high', 'More than ' + t.perRecipientPerDaySms + ' texts to one number in 24h', sms[i], ctx)); break; }
    }
  });
  // Per-automation daily cap (local day of the most recent events).
  const tz = (ctx && ctx.tz) || DEFAULT_TZ;
  const dayStart = startOfDay(nowMs, tz);
  const perAuto = {};
  recent.forEach((e) => { if (e.outcome !== 'blocked' && e.atMs >= dayStart) (perAuto[e.automation] = perAuto[e.automation] || []).push(e); });
  Object.keys(perAuto).forEach((k) => {
    const cap = (AUTOMATIONS[k] || {}).perDay;
    if (cap && perAuto[k].length > cap) items.push(lookItem('over_cap', 'high', (AUTOMATIONS[k].label) + ' fired ' + perAuto[k].length + ' times today (cap ' + cap + ')', perAuto[k][0], ctx));
  });

  const rank = { high: 0, warn: 1, info: 2 };
  return items.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (b.atMs - a.atMs));
}

// ── alerts (banner + watch) ───────────────────────────────────────────────
/**
 * Evaluate the THRESHOLDS config over events. Returns a list of
 * { key, severity, title, detail, count }. Pure: the watch and the banner
 * call it with the same arguments and get the same answer.
 */
function evaluateAlerts(events, nowMs, cfg, ctx) {
  const t = cfg || THRESHOLDS;
  const out = [];
  const hourAgo = nowMs - HOUR;
  const cust = events.filter((e) => (AUTOMATIONS[e.automation] || {}).customer && e.outcome !== 'blocked');
  const lastH = cust.filter((e) => e.atMs > hourAgo && e.atMs <= nowMs);

  const attempts = events.filter((e) => e.atMs > hourAgo && e.atMs <= nowMs && e.outcome !== 'blocked' && e.channel !== 'push');
  const bad = attempts.filter((e) => e.outcome === 'failed' || e.outcome === 'undelivered');
  if (attempts.length >= t.errorRateMinSends && (bad.length / attempts.length) * 100 > t.errorRatePctPerHour) {
    out.push({ key: 'error_rate', severity: 'high', count: bad.length,
      title: 'Message error rate is ' + Math.round((bad.length / attempts.length) * 100) + '% in the last hour',
      detail: bad.length + ' of ' + attempts.length + ' sends failed or were undelivered (limit ' + t.errorRatePctPerHour + '%).' });
  }
  if (lastH.length > t.maxSendsPerHour) {
    out.push({ key: 'volume_hour', severity: 'high', count: lastH.length,
      title: lastH.length + ' customer messages in the last hour', detail: 'The hourly limit is ' + t.maxSendsPerHour + '.' });
  }
  const priorHours = 7 * 24;
  const prior = cust.filter((e) => e.atMs > nowMs - 7 * DAY - HOUR && e.atMs <= hourAgo).length;
  const avg = prior / priorHours;
  if (lastH.length >= t.spikeMinSends && lastH.length > avg * t.spikeFactor) {
    out.push({ key: 'volume_spike', severity: 'warn', count: lastH.length,
      title: 'Volume spike: ' + lastH.length + ' in the last hour', detail: 'That is over ' + t.spikeFactor + 'x the usual hour (about ' + (Math.round(avg * 10) / 10) + ').' });
  }
  const dayStart = startOfDay(nowMs, (ctx && ctx.tz) || DEFAULT_TZ);
  const today = cust.filter((e) => e.atMs >= dayStart).length;
  if (today > t.maxSendsPerDay) {
    out.push({ key: 'volume_day', severity: 'high', count: today, title: today + ' customer messages today', detail: 'The daily limit is ' + t.maxSendsPerDay + '.' });
  }
  const day = events.filter((e) => e.atMs > nowMs - DAY);
  const noC = day.filter((e) => (AUTOMATIONS[e.automation] || {}).customer && (AUTOMATIONS[e.automation] || {}).auto && e.channel === 'sms' && e.outcome !== 'blocked' && e.consent === 'none');
  if (noC.length > t.noConsentMax) {
    out.push({ key: 'no_consent', severity: 'high', count: noC.length, title: noC.length + ' automated text(s) went to a number with no consent record',
      detail: 'Should always be zero. Open the Messaging view and read the Needs-a-look list.' });
  }
  const hi = day.filter((e) => (AUTOMATIONS[e.automation] || {}).risk === 'HIGH' && (AUTOMATIONS[e.automation] || {}).customer && e.outcome !== 'blocked');
  if (hi.length > t.highRiskFiredMax) {
    const names = Array.from(new Set(hi.map((e) => AUTOMATIONS[e.automation].label)));
    out.push({ key: 'high_risk', severity: 'warn', count: hi.length, title: 'HIGH-risk automation fired: ' + names.join(', '),
      detail: hi.length + ' send(s) in the last 24h from automations marked HIGH in the messaging inventory.' });
  }
  const ctxOpt = (ctx && ctx.optOutAtMs) || {};
  const afterStop = day.filter((e) => e.channel === 'sms' && (AUTOMATIONS[e.automation] || {}).customer && e.toKey && ctxOpt[e.toKey] && e.atMs > ctxOpt[e.toKey]);
  if (afterStop.length > t.afterOptOutMax) {
    out.push({ key: 'after_optout', severity: 'high', count: afterStop.length, title: afterStop.length + ' text(s) sent after the number opted out', detail: 'Stop the automation, then check the STOP register.' });
  }
  const outside = day.filter((e) => e.channel === 'sms' && (AUTOMATIONS[e.automation] || {}).campaign === 'outside' && e.outcome !== 'blocked');
  if (outside.length > t.outsideCampaignMax) {
    out.push({ key: 'outside_campaign', severity: 'warn', count: outside.length, title: outside.length + ' text(s) from an automation outside the registered A2P campaign',
      detail: 'Review asks and missed-call texts are not in the campaign description. Carriers can filter or suspend.' });
  }
  const rank = { high: 0, warn: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Dedupe key for one alert: one per alert kind per local day. */
function alertKey(alert, nowMs, tz) {
  return 'msgwatch_' + String(alert.key).replace(/[^a-z0-9_]/gi, '') + '_' + ymdIn(nowMs, tz || DEFAULT_TZ);
}

// ── status strip ──────────────────────────────────────────────────────────
function boolOrUnknown(v) { return v === true ? 'on' : (v === false ? 'off' : 'unknown'); }
/** messaging_controls/global is owned by another session: read it loosely, never create it. */
function controlsFrom(doc) {
  if (!doc) return { killSwitch: 'unknown', canary: 'unknown', present: false };
  // messaging_controls/global as written by manageMessagingControls (messaging-controls.js): customerSendsEnabled
  // is the master (true = sending allowed), so the kill switch is ON when it is anything but true.
  const kill = doc.customerSendsEnabled !== undefined ? doc.customerSendsEnabled !== true : doc.killSwitch !== undefined ? doc.killSwitch : (doc.kill !== undefined ? doc.kill : (doc.paused !== undefined ? doc.paused : (doc.enabled === false ? true : (doc.enabled === true ? false : undefined))));
  const canary = doc.canary !== undefined ? doc.canary : (doc.canaryMode !== undefined ? doc.canaryMode : (doc.mode ? doc.mode === 'canary' : undefined));
  return { killSwitch: boolOrUnknown(kill), canary: boolOrUnknown(canary === 'on' ? true : canary), present: true };
}

function automationRows(flagRows) {
  const byName = {};
  (flagRows || []).forEach((r) => { byName[r.name] = r; });
  return Object.keys(AUTOMATIONS).map((k) => {
    const spec = AUTOMATIONS[k];
    const names = AUTOMATION_FLAGS[k] || [];
    let state = 'ON';
    let flag = '';
    if (names.length) {
      flag = names[0];
      const r = byName[flag];
      state = r ? str(r.state).toUpperCase() : 'UNKNOWN';
    }
    return { key: k, label: spec.label, channel: spec.channel, risk: spec.risk, customer: spec.customer, campaign: spec.campaign, flag, state };
  });
}

// ── whole overview ────────────────────────────────────────────────────────
function buildOverview(input) {
  const i = input || {};
  const nowMs = i.nowMs;
  const tz = i.tz || DEFAULT_TZ;
  const events = (i.events || []).filter((e) => e && e.atMs).sort((a, b) => b.atMs - a.atMs);
  const ctx = { tz, optOutAtMs: i.optOutAtMs || {}, bounces: i.bounces || [] };
  const dayStart = startOfDay(nowMs, tz);
  const cfg = i.thresholds || THRESHOLDS;
  const alerts = evaluateAlerts(events, nowMs, cfg, ctx);
  return {
    generatedAtMs: nowMs,
    tz,
    status: Object.assign({
      texting: i.texting || { enabled: null, registered: null },
      a2pRegistered: i.a2pRegistered === true ? 'yes' : (i.a2pRegistered === false ? 'no' : 'unknown'),
      lastSendAtMs: lastSendAt(events),
      automations: automationRows(i.flagRows),
    }, controlsFrom(i.controls)),
    counts: {
      today: countWindow(events, dayStart, nowMs),
      d7: countWindow(events, nowMs - 7 * DAY, nowMs),
      d30: countWindow(events, nowMs - 30 * DAY, nowMs),
    },
    outcomes: outcomesOf(events, nowMs - 7 * DAY),
    blocked: blockedOf(events, nowMs - 30 * DAY),
    blockedLabels: BLOCK_LABELS,
    optOuts: i.optOuts || { total: 0, recent: [] },
    queues: i.queues || { items: [], pending: 0, failed: 0 },
    needsLook: needsLook(events, nowMs, cfg, ctx).slice(0, 60).map((x) => x),
    alerts,
    events: events.slice(0, 100).map((e) => publicEvent(e, ctx)),
    coverage: { sources: i.sources || {}, blind: BLIND_SPOTS },
    thresholds: cfg,
  };
}

/** Opt-out entries -> masked rows, newest first. */
function optOutRows(entries, limit) {
  const rows = (entries || []).map((e) => ({ atMs: toMs(e.addedAt || e.optedOutAt), last4: digits(e.phone || e.key).slice(-4), source: str(e.source) || 'stop_reply' }))
    .filter((r) => r.last4).sort((a, b) => b.atMs - a.atMs);
  return { total: rows.length, recent: rows.slice(0, limit || 10) };
}

/** Queue rows (email_queue, pending Agent-inbox drafts) -> aged backlog items, oldest first. */
function queueRows(items, nowMs) {
  const rows = (items || []).map((q) => ({ queue: q.queue, status: q.status, ageMs: Math.max(0, nowMs - toMs(q.atMs)), label: clipLine(q.label, 60), attempts: q.attempts || 0 }))
    .sort((a, b) => b.ageMs - a.ageMs);
  return { items: rows.slice(0, 40), pending: rows.filter((r) => r.status === 'pending').length, failed: rows.filter((r) => r.status === 'failed').length };
}

module.exports = {
  HOUR, DAY, DEFAULT_TZ, WINDOW_START_H, WINDOW_END_H, LINE_MAX, VIEW_ROLES, THRESHOLDS, CARRIER_CODES, AUTOMATIONS, BLIND_SPOTS,
  BLOCK_REASONS, BLOCK_LABELS, AUTOMATION_FLAGS,
  maskPhone, maskEmail, scrubText, clipLine, shortName, phoneKey, toMs, canView, hourIn, ymdIn, startOfDay, outsideWindow, zonesFor, consentOf,
  smsOutcome, parseDelivery, blockedReasonOf,
  fromSmsLog, fromEmailLog, fromAlertOutbox, fromStormClaim, fromMissedCallClaim, fromLeadStamps, fromReviewAsk,
  gateOf, publicEvent, countWindow, outcomesOf, blockedOf, needsLook, evaluateAlerts, alertKey, controlsFrom, automationRows, buildOverview,
  optOutRows, queueRows,
};
