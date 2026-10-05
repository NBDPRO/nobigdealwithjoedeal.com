/**
 * integrations/storm-briefing.js — "Leads in storm path" auto-briefing
 *
 * Phase B.2 of the Pro Chrome roadmap. When a storm_alerts_sent doc
 * fires (customer-facing SMS pipeline — see sms-functions.js), we
 * separately fan out a REP-FACING briefing for every rep with leads
 * inside the affected area. The briefing lands in Slack via the
 * existing slack.js helper and is structured for Viktor to act on
 * (B.3) — title + ranked lead list + suggested call order.
 *
 * Dedup model
 *   storm_alerts_sent docs are 1-per-(alertId, subscriberId), so the
 *   same alertId can fire this trigger 100+ times. We atomically
 *   reserve a sentinel doc `storm_briefings_sent/{alertId}` on the
 *   FIRST trigger; subsequent triggers see the doc and return early.
 *
 * Lead ranking
 *   Each lead's "call score" = sizeInches × stageWeight × recencyWeight.
 *   - sizeInches: lead.hailHit.sizeInches if Regrid stamped it, else
 *     pull the matching alert size from the storm alert.
 *   - stageWeight: late-stage leads (in-progress jobs, signed contracts)
 *     score lower because the rep already has them — early-stage leads
 *     score higher because there's still pipeline value.
 *   - recencyWeight: leads created in the last 30 days score higher.
 *
 * Slack message shape
 *   blocks[]:
 *     header  — "⛈ Storm Briefing: {area} ({severity})"
 *     section — "{N} leads in storm path · suggested call order:"
 *     dividers + lead sections for top 10
 *     actions — "Open Pipeline" deep link
 */

'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { getSecret, hasSecret, SECRETS } = require('./_shared');

// Platform tenant (NBD) — same env override as lead-bridge.js / care-plan.js.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const BRIEFING_LEAD_LIMIT = 10;       // top N in the Slack message
const LEAD_LOOKUP_LIMIT   = 250;      // safety: don't iterate >250 leads per briefing
const RECENT_LEAD_DAYS    = 30;       // boost score for leads created within window

const STAGE_WEIGHTS = {
  // Early-stage = high score (the storm is the call-back hook)
  new:          1.00,
  contacted:    0.95,
  inspected:    0.92,
  claim_filed:  0.80,
  // Mid-stage = moderate (rep has them but may still benefit from re-engage)
  adjuster_meeting: 0.65,
  adjuster_done:    0.55,
  scope_received:   0.50,
  estimate_submitted: 0.40,
  estimate_sent_cash: 0.40,
  // Late-stage = low (job is going or done; storm pitch isn't useful)
  contract_signed: 0.20,
  job_created:     0.15,
  install_in_progress: 0.10,
  install_complete:    0.05,
  closed:          0.05,
  lost:            0.10,
};

async function postSlack(payload) {
  if (!hasSecret('SLACK_WEBHOOK_URL')) return { posted: false, reason: 'unconfigured' };
  const url = getSecret('SLACK_WEBHOOK_URL');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { posted: res.ok, status: res.status };
  } catch (e) {
    logger.warn('storm-briefing.slack_post_failed', { err: e.message });
    return { posted: false, reason: e.message };
  }
}

function escSlack(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function recencyWeight(createdAt) {
  if (!createdAt) return 0.85;
  const ms = createdAt && createdAt.toMillis ? createdAt.toMillis() : Date.parse(createdAt) || 0;
  if (!ms) return 0.85;
  const ageDays = Math.max(0, (Date.now() - ms) / 86_400_000);
  if (ageDays <= RECENT_LEAD_DAYS) return 1.00;
  if (ageDays <= 90) return 0.85;
  if (ageDays <= 180) return 0.70;
  return 0.50;
}

function scoreLead(lead, fallbackSize) {
  const stage = lead._stageKey || lead.stage || 'new';
  const stageW = STAGE_WEIGHTS[stage] != null ? STAGE_WEIGHTS[stage] : 0.50;
  const size = (lead.hailHit && Number(lead.hailHit.sizeInches)) || Number(fallbackSize) || 1.0;
  const recencyW = recencyWeight(lead.createdAt);
  return Number((size * stageW * recencyW).toFixed(3));
}

function formatLeadLine(lead, index) {
  const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()
    || lead.name || 'Lead ' + (lead.id || '').slice(0, 6);
  const addr = lead.address || '—';
  const stage = lead._stageKey || lead.stage || 'new';
  const stageLabel = String(stage).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const phone = lead.phone || '';
  // Suggested action by stage
  let action = 'Call about the storm';
  if (stage === 'contract_signed' || /install/.test(stage)) {
    action = 'Photo-document the storm damage for the file';
  } else if (stage === 'claim_filed' || stage === 'adjuster_meeting') {
    action = 'Update adjuster about new damage';
  } else if (stage === 'inspected' || stage === 'estimate_submitted') {
    action = 'Re-quote with storm severity callout';
  }
  return `*${index + 1}. ${escSlack(name)}*  ·  _${escSlack(stageLabel)}_\n` +
         `   📍 ${escSlack(addr)}` + (phone ? `  ·  📞 ${escSlack(phone)}` : '') + `\n` +
         `   → ${escSlack(action)}`;
}

/**
 * Reserve the dedup sentinel atomically. Returns true if THIS invocation
 * is the one that should send the briefing; false if another invocation
 * already won the race.
 *
 * A sentinel whose status is 'failed' is re-reservable (2026-10-03): the
 * failure path below always meant "let a retry pick it up", but this check
 * treated ANY existing doc as sent, so a failed briefing was never retried.
 * The next storm_alerts_sent doc for the same alertId now retries it.
 */
async function _reserveSentinel(db, alertId) {
  const ref = db.doc(`storm_briefings_sent/${alertId}`);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? (snap.data() || {}) : null;
      if (prev && prev.status !== 'failed') {
        throw new Error('already-sent');
      }
      tx.set(ref, {
        alertId,
        reservedAt: FieldValue.serverTimestamp(),
        status: 'reserved',
        attempts: prev ? (Number(prev.attempts) || 1) + 1 : 1,
      });
    });
    return true;
  } catch (e) {
    if (e.message === 'already-sent') return false;
    throw e;
  }
}

async function _findAffectedLeads(db, alert) {
  // Match by zip first (fast indexed equality query). Future expansion:
  // also accept a geohash-bounded query when we have lead.geo on every
  // doc. For now zip is the highest-precision field that's already on
  // every NBD lead.
  const zip = alert.zip || '';
  if (!zip) return [];
  // ONE company per lookup (2026-10-05): this used to match zipCode alone, so
  // every tenant's lead in the ZIP landed in the platform's Slack briefing.
  // The alert's own company when it names one, else the platform tenant —
  // the storm-alert pipeline and the Slack channel are NBD's.
  const companyId = String(alert.companyId || NBD_OWNER_UID);
  const snap = await db.collection('leads')
    .where('companyId', '==', companyId)
    .where('zipCode', '==', String(zip))
    .limit(LEAD_LOOKUP_LIMIT)
    .get();
  const leads = [];
  snap.forEach(d => {
    const data = d.data();
    if (data.companyId !== companyId) return;   // belt and braces
    if (!data.isProspect) leads.push({ id: d.id, ...data });
  });
  return leads;
}

/**
 * Build the structured Slack briefing for an alert + its affected leads.
 * Returns the Slack payload (blocks array). Viktor.ai (B.3) can read
 * this same structure to act on the suggested call order.
 */
function _composeBriefing(alert, scored) {
  const area = escSlack(alert.zip || alert.area || 'unknown area');
  const severity = escSlack(alert.severity || alert.event || 'severe weather');
  const topN = scored.slice(0, BRIEFING_LEAD_LIMIT);

  const blocks = [];
  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: '⛈ Storm Briefing: ' + (alert.zip || alert.area || 'unknown') }
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Severity:* ${severity}` + (alert.event ? `  ·  *Event:* ${escSlack(alert.event)}` : '') +
            `\n*${scored.length} leads* in storm path${scored.length > topN.length ? ` (showing top ${topN.length})` : ''}  ·  *suggested call order:*`
    }
  });
  blocks.push({ type: 'divider' });

  topN.forEach((lead, i) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: formatLeadLine(lead, i) }
    });
  });

  if (!topN.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: '_No active leads in this storm path right now. Briefing logged for the record._' }
    });
  }

  // Structured action metadata at the end — Viktor.ai (B.3) reads this
  // to suggest follow-up tasks. The fields are intentionally
  // machine-readable.
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `_alertId: \`${escSlack(alert.alertId || 'unknown')}\` · zip: \`${area}\` · leadCount: ${scored.length}_`
    }]
  });

  return {
    text: `⛈ Storm Briefing: ${alert.zip || alert.area || 'storm'} — ${scored.length} leads in path`,
    blocks,
  };
}

/**
 * Trigger: storm_alerts_sent/{id} → fan out a briefing once per alertId.
 *
 * The customer-SMS pipeline writes one doc per (alertId, subscriberId);
 * we run on every fire but the sentinel transaction makes only ONE
 * briefing get posted per unique alertId.
 */
exports.stormBriefing_onAlertSent = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'storm_alerts_sent/{id}',
    secrets: [SECRETS.SLACK_WEBHOOK_URL],
  },
  async (event) => {
    const data = event.data && event.data.data && event.data.data();
    if (!data) return;
    const alertId = data.alertId;
    if (!alertId) return;

    const db = getFirestore();

    // Try to reserve. If another invocation won, return early.
    let reserved;
    try {
      reserved = await _reserveSentinel(db, alertId);
    } catch (e) {
      logger.warn('storm-briefing.sentinel_failed', { alertId, err: e.message });
      return;
    }
    if (!reserved) return;

    try {
      const leads = await _findAffectedLeads(db, data);
      const fallbackSize = Number(data.sizeInches) || 1.0;
      const scored = leads
        .map(l => ({ ...l, _score: scoreLead(l, fallbackSize) }))
        .sort((a, b) => b._score - a._score);

      const payload = _composeBriefing(data, scored);
      const slackResult = await postSlack(payload);

      // Mark the sentinel as completed + capture metadata for Viktor.
      await db.doc(`storm_briefings_sent/${alertId}`).set({
        status: 'sent',
        sentAt: FieldValue.serverTimestamp(),
        alertId,
        zip: data.zip || null,
        area: data.area || null,
        event: data.event || null,
        leadCount: scored.length,
        topLeadIds: scored.slice(0, BRIEFING_LEAD_LIMIT).map(l => l.id),
        slackPosted: !!slackResult.posted,
      }, { merge: true });
    } catch (e) {
      logger.error('storm-briefing.send_failed', { alertId, err: e.message });
      // Mark it 'failed' — _reserveSentinel treats a failed sentinel as free,
      // so the next storm_alerts_sent doc for this alertId retries it.
      await db.doc(`storm_briefings_sent/${alertId}`).set({
        status: 'failed',
        error: e.message,
        failedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }
);

// Test surface — pure functions so unit tests don't need the emulator.
exports._test = { scoreLead, recencyWeight, _composeBriefing, formatLeadLine, _reserveSentinel, _findAffectedLeads };
