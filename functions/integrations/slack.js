/**
 * integrations/slack.js — fire-and-forget Slack alert helper
 *
 * Shared helper + two triggers that fire on high-signal events:
 *   - New lead created (stage changed to "contract signed")
 *   - Platform admin grant attempt (security alert from audit module)
 *
 * SETUP:
 *   1. In Slack, create an incoming webhook for a channel like #nbd-ops.
 *   2. firebase functions:secrets:set SLACK_WEBHOOK_URL
 *   3. Paste the webhook URL when prompted.
 *
 * If the secret isn't set the helpers no-op silently — the rest of
 * the pipeline doesn't notice.
 */

'use strict';

const { onDocumentCreated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getSecret, hasSecret, SECRETS } = require('./_shared');
const { reserveOnce } = require('../storm-sms-guard');

// One Slack post per storm alert: storm_alert_slack_posts/{hash(alertId)}.
const STORM_SLACK_POSTS = 'storm_alert_slack_posts';

async function postSlack(payload) {
  if (!hasSecret('SLACK_WEBHOOK_URL')) return { posted: false, reason: 'unconfigured' };
  const url = getSecret('SLACK_WEBHOOK_URL');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return { posted: res.ok, status: res.status };
  } catch (e) {
    logger.warn('slack post failed:', e.message);
    return { posted: false, reason: e.message };
  }
}

// ─── Trigger: lead flipped to a signed/won stage ─────────────
// Hits on `contract_signed`, `won`, `closed_won` etc. Conservative
// stage allowlist — we don't want a chatty channel on every stage
// bump, just the money moments.
const WIN_STAGES = new Set([
  'contract_signed', 'contract-signed', 'won', 'closed_won', 'closed-won',
  'signed', 'sale_closed', 'deal_closed'
]);

exports.slack_onLeadWon = onDocumentWritten(
  {
    region: 'us-central1',
    document: 'leads/{leadId}',
    secrets: [SECRETS.SLACK_WEBHOOK_URL]
  },
  async (event) => {
    if (!hasSecret('SLACK_WEBHOOK_URL')) return;
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data() : null;
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data() : null;
    if (!after) return;

    const prevStage = (before && before.stage || '').toLowerCase().replace(/\s+/g, '_');
    const nextStage = (after.stage || '').toLowerCase().replace(/\s+/g, '_');
    if (prevStage === nextStage) return;
    if (!WIN_STAGES.has(nextStage)) return;

    const repName = await resolveRepName(after.userId);
    const addr = after.address || '(no address)';
    const value = typeof after.jobValue === 'number' ? after.jobValue : null;
    const dollars = value ? `$${value.toLocaleString()}` : '';

    await postSlack({
      text: `💰 Deal signed: ${addr} ${dollars}`.trim(),
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*💰 Deal signed* by *${escSlack(repName)}*\n*${escSlack(addr)}* — ${dollars || 'value not set'}`
          }
        }
      ]
    });
  }
);

// ─── Trigger: security_admin_grant_attempt audit entry ───────
// The audit-triggers module writes one of these whenever an invite
// doc tries to set role='admin'. That's a C-1 probe. Page on-call.
exports.slack_onAdminGrantAttempt = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'audit_log/{id}',
    secrets: [SECRETS.SLACK_WEBHOOK_URL]
  },
  async (event) => {
    if (!hasSecret('SLACK_WEBHOOK_URL')) return;
    const data = event.data && event.data.data && event.data.data();
    if (!data || data.type !== 'security_admin_grant_attempt') return;
    await postSlack({
      text: '🚨 SECURITY: invite doc set role=admin — investigate now',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*🚨 SECURITY ALERT — admin grant attempt*\n' +
              '`companies/' + (data.ids && data.ids.companyId) + '/members/<redacted>`\n' +
              'onRepSignup clamped the role to sales_rep, but the attempt itself means someone probed the C-1 path. ' +
              'Pull the audit_log entry and the company owner\'s session history.'
          }
        }
      ]
    });
  }
);

// ─── Trigger: storm alert — ONE summary post per alert to ops channel ──
// storm_alerts_sent holds one doc per (alertId, subscriber), so a 250-text
// run fired this trigger 250 times and posted 250 times (2026-10-03). It also
// read d.subscribers / d.severity, which no writer has ever set — every post
// said "Subscribers notified: 0". Now the first doc for an alertId reserves
// storm_alert_slack_posts/{hash} with create-once semantics and only that
// invocation posts; the per-subscriber rows stay in storm_alerts_sent.
async function postStormAlertOnce(db, d) {
  if (!d || !d.alertId) return { posted: false, reason: 'no_alert_id' };
  let first;
  try {
    first = await reserveOnce(db, STORM_SLACK_POSTS, d.alertId,
      { alertId: String(d.alertId), event: d.event || null },
      () => FieldValue.serverTimestamp());
  } catch (e) {
    logger.warn('slack_storm_reserve_failed', { err: e.message });
    return { posted: false, reason: 'reserve_failed' };
  }
  if (!first) return { posted: false, reason: 'duplicate' };
  const area = d.areas || d.area || d.zip || 'unknown area';
  return postSlack({
    text: '⛈ Storm alert — texting subscribers: ' + (d.event || 'severe weather') + ' (' + String(area).slice(0, 120) + ')',
    blocks: [{
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*⛈ Storm alert — texting subscribers*\nEvent: *${escSlack(d.event || 'Severe Weather')}*\nArea: *${escSlack(String(area).slice(0, 300))}*` +
          (d.headline ? `\n${escSlack(String(d.headline).slice(0, 300))}` : '') +
          '\n_One post per alert — per-subscriber texts are logged in storm_alerts_sent._'
      }
    }]
  });
}

exports.slack_onStormAlert = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'storm_alerts_sent/{id}',
    secrets: [SECRETS.SLACK_WEBHOOK_URL]
  },
  async (event) => {
    if (!hasSecret('SLACK_WEBHOOK_URL')) return;
    const d = event.data && event.data.data && event.data.data();
    if (!d) return;
    await postStormAlertOnce(getFirestore(), d);
  }
);

async function resolveRepName(uid) {
  if (!uid) return 'Unknown rep';
  try {
    const snap = await getFirestore().doc(`users/${uid}`).get();
    if (snap.exists) {
      const d = snap.data();
      return d.displayName || d.email || uid;
    }
  } catch (e) {}
  return uid;
}

function escSlack(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = exports;
module.exports.postSlack = postSlack;
module.exports._test = { postStormAlertOnce, STORM_SLACK_POSTS };
