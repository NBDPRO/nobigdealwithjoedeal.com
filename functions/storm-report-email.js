/**
 * NBD — Storm Report follow-up email  (Stage 2 of the /storm-report tool)
 * ═══════════════════════════════════════════════════════════════
 *
 * Firestore onCreate trigger on `inspect_leads`. When a lead arrives from the
 * public /storm-report tool (source === '/storm-report') AND the homeowner
 * left an email, it sends them a branded copy of their 5-year storm-history
 * summary plus a free-inspection CTA.
 *
 * Design notes:
 *   - Additive. Does NOT touch submitPublicLead / the lead pipeline. The lead
 *     is captured + the office notified by the normal path regardless; this
 *     only adds the homeowner's emailed copy.
 *   - No new public endpoint → no "email anything to anyone" abuse vector. It
 *     can only fire on a lead that the gated, rate-limited capture already
 *     created, and only emails the address on that lead.
 *   - Idempotent: Firestore triggers are at-least-once. We transactionally
 *     claim the doc (set reportEmailedAt) before sending, so a redelivered
 *     event is a no-op rather than a duplicate email.
 *   - Reuses the existing Resend provider + secrets (RESEND_API_KEY, EMAIL_FROM).
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { Resend } = require('resend');

// Reuse the same secrets the other email functions bind.
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('./integrations/_shared');
const { resendRejected, resendErrorMessage } = require('./resend-guard');
const GUST = require('./asos-gust-logic');
const { gustForAddressDay } = require('./integrations/asos-gust');

const PHONE_DISPLAY = '(859) 420-7382';
const PHONE_TEL = 'tel:+18594207382';
const SITE = 'https://nobigdealwithjoedeal.com';
const REPLY_TO = 'jd@nobigdealwithjoedeal.com';

function isValidEmail(e) {
  return typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The lead's `story` is an internal line: "STORM REPORT | 42 events/5yr (...)".
// Strip the prefix → a homeowner-facing summary. Robust to format drift: if the
// prefix is missing we just present whatever is there.
function summaryLine(story) {
  const s = String(story || '').replace(/^\s*STORM\s*REPORT\s*\|\s*/i, '').trim();
  return s || 'a multi-year history of hail and wind storms';
}

// Branded HTML — orange header / navy footer, matching the other NBD emails.
// First-person voice ("I'll …", "— Joe"), consistent with the marketing site.
const EMAIL_HTML = ({ firstName, address, summary, gust }) => {
  const nearLine = address ? ` near ${esc(address)}` : '';
  // "Wind measured nearby" (2026-10-06): one line for the biggest storm day,
  // nearest station only, and only when that station has a reading. Escaped
  // like every other interpolation; the context line (inspection / insurer)
  // always rides directly under it.
  const gustBlock = (gust && gust.line) ? `
      <div class="callout">
        <div style="font-weight:700; color:#1a3057;">Wind measured nearby</div>
        <div style="margin-top:4px;">${esc(gust.line)}</div>
        <div class="muted" style="margin-top:6px;">${esc(GUST.GUST_CONTEXT_LINE)}</div>
        <div class="muted" style="margin-top:6px;">Wind gusts: ${esc(GUST.GUST_SOURCE_LINE)}</div>
      </div>` : '';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Barlow','Segoe UI',Roboto,'Helvetica Neue',sans-serif; line-height:1.6; color:#333; background:#f5f5f5; margin:0; }
    .container { max-width:600px; margin:0 auto; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 2px 8px rgba(0,0,0,.1); }
    .header { background:linear-gradient(135deg,#BD5728 0%,#a14a22 100%); color:#fff; padding:30px 20px; text-align:center; }
    .header h1 { margin:0; font-size:24px; font-weight:700; letter-spacing:.5px; }
    .header p { margin:6px 0 0; font-size:14px; opacity:.92; }
    .content { padding:30px 24px; color:#333; }
    .content h2 { color:#1a3057; margin:0 0 14px; font-size:20px; }
    .callout { background:#f4f7fc; border-left:4px solid #1a3057; border-radius:6px; padding:16px 18px; margin:18px 0; }
    .callout .big { font-size:18px; font-weight:700; color:#1a3057; }
    .cta-button { display:inline-block; background:#BD5728; color:#fff !important; padding:14px 32px; border-radius:6px; text-decoration:none; font-weight:700; font-size:17px; margin:18px 0; }
    .muted { color:#666; font-size:14px; }
    .footer { background:#1a3057; color:#fff; padding:20px; text-align:center; font-size:12px; }
    .footer a { color:#e8a06a; text-decoration:none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Your 5-Year Storm History</h1>
      <p>No Big Deal Home Solutions</p>
    </div>
    <div class="content">
      <h2>Hi ${esc(firstName)},</h2>
      <p>Thanks for checking your address. Here's the verified storm history I pulled for your home${nearLine}, straight from National Weather Service records:</p>
      <div class="callout">
        <div class="big">${esc(summary)}</div>
        <div class="muted" style="margin-top:6px;">Source: NWS Local Storm Reports (NOAA), last 5 years.</div>
      </div>${gustBlock}
      <p>Storms like these are exactly what homeowners insurance is meant to cover. The catch: hail and wind damage usually isn't visible from the ground &mdash; but it's the first thing an adjuster looks for.</p>
      <p>The next step is simple, and it's free: I'll come out, get on the roof, and document any damage. You'll get my photos and a written repair estimate you can share with your insurer if you decide to file a claim.</p>
      <p style="text-align:center;">
        <a class="cta-button" href="${PHONE_TEL}">Call or text Joe &mdash; ${PHONE_DISPLAY}</a>
      </p>
      <p class="muted" style="text-align:center;">Or just reply to this email and I'll reach out to set up a time.</p>
      <p style="margin-top:22px;">&mdash; Joe<br><span class="muted">No Big Deal Home Solutions</span></p>
      <p class="muted" style="margin-top:22px; border-top:1px solid #eee; padding-top:14px;">
        Want the full interactive version with the map and an event-by-event breakdown?
        <a href="${SITE}/storm-report" style="color:#BD5728; font-weight:600;">See your full storm report &rarr;</a>
      </p>
    </div>
    <div class="footer">
      <p>No Big Deal Home Solutions &nbsp;|&nbsp; ${PHONE_DISPLAY} &nbsp;|&nbsp; ${REPLY_TO}</p>
      <p><a href="${SITE}">nobigdealwithjoedeal.com</a></p>
    </div>
  </div>
</body>
</html>`;
};

// The gust line for the biggest storm day near this lead, or null (= hide).
// Reads the storm history stormReport already cached for the SAME point the
// homeowner looked up (public_cache/storm_*, server-built — the email never
// trusts a client-sent number), picks the top storm day, and asks the nearest
// station for that day (station+date cache; only station + date go to IEM).
// Fail-closed: no coordinates, no cached report, no reading, or any error → null.
async function gustForLead(d, db) {
  try {
    const lat = Number(d && d.lat), lon = Number(d && d.lon);
    if (d == null || d.lat == null || d.lon == null || !isFinite(lat) || !isFinite(lon)) return null;
    const snap = await db.doc('public_cache/' + GUST.stormReportCacheKey(lat, lon)).get();
    const events = snap && snap.exists && snap.data() && snap.data().data && snap.data().data.events;
    const day = GUST.pickTopStormDays(events || [], 1)[0];
    if (!day) return null;
    return await gustForAddressDay(lat, lon, day, { db, logger });
  } catch (e) {
    logger.warn('stormReportEmail: gust line skipped', { err: e && e.message });
    return null;
  }
}

exports.stormReportEmail = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'inspect_leads/{leadId}',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 10,
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() || {};
    const leadId = event.params && event.params.leadId;

    // Only the /storm-report tool's leads.
    if (d.source !== '/storm-report') return;

    // Need a homeowner email to send to.
    if (!isValidEmail(d.email)) {
      logger.info('stormReportEmail: skip — no/invalid email', { leadId });
      return;
    }

    // Idempotency: at-least-once delivery means this can fire more than once.
    // Transactionally claim the doc before sending so a redelivery is a no-op.
    const ref = snap.ref;
    let claimed = false;
    try {
      claimed = await getFirestore().runTransaction(async (tx) => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) return false;
        if (fresh.get('reportEmailedAt')) return false; // already handled
        tx.update(ref, { reportEmailedAt: FieldValue.serverTimestamp() });
        return true;
      });
    } catch (e) {
      logger.error('stormReportEmail: claim txn failed', { leadId, err: e.message });
      return;
    }
    if (!claimed) {
      logger.info('stormReportEmail: skip — already emailed', { leadId });
      return;
    }

    const firstName = (String(d.name || '').trim().split(/\s+/)[0]) || 'there';
    const address = String(d.address || '').trim();
    const summary = summaryLine(d.story);
    const gust = await gustForLead(d, getFirestore());
    const html = EMAIL_HTML({ firstName, address, summary, gust });

    try {
      const resend = new Resend(RESEND_API_KEY.value());
      const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
      // Email category: TRANSACTIONAL — the homeowner asked for this storm-history report on /storm-report. Not gated by the unsubscribe register (email-suppression.js SEND_PATHS).
      const resp = await resend.emails.send({
        from,
        to: d.email,
        subject: 'Your 5-Year Storm History Report — No Big Deal Home Solutions',
        html,
        reply_to: REPLY_TO,
      });
      // Resend resolves { data: null, error } on an API-level rejection
      // instead of throwing — without this check the doc is already
      // claimed (see the transaction above) so a rejected send would be
      // logged and left as if it had gone out, with no retry ever coming.
      if (resendRejected(resp)) {
        throw new Error(resendErrorMessage(resp));
      }
      const id = (resp && resp.data && resp.data.id) || (resp && resp.id) || null;
      await ref.update({ reportEmailId: id });
      logger.info('stormReportEmail: sent', { leadId, id });
    } catch (e) {
      // Don't rethrow — the lead is already captured + the office notified by
      // the normal pipeline. We logged the failure; we don't trigger a retry
      // storm (and we've already claimed, so no duplicate attempt).
      logger.error('stormReportEmail: send failed', { leadId, err: e.message });
    }
  }
);

// Pure renderers, exposed for tests only (not Cloud Functions).
exports._test = { EMAIL_HTML, gustForLead };
