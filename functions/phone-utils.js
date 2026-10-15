/**
 * functions/phone-utils.js — canonical phone-number normalization.
 *
 * Single source of truth for the `phoneDigits` field we stamp on every
 * lead. Inbound Twilio webhooks deliver E.164 (+15551234567); reps type
 * phones free-form ("(555) 123-4567", "555.123.4567", "1-555-123-4567").
 * An EXACT string match between the two never ties an inbound SMS back to
 * its lead — so the lead carries a normalized last-10-US-digits key and
 * incomingSMS matches the sender against THAT (see sms-functions.js).
 *
 *   phoneDigits10('(555) 123-4567')  === '5551234567'
 *   phoneDigits10('+15551234567')    === '5551234567'
 *   phoneDigits10('1-555-123-4567')  === '5551234567'
 *   phoneDigits10('')                === ''
 *   phoneDigits10(null)              === ''
 *
 * The READ side (incomingSMS) and every WRITE side (lead-create paths +
 * the one-off backfill) MUST share this exact transform — otherwise the
 * stamped key and the looked-up key drift and the match silently fails.
 * Real 10-digit US numbers never start with 1 (NANP area codes are
 * [2-9]xx), so the `^1` strip only ever removes a country-code prefix.
 *
 * Firebase-free + pure so it can be required from Cloud Functions, the
 * backfill script, and the unit test with zero deps. The browser
 * lead-write paths inline the identical expression (a smoke-test guard
 * asserts they don't drift).
 */

'use strict';

function phoneDigits10(phone) {
  // Strip every non-digit, drop a leading US country-code 1, keep the last
  // 10 (area code + line number). Kept on ONE line so it stays byte-identical
  // to the copies the browser write paths hand-inline (a smoke-test guard
  // asserts they don't drift — they can't require this Node module).
  return String(phone == null ? '' : phone).replace(/\D/g, '').replace(/^1/, '').slice(-10);
}

/**
 * E.164 for a US/Canada number, else null: exactly 10 digits, or 11 with a
 * leading 1. Anything else (7 digits, international, junk) is rejected.
 * Moved here from verify-functions.js (2026-10-15) so the OTP sender and the
 * public lead intake (submitPublicLead) apply ONE rule.
 */
function formatPhone(phone) {
  const cleaned = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (cleaned.length === 10) return '+1' + cleaned;
  if (cleaned.length === 11 && cleaned.startsWith('1')) return '+' + cleaned;
  return null;
}

module.exports = { phoneDigits10, formatPhone };
