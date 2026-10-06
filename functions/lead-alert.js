/**
 * NBD — New public-lead alert to Joe
 * ═══════════════════════════════════════════════════════════════
 *
 * The public marketing forms (contact / instant-estimate / inspect+storm-tools
 * / free-roof) write straight to Firestore and nothing surfaced them — leads
 * could sit unseen. These onCreate triggers fire the moment a lead lands and
 * alert Joe by **text (Twilio SMS) + email (Resend)**.
 *
 * SMS status: the Twilio number must complete A2P 10DLC registration before US
 * carriers will deliver (otherwise carrier error 30034 — message accepted but
 * dropped). Once the campaign is approved, texts start flowing automatically —
 * no code change needed. Email works regardless and is the reliable backstop.
 *
 * Both sends are independent try/catch so a failure never blocks lead capture.
 * Additive — does not touch submitPublicLead or the lead pipeline.
 *
 * Cal.com bookings (2026-09-13): integrations/calcom.js writes a booking that
 * matches no existing lead straight to leads/{calcom__<id>}, bypassing every
 * public collection above — so nothing paged Joe, not even for a booking with
 * no phone on it. leadAlertCalcom closes that; see onCalcomLeadAlert below.
 *
 * Thumbtack leads (2026-09-26): the webhook stores them in thumbtack_leads,
 * which had no alert trigger, and leadBridgeThumbtack mirrors them to
 * leads/{thumbtack_leads__<id>}, which the Cal.com filter skipped. So the
 * busiest lead channel paged nobody: 74 real leads, 0 alert_outbox rows. The
 * same leads/{leadId} trigger now alerts on the bridge's create as well; see
 * onThumbtackLeadAlert below.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Resend } = require('resend');
// Lazy require (2026-08-07): the twilio SDK is ~21 MB of parse weight that
// every deployed function paid at cold start (index.js pulls this module
// eagerly). Required on first send instead; call sites use _twilio()(...).
let _twilioSdk = null;
const _twilio = () => (_twilioSdk = _twilioSdk || require('twilio'));
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const L = require('./lead-bridge-logic');
const C = require('./tcpa-consent');
const CL = require('./integrations/calcom-logic');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');
const SECRETS = [RESEND_API_KEY, EMAIL_FROM, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER];

const ALERT_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];
const ALERT_SMS = '+18594207382'; // Joe's cell — default when a lead has no tenant contact

// Platform-tenant gate (same convention as render-pdf.js NBD_OWNER_UID): the
// "is this NBD's lead" signal must be the lead's companyId, NOT the resolved
// seal — the old fallback carried seal 'NBD' for an UNRESOLVED tenant lead
// too, so that tenant's homeowner got Joe's ack email/SMS (NBD-leak audit
// 2026-07-29).
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// Resolve who gets the alert for a lead's tenant (Phase C, TenantContext).
// NBD's leads (no companyId, or the NBD owner uid) go to Joe — byte-identical.
// A configured tenant gets its leads routed to itself. A non-NBD tenant with
// NO alert contact is alerted NOWHERE (Jo, 2026-10-05): another company's lead
// is never sent to Joe. Its CRM Settings shows a 'Set your lead alert
// contacts' warning instead (dashboard-bootstrap.module.js), and the
// alert_outbox row records skipped:no-target.
// isNbd rides along so the homeowner-ack gates key on WHOSE lead it is rather
// than which brand string happened to resolve.
async function resolveAlertTarget(companyId) {
  const isNbd = !companyId || String(companyId) === NBD_OWNER_UID;
  const fallback = isNbd
    ? { emails: ALERT_EMAILS, sms: ALERT_SMS, name: 'No Big Deal Home Solutions', seal: 'NBD', isNbd: true }
    // Unresolved NON-NBD tenant: no routing at all (never Joe's inbox or
    // cell) and never his brand — empty strings per the #1129 convention, and
    // isNbd:false keeps the homeowner acks (Joe-branded copy) from firing at
    // another company's customer. The lead itself is still in their CRM.
    : { emails: null, sms: null, name: '', seal: '', isNbd: false };
  if (isNbd) return fallback;
  try {
    const snap = await getFirestore().collection('companyProfile').doc(String(companyId)).get();
    if (snap.exists) {
      const b = (snap.data() || {}).brand || {};
      const c = b.contact || {};
      if (c.alertEmail || c.alertSms) {
        return {
          emails: c.alertEmail ? [c.alertEmail] : null,
          sms: c.alertSms || null,
          // Configured tenant → its own name/seal, never NBD's. (b is the RAW
          // companyProfile.brand: b.displayName is undefined here, so the old
          // `b.seal || b.displayName || fallback.seal` fell through to 'NBD' for
          // a tenant that set alert routing but no seal — an NBD bleed. M1.)
          name: b.legalName || '',
          seal: b.seal || '',
          isNbd: false,
        };
      }
    }
  } catch (e) {
    logger.error('leadAlert: tenant resolve failed', { companyId, err: e && e.message });
  }
  return fallback;
}

const KIND_LABEL = {
  contact_leads: 'Contact form',
  estimate_leads: 'Instant Estimate',
  inspect_leads: 'Inspection / Storm tool',
  free_roof_entries: 'Free Roof entry',
  storm_alert_subscribers: 'Storm — homeowner reports damage',
  // Only CRM-side bookings/leads reach alertJoe with 'leads': Cal.com uses
  // this label, and the Thumbtack path passes opts.label instead.
  leads: 'Cal.com booking',
};

// Human labels for the storm form's "What are you most concerned about?" field.
const CONCERN_LABEL = {
  hail: 'Hail damage to roof',
  wind: 'Wind damage',
  general: 'General severe weather',
  insurance: 'Already has damage — waiting on insurance',
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Pull the human-meaningful fields, tolerant of the per-kind field names.
function summarize(d) {
  const name = d.name || [d.firstName, d.lastName].filter(Boolean).join(' ') || d.nomineeName || '(no name given)';
  const phone = d.phone || '(no phone)';
  const address = d.address || d.zip || '';
  const email = d.email || '';
  const story = d.story || d.message || d.details || '';
  const concern = d.concern || '';
  return { name, phone, address, email, story, concern };
}

// `notice` (optional) is a caller-supplied warning rendered above the details:
// { email: text, mailto: address or '', sms: first SMS line, subject: tag }.
function emailHtml(label, source, s, leadId, name, notice) {
  const telDigits = String(s.phone).replace(/[^\d]/g, '');
  // pre-line: a multi-line Message (a Thumbtack questionnaire) keeps its breaks.
  const row = (k, v) => v ? `<tr><td style="padding:6px 12px;color:#6b7280;font-weight:600;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:6px 12px;color:#111;white-space:pre-line">${esc(v)}</td></tr>` : '';
  const noticeRow = notice && notice.email
    ? `<tr><td colspan="2" style="padding:12px;background:#fef3c7;border-left:4px solid #b45309;color:#78350f;font-weight:700">⚠ ${esc(notice.email)}${notice.mailto ? `<div style="margin-top:8px;font-weight:600"><a href="mailto:${esc(notice.mailto)}" style="color:#b45309">Email ${esc(notice.mailto)}</a></div>` : ''}</td></tr>`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:'Barlow','Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;color:#333">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:linear-gradient(135deg,#BD5728,#a14a22);color:#fff;padding:22px 20px;text-align:center">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.9">New Lead — Act Fast</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${esc(label)}</div>
      ${source ? `<div style="font-size:13px;opacity:.9;margin-top:2px">from ${esc(source)}</div>` : ''}
    </div>
    <div style="padding:22px 20px">
      <table style="width:100%;border-collapse:collapse;font-size:15px">
        ${noticeRow}
        ${row('Name', s.name)}
        ${row('Phone', s.phone)}
        ${row('Address', s.address)}
        ${row('Email', s.email)}
        ${row('Concern', s.concern ? (CONCERN_LABEL[s.concern] || s.concern) : '')}
        ${row('Message', s.story)}
      </table>
      ${telDigits ? `<p style="text-align:center;margin:22px 0 6px"><a href="tel:${telDigits}" style="display:inline-block;background:#BD5728;color:#fff;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px">Call ${esc(s.phone)}</a></p>` : ''}
      <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:16px">Lead ID: ${esc(leadId)} · ${esc(name)}</p>
    </div>
  </div>
</body></html>`;
}

function smsBody(label, source, s, seal, notice) {
  // Suppress the seal token when the tenant has none — never render a bare
  // gap, and never substitute 'NBD' on a tenant's alert.
  const lines = [`🔔 ${seal ? seal + ' ' : ''}lead — ${label}${source ? ` (${source})` : ''}`, `${s.name} · ${s.phone}`];
  // A notice leads the text so it survives the 480-char cut and the lock screen.
  if (notice && notice.sms) lines.unshift(notice.sms);
  if (s.address) lines.push(s.address);
  if (s.concern) lines.push('Concern: ' + (CONCERN_LABEL[s.concern] || s.concern));
  if (s.story) lines.push(String(s.story).slice(0, 200));
  return lines.join('\n').slice(0, 480);
}

// ── Homeowner acknowledgment (speed-to-lead, half of the loop) ──────────
// Joe gets paged the second a lead lands; until now the HOMEOWNER got
// nothing — no confirmation their request went anywhere, which is exactly
// when they keep shopping and fill out a competitor's form. This sends a
// short "got it — here's what happens next" email signed by Joe.
//
// V1 is EMAIL-ONLY by design: an auto-SMS to the homeowner needs express
// texting consent on the forms (TCPA) — that's Jo's call and a copy change,
// not a code constraint. Guards: valid email required; NBD leads only
// (configured tenants must opt in with their own copy before we speak to
// their customers); independent try/catch so a failure never touches lead
// capture or Joe's alert.
const ACK_FIRST_LINE = {
  contact_leads: 'Got your message.',
  estimate_leads: 'Got your estimate request.',
  inspect_leads: 'Got your inspection request.',
  free_roof_entries: 'Your Free Roof entry is in.',
  storm_alert_subscribers: 'Got your storm damage report.',
};

function ackEmailHtml(collection, firstName) {
  const hi = firstName ? `Hi ${esc(firstName)},` : 'Hi,';
  const first = ACK_FIRST_LINE[collection] || 'Got your request.';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family:'Barlow','Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;color:#333">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:linear-gradient(135deg,#1a3057,#12223d);color:#fff;padding:22px 20px;text-align:center">
      <div style="font-size:22px;font-weight:700">${esc(first)}</div>
      <div style="font-size:13px;opacity:.85;margin-top:4px">No Big Deal Home Solutions</div>
    </div>
    <div style="padding:24px 22px;font-size:15px;line-height:1.65">
      <p style="margin:0 0 14px">${hi}</p>
      <p style="margin:0 0 14px">This is Joe. Your request just hit my phone — not a call center, not a queue. I personally look at every one and I'll reach out shortly (same day during work hours).</p>
      <p style="margin:0 0 14px">If it's urgent — active leak, storm damage getting worse — don't wait on me:</p>
      <p style="text-align:center;margin:20px 0"><a href="tel:8594207382" style="display:inline-block;background:#bd5728;color:#fff;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px">Call or text (859) 420-7382</a></p>
      <p style="margin:0">— Joe Deal<br><span style="color:#6b7280;font-size:13px">Owner &amp; Operator, No Big Deal Home Solutions</span></p>
    </div>
  </div>
</body></html>`;
}

function ackEmailText(collection, firstName) {
  const first = ACK_FIRST_LINE[collection] || 'Got your request.';
  return `${first}\n\n${firstName ? 'Hi ' + firstName + ',' : 'Hi,'}\n\nThis is Joe. Your request just hit my phone — not a call center, not a queue. I personally look at every one and I'll reach out shortly (same day during work hours).\n\nIf it's urgent — active leak, storm damage getting worse — call or text me directly: (859) 420-7382.\n\n— Joe Deal\nOwner & Operator, No Big Deal Home Solutions`;
}

async function ackHomeowner(collection, d, leadId, target) {
  // NBD leads only — a tenant's homeowners are not ours to email. Gate on
  // WHOSE lead it is (isNbd from the companyId), not on the resolved seal:
  // the old seal check also matched an UNRESOLVED tenant's fallback target,
  // sending Joe-branded acks to another company's customer (audit 2026-07-29).
  if (!target || target.isNbd !== true) return;
  const email = String(d.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  try {
    const resend = new Resend(RESEND_API_KEY.value());
    const firstName = String(d.firstName || d.name || '').trim().split(/\s+/)[0] || '';
    // Email category: TRANSACTIONAL — acknowledges the homeowner's own request, sent once at submit time. Not gated by the unsubscribe register (email-suppression.js SEND_PATHS).
    const response = await resend.emails.send({
      from: 'Joe Deal <jd@nobigdealwithjoedeal.com>',
      to: email,
      reply_to: 'jd@nobigdealwithjoedeal.com',
      subject: "Got it — Joe here. What happens next",
      html: ackEmailHtml(collection, firstName),
      text: ackEmailText(collection, firstName),
      headers: { 'X-NBD-Campaign': 'lead-ack-v1' },
    });
    // Resend resolves { data: null, error } on an API-level rejection
    // instead of throwing — without this check ackEmailSentAt gets stamped
    // (and "sent" logged) on a homeowner ack that never left Resend.
    if (resendRejected(response)) {
      throw new Error(resendErrorMessage(response));
    }
    logger.info('leadAck: email sent', { collection, leadId });
    if (leadId) {
      await getFirestore().collection(collection).doc(String(leadId))
        .update({ ackEmailSentAt: FieldValue.serverTimestamp() })
        .catch(() => {});
    }
  } catch (e) {
    logger.error('leadAck: email failed', { collection, leadId, err: e.message });
  }
}

// ── Alert outbox ledger (2026-07-06, punch item 6) ──────────────────────
// One doc per alert attempt recording the RESOLVED routing decision +
// per-channel outcomes. Two consumers:
//   - CI: the Stranger E2E asserts the alert for a tenant's public lead
//     TARGETED the tenant (companyProfile alertEmail/alertSms), never
//     Joe — the notification half of lead routing was previously
//     unassertable because Resend/Twilio secrets don't exist in the rig
//     and delivery failed silently server-side.
//   - Prod: an audit trail of who was alerted for which lead (readable
//     by platform admin + the lead's own tenant readers; see
//     firestore.rules /alert_outbox).
// Best-effort by design: an outbox write failure never blocks the alert.
async function recordAlertOutbox(collection, leadId, d, target, outcomes) {
  try {
    await getFirestore().collection('alert_outbox').add({
      kind: 'lead-alert',
      collection,
      leadId: leadId || null,
      companyId: (d && d.companyId) || null,
      target: {
        emails: target.emails || null,
        sms: target.sms || null,
        name: target.name || '',
        seal: target.seal || '',
      },
      emailStatus: outcomes.email,
      smsStatus: outcomes.sms,
      // Twilio "accepts" before the carrier delivers; callWatch stamps the real
      // result on this row as smsDelivery by this id (2026-10-02).
      smsSid: outcomes.smsSid || null,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn('leadAlert: outbox write failed', { collection, leadId, err: e && e.message });
  }
}

// opts (all optional): label — overrides KIND_LABEL[collection]; source —
// overrides d.source in the header; notice — see emailHtml; ack:false — skip
// both homeowner acks (the booking tool already confirmed to the homeowner).
async function alertJoe(collection, d, leadId, opts = {}) {
  const label = opts.label || KIND_LABEL[collection] || collection;
  const source = opts.source != null ? opts.source : (d.source || '');
  const notice = opts.notice || null;
  const s = summarize(d);
  // Route to the lead's tenant (Oaks → Scott); NBD / unset → Joe (default).
  const target = await resolveAlertTarget(d.companyId);
  const outcomes = { email: 'skipped:no-target', sms: 'skipped:no-target' };

  // Text via Twilio (works once the number is A2P 10DLC approved). Skip when
  // the tenant configured no alert SMS — never fall back to Joe's cell.
  if (target.sms) try {
    const client = _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
    const msg = await client.messages.create({
      to: target.sms,
      from: TWILIO_PHONE_NUMBER.value(),
      body: smsBody(label, source, s, target.seal, notice),
    });
    outcomes.sms = 'sent';
    outcomes.smsSid = (msg && msg.sid) || null;
    logger.info('leadAlert: sms queued', { collection, leadId, sid: msg.sid });
  } catch (e) {
    outcomes.sms = 'failed:' + String(e && e.message || e).slice(0, 200);
    logger.error('leadAlert: sms failed', { collection, leadId, err: e.message });
  }

  // Detailed email → the tenant's alert inbox(es). Skip when none configured.
  if (target.emails && target.emails.length) try {
    const resend = new Resend(RESEND_API_KEY.value());
    const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
    // Email category: INTERNAL — the tenant's own new-lead alert inbox. Out of scope for the homeowner unsubscribe register (email-suppression.js SEND_PATHS).
    const resp = await resend.emails.send({
      from,
      to: target.emails,
      subject: `🔔 New lead — ${label}${notice && notice.subject ? ` (${notice.subject})` : ''}${s.name && s.name[0] !== '(' ? `: ${s.name}` : ''}`,
      html: emailHtml(label, source, s, leadId, target.name, notice),
      reply_to: s.email || undefined,
    });
    // Resend resolves { data: null, error } on an API-level rejection
    // instead of throwing — without this check a dead key/suspended
    // account marks outcomes.email 'sent', and the alert_outbox
    // dashboard-health banner (built specifically to catch a silent
    // delivery failure) never sees it.
    if (resendRejected(resp)) {
      throw new Error(resendErrorMessage(resp));
    }
    outcomes.email = 'sent';
    logger.info('leadAlert: email sent', { collection, leadId, id: (resp && resp.data && resp.data.id) || null });
  } catch (e) {
    outcomes.email = 'failed:' + String(e && e.message || e).slice(0, 200);
    logger.error('leadAlert: email failed', { collection, leadId, err: e.message });
  }

  // Ledger the routing decision + outcomes (see recordAlertOutbox above).
  await recordAlertOutbox(collection, leadId, d, target, outcomes);

  // Close the loop with the homeowner (independent; never blocks the alert).
  if (opts.ack !== false) {
    await ackHomeowner(collection, d, leadId, target);
    await ackHomeownerSms(collection, d, leadId, target);
  }
}

// ── Homeowner ack TEXT — gated, estimate funnel only ────────────────────
// Same idea as the ack email but SMS converts harder. Fires ONLY when:
//  - LEAD_ACK_SMS_ENABLED=true on the trigger services (Jo's flip, same
//    pattern as FUNNEL_RECOVERY_ENABLED — default OFF), and
//  - the lead is on a consent-bearing collection, and
//  - the lead itself CARRIES a stored `tcpaConsent: true`.
//
// That last clause is the 2026-09-04 fix. This gate used to stop at the
// collection name, reasoning that the /estimate funnel's submit button is
// hard-disabled until the consent box is ticked and therefore every document
// in estimate_leads consented "by construction". Two things were wrong with
// that. The funnel does post `tcpaConsent`, but submitPublicLead's M-04
// allowlist silently dropped the boolean, so the record never persisted (fixed
// in handlers/integrations.js in the same change). And inferring consent from
// a collection name means anything that ever writes into that collection by
// another route — an import, a backfill, a second form — inherits permission
// to text a homeowner. Consent is now read from the document, never inferred.
//
// Fail-closed consequence, stated plainly: leads created BEFORE the
// persistence fix deploys carry no consent field and will not be acked. That
// is correct. Consent cannot be back-dated onto records that never captured it.
//
// Delivery still requires the Twilio number's A2P 10DLC approval.
async function ackHomeownerSms(collection, d, leadId, target) {
  const gate = C.smsAckGate({
    enabled: process.env.LEAD_ACK_SMS_ENABLED === 'true',
    collection,
    doc: d,
    target,
  });
  if (!gate.allowed) {
    // The flag being off is the normal resting state and must not spam logs;
    // every other refusal is a real suppression an operator should be able to
    // find later, especially `no_stored_consent`, which is the one that says a
    // homeowner asked for a call and did not get the text back.
    if (gate.reason !== 'flag_disabled' && gate.reason !== 'collection_not_consent_bearing') {
      logger.info('leadAck: sms suppressed', { collection, leadId, reason: gate.reason });
    }
    return;
  }
  const digits = String(d.phone || d.phoneNumber || '').replace(/[^\d]/g, '');
  if (digits.length !== 10 && !(digits.length === 11 && digits[0] === '1')) return;
  const to = '+1' + digits.slice(-10);
  try {
    const client = _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
    const firstName = String(d.firstName || '').trim();
    const msg = await client.messages.create({
      to,
      from: TWILIO_PHONE_NUMBER.value(),
      body: `${firstName ? firstName + ' — g' : 'G'}ot your estimate request. This is Joe with No Big Deal Home Solutions — I'll call you shortly. Urgent? Call/text me at (859) 420-7382. Reply STOP to opt out.`,
    });
    logger.info('leadAck: sms queued', { collection, leadId, sid: msg.sid });
    if (leadId) {
      await getFirestore().collection(collection).doc(String(leadId))
        .update({ ackSmsSentAt: FieldValue.serverTimestamp() })
        .catch(() => {});
    }
  } catch (e) {
    logger.error('leadAck: sms failed', { collection, leadId, err: e.message });
  }
}

const TRIGGER_OPTS = {
  region: 'us-central1',
  secrets: SECRETS,
  maxInstances: 10,
  memory: '256MiB',
  timeoutSeconds: 30,
};

function onLeadAlert(collection) {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() || {};
    // The /estimate funnel writes follow-up EVENT docs (results shown / CTA
    // click / email request) into estimate_leads alongside the initial lead.
    // Each is a fresh create → without this skip, one completed funnel fires
    // up to 4 duplicate alert emails for the same homeowner. lead-bridge.js
    // already skips these for the CRM mirror; mirror that here so the alert
    // path agrees with the bridge on what counts as a new lead.
    if (L.isFollowUpEvent(collection, data)) {
      logger.info('leadAlert: follow-up event doc — not a new lead, skipping', { collection, type: data.type });
      return;
    }
    await alertJoe(collection, data, event.params && event.params.leadId);
  };
}

// Most storm-alert signups are a marketing LIST, so the bulk must NOT page
// Joe. But a homeowner who deliberately flags real damage (insurance / wind /
// general — anything other than the form's PRE-SELECTED 'hail' default) is a
// hot, ready-to-hire lead. Alert on those AND mirror them into the CRM pipeline
// (see onStormBridge in lead-bridge.js). Both gates share the SAME
// HIGH_INTENT_STORM_CONCERNS set so the lead that pages Joe is the lead that
// lands in his pipeline. (2026-06-25: widened from ['insurance'] per Jo.)
const STORM_ALERT_CONCERNS = L.HIGH_INTENT_STORM_CONCERNS;
function onStormAlert() {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() || {};
    const concern = String(data.concern || '').toLowerCase();
    if (!STORM_ALERT_CONCERNS.includes(concern)) {
      logger.info('leadAlert: storm signup is list-only (no high-intent concern) — no alert', { concern });
      return;
    }
    await alertJoe('storm_alert_subscribers', data, event.params && event.params.leadId);
  };
}

// Cal.com bookings land in `leads` directly (integrations/calcom.js M-2), so
// this trigger sees EVERY lead create. It must stay silent for all but a
// webhook-created booking or a bridged Thumbtack lead (onThumbtackLeadAlert):
//  - a manual CRM lead (no publicLeadKind) is Joe's own entry;
//  - a bridged web-form lead (publicLeadKind 'inspect', 'estimate', ...)
//    already paged him from its public collection. Alerting here would fire
//    twice. Thumbtack is the one bridged kind with no public-collection alert;
//    it alerts here instead;
//  - a booking re-created by scripts/backfill-calcom-dropped-leads.js is a
//    PAST booking being repaired, not a new one to act on.
// No homeowner ack: Cal.com already emails every booker, a third message is
// Jo's call, and a booking carries no stored tcpaConsent to text on.
// Logs carry the lead id and booleans only — never the booker's contact info.
const MAILTO_SAFE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
function onCalcomLeadAlert() {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    const data = snap.data() || {};
    const leadId = event.params && event.params.leadId;
    if (isBridgedThumbtackLead(data, leadId)) {
      await onThumbtackLeadAlert(data, leadId);
      return;
    }
    if (data.publicLeadKind !== 'calcom_booking' || data.webLead !== true) return;
    if (data.backfilledBy) {
      logger.info('leadAlertCalcom: backfilled booking — not a new lead, no alert', { leadId });
      return;
    }
    const needsPhone = data.needsPhone === true;
    const email = String(data.email || '').trim();
    const title = String(data.calcomEventTitle || '').trim();
    const slug = String(data.calcomEventSlug || '').trim();
    // calcom-logic prepends NO_PHONE_NOTE to the stored notes; the notice below
    // says it once, so the Message row carries only what the booker wrote.
    const bookedNotes = String(data.notes || '').split('\n')
      .filter((l) => l.trim() !== CL.NO_PHONE_NOTE).join('\n').trim();
    const notice = needsPhone ? {
      email: 'No phone on this booking — reply to the Cal.com confirmation email to get a number before the visit',
      mailto: MAILTO_SAFE.test(email) ? email : '',
      sms: 'NO PHONE — reply to the confirmation email',
      subject: 'NO PHONE',
    } : null;
    logger.info('leadAlertCalcom: booking lead created', { leadId, needsPhone, eventSlug: slug || null });
    await alertJoe('leads', { ...data, message: bookedNotes }, leadId, {
      source: [title, slug].filter(Boolean).join(' · '),
      notice,
      ack: false,
    });
  };
}

// Thumbtack leads (2026-09-26). The webhook writes thumbtack_leads/{rawId} and
// leadBridgeThumbtack mirrors it to leads/{thumbtack_leads__<rawId>}. Nothing
// alerted on either create, so every Thumbtack lead reached the pipeline
// without paging Joe.
//
// Why alert here and not on thumbtack_leads: this trigger is already deployed
// with the alert secrets, and the bridge has already done the filtering. It
// drops Thumbtack's "Test this webhook" deliveries (isTest), and its create()
// makes a re-delivery a no-op. Anything that pages must also be a real card in
// the pipeline.
//
// One alert per lead. Only the BRIDGE's create pages: the doc id must be the
// bridge's deterministic id for the raw doc it names. That id is written once,
// by create(). A hand-typed lead with source "Thumbtack", a restore (an
// update, not a create), or any other doc copying these fields fails the id
// check. The alert does not fire from thumbtack_leads, so the raw doc and its
// mirror cannot both page.
//
// No homeowner ack: Thumbtack already messaged the customer, and Thumbtack
// never passes their email. Logs carry the lead id only.
function isBridgedThumbtackLead(data, leadId) {
  const coll = 'thumbtack_leads';
  return data.publicLeadKind === L.BRIDGE_KINDS[coll].kind
    && data.publicLeadCollection === coll
    && !!data.publicLeadId
    && String(leadId || '') === L.bridgeDocId(coll, data.publicLeadId);
}

async function onThumbtackLeadAlert(data, leadId) {
  if (data.backfilledBy) {
    logger.info('leadAlertThumbtack: backfilled lead — not a new lead, no alert', { leadId });
    return;
  }
  logger.info('leadAlertThumbtack: bridged lead created', { leadId });
  // notes is thumbtack-logic leadNotes(): the service, the description, the
  // lead cost and the questionnaire answers, which is what Joe needs for the
  // first call. The label already says Thumbtack, so leave the header's
  // "from" line empty rather than repeat it.
  await alertJoe('leads', { ...data, message: String(data.notes || '') }, leadId, {
    label: L.BRIDGE_KINDS.thumbtack_leads.label,
    source: '',
    ack: false,
  });
}

// IMPORTANT: each export assigns onDocumentCreated(...) DIRECTLY (not via a
// makeTrigger() wrapper). The CI auto-deploy builds its --only allowlist by
// grepping `^exports.<name> = (onRequest|onCall|onDocumentCreated|...)` in
// .github/workflows/firebase-deploy.yml — a `= makeTrigger(...)` RHS does NOT
// match, so these alert triggers were silently dropped from the deploy and a
// fix pushed to main only shipped via a manual full `firebase deploy`. Keep the
// RHS a literal factory call, mirroring the proven lead-bridge.js pattern.
exports.leadAlertContact  = onDocumentCreated({ ...TRIGGER_OPTS, document: 'contact_leads/{leadId}' },     onLeadAlert('contact_leads'));
exports.leadAlertEstimate = onDocumentCreated({ ...TRIGGER_OPTS, document: 'estimate_leads/{leadId}' },    onLeadAlert('estimate_leads'));
exports.leadAlertInspect  = onDocumentCreated({ ...TRIGGER_OPTS, document: 'inspect_leads/{leadId}' },     onLeadAlert('inspect_leads'));
exports.leadAlertFreeRoof = onDocumentCreated({ ...TRIGGER_OPTS, document: 'free_roof_entries/{leadId}' }, onLeadAlert('free_roof_entries'));
exports.leadAlertStorm    = onDocumentCreated({ ...TRIGGER_OPTS, document: 'storm_alert_subscribers/{leadId}' }, onStormAlert());
// leadAlertCalcom also alerts on bridged Thumbtack leads (onThumbtackLeadAlert).
// The name was kept on purpose: a renamed export deploys as a NEW function and
// leaves the old one live, because the deploy never deletes retired functions.
// Both would then fire on every lead create and page Joe twice.
exports.leadAlertCalcom   = onDocumentCreated({ ...TRIGGER_OPTS, document: 'leads/{leadId}' },             onCalcomLeadAlert());
