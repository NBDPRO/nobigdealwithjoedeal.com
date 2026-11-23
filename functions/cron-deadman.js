'use strict';
/**
 * cron-deadman.js — cronDeadman (2026-11-22, audit
 * documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §2.8 / §3.8).
 *
 * WHY: 57 crons share 19 Healthchecks checks, and a shared check stays green
 * as long as its FASTEST member pings: callCenterTranscribe could stop for a
 * week while leadAlertWatchdog kept `calls-texts-ingest` green. The heartbeat
 * wrapper (integrations/heartbeat.js) now writes one ledger doc per job,
 * system/heartbeats/cron_runs/<export name> = { schedule, timeZone, ok, error,
 * lastOkAtMs, … },
 * so each job can be judged on its own.
 *
 * WHAT, every 30 minutes:
 *  1. For every deployed cron in heartbeat-plan.js (minus itself), the next
 *     expected fire after its last ok run comes from the schedule string on
 *     its ledger doc (`every N minutes`, `every day HH:MM`, or a 5-field
 *     cron read in the job's timeZone). A job is a problem once that fire +
 *     clamp(shortest gap, 30 min, 1 h) has passed. Failing runs never move
 *     lastOkAtMs, so "dead" and "failing" are one rule. A job with no ok run
 *     yet is judged from the dead-man's own first run with its longest gap
 *     (or Healthchecks period) + clamp(gap, 30 min, 6 h), so the first deploy
 *     cannot fire a wall of alerts.
 *  2. Alerts (Joe, 2026-11-22: daytime only). 07:00-21:00 ET: a new outage is
 *     sent at once. Outside that window it is queued, and ONE summary goes out
 *     on the first run at or after 07:00. Exception: a dead call or text
 *     pipeline (CRITICAL) is sent at once at any hour. An outage is told once,
 *     then again in each morning summary while it stays open ("still down");
 *     recovery sends one "recovered" line (routed the same way). A night
 *     outage that also recovered overnight becomes one summary line ("down
 *     1:10 AM-3:40 AM, recovered"). A job that leaves the watch list is
 *     dropped without a recovery line. A message about several jobs names
 *     them all on its first line. Error text is masked (redactText).
 *  3. The run throws (heartbeat /fail -> Healthchecks emails Joe over a path
 *     that does not need our push) only when a "down" or "still down" alert
 *     went out this run, the send failed, or the push reached no device.
 *     Queueing at night never throws.
 *
 * State: system/heartbeats = { startedAtMs, checkedAtMs, open, queue,
 * lastSummaryYmd }. pipeline-deadman.js (run by leadAlertWatchdog every 10
 * min) watches checkedAtMs, so this watcher is watched too.
 *
 * Send: ONE swappable function (owner-notify.js: bell + push to the owner).
 * Never a customer, never a text or email.
 *
 * Gate: CRON_DEADMAN_DISABLED=true -> dry run (computes + logs; stamps
 * checkedAtMs; sends nothing, keeps no outage state).
 */
const { onSchedule } = require('./integrations/heartbeat'); // heartbeat-wrapped drop-in for firebase-functions/v2/scheduler
const { logger } = require('firebase-functions/v2');
const HB = require('./integrations/heartbeat');
const { PLAN, CHECKS } = require('./integrations/heartbeat-plan');
const W = require('./call-watch-logic');
const { etHm, etClock } = require('./pipeline-deadman');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const STATE_DOC = 'system/heartbeats';
const SELF = 'cronDeadman';
/** Alert at once 07:00 <= ET hour < 21:00; otherwise queue for the 07:00 summary. */
const ALERT_START_H = 7;
const ALERT_END_H = 21;
/** Dead call / text pipelines alert at any hour (Joe, 2026-11-22). */
const CRITICAL = new Set(['callCenterIngest', 'textInboxIngest']);
const MAX_QUEUE = 50;
/** An outage still open this long after it was told is told again (next morning). */
const REMIND_AFTER_MS = 12 * HOUR;
/** Bell row cap: every job is named on the first line, so detail may be cut. */
const MAX_BODY = 8000;

const deadmanDisabled = () => process.env.CRON_DEADMAN_DISABLED === 'true';

// ── cadence ────────────────────────────────────────────────────────────────

const DOW = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** One cron field -> sorted array of values, or null when it can't be read. */
function cronField(src, lo, hi, names) {
  const out = new Set();
  const num = (t) => {
    const u = String(t).toUpperCase();
    if (names && Object.prototype.hasOwnProperty.call(names, u)) return names[u];
    return /^\d+$/.test(t) ? Number(t) : NaN;
  };
  for (const part of String(src).split(',')) {
    const m = /^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    let a, b;
    if (m[1] === '*') { a = lo; b = hi; }
    else if (m[1].includes('-')) { const [x, y] = m[1].split('-'); a = num(x); b = num(y); }
    else { a = num(m[1]); b = m[2] ? hi : a; }
    if (!Number.isFinite(a) || !Number.isFinite(b) || step < 1) return null;
    for (let v = a; v <= b; v += step) {
      const vv = (names === DOW && v === 7) ? 0 : v; // 7 = Sunday too
      if (vv < lo || vv > hi) return null;
      out.add(vv);
    }
  }
  return [...out].sort((x, y) => x - y);
}

const _cronCache = new Map();
/**
 * Longest gap between consecutive fires of a 5-field cron, over a ~400-day
 * naive calendar (DST is absorbed by the slack). null when unreadable.
 */
function cronGapMs(expr) {
  const key = String(expr || '').trim();
  if (_cronCache.has(key)) return _cronCache.get(key);
  let res = null;
  const f = key.split(/\s+/);
  if (f.length === 5) {
    const mins = cronField(f[0], 0, 59), hours = cronField(f[1], 0, 23);
    const doms = cronField(f[2], 1, 31), months = cronField(f[3], 1, 12, MON), dows = cronField(f[4], 0, 6, DOW);
    if (mins && hours && doms && months && dows && mins.length && hours.length) {
      const domStar = f[2] === '*', dowStar = f[4] === '*';
      const domSet = new Set(doms), monSet = new Set(months), dowSet = new Set(dows);
      const start = Date.UTC(2026, 0, 1);
      let first = null, prev = null, maxGap = 0;
      for (let d = 0; d < 400; d++) {
        const day = new Date(start + d * DAY);
        if (!monSet.has(day.getUTCMonth() + 1)) continue;
        const domOk = domSet.has(day.getUTCDate()), dowOk = dowSet.has(day.getUTCDay());
        // cron: both restricted -> either matches; otherwise the restricted one decides.
        const dayOk = (!domStar && !dowStar) ? (domOk || dowOk) : (domOk && dowOk);
        if (!dayOk) continue;
        for (const h of hours) for (const m of mins) {
          const t = start + d * DAY + h * HOUR + m * MIN;
          if (prev !== null) maxGap = Math.max(maxGap, t - prev);
          else first = t;
          prev = t;
        }
      }
      if (prev !== null && first !== null && prev !== first) res = maxGap;
    }
  }
  _cronCache.set(key, res);
  return res;
}

/** onSchedule schedule string -> cadence in ms, or null when unreadable. */
function cadenceMs(schedule) {
  const s = String(schedule || '').trim();
  if (!s) return null;
  let m = /^every (\d+) (minute|minutes|mins|hour|hours)$/i.exec(s);
  if (m) return Number(m[1]) * (/^h/i.test(m[2]) ? HOUR : MIN) || null;
  m = /^every (\d+ )?days?(?: \d{1,2}:\d{2})?$/i.exec(s);
  if (m) return (m[1] ? Number(m[1]) : 1) * DAY;
  return cronGapMs(s);
}

/** A Healthchecks period from heartbeat-plan.js CHECKS ('15 minutes', '1 week', 'cron … (tz)'). */
function periodMs(period) {
  const s = String(period || '').trim();
  const c = /^cron\s+(.+?)(?:\s*\(.*\))?$/i.exec(s);
  if (c) return cronGapMs(c[1]);
  const m = /^(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks)$/i.exec(s);
  if (!m) return null;
  const unit = m[2].toLowerCase();
  const per = unit.startsWith('minute') ? MIN : unit.startsWith('hour') ? HOUR : unit.startsWith('day') ? DAY : 7 * DAY;
  return Number(m[1]) * per;
}

const slackMs = (gap) => Math.min(Math.max(gap, 30 * MIN), 6 * HOUR);

/** ms -> the same wall-clock time in tz, as a UTC ms value (minute precision). */
function wallMs(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
}
/** A wall-clock time in tz (as from wallMs) -> real ms. */
function fromWall(wall, tz, nearMs) {
  const off = (x) => wallMs(x, tz) - (x - (((x % MIN) + MIN) % MIN));
  let x = wall - off(nearMs);
  x = wall - off(x);
  return x;
}

/**
 * When a job is next DUE after its last ok run, and how late it may be:
 * { dueMs, slackMs } or null when the schedule can't be read. Judging from
 * the next expected fire (review fix) keeps a daytime-only cron from getting
 * a whole-night threshold: '15 7,15 * * *' dead at 07:15 is late by 15:45,
 * not 05:15 the next day. Slack = clamp(shortest gap, 30 min, 1 h).
 */
function nextDue(schedule, afterMs, tz) {
  const s = String(schedule || '').trim();
  const zone = tz || 'UTC';
  let m = /^every (\d+) (minute|minutes|mins|hour|hours)$/i.exec(s);
  if (m) { const g = Number(m[1]) * (/^h/i.test(m[2]) ? HOUR : MIN); return g ? { dueMs: afterMs + g, slackMs: Math.min(Math.max(g, 30 * MIN), HOUR) } : null; }
  m = /^every (\d+ )?days?(?: (\d{1,2}):(\d{2}))?$/i.exec(s);
  let expr = s;
  if (m) {
    if ((m[1] && Number(m[1]) !== 1) || !m[2]) return { dueMs: afterMs + (m[1] ? Number(m[1]) : 1) * DAY, slackMs: HOUR };
    expr = Number(m[3]) + ' ' + Number(m[2]) + ' * * *';
  }
  const f = expr.split(/\s+/);
  if (f.length !== 5) return null;
  const mins = cronField(f[0], 0, 59), hours = cronField(f[1], 0, 23);
  const doms = cronField(f[2], 1, 31), months = cronField(f[3], 1, 12, MON), dows = cronField(f[4], 0, 6, DOW);
  if (!(mins && hours && doms && months && dows && mins.length && hours.length)) return null;
  const domStar = f[2] === '*', dowStar = f[4] === '*';
  const domSet = new Set(doms), monSet = new Set(months), dowSet = new Set(dows);
  const after = wallMs(afterMs, zone);
  const day0 = Math.floor(after / DAY) * DAY;
  for (let d = 0; d < 400; d++) {
    const dayStart = day0 + d * DAY;
    const day = new Date(dayStart);
    if (!monSet.has(day.getUTCMonth() + 1)) continue;
    const domOk = domSet.has(day.getUTCDate()), dowOk = dowSet.has(day.getUTCDay());
    if (!((!domStar && !dowStar) ? (domOk || dowOk) : (domOk && dowOk))) continue;
    for (const h of hours) for (const mm of mins) {
      const t = dayStart + h * HOUR + mm * MIN;
      if (t <= after) continue;
      // Shortest gap between fires (only its clamp to 30-60 min matters).
      const diffs = (a, unit) => a.slice(1).map((v, i) => (v - a[i]) * unit);
      const minGap = mins.length > 1 ? Math.min(...diffs(mins, MIN)) : hours.length > 1 ? Math.min(...diffs(hours, HOUR)) : DAY;
      return { dueMs: fromWall(t, zone, afterMs), slackMs: Math.min(Math.max(minGap, 30 * MIN), HOUR) };
    }
  }
  return null;
}

// ── judging ────────────────────────────────────────────────────────────────

/**
 * jobs = { exportName: ledger doc }, expected = deployed export names to judge,
 * startedAtMs = the dead-man's first run, seenAtMs = { job: when the dead-man
 * first expected a job that has no ledger doc yet } (a cron deployed later
 * gets its own grace). Returns { job: { reason } }.
 */
function judgeJobs({ jobs, expected, startedAtMs, now, seenAtMs }) {
  const out = {};
  for (const name of expected || []) {
    if (name === SELF) continue;
    const plan = PLAN[name];
    if (!plan || plan.exempt) continue;
    const doc = (jobs || {})[name];
    const fallback = periodMs((CHECKS[plan.slug] || {}).period);
    const gap = (doc && cadenceMs(doc.schedule)) || fallback;
    if (!gap) continue;
    const lastOk = doc ? W.toMs(doc.lastOkAtMs) : 0;
    // A job with an ok run: late once its next expected fire + slack passed.
    const due = lastOk ? nextDue(doc.schedule, lastOk, doc.timeZone) : null;
    const since = lastOk || (!doc && W.toMs((seenAtMs || {})[name])) || W.toMs(startedAtMs) || now;
    if (due ? now <= due.dueMs + due.slackMs : now - since <= gap + slackMs(gap)) continue;
    let reason;
    if (doc && doc.ok === false) reason = 'last run failed: ' + HB.redactText(doc.error || doc.lastError || 'unknown error').slice(0, 160);
    else if (doc && W.toMs(doc.finishedAtMs)) reason = 'no run since ' + etWhen(W.toMs(doc.finishedAtMs), now);
    else if (doc) reason = 'no successful run recorded';
    else reason = 'no run recorded since the watcher started ' + etWhen(since, now);
    out[name] = { reason };
  }
  return out;
}

/** "3:10 PM" today, else "Nov 21 3:10 PM" (ET). */
function etWhen(ms, now) {
  if (W.etYmd(ms) === W.etYmd(now)) return etClock(ms);
  return new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' }) + ' ' + etClock(ms);
}

const isDaytime = (now) => { const h = etHm(now).h; return h >= ALERT_START_H && h < ALERT_END_H; };

/**
 * One transition step. state = system/heartbeats, problems = judgeJobs(),
 * expected = the jobs still watched (an open or queued job that left the list
 * is dropped silently: never a false "recovered"). Returns { state, lines,
 * jobs, summary, downSent } — lines to send now (one message) and the jobs
 * they name.
 */
function step(state, problems, now, expected) {
  const s = JSON.parse(JSON.stringify(state || {}));
  s.open = s.open || {};
  s.queue = Array.isArray(s.queue) ? s.queue : [];
  if (Array.isArray(expected)) {
    const watched = new Set(expected);
    for (const job of Object.keys(s.open)) if (!watched.has(job)) delete s.open[job];
    s.queue = s.queue.filter((q) => watched.has(q.job));
  }
  const day = isDaytime(now);
  const now_ = [];
  let downSent = 0;

  for (const job of Object.keys(problems)) {
    if (s.open[job]) { s.open[job].reason = problems[job].reason; continue; }
    const text = job + ': ' + problems[job].reason + '.';
    s.open[job] = { sinceMs: now, reason: problems[job].reason, toldAtMs: null };
    if (day || CRITICAL.has(job)) { now_.push({ job, kind: 'down', text }); s.open[job].toldAtMs = now; downSent++; }
    else s.queue.push({ job, kind: 'down', text, atMs: now });
  }
  for (const job of Object.keys(s.open)) {
    if (problems[job]) continue;
    const o = s.open[job];
    delete s.open[job];
    if (o.toldAtMs == null) {
      // Queued at night and back before anyone was told: one summary line.
      const text = job + ': was down ' + etClock(o.sinceMs) + '-' + etClock(now) + ' (' + o.reason + '), recovered.';
      const i = s.queue.findIndex((q) => q.job === job && q.kind === 'down');
      if (i >= 0) s.queue[i] = { job, kind: 'blip', text, atMs: now };
      else if (day || CRITICAL.has(job)) now_.push({ job, kind: 'recovered', text });
      else s.queue.push({ job, kind: 'blip', text, atMs: now });
      continue;
    }
    const text = job + ': recovered (down since ' + etWhen(o.sinceMs, now) + ').';
    if (day || CRITICAL.has(job)) now_.push({ job, kind: 'recovered', text });
    else s.queue.push({ job, kind: 'recovered', text, atMs: now });
  }

  let summary = false;
  const today = W.etYmd(now);
  if (day && s.lastSummaryYmd !== today) {
    // Once a day, an outage told on an earlier day and still open is told
    // again (review fix: one swiped-away push must not be the last word).
    const remind = [];
    for (const job of Object.keys(s.open)) {
      const o = s.open[job];
      if (o.toldAtMs == null || now - o.toldAtMs < REMIND_AFTER_MS) continue;
      remind.push({ job, kind: 'still', text: job + ': still down since ' + etWhen(o.sinceMs, now) + ' (' + o.reason + ').' });
      o.toldAtMs = now;
      downSent++;
    }
    if (s.queue.length || remind.length) {
      summary = true;
      for (const q of s.queue) {
        if (q.kind === 'down' && s.open[q.job] && s.open[q.job].toldAtMs == null) { s.open[q.job].toldAtMs = now; downSent++; }
      }
      now_.unshift(...s.queue.map((q) => ({ job: q.job, kind: q.kind, text: q.text })), ...remind);
      s.queue = [];
    }
    s.lastSummaryYmd = today;
  }
  if (s.queue.length > MAX_QUEUE) s.queue = s.queue.slice(-MAX_QUEUE);
  return { state: s, lines: now_.map((l) => l.text), jobs: [...new Set(now_.map((l) => l.job))], summary, downSent };
}

/**
 * The message. More than one job: the first line names every job (it is what
 * a push shows) and the title counts them, so a cut-off body never hides one.
 */
function message(r) {
  const jobs = r.jobs || [];
  const head = jobs.length > 1 ? 'Jobs: ' + jobs.join(', ') + '\n' : '';
  const body = (head + r.lines.join('\n')).slice(0, MAX_BODY);
  const n = jobs.length > 1 ? ' (' + jobs.length + ' jobs)' : '';
  if (r.summary) return { title: 'Scheduled jobs: overnight summary' + n, body };
  const allRecovered = !r.downSent;
  return { title: (allRecovered ? 'Scheduled job recovered' : '⚠ Scheduled job problem') + n, body };
}

/** Deployed crons to judge: the plan, limited to what function-map.json says ships. */
function expectedJobs() {
  let deployed = null;
  try { deployed = new Set(Object.keys(require('./function-map.json'))); } catch (_) { /* full plan */ }
  return Object.keys(PLAN).filter((n) => !PLAN[n].exempt && n !== SELF && (!deployed || deployed.has(n)));
}

/**
 * One check. deps: { db, nowMs, live, send(title, body) -> Promise<{ pushed }?>, expected? }.
 * Returns { state, problems, downSent, sent, sendError?, pushFailed? }. A read failure
 * rejects (a watcher that cannot read must not look healthy).
 */
async function run(deps) {
  const { db, nowMs, live } = deps;
  const [stSnap, jobsSnap] = await Promise.all([
    db.doc(STATE_DOC).get(),
    db.collection(HB.LEDGER_COLLECTION).get(),
  ]);
  const state = stSnap.exists ? (stSnap.data() || {}) : {};
  const jobs = {};
  jobsSnap.forEach((d) => { jobs[d.id] = d.data() || {}; });
  const startedAtMs = W.toMs(state.startedAtMs) || nowMs;
  const expected = deps.expected || expectedJobs();
  const seen = {};
  for (const n of expected) if (!jobs[n]) seen[n] = W.toMs((state.seen || {})[n]) || nowMs;
  state.seen = seen;
  const problems = judgeJobs({ jobs, expected, startedAtMs, now: nowMs, seenAtMs: seen });
  const out = { state: Object.keys(problems).length ? 'problem' : 'ok', problems: Object.keys(problems), downSent: 0, sent: false };

  if (!live) {
    await db.doc(STATE_DOC).set(Object.assign({}, state, { startedAtMs, checkedAtMs: nowMs }), { merge: false });
    return Object.assign(out, { state: out.state + '_dry_run' });
  }

  const r = step(state, problems, nowMs, expected);
  if (r.lines.length && typeof deps.send === 'function') {
    const msg = message(r);
    let res;
    try {
      res = await deps.send(msg.title, msg.body);
    } catch (e) {
      // Keep the old outage state, so the next run sends it again.
      await db.doc(STATE_DOC).set(Object.assign({}, state, { startedAtMs, checkedAtMs: nowMs }), { merge: false });
      return Object.assign(out, { sendError: String(e && e.message || e).slice(0, 200) });
    }
    out.sent = true;
    out.downSent = r.downSent;
    // The bell row is written, so the state moves on (no bell spam every 30
    // min); a push no device got still fails the run (Healthchecks email).
    if (res && res.pushed === false) out.pushFailed = true;
  }
  await db.doc(STATE_DOC).set(Object.assign({}, r.state, { startedAtMs, checkedAtMs: nowMs }), { merge: false });
  return out;
}

exports.cronDeadman = onSchedule(
  { schedule: 'every 30 minutes', timeZone: 'America/New_York', timeoutSeconds: 120, memory: '256MiB', maxInstances: 1 },
  async () => {
    const { getFirestore } = require('firebase-admin/firestore');
    const db = getFirestore();
    const r = await run({
      db, nowMs: Date.now(), live: !deadmanDisabled(),
      send: (title, body) => require('./owner-notify').notifyOwner(db, title, body, { type: 'cron_watch', clickUrl: '/pro/dashboard.html', idPrefix: 'cron-deadman-' }),
    });
    logger.info('[cronDeadman]', r);
    if (r.sendError) throw new Error('cronDeadman: alert send failed: ' + r.sendError + ' (jobs: ' + r.problems.join(', ') + ')');
    if (r.pushFailed) throw new Error('cronDeadman: alert written to the bell but the push reached no device (jobs: ' + r.problems.join(', ') + ')');
    if (r.downSent > 0) throw new Error('cronDeadman: ' + r.problems.join(', '));
  }
);

exports._test = { cadenceMs, nextDue, cronGapMs, periodMs, slackMs, judgeJobs, step, expectedJobs, isDaytime, CRITICAL, ALERT_START_H, ALERT_END_H, STATE_DOC, SELF };
exports.run = run;
