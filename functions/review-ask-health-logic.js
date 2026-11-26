'use strict';
/**
 * review-ask-health-logic.js — carrier and complaint health for the review
 * ask, per company (plan G3, slice S3, 2026-11-26). PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What is counted, per company per ET day (review_ask_health/{companyId}_{ymd}):
 *   textSends / emailSends       the denominators
 *   c30007                       carrier filtering
 *   c30003 / c30005 / c30006     unreachable (handset, unknown, landline)
 *   c21610                       sent to a number that had already said STOP
 *   c30034                       unregistered A2P traffic
 *   stops                        STOP replies to a review text (14 days)
 *   complaints / bounces         Resend spam complaints and PERMANENT bounces
 *                                on review-ask email only
 *
 * The thresholds are the plan's PROPOSALS, as named constants. Jo sets the
 * real values (D2); until then these are what a pause uses.
 *
 * Jo's defaults, 2026-11-26 ("OK all seven"): see
 * documentation/projects/REVIEW-ASK-S3-HEALTH-2026-11-26.md.
 */

const crypto = require('crypto');

const FLAG = 'REVIEW_ASK_HEALTH_ENABLED';
// Written out (not env[FLAG]) so the flags-registry drift scan sees the literal compare.
const flagOn = (env) => !!env && env.REVIEW_ASK_HEALTH_ENABLED === 'true';

const C = Object.freeze({
  health: 'review_ask_health',       // counters, {companyId}_{ymd}
  counted: 'review_ask_counted',     // idempotency marks: {sendId}_{status}, stop_{MessageSid}, resend_{svixId}
  heartbeat: 'review_ask_heartbeat', // {companyId}: { pending: { sendId: sentAtMs } }
  sends: 'review_ask_sends',
  tenants: 'review_ask_tenants',
  audit: 'review_ask_audit',
  phones: 'review_ask_phones',
});

// D2: proposals from the plan, §G3. Rolling WINDOW_DAYS, per company.
const THRESHOLDS = Object.freeze({
  WINDOW_DAYS: 7,
  MIN_SENDS: 20,           // the rate checks need at least this many sends in the window
  FILTERED_MIN: 2,         // 30007 >= 2 (the floor-free ABS_FILTERED below already catches 1)
  FILTERED_RATE: 0.01,     // or above 1%
  OPTOUT_RATE: 0.03,       // STOPs + 21610 above 3%
  UNREACHABLE_RATE: 0.10,  // 30003/30005/30006 above 10%
  BOUNCE_RATE: 0.05,       // permanent bounces above 5% of review emails
  // Floor-free: these pause whatever the volume.
  ABS_STOPS: 2,
  ABS_UNREACHABLE: 3,
  ABS_FILTERED: 1,         // any 30007
  ABS_30034: 1,            // any 30034
  ABS_COMPLAINTS: 1,       // one complaint (deliberate: one homeowner can trip it)
});

// The heartbeat: a text sent more than GRACE ago with no callback at all means
// the callback path is broken, so the text pre-flight refuses.
const HEARTBEAT = Object.freeze({ GRACE_MS: 3600000, WINDOW_MS: 7 * 86400000, MAX_MISSING: 1 });
const STOP_ATTRIBUTION_DAYS = 14;
const DAY_MS = 86400000;

const CODE_FIELDS = Object.freeze({ 30007: 'c30007', 30003: 'c30003', 30005: 'c30005', 30006: 'c30006', 21610: 'c21610', 30034: 'c30034' });
const FIELDS = Object.freeze(['textSends', 'emailSends', 'c30007', 'c30003', 'c30005', 'c30006', 'c21610', 'c30034', 'stops', 'complaints', 'bounces']);
const FINAL = new Set(['delivered', 'failed', 'undelivered']);
const STATUSES = new Set(['queued', 'accepted', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'read', 'canceled']);
// Only review-ask mail counts: the unsubscribe token's source (email-suppression.js).
const REVIEW_EMAIL_SOURCES = Object.freeze(['review-ask-auto', 'review-ask-tenant']);

const PUBLIC_BASE = 'https://nobigdealwithjoedeal.com';
const STATUS_PATH = '/api/review-ask/status';
const PAUSED_BY = 'system:reviewAskHealth';

const dayKey = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const windowDays = (nowMs) => {
  const out = [];
  for (let i = 0; i < THRESHOLDS.WINDOW_DAYS; i++) { const k = dayKey(nowMs - i * DAY_MS); if (!out.includes(k)) out.push(k); }
  return out;
};
const healthId = (companyId, ymd) => companyId + '_' + ymd;

const newSendId = () => crypto.randomBytes(16).toString('hex');
const isSendId = (s) => typeof s === 'string' && /^[a-f0-9]{32}$/.test(s);
const statusCallbackUrl = (id) => PUBLIC_BASE + STATUS_PATH + '?s=' + id;
const cleanStatus = (s) => { const v = String(s || '').toLowerCase(); return STATUSES.has(v) ? v : ''; };

/** The counter a final status adds to, or '' (delivered, a non-final status, an unlisted code). */
function countField(status, errorCode) {
  const s = String(status || '').toLowerCase();
  if (s !== 'failed' && s !== 'undelivered') return '';
  const code = String(errorCode == null ? '' : errorCode).replace(/\D/g, '');
  return CODE_FIELDS[code] || '';
}

const emptyTotals = () => { const t = {}; for (const f of FIELDS) t[f] = 0; return t; };
function sumWindow(docs) {
  const t = emptyTotals();
  for (const d of docs || []) { if (!d) continue; for (const f of FIELDS) t[f] += Number(d[f]) || 0; }
  return t;
}

/**
 * The window's day docs with an admin unpause applied (tenant.healthClearedAtMs, healthBaseline):
 * days before the unpause day are dropped, the unpause day keeps only what came after it.
 */
function sinceClear(days, docs, tenant) {
  const t = tenant || {};
  const at = Number(t.healthClearedAtMs) || 0;
  if (!at) return docs;
  const cut = dayKey(at);
  const base = t.healthBaseline || {};
  return docs.map((d, i) => {
    if (!d || days[i] < cut) return null;
    if (days[i] > cut) return d;
    const out = {};
    for (const f of FIELDS) out[f] = Math.max(0, (Number(d[f]) || 0) - (Number(base[f]) || 0));
    return out;
  });
}

/** The pause reason for a window's totals, or '' when healthy. Floor-free checks first. */
function evaluate(totals) {
  const T = THRESHOLDS;
  const x = Object.assign(emptyTotals(), totals || {});
  const unreachable = x.c30003 + x.c30005 + x.c30006;
  const optOuts = x.stops + x.c21610;
  if (x.c30034 >= T.ABS_30034) return 'unregistered';
  if (x.c30007 >= T.ABS_FILTERED) return 'carrier_filtered';
  if (x.stops >= T.ABS_STOPS) return 'stop_replies';
  if (unreachable >= T.ABS_UNREACHABLE) return 'unreachable';
  if (x.complaints >= T.ABS_COMPLAINTS) return 'email_complaint';
  if (x.textSends >= T.MIN_SENDS) {
    if (x.c30007 >= T.FILTERED_MIN || x.c30007 / x.textSends > T.FILTERED_RATE) return 'filtered_rate';
    if (optOuts / x.textSends > T.OPTOUT_RATE) return 'opt_out_rate';
    if (unreachable / x.textSends > T.UNREACHABLE_RATE) return 'unreachable_rate';
  }
  if (x.emailSends >= T.MIN_SENDS && x.bounces / x.emailSends > T.BOUNCE_RATE) return 'bounce_rate';
  return '';
}

/** How many texts in the heartbeat window have waited longer than GRACE with no callback. */
function heartbeatMissing(pending, nowMs) {
  let n = 0;
  for (const v of Object.values(pending && typeof pending === 'object' ? pending : {})) {
    const at = Number(v) || 0;
    const age = nowMs - at;
    if (at > 0 && age > HEARTBEAT.GRACE_MS && age <= HEARTBEAT.WINDOW_MS) n++;
  }
  return n;
}
/** Entries older than the window, to prune. */
const stalePending = (pending, nowMs) => Object.keys(pending || {}).filter((k) => nowMs - (Number(pending[k]) || 0) > HEARTBEAT.WINDOW_MS);

const REASON_TEXT = Object.freeze({
  unregistered: 'a carrier reported unregistered traffic (30034)',
  carrier_filtered: 'a carrier filtered a review text (30007)',
  stop_replies: 'two or more STOP replies this week',
  unreachable: 'three or more unreachable numbers this week',
  email_complaint: 'a spam complaint on a review email',
  filtered_rate: 'the carrier filtering rate passed its limit',
  opt_out_rate: 'the opt-out rate passed 3%',
  unreachable_rate: 'the unreachable rate passed 10%',
  bounce_rate: 'the review email bounce rate passed 5%',
  callbacks_missing: 'a review text has had no delivery callback for an hour (the callback path may be broken)',
});

/** The owner alert. Never a company-written name: the company id and a fixed reason only. */
function pauseAlert(companyId, reason) {
  return {
    title: 'Review ask paused automatically',
    body: 'Company ' + String(companyId).slice(0, 128) + ': review ask paused because ' + (REASON_TEXT[reason] || 'a health limit was passed')
      + '. Only a platform admin can unpause it (manageReviewAskTenant).',
  };
}

module.exports = {
  FLAG, flagOn, C, THRESHOLDS, HEARTBEAT, STOP_ATTRIBUTION_DAYS, DAY_MS, CODE_FIELDS, FIELDS, FINAL, REVIEW_EMAIL_SOURCES,
  PUBLIC_BASE, STATUS_PATH, PAUSED_BY, REASON_TEXT,
  dayKey, windowDays, healthId, newSendId, isSendId, statusCallbackUrl, cleanStatus, countField,
  emptyTotals, sumWindow, sinceClear, evaluate, heartbeatMissing, stalePending, pauseAlert,
};
