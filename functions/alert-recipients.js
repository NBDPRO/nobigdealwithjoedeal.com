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
const { effectivePlan } = require('./lead-cap-logic');

// Named caps (one place to tune).
const RECIPIENT_DAILY_CAP = 100;              // email/SMS per destination per rolling 24h, all tenants (per-tenant ceiling is 60)
const RECIPIENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const CONFIRM_REQUESTS_PER_OWNER_DAY = 5;     // confirmation mails one company may trigger per day
const CONFIRM_REQUESTS_PER_ADDRESS_DAY = 2;   // ... and one destination may receive per day
const CONFIRM_GLOBAL_DAILY_CAP = 300;          // confirmation mails platform-wide per rolling 24h
const CONFIRM_TTL_MS = 48 * 60 * 60 * 1000;
const REVOKE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // the revoke link in the owner notice
const CLAIM_TTL_MS = 2 * 60 * 1000;               // a confirm-token claim that never finished frees itself
// One TENANT's share of a destination's daily budget (2026-10-13): equal to the
// per-tenant alert ceiling (lead-alert.js TENANT_ALERT_DAILY_CAP) and inside the
// all-tenant cap above, so one tenant can never use up a destination for everyone.
const RECIPIENT_TENANT_DAILY_CAP = 60;

const CONFIRMED_COLLECTION = 'alertRecipients';       // {companyId} -> { confirmed: { <key>: {...} } }
const TOKEN_COLLECTION = 'alertRecipientTokens';      // {sha256(token)} -> pending confirmation

// Paid plan names (functions/billing.js PLAN_LIMITS minus 'free'; a test pins
// the two together). A non-NBD tenant on any other name is treated as unpaid.
const KNOWN_PAID_PLANS = Object.freeze(['starter', 'foundation', 'team', 'growth', 'professional', 'enterprise']);

// Firebase Auth uids from sign-up are 28 alphanumerics; every self-signup tenant
// is keyed by one. A company id of any other shape is an admin-seeded legacy slug.
const UID_SHAPE_RE = /^[A-Za-z0-9]{28}$/;
function isUidShaped(id) { return UID_SHAPE_RE.test(String(id || '')); }

// An admin-seeded company doc that exists and names NO owner (a read error is NO).
async function legacySeededCompany(companyId, deps) {
  try {
    const snap = await _db(deps).collection('companies').doc(String(companyId)).get();
    return !!(snap && snap.exists && !((snap.data() || {}).ownerId));
  } catch (_) {
    return false;
  }
}

// NBD's own tenant (the platform owner's uid). Read lazily so a test can set it.
function isNbdTenant(id) {
  const nbd = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
  return !!id && String(id) === String(nbd);
}

// Deliberately strict: one plain address. No display names, no lists.
const EMAIL_RE = /^[A-Za-z0-9._+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

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

// One inbox, many spellings: lowercase, drop a +tag, and for Gmail fold the
// dots and googlemail.com. Used for CAP keys only (never for matching a
// confirmed address, which is exact).
function canonicalInbox(email) {
  const s = (normEmail(email) || String(email || '').toLowerCase()).trim();
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  let local = s.slice(0, at).replace(/\+.*$/, '');
  let domain = s.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return local + '@' + domain;
}

function addrKey(email) {
  return crypto.createHash('sha256').update(normEmail(email) || String(email || '')).digest('hex').slice(0, 40);
}

// a***@example.test — for audit rows, which must not carry a raw address.
function maskEmail(email) {
  const s = normEmail(email);
  if (!s) return '';
  const at = s.lastIndexOf('@');
  return s.slice(0, 1) + '***' + s.slice(at);
}

/**
 * May a tenant's report-share link be EMAILED (from NBD's sender domain)? Only
 * from a paid, non-trial tenant: an active (or past_due: card bounced, still a
 * paying customer) subscription on a known paid plan, after the same
 * access-code trial expiry the lead cap applies. Free, trialing, cancelled,
 * unknown-plan and missing subscriptions are all NO. NBD's own tenant and the
 * fail-closed read-error case are the caller's job. (Jo, 2026-10-13.)
 */
function planAllowsShareEmail(sub, nowMs) {
  if (!sub || typeof sub !== 'object') return false;
  const plan = effectivePlan(sub, nowMs == null ? Date.now() : nowMs);
  if (KNOWN_PAID_PLANS.indexOf(plan) === -1) return false;
  return sub.status === 'active' || sub.status === 'past_due';
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
    return String(companyId); // no company doc: a solo operator keyed by uid
  } catch (_) {
    // Fail CLOSED: after a hand-off companyId is the FORMER owner's uid, so a
    // read error must not resolve their inbox. '' = no owner lookup this run.
    return '';
  }
}

// An owner's Auth identity. email is returned ONLY when Auth says verified.
async function authOwner(companyId, deps) {
  try {
    const u = (deps && deps.getAuthUser)
      ? await deps.getAuthUser(String(companyId))
      : await require('firebase-admin/auth').getAuth().getUser(String(companyId));
    if (!u || u.disabled === true) return { email: '', phone: '' }; // lapsed / erased accounts keep emailVerified
    return {
      email: u.emailVerified === true ? normEmail(u.email || '') : '',
      phone: normPhone(u.phoneNumber || ''),
    };
  } catch (e) {
    return { email: '', phone: '', error: String((e && e.message) || e) };
  }
}

// The confirmed entries ({ <addrKey>: { email, requestedBy, ... } }) for a company.
async function confirmedEntries(companyId, deps) {
  try {
    const snap = await _db(deps).collection(CONFIRMED_COLLECTION).doc(String(companyId)).get();
    const data = snap && snap.exists ? (snap.data() || {}) : {};
    return data.confirmed && typeof data.confirmed === 'object' ? data.confirmed : {};
  } catch (_) {
    return {}; // fail closed
  }
}

// A confirmed entry is honoured only while the person who requested it is STILL
// the company's owner (a hand-off or a different owner voids it) and that owner
// has a verified, enabled sign-in email (a lapsed / disabled owner voids it).
function entryHonoured(entry, ownerUid, ownerEmailVerified) {
  return !!(entry && ownerUid && ownerEmailVerified && String(entry.requestedBy || '') === String(ownerUid));
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
  const ownerUid = await ownerUidFor(companyId, deps);
  const owner = ownerUid ? await authOwner(ownerUid, deps) : { email: '', phone: '' };
  const out = { emails: [], sms: null, ownerEmail: owner.email, ignoredEmail: '', ignoredSms: '' };

  // Legacy admin-seeded tenant (a slug id like 'oaks' whose company doc names NO
  // owner; never a self-signup, those are keyed by a 28-char uid). Only an admin
  // can write its company / profile docs, so its configured contacts keep working
  // as they did before. A uid-shaped company never takes this branch.
  if (ownerUid && !isUidShaped(companyId) && (await legacySeededCompany(companyId, deps))) {
    if (cfgEmail) out.emails = [cfgEmail];
    if (cfgSms) out.sms = cfgSms;
    return out;
  }

  if (cfgEmail) {
    if (owner.email && cfgEmail === owner.email) {
      out.emails = [owner.email];
    } else if (entryHonoured((await confirmedEntries(companyId, deps))[addrKey(cfgEmail)], ownerUid, !!owner.email)) {
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
 * Optional second bucket: tenantKey + tenantLimit give each TENANT its own
 * share of the destination's budget, checked FIRST so a tenant that is over its
 * share is stopped without touching the all-tenant counter (one tenant cannot
 * burn a destination for everyone). trusted:true keeps authenticated-origin
 * alerts (Cal.com, Thumbtack) in their own buckets so an anonymous public-form
 * flood cannot starve them.
 *
 * @param {{limit?:number, windowMs?:number, limiter?:Function,
 *          tenantKey?:string, tenantLimit?:number, trusted?:boolean}} [opts]
 */
async function capRecipients(kind, addresses, opts) {
  const o = opts || {};
  const limit = o.limit || RECIPIENT_DAILY_CAP;
  const windowMs = o.windowMs || RECIPIENT_WINDOW_MS;
  const enforce = o.limiter || require('./rate-limit').enforceRateLimit;
  const ns = 'alertRecipient:' + kind + (o.trusted ? ':trusted' : '');
  const allowed = [];
  const capped = [];
  for (const a of (addresses || [])) {
    if (!a) continue;
    const key = kind === 'sms' ? normPhone(a) || String(a) : canonicalInbox(a);
    if (o.tenantKey) {
      try {
        await enforce(ns + ':tenant', String(o.tenantKey) + '|' + key, o.tenantLimit || limit, windowMs);
      } catch (e) {
        if (e && e.rateLimited) { capped.push(a); continue; }
        // limiter outage: fail OPEN, fall through to the destination cap
      }
    }
    try {
      await enforce(ns, key, limit, windowMs);
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
  CONFIRM_REQUESTS_PER_OWNER_DAY, CONFIRM_REQUESTS_PER_ADDRESS_DAY, CONFIRM_GLOBAL_DAILY_CAP, CONFIRM_TTL_MS,
  REVOKE_TTL_MS, CLAIM_TTL_MS, isUidShaped, isNbdTenant, legacySeededCompany, RECIPIENT_TENANT_DAILY_CAP, KNOWN_PAID_PLANS, maskEmail, planAllowsShareEmail,
  CONFIRMED_COLLECTION, TOKEN_COLLECTION,
  normEmail, normPhone, canonicalInbox, addrKey, authOwner, ownerUidFor, confirmedKeys, confirmedEntries, entryHonoured,
  resolveTenantRecipients, capRecipients, verifiedUserEmail, cleanLabel,
};
