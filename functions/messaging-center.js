'use strict';
/**
 * messaging-center.js (2026-10-19): the READ-ONLY Messaging Control Center.
 *
 *   messagingCenter (onCall, App Check) -> one masked, tenant-scoped overview of
 *       what the CRM has sent, why, what was refused and what needs a look.
 *   messagingWatch  (every hour)         -> the same thresholds, filed as ONE
 *       Agent-inbox report + a bell + a push to the OWNER per alert per day.
 *
 * Both are DARK behind the Firestore flag `messagingControlCenter`
 * (feature_flags/_default or feature_flags/{uid}; absent = off). Off: the
 * callable answers { enabled: false } and reads nothing; the watch computes
 * and logs counts only.
 *
 * WRITES: the callable writes NOTHING. The watch writes only
 * agent_inbox/msgwatch_<alert>_<day> (create-only), one bell and one push to
 * the owner. It never sends to a customer, never creates messaging_controls.
 *
 * READS (all through the admin SDK because the rules deny clients most of
 * these collections): sms_log, email_log, alert_outbox, storm_alerts_sent,
 * missed_call_autotext, public lead stamps, sms_dnc, sms_opt_outs,
 * email_suppressions, email_queue, agent_inbox, sms_settings, integrations/sms,
 * messaging_controls/global (only if another session has created it).
 * Every source is tried on its own; one that fails shows "unavailable" in
 * Coverage instead of blanking the page.
 *
 * Pure logic, masking and thresholds: messaging-center-logic.js.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { callableRateLimit } = require('./shared');
const { CORS_ORIGINS } = require('./handlers/_shared');
const L = require('./messaging-center-logic');

const FLAG = 'messagingControlCenter';
const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const LEAD_COLLECTIONS = ['contact_leads', 'estimate_leads', 'inspect_leads', 'free_roof_entries'];
const WINDOW_DAYS = 30;

/** feature_flags/_default merged with the caller's own override. */
async function flagOn(db, uid) {
  const reads = [db.doc('feature_flags/_default').get()];
  if (uid) reads.push(db.doc('feature_flags/' + uid).get());
  const snaps = await Promise.all(reads);
  const merged = Object.assign({}, ...snaps.map((s) => (s.exists ? s.data() : {})));
  return merged[FLAG] === true;
}

async function getAllChunked(db, refs) {
  const out = [];
  for (let i = 0; i < refs.length; i += 100) {
    const snaps = await db.getAll(...refs.slice(i, i + 100));
    snaps.forEach((s) => out.push(s));
  }
  return out;
}

/** Read every ledger for one tenant and turn rows into events. */
async function gather(db, opts) {
  const { tenant, nowMs } = opts;
  const isNbd = tenant === OWNER;
  const since = new Date(nowMs - WINDOW_DAYS * L.DAY);
  const sinceMs = nowMs - WINDOW_DAYS * L.DAY;
  const sources = {};
  const safe = async (name, fn, fallback) => {
    try { const v = await fn(); sources[name] = 'ok'; return v; }
    catch (e) { sources[name] = 'unavailable'; logger.warn('[messagingCenter] source failed', { name, msg: e && e.message }); return fallback; }
  };
  const docs = (snap) => snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));

  const [tzDoc, smsRows, emailRows, outboxRows, dncRows, supRows, settings, a2pDoc, controlsDoc] = await Promise.all([
    safe('company_profile', async () => { const s = await db.doc('companyProfile/' + tenant).get(); return s.exists ? s.data() : {}; }, {}),
    safe('sms_log', async () => docs(await db.collection('sms_log').where('companyId', '==', tenant).where('date', '>=', since).orderBy('date', 'desc').limit(1500).get()), []),
    safe('email_log', async () => docs(await db.collection('email_log').where('companyId', '==', tenant).where('date', '>=', since).orderBy('date', 'desc').limit(1000).get()), []),
    safe('alert_outbox', async () => docs(await db.collection('alert_outbox').where('companyId', '==', tenant).where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(800).get()), []),
    safe('sms_dnc', async () => docs(await db.collection('sms_dnc').where('companyId', '==', tenant).limit(500).get()), []),
    safe('email_suppressions', async () => docs(await db.collection('email_suppressions').where('companyId', '==', tenant).limit(300).get()), []),
    safe('sms_settings', async () => { const s = await db.doc('sms_settings/' + tenant).get(); return s.exists ? s.data() : {}; }, null),
    safe('integrations_sms', async () => { const s = await db.doc('integrations/sms').get(); return s.exists ? s.data() : {}; }, null),
    safe('messaging_controls', async () => { const s = await db.doc('messaging_controls/global').get(); return s.exists ? s.data() : null; }, null),
  ]);
  if (sources.messaging_controls === 'ok' && !controlsDoc) sources.messaging_controls = 'absent';

  // NBD-only ledgers: the storm list, missed-call claims, the public lead forms, the platform email queue.
  let stormRows = [], missedRows = [], stampRows = [], reviewRows = [], queueDocs = [];
  if (isNbd) {
    [stormRows, missedRows, stampRows, reviewRows, queueDocs] = await Promise.all([
      safe('storm_alerts_sent', async () => docs(await db.collection('storm_alerts_sent').where('sentAt', '>=', since).limit(1000).get()), []),
      safe('missed_call_autotext', async () => docs(await db.collection('missed_call_autotext').where('companyId', '==', tenant).limit(500).get()), []),
      safe('public_lead_stamps', async () => {
        const out = [];
        for (const c of LEAD_COLLECTIONS) {
          for (const f of ['ackEmailSentAt', 'ackSmsSentAt', 'followUpEmailSentAt']) {
            const s = await db.collection(c).where(f, '>=', since).limit(200).get();
            s.docs.forEach((d) => out.push({ collection: c, id: d.id, data: d.data() || {} }));
          }
        }
        return out;
      }, []),
      safe('review_asks', async () => docs(await db.collection('leads').where('reviewRequestedAt', '>=', since).limit(300).get()), []),
      safe('email_queue', async () => {
        const [p, f] = await Promise.all([
          db.collection('email_queue').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(100).get(),
          db.collection('email_queue').where('status', '==', 'failed').limit(50).get(),
        ]);
        return docs(p).concat(docs(f));
      }, []),
    ]);
  }
  const inboxRows = await safe('agent_inbox', async () => docs(await db.collection('agent_inbox').where('companyId', '==', tenant).where('status', '==', 'pending').limit(200).get()), []);

  // Lookups: leads (name, consent, state) for the log rows, subscribers for storm claims, global opt-outs.
  const leadIds = Array.from(new Set(smsRows.concat(emailRows).map((r) => r.data.leadId).filter(Boolean).concat(missedRows.map((r) => r.data.leadId).filter(Boolean)))).slice(0, 400);
  const leadMap = {};
  await safe('lead_lookup', async () => {
    (await getAllChunked(db, leadIds.map((id) => db.doc('leads/' + id)))).forEach((s) => { if (s.exists) leadMap[s.id] = s.data() || {}; });
  }, null);
  const subIds = Array.from(new Set(stormRows.map((r) => r.data.subscriberId).filter(Boolean))).slice(0, 600);
  const subMap = {};
  await safe('subscriber_lookup', async () => {
    (await getAllChunked(db, subIds.map((id) => db.doc('storm_alert_subscribers/' + id)))).forEach((s) => { if (s.exists) subMap[s.id] = s.data() || {}; });
  }, null);

  const events = [];
  smsRows.forEach((r) => { const e = L.fromSmsLog(r.id, r.data, leadMap[r.data.leadId]); if (e) events.push(e); });
  emailRows.forEach((r) => { const e = L.fromEmailLog(r.id, r.data, leadMap[r.data.leadId]); if (e) events.push(e); });
  outboxRows.forEach((r) => L.fromAlertOutbox(r.id, r.data).forEach((e) => events.push(e)));
  stormRows.forEach((r) => { const e = L.fromStormClaim(r.id, r.data, subMap[r.data.subscriberId]); if (e) events.push(e); });
  missedRows.forEach((r) => { const e = L.fromMissedCallClaim(r.id, r.data, leadMap[r.data.leadId]); if (e && e.atMs >= sinceMs) events.push(e); });
  stampRows.forEach((r) => L.fromLeadStamps(r.collection, r.id, r.data).forEach((e) => { if (e.atMs >= sinceMs) events.push(e); }));
  reviewRows.forEach((r) => {
    const own = String(r.data.companyId || r.data.userId || '');
    if (own !== tenant) return;
    const e = L.fromReviewAsk(r.id, r.data);
    if (e && e.atMs >= sinceMs) events.push(e);
  });

  // STOP register: every opted-out number among recent recipients, plus the company's own DNC.
  const optOutAtMs = {};
  dncRows.forEach((r) => { const k = L.phoneKey(r.data.key || r.data.phone); const t = L.toMs(r.data.addedAt); if (k && t && r.data.lifted !== true && !r.data.liftedAt) optOutAtMs[k] = Math.min(optOutAtMs[k] || t, t); });
  const recipKeys = Array.from(new Set(events.filter((e) => e.channel === 'sms' && e.toKey && !e.internal).map((e) => e.toKey))).slice(0, 400);
  await safe('sms_opt_outs', async () => {
    (await getAllChunked(db, recipKeys.map((k) => db.doc('sms_opt_outs/' + k)))).forEach((s) => {
      if (!s.exists) return;
      const t = L.toMs((s.data() || {}).optedOutAt);
      if (t) optOutAtMs[s.id] = Math.min(optOutAtMs[s.id] || t, t);
    });
  }, null);

  const stops = dncRows.filter((r) => r.data.source === 'stop_reply').map((r) => ({ addedAt: r.data.addedAt, phone: r.data.phone, key: r.data.key, source: 'stop_reply' }));
  const bounces = supRows.filter((r) => /bounce|complaint/.test(String(r.data.source || ''))).map((r) => ({ id: r.id.slice(-8), reason: /complaint/.test(r.data.source) ? 'complaint' : 'bounce', atMs: L.toMs(r.data.createdAt) }));

  const queueItems = queueDocs.map((r) => ({ queue: 'email_queue', status: String(r.data.status || 'pending'), atMs: r.data.createdAt, label: r.data.subject || r.data.template || 'email', attempts: r.data.attempts || 0 }))
    .concat(inboxRows.filter((r) => /^draft_/.test(String(r.data.kind || ''))).map((r) => ({ queue: 'agent_inbox', status: 'pending', atMs: r.data.createdAt, label: r.data.title || r.data.kind })));

  // Flags per automation: reuse the registry readout (read-only, no secrets).
  let flagRows = [];
  try { flagRows = require('./flags-registry').buildResponse(process.env, null, { nowMs }).flags || []; } catch (_) { sources.flags = 'unavailable'; }

  return {
    events, sources, flagRows, controls: controlsDoc, optOutAtMs, bounces,
    tz: (tzDoc && tzDoc.timezone) || L.DEFAULT_TZ,
    texting: settings ? { enabled: settings.enabled !== false, registered: isNbd || settings.registered === true } : { enabled: null, registered: null },
    a2pRegistered: a2pDoc ? a2pDoc.a2pApproved === true : null,
    optOuts: L.optOutRows(stops, 10),
    queues: L.queueRows(queueItems, nowMs),
    isNbd,
  };
}

async function overview(db, tenant, nowMs) {
  const g = await gather(db, { tenant, nowMs });
  const o = L.buildOverview({
    nowMs, tz: g.tz, events: g.events, flagRows: g.flagRows, controls: g.controls, texting: g.texting,
    a2pRegistered: g.a2pRegistered, optOutAtMs: g.optOutAtMs, optOuts: g.optOuts, queues: g.queues, bounces: g.bounces, sources: g.sources,
  });
  o.enabled = true;
  o.tenantIsNbd = g.isNbd;
  return o;
}

exports.messagingCenter = onCall(
  { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 60, memory: '512MiB' },
  async (request) => {
    if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const token = request.auth.token || {};
    if (!L.canView(token, request.auth.uid, OWNER)) throw new HttpsError('permission-denied', 'Owner or admin access required');
    await callableRateLimit(request, 'messagingCenter', 30, 60_000);
    const db = getFirestore();
    if (!(await flagOn(db, request.auth.uid))) return { enabled: false };
    const tenant = String(token.companyId || request.auth.uid);
    return overview(db, tenant, Date.now());
  }
);

// ── the hourly watch ──────────────────────────────────────────────────────
const isAlreadyExists = (e) => !!e && (e.code === 6 || /already exists/i.test(String(e.message || '')));

/** Which alerts are new today (create-only inbox doc) and who to tell. Returns counts. */
async function runWatch({ db, nowMs, live, push }) {
  const g = await gather(db, { tenant: OWNER, nowMs });
  const ctx = { tz: g.tz, optOutAtMs: g.optOutAtMs, bounces: g.bounces };
  const alerts = L.evaluateAlerts(g.events, nowMs, L.THRESHOLDS, ctx);
  const out = { alerts: alerts.length, filed: 0, alreadyFiled: 0, pushed: 0, failed: 0 };
  if (!alerts.length || !live) return out;
  const day = L.ymdIn(nowMs, g.tz);
  let pushedToday = 0;
  try { const s = await db.doc('notifications/msgwatch_' + day).get(); pushedToday = s.exists ? Number((s.data() || {}).count || 0) : 0; } catch (_) { /* unknown: allow, the inbox dedupe still holds */ }
  for (const a of alerts) {
    const id = L.alertKey(a, nowMs, g.tz);
    try {
      await db.doc('agent_inbox/' + id).create({
        companyId: OWNER, bot: 'Messaging watch', botId: 'msg-watch', status: 'pending', verified: false, createdAt: FieldValue.serverTimestamp(), keyId: 'msg-watch',
        kind: 'report', leadId: null, title: a.title.slice(0, 140), text: a.detail + ' Open Messaging in the CRM for the masked rows.', dueDate: null,
      });
      out.filed++;
      if (push && pushedToday < L.THRESHOLDS.pushMaxPerDay) {
        try { await push(OWNER, '⚠️ Messaging: ' + a.title.slice(0, 90), 'Open the Messaging view or your Agent inbox.', { link: '#/messaging', type: 'messaging_watch' }); out.pushed++; pushedToday++; }
        catch (e) { logger.warn('[messagingWatch] push failed', { msg: e && e.message }); }
      }
    } catch (e) {
      if (isAlreadyExists(e)) out.alreadyFiled++;
      else { out.failed++; logger.warn('[messagingWatch] write failed', { msg: e && e.message }); }
    }
  }
  if (out.filed) {
    await db.doc('notifications/msgwatch_' + day).set({
      userId: OWNER, companyId: OWNER, type: 'agent_inbox', priority: 'high', count: pushedToday,
      title: '⚠️ ' + out.filed + (out.filed === 1 ? ' messaging alert' : ' messaging alerts'),
      message: 'Check your Agent inbox, or the Messaging view.', read: false, dismissed: false,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true }).catch((e) => logger.warn('[messagingWatch] bell failed', { msg: e && e.message }));
  }
  return out;
}

exports.messagingWatch = onSchedule(
  { schedule: '5 * * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 120, memory: '512MiB' },
  async () => {
    const db = getFirestore();
    const live = await flagOn(db, OWNER).catch(() => false);
    const r = await runWatch({
      db, nowMs: Date.now(), live,
      push: (uid, title, body, data) => require('./push-functions').sendCustomNotification(uid, title, body, Object.assign({ notificationId: 'msgwatch-' + Date.now() }, data)),
    });
    logger.info(live ? 'messaging_watch_run' : 'messaging_watch_dry_run', r);
  }
);

exports._internal = { gather, overview, runWatch, flagOn, FLAG };
