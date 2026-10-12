/**
 * functions/handlers/admin.js — admin-facing callables.
 *
 * Step 4c extraction. Moved verbatim from functions/index.js:
 *   - getAdminAnalytics             (C3: ops dashboard numbers)
 *   - auditCustomerDataIntegrity    (Rock 3 PR 2: read-only integrity report)
 *   - backfillCustomerData          (Rock 3 PR 2: idempotent migration)
 *   - rotateAccessCodes             (C-2: legacy access-code kill switch)
 *   - createTeamMember              (team lifecycle: add member)
 *   - updateUserRole                (team lifecycle: change role)
 *   - deactivateUser                (team lifecycle: disable/reactivate)
 *   - listTeamMembers               (team lifecycle: roster fetch)
 *
 * No behavioral changes; pure structural move.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { Timestamp, getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue } = require('firebase-admin/firestore');

const { callableRateLimit } = require('../shared');
const { formatCustomerId, resolveCustMint } = require('../customer-id');
const {
  CORS_ORIGINS,
  LEGACY_ACCESS_CODES,
  requireTeamAdmin,
  callerMayManageTarget,
  protectedTargetRefusal,
  normalizeRole,
  normalizeEmail,
  isOwnerCaller,
} = require('./_shared');
// Seat-cap helpers — imported from the invite handler so createTeamMember
// enforces the SAME plan→seat limit as createTeamInvite (single source of
// truth; invites.js does not require admin.js, so this edge is one-way/safe).
const { seatLimitForPlan, isInviteExpired } = require('./invites');
// R3-1 (2026-10-06): what a removed / deactivated / demoted member loses.
const { reassignMemberRecords, revokeMemberAccessTokens, roleChangeRevokesAccess } = require('../member-offboarding');
// 2026-10-06 (Jo): a removed member's stored files move to the owner too.
const { prepareMemberStorageMove, markRecordsReassigned, runMemberStorageMove, LOCK_CLAIM } = require('../member-storage-move');

// ═══════════════════════════════════════════════════════════════
// getAdminAnalytics — C3: ops dashboard numbers for the Team Manager.
//
// Returns:
//   signatures:   { sent30d, signed30d, avgHoursToSign }
//   measurements: { requested30d, ready30d, passThruRevenueEst }
//   portal:       { linksMinted30d, portalViews30d }
//   claude:       { tokens30d, costEstimate }
//   leads:        { created30d, signed30d, winRatePct }
//
// Platform admin OR company_admin of the target company. company_admin
// gets scoped to their own companyId; platform admin gets the union
// across the platform when called without a company filter.
// ═══════════════════════════════════════════════════════════════
exports.getAdminAnalytics = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '512MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    const isPlatformAdmin = request.auth.token.role === 'admin';
    const isCompanyAdmin  = request.auth.token.role === 'company_admin';
    // H-04: a previous "solo-owner fallback" branch let every
    // authenticated user without a companyId claim (i.e. every
    // free-tier signup) through this callable. Each call runs three
    // 30-day collection scans — a cheap DoS vector and a
    // reconnaissance gift. Require an actual admin claim.
    if (!isPlatformAdmin && !isCompanyAdmin) {
      throw new HttpsError('permission-denied', 'Admin access required');
    }
    // Per-uid rate limit — admins still shouldn't be calling this in
    // a loop. 30/hour is generous for a dashboard refresh.
    await callableRateLimit(request, 'getAdminAnalytics', 30, 3_600_000);

    const companyId = isPlatformAdmin
      ? (request.data?.companyId || request.auth.token.companyId || null)
      : request.auth.token.companyId;

    const db = getFirestore();
    const since = Timestamp.fromMillis(Date.now() - 30 * 86_400_000);

    // Helper — for a rep-owned collection, restrict to the caller's
    // company when not platform admin. Platform admin with no company
    // filter gets unfiltered.
    async function companyUids() {
      if (!companyId) return null; // platform admin, global
      const membersSnap = await db.collection('companies/' + companyId + '/members').get();
      const uids = membersSnap.docs.map(d => d.data().uid).filter(Boolean);
      // Always include the owner.
      const coSnap = await db.doc('companies/' + companyId).get();
      if (coSnap.exists && coSnap.data().ownerId) uids.push(coSnap.data().ownerId);
      return [...new Set(uids)];
    }

    const repUids = await companyUids();

    // Signatures — walk estimates created in last 30d that have a
    // signatureStatus of sent/viewed/signed/declined/expired.
    let estQuery = db.collection('estimates').where('createdAt', '>=', since);
    const estSnap = await estQuery.get();
    const ests = estSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(e => !repUids || repUids.includes(e.userId));
    const sent = ests.filter(e => e.signatureStatus && e.signatureStatus !== 'none');
    const signed = ests.filter(e => e.signatureStatus === 'signed');
    const hours = signed
      .map(e => {
        const sent_t = e.signatureSentAt?.toMillis?.();
        const signed_t = e.signedAt?.toMillis?.();
        return (sent_t && signed_t) ? (signed_t - sent_t) / 3_600_000 : null;
      })
      .filter(h => h != null && h > 0);
    const avgHoursToSign = hours.length
      ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length * 10) / 10
      : null;

    // Measurements — rollup of count + estimated revenue from the
    // pass-through line. We count only 'ready' jobs in the window.
    let msQuery = db.collection('measurements').where('createdAt', '>=', since);
    const msSnap = await msQuery.get();
    const measurements = msSnap.docs.map(d => d.data())
      .filter(m => !repUids || repUids.includes(m.ownerId));
    // ready30d counts EVERY delivered measurement — it is the "is the
    // integration working" tile. billableMeas is the revenue basis: since
    // 2026-09-06 every measurement is pass-through eligible (AI measures
    // included, at Jo's direction), so the two normally match. The filter
    // stays because passThruEligible is a per-doc field and a future provider
    // or policy could set it false again.
    const readyMeas = measurements.filter(m => m.status === 'ready');
    const billableMeas = readyMeas.filter(m => m.passThruEligible !== false);
    const passThruPrice = Number(process.env.NBD_MEASUREMENT_PASSTHRU_PRICE) || 75;
    const passThruRevenueEst = billableMeas.length * passThruPrice;

    // Portal links
    let linksMinted30d = 0, portalViews30d = 0;
    try {
      const tokSnap = await db.collection('portal_tokens')
        .where('mintedAt', '>=', since).get();
      const tokens = tokSnap.docs.map(d => d.data())
        .filter(t => !repUids || repUids.includes(t.ownerUid));
      linksMinted30d = tokens.length;
      portalViews30d = tokens.reduce((s, t) => s + (t.uses || 0), 0);
    } catch (e) { /* index may not exist yet */ }

    // Claude tokens — we already stamp companyId on api_usage.
    let claudeTokens30d = 0;
    try {
      const q = companyId
        ? db.collection('api_usage').where('companyId', '==', companyId).where('timestamp', '>=', since)
        : db.collection('api_usage').where('timestamp', '>=', since);
      const s = await q.get();
      s.forEach(d => {
        const r = d.data();
        claudeTokens30d += (r.inputTokens || 0) + (r.outputTokens || 0);
      });
    } catch (e) { /* fall through */ }
    // Sonnet pricing: $3/M input, $15/M output. Approx with ratio
    // input:output = 3:1 which is our typical.
    const claudeCostEstimate = (claudeTokens30d / 1_000_000) * 6.0;

    // Leads
    let leadQuery = db.collection('leads').where('createdAt', '>=', since);
    const leadSnap = await leadQuery.get();
    const leads = leadSnap.docs.map(d => d.data())
      .filter(l => !repUids || repUids.includes(l.userId));
    const createdCount = leads.length;
    const signedCount = leads.filter(l => /sign|won|closed/i.test(l.stage || '')).length;

    return {
      range: 'last 30 days',
      companyId: companyId || 'all',
      generatedAt: new Date().toISOString(),
      signatures: {
        sent30d: sent.length,
        signed30d: signed.length,
        avgHoursToSign: avgHoursToSign
      },
      measurements: {
        requested30d: measurements.length,
        ready30d: readyMeas.length,
        billable30d: billableMeas.length,
        passThruRevenueEst: passThruRevenueEst,
        passThruPrice
      },
      portal: {
        linksMinted30d,
        portalViews30d
      },
      claude: {
        tokens30d: claudeTokens30d,
        costEstimateUSD: Math.round(claudeCostEstimate * 100) / 100
      },
      leads: {
        created30d: createdCount,
        won30d: signedCount,
        winRatePct: createdCount > 0 ? Math.round(signedCount / createdCount * 100) : 0
      }
    };
  }
);

// ═════════════════════════════════════════════════════════════
// auditCustomerDataIntegrity (Rock 3 PR 2)
//
// Read-only inventory of the caller's leads. Reports counts of
// leads missing companyId or customerId, plus 5 sample doc IDs of
// each so Joe can spot-check before running backfill. Caller-scoped
// — only sees their own leads (filtered by userId == request.auth.uid),
// so a rep can't audit somebody else's tenant.
//
// Returns:
//   {
//     total: <int>,
//     missingCompanyId: <int>, sampleMissingCompanyId: [docId, ...],
//     missingCustomerId: <int>, sampleMissingCustomerId: [docId, ...]
//   }
//
// Counterpart write fn: backfillCustomerData (next).
// ═════════════════════════════════════════════════════════════
// auditCustomerDataIntegrity was retired 2026-08-11 (dead-surface lane):
// Rock 3 PR 2 one-shot whose job completed; zero callers. Approved by
// Jo. Restore from git (pre-ded736f) for future data-integrity work.

// ═════════════════════════════════════════════════════════════
// backfillCustomerData (Rock 3 PR 2)
//
// Idempotent migration: scans the caller's leads and patches any
// doc missing `companyId` or `customerId`. Companies default to
// the caller's existing companyId claim, falling back to their uid
// (matches the solo-operator convention used in _saveLead and the
// `callerCompanyId = decoded.companyId || decoded.uid` pattern in
// the analytics callables). customerIds are allocated via the
// existing counters/customerIds transaction so we don't reuse
// numbers from the live counter.
//
// Safe to run multiple times — re-runs no-op on docs already fixed.
//
// Returns:
//   {
//     scanned: <int>,
//     fixedCompanyId: <int>,
//     fixedCustomerId: <int>,
//     stillMissing: <int>   // any doc the function couldn't safely patch
//   }
// ═════════════════════════════════════════════════════════════
// backfillCustomerData was retired 2026-08-11 — same rationale and
// restore path as auditCustomerDataIntegrity above.

// ═════════════════════════════════════════════════════════════
// rotateAccessCodes — platform-admin-only kill switch for legacy
// hardcoded access codes (C-2).
//
// Until this runs, NBD-2026 and the other pre-rotation codes are
// still live in Firestore because the old seed script wrote them.
// Calling this deactivates them server-side. After this, the seed
// script is the only way to mint new codes — and it prints them
// to stdout only.
//
// Platform admin only. Intentionally very loud in logs — every
// call creates an audit_log entry.
//
// 2026-07 access-code audit: deactivating a code only blocks FUTURE
// redemptions — validateAccessCode already wrote subscriptions/{uid}
// (plan/status/source:'access_code'/accessCode:<CODE>) at redemption,
// so accounts that redeemed a now-dead code keep their plan forever.
// Passing { revokeGrants: true } OPT-IN cascades the rotation to those
// grants: every subscription with source == 'access_code' whose
// accessCode is one of the legacy codes is downgraded to
// { plan: 'free', status: 'revoked' } with an audit trail
// (revokedAt/revokedBy/revokedFromCode) kept on the doc. Default is
// FALSE — killing a code to stop new signups must never silently nuke
// existing customers.
//
// The cascade needs no claims surgery: validateAccessCode stamps only
// a `role` custom claim — plan lives in the subscriptions doc, which
// billing-gate.js / nbd-auth.js / functions/billing.js re-read per
// session, so the downgrade takes effect on the next gate read
// (nbd-auth additionally treats any status other than
// active/trialing as free).
// ═════════════════════════════════════════════════════════════
exports.rotateAccessCodes = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    memory: '256MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
    if (request.auth.token.role !== 'admin') {
      throw new HttpsError('permission-denied', 'Platform admin required');
    }
    // Opt-in cascade — strict boolean true only, default false.
    const revokeGrants = !!(request.data && request.data.revokeGrants === true);

    const db = getFirestore();
    const deactivated = [];
    for (const codeId of LEGACY_ACCESS_CODES) {
      const ref = db.doc(`access_codes/${codeId}`);
      const snap = await ref.get();
      if (!snap.exists) continue;
      const cur = snap.data();
      if (cur.active === false) continue;
      await ref.update({
        active: false,
        rotatedAt: FieldValue.serverTimestamp(),
        rotatedBy: uid,
        rotatedReason: 'legacy hardcoded code auto-disabled'
      });
      deactivated.push(codeId);
    }

    // Cascade sweeps the WHOLE legacy set, not just codes flipped on
    // this call — after the loop above every legacy code is inactive
    // regardless of whether this run, a prior run, or the seed
    // script's sweep killed it, and the grants it minted are equally
    // stale. (A "this call only" cascade would no-op when an admin
    // rotates first and opts into the cascade on a second call.)
    let revokedGrants = 0;
    const revokedUids = [];
    if (revokeGrants) {
      const IN_CAP = 30; // Firestore 'in' filter cap
      for (let i = 0; i < LEGACY_ACCESS_CODES.length; i += IN_CAP) {
        const chunk = LEGACY_ACCESS_CODES.slice(i, i + IN_CAP);
        const snap = await db.collection('subscriptions')
          .where('source', '==', 'access_code')
          .where('accessCode', 'in', chunk)
          .get();
        for (const subSnap of snap.docs) {
          const sub = subSnap.data() || {};
          // Idempotent: re-running the cascade skips already-revoked grants.
          if (sub.status === 'revoked' && sub.plan === 'free') continue;
          await subSnap.ref.set({
            plan: 'free',
            status: 'revoked',
            revokedAt: FieldValue.serverTimestamp(),
            revokedBy: uid,
            revokedFromCode: sub.accessCode || null,
            updatedAt: FieldValue.serverTimestamp()
          }, { merge: true });
          revokedGrants++;
          revokedUids.push(subSnap.id);
        }
      }
    }

    logger.warn('rotateAccessCodes: legacy codes disabled', {
      by: uid, deactivated, revokeGrants, revokedGrants
    });
    // Write an audit_log entry explicitly — this predates the audit
    // triggers, so we record it here too.
    await db.collection('audit_log').add({
      type: 'rotate_access_codes',
      actorUid: uid,
      deactivated,
      revokeGrants,
      revokedGrants,
      // Cap the uid list so a pathological cascade can't blow the 1MiB
      // doc limit; the count above is always exact.
      revokedUids: revokedUids.slice(0, 200),
      ts: FieldValue.serverTimestamp()
    });
    return { success: true, deactivated, revokeGrants, revokedGrants };
  }
);

// ═════════════════════════════════════════════════════════════
// ADMIN ACCOUNT MANAGER — Team lifecycle Cloud Functions
//
// These callables back the "Team" admin view. Only a global admin
// OR the company owner can invoke them. All writes go through the
// Admin SDK so they bypass Firestore rules — meaning the auth check
// below is the ONLY thing standing between the caller and the data.
// Treat every guard as load-bearing.
//
// Roles: admin | manager | sales_rep | viewer
// ═════════════════════════════════════════════════════════════

// ── createTeamMember ─────────────────────────────────────────
// Creates (or adopts) a Firebase Auth user, stamps role + companyId
// claims, and records the member in companies/{companyId}/members.
// The target's default status is 'active' if we created them fresh,
// 'invited' if they don't have a password set yet.
exports.createTeamMember = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (request) => {
    const { uid: callerUid, companyId, companyRef } = await requireTeamAdmin(request);
    await callableRateLimit(request, 'createTeamMember', 20, 60_000);

    const email = normalizeEmail(request.data && request.data.email);
    if (!email) throw new HttpsError('invalid-argument', 'Valid email required');

    // Global admin can grant admin; company owners cannot.
    const role = normalizeRole(request.data && request.data.role);
    if (!role) throw new HttpsError('invalid-argument', 'Invalid role');

    const displayName = typeof request.data?.displayName === 'string'
      ? request.data.displayName.trim().slice(0, 120)
      : '';

    const db = getFirestore();

    // Make sure the company doc exists so security rules for members work.
    const companySnap = await companyRef.get();
    if (!companySnap.exists) {
      await companyRef.set({
        ownerId: callerUid,
        name: (request.auth.token.name || 'My Company'),
        createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }

    // ── Seat-cap enforcement (mirrors createTeamInvite) ─────────────────
    // createTeamMember is the admin-UI parallel to createTeamInvite and MUST
    // enforce the same plan seat cap — without this a Free/solo owner (whose
    // invite-seat cap is 0) could call this repeatedly to mint unlimited active
    // team seats for $0, bypassing the seat-billing model the three enforcing
    // sites (createTeamInvite, assignSeats, reactivateLapsedSeats) protect.
    const isGlobalAdmin = request.auth.token.role === 'admin';
    let plan = 'free';
    let purchasedSeats = 0;
    if (isGlobalAdmin || isOwnerCaller(request.auth.token)) {
      plan = 'enterprise'; // platform admin / NBD founder — deliberately uncapped
    } else {
      const subSnap = await db.doc(`subscriptions/${companyId}`).get();
      const subData = subSnap.exists ? (subSnap.data() || {}) : {};
      // past_due stays entitled (Stripe is still dunning) — matches createTeamInvite.
      const subActive = subData.status === 'active' || subData.status === 'trialing'
        || subData.status === 'past_due';
      if (subActive && subData.plan) {
        plan = subData.plan;
        purchasedSeats = Math.max(0, Number(subData.purchasedSeats) || 0);
      } else {
        plan = (companySnap.exists && (companySnap.data() || {}).plan) || 'free';
      }
    }
    const seatLimit = seatLimitForPlan(plan) + purchasedSeats; // Infinity + n === Infinity

    // Occupancy + whether THIS email already holds a seat (a re-add is not a new
    // seat). Shared by the cheap pre-check and the authoritative txn re-check.
    const countSeats = (docs) => {
      const occupied = docs.filter((m) => {
        const md = m.data() || {};
        if (md.status === 'invited') return !isInviteExpired(md);
        return md.status === 'active';
      }).length;
      const mine = docs.find((m) => m.id === email);
      const mineStatus = mine ? (mine.data() || {}).status : null;
      const reuses = mineStatus === 'active' || (mineStatus === 'invited' && !isInviteExpired(mine.data()));
      return { occupied, reuses };
    };
    const overCapError = () => new HttpsError('resource-exhausted', seatLimit === 0
      ? 'Team seats need the Team plan ($149/mo) or higher — your current plan is solo. Upgrade at /pro#pricing.'
      : `Your plan includes ${seatLimit} team seat${seatLimit === 1 ? '' : 's'} and they're all taken. Remove a member or upgrade to add more.`);

    // Fast pre-check BEFORE creating an Auth user so an over-cap add fails cheap
    // and never leaves an orphan account. (Authoritative re-check is in the txn.)
    // Only a NEW seat is capped: re-adding someone who already holds a seat
    // (reuses) is never over-cap — mirrors createTeamInvite's !reusesSeat gate so
    // an over-capacity downgrade window can't block a no-delta touch of an
    // existing member.
    if (seatLimit !== Infinity) {
      const preDocs = (await db.collection(`companies/${companyId}/members`).get()).docs;
      const { occupied, reuses } = countSeats(preDocs);
      if (!reuses && occupied + 1 > seatLimit) throw overCapError();
    }

    let userRecord;
    let created = false;
    try {
      userRecord = await getAuth().getUserByEmail(email);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        userRecord = await getAuth().createUser({
          email,
          emailVerified: false,
          displayName: displayName || email.split('@')[0],
          disabled: false
        });
        created = true;
      } else {
        throw e;
      }
    }

    // Block cross-company poaching AND cross-tenant adoption: only adopt a
    // brand-new invitee (created in this call) or a user already scoped to this
    // company. An existing account with a different OR ABSENT companyId is not
    // ours to take (fail closed — see callerMayManageTarget).
    const existingClaims = userRecord.customClaims || {};
    if (!callerMayManageTarget(existingClaims, companyId, request.auth.token.role === 'admin', created)) {
      // Distinguish the two fail-closed reasons so the admin-facing toast is accurate.
      throw new HttpsError('already-exists', existingClaims.companyId
        ? 'This email already belongs to another company; it cannot be added here.'
        : 'This email already has a standalone account; it must sign up via an invite link or be migrated by an admin.');
    }

    const memberRef = db.doc(`companies/${companyId}/members/${email}`);
    // Authoritative, ATOMIC seat-cap enforcement + member write in ONE txn so
    // concurrent adds can't each read a stale count and overshoot the paid cap
    // (the same TOCTOU class fixed in createTeamInvite). The claim stamp lives in
    // the SAME try so ANY failure — cap reject OR a transient Auth error on
    // setCustomUserClaims — rolls back cleanly rather than stranding a claimless,
    // unremovable member row.
    try {
      await db.runTransaction(async (tx) => {
        if (seatLimit !== Infinity) {
          const snap = await tx.get(db.collection(`companies/${companyId}/members`));
          const { occupied, reuses } = countSeats(snap.docs);
          // Only a NEW seat is capped (see pre-check) — re-adding an existing
          // seat-holder is never over-cap.
          if (!reuses && occupied + 1 > seatLimit) throw overCapError();
        }
        tx.set(memberRef, {
          email,
          role,
          displayName: displayName || userRecord.displayName || email.split('@')[0],
          uid: userRecord.uid,
          status: created ? 'invited' : 'active',
          invitedAt: FieldValue.serverTimestamp(),
          invitedBy: callerUid,
          active: true
        }, { merge: true });
      });

      // Merge claims — preserve plan/subscriptionStatus if present. Stamped only
      // once the member's seat is committed.
      await getAuth().setCustomUserClaims(userRecord.uid, {
        ...existingClaims,
        companyId,
        role
      });
    } catch (addErr) {
      // Roll back a BRAND-NEW add so a rejected cap or a transient claim-stamp
      // failure leaves no ghost: delete the member row we may have written and
      // the Auth account we created. Guarded on `created` — an existing member's
      // row and claims predate this call and must never be destroyed here.
      if (created) {
        try { await memberRef.delete(); } catch (_) { /* best-effort */ }
        if (userRecord && userRecord.uid) {
          try { await getAuth().deleteUser(userRecord.uid); } catch (_) { /* best-effort */ }
        }
      }
      throw addErr;
    }

    // Seed user profile doc so the user list query has a name to show.
    await db.doc(`users/${userRecord.uid}`).set({
      email,
      displayName: displayName || userRecord.displayName || email.split('@')[0],
      companyId,
      createdAt: FieldValue.serverTimestamp()
    }, { merge: true });

    // M-5: hash email before logging so Cloud Logging retention can't
    // leak PII. Log the first 16 hex chars — enough for correlation
    // between admins and audit_log entries, not enough for reversal.
    const emailHash = require('crypto').createHash('sha256').update(email).digest('hex').slice(0, 16);
    logger.info('createTeamMember', { companyId, emailHash, role, created });
    return {
      success: true,
      uid: userRecord.uid,
      email,
      role,
      status: created ? 'invited' : 'active',
      created
    };
  }
);

// ── updateUserRole ───────────────────────────────────────────
// Change an existing team member's role. Rewrites custom claims
// and the member doc. Won't let a non-admin promote to admin or
// demote the company owner.
exports.updateUserRole = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (request) => {
    const { uid: callerUid, companyId, companyRef, isOwner: callerIsOwner } = await requireTeamAdmin(request);
    await callableRateLimit(request, 'updateUserRole', 30, 60_000);

    const targetUid = typeof request.data?.uid === 'string' ? request.data.uid : null;
    const targetEmail = normalizeEmail(request.data && request.data.email);
    if (!targetUid && !targetEmail) {
      throw new HttpsError('invalid-argument', 'Target uid or email required');
    }

    const role = normalizeRole(request.data && request.data.role);
    if (!role) throw new HttpsError('invalid-argument', 'Invalid role');

    const isGlobalAdmin = request.auth.token.role === 'admin';

    // Resolve the target user.
    let userRecord;
    try {
      userRecord = targetUid
        ? await getAuth().getUser(targetUid)
        : await getAuth().getUserByEmail(targetEmail);
    } catch (e) {
      throw new HttpsError('not-found', 'User not found');
    }

    const existingClaims = userRecord.customClaims || {};
    // Only re-role a user already scoped to THIS company (or as global admin).
    // A target with a different OR ABSENT companyId is not ours — fail closed so
    // a company_admin cannot re-role/seize a solo owner or access-code member.
    if (!callerMayManageTarget(existingClaims, companyId, isGlobalAdmin)) {
      throw new HttpsError('permission-denied', 'User belongs to another company');
    }

    // Prevent demoting the company owner through this path. The owner
    // must keep at least company_admin privileges; downgrade requires
    // transferring ownership first.
    const companySnap = await companyRef.get();
    const ownerId = companySnap.exists ? companySnap.data().ownerId : null;
    // R3-9: a company_admin may not re-role a platform admin or the owner.
    const protectedMsg = protectedTargetRefusal({ targetUid: userRecord.uid, targetClaims: existingClaims, ownerId, callerIsOwner, isGlobalAdmin });
    if (protectedMsg) throw new HttpsError('permission-denied', protectedMsg);
    if (ownerId && userRecord.uid === ownerId && role !== 'company_admin' && !isGlobalAdmin) {
      throw new HttpsError('failed-precondition', 'Cannot demote the company owner');
    }

    // R3-1: a viewer may not hold a bot key or a calendar feed link (neither
    // can be minted by one), so a demotion to viewer turns theirs off, and so
    // does any downgrade away from company_admin / manager (Jo 2026-10-06;
    // roleChangeRevokesAccess). Before the claim change, so a failure leaves
    // the role as it was for a retry.
    if (roleChangeRevokesAccess(existingClaims.role, role)) {
      await revokeMemberAccessTokens(getFirestore(), userRecord.uid,
        role === 'viewer' ? 'role-viewer' : 'role-downgrade');
    }

    await getAuth().setCustomUserClaims(userRecord.uid, {
      ...existingClaims,
      companyId,
      role
    });

    // Phase-2.4: force re-auth so a role change (esp. a downgrade) takes
    // effect promptly. Without this the target keeps their old claims on
    // the current ID token until it refreshes (~1h). Mirrors
    // deactivateUser's revoke. (The in-flight token's ~1h lifetime is a
    // Firebase trait; revoking blocks refreshing into a fresh token that
    // still carries stale claims, and forces a re-login that picks up the
    // new role.)
    try {
      await getAuth().revokeRefreshTokens(userRecord.uid);
    } catch (e) {
      logger.warn('updateUserRole: token revoke failed', { uid: userRecord.uid, err: e.message });
    }

    const emailKey = (userRecord.email || targetEmail || '').toLowerCase();
    if (emailKey) {
      await getFirestore().doc(`companies/${companyId}/members/${emailKey}`).set({
        role,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: callerUid
      }, { merge: true });
    }

    logger.info('updateUserRole', { companyId, targetUid: userRecord.uid, role });
    return { success: true, uid: userRecord.uid, role };
  }
);

// ── deactivateUser ───────────────────────────────────────────
// Disable the Firebase Auth account and mark the member doc
// deactivated. Data is preserved; toggle `reactivate: true` to
// re-enable. Won't let anyone deactivate the company owner.
exports.deactivateUser = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (request) => {
    const { uid: callerUid, companyId, companyRef, isOwner: callerIsOwner } = await requireTeamAdmin(request);
    await callableRateLimit(request, 'deactivateUser', 20, 60_000);

    const targetUid = typeof request.data?.uid === 'string' ? request.data.uid : null;
    const targetEmail = normalizeEmail(request.data && request.data.email);
    if (!targetUid && !targetEmail) {
      throw new HttpsError('invalid-argument', 'Target uid or email required');
    }
    const reactivate = request.data?.reactivate === true;

    let userRecord;
    try {
      userRecord = targetUid
        ? await getAuth().getUser(targetUid)
        : await getAuth().getUserByEmail(targetEmail);
    } catch (e) {
      throw new HttpsError('not-found', 'User not found');
    }

    const existingClaims = userRecord.customClaims || {};
    const isGlobalAdmin = request.auth.token.role === 'admin';
    // Only disable a user already scoped to THIS company (or as global admin).
    // A target with a different OR ABSENT companyId is not ours — fail closed so
    // a company_admin cannot lock out a solo owner or another tenant's member.
    if (!callerMayManageTarget(existingClaims, companyId, isGlobalAdmin)) {
      throw new HttpsError('permission-denied', 'User belongs to another company');
    }

    // Safety: never kill the owner's login from this path.
    const companySnap = await companyRef.get();
    const ownerId = companySnap.exists ? companySnap.data().ownerId : null;
    if (ownerId && userRecord.uid === ownerId) {
      throw new HttpsError('failed-precondition', 'Cannot deactivate the company owner');
    }
    // R3-9: nor a platform admin, unless the caller is one.
    const protectedMsg = protectedTargetRefusal({ targetUid: userRecord.uid, targetClaims: existingClaims, ownerId, callerIsOwner, isGlobalAdmin });
    if (protectedMsg) throw new HttpsError('permission-denied', protectedMsg);
    // Don't let the caller lock themselves out.
    if (userRecord.uid === callerUid) {
      throw new HttpsError('failed-precondition', 'Cannot deactivate your own account');
    }

    // R3-1: turn off the member's bot keys and calendar feed links before the
    // account is disabled (a failure throws with nothing changed yet). Records
    // are NOT reassigned here: deactivation is reversible, and a disabled
    // account cannot sign in. Reactivating does not bring the keys/links back;
    // the member makes new ones.
    if (!reactivate) {
      await revokeMemberAccessTokens(getFirestore(), userRecord.uid, 'member-deactivated');
    }

    await getAuth().updateUser(userRecord.uid, { disabled: !reactivate });
    // Revoke tokens when deactivating so existing sessions die.
    if (!reactivate) {
      await getAuth().revokeRefreshTokens(userRecord.uid);
    }

    const emailKey = (userRecord.email || targetEmail || '').toLowerCase();
    if (emailKey) {
      await getFirestore().doc(`companies/${companyId}/members/${emailKey}`).set({
        status: reactivate ? 'active' : 'deactivated',
        active: !!reactivate,
        deactivatedAt: reactivate ? null : FieldValue.serverTimestamp(),
        deactivatedBy: reactivate ? null : callerUid,
        // deactivatedReason is the ONLY discriminator reactivateLapsedSeats
        // (lapse-enforcement.js) uses to tell lapse-paused seats from
        // owner-disabled ones. This path must stamp 'owner-removed' on a manual
        // deactivation so a re-checkout does NOT auto-restore an intentionally
        // disabled member — AND clear it to null on reactivation so a member the
        // lapse cron paused (reason:'lapse') then the owner manually reactivated
        // doesn't carry a stale 'lapse' that a later owner-deactivate + checkout
        // would silently reverse. Contract: lapse-enforcement.js:21.
        deactivatedReason: reactivate ? null : 'owner-removed'
      }, { merge: true });
    }

    // A member suspended at their own erasure request is turned back on HERE:
    // close out that request so a later lapse restore treats them as anyone
    // else (lapse-enforcement.js skips outcome 'suspended').
    if (reactivate) {
      try {
        const erRef = getFirestore().doc(`account_erasures/${userRecord.uid}`);
        const er = await erRef.get();
        if (er.exists && (er.data() || {}).outcome === 'suspended') {
          await erRef.update({ outcome: 'reactivated', reactivatedAt: FieldValue.serverTimestamp(), reactivatedBy: callerUid });
        }
      } catch (e) {
        logger.warn('deactivateUser: erasure outcome update failed', { targetUid: userRecord.uid, err: e.message });
      }
    }

    // Audit row (2026-10-08): this is also how an owner or company_admin turns
    // back on a member who suspended themselves through account erasure
    // (deactivatedReason 'self-erasure'), so who did it is written down.
    try {
      await getFirestore().collection('audit_log').add({
        type: reactivate ? 'member_reactivated' : 'member_deactivated',
        op: reactivate ? 'reactivate' : 'deactivate',
        ids: { uid: userRecord.uid, companyId },
        by: callerUid,
        ts: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.warn('deactivateUser: audit row failed', { companyId, targetUid: userRecord.uid, err: e.message });
    }

    logger.info(reactivate ? 'reactivateUser' : 'deactivateUser', {
      companyId, targetUid: userRecord.uid
    });
    return { success: true, uid: userRecord.uid, disabled: !reactivate };
  }
);

// ── transferCompanyOwnership (owner hand-off, Jo 2026-10-08) ─────────────
// The OWNER hands the company to an existing, active company_admin of the
// same company. companies/{id}.ownerId moves to them; the former owner stays
// on the team as a company_admin (roster row created), so from then on their
// own account erasure follows the member path (suspend, delete nothing). The
// company keeps its id (often the former owner's uid): firestore.rules
// ownsTenantByUid() stops the uid-keyed branches granting the former owner
// anything once the company doc names someone else.
//
// Who may call: only the current owner (companies/{id}.ownerId === caller),
// with an enabled Auth account (requireTeamAdmin re-reads the Auth record).
// Not a company_admin, not a platform admin, not the platform owner's own
// company (its id is wired into NBD-only keys across the system), not a solo
// owner with no company doc (nobody to hand to). The tenant comes from the
// caller's own claims; the request names only the target.
// Who may receive: same company (companyId claim), role company_admin, Auth
// enabled, roster row 'active' with their uid. Never the caller.
// Explicit: the request must carry { confirm: true } (the dashboard sends it
// only after its consequences dialog), so a stale or scripted client cannot
// hand a company off by accident.
//
// Money does NOT move (and nothing is charged):
//   - subscriptions/{companyId} is keyed by the company id, which does not
//     change; no Stripe API is called. The card on file keeps paying until the
//     new owner changes it in Billing.
//   - A connected Stripe payout account (connectAccounts/{companyId}) is held
//     under the former owner's identity and bank, so the hand-off is REFUSED
//     while one exists: payouts must never change hands as a side effect.
//
// Ordering is chosen so every failure leaves a safe state: the caller's claims
// are written first (a company_admin claim on a still-owner is harmless), then
// one transaction moves ownerId + roster rows + audit atomically, then the
// target's claims are re-asserted (they already held them).
const HANDOFF_TARGET_ROLE = 'company_admin';
const HANDOFF_PLATFORM_COMPANY = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
const HANDOFF_TARGET_REFUSAL = 'That person is not an active admin on your team. Make them an admin first.';
const HANDOFF_PAYOUT_REFUSAL = 'Online payments are connected to your Stripe payout account, which cannot be handed off here yet. Contact support to move payouts first.';
// ANY connect doc that is not an explicitly failed attempt blocks: a setup in
// flight (status 'creating', no accountId yet) would otherwise bind the old
// owner's Express account to the new owner's company.
function handoffConnectBlocks(d) {
  if (!d) return false;
  if (d.accountId) return true;
  return !!d.status && d.status !== 'failed';
}
exports.transferCompanyOwnership = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    memory: '256MiB'
  },
  async (request) => {
    const { uid: callerUid, companyId, companyRef, isGlobalAdmin } = await requireTeamAdmin(request);
    await callableRateLimit(request, 'transferCompanyOwnership', 5, 3_600_000);

    const token = request.auth.token || {};
    if (isGlobalAdmin || isOwnerCaller(token) || companyId === HANDOFF_PLATFORM_COMPANY) {
      throw new HttpsError('permission-denied', 'This company cannot be handed off from the dashboard');
    }
    if (!request.data || request.data.confirm !== true) {
      throw new HttpsError('failed-precondition', 'Confirm the hand-off to continue');
    }

    const db = getFirestore();
    const coSnap = await companyRef.get();
    const co = coSnap.exists ? (coSnap.data() || {}) : null;
    if (!co || !co.ownerId) {
      throw new HttpsError('permission-denied', 'Only the company owner can hand the company to someone else');
    }
    // A former owner replaying a hand-off that already went through gets the
    // success again (see the idempotent return below); anyone else who is not
    // the owner is refused.
    const isReplayCandidate = co.ownerId !== callerUid && co.previousOwnerId === callerUid;
    if (co.ownerId !== callerUid && !isReplayCandidate) {
      throw new HttpsError('permission-denied', 'Only the company owner can hand the company to someone else');
    }

    let callerRec;
    try { callerRec = await getAuth().getUser(callerUid); } catch (e) {
      throw new HttpsError('unavailable', 'Could not verify your account. Please try again.');
    }
    if (callerRec.disabled === true) {
      throw new HttpsError('permission-denied', 'This account is suspended');
    }

    const targetUidIn = typeof request.data.uid === 'string' ? request.data.uid.trim() : '';
    const targetEmailIn = normalizeEmail(request.data.email);
    if (!targetUidIn && !targetEmailIn) throw new HttpsError('invalid-argument', 'Target uid or email required');
    let target;
    try {
      target = targetUidIn ? await getAuth().getUser(targetUidIn) : await getAuth().getUserByEmail(targetEmailIn);
    } catch (e) {
      if (e && e.code && e.code !== 'auth/user-not-found' && e.code !== 'auth/invalid-uid') {
        throw new HttpsError('unavailable', 'Could not look that person up. Please try again.');
      }
      throw new HttpsError('failed-precondition', HANDOFF_TARGET_REFUSAL);
    }
    if (target.uid === callerUid) throw new HttpsError('failed-precondition', 'You already own this company');

    if (isReplayCandidate) {
      if (co.ownerId === target.uid) {
        return { success: true, replayed: true, companyId, ownerId: target.uid, previousOwnerId: callerUid };
      }
      throw new HttpsError('permission-denied', 'Only the company owner can hand the company to someone else');
    }

    const tClaims = target.customClaims || {};
    // One generic refusal for every "not eligible" shape (another company, a
    // lower role, a platform admin, a disabled or unknown account): the
    // answer must not tell an owner which emails hold accounts elsewhere.
    if (tClaims.companyId !== companyId || tClaims.role !== HANDOFF_TARGET_ROLE || target.disabled === true) {
      throw new HttpsError('failed-precondition', HANDOFF_TARGET_REFUSAL);
    }
    const targetEmail = String(target.email || '').trim().toLowerCase();
    const callerEmail = String(callerRec.email || '').trim().toLowerCase();
    if (!targetEmail || !callerEmail) {
      throw new HttpsError('failed-precondition', 'Both accounts need an email address on file');
    }

    // Payouts never change hands as a side effect (see header).
    const connectSnap = await db.doc(`connectAccounts/${companyId}`).get();
    if (connectSnap.exists && handoffConnectBlocks(connectSnap.data() || {})) {
      throw new HttpsError('failed-precondition', HANDOFF_PAYOUT_REFUSAL);
    }

    // The former owner keeps working as a company_admin. Claims first: if a
    // later step fails the caller is still the owner (and a company_admin
    // claim on an owner is a no-op). Merge, never replace.
    const callerClaims = callerRec.customClaims || {};
    await getAuth().setCustomUserClaims(callerUid, { ...callerClaims, companyId, role: HANDOFF_TARGET_ROLE });

    const targetRow = db.doc(`companies/${companyId}/members/${targetEmail}`);
    const callerRow = db.doc(`companies/${companyId}/members/${callerEmail}`);
    const connectRef = db.doc(`connectAccounts/${companyId}`);
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(companyRef);
      const row = await tx.get(targetRow);
      // Re-read inside the transaction: a payout setup started after the
      // pre-check above is a hand-off blocker too.
      const cn = await tx.get(connectRef);
      if (cn.exists && handoffConnectBlocks(cn.data() || {})) {
        throw new HttpsError('failed-precondition', HANDOFF_PAYOUT_REFUSAL);
      }
      if (!cur.exists || (cur.data() || {}).ownerId !== callerUid) {
        throw new HttpsError('aborted', 'Ownership changed while this was running. Reload and try again.');
      }
      const r = row.exists ? (row.data() || {}) : null;
      if (!r || r.status !== 'active' || r.uid !== target.uid
          || String(r.role || '').toLowerCase() !== HANDOFF_TARGET_ROLE) {
        throw new HttpsError('failed-precondition', HANDOFF_TARGET_REFUSAL);
      }
      tx.update(companyRef, {
        ownerId: target.uid,
        previousOwnerId: callerUid,
        ownershipTransferredAt: FieldValue.serverTimestamp(),
        ownershipTransferredBy: callerUid,
      });
      // The owner holds no roster row (it is not a seat); the former owner
      // now does. Seat count is unchanged: one row out, one row in.
      tx.delete(targetRow);
      tx.set(callerRow, {
        uid: callerUid,
        email: callerEmail,
        role: HANDOFF_TARGET_ROLE,
        status: 'active',
        active: true,
        activatedAt: FieldValue.serverTimestamp(),
        activatedVia: 'owner-handoff',
      }, { merge: true });
      tx.set(db.doc(`users/${target.uid}`), { companyId, role: HANDOFF_TARGET_ROLE }, { merge: true });
      tx.set(db.doc(`users/${callerUid}`), { companyId, role: HANDOFF_TARGET_ROLE }, { merge: true });
      // Audit row inside the same transaction: no transfer without a record.
      // Ids only, no names, emails or phone numbers.
      tx.set(db.collection('audit_log').doc(), {
        type: 'company_ownership_transferred',
        op: 'transfer',
        ids: { companyId, from: callerUid, to: target.uid },
        by: callerUid,
        ts: FieldValue.serverTimestamp(),
      });
    });

    // The new owner already holds company_admin of this company (checked
    // above and again through the roster row inside the transaction). The
    // claims are deliberately NOT re-written from the pre-check read: a stale
    // write here could restore claims a racing removeMember had just stripped.

    // Keys and calendar links the former owner made were made with owner reach:
    // switch them off (the new owner remakes what they need). Best effort, the
    // transfer is committed; the counts are logged, ids only.
    try {
      const { revokeMemberAccessTokens: revoke } = require('../member-offboarding');
      const r = await revoke(db, callerUid, 'owner-handoff');
      logger.info('transferCompanyOwnership: former owner keys revoked', { companyId, ...r });
    } catch (e) {
      logger.warn('transferCompanyOwnership: key revoke failed', { companyId, err: e && e.message });
    }
    logger.info('transferCompanyOwnership', { companyId, from: callerUid, to: target.uid });
    return { success: true, companyId, ownerId: target.uid, previousOwnerId: callerUid };
  }
);

// ── removeMember ─────────────────────────────────────────────
// Fully removes a team member: STRIPS their companyId/role claims
// (merge-preserving billing), revokes their refresh tokens, and deletes
// the roster doc. Replaces the old client-side `deleteDoc(members/...)`,
// which left the removed user's Auth account enabled and their companyId
// claim intact — so Firestore (which authorizes tenant data by claim, not
// roster membership) still granted them full same-tenant read/write until
// the claim happened to change. Stripping the claim also makes a removed
// user correctly un-reactivatable without a fresh invite (deactivateUser's
// callerMayManageTarget gate keys on the now-absent claim).
//
// Handles both member states:
//   - invited (no uid yet — never signed up): just delete the roster doc.
//   - active/deactivated (has a uid): clear claims + revoke, then delete.
// Guards mirror deactivateUser: not the owner, not yourself, same company.
// R3-1: an active member's records are reassigned to the owner first, which
// is why the timeout is 120s rather than 30s.
//
// offboardMember (R3-1, 2026-10-06): before the claims go, take back what the
// claims never covered. Rules authorize company records on the owner field
// (isOwner(userId)) with no tenant check, so a removed rep who signed back in
// still owned every lead, estimate, photo... they had made. Those move to the
// company owner (the caller when the company has no ownerId), and the rep's
// bot keys + calendar feed links are revoked. Both run BEFORE the claim strip:
// if either throws, the rep still carries this company's claim, so
// callerMayManageTarget lets the admin retry. Why reassign rather than a
// rules change: see functions/member-offboarding.js.
//
// Files (2026-10-06, Jo): Storage authorizes on the uid in the object path,
// so the records moving was not enough: the ex-rep could still read and
// delete photos/<rep>/..., documents/<rep>/... and the rest. The reassignment
// now records every moved doc in the storage move's ledger (same batch), and
// after the claim strip the move copies each company file to the owner's
// folder, repoints the records and deletes the original
// (functions/member-storage-move.js). The claim strip also sets the
// offboardLock claim, which storage.rules honours, so the old folder is
// locked for the whole move. One bounded slice runs here; the
// resumeMemberStorageMoves cron finishes a large one.
async function offboardMember(db, uid, toUid, companyId) {
  const revoked = await revokeMemberAccessTokens(db, uid, 'member-removed');
  const move = await prepareMemberStorageMove(db, { companyId, fromUid: uid, toUid });
  const reassigned = await reassignMemberRecords(db, { fromUid: uid, toUid, companyId, ledger: move.ledger });
  await markRecordsReassigned(move.ref);
  logger.info('removeMember.offboarded', {
    companyId, targetUid: uid, ...revoked, reassigned: reassigned.total, skipped: reassigned.skipped, storageMove: move.id,
  });
  return move.id;
}
// What removeMember does BEFORE any record, file or claim changes.
//  - The roster row leaves 'active' first, so a hand-off racing this removal
//    cannot pick the target (its transaction re-reads the row).
//  - A FORMER OWNER's login goes OFF before the claim strip: an enabled,
//    claim-less account would read as the company owner through every
//    `claims.companyId || uid` fallback. Disabling first means a failure here
//    changes nothing, and a failure later leaves the account disabled.
async function beginMemberRemoval(st, db, memberRef, member, userRecord, companyId, formerOwner) {
  if (member && member.status === 'active') {
    await memberRef.set({ status: 'removing', active: false, removingAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  if (formerOwner) {
    await getAuth().updateUser(userRecord.uid, { disabled: true });
    st.signInDisabled = true;
    try {
      const sub = await db.doc(`subscriptions/${companyId}`).get();
      const sd = sub.exists ? (sub.data() || {}) : {};
      st.billingOnFormerOwner = !!(sd.stripeCustomerId || sd.stripeSubscriptionId);
    } catch (_) { /* informational only */ }
  }
}
exports.removeMember = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 120,
    memory: '256MiB'
  },
  async (request) => {
    const { uid: callerUid, companyId, companyRef, isOwner: callerIsOwner } = await requireTeamAdmin(request);
    await callableRateLimit(request, 'removeMember', 20, 60_000);

    const targetEmail = normalizeEmail(request.data && request.data.email);
    if (!targetEmail) throw new HttpsError('invalid-argument', 'Target email required');

    const db = getFirestore();
    const memberRef = db.doc(`companies/${companyId}/members/${targetEmail}`);
    const memberSnap = await memberRef.get();
    if (!memberSnap.exists) {
      // Idempotent: nothing to remove.
      return { success: true, removed: false, reason: 'not_found' };
    }
    const member = memberSnap.data() || {};

    // Resolve the Auth account (member doc may carry uid; else look up by
    // email). A pending invite has neither → claim-clearing is a no-op.
    let userRecord = null;
    const lookupUid = typeof member.uid === 'string' ? member.uid : null;
    try {
      userRecord = lookupUid
        ? await getAuth().getUser(lookupUid)
        : await getAuth().getUserByEmail(targetEmail);
    } catch (_) { userRecord = null; } // invited-but-never-signed-up → no account

    // A PENDING invite (status 'invited', no uid) has never been claimed, so
    // the invitee's claims cannot legitimately point at this company. The old
    // code still ran the fail-closed foreign-claim guard against whatever
    // account owned that email — and since the invite email tells people to
    // register (which mints solo claims companyId==their-own-uid), cancelling
    // any invite whose recipient had ANY account threw 'User belongs to
    // another company' and the seat was stuck forever (gauntlet gap). The
    // guard must gate the CLAIM MUTATION, not the roster-row delete: deleting
    // our own tenant's invite row harms no one.
    const isPendingInvite = member.status === 'invited' && !lookupUid;
    let moveId = null;
    const st = { signInDisabled: false, billingOnFormerOwner: false };

    if (userRecord) {
      // Never remove the owner or yourself.
      const companySnap = await companyRef.get();
      const ownerId = companySnap.exists ? companySnap.data().ownerId : null;
      if (ownerId && userRecord.uid === ownerId) {
        throw new HttpsError('failed-precondition', 'Cannot remove the company owner');
      }
      if (userRecord.uid === callerUid) {
        throw new HttpsError('failed-precondition', 'Cannot remove your own account');
      }
      const existingClaims = userRecord.customClaims || {};
      const isGlobalAdmin = request.auth.token.role === 'admin';
      // R3-9: never strip a platform admin's claims unless the caller is one
      // (a pending-invite cancel only drops our roster row — allowed).
      const protectedMsg = protectedTargetRefusal({ targetUid: userRecord.uid, targetClaims: existingClaims, ownerId, callerIsOwner, isGlobalAdmin });
      if (protectedMsg && !isPendingInvite) throw new HttpsError('permission-denied', protectedMsg);
      // A FORMER OWNER's uid is the company id, so they are provably this
      // company's even once their claims are gone: that is what lets a retry
      // finish a removal that stopped between the claim strip and the disable.
      const formerOwner = !!ownerId && ownerId !== userRecord.uid && userRecord.uid === companyId;
      const managesTarget = callerMayManageTarget(existingClaims, companyId, isGlobalAdmin) || formerOwner;
      if (!managesTarget && !isPendingInvite) {
        // Active/claimed member with foreign or absent claims: fail closed —
        // only touch a user actually scoped to THIS company.
        throw new HttpsError('permission-denied', 'User belongs to another company');
      }
      // Below: row off 'active' + former-owner login off, records move, then
      // companyId + role are stripped (billing claims are PRESERVED).
      if (managesTarget) {
        await beginMemberRemoval(st, db, memberRef, member, userRecord, companyId, formerOwner);
        moveId = await offboardMember(db, userRecord.uid, ownerId || callerUid, companyId);
        const stripped = { ...existingClaims, [LOCK_CLAIM]: true };
        delete stripped.companyId;
        delete stripped.role;
        await getAuth().setCustomUserClaims(userRecord.uid, stripped);
        await getAuth().revokeRefreshTokens(userRecord.uid);
      }
      // else: pending-invite cancel for an account claimed elsewhere — leave
      // that account's claims alone and just drop our roster row below.
    }

    await memberRef.delete();
    logger.info('removeMember', { companyId, targetEmail, hadAccount: !!userRecord });

    // The removal is done. Start the file move; whatever this slice does not
    // finish, the cron does, so a failure here never fails the removal.
    let filesMove = null;
    if (moveId) {
      try {
        const { getStorage } = require('firebase-admin/storage');
        filesMove = (await runMemberStorageMove(db, getStorage().bucket(), moveId, {
          auth: getAuth(), logger, deadlineMs: 45_000,
        })).status;
      } catch (e) {
        logger.warn('removeMember.storageMove deferred to cron', { moveId, msg: e && e.message });
        filesMove = 'running';
      }
    }
    return { success: true, removed: true, hadAccount: !!userRecord, filesMove, signInDisabled: st.signInDisabled, billingOnFormerOwner: st.billingOnFormerOwner };
  }
);

// ── listTeamMembers ──────────────────────────────────────────
// Returns the team roster enriched with Auth data (lastSignInTime,
// disabled) and a lead count per member. The member doc by itself
// has email/role/status; the extras come from Auth + a cheap
// collectionGroup count on leads.
exports.listTeamMembers = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB'
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    const claims = request.auth.token || {};
    const isGlobalAdmin = claims.role === 'admin';
    const isManager = claims.role === 'manager';
    const callerCompanyId = claims.companyId || uid;
    const companyId = (request.data && request.data.companyId) || callerCompanyId;

    // Managers and owners can list their own team. Admins can list any.
    if (!isGlobalAdmin && companyId !== callerCompanyId) {
      throw new HttpsError('permission-denied', 'Cannot view another company');
    }

    const db = getFirestore();
    const companySnap = await db.doc(`companies/${companyId}`).get();
    // Solo-operator fallback: if the company doc hasn't been created
    // yet AND the caller is acting on their own workspace
    // (companyId === uid), treat them as the owner. Otherwise a solo
    // operator who clicks "Team" before ever creating a company doc
    // gets permission-denied and an empty roster they can't escape.
    const isSelfWorkspace = companyId === uid;
    const ownerId = companySnap.exists
      ? companySnap.data().ownerId
      : (isSelfWorkspace ? uid : null);
    if (!isGlobalAdmin && !isManager && ownerId !== uid) {
      throw new HttpsError('permission-denied', 'Owner, manager, or admin required');
    }

    const membersSnap = await db.collection(`companies/${companyId}/members`).get();
    const members = [];

    // Always include the owner card first.
    if (ownerId) {
      try {
        const ownerRecord = await getAuth().getUser(ownerId);
        // Counted like every member below — this was hard-coded 0, so the
        // owner's own row always read "0 leads".
        let ownerLeadCount = 0;
        try {
          const ownerLeads = await db.collection('leads').where('userId', '==', ownerId).count().get();
          ownerLeadCount = ownerLeads.data().count || 0;
        } catch (e) { /* counts may fail on missing index; leave 0 */ }
        members.push({
          uid: ownerId,
          email: (ownerRecord.email || '').toLowerCase(),
          displayName: ownerRecord.displayName || 'Owner',
          role: 'company_admin',
          status: ownerRecord.disabled ? 'deactivated' : 'active',
          isOwner: true,
          disabled: !!ownerRecord.disabled,
          lastSignInTime: ownerRecord.metadata?.lastSignInTime || null,
          creationTime: ownerRecord.metadata?.creationTime || null,
          leadCount: ownerLeadCount
        });
      } catch (e) {
        logger.warn('listTeamMembers: owner lookup failed', { ownerId, err: e.message });
      }
    }

    for (const doc of membersSnap.docs) {
      const m = doc.data() || {};
      if (!m.email) continue;
      if (m.uid && m.uid === ownerId) continue; // owner already listed

      let authMeta = null;
      try {
        const u = m.uid
          ? await getAuth().getUser(m.uid)
          : await getAuth().getUserByEmail(m.email);
        authMeta = {
          uid: u.uid,
          disabled: !!u.disabled,
          lastSignInTime: u.metadata?.lastSignInTime || null,
          creationTime: u.metadata?.creationTime || null
        };
      } catch (e) { /* invited but not signed up yet */ }

      // Lead count — skip if member never activated (no uid to match).
      let leadCount = 0;
      if (authMeta?.uid) {
        try {
          const leadsSnap = await db.collection('leads')
            .where('userId', '==', authMeta.uid)
            .count()
            .get();
          leadCount = leadsSnap.data().count || 0;
        } catch (e) { /* counts may fail on missing index; leave 0 */ }
      }

      members.push({
        uid: authMeta?.uid || m.uid || null,
        email: m.email,
        displayName: m.displayName || m.email.split('@')[0],
        role: m.role || 'sales_rep',
        status: authMeta?.disabled
          ? 'deactivated'
          : (m.status || (authMeta ? 'active' : 'invited')),
        isOwner: false,
        disabled: !!authMeta?.disabled,
        lastSignInTime: authMeta?.lastSignInTime || null,
        creationTime: authMeta?.creationTime || m.invitedAt?.toDate?.()?.toISOString() || null,
        leadCount
      });
    }

    return { success: true, companyId, members, count: members.length };
  }
);
