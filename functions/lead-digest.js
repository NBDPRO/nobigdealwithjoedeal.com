/**
 * NBD — Morning lead digest
 * ═══════════════════════════════════════════════════════════════
 * 7:00 AM America/New_York, daily: one email to Joe summarizing every
 * public lead from the previous 24h across the five sources, so nothing
 * that landed overnight starts the day unseen. Skips entirely when there
 * were zero leads (no empty-inbox spam). Read-only over the lead
 * collections; independent of the instant per-lead alerts.
 */

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Resend } = require('resend');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const L = require('./lead-bridge-logic');
const Absorb = require('./morning-brief-absorb');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const DIGEST_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];
const SOURCES = [
  ['estimate_leads', 'Instant Estimate'],
  ['inspect_leads', 'Inspection / Storm tool'],
  ['contact_leads', 'Contact form'],
  ['free_roof_entries', 'Free Roof entry'],
  ['storm_alert_subscribers', 'Storm signup'],
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The digest's rows: every public lead from the 24h before nowMs across the
 * five sources. Shared with the 6:45 morning brief, which carries these as
 * its "New leads" section when it absorbs this email (2026-10-04).
 */
async function gatherDigestRows(db, nowMs) {
  const since = Timestamp.fromMillis((Number(nowMs) || Date.now()) - 24 * 60 * 60 * 1000);
  const rows = [];

  for (const [collection, label] of SOURCES) {
    const snap = await db.collection(collection)
      .where('createdAt', '>=', since)
      .limit(100)
      .get();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      // estimate_leads carries follow-up event docs alongside real leads —
      // same skip the instant alerts use.
      if (L.isFollowUpEvent(collection, d)) continue;
      rows.push({
        label,
        name: [d.firstName, d.lastName].filter(Boolean).join(' ') || d.name || '(no name)',
        phone: d.phone || d.phoneNumber || '',
        address: d.address || '',
        when: d.createdAt && d.createdAt.toDate
          ? d.createdAt.toDate().toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
          : '',
        acked: !!d.ackEmailSentAt,
      });
    }
  }

  return rows;
}

exports.dailyLeadDigest = onSchedule(
  {
    schedule: '0 7 * * *',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 1,
    timeoutSeconds: 120,
    memory: '256MiB',
  },
  async () => {
    const db = getFirestore();
    // One morning email (2026-10-04): when the 6:45 brief is live and absorbs
    // this digest, the same rows reach Jo there instead. Code path kept.
    if (await Absorb.briefAbsorbs(db)) {
      logger.info('leadDigest: absorbed by the morning brief — skipping send');
      return;
    }
    const rows = await gatherDigestRows(db, Date.now());

    if (!rows.length) {
      logger.info('leadDigest: no leads in window — skipping send');
      return;
    }

    const tr = rows.map((r) => {
      const tel = r.phone ? `<a href="tel:${esc(String(r.phone).replace(/[^\d]/g, ''))}" style="color:#BD5728;font-weight:700;text-decoration:none">${esc(r.phone)}</a>` : '—';
      return `<tr>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;font-weight:600">${esc(r.name)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee">${tel}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#6b7280">${esc(r.label)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #eee;color:#6b7280;white-space:nowrap">${esc(r.when)}</td>
      </tr>
      ${r.address ? `<tr><td colspan="4" style="padding:0 10px 8px;border-bottom:1px solid #eee;color:#9ca3af;font-size:13px">${esc(r.address)}</td></tr>` : ''}`;
    }).join('');

    const html = `<!DOCTYPE html><html><body style="font-family:'Barlow','Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;color:#333">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:linear-gradient(135deg,#1a3057,#12223d);color:#fff;padding:20px;text-align:center">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Morning Digest</div>
      <div style="font-size:24px;font-weight:700;margin-top:4px">${rows.length} lead${rows.length === 1 ? '' : 's'} in the last 24h</div>
    </div>
    <div style="padding:16px 14px">
      <table style="width:100%;border-collapse:collapse;font-size:14px">${tr}</table>
    </div>
  </div>
</body></html>`;

    try {
      const resend = new Resend(RESEND_API_KEY.value());
      const from = process.env.EMAIL_FROM || 'noreply@nobigdealwithjoedeal.com';
      await resend.emails.send({
        from,
        to: DIGEST_EMAILS,
        subject: `☀️ ${rows.length} lead${rows.length === 1 ? '' : 's'} in the last 24h`,
        html,
      });
      logger.info('leadDigest: sent', { count: rows.length });
    } catch (e) {
      logger.error('leadDigest: send failed', { err: e.message });
    }
  }
);

exports.gatherDigestRows = gatherDigestRows;
exports.SOURCES = SOURCES;
exports.DIGEST_EMAILS = DIGEST_EMAILS;
