'use strict';
/**
 * call-watch-logic.js — the rules behind callWatch (Jo, 2026-10-02: "a
 * scheduled check on calls every few hours so nothing gets missed throughout
 * the day or slow updates"). Pure; call-watch.js does the reads and alerts.
 *
 * Two questions, every 2 hours from 8 AM to 8 PM Eastern:
 *   1. NOTHING MISSED — what needs Jo that arrived since the last check:
 *      Cube calls + text days by the SAME rule as the Calls screen's "Needs
 *      attention" (docs/pro/js/home-attention.js callNeedsYou — the test
 *      runs both on the same rows), missed inbound calls, and Thursday
 *      calls not yet reviewed.
 *   2. NO SLOW UPDATES — is the pipeline keeping up: copy + transcribe ran
 *      recently and didn't fail, nothing waits hours for a transcript,
 *      Thursday calls aren't stuck or failed. (The heartbeat ping only
 *      proves a cron FIRED; the call jobs catch their own errors.)
 * One alert, only when something is new; a standing pipeline problem
 * repeats at most every 6 hours.
 */

const DAY = 86400000;
const HOUR = 3600000;
const CALL_WINDOW = 14 * DAY;
const PROMISE_WINDOW = 45 * DAY; // Jo, 2026-10-12: an open promise of his stays 'needs you' to 45 days
const STALE_RUN_MS = 75 * 60000;        // the 30-min jobs: two missed runs + slack
const STALE_TEXT_NOTES_MS = 150 * 60000; // the 60-min text notes job
const TRANSCRIPT_WAIT_MS = 6 * HOUR;
const THURSDAY_STUCK_MS = 30 * 60000;
const PROBLEM_REPEAT_MS = 6 * HOUR;

function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v); return Number.isFinite(t) ? t : 0;
}
const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Mirror of home-attention.js isMissedCall / reachIndex / callNeedsYou (kept in step by the test). */
const isMissedCall = (c) => !!c && c.channel !== 'text' && c.status === 'short' && c.direction === 'inbound';
function reachIndex(rows) {
  const m = new Map();
  (rows || []).forEach((r) => {
    if (!r || r.channel === 'text' || isMissedCall(r) || (r.direction !== 'inbound' && r.direction !== 'outbound')) return;
    const k = callerKey(r), at = toMs(r.startedAtMs) || 0;
    if (at > (m.get(k) || 0)) m.set(k, at);
  });
  return { reachedAt: m };
}
// Per-number labels (2026-10-12; docs/pro/js/contact-labels-logic.js, rules in
// home-attention.js). ctx.labels = { digits10: { kind, policy, ackAtMs,
// updatedAtMs } }. hide / quiet drop urgent, missed and unknown-number noise;
// a promise Jo made (or a follow-up date that has come) ALWAYS surfaces.
function labelOf(ctx, c) {
  const L = ctx && ctx.labels;
  if (!L || !c) return null;
  const d = String(c.phoneDigits || '').replace(/\D/g, '').slice(-10);
  if (d.length !== 10) return null;
  return (typeof L.get === 'function' ? L.get(d) : L[d]) || null;
}
const labelPolicy = (lb) => (lb && (lb.policy === 'hide' || lb.policy === 'quiet' || lb.policy === 'surface') ? lb.policy : '');

function callNeedsYou(c, now, ctx) {
  const t = now == null ? Date.now() : now;
  if (!c || c.handledAtMs || c.status === 'personal') return false;
  if (c.callType === 'spam' || c.taskDone === true) return false;
  // Mirror of home-attention.js: a promise Jo made outlives the 14-day window
  // up to 45 days (then Home's single "old promises" row takes it).
  if ((toMs(c.startedAtMs) || 0) < t - CALL_WINDOW) {
    if ((toMs(c.startedAtMs) || 0) < t - PROMISE_WINDOW) return false;
    return (c.promises || []).some((p) => p && p.who === 'jo' && !p.keptAtMs);
  }
  const promised = (c.promises || []).some((p) => p && p.who === 'jo');
  const lb = labelOf(ctx, c);
  const pol = labelPolicy(lb);
  const dueFu = !!(c.followUpDate && c.followUpDate <= etYmd(t));
  // hide: a promise, a due callback or an urgent call from a non-spam number
  // breaks through (mirror of home-attention.js); quiet: promise / callback only.
  if (pol === 'hide') return promised || dueFu || (c.urgent === true && lb.kind !== 'spam');
  if (pol === 'quiet') return promised || dueFu;
  if (!pol && (c.callType === 'sub' || c.callType === 'supplier')) return promised;
  if (c.urgent === true) return true;
  if (promised) return true;
  if (c.followUpDate && c.followUpDate <= etYmd(t)) return true;
  if (isMissedCall(c)) {
    const reached = ctx && ctx.reachedAt ? (ctx.reachedAt.get(callerKey(c)) || 0) : 0;
    return reached <= (toMs(c.startedAtMs) || 0);
  }
  if (c.leadId) return false;
  if (c.bucket === 'insurance' || (lb && lb.kind === 'insurance')) return true;
  if (c.bucket === 'unknown') return c.status !== 'short';
  return false;
}

const BURST_N = 3, BURST_MS = DAY;
/**
 * Mirror of home-attention.js resurfacedNumbers: a HIDDEN number that is
 * filed on a customer, or rings 3+ times in 24 h, after the label was applied
 * / last acknowledged ("Keep hidden" = ackAtMs). Once per baseline.
 */
function resurfacedNumbers(rows, labels, now) {
  const out = [];
  if (!labels) return out;
  const t = now == null ? Date.now() : now;
  const by = new Map();
  (rows || []).forEach((c) => {
    if (!c || c.channel === 'text' || c.handledAtMs || c.taskDone === true || c.status === 'personal' || c.callType === 'spam') return;
    const d = String(c.phoneDigits || '').replace(/\D/g, '').slice(-10);
    if (d.length !== 10) return;
    const lb = typeof labels.get === 'function' ? labels.get(d) : labels[d];
    if (!lb || lb.policy !== 'hide') return;
    const base = Math.max(toMs(lb.ackAtMs), toMs(lb.updatedAtMs));
    if ((toMs(c.startedAtMs) || 0) <= base) return;
    if (!by.has(d)) by.set(d, { digits: d, base, calls: [] });
    by.get(d).calls.push(c);
  });
  by.forEach((v) => {
    const recent = v.calls.filter((c) => c.direction !== 'outbound' && (toMs(c.startedAtMs) || 0) >= t - BURST_MS);
    const onLead = v.calls.some((c) => c.leadId);
    const reason = onLead ? 'lead' : (recent.length >= BURST_N ? 'burst' : '');
    if (reason) out.push({ digits: v.digits, reason, calls: v.calls, base: v.base });
  });
  return out;
}

/** Why a call / text day needs Jo, in a few words. */
function reasonFor(c, now, ctx) {
  const promised = (c.promises || []).some((p) => p && p.who === 'jo');
  const lb = labelOf(ctx, c);
  const pol = labelPolicy(lb);
  const urgentOk = pol === 'quiet' ? false : (pol === 'hide' ? !!(lb && lb.kind !== 'spam') : true);
  if (c.urgent === true && c.callType !== 'sub' && c.callType !== 'supplier' && urgentOk) return 'urgent';
  if (promised) return 'you promised something';
  if (c.followUpDate && c.followUpDate <= etYmd(now)) return 'follow-up due';
  if (isMissedCall(c)) return 'missed call';
  if (c.bucket === 'insurance') return 'insurance line, no customer on file';
  return 'unknown number, no customer on file';
}
/** Mirror of home-attention.js callerKey: the customer, else the number. */
function callerKey(c) {
  if (!c) return '';
  if (c.leadId) return 'lead:' + c.leadId;
  const d = String(c.phoneDigits || '').replace(/\D/g, '').slice(-10);
  return d ? 'num:' + d : 'id:' + (c.id || '');
}

const who = (c) => String(c.contactName || c.from || (c.phoneDigits ? '…' + String(c.phoneDigits).slice(-4) : '') || 'Unknown caller').slice(0, 60);

/** True when the row's follow-up date became due after the day of the last check (ET), and is due now. */
function followUpCameDue(c, sinceMs, now) {
  return !!(c && c.followUpDate && c.followUpDate <= etYmd(now) && c.followUpDate > etYmd(sinceMs));
}

/**
 * New items since `sinceMs` that need Jo. calls / textDays: phone_calls /
 * phone_text_days docs (with id); thursday: thursday_calls docs (with id).
 */
function newNeeds(calls, textDays, thursday, sinceMs, now, labels) {
  const out = [];
  const ctx = reachIndex(calls);
  if (labels) ctx.labels = labels;
  const tctx = labels ? { labels } : null;
  (calls || []).forEach((c) => {
    if (!callNeedsYou(c, now, ctx)) return;
    const arrived = toMs(c.notedAtMs) || toMs(c.createdAtMs) || toMs(c.startedAtMs);
    // A follow-up date that CAME DUE since the last check is news even though
    // the call is old (audit R7, 2026-10-12): "call back Friday" is pushed on Friday.
    const due = followUpCameDue(c, sinceMs, now);
    if (arrived <= sinceMs && !due) return;
    const why = reasonFor(c, now, ctx);
    // Already told by the immediate urgent push (call-center.js pushUrgent).
    if (why === 'urgent' && c.urgentPushedAtMs && !due) return;
    out.push({ id: 'call:' + c.id, tellId: arrived <= sinceMs ? 'call:' + c.id + '#due:' + c.followUpDate : undefined, key: callerKey(c), kind: 'call', who: who(c), why, at: toMs(c.startedAtMs) });
  });
  (textDays || []).forEach((c) => {
    if (!callNeedsYou(c, now, tctx)) return;
    const arrived = toMs(c.notedAtMs) || toMs(c.startedAtMs);
    const due = followUpCameDue(c, sinceMs, now);
    if (arrived <= sinceMs && !due) return;
    // A text day is ONE doc per number per day that textInboxNotes re-writes
    // (same id, new notedAtMs / urgent / promises) whenever another text lands.
    // Keyed on the plain id, the 10:00 "who is this" tell swallowed the 15:00
    // "water through the ceiling" re-note (QA 2026-10-13): told once per REASON.
    const why = reasonFor(c, now, tctx);
    out.push({ id: 'text:' + c.id, tellId: arrived <= sinceMs ? 'text:' + c.id + '#due:' + c.followUpDate : 'text:' + c.id + '#' + why, key: callerKey(c), kind: 'text', who: who(c), why, at: toMs(c.startedAtMs) });
  });
  // A hidden number that came back (matches a customer, or 3+ calls in 24 h):
  // told once per label baseline — "Keep hidden" moves the baseline.
  resurfacedNumbers(calls, labels, now).forEach((v) => {
    const latest = v.calls.slice().sort((a, b) => (toMs(b.startedAtMs) || 0) - (toMs(a.startedAtMs) || 0))[0];
    const at = toMs(latest.startedAtMs);
    if (at <= sinceMs) return;
    out.push({
      id: 'hidden:' + v.digits + ':' + v.base, key: callerKey(latest), kind: 'call', who: who(latest),
      why: v.reason === 'lead' ? 'a hidden number matches a customer' : 'a hidden number is calling a lot', at,
    });
  });
  (thursday || []).forEach((t) => {
    if (!t || t.reviewed === true || t.status !== 'processed') return;
    const arrived = toMs(t.processedAt) || toMs(t.startedAt);
    if (arrived <= sinceMs || arrived < now - CALL_WINDOW) return;
    const td = String(t.from || '').replace(/\D/g, '').slice(-10);
    // Thursday took a call from a number Jo hid / quieted: a promise would
    // be on a phone call, not here, so it stays out of the alert.
    const tl = labels && td ? (typeof labels.get === 'function' ? labels.get(td) : labels[td]) : null;
    if (tl && (tl.policy === 'hide' || tl.policy === 'quiet')) return;
    out.push({ id: 'thursday:' + t.id, key: td ? 'num:' + td : 'thursday:' + t.id, kind: 'thursday', who: String(t.from || 'Caller').slice(0, 60), why: t.urgent ? 'urgent (Thursday took it)' : 'Thursday took it — not reviewed', at: toMs(t.startedAt) });
  });
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/**
 * Pipeline health. cc = integrations/callCenter, ti = integrations/textInbox
 * (both may be null), stored = phone_calls with status 'stored',
 * thursday = recent thursday_calls, gates = which jobs are switched on.
 */
function pipelineProblems(cc, ti, stored, thursday, now, gates) {
  const g = gates || {};
  const p = [];
  const c = cc || {};
  if (g.ingest && !c.paused) {
    const last = toMs(c.lastRunAtMs);
    if (!last || now - last > STALE_RUN_MS) p.push({ key: 'ingest_stale', text: 'Calls haven\'t been copied from Drive since ' + (last ? Math.round((now - last) / 60000) + ' min ago' : 'ever') + ' (runs every 30 min).' });
    else if (c.lastRun && Number(c.lastRun.failed) > 0) p.push({ key: 'ingest_failed', text: 'The last call copy had ' + Number(c.lastRun.failed) + ' failure(s).' });
  }
  if (g.transcribe && !c.paused) {
    const last = toMs(c.lastTranscribeAtMs);
    const lt = c.lastTranscribe || {};
    if (!last || now - last > STALE_RUN_MS) p.push({ key: 'transcribe_stale', text: 'Call transcripts haven\'t run since ' + (last ? Math.round((now - last) / 60000) + ' min ago' : 'ever') + ' (runs every 30 min).' });
    else if (Number(lt.failed) > 0) p.push({ key: 'transcribe_failed', text: 'The last transcript run had ' + Number(lt.failed) + ' failure(s).' });
  }
  const waiting = (stored || []).filter((s) => s && toMs(s.startedAtMs) && toMs(s.startedAtMs) >= now - CALL_WINDOW);
  const oldest = waiting.reduce((m, s) => Math.min(m, toMs(s.createdAtMs) || toMs(s.startedAtMs) || now), now);
  if (g.transcribe && waiting.length && now - oldest > TRANSCRIPT_WAIT_MS) {
    const capped = c.lastTranscribe && (c.lastTranscribe.state === 'cap' || c.lastTranscribe.rateLimited > 0);
    p.push({ key: 'transcripts_behind', text: waiting.length + ' call(s) waiting for a transcript, oldest ' + Math.round((now - oldest) / HOUR) + ' h' + (capped ? ' (the daily transcription cap or rate limit is holding them).' : '.') });
  }
  if (g.textNotes && ti && !ti.paused) {
    const last = toMs(ti.lastRunAtMs);
    if (!last || now - last > STALE_TEXT_NOTES_MS) p.push({ key: 'texts_stale', text: 'Texts haven\'t been read from the backup since ' + (last ? Math.round((now - last) / 60000) + ' min ago' : 'ever') + '.' });
    else if (ti.lastRun && ti.lastRun.state === 'no_backup') p.push({ key: 'texts_no_backup', text: 'No SMS Backup & Restore file found in Drive — check the backup app on the phone.' });
  }
  const stuck = (thursday || []).filter((t) => t && (
    (t.status === 'pending' || t.status === 'processing') && now - (toMs(t.processingStartedAt) || toMs(t.createdAt) || toMs(t.startedAt) || now) > THURSDAY_STUCK_MS));
  const failed = (thursday || []).filter((t) => t && t.status === 'failed' && (toMs(t.processedAt) || toMs(t.startedAt)) >= now - DAY);
  if (stuck.length) p.push({ key: 'thursday_stuck', text: stuck.length + ' Thursday call(s) stuck processing for 30+ min.' });
  if (failed.length) p.push({ key: 'thursday_failed', text: failed.length + ' Thursday call(s) failed to process in the last day.' });
  return p;
}

/** Problems worth alerting now: new keys, or a standing one last told 6+ h ago. */
function problemsToTell(problems, lastTold, now) {
  const told = lastTold || {};
  return (problems || []).filter((p) => !told[p.key] || now - toMs(told[p.key]) >= (p.repeatMs || PROBLEM_REPEAT_MS));
}

/**
 * Texts that did not deliver (2026-10-02). Twilio "accepts" a message and the
 * carrier blocks it later, so the CRM's own records said "sent" for 45 days
 * while 0 of 23 texts arrived (30034: number not registered; 21608: trial
 * account). messages = Twilio outbound messages from the last day ({ status,
 * error_code, direction, date_sent }). One problem, repeated at most daily.
 */
const SMS_REPEAT_MS = 24 * HOUR;
const SMS_REASONS = {
  30034: 'the sending number is not registered for business texting (A2P 10DLC)',
  21608: 'the Twilio account is still a trial and can only text verified numbers',
  30007: 'the carrier filtered it as spam',
  30003: 'the phone was unreachable',
  30005: 'the number does not exist',
  30006: 'the number cannot receive texts',
};
/** sid -> 'delivered' | 'undelivered:<code>' | 'failed:<code>' for messages in a final state (pure). */
function deliveryBySid(messages) {
  const out = {};
  (messages || []).forEach((m) => {
    if (!m || !m.sid || !/^outbound/.test(String(m.direction || ''))) return;
    if (m.status === 'delivered') out[m.sid] = 'delivered';
    else if (m.status === 'undelivered' || m.status === 'failed') out[m.sid] = m.status + ':' + (m.error_code || '?');
  });
  return out;
}

function smsProblems(messages, now) {
  const out = (messages || []).filter((m) => m && /^outbound/.test(String(m.direction || ''))
    && (toMs(m.date_sent) || toMs(m.date_created) || now) >= now - DAY);
  // A person who replied STOP (21610) is the system working, not a failure.
  const bad = out.filter((m) => (m.status === 'undelivered' || m.status === 'failed') && String(m.error_code) !== '21610');
  if (!bad.length) return [];
  const codes = {};
  bad.forEach((m) => { const c = String(m.error_code || '?'); codes[c] = (codes[c] || 0) + 1; });
  const top = Object.keys(codes).sort((a, b) => codes[b] - codes[a])[0];
  const delivered = out.filter((m) => m.status === 'delivered').length;
  return [{
    key: 'sms_undelivered', repeatMs: SMS_REPEAT_MS,
    text: bad.length + ' text' + (bad.length === 1 ? '' : 's') + ' in the last day did not deliver' + (delivered ? ' (' + delivered + ' did)' : ' (none did)') +
      ' — ' + (SMS_REASONS[top] || 'Twilio error ' + top) + '. The fix: documentation/runbooks/TWILIO-A2P-REGISTRATION.md.',
  }];
}

/**
 * The re-tell ladder (2026-10-12 audit R1 / ack-timeout lead). callWatch used
 * to tell each person ONCE; an unhandled urgent call or a promise Jo made was
 * never mentioned again until the morning email. Now an item that is still
 * open and high-value is told again on the next runs, then the morning brief
 * takes over. Deliberately SHORT (solo operator): original push, two
 * re-tells (the last one sticky), then the 07:15 brief / sweep.
 *   open   = callNeedsYou() still true: not handled, not task-done, not spam
 *   resolved / snoozed with a date -> drops out of the ladder (never nags)
 *   high-value = urgent, a promise Jo made, a due follow-up, an insurance line
 */
const LADDER_GAP_MS = 100 * 60000;   // runs are 2 h apart; never twice in one run
const LADDER_MAX = 3;                // tells including the first
const HIGH_WHY = /^(urgent|you promised something|follow-up due|insurance line)/;
function ladderCandidates(callRows, textRows, now, labels) {
  const out = [];
  const ctx = reachIndex(callRows);
  if (labels) ctx.labels = labels;
  const tctx = labels ? { labels } : undefined;
  const today = etYmd(now);
  const add = (c, prefix, useCtx) => {
    const cx = useCtx ? ctx : tctx;
    if (!callNeedsYou(c, now, cx)) return;
    const why = reasonFor(c, now, cx);
    if (!HIGH_WHY.test(why)) return;
    // Snoozed with a date: on the call (no task) or by moving its task.
    if (c.snoozeUntilYmd && String(c.snoozeUntilYmd) > today) return;
    if (c.taskDueYmd && String(c.taskDueYmd) > today) return;
    out.push({ id: prefix + c.id, key: callerKey(c), kind: prefix === 'text:' ? 'text' : 'call', who: who(c), why, at: toMs(c.startedAtMs), seedAt: toMs(c.urgentPushedAtMs) });
  };
  (callRows || []).forEach((c) => add(c, 'call:', true));
  (textRows || []).forEach((c) => add(c, 'text:', false));
  return out;
}
/** Items to tell AGAIN now: told before (ladder, or the immediate urgent push), still open, rungs left. */
function ladderRetells(callRows, textRows, ladder, now, labels) {
  const L = ladder || {};
  const out = [];
  ladderCandidates(callRows, textRows, now, labels).forEach((x) => {
    const prev = L[x.id] || (x.seedAt ? { n: 1, at: x.seedAt } : null);
    if (!prev || !(Number(prev.n) >= 0)) return;
    if (Number(prev.n) >= LADDER_MAX) return;
    if (now - (toMs(prev.at) || 0) < LADDER_GAP_MS) return;
    out.push(Object.assign({}, x, { rung: Number(prev.n) + 1, why: x.why + ' — still open (reminder ' + Number(prev.n) + ')' }));
  });
  return out;
}
/**
 * The ladder state to persist. newIds = ids newly told this run, retells =
 * ladderRetells() output, reached = the push reached a device (false → the
 * rung does not count, so the next run tries it again). Only items still open
 * are kept, so a handled / snoozed item leaves the map by itself.
 */
function nextLadder(callRows, textRows, ladder, newIds, retells, reached, now, labels) {
  const L = ladder || {};
  const fresh = new Set(newIds || []);
  const re = new Map((retells || []).map((r) => [r.id, r]));
  const next = {};
  ladderCandidates(callRows, textRows, now, labels).forEach((x) => {
    const prev = L[x.id] || (x.seedAt ? { n: 1, at: x.seedAt } : null);
    if (re.has(x.id)) next[x.id] = reached ? { n: re.get(x.id).rung, at: now } : prev;
    else if (fresh.has(x.id)) next[x.id] = reached ? { n: 1, at: now } : { n: 0, at: 0 };
    else if (prev) next[x.id] = prev;
  });
  return next;
}

/**
 * The end-of-day "nothing fell through" ledger (2026-10-12 audit, section 4).
 * Written once a day by the 20:00 callWatch run as a bell entry that stays
 * unread until Jo taps it: a digest that arrives and is ignored shows as an
 * unread item instead of vanishing. Pure; rows are the 14-day windows
 * callWatch already loaded.
 */
const LEDGER_OLD_MS = 3 * DAY;
function dailyLedger(callRows, textRows, now, extra) {
  const ex = extra || {};
  const today = etYmd(now);
  const calls = (callRows || []).filter((c) => c && c.channel !== 'text');
  const todays = calls.filter((c) => etYmd(toMs(c.startedAtMs)) === today);
  const noted = todays.filter((c) => c.status === 'noted' || c.status === 'personal').length;
  const waiting = calls.filter((c) => c.status === 'stored' && toMs(c.startedAtMs) >= now - CALL_WINDOW).length;
  const ctx = reachIndex(callRows);
  // Per-number labels (2026-10-12): the ledger counts people by the same rule as
  // Home / callWatch, so a hidden spam number is not an "open person".
  if (ex.labels) ctx.labels = ex.labels;
  const tctx = ex.labels ? { labels: ex.labels } : undefined;
  const people = new Map();
  (callRows || []).forEach((c) => { if (callNeedsYou(c, now, ctx)) { const k = callerKey(c); const at = toMs(c.startedAtMs); if (!people.has(k) || at < people.get(k)) people.set(k, at); } });
  (textRows || []).forEach((c) => { if (callNeedsYou(c, now, tctx)) { const k = callerKey(c); const at = toMs(c.startedAtMs); if (!people.has(k) || at < people.get(k)) people.set(k, at); } });
  // A HIDDEN number that came back (filed on a customer, or 3+ calls in 24 h)
  // is a person on Home's list (groupNeeds adds it) and was told once by
  // callWatch; counting people by callNeedsYou alone read "nothing fell
  // through" while Home showed that person (QA 2026-10-13).
  resurfacedNumbers(callRows, ex.labels, now).forEach((v) => {
    v.calls.forEach((c) => { const k = callerKey(c); const at = toMs(c.startedAtMs); if (!people.has(k) || at < people.get(k)) people.set(k, at); });
  });
  const open = people.size;
  const oldOpen = Array.from(people.values()).filter((at) => at && now - at > LEDGER_OLD_MS).length;
  const anomalies = [];
  if (!todays.length) anomalies.push('No calls were recorded today. A quiet phone looks exactly like a recorder that stopped.');
  if (waiting > 0) anomalies.push(waiting + ' recording' + (waiting === 1 ? '' : 's') + ' still waiting for a transcript.');
  if (oldOpen > 0) anomalies.push(oldOpen + ' ' + (oldOpen === 1 ? 'person has' : 'people have') + ' been waiting on you more than 3 days.');
  if (ex.lastPush && ex.lastPush.sent === 0) anomalies.push('The last alert reached 0 phones. Check that notifications are on for the CRM app.');
  if (ex.problems && ex.problems.length) anomalies.push('Pipeline: ' + ex.problems.slice(0, 2).join(' / '));
  const clear = open === 0 && !anomalies.length;
  const head = todays.length + ' call' + (todays.length === 1 ? '' : 's') + ' today, ' + noted + ' noted · ' + open + (open === 1 ? ' person' : ' people') + ' still need' + (open === 1 ? 's' : '') + ' you';
  return {
    ymd: today, calls: todays.length, noted, waiting, open, oldOpen, anomalies, clear,
    title: clear ? '🗒 Day check: nothing fell through' : '🗒 Day check: ' + open + (open === 1 ? ' person' : ' people') + ' still open' + (anomalies.length ? ' · ' + anomalies.length + ' warning' + (anomalies.length === 1 ? '' : 's') : ''),
    message: [head].concat(anomalies.map((a) => '⚠ ' + a)).concat(['Tap to open the Call Center, then mark this reviewed.']).join('\n').slice(0, 900),
    priority: anomalies.length ? 'high' : 'normal',
  };
}

/**
 * The email rung (2026-10-12, Jo): the THIRD tell of an item still open also
 * goes to Jo's own inbox, so a push nobody saw has a second channel (SMS is
 * blocked until A2P). Internal only; rung items = ladderRetells() output.
 * Returns null when nothing is on its last rung.
 */
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function ladderEmail(retells, now) {
  const last = (retells || []).filter((r) => r && r.rung >= LADDER_MAX);
  if (!last.length) return null;
  const seen = new Map();
  last.forEach((r) => { const k = r.key || r.id; if (!seen.has(k)) seen.set(k, r); });
  const people = Array.from(seen.values());
  const url = 'https://nobigdealwithjoedeal.com/pro/dashboard.html#/calls';
  const lines = people.slice(0, 12).map((p) => p.who + ' - ' + String(p.why).replace(/ - still open.*$/, ''));
  const subject = 'Still open: ' + people.length + (people.length === 1 ? ' person' : ' people') + ' waiting on you (' + etYmd(now) + ')';
  const text = ['These were pushed to your phone earlier today and are still open:', ''].concat(lines.map((l) => '- ' + l)).concat(['', 'Open the Call Center: ' + url, '', 'This is the last reminder; the morning brief lists anything still open.']).join('\n');
  const html = '<p>These were pushed to your phone earlier today and are still open:</p><ul>' + lines.map((l) => '<li>' + esc(l) + '</li>').join('') +
    '</ul><p><a href="' + url + '">Open the Call Center</a></p><p style="color:#666">This is the last reminder; the morning brief lists anything still open.</p>';
  return { subject, text, html, people: people.length };
}

/** The one alert (bell + push). null when there is nothing to say. */
function alertFor(needs, problems, now) {
  const items = needs || [], pr = problems || [];
  if (!items.length && !pr.length) return null;
  // One line per PERSON (Jo, 2026-10-02: "group them by customer"), the
  // newest item first; their other new calls ride as "+N more calls".
  const by = new Map();
  items.forEach((x) => {
    const k = x.key || x.id;
    if (!by.has(k)) by.set(k, Object.assign({}, x, { extra: 0 }));
    else { const g = by.get(k); g.extra++; if (/urgent/.test(x.why) && !/urgent/.test(g.why)) g.why = x.why; }
  });
  const n = Array.from(by.values()).map((g) => Object.assign({}, g, {
    why: g.why + (g.extra ? ' (+' + g.extra + ' more call' + (g.extra === 1 ? '' : 's') + ')' : ''),
  }));
  const parts = [];
  if (n.length) parts.push(n.length + (n.length === 1 ? ' person needs' : ' people need') + ' you');
  if (pr.some((p) => p.key !== 'sms_undelivered')) parts.push('call updates are behind');
  if (pr.some((p) => p.key === 'sms_undelivered')) parts.push('texts are not delivering');
  const lines = n.slice(0, 5).map((x) => '• ' + x.who + ' — ' + x.why).concat(n.length > 5 ? ['• +' + (n.length - 5) + ' more'] : []).concat(pr.map((x) => '⚠ ' + x.text));
  return {
    title: '📞 ' + parts.join(' · '),
    message: lines.join('\n').slice(0, 900),
    push: n.length ? n.slice(0, 2).map((x) => x.who + ' — ' + x.why).join('; ') + (n.length > 2 ? ' +' + (n.length - 2) + ' more' : '') : pr[0].text,
    priority: n.some((x) => /urgent/.test(x.why)) || pr.length ? 'high' : 'normal',
    day: etYmd(now),
    // One person on a phone call / text day → straight to their card in the
    // Call Center (call-center-view.js ?call=); anything else → the list.
    clickUrl: n.length === 1 && /^(call|text):/.test(n[0].id) ? callCardUrl(n[0].id.replace(/^(call|text):/, '')) : '/pro/dashboard.html#/calls',
  };
}
/** The Call Center opened on one call's card (call-center-view.js reads ?call=). */
const callCardUrl = (id) => '/pro/dashboard.html?call=' + encodeURIComponent(id) + '#/calls';

/** Business hours check (ET), so a late scheduler retry never pings at night. */
function inWatchHours(now) {
  const h = Number(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return h >= 8 && h <= 20;
}

module.exports = {
  CALL_WINDOW, STALE_RUN_MS, TRANSCRIPT_WAIT_MS, THURSDAY_STUCK_MS, PROBLEM_REPEAT_MS,
  SMS_REPEAT_MS, smsProblems, deliveryBySid, dailyLedger, ladderEmail, LADDER_GAP_MS, LADDER_MAX, ladderCandidates, ladderRetells, nextLadder,
  toMs, etYmd, callNeedsYou, labelOf, resurfacedNumbers, callerKey, reasonFor, reachIndex, isMissedCall, callCardUrl, newNeeds, pipelineProblems, problemsToTell, alertFor, inWatchHours,
};
