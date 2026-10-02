/**
 * types.js — JSDoc typedefs for every Firestore document shape we touch.
 *
 * This file holds NO runtime code. It exists so editors (VS Code,
 * WebStorm) can resolve `@type` annotations across our vanilla-JS
 * codebase without committing to a TypeScript migration. Loaded as a
 * <script> tag costs ~2KB and gives us:
 *
 *   - Autocomplete on lead.firstNa<cursor>  → firstName
 *   - Red-squiggle on photo.urll          (typo'd field)
 *   - Hover-doc showing every known field with comment
 *
 * Usage in a regular .js file:
 *
 *   /** @type {Lead} *\/
 *   const lead = await getDoc(...).data();
 *   lead.fullName  // editor autocompletes
 *
 *   /** @param {Photo} photo *\/
 *   function renderTile(photo) { ... }
 *
 * Or:
 *
 *   /** @type {Array<Photo>} *\/
 *   window._customerPhotos = [];
 *
 * The shapes here mirror what the live Firestore docs actually contain
 * — derived from the existing call sites + firestore.rules + the
 * Cloud Functions that write them. They are the source of truth for
 * "what is in this collection?" — if you add a new field on a doc,
 * add it here too.
 *
 * Single source of truth. Update this file when schemas change. The
 * migration framework (todo #4) will reference these typedefs in
 * migration up/down scripts.
 */

/* ─── primitives ─────────────────────────────────────────────────── */

/**
 * @typedef {object} FirestoreTimestamp
 * @property {() => Date} toDate
 * @property {() => number} toMillis
 * @property {number} seconds
 * @property {number} nanoseconds
 */

/**
 * Either a Firestore Timestamp (server-set) or a plain ISO/millis
 * string we stamped client-side before the server sync. Comparator
 * helpers normalize both.
 * @typedef {FirestoreTimestamp | string | number | null | undefined} TimestampLike
 */

/**
 * Insurance carrier slug. Free-text but the kanban filter expects one
 * of a known set; new values silently bucket into "Other".
 * @typedef {string} CarrierSlug
 */

/**
 * Lead pipeline stage key. The full set is exported by KANBAN_VIEWS
 * in dashboard.html; managed by view-* preset (insurance / cash / etc).
 * @typedef {string} StageKey
 */

/* ─── /leads/{leadId} ────────────────────────────────────────────── */

/**
 * A customer record. Created from the new-lead modal, kanban quick-
 * add, D2D promotion, or a public form (Cloud Function only — not
 * client-write since C-3 hardening).
 *
 * @typedef {object} Lead
 *
 * @property {string} id
 *   Firestore doc id. NOT stored as a field — fetched from the snap.
 *
 * @property {string} userId
 *   Owner uid. Required by /leads/{id} create rule.
 *
 * @property {string} companyId
 *   Tenant id. **Required on create since PR #60.** Backfilled on
 *   every existing prod lead by PR #56.
 *
 * @property {string=} customerId
 *   Sequential NBD-#### id minted by counters/leads transaction.
 *   Set on first save; never re-minted.
 *
 * @property {string=} firstName
 * @property {string=} lastName
 * @property {string=} fullName
 *   Either firstName+lastName OR fullName — the new-lead modal
 *   accepts both shapes for free-form entry.
 *
 * @property {string=} email
 * @property {string=} phone
 * @property {string=} address
 * @property {string=} city
 * @property {string=} state
 * @property {string=} zip
 *
 * @property {StageKey=} stage
 *   Current kanban column. Default 'NEW_LEAD'.
 *
 * @property {TimestampLike=} stageStartedAt
 *   When the lead entered its current stage (PR #40 T18).
 *
 * @property {string=} damageType
 *   "Roof - Hail" | "Roof - Wind" | "Roof - Hail & Wind" |
 *   "Siding - Hail" | "Gutters" | etc. (see crmDmgFilter <select>).
 *
 * @property {CarrierSlug=} carrier
 *   Insurance carrier — surfaces in the lead card badge.
 *
 * @property {string=} adjusterName
 * @property {string=} adjusterPhone
 * @property {string=} adjusterEmail
 *   Only present when stage >= INSPECTED.
 *
 * @property {string=} coverPhotoId
 * @property {string=} coverPhotoUrl
 *   Rep-chosen cover photo (RoofLink "Set Cover") — id of the photo doc
 *   plus a denormalized URL so the customer hero, mobile job-detail hero,
 *   kanban thumbs, and estimate PDF cover render without a photo lookup.
 *
 * @property {number=} estimateTotalCents
 *   Last-saved grand total, integer cents. Drives the kanban $
 *   pipeline rollup.
 *
 * @property {boolean=} deleted
 *   Soft-delete flag — never hard-delete from this collection because
 *   estimates/photos/documents reference leadId.
 *
 * @property {TimestampLike=} createdAt
 * @property {TimestampLike=} updatedAt
 */

/* ─── /photos/{photoId} ──────────────────────────────────────────── */

/**
 * A single photo attached to a lead. Uploaded via the customer page
 * upload modal or the dashboard photo view. Storage path is
 * audio/{uid}/{leadId}/{photoId}.{ext} — see storage.rules.
 *
 * @typedef {object} Photo
 *
 * @property {string} id
 * @property {string} userId
 * @property {string} leadId
 * @property {string=} companyId
 *
 * @property {string} url
 *   Public Firebase Storage download URL (signed if needed). This
 *   is the ORIGINAL upload — full-resolution iPhone JPEG, etc.
 *   Render code should prefer `urls` (responsive variants) when
 *   present and fall back to `url` for legacy docs.
 *
 * @property {string=} storagePath
 *   Canonical Storage object name. Shape varies by upload surface:
 *   customer page `photos/{uid}/{custId}_{ts}_{name}.jpg`,
 *   dashboard + photo-engine `photos/{uid}/{leadId}/{ts}_{name}.jpg`,
 *   photo-editor `photos/{uid}/{leadId}/photo_{id}.jpg` — always
 *   owner-rooted at segment [1]. Used by the image-pipeline Cloud
 *   Function to find this doc after it generates
 *   `_thumb/_med/_full.webp` variants, and by delete paths to
 *   remove the Storage object without cracking the download URL.
 *   Set on every write since the image-pipeline rollout (PR #75;
 *   dashboard/photo-editor writers joined 2026-08-16); legacy docs
 *   may be missing it until the backfill migration runs.
 *
 * @property {{ thumb: string, med: string, full: string }=} urls
 *   Responsive WebP variants generated by
 *   `functions/image-pipeline.js` on Storage upload. Keys map to
 *   widths 200 / 600 / 1600 px. Customer-facing render code emits
 *   `<img srcset>` from this object — see `buildPhotoImgAttrs`
 *   in customer.html. Missing on legacy docs until backfilled.
 *
 * @property {TimestampLike=} variantsGeneratedAt
 *   Server timestamp written by image-pipeline when variants land.
 *
 * @property {string=} originalUrl
 *   The pristine pre-annotation camera photo's download URL. Backed up
 *   ONCE, idempotently, the first time the photo editor's flatten-and-
 *   save-over (`uploadBlob()` in photo-editor.js) overwrites `url` with an
 *   annotated/flattened copy — so the original is never silently orphaned
 *   in Storage. Undefined until the first save-over; a later save-over
 *   never overwrites it again.
 *
 * @property {string=} originalStoragePath
 *   Storage object name paired with `originalUrl` — same one-time,
 *   idempotent backup, set alongside it.
 *
 * @property {string=} filename
 *   Original filename for display + report captions.
 *
 * @property {('Before'|'During'|'After'|string)=} phase
 *   Job-stage tag. Drives the phase grouping on the customer photo
 *   grid. Default 'During' if missing.
 *
 * @property {string=} category
 *   "Property" | "Damage" | "Repair" | "Reference" — display badge.
 *
 * @property {string=} damageType
 *   "hail" | "wind" | "missing-shingles" | "leak" | "granule-loss" |
 *   "lifted-shingles" | "other" — see bulk-action dropdown.
 *
 * @property {('minor'|'moderate'|'severe'|string)=} severity
 *
 * @property {string=} location
 *   Free text — e.g. "north slope".
 *
 * @property {string=} description
 *   Free text caption.
 *
 * @property {Array<string>=} tags
 *
 * @property {Array<object>=} annotations
 *   Vector shape data from the photo editor's drawing tools (pen, line,
 *   arrow, rect, circle, text, callout, stamp, measure, eraser) — a
 *   JSON-serialized copy of the editor's in-memory annotation list.
 *   Written by both `saveTagsOnly()` (tags-only save, no flatten) and
 *   `uploadBlob()` (flatten + save) in photo-editor.js, so a marked-up
 *   photo can be reopened with its shapes still editable rather than only
 *   the flattened pixels. Distinct from `isAnnotated`, which just flags
 *   that a flattened copy exists.
 *
 * @property {boolean=} isAnnotated
 *   True when the photo editor has saved a marked-up overlay.
 *
 * @property {boolean=} sharedWithHomeowner
 *   When true, the photo is exposed to the homeowner-facing
 *   `/pro/portal.html?token=...` view via getHomeownerPortalView
 *   (PR #80). Toggled per-tile from the customer page Share
 *   badge. Default false — the rep must opt each photo in
 *   explicitly so internal damage workups can't leak.
 *
 * @property {string=} homeownerCaption
 *   Optional homeowner-facing caption shown beneath the photo on
 *   the portal gallery. Distinct from `description`, which is
 *   the rep-facing internal note — homeowners never see that.
 *
 * @property {number=} order
 *   Drag-arranged display order (PR #68). Integer ascending. Photos
 *   without `.order` fall back to uploadedAt sort.
 *
 * @property {number=} size
 *   Bytes — original upload size, before transcode.
 *
 * @property {string=} type
 *   MIME type from upload — image/jpeg, image/heic, etc.
 *
 * @property {TimestampLike=} date
 * @property {TimestampLike=} uploadedAt
 */

/* ─── /estimates/{estimateId} ────────────────────────────────────── */

/**
 * An estimate written by the V2 builder (canonical) or the legacy
 * builder (deprecated, see Rock 2 audit). Every estimate is owned by
 * one userId and references one leadId.
 *
 * @typedef {object} Estimate
 *
 * @property {string} id
 * @property {string} userId
 * @property {string} leadId
 * @property {string=} companyId
 *
 * @property {string=} title
 *   Display name on the customer page list.
 *
 * @property {string=} address
 *   Property address — denormalized from /leads for speed.
 *
 * @property {('economy'|'good'|'better'|'best'|'beyond'|string)=} tier
 *   Pricing tier picked. $440 / $550 / $660 / $770 / $880 per-SQ in the V2
 *   engine (five tiers since 2026-10-02; Beyond = TAMKO HailGuard only).
 *
 * @property {number=} grandTotalCents
 *   Final price including tax + adjustments, integer cents.
 *
 * @property {Array<EstimateLineItem>=} lineItems
 *
 * @property {boolean=} deleted
 * @property {TimestampLike=} createdAt
 * @property {TimestampLike=} updatedAt
 */

/**
 * One line item inside an Estimate.lineItems array.
 * @typedef {object} EstimateLineItem
 * @property {string} description
 * @property {string=} name
 * @property {number=} quantity
 * @property {string=} unit
 * @property {number=} amount
 *   Display dollars (number) — historic format. New writes use Cents.
 * @property {number=} amountCents
 */

/* ─── /users/{uid} ───────────────────────────────────────────────── */

/**
 * Self-owned user profile. Privileged fields (role, plan, accessCode,
 * isAdmin, companyId) are blocked on client write by firestore.rules
 * — they only change via Cloud Function (admin SDK).
 *
 * @typedef {object} UserProfile
 * @property {string} id            Same as auth uid.
 * @property {string=} email
 * @property {string=} firstName
 * @property {string=} lastName
 * @property {string=} phone
 * @property {string=} companyName
 * @property {('admin'|'company_admin'|'manager'|'sales_rep'|'viewer'|string)=} role
 * @property {string=} plan         'free' | 'starter' | 'growth' | 'enterprise' (legacy docs may carry 'foundation'/'blueprint'/'professional')
 * @property {string=} companyId
 * @property {boolean=} isAdmin
 * @property {TimestampLike=} createdAt
 */

/* ─── /companies/{companyId} ─────────────────────────────────────── */

/**
 * Tenant root document. Owner can write; members read.
 * @typedef {object} Company
 * @property {string} id
 * @property {string} name
 * @property {string} ownerId       uid that created the tenant.
 * @property {string=} slug
 * @property {string=} logoUrl
 * @property {TimestampLike=} createdAt
 */

/* ─── /leads/{leadId}/activity/{activityId} ──────────────────────── */

/**
 * Per-lead activity log. Reps can append manual notes/calls/sms via
 * client write; webhooks (measurement, stripe, esign, calcom) write
 * via admin SDK. firestore.rules enforces source/type allowlists on
 * client writes — see the F-05 hardening.
 *
 * @typedef {object} LeadActivity
 * @property {string} id
 * @property {string} userId
 * @property {('rep'|'webhook'|'system')} source
 * @property {('note'|'call'|'sms_out'|'email_out'|'photo_added'|
 *            'task_done'|'appointment_set'|'door_knock'|
 *            'follow_up'|'status_change'|string)} type
 * @property {string=} note
 * @property {TimestampLike=} createdAt
 */
