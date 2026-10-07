/**
 * functions/integrations/calcom-logic.js — pure (firebase-free) logic for the
 * Cal.com booking webhook. The HTTP/Firestore I/O stays in calcom.js; every
 * function here is a pure function of its inputs so it unit-tests with zero
 * deps (tests/calcom-webhook-payload.test.js). Same split as
 * thumbtack-logic.js / lead-bridge-logic.js.
 *
 * ── WHY THIS EXISTS (2026-09-13) ─────────────────────────────────────────
 * calcom.js read the homeowner's phone from `attendees[0].phoneNumber` and
 * nothing else. Cal.com's documented BOOKING_CREATED payload
 * (cal.com/docs/developing/guides/automation/webhooks) lists attendee keys as
 * email / name / firstName / lastName / timeZone / language — no phone. The
 * "Phone" booking question arrives as `responses.attendeePhoneNumber`, shaped
 * `{ label, value, isHidden }`, and for a phone-call event (roof-question-call,
 * estimate-walkthrough) the number is collected by the LOCATION prompt and
 * arrives as `responses.location.value.optionValue`. There was no
 * `payload.responses` read anywhere in functions/. So a booking could make the
 * phone REQUIRED in Cal.com and still land in the CRM as a phone-less lead —
 * which is exactly how an organic gutter/siding lead reached Jo email-only.
 * The address had the same problem: `payload.location` for an in-person event
 * can be the location TYPE token (e.g. `attendeeInPerson`), not the address.
 *
 * ── WHY IT IS TOLERANT ───────────────────────────────────────────────────
 * No real BOOKING_CREATED body has ever been captured in this repo. So:
 *   1. Every value is read from several documented/plausible places, in a
 *      fixed priority order, and the winner is RECORDED (`phoneSource`,
 *      `addressSource`) so the first real booking settles the shape from the
 *      Cloud Logging breadcrumb calcom.js writes.
 *   2. Nothing here throws on an unexpected shape.
 *   3. It never writes a WRONG value to fill a gap: a location type token is
 *      never an address, a phone number is never an address, and the
 *      ORGANIZER's phone / address (`userPhone`, `inPerson`) is never taken as
 *      the homeowner's — Joe's own number on a lead would be worse than none.
 */

'use strict';

const { phoneDigits10 } = require('../phone-utils');
const L = require('../lead-bridge-logic');

// Cal.com location type values. Only ATTENDEE-supplied ones carry homeowner data.
const ATTENDEE_PHONE_LOCATION_TYPES = ['phone', 'attendeePhone'];
const ATTENDEE_ADDRESS_LOCATION_TYPES = ['attendeeInPerson', 'attendeeAddress'];
// Everything Cal.com uses as a location TYPE rather than a value — never an address.
const LOCATION_TYPE_TOKENS = [
  'attendeeInPerson', 'attendeeAddress', 'inPerson', 'phone', 'attendeePhone',
  'userPhone', 'link', 'somewhereElse', 'attendeeInPersonOrganizer',
].map((t) => t.toLowerCase());

const NO_PHONE_NOTE = 'NO PHONE on this booking — reply to the Cal.com confirmation email to get a number before the visit.';

function isObj(v) { return v != null && typeof v === 'object' && !Array.isArray(v); }

function firstAttendee(payload) {
  const a = payload && Array.isArray(payload.attendees) ? payload.attendees[0] : null;
  return isObj(a) ? a : {};
}

function responsesOf(payload) {
  return payload && isObj(payload.responses) ? payload.responses : {};
}

/**
 * A booking-question response arrives as `{ label, value, isHidden }` in the
 * webhook, or as a bare value in the REST API's bookingFieldsResponses.
 * Returns a trimmed string, or '' when the value is not a scalar.
 */
function responseValue(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string' || typeof resp === 'number') return String(resp).trim();
  if (isObj(resp) && (typeof resp.value === 'string' || typeof resp.value === 'number')) return String(resp.value).trim();
  return '';
}

/** `{ type, optionValue }` of the location response, from either shape. */
function locationResponse(payload) {
  const loc = responsesOf(payload).location;
  // Webhook: { label, value: { value: 'attendeeInPerson', optionValue: '12 Elm St' } }
  // REST:    { value: 'attendeeInPerson', optionValue: '12 Elm St' }
  const inner = isObj(loc) && isObj(loc.value) ? loc.value : (isObj(loc) ? loc : null);
  if (!inner) return { type: '', optionValue: '' };
  return {
    type: typeof inner.value === 'string' ? inner.value.trim() : '',
    optionValue: typeof inner.optionValue === 'string' || typeof inner.optionValue === 'number' ? String(inner.optionValue).trim() : '',
  };
}

function digitsOf(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

/** A US NANP shape: exactly 10 digits, or 11 with a leading country-code 1. */
function isUsPhone(v) {
  const d = digitsOf(v);
  return d.length === 10 || (d.length === 11 && d[0] === '1');
}

/**
 * The homeowner's phone, from whichever field Cal.com used.
 * Returns { phone, phoneDigits, phoneSource }.
 *   phone        — the raw string as the homeowner typed it ('' when none)
 *   phoneDigits  — phoneDigits10(phone): the CRM/SMS match key
 *   phoneSource  — which field won, or 'none'
 * A US-shaped candidate always beats an earlier non-US one. A non-US value
 * with at least 7 digits is kept (so a real international number is not
 * thrown away) with a ':unverified' source suffix; anything shorter — a
 * location token, a label, 'call me' — is rejected.
 */
function resolveAttendeePhone(payload) {
  const att = firstAttendee(payload);
  const r = responsesOf(payload);
  const loc = locationResponse(payload);
  const candidates = [
    ['attendees[0].phoneNumber', att.phoneNumber],
    ['responses.attendeePhoneNumber', responseValue(r.attendeePhoneNumber)],
    ['responses.phone', responseValue(r.phone)],
    ['responses.location', ATTENDEE_PHONE_LOCATION_TYPES.includes(loc.type) ? loc.optionValue : ''],
    ['attendees[0].phone', att.phone],
    ['smsReminderNumber', (payload && payload.smsReminderNumber) || responseValue(r.smsReminderNumber)],
  ].map(([source, v]) => [source, typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '']);

  const us = candidates.find(([, v]) => v && isUsPhone(v));
  if (us) return { phone: us[1], phoneDigits: phoneDigits10(us[1]), phoneSource: us[0] };
  const other = candidates.find(([, v]) => v && digitsOf(v).length >= 7);
  if (other) return { phone: other[1], phoneDigits: phoneDigits10(other[1]), phoneSource: other[0] + ':unverified' };
  return { phone: '', phoneDigits: '', phoneSource: 'none' };
}

/** True when a string reads like a street address rather than a token, URL or number. */
function looksLikeAddress(s) {
  s = String(s == null ? '' : s).trim();
  if (!s || !/[a-z]/i.test(s)) return false;                 // a bare phone number has no letters
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;           // integrations:google_meet, https:, tel:
  if (s.includes('://')) return false;
  if (LOCATION_TYPE_TOKENS.includes(s.toLowerCase())) return false;
  return true;
}

/**
 * The property address, from whichever field carried it.
 * Returns { address, addressSource }.
 */
function resolveBookingAddress(payload) {
  const r = responsesOf(payload);
  const loc = locationResponse(payload);
  if (ATTENDEE_ADDRESS_LOCATION_TYPES.includes(loc.type) && looksLikeAddress(loc.optionValue)) {
    return { address: loc.optionValue, addressSource: 'responses.location' };
  }
  for (const key of ['attendeeAddress', 'address']) {
    const v = responseValue(r[key]);
    if (looksLikeAddress(v)) return { address: v, addressSource: 'responses.' + key };
  }
  const top = payload && typeof payload.location === 'string' ? payload.location.trim() : '';
  if (looksLikeAddress(top)) return { address: top, addressSource: 'location' };
  return { address: '', addressSource: 'none' };
}

/** { slug, eventTypeId, title } — `type` is the event slug in Cal.com's payload. */
function extractEventType(payload) {
  payload = payload || {};
  const slug = [payload.type, payload.eventTypeSlug, isObj(payload.eventType) ? payload.eventType.slug : '']
    .find((v) => typeof v === 'string' && v.trim());
  const id = payload.eventTypeId != null ? payload.eventTypeId : (isObj(payload.eventType) ? payload.eventType.id : null);
  return {
    slug: slug ? slug.trim() : '',
    eventTypeId: id != null && id !== '' ? id : null,
    title: payload.title || payload.eventTitle || null,
  };
}

/**
 * The contact + provenance fields of the CRM lead a cold booking creates.
 * calcom.js adds the rep scoping (userId / companyId) and the server
 * timestamps; everything derived from the payload is decided here.
 */
function buildCalcomLeadFields({ payload, bookingId } = {}) {
  payload = payload || {};
  const att = firstAttendee(payload);
  const { firstName, lastName } = L.splitName({ name: att.name || responseValue(responsesOf(payload).name) });
  const { phone, phoneDigits, phoneSource } = resolveAttendeePhone(payload);
  const { address, addressSource } = resolveBookingAddress(payload);
  const ev = extractEventType(payload);
  const needsPhone = !phoneDigits;
  const bookedNotes = String(payload.additionalNotes || payload.description || responseValue(responsesOf(payload).notes) || '');
  const notes = needsPhone ? [NO_PHONE_NOTE, bookedNotes].filter(Boolean).join('\n') : bookedNotes;
  return {
    firstName,
    lastName,
    address,
    phone,
    phoneDigits,
    email: String(att.email || responseValue(responsesOf(payload).email) || ''),
    // Canonical key + role (2026-10-04 numbers audit: 64 leads stored the
    // legacy display name 'New' and 62 had no stageRole). Migration 008
    // heals the ones already written.
    stage: 'new',
    stageRole: 'new',
    status: 'new',
    source: 'Website — Cal.com booking',
    notes,
    webLead: true,
    publicLeadKind: 'calcom_booking',
    calcomBookingId: bookingId != null ? bookingId : (payload.uid || payload.bookingId || null),
    calcomEventTitle: ev.title,
    calcomEventSlug: ev.slug || null,
    calcomEventTypeId: ev.eventTypeId,
    sourcePage: ev.slug ? 'calcom:' + ev.slug : 'calcom',
    phoneSource,
    addressSource,
    needsPhone,
  };
}

/**
 * M-1: does this booker already exist in the rep's pipeline? Matches on email
 * (case-insensitive) or on the last-10-digit phone key. `leads` is an array of
 * { id, data } — the webhook passes query docs mapped to that shape.
 * Returns the matching lead id or null.
 */
function matchExistingLead(leads, { email, phoneDigits } = {}) {
  const e = String(email || '').toLowerCase().trim();
  const p = String(phoneDigits || '');
  if (!e && p.length !== 10) return null;
  for (const lead of leads || []) {
    const d = (lead && lead.data) || {};
    if (e && String(d.email || '').toLowerCase().trim() === e) return lead.id;
    if (p.length === 10 && (String(d.phoneDigits || '') === p || phoneDigits10(d.phone) === p)) return lead.id;
  }
  return null;
}

// ── REP ROUTING (review R5-8-1, 2026-10-06) ─────────────────────────────
// Which CRM account a booking belongs to. calcom.js does the lookups (Auth by
// organizer email, users where calcomUsername == organizer username, the
// optional system/calcomRouting doc); these functions only decide.
//
// Since #1945 the email match won even when that account belonged to NO
// company, so a tenant whose Cal.com organizer email is an old company-less
// login had every booking land in that dead account while the account that
// owns the company (and carries the username) got nothing. The email-first
// order itself stays: any user can write their own users/{uid}.calcomUsername,
// so a username must never beat an email match that is a real tenant account.

const COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function idOrNull(v) { return typeof v === 'string' && COMPANY_ID_RE.test(v) ? v : null; }

/**
 * The company an account belongs to, or null when it is not a CRM tenant
 * account. Only server-controlled sources count: the companyId custom claim,
 * users/{uid}.companyId (clients cannot create or change it — firestore.rules
 * users/{uid}), or a companies/{uid} doc that names this uid as ownerId (the
 * solo-owner convention, companyId == uid, as in handlers/_shared.js
 * requireTeamAdmin).
 */
function accountCompanyId({ uid, claims, userData, companyData } = {}) {
  const fromClaim = idOrNull(claims && claims.companyId);
  if (fromClaim) return fromClaim;
  const fromUser = idOrNull(userData && userData.companyId);
  if (fromUser) return fromUser;
  if (uid && isObj(companyData) && companyData.ownerId === uid) return uid;
  return null;
}

/**
 * The companyId an optional server-only routing doc maps this booking to,
 * by event-type slug first, then organizer username (case-insensitive).
 * Shape: { byEventSlug: { <slug>: <companyId> }, byUsername: { <username>: <companyId> } }.
 * Returns null when absent or not a plain id.
 */
function pickConfiguredCompanyId(cfg, { eventSlug, organizerUsername } = {}) {
  if (!isObj(cfg)) return null;
  const own = (map, key) => (isObj(map) && key && Object.prototype.hasOwnProperty.call(map, key) ? idOrNull(map[key]) : null);
  const slug = typeof eventSlug === 'string' ? eventSlug.trim() : '';
  const user = typeof organizerUsername === 'string' ? organizerUsername.trim() : '';
  return own(cfg.byEventSlug, slug) || own(cfg.byUsername, user) || own(cfg.byUsername, user.toLowerCase()) || null;
}

/**
 * Decide the rep. Inputs are lookup results:
 *   configured        { uid, companyId } from the routing doc, or null
 *   emailAccount      { uid, companyId|null } — the Auth account with the organizer email, or null
 *   usernameClaimants [{ uid, companyId|null }] — users carrying the organizer username (up to 2 read)
 * Returns { repUid, repCompanyId, reason, conflict }. repUid null = unassigned.
 * Order:
 *   1. configured mapping (server-only, so it is trusted first)
 *   2. email account that belongs to a company (wins over any username — security)
 *   3. the ONE username claimant, only when it belongs to a company
 *   4. a company-less email account (legacy solo fallback, companyId = uid)
 *   5. nobody (a username claimed twice never assigns through the username)
 */
function resolveCalcomRep({ configured, emailAccount, usernameClaimants } = {}) {
  const valid = (a) => isObj(a) && typeof a.uid === 'string' && a.uid !== '';
  if (valid(configured) && idOrNull(configured.companyId)) {
    return { repUid: configured.uid, repCompanyId: configured.companyId, reason: 'configured', conflict: false };
  }
  const email = valid(emailAccount) ? emailAccount : null;
  const claimants = (Array.isArray(usernameClaimants) ? usernameClaimants : []).filter(valid);
  const ambiguous = claimants.length > 1;
  const unique = claimants.length === 1 ? claimants[0] : null;
  const uniqueCo = unique ? idOrNull(unique.companyId) : null;
  const emailCo = email ? idOrNull(email.companyId) : null;

  if (email && emailCo) {
    const conflict = !!(unique && uniqueCo && unique.uid !== email.uid && uniqueCo !== emailCo);
    return { repUid: email.uid, repCompanyId: emailCo, reason: conflict ? 'email_over_username' : 'email', conflict };
  }
  if (unique && uniqueCo) {
    return { repUid: unique.uid, repCompanyId: uniqueCo, reason: email ? 'username_over_companyless_email' : 'username', conflict: false };
  }
  if (email) {
    return { repUid: email.uid, repCompanyId: email.uid, reason: 'email_no_company', conflict: false };
  }
  const reason = ambiguous ? 'username_ambiguous' : (unique ? 'username_no_company' : 'no_match');
  return { repUid: null, repCompanyId: null, reason, conflict: false };
}

module.exports = {
  resolveCalcomRep,
  accountCompanyId,
  pickConfiguredCompanyId,
  resolveAttendeePhone,
  resolveBookingAddress,
  extractEventType,
  buildCalcomLeadFields,
  matchExistingLead,
  responseValue,
  looksLikeAddress,
  isUsPhone,
  NO_PHONE_NOTE,
  ATTENDEE_PHONE_LOCATION_TYPES,
  ATTENDEE_ADDRESS_LOCATION_TYPES,
};
