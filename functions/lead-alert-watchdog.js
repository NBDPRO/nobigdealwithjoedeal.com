'use strict';
/**
 * lead-alert-watchdog.js — leadAlertWatchdog (2026-10-07): every 10 minutes,
 * make sure each new NBD lead actually REACHED Joe, and re-send the ones that
 * did not.
 *
 * WHY: the lead-alert triggers (lead-alert.js) record what they attempted in
 * alert_outbox, but nothing checked for a MISSING success. The Twilio number
 * is not A2P registered, so every alert text is carrier-blocked (30034) while
 * the row used to say "sent"; email was the only working channel, and if
 * Resend failed (dead key, suspended account) or the trigger never ran at all,
 * a lead would sit in the CRM with nobody told. A failure count can't catch
 * that on a path this quiet (a few leads a week) — memory
 * client-fallbacks-hide-total-server-failure: alert on the missing success.
 *
 * WHAT IT DOES, per run:
 *  1. Lists leads created 10 min – 6 h ago in every collection a lead-alert
 *     trigger listens on, keeps the ones lead-alert.js alertPlan() says should
 *     alert (the SAME decision the triggers make), NBD's only.
 *  2. Reads that lead's alert_outbox rows. A row whose text has no carrier
 *     verdict yet gets one from Twilio (GET only) and is stamped smsDelivery.
 *  3. Reached = some row has emailStatus 'sent', pushStatus 'sent', or
 *     smsDelivery 'delivered'. Twilio merely ACCEPTING a text is not reached.
 *  4. Not reached → claims alert_outbox/watchdog__<collection>__<leadId>
 *     (create(): once per lead, ever) and re-sends by EMAIL + PUSH only, with
 *     a "missed alert" notice. Never texts, never contacts the homeowner.
 *  5. If a re-send ALSO reached nobody, the run throws, so the heartbeat
 *     reports /fail — the last line of defence is Healthchecks.io emailing Jo.
 *
 * Gate: LEAD_ALERT_WATCHDOG_DISABLED=true → dry run (computes + logs only).
 * At most MAX_RESENDS_PER_RUN re-sends per run.
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const LA = require('./lead-alert')._internal;
const W = require('./call-watch-logic');

const GRACE_MS = 10 * 60 * 1000;          // give the trigger (and its retries) time first
const LOOKBACK_MS = 6 * 60 * 60 * 1000;   // older leads were judged by earlier runs
const MAX_RESENDS_PER_RUN = 10;
// Every collection a lead-alert trigger listens on (lead-alert.js exports).
const COLLECTIONS = ['contact_leads', 'estimate_leads', 'inspect_leads', 'free_roof_entries', 'storm_alert_subscribers', 'leads'];

const NOTICE = {
  email: 'This lead did not reach you when it came in: no email, push or text was confirmed delivered. Sent again by the missed-alert check.',
  mailto: '',
  sms: '',
  subject: 'MISSED ALERT',
};

const watchdogDisabled = () => process.env.LEAD_ALERT_WATCHDOG_DISABLED === 'true';
const secretVal = (n) => { const v = String(process.env[n] || '').trim(); return v && v !== '__unset__' ? v : ''; };

/** Did any channel on these alert_outbox rows confirm it reached the target? (pure) */
function reached(rows) {
  return (rows || []).some((r) => r && (r.emailStatus === 'sent' || r.pushStatus === 'sent' || r.smsDelivery === 'delivered'));
}

/** NBD's own lead (the watchdog never re-routes another company's lead). (pure) */
function isNbdLead(d, ownerUid) {
  return !d.companyId || String(d.companyId) === String(ownerUid);
}

function claimId(collection, leadId) { return 'watchdog__' + collection + '__' + leadId; }

/** One Twilio message by SID — GET only; null when Twilio isn't configured. */
async function twilioMessage(msgSid) {
  const sid = secretVal('TWILIO_ACCOUNT_SID'), tok = secretVal('TWILIO_AUTH_TOKEN');
  if (!sid || !tok) return null;
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages/' + encodeURIComponent(msgSid) + '.json';
  const res = await fetch(url, { method: 'GET', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('twilio message ' + res.status);
  return res.json();
}

const toDate = (ms) => new Date(ms);

/**
 * deps: { db, nowMs, live, alert(collection, data, leadId, opts) → outcomes,
 *         twilio(msgSid) → message | null, ownerUid }
 */
async function runWatchdog(deps) {
  const { db, nowMs, live } = deps;
  const ownerUid = deps.ownerUid || LA.NBD_OWNER_UID;
  const out = { checked: 0, reached: 0, missed: 0, resent: 0, resendReached: 0, unresolved: 0, stamped: 0, alreadyHandled: 0, capped: 0 };

  for (const collection of COLLECTIONS) {
    const snap = await db.collection(collection)
      .where('createdAt', '>=', toDate(nowMs - LOOKBACK_MS))
      .where('createdAt', '<=', toDate(nowMs - GRACE_MS))
      .get();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (!isNbdLead(data, ownerUid)) continue;
      const plan = LA.alertPlan(collection, data, doc.id);
      if (!plan.alert) continue;
      out.checked++;

      const claimRef = db.collection('alert_outbox').doc(claimId(collection, doc.id));
      if ((await claimRef.get()).exists) { out.alreadyHandled++; continue; }

      const rowSnap = await db.collection('alert_outbox').where('leadId', '==', doc.id).get();
      const rows = [];
      for (const r of rowSnap.docs) {
        const row = r.data() || {};
        if (row.kind !== 'lead-alert' || row.collection !== collection) continue;
        // Carrier verdict for a text nobody has checked yet (callWatch only
        // looks every 2 h, 08–20 ET). GET only; a Twilio error never blocks.
        if (row.smsSid && !row.smsDelivery && typeof deps.twilio === 'function') {
          try {
            const m = await deps.twilio(row.smsSid);
            const v = m && W.deliveryBySid([m])[row.smsSid];
            if (v) {
              row.smsDelivery = v;
              out.stamped++;
              if (live) await r.ref.update({ smsDelivery: v, smsDeliveryAtMs: nowMs });
            }
          } catch (e) { logger.warn('[leadAlertWatchdog] twilio status skipped', { err: e && e.message }); }
        }
        rows.push(row);
      }

      if (reached(rows)) { out.reached++; continue; }
      out.missed++;
      // Ids and counts only in logs — never the homeowner's details.
      logger.warn('[leadAlertWatchdog] lead not confirmed reached', { collection, leadId: doc.id, alertRows: rows.length });
      if (!live) continue;
      if (out.resent >= MAX_RESENDS_PER_RUN) { out.capped++; continue; }

      try {
        await claimRef.create({
          kind: 'lead-alert-watchdog',
          collection,
          leadId: doc.id,
          companyId: data.companyId || null,
          reason: rows.length ? 'not-delivered' : 'no-alert-recorded',
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (e) {
        // Already claimed (an overlapping run) — or alert_outbox is unwritable,
        // in which case re-sending would repeat every run. Either way, stop.
        out.alreadyHandled++;
        continue;
      }
      out.resent++;
      // Keep the trigger's own notice (a Cal.com booking with no phone) after ours.
      const own = plan.opts && plan.opts.notice;
      const notice = own
        ? Object.assign({}, NOTICE, { email: NOTICE.email + ' ' + own.email, mailto: own.mailto || '', subject: NOTICE.subject + ' · ' + own.subject })
        : NOTICE;
      const outcomes = await deps.alert(plan.collection, plan.data, doc.id, Object.assign({}, plan.opts, {
        ack: false, skipSms: true, watchdog: true, notice,
      })) || {};
      const ok = outcomes.email === 'sent' || outcomes.push === 'sent';
      if (ok) out.resendReached++; else out.unresolved++;
      await claimRef.update({ resendEmail: String(outcomes.email || ''), resendPush: String(outcomes.push || ''), resendReached: ok })
        .catch((e) => logger.warn('[leadAlertWatchdog] claim update skipped', { err: e && e.message }));
    }
  }
  return out;
}

exports.leadAlertWatchdog = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '256MiB', maxInstances: 1, secrets: LA.SECRETS },
  async () => {
    const r = await runWatchdog({
      db: getFirestore(), nowMs: Date.now(), live: !watchdogDisabled(),
      alert: LA.alertJoe, twilio: twilioMessage,
    });
    logger.info('[leadAlertWatchdog]', r);
    if (r.unresolved > 0) {
      // A lead reached nobody even on the re-send: fail the run so the
      // heartbeat pings /fail (a watchdog that can't reach Joe must not look healthy).
      throw new Error('leadAlertWatchdog: ' + r.unresolved + ' lead(s) reached nobody after a re-send');
    }
  }
);

exports._internal = { runWatchdog, reached, isNbdLead, claimId, twilioMessage, COLLECTIONS, GRACE_MS, LOOKBACK_MS, MAX_RESENDS_PER_RUN, NOTICE };
