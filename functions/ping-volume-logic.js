'use strict';
/**
 * ping-volume-logic.js - how often "needs you" may buzz Jo's phone (2026-10-13,
 * audit F4 / F6 / F7 / F8, documentation/audit/PING-VOLUME-2026-10-13.md).
 * Pure; call-watch.js, call-center.js, morning-brief.js and thursday.js apply it.
 *
 * The problem it fixes: the ladder climbs per CALL and the alert groups per
 * PERSON, so one customer ringing six times produced 7 pushes + 4 emails in a
 * day; a number that hangs up every 20 minutes pushed at every run; the same
 * unchanged promise was emailed twice a day for a month.
 *
 * One rule, stated once - the person card:
 *   A person has ONE card a day. They are pushed about at most PERSON_PUSH_DAY_MAX
 *   times (plus one final sticky reminder) and emailed about at most once, however
 *   many calls they make. A new arrival of a kind of need that person was ALREADY
 *   pushed about today is folded into the next re-tell instead of buzzing again;
 *   a NEW kind of need (urgent after a routine call, a promise after a missed
 *   call) always pushes. Never dropped: a folded item stays on Home, in the
 *   bell, the 20:00 ledger and the brief - only the buzz is collapsed.
 *
 * Kinds: urgent | promise | due | insurance | missed (a known customer) |
 *        low (an unlabelled number with nothing but "unknown number" / "missed
 *        call") | thursday | hidden | other.
 */

const DAY = 86400000;
const PERSON_PUSH_DAY_MAX = 3;      // pushes about one person in an ET day (design: 3 pushes + 1 email)
const LOW_RE = /^(missed call|unknown number)/;

const etYmd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etHour = (ms) => Number(new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false })) % 24;
const toMs = (v) => {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v); return Number.isFinite(t) ? t : 0;
};

/** The kind of need an alert item is (see the header). */
function kindOf(x) {
  if (!x) return 'other';
  if (x.kind === 'thursday') return 'thursday';
  if (/^hidden:/.test(String(x.id || ''))) return 'hidden';
  const why = String(x.why || '');
  if (/^urgent/.test(why)) return 'urgent';
  if (/^you promised something/.test(why)) return 'promise';
  if (/^follow-up due/.test(why)) return 'due';
  if (/^insurance line/.test(why)) return 'insurance';
  if (/^missed call/.test(why)) return /^lead:/.test(String(x.key || '')) ? 'missed' : 'low';
  if (/^unknown number/.test(why)) return 'low';
  return 'other';
}
const isLow = (x) => kindOf(x) === 'low';

/** An entry for `key` that still describes TODAY's episode (handled since = a fresh start). */
function entryFor(pp, key, ymd, handledSinceMs) {
  const e = pp && pp[key];
  if (!e || e.ymd !== ymd) return null;
  if (handledSinceMs && toMs(e.firstAtMs) <= handledSinceMs) return null;
  return e;
}

/**
 * Immediate urgent pushes already sent today per person, read off the call rows
 * (call-center.js pushUrgent stamps urgentPushedAtMs; a FOLDED call carries
 * urgentFoldedAtMs and was not a push of its own). `handledSince` is the latest
 * time Jo handled anything of that person: pushes before it belong to a closed
 * episode and do not count against a new one.
 */
function personFacts(rows, nowMs, callerKey) {
  const today = etYmd(nowMs);
  const by = new Map();
  (rows || []).forEach((c) => {
    if (!c) return;
    const k = callerKey(c);
    if (!by.has(k)) by.set(k, { handledSince: 0, urgentAt: [] });
    const f = by.get(k);
    const h = toMs(c.handledAtMs);
    if (h > f.handledSince) f.handledSince = h;
    const u = toMs(c.urgentPushedAtMs);
    if (u && !c.urgentFoldedAtMs && etYmd(u) === today) f.urgentAt.push(u);
  });
  return by;
}

/**
 * Decide, for one watch run, what may BUZZ.
 *   items    = needs.concat(retells) (alert items: { id, key, kind, why, rung? })
 *   pp       = the persisted person-pings map (integrations/callWatch.personPings)
 *   facts    = personFacts(...)
 * Returns { alertItems, pushItems, lowDropped, entries } where
 *   alertItems - what the bell / push text lists (a low-value number already
 *                belled today is dropped: "bell once, then the brief says it")
 *   pushItems  - the items that earn a push; empty => the run is bell-only
 *   entries    - the updated person map, to be stored AFTER the push reached a phone
 */
function planPush({ items, pp, facts, nowMs, callerKey }) {
  const today = etYmd(nowMs);
  const alertItems = [], pushItems = [], lowDropped = [];
  const seenKind = new Map();              // key -> Set(kind) pushed so far THIS run
  const runCount = new Map();              // key -> pushes decided this run (one per person)
  (items || []).forEach((x) => {
    const key = x.key || x.id;
    const f = (facts && facts.get(key)) || { handledSince: 0, urgentAt: [] };
    const e = entryFor(pp, key, today, f.handledSince) || {};
    const k = kindOf(x);
    if (k === 'low') {
      // A number already belled today stays out of today's alerts entirely.
      if (e.lowBellYmd === today) { lowDropped.push(x); return; }
      alertItems.push(x);                // bell yes, push never
      return;
    }
    alertItems.push(x);
    const imm = f.urgentAt.filter((t) => t > f.handledSince).length;
    const total = (Number(e.n) || 0) + imm;
    const kinds = Object.assign({}, e.kinds || {});
    if (imm) kinds.urgent = kinds.urgent || Math.max.apply(null, f.urgentAt);
    const thisRun = seenKind.get(key) || new Set();
    const isRetell = Number(x.rung) >= 2;
    const isFinal = Number(x.rung) >= 3;
    let push = false;
    if (!kinds[k] && !thisRun.has(k)) push = true;                       // a NEW kind of need: always
    else if (isRetell && total + (runCount.get(key) || 0) < PERSON_PUSH_DAY_MAX) push = true;
    else if (isFinal && e.stickyYmd !== today) push = true;              // the last, sticky rung once a day
    if (push) { pushItems.push(x); thisRun.add(k); seenKind.set(key, thisRun); runCount.set(key, Math.max(runCount.get(key) || 0, 1)); }
  });
  return { alertItems, pushItems, lowDropped };
}

/**
 * Fold a finished run into the person map: `pushedKeys` = people a push that
 * REACHED a phone listed (a push that reached 0 devices does not count as
 * told), `belledLowKeys` = unlabelled numbers belled, `emailedKeys` = people
 * mailed. Returns a new map holding only today's entries.
 */
function applyRun({ pp, nowMs, pushItems, pushReached, belledLowKeys, emailedKeys, stickyKeys, facts }) {
  const today = etYmd(nowMs);
  const out = {};
  Object.keys(pp || {}).forEach((k) => { if (pp[k] && pp[k].ymd === today) out[k] = Object.assign({}, pp[k]); });
  const touch = (key) => {
    const f = (facts && facts.get(key)) || { handledSince: 0 };
    let e = out[key];
    if (e && f.handledSince && toMs(e.firstAtMs) <= f.handledSince) e = null;      // a closed episode
    if (!e) e = { ymd: today, n: 0, kinds: {}, firstAtMs: nowMs, lastAtMs: nowMs };
    out[key] = e;
    return e;
  };
  if (pushReached) {
    const per = new Map();
    (pushItems || []).forEach((x) => { const key = x.key || x.id; if (!per.has(key)) per.set(key, new Set()); per.get(key).add(kindOf(x)); });
    per.forEach((kinds, key) => {
      const e = touch(key);
      e.n = (Number(e.n) || 0) + 1; e.lastAtMs = nowMs;
      kinds.forEach((k) => { e.kinds[k] = nowMs; });
    });
    (stickyKeys || []).forEach((key) => { touch(key).stickyYmd = today; });
  }
  (belledLowKeys || []).forEach((key) => { touch(key).lowBellYmd = today; });
  (emailedKeys || []).forEach((key) => { touch(key).emailedYmd = today; });
  // Bound the document (a storm week touches a few hundred numbers).
  const keys = Object.keys(out);
  if (keys.length > 400) keys.sort((a, b) => toMs(out[a].lastAtMs) - toMs(out[b].lastAtMs)).slice(0, keys.length - 400).forEach((k) => { delete out[k]; });
  return out;
}

const emailedToday = (pp, key, nowMs, facts) => {
  const f = (facts && facts.get(key)) || { handledSince: 0 };
  const e = entryFor(pp, key, etYmd(nowMs), f.handledSince);
  return !!(e && e.emailedYmd === etYmd(nowMs));
};

// ── (c) F7: one email per CHANGE of the open list, not one per slot ──────────
/** A short signature of what a digest lists (ids + kind + due + the promise texts). */
function digestSig(items) {
  const parts = (items || []).map((i) => [i.kind || '', i.callId || i.leadId || '', i.due || '', (i.promises || []).join('~')].join('|')).sort();
  let h = 5381;
  const s = parts.join('\n');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return parts.length + ':' + (h >>> 0).toString(36);
}
/** True when `last` ({ ymd, sig }) already sent exactly this list today. */
function digestUnchanged(last, items, nowMs) {
  return !!(last && last.ymd === etYmd(nowMs) && last.sig && last.sig === digestSig(items));
}

// ── (b) F6: the one-line summary the brief carries for repeat low-value numbers ──
/**
 * Unlabelled numbers with 2+ open "unknown number" / "missed call" calls in the
 * last 36 h: [{ digits, n, lastAtMs, missed }]. callNeedsYou is the open test, so
 * handled / labelled-hidden numbers are not here.
 */
function quietNumbers(rows, nowMs, needsYou, ctx) {
  const by = new Map();
  (rows || []).forEach((c) => {
    if (!c || c.leadId || c.channel === 'text') return;
    if (toMs(c.startedAtMs) < nowMs - 36 * 3600000) return;
    if (!needsYou(c, nowMs, ctx)) return;
    if (c.urgent === true) return;
    const d = String(c.phoneDigits || '').replace(/\D/g, '').slice(-10);
    if (d.length !== 10) return;
    const e = by.get(d) || { digits: d, n: 0, lastAtMs: 0, missed: 0 };
    e.n++; if (c.status === 'short') e.missed++;
    e.lastAtMs = Math.max(e.lastAtMs, toMs(c.startedAtMs));
    by.set(d, e);
  });
  return Array.from(by.values()).filter((e) => e.n >= 2).sort((a, b) => b.n - a.n || b.lastAtMs - a.lastAtMs);
}
const pretty = (d) => '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
function quietNumberLines(list, failed) {
  const out = (list || []).slice(0, 5).map((q) => pretty(q.digits) + ' called ' + q.n + ' times in the last day' + (q.missed === q.n ? ' (hung up each time)' : '') + ' and is not labelled. Not pushed. Label it in the Call Center to silence it.');
  if ((list || []).length > 5) out.push('+' + (list.length - 5) + ' more repeat numbers.');
  if (failed) out.push('Could not check repeated unknown-number calls just now.');
  return out;
}

// ── (e) two pushes at 08:00 become one ───────────────────────────────────────
/** The call alert and the promise push of one run, as ONE push. */
function mergePush(alert, promisePush) {
  const title = String(alert.title || '').replace(/^📞 /, '') + ' · ' + promisePush.title;
  const body = (String(alert.push || '') + ' | ' + String(promisePush.body || '')).slice(0, 200);
  return { title, body };
}

// ── (d) F8: Thursday's own channels keep the 21:00-08:00 ET rule ─────────────
/** True between 21:00 and 07:59 ET: the same window callWatch's inWatchHours closes. */
const inQuietHours = (nowMs) => { const h = etHour(nowMs); return h >= 21 || h < 8; };
/**
 * Hold Thursday's push / email / SMS for a call that is not urgent and landed
 * in quiet hours. Her emergency path (route.urgent: an active leak, a customer
 * in danger) is never held. A held call is told by callWatch's first run of the
 * morning ("Thursday took it - not reviewed"), which is why it is safe to hold.
 */
const holdThursday = (route, nowMs) => !(route && route.urgent === true) && inQuietHours(nowMs);
/** callWatch must not repeat a call Thursday's own push already delivered. */
const thursdayAlreadyPushed = (row) => !!(row && row.notifyState && row.notifyState.push && (row.notifyState.push.sentAt || row.notifyState.push.status === 'sent'));

module.exports = {
  DAY, PERSON_PUSH_DAY_MAX, LOW_RE, etYmd, kindOf, isLow, personFacts, planPush, applyRun, emailedToday,
  digestSig, digestUnchanged, quietNumbers, quietNumberLines, mergePush,
  inQuietHours, holdThursday, thursdayAlreadyPushed,
};
