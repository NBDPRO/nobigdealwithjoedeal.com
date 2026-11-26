'use strict';
/**
 * review-ask-tenant-logic.js — the automatic Google review ask for OTHER
 * companies on the CRM, EMAIL ONLY (2026-11-26). PURE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Plan: documentation/projects/REVIEW-ASK-MULTITENANT-GUARDRAIL-PLAN-2026-11-26.md
 * (slices S1 + S2, Jo OK 2026-11-26: "S0 + email only", "email only for now",
 * reviews@ on a dedicated sending subdomain of NBD's domain, apart from jd@ and
 * the apex (D4), the proposed caps and ramp). The I/O is review-ask-tenant.js.
 * The subdomain needs its Resend DNS records before the flag is ever turned on.
 * NBD's own ask (review-ask-auto.js) is untouched: NBD is never handled here.
 *
 * Two keys (plan §3):
 *   review_ask_profile/{companyId}  what the company ASKED for: name, Google
 *                                   review link, Reply-To. Never read by a send.
 *   review_ask_tenants/{companyId}  what the PLATFORM ADMIN approved and set:
 *                                   on/off, pause, ramp stage, and the frozen
 *                                   `approved` copy every send reads.
 * Both are admin-SDK only (the rules' catch-all deny): a company changes its
 * request only through setReviewAskProfile, and nothing it writes reaches a
 * send until a platform admin approves it.
 *
 * Only texts? Never here. This module builds emails; texting for other
 * companies needs their own Twilio subaccount (plan §2, slice S5).
 */

const crypto = require('crypto');
const RA = require('./review-ask-auto-logic');
const roles = require('./stage-roles');
const { isQuietBackfill, isBackfillInvoice } = require('./quiet-backfill');

const FLAG = 'REVIEW_ASK_TENANTS_ENABLED';
const AUTOMATION_KEY = 'reviewAskTenantEmail';
const FROM_ADDRESS = 'reviews@mail.nobigdealwithjoedeal.com';
const DAY_MS = 24 * 60 * 60 * 1000;
// One ask per email address per company in this window (plan G4: per company,
// so one company can never use up another's customers' asks).
const COMPANY_WINDOW_DAYS = 180;
// Across ALL companies: at most this many different companies may ask one
// address in GLOBAL_WINDOW_DAYS (anti-harassment). The reason is never shown to a company.
const GLOBAL_WINDOW_DAYS = 30;
const GLOBAL_MAX_COMPANIES = 2;
// The lead must exist (by the SERVER's createTime) this long before the payment.
const MIN_LEAD_AGE_DAYS = 3;
// A manual (non-Stripe) payment counts only from this much, in cents (Jo, 2026-11-26: the proposal, $500).
const MANUAL_MIN_CENTS = 50000;
// Ramp (Jo, 2026-11-26: the proposal). The platform admin moves a company up;
// any pause puts it back on stage 1.
const RAMP = Object.freeze({
  1: Object.freeze({ day: 5, month: 50 }),
  2: Object.freeze({ day: 10, month: 150 }),
  3: Object.freeze({ day: 25, month: 400 }),
});
const PROFILE_CHANGES_PER_DAY = 10;
const TRIGGERED_BY = 'system:reviewAskTenantSweep';

const flagOn = (env) => !!env && env[FLAG] === 'true';
const truthy = (v) => v === true || v === 1 || (typeof v === 'string' && /^(true|yes|y|1|on)$/i.test(v.trim()));
const str = (v) => (typeof v === 'string' ? v : '');

function ms(t) {
  if (!t) return 0;
  if (typeof t === 'number') return Number.isFinite(t) ? t : 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function') return t.toDate().getTime();
  if (typeof t.seconds === 'number') return t.seconds * 1000;
  if (t instanceof Date) return t.getTime();
  const d = Date.parse(t);
  return Number.isFinite(d) ? d : 0;
}

// ── What a company may ask for (validated at save AND again at every send) ──

// Names that would read as the platform, NBD or Google. Compared with case,
// spacing and punctuation removed; digits and non-Latin letters never get this far.
const RESERVED = ['nobigdeal', 'nbd', 'nbdpro', 'google', 'googlereviews', 'googlereview', 'reviews', 'review'];
const RESERVED_SUBSTR = ['nobigdeal', 'google', 'nbd'];
// Letters NFKD leaves alone that read as plain Latin ones (Gøøgle, Ł…).
const FOLD = { 'ø': 'o', 'ł': 'l', 'đ': 'd', 'æ': 'ae', 'œ': 'oe', 'ß': 'ss', 'þ': 'th', 'ı': 'i', 'ð': 'd', 'ħ': 'h' };
const foldKey = (s) => s.toLowerCase().replace(/[øłđæœßþıðħ]/g, (c) => FOLD[c]).normalize('NFKD').replace(/[^a-z]/g, '');

/** → { ok: true, value } | { ok: false, reason } */
function validateDisplayName(v) {
  const s = str(v).replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 60) return { ok: false, reason: 'name_length' };
  // Letters (Latin, incl. accented), spaces, & ' - only: no digits, dots, @ or slashes,
  // so no phone number, domain or URL can ride in the name.
  if (!/^[A-Za-zÀ-ÖØ-öø-ɏ&' -]+$/.test(s)) return { ok: false, reason: 'name_characters' };
  if (!/[A-Za-zÀ-ÖØ-öø-ɏ]{2}/.test(s)) return { ok: false, reason: 'name_characters' };
  const key = foldKey(s);
  if (RESERVED.includes(key) || RESERVED_SUBSTR.some((r) => key.includes(r))) return { ok: false, reason: 'name_reserved' };
  return { ok: true, value: s };
}

// Google's own review pages only (plan §3). The long writereview form is preferred.
const GOOGLE_REVIEW_URL = [
  /^https:\/\/search\.google\.com\/local\/writereview\?placeid=[A-Za-z0-9_-]{10,200}$/,
  /^https:\/\/g\.page\/r\/[A-Za-z0-9_-]{6,64}\/review$/,
];
function validateReviewUrl(v) {
  const s = str(v).trim();
  return GOOGLE_REVIEW_URL.some((re) => re.test(s)) ? { ok: true, value: s } : { ok: false, reason: 'link_not_google_review' };
}

// The platform's own domains: a company's Reply-To may never point there.
const PLATFORM_DOMAINS = ['nobigdealwithjoedeal.com', 'nobigdeal-pro.web.app', 'nobigdeal-pro.firebaseapp.com'];
function validateReplyTo(v) {
  const s = str(v).trim().toLowerCase();
  if (!s || s.length > 254 || /[\s<>"',;\\]/.test(s)) return { ok: false, reason: 'reply_to_invalid' };
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return { ok: false, reason: 'reply_to_invalid' };
  const domain = s.split('@')[1];
  if (PLATFORM_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return { ok: false, reason: 'reply_to_platform' };
  return { ok: true, value: s };
}

/** The CAN-SPAM postal address (the platform admin's frozen copy): an address, never a link. */
function validatePostalAddress(v) {
  const s = str(v).replace(/\s+/g, ' ').trim();
  if (s.length < 10 || s.length > 200) return { ok: false, reason: 'postal_length' };
  if (/https?:|www\.|@|:\/\//i.test(s)) return { ok: false, reason: 'postal_link' };
  if (/\b[a-z0-9-]+\.(com|net|org|biz|info|io|co|us|app|site|online)\b/i.test(s)) return { ok: false, reason: 'postal_link' };
  if (!/\d/.test(s)) return { ok: false, reason: 'postal_no_number' };
  return { ok: true, value: s };
}

/** The request a company sends: exactly these keys, each valid. → { ok, value } | { ok: false, reason } */
function validateProfileRequest(data) {
  const d = data && typeof data === 'object' ? data : {};
  const allowed = ['displayName', 'googleReviewUrl', 'replyTo'];
  const extra = Object.keys(d).filter((k) => k !== 'action' && !allowed.includes(k));
  if (extra.length) return { ok: false, reason: 'unknown_field', field: extra[0] };
  const n = validateDisplayName(d.displayName); if (!n.ok) return n;
  const u = validateReviewUrl(d.googleReviewUrl); if (!u.ok) return u;
  const r = validateReplyTo(d.replyTo); if (!r.ok) return r;
  return { ok: true, value: { displayName: n.value, googleReviewUrl: u.value, replyTo: r.value } };
}

/** The approved copy, re-checked at every send. → { ok: true, value } | { ok: false, reason } */
function validateApproved(a) {
  const x = a && typeof a === 'object' ? a : null;
  if (!x) return { ok: false, reason: 'not_approved' };
  const n = validateDisplayName(x.displayName); if (!n.ok) return n;
  const u = validateReviewUrl(x.reviewUrl); if (!u.ok) return u;
  const r = validateReplyTo(x.replyTo); if (!r.ok) return r;
  const p = validatePostalAddress(x.postalAddress); if (!p.ok) return p;
  return { ok: true, value: { displayName: n.value, reviewUrl: u.value, replyTo: r.value, postalAddress: p.value } };
}

// ── The company's switches (review_ask_tenants) ────────────────────────────

const rampStage = (t) => (RAMP[Number(t && t.rampStage)] ? Number(t.rampStage) : 1);
const capsFor = (t) => RAMP[rampStage(t)];

/** May this company's asks go out at all? NBD never: it has its own path. */
function tenantReady(t, companyId, nbdUid) {
  const id = str(companyId);
  if (!id || id.indexOf('/') !== -1) return { ok: false, reason: 'no_company' };
  if (id === str(nbdUid || RA.NBD_OWNER_UID)) return { ok: false, reason: 'is_nbd' };
  const x = t && typeof t === 'object' ? t : null;
  if (!x || x.enabled !== true) return { ok: false, reason: 'not_enabled' };
  if (x.paused === true) return { ok: false, reason: 'paused' };
  const a = validateApproved(x.approved);
  if (!a.ok) return { ok: false, reason: 'approved_' + a.reason };
  return { ok: true, approved: a.value, caps: capsFor(x) };
}

// ── Which jobs count (plan G5, restated honestly) ──────────────────────────

const DEAD = { void: 1, voided: 1, cancelled: 1, canceled: 1, uncollectible: 1, draft: 1 };

/**
 * What proves the money: a Stripe payment entry (method 'stripe' is refused
 * from a client by the rules: only the server writes it), or the total of the
 * job's real manual payments in cents. Refunds, reversed payments, payment
 * backfills and dead invoices never count. A refund marked as a dispute is an open problem.
 */
function paymentProof(invoices) {
  let stripe = false, manualCents = 0, disputed = false;
  for (const inv of Array.isArray(invoices) ? invoices : []) {
    if (!inv || inv.deleted === true || DEAD[String(inv.status || '').toLowerCase()]) continue;
    if (isBackfillInvoice(inv)) continue;
    if (inv.disputeOpen === true || String(inv.status || '').toLowerCase() === 'disputed') disputed = true;
    for (const r of Array.isArray(inv.refunds) ? inv.refunds : []) if (r && /^dispute/i.test(String(r.kind || ''))) disputed = true;
    const all = Array.isArray(inv.payments) ? inv.payments : [];
    const reversed = require('./reversal-pairs').reversedIndexes(all);
    all.forEach((p, i) => {
      if (!p || p.refund || reversed.has(i) || !(Number(p.amount) > 0)) return;
      if (String(p.method || '') === 'stripe') stripe = true;
      else manualCents += Math.round(Number(p.amount) * 100);
    });
  }
  return { stripe, manualCents, disputed };
}

/** Intake the server stamped (frozen on create AND update since S0, firestore.rules). */
const serverIntake = (lead) => {
  const l = lead || {};
  return l.webLead === true || !!str(l.publicLeadId) || !!str(l.calcomBookingId);
};

const DONE_KEYS = { install_complete: 1, final_photos: 1 };
/** Was the job marked complete? (the fbd607588 idea, re-implemented): a done stamp or a stage history through Install Done / Final Photos. */
function markedComplete(lead, job, jobId) {
  const l = lead || {};
  const useJob = !!job && !!jobId && l.activeJobId && jobId !== l.activeJobId;
  const rec = useJob ? job : Object.assign({}, l, job || {});
  if (ms(rec.installCompletedAt) || ms(rec.completedAt)) return true;
  const h = Array.isArray(rec.stageHistory) ? rec.stageHistory : [];
  return h.some((e) => e && DONE_KEYS[String(e.to || '').trim().toLowerCase().replace(/\s+/g, '_')]);
}

/** An open warranty claim, dispute or complaint on the lead or the job: no ask (Jo's rule 5). */
function openProblem(rec) {
  const r = rec || {};
  if (r.openWarrantyClaimId || r.disputeOpen === true || r.complaintOpen === true) return true;
  const key = String(r._stageKey || r.stage || '').trim().toLowerCase().replace(/\s+/g, '_');
  return /^(warranty|service)_/.test(key);
}

const tenantOf = (lead) => str(lead && (lead.companyId || lead.userId));

/**
 * The recipient address, strictly: one plain address (no display name, angle
 * brackets, commas or spaces), lower-cased. '' = not usable. The same form is
 * sent to, suppressed and hashed, so "<victim@x>" or "Victim@X " can never
 * dodge an unsubscribe or a window.
 */
function canonicalEmail(v) {
  const s = str(v).trim().toLowerCase();
  if (!s || s.length > 254 || /[\s<>"',;\\()[\]:]/.test(s)) return '';
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : '';
}
/** The mailbox behind an address: +tag dropped; Gmail dots dropped. For the windows and a second suppression check. */
function baseEmail(v) {
  const s = canonicalEmail(v);
  if (!s) return '';
  let [local, domain] = s.split('@');
  local = local.split('+')[0];
  if (domain === 'gmail.com' || domain === 'googlemail.com') { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return local ? local + '@' + domain : '';
}

/** The checks that need no read (the rep nudge uses these to leave a job for the sweep). → '' | reason */
function preReadReason({ companyId, lead, job, jobId, recvMs, nowMs }) {
  const l = lead || {};
  const now = Number(nowMs) || Date.now();
  if (!companyId || tenantOf(l) !== companyId) return 'wrong_company';
  if (l.deleted === true || l.deletedAt) return 'deleted';
  if (l.archived === true) return 'archived';
  if (l.isProspect) return 'prospect';
  if (roles.isLost(l) || (job && roles.isLost(job))) return 'lost';
  if (isQuietBackfill(l) || (job && isQuietBackfill(job))) return 'quiet_backfill';
  if (truthy(l.doNotContact) || truthy(l.dnc) || truthy(l.doNotEmail) || truthy(l.emailOptOut)) return 'do_not_contact';
  if (l.reviewRequested === true || (job && ms(job.reviewRequestedAt))) return 'already_requested';
  if (RA.attempted(l, jobId)) return 'already_attempted';
  if (openProblem(l) || openProblem(job)) return 'open_problem';
  if (!RA.inWindow(recvMs, now)) return recvMs ? 'outside_window' : 'no_received_date';
  if (!serverIntake(l)) return 'no_server_intake';
  if (!markedComplete(l, job, jobId)) return 'not_complete';
  if (!canonicalEmail(l.email)) return 'no_email';
  return '';
}
// Reasons that will not change for this job: the sweep stamps the job "done"
// (no reason on the lead), so the rep nudge takes it back the next morning.
const FINAL_REASONS = new Set(['no_server_intake', 'lead_too_new', 'not_complete', 'payment_unproven', 'open_problem', 'no_email', 'do_not_contact']);

/**
 * Did Resend say a definite "not sent"? Only a request it refused (bad
 * address, unverified sender, auth, unprocessable). A 429, a 5xx or the SDK's
 * own network / timeout error are UNKNOWN: the email may have gone.
 */
const DEFINITE_NAMES = new Set(['validation_error', 'missing_required_field', 'invalid_from_address', 'invalid_to_address', 'invalid_parameter', 'invalid_api_key', 'restricted_api_key', 'missing_api_key', 'invalid_access', 'not_found', 'method_not_allowed', 'invalid_idempotency_key', 'invalid_attachment']);
function resendDefinite(r) {
  const e = r && r.error;
  if (!e) return false;
  const code = Number(e.statusCode || e.status) || 0;
  if ([400, 401, 403, 404, 405, 422].includes(code)) return true;
  return DEFINITE_NAMES.has(String(e.name || ''));
}

/**
 * May this company's customer be asked for this job, by email? Every input is
 * re-read by the caller just before this. → { ok: true, to } | { ok: false, reason }
 * The reasons stay server-side (review_ask_sends); a company never sees them.
 */
function eligibility({ companyId, lead, job, jobId, leadCreateMs, recvMs, invoices, nowMs }) {
  const l = lead || {};
  const pre = preReadReason({ companyId, lead, job, jobId, recvMs, nowMs });
  if (pre) return { ok: false, reason: pre };
  const created = Number(leadCreateMs) || 0;
  if (!created || created > Number(recvMs) - MIN_LEAD_AGE_DAYS * DAY_MS) return { ok: false, reason: 'lead_too_new' };
  const pay = paymentProof(invoices);
  if (pay.disputed) return { ok: false, reason: 'open_problem' };
  if (!pay.stripe && pay.manualCents < MANUAL_MIN_CENTS) return { ok: false, reason: 'payment_unproven' };
  return { ok: true, to: canonicalEmail(l.email), base: baseEmail(l.email) };
}

// ── Recipient windows and caps (keys and decisions; the transaction is in the I/O file) ──

const normEmail = (e) => str(e).trim().toLowerCase();
const emailHash = (e) => crypto.createHash('sha256').update('review_ask|email|' + (baseEmail(e) || normEmail(e))).digest('hex').slice(0, 40);

/** The ET calendar day / month keys the caps count in. */
function periodKeys(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(Number(nowMs) || Date.now()));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value || '';
  return { day: get('year') + get('month') + get('day'), month: get('year') + get('month') };
}

/**
 * Decide inside the transaction. Inputs are the docs as read.
 *   companyDoc   review_ask_emails/{companyId}_{hash}: { lastAskMs }
 *   globalDoc    review_ask_recipient/{hash}: { asks: [{ companyId, atMs }] }
 *   dayCount / monthCount: this company's sends in the period
 * → { ok: true, asks } (the new global list) | { ok: false, reason }
 */
function claimDecision({ companyId, companyDoc, globalDoc, dayCount, monthCount, caps, nowMs }) {
  const now = Number(nowMs) || Date.now();
  const c = caps || RAMP[1];
  if ((Number(dayCount) || 0) >= c.day) return { ok: false, reason: 'tenant_daily_cap' };
  if ((Number(monthCount) || 0) >= c.month) return { ok: false, reason: 'tenant_monthly_cap' };
  const last = Number(companyDoc && companyDoc.lastAskMs) || 0;
  if (last && now - last < COMPANY_WINDOW_DAYS * DAY_MS) return { ok: false, reason: 'recipient_recently_asked' };
  const recent = (Array.isArray(globalDoc && globalDoc.asks) ? globalDoc.asks : [])
    .filter((a) => a && now - (Number(a.atMs) || 0) < GLOBAL_WINDOW_DAYS * DAY_MS);
  const others = new Set(recent.map((a) => str(a.companyId)).filter((x) => x && x !== companyId));
  if (others.size >= GLOBAL_MAX_COMPANIES) return { ok: false, reason: 'recipient_global_cap' };
  return { ok: true, asks: recent.concat([{ companyId, atMs: now }]).slice(-10) };
}

// ── The words (fixed; the only variables are the first name, the approved name and link) ──

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const firstNameOf = (lead) => str(lead && (lead.firstName || lead.name)).trim().split(/\s+/)[0].replace(/[^A-Za-zÀ-ÖØ-öø-ɏ' -]/g, '').slice(0, 40);

/**
 * The ask email. The same words to every customer: no rating first, no
 * condition, nothing offered, no promotion, no platform branding (plan G2/G8).
 * The CAN-SPAM footer (company's postal address + unsubscribe) is added by
 * email-suppression.js applyFooter.
 */
function emailContent(lead, approved) {
  const name = approved.displayName;
  const url = approved.reviewUrl;
  const f = firstNameOf(lead);
  const hi = f ? 'Hi ' + f : 'Hi';
  const subject = 'A quick favor from ' + name;
  const line1 = 'Thank you for choosing ' + name + '. If you have a minute, a Google review helps your neighbors pick a contractor.';
  const line2 = 'Honest feedback, whatever it is, is welcome.';
  const text = hi + ',\n\n' + line1 + ' ' + line2 + '\n\n' + url + '\n\nThank you,\n' + name;
  const html = '<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">'
    + '<title>' + esc(subject) + '</title></head>'
    + '<body style="margin:0;padding:0;background:#f5f5f5;font-family:Segoe UI,Roboto,Arial,sans-serif;color:#1f2937;line-height:1.6;">'
    + '<div style="max-width:560px;margin:0 auto;background:#ffffff;padding:28px 24px;">'
    + '<p>' + esc(hi) + ',</p><p>' + esc(line1) + ' ' + esc(line2) + '</p>'
    + '<p style="text-align:center;margin:22px 0;"><a href="' + esc(url) + '" style="display:inline-block;padding:12px 24px;background:#1f2937;color:#ffffff;border-radius:6px;text-decoration:none;font-weight:600;">Leave a Google review</a></p>'
    + '<p style="font-size:13px;color:#6b7280;">Or paste this link: ' + esc(url) + '</p>'
    + '<p>Thank you,<br>' + esc(name) + '</p>'
    + '</div></body></html>';
  return { subject, html, text };
}

/** "Name" <reviews@…>: the approved name only (already letters, spaces, & ' -). */
const fromHeader = (approved) => '"' + approved.displayName.replace(/["\\\r\n<>]/g, '') + '" <' + FROM_ADDRESS + '>';

module.exports = {
  FLAG, AUTOMATION_KEY, FROM_ADDRESS, DAY_MS, COMPANY_WINDOW_DAYS, GLOBAL_WINDOW_DAYS, GLOBAL_MAX_COMPANIES,
  MIN_LEAD_AGE_DAYS, MANUAL_MIN_CENTS, RAMP, PROFILE_CHANGES_PER_DAY, TRIGGERED_BY, PLATFORM_DOMAINS,
  flagOn, ms, validateDisplayName, validateReviewUrl, validateReplyTo, validatePostalAddress,
  validateProfileRequest, validateApproved, rampStage, capsFor, tenantReady,
  paymentProof, serverIntake, markedComplete, openProblem, tenantOf, eligibility, preReadReason, FINAL_REASONS,
  canonicalEmail, baseEmail, resendDefinite,
  emailHash, periodKeys, claimDecision, emailContent, fromHeader, firstNameOf,
};
