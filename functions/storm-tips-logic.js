/**
 * storm-tips-logic.js — pure rules for the storm-season tips email (2026-11-26).
 * No Firebase imports, so tests load it directly.
 *
 * WHO: homeowners who ticked "Also email me storm-season tips from Joe now and
 * then" on a guide page. submitPublicLead stores that on guide_copy_requests
 * as emailConsent: true + emailConsentAt + emailConsentVersion
 * 'guide-storm-tips-2026-11-26' (guide-copy-logic.js), plus an optional zip.
 * Several requests from one inbox are ONE subscriber (subscribersFrom below).
 *
 * WHAT (Joe, 2026-11-26):
 *   1. First contact is Joe pressing send. Nobody gets anything until he does,
 *      and the first email is always ISSUES[0] ('first-hello').
 *   2. After that Joe may put a subscriber on the schedule (per subscriber,
 *      from /pro/storm-tips). The schedule sends the next in-season issue that
 *      person has not had, no more often than the interval Joe sets.
 *   3. Never more than one storm-tips email per subscriber per 14 days
 *      (MIN_INTERVAL_DAYS), whoever presses what. Joe can set a longer
 *      interval, never a shorter one.
 *   4. A subscriber with a ZIP can be targeted by a real storm: Joe picks a
 *      storm_events row and only subscribers within STORM_RADIUS_MI of it are
 *      chosen. No ZIP = never chosen by a storm target, still gets the rest.
 *
 * Commercial email: the sender (storm-tips-email.js) runs every send through
 * email-suppression.js gateCommercialEmail (unsubscribe link, one-click
 * headers, postal address, suppression register) and MessagingControls.
 * Nothing here decides the gates; it decides WHO and WHICH issue.
 *
 * Copy rules (Joe's voice, plain): no insurance-outcome promises, never "we
 * handle the claim" (Kentucky), no "licensed" (say fully insured), makers'
 * warranty words only, no invented numbers. The issues below are DRAFTS for
 * Joe's approval; nothing sends until he turns it on.
 */
'use strict';

const SITE = 'https://nobigdealwithjoedeal.com';
const PHONE_DISPLAY = '(859) 420-7382';
const PHONE_TEL = 'tel:+18594207382';
const FROM = 'Joe Deal <jd@nobigdealwithjoedeal.com>';
const REPLY_TO = 'jd@nobigdealwithjoedeal.com';
const CONSENT_VERSION = 'guide-storm-tips-2026-11-26';
const SOURCE = 'storm-tips';

const DAY_MS = 86_400_000;
const MIN_INTERVAL_DAYS = 14;     // Joe, 2026-11-26: the hard floor
const MAX_INTERVAL_DAYS = 365;
const DEFAULT_INTERVAL_DAYS = 30;
const STORM_RADIUS_MI = 15;       // same "near you" honesty radius as storm texts
const MAX_PER_SEND = 200;         // one press of Send can never mail more than this
const MAX_PER_SWEEP = 50;         // one scheduled run, likewise

/**
 * The issues. `months` = calendar months (1-12) a SCHEDULED send may use it;
 * a manual send by Joe may use any issue. Order = the order a subscriber gets
 * them. `paras` are plain strings (no HTML from anywhere else); `link` is a
 * page on this site only.
 */
const ISSUES = Object.freeze([
  {
    id: 'first-hello',
    months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    subject: 'Storm tips from Joe: what I’d check first',
    heading: 'A few storm tips, as promised',
    paras: [
      'You asked for one of my homeowner guides and ticked the box for storm tips, so here is the first one. I’ll keep these short and I won’t send them often.',
      'Before the next storm: take a few dated photos of your roof, gutters and siding from the ground. If something changes later, you’ll have a clear before picture. My photo baseline sheet walks you through it.',
      'After hail or high wind: look from the ground, not from a ladder. Dents in gutters, downspouts, mailbox tops and the AC unit fins are the easiest clues. Missing or creased shingles and granules piling up at the downspouts are the next ones.',
      'If you see something and want a second set of eyes, I’ll come look. The inspection is free, and I’ll tell you straight what I see, even when that’s “you’re fine.”',
    ],
    link: { href: SITE + '/guides/hail-photo-baseline-sheet', text: 'The photo baseline sheet' },
  },
  {
    id: 'spring-hail-prep',
    months: [2, 3, 4, 5],
    subject: 'Hail season is close: 10 minutes now saves a headache later',
    heading: 'Before hail season',
    paras: [
      'Hail season around Cincinnati and Northern Kentucky usually picks up in spring. Ten minutes this week makes the rest of it easier.',
      'Clear the gutters and make sure the downspouts run away from the house. Trim branches that hang over the roof. Take your baseline photos if you haven’t yet.',
      'Find your homeowners policy and note your deductible, so you know your numbers before you need them. Your insurance company decides what a policy covers. I can only tell you what I see on the roof.',
    ],
    link: { href: SITE + '/guides/hail-photo-baseline-sheet', text: 'The photo baseline sheet' },
  },
  {
    id: 'after-a-storm',
    months: [3, 4, 5, 6, 7, 8, 9],
    subject: 'After a storm: the first 48 hours',
    heading: 'After a storm: the first 48 hours',
    paras: [
      'If a storm rolled through near you, here is what I’d do in the first couple of days.',
      'Stay off the roof. Walk around the house and take dated photos of anything that looks different: gutters, siding, window screens, the AC unit, anything on the ground.',
      'Check the attic or top-floor ceilings for drips or stains. If water is coming in, put a bucket under it and call me. A tarp is a short-term fix, and only when it’s safe to put one up.',
      'Whether to file a claim is your call. If it helps, I’ll inspect for free and give you my honest read in writing first. My storm claim guide explains how the process works in Kentucky and Ohio.',
    ],
    link: { href: SITE + '/guides/kentucky-ohio-storm-claim-guide', text: 'The storm claim guide (KY & OH)' },
  },
  {
    id: 'fall-gutters',
    months: [9, 10, 11],
    subject: 'Before winter: gutters, flashing and a quick look up',
    heading: 'A quick fall check',
    paras: [
      'Leaves are coming down, which makes this the best time to look at the things that cause winter leaks.',
      'Clean the gutters once most leaves have dropped, and check that the downspouts are clear all the way down. From the ground, look at the metal around the chimney and vents: lifted or rusty flashing is where a lot of winter leaks start.',
      'If you spot something you’re not sure about, send me a photo by text. I’ll tell you if it can wait.',
    ],
    link: { href: SITE + '/guides/home-care-warranty-card', text: 'The home care card' },
  },
  {
    id: 'winter-ice',
    months: [12, 1, 2],
    subject: 'Icicles, ice dams and what they’re telling you',
    heading: 'Winter: ice on the roof',
    paras: [
      'A few icicles are normal. A thick ridge of ice along the edge of the roof, called an ice dam, can push water back under the shingles.',
      'The usual cause is warm air from the house melting the snow up high, which then freezes again at the cold edge. Attic insulation and ventilation are what fix it, not chipping the ice off.',
      'Please don’t climb up or hack at the ice. If you see water stains inside after a freeze, call or text me and I’ll come take a look.',
    ],
    link: { href: SITE + '/guides/home-care-warranty-card', text: 'The home care card' },
  },
]);
const ISSUE_IDS = ISSUES.map((i) => i.id);
const FIRST_ISSUE_ID = ISSUES[0].id;

function issueById(id) { return ISSUES.find((i) => i.id === id) || null; }

function normEmail(e) { return String(e == null ? '' : e).trim().toLowerCase(); }
function isValidEmail(e) {
  return typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}
/** A US 5-digit ZIP (ZIP+4 is cut to 5), or '' for anything else. */
function cleanZip(z) {
  const m = /^\s*(\d{5})(?:-\d{4})?\s*$/.exec(String(z == null ? '' : z));
  return m ? m[1] : '';
}

/** Firestore Timestamp | Date | number | {_seconds} → ms, or 0. */
function toMs(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v._seconds === 'number') return v._seconds * 1000;
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return 0;
}

/** Joe's interval, clamped: never under the 14-day floor. Junk → the default. */
function cleanInterval(v) {
  const n = Number(v);
  if (!Number.isInteger(n)) return DEFAULT_INTERVAL_DAYS;
  return Math.min(MAX_INTERVAL_DAYS, Math.max(MIN_INTERVAL_DAYS, n));
}

/**
 * guide_copy_requests rows → one subscriber per inbox, only with a real
 * storm-tips yes of THIS wording version. The newest consenting row wins; a
 * ZIP is taken from the newest row that has one.
 * rows: [{ id, data }] → [{ key: normEmail, email, zip, consentAtMs, requestIds }]
 */
function subscribersFrom(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const d = (r && r.data) || {};
    if (d.emailConsent !== true || d.emailConsentVersion !== CONSENT_VERSION) continue;
    if (!isValidEmail(normEmail(d.email))) continue;
    if (d.alertSuppressed === 'duplicate' || d.alertSuppressed === 'volume') continue;
    const key = normEmail(d.email);
    const at = toMs(d.emailConsentAt) || toMs(d.createdAt);
    const zip = cleanZip(d.zip);
    const cur = by.get(key);
    if (!cur) {
      by.set(key, { key, email: key, zip, zipAtMs: zip ? at : 0, consentAtMs: at, requestIds: [r.id] });
      continue;
    }
    cur.requestIds.push(r.id);
    if (at > cur.consentAtMs) cur.consentAtMs = at;
    if (zip && at >= cur.zipAtMs) { cur.zip = zip; cur.zipAtMs = at; }
  }
  return [...by.values()].map((s) => ({ key: s.key, email: s.email, zip: s.zip, consentAtMs: s.consentAtMs, requestIds: s.requestIds }))
    .sort((a, b) => b.consentAtMs - a.consentAtMs);
}

/** Issues this subscriber's state says they already had. */
function sentIds(state) {
  const s = state || {};
  return Array.isArray(s.issuesSent) ? s.issuesSent.filter((x) => typeof x === 'string') : [];
}

/** Has the 14-day floor (or Joe's longer interval) passed since the last send? */
function intervalOk(state, nowMs, intervalDays) {
  const last = toMs((state || {}).lastSentAtMs);
  if (!last) return true;
  const days = Math.max(MIN_INTERVAL_DAYS, Number(intervalDays) || MIN_INTERVAL_DAYS);
  return nowMs - last >= days * DAY_MS;
}

/** Calendar month (1-12) in Eastern time: the service area's month. */
function easternMonth(nowMs) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'numeric' }).format(new Date(nowMs));
  return Number(s);
}

/** The next issue the SCHEDULE may send: first unsent, in season, in order. null = nothing due. */
function nextScheduledIssue(state, nowMs) {
  const had = new Set(sentIds(state));
  if (!had.has(FIRST_ISSUE_ID)) return null; // the schedule never makes first contact
  const month = easternMonth(nowMs);
  return ISSUES.find((i) => !had.has(i.id) && i.months.indexOf(month) !== -1) || null;
}

/**
 * Can Joe's manual send give `issueId` to this subscriber now?
 * → { ok, reason }. The first email anyone gets is always FIRST_ISSUE_ID.
 */
function manualVerdict(state, issueId, nowMs) {
  if (!issueById(issueId)) return { ok: false, reason: 'unknown_issue' };
  const had = sentIds(state);
  if ((state || {}).stopped === true) return { ok: false, reason: 'stopped' };
  if (!had.length && issueId !== FIRST_ISSUE_ID) return { ok: false, reason: 'needs_first_hello' };
  if (had.indexOf(issueId) !== -1) return { ok: false, reason: 'already_sent' };
  if (!intervalOk(state, nowMs, MIN_INTERVAL_DAYS)) return { ok: false, reason: 'too_soon' };
  return { ok: true, reason: null };
}

/** Is the schedule allowed to send to this subscriber now? → { ok, reason, issue } */
function scheduledVerdict(state, nowMs, intervalDays) {
  const s = state || {};
  if (s.stopped === true) return { ok: false, reason: 'stopped', issue: null };
  if (s.scheduleOn !== true) return { ok: false, reason: 'not_on_schedule', issue: null };
  if (!sentIds(s).length) return { ok: false, reason: 'needs_first_hello', issue: null };
  if (!intervalOk(s, nowMs, intervalDays)) return { ok: false, reason: 'too_soon', issue: null };
  const issue = nextScheduledIssue(s, nowMs);
  if (!issue) return { ok: false, reason: 'nothing_in_season', issue: null };
  return { ok: true, reason: null, issue };
}

function haversineMi(la1, lo1, la2, lo2) {
  const R = 3958.8, dLa = (la2 - la1) * Math.PI / 180, dLo = (lo2 - lo1) * Math.PI / 180;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * Math.PI / 180) * Math.cos(la2 * Math.PI / 180) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Is this subscriber near the storm? zipCoords: (zip) → [lat, lon] | null
 * (storm-watch.js's table). No ZIP or an unmappable one = not near.
 */
function nearStorm(sub, event, zipCoords) {
  if (!sub || !sub.zip || !event || typeof zipCoords !== 'function') return false;
  const lat = Number(event.lat), lon = Number(event.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const c = zipCoords(sub.zip);
  if (!c) return false;
  return haversineMi(c[0], c[1], lat, lon) <= STORM_RADIUS_MI;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The email for one issue. Nothing a visitor typed is in it: every word comes
 * from ISSUES. The suppression gate's footer (unsubscribe + postal address) is
 * added by the sender with applyFooter, before </body>.
 * → { subject, html, text }
 */
function renderIssue(issueId) {
  const i = issueById(issueId);
  if (!i) throw new Error('unknown storm-tips issue: ' + issueId);
  const paras = i.paras.map((p) => '      <p>' + esc(p) + '</p>').join('\n');
  const link = i.link ? `\n      <p><a href="${esc(i.link.href)}" style="color:#BD5728; font-weight:600;">${esc(i.link.text)} &rarr;</a></p>` : '';
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: 'Barlow','Segoe UI',Roboto,'Helvetica Neue',sans-serif; line-height:1.6; color:#333; background:#f5f5f5; margin:0; }
    .container { max-width:600px; margin:0 auto; background:#fff; border-radius:8px; overflow:hidden; }
    .header { background:#1a3057; color:#fff; padding:26px 20px; text-align:center; }
    .header h1 { margin:0; font-size:22px; font-weight:700; }
    .header p { margin:6px 0 0; font-size:13px; opacity:.9; }
    .content { padding:28px 24px; color:#333; }
    .cta-button { display:inline-block; background:#BD5728; color:#fff !important; padding:13px 28px; border-radius:6px; text-decoration:none; font-weight:700; font-size:16px; margin:16px 0; }
    .muted { color:#666; font-size:14px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>${esc(i.heading)}</h1>
      <p>Storm tips from Joe &middot; No Big Deal Home Solutions</p>
    </div>
    <div class="content">
      <p>Hi there,</p>
${paras}${link}
      <p style="text-align:center;">
        <a class="cta-button" href="${SITE}/inspect">Book a free inspection</a>
      </p>
      <p class="muted" style="text-align:center;">Or call or text me at <a href="${PHONE_TEL}" style="color:#BD5728;">${PHONE_DISPLAY}</a>, or just reply to this email.</p>
      <p style="margin-top:22px;">&mdash; Joe<br><span class="muted">No Big Deal Home Solutions</span></p>
      <p class="muted">You’re getting this because you ticked “email me storm-season tips” when you asked for one of my guides. One click below stops them.</p>
    </div>
  </div>
</body>
</html>`;
  const text = [
    i.heading, '', 'Hi there,', '',
    ...i.paras.flatMap((p) => [p, '']),
    i.link ? i.link.text + ': ' + i.link.href : '',
    'Book a free inspection: ' + SITE + '/inspect',
    'Or call or text me at ' + PHONE_DISPLAY + ', or just reply to this email.',
    '', '- Joe', 'No Big Deal Home Solutions', '',
    'You’re getting this because you ticked "email me storm-season tips" when you asked for one of my guides.',
  ].join('\n');
  return { subject: i.subject, html, text };
}

/** "jo***@ex***.com" for the screen and logs. */
function maskEmail(email) {
  const e = normEmail(email);
  const at = e.indexOf('@');
  if (at < 1) return '***';
  const dot = e.lastIndexOf('.');
  const dom = e.slice(at + 1, dot > at ? dot : undefined);
  return e.slice(0, 2) + '***@' + dom.slice(0, 2) + '***' + (dot > at ? e.slice(dot) : '');
}

module.exports = {
  SITE, FROM, REPLY_TO, CONSENT_VERSION, SOURCE, DAY_MS,
  MIN_INTERVAL_DAYS, MAX_INTERVAL_DAYS, DEFAULT_INTERVAL_DAYS, STORM_RADIUS_MI, MAX_PER_SEND, MAX_PER_SWEEP,
  ISSUES, ISSUE_IDS, FIRST_ISSUE_ID,
  issueById, normEmail, isValidEmail, cleanZip, toMs, cleanInterval, subscribersFrom, sentIds,
  intervalOk, easternMonth, nextScheduledIssue, manualVerdict, scheduledVerdict,
  haversineMi, nearStorm, renderIssue, maskEmail,
};
