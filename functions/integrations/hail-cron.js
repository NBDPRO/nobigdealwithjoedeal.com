/**
 * integrations/hail-cron.js — nightly hail batch for every rep's leads
 *
 * Runs on a pubsub schedule. For each active lead that has a lat/lng
 * (or an address we can geocode), fetches recent hail reports within
 * a small radius and stamps `lead.hailHit` if anything 0.75"+ was
 * recorded since the lead's lastHailCheck timestamp.
 *
 * Keeps the "⛈ 1.5"" chip on Kanban cards up to date without reps
 * needing to tap the D2D map. Also posts a Slack summary to
 * SLACK_WEBHOOK_URL if new hits landed.
 *
 * Scheduling: every 24h at 3am local to us-central1 (UTC-6 → 9am UTC).
 * Batch size: 500 leads / run (Firestore page limit). Larger tenants
 * will roll over into the next run's cursor naturally.
 *
 * Provider: NOAA/IEM Local Storm Reports — free and keyless. (The paid
 * HailTrace branch, never configured, was removed 2026-10-04 —
 * VENDOR-COST-LOCKIN Lane C.)
 */

'use strict';

const { onSchedule } = require('./heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue, FieldPath } = require('firebase-admin/firestore');
const { SECRETS, hasSecret, getSecret } = require('./_shared');

// The NOAA fetcher is duplicated lightly from hail.js rather than going
// through the callable — this cron runs with admin rights, no caller token,
// and its own longer timeout.
const { retryTransient } = require('./retry-transient');

async function fetchNoaaHail(lat, lng, radiusMi, daysBack) {
  const tsEnd = new Date();
  const tsStart = new Date(tsEnd.getTime() - daysBack * 86_400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const latDelta = radiusMi / 69;
  const lngDelta = radiusMi / (69 * Math.cos(lat * Math.PI / 180));
  const url = 'https://mesonet.agron.iastate.edu/geojson/lsr.php?'
    + 'sts=' + encodeURIComponent(fmt(tsStart) + 'T00:00')
    + '&ets=' + encodeURIComponent(fmt(tsEnd) + 'T23:59')
    + '&type%5B%5D=H'
    + '&minlat=' + (lat - latDelta).toFixed(4)
    + '&maxlat=' + (lat + latDelta).toFixed(4)
    + '&minlon=' + (lng - lngDelta).toFixed(4)
    + '&maxlon=' + (lng + lngDelta).toFixed(4);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) return [];
  const geo = await res.json();
  return ((geo && geo.features) || []).map(f => {
    const p = f.properties || {};
    const g = f.geometry && f.geometry.coordinates;
    return {
      at: p.valid || p.utc_valid || null,
      lat: Array.isArray(g) ? g[1] : null,
      lng: Array.isArray(g) ? g[0] : null,
      sizeInches: parseFloat(p.magnitude) || null,
      source: 'noaa'
    };
  }).filter(h => h.lat != null && h.lng != null);
}

async function postSlackSummary(summary) {
  if (!hasSecret('SLACK_WEBHOOK_URL')) return;
  try {
    await fetch(getSecret('SLACK_WEBHOOK_URL'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: summary.text,
        blocks: summary.blocks
      })
    });
  } catch (e) { logger.warn('hail-cron slack post failed', e.message); }
}

exports.hailMatchCron = onSchedule(
  {
    region: 'us-central1',
    schedule: 'every day 09:00',          // 9am America/Chicago (Central)
    timeZone: 'America/Chicago',
    timeoutSeconds: 540,                   // 9 min
    memory: '512MiB',
    secrets: [SECRETS.SLACK_WEBHOOK_URL]
  },
  async (event) => {
    const db = getFirestore();
    const SIZE_THRESHOLD = 0.75;   // inches — below this, not worth pitching
    const RADIUS_MI = 0.3;          // ~5 blocks
    const DAYS_BACK = 90;

    // Pull up to 500 leads and filter deleted ones IN MEMORY. Pagination is by
    // ownerUid + cursor field — but for the first pass we iterate all active
    // leads once. Larger tenants roll over to the next day run.
    //
    // 2026-09-04: this used to be `.where('deleted','==',false)`, and that one
    // clause meant the cron had never scored a single one of Jo's leads. A
    // Firestore equality filter SKIPS documents that lack the field entirely,
    // and no live lead-create path writes `deleted` — repos.js stampCreate and
    // both dashboard fallbacks write userId/companyId/createdAt/stage and
    // nothing else. Measured in production the day this was found: 68 of 216
    // lead docs matched, and every one belonged to the seed-demo tenant, while
    // all 81 of Jo's geocoded live leads were invisible to it.
    //
    // The three sibling lead-sweeping crons (dormant-leads.js:205,
    // anniversary-touch.js:232, review-request-nudge.js:240) all do
    // `if (lead.deleted) continue;` instead, which treats a missing field as
    // LIVE — the correct default. This file was the only `.where('deleted'`
    // in the repo. Match the siblings.
    //
    // R4-7 (2026-10-06): the read was a single `.limit(500)` with no cursor,
    // and the "rolls over to the next day" above was never true — lead #501+
    // was simply never scored. Page through EVERY lead by document id (the
    // dormant-leads.js pattern). Leads checked in the last 20h are skipped
    // cheaply below; if the provider calls still outrun the timeout, stop
    // with a logged count instead of being killed mid-loop.
    const PAGE = 500;
    const startedAt = Date.now();
    const BUDGET_MS = 480 * 1000; // under the 540s timeout
    const leadDocs = [];
    let cursor = null;
    for (;;) {
      let q = db.collection('leads').orderBy(FieldPath.documentId()).limit(PAGE);
      if (cursor) q = q.startAfter(cursor);
      const page = await q.get();
      leadDocs.push(...page.docs);
      if (page.size < PAGE) break;
      cursor = page.docs[page.docs.length - 1];
    }

    const fetcher = fetchNoaaHail;

    const newHits = [];
    let checked = 0;
    let skipped = 0;
    let unreached = 0;

    for (const docSnap of leadDocs) {
      if (Date.now() - startedAt > BUDGET_MS) { unreached++; continue; }
      const lead = docSnap.data();
      // Deleted-lead guard, in memory — same convention as the other three
      // lead-sweeping crons. Truthiness, not `=== false`: a lead with no
      // `deleted` field at all is live, which is the case for every lead the
      // current create paths write.
      if (lead.deleted) { skipped++; continue; }
      const lat = Number(lead.lat) || Number(lead.latitude);
      const lng = Number(lead.lng) || Number(lead.lon) || Number(lead.longitude);
      if (!isFinite(lat) || !isFinite(lng)) { skipped++; continue; }
      // Already-checked-recently guard — don't re-query providers every
      // run for leads we just scored.
      const last = lead.lastHailCheck && lead.lastHailCheck.toMillis
        ? lead.lastHailCheck.toMillis() : 0;
      if (Date.now() - last < 20 * 60 * 60 * 1000) { skipped++; continue; }

      try {
        const hits = await retryTransient(() => fetcher(lat, lng, RADIUS_MI, DAYS_BACK));
        const best = hits.reduce((m, h) => {
          const s = Number(h.sizeInches) || 0;
          return s > (m.sizeInches || 0) ? h : m;
        }, { sizeInches: 0 });

        const update = {
          lastHailCheck: FieldValue.serverTimestamp()
        };
        if ((best.sizeInches || 0) >= SIZE_THRESHOLD) {
          update.hailHit = {
            sizeInches: best.sizeInches,
            at:         best.at || null,
            source:     best.source || 'unknown',
            radiusMi:   RADIUS_MI,
            foundAt:    FieldValue.serverTimestamp()
          };
          // Only mark as "new" if we didn't already have a match of
          // equal-or-greater size on this lead.
          const existing = lead.hailHit && lead.hailHit.sizeInches || 0;
          if (best.sizeInches > existing) {
            newHits.push({
              leadId: docSnap.id,
              sizeInches: best.sizeInches,
              address: lead.address || '(no address)',
              // Roof Care Plan member (functions/care-plan.js lead mirror):
              // priority after storms, so first in the summary (2026-10-05).
              carePlanMember: !!(lead.carePlan && lead.carePlan.member === true
                && (lead.carePlan.status === 'active' || lead.carePlan.status === 'past_due')),
              ownerUid: lead.userId
            });
          }
        }
        await docSnap.ref.update(update);
        checked++;
      } catch (e) {
        logger.warn('hail-cron: lead ' + docSnap.id + ' failed: ' + e.message);
      }
    }

    logger.info('hail-cron complete', {
      leads: leadDocs.length, checked, skipped, unreached, newHits: newHits.length
    });
    if (unreached) logger.error('hail-cron: ran out of time; leads not checked this run', { unreached, leads: leadDocs.length });

    // Slack summary — only when there's news to report. Nobody wants
    // "0 new hail hits" every morning.
    if (newHits.length > 0) {
      const top = newHits
        .slice()
        .sort((a, b) => ((b.carePlanMember ? 1 : 0) - (a.carePlanMember ? 1 : 0)) || (b.sizeInches - a.sizeInches))
        .slice(0, 10);
      await postSlackSummary({
        text: '⛈ ' + newHits.length + ' new hail match(es) on pipeline leads',
        blocks: [{
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              '*⛈ Hail match report*\n' +
              newHits.length + ' lead(s) now have verified hail within ' + RADIUS_MI + ' mi.\n\n' +
              top.map(h => '• `' + h.sizeInches.toFixed(2) + '"` — ' + h.address + (h.carePlanMember ? '  🛡 Care Plan member — priority' : '')).join('\n')
          }
        }]
      });
    }
  }
);

module.exports = exports;
