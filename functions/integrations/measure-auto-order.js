/**
 * integrations/measure-auto-order.js — order the Instant Roofer measure
 * before the rep has to ask for it.
 *
 * WHY (2026-10-04, Jo approved)
 * The measurement adapter is live and works, and an audit found it had been
 * used twice. A rep standing in a driveway does not stop to press
 * Auto-measure; they draw by hand or guess. So the measure is ordered for
 * them at the two moments a roof is about to be priced:
 *
 *   - an appointment is set on the lead  (appointments/{id} created with a leadId)
 *   - the lead reaches the Inspected stage (leads/{id} stage change)
 *
 * MONEY — every guard here exists because this spends $3 with nobody
 * pressing a button:
 *   - never twice per lead: a lead marker reserved in a transaction, a
 *     deterministic measurements/auto-<leadId> doc written with create(),
 *     and any lead that already carries a measurementJobId is skipped;
 *   - a DAILY and a MONTHLY ceiling on paid orders (AUTO_ORDER_DEFAULTS,
 *     overridable without a deploy in feature_flags/global as
 *     autoMeasureDailyCap / autoMeasureMonthlyCap), reserved in the same
 *     transaction as the lead marker, so a burst of triggers cannot race past
 *     them;
 *   - a kill switch: feature_flags/global.autoMeasureDisabled = true;
 *   - same-roof reuse (90 days) through measureLeadAndPublish, so a roof any
 *     teammate already measured costs nothing;
 *   - only leads with coordinates (no server geocode spend here).
 *
 * The actual vendor call, doc shape and lead write-back are the web-lead
 * path's (public-measure.js measureLeadAndPublish) — one implementation.
 * The auto-order asks for the outline image too; it lands in Storage and the
 * Draw tool shows it beside the drawn totals.
 */

'use strict';

const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { SECRETS, PROVIDERS } = require('./_shared');
const IR = require('./instantroofer-logic');

// ─── Config ────────────────────────────────────────────────
// Defaults sized to real volume: ~32 leads/month across every source
// (2026-09 lead counters), so 6/day and 60/month is headroom for a storm
// week while capping a runaway at $18/day, $180/month.
const AUTO_ORDER_DEFAULTS = Object.freeze({
  dailyCap: 6,
  monthlyCap: 60,
});

// Stages that mean "this roof is about to be priced". The appointment door
// is the appointments trigger below.
const TRIGGER_STAGES = new Set(['inspected']);

// Never spend on a lead that is gone or lost.
const DEAD_STAGES = new Set(['lost']);

function stageKeyOf(lead) {
  const l = lead || {};
  const raw = l._stageKey || l.stage || '';
  return String(raw).trim().toLowerCase().replace(/\s+/g, '_');
}

/** Effective caps: defaults, overridden by numeric flags. Pure. */
function resolveCaps(flags) {
  const f = flags || {};
  const num = (v, d) => (typeof v === 'number' && isFinite(v) && v >= 0 ? Math.floor(v) : d);
  return {
    dailyCap: num(f.autoMeasureDailyCap, AUTO_ORDER_DEFAULTS.dailyCap),
    monthlyCap: num(f.autoMeasureMonthlyCap, AUTO_ORDER_DEFAULTS.monthlyCap),
  };
}

/**
 * Is this lead a candidate at all? Pure. Returns null to go ahead, or the
 * reason not to.
 */
function leadSkipReason(lead) {
  const l = lead || {};
  if (!l.userId) return 'no-owner';
  if (l.deleted === true) return 'deleted';
  if (DEAD_STAGES.has(stageKeyOf(l))) return 'lost';
  if (l.measurementJobId) return 'already-measured';
  if (!IR.validateCoords(l.lat, l.lng).ok) return 'no-coords';
  return null;
}

/** Did this update move the lead INTO a trigger stage? Pure. */
function enteredTriggerStage(before, after) {
  const a = stageKeyOf(after);
  return TRIGGER_STAGES.has(a) && stageKeyOf(before) !== a;
}

function dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }
function monthKey(ms) { return new Date(ms).toISOString().slice(0, 7); }

/**
 * Reserve one paid order for this lead, or say why not. One transaction:
 * the lead marker (never twice), the day counter, the month counter.
 */
async function reserveOrder(db, { leadId, caps, now, trigger }) {
  const t = now();
  const markerRef = db.doc(`measurementAutoOrders/lead_${leadId}`);
  const dayRef = db.doc(`measurementAutoOrders/day_${dayKey(t)}`);
  const monthRef = db.doc(`measurementAutoOrders/month_${monthKey(t)}`);
  return db.runTransaction(async (tx) => {
    const [m, d, mo] = await Promise.all([tx.get(markerRef), tx.get(dayRef), tx.get(monthRef)]);
    if (m.exists) return { ok: false, reason: 'already-ordered' };
    const dayCount = (d.exists && d.data().count) || 0;
    const monthCount = (mo.exists && mo.data().count) || 0;
    if (dayCount >= caps.dailyCap) return { ok: false, reason: 'daily-cap', dayCount };
    if (monthCount >= caps.monthlyCap) return { ok: false, reason: 'monthly-cap', monthCount };
    tx.set(markerRef, { leadId, trigger, status: 'reserved', at: FieldValue.serverTimestamp() });
    tx.set(dayRef, { count: FieldValue.increment(1), day: dayKey(t), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    tx.set(monthRef, { count: FieldValue.increment(1), month: monthKey(t), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { ok: true };
  });
}

/**
 * The whole decision + order for one lead. Injectable for tests:
 * deps.flags (object) | deps.getFlags(), deps.measure(db, args), deps.now.
 */
async function autoOrderForLead(db, { leadId, lead, trigger }, deps) {
  deps = deps || {};
  const now = deps.now || Date.now;
  const skip = leadSkipReason(lead);
  if (skip) return { ok: false, reason: skip };
  if ((deps.provider || PROVIDERS.measurement) !== 'instantroofer') return { ok: false, reason: 'provider-not-instantroofer' };

  const flags = deps.flags || await (deps.getFlags || require('./killswitch').getFlags)();
  if (flags && flags.autoMeasureDisabled === true) return { ok: false, reason: 'disabled' };
  const caps = resolveCaps(flags);

  const reserved = await reserveOrder(db, { leadId, caps, now, trigger });
  if (!reserved.ok) {
    const lvl = reserved.reason === 'already-ordered' ? 'info' : 'error';
    logger[lvl]('measure-auto-order: not ordered', { leadId, trigger, reason: reserved.reason, caps });
    return reserved;
  }

  const measure = deps.measure || require('./public-measure')._test.measureLeadAndPublish;
  let out;
  try {
    out = await measure(db, {
      leadId, lead,
      jobDocId: 'auto-' + leadId,
      source: 'auto-order:' + trigger,
      withOutline: true,
      deps: deps.measureDeps,
    });
  } catch (e) {
    out = { ok: false, reason: 'threw', error: e && e.message };
  }
  await db.doc(`measurementAutoOrders/lead_${leadId}`).set({
    status: out && out.ok ? (out.reused ? 'reused' : 'ordered') : 'failed',
    reason: (out && out.reason) || null,
    jobId: (out && out.jobId) || null,
    doneAt: FieldValue.serverTimestamp(),
  }, { merge: true }).catch(() => {});
  return out;
}

const TRIGGER_OPTS = {
  region: 'us-central1',
  timeoutSeconds: 60,
  memory: '256MiB',
  // A retry would be a second paid call; the reservation already makes it a
  // no-op, but there is nothing a retry could fix either.
  retry: false,
  secrets: [SECRETS.INSTANTROOFER_API_KEY],
};

// Door 1 — the lead reached Inspected.
exports.autoMeasureOnStage = onDocumentUpdated(
  Object.assign({ document: 'leads/{leadId}' }, TRIGGER_OPTS),
  async (event) => {
    const before = event.data && event.data.before && event.data.before.data();
    const after = event.data && event.data.after && event.data.after.data();
    if (!after || !enteredTriggerStage(before, after)) return;
    const leadId = event.params.leadId;
    try {
      const out = await autoOrderForLead(getFirestore(), { leadId, lead: after, trigger: 'stage' });
      logger.info('measure-auto-order: stage', { leadId, ok: !!(out && out.ok), reason: out && out.reason });
    } catch (e) {
      logger.error('measure-auto-order: stage threw', { leadId, err: e && e.message });
    }
  }
);

// Door 2 — an appointment was set on the lead.
exports.autoMeasureOnAppointment = onDocumentCreated(
  Object.assign({ document: 'appointments/{appointmentId}' }, TRIGGER_OPTS),
  async (event) => {
    const appt = event.data && event.data.data();
    const leadId = appt && typeof appt.leadId === 'string' ? appt.leadId : '';
    if (!leadId || !/^[A-Za-z0-9_-]{1,128}$/.test(leadId)) return;
    try {
      const db = getFirestore();
      const snap = await db.doc(`leads/${leadId}`).get();
      if (!snap.exists) return;
      const lead = snap.data() || {};
      // The appointment must belong to the lead's own tenant — an appointment
      // doc is client-written, and its leadId is just a string.
      const owner = appt.userId || appt.repUid || null;
      if (owner && owner !== lead.userId && !(appt.companyId && appt.companyId === lead.companyId)) {
        logger.warn('measure-auto-order: appointment owner does not match lead', { leadId });
        return;
      }
      const out = await autoOrderForLead(db, { leadId, lead, trigger: 'appointment' });
      logger.info('measure-auto-order: appointment', { leadId, ok: !!(out && out.ok), reason: out && out.reason });
    } catch (e) {
      logger.error('measure-auto-order: appointment threw', { leadId, err: e && e.message });
    }
  }
);

exports._test = {
  AUTO_ORDER_DEFAULTS, TRIGGER_STAGES, resolveCaps, leadSkipReason, enteredTriggerStage,
  reserveOrder, autoOrderForLead, stageKeyOf,
};

module.exports = exports;
