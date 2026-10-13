'use strict';
/**
 * pipeline-health.js — callPipelineHealth (2026-10-12 reliability audit): the
 * one-glance "is the never-forget chain alive" snapshot for the Call Center.
 * Owner / platform admin only (integrations/* is not client-readable, so the
 * screen reads it through this callable). Read-only.
 *
 * healthRows() is pure: status docs in, rows out. Statuses: ok | warn | bad.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const W = require('./call-watch-logic');
const DM = require('./pipeline-deadman');

const MIN = 60000, HOUR = 3600000;
const OWNER = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const worst = (a, b) => (a === 'bad' || b === 'bad' ? 'bad' : (a === 'warn' || b === 'warn' ? 'warn' : 'ok'));
const ago = (ms, now) => {
  if (!ms) return 'never';
  const m = Math.round((now - ms) / MIN);
  return m < 90 ? m + ' min ago' : (m < 60 * 36 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' days ago');
};

/**
 * i: { watch, cc, health, ledger, newestCallMs, waiting, tokens, now, gates }
 * (any doc may be null). Returns { overall, rows:[{key,label,status,detail}] }.
 */
function healthRows(i) {
  const now = i.now, g = i.gates || {}, cc = i.cc || {}, watch = i.watch || {}, health = i.health || {}, ledger = i.ledger || null;
  const rows = [];
  const job = (key, label, last, on) => {
    if (!on) return rows.push({ key, label, status: 'warn', detail: 'switched off in this deployment' });
    if (cc.paused) return rows.push({ key, label, status: 'warn', detail: 'paused' });
    const age = last ? now - last : Infinity;
    rows.push({ key, label, status: age <= 75 * MIN ? 'ok' : (age <= DM.JOB_STALE_MS ? 'warn' : 'bad'), detail: 'last run ' + ago(last, now) + ' (every 30 min)' });
  };
  job('copy', 'Recordings copied from Drive', W.toMs(cc.lastRunAtMs), g.ingest);
  job('transcribe', 'Transcripts + notes', W.toMs(cc.lastTranscribeAtMs), g.transcribe);

  const slot = DM.expectedWatchSlotMs(now);
  const lastWatch = W.toMs(watch.lastCheckAtMs);
  const watchLate = slot != null && lastWatch < slot - 2 * MIN;
  rows.push({
    key: 'callwatch', label: '2-hour call check', status: !g.watch ? 'warn' : (watchLate ? 'bad' : 'ok'),
    detail: (g.watch ? 'last check ' + ago(lastWatch, now) : 'switched off') +
      (watchLate ? ' — the ' + new Date(slot).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }) + ' check is overdue' : ' (08:00–20:00 ET, every 2 h)'),
  });

  const newest = Number(i.newestCallMs) || 0;
  const nAge = newest ? now - newest : Infinity;
  rows.push({
    key: 'recordings', label: 'New recordings arriving',
    status: !newest ? 'warn' : (nAge <= 24 * HOUR ? 'ok' : (nAge <= DM.SILENT_RECORDINGS_MS ? 'warn' : 'bad')),
    detail: newest ? 'newest recording ' + ago(newest, now) : 'no recordings on file',
  });

  const sent = watch.lastPush && watch.lastPush.sent;
  const tokens = Number(i.tokens);
  const pushBad = tokens === 0 || sent === 0;
  rows.push({
    key: 'push', label: 'Alerts reach your phone',
    status: pushBad ? 'bad' : (Number.isFinite(tokens) && sent != null ? 'ok' : 'warn'),
    detail: (Number.isFinite(tokens) ? tokens + ' device' + (tokens === 1 ? '' : 's') + ' registered' : 'devices unknown') +
      (watch.lastPush ? '; last alert reached ' + (sent == null ? '?' : sent) : '; no alert sent yet'),
  });

  const waiting = Number(i.waiting) || 0;
  rows.push({ key: 'waiting', label: 'Recordings waiting for a transcript', status: waiting === 0 ? 'ok' : (waiting <= 5 ? 'warn' : 'bad'), detail: waiting + ' waiting' });

  rows.push({
    key: 'ledger', label: 'Day check (8 PM)', status: ledger && ledger.clear ? 'ok' : 'warn',
    detail: ledger ? ledger.ymd + ': ' + (ledger.open || 0) + ' open, ' + ((ledger.anomalies || []).length) + ' warning(s)' : 'not written yet',
  });

  const probs = Array.isArray(health.problems) ? health.problems : [];
  rows.push({
    key: 'deadman', label: 'Safety net (dead-man)', status: probs.length ? 'bad' : 'ok',
    detail: probs.length ? probs.join(', ') : 'nothing stopped' + (health.checkedAtMs ? ' (checked ' + ago(W.toMs(health.checkedAtMs), now) + ')' : ''),
  });

  const overall = rows.reduce((o, r) => worst(o, r.status), 'ok');
  return { overall, rows };
}

async function snapshot({ db, nowMs, env }) {
  const gates = DM.gatesFromEnv(env || process.env);
  const paths = ['integrations/callWatch', 'integrations/callCenter', 'integrations/pipelineHealth', 'integrations/dailyLedger'];
  const [watch, cc, health, ledger] = await Promise.all(paths.map((p) => db.doc(p).get()));
  let newestCallMs = 0, waiting = 0, tokens = NaN;
  try {
    const q = await db.collection('phone_calls').where('userId', '==', OWNER).orderBy('startedAtMs', 'desc').limit(1).get();
    newestCallMs = q.docs.length ? W.toMs(q.docs[0].data().startedAtMs) : 0;
  } catch (_) { /* the row says "no recordings on file" */ }
  try { waiting = (await db.collection('phone_calls').where('userId', '==', OWNER).where('status', '==', 'stored').limit(200).get()).size; } catch (_) { /* 0 */ }
  try { tokens = (await db.collection('users').doc(OWNER).collection('fcmTokens').get()).size; } catch (_) { /* unknown */ }
  const out = healthRows({
    watch: watch.exists ? watch.data() : null, cc: cc.exists ? cc.data() : null, health: health.exists ? health.data() : null,
    ledger: ledger.exists ? ledger.data() : null, newestCallMs, waiting, tokens, now: nowMs, gates,
  });
  return Object.assign({ atMs: nowMs }, out);
}

async function handle({ auth, db, nowMs }) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const role = String((auth.token || {}).role || '');
  if (!(auth.uid === OWNER || role === 'admin')) throw new HttpsError('permission-denied', 'This panel is the owner’s.');
  return snapshot({ db, nowMs });
}

exports.callPipelineHealth = onCall(
  { region: 'us-central1', enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 30, maxInstances: 3 },
  (request) => handle({ auth: request.auth, db: getFirestore(), nowMs: Date.now() })
);
exports._internal = { healthRows, snapshot, handle };
