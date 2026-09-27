/**
 * functions/lead-bridge-logic.js — pure (firebase-free) logic for the
 * public-lead → CRM-pipeline bridge (Phase C, H-1 fix).
 *
 * Split out from lead-bridge.js so it can be unit-tested with zero deps
 * (no firebase-admin / functions runtime). The trigger file owns the
 * Firestore I/O; everything here is a pure function of its inputs.
 *
 * The problem (H-1): submitPublicLead writes public-form submissions into
 * per-kind collections (contact_leads, estimate_leads, inspect_leads,
 * free_roof_entries). The CRM pipeline reads the `leads` collection
 * (rules scope reads to `userId == auth.uid`). Nothing copied public
 * leads into `leads`, so they never reached the pipeline — the owner only
 * learned of them by email. This module maps a public lead onto a CRM
 * `leads` doc and resolves which tenant/owner it belongs to.
 *
 * Tenant model:
 *   - NBD (tenant zero): public forms pass NO companyId → owner is the
 *     tenant-zero uid; solo convention => companyId == owner uid.
 *   - A tenant microsite passes a validated companyId (submitPublicLead
 *     checks it against the companies registry) → owner is
 *     companies/{companyId}.ownerId, or the companyId itself when the id
 *     is a uid (solo tenant). If no owner is resolvable, the caller skips
 *     the mirror (never guesses an owner — that would leak a lead into the
 *     wrong pipeline or none at all).
 */

'use strict';

const { phoneDigits10 } = require('./phone-utils');

// Public kinds that become CRM pipeline leads. contact / estimate / inspect /
// free_roof bridge UNCONDITIONALLY. storm bridges CONDITIONALLY — only the
// high-intent concerns (see shouldBridgeStorm); the bulk of storm signups are
// a marketing LIST, not pipeline leads. `guide` (download) is a list-builder,
// never bridged. label matches lead-alert's KIND_LABEL so the CRM `source`
// reads the same as the alert subject.
const BRIDGE_KINDS = {
  contact_leads:           { kind: 'contact',   label: 'Contact form' },
  estimate_leads:          { kind: 'estimate',  label: 'Instant Estimate' },
  inspect_leads:           { kind: 'inspect',   label: 'Inspection / Storm tool' },
  free_roof_entries:       { kind: 'free_roof', label: 'Free Roof entry' },
  storm_alert_subscribers: { kind: 'storm',     label: 'Storm Alert' },
  // Thumbtack webhook pushes (integrations/thumbtack.js). NOT a website form —
  // see EXTERNAL_SOURCE_LABEL below for why its `source` is spelled differently.
  thumbtack_leads:         { kind: 'thumbtack', label: 'Thumbtack' },
};

// Collections whose leads arrive from an EXTERNAL marketplace rather than an
// NBD web form. Their CRM `source` must read as the channel itself ("Thumbtack")
// — not "Website — Thumbtack" — because channel attribution is what the lead
// scorecard buckets on, and a mislabelled source silently credits paid
// marketplace spend to the website. `webLead` stays false for the same reason.
const EXTERNAL_SOURCE_COLLECTIONS = ['thumbtack_leads'];

// Storm-form "What are you most concerned about?" values. 'hail' is the form's
// PRE-SELECTED default (passive newsletter intent), so it is NOT a deliberate
// signal. The other three are an explicit pick = a homeowner reporting real
// damage = a hot lead worth both an alert (lead-alert.js) AND a CRM pipeline
// card (the storm bridge). Single source of truth so alert + bridge can't drift.
const HIGH_INTENT_STORM_CONCERNS = ['insurance', 'wind', 'general'];

// Human labels for the concern field (mirrors lead-alert.js CONCERN_LABEL) so
// the bridged pipeline card's note reads in plain English.
const STORM_CONCERN_LABEL = {
  hail:      'Hail damage to roof',
  wind:      'Wind damage',
  general:   'General severe weather',
  insurance: 'Already has damage — waiting on insurance',
};

// Should this storm_alert_subscribers doc become a CRM lead? Only when the
// homeowner deliberately flagged real damage (not the hail default).
function shouldBridgeStorm(data) {
  const concern = String((data || {}).concern || '').toLowerCase();
  return HIGH_INTENT_STORM_CONCERNS.indexOf(concern) !== -1;
}

// Firebase Auth uids are 28-char alphanumeric strings. A tenant whose
// companyId looks like a uid is a solo operator (companyId == uid), so the
// owner is the companyId itself. A short slug like 'oaks' is NOT a uid and
// requires an explicit companies/{id}.ownerId.
function looksLikeUid(s) {
  return typeof s === 'string' && /^[A-Za-z0-9]{20,}$/.test(s);
}

// Resolve { ownerUid, companyId } for a public lead, or null when no owner
// can be safely determined (caller then skips the CRM mirror).
//   companyId   — the lead's (already-validated) tenant tag, or '' for NBD.
//   companyDoc  — companies/{companyId} data, or null if absent/unread.
//   opts.nbdOwnerUid — tenant-zero owner uid (NBD default when untagged).
function resolveBridgeTarget(companyId, companyDoc, opts) {
  opts = opts || {};
  const nbdOwnerUid = opts.nbdOwnerUid || null;
  companyId = companyId ? String(companyId) : '';

  // Untagged → NBD (tenant zero). Solo convention: companyId == owner uid,
  // matching every in-app NBD lead (userId == companyId == Joe's uid).
  if (!companyId) {
    if (!nbdOwnerUid) return null;
    return { ownerUid: nbdOwnerUid, companyId: nbdOwnerUid };
  }

  // Tenant-tagged. Prefer the company doc's explicit owner.
  const ownerId = companyDoc && (companyDoc.ownerId || companyDoc.ownerUid);
  if (ownerId) return { ownerUid: String(ownerId), companyId };

  // Solo tenant whose companyId IS their uid (no separate company doc).
  if (looksLikeUid(companyId)) return { ownerUid: companyId, companyId };

  // Tenant is known (submitPublicLead validated it) but has no resolvable
  // owner uid (e.g. companies/oaks.ownerId not set yet). Skip — do not guess.
  return null;
}

// Deterministic CRM doc id so a re-delivered trigger can't create a second
// lead for the same public submit (idempotency via create()-or-skip).
function bridgeDocId(collection, sourceId) {
  return String(collection) + '__' + String(sourceId);
}

// The /estimate funnel saves follow-up EVENT docs (results shown, CTA
// click, email request) into estimate_leads alongside the initial lead
// save. Each event carries a `type` tag; the initial save has none.
// Bridging the events too gave the owner up to 4 duplicate "New" pipeline
// cards per completed funnel. Known event types are skipped; an UNKNOWN
// future type still bridges (fail-open — never silently drop a possible
// lead). estimate-email.js still fires on email_estimate_request docs.
const ESTIMATE_EVENT_TYPES = ['estimate_result', 'cta_click', 'email_estimate_request'];
function isFollowUpEvent(collection, data) {
  return collection === 'estimate_leads' &&
    ESTIMATE_EVENT_TYPES.indexOf(String((data || {}).type || '')) !== -1;
}

// Best-effort name split: the public kinds carry a single `name` (or
// `nomineeName`), except `contact` which already has firstName.
function splitName(data) {
  data = data || {};
  if (data.firstName) {
    return { firstName: String(data.firstName), lastName: String(data.lastName || '') };
  }
  const raw = String(data.name || data.nomineeName || '').trim();
  if (!raw) return { firstName: '(Web lead)', lastName: '' };
  const parts = raw.split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Map a public-form submission onto a CRM `leads` doc (minus the
// serverTimestamp fields, which the trigger adds so this stays pure).
function mapPublicLeadToLead(args) {
  args = args || {};
  const collection = args.collection;
  const data = args.data || {};
  const meta = BRIDGE_KINDS[collection] || { kind: collection, label: collection };
  const isExternal = EXTERNAL_SOURCE_COLLECTIONS.indexOf(collection) !== -1;
  const { firstName, lastName } = splitName(data);

  const notesParts = [];
  const story = data.story || data.message || data.details || '';
  if (story) notesParts.push(String(story));
  if (data.nominatorName) {
    notesParts.push('Nominated by ' + data.nominatorName +
      (data.nominatorRelation ? ' (' + data.nominatorRelation + ')' : ''));
  }
  if (collection === 'free_roof_entries') notesParts.push('"One Free Roof" giveaway entry');
  // Storm: surface the homeowner's damage concern so the rep sees WHY this
  // signup became a hot lead (only high-intent concerns reach the bridge).
  if (collection === 'storm_alert_subscribers') {
    const c = String(data.concern || '').toLowerCase();
    notesParts.push('Storm Alert signup — concern: ' + (STORM_CONCERN_LABEL[c] || c || 'unspecified'));
  }
  if (data.photoCount) notesParts.push('Homeowner has ' + data.photoCount + ' photo(s) to share');
  // Estimator context — so the pipeline card shows what the homeowner
  // actually asked for, not just a name and address. Fields are present
  // only post-M-04 allowlist expansion; older docs simply add no line.
  if (collection === 'estimate_leads') {
    const ctx = [];
    if (data.service) ctx.push(String(data.service) + (data.roofType ? ' (' + String(data.roofType) + ')' : ''));
    if (data.timeline) ctx.push('timeline: ' + String(data.timeline));
    if (ctx.length) notesParts.push('Instant Estimate — ' + ctx.join(' · '));
  }

  const doc = {
    userId: args.ownerUid,
    companyId: args.companyId,
    firstName: firstName,
    lastName: lastName,
    address: String(data.address || data.zip || ''),
    phone: String(data.phone || ''),
    // Normalized match key so an inbound SMS from this homeowner ties back
    // to this lead (incomingSMS queries leads by phoneDigits). See
    // functions/phone-utils.js.
    phoneDigits: phoneDigits10(data.phone),
    email: String(data.email || ''),
    stage: 'New',
    status: 'new',
    source: isExternal ? meta.label : 'Website — ' + meta.label,
    // External sources (thumbtack.js) precompute a richer note than the generic
    // story/message/details assembly below can reach — prefer it when present.
    notes: (isExternal && data.notes) ? String(data.notes) : notesParts.join('\n'),
    // provenance + idempotency anchor
    webLead: !isExternal,
    publicLeadKind: meta.kind || collection,
    publicLeadCollection: collection,
    publicLeadId: String(args.sourceId || ''),
    // Attribution (2026-09-13). Every public form posts a page-level `source`
    // ('/inspect', '/storm-check', 'page-form:/areas/mason-oh', 'tenant-site:…')
    // that `source` above collapses into one kind label. Kept verbatim so a
    // lead-source count is one query, not a join back to the public
    // collection. `source` is unchanged (lead-alert and the scorecard key on
    // it). Cal.com leads carry sourcePage 'calcom:<event-slug>'
    // (integrations/calcom-logic.js).
    sourcePage: String(data.source || ''),
  };

  // Coordinates (2026-09-06). The /estimate wizard geocodes the address at
  // step 1 and the gateway now persists lat/lon on the public lead; carry
  // them onto the CRM lead under the repo's canonical names (`lat`/`lng` —
  // note the public form's `lon` becomes `lng` here; hail-cron.js tolerates
  // both spellings but nothing else writes the alternates, so do not spread
  // the drift). integrations/public-measure.js measures the roof off these,
  // and the map/heatmap layers stop having to re-geocode a bridged lead.
  const _lat = Number(data.lat), _lng = Number(data.lon != null ? data.lon : data.lng);
  if (isFinite(_lat) && isFinite(_lng) && Math.abs(_lat) <= 90 && Math.abs(_lng) <= 180
      && !(_lat === 0 && _lng === 0)) {
    doc.lat = _lat;
    doc.lng = _lng;
  }

  // Marketing attribution — only when the gateway passed it through.
  if (data.utm_source)   doc.utmSource = String(data.utm_source);
  if (data.utm_medium)   doc.utmMedium = String(data.utm_medium);
  if (data.utm_campaign) doc.utmCampaign = String(data.utm_campaign);
  if (data.referrer)     doc.referrer = String(data.referrer);

  // Referral-code self-redemption: a friend entered a customer's personal
  // code on the public form. Carry it onto the CRM lead (uppercased to match
  // the referrals-collection code format) so the onReferralLeadWrite trigger
  // can attribute it and credit the $100 bonus on close.
  // Strip to A-Z0-9- so the redeemed value matches the minted code format
  // exactly (internal spaces/punctuation would miss the exact-match lookup and
  // silently lose the referrer's $100).
  if (data.referralCode) doc.redeemReferralCode = String(data.referralCode).toUpperCase().replace(/[^A-Z0-9-]/g, '');

  // TCPA consent provenance (2026-09-04). The homeowner ticked the express-
  // written-consent box on the public form; carry that fact onto the CRM lead
  // so the proof lives where Jo actually looks, not only on the raw public-lead
  // document. Copied strictly (`=== true`) and only when present, so a lead
  // that never captured consent is silently absent rather than stamped false.
  //
  // Scope note, deliberately: NOTHING in the CRM reads this yet. The CRM's own
  // outbound texting is Jo hand-initiating a message to someone he is already
  // doing business with — a different consent posture from an automated ack —
  // and auto-blocking it on this flag would break his daily driver. This is the
  // audit record; gating CRM sends on it is a separate decision, not a
  // side effect of persisting the fact.
  if (data.tcpaConsent === true) doc.tcpaConsent = true;

  // Per-lead acquisition cost (2026-09-20). Thumbtack's leadPrice (webhook
  // payload, thumbtack-logic.js normalizeLead) previously only reached the
  // CRM as a text line inside `notes` ("Lead cost: $51.96") — nothing wrote
  // the structured `leadCost` field lead-source-roi.js and expense-config.js's
  // DIRECT `lead_acquisition` category actually key on, so every Thumbtack
  // lead bridged after the one-off 09-06 backfill silently carried no
  // trackable cost until someone typed it in by hand. Scoped to EXTERNAL
  // sources only — leadPrice is Thumbtack's own field name, not something an
  // NBD web form sends. Never stamp a speculative 0 (mirrors the backfill
  // script's own rule): "no cost line" and "cost of $0" are different facts.
  if (isExternal && data.leadPrice != null) {
    const leadCostNum = parseFloat(String(data.leadPrice).replace(/[^0-9.]/g, ''));
    if (isFinite(leadCostNum) && leadCostNum > 0) doc.leadCost = leadCostNum;
  }

  return doc;
}

module.exports = {
  BRIDGE_KINDS,
  EXTERNAL_SOURCE_COLLECTIONS,
  ESTIMATE_EVENT_TYPES,
  HIGH_INTENT_STORM_CONCERNS,
  STORM_CONCERN_LABEL,
  shouldBridgeStorm,
  isFollowUpEvent,
  looksLikeUid,
  resolveBridgeTarget,
  bridgeDocId,
  splitName,
  mapPublicLeadToLead,
};
