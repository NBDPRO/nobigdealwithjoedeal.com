/**
 * functions/send-window.js — the ONE customer send window (Joe, 2026-11-22)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An AUTOMATED customer email or text goes only between START_H (08:00,
 * inclusive) and END_H (20:00, exclusive) in the RECIPIENT's local time.
 * Outside it, nothing is sent and nothing is claimed: the sweep leaves the
 * item eligible and sends it on its first run inside the window
 * (documentation/audit/BOTS-AGENTS-SCHEDULES-REVIEW-2026-11-22.md §3.8).
 *
 * Stricter than the TCPA texting hours the callers already check
 * (sms-send-window.js, 08:00–21:00 plus the 8pm states): those stay as they
 * are for the rep's own texts; this one is for automations.
 *
 * WHERE IS THE RECIPIENT? sms-send-window.js recipientWindow() already maps a
 * record's tz / state / ZIP / "…, ST 12345" address tail to IANA zones (a
 * split state with no narrowing ZIP must clear EVERY zone it has). Reused, not
 * copied. Only when the record says nothing does the company's own zone
 * decide (agent-mcp-logic.js companyTimeZone: companyProfile.timezone /
 * timeZone / brand.timezone, then agent_settings.timezone for a company with
 * no profile doc yet; readCompanyZone reads both), then America/New_York. Lat/lng is not used: no helper maps it, and a longitude
 * band is wrong exactly in KY / IN / TN.
 *
 * WHO IS EXEMPT? Only a caller that says so with an explicit marker
 * (isExempt): 'exempt:internal' (the owner's / staff's own alerts),
 * 'exempt:transactional' (an instant answer to what the recipient just did:
 * the request ack, a code they asked for) and 'exempt:manual' (a person
 * pressed send; their path keeps its own TCPA hours). Anything else — an
 * absent marker included — is held to the window. guardTwilio applies it, so
 * a text path that forgets the recipient is still refused at 3am.
 *
 * ONE ANSWER PER SEND: a caller that checks the window before a one-time
 * claim passes the SAME nowMs and companyProfile on to guardTwilio
 * (create(msg, { recipient, companyProfile, nowMs })), so the central check
 * can never refuse what the pre-check already claimed. companyProfile: null
 * there means "decided: no company zone", not "go and read one".
 *
 * No tenant override: the MessagingControls docs hold no quiet hours today, so these
 * constants are the one source. Pure except readCompanyZone / profileFor (one
 * read each, never throw) and the clock seam nowMs(), which reads
 * sms-outbox-guard.js's (tests already pin that one).
 *
 * Tested in tests/send-window-2026-11-22.test.js.
 */
'use strict';

const Recipient = require('./sms-send-window');
const Outbox = require('./sms-outbox-guard');

const START_H = 8;
const END_H = 20;
const DEFAULT_TZ = 'America/New_York';
const STEP_MS = 15 * 60 * 1000;           // every real zone offset is a multiple of 15 minutes
const MAX_LOOKAHEAD_MS = 3 * 86_400_000;  // an empty intersection of zones answers null, never loops

const EXEMPT = Object.freeze(['exempt:internal', 'exempt:transactional', 'exempt:manual']);

const _fmt = new Map();
function formatter(tz) {
  let f = _fmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
    _fmt.set(tz, f);
  }
  return f;
}

function validTz(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try { formatter(tz); return true; } catch (_) { return false; }
}

/** The company's own IANA zone, or ''. The fields are agent-mcp-logic.js companyTimeZone's (reused, read-only). */
function companyTz(profile) {
  const z = require('./agent-mcp-logic').companyTimeZone(profile || {}, false, null);
  return z.set && validTz(z.tz) ? z.tz : '';
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); if (t.unref) t.unref(); })])
    .finally(() => clearTimeout(t));
}

/**
 * The company's zone as a profile-like { timezone } (or null): companyProfile/{id},
 * else agent_settings/{id}.timezone (agent-mcp.js writes it there while a company
 * has no profile doc). Never throws; unreadable = null (then America/New_York).
 */
async function readCompanyZone(db, companyId, timeoutMs) {
  if (!db || !companyId) return null;
  const ms = timeoutMs || 4000;
  const read = (p) => withTimeout(db.doc(p).get(), ms).then((s) => (s && s.exists ? (s.data() || {}) : null)).catch(() => null);
  try {
    const [profile, settings] = await Promise.all([read('companyProfile/' + String(companyId)), read('agent_settings/' + String(companyId))]);
    const z = require('./agent-mcp-logic').companyTimeZone(profile || {}, false, settings && settings.timezone);
    return z.set && validTz(z.tz) ? { timezone: z.tz } : null;
  } catch (_) { return null; }
}

/** The company zone only when the record has no location of its own (no read otherwise). */
async function profileFor(db, rec, companyId, timeoutMs) {
  if (Recipient.recipientWindow(rec || {}).basis !== 'default') return null;
  return readCompanyZone(db, companyId, timeoutMs);
}

/**
 * Every zone the recipient may be in.
 * @returns {{zones: string[], basis: 'tz'|'zip'|'state'|'company'|'default', state: string}}
 */
function recipientZones(rec, companyProfile) {
  const w = Recipient.recipientWindow(rec || {});
  if (w.basis !== 'default') return { zones: w.zones.slice(), basis: w.basis, state: w.state };
  const c = companyTz(companyProfile);
  if (c) return { zones: [c], basis: 'company', state: '' };
  return { zones: [DEFAULT_TZ], basis: 'default', state: '' };
}

/** The recipient's (first) zone as one IANA name. */
function recipientTz(rec, companyProfile) {
  return recipientZones(rec, companyProfile).zones[0];
}

function hourIn(ms, tz) {
  const h = formatter(tz).formatToParts(new Date(ms)).find((p) => p.type === 'hour');
  return h ? Number(h.value) % 24 : NaN;
}

const zonesOf = (tz) => (Array.isArray(tz) ? tz : [tz]).filter(validTz);

/** Inside [START_H, END_H) in EVERY zone given (a string or an array)? An unknown zone is not inside. */
function inWindow(nowMs, tz) {
  const zones = zonesOf(tz);
  if (!zones.length || !Number.isFinite(Number(nowMs))) return false;
  return zones.every((z) => { const h = hourIn(Number(nowMs), z); return h >= START_H && h < END_H; });
}

/** The first instant at or after nowMs inside the window (DST-safe: it walks real instants). null = none in 3 days. */
function nextOpenMs(nowMs, tz) {
  const t0 = Number(nowMs);
  if (!Number.isFinite(t0) || !zonesOf(tz).length) return null;
  if (inWindow(t0, tz)) return t0;
  for (let t = Math.floor(t0 / STEP_MS) * STEP_MS + STEP_MS; t <= t0 + MAX_LOOKAHEAD_MS; t += STEP_MS) {
    if (inWindow(t, tz)) return t;
  }
  return null;
}

/** May an automated message reach this recipient at nowMs? */
function check(nowMs, rec, companyProfile) {
  const r = recipientZones(rec, companyProfile);
  const ok = inWindow(nowMs, r.zones);
  return { ok, zones: r.zones, basis: r.basis, nextOpenMs: ok ? Number(nowMs) : nextOpenMs(nowMs, r.zones) };
}

function isExempt(marker) {
  return typeof marker === 'string' && EXEMPT.indexOf(marker) !== -1;
}

/** The clock: sms-outbox-guard.js's seam, read at call time. */
function nowMs() {
  return Outbox.nowMs();
}

module.exports = {
  START_H, END_H, DEFAULT_TZ, EXEMPT,
  validTz, companyTz, readCompanyZone, profileFor, recipientZones, recipientTz, inWindow, nextOpenMs, check, isExempt, nowMs,
};
