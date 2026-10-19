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
 * planThumbtack below.
 *
 * Push + honest SMS status (2026-10-07). The Twilio number is still not A2P
 * registered, so every alert text is carrier-blocked (30034) — yet the outbox
 * row said smsStatus 'sent' the moment Twilio ACCEPTED it, and email was the
 * ONLY channel that actually reached Joe (no push on any web/Cal.com/Thumbtack
 * lead: onNewLead pushes only leads with an assignedTo, which no bridged lead
 * has). Now: every alert also pushes to the owner's devices (pushStatus on the
 * row), an accepted text is recorded as 'accepted' (the carrier's verdict
 * lands later as smsDelivery), and lead-alert-watchdog.js re-sends by email +
 * push any lead that no channel confirmed reaching Joe.
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
// Homeowner-ack text: the checks every send path makes (2026-10-05).
const OptOut = require('./sms-optout');
const TextingGate = require('./sms-texting-gate');
// The ONE customer kill switch + canary + owner contact (2026-10-19).
const MessagingControls = require('./messaging-controls');
const SendWindow = require('./sms-send-window');
const Outbox = require('./sms-outbox-guard');   // nowMs: the one clock seam the send paths share
const CL = require('./integrations/calcom-logic');
// Who an alert may go TO: the owner's verified Auth email / phone or an address
// the owner confirmed — never a raw tenant-writable value (2026-10-13).
const AR = require('./alert-recipients');
// Flood / repeat guard decided at intake (submitPublicLead) — 2026-10-15.
const PLG = require('./public-lead-guard');
// The homeowner "got your request" email: at most this many per destination
// inbox per rolling 24h (H1, 2026-10-15).
const ACK_RECIPIENT_DAILY_CAP = 1;

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_PHONE_NUMBER = defineSecret('TWILIO_PHONE_NUMBER');
const SECRETS = [RESEND_API_KEY, EMAIL_FROM, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER];

// Per-tenant daily ceiling on email/SMS lead alerts for a NON-NBD tenant
// (2026-10-13). A tenant sets its own alert contacts and they are not verified,
// so the alert senders (NBD's Resend domain + Twilio number) are only as
// well-behaved as the tenant. A real contractor sees a handful of leads a day;
// this bounds what a misconfigured or hostile tenant can push through NBD's
// senders. Over the ceiling the lead still lands in the CRM and the tenant's
// own devices still get the push; only the email/SMS are skipped.
const TENANT_ALERT_DAILY_CAP = 60;
const TENANT_ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;
// One source IP may page a tenant this many times a day via the PUBLIC forms
// (2026-10-13). submitPublicLead accepts any real tenant id from an anonymous
// browser, so without this one box could use up the tenant's whole ceiling above
// (and the destination cap) and starve the owner's real alerts. The lead, bell
// and push are unaffected. Checked BEFORE the tenant ceiling so a flood from one
// IP does not consume it.
const TENANT_ALERT_IP_DAILY_CAP = 10;

const ALERT_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];

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
// pushUid (2026-10-07): whose devices get the new-lead push — Joe's for an
// NBD lead, the tenant's own owner uid (its companyId) for a configured
// tenant, nobody for an unconfigured one (same as its email/SMS).
async function resolveAlertTarget(companyId) {
  const isNbd = !companyId || String(companyId) === NBD_OWNER_UID;
  const fallback = isNbd
    ? { emails: ALERT_EMAILS, sms: null, name: 'No Big Deal Home Solutions', seal: 'NBD', isNbd: true, pushUid: NBD_OWNER_UID }
    // Unresolved NON-NBD tenant: no routing at all (never Joe's inbox or
    // cell) and never his brand — empty strings per the #1129 convention, and
    // isNbd:false keeps the homeowner acks (Joe-branded copy) from firing at
    // another company's customer. The lead itself is still in their CRM.
    : { emails: null, sms: null, name: '', seal: '', isNbd: false, pushUid: null };
  if (isNbd) {
    // Jo's cell comes from messaging_controls/internal (config), never a
    // constant in this public repo. Not configured = no alert text (email and
    // push still go), logged so it is not a silent gap.
    const owner = await MessagingControls.readOwnerContact(getFirestore());
    fallback.sms = owner.phone || null;
    if (!owner.phone) logger.warn('leadAlert: owner_phone_not_configured — no alert text for NBD leads');
    return fallback;
  }
  try {
    const snap = await getFirestore().collection('companyProfile').doc(String(companyId)).get();
    if (snap.exists) {
      const b = (snap.data() || {}).brand || {};
      const c = b.contact || {};
      if (c.alertEmail || c.alertSms) {
        // alertEmail / alertSms are tenant-writable, so they are only a
        // REQUEST: the recipient is the owner's verified Auth email, an address
        // the owner confirmed, or (for an unconfirmed custom value) the
        // owner's Auth email. SMS goes to the owner's Auth phone only.
        const rr = await AR.resolveTenantRecipients(companyId, c);
        if (rr.ignoredEmail || rr.ignoredSms) {
          logger.warn('leadAlert: tenant alert contact not verified — ignored', {
            companyId: String(companyId), email: !!rr.ignoredEmail, sms: !!rr.ignoredSms,
            fellBackToOwnerEmail: !!(rr.ignoredEmail && rr.emails.length),
          });
        }
        return {
          emails: rr.emails.length ? rr.emails : null,
          sms: rr.sms || null,
          // Configured tenant → its own name/seal, never NBD's. (b is the RAW
          // companyProfile.brand: b.displayName is undefined here, so the old
          // `b.seal || b.displayName || fallback.seal` fell through to 'NBD' for
          // a tenant that set alert routing but no seal — an NBD bleed. M1.)
          name: b.legalName || '',
          seal: b.seal || '',
          isNbd: false,
          pushUid: String(companyId),
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
  // Form answers that used to be stored but never shown (R5-9-2..4): the
  // contact form's service, the Free Roof category (labelled), and the
  // /estimate ballpark the homeowner was shown. All rendered through esc().
  const service = d.service || '';
  const category = d.category ? L.freeRoofCategoryLabel(d.category) : '';
  const ballpark = L.ballparkText(d);
  return { name, phone, address, email, story, concern, service, category, ballpark };
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
        ${row('Service', s.service)}
        ${row('Category', s.category)}
        ${row('Ballpark shown', s.ballpark)}
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
  if (s.service) lines.push('Service: ' + s.service);
  if (s.category) lines.push('Category: ' + s.category);
  if (s.ballpark) lines.push('Shown ' + s.ballpark);
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
  // Per-recipient cap (H1, 2026-10-15). The address was typed into a public
  // form, so anyone can name anyone: without this, a script could make NBD's
  // Resend domain mail the same stranger once per submit. One ack per
  // destination inbox per 24h, across every form. A limiter outage fails
  // open (capRecipients), same as every other alert path.
  // Kill switch BEFORE the per-recipient cap: a paused send must not use up
  // the homeowner's one ack slot for the day.
  // Automated => it needs its OWN explicit entry (messaging_controls/automations
  // leadAckEmail === true) as well as the global switch; default OFF.
  const ackSwitch = await MessagingControls.automationStatus(getFirestore(), 'leadAckEmail', 'email', true);
  if (!ackSwitch.enabled) {
    logger.info('leadAck: email held — not enabled', { collection, leadId, reason: ackSwitch.reason });
    return;
  }
  const capAck = await AR.capRecipients('leadAck', [email], { limit: ACK_RECIPIENT_DAILY_CAP });
  if (!capAck.allowed.length) {
    logger.info('leadAck: email skipped — recipient already acked in the last 24h', { collection, leadId });
    return;
  }
  try {
    const resend = new Resend(RESEND_API_KEY.value());
    // Greeting name only when it is a plain single word (letters, ' or -):
    // never echo arbitrary visitor text to a third-party inbox.
    const firstName = PLG.safeGreetingName(d.firstName || d.name);
    // Email category: TRANSACTIONAL — acknowledges the homeowner's own request, sent once at submit time. Not gated by the unsubscribe register (email-suppression.js SEND_PATHS).
    const ackGate = await MessagingControls.guardEmail(getFirestore(), {
      from: 'Joe Deal <jd@nobigdealwithjoedeal.com>',
      to: email,
      reply_to: 'jd@nobigdealwithjoedeal.com',
      subject: "Got it — Joe here. What happens next",
      html: ackEmailHtml(collection, firstName),
      text: ackEmailText(collection, firstName),
      headers: { 'X-NBD-Campaign': 'lead-ack-v1' },
    });
    if (!ackGate.send) {
      logger.info('leadAck: email held — customer messaging paused', { collection, leadId, reason: ackGate.reason });
      return;
    }
    const response = await resend.emails.send(ackGate.msg);
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
      // 'accepted' = Twilio took the text, NOT that it arrived. callWatch and
      // leadAlertWatchdog stamp the carrier's verdict on this row as
      // smsDelivery ('delivered' | 'undelivered:<code>' | 'failed:<code>')
      // by smsSid (2026-10-02 / 2026-10-07).
      smsStatus: outcomes.sms,
      smsSid: outcomes.smsSid || null,
      // 'sent' (>= 1 device took it) | 'skipped:no-device' | 'skipped:no-target' | 'failed:…'
      pushStatus: outcomes.push || 'skipped:no-target',
      ...(outcomes.watchdog ? { watchdogRetry: true } : {}),
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    logger.warn('leadAlert: outbox write failed', { collection, leadId, err: e && e.message });
  }
}

// New-lead push to the alert target's own devices (2026-10-07). Returns the
// outcome string recorded as pushStatus. Lazy require: push-functions builds
// its Firestore/Messaging clients at load. type 'newLead' gives the push the
// Call / Open / Snooze buttons (push-functions notificationActionsFor).
async function pushLeadAlert(target, collection, d, leadId, label, s, notice) {
  if (!target || !target.pushUid) return 'skipped:no-target';
  try {
    const crmLeadId = collection === 'leads' ? String(leadId || '') : L.bridgeDocId(collection, leadId);
    const title = (notice && notice.subject ? `⚠ ${notice.subject} — ` : '🔔 ') + `New lead — ${label}`;
    const body = [s.name, s.phone, s.address].filter(Boolean).join(' · ').slice(0, 180);
    const r = await require('./push-functions').sendCustomNotification(target.pushUid, title, body, {
      type: 'newLead',
      leadId: crmLeadId,
      phone: String(d.phone || d.phoneNumber || '').replace(/[^\d+]/g, ''),
      clickUrl: `/pro/dashboard.html?tab=leads&leadId=${encodeURIComponent(crmLeadId)}`,
      notificationId: `lead-alert-${crmLeadId}`,
      requireInteraction: 'true',
    });
    if (r && r.sent > 0) return 'sent';
    if (r && Array.isArray(r.errors) && r.errors.length) return 'failed:' + String(r.errors[0]).slice(0, 200);
    return 'skipped:no-device';
  } catch (e) {
    return 'failed:' + String(e && e.message || e).slice(0, 200);
  }
}

// One in-app bell per tenant per day when its email/text alerts were paused by a
// cap (2026-10-13). The ceiling can be reached by anonymous public-form traffic
// (residual), so the owner must be able to see that alerts paused while leads
// still arrive. Deterministic id + create() = at most one a day; best-effort.
async function alertsPausedBell(target, companyId, trusted) {
  try {
    const uid = target && target.pushUid;
    if (!uid) return;
    const day = new Date(Outbox.nowMs()).toISOString().slice(0, 10);
    await getFirestore().collection('notifications').doc(`alertcap_${companyId}_${trusted ? 't' : 'p'}_${day}`).create({
      userId: String(uid), type: 'alerts_paused', priority: 'high',
      title: 'Lead alerts paused today',
      message: 'Email and text alerts hit the daily limit. New leads still arrive in your CRM and on your phone.',
      clickUrl: '/pro/dashboard.html?tab=leads', read: false, dismissed: false,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (!(e && (e.code === 6 || /already exists/i.test(String(e.message || ''))))) {
      logger.warn('leadAlert: alerts-paused bell failed', { err: e && e.message });
    }
  }
}

// opts (all optional): label — overrides KIND_LABEL[collection]; source —
// overrides d.source in the header; notice — see emailHtml; ack:false — skip
// both homeowner acks (the booking tool already confirmed to the homeowner);
// skipSms — no text (the watchdog's re-send: texts are what failed);
// watchdog — marks the outbox row as a re-send.
// Returns the outcomes { email, sms, push, smsSid }.
async function alertJoe(collection, d, leadId, opts = {}) {
  const label = opts.label || KIND_LABEL[collection] || collection;
  const source = opts.source != null ? opts.source : (d.source || '');
  const notice = opts.notice || null;
  const s = summarize(d);
  // Route to the lead's tenant (Oaks → Scott); NBD / unset → Joe (default).
  const target = await resolveAlertTarget(d.companyId);
  const outcomes = { email: 'skipped:no-target', sms: 'skipped:no-target', push: 'skipped:no-target' };
  if (opts.watchdog) outcomes.watchdog = true;
  if (opts.skipSms && target.sms) outcomes.sms = 'skipped:watchdog-resend';

  // Tenant ceiling (NBD's own leads are never capped here). A limiter outage
  // fails OPEN: a dropped lead alert costs a customer, a missed cap costs one
  // more message.
  // Origin (2026-10-13): collection 'leads' is only alerted for rows an
  // authenticated webhook minted (Cal.com, Thumbtack bridge — see the id checks
  // in planCalcom / isBridgedThumbtackLead). Everything else arrives from an
  // anonymous public form. They get SEPARATE buckets so a public-form flood
  // cannot starve a real booking alert.
  const trusted = collection === 'leads';
  // A watchdog re-send is the SAME lead's second attempt: its first attempt
  // already debited every bucket, so it must not debit them again.
  const debit = !opts.watchdog;
  let capped = false;
  let ipTripped = false;
  if (debit && !target.isNbd && d.companyId && (target.sms || (target.emails && target.emails.length))) {
    try {
      const RL = require('./rate-limit');
      // No usable source address (clientIp falls back to 'unknown') -> no IP
      // bucket: all such leads would share one key and starve each other.
      const ipOk = typeof d.ip === 'string' && d.ip.trim() !== '' && d.ip.trim().toLowerCase() !== 'unknown';
      if (!trusted && ipOk) {
        try {
          await RL.enforceRateLimit('leadAlert:tenantIp', String(d.companyId) + '|' + RL.rateLimitIpKey(String(d.ip)), TENANT_ALERT_IP_DAILY_CAP, TENANT_ALERT_WINDOW_MS);
        } catch (ipErr) {
          if (ipErr && ipErr.rateLimited) { ipTripped = true; throw ipErr; }
          logger.warn('leadAlert: per-IP cap check unavailable — continuing', { collection, leadId, err: ipErr && ipErr.message });
        }
      }
      await RL.enforceRateLimit(trusted ? 'leadAlert:tenant:trusted' : 'leadAlert:tenant', String(d.companyId), TENANT_ALERT_DAILY_CAP, TENANT_ALERT_WINDOW_MS);
    } catch (e) {
      if (e && e.rateLimited) {
        capped = true;
        if (target.sms) outcomes.sms = 'skipped:rate-limited';
        if (target.emails && target.emails.length) outcomes.email = 'skipped:rate-limited';
        logger.warn('leadAlert: tenant daily alert cap reached — email/SMS skipped', { collection, leadId, companyId: String(d.companyId) });
        // Only the TENANT ceiling rings the bell: one source IP tripping its own
        // bucket must not be able to page the owner.
        if (!ipTripped) await alertsPausedBell(target, d.companyId, trusted);
      } else {
        logger.warn('leadAlert: tenant cap check unavailable — sending', { collection, leadId, err: e && e.message });
      }
    }
  }

  // Per-recipient daily cap, across tenants (2026-10-13): one destination
  // address/number can only be paged so many times a day whoever asks. NBD's
  // own constants are exempt (a tenant cannot write them). A capped alert still
  // has its CRM lead, bell and push. A limiter outage fails open.
  let toEmails = target.emails || null;
  let toSms = target.sms || null;
  if (capped) { toEmails = null; toSms = null; }
  if (debit && !target.isNbd && !capped) {
    if (toEmails && toEmails.length) {
      const r = await AR.capRecipients('email', toEmails, { tenantKey: d.companyId, tenantLimit: AR.RECIPIENT_TENANT_DAILY_CAP, trusted });
      toEmails = r.allowed;
      if (r.capped.length) {
        logger.warn('leadAlert: recipient daily cap reached — email skipped', { collection, leadId, capped: r.capped.length });
        if (!toEmails.length) outcomes.email = 'skipped:recipient-capped';
      }
    }
    if (toSms) {
      const r = await AR.capRecipients('sms', [toSms], { tenantKey: d.companyId, tenantLimit: AR.RECIPIENT_TENANT_DAILY_CAP, trusted });
      if (!r.allowed.length) {
        toSms = null;
        outcomes.sms = 'skipped:recipient-capped';
        logger.warn('leadAlert: recipient daily cap reached — SMS skipped', { collection, leadId });
      }
    }
  }

  // Text via Twilio (works once the number is A2P 10DLC approved). Skip when
  // the tenant configured no alert SMS — never fall back to Joe's cell.
  // NBD's own alert (to Jo) is an INTERNAL alert: its own switch + an hourly
  // cap, never the customer switch. A non-NBD tenant owner's text goes out on
  // NBD's campaign number, so it passes the customer switch like any other.
  let smsHeld = null;
  if (toSms && !opts.skipSms && !capped && target.isNbd) {
    const ia = await MessagingControls.internalAlertStatus(getFirestore(), 'sms', { key: collection + '/' + leadId, bucket: 'lead' });
    if (!ia.allowed) smsHeld = ia.reason;
  }
  if (smsHeld) {
    outcomes.sms = 'skipped:' + smsHeld;
    logger.warn('leadAlert: internal alert text held', { collection, leadId, reason: smsHeld });
  }
  if (toSms && !opts.skipSms && !capped && !smsHeld) try {
    const rawClient = _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value());
    const client = target.isNbd ? rawClient : MessagingControls.guardTwilio(getFirestore(), rawClient);
    const msg = await client.messages.create({
      to: toSms,
      from: TWILIO_PHONE_NUMBER.value(),
      body: smsBody(label, source, s, target.seal, notice),
    });
    // ACCEPTED, not sent: while the number is unregistered the carrier drops
    // every one of these after Twilio takes it (30034). The verdict is
    // stamped later as smsDelivery; nothing may read 'accepted' as reached.
    outcomes.sms = 'accepted';
    outcomes.smsSid = (msg && msg.sid) || null;
    logger.info('leadAlert: sms queued', { collection, leadId, sid: msg.sid });
  } catch (e) {
    outcomes.sms = 'failed:' + String(e && e.message || e).slice(0, 200);
    logger.error('leadAlert: sms failed', { collection, leadId, err: e.message });
  }

  // NBD's alert email to Jo: own switch + hourly cap (internal, never the customer switch).
  if (toEmails && toEmails.length && !capped && target.isNbd) {
    const ie = await MessagingControls.internalAlertStatus(getFirestore(), 'email', { key: collection + '/' + leadId, bucket: 'lead' });
    if (!ie.allowed && ie.reason !== 'owner_email_not_configured') {
      toEmails = null;
      outcomes.email = 'skipped:' + ie.reason;
      logger.warn('leadAlert: internal alert email held', { collection, leadId, reason: ie.reason });
    }
  }

  // Detailed email → the tenant's alert inbox(es). Skip when none configured.
  if (toEmails && toEmails.length && !capped) try {
    const resend = new Resend(RESEND_API_KEY.value());
    const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
    // Email category: INTERNAL — the tenant's own new-lead alert inbox. Out of scope for the homeowner unsubscribe register (email-suppression.js SEND_PATHS).
    const resp = await resend.emails.send({
      from,
      to: toEmails,
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

  // Push to the target's phone(s) — the channel that works without A2P.
  outcomes.push = await pushLeadAlert(target, collection, d, leadId, label, s, notice);
  if (outcomes.push !== 'sent' && outcomes.push !== 'skipped:no-target') {
    logger.warn('leadAlert: push not delivered', { collection, leadId, push: outcomes.push });
  }

  // Ledger the routing decision + outcomes (see recordAlertOutbox above).
  await recordAlertOutbox(collection, leadId, d, target, outcomes);

  // Close the loop with the homeowner (independent; never blocks the alert).
  if (opts.ack !== false) {
    await ackHomeowner(collection, d, leadId, target);
    await ackHomeownerSms(collection, d, leadId, target);
  }
  return outcomes;
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
  // BOTH the env flag and an explicit messaging_controls/automations entry
  // (leadAckSms === true) and the global SMS switch; any one missing = no text.
  const ackAuto = await MessagingControls.automationStatus(
    getFirestore(), 'leadAckSms', 'sms', process.env.LEAD_ACK_SMS_ENABLED === 'true');
  const gate = C.smsAckGate({
    enabled: ackAuto.enabled,
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
  // 2026-10-05 (texting review): the same three checks as every other send
  // path — the STOP register + the company's Do Not Text list, the company's
  // texting master switch, and texting hours in the homeowner's time. Any
  // read error skips the ack (fail closed); the ack is a courtesy, never
  // worth a text to someone who said stop.
  const tenantKey = TextingGate.tenantKeyOfRecord(d) || TextingGate.NBD_OWNER_UID;
  try {
    const opt = await OptOut.isOptedOut(getFirestore(), to, { companyId: tenantKey, timeoutMs: OptOut.READ_TIMEOUT_MS });
    if (opt.optedOut) { logger.info('leadAck: sms suppressed', { collection, leadId, reason: 'opted_out' }); return; }
    const status = await TextingGate.textingStatus(getFirestore(), tenantKey);
    if (!status.allowed) { logger.info('leadAck: sms suppressed', { collection, leadId, reason: 'texting_' + status.reason }); return; }
  } catch (e) {
    logger.error('leadAck: sms suppressed — compliance check unreadable', { collection, leadId, err: e && e.message });
    return;
  }
  if (!SendWindow.withinRecipientWindow(Outbox.nowMs(), d)) {
    logger.info('leadAck: sms suppressed', { collection, leadId, reason: 'quiet_hours' });
    return;
  }
  // Idempotency per (recipient, template, lead): a retried trigger can never
  // send the same ack twice. An unverifiable marker is no send.
  try {
    const first = await MessagingControls.claimSendOnce(getFirestore(), to, 'lead_ack_sms', collection + '/' + (leadId || ''));
    if (!first) { logger.info('leadAck: sms suppressed', { collection, leadId, reason: 'already_sent' }); return; }
  } catch (e) {
    logger.error('leadAck: sms suppressed — dedupe unverifiable', { collection, leadId, err: e && e.message });
    return;
  }
  try {
    const client = MessagingControls.guardTwilio(getFirestore(), _twilio()(TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value()));
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

// ── What a create should alert, and how (2026-10-07) ────────────────────
// ONE decision shared by the triggers below and lead-alert-watchdog.js, so
// the watchdog's "this lead should have reached Joe" can never drift from
// what the triggers actually alert on. Returns
//   { alert: false, log?: [message, meta] }  — no alert (log once if given)
//   { alert: true, collection, data, opts, log? } — alertJoe(collection, data, leadId, opts)
function alertPlan(collection, data, leadId) {
  data = data || {};
  if (collection === 'leads') return planLeadsDoc(data, leadId);
  // Intake guard (M1, 2026-10-15): submitPublicLead marks a repeat phone
  // within 24h ('duplicate') and every lead past the daily alert cap
  // ('volume'). The lead is stored and bridged as usual; no SMS / email /
  // push / homeowner ack. These fields are server-set only (the public
  // collections deny every client write), and the watchdog reads this same
  // plan, so it will not re-send them either.
  if (data.alertSuppressed === 'duplicate' || data.alertSuppressed === 'volume') {
    return { alert: false, log: ['leadAlert: alert suppressed at intake', { collection, reason: data.alertSuppressed }] };
  }
  const plan = collection === 'storm_alert_subscribers' ? planStorm(data) : alertPlanPublic(collection, data);
  // The first lead over the daily cap carries the ONE "volume unusually high"
  // notice; everything after it today is suppressed above.
  if (plan.alert && data.leadVolumeNotice === true) {
    plan.opts = Object.assign({}, plan.opts, { notice: LEAD_VOLUME_NOTICE });
  }
  return plan;
}

const LEAD_VOLUME_NOTICE = {
  email: 'Lead volume is unusually high today. Text, email and push alerts are paused for the rest of the day. New leads still land in the CRM; check the pipeline.',
  mailto: '',
  sms: 'LEAD VOLUME UNUSUALLY HIGH TODAY - alerts paused, leads still in CRM',
  subject: 'LEAD VOLUME HIGH',
};

function alertPlanPublic(collection, data) {
  // The /estimate funnel writes follow-up EVENT docs (results shown / CTA
  // click / email request) into estimate_leads alongside the initial lead.
  // Each is a fresh create → without this skip, one completed funnel fires
  // up to 4 duplicate alert emails for the same homeowner. lead-bridge.js
  // already skips these for the CRM mirror; mirror that here so the alert
  // path agrees with the bridge on what counts as a new lead.
  if (L.isFollowUpEvent(collection, data)) {
    return { alert: false, log: ['leadAlert: follow-up event doc — not a new lead, skipping', { collection, type: data.type }] };
  }
  return { alert: true, collection, data, opts: {} };
}

async function runPlan(plan, leadId) {
  if (plan.log) logger.info(plan.log[0], plan.log[1]);
  if (plan.alert) await alertJoe(plan.collection, plan.data, leadId, plan.opts);
}

function onLeadAlert(collection) {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    const leadId = event.params && event.params.leadId;
    await runPlan(alertPlan(collection, snap.data() || {}, leadId), leadId);
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
function planStorm(data) {
  const concern = String(data.concern || '').toLowerCase();
  if (!STORM_ALERT_CONCERNS.includes(concern)) {
    return { alert: false, log: ['leadAlert: storm signup is list-only (no high-intent concern) — no alert', { concern }] };
  }
  return { alert: true, collection: 'storm_alert_subscribers', data, opts: {} };
}
function onStormAlert() {
  return async (event) => {
    const snap = event.data;
    if (!snap) return;
    const leadId = event.params && event.params.leadId;
    await runPlan(alertPlan('storm_alert_subscribers', snap.data() || {}, leadId), leadId);
  };
}

// Cal.com bookings land in `leads` directly (integrations/calcom.js M-2), so
// this trigger sees EVERY lead create. It must stay silent for all but a
// webhook-created booking or a bridged Thumbtack lead (planThumbtack):
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
    const leadId = event.params && event.params.leadId;
    await runPlan(alertPlan('leads', snap.data() || {}, leadId), leadId);
  };
}

function planLeadsDoc(data, leadId) {
  if (isBridgedThumbtackLead(data, leadId)) return planThumbtack(data, leadId);
  if (data.publicLeadKind !== 'calcom_booking' || data.webLead !== true) return { alert: false };
  if (data.backfilledBy) {
    return { alert: false, log: ['leadAlertCalcom: backfilled booking — not a new lead, no alert', { leadId }] };
  }
  // Provenance (2026-10-13): only the Cal.com webhook's create() mints the
  // deterministic id calcom__<bookingId> (integrations/calcom.js), and it
  // writes calcomBookingId from the same value. A lead that merely CLAIMS to
  // be a booking (any signed-in tenant can write any field onto a lead it
  // creates) must not page anyone: the alert goes out on NBD's Resend/Twilio
  // senders, so a forged one is a free relay. Same idea as
  // isBridgedThumbtackLead above; firestore.rules also refuses these fields
  // and ids from a client create.
  const bookingId = data.calcomBookingId;
  if (bookingId == null || bookingId === '' || String(leadId || '') !== L.bridgeDocId('calcom', bookingId)) {
    return { alert: false, log: ['leadAlertCalcom: lead claims to be a booking but its id is not the webhook-minted one — no alert', { leadId }] };
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
  return {
    alert: true,
    collection: 'leads',
    data: { ...data, message: bookedNotes },
    opts: { source: [title, slug].filter(Boolean).join(' · '), notice, ack: false },
    log: ['leadAlertCalcom: booking lead created', { leadId, needsPhone, eventSlug: slug || null }],
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

function planThumbtack(data, leadId) {
  if (data.backfilledBy) {
    return { alert: false, log: ['leadAlertThumbtack: backfilled lead — not a new lead, no alert', { leadId }] };
  }
  // notes is thumbtack-logic leadNotes(): the service, the description, the
  // lead cost and the questionnaire answers, which is what Joe needs for the
  // first call. The label already says Thumbtack, so leave the header's
  // "from" line empty rather than repeat it.
  return {
    alert: true,
    collection: 'leads',
    data: { ...data, message: String(data.notes || '') },
    opts: { label: L.BRIDGE_KINDS.thumbtack_leads.label, source: '', ack: false },
    log: ['leadAlertThumbtack: bridged lead created', { leadId }],
  };
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
// leadAlertCalcom also alerts on bridged Thumbtack leads (planThumbtack).
// The name was kept on purpose: a renamed export deploys as a NEW function and
// leaves the old one live, because the deploy never deletes retired functions.
// Both would then fire on every lead create and page Joe twice.
exports.leadAlertCalcom   = onDocumentCreated({ ...TRIGGER_OPTS, document: 'leads/{leadId}' },             onCalcomLeadAlert());

// For lead-alert-watchdog.js and tests. NON-enumerable on purpose: index.js
// does Object.assign(exports, require('./lead-alert')), and only Cloud
// Functions belong on the deployed export surface.
Object.defineProperty(exports, '_internal', {
  enumerable: false,
  value: { alertPlan, alertJoe, resolveAlertTarget, TENANT_ALERT_DAILY_CAP, TENANT_ALERT_IP_DAILY_CAP, SECRETS, NBD_OWNER_UID, ALERT_COLLECTIONS: Object.keys(KIND_LABEL) },
});
