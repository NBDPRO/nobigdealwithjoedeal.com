/**
 * functions/alert-recipients.js — who a staff/owner alert may be sent TO
 * ═══════════════════════════════════════════════════════════════
 *
 * One shared helper for every sender that pages a company's owner or staff from
 * NBD's Resend domain / Twilio number (new-lead alerts, Cal.com booking alerts,
 * the watchdog re-send, owner digests).
 *
 * WHY (2026-10-13, "Option B")
 * ────────────────────────────
 * The recipient used to be read straight off tenant-writable Firestore
 * (companyProfile.brand.contact.alertEmail / alertSms, users/{uid}.email). Any
 * tenant owner can write those fields, so NBD's own sender domain could be
 * pointed at an arbitrary inbox or number. A recipient is now one of:
 *
 *   1. the company owner's VERIFIED Firebase Auth email / phone number
 *      (Auth is not client-writable, and the email was proven by its owner), or
 *   2. a custom address the owner CONFIRMED: NBD emails a one-time link to that
 *      address and the click is recorded server-side in alertRecipients/{companyId}
 *      (firestore.rules: no client read or write).
 *
 * Anything else is IGNORED, not an error: the alert falls back to the owner's
 * Auth email, and the CRM lead, the in-app bell and the push are untouched.
 * SMS goes only to the owner's Auth phone number (and only when the company
 * opted into SMS alerts by configuring one that matches).
 *
 * The second half is a per-recipient daily cap, keyed on the destination
 * address/number across ALL tenants, via the shared rate-limit.js limiter.
 * A limiter outage fails OPEN (a dropped lead alert costs a customer; a missed
 * cap costs one message).
 *
 * NBD's own tenant is not routed through here: its alert contacts are the
 * hard-coded constants in lead-alert.js (jd@ and the gmail inbox are deliberate
 * separate addresses; never merge them), and nothing a tenant can write feeds
 * them. This module has NO firebase-functions dependency so unit tests can load
 * it with the admin SDK stubbed.
 */
'use strict';

const crypto = require('crypto');

// Named caps (one place to tune).
const RECIPIENT_DAILY_CAP = 100;              // email/SMS per destination per rolling 24h, all tenants (per-tenant ceiling is 60)
const RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONFIRM_REQUESTS_PER_OWNER_DAY = 5;     // confirmation mails one company may trigger per day
const CONFIRM_REQUESTS_PER_ADDRESS_DAY = 2;   // ... and one destination may receive per day
const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;

const CONFIRMED_COLLECTION = 'alertRecipients';       // {companyId} -> { confirmed: { <key>: {...} } }
const TOKEN_COLLECTION = 'alertRecipientTokens';      // {sha256(token)} -> pending confirmation

// Deliberately strict: one plain address. No display names, no lists.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function normEmail(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim().toLowerCase();
  if (!s || s.length > 254 || !EMAIL_RE.test(s)) return '';
  return s;
}

// E.164 or a 10/11-digit US number -> '+1XXXXXXXXXX'. '' when unusable.
function normPhone(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const raw = String(v).trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (raw.startsWith('+')) return /^\d{8,15}$/.test(digits) ? '+' + digits : '';
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '';
}

function addrKey(email) {
  return crypto.createHash('sha256').update(normEmail(email) || String(email || '')).digest('hex').slice(0, 40);
}

function _db(deps) {
  if (deps && deps.db) return deps.db;
  return require('firebase-admin/firestore').getFirestore();
}

// The CURRENT owner's uid. A company keeps its id across an owner hand-off
// (transferCompanyOwnership), so companyId is the original owner's uid but
// companies/{companyId}.ownerId names who owns it now; a solo operator has no
// company doc and is keyed by their own uid.
async function ownerUidFor(companyId, deps) {
  try {
    const snap = await _db(deps).collection('companies').doc(String(companyId)).get();
    const oid = snap && snap.exists ? ((snap.data() || {}).ownerId || '') : '';
    if (typeof oid === 'string' && oid) return oid;
  } catch (_) { /* fall through to the uid-as-tenant key */ }
  return String(companyId);
}

// An owner's Auth identity. email is returned ONLY when Auth says verified.
async function authOwner(companyId, deps) {
  try {
    const u = (deps && deps.getAuthUser)
      ? await deps.getAuthUser(String(companyId))
      : await require('firebase-admin/auth').getAuth().getUser(String(companyId));
    if (!u) return { email: '', phone: '' };
    return {
      email: u.emailVerified === true ? normEmail(u.email || '') : '',
      phone: normPhone(u.phoneNumber || ''),
    };
  } catch (e) {
    return { email: '', phone: '', error: String((e && e.message) || e) };
  }
}

// Set of confirmed address keys for a company.
async function confirmedKeys(companyId, deps) {
  try {
    const snap = await _db(deps).collection(CONFIRMED_COLLECTION).doc(String(companyId)).get();
    const data = snap && snap.exists ? (snap.data() || {}) : {};
    const map = data.confirmed && typeof data.confirmed === 'object' ? data.confirmed : {};
    return new Set(Object.keys(map));
  } catch (_) {
    return new Set();
  }
}

/**
 * Resolve the verified recipients for a NON-NBD company that has configured
 * alert contacts.
 *
 * @param {string} companyId  owner uid / company key
 * @param {object} contact    companyProfile.brand.contact (tenant-writable: untrusted)
 * @param {object} [deps]     test seams: { db, getAuthUser }
 * @returns {{emails:string[], sms:string|null, ownerEmail:string,
 *            ignoredEmail:string, ignoredSms:string}}
 */
async function resolveTenantRecipients(companyId, contact, deps) {
  const c = contact && typeof contact === 'object' ? contact : {};
  const cfgEmail = normEmail(c.alertEmail);
  const cfgSms = normPhone(c.alertSms);
  const owner = await authOwner(await ownerUidFor(companyId, deps), deps);
  const out = { emails: [], sms: null, ownerEmail: owner.email, ignoredEmail: '', ignoredSms: '' };

  if (cfgEmail) {
    if (owner.email && cfgEmail === owner.email) {
      out.emails = [owner.email];
    } else if ((await confirmedKeys(companyId, deps)).has(addrKey(cfgEmail))) {
      out.emails = [cfgEmail];
    } else {
      out.ignoredEmail = cfgEmail;
    }
  }
  // Unconfirmed / absent custom address: the owner's own verified inbox.
  if (!out.emails.length && owner.email) out.emails = [owner.email];

  if (cfgSms) {
    if (owner.phone && cfgSms === owner.phone) out.sms = owner.phone;
    else out.ignoredSms = cfgSms;
  }
  return out;
}

/**
 * Apply the per-recipient daily cap. Returns the addresses still allowed and
 * those capped. A non-rate-limit error (limiter outage) lets the address
 * through.
 *
 * @param {'email'|'sms'} kind
 * @param {string[]} addresses
 * @param {{limit?:number, windowMs?:number, limiter?:Function}} [opts]
 */
async function capRecipients(kind, addresses, opts) {
  const o = opts || {};
  const limit = o.limit || RECIPIENT_DAILY_CAP;
  const windowMs = o.windowMs || RECIPIENT_WINDOW_MS;
  const enforce = o.limiter || require('./rate-limit').enforceRateLimit;
  const allowed = [];
  const capped = [];
  for (const a of (addresses || [])) {
    if (!a) continue;
    // One inbox, many spellings: drop a +tag so user+1@ and user+2@ share a bucket.
    const key = kind === 'sms' ? normPhone(a) || String(a) : (normEmail(a) || String(a).toLowerCase()).replace(/\+[^@]*@/, '@');
    try {
      await enforce('alertRecipient:' + kind, key, limit, windowMs);
      allowed.push(a);
    } catch (e) {
      if (e && e.rateLimited) capped.push(a);
      else allowed.push(a); // limiter outage: fail OPEN
    }
  }
  return { allowed, capped };
}

// Tenant-written text that reaches an email Subject or greeting: drop control
// and bidi/zero-width characters, collapse whitespace, bound the length.
function cleanLabel(s, max) {
  return String(s == null ? '' : s)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max || 60);
}

/**
 * The one address a USER-scoped digest (weekly digest, dormant-lead nudge,
 * review nudge) may go to. users/{uid}.email is writable by that user, so it
 * is honoured only when it equals the user's verified Auth email. The platform
 * owner's stored address passes through untouched (only that user can write
 * that doc), so NBD's own digests do not move.
 */
async function verifiedUserEmail(uid, storedEmail, deps) {
  const stored = normEmail(storedEmail);
  if (!stored) return '';
  const nbd = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  if (String(uid) === nbd) return stored;
  const owner = await authOwner(uid, deps);
  return owner.email && owner.email === stored ? stored : '';
}

module.exports = {
  RECIPIENT_DAILY_CAP, RECIPIENT_WINDOW_MS,
  CONFIRM_REQUESTS_PER_OWNER_DAY, CONFIRM_REQUESTS_PER_ADDRESS_DAY, CONFIRM_TTL_MS,
  CONFIRMED_COLLECTION, TOKEN_COLLECTION,
  normEmail, normPhone, addrKey, authOwner, ownerUidFor, confirmedKeys,
  resolveTenantRecipients, capRecipients, verifiedUserEmail, cleanLabel,
};
