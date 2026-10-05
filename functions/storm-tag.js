/**
 * storm-tag.js — stamp stormId on a new lead that came in after a storm
 * (2026-10-04, "results per storm"). Rules: storm-tag-logic.js.
 *
 * Trigger: leads/{leadId} created. Reads storm_events (the stormWatch cron's
 * store of qualifying service-area hail / wind / tornado reports) processed in
 * the last STORM_WINDOW_DAYS + 1 days — a single-field range on processedAt,
 * no composite index — and, when one is within STORM_RADIUS_MI of the lead's
 * map pin, writes stormId / stormDate / stormKind / stormDistanceMi /
 * stormPlace onto the lead. A lead with no pin, a deleted / test lead, or one
 * already tagged is left alone. Never sends anything; never throws (a failed
 * tag only means the lead shows under "no storm" in Reports).
 */
'use strict';

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const T = require('./storm-tag-logic');

async function tagLead(db, leadId, lead, nowMs) {
  if (!lead) return { skipped: 'no_lead' };
  const hasPin = Number.isFinite(Number(lead.lat)) && Number.isFinite(Number(lead.lng != null ? lead.lng : lead.lon));
  const dolStorm = /storm/i.test(String(lead.dateOfLossSource || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(lead.dateOfLoss || ''));
  if (!hasPin && !dolStorm) return { skipped: 'no_pin' };
  if (lead.stormId || lead.deleted === true || lead.e2eTestData) return { skipped: 'not_taggable' };
  let events = [];
  if (!dolStorm) {
    const since = Timestamp.fromMillis(nowMs - (T.STORM_WINDOW_DAYS + 1) * 86400000);
    const snap = await db.collection('storm_events').where('processedAt', '>=', since).limit(500).get();
    events = snap.docs.map((d) => d.data() || {});
  }
  const patch = T.stormTagPatch(lead, events, { nowMs });
  if (!patch) return { skipped: 'no_storm' };
  await db.collection('leads').doc(String(leadId)).update(patch);
  return { tagged: patch.stormId };
}

exports.stormTagOnLeadCreate = onDocumentCreated(
  { document: 'leads/{leadId}', region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 },
  async (event) => {
    const lead = event.data && typeof event.data.data === 'function' ? event.data.data() : null;
    try {
      const r = await tagLead(getFirestore(), event.params.leadId, lead, Date.now());
      if (r.tagged) logger.info('[stormTag] tagged', { leadId: event.params.leadId, stormId: r.tagged });
    } catch (e) {
      logger.warn('[stormTag] failed', { leadId: event.params.leadId, err: e && e.message });
    }
  }
);

exports._test = { tagLead };
