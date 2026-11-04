/**
 * monthly-overhead-alert.js — monthly per-tenant overhead spend digest.
 *
 * On the 1st of each month (9am ET) this sums the PREVIOUS month's
 * OVERHEAD-type expenses (expense docs carry a denormalized `costType`
 * written by the client — see docs/pro/js/expense-config.js, the
 * taxonomy's single source of truth) per company, compares against the
 * month before, and emails each company owner a category breakdown via
 * email_queue → emailQueueWorker (integrations/email-queue-worker.js).
 *
 * Design notes:
 *   - One date-range query across all tenants (single-field range on
 *     `date`, automatic index — deliberately NOT a per-company
 *     {companyId,costType,date} composite), bucketed in code. Expense
 *     volume is small; this avoids a new composite index.
 *   - Month boundaries in America/New_York (house convention for
 *     calendar metrics), buffered −2 days at the query edge.
 *   - Owner resolution: companies/{cid}.ownerId, falling back to the
 *     companyId itself (solo operators: companyId == owner uid).
 *   - Companies with zero overhead spend last month are skipped — no
 *     empty spam.
 *   - Enabled by default; set MONTHLY_OVERHEAD_ALERT_DISABLED=true to
 *     pause without a deploy rollback.
 *   - email_queue docs MUST carry status:'pending' — the worker's query
 *     filters on it; a doc without it is never sent (the health-digest
 *     trap).
 *
 * All arithmetic/formatting lives in monthly-overhead-logic.js (pure,
 * firebase-free, unit-tested).
 */

'use strict';

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const L = require('./monthly-overhead-logic');

exports.monthlyOverheadAlertCron = onSchedule(
  {
    // 1st of the month, 9am ET (summarizes the month that just ended).
    schedule: '0 9 1 * *',
    timeZone: L.TZ,
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async () => {
    if (process.env.MONTHLY_OVERHEAD_ALERT_DISABLED === 'true') {
      logger.info('monthly_overhead.skipped', { reason: 'MONTHLY_OVERHEAD_ALERT_DISABLED' });
      return;
    }
    const db = getFirestore();
    const { lastKey, priorKey, lastLabel, queryStart } = L.monthKeysAt(new Date());

    // Capped as a defense against a runaway (an import bug, a tenant with
    // years of unpruned expense history) rather than because real volume is
    // expected to reach it — "expense volume is small" above is a belief
    // about today's data, not a guarantee. A hit is loud, not a silent
    // truncation: some_company's overhead would quietly under-report.
    const EXPENSES_READ_CAP = 5000;
    const snap = await db.collection('expenses').where('date', '>=', queryStart).limit(EXPENSES_READ_CAP).get();
    if (snap.size >= EXPENSES_READ_CAP) {
      logger.warn('monthly_overhead.read_cap_hit', { cap: EXPENSES_READ_CAP, queryStart });
    }
    const docs = snap.docs.map(d => d.data());
    const perCompany = L.summarizeOverhead(docs, lastKey, priorKey);

    let queued = 0, skippedZero = 0, noEmail = 0, alreadySent = 0;
    for (const [cid, summary] of perCompany) {
      // Not `<= 0`: credits that outrun the month's overhead make the total NEGATIVE, and that
      // must reach the owner (buildEmail flags it), not be skipped as "nothing to report".
      if (summary.totalCents === 0) { skippedZero++; continue; }
      let ownerUid = cid;
      try {
        const co = await db.collection('companies').doc(cid).get();
        if (co.exists && co.data().ownerId) ownerUid = co.data().ownerId;
      } catch (e) { logger.warn('monthly_overhead.company_lookup_failed', { cid, message: e.message }); }
      let email = null;
      try {
        email = (await getAuth().getUser(ownerUid)).email || null;
      } catch (e) { logger.warn('monthly_overhead.owner_lookup_failed', { cid, ownerUid, message: e.message }); }
      if (!email) { noEmail++; continue; }

      // Idempotency: reserve a per-company/per-month marker BEFORE enqueuing.
      // Cloud Scheduler is at-least-once, so a retried cron run would otherwise
      // re-send this digest. create() fails if the marker exists → already
      // sent this month, skip. (#7)
      const markerRef = db.collection('overheadAlertLog').doc(L.alertMarkerId(cid, lastKey));
      try {
        await markerRef.create({
          companyId: cid, month: lastKey, ownerUid, email,
          createdAt: FieldValue.serverTimestamp(), source: 'monthly_overhead_alert',
        });
      } catch (e) {
        if (e && (e.code === 6 || /already exists/i.test(e.message || ''))) { alreadySent++; continue; }
        throw e;
      }

      const { subject, bodyHtml, bodyPlain } = L.buildEmail(summary, lastLabel);
      try {
        await db.collection('email_queue').add({
          to: email,
          subject,
          bodyHtml,
          bodyPlain,
          // F-wave contract: the worker's query filters on status —
          // omitting it means the mail is silently never sent.
          status: 'pending',
          createdAt: FieldValue.serverTimestamp(),
          source: 'monthly_overhead_alert',
        });
        queued++;
      } catch (e) {
        // Roll the marker back so the next run retries this company instead of
        // silently swallowing the digest (marker without a sent email).
        await markerRef.delete().catch(() => {});
        throw e;
      }
    }
    logger.info('monthly_overhead.done', {
      month: lastKey, companies: perCompany.size, queued, skippedZero, noEmail, alreadySent, scanned: docs.length,
    });
  }
);

// Re-exported for any smoke/require that expects the pure helpers here.
exports._test = L;
