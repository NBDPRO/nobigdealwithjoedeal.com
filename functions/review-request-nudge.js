/**
 * NBD Pro — Post-Win Review Request Nudge
 * ═══════════════════════════════════════════════════════════════
 *
 * Mirrors the anniversary-touch.js pattern: a scheduled Cloud Function
 * that scans every rep's book for jobs that recently became PAID IN FULL
 * (functions/paid-in-full.js — a won stage at or after Final Payment and no
 * invoice still owing; Jo, 2026-10-03) without a review request, then
 * nudges the rep. Until 2026-10-03 any won stage counted, Install Done
 * included, so the ask came before the money — 0 of 36 won/paid jobs in
 * prod had ever been asked. Reviews are the
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
 *   2. Gate + window: paid in full, 3–21 days ago (the later of entering
 *      the paid stage and the last invoice payment) — fresh enough that
 *      the homeowner still remembers the crew's name.
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
// Paid in full (Jo, 2026-10-03): the ask waits until the job's money is in —
// the ONE rule the client bell / review deck / spine task also use.
const PIF = require('./paid-in-full');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM     = defineSecret('EMAIL_FROM');

const DAY_MS = 24 * 60 * 60 * 1000;
// Ask window: 3-21 days after the job became PAID IN FULL (the later of
// entering its paid stage and its last invoice payment — paid-in-full.js).
// Before 2026-10-03 this counted from ANY won stage, Install Done included,
// so the ask landed in the middle of the final-payment conversation. The
// upper bound stops stale payoffs (rep on vacation, backfilled data) from
// generating awkward months-later asks.
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
  // Eastern (the server runs in UTC: a 9:30pm win printed as the next day).
  return new Date(ms).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
}

function buildEmailHtml({ firstName, dueLeads }) {
  const dashboardUrl  = 'https://nobigdealwithjoedeal.com/pro/dashboard.html';
  const customerBase  = 'https://nobigdealwithjoedeal.com/pro/customer.html';
  const total = dueLeads.length;
  const greeting = firstName ? `Hey ${escapeHtml(firstName)},` : 'Hey,';

  // Drop-in script mirroring the CRM's one-tap SMS (ReviewEngine.
  // sendReviewSMS resolves the tenant's own name + review link at send
  // time — this preview stays brand-neutral on purpose).
  // Since 2026-10-03 the ask carries the homeowner's own referral link in the
  // same message (one tap, not two). No reward is mentioned next to a review
  // ask — Google's policy forbids review incentives.
  const sampleScript =
    `Hi {firstName}, thank you so much for trusting us with your project! ` +
    `We'd love to hear how we did. If you have 30 seconds, a Google review means the world to us: {your review link} ` +
    `If you mention your town and what we did (like 'roof replacement in Mason'), it helps your neighbors find us. ` +
    `And if a friend or neighbor ever needs roof work, here's your own link to send them our way: {their referral link}`;

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
          <span style="font-size:12px;color:#6b7280;">Paid in full ${escapeHtml(wonOn)}</span>
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
      <p>${total === 1 ? 'A job' : `${total} jobs`} ${total === 1 ? 'is' : 'are'} paid in full and ${total === 1 ? 'hasn’t' : 'haven’t'} been asked for a Google review yet. The ask converts best in the first couple of weeks, while the crew's name is still fresh — after that the moment is gone.</p>

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

// ─── Multi-job (Jo, J2, 2026-09-30) ─────────────────────────────
// A review ask per completed JOB, never two asks to one customer within 90
// days. A customer with no jobs yet keeps the old rule (once, ever).
const REVIEW_GAP_DAYS = 90;
const FIRST_JOB_ID = 'j1';
const validJobId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : null);
const lastAskMs = (lead) => Math.max(timestampMillis(lead.reviewRequestedAt), timestampMillis(lead.reviewNudgedAt));

/**
 * PURE. Is a review ask due for this job?
 *   jobId null → the customer has no jobs: once per customer, as before.
 *   Otherwise: not if this job was already nudged or asked; not if this is
 *   the first job and the customer was asked under the old per-customer rule
 *   (no reviewJobCount yet); not within 90 days of the customer's last ask.
 */
function reviewAskDue(lead, job, jobId, wonMs, now) {
  const l = lead || {};
  if (!wonMs || wonMs < now - NUDGE_MAX_DAYS * DAY_MS || wonMs > now - NUDGE_MIN_DAYS * DAY_MS) return false;
  if (!l.phone && !l.email) return false;           // nothing to send with
  if (!jobId) return !l.reviewRequested && !timestampMillis(l.reviewNudgedAt);
  const j = job || {};
  if (timestampMillis(j.reviewNudgedAt) || timestampMillis(j.reviewRequestedAt)) return false;
  if (jobId === FIRST_JOB_ID && !l.reviewJobCount && (l.reviewRequested || timestampMillis(l.reviewNudgedAt))) return false;
  const last = lastAskMs(l);
  if (last && now - last < REVIEW_GAP_DAYS * DAY_MS) return false;
  return true;
}

// ─── Paid in full (2026-10-03) ───────────────────────────────────
// A payoff landing more than a year after the job entered its paid stage is
// not worth a daily invoice read per closed customer, forever.
const PAID_LOOKBACK_DAYS = 365;

/**
 * null when `rec` (a lead, or a job doc carrying its lead's tenant) is not
 * paid in full — or its invoices can't be read: fail closed, never ask on a
 * guess. Else { ms }: when it became paid in full, the later of entering the
 * paid stage and the last invoice payment.
 */
async function paidAnchor(db, rec, leadId, jobId, fallbackTs) {
  if (!PIF.isPaidStage(rec)) return null;
  const stageMs = timestampMillis(rec.stageStartedAt) || timestampMillis(fallbackTs) || timestampMillis(rec.updatedAt);
  if (stageMs && stageMs < Date.now() - PAID_LOOKBACK_DAYS * DAY_MS) return null;
  let invoices;
  try { invoices = await PIF.loadLeadInvoices(db, leadId, rec, jobId || null); }
  catch (e) { logger.warn('review_nudge_invoices_read_failed', { leadId, err: e.message }); return null; }
  if (!PIF.paidInFull(rec, invoices)) return null;
  return { ms: Math.max(stageMs, PIF.lastPaidMs(invoices)) };
}

// ─── Per-user aggregation ────────────────────────────────────────
async function findReviewDueLeads(db, uid) {
  const now = Date.now();                            // the 3–21 day window lives in reviewAskDue

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

    // Paid in full (2026-10-03) — a won stage at or after Final Payment AND
    // no invoice still owing. The stage half is free (no read), so Install
    // Done / Final Photos / Collections never cost an invoice query.
    const jobId = validJobId(lead.activeJobId);
    if (!jobId && (lead.reviewRequested || timestampMillis(lead.reviewNudgedAt))) continue;   // asked once, ever (no read)
    if (!lead.phone && !lead.email) continue;                                                  // nothing to send with
    const paid = await paidAnchor(db, lead, lead.id, jobId);
    if (!paid) continue;

    // Paid recently enough? The later of entering the paid stage
    // (stageStartedAt, stamped by every moveCard; updatedAt is the
    // pre-rollout fallback) and the last invoice payment. The lead's fields
    // are its ACTIVE job's; that job's own latch lives on its job doc.
    const wonMs = paid.ms;
    let job = null;
    if (jobId && reviewAskDue(lead, null, jobId, wonMs, now)) {
      try { const js = await db.collection('leads').doc(lead.id).collection('jobs').doc(jobId).get(); job = js.exists ? js.data() : null; }
      catch (_) { job = null; }
    }
    if (!reviewAskDue(lead, job, jobId, wonMs, now)) continue;
    out.push({ ...lead, wonMs, jobId, jobTitle: (job && job.title) || null });
  }

  // A customer's OTHER jobs that were won recently (multi-job). One
  // collection-group read; the single-field COLLECTION_GROUP index on
  // userId (#1917) serves it.
  let jobSnap = { docs: [] };
  if (typeof db.collectionGroup === 'function') {
    try { jobSnap = await db.collectionGroup('jobs').where('userId', '==', uid).limit(5000).get(); }
    catch (e) { logger.warn('review_nudge_jobs_read_failed', { uid, err: e.message }); }
  }
  for (const d of jobSnap.docs) {
    const job = d.data() || {};
    const leadId = d.ref && d.ref.parent && d.ref.parent.parent && d.ref.parent.parent.id;
    if (!leadId || roles.roleFor(job) !== roles.ROLE.WON || !PIF.isPaidStage(job)) continue;
    // A job's latches first (no read): already nudged or asked → skip.
    if (timestampMillis(job.reviewNudgedAt) || timestampMillis(job.reviewRequestedAt)) continue;
    let lead;
    try { const ls = await db.collection('leads').doc(leadId).get(); lead = ls.exists ? { id: leadId, ...ls.data() } : null; }
    catch (_) { lead = null; }
    if (!lead || lead.deleted || lead.isProspect) continue;
    if (lead.activeJobId === d.id) continue;                               // covered above
    // The job's own invoices (its jobId, or none stamped) must owe nothing.
    const paid = await paidAnchor(db, Object.assign({}, job, { companyId: lead.companyId, userId: lead.userId }), leadId, d.id, job.closedAt);
    if (!paid) continue;
    const wonMs = paid.ms;
    if (!reviewAskDue(lead, job, d.id, wonMs, now)) continue;
    out.push({ ...lead, wonMs, jobId: d.id, jobTitle: job.title || null });
  }

  // Never two asks to one customer in one sweep: keep their newest win.
  const byLead = new Map();
  for (const e of out) { const cur = byLead.get(e.id); if (!cur || e.wonMs > cur.wonMs) byLead.set(e.id, e); }
  const list = [...byLead.values()];
  list.sort((a, b) => b.wonMs - a.wonMs);
  return list;
}

async function writeReviewActivity(db, leadId, uid) {
  try {
    await db.collection(`leads/${leadId}/activity`).add({
      userId: uid,
      type: 'review_request_due',
      label: 'Google review ask due',
      message: 'This job is paid in full — a review ask converts best in the first two weeks.',
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
    // Deduped per customer — and, for a job, per job: a customer's second job
    // a year later gets its own bell. The client engine's bells carry no
    // jobId, so for a job any job-less bell from the last 30 days counts as
    // this one. Equality-only query (no composite index), checked in memory.
    const existing = await db.collection('notifications')
      .where('userId', '==', uid)
      .where('leadId', '==', lead.id)
      .where('type', '==', 'review_request')
      .limit(lead.jobId ? 50 : 1)
      .get();
    if (!lead.jobId) { if (!existing.empty) return false; }
    else {
      const recent = Date.now() - 30 * DAY_MS;
      const dup = existing.docs.some((d) => { const n = d.data() || {}; return n.jobId ? n.jobId === lead.jobId : timestampMillis(n.createdAt) > recent; });
      if (dup) return false;
    }
    const customerName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Customer';
    const note = {
      userId: uid,
      leadId: lead.id,
      type: 'review_request',
      title: '⭐ Request a Review',
      message: `${customerName}'s ${lead.jobTitle ? lead.jobTitle + ' job' : 'project'} is complete — send a review request?`,
      read: false,
      dismissed: false,
      createdAt: FieldValue.serverTimestamp(),
    };
    if (lead.jobId) note.jobId = lead.jobId;
    await db.collection('notifications').add(note);
    return true;
  } catch (e) {
    logger.warn('review_nudge_notification_failed', { leadId: lead.id, err: e.message });
    return false;
  }
}

async function markReviewNudged(db, leadId, jobId) {
  try {
    const patch = { reviewNudgedAt: FieldValue.serverTimestamp() };
    // Multi-job: the job's own latch, plus a count so the "asked under the
    // old per-customer rule" check never mistakes a new-rule ask for one.
    if (jobId) patch.reviewJobCount = FieldValue.increment(1);
    await db.doc(`leads/${leadId}`).update(patch);
    if (jobId) await db.doc(`leads/${leadId}/jobs/${jobId}`).update({ reviewNudgedAt: FieldValue.serverTimestamp() });
  } catch (e) {
    logger.warn('review_nudge_mark_failed', { leadId, jobId, err: e.message });
  }
}

/**
 * One user's nudge pass: find the due review asks and, for each, write the
 * activity row + bell + the once-ever mark. Returns the due leads. Shared by
 * the 08:15 run and the 06:45 morning brief (which carries the OWNER's list
 * in its email when it absorbs this one — morning-brief-absorb.js).
 */
async function nudgeUser(db, uid) {
  const dueLeads = await findReviewDueLeads(db, uid);
  let notified = 0;
  for (const lead of dueLeads) {
    await writeReviewActivity(db, lead.id, uid);
    if (await writeReviewNotification(db, lead, uid)) notified++;
    await markReviewNudged(db, lead.id, lead.jobId || null);
  }
  return { dueLeads, notified };
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

    let emailed = 0, skippedOptOut = 0, skippedNothing = 0, failed = 0, skippedAbsorbed = 0;
    // The owner's asks went out in the 06:45 brief (bell + mark included).
    const absorbedOwner = await require('./morning-brief-absorb').briefAbsorbs(db);
    const OWNER_UID = require('./morning-brief-absorb').OWNER;
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
        if (absorbedOwner && uid === OWNER_UID)       { skippedAbsorbed++; continue; }

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
            await markReviewNudged(db, lead.id, lead.jobId || null);
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
      emailed, skippedOptOut, skippedNothing, failed, skippedAbsorbed,
      nudged, notified,
      total: totalUsers,
    });
  }
);

exports.nudgeUser = nudgeUser;
exports._test = { reviewAskDue, findReviewDueLeads, markReviewNudged, writeReviewNotification, nudgeUser, REVIEW_GAP_DAYS, paidAnchor, buildEmailHtml };
