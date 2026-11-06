/**
 * functions/portal-moments.js — key-moment emails that carry the homeowner's
 * portal link (2026-11-04, documentation/projects/CUSTOMER-PORTAL-PLAN-2026-11-04.md
 * Phase 5). BUILT DARK.
 *
 * Three moments, each one email per lead per moment (per build date for the
 * build-day email):
 *   booked        a Cal.com inspection booking lands (appointments create)
 *   build_day_set the build date is set or moved on a signed job
 *   job_done      the job reaches the final walkthrough
 *
 * Sends ONLY when all of these hold, every one failing closed:
 *   - env PORTAL_MOMENT_EMAILS_ENABLED === 'true' (checked before any read)
 *   - messaging_controls/automations.portalMomentEmail === true, the global
 *     customer switch and the email switch (MessagingControls.automationStatus)
 *   - the lead is NBD's (the sender is Joe's own address; tenants need their
 *     own sender before this can speak for them)
 *   - the address is not on the suppression register and NBD's postal
 *     address is set (Suppression.gateCommercialEmail: List-Unsubscribe
 *     headers + footer on every email)
 *   - the per-recipient daily cap
 *   - a one-time claim doc portal_moment_sends/{id} created BEFORE the send
 *     (a redelivered trigger or a second write can never send twice)
 *
 * Wording (KY + crews): no claim / carrier / adjuster words, no "our team".
 * The portal link is an existing live link with at least 7 days left, else a
 * fresh 30-day one (portal-token-mint.js).
 */
'use strict';

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const HP = require('./homeowner-progress');
const SW = require('./schedule-window');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const REPLY_TO = 'jd@nobigdealwithjoedeal.com';
const AUTOMATION_KEY = 'portalMomentEmail';
const ENV_FLAG = 'PORTAL_MOMENT_EMAILS_ENABLED';
const RECIPIENT_DAILY_CAP = 3;
const LINK_MIN_LIFE_MS = 7 * 86_400_000;

// ALL customer-facing wording. Edit here, nowhere else.
const MOMENT_COPY = Object.freeze({
  booked: Object.freeze({
    subject: 'Your inspection is booked: here is your project page',
    lines: Object.freeze([
      'Hi {first},',
      'Thanks for booking. Your project page shows your appointment, and you can pick a new time there if you need to.',
      'As things move along it will show your estimate, photos and documents too.',
    ]),
    button: 'Open your project page',
  }),
  build_day_set: Object.freeze({
    subject: 'Your build day: {date}',
    lines: Object.freeze([
      'Hi {first},',
      'Your build day is set for {date}.',
      'Your project page shows the forecast and the crew company the week of the job. Need to change something? Reply to this email or send {rep} a message on the page.',
    ]),
    button: 'See your project page',
  }),
  job_done: Object.freeze({
    subject: 'The work at your home is done',
    lines: Object.freeze([
      'Hi {first},',
      'The work at your home is done. {rep} will walk the job with you, and your final photos and paperwork will be on your project page.',
    ]),
    button: 'See your project page',
  }),
});

const fill = (t, v) => String(t || '').replace(/\{(\w+)\}/g, (m, k) => (v[k] != null && v[k] !== '' ? String(v[k]) : m));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,190}\.[A-Za-z]{2,24}$/;

/** The homeowner progress step for a lead's stage, or null. */
function stepOf(lead) {
  const k = HP.stageKeyFor(lead || {});
  return k ? HP.STAGE_TO_STEP[k] || null : null;
}

/** 'Tuesday, November 10' for a YYYY-MM-DD (no time zone drift: noon UTC). */
function dayLabel(ymd) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ymd || ''))) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Pure. The moment a lead write is, or null.
 * → { moment: 'build_day_set', key: 'YYYY-MM-DD' } | { moment: 'job_done', key: 'done' } | null
 */
function momentFromLeadChange(before, after, todayYmd) {
  const b = before || {}, a = after || {};
  if (a.deleted === true) return null;
  const sa = stepOf(a), sb = stepOf(b);
  if (sa === 'walkthrough' && sb !== 'walkthrough') return { moment: 'job_done', key: 'done' };
  const w = SW.normalize(a);
  const wb = SW.normalize(b);
  if ((sa === 'signed' || sa === 'scheduled') && w && w.date >= String(todayYmd || '') && (!wb || wb.date !== w.date)) {
    return { moment: 'build_day_set', key: w.date };
  }
  return null;
}

/** Pure. A new Cal.com booking that should get the "booked" email, or null. */
function momentFromAppointment(appt, nowMs) {
  const x = appt || {};
  const start = x.startTime && typeof x.startTime.toMillis === 'function' ? x.startTime.toMillis() : NaN;
  if (x.source !== 'calcom' || x.status !== 'booked' || typeof x.leadId !== 'string' || !x.leadId) return null;
  if (!(start > nowMs)) return null;
  return { moment: 'booked', key: String(x.bookingId || 'booking').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'booking' };
}

/** Pure. { subject, html, text } for a moment. */
function buildMomentEmail(moment, vars) {
  const c = MOMENT_COPY[moment];
  if (!c) return null;
  const v = Object.assign({ first: 'there', rep: 'Joe' }, vars || {});
  const lines = c.lines.map((l) => fill(l, v));
  const url = String(v.url || '');
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1612;max-width:560px">' +
    lines.map((l) => '<p style="margin:0 0 14px">' + esc(l) + '</p>').join('') +
    '<p style="margin:20px 0"><a href="' + esc(url) + '" style="display:inline-block;background:#BD5728;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">' + esc(c.button) + '</a></p>' +
    '<p style="margin:0 0 14px">' + esc(v.rep) + '<br>No Big Deal Home Solutions</p>' +
    '</div>';
  const text = lines.join('\n\n') + '\n\n' + c.button + ': ' + url + '\n\n' + v.rep + '\nNo Big Deal Home Solutions';
  return { subject: fill(c.subject, v), html, text };
}

/** Claim doc id: one per lead + moment + key. */
function claimId(leadId, m) {
  return (String(leadId) + '_' + m.moment + '_' + m.key).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 200);
}

/** A live portal link with >= 7 days left, else a fresh 30-day one. */
async function portalLinkFor(db, leadId, lead) {
  const PAS = require('./portal-after-signing');
  const qs = await db.collection('portal_tokens').where('leadId', '==', leadId).limit(20).get();
  const rows = qs.docs.map((d) => {
    const x = d.data() || {};
    return { id: d.id, leadId: x.leadId, ownerUid: x.ownerUid,
      expiresAtMs: x.expiresAt && x.expiresAt.toMillis ? x.expiresAt.toMillis() : 0, uses: x.uses, maxUses: x.maxUses };
  });
  const reuse = PAS.portalUrlFor(rows, leadId, lead.userId, Date.now() + LINK_MIN_LIFE_MS);
  if (reuse) return reuse;
  const minted = await require('./portal-token-mint').writePortalToken(db, leadId, lead, 'system:portal-moment', 30);
  return 'https://nobigdealwithjoedeal.com/pro/portal.html?token=' + minted.token;
}

/**
 * Send one moment email if every gate allows it. Never throws.
 * deps (tests): { db, env, resend, nowMs }
 */
async function sendMoment(leadId, m, deps) {
  const d = deps || {};
  const env = d.env || process.env;
  // Literal read so flags-registry-drift sees the flag in use.
  const envOn = (d.env ? d.env.PORTAL_MOMENT_EMAILS_ENABLED : process.env.PORTAL_MOMENT_EMAILS_ENABLED) === 'true';
  if (!envOn) { logger.info('portal_moment_dark', { moment: m.moment }); return { sent: false, reason: 'env_flag_off' }; }
  const db = d.db || getFirestore();
  const MessagingControls = require('./messaging-controls');
  const auto = await MessagingControls.automationStatus(db, AUTOMATION_KEY, 'email', true);
  if (!auto.enabled) return { sent: false, reason: auto.reason };
  let claimRef = null;
  try {
    const snap = await db.doc('leads/' + leadId).get();
    const lead = snap.exists ? snap.data() || {} : null;
    if (!lead || lead.deleted === true) return { sent: false, reason: 'no_lead' };
    const tenant = String(lead.companyId || lead.userId || '');
    if (!require('./zelle-contact').isNbdCompany(tenant)) return { sent: false, reason: 'not_nbd' };
    const email = String(lead.email || '').trim();
    if (!EMAIL_RE.test(email)) return { sent: false, reason: 'no_email' };

    claimRef = db.doc('portal_moment_sends/' + claimId(leadId, m));
    try {
      await claimRef.create({ leadId, moment: m.moment, key: m.key, status: 'claimed', claimedAt: FieldValue.serverTimestamp() });
    } catch (e) {
      return { sent: false, reason: 'already_claimed' };
    }

    const Suppression = require('./email-suppression');
    const unsub = await Suppression.gateCommercialEmail(db, { companyId: tenant, email, source: 'portal-moment' },
      { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FieldValue.serverTimestamp });
    if (unsub.suppressed || unsub.blocked) {
      await claimRef.update({ status: unsub.suppressed ? 'suppressed' : 'blocked_no_postal_address' });
      return { sent: false, reason: unsub.suppressed ? 'suppressed' : 'no_postal_address' };
    }
    const cap = await require('./alert-recipients').capRecipients('portal-moment', [email], { limit: RECIPIENT_DAILY_CAP });
    if (!cap.allowed.length) { await claimRef.update({ status: 'capped' }); return { sent: false, reason: 'capped' }; }

    const url = await portalLinkFor(db, leadId, lead);
    const first = String(lead.firstName || '').trim().split(/\s+/)[0] || 'there';
    const rep = String(lead.repName || '').trim().split(/\s+/)[0] || 'Joe';
    const built = buildMomentEmail(m.moment, { first, rep, url, date: dayLabel(m.key) });
    const body = Suppression.applyFooter(unsub, built.html, built.text);
    const gated = await MessagingControls.guardEmail(db, {
      from: env.EMAIL_FROM || 'Joe Deal <jd@nobigdealwithjoedeal.com>',
      to: email, replyTo: REPLY_TO, subject: built.subject, html: body.html, text: body.text,
      headers: Object.assign({ 'X-NBD-Campaign': 'portal-moment-' + m.moment }, unsub.headers),
      tags: unsub.tags,
    });
    if (!gated.send) { await claimRef.update({ status: 'paused', reason: String(gated.reason || '') }); return { sent: false, reason: gated.reason }; }
    let resend = d.resend;
    if (!resend) {
      if (!env.RESEND_API_KEY) throw new Error('portal_moment_missing_api_key');
      const { Resend } = require('resend');
      resend = new Resend(env.RESEND_API_KEY);
    }
    const { resendRejected, resendErrorMessage } = require('./resend-guard');
    const response = await resend.emails.send(gated.msg);
    if (resendRejected(response)) throw new Error(resendErrorMessage(response));
    await claimRef.update({ status: 'sent', sentAt: FieldValue.serverTimestamp() }).catch(() => {});
    logger.info('portal_moment_sent', { leadId, moment: m.moment });
    return { sent: true };
  } catch (e) {
    logger.error('portal_moment_failed', { leadId, moment: m.moment, err: e && e.message });
    // The claim stays: a failed send is looked at, never auto-retried into a duplicate.
    if (claimRef) await claimRef.update({ status: 'failed', error: String((e && e.message) || '').slice(0, 200) }).catch(() => {});
    return { sent: false, reason: 'error' };
  }
}

const TRIGGER_OPTS = { region: 'us-central1', secrets: [RESEND_API_KEY, EMAIL_FROM], maxInstances: 10, memory: '256MiB', timeoutSeconds: 30 };

exports.portalMomentOnLead = onDocumentUpdated({ ...TRIGGER_OPTS, document: 'leads/{leadId}' }, async (event) => {
  const before = event.data && event.data.before && event.data.before.data();
  const after = event.data && event.data.after && event.data.after.data();
  if (!after) return;
  const PF = require('./production-flow-logic');
  const m = momentFromLeadChange(before, after, PF.nyDate(Date.now()));
  if (!m) return;
  await sendMoment(event.params.leadId, m);
});

exports.portalMomentOnBooking = onDocumentCreated({ ...TRIGGER_OPTS, document: 'appointments/{apptId}' }, async (event) => {
  const appt = event.data && event.data.data();
  const m = momentFromAppointment(appt, Date.now());
  if (!m) return;
  await sendMoment(appt.leadId, m);
});

// Tests only. NON-enumerable: index.js re-exports Cloud Functions only.
Object.defineProperty(exports, '_internal', {
  enumerable: false,
  value: { MOMENT_COPY, AUTOMATION_KEY, ENV_FLAG, momentFromLeadChange, momentFromAppointment, buildMomentEmail, claimId, dayLabel, sendMoment, stepOf },
});
