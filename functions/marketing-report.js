/**
 * NBD — Monthly marketing report
 * ═══════════════════════════════════════════════════════════════
 * 7:00 AM ET on the 1st: one email to Joe reading out what last month's
 * marketing machine actually produced, so spend decisions run on numbers:
 *
 *   - leads by source (all five public collections, follow-up event docs
 *     excluded) and by UTM campaign/source where attribution was captured;
 *   - estimate-funnel health: starts (funnel_abandoned records), completes,
 *     abandons, recovery emails sent;
 *   - automation counts: homeowner acks, 24h follow-ups;
 *   - CRM movement: how far last month's web leads progressed by stage;
 *   - storm activity: qualifying events the watcher processed.
 *
 * All queries are createdAt-range-only (no composite indexes); webLead and
 * UTM filtering happen in code. Read-only except the outbound email.
 */

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { Resend } = require('resend');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const L = require('./lead-bridge-logic');
const SR = require('./stage-roles');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');

const REPORT_EMAILS = ['jd@nobigdealwithjoedeal.com', 'jonathandeal459@gmail.com'];
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

// Pure aggregation over already-fetched doc arrays — unit-testable.
function aggregate({ leadDocsBySource, funnelDocs, crmDocs, stormCount }) {
  const bySource = {};
  const byUtm = {};
  let totalLeads = 0;
  let acks = 0;
  let followUps = 0;
  for (const [collection, label] of SOURCES) {
    const docs = leadDocsBySource[collection] || [];
    let n = 0;
    for (const d of docs) {
      if (L.isFollowUpEvent(collection, d)) continue;
      n++;
      if (d.ackEmailSentAt) acks++;
      if (d.followUpEmailSentAt) followUps++;
      const utm = d.utm_source
        ? String(d.utm_source) + (d.utm_campaign ? ' / ' + String(d.utm_campaign) : '')
        : '(direct / untagged)';
      byUtm[utm] = (byUtm[utm] || 0) + 1;
    }
    bySource[label] = n;
    totalLeads += n;
  }

  let funnelStarts = 0, funnelCompletes = 0, recoveries = 0;
  for (const d of funnelDocs) {
    funnelStarts++;
    if (d.completedAt) funnelCompletes++;
    if (d.recoveryEmailSentAt) recoveries++;
  }

  const crmStages = {};
  for (const d of crmDocs) {
    if (!d.webLead) continue;
    // Canonical key (2026-10-04): 'New' and 'new' are one stage, not two
    // rows. A tenant custom stage keeps its own key.
    const stage = SR.canonicalStageKey(d.stage) || String(d.stage || 'new');
    crmStages[stage] = (crmStages[stage] || 0) + 1;
  }

  return {
    totalLeads, bySource, byUtm, acks, followUps,
    funnelStarts, funnelCompletes, funnelAbandons: Math.max(0, funnelStarts - funnelCompletes),
    recoveries, crmStages, stormCount,
  };
}

function reportHtml(monthLabel, a) {
  const rows = (obj) => Object.entries(obj).sort((x, y) => y[1] - x[1])
    .map(([k, v]) => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${esc(k)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;font-weight:700">${v}</td></tr>`)
    .join('') || '<tr><td style="padding:6px 12px;color:#9ca3af">none</td><td></td></tr>';
  const section = (title, body) =>
    `<h3 style="margin:22px 0 8px;color:#12223d">${esc(title)}</h3><table style="width:100%;border-collapse:collapse;font-size:14px">${body}</table>`;
  return `<!DOCTYPE html><html><body style="font-family:'Barlow','Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;color:#333">
  <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:linear-gradient(135deg,#1a3057,#12223d);color:#fff;padding:22px 20px;text-align:center">
      <div style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;opacity:.85">Marketing Report</div>
      <div style="font-size:26px;font-weight:700;margin-top:4px">${esc(monthLabel)}: ${a.totalLeads} lead${a.totalLeads === 1 ? '' : 's'}</div>
    </div>
    <div style="padding:8px 20px 24px">
      ${section('Leads by source', rows(a.bySource))}
      ${section('Leads by campaign (UTM)', rows(a.byUtm))}
      ${section('Estimate funnel', rows({
        'Started (email captured)': a.funnelStarts,
        'Completed': a.funnelCompletes,
        'Abandoned': a.funnelAbandons,
        'Recovery emails sent': a.recoveries,
      }))}
      ${section('Automation', rows({
        'Homeowner acks sent': a.acks,
        '24h follow-ups sent': a.followUps,
        'Storm events processed': a.stormCount,
      }))}
      ${section('Where last month\'s web leads stand now (CRM stage)', rows(a.crmStages))}
    </div>
  </div>
</body></html>`;
}

exports.monthlyMarketingReport = onSchedule(
  {
    schedule: '0 7 1 * *',
    timeZone: 'America/New_York',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 1,
    timeoutSeconds: 300,
    memory: '256MiB',
  },
  async () => {
    const db = getFirestore();
    // Previous calendar month, ET-approximate (UTC month boundaries are fine
    // for a monthly rollup — consistent month to month).
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const startTs = Timestamp.fromDate(monthStart);
    const endTs = Timestamp.fromDate(monthEnd);
    const monthLabel = monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

    const inWindow = (col) => db.collection(col)
      .where('createdAt', '>=', startTs).where('createdAt', '<', endTs).limit(1000).get();

    const leadDocsBySource = {};
    for (const [collection] of SOURCES) {
      leadDocsBySource[collection] = (await inWindow(collection)).docs.map((d) => d.data() || {});
    }
    const funnelDocs = (await inWindow('funnel_abandoned')).docs.map((d) => d.data() || {});
    const crmDocs = (await inWindow('leads')).docs.map((d) => d.data() || {});
    const stormCount = (await db.collection('storm_events')
      .where('processedAt', '>=', startTs).where('processedAt', '<', endTs).limit(1000).get()).size;

    const a = aggregate({ leadDocsBySource, funnelDocs, crmDocs, stormCount });
    if (!a.totalLeads && !a.funnelStarts && !a.stormCount) {
      logger.info('marketingReport: empty month — skipping send');
      return;
    }

    try {
      const resend = new Resend(RESEND_API_KEY.value());
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'noreply@nobigdealwithjoedeal.com',
        to: REPORT_EMAILS,
        subject: `📊 ${monthLabel} marketing report — ${a.totalLeads} leads`,
        html: reportHtml(monthLabel, a),
      });
      logger.info('marketingReport: sent', { month: monthLabel, totalLeads: a.totalLeads });
    } catch (e) {
      logger.error('marketingReport: send failed', { err: e.message });
    }
  }
);

exports._test = { aggregate };
