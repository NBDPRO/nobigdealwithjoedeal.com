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
 * and logs counts only. A flag read that FAILS throws (the watch's heartbeat
 * goes red) instead of silently looking like "off".
 *
 * WRITES: the callable writes NOTHING. The watch writes only
 * agent_inbox/msgwatch_<alert>_<day>_t<size> (create-only), one create-only
 * bell per day and one push to the owner. It never sends to a customer and never
 * creates messaging_controls.
 *
 * READS (admin SDK; the rules deny clients most of these): sms_log, email_log,
 * alert_outbox, storm_alerts_sent, missed_call_autotext, public lead stamps,
 * leads.reviewAutoAsk, sms_dnc, sms_opt_outs, email_suppressions, email_queue,
 * agent_inbox, sms_settings, integrations/sms, messaging_controls/{global,automations}.
 * Every range query orders newest-first with a limit, so a busy month drops the
 * OLDEST rows, never the newest; a source that returns exactly its limit is
 * reported as `truncated`. Every source is tried on its own: one that fails shows
 * "unavailable", turns the page's banner red (never a green "nothing to look at")
 * and, in the watch, files a deduped "monitor is blind" report.
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
const LIMITS = Object.freeze({
  sms_log: 1500, email_log: 1000, alert_outbox: 800, storm_alerts_sent: 1500, missed_call_autotext: 500, public_lead_stamps: 200,
  review_asks: 300, sms_dnc: 500, email_suppressions: 300, email_pending: 100, email_failed: 50, agent_inbox: 200,
  lead_lookup: 1500, storm_subscriber_lookup: 1500, sms_opt_outs: 1500,
});

/** Is the master kill-switch code (messaging-controls.js, PR #2572) part of THIS deployment? Swappable in tests. */
const deps = {
  killSwitchDeployed() { try { require.resolve('./messaging-controls'); return true; } catch (_) { return false; } },
};

/** feature_flags/_default merged with the caller's own override. REJECTS if the default doc cannot be read. */
async function flagOn(db, uid) {
  const reads = [db.doc('feature_flags/_default').get()];
  if (uid) reads.push(db.doc('feature_flags/' + uid).get().catch(() => null)); // a denied per-user doc must not hide _default
  const snaps = await Promise.all(reads);
  const merged = Object.assign({}, ...snaps.map((s) => (s && s.exists ? s.data() : {})));
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
  const truncated = {};
  const safe = async (name, fn, fallback) => {
    try { const v = await fn(); if (sources[name] !== 'absent') sources[name] = 'ok'; return v; }
    catch (e) { sources[name] = 'unavailable'; logger.warn('[messagingCenter] source failed', { name, msg: e && e.message }); return fallback; }
  };
  const docs = (name, limit, snap) => {
    if (snap.docs.length >= limit) truncated[name] = true;
    return snap.docs.map((d) => ({ id: d.id, data: d.data() || {} }));
  };

  const [tzDoc, smsRows, emailRows, outboxRows, dncRows, supRows, settings, a2pDoc] = await Promise.all([
    safe('company_profile', async () => { const s = await db.doc('companyProfile/' + tenant).get(); return s.exists ? s.data() : {}; }, {}),
    safe('sms_log', async () => docs('sms_log', LIMITS.sms_log, await db.collection('sms_log').where('companyId', '==', tenant).where('date', '>=', since).orderBy('date', 'desc').limit(LIMITS.sms_log).get()), []),
    safe('email_log', async () => docs('email_log', LIMITS.email_log, await db.collection('email_log').where('companyId', '==', tenant).where('date', '>=', since).orderBy('date', 'desc').limit(LIMITS.email_log).get()), []),
    safe('alert_outbox', async () => docs('alert_outbox', LIMITS.alert_outbox, await db.collection('alert_outbox').where('companyId', '==', tenant).where('createdAt', '>=', since).orderBy('createdAt', 'desc').limit(LIMITS.alert_outbox).get()), []),
    safe('sms_dnc', async () => docs('sms_dnc', LIMITS.sms_dnc, await db.collection('sms_dnc').where('companyId', '==', tenant).orderBy('addedAt', 'desc').limit(LIMITS.sms_dnc).get()), []),
    safe('email_suppressions', async () => docs('email_suppressions', LIMITS.email_suppressions, await db.collection('email_suppressions').where('companyId', '==', tenant).orderBy('createdAt', 'desc').limit(LIMITS.email_suppressions).get()), []),
    safe('sms_settings', async () => { const s = await db.doc('sms_settings/' + tenant).get(); return s.exists ? s.data() : {}; }, null),
    safe('integrations_sms', async () => { const s = await db.doc('integrations/sms').get(); return s.exists ? s.data() : {}; }, null),
  ]);

  // The master kill switch: only meaningful if its code is deployed (otherwise nothing enforces the doc).
  let controls = { state: 'not_deployed' };
  let automationsDoc = { state: 'not_deployed' };
  if (deps.killSwitchDeployed()) {
    controls = await (async () => {
      try { const s = await db.doc('messaging_controls/global').get(); sources.messaging_controls = s.exists ? 'ok' : 'absent'; return s.exists ? { state: 'ok', doc: s.data() || {} } : { state: 'absent' }; }
      catch (e) { sources.messaging_controls = 'unreadable'; return { state: 'unreadable' }; }
    })();
    automationsDoc = await (async () => {
      try { const s = await db.doc('messaging_controls/automations').get(); return s.exists ? { state: 'ok', doc: s.data() || {} } : { state: 'absent' }; }
      catch (e) { return { state: 'unreadable' }; }
    })();
  } else sources.messaging_controls = 'not deployed';

  // NBD-only ledgers: the storm list, missed-call claims, the public lead forms, the platform email queue.
  let stormRows = [], missedRows = [], stampRows = [], reviewRows = [], queueDocs = [];
  if (isNbd) {
    [stormRows, missedRows, stampRows, reviewRows, queueDocs] = await Promise.all([
      safe('storm_alerts_sent', async () => docs('storm_alerts_sent', LIMITS.storm_alerts_sent, await db.collection('storm_alerts_sent').where('sentAt', '>=', since).orderBy('sentAt', 'desc').limit(LIMITS.storm_alerts_sent).get()), []),
      safe('missed_call_autotext', async () => docs('missed_call_autotext', LIMITS.missed_call_autotext, await db.collection('missed_call_autotext').where('companyId', '==', tenant).where('lastSentAtMs', '>=', sinceMs).orderBy('lastSentAtMs', 'desc').limit(LIMITS.missed_call_autotext).get()), []),
      safe('public_lead_stamps', async () => {
        const out = [];
        for (const c of LEAD_COLLECTIONS) {
          for (const f of ['ackEmailSentAt', 'ackSmsSentAt', 'followUpEmailSentAt']) {
            const s = await db.collection(c).where(f, '>=', since).orderBy(f, 'desc').limit(LIMITS.public_lead_stamps).get();
            if (s.docs.length >= LIMITS.public_lead_stamps) truncated.public_lead_stamps = true;
            s.docs.forEach((d) => out.push({ collection: c, id: d.id, data: d.data() || {} }));
          }
        }
        return out;
      }, []),
      safe('review_asks', async () => {
        // A tenant's leads carry companyId, or only userId for a solo owner: ask both, newest first.
        const seen = {};
        const out = [];
        for (const f of ['companyId', 'userId']) {
          const s = await db.collection('leads').where(f, '==', tenant).where('reviewRequestedAt', '>=', since).orderBy('reviewRequestedAt', 'desc').limit(LIMITS.review_asks).get();
          if (s.docs.length >= LIMITS.review_asks) truncated.review_asks = true;
          s.docs.forEach((d) => { if (!seen[d.id]) { seen[d.id] = 1; out.push({ id: d.id, data: d.data() || {} }); } });
        }
        return out;
      }, []),
      safe('email_queue', async () => {
        const [p, f] = await Promise.all([
          db.collection('email_queue').where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(LIMITS.email_pending).get(),
          db.collection('email_queue').where('status', '==', 'failed').orderBy('createdAt', 'asc').limit(LIMITS.email_failed).get(),
        ]);
        return docs('email_queue', LIMITS.email_pending, p).concat(docs('email_queue', LIMITS.email_failed, f));
      }, []),
    ]);
  }
  const inboxRows = await safe('agent_inbox', async () => docs('agent_inbox', LIMITS.agent_inbox, await db.collection('agent_inbox').where('companyId', '==', tenant).where('status', '==', 'pending').orderBy('createdAt', 'asc').limit(LIMITS.agent_inbox).get()), []);

  // Lookups: leads (name, consent, state) for the log rows, subscribers for storm claims.
  const leadIdAll = Array.from(new Set(smsRows.concat(emailRows).map((r) => r.data.leadId).filter(Boolean).concat(missedRows.map((r) => r.data.leadId).filter(Boolean))));
  if (leadIdAll.length > LIMITS.lead_lookup) truncated.lead_lookup = true;
  const leadIds = leadIdAll.slice(0, LIMITS.lead_lookup);
  const leadMap = {};
  await safe('lead_lookup', async () => {
    (await getAllChunked(db, leadIds.map((id) => db.doc('leads/' + id)))).forEach((s) => { if (s.exists) leadMap[s.id] = s.data() || {}; });
  }, null);
  const subIdAll = Array.from(new Set(stormRows.map((r) => r.data.subscriberId).filter(Boolean)));
  if (subIdAll.length > LIMITS.storm_subscriber_lookup) truncated.storm_subscriber_lookup = true;
  const subIds = subIdAll.slice(0, LIMITS.storm_subscriber_lookup);
  const subMap = {};
  if (isNbd) {
    await safe('storm_subscriber_lookup', async () => {
      (await getAllChunked(db, subIds.map((id) => db.doc('storm_alert_subscribers/' + id)))).forEach((s) => { if (s.exists) subMap[s.id] = s.data() || {}; });
    }, null);
  }

  const events = [];
  smsRows.forEach((r) => { const e = L.fromSmsLog(r.id, r.data, leadMap[r.data.leadId]); if (e) events.push(e); });
  emailRows.forEach((r) => { const e = L.fromEmailLog(r.id, r.data, leadMap[r.data.leadId]); if (e) events.push(e); });
  outboxRows.forEach((r) => L.fromAlertOutbox(r.id, r.data).forEach((e) => events.push(e)));
  stormRows.forEach((r) => { const e = L.fromStormClaim(r.id, r.data, subMap[r.data.subscriberId]); if (e) events.push(e); });
  missedRows.forEach((r) => { const e = L.fromMissedCallClaim(r.id, r.data, leadMap[r.data.leadId]); if (e && e.atMs >= sinceMs) events.push(e); });
  stampRows.forEach((r) => L.fromLeadStamps(r.collection, r.id, r.data).forEach((e) => { if (e.atMs >= sinceMs) events.push(e); }));
  reviewRows.forEach((r) => { const e = L.fromReviewAsk(r.id, r.data); if (e && e.atMs >= sinceMs) events.push(e); });

  // STOP register: the company's own DNC plus the global register for every recent recipient.
  const optOutAtMs = {};
  const optRows = [];
  dncRows.forEach((r) => {
    const k = L.phoneKey(r.data.key || r.data.phone);
    const t = L.toMs(r.data.addedAt);
    if (!k || r.data.lifted === true) return;
    if (t) optOutAtMs[k] = Math.min(optOutAtMs[k] || t, t);
    if (r.data.source === 'stop_reply') optRows.push({ addedAt: r.data.addedAt, phone: r.data.phone, key: r.data.key, source: 'stop_reply' });
  });
  const recipAll = Array.from(new Set(events.filter((e) => e.channel === 'sms' && e.toKey && !e.internal).map((e) => e.toKey)));
  if (recipAll.length > LIMITS.sms_opt_outs) truncated.sms_opt_outs = true;
  const recipKeys = recipAll.slice(0, LIMITS.sms_opt_outs);
  await safe('sms_opt_outs', async () => {
    (await getAllChunked(db, recipKeys.map((k) => db.doc('sms_opt_outs/' + k)))).forEach((s) => {
      if (!s.exists) return;
      const d = s.data() || {};
      const t = L.toMs(d.optedOutAt);
      if (t) optOutAtMs[s.id] = Math.min(optOutAtMs[s.id] || t, t);
      // The register is global; only numbers THIS tenant texted are listed here.
      if (!optRows.some((x) => L.phoneKey(x.key || x.phone) === s.id)) optRows.push({ addedAt: d.optedOutAt, phone: d.phone || s.id, key: s.id, source: String(d.source || d.keyword || 'register') });
    });
  }, null);

  const bounces = supRows.filter((r) => /bounce|complaint/.test(String(r.data.source || ''))).map((r) => ({ id: r.id.slice(-8), reason: /complaint/.test(r.data.source) ? 'complaint' : 'bounce', atMs: L.toMs(r.data.createdAt) }));

  const queueItems = queueDocs.map((r) => ({ queue: 'email_queue', status: String(r.data.status || 'pending'), atMs: r.data.createdAt, label: r.data.subject || r.data.template || 'email', attempts: r.data.attempts || 0 }))
    .concat(inboxRows.filter((r) => /^draft_/.test(String(r.data.kind || ''))).map((r) => ({ queue: 'agent_inbox', status: 'pending', atMs: r.data.createdAt, label: r.data.title || r.data.kind })));

  // Flags per automation: reuse the registry readout (read-only, no secrets).
  let flagRows = [];
  try { flagRows = require('./flags-registry').buildResponse(process.env, null, { nowMs }).flags || []; } catch (_) { sources.flags = 'unavailable'; }

  return {
    events, sources, truncated, flagRows, controls, automationsDoc, optOutAtMs, bounces,
    tz: (tzDoc && tzDoc.timezone) || L.DEFAULT_TZ,
    texting: settings ? { enabled: settings.enabled !== false, registered: isNbd || settings.registered === true } : { enabled: null, registered: null },
    a2pRegistered: a2pDoc ? a2pDoc.a2pApproved === true : null,
    optOuts: L.optOutRows(optRows, 10),
    queues: L.queueRows(queueItems, nowMs),
    isNbd,
  };
}

async function overview(db, tenant, nowMs) {
  const g = await gather(db, { tenant, nowMs });
  const o = L.buildOverview({
    nowMs, tz: g.tz, events: g.events, flagRows: g.flagRows, controls: g.controls, automationsDoc: g.automationsDoc, texting: g.texting,
    a2pRegistered: g.a2pRegistered, optOutAtMs: g.optOutAtMs, optOuts: g.optOuts, queues: g.queues, bounces: g.bounces, sources: g.sources, truncated: g.truncated,
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

/** Which alerts are new (create-only inbox doc, one per kind/day/size) and who to tell. Returns counts. */
async function runWatch({ db, nowMs, live, push }) {
  const g = await gather(db, { tenant: OWNER, nowMs });
  const blind = L.CRITICAL_SOURCES.filter((k) => g.sources[k] === 'unavailable');
  const ctx = { tz: g.tz, optOutAtMs: g.optOutAtMs, bounces: g.bounces, blind };
  const alerts = L.evaluateAlerts(g.events, nowMs, L.THRESHOLDS, ctx);
  const out = { alerts: alerts.length, filed: 0, alreadyFiled: 0, pushed: 0, failed: 0, blind: blind.length };
  if (!alerts.length || !live) return out;
  const day = L.ymdIn(nowMs, g.tz);
  let pushedToday = 0;
  try { const s = await db.doc('notifications/msgwatch_' + day).get(); pushedToday = s.exists ? Number((s.data() || {}).pushes || 0) : 0; } catch (_) { /* unknown: allow, the inbox dedupe still holds */ }
  let newPushes = 0;
  for (const a of alerts) {
    const id = L.alertKey(a, nowMs, g.tz);
    try {
      await db.doc('agent_inbox/' + id).create({
        companyId: OWNER, bot: 'Messaging watch', botId: 'msg-watch', status: 'pending', verified: false, createdAt: FieldValue.serverTimestamp(), keyId: 'msg-watch',
        kind: 'report', leadId: null, title: a.title.slice(0, 140), text: a.detail + ' Open Messaging in the CRM for the masked rows.', dueDate: null,
      });
      out.filed++;
      // Pushing is capped per day; FILING never is.
      if (push && pushedToday + newPushes < L.THRESHOLDS.pushMaxPerDay) {
        try { await push(OWNER, '⚠️ Messaging: ' + a.title.slice(0, 90), 'Open the Messaging view or your Agent inbox.', { link: '#/messaging', type: 'messaging_watch' }); out.pushed++; newPushes++; }
        catch (e) { logger.warn('[messagingWatch] push failed', { msg: e && e.message }); }
      }
    } catch (e) {
      if (isAlreadyExists(e)) out.alreadyFiled++;
      else { out.failed++; logger.warn('[messagingWatch] write failed', { msg: e && e.message }); }
    }
  }
  // The bell is its own idempotent write (create-only per day), independent of whether a report was new this run.
  try {
    await db.doc('notifications/msgwatch_' + day).create({
      userId: OWNER, companyId: OWNER, type: 'agent_inbox', priority: 'high', pushes: newPushes,
      title: '⚠️ Messaging alert' + (alerts.length === 1 ? '' : 's') + ' need a look',
      message: 'Check your Agent inbox, or the Messaging view.', read: false, dismissed: false,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (isAlreadyExists(e)) { if (newPushes) await db.doc('notifications/msgwatch_' + day).set({ pushes: pushedToday + newPushes, updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {}); }
    else logger.warn('[messagingWatch] bell failed', { msg: e && e.message });
  }
  return out;
}

exports.messagingWatch = onSchedule(
  { schedule: '5 * * * *', timeZone: 'America/New_York', maxInstances: 1, timeoutSeconds: 120, memory: '512MiB' },
  async () => {
    const db = getFirestore();
    // A flag read that fails must NOT look like "off": throw so the heartbeat reports /fail.
    const live = await flagOn(db, OWNER).catch((e) => { logger.error('messaging_watch_flag_unreadable', { msg: e && e.message }); throw new Error('messagingWatch: could not read the messagingControlCenter flag'); });
    const r = await runWatch({
      db, nowMs: Date.now(), live,
      push: (uid, title, body, data) => require('./push-functions').sendCustomNotification(uid, title, body, Object.assign({ notificationId: 'msgwatch-' + Date.now() }, data)),
    });
    logger.info(live ? 'messaging_watch_run' : 'messaging_watch_dry_run', r);
  }
);

exports._internal = { gather, overview, runWatch, flagOn, FLAG, deps, LIMITS };
