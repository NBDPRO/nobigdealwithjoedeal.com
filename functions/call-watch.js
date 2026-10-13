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
 * Also reads the promise TASKS (collectionGroup tasks, userId == owner; 2026-10-13,
 * documentation/audit/PROMISE-CHANNEL-AND-PARKED-RULE-2026-10-13.md): dated
 * promises / ripe Waiting items owed today or earlier, one row per person ->
 * ONE "N promises due today" push, the ladder, the 20:00 ledger count. A push
 * that reaches no phone mails Jo once per item (unreachedEmailed).
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
const CL = require('./contact-labels');
// The task channel (2026-10-13, audit F1): dated promises / ripe Waiting items
// that live only as lead tasks. Reads in promise-channel.js, rules in -logic.
const PC = require('./promise-channel');
const PCL = require('./promise-channel-logic');

const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
// The ladder's email rung (Jo's own inbox; same secrets callCenterSweep binds).
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const secretVal = (n) => { const v = String(process.env[n] || '').trim(); return v && v !== '__unset__' ? v : ''; };

/** Twilio outbound messages from the last day — GET only; [] when not configured. */
async function recentTexts(nowMs) {
  const sid = secretVal('TWILIO_ACCOUNT_SID'), tok = secretVal('TWILIO_AUTH_TOKEN');
  if (!sid || !tok) return [];
  const since = new Date(nowMs - 86400000).toISOString().slice(0, 10);
  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(sid) + '/Messages.json?PageSize=200&DateSent%3E=' + since;
  // A hung Twilio GET must not eat the whole 120 s run before any alert is written
  // (QA 2026-10-13); the caller catches the abort and carries on without the check.
  const res = await fetch(url, { method: 'GET', headers: { Authorization: 'Basic ' + Buffer.from(sid + ':' + tok).toString('base64') }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error('twilio messages ' + res.status);
  const body = await res.json();
  return Array.isArray(body.messages) ? body.messages : [];
}

const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const watchEnabled = () => process.env.CALL_WATCH_ENABLED === 'true';

/**
 * The tenant's per-number labels (companies/{OWNER}/contact_labels), indexed
 * by 10 digits. A failed read is NOT fatal and NOT silent: the watch runs
 * with no labels (every call surfaces, the safe direction) and logs why.
 */
async function loadLabels(db) {
  // One loader for every server reader (it also drops absurd future ackAtMs /
  // updatedAtMs stamps and logs a failed read, returning {} = surface everything).
  return CL.loadLabels(db, OWNER);
}

/** Mirror done follow-up tasks onto open calls / text days (mutates the rows). */
async function reconcileTaskDone({ db, calls, texts, nowMs, live }) {
  const open = [];
  (calls || []).forEach((c) => { if (c.leadId && c.taskDone !== true && W.callNeedsYou(c, nowMs)) open.push({ row: c, col: 'phone_calls', task: 'cube-' + c.id }); });
  (texts || []).forEach((c) => { if (c.leadId && c.taskDone !== true && W.callNeedsYou(c, nowMs)) open.push({ row: c, col: 'phone_text_days', task: 'sms-' + c.id }); });
  if (!open.length || typeof db.getAll !== 'function') return 0;
  let n = 0;
  for (let i = 0; i < open.length; i += 100) {
    const part = open.slice(i, i + 100);
    const snaps = await db.getAll(...part.map((o) => db.doc('leads/' + o.row.leadId + '/tasks/' + o.task)));
    for (let j = 0; j < part.length; j++) {
      // A snooze moves the task's due date; remember it so the re-tell ladder
      // never nags about an item Jo parked with a date.
      const t = snaps[j].exists ? (snaps[j].data() || {}) : null;
      if (t && t.dueDate) part[j].row.taskDueYmd = t.dueDate;
      // A task whose due date a snooze moved (call-center.js 'snooze'): the day
      // that date arrives is told again (newNeeds snoozeWakeYmd).
      if (t && t.snoozedFromDue) part[j].row.taskSnoozed = true;
      if (!(t && t.done === true)) continue;
      // A text day REOPENED by a new inbound text after its task was ticked
      // (textInboxNotes stamps reopenedAtMs): that old tick must not close it
      // again. A fresh tick (completedAt after the reopen) does.
      const reopened = W.toMs(part[j].row.reopenedAtMs);
      if (reopened && W.toMs(t.completedAt) <= reopened) continue;
      part[j].row.taskDone = true;
      n++;
      if (live) await db.collection(part[j].col).doc(part[j].row.id).set({ taskDone: true }, { merge: true });
    }
  }
  return n;
}

async function runWatch({ db, nowMs, live, push, texts: fetchTexts, email }) {
  if (!W.inWatchHours(nowMs)) return { state: 'off_hours' };
  const stateRef = db.doc('integrations/callWatch');
  const stateSnap = await stateRef.get();
  const st = stateSnap.exists ? stateSnap.data() : {};
  // First run looks back 2 hours; after that, since the last check.
  const sinceMs = W.toMs(st.lastCheckAtMs) || nowMs - 2 * 3600000;
  const since14 = nowMs - W.CALL_WINDOW;
  // Calls are READ over the promise window (45 days): callNeedsYou keeps only
  // open Jo promises past day 14, but it can only judge rows it is fed.
  const sinceWin = nowMs - W.PROMISE_WINDOW;

  // orderBy desc so the ranges use the deployed (userId, startedAtMs DESC)
  // indexes; an unordered range wants an ASC index, which prod doesn't have
  // (the emulator never enforces indexes, so only prod caught it).
  const [calls, texts, thursday, stored, cc, ti] = await Promise.all([
    db.collection('phone_calls').where('userId', '==', OWNER).where('startedAtMs', '>=', sinceWin).orderBy('startedAtMs', 'desc').get(),
    db.collection('phone_text_days').where('userId', '==', OWNER).where('startedAtMs', '>=', sinceWin).orderBy('startedAtMs', 'desc').get(),
    W.readThursday(db, OWNER, since14),
    db.collection('phone_calls').where('userId', '==', OWNER).where('status', '==', 'stored').limit(200).get(),
    db.doc('integrations/callCenter').get(),
    db.doc('integrations/textInbox').get(),
  ]);
  const rows = (s) => s.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  // thursday = rows already inside the 14-day window (W.readThursday; null
  // startedAt rows fall back to createdAt here).
  const thu = thursday.filter((t) => (W.toMs(t.startedAt) || W.toMs(t.createdAt)) >= since14);
  const callRows = rows(calls), textRows = rows(texts);
  const labels = await loadLabels(db);

  // A follow-up task ticked before onCallTaskWrite existed (or a missed
  // trigger) never reached the call: read the open ones' tasks and mirror
  // taskDone, so a kept promise is never alerted and the screens catch up.
  const mirror = await reconcileTaskDone({ db, calls: callRows, texts: textRows, nowMs, live });

  // Promises / Waiting items owed today or earlier, one row per PERSON. A failed
  // read is carried as promiseRead.failed (ledger warning), never as "none due".
  const promiseRead = await PC.readDuePromisePeople({ db, owner: OWNER, nowMs, labels });
  const promiseExtras = promiseRead.people.map(PCL.ladderExtra);

  // Items already told (keeps a re-run or an overlapping check from repeating).
  const told = new Set(Array.isArray(st.toldIds) ? st.toldIds : []);
  const needs = W.newNeeds(callRows, textRows, thu, sinceMs, nowMs, labels, told).filter((n) => !told.has(n.tellId || n.id));
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
  // The 20:00 run closes the day with the "nothing fell through" ledger.
  const ledgerDue = W.etYmd(nowMs) !== st.ledgerYmd && Number(new Date(nowMs).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })) === 20;
  // Old open promises (past 45 days) for the ledger's review line: same
  // (userId, startedAtMs DESC) index as the window query, read only at 20:00.
  // A failed read is carried into the ledger as a warning, never as "clear".
  const OLD_CAP = 300;
  let oldRows = [], oldPromisesFailed = false, oldCapped = false;
  if (ledgerDue) {
    // Calls AND text days (a texted promise past 45 days appeared nowhere, QA
    // 2026-10-13): two reads, each its own failure, same index shape.
    for (const col of ['phone_calls', 'phone_text_days']) {
      try {
        const os = await db.collection(col).where('userId', '==', OWNER).where('startedAtMs', '<', sinceWin).orderBy('startedAtMs', 'desc').limit(OLD_CAP).get();
        oldRows = oldRows.concat(rows(os).filter((c) => W.isOldPromise(c, nowMs)));
        if (os.docs.length >= OLD_CAP) oldCapped = true;
      } catch (e) { oldPromisesFailed = true; logger.warn('[callWatch] old-promise read failed', { col, err: e && e.message }); }
    }
  }
  const ledger = ledgerDue ? W.dailyLedger(callRows, textRows, nowMs, { lastPush: st.lastPush, problems: problems.map((p) => p.key), labels, oldRows, oldPromisesFailed, oldCapped, promisePeople: promiseRead.people, promisesFailed: promiseRead.failed }) : null;
  // Items told before and still open come round again (audit R1), short ladder.
  const retells = W.ladderRetells(callRows, textRows, st.ladder, nowMs, labels, promiseExtras);
  const alert = W.alertFor(needs.concat(retells), tell, nowMs);
  // People owed a promise the ladder has not told yet (no entry, or the set of
  // due tasks / dates changed): ONE push, "N promises due today".
  const promiseFresh = promiseExtras.filter((x) => !W.ladderPrev(st.ladder || {}, x));
  const counts = { needs: needs.length, retold: retells.length, problems: problems.length, told: tell.length, tasksMirrored: mirror, promisesDue: promiseRead.people.length, promisesFresh: promiseFresh.length, promisesCheckFailed: promiseRead.failed };

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

  let pushRes = null;
  if (ledger) {
    await db.collection('notifications').add({
      userId: OWNER, type: 'call_watch', title: ledger.title, message: ledger.message, priority: ledger.priority,
      clickUrl: '/pro/dashboard.html#/calls', read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
    });
    try { await db.doc('integrations/dailyLedger').set(Object.assign({ atMs: nowMs }, ledger, { title: undefined, message: undefined }), { merge: false }); }
    catch (e) { logger.warn('[callWatch] ledger doc skipped', { err: e && e.message }); }
  }
  const problemsToldAt = {};
  problems.forEach((p) => { problemsToldAt[p.key] = (tell.some((t) => t.key === p.key) ? nowMs : W.toMs((st.problemsToldAt || {})[p.key])) || nowMs; });
  const toldIds = needs.map((n) => n.tellId || n.id).concat([...told]).slice(0, 400);
  if (alert) {
    await db.collection('notifications').add({
      userId: OWNER, type: 'call_watch', title: alert.title, message: alert.message, priority: alert.priority,
      clickUrl: alert.clickUrl, read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
    });
    // The last rung is sticky (requireInteraction) so it stays on the lock screen.
    const sticky = retells.some((r) => r.rung >= W.LADDER_MAX);
    try { pushRes = await push(OWNER, alert.title.replace(/^📞 /, ''), alert.push, Object.assign({ type: 'call_watch', clickUrl: alert.clickUrl }, sticky ? { requireInteraction: 'true' } : {})); }
    catch (e) { logger.warn('[callWatch] push failed', { err: e && e.message }); pushRes = { sent: 0, failed: 0, errors: [String(e && e.message)] }; }
  }
  // The promise push (separate from the call alert, its own reached flag): a
  // push that reached 0 devices does NOT count as told - the person gets no
  // ladder entry (or n:0), so the next run tries again.
  let promiseRes = null;
  if (promiseFresh.length) {
    const freshPeople = promiseRead.people.filter((p) => promiseFresh.some((x) => x.key === p.key));
    const pt = PCL.pushText(freshPeople);
    try {
      await db.collection('notifications').add({
        userId: OWNER, type: 'promise_due', title: '📌 ' + pt.title, message: pt.bell, priority: 'high',
        clickUrl: '/pro/dashboard.html#/home', read: false, dismissed: false, createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) { logger.warn('[callWatch] promise bell failed', { err: e && e.message }); }
    try { promiseRes = await push(OWNER, pt.title, pt.body, { type: 'promise_due', clickUrl: '/pro/dashboard.html#/home', notificationId: 'promise-due-' + W.etYmd(nowMs), promiseKeys: freshPeople.map((p) => p.key).join(',').slice(0, 400) }); }
    catch (e) { logger.warn('[callWatch] promise push failed', { err: e && e.message }); promiseRes = { sent: 0, failed: 0, errors: [String(e && e.message)] }; }
  }
  const promiseUnreached = !!(promiseRes && typeof promiseRes === 'object' && promiseRes.sent === 0);
  // Audit R2: the push RESOLVES {sent:0} when no phone is registered or every
  // token failed. Record it, and fail the run after the state is written so
  // the heartbeat pings /fail (Healthchecks emails Jo): the bell is the only
  // thing that told him.
  const pushUnreached = !!(alert && pushRes && typeof pushRes === 'object' && pushRes.sent === 0);
  // Email rung: the third tell of an item still open also emails Jo. A failed
  // send is logged at error (the heartbeat counts it) and recorded; it never
  // blocks the state write below.
  let emailRes = null;
  const mail = W.ladderEmail(retells, nowMs);
  if (mail && typeof email === 'function') {
    try { await email(mail); emailRes = { atMs: nowMs, ok: true, people: mail.people }; }
    catch (e) { emailRes = { atMs: nowMs, ok: false, error: String(e && e.message || e).slice(0, 160) }; logger.error('[callWatch] ladder email failed', { err: e && e.message }); }
  }
  // F2 (audit 2026-10-13): the rung email waits behind a REACHED push, so with a
  // dead token / notifications off it never fired (13 failed attempts, 0
  // emails). On the first run a push reaches nobody, the high-value items it
  // carried go to Jo's own inbox, ONCE per item (unreachedEmailed), through the
  // same helper and recipient as the ladder email.
  const prevEmailed = (st.unreachedEmailed && typeof st.unreachedEmailed === 'object') ? st.unreachedEmailed : {};
  const unreachedEmailed = {};
  Object.keys(prevEmailed).forEach((k) => { if (nowMs - W.toMs(prevEmailed[k]) < 14 * 86400000) unreachedEmailed[k] = prevEmailed[k]; });
  let unreachedRes = null;
  const carried = [];
  if (pushUnreached) needs.concat(retells).forEach((x) => carried.push(x));
  if (promiseUnreached) promiseFresh.forEach((x) => carried.push(x));
  if (carried.length && typeof email === 'function') {
    const rungKeys = new Set((retells || []).filter((r) => r.rung >= W.LADDER_MAX).map((r) => r.key || r.id));
    // Once per item: the id a person was already mailed under (a promise's id
    // carries its signature, so a CHANGED set of due tasks may mail again).
    const idOf = (x) => (x.sig ? x.id + '#' + x.sig : x.id);
    const items = W.highValueItems(carried).filter((x) => !unreachedEmailed[idOf(x)] && !rungKeys.has(x.key || x.id));
    const um = W.unreachedEmail(items, nowMs);
    if (um) {
      try {
        await email(um);
        unreachedRes = { atMs: nowMs, ok: true, people: um.people };
        items.forEach((x) => { unreachedEmailed[idOf(x)] = nowMs; });
      } catch (e) {
        unreachedRes = { atMs: nowMs, ok: false, error: String(e && e.message || e).slice(0, 160) };
        logger.error('[callWatch] unreached-push email failed', { err: e && e.message });
      }
    }
  }
  await stateRef.set({
    lastCheckAtMs: nowMs, lastResult: counts, problems: problems.map((p) => p.key), problemsToldAt, toldIds,
    ledgerYmd: ledger ? ledger.ymd : (st.ledgerYmd || null),
    ladder: W.nextLadder(callRows, textRows, st.ladder, needs.map((n) => n.id), retells, !pushUnreached, nowMs, labels, promiseExtras,
      { ids: new Set(promiseFresh.map((x) => x.id)), reached: !promiseUnreached }),
    lastEmail: emailRes || (st.lastEmail || null),
    unreachedEmailed,
    lastUnreachedEmail: unreachedRes || (st.lastUnreachedEmail || null),
    lastPromisePush: promiseRes ? { atMs: nowMs, sent: promiseRes.sent != null ? Number(promiseRes.sent) : null, people: promiseFresh.length } : (st.lastPromisePush || null),
    promiseCheck: promiseRead.failed ? { failedAtMs: nowMs, error: promiseRead.error || '' } : { okAtMs: nowMs, due: promiseRead.people.length },
    lastPush: alert ? { atMs: nowMs, sent: pushRes && pushRes.sent != null ? Number(pushRes.sent) : null, failed: pushRes && pushRes.failed != null ? Number(pushRes.failed) : null } : (st.lastPush || null),
  }, { merge: false });
  if (pushUnreached || promiseUnreached) throw new Error('callWatch: the alert reached 0 devices (no push token on file, or every token failed) — only the in-app bell was written');
  return Object.assign({ state: alert ? 'alerted' : 'quiet' }, counts);
}

exports.callWatch = onSchedule(
  { schedule: '0 8-20/2 * * *', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '512MiB', maxInstances: 1, secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, RESEND_API_KEY, EMAIL_FROM] },
  async () => {
    try {
      const r = await runWatch({
        db: getFirestore(), nowMs: Date.now(), live: watchEnabled(), texts: recentTexts,
        email: async (m) => {
          const { secretValue } = require('./integrations/_shared');
          const key = secretValue(RESEND_API_KEY);
          if (!key) throw new Error('no-resend-key');
          const user = await getFirestore().doc('users/' + OWNER).get();
          const to = user.exists ? String((user.data() || {}).email || '') : '';
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error('no-owner-email');
          const { Resend } = require('resend');
          const { resendRejected, resendErrorMessage } = require('./resend-guard');
          // Email category: INTERNAL - Jo's own reminder, never a homeowner.
          const resp = await new Resend(key).emails.send({ from: secretValue(EMAIL_FROM) || 'NBD Pro <noreply@nobigdealwithjoedeal.com>', to, subject: m.subject, html: m.html, text: m.text });
          if (resendRejected(resp)) throw new Error('resend: ' + resendErrorMessage(resp));
        },
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

exports._internal = { runWatch, recentTexts, reconcileTaskDone, loadLabels };
