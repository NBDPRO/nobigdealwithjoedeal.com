/**
 * NBD Pro — Post-Win Review Request Nudge
 * ═══════════════════════════════════════════════════════════════
 *
 * Mirrors the anniversary-touch.js pattern: a scheduled Cloud Function
 * that scans every rep's book for jobs that recently entered a WON-role
 * stage without a review request, then nudges the rep. Reviews are the
 * highest-ROI marketing asset a local contractor has, and the ask is
 * almost always forgotten in the post-install rush — the client-side
 * engine (docs/pro/js/review-engine.js) only fires when the rep opens
 * the dashboard, so a busy week means the window quietly closes.
 *
 * What we do:
 *   1. Find won leads per rep through BOTH lanes: persisted
 *      `stageRole == 'won'` (the freeform-pipeline contract — tenant
 *      custom stages count) plus the legacy won-key list for
 *      pre-backfill leads; every candidate is re-verified in memory
 *      with the shared role map (stage-roles.roleFor).
 *   2. Window: stageStartedAt 3–21 days ago — late enough that the job
 *      has settled, fresh enough that the homeowner still remembers
 *      the crew's name.
 *   3. Idempotency: skip leads already asked (`reviewRequested`, which
 *      the client engine stamps when the rep actually sends) or
 *      already nudged (`reviewNudgedAt`, stamped HERE on every run
 *      mode — one server nudge per lead, ever). Same hard-won lesson
 *      as anniversary-touch: mark on nudge, not on email success, or
 *      dry-run re-nudges daily for the whole window.
 *   4. Write a `review_request_due` activity row + a bell notification
 *      (the exact doc shape the client engine writes, deduped against
 *      any the client already created) on each match.
 *   5. Aggregate per-rep: ONE morning digest email with deep links and
 *      a drop-in script.
 *
 * What we DON'T do:
 *   - We don't auto-send to the homeowner. Same posture as
 *     anniversary-touch: the rep reviews and taps one button in the CRM
 *     (ReviewEngine.sendReviewSMS/Email) — a human decides whether this
 *     customer, this week, should get this ask.
 *
 * Per-user opt-out: users/{uid}.reviewNudgeEnabled === false.
 * E2E test accounts always skipped.
 *
 * Ships DRY-RUN by default. Set REVIEW_NUDGE_ENABLED=true on the
 * reviewRequestNudge Cloud Run revision after a cycle of observation.
 */

'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { FieldPath, FieldValue, getFirestore } = require('firebase-admin/firestore');
const { Resend } = require('resend');
const roles = require('./stage-roles');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM     = defineSecret('EMAIL_FROM');

const DAY_MS = 24 * 60 * 60 * 1000;
// Ask window: 3-21 days after entering the won stage. The lower bound
// keeps the ask out of the final-payment conversation; the upper bound
// stops stale wins (rep on vacation, backfilled data) from generating
// awkward months-later asks.
const NUDGE_MIN_DAYS = 3;
const NUDGE_MAX_DAYS = 21;

// Legacy query lane for leads that predate the stageRole backfill —
// the historical won keys as persisted over the years. Everything the
// query returns is re-verified through stage-roles.roleFor below, so
// this list only has to be broad enough, not exact.
const LEGACY_WON_KEYS = [
  'closed', 'Closed Won',
  'complete', 'Complete',
  'install_complete',
  'final_photos',
  'final_payment',
  'deductible_collected',
];

// ─── Branded email template (anniversary-touch skeleton) ─────────
const TEMPLATE_STYLES = `
  body { font-family: 'Barlow','Segoe UI',Roboto,sans-serif; line-height:1.6; color:#333; background:#f5f5f5; margin:0; padding:0; }
  .container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08); }
  .header { background:linear-gradient(135deg,#BD5728 0%,#a14a22 100%); color:#fff; padding:32px 24px; text-align:center; }
  .header h1 { margin:0 0 6px; font-size:24px; font-weight:700; letter-spacing:-0.3px; }
  .header p { margin:0; font-size:13px; opacity:0.9; }
  .content { padding:28px 24px; color:#1f2937; }
  h2 { color:#1a3057; margin:0 0 8px; font-size:18px; }
  p { margin:8px 0; }
  .rev-row {
    display:block; padding:14px; border-radius:8px;
    background:#fff7ed; border:1px solid #fed7aa;
    margin-bottom:8px; text-decoration:none; color:inherit;
  }
  .rev-name { font-weight:700; color:#111827; font-size:15px; margin-bottom:3px; }
  .rev-meta { font-size:12px; color:#6b7280; }
  .rev-pill {
    display:inline-block; background:#fef3c7; color:#92400e;
    font-size:10px; font-weight:700; padding:2px 8px;
    border-radius:999px; text-transform:uppercase;
    letter-spacing:0.4px; margin-right:6px;
  }
  .cta {
    display:inline-block; margin-top:18px; padding:12px 24px;
    background:#BD5728; color:#fff; border-radius:6px;
    text-decoration:none; font-weight:600;
  }
  .footer { background:#1a3057; color:#94a3b8; padding:18px 24px; text-align:center; font-size:11px; }
  .footer a { color:#BD5728; text-decoration:none; }
  .script-box {
    background:#f9fafb; border:1px dashed #d1d5db;
    border-radius:6px; padding:12px 14px; font-size:13px;
    color:#374151; margin-top:8px;
  }
`;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function timestampMillis(t) {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function')   return t.toDate().getTime();
  if (typeof t === 'number')            return t;
  return 0;
}

function fmtMonthDay(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function buildEmailHtml({ firstName, dueLeads }) {
  const dashboardUrl  = 'https://nobigdealwithjoedeal.com/pro/dashboard.html';
  const customerBase  = 'https://nobigdealwithjoedeal.com/pro/customer.html';
  const total = dueLeads.length;
  const greeting = firstName ? `Hey ${escapeHtml(firstName)},` : 'Hey,';

  // Drop-in script mirroring the CRM's one-tap SMS (ReviewEngine.
  // sendReviewSMS resolves the tenant's own name + review link at send
  // time — this preview stays brand-neutral on purpose).
  const sampleScript =
    `Hi {firstName}, thank you so much for trusting us with your project! ` +
    `We'd love to hear how we did. If you have 30 seconds, a Google review means the world to us: {your review link} ` +
    `If you mention your town and what we did (like 'roof replacement in Mason'), it helps your neighbors find us.`;

  const rowsHtml = dueLeads.map(l => {
    const name = `${l.firstName || ''} ${l.lastName || ''}`.trim() || 'Customer';
    const url  = `${customerBase}?id=${encodeURIComponent(l.id)}&review=1`;
    const meta = [l.address, l.phone].filter(Boolean).map(escapeHtml).join(' · ');
    const wonOn = fmtMonthDay(l.wonMs);
    return `
      <a class="rev-row" href="${url}">
        <div class="rev-name">${escapeHtml(name)}</div>
        <div style="margin-bottom:6px;">
          <span class="rev-pill">review ask due</span>
          <span style="font-size:12px;color:#6b7280;">Job won ${escapeHtml(wonOn)}</span>
        </div>
        <div class="rev-meta">${meta || '&nbsp;'}</div>
      </a>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${total} review ask${total === 1 ? '' : 's'} ready</title>
  <style>${TEMPLATE_STYLES}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${total} customer${total === 1 ? '' : 's'} ready for a review ask</h1>
      <p>NBD Pro · Post-win review requests</p>
    </div>
    <div class="content">
      <p>${greeting}</p>
      <p>${total === 1 ? 'A job' : `${total} jobs`} wrapped recently and ${total === 1 ? 'hasn’t' : 'haven’t'} been asked for a Google review yet. The ask converts best in the first couple of weeks, while the crew's name is still fresh — after that the moment is gone.</p>

      <h2 style="margin-top:24px;">Due today</h2>
      <div style="margin:14px 0;">
        ${rowsHtml}
      </div>

      <h2 style="margin-top:22px;">Drop-in script</h2>
      <div class="script-box">${escapeHtml(sampleScript)}</div>
      <p style="font-size:12px;color:#6b7280;margin-top:8px;">Click any customer above to open their record — the Review Request button pre-fills this message with your saved Google review link and sends from your phone in one tap.</p>

      <p style="text-align:center; margin-top:18px;">
        <a href="${dashboardUrl}" class="cta">Open Dashboard</a>
      </p>

      <p style="font-size:12px; color:#6b7280; margin-top:18px; text-align:center;">
        Don't want these? <a href="${dashboardUrl}#settings" style="color:#BD5728;">Manage email preferences</a>.
      </p>
    </div>
    <div class="footer">
      <p>No Big Deal Home Solutions · (859) 420-7382 · jd@nobigdealwithjoedeal.com</p>
    </div>
  </div>
</body>
</html>`;
}

// ─── Per-user aggregation ────────────────────────────────────────
async function findReviewDueLeads(db, uid) {
  const now = Date.now();
  const minWonMs = now - NUDGE_MAX_DAYS * DAY_MS;
  const maxWonMs = now - NUDGE_MIN_DAYS * DAY_MS;

  // Two query lanes, merged + deduped: persisted-role (custom stages
  // included — leads(userId, stageRole) composite) and the legacy key
  // list for pre-backfill leads (reuses leads(userId, stage)).
  const [roleSnap, legacySnap] = await Promise.all([
    db.collection('leads')
      .where('userId', '==', uid)
      .where('stageRole', '==', 'won')
      .limit(5000)
      .get(),
    db.collection('leads')
      .where('userId', '==', uid)
      .where('stage', 'in', LEGACY_WON_KEYS)
      .limit(5000)
      .get(),
  ]);

  const seen = new Set();
  const out = [];
  for (const doc of [...roleSnap.docs, ...legacySnap.docs]) {
    if (seen.has(doc.id)) continue;
    seen.add(doc.id);
    const lead = { id: doc.id, ...doc.data() };
    if (lead.deleted) continue;
    if (lead.isProspect) continue;

    // Re-verify through the shared role map: persisted stageRole wins,
    // else the key classifies. Drops legacy-lane rows whose raw stage
    // string matched but whose persisted role says otherwise.
    if (roles.roleFor(lead) !== roles.ROLE.WON) continue;

    // Nothing to send with — the CRM's one-tap ask needs a phone
    // (SMS) or an email address.
    if (!lead.phone && !lead.email) continue;

    // Won recently enough? stageStartedAt is stamped by every moveCard;
    // updatedAt is the pre-rollout fallback.
    const wonMs = timestampMillis(lead.stageStartedAt) || timestampMillis(lead.updatedAt);
    if (!wonMs || wonMs < minWonMs || wonMs > maxWonMs) continue;

    // Idempotency: the rep already sent an ask (client engine stamps
    // reviewRequested), or this sweep already nudged once.
    if (lead.reviewRequested) continue;
    if (timestampMillis(lead.reviewNudgedAt)) continue;

    out.push({ ...lead, wonMs });
  }
  out.sort((a, b) => b.wonMs - a.wonMs);
  return out;
}

async function writeReviewActivity(db, leadId, uid) {
  try {
    await db.collection(`leads/${leadId}/activity`).add({
      userId: uid,
      type: 'review_request_due',
      label: 'Google review ask due',
      message: 'This job wrapped recently — a review ask converts best in the first two weeks.',
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn('review_nudge_activity_write_failed', { leadId, err: e.message });
  }
}

// The bell notification, in the exact shape the client engine writes
// (review-engine.js createReviewNotification) so both lanes render the
// same and dedupe against each other.
async function writeReviewNotification(db, lead, uid) {
  try {
    const existing = await db.collection('notifications')
      .where('userId', '==', uid)
      .where('leadId', '==', lead.id)
      .where('type', '==', 'review_request')
      .limit(1)
      .get();
    if (!existing.empty) return false;
    const customerName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Customer';
    await db.collection('notifications').add({
      userId: uid,
      leadId: lead.id,
      type: 'review_request',
      title: '⭐ Request a Review',
      message: `${customerName}'s project is complete — send a review request?`,
      read: false,
      dismissed: false,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    logger.warn('review_nudge_notification_failed', { leadId: lead.id, err: e.message });
    return false;
  }
}

async function markReviewNudged(db, leadId) {
  try {
    await db.doc(`leads/${leadId}`).update({
      reviewNudgedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn('review_nudge_mark_failed', { leadId, err: e.message });
  }
}

// ─── Scheduled function ──────────────────────────────────────────
// Daily at 8:15am Eastern — offset from anniversaryAutoTouch (8:00)
// so the two morning sweeps don't contend for the same quota window.
exports.reviewRequestNudge = onSchedule(
  {
    schedule: '15 8 * * *',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 1,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const enabled = process.env.REVIEW_NUDGE_ENABLED === 'true';
    const db = getFirestore();

    const resend = enabled && process.env.RESEND_API_KEY
      ? new Resend(process.env.RESEND_API_KEY)
      : null;
    const fromAddress = process.env.EMAIL_FROM || 'Joe Deal <jd@nobigdealwithjoedeal.com>';

    let emailed = 0, skippedOptOut = 0, skippedNothing = 0, failed = 0;
    let nudged = 0, notified = 0;

    // Paginate ALL users (the anniversary 2.6 lesson: a bare limit(500)
    // silently drops user #501+ as tenants grow).
    let totalUsers = 0;
    let userCursor = null;
    while (true) {
      let uq = db.collection('users')
        .orderBy(FieldPath.documentId())
        .limit(500);
      if (userCursor) uq = uq.startAfter(userCursor);
      const usersSnap = await uq.get();
      if (usersSnap.empty) break;
      totalUsers += usersSnap.size;

      for (const userDoc of usersSnap.docs) {
        const user = userDoc.data() || {};
        const uid  = userDoc.id;

        if (!user.email || !isValidEmail(user.email)) { skippedOptOut++; continue; }
        if (user.reviewNudgeEnabled === false)        { skippedOptOut++; continue; }
        if (user.e2eTestAccount)                      { skippedOptOut++; continue; }

        try {
          const dueLeads = await findReviewDueLeads(db, uid);
          if (dueLeads.length === 0) { skippedNothing++; continue; }

          // Activity + notification + the idempotency mark fire in EVERY
          // mode (incl. dry-run) — the CRM bell is the canonical channel
          // and the mark is what stops daily re-nudges (anniversary-touch
          // learned this the hard way).
          for (const lead of dueLeads) {
            await writeReviewActivity(db, lead.id, uid);
            if (await writeReviewNotification(db, lead, uid)) notified++;
            await markReviewNudged(db, lead.id);
            nudged++;
          }

          const firstName = user.displayName ? String(user.displayName).split(' ')[0] : '';
          const html = buildEmailHtml({ firstName, dueLeads });
          const subject = `${dueLeads.length} customer${dueLeads.length === 1 ? '' : 's'} ready for a review ask`;

          if (!enabled || !resend) {
            logger.info('review_nudge_dry_run', {
              uid, email: user.email, count: dueLeads.length,
              sample: dueLeads.slice(0, 3).map(l => l.id),
            });
            continue;
          }

          await resend.emails.send({
            from: fromAddress,
            to: user.email,
            subject,
            html,
          });
          emailed++;
        } catch (e) {
          logger.warn('review_nudge_user_error', { uid, err: e.message });
          failed++;
        }
      }

      if (usersSnap.size < 500) break;
      userCursor = usersSnap.docs[usersSnap.docs.length - 1];
    }

    logger.info('review_nudge_complete', {
      mode: enabled ? 'live' : 'dry-run',
      emailed, skippedOptOut, skippedNothing, failed,
      nudged, notified,
      total: totalUsers,
    });
  }
);
