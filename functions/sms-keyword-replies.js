/**
 * functions/sms-keyword-replies.js — the automatic STOP / HELP / START replies
 * (2026-10-13, Twilio A2P reapply packet row 14).
 *
 * The replies a homeowner gets back when they text a keyword used to say
 * "NBD Pro" (the CRM product's name) — but the registered campaign sender is
 * the roofing business, and carrier reviewers check that the HELP / opt-out
 * reply names the brand the consumer opted in to. So:
 *
 *   - The business name is the tenant that owns the number texted (its
 *     companyProfile brand), NEVER "NBD Pro". NBD's own line (the global
 *     TWILIO_PHONE_NUMBER) and anything unknown fall back to
 *     "No Big Deal Home Solutions".
 *   - One tenant's customers are never told "No Big Deal" when the number
 *     texted is that tenant's own registered number.
 *   - Copy is GSM-7 (straight apostrophe, no emoji) and one SMS segment
 *     (<= 160) for any name up to MAX_NAME characters.
 *
 * The strings match the registered Twilio campaign fields in
 * documentation/projects/TWILIO-A2P-REAPPLY-PACKET-2026-10-13.md section 5.
 *
 * Pure except resolveBrand(), which takes the db handle. Nothing here sends.
 */
'use strict';

const { phoneDigits10 } = require('./phone-utils');

const NBD_NAME = 'No Big Deal Home Solutions';
// NBD's public business line and marketing address: the same pair every
// public page and zelle-contact.js carry (jd@ is marketing, info@ documents).
const NBD_PHONE = '(859) 420-7382';
const NBD_EMAIL = 'jd@nobigdealwithjoedeal.com';
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// A name longer than this is cut so the reply stays one segment.
const MAX_NAME = 30;
// Said when a matched tenant has not set a business name (never "No Big Deal").
const UNNAMED_TENANT = 'This business';

const NBD_BRAND = Object.freeze({ name: NBD_NAME, phone: NBD_PHONE, email: NBD_EMAIL, isNbd: true });

/** GSM-7-safe, single-line, bounded text. */
function clean(v, max) {
  let s = String(v == null ? '' : v)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && s.length > max) {
    // cut on a word boundary when there is one past the first half
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(' ');
    s = (s.charAt(max) !== ' ' && sp > max / 2 ? cut.slice(0, sp) : cut).trim();
  }
  return s;
}

/** The brand fields a reply needs, from a companyProfile doc's data. */
function brandFromProfile(profile) {
  const b = (profile && profile.brand) || {};
  const c = (b && b.contact) || {};
  const name = clean(b.name || b.legalName || b.shortName || (profile && (profile.companyName || profile.name)), MAX_NAME);
  return {
    name: name || UNNAMED_TENANT,
    phone: clean(c.phone, 20),
    email: '',
    isNbd: false,
  };
}

function nameOf(brand) {
  return clean(brand && brand.name, MAX_NAME) || NBD_NAME;
}

/** Opt-out confirmation: brand + unsubscribed + no more texts. */
function stopReply(brand) {
  return nameOf(brand) + ": You're unsubscribed and won't get any more texts from this number. Reply START to resubscribe.";
}

/** HELP: brand + a way to reach the business + rates + how to stop. */
function helpReply(brand) {
  const b = brand || NBD_BRAND;
  const phone = clean(b.phone, 20);
  const email = clean(b.email, 60);
  let how;
  if (phone && email) how = 'for help call ' + phone + ' or email ' + email + '.';
  else if (phone) how = 'for help call ' + phone + '.';
  else how = 'for help reply to this text.';
  return nameOf(b) + ': ' + how + ' Msg & data rates may apply. Reply STOP to opt out.';
}

/** START / UNSTOP resubscribe confirmation. */
function startReply(brand) {
  return nameOf(brand) + ": You're subscribed to our texts. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.";
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** TwiML for one reply. The text is escaped: "Msg & data" is a bare & in XML. */
function twiml(text) {
  return '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + xmlEscape(text) + '</Message></Response>';
}

/**
 * Who owns the number the homeowner texted?
 *
 * - the global TWILIO_PHONE_NUMBER (or no usable To) → NBD, always (a tenant
 *   can type anything into its own profile; it cannot claim NBD's line);
 * - another number that exactly one companyProfile names as its
 *   brand.integrations.twilioNumber → that tenant;
 * - anything else (no match, several matches, a read error) → NBD fallback.
 *   A failure here never blocks the reply: the opt-out is already recorded.
 *
 * @param {object} db Firestore (Admin) handle
 * @param {string} to the Twilio "To" of the inbound message
 * @param {string} ownNumber the global sender number ('' when unset)
 * @param {{warn?: Function}} [log]
 * @returns {Promise<{name: string, phone: string, email: string, isNbd: boolean, companyId?: string, source: string}>}
 */
async function resolveBrand(db, to, ownNumber, log) {
  const toKey = phoneDigits10(to);
  const ownKey = phoneDigits10(ownNumber);
  const nbd = (source) => Object.assign({ source }, NBD_BRAND);
  if (!toKey) return nbd('no_to');
  if (ownKey && toKey === ownKey) return nbd('own_number');
  try {
    const seen = new Map();
    const shapes = [String(to || '').trim(), '+1' + toKey].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const v of shapes) {
      const snap = await db.collection('companyProfile').where('brand.integrations.twilioNumber', '==', v).limit(3).get();
      snap.docs.forEach((d) => seen.set(d.id, d.data() || {}));
    }
    if (seen.size === 1) {
      const [id, profile] = [...seen.entries()][0];
      if (id === NBD_OWNER_UID) return nbd('nbd_profile');
      return Object.assign({ companyId: id, source: 'tenant_number' }, brandFromProfile(profile));
    }
    if (seen.size > 1 && log && log.warn) log.warn('sms_keyword_brand_ambiguous', { matches: seen.size });
    return nbd(seen.size > 1 ? 'ambiguous' : 'unknown_number');
  } catch (e) {
    if (log && log.warn) log.warn('sms_keyword_brand_lookup_failed', { err: e && e.message });
    return nbd('lookup_failed');
  }
}

module.exports = {
  NBD_NAME, NBD_PHONE, NBD_EMAIL, NBD_BRAND, MAX_NAME, UNNAMED_TENANT,
  stopReply, helpReply, startReply, twiml, xmlEscape, brandFromProfile, resolveBrand,
};
