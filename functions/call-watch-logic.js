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

/** Mirror of home-attention.js callNeedsYou (kept in step by the test). */
function callNeedsYou(c, now) {
  const t = now == null ? Date.now() : now;
  if (!c || c.handledAtMs || c.status === 'personal') return false;
  if ((toMs(c.startedAtMs) || 0) < t - CALL_WINDOW) return false;
  if (c.urgent === true) return true;
  if ((c.promises || []).some((p) => p && p.who === 'jo')) return true;
  if (c.followUpDate && c.followUpDate <= etYmd(t)) return true;
  if (c.leadId) return false;
  if (c.bucket === 'insurance') return true;
  if (c.bucket === 'unknown') return c.status !== 'short' || c.direction === 'inbound';
  return false;
}

/** Why a call / text day needs Jo, in a few words. */
function reasonFor(c, now) {
  if (c.urgent === true) return 'urgent';
  if ((c.promises || []).some((p) => p && p.who === 'jo')) return 'you promised something';
  if (c.followUpDate && c.followUpDate <= etYmd(now)) return 'follow-up due';
  if (c.bucket === 'insurance') return 'insurance line, no customer on file';
  if (c.status === 'short' && c.direction === 'inbound') return 'missed call';
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

/**
 * New items since `sinceMs` that need Jo. calls / textDays: phone_calls /
 * phone_text_days docs (with id); thursday: thursday_calls docs (with id).
 */
function newNeeds(calls, textDays, thursday, sinceMs, now) {
  const out = [];
  (calls || []).forEach((c) => {
    if (!callNeedsYou(c, now)) return;
    const arrived = toMs(c.notedAtMs) || toMs(c.createdAtMs) || toMs(c.startedAtMs);
    if (arrived <= sinceMs) return;
    out.push({ id: 'call:' + c.id, key: callerKey(c), kind: 'call', who: who(c), why: reasonFor(c, now), at: toMs(c.startedAtMs) });
  });
  (textDays || []).forEach((c) => {
    if (!callNeedsYou(c, now)) return;
    const arrived = toMs(c.notedAtMs) || toMs(c.startedAtMs);
    if (arrived <= sinceMs) return;
    out.push({ id: 'text:' + c.id, key: callerKey(c), kind: 'text', who: who(c), why: reasonFor(c, now), at: toMs(c.startedAtMs) });
  });
  (thursday || []).forEach((t) => {
    if (!t || t.reviewed === true || t.status !== 'processed') return;
    const arrived = toMs(t.processedAt) || toMs(t.startedAt);
    if (arrived <= sinceMs || arrived < now - CALL_WINDOW) return;
    const td = String(t.from || '').replace(/\D/g, '').slice(-10);
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
  };
}

/** Business hours check (ET), so a late scheduler retry never pings at night. */
function inWatchHours(now) {
  const h = Number(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  return h >= 8 && h <= 20;
}

module.exports = {
  CALL_WINDOW, STALE_RUN_MS, TRANSCRIPT_WAIT_MS, THURSDAY_STUCK_MS, PROBLEM_REPEAT_MS,
  SMS_REPEAT_MS, smsProblems,
  toMs, etYmd, callNeedsYou, callerKey, reasonFor, newNeeds, pipelineProblems, problemsToTell, alertFor, inWatchHours,
};
