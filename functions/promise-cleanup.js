'use strict';

/**
 * functions/promise-cleanup.js — nightly promise cleanup (2026-10-04).
 *
 * 02:30 ET: for each of Jo's calls / days of texts that still has an open
 * "you said you'd…" promise (filed on a customer, not handled, task not
 * ticked, last 30 days), Claude Haiku 4.5 reads what happened AFTER it on that
 * customer's timeline and says which promises were explicitly done. Only a
 * verdict whose quoted evidence is found word for word in a later entry is
 * applied (promise-cleanup-logic.js verifyVerdicts). Applying = stamping
 * keptAtMs / keptBy / keptEvidence on that promise in the phone_calls or
 * phone_text_days doc AND on its timeline entry (cube-<id> / sms-<id>), which
 * drops it from the "You said you'd…" list (collectSweepItems), the morning
 * brief and "Brief me". The follow-up task itself is never touched.
 *
 * Every change is logged: one promise_cleanup_log row per promise marked
 * (applied:true), or proposed in a dry run (applied:false). DRY-RUN unless
 * PROMISE_CLEANUP_ENABLED=true. Owner's calls only; never contacts anyone.
 */

const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const P = require('./promise-cleanup-logic');

const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const LOOKBACK_MS = 30 * 24 * 3600 * 1000;   // same window as the sweep list
const PER_RUN = 40;
const enabled = () => process.env.PROMISE_CLEANUP_ENABLED === 'true';

async function loadCandidates(db, nowMs) {
  const out = [];
  for (const [collection, channel] of [['phone_calls', 'call'], ['phone_text_days', 'text']]) {
    const q = await db.collection(collection).where('userId', '==', OWNER).where('status', '==', 'noted')
      .orderBy('startedAtMs', 'desc').limit(300).get();
    q.forEach((d) => {
      const c = Object.assign({}, d.data() || {}, { id: d.id, _collection: collection, channel });
      if (P.isCandidate(c, nowMs, LOOKBACK_MS)) out.push(c);
    });
  }
  return out.sort((a, b) => (Number(b.startedAtMs) || 0) - (Number(a.startedAtMs) || 0)).slice(0, PER_RUN);
}

/**
 * One run. deps: { db, nowMs, live, ask: ({system, prompt}) → parsed JSON, log }
 * @returns {{ checked, asked, marked, proposed, errors }}
 */
async function runPromiseCleanup({ db, nowMs, live, ask, log = logger }) {
  const stats = { checked: 0, asked: 0, marked: 0, proposed: 0, errors: 0 };
  const calls = await loadCandidates(db, nowMs);
  for (const call of calls) {
    stats.checked++;
    try {
      const own = (call.channel === 'text' ? 'sms-' : 'cube-') + call.id;
      const actSnap = await db.collection('leads').doc(call.leadId).collection('activity').orderBy('createdAt', 'desc').limit(60).get();
      const activity = [];
      actSnap.forEach((d) => activity.push(Object.assign({ id: d.id }, d.data() || {})));
      const evidence = P.evidenceAfter(call, activity, own);
      if (!evidence.length) continue;                        // nothing happened since → nothing to judge
      const promises = P.openPromises(call);
      stats.asked++;
      const parsed = await ask({ system: P.SYSTEM, prompt: P.buildPrompt(promises, evidence) });
      const kept = P.verifyVerdicts(parsed, promises, evidence);
      if (!kept.length) continue;
      for (const k of kept) {
        await db.collection('promise_cleanup_log').add({
          applied: !!live, ownerUid: OWNER, leadId: call.leadId, channel: call.channel, sourceId: call.id,
          promiseIndex: k.index, promiseText: k.text, evidenceActivityId: k.activityId || null, quote: k.quote,
          model: P.MODEL, atMs: nowMs, createdAt: FieldValue.serverTimestamp(),
        });
      }
      if (!live) { stats.proposed += kept.length; continue; }
      const next = P.applyKept(call.promises, kept, nowMs);
      await db.collection(call._collection).doc(call.id).set({ promises: next, promiseCleanupAtMs: nowMs }, { merge: true });
      // The timeline copy (Brief me + smart follow-ups read it). Only if present.
      const actRef = db.collection('leads').doc(call.leadId).collection('activity').doc(own);
      const act = await actRef.get();
      if (act.exists && Array.isArray((act.data() || {}).promises)) {
        await actRef.set({ promises: P.applyKept(act.data().promises, kept, nowMs) }, { merge: true });
      }
      stats.marked += kept.length;
      log.info('promise_cleanup_marked', { sourceId: call.id, leadId: call.leadId, n: kept.length });
    } catch (e) {
      stats.errors++;
      log.warn('promise_cleanup_failed', { sourceId: call.id, err: e && e.message });
    }
  }
  return stats;
}

exports.promiseCleanup = onSchedule(
  { schedule: '30 2 * * *', timeZone: 'America/New_York', timeoutSeconds: 540, memory: '512MiB', maxInstances: 1, secrets: [ANTHROPIC_API_KEY] },
  async () => {
    try {
      if (await require('./integrations/killswitch').isAiDisabled()) { logger.info('[promiseCleanup] AI disabled — skipped'); return; }
      const { claudeNotes } = require('./call-center');
      const r = await runPromiseCleanup({
        db: getFirestore(), nowMs: Date.now(), live: enabled(),
        ask: ({ system, prompt }) => claudeNotes({ system, prompt, feature: 'promise-cleanup', maxTokens: 600 }),
      });
      logger.info('[promiseCleanup]', Object.assign({ mode: enabled() ? 'live' : 'dry-run' }, r));
    } catch (e) {
      logger.warn('[promiseCleanup] failed', { err: e && e.message });
    }
  }
);

exports._test = { runPromiseCleanup, loadCandidates, OWNER, PER_RUN };
