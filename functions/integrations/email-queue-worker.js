/**
 * integrations/email-queue-worker.js — F1
 *
 * Polls email_queue/{id} every minute and hands each pending row to
 * Resend. Keeps the existing direct-send paths (sendEmail etc.) in
 * place for latency-sensitive flows; this worker is for the fire-
 * and-forget emails enqueued by D7 (GDPR erasure confirmation) and
 * E1 (Stripe dunning). Queueing means:
 *
 *   - Both flows are resilient to transient Resend outages (retries).
 *   - We can bulk-audit email traffic by inspecting the collection.
 *   - The sending domain rate limit is one choke point, not two.
 *
 * State machine on each row:
 *   (no status)           → picked up, marked 'sending'
 *   sending  + success    → 'sent' + sentAt
 *   sending  + failure    → attempts++, returns to queue until max
 *   sending  + max tries  → 'failed'
 *
 * Idempotent under the Firestore scheduler: if two ticks overlap
 * the worker uses a transaction to claim each doc.
 */

'use strict';

const { onSchedule } = require('./heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretValue } = require('./_shared');
const { resendRejected, resendErrorMessage } = require('../resend-guard');

const MAX_ATTEMPTS = 5;

exports.emailQueueWorker = onSchedule(
  {
    region: 'us-central1',
    schedule: 'every 1 minutes',
    timeZone: 'Etc/UTC',
    timeoutSeconds: 240,
    memory: '256MiB',
    secrets: [RESEND_API_KEY, EMAIL_FROM]
  },
  async () => {
    // secretValue(): the deploy's '__unset__' stub reads as '' here, so a
    // stubbed sender no longer passes the configured check below.
    const resendKey = secretValue(RESEND_API_KEY) || '';
    const fromAddr  = secretValue(EMAIL_FROM) || '';
    if (!resendKey || !fromAddr) {
      // R4-7-5 (2026-10-06): this was logger.info + return, so the heartbeat
      // stayed green while dunning, dispute alerts, erasure confirmations and
      // the backup alarm piled up unsent. Throw so the run records a failure.
      logger.error('emailQueueWorker: Resend not configured (RESEND_API_KEY / EMAIL_FROM missing or stub), queue NOT drained');
      throw new Error('emailQueueWorker: Resend not configured');
    }

    const { Resend } = require('resend');
    const resend = new Resend(resendKey);
    const db = getFirestore();

    // Reaper (Audit #4 / 2.2): re-queue rows stuck in 'sending'. A tick
    // that crashed or timed out after claiming a row but before writing
    // 'sent'/'pending' leaves it in 'sending' forever — never re-picked
    // (the queue query below is pending-only), silently dropping GDPR-
    // erasure confirmations and Stripe dunning emails. Reclaiming after a
    // 10-min lease (>> the 240s timeout) restores at-least-once delivery.
    // Tradeoff: if the crash happened in the sub-second AFTER a successful
    // Resend send but BEFORE the 'sent' write, the reclaim re-sends a
    // duplicate — acceptable for these transactional emails vs. a silent
    // drop, and bounded by MAX_ATTEMPTS.
    let requeued = 0;
    try {
      const staleCutoff = Timestamp.fromMillis(Date.now() - 10 * 60_000);
      const stuck = await db.collection('email_queue')
        .where('status', '==', 'sending')
        .where('claimedAt', '<', staleCutoff)
        .limit(25)
        .get();
      for (const d of stuck.docs) {
        await d.ref.update({
          status: 'pending',
          attempts: (d.data().attempts || 0) + 1,
          lastError: 'reclaimed: stale sending lease',
          reclaimedAt: FieldValue.serverTimestamp(),
        });
        requeued++;
      }
    } catch (e) {
      logger.warn('emailQueueWorker reaper error', { err: e.message });
    }

    // Claim up to 25 pending rows per tick. Anything that needs
    // faster delivery should go through the direct-send functions.
    // Writers MUST set `status: 'pending'` explicitly (enforced by
    // the enqueue call sites in compliance.js + dunning in index.js).
    const snap = await db.collection('email_queue')
      .where('status', '==', 'pending')
      .orderBy('createdAt')
      .limit(25)
      .get();

    let sent = 0, failed = 0;
    for (const doc of snap.docs) {
      // Transactional claim so overlapping ticks don't double-send.
      try {
        await db.runTransaction(async (tx) => {
          const fresh = await tx.get(doc.ref);
          if (!fresh.exists) throw new Error('missing');
          const d = fresh.data();
          if (d.status && d.status !== 'pending') throw new Error('not-pending');
          tx.update(doc.ref, {
            status: 'sending',
            claimedAt: FieldValue.serverTimestamp()
          });
        });
      } catch (e) {
        continue; // someone else has it
      }

      const data = doc.data();
      const to = data.to;
      if (typeof to !== 'string' || !to.includes('@')) {
        await doc.ref.update({
          status: 'failed',
          failedReason: 'bad recipient',
          failedAt: FieldValue.serverTimestamp()
        });
        failed++;
        logger.error('emailQueueWorker: row failed for good (bad recipient)', { docId: doc.id, source: data.source || null });
        continue;
      }

      try {
        const response = await resend.emails.send({
          from: fromAddr,
          to,
          subject: String(data.subject || '(no subject)').slice(0, 200),
          text: String(data.bodyPlain || '').slice(0, 50_000),
          html: data.bodyHtml ? String(data.bodyHtml).slice(0, 100_000) : undefined,
          reply_to: data.replyTo || undefined
        });
        // Resend resolves { data: null, error } on an API-level rejection
        // instead of throwing — without this check a rejected send is
        // marked 'sent' and never re-queued, defeating the retry state
        // machine this worker exists to provide (see file header).
        if (resendRejected(response)) {
          throw new Error(resendErrorMessage(response));
        }
        await doc.ref.update({
          status: 'sent',
          sentAt: FieldValue.serverTimestamp()
        });
        sent++;
      } catch (e) {
        const attempts = (data.attempts || 0) + 1;
        const shouldRetry = attempts < MAX_ATTEMPTS;
        await doc.ref.update({
          status: shouldRetry ? 'pending' : 'failed',
          attempts,
          lastError: (e && e.message || 'unknown').slice(0, 400),
          lastAttemptAt: FieldValue.serverTimestamp()
        });
        if (!shouldRetry) {
          failed++;
          // Terminal: this email will never be sent. Error, not warn.
          logger.error('emailQueueWorker: row failed for good after max attempts', { docId: doc.id, attempts, source: data.source || null, err: e.message });
        } else {
          logger.warn('emailQueueWorker send error', { docId: doc.id, attempts, err: e.message });
        }
      }
    }

    // Always emit a heartbeat (Audit #4 / 2.1) so a "no success log in N
    // minutes" absence alert can detect the worker silently dying — not
    // just when the queue happened to be non-empty.
    logger.info('emailQueueWorker', { picked: snap.size, sent, failed, requeued });
  }
);

module.exports = exports;
