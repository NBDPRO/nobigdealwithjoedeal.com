'use strict';
/**
 * pipeline-deadman.js — the watcher of the watcher (2026-10-12 reliability
 * audit, documentation/audit/NEVER-FORGET-RELIABILITY-AUDIT-2026-10-12.md R3/R4).
 *
 * WHY: callWatch is the ONLY thing that notices the call pipeline going stale
 * (ingest / transcribe / transcripts waiting). Nothing independent noticed
 * callWatch itself stopping: its heartbeat shares the `call-followups` check
 * with callCenterSweep (07:15 / 15:15 pings keep a 12 h check green), and a
 * callWatch whose gate is off returns a dry-run and still pings success. And
 * callCenterIngest / Transcribe swallow their own failures (logger.warn), so
 * the `calls-texts-ingest` check — fed every 10 min by leadAlertWatchdog —
 * never reddens for them either.
 *
 * WHAT: leadAlertWatchdog (every 10 min, 24/7, on a different schedule from
 * callWatch) calls run() after its own work. run() reads the status docs the
 * jobs already write (integrations/callWatch.lastCheckAtMs,
 * integrations/callCenter.lastRunAtMs / lastTranscribeAtMs) and decides, with
 * pure rules, whether the 2-hourly check or the copy/transcribe jobs stopped.
 * A standing problem is told at most every 6 h (bell + push, 08–20 ET only),
 * recorded on integrations/pipelineHealth, and returned so the caller can
 * throw — the heartbeat then pings /fail and Healthchecks.io emails Jo over a
 * path that does not depend on our push or Firestore at all.
 *
 * Reads and one bell/push to Jo only. Never texts or emails anyone.
 */
const W = require('./call-watch-logic');

const HOUR = 3600000;
const MIN = 60000;
/** callWatch runs on even ET hours 08..20; a slot is "due" this long after its start. */
const WATCH_GRACE_MS = 30 * MIN;
/** The 30-minute copy / transcribe jobs: four missed runs (callWatch's own check is 75 min). */
const JOB_STALE_MS = 2 * HOUR;
const REPEAT_MS = 6 * HOUR;
/**
 * The phone stopped uploading (Cube ACR killed, Drive sync off, phone dead):
 * ingest runs "healthy" and finds nothing. Jo's phone makes calls most days, so
 * no new recording row in this long is a canary, not a quiet week.
 */
const SILENT_RECORDINGS_MS = 36 * HOUR;
const ET = 'America/New_York';

function etHm(ms) {
  const s = new Date(ms).toLocaleString('en-US', { timeZone: ET, hour: 'numeric', minute: 'numeric', hour12: false });
  const m = /^(\d{1,2}):(\d{2})/.exec(s) || [];
  let h = Number(m[1]); if (h === 24) h = 0;
  return { h, m: Number(m[2]) };
}
const etClock = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: ET, hour: 'numeric', minute: '2-digit' });

/**
 * Start (ms) of the most recent callWatch slot that is at least `graceMs` old,
 * or null when none is due yet today (before 08:30 ET). Slots: 08,10,…,20 ET.
 */
function expectedWatchSlotMs(now, graceMs) {
  const t = now - (graceMs == null ? WATCH_GRACE_MS : graceMs);
  const { h, m } = etHm(t);
  if (h < 8) return null;
  const slotH = h > 20 ? 20 : (h % 2 === 0 ? h : h - 1);
  if (slotH < 8) return null;
  const d = new Date(t);
  return t - ((h - slotH) * 60 + m) * MIN - d.getUTCSeconds() * 1000 - d.getUTCMilliseconds();
}

/**
 * watch = integrations/callWatch (or null), cc = integrations/callCenter (or
 * null), gates = { watch, ingest, transcribe } — which jobs are switched on in
 * this deployment. Returns [{ key, text, repeatMs }].
 */
function deadManProblems({ watch, cc, now, gates, newestCallMs }) {
  const g = gates || {};
  const out = [];
  if (g.watch) {
    const slot = expectedWatchSlotMs(now);
    const last = W.toMs((watch || {}).lastCheckAtMs);
    if (slot != null && last < slot - 2 * MIN) {
      out.push({
        key: 'callwatch_not_running', repeatMs: REPEAT_MS,
        text: 'The 2-hour call check has not run since ' + (last ? etClock(last) + ' ET' : 'ever') +
          ' (the ' + etClock(slot) + ' check is overdue). New calls will not be pushed to you until it does.',
      });
    }
  }
  const c = cc || {};
  if (!c.paused) {
    if (g.ingest) {
      const last = W.toMs(c.lastRunAtMs);
      if (!last || now - last > JOB_STALE_MS) {
        out.push({ key: 'ingest_not_running', repeatMs: REPEAT_MS, text: 'Call recordings have not been copied from Drive since ' + (last ? Math.round((now - last) / MIN) + ' min ago' : 'ever') + ' (runs every 30 min).' });
      }
    }
    // newestCallMs: undefined = could not be read (say nothing); 0 = no calls at all.
    if (g.ingest && typeof newestCallMs === 'number' && newestCallMs > 0 && now - newestCallMs > SILENT_RECORDINGS_MS) {
      out.push({ key: 'no_new_recordings', repeatMs: REPEAT_MS, text: 'No new call recording has arrived in ' + Math.round((now - newestCallMs) / HOUR) + ' h. The copy job is running, so check that Cube ACR is still recording and uploading to Drive on the phone.' });
    }
    if (g.transcribe) {
      const last = W.toMs(c.lastTranscribeAtMs);
      if (!last || now - last > JOB_STALE_MS) {
        out.push({ key: 'transcribe_not_running', repeatMs: REPEAT_MS, text: 'Call transcripts have not run since ' + (last ? Math.round((now - last) / MIN) + ' min ago' : 'ever') + ' (runs every 30 min).' });
      }
    }
  }
  return out;
}

const gatesFromEnv = (env) => ({
  watch: env.CALL_WATCH_ENABLED === 'true',
  ingest: env.CALL_CENTER_INGEST_ENABLED === 'true',
  transcribe: env.CALL_CENTER_TRANSCRIBE_ENABLED === 'true',
});

/**
 * One check. deps: { db, nowMs, live, env, notify(title, body) → Promise }.
 * Returns { problems: [keys], told: [keys], state }. Never throws on a read
 * failure of its own bookkeeping: a failed read is itself reported as a
 * problem (a watcher that cannot read must not look healthy).
 */
async function run(deps) {
  const { db, nowMs, live } = deps;
  const gates = gatesFromEnv(deps.env || process.env);
  let watch = null, cc = null, health = {};
  try {
    const [a, b, c] = await Promise.all([
      db.doc('integrations/callWatch').get(),
      db.doc('integrations/callCenter').get(),
      db.doc('integrations/pipelineHealth').get(),
    ]);
    watch = a.exists ? a.data() : null;
    cc = b.exists ? b.data() : null;
    health = c.exists ? (c.data() || {}) : {};
  } catch (e) {
    return { state: 'read_failed', error: String(e && e.message || e).slice(0, 200), problems: ['deadman_read_failed'], told: [] };
  }
  let newestCallMs;
  try {
    const owner = (deps.env || process.env).NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
    const q = await db.collection('phone_calls').where('userId', '==', owner).orderBy('startedAtMs', 'desc').limit(1).get();
    newestCallMs = q.docs.length ? (W.toMs((q.docs[0].data() || {}).startedAtMs) || 0) : 0;
  } catch (_) { newestCallMs = undefined; }
  const problems = deadManProblems({ watch, cc, now: nowMs, gates, newestCallMs });
  const tell = W.problemsToTell(problems, health.problemsToldAt, nowMs);
  const out = { state: problems.length ? 'problem' : 'ok', problems: problems.map((p) => p.key), told: [] };
  if (!live) return Object.assign(out, { state: out.state + '_dry_run' });

  if (tell.length && W.inWatchHours(nowMs) && typeof deps.notify === 'function') {
    try {
      await deps.notify('⚠ Call alerts may be down', tell.map((p) => p.text).join('\n').slice(0, 900));
      out.told = tell.map((p) => p.key);
    } catch (_) { /* the heartbeat /fail below is the other path */ }
  }
  const problemsToldAt = {};
  problems.forEach((p) => {
    problemsToldAt[p.key] = out.told.includes(p.key) ? nowMs : (W.toMs((health.problemsToldAt || {})[p.key]) || 0);
  });
  try {
    await db.doc('integrations/pipelineHealth').set({
      checkedAtMs: nowMs, problems: out.problems, problemsToldAt,
      texts: problems.map((p) => p.text).slice(0, 5),
    }, { merge: false });
  } catch (_) { /* bookkeeping only */ }
  return out;
}

module.exports = { run, deadManProblems, expectedWatchSlotMs, gatesFromEnv, WATCH_GRACE_MS, JOB_STALE_MS, REPEAT_MS, SILENT_RECORDINGS_MS };
