'use strict';
/**
 * call-watch.js — callWatch (Jo, 2026-10-02): every 2 hours, 8 AM–8 PM
 * Eastern, check the phone pipeline so nothing gets missed through the day
 * and slow updates get caught. Rules: call-watch-logic.js.
 *
 * Reads: phone_calls + phone_text_days (owner), thursday_calls (owner's
 * company), integrations/callCenter + integrations/textInbox (status docs).
 * Writes: integrations/callWatch (what it already told Jo), one bell
 * notification per check that has something new, and a push to Jo's phone.
 * Never texts or emails anyone. Gate: CALL_WATCH_ENABLED=true (otherwise it
 * computes and logs only).
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const W = require('./call-watch-logic');

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const watchEnabled = () => process.env.CALL_WATCH_ENABLED === 'true';

async function runWatch({ db, nowMs, live, push }) {
  if (!W.inWatchHours(nowMs)) return { state: 'off_hours' };
  const stateRef = db.doc('integrations/callWatch');
  const stateSnap = await stateRef.get();
  const st = stateSnap.exists ? stateSnap.data() : {};
  // First run looks back 2 hours; after that, since the last check.
  const sinceMs = W.toMs(st.lastCheckAtMs) || nowMs - 2 * 3600000;
  const since14 = nowMs - W.CALL_WINDOW;

  const [calls, texts, thursday, stored, cc, ti] = await Promise.all([
    db.collection('phone_calls').where('userId', '==', OWNER).where('startedAtMs', '>=', since14).get(),
    db.collection('phone_text_days').where('userId', '==', OWNER).where('startedAtMs', '>=', since14).get(),
    db.collection('thursday_calls').where('companyId', '==', OWNER).limit(300).get(),
    db.collection('phone_calls').where('userId', '==', OWNER).where('status', '==', 'stored').limit(200).get(),
    db.doc('integrations/callCenter').get(),
    db.doc('integrations/textInbox').get(),
  ]);
  const rows = (s) => s.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  const thu = rows(thursday).filter((t) => (W.toMs(t.startedAt) || W.toMs(t.createdAt)) >= since14);

  // Items already told (keeps a re-run or an overlapping check from repeating).
  const told = new Set(Array.isArray(st.toldIds) ? st.toldIds : []);
  const needs = W.newNeeds(rows(calls), rows(texts), thu, sinceMs, nowMs).filter((n) => !told.has(n.id));
  const gates = {
    ingest: process.env.CALL_CENTER_INGEST_ENABLED === 'true',
    transcribe: process.env.CALL_CENTER_TRANSCRIBE_ENABLED === 'true',
    textNotes: process.env.TEXT_NOTES_ENABLED === 'true',
  };
  const problems = W.pipelineProblems(cc.exists ? cc.data() : null, ti.exists ? ti.data() : null, rows(stored), thu, nowMs, gates);
  const tell = W.problemsToTell(problems, st.problemsToldAt, nowMs);
  const alert = W.alertFor(needs, tell, nowMs);
  const counts = { needs: needs.length, problems: problems.length, told: tell.length };

  if (!live) return Object.assign({ state: 'dry_run', alert: alert ? alert.title : null }, counts);

  const problemsToldAt = {};
  problems.forEach((p) => { problemsToldAt[p.key] = (tell.some((t) => t.key === p.key) ? nowMs : W.toMs((st.problemsToldAt || {})[p.key])) || nowMs; });
  const toldIds = needs.map((n) => n.id).concat([...told]).slice(0, 400);
  if (alert) {
    await db.collection('notifications').add({
      userId: OWNER, type: 'call_watch', title: alert.title, message: alert.message, priority: alert.priority,
      clickUrl: '/pro/dashboard#/calls', read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
    });
    try { await push(OWNER, alert.title.replace(/^📞 /, ''), alert.push, { type: 'call_watch', clickUrl: '/pro/dashboard#/calls' }); }
    catch (e) { logger.warn('[callWatch] push failed', { err: e && e.message }); }
  }
  await stateRef.set({ lastCheckAtMs: nowMs, lastResult: counts, problems: problems.map((p) => p.key), problemsToldAt, toldIds }, { merge: false });
  return Object.assign({ state: alert ? 'alerted' : 'quiet' }, counts);
}

exports.callWatch = onSchedule(
  { schedule: '0 8-20/2 * * *', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '512MiB', maxInstances: 1 },
  async () => {
    try {
      const r = await runWatch({
        db: getFirestore(), nowMs: Date.now(), live: watchEnabled(),
        // sendCustomNotification (as Thursday + deal views use) — push-functions'
        // module.exports.sendPushNotification points at an export never assigned.
        push: (uid, title, body, data) => require('./push-functions').sendCustomNotification(uid, title, body, Object.assign({ notificationId: 'call-watch-' + Date.now() }, data)),
      });
      logger.info('[callWatch]', r);
    } catch (e) {
      logger.warn('[callWatch] failed', { err: e && e.message });
      throw e; // let the heartbeat report /fail — a watch that can't watch must not look healthy
    }
  }
);

exports._internal = { runWatch };
