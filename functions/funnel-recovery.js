/**
 * NBD — Abandoned Funnel Recovery
 * ═══════════════════════════════════════════════════════════════
 *
 * When a visitor enters their email in /estimate but abandons before
 * completing, we save the partial state. One hour later, a scheduled
 * job fires a warm recovery email signed by Joe with a link back.
 *
 * Functions:
 *   - saveFunnelProgress (HTTP onRequest)  — client posts partial/complete state
 *   - runAbandonRecovery (onSchedule hourly) — sends recovery emails
 *
 * Firestore:
 *   funnel_abandoned/{docId}  — one record per unique funnel session
 *
 * Safety:
 *   The scheduled function is GATED by the FUNNEL_RECOVERY_ENABLED
 *   env var. When unset OR not === "true", the job runs in DRY-RUN
 *   mode — it logs which emails *would* have been sent but does not
 *   actually send. Enable production sending via:
 *     firebase functions:config:set  (legacy — not used here)
 *   or set FUNNEL_RECOVERY_ENABLED=true on the runAbandonRecovery
 *   function via the Google Cloud Console (Cloud Run → edit & deploy
 *   new revision → environment variables) OR via gcloud:
 *     gcloud run services update runabandonrecovery \
 *       --region=us-central1 \
 *       --update-env-vars=FUNNEL_RECOVERY_ENABLED=true
 *
 * Future work:
 *   - Token-based resume that pre-fills the funnel from saved state
 *   - Second-touch SMS at 24h (needs TCPA consent gating)
 *   - Retry-on-failure + bounce tracking via Resend webhooks
 */

const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { Resend } = require('resend');
const { httpRateLimit, enforceRateLimit } = require('./integrations/upstash-ratelimit');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const Suppression = require('./email-suppression');

// ───────────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────────

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

const SITE_URL = 'https://nobigdealwithjoedeal.com';
const REPLY_TO = 'jd@nobigdealwithjoedeal.com';
const ABANDON_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RECOVERY_MAX_AGE_DAYS = 30; // Don't send recovery if record is older than this
// runAbandonRecovery paging: unprocessed records only, newest first.
const RECOVERY_RETRY_STATUSES = [null, 'failed'];
const RECOVERY_PAGE_SIZE = 200;
const RECOVERY_MAX_PER_RUN = 400; // bounded under the 300s timeout; the rest wait an hour
// The /estimate funnel is NBD's own public site (tenant zero): its visitors'
// unsubscribes are recorded against NBD's tenant key. Same constant +
// override as lead-bridge.js / estimate-email.js.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// ───────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && EMAIL_RE.test(email);
}

function sanitizeString(value, maxLen = 200) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

// firstName is whatever the public funnel was sent, and this email goes to
// whatever address was typed — escape it so the name can't carry links or
// markup into a branded email (security audit 2026-09-29).
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildRecoveryEmailHtml({ firstName }) {
  const greeting = firstName ? `Hey ${escHtml(firstName)},` : 'Hey,';
  const resumeUrl = `${SITE_URL}/estimate?utm_source=recovery&utm_medium=email&utm_campaign=abandoned-funnel`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Your No Big Deal estimate is waiting</title></head>
<body style="margin:0;padding:0;font-family:'Segoe UI',Arial,sans-serif;background:#f5f3ef;color:#1a1a1a;line-height:1.6;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <div style="background:#12223d;color:#fff;padding:20px 24px;border-radius:10px 10px 0 0;text-align:center;">
      <div style="font-size:18px;font-weight:800;letter-spacing:.06em;">NO BIG DEAL</div>
      <div style="font-size:11px;color:rgba(255,255,255,.7);letter-spacing:.08em;text-transform:uppercase;margin-top:4px;">Home Solutions</div>
    </div>
    <div style="background:#fff;padding:32px 28px;border-radius:0 0 10px 10px;border:1px solid #e8e5e0;border-top:none;">
      <p style="font-size:16px;margin:0 0 16px;">${greeting}</p>
      <p style="font-size:16px;margin:0 0 16px;">Joe here. I noticed you started an estimate on my site but didn't get a chance to finish it — totally understand, life happens.</p>
      <p style="font-size:16px;margin:0 0 16px;">If you still want that roof / siding / gutter estimate (no pressure, no pushy follow-ups), just pick up where you left off:</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${resumeUrl}" style="display:inline-block;background:#bd5728;color:#fff;padding:14px 28px;border-radius:8px;font-weight:800;font-size:15px;text-decoration:none;letter-spacing:.02em;">Finish my estimate →</a>
      </div>
      <p style="font-size:15px;margin:0 0 16px;">Or if it's easier, just call or text me directly — I answer my own phone:</p>
      <p style="font-size:15px;margin:0 0 16px;"><strong>📞 (859) 420-7382</strong></p>
      <p style="font-size:15px;margin:0 0 8px;">Either way, no big deal.</p>
      <p style="font-size:15px;margin:0;">— Joe</p>
    </div>
    <div style="text-align:center;font-size:12px;color:#6b7280;padding:20px 16px;">
      <p style="margin:0 0 6px;">No Big Deal Home Solutions · Greater Cincinnati, OH</p>
      <p style="margin:0;">Licensed &amp; insured · GAF Certified · Owner-operated by Joe Deal</p>
    </div>
  </div>
</body>
</html>`;
}

function buildRecoveryEmailText({ firstName }) {
  const greeting = firstName ? `Hey ${firstName},` : 'Hey,';
  const resumeUrl = `${SITE_URL}/estimate?utm_source=recovery&utm_medium=email&utm_campaign=abandoned-funnel`;
  return [
    greeting,
    '',
    "Joe here. I noticed you started an estimate on my site but didn't get a chance to finish it — totally understand, life happens.",
    '',
    "If you still want that roof / siding / gutter estimate (no pressure, no pushy follow-ups), just pick up where you left off:",
    '',
    resumeUrl,
    '',
    "Or if it's easier, just call or text me directly — I answer my own phone:",
    '',
    '(859) 420-7382',
    '',
    "Either way, no big deal.",
    '',
    '— Joe',
    '',
    '---',
    'No Big Deal Home Solutions · Greater Cincinnati, OH',
    'Licensed & insured · GAF Certified · Owner-operated by Joe Deal',
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────
// saveFunnelProgress — HTTP endpoint called by the estimate funnel
// ───────────────────────────────────────────────────────────────
//
// Request body:
//   {
//     email: string (required, validated),
//     funnelId: string (required — client-generated UUID),
//     firstName?: string,
//     lastName?: string,
//     phoneNumber?: string,
//     address?: string,
//     currentStep?: number,
//     completed?: boolean   (true when user finishes the funnel)
//   }
//
// Response:
//   { success: true }
//
// The doc ID is the funnelId (not email) so a user who restarts with
// the same email in a new session gets a fresh record. Older
// abandoned records with the same email can coexist; the scheduled
// job handles dedupe.

exports.saveFunnelProgress = onRequest(
  {
    cors: CORS_ORIGINS,
    maxInstances: 10,
    concurrency: 40,
    timeoutSeconds: 10,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ success: false, error: 'POST only' });
      return;
    }

    // Per-IP cap. A legit funnel session posts one progress update per step
    // (~6-8 per visit, debounced); 30/min/IP swallows that with room to
    // spare. Without this, the endpoint was the only unthrottled public
    // writer — and every doc it creates is a future outbound recovery email
    // to an attacker-supplied address via runAbandonRecovery.
    if (!(await httpRateLimit(req, res, 'funnelProgress:ip', 30, 60_000))) return;

    try {
      const body = req.body || {};
      const email = sanitizeString(body.email, 254).toLowerCase();
      const funnelId = sanitizeString(body.funnelId, 64);

      if (!isValidEmail(email)) {
        res.status(400).json({ success: false, error: 'invalid_email' });
        return;
      }
      if (!funnelId || funnelId.length < 8) {
        res.status(400).json({ success: false, error: 'invalid_funnel_id' });
        return;
      }

      // Per-email cap. The doc ID is the client-generated funnelId (see the
      // note below), so the per-IP cap above does nothing to stop one IP from
      // rotating through fresh funnelIds that all target the SAME
      // attacker-supplied email — each one is a distinct funnel_abandoned
      // record and therefore a future outbound recovery email via
      // runAbandonRecovery. 3/day mirrors the funnel's own outbound-email cap
      // (estimate-email.js) and comfortably covers a real visitor restarting
      // the funnel a few times, while bounding how many recovery emails a
      // single burst can queue against an uninvolved address.
      try {
        await enforceRateLimit('funnelProgress:email', email, 3, 24 * 60 * 60 * 1000);
      } catch (e) {
        if (e && e.rateLimited) {
          res.set('Retry-After', String(Math.ceil((e.retryAfterMs || 24 * 60 * 60 * 1000) / 1000)));
          res.status(429).json({ success: false, error: 'rate_limited' });
          return;
        }
        throw e;
      }

      const db = getFirestore();
      const docRef = db.collection('funnel_abandoned').doc(funnelId);
      const now = FieldValue.serverTimestamp();

      const existing = await docRef.get();
      const isNew = !existing.exists;

      const update = {
        email,
        funnelId,
        firstName: sanitizeString(body.firstName, 80),
        lastName: sanitizeString(body.lastName, 80),
        phoneNumber: sanitizeString(body.phoneNumber, 20),
        address: sanitizeString(body.address, 240),
        currentStep: Number.isFinite(body.currentStep) ? body.currentStep : 0,
        updatedAt: now,
      };

      if (isNew) {
        update.createdAt = now;
        update.completedAt = null;
        update.recoveryEmailSentAt = null;
        update.recoveryEmailStatus = null;
      }

      if (body.completed === true) {
        update.completedAt = now;
        update.recoveryEmailStatus = 'skipped_completed';
      }

      await docRef.set(update, { merge: true });

      res.status(200).json({ success: true });
    } catch (err) {
      logger.error('saveFunnelProgress_failed', {
        error: err && err.message,
        stack: err && err.stack,
      });
      res.status(500).json({ success: false, error: 'server_error' });
    }
  }
);

// ───────────────────────────────────────────────────────────────
// runAbandonRecovery — hourly scheduled job
// ───────────────────────────────────────────────────────────────
//
// Query: all funnel_abandoned docs where:
//   - createdAt is older than 1 hour
//   - completedAt is null (user didn't finish)
//   - recoveryEmailSentAt is null (we haven't sent yet)
//   - createdAt is newer than 30 days (don't send stale recoveries)
//
// For each matching doc, send a warm recovery email via Resend,
// signed by Joe, with a direct link back to /estimate.
//
// GATED by FUNNEL_RECOVERY_ENABLED env var. When disabled, runs
// in DRY-RUN mode — logs eligible records but does not send.

exports.runAbandonRecovery = onSchedule(
  {
    schedule: 'every 60 minutes',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async (event) => {
    const enabled = process.env.FUNNEL_RECOVERY_ENABLED === 'true';
    const db = getFirestore();
    const now = Date.now();
    const cutoffOld = new Date(now - ABANDON_WINDOW_MS);
    const cutoffTooOld = new Date(now - RECOVERY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

    // Only UNPROCESSED records, newest first, paged with a cursor (2026-10-03).
    // The old query was a bare createdAt range with .limit(200): Firestore
    // returns a range query in ascending createdAt order, so once the 30-day
    // window held more than 200 records the job re-read the same OLDEST 200
    // (all long since sent/skipped) every hour and a new abandoner was never
    // even looked at. Now each query filters on recoveryEmailStatus, so
    // finished records ('sent', 'sending', 'suppressed', 'skipped_completed')
    // drop out of the result set, and orders newest-first so fresh
    // abandoners are always reached first.
    //
    // `== null` only matches a field that EXISTS with value null — a missing
    // field is invisible to it. saveFunnelProgress has written
    // recoveryEmailStatus: null on every new record since the collection was
    // created (041a6ea0, 2026-04-18), and nothing else writes this
    // collection, so every unprocessed record carries the explicit null.
    // 'failed' is queried separately so a genuine Resend failure is still
    // retried next hour, exactly as before.
    // Index: funnel_abandoned (recoveryEmailStatus ASC, createdAt DESC) in
    // firestore.indexes.json — equality + range/order on different fields.
    const docs = [];
    const seen = new Set(); // a doc can only match one status, but never process one twice
    for (const status of RECOVERY_RETRY_STATUSES) {
      let cursor = null;
      while (docs.length < RECOVERY_MAX_PER_RUN) {
        let q = db
          .collection('funnel_abandoned')
          .where('recoveryEmailStatus', '==', status)
          .where('createdAt', '<', Timestamp.fromDate(cutoffOld))
          .where('createdAt', '>', Timestamp.fromDate(cutoffTooOld))
          .orderBy('createdAt', 'desc');
        if (cursor) q = q.startAfter(cursor);
        const page = await q.limit(RECOVERY_PAGE_SIZE).get();
        for (const d of page.docs) {
          if (docs.length < RECOVERY_MAX_PER_RUN && !seen.has(d.id)) { seen.add(d.id); docs.push(d); }
        }
        if (page.docs.length < RECOVERY_PAGE_SIZE) break;
        cursor = page.docs[page.docs.length - 1];
      }
    }
    const snap = { empty: docs.length === 0, docs, size: docs.length };

    if (snap.empty) {
      logger.info('funnel_recovery_no_eligible', { mode: enabled ? 'live' : 'dry-run' });
      return;
    }

    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let blockedNoAddress = 0; // CAN-SPAM: no postal address configured (2026-10-03)
    let resend = null;
    let fromAddress = 'Joe Deal <jd@nobigdealwithjoedeal.com>';
    if (enabled) {
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) {
        // Throw, don't return: this branch means the function is LIVE
        // (FUNNEL_RECOVERY_ENABLED=true) but its secret binding is broken —
        // a rotated/expired/deleted RESEND_API_KEY. withHeartbeat only pings
        // the dead-man's-switch /fail endpoint on a throw, so a plain return
        // here reported this exact misconfiguration as a healthy, on-time run.
        throw new Error('funnel_recovery_missing_api_key');
      }
      resend = new Resend(apiKey);
      if (process.env.EMAIL_FROM) fromAddress = process.env.EMAIL_FROM;
    }

    for (const doc of snap.docs) {
      const data = doc.data() || {};

      // Skip if already completed or already sent recovery
      if (data.completedAt) { skipped++; continue; }
      if (data.recoveryEmailSentAt) { skipped++; continue; }
      // A prior run claimed this record right before calling Resend (below).
      // Once claimed, it stays excluded from every future run regardless of
      // whether the post-send "sent" stamp ever lands — see the claim write
      // for why that is the only way to guarantee no re-send.
      if (data.recoveryEmailStatus === 'sending') { skipped++; continue; }
      // Unsubscribed on a previous run: already decided, never re-evaluated.
      if (data.recoveryEmailStatus === 'suppressed') { skipped++; continue; }
      if (!isValidEmail(data.email)) { skipped++; continue; }

      const firstName = sanitizeString(data.firstName, 80);

      if (!enabled) {
        logger.info('funnel_recovery_dry_run', {
          funnelId: doc.id,
          email: require('./email-suppression').maskEmail(data.email),   // no PII in logs (2026-10-01)
          firstName,
          age_min: Math.round((now - data.createdAt.toMillis()) / 60000),
        });
        skipped++;
        continue;
      }

      // Email unsubscribe (CAN-SPAM, 2026-09-22). A recovery email is
      // COMMERCIAL: skip an address on NBD's suppression register, and give
      // every one that goes a footer link + one-click List-Unsubscribe
      // headers. Checked BEFORE the claim so a suppressed record is stamped
      // 'suppressed' (terminal) rather than 'sending'. A gate error (register
      // unreadable, token not minted) sends nothing and leaves the record
      // unclaimed — it is retried next hour, never sent unchecked.
      let unsub;
      try {
        unsub = await Suppression.gateCommercialEmail(db, {
          companyId: NBD_OWNER_UID, email: data.email, source: 'funnel-recovery',
        }, { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FieldValue.serverTimestamp });
      } catch (gateErr) {
        logger.error('funnel_recovery_suppression_unverified', {
          funnelId: doc.id, error: gateErr && gateErr.message,
        });
        failed++;
        continue;
      }
      if (unsub.suppressed) {
        logger.info('funnel_recovery_suppressed', { funnelId: doc.id });
        await doc.ref.update({ recoveryEmailStatus: 'suppressed' }).catch(() => {});
        skipped++;
        continue;
      }
      // CAN-SPAM (2026-10-03): no postal address configured for NBD → do not
      // send. Left unclaimed and unstamped (the visitor did nothing), so it
      // goes out on a later run once the address is set, while still inside
      // the recovery window. Counted so the summary log shows it.
      if (unsub.blocked) {
        logger.warn('funnel_recovery_blocked_no_postal_address', { funnelId: doc.id });
        blockedNoAddress++;
        continue;
      }

      // Claim the record BEFORE calling Resend. The eligibility gate above
      // (`recoveryEmailStatus === 'sending'`) is exactly why this must
      // happen first: the OLD code's only exclusion came from the write
      // AFTER the send, so a send that genuinely succeeded but whose
      // bookkeeping write then failed (transient Firestore error,
      // permission blip, deadline exceeded) left recoveryEmailSentAt unset
      // and the homeowner got the same email again next hour. Claiming
      // first means the exclusion is durable before Resend is ever called,
      // so it can never depend on anything that happens after the send.
      try {
        await doc.ref.update({
          recoveryEmailStatus: 'sending',
          recoveryEmailClaimedAt: FieldValue.serverTimestamp(),
        });
      } catch (claimErr) {
        // Couldn't durably claim it — do not send. Worst case this delays a
        // legitimate recovery email by an hour; that's a far better failure
        // mode than a duplicate.
        logger.error('funnel_recovery_claim_failed', {
          funnelId: doc.id,
          error: claimErr && claimErr.message,
        });
        failed++;
        continue;
      }

      try {
        const body = Suppression.applyFooter(unsub,
          buildRecoveryEmailHtml({ firstName }), buildRecoveryEmailText({ firstName }));
        const response = await resend.emails.send({
          from: fromAddress,
          to: data.email,
          replyTo: REPLY_TO,
          subject: 'You started an estimate — want me to finish it?',
          html: body.html,
          text: body.text,
          headers: Object.assign({
            'X-NBD-Campaign': 'funnel-recovery-v1',
          }, unsub.headers),
          // Attributes a bounce/complaint back to this tenant — see
          // functions/resend-webhook.js.
          tags: unsub.tags,
        });
        // Resend resolves { data: null, error } on an API-level rejection
        // instead of throwing — without this check recoveryEmailSentAt
        // gets stamped and the top-of-loop `if (data.recoveryEmailSentAt)
        // skip` guard means this funnel would NEVER be retried.
        if (resendRejected(response)) {
          throw new Error(resendErrorMessage(response));
        }

        try {
          await doc.ref.update({
            recoveryEmailSentAt: FieldValue.serverTimestamp(),
            recoveryEmailStatus: 'sent',
          });
        } catch (stampErr) {
          // The email is already out — do NOT mark this 'failed' (that would
          // clear the 'sending' claim's exclusion and make it eligible for a
          // real re-send next hour). The claim above is what keeps it out of
          // future runs; this is now a bookkeeping gap only, loud enough
          // that it needs a human to reconcile against Resend's own log.
          logger.error('funnel_recovery_stamp_failed_after_send', {
            funnelId: doc.id,
            email: require('./email-suppression').maskEmail(data.email),
            error: stampErr && stampErr.message,
          });
        }
        sent++;
      } catch (err) {
        logger.error('funnel_recovery_send_failed', {
          funnelId: doc.id,
          error: err && err.message,
        });
        try {
          await doc.ref.update({
            recoveryEmailStatus: 'failed',
            recoveryEmailError: (err && err.message) || 'unknown',
          });
        } catch (failWriteErr) {
          // Already claimed 'sending' above; if even this write fails the
          // record simply stays excluded rather than silently reopening.
          logger.error('funnel_recovery_fail_stamp_failed', {
            funnelId: doc.id,
            error: failWriteErr && failWriteErr.message,
          });
        }
        failed++;
      }
    }

    logger.info('funnel_recovery_done', {
      mode: enabled ? 'live' : 'dry-run',
      eligible: snap.size,
      sent,
      skipped,
      failed,
      blockedNoAddress,
    });
  }
);
