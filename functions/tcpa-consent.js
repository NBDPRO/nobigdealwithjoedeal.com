/**
 * NBD — TCPA consent, as a stored fact rather than an inference
 * ═══════════════════════════════════════════════════════════════
 *
 * Background (2026-09-04). The /estimate funnel hard-disables its submit
 * button until the homeowner ticks the express-written-consent box, and it
 * posts `tcpaConsent: true` with the lead. The funnel's own comment says the
 * value is "stored explicitly so the record is audit-ready and the SMS-ack
 * trigger can rely on it".
 *
 * Neither half was true in production:
 *
 *   1. submitPublicLead's M-04 optional-field allowlist only ever accepted
 *      STRINGS (`typeof v !== 'string'` → continue), and `tcpaConsent` was not
 *      on the estimate kind's list at all. The boolean was dropped on every
 *      submission, so NO lead has ever carried a consent record.
 *   2. lead-alert's `ackHomeownerSms` never read the field. It inferred
 *      consent from `collection === 'estimate_leads'` — i.e. from the funnel's
 *      UI construction — so any document landing in that collection by any
 *      other route (an import, a migration, a backfill, a seed, a future
 *      second form) would be texted with nothing to show for it.
 *
 * That is the difference between BELIEVING you have consent and being able to
 * SHOW it. This module is the second half: one place that answers "may we text
 * this person, and if not, why not" from the stored record only.
 *
 * Fail-closed by construction: a missing field is not consent, a string
 * "true" written by some future caller is not consent, and only an explicit
 * boolean `true` opens the gate. Legacy leads created before the persistence
 * fix therefore never receive the ack — correctly, because no consent record
 * exists for them and one cannot be invented after the fact.
 *
 * Pure and dependency-free so it is unit-testable without emulators
 * (tests/tcpa-consent.test.js), following the *-logic.js convention.
 */

/** The single field name, so no call site can drift onto a near-miss key. */
const CONSENT_FIELD = 'tcpaConsent';

/**
 * Collections whose documents can carry express written texting consent.
 *
 * Deliberately NOT "every public lead collection": a collection earns a place
 * here only once its form actually presents a consent disclosure and gates
 * submission on it. Today that is the /estimate funnel alone. Adding a key
 * here without adding the checkbox to that form is how a consent gate becomes
 * decorative, so treat this list as the audit trail it is.
 */
// 2026-09-04: inspect_leads joins. Three of its four forms (/storm-check,
// /roof-score, /storm-report) present the disclosure, gate submission on it and
// post the value; the fourth (/inspect) has no checkbox, posts nothing, and its
// documents therefore fail hasWrittenConsent — they are never texted. That is
// the point of reading consent from the document rather than the collection.
const CONSENT_COLLECTIONS = Object.freeze(['estimate_leads', 'inspect_leads']);

/**
 * Coerce a consent value as it arrives on a public-form submission.
 *
 * Returns `true`, `false`, or `undefined` — and the third case is the load-
 * bearing one. `undefined` means "the caller said nothing", and a caller who
 * said nothing must never have `false` written for them: an absent field and a
 * declined checkbox are different facts, and only one of them is evidence.
 *
 * Accepts the exact string forms too, because the gateway takes JSON today but
 * a form-encoded caller would arrive as 'true'/'false'. Nothing else counts —
 * not 1, not 'yes', not 'on'. See hasWrittenConsent for why strictness here is
 * the whole point.
 *
 * @param {*} v raw value from the request body
 * @returns {boolean|undefined}
 */
function parseSubmittedConsent(v) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return undefined;
}

/**
 * Is there a stored, provable consent record on this document?
 *
 * Strict identity against `true`. Truthy values (1, 'yes', 'true') are
 * rejected on purpose — every one of them means somebody wrote the field by a
 * path that was not the consent checkbox, and a consent record you cannot
 * explain is worse than none.
 *
 * @param {object|null|undefined} doc  the lead document
 * @returns {boolean}
 */
function hasWrittenConsent(doc) {
  return !!doc && doc[CONSENT_FIELD] === true;
}

/**
 * The full policy decision for the homeowner SMS acknowledgement.
 *
 * Returns a stable `reason` code even when allowed, so the caller can log the
 * decision rather than the absence of one — a suppressed text that logs
 * nothing is indistinguishable from a text that was never attempted.
 *
 * @param {object}  args
 * @param {boolean} args.enabled     LEAD_ACK_SMS_ENABLED === 'true'
 * @param {string}  args.collection  source collection of the lead
 * @param {object}  args.doc         the lead document
 * @param {object}  args.target      resolved alert target (needs isNbd)
 * @returns {{allowed: boolean, reason: string}}
 */
function smsAckGate(args) {
  const a = args || {};
  if (a.enabled !== true) return { allowed: false, reason: 'flag_disabled' };
  if (!CONSENT_COLLECTIONS.includes(String(a.collection || ''))) {
    return { allowed: false, reason: 'collection_not_consent_bearing' };
  }
  // Never text another company's homeowner with Joe's brand. Mirrors the
  // ackHomeowner email gate; see the NBD-leak audit (2026-07-29).
  if (!a.target || a.target.isNbd !== true) return { allowed: false, reason: 'not_nbd_lead' };
  if (!hasWrittenConsent(a.doc)) return { allowed: false, reason: 'no_stored_consent' };
  return { allowed: true, reason: 'consent_on_record' };
}

// ── The consent RECORD (2026-10-03, legal-checklist audit) ────────────────
// A stored `tcpaConsent: true` says THAT the box was ticked. A record you can
// defend also says WHEN (server clock, not the browser's), WHAT the person
// agreed to (the exact disclosure text they saw), WHERE (which page) and from
// which IP. The text lives here, once, keyed by a short version id; the lead
// document stores only the id. If the wording on a form ever changes, add a
// NEW version — never edit an existing one, or every record already stamped
// with that id silently starts pointing at words nobody agreed to.
// tests/tcpa-consent.test.js pins each page's label to the text below.
const SMS_TERMS_TAIL = 'by call or text at the number above. Message frequency varies. '
  + 'Message & data rates may apply. Reply STOP to opt out, HELP for help. '
  + 'Consent is not a condition of purchase.';
const CONSENT_TEXTS = Object.freeze({
  // /storm-check, /roof-score, /storm-report, and (from 2026-10-03) /inspect,
  // /storm-alerts, the homepage form and the on-page quick form.
  'tcpa-v1-2026-10-03':
    'I agree to receive my results and follow-up communication from No Big Deal Home Solutions '
    + 'by call or text at the number above. Message & data rates may apply. Reply STOP to opt out. '
    + 'Not a condition of purchase.',
  // The /estimate funnel's own wording (docs/estimate.html #tcpaConsent).
  'tcpa-estimate-v1-2026-10-03':
    'I agree to receive my estimate and follow-up communication from No Big Deal Home Solutions. '
    + 'Message & data rates may apply. Reply STOP to opt out.',
  // 2026-10-05 (Twilio A2P campaign review): every form now carries the full
  // carrier set — frequency, HELP, "Consent is not a condition of purchase" and
  // a Privacy Policy link (the link text is not part of the stored words). The
  // v1 texts above stay: records already stamped with them must keep meaning
  // what those people saw.
  'tcpa-v2-2026-10-05':
    'I agree to receive my results and follow-up communication from No Big Deal Home Solutions '
    + SMS_TERMS_TAIL,
  'tcpa-estimate-v2-2026-10-05':
    'I agree to receive my estimate and follow-up communication from No Big Deal Home Solutions '
    + SMS_TERMS_TAIL,
  // /storm-alerts says what it actually sends (v1 there read "my results").
  'tcpa-storm-alerts-v2-2026-10-05':
    'I agree to receive storm alerts and follow-up communication from No Big Deal Home Solutions '
    + SMS_TERMS_TAIL,
});
const CONSENT_VERSION = 'tcpa-v2-2026-10-05';
const ESTIMATE_CONSENT_VERSION = 'tcpa-estimate-v2-2026-10-05';
const STORM_ALERTS_CONSENT_VERSION = 'tcpa-storm-alerts-v2-2026-10-05';

/** Which disclosure a submission of this public-lead kind was shown. */
function consentVersionForKind(kind) {
  if (kind === 'estimate') return ESTIMATE_CONSENT_VERSION;
  // 'storm' is only ever posted by /storm-alerts (window._saveStormAlert).
  if (kind === 'storm') return STORM_ALERTS_CONSENT_VERSION;
  return CONSENT_VERSION;
}

/**
 * The page path a submission came from, for tcpaConsentSource. Prefers the
 * Referer's pathname (what the browser actually loaded) and falls back to the
 * form's own `source` tag. Never the query string — UTMs and the like are not
 * part of the consent record and can carry personal data.
 */
function consentSourcePath(referer, source) {
  if (typeof referer === 'string' && referer) {
    try {
      const p = new URL(referer).pathname;
      if (p) return p.slice(0, 200);
    } catch (_) { /* not a URL — fall through */ }
  }
  return String(source == null ? '' : source).slice(0, 200);
}

/**
 * The fields to stamp onto a public-lead document that carries consent.
 * Returns {} unless consent is exactly `true` — a decline or an absent field
 * gets no record (and so cannot be mistaken for one).
 *
 * @param {object} a
 * @param {*}      a.consent    the parsed tcpaConsent value
 * @param {string} a.kind       submitPublicLead kind
 * @param {string} [a.referer]  request Referer header
 * @param {string} [a.source]   the form's own source tag
 * @param {string} [a.ip]       request IP, when the handler has it
 * @param {*}      a.at         timestamp value (FieldValue.serverTimestamp())
 */
function consentRecord(a) {
  const o = a || {};
  if (o.consent !== true) return {};
  const rec = {
    tcpaConsentAt: o.at,
    tcpaConsentText: consentVersionForKind(o.kind),
    tcpaConsentSource: consentSourcePath(o.referer, o.source),
  };
  if (o.ip) rec.tcpaConsentIp = String(o.ip).slice(0, 64);
  return rec;
}

module.exports = {
  CONSENT_FIELD,
  CONSENT_COLLECTIONS,
  CONSENT_TEXTS,
  CONSENT_VERSION,
  ESTIMATE_CONSENT_VERSION,
  STORM_ALERTS_CONSENT_VERSION,
  parseSubmittedConsent,
  hasWrittenConsent,
  smsAckGate,
  consentVersionForKind,
  consentSourcePath,
  consentRecord,
};
