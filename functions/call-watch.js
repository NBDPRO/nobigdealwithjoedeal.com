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
 *
 * Also reads (GET only) Twilio's delivery results for the last day, so texts
 * the carrier blocked surface as "texts are not delivering" (2026-10-02: 0 of
 * 23 delivered while the CRM's records said "sent").
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { defineSecret } = require('firebase-functions/params');
const W = require('./call-watch-logic');

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const secretVal = (n) => { const v = String(process.env[n] || '').trim(); return v && v !== '__unset__' ? v : ''; };

/** Twilio outbound messages from the last day — GET only; [] when not configured. */
async function recentTexts(nowMs) {
  const sid = secretVal('TWILIO_ACCOUNT_SID'), tok = secretVal('TWILIO_AUTH_TOKEN');
  if (!sid || !tok) return [];
  const since = new Date(nowMs - 86400000).toISOString().slice(0, 10);
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json?PageSize=200&DateSent%3E=' + since;
  const res = await fetch(url, { method: 'GET', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') } });
  if (!res.ok) throw new Error('twilio messages ' + res.status);
  const body = await res.json();
  return Array.isArray(body.messages) ? body.messages : [];
}

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const watchEnabled = () => process.env.CALL_WATCH_ENABLED === 'true';

async function runWatch({ db, nowMs, live, push, texts: fetchTexts }) {
  if (!W.inWatchHours(nowMs)) return { state: 'off_hours' };
  const stateRef = db.doc('integrations/callWatch');
  const stateSnap = await stateRef.get();
  const st = stateSnap.exists ? stateSnap.data() : {};
  // First run looks back 2 hours; after that, since the last check.
  const sinceMs = W.toMs(st.lastCheckAtMs) || nowMs - 2 * 3600000;
  const since14 = nowMs - W.CALL_WINDOW;

  // orderBy desc so the ranges use the deployed (userId, startedAtMs DESC)
  // indexes; an unordered range wants an ASC index, which prod doesn't have
  // (the emulator never enforces indexes, so only prod caught it).
  const [calls, texts, thursday, stored, cc, ti] = await Promise.all([
    db.collection('phone_calls').where('userId', '==', OWNER).where('startedAtMs', '>=', since14).orderBy('startedAtMs', 'desc').get(),
    db.collection('phone_text_days').where('userId', '==', OWNER).where('startedAtMs', '>=', since14).orderBy('startedAtMs', 'desc').get(),
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
  let sent = [];
  if (typeof fetchTexts === 'function') {
    try { sent = await fetchTexts(nowMs); problems.push(...W.smsProblems(sent, nowMs)); }
    catch (e) { logger.warn('[callWatch] text delivery check skipped', { err: e && e.message }); }
  }
  const tell = W.problemsToTell(problems, st.problemsToldAt, nowMs);
  const alert = W.alertFor(needs, tell, nowMs);
  const counts = { needs: needs.length, problems: problems.length, told: tell.length };

  if (!live) return Object.assign({ state: 'dry_run', alert: alert ? alert.title : null }, counts);

  // The lead-alert ledger said "sent" for texts the carrier blocked: stamp the
  // real result on each alert_outbox row that carries the message id.
  const delivery = W.deliveryBySid(sent);
  const sids = Object.keys(delivery);
  for (let i = 0; i < sids.length; i += 30) {
    try {
      const snap = await db.collection('alert_outbox').where('smsSid', 'in', sids.slice(i, i + 30)).get();
      await Promise.all(snap.docs.filter((d) => d.data().smsDelivery !== delivery[d.data().smsSid])
        .map((d) => d.ref.update({ smsDelivery: delivery[d.data().smsSid], smsDeliveryAtMs: nowMs })));
    } catch (e) { logger.warn('[callWatch] outbox delivery stamp skipped', { err: e && e.message }); }
  }

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
  { schedule: '0 8-20/2 * * *', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '512MiB', maxInstances: 1, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN] },
  async () => {
    try {
      const r = await runWatch({
        db: getFirestore(), nowMs: Date.now(), live: watchEnabled(), texts: recentTexts,
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

exports._internal = { runWatch, recentTexts };
