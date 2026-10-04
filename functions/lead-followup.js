/**
 * NBD — 24h "we haven't connected" follow-up
 * ═══════════════════════════════════════════════════════════════
 * A lead that Joe couldn't reach used to just go cold silently. Every 3
 * hours this sweep finds public leads 20–48h old whose bridged CRM card
 * is STILL untouched (stage/status both 'new' — the dashboard flips stage
 * to 'contacted'/'Inspected'/... the moment Joe works it) and sends the
 * homeowner ONE follow-up email from Joe.
 *
 * Guards, in order:
 *  - active unless LEAD_FOLLOWUP_ENABLED === 'false' (kill switch);
 *  - window 20–48h: never sooner than Joe's realistic first-day attempts,
 *    never after the request has gone stale;
 *  - one send ever per lead (followUpEmailStatus 'sending' claimed on the
 *    public doc BEFORE the send, followUpEmailSentAt stamped after);
 *  - skipped when the CRM card moved past 'new' (Joe reached them) or when
 *    the CRM card is missing (bridge failed — don't email on unknown state);
 *  - NBD leads only (same tenant rule as the ack email);
 *  - storm_alert_subscribers excluded — that's a list signup, not an open
 *    request; estimate follow-up event docs excluded via isFollowUpEvent.
 *
 * Index note: all Firestore queries here use range-on-createdAt only, or
 * equality-only filters — no composite indexes needed.
 */

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Resend } = require('resend');
const { Timestamp, FieldValue, getFirestore } = require('firebase-admin/firestore');
const L = require('./lead-bridge-logic');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const Suppression = require('./email-suppression');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const WINDOW_OLDEST_H = 48;
const WINDOW_YOUNGEST_H = 20;
const SOURCES = ['estimate_leads', 'inspect_leads', 'contact_leads', 'free_roof_entries'];
// Tenant-zero (NBD) key, same constant + override as lead-bridge.js. An
// untagged public lead is NBD's, so its unsubscribe lives under this key.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// Same tenant rule as lead-alert's ack: a configured tenant's homeowners are
// not ours to email. (Mirror of resolveAlertTarget's fallback logic — a lead
// with no companyId, or one whose companyProfile has no alert contact, is NBD.)
async function isNbdLead(companyId) {
  if (!companyId) return true;
  try {
    const snap = await getFirestore().collection('companyProfile').doc(String(companyId)).get();
    if (!snap.exists) return true;
    const c = ((snap.data() || {}).brand || {}).contact || {};
    return !(c.alertEmail || c.alertSms);
  } catch (e) {
    return false; // unknown tenant state — don't email
  }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function followUpHtml(firstName) {
  const hi = firstName ? `Hi ${esc(firstName)},` : 'Hi,';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:'Barlow','Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;color:#333">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:linear-gradient(135deg,#1a3057,#12223d);color:#fff;padding:22px 20px;text-align:center">
      <div style="font-size:22px;font-weight:700">We haven't connected yet</div>
      <div style="font-size:13px;opacity:.85;margin-top:4px">No Big Deal Home Solutions</div>
    </div>
    <div style="padding:24px 22px;font-size:15px;line-height:1.65">
      <p style="margin:0 0 14px">${hi}</p>
      <p style="margin:0 0 14px">Joe here. You reached out about your home and we haven't managed to connect — that's on me to fix, not you. Your request is still at the top of my list.</p>
      <p style="margin:0 0 14px">Fastest way to lock in a time: call or text me directly, or just reply to this email with a good time and I'll call you then.</p>
      <p style="text-align:center;margin:20px 0"><a href="tel:8594207382" style="display:inline-block;background:#bd5728;color:#fff;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px">Call or text (859) 420-7382</a></p>
      <p style="margin:0">— Joe Deal<br><span style="color:#6b7280;font-size:13px">Owner &amp; Operator, No Big Deal Home Solutions</span></p>
    </div>
  </div>
</body></html>`;
}

function followUpText(firstName) {
  return `${firstName ? 'Hi ' + firstName + ',' : 'Hi,'}\n\nJoe here. You reached out about your home and we haven't managed to connect — that's on me to fix, not you. Your request is still at the top of my list.\n\nFastest way to lock in a time: call or text me at (859) 420-7382, or reply to this email with a good time and I'll call you then.\n\n— Joe Deal\nOwner & Operator, No Big Deal Home Solutions`;
}

exports.leadFollowUpSweep = onSchedule(
  {
    schedule: '0 */3 * * *',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async () => {
    if (process.env.LEAD_FOLLOWUP_ENABLED === 'false') {
      logger.info('leadFollowUp: disabled via env — skipping');
      return;
    }
    const db = getFirestore();
    const now = Date.now();
    const oldest = Timestamp.fromMillis(now - WINDOW_OLDEST_H * 3600_000);
    const youngest = Timestamp.fromMillis(now - WINDOW_YOUNGEST_H * 3600_000);

    let sent = 0;
    let skipped = 0;
    let blockedNoAddress = 0; // CAN-SPAM: no postal address configured (2026-10-03)
    let resend = null;

    for (const collection of SOURCES) {
      const snap = await db.collection(collection)
        .where('createdAt', '>=', oldest)
        .where('createdAt', '<=', youngest)
        .limit(100)
        .get();

      for (const doc of snap.docs) {
        const d = doc.data() || {};
        if (L.isFollowUpEvent(collection, d)) { skipped++; continue; }
        if (d.followUpEmailSentAt) { skipped++; continue; }
        if (d.followUpEmailSuppressedAt) { skipped++; continue; }
        // Claimed by a prior sweep right before its Resend call (below): stays
        // excluded whether or not that sweep's post-send stamp ever landed.
        if (d.followUpEmailStatus === 'sending') { skipped++; continue; }
        const email = String(d.email || '').trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { skipped++; continue; }
        if (!(await isNbdLead(d.companyId))) { skipped++; continue; }

        // The bridged CRM card is the source of truth for "did Joe reach
        // them". Missing card = unknown state = don't email.
        const crm = await db.collection('leads')
          .where('publicLeadCollection', '==', collection)
          .where('publicLeadId', '==', doc.id)
          .limit(1)
          .get();
        if (crm.empty) { skipped++; continue; }
        const card = crm.docs[0].data() || {};
        const untouched =
          String(card.stage || '').toLowerCase() === 'new' &&
          String(card.status || '').toLowerCase() === 'new';
        if (!untouched) { skipped++; continue; }

        // Email unsubscribe (CAN-SPAM, 2026-09-22). This follow-up is
        // COMMERCIAL: an address on the lead's tenant's suppression register
        // is skipped (and stamped so it is not re-checked), and every one that
        // goes carries a footer link + one-click List-Unsubscribe headers. A
        // gate error sends nothing; the next sweep retries while the lead is
        // still inside the window.
        const tenantKey = String(card.companyId || d.companyId || NBD_OWNER_UID);
        let unsub;
        try {
          unsub = await Suppression.gateCommercialEmail(db, {
            companyId: tenantKey, email, leadId: crm.docs[0].id, source: 'lead-followup',
          }, { timeoutMs: Suppression.READ_TIMEOUT_MS, serverTimestamp: FieldValue.serverTimestamp });
        } catch (e) {
          logger.error('leadFollowUp: suppression_unverified', { collection, leadId: doc.id, err: e && e.message });
          skipped++;
          continue;
        }
        if (unsub.suppressed) {
          logger.info('leadFollowUp: suppressed', { collection, leadId: doc.id });
          await doc.ref.update({ followUpEmailSuppressedAt: FieldValue.serverTimestamp() }).catch(() => {});
          skipped++;
          continue;
        }
        // CAN-SPAM (2026-10-03): the lead's tenant has no postal address
        // configured → do not send. Not stamped (the homeowner did nothing);
        // a later sweep sends it if the address is set while the lead is
        // still inside the window. Counted in the sweep summary.
        if (unsub.blocked) {
          logger.warn('leadFollowUp: blocked, no postal address', { collection, leadId: doc.id, tenantKey });
          blockedNoAddress++;
          continue;
        }

        // Claim BEFORE calling Resend (2026-10-03; house pattern from
        // funnel-recovery.js). The send and the followUpEmailSentAt stamp
        // used to share one try, so a send that went out but whose stamp
        // write then failed left the lead eligible — and the homeowner got
        // the same "we haven't connected" email every 3 hours for the rest
        // of the 20–48h window. The claim makes the exclusion durable before
        // anything is sent; a failed claim sends nothing (retried next sweep).
        try {
          await doc.ref.update({
            followUpEmailStatus: 'sending',
            followUpEmailClaimedAt: FieldValue.serverTimestamp(),
          });
        } catch (e) {
          logger.error('leadFollowUp: claim failed', { collection, leadId: doc.id, err: e && e.message });
          skipped++;
          continue;
        }

        let delivered = false;
        try {
          if (!resend) resend = new Resend(RESEND_API_KEY.value());
          const firstName = String(d.firstName || d.name || '').trim().split(/\s+/)[0] || '';
          const body = Suppression.applyFooter(unsub, followUpHtml(firstName), followUpText(firstName));
          const response = await resend.emails.send({
            from: 'Joe Deal <jd@nobigdealwithjoedeal.com>',
            to: email,
            reply_to: 'jd@nobigdealwithjoedeal.com',
            subject: "We haven't connected yet — Joe",
            html: body.html,
            text: body.text,
            headers: Object.assign({ 'X-NBD-Campaign': 'lead-followup-v1' }, unsub.headers),
            // Attributes a bounce/complaint back to this tenant — see
            // functions/resend-webhook.js.
            tags: unsub.tags,
          });
          // Resend resolves { data: null, error } on an API-level rejection
          // instead of throwing — without this check followUpEmailSentAt
          // gets stamped, and per this file's own header comment ("one
          // send ever per lead") that lead would never be followed up
          // with again.
          if (resendRejected(response)) {
            throw new Error(resendErrorMessage(response));
          }
          delivered = true;
          sent++;
          await doc.ref.update({ followUpEmailSentAt: FieldValue.serverTimestamp(), followUpEmailStatus: 'sent' });
        } catch (e) {
          if (delivered) {
            // The email is out; the 'sending' claim keeps this lead excluded.
            // Bookkeeping gap only — reconcile against Resend's log.
            logger.error('leadFollowUp: stamp failed after send', { collection, leadId: doc.id, err: e && e.message });
          } else {
            logger.error('leadFollowUp: send failed', { collection, leadId: doc.id, err: e && e.message });
            // A genuine send failure releases the claim so the next sweep
            // retries while the lead is still in the window (as before). If
            // even this write fails the lead stays claimed — no duplicate.
            await doc.ref.update({ followUpEmailStatus: 'failed', followUpEmailError: String((e && e.message) || 'unknown').slice(0, 300) })
              .catch((w) => logger.error('leadFollowUp: fail stamp failed', { collection, leadId: doc.id, err: w && w.message }));
          }
        }
      }
    }
    logger.info('leadFollowUp: sweep done', { sent, skipped, blockedNoAddress });
  }
);
