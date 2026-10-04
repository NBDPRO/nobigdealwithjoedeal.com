/**
 * NBD PRO — self-serve tenant provisioning (PILLAR1 Phase 2)
 * ═══════════════════════════════════════════════════════════════
 * createCompany: a freshly-signed-up owner turns their account into a real
 * tenant — `companies/{uid}` + a minimal `companyProfile/{uid}` seed + the
 * `companyId`/`role:company_admin` custom claims (the rules' + requireTeamAdmin's canonical top company role — 'owner' is not in the role vocabulary) — without Jo hand-seeding Firestore
 * (previously the ONLY way; see NBD-PRO-PRODUCT-AUDIT-2026-07.md gap #1 and
 * PILLAR1-PROVISIONING-PLAN.md Phase 2).
 *
 * Conventions honored:
 *  - companyId == uid (the existing solo-operator convention, formalized —
 *    every resolver, rules block, and lead-router already understands it, and
 *    it makes companies/{id} exist so submitPublicLead's tenant validation
 *    and lead-bridge routing work for the new tenant).
 *  - The companyProfile seed is NEUTRAL (tenant's own name + their auth
 *    email as alert contact). Deliberately NOT NBD's brand defaults — the
 *    Pillar-2 "NBD bleed" review (M1) is why: a half-configured tenant must
 *    never inherit Joe's phone/logo/seal. Unset fields fall through to the
 *    same neutral behavior the resolver already implements.
 *  - Claims via merge (setCustomUserClaims REPLACES the set — same trap the
 *    Stripe webhook guards against with its own mergeCustomClaims).
 *
 * Idempotent: calling again returns the existing tenant. A user who already
 * belongs to SOMEONE ELSE'S company (invited rep) is refused — reps don't
 * spawn their own tenants by accident.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { CORS_ORIGINS } = require('./_shared');
const { callableRateLimit } = require('../shared');
const { validateSeal, decideReservation } = require('../prefix-reservation');

// Mirror of functions/stripe.js mergeCustomClaims — setCustomUserClaims
// replaces the whole claim set, so read-merge-write to avoid wiping the
// billing claims the Stripe webhook maintains.
async function mergeCustomClaims(uid, patch) {
  let existing = {};
  try {
    existing = (await getAuth().getUser(uid)).customClaims || {};
  } catch (e) {
    logger.error('createCompany_getUser_failed', { uid, err: e.message });
    throw new HttpsError('internal', 'Could not read account');
  }
  await getAuth().setCustomUserClaims(uid, { ...existing, ...patch });
}

// Exported for unit tests.
function validateCompanyInput(data) {
  const name = String((data && data.name) || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 80) {
    return { error: 'Company name must be 2-80 characters.' };
  }
  const phoneDigits = String((data && data.phone) || '').replace(/[^\d]/g, '');
  const phone = phoneDigits.length === 10 ? phoneDigits
    : (phoneDigits.length === 11 && phoneDigits[0] === '1') ? phoneDigits.slice(1) : '';
  const serviceArea = String((data && data.serviceArea) || '').trim().slice(0, 120);
  return { name, phone, serviceArea };
}

exports.createCompany = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Not authenticated');
    await callableRateLimit(request, 'createCompany', 5, 3_600_000);

    // Invited reps belong to their inviter's tenant — refuse a second one.
    const claimCompany = request.auth.token.companyId;
    if (claimCompany && claimCompany !== uid) {
      throw new HttpsError('failed-precondition',
        'This account already belongs to a company.');
    }

    // Platform admins never lose their role claim through self-serve
    // provisioning. Mirrors claimInvite's guard (handlers/invites.js:95,
    // "Never let an invite doc rewrite a platform admin's claims.") —
    // createCompany had no equivalent, so a platform admin testing
    // self-serve signup or hitting the onboarding wizard's self-heal
    // retry got mergeCustomClaims(uid, { role: 'company_admin' }) applied
    // unconditionally, demoting them from 'admin' until mintOwnerClaims
    // was manually re-run. companyId alone is safe to add: isGlobalAdmin
    // checks bypass company scoping everywhere else (_shared.js), so it
    // never narrows an admin's access — only `role` needs protecting.
    const isPlatformAdmin = request.auth.token.role === 'admin';
    const tenantClaimPatch = isPlatformAdmin
      ? { companyId: uid }
      : { companyId: uid, role: 'company_admin' };

    const db = getFirestore();
    const companyRef = db.doc(`companies/${uid}`);

    // Idempotent re-call: tenant already provisioned.
    const existing = await companyRef.get();
    if (existing.exists) {
      if ((existing.data() || {}).ownerId !== uid) {
        // companies/{uid} owned by someone else shouldn't be possible under
        // the uid convention — refuse loudly rather than adopt it.
        throw new HttpsError('failed-precondition', 'Company id conflict.');
      }
      if (!claimCompany) await mergeCustomClaims(uid, tenantClaimPatch);
      return { created: false, companyId: uid };
    }

    const v = validateCompanyInput(request.data);
    if (v.error) throw new HttpsError('invalid-argument', v.error);

    const email = String(request.auth.token.email || '').toLowerCase();
    const now = FieldValue.serverTimestamp();

    const batch = db.batch();
    batch.set(companyRef, {
      name: v.name,
      ownerId: uid,
      // status:'active' = a working CRM tenant. The PUBLIC microsite is a
      // separate release: it starts unpublished and only the owner's
      // publishTenantSite call (name + phone + service area filled) flips it.
      // Without this, every free signup got a live page on Jo's domain with
      // whatever name and phone it typed (handlers/public-site.js).
      status: 'active',
      sitePublished: false,
      plan: 'free',
      source: 'self-serve',
      createdAt: now,
    });
    // MERGE, not overwrite. The onboarding wizard (Phase 4) writes the full
    // brand to companyProfile/{uid} and THEN calls createCompany as a
    // self-heal when register-time provisioning didn't land — the exact
    // recovery path. companies/{uid} not existing (the idempotency gate above)
    // does NOT imply companyProfile/{uid} is absent, so a plain set() here
    // clobbered everything the tenant just configured (seal, colors, logo,
    // contact, letterhead). Merge preserves those and only ADDS the neutral
    // identity seed (deep-merging brand.contact.alertEmail alongside any
    // contact the wizard set). Still no NBD values — every seed field is the
    // tenant's own.
    batch.set(db.doc(`companyProfile/${uid}`), {
      brand: {
        legalName: v.name,
        contact: {
          ...(email ? { alertEmail: email } : {}),
          ...(v.phone ? { alertSms: '+1' + v.phone } : {}),
        },
        ...(v.serviceArea ? { serviceArea: v.serviceArea } : {}),
      },
      provisionedBy: 'createCompany-v1',
      createdAt: now,
    }, { merge: true });
    await batch.commit();

    // Seed a canonical FREE subscriptions doc so every tenant has one — single
    // source of truth, instead of "absence == free" inferred across ~8 readers.
    // Shape reads IDENTICALLY to an absent doc everywhere (plan:'free',
    // status:'none' — billing-gate's exact free sentinel), so no reader changes
    // behavior; only createCustomerPortalSession was taught to treat a
    // customer-less doc like an absent one (404 → pricing).
    // create() is ATOMIC and fails if a doc already exists — critical: a
    // buy-first checkout (or access-code grant) can write a PAID/comp doc before
    // this runs, and must NEVER be clobbered down to free. ALREADY_EXISTS is the
    // expected, benign outcome in that race; anything else propagates.
    try {
      await db.doc(`subscriptions/${uid}`).create({
        plan: 'free',
        status: 'none',
        source: 'self-serve',
        usage: { leads: 0, reports: 0, aiCalls: 0, cycleStart: new Date().toISOString() },
        createdAt: now,
      });
    } catch (e) {
      if (!(e.code === 6 || /already exists/i.test(String(e.message)))) {
        logger.warn('createCompany_free_sub_seed_failed', { uid, err: e.message });
      }
    }

    await mergeCustomClaims(uid, tenantClaimPatch);

    logger.info('createCompany_provisioned', { uid, name: v.name });
    // Client must force-refresh the ID token to pick up the new claims.
    return { created: true, companyId: uid };
  }
);

// ═════════════════════════════════════════════════════════════════
// reserveCompanyPrefix — atomically claim a GLOBALLY-UNIQUE customer-ID
// prefix (seal) for the caller's tenant.
// ═════════════════════════════════════════════════════════════════
//
// Why this exists: customer IDs are 'PREFIX-####' (e.g. 'OAK-0001'), minted
// from a PER-TENANT counter that starts at 1. The prefix used to be chosen
// client-side with only a format check + a reserved 'NBD' literal — nothing
// stopped two self-serve tenants from both deriving the seal 'OAK' and each
// minting 'OAK-0001'. The public referral endpoint (functions/referrals.js)
// resolves the source customer by an UNSCOPED `where('customerId','==',ref)`,
// so a colliding prefix would silently drop a homeowner's PII lead into the
// WRONG tenant's CRM and notify the wrong rep. Making prefixes globally unique
// makes every customerId globally unique, which closes that misroute at the root.
//
// This callable is the ONLY writer of brand.docPrefix / brand.seal (firestore
// rules make them client-immutable) and of docPrefixes/{PREFIX} (rules deny all
// client writes). It reserves the prefix in a transaction: free → claim it +
// stamp the profile; already yours → idempotent no-op; taken by someone else →
// rejected. A tenant that already owns a different prefix is refused (rotating a
// prefix would strand every existing customerId minted under the old one).
// validateSeal + decideReservation live in ../prefix-reservation (pure, unit-
// tested); this callable just wires them to the Firestore transaction I/O.
exports.reserveCompanyPrefix = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Not authenticated');
    await callableRateLimit(request, 'reserveCompanyPrefix', 10, 3_600_000);

    // Invited reps belong to their inviter's tenant — only the owner sets the
    // company prefix. companyId == uid for solo owners (the standard convention).
    const claimCompany = request.auth.token.companyId;
    if (claimCompany && claimCompany !== uid) {
      throw new HttpsError('failed-precondition',
        'Only the company owner can set the customer-ID prefix.');
    }
    const companyId = claimCompany || uid;

    const v = validateSeal(request.data && request.data.seal);
    if (v.error) throw new HttpsError('invalid-argument', v.error);
    const seal = v.seal;

    const db = getFirestore();
    const prefixRef = db.doc(`docPrefixes/${seal}`);
    const profileRef = db.doc(`companyProfile/${companyId}`);
    const now = FieldValue.serverTimestamp();

    let result;
    try {
      result = await db.runTransaction(async (tx) => {
        // Reads first (transaction rule): the registry slot + this tenant's
        // currently-reserved prefix (if any).
        const [prefixSnap, profileSnap] = await Promise.all([
          tx.get(prefixRef),
          tx.get(profileRef),
        ]);

        const decision = decideReservation({
          prefixExists: prefixSnap.exists,
          prefixOwner: (prefixSnap.data() || {}).companyId,
          existingPrefix: ((profileSnap.data() || {}).brand || {}).docPrefix,
          companyId,
          seal,
        });

        if (decision.action === 'reject') {
          if (decision.code === 'already-exists') {
            // Held by a different tenant — exactly the collision we block.
            throw new HttpsError('already-exists',
              'Those initials are already in use by another company. Please choose different initials.');
          }
          // Rotating a prefix would strand every customerId minted under the old
          // one (and orphan its registry entry).
          throw new HttpsError('failed-precondition',
            'Your company already has a customer-ID prefix set; it cannot be changed here.');
        }

        if (decision.action === 'idempotent') {
          // Already ours. Re-stamp the profile defensively (a partial earlier run
          // could have written the registry but not the profile) and return.
          tx.set(profileRef, { brand: { docPrefix: seal, seal } }, { merge: true });
          return { reserved: false, seal, alreadyOwned: true };
        }

        // action === 'claim' — free slot.
        tx.set(prefixRef, {
          companyId,
          seal,
          reservedVia: 'reserveCompanyPrefix',
          reservedBy: uid,
          reservedAt: now,
        });
        tx.set(profileRef, { brand: { docPrefix: seal, seal } }, { merge: true });
        return { reserved: true, seal };
      });
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('reserveCompanyPrefix_txn_failed', { uid, seal, err: e.message });
      throw new HttpsError('internal', 'Could not reserve your prefix. Try again.');
    }

    logger.info('reserveCompanyPrefix_done', { uid, companyId, seal, reserved: result.reserved });
    return result;
  }
);

exports._test = { validateCompanyInput, validateSeal, decideReservation };
