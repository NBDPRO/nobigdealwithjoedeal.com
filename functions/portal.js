/**
 * functions/portal.js — homeowner-portal Cloud Functions
 *
 * L-03: extracted from functions/index.js as the first step in
 * breaking that 2900-line monolith up. The three exports here plus
 * the token-mint helpers are fully self-contained; nothing else in
 * the codebase reaches into portal state.
 *
 * Exports:
 *   createPortalToken       (onCall)   — rep mints a per-lead share token
 *   revokePortalToken       (onCall)   — rep or admin kills tokens
 *   getHomeownerPortalView  (onRequest) — homeowner POSTs token → redacted view
 *
 * Storage shape: `portal_tokens/{token}` admin-SDK only (firestore.rules:459).
 * Tokens are 24 chars from a 32-char no-confusable alphabet → 32^24
 * possibilities, infeasible to brute-force against the per-IP rate limit.
 *
 * Flow:
 *   1. Rep calls createPortalToken({leadId}) — mints token, stores
 *      { leadId, ownerUid, expiresAt, uses:0, maxUses:100 }.
 *   2. Rep SMS/emails the URL `/pro/portal.html?token=<tok>` to the
 *      homeowner.
 *   3. Homeowner opens portal.html → client POSTs to
 *      getHomeownerPortalView({token}) → redacted view of lead + rep
 *      + latest estimate + optional BoldSign signing URL.
 *
 * Redaction: homeowner never sees claim details, internal notes,
 * rep commission, or other leads.
 */

'use strict';

const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { FieldValue } = require('firebase-admin/firestore');

const {
  SECRETS: INT_SECRETS,
  hasSecret: hasInt,
  getSecret: getInt,
} = require('./integrations/_shared');

// R-01 rate-limit adapter (Upstash → Firestore fallback) for the
// per-IP gate on getHomeownerPortalView.
const { httpRateLimit } = require('./integrations/upstash-ratelimit');

// B2: shared authz helper — callableRateLimit lives in shared.js
// alongside other cross-module primitives. portal.js was where the
// duplicated copy was first flagged.
const { callableRateLimit } = require('./shared');
const { applyRepReplyEffects } = require('./portal-reply-effects');
// Customer-safe line items for the shared-estimate view. This is a byte-copy
// of docs/pro/js/customer-estimate-rows.js (Functions deploys only functions/;
// a smoke drift guard in tests/customer-estimate-rows.test.js asserts the two
// stay identical). NEVER emit est.rows raw — pre-sweep V2 rows carry the
// contractor's COST basis.
const { buildDisplayRows, buildDocLineItems, tierApplies } = require('./customer-estimate-rows');
// The estimate's deposit-rule stamp, validated + whitelisted (2026-09-25).
const { safeDepositPlan } = require('./deposit-plan-view');
// Single authority check for portal-link mint/revoke: platform admin, owning
// rep, or a company_admin of the lead's tenant. Pure module — decision is
// unit-tested there, not here.
const { canManageLead, portalTenant, recordInPortalTenant, tokenMatchesLead } = require('./portal-authz');

// CORS origins — identical to the list in functions/index.js. The
// duplication is deliberate: portal.js is meant to be importable on
// its own, and the origin allowlist is short and rarely changes.
// If/when more modules peel off, this goes into shared.js.
const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ─── Token minting ──────────────────────────────────────────
// 32-char no-confusable alphabet (no 0/O, 1/I/L). 24 bytes of
// crypto.randomBytes → 24 chars of token → ~120 bits of entropy.
const PORTAL_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/**
 * D-2.7 — auto-pair before/after photos for the homeowner portal.
 *
 * Given the raw photo docs (already filtered to sharedWithHomeowner
 * by the caller), find the strongest before/after pair per location.
 * Returns an array of { before, after, location } in stable order.
 *
 * Pairing rule:
 *   group by photo.location (skip photos without a location)
 *   per group: pick the most-recent phase==='Before' and the most-
 *   recent phase==='After'. Both required for a valid pair.
 *
 * We deliberately don't fall back to "any two photos at this location"
 * — a before/after slider with two random shots is worse than no
 * slider. Reps who want a pair need to phase-tag both shots.
 *
 * Returns at most 6 pairs (avoids overwhelming the portal page).
 */
function _pairBeforeAfter(photos) {
  if (!Array.isArray(photos) || photos.length < 2) return [];
  const byLoc = new Map();
  for (const p of photos) {
    const loc = (p.location || '').trim();
    if (!loc) continue;
    const phase = String(p.phase || '').toLowerCase();
    if (phase !== 'before' && phase !== 'after') continue;
    if (!byLoc.has(loc)) byLoc.set(loc, { before: null, after: null });
    const slot = byLoc.get(loc);
    const created = p.createdAt && (p.createdAt.toMillis ? p.createdAt.toMillis() : (p.createdAt.seconds ? p.createdAt.seconds * 1000 : 0)) || 0;
    if (phase === 'before') {
      if (!slot.before || created > (slot.before._ms || 0)) slot.before = Object.assign({}, p, { _ms: created });
    } else {
      if (!slot.after  || created > (slot.after._ms  || 0)) slot.after  = Object.assign({}, p, { _ms: created });
    }
  }
  const pairs = [];
  for (const [loc, slot] of byLoc.entries()) {
    if (slot.before && slot.after) {
      pairs.push({
        location: loc,
        before: { url: slot.before.url || null, urls: slot.before.urls || null },
        after:  { url: slot.after.url  || null, urls: slot.after.urls  || null },
      });
    }
  }
  // Newest-after-first so the most-recent comparison surfaces at top.
  pairs.sort((a, b) => (b.after._ms || 0) - (a.after._ms || 0));
  return pairs.slice(0, 6).map(p => ({
    location: p.location,
    before:   p.before,
    after:    p.after,
  }));
}

function mintPortalToken() {
  const bytes = require('crypto').randomBytes(24);
  let s = '';
  for (const b of bytes) s += PORTAL_TOKEN_ALPHABET[b % PORTAL_TOKEN_ALPHABET.length];
  return s;
}

// ═══════════════════════════════════════════════════════════════
// createPortalToken
// ═══════════════════════════════════════════════════════════════
exports.createPortalToken = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 15,
    memory: '256MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    // D1: a compromised rep session could otherwise mint millions of
    // tokens. 30/min/uid is way more than a human ever needs.
    await callableRateLimit(request, 'createPortalToken', 30, 60_000);
    const leadId = typeof request.data?.leadId === 'string' ? request.data.leadId : null;
    if (!leadId) throw new HttpsError('invalid-argument', 'leadId required');

    const db = getFirestore();
    const leadSnap = await db.doc(`leads/${leadId}`).get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
    const lead = leadSnap.data();
    // Owning rep, same-tenant company_admin, or platform admin. The tenant
    // admin needs mint too — revoke→re-mint is one workflow in the dashboard.
    if (!canManageLead(request.auth.token, uid, lead)) {
      throw new HttpsError('permission-denied', 'Not your lead');
    }

    // 30-day default TTL — rep can force re-mint anytime.
    const ttlDays = Math.min(90, Math.max(1, Number(request.data?.ttlDays) || 30));
    const now = Date.now();
    const expiresAt = Timestamp.fromMillis(now + ttlDays * 86_400_000);

    const token = mintPortalToken();
    await db.doc(`portal_tokens/${token}`).set({
      leadId,
      ownerUid: lead.userId,
      // Tenant key carried on the token so sendPortalMessage can stamp
      // companyId on the thread without a per-message lead read. ownerUid is
      // lead.userId — the REP's uid, which diverges from companyId on a team
      // tenant — so it is only a last-resort fallback, never the source.
      companyId: lead.companyId || null,
      mintedBy: uid,
      mintedAt: FieldValue.serverTimestamp(),
      expiresAt,
      uses: 0,
      maxUses: 100  // generous — homeowner may reload across days
    });
    return { token, expiresAt: expiresAt.toMillis() };
  }
);

// ═══════════════════════════════════════════════════════════════
// revokePortalToken
// Flips tokens to an expired timestamp rather than deleting so the
// audit trail survives. Owner-scoped; platform admin unrestricted.
// ═══════════════════════════════════════════════════════════════
exports.revokePortalToken = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 15,
    memory: '256MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    await callableRateLimit(request, 'revokePortalToken', 30, 60_000);
    const leadId = typeof request.data?.leadId === 'string' ? request.data.leadId : null;
    const tokenId = typeof request.data?.token === 'string' ? request.data.token : null;
    if (!leadId && !tokenId) {
      throw new HttpsError('invalid-argument', 'leadId or token required');
    }

    const db = getFirestore();
    const claims = request.auth.token || {};
    const isAdmin = claims.role === 'admin';
    let revoked = [];
    // The legacy-portal purge below is lead-level; when the caller passes
    // only a token id, derive the lead from the token doc.
    let resolvedLeadId = leadId;

    // Resolve the token first (when given) so the lead — and therefore the
    // authority check — is known BEFORE anything is flipped.
    let tokenRef = null;
    let tokenData = null;
    if (tokenId) {
      tokenRef = db.doc(`portal_tokens/${tokenId}`);
      const snap = await tokenRef.get();
      if (!snap.exists) throw new HttpsError('not-found', 'Token not found');
      tokenData = snap.data();
      if (!resolvedLeadId && typeof tokenData.leadId === 'string') {
        resolvedLeadId = tokenData.leadId;
      }
    }

    // One lead read up front: the gate, the batch filter, and the legacy
    // purge below all key off it.
    let lead = null;
    let leadRef = null;
    if (resolvedLeadId) {
      leadRef = db.doc(`leads/${resolvedLeadId}`);
      const ls = await leadRef.get();
      if (ls.exists) lead = ls.data();
    }
    // Lead gone (deleted): tenant membership can't be proven, so only the
    // platform admin — or, below, the token's own minter — may still clean up.
    const canManage = lead ? canManageLead(claims, uid, lead) : isAdmin;

    if (tokenRef) {
      if (!canManage && tokenData.ownerUid !== uid) {
        throw new HttpsError('permission-denied', 'Not your token');
      }
      await tokenRef.update({
        expiresAt: Timestamp.fromMillis(Date.now() - 1),
        revokedAt: FieldValue.serverTimestamp(),
        revokedBy: uid
      });
      revoked = [tokenId];
    } else {
      // Revoke every token for this lead the caller has authority over.
      const q = await db.collection('portal_tokens')
        .where('leadId', '==', leadId)
        .get();
      const batch = db.batch();
      q.forEach(d => {
        const data = d.data();
        if (!canManage && data.ownerUid !== uid) return;
        batch.update(d.ref, {
          expiresAt: Timestamp.fromMillis(Date.now() - 1),
          revokedAt: FieldValue.serverTimestamp(),
          revokedBy: uid
        });
        revoked.push(d.id);
      });
      if (revoked.length) await batch.commit();
      // Honesty (audit 2026-08-02): tokens exist but the caller could flip
      // none → that's a permission failure, not `{success:true, revoked:0}`.
      // The old silent skip made a tenant owner believe a departed rep's
      // link was dead when it was still live.
      if (!q.empty && revoked.length === 0) {
        throw new HttpsError('permission-denied', 'Not your lead');
      }
    }

    // ── Legacy baked-HTML Storage purge ──────────────────────────────
    // Pre-#698, customer-portal.js baked a lead's data into a static HTML
    // file and uploaded it to Storage at
    //   portals/{uid}/{leadId}/v-<ts>.html   (full project portal, versioned)
    //   portals/{uid}/{leadId}-photos.html   (photo gallery portal)
    // persisting the getDownloadURL on the lead (portalUrl / portalPath /
    // portalHistory[].path / photoPortalUrl). A Storage download-token URL
    // bypasses Security Rules and never expires, so flipping portal_tokens
    // above left those already-shared links live forever. Delete the objects
    // and clear the dead fields so a revoke actually revokes. Owner-or-admin
    // gated — never touch another tenant's artifacts or lead doc.
    if (resolvedLeadId && lead && leadRef) {
      try {
        // (bare block: the lead was already read for the gate above; keeps
        // the purge body's original indentation for a reviewable diff)
        {
          const ownerUid = lead.userId;
          if (canManage) {
            // Collect every baked-HTML object path recorded for this lead.
            const paths = new Set();
            if (typeof lead.portalPath === 'string' && lead.portalPath) {
              paths.add(lead.portalPath);
            }
            if (Array.isArray(lead.portalHistory)) {
              for (const h of lead.portalHistory) {
                if (h && typeof h.path === 'string' && h.path) paths.add(h.path);
              }
            }
            // The photo portal persisted only its URL, never a path — but the
            // object location is deterministic.
            if (lead.photoPortalUrl && ownerUid) {
              paths.add(`portals/${ownerUid}/${resolvedLeadId}-photos.html`);
            }
            const bucket = getStorage().bucket();
            let deleted = 0;
            for (const p of paths) {
              // Defense-in-depth: only ever delete inside the portals/ tree.
              if (!p.startsWith('portals/')) continue;
              try {
                await bucket.file(p).delete({ ignoreNotFound: true });
                deleted++;
              } catch (e) {
                logger.warn('revokePortalToken: storage delete failed',
                  { path: p, err: e.message });
              }
            }
            // Strip the now-dead URL/path fields so the dashboard stops
            // surfacing a link that 404s.
            if (paths.size || lead.portalUrl || lead.photoPortalUrl) {
              await leadRef.update({
                portalUrl: FieldValue.delete(),
                portalPath: FieldValue.delete(),
                portalHistory: FieldValue.delete(),
                portalGeneratedAt: FieldValue.delete(),
                photoPortalUrl: FieldValue.delete(),
                photoPortalGeneratedAt: FieldValue.delete()
              });
            }
            logger.info('revokePortalToken: legacy portal purge',
              { leadId: resolvedLeadId, objectsDeleted: deleted, objectsFound: paths.size });

            // Remote-signing links live in an independent collection
            // (doc_sign_tokens, own 7-day TTL). A revoke must kill them too, or
            // an already-emailed sign link stays bindingly signable after the
            // rep revoked the lead (QA finding). Query by leadId only (auto
            // single-field index) + filter pending in code — no new composite.
            try {
              const signSnap = await db.collection('doc_sign_tokens')
                .where('leadId', '==', resolvedLeadId).get();
              const sbatch = db.batch();
              let signRevoked = 0;
              signSnap.forEach((d) => {
                if ((d.data().status || '') === 'pending') {
                  sbatch.update(d.ref, { status: 'revoked', revokedAt: FieldValue.serverTimestamp(), revokedBy: uid });
                  signRevoked++;
                }
              });
              if (signRevoked) await sbatch.commit();
              logger.info('revokePortalToken: sign tokens revoked', { leadId: resolvedLeadId, count: signRevoked });
            } catch (e) {
              logger.warn('revokePortalToken: sign-token revoke failed', { leadId: resolvedLeadId, err: e.message });
            }
          } else {
            logger.warn('revokePortalToken: legacy purge skipped — caller lacks authority on this lead',
              { leadId: resolvedLeadId });
          }
        }
      } catch (e) {
        // Never fail the revoke because cleanup of a legacy artifact errored —
        // the token expiry above is the security-critical part and is done.
        logger.warn('revokePortalToken: legacy purge failed',
          { leadId: resolvedLeadId, err: e.message });
      }
    }

    logger.info('revokePortalToken', { leadId: resolvedLeadId, count: revoked.length });
    // revoked: 0 now ONLY means "nothing was active" — a caller without
    // authority throws above instead of getting a success-shaped no-op.
    return revoked.length
      ? { success: true, revoked: revoked.length }
      : { success: true, revoked: 0, reason: 'no_active_tokens' };
  }
);

// ═══════════════════════════════════════════════════════════════
// getHomeownerPortalView — homeowner-facing POST → redacted view.
// ═══════════════════════════════════════════════════════════════
// ── Project progress (homeowner-facing milestones) ──────────────────
// Map the rep-side stage key to one of 5 user-friendly milestones
// homeowners actually understand. Internal stages like
// "supplement_requested" do not matter to them — they want to know "are we
// still inspecting" vs "is someone coming to install".
const HOMEOWNER_PROGRESS = [
  { key: 'inspected',        label: 'Inspection',     blurb: 'We\'ve looked at your property.' },
  { key: 'estimate_sent',    label: 'Estimate',       blurb: 'You have a written quote.' },
  { key: 'contract_signed',  label: 'Contract',       blurb: 'Signed and ready to schedule.' },
  { key: 'install',          label: 'Installation',   blurb: 'The crew is on the job.' },
  { key: 'complete',         label: 'Complete',       blurb: 'Project finished — final walkthrough done.' }
];
const STAGE_TO_PROGRESS = {
  // Pre-inspection / contact-only — show "Inspection" as upcoming
  'new': 'inspected', 'contacted': 'inspected',
  // Inspection done
  'inspected': 'inspected',
  // Insurance pipeline — collapse to "Estimate" once a number is on the table
  'claim_filed': 'inspected', 'adjuster_meeting_scheduled': 'inspected',
  'adjuster_inspection_done': 'estimate_sent', 'scope_received': 'estimate_sent',
  'estimate_submitted': 'estimate_sent', 'supplement_requested': 'estimate_sent',
  'supplement_approved': 'estimate_sent',
  // Cash / finance — same idea
  'estimate_sent_cash': 'estimate_sent', 'negotiating': 'estimate_sent',
  'prequal_sent': 'estimate_sent', 'loan_approved': 'estimate_sent',
  // Contract signed
  'contract_signed': 'contract_signed',
  // Job phase
  'job_created': 'contract_signed', 'permit_pulled': 'contract_signed',
  'materials_ordered': 'contract_signed', 'materials_delivered': 'install',
  'crew_scheduled': 'install', 'install_in_progress': 'install',
  'install_complete': 'install',
  'final_photos': 'complete', 'deductible_collected': 'complete',
  'final_payment': 'complete', 'closed': 'complete'
};

// ONE owner for "which milestone is this lead on?".
//
// 2026-09-08: this lived inside getHomeownerPortalView while
// submitCustomerRating carried its own hardcoded literal list —
// ['final_photos','deductible_collected','final_payment','closed'] — under a
// comment claiming those were "exactly the stages that map to the
// 'complete' progress milestone". They were not, in two ways, and both
// reach a real homeowner:
//
//   * A legacy raw display stage ('Complete', 'Closed Won', 'Won', 'Closed')
//     is not a key in STAGE_TO_PROGRESS, so the view fell through to the
//     role fallback, stage-roles ALIASed it to 'closed', the role came back
//     'won', and progressKey became 'complete' — canRate true, card
//     rendered. The submit gate then compared the RAW stage against its
//     literal list, missed, and answered 409 "You can rate once the job is
//     complete." on a job that was complete.
//   * A tenant CUSTOM stage carrying stageRole 'won' does the same thing.
//
// So a homeowner tapped five stars on a finished roof and was told it was
// not finished. Two gates for one invariant drift; now there is one.
function progressKeyFor(lead) {
  const stageKey = (lead && (lead._stageKey || lead.stage)) || 'new';
  let progressKey = STAGE_TO_PROGRESS[stageKey];
  if (!progressKey) {
    // A tenant CUSTOM stage is not in the map — fall back by its semantic
    // role (persisted on the lead by crm-pipeline moveCard).
    const _role = require('./stage-roles').roleFor(lead);
    progressKey = _role === 'won' ? 'complete' : (_role === 'job' ? 'install' : 'inspected');
  }
  return progressKey;
}

// ONE owner for "when did each homeowner-facing milestone first happen?".
// Indexes lead.stageHistory (array of {from, to, timestamp, user}, written by
// commitStageChange in docs/pro/js/stage-write.js) by mapping each entry's
// destination stage through STAGE_TO_PROGRESS, keeping the EARLIEST
// timestamp per milestone bucket — mirrors the "first entry wins" fix
// already shipped on the rep side (docs/pro/js/customer-tasks-ui.js:446-455):
// a bounce-back re-entry into an earlier stage must not overwrite the date
// the lead first reached a later milestone.
//
// A tenant CUSTOM stage (not a key in STAGE_TO_PROGRESS) has no per-history-
// entry role recorded — stageRole is stamped on the LEAD doc at write time,
// not inside the historyEvent itself — so there is no way to know which
// milestone a historical custom-stage entry belonged to. Those entries are
// skipped for dating purposes; progressKeyFor's live role fallback still
// resolves the CURRENT position for them, just without a per-step date.
//
// timestamp is written as new Date().toISOString() (stage-write.js), never
// a Firestore Timestamp, so plain string comparison is chronological — same
// "ship the raw value, format client-side" call already made for
// scheduledDate below.
function milestoneDatesFor(lead) {
  const dates = {};
  const history = Array.isArray(lead && lead.stageHistory) ? lead.stageHistory : [];
  for (const h of history) {
    if (!h || !h.to || typeof h.timestamp !== 'string') continue;
    const key = STAGE_TO_PROGRESS[h.to];
    if (!key) continue;
    if (!(key in dates) || h.timestamp < dates[key]) dates[key] = h.timestamp;
  }
  return dates;
}

// ONE owner for "is this leads/{id}/documents row visible to the
// homeowner?" (documents shelf, 2026-09-16). Used BOTH to build the shelf
// list below and by getPortalDocumentHtml to re-check a specific docId
// before returning bytes — the exact "two gates for one invariant" drift
// progressKeyFor's own comment above describes, avoided by having one
// function instead of two independently-written filters.
function _isDocVisibleToHomeowner(d) {
  return !!d && d.deleted !== true && (d.generated === true || d.sharedWithHomeowner === true);
}

// ── Homeowner-upload signed-URL refresh ─────────────────────────────
// uploadHomeownerPhoto bakes a signed URL into the photo doc with a 7-day
// expiry (the per-request max). Its own comment predicted the consequence and
// deferred it: "a future wave will move all rep gallery reads through
// signImageUrl on demand". Until that wave, the baked URL simply dies — and
// the first person to see it die is the homeowner, looking at the broken tile
// where the photo they sent their contractor used to be. The same doc feeds
// the rep's customer-page gallery, so it breaks on both sides at once.
//
// Re-sign lazily: only when the stored expiry is missing or inside the renewal
// window, so the portal's 30s poll does not mint a new URL every tick. Docs
// written before urlExpiresAt existed fall back to uploadedAt, and anything
// older than the 7-day life is treated as stale.
//
// Best-effort throughout. getSignedUrl needs roles/iam.serviceAccountTokenCreator
// on the runtime SA; if that is ever revoked this must degrade to the stale URL
// rather than blanking a gallery — see the photo-token cutover note.
const HOMEOWNER_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOMEOWNER_URL_RENEW_MS = 24 * 60 * 60 * 1000; // re-sign inside 24h of death

function _homeownerUrlIsStale(p, nowMs) {
  const exp = typeof p.urlExpiresAt === 'number'
    ? p.urlExpiresAt
    : (p.uploadedAt && p.uploadedAt.toMillis ? p.uploadedAt.toMillis() + HOMEOWNER_URL_TTL_MS : 0);
  return !exp || exp - nowMs < HOMEOWNER_URL_RENEW_MS;
}

async function _refreshHomeownerPhotoUrls(docs, nowMs) {
  const fresh = new Map();
  const stale = docs.filter((d) => {
    const p = d.data();
    return p.source === 'homeowner' && typeof p.path === 'string' && p.path
      && _homeownerUrlIsStale(p, nowMs);
  });
  if (!stale.length) return fresh;
  await Promise.all(stale.map(async (d) => {
    try {
      const expires = nowMs + HOMEOWNER_URL_TTL_MS;
      const [url] = await getStorage().bucket().file(d.data().path).getSignedUrl({
        action: 'read', expires,
      });
      fresh.set(d.id, url);
      // Write back so the rep's gallery — which reads the same doc and does
      // NOT go through here — gets the fresh URL too.
      await d.ref.update({ url, urlExpiresAt: expires });
    } catch (e) {
      // Keep the stale URL. A broken tile is better than a blank gallery, and
      // far better than a 500 on the whole portal.
      logger.warn('homeowner photo url refresh failed', { photoId: d.id, err: e && e.message });
    }
  }));
  return fresh;
}

exports.getHomeownerPortalView = onRequest(
  {
    region: 'us-central1',
    // Wave 87: CORS lockdown. Was `cors: true` (any origin), which
    // let any page on the web POST to this endpoint and harvest the
    // redacted portal view if they could guess/intercept a token.
    // The actual call site is portal.html on our own domain — the
    // statically-generated portal HTML in Firebase Storage doesn't
    // hit this endpoint (its data is baked in at generation time).
    // So the allowlist is exactly the same as the rep-facing
    // endpoints above. If/when we serve portal HTML from a custom
    // sub-domain, add it here explicitly.
    cors: CORS_ORIGINS,
    // R-05 sizing: homeowner-facing (not a rep path), so volume is
    // bounded by "number of active portal links × opens". At 10k
    // signed homeowners with an avg 3 opens/week during a storm
    // spike that's ~500/hour sustained, burst to maybe 2000 concurrent
    // during an email blast. 80×80 = 6.4k ceiling gives 3× headroom.
    maxInstances: 80,
    concurrency: 80,
    timeoutSeconds: 15,
    memory: '256MiB',
    secrets: [INT_SECRETS.BOLDSIGN_API_KEY]
  },
  async (req, res) => {
    // F-06: POST only. Previously accepted GET with the token in the
    // query string, which leaked via access logs / Referer / browser
    // history on every homeowner pageload. portal.html now POSTs.
    if (req.method !== 'POST') { res.status(405).end(); return; }

    // Rate-limit per IP — 30/min is plenty for a homeowner on the
    // page and stops an attacker from brute-forcing tokens.
    if (!(await httpRateLimit(req, res, 'portal:ip', 30, 60_000))) return;

    const token = (req.body && req.body.token) || '';
    // Charset-validate (not just length): a token with a '/' makes an odd-segment
    // Firestore path that throws uncaught → opaque 500 instead of a clean 400.
    // Minted tokens are [A-Za-z0-9]; mirrors deal-acceptance.js's guard.
    //
    // `code` is the stable, machine-readable half of every error this
    // endpoint returns. The portal keys its copy off it because the status
    // alone cannot separate the two 429s below, which need opposite advice,
    // and because 400 here means "the link arrived truncated" — a real and
    // common outcome of an SMS client clipping a long URL, which the page
    // used to answer with "please try again in a moment". Statuses are
    // unchanged; a portal build that predates this ignores `code` and falls
    // back to them. The other six portal endpoints still carry the bare
    // guard — uniform codes there are a follow-up, not this slice.
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token', code: 'bad_token' });
      return;
    }
    // The live poller (portal.js, every 30s while the tab is foreground) hits
    // this same endpoint. A poll is a continuation of an existing open, NOT a
    // new "use" — counting it against maxUses would brick the portal in ~50min
    // of an open tab (QA finding). Polls therefore skip both the cap check and
    // the use-increment; only genuine opens deplete the replay budget.
    const isPoll = !!(req.body && req.body.poll);

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);
    const tokSnap = await tokRef.get();
    if (!tokSnap.exists) { res.status(404).json({ error: 'Invalid link', code: 'unknown_link' }); return; }
    const tok = tokSnap.data();

    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'This link has expired. Contact your rep for a new one.', code: 'expired' });
      return;
    }
    if (!isPoll && typeof tok.maxUses === 'number' && (tok.uses || 0) >= tok.maxUses) {
      res.status(429).json({ error: 'This link has been opened too many times.', code: 'too_many_opens' });
      return;
    }

    // Load lead, rep, latest estimate, and any photos the rep has
    // explicitly shared with the homeowner. Photos are gated by
    // `sharedWithHomeowner: true` — the rep flips the flag from
    // customer.html. We deliberately don't return EVERY photo
    // (homeowner doesn't need to see internal damage workups or
    // photos uploaded for a different lead by mistake).
    //
    // limit(50) caps the gallery — generous for a real project,
    // tight enough that a misclick can't dump 500 photos to the
    // homeowner page in one fetch.
    const [leadSnap, repSnap, estSnap, photoSnap, docSnap, envSnap, invSnap] = await Promise.all([
      db.doc(`leads/${tok.leadId}`).get(),
      db.doc(`users/${tok.ownerUid}`).get(),
      db.collection('estimates')
        .where('leadId', '==', tok.leadId)
        .limit(10)
        .get(),
      db.collection('photos')
        .where('leadId', '==', tok.leadId)
        .where('userId', '==', tok.ownerUid)
        .where('sharedWithHomeowner', '==', true)
        .limit(50)
        .get(),
      // Unfiltered + unordered, same as the rep-side reader
      // (docs/pro/js/customer-documents.js) — no composite index required,
      // so it cannot fail closed the way an index-less filtered query does.
      // The generated/shared split happens in memory below.
      db.doc(`leads/${tok.leadId}`).collection('documents').get(),
      // Signed non-contract paperwork (change orders, inspection reports —
      // anything routed through esign.html rather than the main BoldSign
      // contract embed above). Top-level collection, own leadId field.
      db.collection('esign_envelopes')
        .where('leadId', '==', tok.leadId)
        .where('status', '==', 'completed')
        .limit(20)
        .get(),
      // Balance due (2026-09-16). Top-level collection, same
      // where('leadId', ...) pattern invoice-pipeline.js already queries by.
      db.collection('invoices')
        .where('leadId', '==', tok.leadId)
        .limit(20)
        .get()
    ]);

    if (!leadSnap.exists) { res.status(404).json({ error: 'Project not found', code: 'project_missing' }); return; }
    const lead = leadSnap.data();
    // 2026-09-25 (review of PR #1777): a lead id can be re-created by another
    // tenant after a hard delete. The old tenant's link must not open the new
    // lead, and the estimates / e-sign envelopes / invoices below, found by
    // leadId alone, must be this tenant's. See portal-authz.js.
    if (!tokenMatchesLead(tok, lead)) {
      res.status(404).json({ error: 'Project not found', code: 'project_missing' });
      return;
    }
    const tenant = portalTenant(tok, lead);
    const rep = repSnap.exists ? repSnap.data() : {};

    // Multi-tenant branding: resolve the tenant's legal name from its
    // companyProfile so a non-NBD rep's homeowner sees THEIR company name,
    // not NBD's. Keyed by the lead's companyId (falls back to the owner uid
    // for solo tenants — companyId === uid there). One best-effort read on
    // the already-async path; NBD (profile brand.legalName is already
    // 'No Big Deal Home Solutions', or profile absent) keeps the exact
    // rep.companyName || rep.company || NBD fallback below → byte-identical.
    let tenantName = '';
    // Full white-label (2026-07-19): expose the tenant's OWN logo + accent to
    // the portal renderer. Only tenant-set values leak out (never NBD's
    // defaults — same identity rule as client _resolveBrand), the logo must
    // be https, and NBD itself keeps {name only} so the client's hardcoded
    // NBD logo/footer stay byte-identical.
    let tenantLogoUrl = '';
    let tenantColors = null;
    const tenantKey = lead.companyId || tok.ownerUid;
    if (tenantKey) {
      try {
        const cpSnap = await db.doc(`companyProfile/${tenantKey}`).get();
        if (cpSnap.exists) {
          const _b = (cpSnap.data() || {}).brand || {};
          const _ln = _b.legalName || '';
          const _isTenant = _ln && _ln !== 'No Big Deal Home Solutions';
          tenantName = _isTenant ? _ln : '';  // NBD-name guard (byte-identical; mirrors render-pdf.js/sms-functions.js)
          if (_isTenant) {
            if (typeof _b.logoUrl === 'string' && /^https:\/\//i.test(_b.logoUrl)) tenantLogoUrl = _b.logoUrl;
            const _c = _b.colors || {};
            const HEX = /^#[0-9a-f]{3,8}$/i;
            const accent = HEX.test(_c.accent || '') ? _c.accent : null;
            const primary = HEX.test(_c.primary || '') ? _c.primary : null;
            if (accent || primary) tenantColors = { accent, primary };
          }
        }
      } catch (e) {
        logger.warn('[portal] tenant resolve failed', { err: e.message });
      }
    }

    // Pick the latest SHARED estimate (createdAt desc). In-memory sort to
    // avoid a composite-index requirement for this rarely-hit path.
    //
    // This used to be estimates[0] with no filter at all. Estimates are
    // created with only {createdAt, userId, companyId} — no status, no
    // sentAt, no share flag — so the newest save was on the homeowner's
    // phone within seconds, whatever it was. A rep pricing three tiers side
    // by side published the scratch one, labelled "Draft" next to a real
    // dollar figure. Pricing control is the deal; the rep decides when a
    // number leaves the building, not the sort order.
    //
    // Three signals count as "the rep meant this to be seen", any one of:
    //   • sharedWithHomeowner — stamped by the Share button on the estimate
    //     row (shareEstimateViewLink), the rep's existing deliberate gesture
    //   • the signature lifecycle — putting it out for signature IS sharing
    //   • sentAt — set by the flows that email/text it out
    // Anything else is private and the portal renders no estimate card.
    //
    // Deliberately NOT grandfathered: estimates predating this carry none of
    // the three, so they stay hidden until the rep re-shares. Hiding a price
    // the customer already saw is recoverable in one click; leaking one the
    // rep never approved is not.
    const SHARED_SIG = ['sent', 'viewed', 'signed', 'declined', 'expired'];
    const isSharedEstimate = (e) =>
      e.sharedWithHomeowner === true
      || SHARED_SIG.includes(e.signatureStatus)
      || !!e.sentAt;

    const estimates = estSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(e => recordInPortalTenant(e, ['userId'], tenant));
    estimates.sort((a, b) => {
      const ta = a.createdAt?.toMillis?.() || 0;
      const tb = b.createdAt?.toMillis?.() || 0;
      return tb - ta;
    });
    const latest = estimates.find(isSharedEstimate) || null;

    // REDACTION: only non-sensitive fields reach the homeowner.
    // No claim details, no internal notes, no rep commission, no
    // other leads.

    // If the estimate is awaiting signature AND BoldSign is
    // configured AND the signer email on file matches the one
    // stored on the estimate, request a fresh embed signing URL.
    let signEmbedUrl = null;
    if (latest
        && (latest.signatureStatus === 'sent' || latest.signatureStatus === 'viewed')
        && latest.signatureProvider === 'boldsign'
        && latest.signatureDocumentId
        && latest.signerEmail
        && hasInt('BOLDSIGN_API_KEY')) {
      try {
        const apiKey = getInt('BOLDSIGN_API_KEY');
        const embedRes = await fetch(
          `https://api.boldsign.com/v1/document/getEmbeddedSignLink?documentId=${encodeURIComponent(latest.signatureDocumentId)}&signerEmail=${encodeURIComponent(latest.signerEmail)}`,
          { headers: { 'X-API-KEY': apiKey } }
        );
        if (embedRes.ok) {
          const d = await embedRes.json();
          // Wave 87: validate the URL points at app.boldsign.com
          // BEFORE we hand it to portal.html for iframe embedding.
          // BoldSign's API normally returns a https://app.boldsign.com/...
          // URL, but a future API change or a redirect-style response
          // could return an attacker-controlled origin. The portal
          // page iframes whatever URL we hand back — if that's
          // anywhere other than BoldSign, we just embedded a third
          // party site for the homeowner.
          const candidate = d.signLink || d.signUrl || null;
          if (candidate && /^https:\/\/app\.boldsign\.com\//i.test(candidate)) {
            signEmbedUrl = candidate;
          } else if (candidate) {
            logger.warn('portal embed url rejected — wrong origin', { candidate });
          }
        }
      } catch (e) {
        logger.warn('portal embed link fetch failed', { err: e.message });
      }
    }

    // Project progress — see progressKeyFor() at module scope. Both this
    // view and submitCustomerRating resolve through it, so the rating card
    // can never render on a job whose rating the server will then refuse.
    const progressKey = progressKeyFor(lead);
    const currentIdx = HOMEOWNER_PROGRESS.findIndex(p => p.key === progressKey);
    const nextStep = currentIdx >= 0 && currentIdx < HOMEOWNER_PROGRESS.length - 1
      ? HOMEOWNER_PROGRESS[currentIdx + 1] : null;
    const progress = {
      milestones: HOMEOWNER_PROGRESS,
      currentKey:    progressKey,
      currentIndex:  currentIdx,
      currentLabel:  HOMEOWNER_PROGRESS[currentIdx]?.label || 'In Progress',
      nextLabel:     nextStep?.label || null,
      nextBlurb:     nextStep?.blurb || null,
      // The install date. crm-stages.js requires scheduledDate on EVERY track
      // to reach CREW_SCHEDULED (tests/crm-required-fields.test.js guards it),
      // so from that stage on this is a real commitment a rep typed, not a
      // guess — and it was the one question the portal could not answer.
      //
      // Shipped as the raw YYYY-MM-DD string ON PURPOSE. The past/today/future
      // decision has to be made in the READER's timezone and this function
      // runs in UTC, so formatting or comparing here would be wrong for every
      // homeowner. Shape-validated so a malformed value renders nothing rather
      // than "Invalid Date" on a customer's screen.
      scheduledDate: /^\d{4}-\d{2}-\d{2}$/.test(String(lead.scheduledDate || ''))
        ? lead.scheduledDate
        : null,
      // {inspected: <ISOString>, estimate_sent: ..., ...} — only keys the
      // lead has actually reached carry a date; see milestoneDatesFor above.
      milestoneDates: milestoneDatesFor(lead),
    };

    // Refresh any homeowner-upload URL that is dead or nearly dead before
    // it reaches the gallery. Rep-uploaded photos carry permanent variant
    // URLs in `urls` and are untouched.
    const _freshUrls = await _refreshHomeownerPhotoUrls(photoSnap.docs, Date.now());

    // Documents shelf (2026-09-16). Two visibility rules on leads/{id}/documents:
    //   - generated === true (document-generator.js output: contract, estimate,
    //     invoice, warranty, etc.) is ALWAYS shown — these are customer-facing
    //     document types by construction, same set functions/render-pdf.js's
    //     TEMPLATES map serves.
    //   - anything else (a rep camera/file/DnD upload — could be internal
    //     notes, adjuster correspondence, anything) defaults CLOSED and needs
    //     an explicit sharedWithHomeowner === true, same opt-in shape as the
    //     photo gallery's sharedWithHomeowner filter above.
    //
    // A generated row persists its content as HTML at `htmlPath`, never a
    // direct URL — functions/document-view.js's header explains why a signed
    // Storage URL is wrong for HTML specifically (it would execute
    // same-origin as storage.googleapis.com, unlike a PDF or image). Those
    // rows carry viaHtml:true instead of a url; the client fetches the bytes
    // through getPortalDocumentHtml below, which re-derives this EXACT
    // visibility gate server-side from the token before returning anything —
    // a client can't widen its own access by guessing a docId that wasn't in
    // the list it was handed.
    //
    // An uploaded row already carries a plain `url` (getDownloadURL, written
    // by customer-signed-doc-upload.js / customer-dnd-upload.js) — the SAME
    // field the rep-facing customer.html already links directly, so surfacing
    // it here is not a new privacy exposure, just the same link reaching the
    // person the document is about.
    const _visibleDocRows = docSnap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(_isDocVisibleToHomeowner);
    const _generatedDocs = _visibleDocRows.map(d => {
      const url = typeof d.url === 'string' && /^https:\/\//i.test(d.url) ? d.url : null;
      return {
        id: d.id,
        name: d.name || d.filename || d.typeName || 'Document',
        date: d.uploadedAt?.toDate?.()?.toISOString()
          || d.createdAt?.toDate?.()?.toISOString()
          || (typeof d.date === 'string' ? d.date : null),
        url,
        viaHtml: !url && typeof d.htmlPath === 'string' && !!d.htmlPath,
      };
    }).filter(d => d.url || d.viaHtml); // nothing safe to show → drop it

    // Signed non-contract paperwork (change orders, inspection reports —
    // anything routed through esign.html rather than the main BoldSign
    // contract embed above). These ARE plain PDFs in Storage (signed.pdf,
    // application/pdf) — the HTML-execution concern above doesn't apply, so
    // a short-lived signed URL is the right, standard tool here, same as
    // _refreshHomeownerPhotoUrls above.
    const _esignDocs = (await Promise.all(envSnap.docs.map(async (d) => {
      const e = d.data();
      if (!recordInPortalTenant(e, ['ownerUid'], tenant)) return null;
      if (typeof e.signedPath !== 'string' || !e.signedPath) return null;
      try {
        const [url] = await getStorage().bucket().file(e.signedPath).getSignedUrl({
          action: 'read', expires: Date.now() + HOMEOWNER_URL_TTL_MS,
        });
        return {
          id: d.id,
          name: e.title || 'Signed document',
          date: e.signedAt?.toDate?.()?.toISOString() || null,
          url,
          viaHtml: false,
        };
      } catch (err) {
        logger.warn('esign envelope signed-url mint failed', { envelopeId: d.id, err: err && err.message });
        return null;
      }
    }))).filter(Boolean);

    const _portalDocuments = _generatedDocs.concat(_esignDocs)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    // Balance due / pay (2026-09-16), READ-ONLY. Surfaces data that already
    // exists — never mints a new payment link. stripePaymentLink is written
    // by docs/pro/js/invoice-pipeline.js only after a rep calls
    // createStripePaymentLink (functions/stripe.js), and is cleared back to
    // null by markPaid; there is no path here for a homeowner to charge
    // themselves without a rep having sent a link first. Picks the most
    // recently created invoice that still has a balance — most jobs have
    // exactly one, but this doesn't assume that.
    const _unpaidInvoice = invSnap.docs
      .map(d => d.data())
      .filter(inv => recordInPortalTenant(inv, ['createdBy'], tenant))
      .filter(inv => Number(inv.balanceDue) > 0)
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))[0] || null;
    const _balance = _unpaidInvoice ? {
      amountCents: Math.round(Number(_unpaidInvoice.balanceDue) * 100),
      stripePaymentLink: typeof _unpaidInvoice.stripePaymentLink === 'string' && /^https:\/\//i.test(_unpaidInvoice.stripePaymentLink)
        ? _unpaidInvoice.stripePaymentLink
        : null,
    } : null;

    const view = {
      homeowner: {
        firstName: lead.firstName || '',
        lastName:  lead.lastName || '',
        address:   lead.address || '',
        // Step 16: expose customerId so the portal can build a stable
        // referral link (/refer.html?ref=NBD-0001). customerId is
        // already public — the rep shares it informally — and the
        // referral endpoint validates it server-side anyway.
        customerId: lead.customerId || null
      },
      // Step 16: referral counter, drives the "X friends sent your way"
      // pill in the portal's Refer-a-friend card.
      referralStats: lead.referralStats
        ? { sent: lead.referralStats.sent || 0 }
        : { sent: 0 },
      // Step 17: Digital Warranty Card payload — set when the rep
      // generates a warranty certificate from customer.html. Null
      // means no cert has been issued yet, in which case the portal
      // hides the warranty card entirely.
      warranty: lead.warranty ? {
        tier:        lead.warranty.tier || 'standard',
        tierLabel:   lead.warranty.tierLabel || '',
        tierDesc:    lead.warranty.tierDesc || '',
        work:        lead.warranty.work || '',
        installDate: lead.warranty.installDate || null,
        certNumber:  lead.warranty.certNumber || null,
        // 2026-09-15 (Warranty Claim lane): lets the portal swap the "Start a
        // warranty claim" button for a "Claim in progress" state instead of
        // letting the homeowner file a second report on top of an open one.
        // Deliberately just the id, not claim details — the portal has no
        // authenticated read of the warrantyClaims subcollection.
        openWarrantyClaimId: lead.openWarrantyClaimId || null,
      } : null,
      rep: {
        displayName:    rep.displayName || lead.repName || 'Your Rep',
        calcomUsername: rep.calcomUsername || null,
        calcomEventSlug: rep.calcomEventSlug || 'roof-inspection',
        // Optional per-visit-type slugs ({ adjuster, estimate, gutters, ... }).
        // booking-events.js on the client resolves these; absent, every kind
        // collapses to calcomEventSlug above, so a tenant that never set them
        // behaves exactly as before.
        calcomEventSlugs: (rep.calcomEventSlugs && typeof rep.calcomEventSlugs === 'object')
          ? rep.calcomEventSlugs
          : null,
        phone: rep.phone || null
      },
      company: {
        // register.js writes the company under `company` (not `companyName`),
        // so the old `rep.companyName` read always missed and fell back to NBD —
        // wrong-tenant branding for a non-NBD rep. Read both. Per-tenant
        // companyProfile (tenantName, from brand.legalName) is the canonical
        // source and wins when present; the rep.* reads cover pre-profile data.
        name: tenantName || rep.companyName || rep.company || 'No Big Deal Home Solutions',
        // Tenant-set only (server-guarded https/hex); null/absent for NBD so
        // the client keeps its hardcoded NBD logo + footer byte-identical.
        logoUrl: tenantLogoUrl || null,
        colors: tenantColors
      },
      progress,
      estimate: latest ? {
        id:              latest.id,
        builder:         latest.builder || 'classic',
        grandTotal:      latest.grandTotal || latest.total || null,
        // V2 estimate builder persists only the tier KEY (good/better/best),
        // not tierName, so the portal's tier-label line was dropped for all V2
        // estimates. Derive the label from the key when tierName is absent.
        // GBB audit, 2026-09-09: this map previously said 'Standard Reroof'/
        // 'Reroof Plus'/'Full Redeck' — a fifth, independent stale vocabulary
        // that fired for every V2 estimate (V2 never writes tierName at all),
        // showing a homeowner a name the rest of the app (contract, warranty
        // cert, estimate PDF) no longer uses. functions/ has no server-side
        // mirror of estimate-config.js's TIER_DISPLAY, so this literal map is
        // kept in sync by hand — it must match TIER_DISPLAY's labels exactly.
        // 2026-09-25: nothing at all when no tier applies. A Job Template
        // estimate's tier priced nothing and was a silent 'better' default,
        // so this line told gutter and repair customers they bought
        // "Preferred". tierApplies() is the shared rule (it also covers
        // template estimates saved before the fix — see its comment).
        tierName:        tierApplies(latest)
          ? (latest.tierName
            || ({ good: 'Standard', better: 'Preferred', best: 'Elite' }[latest.tier])
            || null)
          : null,
        signatureStatus: latest.signatureStatus || 'none',
        signedAt:        latest.signedAt?.toDate?.()?.toISOString() || null,
        signedDocumentUrl: latest.signedDocumentUrl || null,
        signEmbedUrl:    signEmbedUrl,
        lineCount: Array.isArray(latest.lines) ? latest.lines.length : null,
        // What is due at signing, in the rule's own words (deposit-rule.js via
        // the saved stamp, 2026-09-25) — the same sentence the homeowner's
        // quote, contract and invoice print. null when absent or stale.
        depositPlan: safeDepositPlan(latest),
        createdAt: latest.createdAt?.toDate?.()?.toISOString() || null
      } : null,
      bookingUrl: rep.calcomUsername
        ? ('https://cal.com/' + rep.calcomUsername + '/' + (rep.calcomEventSlug || 'roof-inspection'))
        : null,
      // Project photos the rep flipped to sharedWithHomeowner.
      // We only emit the responsive variant URLs (`urls`) so the
      // homeowner page renders 200/600/1600 px WebP via <img
      // srcset> instead of pulling 3-5 MB iPhone originals over
      // their phone connection. Photos without `urls` (legacy,
      // pre-image-pipeline) fall back to the original `url`. The
      // redaction here matches the rest of this view: NO internal
      // notes, damageType, severity, location, tags — homeowner
      // only sees the picture, the phase, and an optional
      // homeowner-facing caption.
      photos: photoSnap.docs.map(d => {
        const p = d.data();
        return {
          id: d.id,
          urls: p.urls || null,
          url:  _freshUrls.get(d.id) || p.url || null,
          phase: p.phase || 'During',
          caption: p.homeownerCaption || '',
          // 2026-09-16 (photo self-announce fix): source, not exposed for
          // display (the gallery shows no origin badge either way), only so
          // the client's live-update diff can tell "a rep just shared this"
          // from "I just uploaded this myself" before firing a toast. Same
          // internal-field-redaction posture as the rest of this view —
          // this is the one internal field that actually needs to travel.
          source: p.source === 'homeowner' ? 'homeowner' : 'rep',
        };
      }),
      // D-2.7: auto-pair before/after photos by location. The portal
      // renders a draggable slider per pair; PDFs render side-by-side.
      // Pairing rule: same `location`, one phase='Before' + one
      // phase='After', most-recent of each wins. Empty when no pairs.
      photoPairs: _pairBeforeAfter(photoSnap.docs.map(d => ({ id: d.id, ...d.data() }))),
      // Contract/estimate/invoice/warranty/etc + any rep-shared upload +
      // signed ancillary (esign) paperwork — see the build above.
      documents: _portalDocuments,
      // null when there's no outstanding invoice — most jobs, most of the
      // time. See the build above for why this never mints a new link.
      balance: _balance,
      tokenInfo: {
        daysRemaining: tok.expiresAt
          ? Math.max(0, Math.ceil((tok.expiresAt.toMillis() - Date.now()) / 86_400_000))
          : null
      },
      // Wave 121: rating gate — surface to the portal whether the
      // homeowner can rate the job and whether they already have.
      // The rating card only shows when:
      //   1. progressKey === 'complete'
      //   2. lead.customerRating is unset (not already rated)
      // We emit both bits so the client can render correctly without
      // a second round-trip. If rep.googleReviewUrl is set on the
      // user doc, we also surface it so 4-5★ raters get nudged to
      // leave a public review on Google.
      rating: {
        canRate: progressKey === 'complete',
        submitted: typeof lead.customerRating === 'number' && lead.customerRating > 0,
        stars: typeof lead.customerRating === 'number' ? lead.customerRating : null,
        // W134 CRITICAL fix: enforce https?:// scheme so a rep with a
        // misconfigured (or malicious) googleReviewUrl can't inject a
        // javascript: URL into the portal's <a href>. esc() in the
        // portal HTML doesn't strip schemes — only escapes characters.
        googleReviewUrl: (typeof rep.googleReviewUrl === 'string'
          && /^https?:\/\//i.test(rep.googleReviewUrl.trim()))
          ? rep.googleReviewUrl.trim().slice(0, 500)
          : null,
      },
    };

    // Bump use counter on a real OPEN only (fire-and-forget; don't fail the
    // response). Polls just refresh lastSeenAt so they don't burn the replay
    // budget (QA finding — see isPoll above).
    tokRef.update(isPoll
      ? { lastSeenAt: FieldValue.serverTimestamp() }
      : { uses: FieldValue.increment(1), lastSeenAt: FieldValue.serverTimestamp() }
    ).catch(() => {});

    // 2026-09-16 (view-tracking fix): this open-tracking write existed
    // already, but ONLY on portal_tokens/{token} — nothing rep-facing reads
    // that doc, so a genuine open never moved any indicator a rep actually
    // watches. Those indicators (customer-engagement-score.js,
    // customer-viewed-chip.js, crm-pipeline.js's kanban badge) all key off
    // estimate.viewedAt instead — a SEPARATE signal from a different flow
    // (getEstimateForView, the standalone /pro/estimate-view.html link) that
    // never fires just because the homeowner opened the main portal. Stamp
    // the LEAD doc too, on a genuine open only, so those three consumers can
    // read it for free off the same lead object they already have loaded —
    // no new query, no new subscription.
    if (!isPoll) {
      db.doc(`leads/${tok.leadId}`).update({ lastPortalOpenAt: FieldValue.serverTimestamp() }).catch(() => {});
    }

    res.status(200).json(view);
  }
);

// ═══════════════════════════════════════════════════════════════
// getPortalDocumentHtml — fetch a generated document's HTML, portal-token
// gated (2026-09-16, documents shelf).
// ═══════════════════════════════════════════════════════════════
//
// Mirrors functions/document-view.js's getDocumentHtml BYTE-FOR-BYTE in how
// it reads the object (download via admin SDK, size-cap, return the string
// for a sandboxed client-side render) — that file's header explains why a
// signed Storage URL is wrong for this content (HTML fetched from
// storage.googleapis.com executes same-origin there). The only thing that
// differs is the authorization check: getDocumentHtml is Firebase-Auth-only
// (a rep on customer.html); a homeowner in the token-gated portal has no
// Firebase session, so this checks the portal token instead — same model
// getHomeownerPortalView/uploadHomeownerPhoto/requestCallback all already
// use for "no-login homeowner, but still authorized."
//
// The visibility check is NOT "does this docId exist under this lead" — it
// re-derives the EXACT same generated===true || sharedWithHomeowner===true
// gate getHomeownerPortalView used to decide whether to list this document
// at all. A docId a homeowner was never shown (an un-shared upload, or one
// from a different lead) is refused even with a valid, unexpired token —
// the token proves WHICH lead, not blanket access to everything under it.
const MAX_PORTAL_DOC_HTML_BYTES = 5 * 1024 * 1024; // matches document-view.js's cap

exports.getPortalDocumentHtml = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 30,
    concurrency: 40,
    timeoutSeconds: 20,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'portal-doc-html:ip', 30, 60_000))) return;

    const { token, docId } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }
    if (typeof docId !== 'string' || !docId) {
      res.status(400).json({ error: 'docId required' });
      return;
    }

    const db = getFirestore();
    try {
      const tokSnap = await db.doc(`portal_tokens/${token}`).get();
      if (!tokSnap.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
      const tok = tokSnap.data();
      if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
        res.status(410).json({ error: 'This link has expired' });
        return;
      }

      const docSnap = await db.doc(`leads/${tok.leadId}/documents/${docId}`).get();
      if (!docSnap.exists) { res.status(404).json({ error: 'Document not found' }); return; }
      const meta = docSnap.data() || {};

      // Re-derive getHomeownerPortalView's exact gate — see
      // _isDocVisibleToHomeowner above.
      if (!_isDocVisibleToHomeowner(meta)) {
        res.status(403).json({ error: 'Not shared' });
        return;
      }
      const htmlPath = typeof meta.htmlPath === 'string' ? meta.htmlPath : null;
      if (!htmlPath) { res.status(404).json({ error: 'This document has no HTML on file' }); return; }

      // Same lead-prefix confinement as getDocumentHtml — htmlPath is
      // client-written, so without this a malformed/tampered row could
      // point anywhere in the bucket.
      if (!/^documents\/[^/]+\/[^/]+\//.test(htmlPath) || htmlPath.split('/')[2] !== tok.leadId) {
        logger.error('[getPortalDocumentHtml] htmlPath outside lead prefix', { leadId: tok.leadId, docId, htmlPath });
        res.status(500).json({ error: 'Document path is not readable' });
        return;
      }

      const file = getStorage().bucket().file(htmlPath);
      const [objectMeta] = await file.getMetadata();
      if (Number(objectMeta.size) > MAX_PORTAL_DOC_HTML_BYTES) {
        res.status(413).json({ error: 'Document is too large to open here' });
        return;
      }
      const [buf] = await file.download();
      res.status(200).json({
        html: buf.toString('utf8'),
        name: meta.name || meta.filename || meta.typeName || 'Document',
      });
    } catch (err) {
      if (err && err.code === 404) { res.status(404).json({ error: 'Document file is no longer stored' }); return; }
      logger.error('[getPortalDocumentHtml] failed', { docId, err: err && err.message });
      res.status(500).json({ error: 'Could not read the document' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// Wave 118: uploadHomeownerPhoto — homeowner uploads photos via portal
// ═══════════════════════════════════════════════════════════════
//
// The portal's biggest close-the-loop opportunity: let the homeowner
// upload photos of damage they spotted (storm, mid-job concerns,
// finished work) without waiting for an inspection.
//
// Auth: portal token only (no Firebase user — this is the
// homeowner-facing path). Validated via the same portal_tokens
// collection as getHomeownerPortalView.
//
// Storage: data URL → Firebase Storage at
//   homeowner-uploads/{ownerUid}/{leadId}/{timestamp}.jpg
//
// Firestore: photo doc in `photos` collection with:
//   leadId, userId (rep — for visibility), source: 'homeowner',
//   uploadedAt, url, caption, sharedWithHomeowner: true
//
// Limits:
//   - 10 photos per lead per day (per-token rate limit)
//   - 8 MB per photo (resized client-side; this is the hard server cap)
//   - jpeg/png/webp data URLs only
//
// Notifies the rep via the existing notifications collection so
// the homeowner upload appears in the W48 bell with the W92 high-
// engagement signal it deserves.
exports.uploadHomeownerPhoto = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 50,
    concurrency: 40,
    timeoutSeconds: 30,
    memory: '512MiB', // base64-decode + storage upload
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    // Rate limit per IP — defends against bots churning uploads.
    if (!(await httpRateLimit(req, res, 'portal-upload:ip', 20, 60_000))) return;

    const { token, dataUrl, caption } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }
    if (typeof dataUrl !== 'string') {
      res.status(400).json({ error: 'dataUrl required' });
      return;
    }
    // W134 hardening: pre-check the literal `;base64,` separator before
    // running the greedy regex. Without this, a multi-megabyte string
    // missing the separator would force the regex engine to backtrack
    // across the whole payload (potential ReDoS vector).
    if (!dataUrl.includes(';base64,')) {
      res.status(400).json({ error: 'Invalid image format. Use JPEG/PNG/WebP.' });
      return;
    }
    // Parse the data URL: expect data:image/jpeg;base64,XXXX
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!m) {
      res.status(400).json({ error: 'Invalid image format. Use JPEG/PNG/WebP.' });
      return;
    }
    const mimeType = m[1];
    const b64 = m[2];
    // 8MB hard cap on the base64 string. Decoded binary will be ~6MB
    // (base64 inflates 3:4) which is the actual storage byte count.
    if (b64.length > 8 * 1024 * 1024) {
      res.status(413).json({ error: 'Photo too large. Max 8MB.' });
      return;
    }
    const safeCaption = (typeof caption === 'string') ? caption.slice(0, 280) : '';

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);

    // W134 CRITICAL fix: TOCTOU race. Previously we read the token,
    // checked `todayUploads >= 10` outside any transaction, then did
    // the slow Storage upload, then incremented. Two concurrent
    // requests with the same token at todayUploads=9 both passed the
    // check, both uploaded, and both incremented — total uploads = 11
    // instead of 10. With 20 concurrent requests, all 20 slipped
    // through. Now we atomically reserve the quota slot inside a
    // Firestore transaction, then do the I/O outside. If I/O fails
    // after the slot is reserved, the user is short one slot for the
    // day — acceptable trade-off for actual quota enforcement.
    const todayKey = new Date().toISOString().slice(0, 10); // UTC YYYY-MM-DD
    const uploadsField = `uploadsByDay.${todayKey}`;
    let reservation;
    try {
      reservation = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) {
          const e = new Error('not-found'); e._http = 404; e._msg = 'Invalid link'; throw e;
        }
        const data = snap.data();
        if (data.expiresAt && data.expiresAt.toMillis && data.expiresAt.toMillis() < Date.now()) {
          const e = new Error('expired'); e._http = 410; e._msg = 'This link has expired.'; throw e;
        }
        const cur = (data.uploadsByDay && data.uploadsByDay[todayKey]) || 0;
        if (cur >= 10) {
          const e = new Error('quota'); e._http = 429; e._msg = 'Daily upload limit reached (10). Try again tomorrow.'; throw e;
        }
        tx.update(tokRef, {
          [uploadsField]: FieldValue.increment(1),
          lastUploadAt: FieldValue.serverTimestamp(),
        });
        return { ownerUid: data.ownerUid, leadId: data.leadId, todayCount: cur };
      });
    } catch (err) {
      if (err && err._http) {
        res.status(err._http).json({ error: err._msg });
        return;
      }
      logger.error('[uploadHomeownerPhoto] reservation failed', { msg: err.message });
      res.status(500).json({ error: 'Could not start upload. Try again.' });
      return;
    }
    const tok = reservation;

    try {
      // Storage upload
      const buffer = Buffer.from(b64, 'base64');
      const ext = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
      const ts = Date.now();
      const path = `homeowner-uploads/${tok.ownerUid}/${tok.leadId}/${ts}.${ext}`;
      const file = getStorage().bucket().file(path);
      await file.save(buffer, { contentType: mimeType, resumable: false });
      // W134 hardening: shorter signed-URL expiry. Previously
      // '03-09-2491' (~466 years) made every uploaded photo
      // effectively permanent — even after the photo doc was deleted
      // from Firestore, the Storage URL stayed accessible. Now 7 days,
      // which is the per-request max. This comment used to claim "the
      // rep's dashboard re-signs on demand via the existing
      // signImageUrl function" — that was aspirational, not true:
      // signImageUrl's path allowlist (functions/handlers/photo.js)
      // never included homeowner-uploads/ until 2026-09-14, so every
      // such re-sign 400'd and the rep gallery lost the photo outright
      // once the 7-day URL expired. Fixed the same date: the allowlist
      // (and a matching storage.rules read block, which also did not
      // exist before then) now cover this prefix, so the re-sign this
      // comment always claimed actually works. We still bake a signed
      // URL into the photo doc so the existing rep gallery query keeps
      // working without further code changes.
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
      const [url] = await file.getSignedUrl({
        action: 'read',
        expires: expiresAt,
      });

      // Photo doc — rep owns it (userId = ownerUid) so the existing
      // photo queries on the rep dashboard surface it. companyId is the
      // owner's tenant key (claims.companyId || uid — the Phase-1.5
      // rule) so company-scoped team reads see homeowner uploads too;
      // best-effort, the uid fallback matches the solo convention.
      let ownerCompanyId = tok.ownerUid;
      try {
        const ownerUser = await require('firebase-admin/auth').getAuth().getUser(tok.ownerUid);
        if (ownerUser.customClaims && ownerUser.customClaims.companyId) {
          ownerCompanyId = ownerUser.customClaims.companyId;
        }
      } catch (_) { /* deleted owner → uid fallback */ }
      const photoRef = await db.collection('photos').add({
        leadId: tok.leadId,
        userId: tok.ownerUid,
        companyId: ownerCompanyId,
        source: 'homeowner',
        url,
        // When that signed URL dies. Without this the only way to know whether
        // a baked URL is still good is to try it — and the failure surfaces as
        // a broken tile in the homeowner's own gallery, not as an error we see.
        urlExpiresAt: expiresAt,
        path,
        mimeType,
        caption: safeCaption,
        phase: 'During', // homeowner uploads typically mid-project
        // Same reason as the customer-page upload path: the rep-facing gallery
        // and Recent feed both orderBy('createdAt'), and Firestore drops docs
        // missing the ordered field. Stamping only uploadedAt made a
        // homeowner's upload invisible in exactly the views the notification
        // below tells the rep to go and look at.
        createdAt: FieldValue.serverTimestamp(),
        uploadedAt: FieldValue.serverTimestamp(),
        sharedWithHomeowner: true, // visible back to them in the gallery
      });

      // W134: counter increment moved INTO the W134 reservation
      // transaction above; no longer a second write here.

      // W159 CRITICAL fix: also stamp lastUploadAt + bump
      // unreadHomeownerUploads on the LEAD doc. Previously the
      // transaction wrote lastUploadAt to the portal_tokens doc
      // (which is correct for the token's own audit trail), but
      // lead-score.js _scoreHot reads lead.lastUploadAt and the
      // recency scorer reads it too. Without this write, the
      // "recent-upload" hot signal (+4 pts) NEVER fired and the
      // recency boost a fresh upload should give was zero. Same
      // pattern as W123's lead.lastHomeownerMessageAt write.
      try {
        await db.doc(`leads/${tok.leadId}`).set({
          lastUploadAt: FieldValue.serverTimestamp(),
          unreadHomeownerUploads: FieldValue.increment(1),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (leadErr) {
        logger.warn('[uploadHomeownerPhoto] lead doc bump failed', { msg: leadErr.message });
      }

      // Notification to the rep — surfaces in the W48 bell as a
      // high-priority "homeowner uploaded a photo" signal.
      try {
        await db.collection('notifications').add({
          userId: tok.ownerUid,
          type: 'homeowner_upload',
          leadId: tok.leadId,
          photoId: photoRef.id,
          title: 'Homeowner uploaded a photo',
          message: safeCaption ? `"${safeCaption.slice(0, 60)}"` : 'New photo from the homeowner — review on the customer page.',
          priority: 'high',
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (notifErr) {
        logger.warn('[uploadHomeownerPhoto] notification create failed', { msg: notifErr.message });
      }

      res.status(200).json({
        ok: true,
        photoId: photoRef.id,
        url,
        remainingToday: 10 - (tok.todayCount + 1),
      });
    } catch (err) {
      logger.error('[uploadHomeownerPhoto] failed', { msg: err.message });
      res.status(500).json({ error: 'Upload failed. Try again.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// Wave 119: requestCallback — homeowner picks a time-window,
// rep sees a task on the lead.
// ═══════════════════════════════════════════════════════════════
//
// Companion to the call-now button. The customer taps a time-slot
// chip ("today", "tomorrow morning", "this weekend", etc.) plus an
// optional note, and we drop a real task on the lead so the rep
// sees it in their bell + customer page activity log without any
// extra rep-side wiring.
//
// Time-slot resolution is server-side and uses Eastern time — same
// timezone fix W104 applied to the scheduled push functions. We
// resolve the slot to a concrete `dueDate` (YYYY-MM-DD) so the
// existing notif-bell `task-today` / `overdue-task` branches pick
// it up identically to a manually-created task.
//
// Limits:
//   - 3 callback requests per token per day (defends against
//     a stuck homeowner spamming "call me now")
//   - 280-char note cap, slot whitelist
//   - Per-IP rate limit shared with portal upload
exports.requestCallback = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 50,
    concurrency: 60,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    if (!(await httpRateLimit(req, res, 'portal-callback:ip', 30, 60_000))) return;

    const { token, slot, note } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }
    const ALLOWED_SLOTS = new Set([
      'today',
      'tomorrow-morning',
      'tomorrow-afternoon',
      'tomorrow-evening',
      'weekend',
      'anytime',
    ]);
    if (typeof slot !== 'string' || !ALLOWED_SLOTS.has(slot)) {
      res.status(400).json({ error: 'Invalid time slot' });
      return;
    }
    const safeNote = (typeof note === 'string') ? note.trim().slice(0, 280) : '';

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);

    // W134 CRITICAL fix: TOCTOU race on per-token daily quota — same
    // pattern as uploadHomeownerPhoto. Atomically reserve the slot
    // inside a transaction; if reservation succeeds, do the writes.
    const todayKey = new Date().toISOString().slice(0, 10);
    const callbacksField = `callbacksByDay.${todayKey}`;
    let tok;
    try {
      tok = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) {
          const e = new Error('not-found'); e._http = 404; e._msg = 'Invalid link'; throw e;
        }
        const data = snap.data();
        if (data.expiresAt && data.expiresAt.toMillis && data.expiresAt.toMillis() < Date.now()) {
          const e = new Error('expired'); e._http = 410; e._msg = 'This link has expired.'; throw e;
        }
        const cur = (data.callbacksByDay && data.callbacksByDay[todayKey]) || 0;
        if (cur >= 3) {
          const e = new Error('quota'); e._http = 429; e._msg = 'You\'ve sent a few requests already today — your rep will be in touch.'; throw e;
        }
        tx.update(tokRef, {
          [callbacksField]: FieldValue.increment(1),
          lastCallbackAt: FieldValue.serverTimestamp(),
        });
        return { ownerUid: data.ownerUid, leadId: data.leadId, todayCount: cur };
      });
    } catch (err) {
      if (err && err._http) {
        res.status(err._http).json({ error: err._msg });
        return;
      }
      logger.error('[requestCallback] reservation failed', { msg: err.message });
      res.status(500).json({ error: 'Could not save request. Try again.' });
      return;
    }

    // Resolve the slot to a concrete due date in Eastern time.
    // We work with the raw YYYY-MM-DD from Intl so it doesn't drift
    // off the date locally vs server-side.
    const easternDate = (offset) => {
      // offset = 0 today, 1 tomorrow, 2 day-after, etc.
      const d = new Date(Date.now() + offset * 86_400_000);
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      return fmt.format(d); // 'YYYY-MM-DD'
    };
    // Saturday lookahead — find the next Saturday in Eastern time.
    const nextSaturday = () => {
      for (let i = 0; i <= 7; i++) {
        const d = new Date(Date.now() + i * 86_400_000);
        const wd = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York', weekday: 'short',
        }).format(d);
        if (wd === 'Sat') return easternDate(i);
      }
      return easternDate(6); // fallback
    };

    let dueDate;
    let label;
    switch (slot) {
      case 'today':
        dueDate = easternDate(0);
        label = 'today';
        break;
      case 'tomorrow-morning':
        dueDate = easternDate(1);
        label = 'tomorrow morning';
        break;
      case 'tomorrow-afternoon':
        dueDate = easternDate(1);
        label = 'tomorrow afternoon';
        break;
      case 'tomorrow-evening':
        dueDate = easternDate(1);
        label = 'tomorrow evening';
        break;
      case 'weekend':
        dueDate = nextSaturday();
        label = 'this weekend';
        break;
      case 'anytime':
      default:
        dueDate = easternDate(2); // 2 days out so it stays in active queue
        label = 'anytime this week';
        break;
    }

    const taskText = '📞 CALLBACK REQUESTED — ' + label
      + (safeNote ? ' — "' + safeNote + '"' : '');

    try {
      // Drop a task on the lead — surfaces in the rep's notif-bell
      // via the existing task-today / overdue-task branches.
      const taskRef = await db.collection(`leads/${tok.leadId}/tasks`).add({
        text: taskText,
        done: false,
        dueDate,
        // Marker fields so downstream surfaces (customer page, rep
        // bell) can recognize this isn't a self-created task.
        source: 'homeowner_callback',
        slot,
        slotLabel: label,
        homeownerNote: safeNote || null,
        createdAt: FieldValue.serverTimestamp(),
      });

      // Activity log entry — surfaces on the customer page timeline.
      try {
        await db.collection(`leads/${tok.leadId}/activity`).add({
          userId: tok.ownerUid,
          type: 'callback_request',
          label: 'Callback requested',
          slot,
          slotLabel: label,
          note: safeNote || null,
          dueDate,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (actErr) {
        logger.warn('[requestCallback] activity create failed', { msg: actErr.message });
      }

      // Bump the lead's updatedAt so stale-lead bell branches don't
      // fire on a lead that just had a fresh customer signal.
      // W159 CRITICAL fix: also write lastCallbackAt to the lead
      // doc. Previously the transaction wrote it only to the
      // portal_tokens doc — but lead-score.js _scoreHot reads
      // lead.lastCallbackAt to award the "callback-requested" hot
      // signal (+5 pts). Without this write the signal was
      // permanently silent. Same wrong-target bug pattern as
      // lastUploadAt above.
      try {
        await db.doc(`leads/${tok.leadId}`).set({
          updatedAt: FieldValue.serverTimestamp(),
          lastCallbackAt: FieldValue.serverTimestamp(),
          unreadHomeownerCallbacks: FieldValue.increment(1),
        }, { merge: true });
      } catch (_) { /* non-critical */ }

      // W134: counter increment moved INTO the W134 reservation
      // transaction above; no longer a second write here.

      // Server-side notification doc (future bell-stream wiring).
      try {
        await db.collection('notifications').add({
          userId: tok.ownerUid,
          type: 'homeowner_callback',
          leadId: tok.leadId,
          taskId: taskRef.id,
          title: 'Homeowner requested a callback',
          message: 'Best time: ' + label + (safeNote ? ' — "' + safeNote.slice(0, 60) + '"' : ''),
          priority: 'high',
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (notifErr) {
        logger.warn('[requestCallback] notification create failed', { msg: notifErr.message });
      }

      res.status(200).json({
        ok: true,
        taskId: taskRef.id,
        dueDate,
        slotLabel: label,
        remainingToday: 3 - (tok.todayCount + 1),
      });
    } catch (err) {
      logger.error('[requestCallback] failed', { msg: err.message });
      res.status(500).json({ error: 'Could not save request. Try again.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// 2026-09-15 (Warranty Claim lane): reportWarrantyClaim — upgrades the
// portal's old dead-end `sms:` deep link (docs/pro/js/portal.js's Digital
// Warranty Card) into a real, tracked report. Modeled on requestCallback
// above: same token-auth + rate-limit shape, same task/activity/notification
// triple so it surfaces in the rep's existing bell + customer-page timeline
// with no new UI surface needed there.
//
// Deliberately narrower than the rep-side flow (crm-pipeline.js's moveCard()
// guard -> warranty-claim.js's promptIntake()): this NEVER touches
// lead.stage or lead.openWarrantyClaimId. Those two are hard-gate inputs
// (missingRequiredFields, moveCard's own guard) that this codebase's
// convention keeps synchronous and rep-confirmed — an unauthenticated,
// unreviewed homeowner report shouldn't silently reopen the board column or
// arm the re-entry gate. The claim doc created here is a triage record
// (reportedBy:'homeowner', status:'open'); if the rep decides it's real
// after reading the task, THEIR OWN "File Warranty Claim" click is what
// formalizes it onto the board (a second doc, by design — the two are not
// meant to merge automatically).
// ═══════════════════════════════════════════════════════════════
exports.reportWarrantyClaim = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 50,
    concurrency: 60,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    if (!(await httpRateLimit(req, res, 'portal-warranty-claim:ip', 10, 60_000))) return;

    const { token, issueDescription } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }
    const safeDesc = (typeof issueDescription === 'string') ? issueDescription.trim().slice(0, 2000) : '';
    if (!safeDesc) {
      res.status(400).json({ error: 'Please describe the issue' });
      return;
    }

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);
    let tok;
    try {
      const snap = await tokRef.get();
      if (!snap.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
      const data = snap.data();
      if (data.expiresAt && data.expiresAt.toMillis && data.expiresAt.toMillis() < Date.now()) {
        res.status(410).json({ error: 'This link has expired.' });
        return;
      }
      tok = { ownerUid: data.ownerUid, leadId: data.leadId };
    } catch (err) {
      logger.error('[reportWarrantyClaim] token lookup failed', { msg: err.message });
      res.status(500).json({ error: 'Could not save your report. Try again.' });
      return;
    }

    const taskText = '🛟 WARRANTY CLAIM REPORTED — "' + safeDesc.slice(0, 200) + '"';

    try {
      // Triage claim doc — see the lane comment above for why this never
      // touches lead.stage/openWarrantyClaimId.
      const claimRef = await db.collection(`leads/${tok.leadId}/warrantyClaims`).add({
        status: 'open',
        reason: null,
        issueDescription: safeDesc,
        reportedBy: 'homeowner',
        reportedAt: FieldValue.serverTimestamp(),
        scheduledDate: null,
        diagnosisNotes: '',
        resolutionNotes: '',
        billable: false,
        resolvedAt: null,
        linkedPhotoIds: [],
        linkedDocumentIds: [],
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      const taskRef = await db.collection(`leads/${tok.leadId}/tasks`).add({
        text: taskText,
        done: false,
        dueDate: new Date().toISOString().slice(0, 10),
        source: 'homeowner_warranty_claim',
        claimId: claimRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });

      try {
        await db.collection(`leads/${tok.leadId}/activity`).add({
          userId: tok.ownerUid,
          type: 'warranty_claim_reported',
          label: 'Homeowner reported a warranty issue',
          note: safeDesc,
          claimId: claimRef.id,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (actErr) {
        logger.warn('[reportWarrantyClaim] activity create failed', { msg: actErr.message });
      }

      try {
        await db.doc(`leads/${tok.leadId}`).set({
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (_) { /* non-critical */ }

      try {
        await db.collection('notifications').add({
          userId: tok.ownerUid,
          type: 'homeowner_warranty_claim',
          leadId: tok.leadId,
          taskId: taskRef.id,
          title: 'Homeowner reported a warranty issue',
          message: safeDesc.slice(0, 60),
          priority: 'high',
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (notifErr) {
        logger.warn('[reportWarrantyClaim] notification create failed', { msg: notifErr.message });
      }

      res.status(200).json({ ok: true });
    } catch (err) {
      logger.error('[reportWarrantyClaim] failed', { msg: err.message });
      res.status(500).json({ error: 'Could not save your report. Try again.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// Wave 121: submitCustomerRating — homeowner rates the completed
// job, optional comment, smart routing on outcome.
// ═══════════════════════════════════════════════════════════════
//
// The post-completion feedback loop. When a lead has hit the
// 'complete' homeowner-progress milestone, we show a 1-5 star
// rating card on the portal. Customer picks stars + optional
// comment, server stamps the lead with `customerRating` +
// `customerRatingComment` + `customerRatingAt`, and routes
// downstream surfaces:
//
//   - Always: activity log entry on leads/{id}/activity
//   - Always: notification doc for the rep (high priority)
//   - 4-5 stars: response includes googleReviewUrl so the portal
//                can nudge the homeowner to leave a public review
//   - 1-3 stars: drop a "RECOVERY CALL NEEDED" task on the lead
//                with priority dueDate=today so the rep sees it
//                in their bell IMMEDIATELY. A negative rating
//                without recovery is the worst of both worlds:
//                disappointed customer + rep unaware.
//
// Idempotency: ratings are write-once. If lead.customerRating is
// already set, we reject with 409. The portal already gates this
// via the `rating.submitted` flag in the view, but the server is
// authoritative.
//
// Limits:
//   - One rating per lead lifetime (write-once)
//   - 500-char comment cap
//   - Star whitelist: 1, 2, 3, 4, 5 only
exports.submitCustomerRating = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 50,
    concurrency: 60,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }

    if (!(await httpRateLimit(req, res, 'portal-rating:ip', 30, 60_000))) return;

    const { token, stars, comment } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }
    const starsNum = Number(stars);
    if (!Number.isInteger(starsNum) || starsNum < 1 || starsNum > 5) {
      res.status(400).json({ error: 'Stars must be 1-5' });
      return;
    }
    const safeComment = (typeof comment === 'string') ? comment.trim().slice(0, 500) : '';

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);
    const tokSnap = await tokRef.get();
    if (!tokSnap.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
    const tok = tokSnap.data();
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'This link has expired.' });
      return;
    }

    const leadRef = db.doc(`leads/${tok.leadId}`);

    // W134 fix: write-once atomicity. The previous read-then-update
    // was racy — two concurrent submissions could both pass the
    // `customerRating > 0` check and both write. Now we atomically
    // verify the lead exists, that customerRating is unset, and then
    // stamp it inside a single transaction.
    try {
      await db.runTransaction(async (tx) => {
        const leadSnap = await tx.get(leadRef);
        if (!leadSnap.exists) {
          const e = new Error('not-found'); e._http = 404; e._msg = 'Lead not found'; throw e;
        }
        const lead = leadSnap.data();
        if (typeof lead.customerRating === 'number' && lead.customerRating > 0) {
          const e = new Error('already-rated'); e._http = 409; e._msg = 'You\'ve already rated this job. Thank you!'; throw e;
        }
        // Server-side 'complete' gate — the canRate hint in getHomeownerPortalView
        // is client-only; without this a crafted POST could rate a job that
        // isn't done (QA finding). These are exactly the stages that map to the
        // 'complete' progress milestone in the portal view.
        // Same resolver the portal view uses for canRate, so the card the
        // homeowner sees and the gate that accepts their rating agree by
        // construction rather than by two lists staying in sync.
        if (progressKeyFor(lead) !== 'complete') {
          const e = new Error('not-complete'); e._http = 409; e._msg = 'You can rate once the job is complete.'; throw e;
        }
        tx.update(leadRef, {
          customerRating: starsNum,
          customerRatingComment: safeComment || null,
          customerRatingAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (err) {
      if (err && err._http) {
        res.status(err._http).json({ error: err._msg });
        return;
      }
      logger.error('[submitCustomerRating] write-once transaction failed', { msg: err.message });
      res.status(500).json({ error: 'Could not save rating. Try again.' });
      return;
    }

    try {

      // Activity log for the customer page timeline.
      try {
        await db.collection(`leads/${tok.leadId}/activity`).add({
          userId: tok.ownerUid,
          type: 'customer_rating',
          label: starsNum + '-star rating from homeowner',
          stars: starsNum,
          comment: safeComment || null,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (actErr) {
        logger.warn('[submitCustomerRating] activity create failed', { msg: actErr.message });
      }

      // Low-rating recovery: drop a high-priority task on the lead
      // so the rep gets it in their bell as task-today / overdue.
      if (starsNum <= 3) {
        try {
          const today = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York',
            year: 'numeric', month: '2-digit', day: '2-digit',
          }).format(new Date());
          await db.collection(`leads/${tok.leadId}/tasks`).add({
            text: '⚠️ RECOVERY CALL — homeowner gave ' + starsNum + '★'
              + (safeComment ? ' — "' + safeComment.slice(0, 100) + '"' : ''),
            done: false,
            dueDate: today, // today in Eastern → bell shows it RIGHT NOW
            source: 'rating_recovery',
            stars: starsNum,
            createdAt: FieldValue.serverTimestamp(),
          });
        } catch (taskErr) {
          logger.warn('[submitCustomerRating] recovery task failed', { msg: taskErr.message });
        }
      }

      // Notification doc for the rep (server-side bell stream).
      try {
        const notifTitle = starsNum >= 4
          ? `⭐ ${starsNum}-star rating from homeowner`
          : `⚠️ ${starsNum}-star rating — recovery needed`;
        await db.collection('notifications').add({
          userId: tok.ownerUid,
          type: 'customer_rating',
          leadId: tok.leadId,
          title: notifTitle,
          message: safeComment ? '"' + safeComment.slice(0, 80) + '"' : 'No comment provided.',
          priority: starsNum <= 3 ? 'high' : 'medium',
          stars: starsNum,
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (notifErr) {
        logger.warn('[submitCustomerRating] notification create failed', { msg: notifErr.message });
      }

      // For 4-5 star raters, return the Google review URL so the
      // portal can nudge them to leave a public review. Resolve
      // from the rep's user doc — same field surfaced in the view.
      // W134 CRITICAL fix: enforce https:// scheme. Previously a rep
      // who set googleReviewUrl to `javascript:alert(...)` would have
      // that value flow into the portal's <a href> via esc() (which
      // only HTML-escapes — does NOT strip dangerous schemes). XSS
      // pivot. The whitelist below ensures only http(s) URLs survive.
      let googleReviewUrl = null;
      if (starsNum >= 4) {
        try {
          const repSnap = await db.doc(`users/${tok.ownerUid}`).get();
          if (repSnap.exists) {
            const raw = repSnap.data().googleReviewUrl;
            if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) {
              googleReviewUrl = raw.trim().slice(0, 500); // also bound length
            }
          }
        } catch (_) { /* non-critical */ }
      }

      res.status(200).json({
        ok: true,
        stars: starsNum,
        googleReviewUrl,
        // Hint for the portal copy — high vs low determines which
        // post-submit message the user sees.
        tier: starsNum >= 4 ? 'high' : 'low',
      });
    } catch (err) {
      logger.error('[submitCustomerRating] failed', { msg: err.message });
      res.status(500).json({ error: 'Could not save rating. Try again.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// Wave 123: sendPortalMessage + getPortalMessages
// Async messaging from the homeowner side of the portal.
// ═══════════════════════════════════════════════════════════════
//
// The "talk to your rep without phone tag" lane. Homeowner can
// send a question, file an "I'll be home Saturday morning if you
// want to swing by" note, or follow up on a quote — without
// having to call. Server stores under leads/{id}/portal_messages
// (admin SDK only writes), and the rep sees it as a notification
// + activity entry.
//
// W123 ships the homeowner-send direction. The rep-reply
// direction (replyToPortalMessage callable + portal thread fetch)
// follows in W124.
//
// Limits:
//   - 30 messages per token per day (anti-spam)
//   - 2000-char per message
//   - Per-IP rate limit shared with portal endpoints
exports.sendPortalMessage = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 50,
    concurrency: 60,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'portal-msg:ip', 60, 60_000))) return;

    const { token, text } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }
    if (typeof text !== 'string' || !text.trim()) {
      res.status(400).json({ error: 'Message text is required' });
      return;
    }
    const safeText = text.trim().slice(0, 2000);

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);

    // W134 CRITICAL fix: TOCTOU race on per-token daily quota — same
    // pattern as uploadHomeownerPhoto + requestCallback. Atomically
    // reserve the slot inside a transaction.
    const todayKey = new Date().toISOString().slice(0, 10);
    const msgsField = `messagesByDay.${todayKey}`;
    let tok;
    try {
      tok = await db.runTransaction(async (tx) => {
        const snap = await tx.get(tokRef);
        if (!snap.exists) {
          const e = new Error('not-found'); e._http = 404; e._msg = 'Invalid link'; throw e;
        }
        const data = snap.data();
        if (data.expiresAt && data.expiresAt.toMillis && data.expiresAt.toMillis() < Date.now()) {
          const e = new Error('expired'); e._http = 410; e._msg = 'This link has expired.'; throw e;
        }
        const cur = (data.messagesByDay && data.messagesByDay[todayKey]) || 0;
        if (cur >= 30) {
          const e = new Error('quota'); e._http = 429; e._msg = 'Daily message limit reached (30). Try again tomorrow or call your rep directly.'; throw e;
        }
        tx.update(tokRef, {
          [msgsField]: FieldValue.increment(1),
          lastMessageAt: FieldValue.serverTimestamp(),
        });
        return { ownerUid: data.ownerUid, leadId: data.leadId, todayCount: cur };
      });
    } catch (err) {
      if (err && err._http) {
        res.status(err._http).json({ error: err._msg });
        return;
      }
      logger.error('[sendPortalMessage] reservation failed', { msg: err.message });
      res.status(500).json({ error: 'Could not send message. Try again.' });
      return;
    }

    try {
      // Tenant key for the thread (Comm Log stamping contract). Tokens minted
      // since this shipped carry companyId, so the common path costs no extra
      // read; older tokens fall back to one best-effort lead read, and only
      // then to ownerUid — which is the REP's uid and WRONG for a team tenant,
      // so that last resort is logged rather than stamped silently.
      let msgCompanyId = tok.companyId || null;
      if (!msgCompanyId) {
        try {
          const leadForTenant = await db.doc(`leads/${tok.leadId}`).get();
          const ld = leadForTenant.exists ? (leadForTenant.data() || {}) : {};
          msgCompanyId = ld.companyId || null;
        } catch (e) {
          logger.warn('[sendPortalMessage] lead tenant read failed', { leadId: tok.leadId, msg: e && e.message });
        }
        if (!msgCompanyId) {
          msgCompanyId = tok.ownerUid || null;
          logger.warn('[sendPortalMessage] stamping ownerUid as the tenant key (legacy token, no lead companyId)', { leadId: tok.leadId });
        }
      }

      const msgRef = await db.collection(`leads/${tok.leadId}/portal_messages`).add({
        leadId: tok.leadId,
        ownerUid: tok.ownerUid,
        companyId: msgCompanyId,
        source: 'homeowner',
        text: safeText,
        createdAt: FieldValue.serverTimestamp(),
        readBySender: true,
        readByRecipient: false,
      });

      // Activity log entry — surfaces on the customer page timeline.
      try {
        await db.collection(`leads/${tok.leadId}/activity`).add({
          userId: tok.ownerUid,
          companyId: msgCompanyId,
          type: 'portal_message_in',
          label: 'Message from homeowner',
          messageId: msgRef.id,
          textPreview: safeText.slice(0, 120),
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (actErr) {
        logger.warn('[sendPortalMessage] activity create failed', { msg: actErr.message });
      }

      // Bump lead.updatedAt + lastHomeownerMessageAt so the
      // customer page bell badge can highlight unread messages
      // and stale-lead bell signals don't fire on a fresh signal.
      try {
        await db.doc(`leads/${tok.leadId}`).set({
          updatedAt: FieldValue.serverTimestamp(),
          lastHomeownerMessageAt: FieldValue.serverTimestamp(),
          unreadHomeownerMessages: FieldValue.increment(1),
        }, { merge: true });
      } catch (_) { /* non-critical */ }

      // W134: counter increment moved INTO the W134 reservation
      // transaction above; no longer a second write here.

      // Server-side notification doc.
      try {
        await db.collection('notifications').add({
          userId: tok.ownerUid,
          type: 'portal_message',
          leadId: tok.leadId,
          messageId: msgRef.id,
          title: 'New message from homeowner',
          message: safeText.slice(0, 100),
          priority: 'high',
          read: false,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (_) { /* non-critical */ }

      res.status(200).json({
        ok: true,
        messageId: msgRef.id,
        remainingToday: 30 - (tok.todayCount + 1),
      });
    } catch (err) {
      logger.error('[sendPortalMessage] failed', { msg: err.message });
      res.status(500).json({ error: 'Could not send message. Try again.' });
    }
  }
);

// ── replyToPortalMessage — rep-side reply (uid-authed callable) ──
// Wave 125: completes the two-way thread. The rep replies from the
// customer page; we write the doc with source: 'rep', mark all
// unread homeowner messages as readByRecipient (so the unread
// counter on the lead clears), and bump lastRepMessageAt.
exports.replyToPortalMessage = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    await callableRateLimit(request, 'replyToPortalMessage', 60, 60_000);

    const leadId = typeof request.data?.leadId === 'string' ? request.data.leadId : null;
    const text = typeof request.data?.text === 'string' ? request.data.text.trim() : '';
    if (!leadId) throw new HttpsError('invalid-argument', 'leadId required');
    if (!text) throw new HttpsError('invalid-argument', 'text required');
    const safeText = text.slice(0, 2000);

    const db = getFirestore();
    const leadRef = db.doc(`leads/${leadId}`);
    const leadSnap = await leadRef.get();
    if (!leadSnap.exists) throw new HttpsError('not-found', 'Lead not found');
    const lead = leadSnap.data();
    const isAdmin = request.auth.token.role === 'admin';
    if (lead.userId !== uid && !isAdmin) {
      throw new HttpsError('permission-denied', 'Not your lead');
    }

    const msgRef = await db.collection(`leads/${leadId}/portal_messages`).add({
      leadId,
      ownerUid: lead.userId,
      companyId: lead.companyId || lead.userId || null,
      source: 'rep',
      text: safeText,
      createdAt: FieldValue.serverTimestamp(),
      readBySender: true,
      readByRecipient: false,
    });

    // Mark-read + lead bump + timeline entry. Shared with the AI-approved
    // portal reply (onAiDraftApproved's portal branch) so the two rep-reply
    // paths cannot drift — the AI path used to do none of this.
    await applyRepReplyEffects({
      db, FieldValue, leadId,
      ownerUid: lead.userId,
      companyId: lead.companyId || lead.userId || null,
      messageId: msgRef.id,
      textPreview: safeText,
      logger,
    });

    return { success: true, messageId: msgRef.id };
  }
);

// ── getPortalMessages — homeowner fetches the thread ──────────
// Token-authed, returns the latest 50 messages for the lead with
// rep messages + their own. Sets readByRecipient=true on rep
// messages the homeowner is now seeing (since they're seeing them).
exports.getPortalMessages = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 50,
    concurrency: 80,
    timeoutSeconds: 10,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'portal-msg-get:ip', 120, 60_000))) return;

    const { token } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);
    const tokSnap = await tokRef.get();
    if (!tokSnap.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
    const tok = tokSnap.data();
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'This link has expired.' });
      return;
    }
    // Phase-2.3: enforce the replay cap on reads too. getHomeownerPortalView
    // checks maxUses but the read endpoints didn't — a leaked-but-unexpired
    // token could otherwise re-read the thread until expiry. (The write
    // endpoints are already bounded by per-day quotas / write-once.)
    if (typeof tok.maxUses === 'number' && (tok.uses || 0) >= tok.maxUses) {
      res.status(429).json({ error: 'This link has been opened too many times.' });
      return;
    }

    try {
      const snap = await db.collection(`leads/${tok.leadId}/portal_messages`)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .get();

      const messages = [];
      const repMessageRefs = [];
      snap.forEach(d => {
        const data = d.data();
        messages.push({
          id: d.id,
          source: data.source,
          text: data.text,
          createdAt: data.createdAt?.toMillis?.() || null,
          readByRecipient: !!data.readByRecipient,
        });
        // If a rep message is unread by the homeowner, queue it
        // for the read-stamp batch update below.
        if (data.source === 'rep' && data.readByRecipient !== true) {
          repMessageRefs.push(d.ref);
        }
      });

      // Mark unread rep messages as read by the homeowner. Best-effort.
      if (repMessageRefs.length > 0) {
        try {
          const batch = db.batch();
          repMessageRefs.forEach(ref => batch.update(ref, { readByRecipient: true }));
          await batch.commit();
        } catch (_) { /* non-critical */ }
      }

      // Reverse so client gets oldest-first (natural conversation order).
      messages.reverse();

      res.status(200).json({ messages });
    } catch (err) {
      logger.error('[getPortalMessages] failed', { msg: err.message });
      res.status(500).json({ error: 'Could not load messages.' });
    }
  }
);

// ═══════════════════════════════════════════════════════════════
// Wave 146: getEstimateForView — token-authed homeowner preview
// ═══════════════════════════════════════════════════════════════
//
// The lightweight preview path for estimates. Distinct from the
// BoldSign signature flow (which is heavyweight + requires
// envelope creation). Lets the rep send a "preview link" the
// customer can click to see the estimate inside a branded HTML
// shell without committing to sign.
//
// Side effect: stamps `viewedAt` (and bumps a `viewCount` +
// `lastViewedAt`) on the estimate doc. This is the missing write
// path that Wave 91's engagement-tier signal + the W57+W58
// almost-there-widget have been waiting for. Without it, the
// "estimate viewed" tier never fires for a V2 estimate that's
// shared via this link rather than a BoldSign envelope.
//
// Auth: portal_tokens entry validates the lead context. The
// estimate must belong to the same lead as the token.
exports.getEstimateForView = onRequest(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    maxInstances: 50,
    concurrency: 80,
    timeoutSeconds: 15,
    memory: '256MiB',
  },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!(await httpRateLimit(req, res, 'estimate-view:ip', 60, 60_000))) return;

    const { token, estimateId } = req.body || {};
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{10,64}$/.test(token)) {
      res.status(400).json({ error: 'Invalid token' });
      return;
    }
    if (typeof estimateId !== 'string' || !estimateId || estimateId.length > 64) {
      res.status(400).json({ error: 'Invalid estimate ID' });
      return;
    }

    const db = getFirestore();
    const tokRef = db.doc(`portal_tokens/${token}`);
    const tokSnap = await tokRef.get();
    if (!tokSnap.exists) { res.status(404).json({ error: 'Invalid link' }); return; }
    const tok = tokSnap.data();
    if (tok.expiresAt && tok.expiresAt.toMillis && tok.expiresAt.toMillis() < Date.now()) {
      res.status(410).json({ error: 'This link has expired.' });
      return;
    }
    // Phase-2.3: enforce the replay cap on reads too (match
    // getHomeownerPortalView) — bounds a leaked-but-unexpired token.
    if (typeof tok.maxUses === 'number' && (tok.uses || 0) >= tok.maxUses) {
      res.status(429).json({ error: 'This link has been opened too many times.' });
      return;
    }

    const estRef = db.doc(`estimates/${estimateId}`);
    const [estSnap, tokLeadSnap] = await Promise.all([estRef.get(), db.doc(`leads/${tok.leadId}`).get()]);
    if (!estSnap.exists) { res.status(404).json({ error: 'Estimate not found.' }); return; }
    const est = estSnap.data();
    // 2026-09-25 (review of PR #1777): same tenant scope as
    // getHomeownerPortalView. The leadId check below ties the estimate to the
    // lead id; a lead id can be re-created by another tenant, and an estimate
    // can be written with any lead's id, so it must also be this tenant's.
    const tokLead = tokLeadSnap.exists ? (tokLeadSnap.data() || {}) : null;
    if (!tokLead || !tokenMatchesLead(tok, tokLead)
        || !recordInPortalTenant(est, ['userId'], portalTenant(tok, tokLead))) {
      res.status(403).json({ error: 'Estimate not available for this link.' });
      return;
    }

    // Cross-tenant defense: the estimate must belong to the same
    // lead the token grants access to. A homeowner with a valid
    // token for lead A cannot fish for estimates on lead B by
    // guessing IDs.
    if (est.leadId !== tok.leadId) {
      logger.warn('[getEstimateForView] cross-lead access blocked', {
        token: token.slice(0, 8) + '...',
        tokLeadId: tok.leadId,
        estLeadId: est.leadId,
      });
      res.status(403).json({ error: 'Estimate not available for this link.' });
      return;
    }

    // Stamp viewedAt + bump counters. viewedAt only sets on the
    // FIRST view so the W92 engagement tier doesn't churn, but
    // viewCount + lastViewedAt update on every view to power the
    // W57 almost-there-widget's "viewed 3x today" multi-view signal.
    try {
      const update = {
        lastViewedAt: FieldValue.serverTimestamp(),
        viewCount: FieldValue.increment(1),
        lastViewedVia: 'token-link',
      };
      if (!est.viewedAt) {
        update.viewedAt = FieldValue.serverTimestamp();
      }
      await estRef.update(update);
    } catch (e) {
      logger.warn('[getEstimateForView] viewedAt update failed', { msg: e.message });
    }

    // Activity log entry on the lead so the rep's customer-page
    // timeline shows "Homeowner viewed estimate" — surfaces in the
    // bell + briefing + Lead Intelligence score (W135 hot signals).
    try {
      await db.collection(`leads/${tok.leadId}/activity`).add({
        userId: tok.ownerUid,
        type: 'estimate_viewed',
        label: 'Homeowner viewed estimate',
        estimateId,
        viewedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.warn('[getEstimateForView] activity log failed', { msg: e.message });
    }

    // Return a redacted view of the estimate. We strip internal
    // fields (margin, costBasis, internalNotes) that the homeowner
    // shouldn't see; the client renders only the consumer-facing surface.
    //
    // Audit 2026-08-02 (medium): the old whitelist emitted `est.lines` and
    // `est.tiers` — fields NO writer persists (classic + V2 both save `rows`,
    // per-SQ saves `prices`), so every homeowner saw an empty scope. And the
    // naive fix (emit rows) would leak the contractor's cost basis: pre-sweep
    // V2 rows carry material/labor COST in rate/total. buildDisplayRows is
    // the exact retail ladder the customer-portal PDF already uses
    // (retailTotal → cost×(1+markup) → face; per-SQ → no rows; O&P footer),
    // mapped here onto the shape estimate-view.js renders
    // ({name, quantity, unit, lineTotal}).
    const displayRows = buildDisplayRows(est);
    // buildDisplayRows reads est.rows and nothing else. A doc whose scope
    // lives only in est.lineItems therefore yields [], and estimate-view.js
    // falls through to "Detailed line items will be reviewed in person." —
    // an empty scope on the page the homeowner opens to find out what they
    // are paying for. The CRM's own PDF export already has this fallback
    // (customer-bootstrap.module.js, printRows), so a rep could export a
    // full scope and share a link showing none, for the same document.
    //
    // Reachable without any legacy data: Log Estimate writes no rows, and
    // saving the scope back from doc pre-flight writes lineItems onto that
    // doc. buildDocLineItems is the shared three-shape reader that lives
    // beside buildDisplayRows precisely so this stays one copy of the retail
    // ladder — its own docstring notes that a fourth private copy is what
    // leaked the cost basis to homeowners in the first place.
    //
    // Gated on lineItems specifically, NOT used unconditionally: for a per-SQ
    // doc buildDocLineItems synthesises a single summary line, and per-SQ is
    // already served by the safeTiers cards below. Widening this would change
    // a shape that is not broken.
    let docLines = null;
    if (!displayRows.length && Array.isArray(est.lineItems) && est.lineItems.length) {
      docLines = buildDocLineItems(est);
    }
    // Per-SQ docs persist retail tier totals in `prices` — synthesize the
    // tier cards the client expects ({good|better|best: {grandTotal}}). If a
    // doc ever carries a real `tiers` payload, sanitize to grandTotal-only
    // per key rather than passing raw (tiers objects can embed cost splits).
    let safeTiers = null;
    const rawTiers = (est.prices && typeof est.prices === 'object') ? est.prices
      : (est.tiers && typeof est.tiers === 'object') ? est.tiers : null;
    if (rawTiers) {
      safeTiers = {};
      for (const k of ['good', 'better', 'best']) {
        const t = rawTiers[k];
        const v = (t && typeof t === 'object') ? (t.grandTotal ?? t.total) : t;
        if (v != null && Number.isFinite(Number(v))) safeTiers[k] = { grandTotal: Number(v) };
      }
      if (!Object.keys(safeTiers).length) safeTiers = null;
    }
    const safeEstimate = {
      id: estSnap.id,
      // null when no tier applies (a Job Template estimate — see tierApplies).
      tier:        tierApplies(est) ? (est.tier || null) : null,
      mode:        est.mode || null,
      grandTotal:  est.grandTotal || est.total || null,
      total:       est.total || est.grandTotal || null,
      // Same whitelist for both readers — name / quantity / unit / lineTotal
      // only, so no material or labor cost key can ride along from either.
      lines:       docLines
        ? docLines.map(r => ({
          name:      r.description || r.name || r.code || 'Line item',
          quantity:  r.quantity != null ? r.quantity : null,
          unit:      r.unit || '',
          lineTotal: r.total,
        }))
        : displayRows.map(r => ({
        name:      r.desc || r.code || 'Line item',
        // buildDisplayRows' qty is a display string that may embed the unit
        // ('20.00 SQ') — pass it whole, leave unit empty.
        quantity:  r.qty || null,
        unit:      '',
        lineTotal: r.total,
      })),
      tierName:    est.tierName || null,
      addr:        est.addr || est.address || null,
      owner:       est.owner || null,
      createdAt:   est.createdAt?.toDate?.()?.toISOString() || null,
      number:      est.number || null,
      meas:        est.meas || est.measurements || null,
      tiers:       safeTiers,
      // Payment terms (2026-09-25): the deposit-rule stamp, validated — see
      // functions/deposit-plan-view.js. Per-SQ docs stamp the selected tier's
      // total, so this is that tier's deposit.
      depositPlan: safeDepositPlan(est),
      // Photo embeds (2026-07): the rep-selected photos ride the shared
      // view. URL-only pass-through — {url} per entry, ids and any other
      // photo-doc fields stay server-side.
      photos:      Array.isArray(est.photos)
        ? est.photos.filter(p => p && typeof p.url === 'string').map(p => ({ url: p.url }))
        : [],
    };

    // Full white-label (2026-07-19): the renderer hardcoded "NBD · No Big
    // Deal" for every tenant. Resolve the tenant brand (companyProfile keyed
    // by the lead's companyId — team reps' estimates belong to the company,
    // not the rep uid) with the same guards as portalView: tenant-set values
    // only, https logo, hex colors; NBD → {name} so the client renders its
    // NBD literals byte-identical.
    let company = { name: 'No Big Deal Home Solutions', logoUrl: null, colors: null };
    try {
      const leadSnap = await db.doc(`leads/${tok.leadId}`).get();
      const tenantKey = (leadSnap.exists && (leadSnap.data() || {}).companyId) || tok.ownerUid;
      if (tenantKey) {
        const cpSnap = await db.doc(`companyProfile/${tenantKey}`).get();
        if (cpSnap.exists) {
          const _b = (cpSnap.data() || {}).brand || {};
          const _ln = _b.legalName || '';
          if (_ln && _ln !== 'No Big Deal Home Solutions') {
            company.name = _ln;
            if (typeof _b.logoUrl === 'string' && /^https:\/\//i.test(_b.logoUrl)) company.logoUrl = _b.logoUrl;
            const _c = _b.colors || {};
            const HEX = /^#[0-9a-f]{3,8}$/i;
            const accent = HEX.test(_c.accent || '') ? _c.accent : null;
            const primary = HEX.test(_c.primary || '') ? _c.primary : null;
            if (accent || primary) company.colors = { accent, primary };
          }
        }
      }
    } catch (e) {
      logger.warn('[getEstimateForView] tenant resolve failed', { msg: e.message });
    }

    res.status(200).json({ estimate: safeEstimate, company });
  }
);
