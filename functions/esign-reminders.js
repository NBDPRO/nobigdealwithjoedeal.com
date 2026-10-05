/**
 * functions/esign-reminders.js — signing reminders and link expiry.
 *
 * BoldSign (retired 2026-10-04) was configured to remind a signer every 2
 * days, 3 times, and to flag an expired envelope. Our envelopes had neither:
 * a homeowner who missed the email was never nudged, and a link that ran out
 * at 14 days left the envelope reading "Sent" forever.
 *
 * Once a day:
 *   1. EXPIRY — an envelope whose current link has expired (linkExpiresAt in
 *      the past) and is still sent/viewed becomes 'expired'; the estimate
 *      mirrors it and the rep gets a bell to resend.
 *   2. REMINDERS — an envelope with remindNextAt in the past gets the same
 *      link re-emailed to the signer whose turn it is (subject "Reminder:"),
 *      up to ESL.REMINDER_MAX times, ESL.REMINDER_EVERY_MS apart. Only
 *      envelopes SENT AFTER this shipped carry remindNextAt, and the rep can
 *      send with reminders:false — nothing older starts getting mail.
 *
 * Both queries are single-field range queries on numeric fields, which
 * Firestore serves from its automatic single-field indexes (the emulator
 * never enforces composite indexes, so a two-field query here would pass
 * locally and FAILED_PRECONDITION in production).
 *
 * Gate: ESIGN_REMINDERS_DISABLED=true turns the sweep off (cron-gates.js).
 */
'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const ESL = require('./esign-logic');
const IO = require('./esign-io');

const OPEN = ['sent', 'viewed'];

/** The live token for the signer whose turn it is, or null. */
async function liveTokenFor(db, envelopeId, signerId, now) {
  const snap = await db.collection('esign_tokens')
    .where('envelopeId', '==', envelopeId).where('status', '==', 'pending').get();
  let found = null;
  snap.forEach((d) => {
    const t = d.data() || {};
    const exp = t.expiresAt && t.expiresAt.toMillis ? t.expiresAt.toMillis() : 0;
    const sid = t.signerId || ESL.DEFAULT_SIGNER_ID;
    if (!found && exp > now && sid === signerId) found = d.id;
  });
  return found;
}

/** The sweep itself, exported for tests (esign-reminders is not Object.assign'd into index). */
async function runSweep(db, now) {
  const out = { expired: 0, reminded: 0, cleared: 0 };

  const exp = await db.collection('esign_envelopes').where('linkExpiresAt', '<=', now).limit(200).get();
  for (const d of exp.docs) {
    const env = d.data() || {};
    if (!OPEN.includes(env.status)) {
      await d.ref.set({ linkExpiresAt: FieldValue.delete() }, { merge: true }).catch(() => {});
      continue;
    }
    await d.ref.set({
      status: 'expired',
      expiredAt: FieldValue.serverTimestamp(),
      linkExpiresAt: FieldValue.delete(),
      remindNextAt: FieldValue.delete(),
      audit: FieldValue.arrayUnion({ event: 'expired', at: now }),
    }, { merge: true });
    await IO.syncEstimate(db, d.id, env, 'expired');
    await IO.notifyRep(db, env, {
      type: 'esign_expired', title: 'Signing link expired',
      message: `The signing link for ${env.title || 'a document'} expired before it was signed. Open the customer to send a new one.`,
      priority: 'normal',
    });
    out.expired++;
  }

  const due = await db.collection('esign_envelopes').where('remindNextAt', '<=', now).limit(200).get();
  for (const d of due.docs) {
    const env = d.data() || {};
    const rem = env.reminders || {};
    const count = Number(rem.count) || 0;
    const signer = ESL.nextPendingSigner(env);
    if (!OPEN.includes(env.status) || rem.enabled !== true || count >= ESL.REMINDER_MAX || !signer || !signer.email) {
      await d.ref.set({ remindNextAt: FieldValue.delete() }, { merge: true }).catch(() => {});
      out.cleared++;
      continue;
    }
    const token = await liveTokenFor(db, d.id, signer.id, now);
    if (!token) {
      await d.ref.set({ remindNextAt: FieldValue.delete() }, { merge: true }).catch(() => {});
      out.cleared++;
      continue;
    }
    const mail = await IO.emailLink(env, signer, IO.SIGN_URL_BASE + token, { reminder: true });
    const n = count + 1;
    await d.ref.set({
      reminders: { enabled: true, count: n, lastAt: now },
      remindNextAt: n < ESL.REMINDER_MAX ? now + ESL.REMINDER_EVERY_MS : FieldValue.delete(),
      audit: FieldValue.arrayUnion({ event: 'reminded', at: now, signerId: signer.id, emailed: !!mail.emailed, n }),
    }, { merge: true });
    out.reminded++;
  }
  return out;
}

exports.esignReminderSweep = onSchedule(
  {
    // 10:00 ET — a civil hour to land in a homeowner's inbox.
    schedule: '0 10 * * *',
    timeZone: 'America/New_York',
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '256MiB',
    retry: false,
    secrets: [IO.RESEND_API_KEY, IO.EMAIL_FROM],
  },
  async () => {
    if (process.env.ESIGN_REMINDERS_DISABLED === 'true') {
      logger.info('[esignReminderSweep] ESIGN_REMINDERS_DISABLED=true — skipped');
      return;
    }
    const r = await runSweep(getFirestore(), Date.now());
    logger.info('[esignReminderSweep] done', r);
  }
);

exports._runSweep = runSweep;
