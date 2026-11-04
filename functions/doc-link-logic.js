'use strict';
/**
 * doc-link-logic.js — pure rules for the Secure Document Link (2026-11-04).
 * No firebase, no I/O: unit-tested in tests/doc-link-2026-11-04.test.js.
 *
 * A "secure link" is a report_share_tokens doc (kind lead_document) minted with
 * purpose 'secure_doc'. It adds, on top of the existing tracked PDF link: an
 * optional password, a per-view log, "opened" (not just "fetched") counting,
 * time with the page open, device class, and one 24h reminder to Jo.
 *
 * Everything is dark behind SECURE_DOC_LINK_ENABLED (master) and
 * DOC_LINK_FOLLOWUP_ENABLED (the reminder sweep). Nothing here contacts a
 * customer.
 */
const crypto = require('crypto');
const DV = require('./deal-view-logic');

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const MIN_MS = 60000;

// ── flags ────────────────────────────────────────────────────────────────
// DOC_LINK_FOLLOWUP_ENABLED is read in doc-link-followup.js.
const secureLinkEnabled = () => process.env.SECURE_DOC_LINK_ENABLED === 'true';

// ── expiry ───────────────────────────────────────────────────────────────
const DEFAULT_EXPIRY_DAYS = 14;
const MAX_EXPIRY_DAYS = 90;
const EXPIRY_CHOICES = [1, 7, 14, 30];
function expiryDays(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_EXPIRY_DAYS;
  return Math.min(n, MAX_EXPIRY_DAYS);
}

// ── password (scrypt, per-link salt, constant-time compare) ──────────────
const PW_MIN = 6;
const PW_MAX = 64;
const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no 0/O/1/I
const SCRYPT = { alg: 'scrypt', N: 32768, r: 8, p: 1, keylen: 32 };
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** 8 random characters, shown to Jo as ABCD-EFGH. 256 % 32 === 0, so unbiased. */
function generatePassword() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (const b of bytes) s += PW_ALPHABET[b % PW_ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}

/** Same rule at hash time and verify time. A generated-shape code is case/hyphen-insensitive. */
function normalizePassword(v) {
  const s = String(v == null ? '' : v).trim();
  const bare = s.replace(/[-\s]/g, '').toUpperCase();
  if (/^[A-HJ-NP-Z2-9]{8}$/.test(bare)) return bare;
  return s;
}
function passwordOk(v) {
  const s = normalizePassword(v);
  return s.length >= PW_MIN && s.length <= PW_MAX;
}

// scrypt at N=32768 holds ~32 MB; the function has 256 MiB and concurrency 40.
let _active = 0;
const _queue = [];
function _slot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => {
        _active--;
        const next = _queue.shift();
        if (next) next();
      });
    };
    if (_active < 2) run(); else _queue.push(run);
  });
}
function _scrypt(plain, salt, p) {
  return _slot(() => new Promise((resolve, reject) => {
    crypto.scrypt(plain, salt, p.keylen, { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT_MAXMEM }, (e, k) => (e ? reject(e) : resolve(k)));
  }));
}

/** @returns {Promise<{passwordHash:string,passwordSalt:string,passwordParams:object}>} */
async function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const key = await _scrypt(Buffer.from(normalizePassword(plain), 'utf8'), salt, SCRYPT);
  return {
    passwordHash: key.toString('base64'),
    passwordSalt: salt.toString('base64'),
    passwordParams: Object.assign({}, SCRYPT),
  };
}

/** Constant-time. A malformed record or out-of-bounds params never verifies. */
async function verifyPassword(plain, rec) {
  try {
    const r = rec || {};
    const p = r.passwordParams || {};
    if (p.alg !== 'scrypt' || p.N !== SCRYPT.N || p.r !== SCRYPT.r || p.p !== SCRYPT.p || p.keylen !== SCRYPT.keylen) return false;
    const salt = Buffer.from(String(r.passwordSalt || ''), 'base64');
    const want = Buffer.from(String(r.passwordHash || ''), 'base64');
    if (salt.length !== 16 || want.length !== SCRYPT.keylen) return false;
    const got = await _scrypt(Buffer.from(normalizePassword(plain), 'utf8'), salt, p);
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (_) { return false; }
}

// ── per-token lockout: 5 tries per 15 min, then a 15 min lock ────────────
const PW_MAX_TRIES = 5;
const PW_WINDOW_MS = 15 * MIN_MS;
const PW_LOCK_MS = 15 * MIN_MS;
const _n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Reserve one attempt BEFORE checking the password (so parallel guesses cannot
 * exceed the budget). Returns { allowed, retryAfterMs, patch, willLock }.
 * willLock = this is the 5th try: if it fails, the link is locked and Jo is told.
 */
function reserveAttempt(tok, nowMs) {
  const t = tok || {};
  const lockedUntil = _n(t.pwLockedUntilMs);
  if (lockedUntil > nowMs) return { allowed: false, retryAfterMs: lockedUntil - nowMs, patch: null, willLock: false };
  let count = _n(t.failedPwCount);
  let start = _n(t.pwWindowStartMs);
  if (!start || nowMs - start >= PW_WINDOW_MS || lockedUntil) { count = 0; start = nowMs; }
  count += 1;
  const patch = { failedPwCount: count, pwWindowStartMs: start, pwLockedUntilMs: 0 };
  const willLock = count >= PW_MAX_TRIES;
  if (willLock) patch.pwLockedUntilMs = nowMs + PW_LOCK_MS;
  return { allowed: true, retryAfterMs: 0, patch, willLock };
}
const clearAttempts = () => ({ failedPwCount: 0, pwWindowStartMs: 0, pwLockedUntilMs: 0 });

// ── unlock proof in the __session cookie ─────────────────────────────────
// Hosting forwards ONLY a cookie named __session to a rewritten function
// (firebase.google.com/docs/hosting/manage-cache). The value is signed with a
// per-link random key stored on the token doc (unlockKey), so no new secret
// has to exist. One cookie can carry proofs for several links.
const UNLOCK_TTL_MS = 2 * HOUR_MS;
const COOKIE_NAME = '__session';
function _sig(key, token, exp) {
  return crypto.createHmac('sha256', String(key)).update(token + '|' + exp).digest('base64url');
}
function mintUnlockEntry(token, unlockKey, nowMs) {
  const exp = nowMs + UNLOCK_TTL_MS;
  return token.slice(0, 10) + ':' + exp + ':' + _sig(unlockKey, token, exp);
}
function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  });
  return out;
}
function _entries(cookieHeader) {
  const v = parseCookies(cookieHeader)[COOKIE_NAME] || '';
  return v.split('~').filter(Boolean).slice(0, 8);
}
function isUnlocked(cookieHeader, token, unlockKey, nowMs) {
  if (!unlockKey) return false;
  return _entries(cookieHeader).some((e) => {
    const [t10, exp, sig] = e.split(':');
    if (t10 !== token.slice(0, 10) || !(Number(exp) > nowMs) || !sig) return false;
    const want = Buffer.from(_sig(unlockKey, token, exp));
    const got = Buffer.from(sig);
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  });
}
/** Set-Cookie value: keeps other links' still-live entries, replaces this link's. */
function unlockCookie(cookieHeader, token, unlockKey, nowMs) {
  const keep = _entries(cookieHeader).filter((e) => e.split(':')[0] !== token.slice(0, 10) && Number(e.split(':')[1]) > nowMs).slice(-4);
  keep.push(mintUnlockEntry(token, unlockKey, nowMs));
  return COOKIE_NAME + '=' + keep.join('~') + '; Max-Age=' + Math.floor(UNLOCK_TTL_MS / 1000)
    + '; Path=/report; HttpOnly; Secure; SameSite=Lax';
}

// ── device class (no raw UA is ever stored) ──────────────────────────────
function parseDevice(ua) {
  const s = String(ua || '');
  if (!s) return { device: 'unknown', os: 'other', browser: 'other' };
  let device = 'desktop';
  let os = 'other';
  if (/iPad/i.test(s)) { device = 'tablet'; os = 'iOS'; }
  else if (/iPhone|iPod/i.test(s)) { device = 'mobile'; os = 'iOS'; }
  else if (/Android/i.test(s)) { device = /Mobile/i.test(s) ? 'mobile' : 'tablet'; os = 'Android'; }
  else if (/Windows/i.test(s)) os = 'Windows';
  else if (/Macintosh|Mac OS X/i.test(s)) os = 'macOS';
  else if (/Linux|X11|CrOS/i.test(s)) os = 'Linux';
  else device = 'unknown';
  let browser = 'other';
  if (/EdgiOS|EdgA|Edg\//.test(s)) browser = 'Edge';
  else if (/FxiOS|Firefox/.test(s)) browser = 'Firefox';
  else if (/CriOS|Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  return { device, os, browser };
}

// ── open / ping accounting ───────────────────────────────────────────────
const OPEN_VISIBLE_SECONDS = 3;
const OPEN_MIN_ELAPSED_MS = 2500;
const PING_MAX_SECONDS = 60;
const PING_SLACK_SECONDS = 5;
const VIEW_CAP_SECONDS = 4 * 3600;
const READING_NOW_SECONDS = 10;
const READING_COOLDOWN_MS = 2 * HOUR_MS;
const FOLLOWUP_AFTER_MS = 24 * HOUR_MS;
const FOLLOWUP_STALE_MS = 7 * DAY_MS;
const VIEW_TTL_DAYS = 180;

/** A scanner that never keeps the page visible, or a scripted instant POST, is not an open. */
function shouldPromoteOpen(visibleSeconds, elapsedMsSinceFetch) {
  const v = Number(visibleSeconds);
  return Number.isFinite(v) && v >= OPEN_VISIBLE_SECONDS && Number(elapsedMsSinceFetch) >= OPEN_MIN_ELAPSED_MS;
}

/** Seconds to add for one ping: <= 60, <= wall clock since the last ping + 5 s, <= what is left of the 4 h cap. */
function clampPing(claimed, elapsedMs, alreadySeconds) {
  let s = Math.floor(Number(claimed));
  if (!Number.isFinite(s) || s <= 0) return 0;
  s = Math.min(s, PING_MAX_SECONDS);
  const el = Number(elapsedMs);
  if (!Number.isFinite(el) || el < 0) return 0;
  s = Math.min(s, Math.ceil(el / 1000) + PING_SLACK_SECONDS);
  const room = VIEW_CAP_SECONDS - Math.max(0, Math.floor(_n(alreadySeconds)));
  return Math.max(0, Math.min(s, room));
}

const isBot = (ua) => DV.isPreviewBot(ua);

// ── 24 h reminder decision ───────────────────────────────────────────────
// Stages after the estimate (mirrors docs/pro/js/estimate-followups.js PAST_ESTIMATE).
const MOVED_ON = ['contract_signed', 'job_created', 'permit_pulled', 'materials_ordered',
  'materials_delivered', 'crew_scheduled', 'install_in_progress', 'install_complete', 'final_photos',
  'deductible_collected', 'final_payment', 'collections', 'closed', 'lost', 'warranty_claim',
  'warranty_scheduled', 'warranty_repaired', 'service_approved', 'loan_approved',
  'approved', 'in progress', 'complete', 'closed won', 'closed lost'];
function ms(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  const t = Date.parse(v); return Number.isFinite(t) ? t : 0;
}
/**
 * @returns {{action:'file'|'wait'|'skip', clear:boolean, reason:string}}
 * clear = take the due time off the token (decided for good).
 */
function followUpDecision(tok, lead, nowMs) {
  const t = tok || {};
  const due = _n(t.followUpDueAtMs);
  if (!due) return { action: 'skip', clear: false, reason: 'no_due' };
  if (due > nowMs) return { action: 'wait', clear: false, reason: 'not_due' };
  if (t.followUpFiledAt) return { action: 'skip', clear: true, reason: 'already_filed' };
  if (t.purpose !== 'secure_doc') return { action: 'skip', clear: true, reason: 'not_secure' };
  if (nowMs - due > FOLLOWUP_STALE_MS) return { action: 'skip', clear: true, reason: 'stale' };
  if ((t.status && t.status !== 'active') || t.revokedAt) return { action: 'skip', clear: true, reason: 'revoked' };
  const exp = ms(t.expiresAt);
  if (exp && exp < nowMs) return { action: 'skip', clear: true, reason: 'expired' };
  const l = lead || null;
  if (!l || l.deleted === true || l.isDeleted === true) return { action: 'skip', clear: true, reason: 'no_lead' };
  if (!t.ownerUid || l.userId !== t.ownerUid) return { action: 'skip', clear: true, reason: 'owner_mismatch' };
  const stage = String(l.stage || l.status || '').trim().toLowerCase();
  if (stage && MOVED_ON.includes(stage)) return { action: 'skip', clear: true, reason: 'moved_on' };
  const first = ms(t.firstOpenedAt) || (due - FOLLOWUP_AFTER_MS);
  if (ms(l.lastEstimateNudgeAt) > first) return { action: 'skip', clear: true, reason: 'nudged' };
  // lastInboundAt (inbound-stamp.js): the customer's own text or portal message.
  // A phone call is not recorded there, so this is a nudge, not a claim.
  if (ms(l.lastInboundAt) > first) return { action: 'skip', clear: true, reason: 'replied' };
  return { action: 'file', clear: false, reason: 'due' };
}

// ── copy ─────────────────────────────────────────────────────────────────
function fmtDate(msv, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(msv));
  } catch (_) { return new Date(msv).toISOString().slice(0, 10); }
}
function fmtWhen(msv, tz) {
  try {
    const z = tz || 'America/New_York';
    const day = new Intl.DateTimeFormat('en-US', { timeZone: z, weekday: 'long' }).format(new Date(msv));
    const time = new Intl.DateTimeFormat('en-US', { timeZone: z, hour: 'numeric', minute: '2-digit' }).format(new Date(msv));
    return day + ' at ' + time.replace(' AM', ' am').replace(' PM', ' pm');
  } catch (_) { return new Date(msv).toISOString(); }
}

/** Jo's approved wording, verbatim for NBD. Other tenants get their own names in the same sentence. */
function trackingNotice(o) {
  const x = o || {};
  const brand = String(x.brand || 'No Big Deal').trim() || 'No Big Deal';
  const rep = String(x.rep || 'Joe').trim() || 'Joe';
  return 'This is a private link to your estimate from ' + brand + '. It\'s tracked: ' + rep
    + ' can see when it\'s opened, how many times and for how long, so he knows when to follow up. It expires on '
    + fmtDate(x.expiresAtMs, x.tz) + '.';
}

function minutesLabel(seconds) {
  const s = Math.max(0, Math.floor(_n(seconds)));
  if (s < 60) return s + ' sec';
  return 'about ' + Math.round(s / 60) + ' min';
}

function reminderCopy(o) {
  const x = o || {};
  const who = String(x.name || '').trim() || 'Your customer';
  const doc = String(x.docLabel || 'the estimate').trim();
  const views = Math.max(1, Math.floor(_n(x.openCount)));
  return {
    title: (who + ' opened the estimate and has gone quiet').slice(0, 140),
    text: who + ' opened "' + doc + '" on ' + fmtWhen(x.firstOpenedAtMs, x.tz) + ' (' + views
      + (views === 1 ? ' view, ' : ' views, ') + minutesLabel(x.readSeconds)
      + ' with the page open). I don\'t see a reply in the CRM. Good time for a call. Nothing was sent to the customer.',
  };
}

// ── customer pages (strict CSP: external script and stylesheet only) ─────
const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">'
  + '<meta name="referrer" content="no-referrer"><title>Your document</title>'
  + '<link rel="stylesheet" href="/pro/css/doc-link-view.css">';

function shellHtml(o) {
  const x = o || {};
  const base = '/report/' + esc(x.token);
  return HEAD
    + '<meta name="nbd-doc-token" content="' + esc(x.token) + '"><meta name="nbd-doc-view" content="' + esc(x.viewId) + '">'
    + '<meta name="nbd-doc-ping" content="/api/doc-link-ping">'
    + '<script src="/pro/js/doc-link-view.js" defer></script></head><body class="dl">'
    + '<header class="dl-bar"><p class="dl-notice">' + esc(x.notice) + '</p></header>'
    + '<main class="dl-main"><h1 class="dl-title">' + esc(x.docLabel || 'Your document') + '</h1>'
    + '<p><a class="dl-btn" id="dlOpen" href="' + base + '/file?v=' + esc(x.viewId) + '">Open full document</a></p>'
    + '<iframe class="dl-frame" title="Document" src="' + base + '/file?v=' + esc(x.viewId) + '"></iframe>'
    + '</main></body></html>';
}

function passwordHtml(o) {
  const x = o || {};
  const msg = x.locked ? 'Too many tries. Please wait a few minutes, or ask for a fresh link.'
    : (x.wrong ? 'That code did not match. Please try again.' : '');
  return HEAD + '</head><body class="dl"><main class="dl-main"><h1 class="dl-title">Enter your code</h1>'
    + '<p>This document is protected. Enter the code you were given.</p>'
    + (msg ? '<p class="dl-err" role="alert">' + esc(msg) + '</p>' : '')
    + '<form method="post" action="/report/' + esc(x.token) + '/unlock" autocomplete="off">'
    + '<input class="dl-input" type="password" name="code" maxlength="64" autocomplete="off" aria-label="Code" required> '
    + '<button class="dl-btn" type="submit">Open</button></form></main></body></html>';
}

const SHELL_CSP = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
  "img-src 'self' data:", "frame-src 'self'", "form-action 'none'", "frame-ancestors 'none'", "base-uri 'none'", "object-src 'none'"].join('; ');
const PASSWORD_CSP = ["default-src 'none'", "style-src 'self'", "form-action 'self'", "frame-ancestors 'none'", "base-uri 'none'"].join('; ');
// No sandbox here: Chrome's PDF viewer does not run in a sandboxed frame. The
// bytes are still verified %PDF + served as application/pdf with nosniff.
const FILE_CSP = "default-src 'none'; frame-ancestors 'self'; form-action 'self'";

module.exports = {
  secureLinkEnabled,
  DEFAULT_EXPIRY_DAYS, MAX_EXPIRY_DAYS, EXPIRY_CHOICES, expiryDays,
  PW_MIN, PW_MAX, SCRYPT, generatePassword, normalizePassword, passwordOk, hashPassword, verifyPassword,
  PW_MAX_TRIES, PW_WINDOW_MS, PW_LOCK_MS, reserveAttempt, clearAttempts,
  COOKIE_NAME, UNLOCK_TTL_MS, parseCookies, isUnlocked, unlockCookie,
  parseDevice, isBot,
  OPEN_VISIBLE_SECONDS, PING_MAX_SECONDS, VIEW_CAP_SECONDS, READING_NOW_SECONDS, READING_COOLDOWN_MS,
  FOLLOWUP_AFTER_MS, FOLLOWUP_STALE_MS, VIEW_TTL_DAYS, DAY_MS,
  shouldPromoteOpen, clampPing, followUpDecision, ms,
  fmtDate, fmtWhen, trackingNotice, reminderCopy, esc,
  shellHtml, passwordHtml, SHELL_CSP, PASSWORD_CSP, FILE_CSP,
};
