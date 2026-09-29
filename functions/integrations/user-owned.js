/**
 * integrations/user-owned.js — canonical registry of every Firestore
 * collection, collectionGroup, Storage prefix, and owner-keyed doc
 * path that is tied to a single end-user uid.
 *
 * Single source of truth for:
 *   - `confirmAccountErasure` (M-01): GDPR Article 17 cascade. A user
 *     who requests right-to-be-forgotten expects every trace of their
 *     data removed. Before this registry, the cascade named 7 flat
 *     collections and 1 collection-group; the full list below is 21
 *     flat collections, 2 groups, 8 Storage prefixes, 5 owner-keyed
 *     uid-path docs, and the vestigial nested-leads subtree.
 *
 *   - `exportMyData` (M-02): GDPR Article 20 data export. Same shape,
 *     read side. A dump that omits 2/3 of the user's data is not a
 *     portable export.
 *
 * Rule for additions: if a new collection, subcollection, or Storage
 * prefix stores user data keyed by uid (via a field or a path
 * segment), it goes in THIS file before it lands in a rule file. The
 * registry is the blast-radius map. If it's not here, erasure and
 * export both silently miss it.
 *
 * Rule for exclusions: append-only audit trails (audit_log,
 * account_erasures) are intentionally excluded — the whole point of
 * those is to survive account deletion.
 */

'use strict';

// ─── FLAT COLLECTIONS ───────────────────────────────────────
// Every top-level collection that stamps the owner uid on each doc.
// Default ownerField is 'userId'; specify when a collection uses a
// different field name (e.g. invoices uses `createdBy`).
//
// Source: firestore.rules + grep for `collection(...).add({ userId }`
// across functions/ and docs/pro/js/ (see agent audit 2026-04-15).
const FLAT_USER_COLLECTIONS = [
  // recursive: erasure must recursiveDelete each lead so its
  // subcollections (tasks/notes/documents/drawings/portal_messages,
  // plus activity/recordings) go too — a plain doc delete orphans them.
  { name: 'leads', recursive: true },
  { name: 'estimates' },
  // Wave 144: insurance supplements ride on the same owner-scope
  // rule shape as estimates. Each supplement carries
  // { userId, leadId, parentEstimateId, version, ... } and is
  // saved via EstimateSupplement.saveToFirestore() from the
  // customer-page +Supplement button.
  { name: 'supplements' },
  // Expense ledger (Phase 1 expense subsystem). Owner-keyed on userId; a
  // user's expenses + supplier-spend records erase/export with their account.
  // Receipt images live in Storage under receipts/{uid}/ (see the Storage
  // prefix cleanup); the Firestore doc only holds receiptStoragePath.
  { name: 'expenses' },
  // Yard-sign placements (yard-signs.js, 2026-09-29). Owner-keyed on userId;
  // photos live in Storage under yard-signs/{uid}/.
  { name: 'yardSigns' },
  // Recurring-expense templates + supplier/vendor records (money-layer
  // expansion). Owner-keyed on userId; erase/export with the account. Supplier
  // docs hold NO tax IDs (tracking only); the locked suppliers/{id}/private/**
  // seam is admin-SDK-only and has no client data yet.
  { name: 'recurringExpenses' },
  { name: 'suppliers', recursive: true },
  { name: 'photos' },
  { name: 'pins' },
  // Territory zones (drawn canvassing areas, optionally rep-assigned). Owner-
  // keyed on userId + team-shared via companyId (same shape as pins); erase/
  // export with the account. Points are plain {lat,lng}; no PII.
  { name: 'zones' },
  // NEW-D40a: the draw tool's unlinked-drawing fallback — drawings
  // saved with no matching lead land here (leadId '_unlinked_<uid>',
  // userId stamped by saveDrawingToCustomer). Lead-LINKED drawings
  // live under leads/{id}/drawings and ride the recursive leads
  // entry above.
  { name: 'drawings' },
  { name: 'tasks' },
  { name: 'documents' },
  { name: 'communications' },
  { name: 'notifications' },
  { name: 'notes' },
  { name: 'dailyTracker' },
  { name: 'knocks' },
  { name: 'territories' },
  { name: 'products' },
  { name: 'templates' },
  // Close Board deal rooms (close-board.js syncDealToFirestore). Owner-keyed
  // on userId; rides the GDPR cascade so a user's shared deals erase too.
  { name: 'deal_rooms' },
  { name: 'training_sessions' },
  { name: 'drip_queue' },
  { name: 'drip_log' },
  { name: 'lead_documents' },
  { name: 'referrals' },
  { name: 'review_requests' },
  { name: 'reports' },
  // Invoices use `createdBy` (not `userId`) for historical reasons —
  // the original invoice schema predated the userId convention.
  { name: 'invoices', ownerField: 'createdBy' },
  // Appointments are written by the Cal.com webhook (admin-SDK only,
  // see firestore.rules:481-484) but stamp `userId` on each booking
  // so the rep who owns the lead can read them. Caught by the
  // registry-drift sweep — was previously missing from the GDPR
  // cascade, leaving homeowner appointment metadata behind on
  // right-to-be-forgotten.
  { name: 'appointments' },
  // ML roof-edge training pairs written by maps.js when the user
  // corrects the auto-detected outline. Each row carries `userId`
  // plus address/coords — clearly the rep's data, so it rides the
  // GDPR cascade with everything else.
  { name: 'ml_training_data' },
  // Photo-vision cost meters — per-lead AI spend tally. Keyed by
  // leadId but carries ownerUid so the GDPR cascade reaches it via
  // ownerField lookup. Erasing a user erases their AI spend history.
  { name: 'leadCostMeter', ownerField: 'ownerUid' },
  // Per-user monthly Vision spend (doc id = `{uid}__{YYYY-MM}`, body
  // has `uid` field). Same cascade reasoning as leadCostMeter.
  { name: 'userCostMeter', ownerField: 'uid' },
  // Customer-side audit events (audit batch 7) — homeowner activity log.
  // Carries ownerUid so erasure reaches it; rep-readable via that field.
  { name: 'customerAuditEvents', ownerField: 'ownerUid' },
  // Phase-2.1 (registry-drift fix): these are keyed by uid/ownerId but were
  // missing from the registry, so erasure + export silently skipped them —
  // leaving homeowner-linked data behind on right-to-be-forgotten.
  { name: 'measurements', ownerField: 'ownerId' }, // HOVER roof measurements (address/geometry)
  { name: 'email_log',    ownerField: 'uid' },     // sent-email log (homeowner addresses)
  { name: 'sms_log',      ownerField: 'uid' },     // sent-SMS log (homeowner phone numbers)
  // sendSMS idempotency claims (offline SMS outbox + live sends that carry a
  // clientMsgId). Each doc holds the rep's uid and the homeowner's canonical
  // phone key (toDigits). A Firestore TTL on expireAt deletes them after
  // ~8 days anyway; erasure/export must not wait for that.
  { name: 'sms_client_ids', ownerField: 'uid' },
  { name: 'api_usage',    ownerField: 'uid' },     // AI token-usage history
  // Calendar-feed subscription tokens (calendar-feed.js). Each doc is a bearer
  // credential that serves the rep's own schedule — homeowner names, addresses
  // and phones — to anyone holding the URL. Erasing the account must revoke
  // the feed, or a deleted rep's link keeps answering.
  { name: 'calendar_feed_tokens', ownerField: 'uid' },
  // Thursday call log (integrations/thursday.js) — callers' names, numbers,
  // transcripts. Owner-keyed on userId; erase/export with the account.
  { name: 'thursday_calls', ownerField: 'userId' },
];

// ─── COLLECTION-GROUPS WITH userId STAMPS ───────────────────
// Subcollections under other parents whose rows carry a `userId`
// field. `collectionGroup(name).where('userId','==',uid)` reaches
// them without knowing the parent path.
//
// NOT listed: `leads/{leadId}/tasks|notes` — those use the PARENT
// lead's userId for authorization (firestore.rules:101-112), rows
// do not carry their own userId field, so a collectionGroup sweep
// wouldn't find them. They get nuked by the nested-leads
// recursiveDelete path instead.
const COLLECTION_GROUPS_WITH_USERID = [
  'recordings',   // leads/{leadId}/recordings/{id} — Voice Intelligence
  'activity',     // leads/{leadId}/activity/{id}   — F-05 rep + webhook stamps
];

// ─── STORAGE PREFIXES ───────────────────────────────────────
// Every Storage bucket path of the shape `<prefix>/{uid}/...`.
// Right-to-be-forgotten means deleting the binary payloads too, not
// just the Firestore row.
//
// This list used to say "per storage.rules", and that framing is what
// let it drift: storage.rules is not a registry of what exists, only of
// what has a rule. Four prefixes were missing on 2026-09-08 — `documents`
// and `esign` had rules blocks nobody had mirrored here, while
// `pdf-renders` and `homeowner-uploads` are written by the ADMIN SDK
// (which bypasses rules entirely) and had no block at all, so no amount
// of reading storage.rules would ever have found them.
//
// scripts/check-storage-prefix-registry.js now derives the true set from
// BOTH sources — `match /<prefix>/{uid}/` blocks in storage.rules AND
// `<prefix>/${uid}/` write sites in functions/ + docs/**/js/ — and fails
// if either names a prefix this list omits. Add the prefix here when you
// add the write site; the gate will tell you if you forget.
//
// SCOPE: this list is the EXPORT scope (GDPR Art. 15) — everything the
// user can obtain. Erasure (Art. 17) uses ERASURE_STORAGE_PREFIXES below,
// which is this list minus a documented retention hold.
const STORAGE_PREFIXES = [
  'audio',
  'photos',
  'docs',
  // `portals/{uid}/...` covers the legacy baked-HTML customer portals
  // (portals/{uid}/{leadId}/v-<ts>.html + portals/{uid}/{leadId}-photos.html).
  // Those static files carry permanent, never-expiring Storage download-token
  // URLs that bypass Security Rules, so erasure MUST delete them — the
  // Firestore lead row alone isn't enough. The prefix sweep below
  // (deleteFiles `portals/{uid}/`) removes every version + the photo gallery
  // in one call. (The live portal is token-based and stores no Storage blob.)
  'portals',
  'galleries',
  'reports',
  'shared_docs',
  'deal_rooms',
  // receipts/{uid}/... — original receipt images/PDFs backing expense docs
  // (Phase 1 expense subsystem). Owner-keyed like docs/; erase with the account.
  'receipts',
  // yard-signs/{uid}/... — photos of placed yard signs (yard-signs.js).
  'yard-signs',
  // documents/{uid}/{leadId}/{docId}.html — generated + signed customer
  // documents (document-generator.js onPersistFinalized, storage.rules:96).
  // Added 2026-09-08. onLeadDeleted already reaps this prefix per-lead
  // (lead-artifact-cleanup.js LEAD_KEYED_PREFIXES), so erasure was clearing
  // MOST of it as a side effect of deleting the lead rows — best-effort,
  // via a trigger with `retry: false`, and blind to any object whose lead
  // row was already gone. Listing it here makes the sweep deterministic and
  // catches those orphans. They historically carried permanent download
  // tokens (documentation/audit/ORPHANED-STORAGE-ARTIFACTS-2026-08-18.md),
  // where deletion is the only revocation there is.
  'documents',
  // esign/{uid}/{leadId}/{envelopeId}/{source,signed}.pdf — e-sign envelopes
  // (storage.rules:119). EXPORT ONLY — see ERASURE_RETAINED_PREFIXES below.
  'esign',
  // homeowner-uploads/{ownerUid}/{leadId}/{ts}.{ext} — photos the HOMEOWNER
  // submits through the portal (portal.js uploadHomeownerPhoto). Admin-SDK
  // write, no storage.rules block, and not a `photos/` object, so neither the
  // rules file nor the lead reaper ever named it. The upload files its
  // Firestore row into `photos` (which IS erased) while the bytes landed
  // here, so erasure deleted the pointer and left the image. Same content
  // class as photos/ — a customer's property — so it erases with it.
  'homeowner-uploads',
  // pdf-renders/{uid}/{ts}-{slug}.pdf — server-rendered invoices, contracts,
  // warranties and reports (render-pdf.js). In neither the export nor the
  // erasure sweep since the renderer shipped. Objects written before
  // 2026-09-08 carry permanent download tokens (19 of 21 in prod), which
  // makes deleting them the only revocation available.
  'pdf-renders',
  // calls/{uid}/{callId}.{ext} — Thursday call recordings copied from Bland
  // (integrations/thursday.js saveRecording). Admin-SDK write, streamed to the
  // CRM by getThursdayRecording; callers' voices erase with the account.
  'calls',
];

// ─── ERASURE RETENTION HOLDS ────────────────────────────────
// Prefixes that are EXPORTED but deliberately NOT erased.
//
// GDPR Art. 17(3) carves out erasure where processing is necessary for
// the establishment, exercise or defence of legal claims. An executed,
// counter-signed contract is the paradigm case: it is the record of an
// agreement between two parties, and the other party's interest in it
// does not end because one party asks to be forgotten.
//
// Decided by Jo on 2026-09-08, deliberately and not as a code cleanup:
// esign/ holds source.pdf + signed.pdf for every envelope. Nothing has
// ever deleted one — it is absent from LEAD_KEYED_PREFIXES too — so this
// is not a new hold, it is the existing behaviour finally written down
// and made honest to the data subject (confirmAccountErasure reports
// what it retained; see compliance.js).
//
// Anything listed here MUST also be in STORAGE_PREFIXES, so that what is
// retained is at least obtainable by the person asking. The registry gate
// enforces that.
const ERASURE_RETAINED_PREFIXES = [
  'esign',
];

// The erasure sweep's actual scope. Derived, never hand-maintained — a
// prefix added to STORAGE_PREFIXES is erased unless someone deliberately
// puts it on the retention list above.
const ERASURE_STORAGE_PREFIXES = STORAGE_PREFIXES.filter(
  p => !ERASURE_RETAINED_PREFIXES.includes(p)
);

// ─── OWNER-KEYED UID-PATH DOCS ───────────────────────────────
// Firestore docs addressed as `<coll>/{uid}` directly — no scan
// needed, just a targeted delete/get. Excludes `account_erasures`
// and any audit-trail collections intentionally.
const OWNER_KEYED_DOCS = [
  'users',
  'subscriptions',
  'userSettings',
  'leaderboard',
  'reps',
  'estimate_drafts',
  'feature_flags',
];

// ─── NESTED-LEADS SUBTREE ───────────────────────────────────
// Vestigial `leads/{uid}/leads/{leadId}` path from an old schema
// (firestore.rules:140-145). No current writer, but the rule still
// permits the owner to write here, and previous GDPR sweeps missed
// the subtree. Erasure uses `db.recursiveDelete(NESTED_LEADS_PATH(uid))`
// to wipe the whole doc + every child collection in one call.
function NESTED_LEADS_PATH(uid) {
  return 'leads/' + uid;
}

module.exports = {
  FLAT_USER_COLLECTIONS,
  COLLECTION_GROUPS_WITH_USERID,
  STORAGE_PREFIXES,
  ERASURE_RETAINED_PREFIXES,
  ERASURE_STORAGE_PREFIXES,
  OWNER_KEYED_DOCS,
  NESTED_LEADS_PATH,
};
