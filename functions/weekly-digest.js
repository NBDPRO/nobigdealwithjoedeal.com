/**
 * NBD Pro — Weekly Digest Email
 * ═══════════════════════════════════════════════════════════════
 *
 * Scheduled Cloud Function that emails each rep a Monday-morning
 * recap of the previous 7 days: new leads, won deals + revenue,
 * lost deals, total pipeline value, and the top 5 new leads.
 *
 * Reps who don't open the dashboard daily lose track of momentum.
 * The digest is the "where am I" snapshot they get without having
 * to log in. The notification bell (Wave 13) handles real-time
 * alerts; this handles the slower weekly rhythm.
 *
 * Schedule: Monday 7am Eastern (Cincinnati-based business). Runs
 * once per week. Per-user opt-out via users/{uid}.weeklyDigestEnabled
 * === false. E2E test accounts are always skipped.
 *
 * Gate: WEEKLY_DIGEST_ENABLED env var. When unset/false, runs in
 * DRY-RUN mode — logs eligible recipients but does not send. Lets
 * us deploy and observe before flipping the switch.
 */

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { FieldPath, getFirestore, Timestamp } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { Resend } = require('resend');
const stageRoles = require('./stage-roles');
// The ONE money reader ('$45,000' → 45000) and the jobs rule the Home KPI
// tiles use (review R2, 2026-10-06).
const { moneyValue } = require('./customer-estimate-rows');
const { jobRecords, jobsByLeadFromDocs } = require('./jobs-logic');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM     = defineSecret('EMAIL_FROM');

// A signed contract is BOOKED, not open pipeline (Jo, 2026-10-06): a "win"
// is the shared sale test (stage-roles.js isSale — contract_signed, any
// in-production job stage, any won stage, persisted stageRole first so a
// tenant's custom stage counts). The kanban header, the Home KPI tiles and
// agent crm_summary use the same test. This replaced two hand-kept Sets
// that had drifted: they counted job_created…install_in_progress (and
// contract_signed, in the pipeline scan) as open pipeline.
function _isWonLead(l) {
  return stageRoles.isSale(l);
}
function _isLostLead(l) {
  const key = String(l && l.stage || '').toLowerCase();
  if (key === 'lost') return true;
  return stageRoles.roleFor(l) === stageRoles.ROLE.LOST;
}
// Out of the active pipeline: booked (a sale) or lost.
function _isTerminalLead(l) {
  return stageRoles.isSale(l) || _isLostLead(l);
}
// When a win happened: the close date (stamped at signing — stage-roles.js
// needsClosedAt), else the current stage's start. Without closedAt a deal
// signed in March would re-count as "won this week" when it moves to
// Permit Pulled.
function _wonAtMs(l) {
  return timestampMillis(l.closedAt) || timestampMillis(l.stageStartedAt);
}

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ─── Branded HTML template (mirrors email-functions.js styling) ──
const TEMPLATE_STYLES = `
  body { font-family: 'Barlow','Segoe UI',Roboto,sans-serif; line-height:1.6; color:#333; background:#f5f5f5; margin:0; padding:0; }
  .container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,0.08); }
  .header { background:linear-gradient(135deg,#BD5728 0%,#a14a22 100%); color:#fff; padding:32px 24px; text-align:center; }
  .header h1 { margin:0 0 6px; font-size:24px; font-weight:700; letter-spacing:-0.3px; }
  .header p { margin:0; font-size:13px; opacity:0.9; }
  .content { padding:28px 24px; color:#1f2937; }
  .stats { display:table; width:100%; border-collapse:separate; border-spacing:8px; margin:18px 0 24px; }
  .stat { display:table-cell; background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:14px 12px; text-align:center; vertical-align:top; }
  .stat-value { font-size:24px; font-weight:700; color:#1a3057; line-height:1.1; margin-bottom:4px; }
  .stat-label { font-size:11px; color:#6b7280; text-transform:uppercase; letter-spacing:0.4px; font-weight:600; }
  .stat.success .stat-value { color:#166534; }
  .stat.warn    .stat-value { color:#9a3412; }
  .lead-list { margin:20px 0; }
  .lead-row { padding:10px 12px; border-bottom:1px solid #f1f5f9; font-size:13px; color:#1f2937; }
  .lead-row:last-child { border-bottom:none; }
  .lead-name { font-weight:600; color:#111827; }
  .lead-sub { color:#6b7280; font-size:12px; margin-top:2px; }
  .empty { padding:24px; text-align:center; color:#6b7280; font-size:13px; font-style:italic; }
  .cta { display:inline-block; margin-top:18px; padding:12px 24px; background:#BD5728; color:#fff; border-radius:6px; text-decoration:none; font-weight:600; }
  .footer { background:#1a3057; color:#94a3b8; padding:18px 24px; text-align:center; font-size:11px; }
  .footer a { color:#BD5728; text-decoration:none; }
  h2 { color:#1a3057; margin:0 0 8px; font-size:18px; }
  p { margin:8px 0; }
`;

function fmtMoney(n) {
  const v = Math.round(Number(n) || 0);
  // A refund week can net negative: "-$250", not "$-250".
  return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function buildDigestHtml(d) {
  const greeting = d.firstName ? `Good morning, ${escapeHtml(d.firstName)}` : 'Good morning';
  const newLeadRows = d.topLeads.length === 0
    ? `<div class="empty">No new leads this week. Time to hit the route.</div>`
    : d.topLeads.map(l => {
        const name = `${l.firstName || ''} ${l.lastName || ''}`.trim() || 'New lead';
        const sub  = [l.address, l.phone].filter(Boolean).join(' · ');
        return `
          <div class="lead-row">
            <div class="lead-name">${escapeHtml(name)}</div>
            ${sub ? `<div class="lead-sub">${escapeHtml(sub)}</div>` : ''}
          </div>`;
      }).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Your week at NBD Pro</title>
  <style>${TEMPLATE_STYLES}</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Your Week at a Glance</h1>
      <p>NBD Pro · ${escapeHtml(d.weekLabel)}</p>
    </div>
    <div class="content">
      <h2>${greeting}.</h2>
      <p>Here's how the last 7 days looked across your pipeline.</p>

      <div class="stats">
        <div class="stat">
          <div class="stat-value">${d.newLeadsCount}</div>
          <div class="stat-label">New Leads</div>
        </div>
        <div class="stat success">
          <div class="stat-value">${d.wonCount}</div>
          <div class="stat-label">Closed</div>
        </div>
        <div class="stat warn">
          <div class="stat-value">${d.lostCount}</div>
          <div class="stat-label">Lost</div>
        </div>
      </div>

      <div class="stats">
        <div class="stat success">
          <div class="stat-value">${fmtMoney(d.collectedThisWeek || 0)}</div>
          <div class="stat-label">Revenue Collected (Wk)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${fmtMoney(d.wonRevenue)}</div>
          <div class="stat-label">Won This Week (booked)</div>
        </div>
        <div class="stat">
          <div class="stat-value">${fmtMoney(d.activePipelineValue)}</div>
          <div class="stat-label">Active Pipeline</div>
        </div>
      </div>

      <h2 style="margin-top:24px;">New leads this week</h2>
      <div class="lead-list">${newLeadRows}</div>

      ${d.topLeads.length > 0 ? `
        <p style="text-align:center; margin-top:8px;">
          <a href="https://nobigdealwithjoedeal.com/pro/dashboard.html" class="cta">Open Dashboard</a>
        </p>` : ''}

      <p style="font-size:12px; color:#6b7280; margin-top:24px; text-align:center;">
        Want fewer emails? <a href="https://nobigdealwithjoedeal.com/pro/dashboard.html#settings" style="color:#BD5728;">Manage your digest preferences</a>.
      </p>
    </div>
    <div class="footer">
      <p>No Big Deal Home Solutions · (859) 420-7382 · jd@nobigdealwithjoedeal.com</p>
    </div>
  </div>
</body>
</html>`;
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
}

function timestampMillis(t) {
  if (!t) return 0;
  if (typeof t.toMillis === 'function') return t.toMillis();
  if (typeof t.toDate === 'function')   return t.toDate().getTime();
  if (typeof t === 'number')            return t;
  // Payment dates may be Date objects or ISO strings (invoice ledger writers).
  if (t instanceof Date)                return t.getTime();
  if (typeof t === 'string')            { const n = Date.parse(t); return isNaN(n) ? 0 : n; }
  return 0;
}

// Invoice payments with their dates — mirrors collected-revenue.js paymentsOf:
// the payments[] ledger (+ a synthetic remainder when it sums short of
// total−balanceDue), else one lump dated lastPaymentAt||paidAt — plus
// refunds[] as negative entries on the refund date (_refundsOf).
function _paymentsOf(inv) {
  return _paymentsOnlyOf(inv).concat(_refundsOf(inv));
}

// Refunds / lost chargebacks (invoices.refunds[], written by the Stripe
// ledger) come off revenue on the day the money went back. A failed or
// canceled refund, or a dispute Jo won, returned nothing. Same rule as
// refundsOf in the four client readers —
// tests/refunds-in-revenue-2026-09-29.test.js checks parity.
function _refundsOf(inv) {
  const out = [];
  const list = Array.isArray(inv && inv.refunds) ? inv.refunds : [];
  list.forEach(r => {
    r = r || {};
    const amt = Number(r.amount);
    const at = r.at != null ? r.at : r.date;
    if (!(amt > 0) || at == null || r.status === 'failed' || r.status === 'canceled' || r.status === 'won') return;
    out.push({ amount: -amt, at, refund: true });
  });
  return out;
}

function _paymentsOnlyOf(inv) {
  const total = Number(inv.total) || 0;
  const bal = inv.balanceDue != null ? (Number(inv.balanceDue) || 0) : 0;
  const collectedCents = Math.round(Math.max(0, total - bal) * 100);
  if (Array.isArray(inv.payments) && inv.payments.length) {
    const out = [];
    let ledgerCents = 0, earliestAt = null, earliestMs = Infinity;
    inv.payments.forEach(p => {
      const amt = Number(p && p.amount);
      const at = p && (p.at != null ? p.at : p.date);
      if (!(amt > 0) || at == null) return;
      out.push({ amount: amt, at });
      ledgerCents += Math.round(amt * 100);
      const ms = timestampMillis(at);
      if (ms && ms < earliestMs) { earliestMs = ms; earliestAt = at; }
    });
    if (out.length) {
      const rem = collectedCents - ledgerCents;
      if (rem >= 1) {
        const remAt = earliestAt != null ? earliestAt : (inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt);
        if (remAt != null) out.push({ amount: rem / 100, at: remAt, synthetic: true });
      }
      return out;
    }
  }
  if (collectedCents <= 0) return [];
  const payDate = inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt;
  return payDate == null ? [] : [{ amount: collectedCents / 100, at: payDate }];
}

// ─── Per-user aggregation ───────────────────────────────────────
// Audit #4 Phase 5 (2026-07-04): the single whole-book scan (2000-doc cap,
// silent truncation for big reps) is split into three bounded reads:
//   1. createdAt >= cutoff   — this week's NEW leads (existing index
//      leads(userId ASC, createdAt DESC) covers it)
//   2. updatedAt >= cutoff   — candidates for won/lost-this-week (stage
//      filtered in memory; new index leads(userId ASC, updatedAt DESC))
//   3. a paginated PROJECTION (stage, jobValue, deleted only) over the
//      full book for activePipelineValue — that number genuinely needs
//      every open lead, but 3 small fields per doc instead of whole
//      documents, and paginated with no truncation cap.
// The weekly deltas can no longer be wrong for reps with >2000 leads.
async function aggregateUserMetrics(db, uid) {
  const now = Date.now();
  const cutoff = now - ONE_WEEK_MS;
  const cutoffTs = Timestamp.fromMillis(cutoff);

  const [createdSnap, updatedSnap] = await Promise.all([
    db.collection('leads')
      .where('userId', '==', uid)
      .where('createdAt', '>=', cutoffTs)
      .orderBy('createdAt', 'desc')
      .limit(2000)
      .get(),
    db.collection('leads')
      .where('userId', '==', uid)
      .where('updatedAt', '>=', cutoffTs)
      .orderBy('updatedAt', 'desc')
      .limit(2000)
      .get(),
  ]);

  const newLeads = createdSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => !l.deleted);

  const touchedThisWeek = updatedSnap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(l => !l.deleted);

  // Won THIS WEEK = closed in the window (_wonAtMs: closedAt, else
  // stageStartedAt), not merely touched: a March close that got a note on
  // Tuesday is not a win this week. stageStartedAt is stamped on every stage
  // move (backfilled by migrations 002/003); a doc with neither date falls
  // back to "touched this week".
  const wonThisWeek = touchedThisWeek.filter(_isWonLead)
    .filter(l => !_wonAtMs(l) || _wonAtMs(l) >= cutoff);
  // BOOKED value of those wins — projected, not money (labelled so below).
  const wonRevenue = wonThisWeek.reduce((s, l) => s + moneyValue(l.jobValue), 0);

  // Revenue = money COLLECTED this week (Jo, 2026-09-28: "Revenue is always
  // collected only"): each invoice payment by the date it arrived. Same
  // ledger logic as docs/pro/js/collected-revenue.js paymentsOf. createdBy is
  // a single-field filter (no composite index); dates are filtered here.
  let collectedCents = 0;
  try {
    const invSnap = await db.collection('invoices').where('createdBy', '==', uid).limit(5000).get();
    invSnap.docs.forEach(d => {
      const inv = d.data() || {};
      if (inv.deleted === true) return;
      _paymentsOf(inv).forEach(p => {
        if (timestampMillis(p.at) >= cutoff) collectedCents += Math.round((Number(p.amount) || 0) * 100);
      });
    });
  } catch (e) {
    logger.warn('weekly_digest_invoice_read_failed', { uid, err: e && e.message });
  }
  const collectedThisWeek = collectedCents / 100;

  const lostThisWeek = touchedThisWeek.filter(_isLostLead);

  // Active pipeline = every non-terminal JOB regardless of recency — a
  // customer's second open job adds its own value, like the Home KPI tiles
  // (jobs-logic.js jobRecords; review R2-2-7, 2026-10-06).
  // Paginated field-mask read: ~4 fields/doc instead of full documents,
  // and no truncation cap — big books just take more (cheap) pages.
  let activePipelineValue = 0;
  const pipeLeads = [];
  let cursor = null;
  for (let page = 0; page < 200; page++) {
    let q = db.collection('leads')
      .where('userId', '==', uid)
      .orderBy(FieldPath.documentId())
      // stageRole added 2026-09-15 — without it in the field mask, _isTerminalLead's
      // role fallback would always see it as undefined and silently degrade to the
      // hardcoded-only check this fix exists to get past.
      .select('stage', 'stageRole', 'jobValue', 'deleted', 'activeJobId')
      .limit(1000);
    if (cursor) q = q.startAfter(cursor);
    const pageSnap = await q.get();
    for (const d of pageSnap.docs) {
      const l = d.data();
      if (l.deleted) continue;
      pipeLeads.push(Object.assign({ id: d.id }, l));
    }
    if (pageSnap.size < 1000) break;
    cursor = pageSnap.docs[pageSnap.docs.length - 1];
  }
  // The rep's jobs (userId equality on the jobs collection group — the index
  // exists). Best-effort: a failed read leaves each customer counted once.
  let jobsByLead = null;
  try {
    const jobSnap = await db.collectionGroup('jobs').where('userId', '==', uid)
      .select('stage', 'stageRole', 'jobValue').limit(5000).get();
    jobsByLead = jobsByLeadFromDocs(jobSnap.docs);
  } catch (e) {
    logger.warn('weekly_digest_jobs_read_failed', { uid, err: e && e.message });
  }
  for (const r of jobRecords(pipeLeads, jobsByLead)) {
    if (_isTerminalLead(r)) continue;
    activePipelineValue += moneyValue(r.jobValue);
  }

  // Sort new leads by creation time desc, take top 5 for display.
  const topLeads = [...newLeads]
    .sort((a, b) => timestampMillis(b.createdAt) - timestampMillis(a.createdAt))
    .slice(0, 5);

  return {
    newLeadsCount: newLeads.length,
    wonCount: wonThisWeek.length,
    lostCount: lostThisWeek.length,
    wonRevenue,
    collectedThisWeek,
    activePipelineValue,
    topLeads,
    // !== 0: a refund-only week nets negative and is still worth reporting.
    hasAnyActivity: newLeads.length > 0 || wonThisWeek.length > 0 || lostThisWeek.length > 0 || collectedCents !== 0,
  };
}

// For tests (tests/r2-money-parse-multijob-2026-10-06.test.js runs it on a
// fake db). index.js re-exports only weeklyDigest, so this deploys nothing.
exports._aggregateUserMetrics = aggregateUserMetrics;

// ─── Scheduled function ─────────────────────────────────────────
exports.weeklyDigest = onSchedule(
  {
    // Monday 7am Eastern. Cincinnati-based business — most reps are
    // Eastern. The cron syntax is interpreted in the timeZone option.
    schedule: '0 7 * * MON',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 1,
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const enabled = process.env.WEEKLY_DIGEST_ENABLED === 'true';
    const db = getFirestore();

    const resend = enabled && process.env.RESEND_API_KEY
      ? new Resend(process.env.RESEND_API_KEY)
      : null;
    const fromAddress = process.env.EMAIL_FROM || 'Joe Deal <jd@nobigdealwithjoedeal.com>';

    let sent = 0, skipped = 0, failed = 0, noActivity = 0;

    // Friendly week label like "Apr 28 — May 4".
    const now = new Date();
    const weekStart = new Date(now.getTime() - ONE_WEEK_MS);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const weekLabel = `${fmt(weekStart)} — ${fmt(now)}`;

    // 2.6: paginate ALL users. The previous single .limit(500).get() meant
    // user #501+ was silently never processed once team/tenant count grew
    // past 500. Page by document id so every user is covered.
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
      const uid = userDoc.id;

      if (!user.email || !isValidEmail(user.email)) { skipped++; continue; }
      if (user.weeklyDigestEnabled === false)        { skipped++; continue; }
      if (user.e2eTestAccount)                       { skipped++; continue; }

      try {
        const metrics = await aggregateUserMetrics(db, uid);

        // Skip the digest entirely for users with no movement at all
        // this week. Nothing more demoralizing than a "0 / 0 / 0" recap.
        // We still want to nudge dormant users eventually but that's
        // a different cron (re-engagement), not the weekly digest.
        if (!metrics.hasAnyActivity) { noActivity++; continue; }

        const firstName = user.displayName ? String(user.displayName).split(' ')[0] : '';
        const html = buildDigestHtml({ ...metrics, firstName, weekLabel });
        const subject = `Your NBD week: ${metrics.newLeadsCount} new · ${metrics.wonCount} closed · ${fmtMoney(metrics.collectedThisWeek || 0)} collected`;

        if (!enabled || !resend) {
          logger.info('weekly_digest_dry_run', {
            uid, email: user.email,
            newLeads: metrics.newLeadsCount,
            won: metrics.wonCount,
            lost: metrics.lostCount,
            wonRevenue: metrics.wonRevenue,
          });
          skipped++;
          continue;
        }

        await resend.emails.send({
          from: fromAddress,
          to: user.email,
          subject,
          html,
        });

        await userDoc.ref.update({
          lastDigestSentAt: FieldValue.serverTimestamp(),
        });

        sent++;
      } catch (e) {
        logger.warn('weekly_digest_user_error', { uid, err: e.message });
        failed++;
      }
      }

      if (usersSnap.size < 500) break;
      userCursor = usersSnap.docs[usersSnap.docs.length - 1];
    }

    logger.info('weekly_digest_complete', {
      mode: enabled ? 'live' : 'dry-run',
      sent, skipped, failed, noActivity,
      total: totalUsers,
    });
  }
);
