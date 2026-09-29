/**
 * NBD PRO — team invites, de-GCIP'd (PILLAR1 Phase 3)
 * ═══════════════════════════════════════════════════════════════
 * The original design stamped invited reps' claims in onRepSignup, a
 * beforeUserCreated BLOCKING trigger — which needs a GCIP upgrade and sits
 * permanently in NBD_DEPLOY_SKIP_LIST, so invites have never worked in
 * production: the team tab wrote companies/{owner}/members/{email} docs,
 * no email went out, and no claim was ever stamped. This module is the
 * plan's recommended alternative (Phase 0 option b): a non-blocking claim
 * on first dashboard load instead of a blocking trigger at signup.
 *
 *   claimInvite (onCall)      — signed-in user with a VERIFIED email and no
 *     foreign company claim looks up their pending invite and, if found,
 *     gets { companyId, role, plan } claims merged + the member doc
 *     activated. Called by dashboard-bootstrap on first load; idempotent.
 *
 *   teamInviteEmail (onDocumentCreated companies/{companyId}/members/{id})
 *     — the missing notification: emails the invitee signup instructions
 *     when the owner creates an invite. Platform-branded, reply-to owner.
 *
 * Security posture:
 *  - email_verified REQUIRED before a claim can be made. The blocking
 *    trigger matched the provider-supplied email at creation; without it,
 *    anyone could register an unverified account with someone else's email
 *    and inherit their invite. Google SSO is verified by construction;
 *    email/password users click the verification link register.js sends.
 *  - Role allowlist (INVITE_ALLOWED_ROLES) re-checked server-side — an
 *    invite doc carrying role 'admin' can never mint platform-admin claims.
 *  - Platform admins are refused outright: claiming an invite would
 *    OVERWRITE their role claim with a tenant role.
 *  - A rep who already belongs to ANOTHER company is refused (claims are
 *    not silently re-pointed). A self-serve solo owner (companyId == uid,
 *    the Phase-2 default for every new signup) MAY claim — their empty
 *    solo tenant is marked superseded, never deleted.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { Resend } = require('resend');
const { CORS_ORIGINS, INVITE_ALLOWED_ROLES, isOwnerCaller, requireTeamAdmin } = require('./_shared');
const { callableRateLimit } = require('../shared');
const { findPendingInvite } = require('./invite-lookup');
// Seat caps live in billing.js PLAN_LIMITS (server source of truth for the
// plan table; mirrors docs/pro/js/billing-gate.js PLANS).
const { _test: { PLAN_LIMITS } } = require('../billing');

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const EMAIL_FROM = defineSecret('EMAIL_FROM');
const { secretOr } = require('../integrations/_shared');
const { resendRejected, resendErrorMessage } = require('../resend-guard');

// Mirror of stripe.js/provisioning.js mergeCustomClaims — setCustomUserClaims
// replaces the whole set, so read-merge-write to keep billing claims intact.
async function mergeCustomClaims(uid, patch) {
  let existing = {};
  try {
    existing = (await getAuth().getUser(uid)).customClaims || {};
  } catch (e) {
    logger.error('claimInvite_getUser_failed', { uid, err: e.message });
    throw new HttpsError('internal', 'Could not read account');
  }
  await getAuth().setCustomUserClaims(uid, { ...existing, ...patch });
}

// The role an invite actually grants. Exported for unit tests.
// Fail-down mirror of onRepSignup: anything outside the allowlist (incl.
// 'admin' and garbage) becomes the lowest-privilege field role.
function resolveInviteRole(requested) {
  return INVITE_ALLOWED_ROLES.has(requested) ? requested : 'sales_rep';
}

exports.claimInvite = onCall(
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
    await callableRateLimit(request, 'claimInvite', 10, 3_600_000);

    const token = request.auth.token || {};
    const email = String(token.email || '').toLowerCase().trim();
    if (!email) return { claimed: false, reason: 'no_email' };

    // Never let an invite doc rewrite a platform admin's claims.
    if (token.role === 'admin') return { claimed: false, reason: 'platform_admin' };

    // Already on someone else's team — claims are not re-pointed silently.
    if (token.companyId && token.companyId !== uid) {
      return { claimed: false, reason: 'already_member' };
    }

    const db = getFirestore();

    // Find the pending invite BEFORE the verified-email wall so an
    // unverified user with no invite gets the cheap terminal 'no_invite'
    // (the dashboard hook stops retrying) instead of an endless
    // email-unverified loop for the 99% with no invite at all.
    //
    // 2026-09-25 (invite-claim path check): the lookup lives in
    // handlers/invite-lookup.js, shared with onRepSignup. It used to be an
    // inline collectionGroup('members') query here that read the tenant off
    // ref.parent.parent.id, so a `members` doc under ANY parent counted as an
    // invite, including one a user wrote under their own users/{uid}. Now only
    // a doc at exactly companies/{companyId}/members/{email}, with an issuable
    // role and an existing company doc, is an invite; anything else is dropped
    // before the ambiguity check below. See that file's header.
    const lookup = await findPendingInvite(db, email);
    if (lookup.nonCanonical || lookup.invalid || lookup.orphaned || lookup.truncated) {
      logger.warn('claimInvite: dropped member docs that are not invites', {
        nonCanonical: lookup.nonCanonical, invalid: lookup.invalid,
        orphaned: lookup.orphaned, truncated: lookup.truncated,
      });
    }
    if (lookup.status === 'none') return { claimed: false, reason: 'no_invite' };

    // Two DIFFERENT companies invited the same email. The collectionGroup has
    // no orderBy, so Firestore orders by __name__ (the full member path) and
    // taking the first hit would silently claim the lexicographically-smallest
    // companyId — NOT necessarily the tenant the rep meant to join. That is a
    // cross-tenant mis-claim (wrong-tenant data leak) AND a permanent lockout:
    // once the wrong companyId is on the token, the `token.companyId !== uid`
    // guard above rejects every retry. Refuse instead; the owners resolve the
    // collision (cancel the stray invite) and the rep re-checks. Non-terminal
    // client-side so it self-heals. findPendingInvite counts companies only
    // over REAL invites, so a stray doc can no longer trigger this. It also
    // answers 'ambiguous' (truncated: true) when its scan hit the page cap
    // (2026-09-25 review fixup): past the cap it cannot tell which invite,
    // or whether a second one exists.
    if (lookup.status === 'ambiguous') {
      logger.warn('claimInvite: ambiguous cross-tenant invite — refusing', {
        email, companies: lookup.companyIds, truncated: lookup.truncated,
      });
      return { claimed: false, reason: 'ambiguous_invite' };
    }

    const memberRef = lookup.ref;
    const memberData = lookup.data || {};
    const companyId = lookup.companyId;

    // Invite expiry (gauntlet batch 2 — product decision 2026-07-16:
    // 30 days). An expired invite is claimable no more; the owner's
    // Re-send recreates the doc with a fresh invitedAt (delete+recreate
    // transaction), which restarts the clock. Checked BEFORE the
    // verified-email wall so an expired invite doesn't loop the invitee
    // through verification for nothing. Missing invitedAt (pre-expiry
    // docs) is treated as fresh — never strand a legacy invite.
    if (isInviteExpired(memberData)) {
      return { claimed: false, reason: 'invite_expired' };
    }

    // Invite exists — now the email-ownership wall. The ID token's
    // email_verified claim can lag the real Auth record by up to ~1h: Firebase
    // does NOT re-mint the claim the moment a user verifies. A rep who verifies
    // in another tab/device and returns to the still-signed-in dashboard would
    // otherwise be stranded behind this wall with a stale token until sign-out/in.
    // Fall back to the authoritative Auth record before refusing (mirrors
    // mintOwnerClaims, functions/handlers/auth.js).
    let emailVerified = token.email_verified === true;
    if (!emailVerified) {
      try {
        const rec = await getAuth().getUser(uid);
        emailVerified = rec.emailVerified === true;
      } catch (e) {
        logger.warn('claimInvite: email-verify recheck failed', { uid, err: e.message });
      }
    }
    if (!emailVerified) {
      throw new HttpsError('failed-precondition',
        'Verify your email address first — check your inbox for the verification link, then reload.');
    }

    // Owner inviting themselves is a no-op tenant-wise; refuse to avoid a
    // self-invite overwriting company_admin with a lesser role.
    if (companyId === uid) return { claimed: false, reason: 'own_company' };

    const role = resolveInviteRole(typeof memberData.role === 'string' ? memberData.role : '');
    if (role !== memberData.role) {
      logger.warn('claimInvite: invite role outside allowlist', { companyId, requested: memberData.role });
    }

    // findPendingInvite already read (and required) the company doc.
    const companyName = (lookup.company && lookup.company.name) || '';

    // Explicit Join for anyone who owns a company of their own (2026-09-29,
    // the 09-26 "inviteaccept" lane). The dashboard used to call this at boot
    // for every solo account and it claimed on the spot, so ANY tenant's
    // invite to an owner's email silently moved that owner (Jo included) into
    // the other team — and the client's "already checked" flag lives in nbd_
    // localStorage, which sign-out wipes. Enforced HERE, not in the client, so
    // a stale cached dashboard cannot claim either: an owner gets a preview
    // and must call again with { confirm: true }.
    //
    // An account with no tenant of its own still joins at once. That is the
    // person who signed up through the invite email's link (register.js
    // ?invite=1 never provisions a solo company), and signing up through the
    // invite IS the acceptance.
    let ownsTenant = token.companyId === uid;
    if (!ownsTenant) {
      const own = await db.doc(`companies/${uid}`).get();
      ownsTenant = own.exists && (own.data() || {}).ownerId === uid;
    }
    const confirmed = !!(request.data && request.data.confirm === true);
    if (ownsTenant && !confirmed) {
      return { claimed: false, reason: 'confirm_required', companyId, companyName, role, ownsTenant: true };
    }

    // Only companyId + role. Deliberately NO `plan` claim: post-Pillar-4
    // billing resolves from subscriptions/{companyId}, so a rep inherits the
    // company plan from the doc automatically — and hardcoding plan:'growth'
    // here (the old onRepSignup shape) CLOBBERED a paid solo owner's real
    // plan claim on merge (the plan claim is telemetry-only now, but the
    // clobber still violated the merge-don't-replace invariant and mislabeled
    // Sentry). mergeCustomClaims preserves any existing plan/billing claims.
    await mergeCustomClaims(uid, { companyId, role });

    const batch = db.batch();
    batch.update(memberRef, {
      status: 'active',
      uid,
      activatedAt: FieldValue.serverTimestamp(),
      activatedVia: 'claimInvite-v1',
    });
    batch.set(db.doc(`users/${uid}`), {
      email,
      role,
      companyId,
      displayName: token.name || email.split('@')[0],
    }, { merge: true });
    // A Phase-2 self-serve solo tenant being absorbed into a team: keep the
    // doc (their solo-era data stays keyed to them) but mark it so nothing
    // routes new work to it.
    if (token.companyId === uid) {
      const soloRef = db.doc(`companies/${uid}`);
      const soloSnap = await soloRef.get();
      if (soloSnap.exists && (soloSnap.data() || {}).ownerId === uid) {
        batch.update(soloRef, {
          status: 'superseded-by-invite',
          supersededBy: companyId,
          supersededAt: FieldValue.serverTimestamp(),
        });
      }
    }
    await batch.commit();

    logger.info('claimInvite: activated', { uid, companyId, role });
    // Client must getIdToken(true) to pick up the new claims.
    return { claimed: true, companyId, role, companyName };
  }
);

// ───────────────────────────────────────────────────────────────
// teamInviteEmail — the notification the team tab always implied
// ("Invite sent") but never actually sent.
// ───────────────────────────────────────────────────────────────
const SITE_URL = 'https://nobigdealwithjoedeal.com';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function inviteEmailHtml(companyName, roleLabel) {
  const co = esc(companyName || 'your team');
  return `<!doctype html><html><body style="font-family:'Barlow','Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;color:#333">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <div style="background:linear-gradient(135deg,#1a3057,#12223d);color:#fff;padding:22px 20px;text-align:center">
      <div style="font-size:22px;font-weight:700">You're invited to join ${co}</div>
      <div style="font-size:13px;opacity:.85;margin-top:4px">on NBD PRO — the contractor platform</div>
    </div>
    <div style="padding:24px 22px;font-size:15px;line-height:1.65">
      <p style="margin:0 0 14px">${co} added you to their team as <strong>${esc(roleLabel)}</strong>. Three steps and you're in:</p>
      <ol style="margin:0 0 14px;padding-left:22px">
        <li style="margin-bottom:8px">Create your account at the link below <strong>using this email address</strong> (or sign in if you already have one).</li>
        <li style="margin-bottom:8px">Verify your email — click the link in the verification message.</li>
        <li>Open your dashboard. You'll be joined to the team automatically.</li>
      </ol>
      <p style="text-align:center;margin:20px 0"><a href="${SITE_URL}/pro/register.html?invite=1" style="display:inline-block;background:#bd5728;color:#fff;padding:13px 30px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px">Create your account</a></p>
      <p style="margin:0;color:#6b7280;font-size:13px">Didn't expect this? You can ignore this email — nothing happens without you signing up.</p>
    </div>
  </div>
</body></html>`;
}

function inviteEmailText(companyName, roleLabel) {
  const co = companyName || 'your team';
  return `${co} added you to their team on NBD PRO as ${roleLabel}.\n\nThree steps and you're in:\n1. Create your account at ${SITE_URL}/pro/register.html?invite=1 using this email address (or sign in if you already have one).\n2. Verify your email — click the link in the verification message.\n3. Open your dashboard. You'll be joined to the team automatically.\n\nDidn't expect this? You can ignore this email — nothing happens without you signing up.`;
}

exports.teamInviteEmail = onDocumentCreated(
  {
    region: 'us-central1',
    document: 'companies/{companyId}/members/{memberId}',
    secrets: [RESEND_API_KEY, EMAIL_FROM],
    maxInstances: 10,
    memory: '256MiB',
    timeoutSeconds: 30,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const d = snap.data() || {};
    if (d.status !== 'invited') return; // seeds/migrations/active writes: not ours
    const to = String(d.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      logger.warn('teamInviteEmail: bad invite email, skipping', { companyId: event.params.companyId });
      return;
    }

    const db = getFirestore();
    const companyId = event.params.companyId;
    let companyName = '';
    let replyTo;
    try {
      const coSnap = await db.doc(`companies/${companyId}`).get();
      if (coSnap.exists) companyName = (coSnap.data() || {}).name || '';
      // Reply-to the inviting owner so responses go to a human.
      const inviterUid = d.invitedBy || companyId;
      const inviter = await getAuth().getUser(String(inviterUid)).catch(() => null);
      if (inviter && inviter.email) replyTo = inviter.email;
    } catch (_) { /* cosmetic lookups — never block the send */ }

    const roleLabel = String(d.role || 'sales rep').replace(/_/g, ' ');
    let emailStatus;
    try {
      const resend = new Resend(RESEND_API_KEY.value());
      const from = secretOr(EMAIL_FROM, 'noreply@nobigdealwithjoedeal.com');
      const response = await resend.emails.send({
        from,
        to,
        reply_to: replyTo,
        subject: `${companyName || 'A team'} invited you to NBD PRO`,
        html: inviteEmailHtml(companyName, roleLabel),
        text: inviteEmailText(companyName, roleLabel),
        headers: { 'X-NBD-Campaign': 'team-invite-v1' },
      });
      // Resend resolves { data: null, error } on an API-level rejection
      // instead of throwing — without this check emailStatus is 'sent' and
      // the comment below ("the dashboard's alert-health banner surfaces
      // failed:* statuses") never fires for exactly the failure it names.
      if (resendRejected(response)) {
        throw new Error(resendErrorMessage(response));
      }
      emailStatus = 'sent';
      await snap.ref.update({ inviteEmailSentAt: FieldValue.serverTimestamp() }).catch(() => {});
      logger.info('teamInviteEmail: sent', { companyId });
    } catch (e) {
      emailStatus = 'failed:' + String(e && e.message || e).slice(0, 200);
      logger.error('teamInviteEmail: send failed', { companyId, err: e.message });
    }
    // Ledger the attempt in alert_outbox (same seam as lead-alert.js
    // recordAlertOutbox): the dashboard's alert-health banner surfaces
    // 'failed:*' statuses to the owner — without this, a dead Resend key
    // means invites silently never arrive and nobody finds out. Best-effort:
    // an outbox write failure never blocks anything.
    try {
      await db.collection('alert_outbox').add({
        kind: 'team-invite',
        collection: `companies/${companyId}/members`,
        leadId: null,
        companyId,
        target: { emails: [to], sms: null, name: companyName, seal: '' },
        emailStatus,
        smsStatus: 'skipped:n/a',
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (e) {
      logger.warn('teamInviteEmail: outbox write failed', { companyId, err: e && e.message });
    }
  }
);

// ───────────────────────────────────────────────────────────────
// createTeamInvite — Pillar 4: invites move server-side so plan
// seat limits are enforceable. firestore.rules now denies client
// member CREATEs; the team tab calls this instead. The write shape
// matches the old client write exactly, so teamInviteEmail and
// claimInvite behave identically.
//
// Seat policy: (invited + active) member docs < PLAN_LIMITS[plan].reps.
// free/starter (reps:1) → no team invites; team (reps:2, $149/mo) → up
// to 2 reps; growth (reps:5) → up to 5 reps besides the owner (the
// generous reading of the landing copy "Growth allows up to 5 team
// reps"); enterprise → unlimited.
// ───────────────────────────────────────────────────────────────

// How many INVITED-REP seats a plan grants (besides the owner). reps:1 in
// the plan table means "solo — 1 user total" → 0 invite seats; reps:5
// means "up to 5 team reps" → 5 seats. Exported for unit tests.
function seatLimitForPlan(plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  if (limits.reps === Infinity) return Infinity;
  return limits.reps <= 1 ? 0 : limits.reps;
}

// Single source for the seat-cap refusal copy. BOTH throw sites (the fast
// pre-check and the authoritative in-transaction re-check) must call this so
// the two strings can never drift apart again — the duplicated ternary is
// exactly how the wrong "Growth plan" copy survived at the race-path site.
// The cheapest plan with ANY invite seats is Team ($149/mo, 2 seats) — see
// PLAN_LIMITS in billing.js — so the zero-seat refusal names Team, not
// Growth ($299).
function seatCapMessage(seats) {
  return seats === 0
    ? 'Team invites need the Team plan ($149/mo) or higher — your current plan is solo. Upgrade at /pro#pricing.'
    : `Your plan includes ${seats} team seat${seats === 1 ? '' : 's'} and they're all taken. Remove a member or upgrade to add more.`;
}

// Invite TTL (gauntlet batch 2): pending invites are claimable for 30 days
// — long enough for roofing's slow hiring reality (owners invite before a
// rep's start date), short enough that a company that abandoned a hire
// isn't holding a standing grant forever. Re-send refreshes the clock
// (delete+recreate stamps a new invitedAt). Expired invites also stop
// consuming a seat (see the occupied filter in createTeamInvite). Missing
// invitedAt (legacy docs) never expires. Exported for unit tests.
const INVITE_TTL_DAYS = 30;
function isInviteExpired(memberData, nowMs = Date.now()) {
  if (!memberData || memberData.status !== 'invited') return false;
  const ts = memberData.invitedAt;
  const ms = ts && typeof ts.toMillis === 'function' ? ts.toMillis()
    : (typeof ts === 'number' ? ts : null);
  if (ms === null) return false; // legacy invite without a timestamp — keep valid
  return (nowMs - ms) > INVITE_TTL_DAYS * 24 * 3600 * 1000;
}

exports.createTeamInvite = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    await callableRateLimit(request, 'createTeamInvite', 30, 3_600_000);
    // Owner (incl. solo companyId==uid convention) or platform admin only —
    // same gate the admin team-management callables use.
    const { uid, companyId, isGlobalAdmin } = await requireTeamAdmin(request);

    const email = String((request.data && request.data.email) || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpsError('invalid-argument', 'Enter a valid email address.');
    }
    const callerEmail = String(request.auth.token.email || '').toLowerCase();
    if (email === callerEmail) {
      throw new HttpsError('invalid-argument', "That's your own email — you already own this company.");
    }
    const role = String((request.data && request.data.role) || 'sales_rep');
    if (!INVITE_ALLOWED_ROLES.has(role)) {
      throw new HttpsError('invalid-argument', 'Role must be one of: company_admin, manager, sales_rep, viewer.');
    }

    const db = getFirestore();

    const coRef = db.doc(`companies/${companyId}`);
    const coSnap = await coRef.get();

    // Resolve the company's plan: subscription doc first (webhook-written
    // truth), company doc plan as fallback. Joe's owner accounts and
    // platform admins are never seat-gated.
    let plan = 'free';
    // Per-seat add-ons (Route 1): extra invited-rep seats bought as a Stripe
    // subscription-item quantity, persisted as purchasedSeats on the sub doc
    // by the webhook. Effective cap = seatLimitForPlan(plan) + purchasedSeats.
    // Only an ENTITLED sub's seats count — a lapsed sub's purchased seats die
    // with it (the plan fallback below already drops to the company doc/free).
    let purchasedSeats = 0;
    // Owner seat-cap bypass: claims-based (token.owner === true) with the
    // deprecated email fallback inside isOwnerCaller (remove fallback after
    // owner claims confirmed in prod).
    if (isGlobalAdmin || isOwnerCaller(request.auth.token)) {
      plan = 'enterprise';
    } else {
      const subSnap = await db.doc(`subscriptions/${companyId}`).get();
      const subData = subSnap.exists ? (subSnap.data() || {}) : {};
      // 'past_due' stays entitled for seat resolution: Stripe is still
      // auto-retrying the card (dunning), the subscription is not cancelled,
      // and without this a paying owner mid-dunning got seats=0 plus the
      // free-tier "your current plan is solo" copy — reads like data loss to
      // a customer whose card merely bounced (gauntlet gap). Hard removal
      // only happens on customer.subscription.deleted.
      const subActive = subData.status === 'active' || subData.status === 'trialing'
        || subData.status === 'past_due';
      if (subActive && subData.plan) {
        plan = subData.plan;
        purchasedSeats = Math.max(0, Number(subData.purchasedSeats) || 0);
      } else {
        plan = (coSnap.exists && (coSnap.data() || {}).plan) || 'free';
      }
    }

    // Infinity + n === Infinity, so enterprise stays uncapped.
    const seats = seatLimitForPlan(plan) + purchasedSeats;
    const membersSnap = await db.collection(`companies/${companyId}/members`).get();
    const occupied = membersSnap.docs.filter((m) => {
      const md = m.data() || {};
      // Expired pending invites free their seat automatically (30-day TTL)
      // — a stale invite no longer blocks inviting someone else.
      if (md.status === 'invited') return !isInviteExpired(md);
      return md.status === 'active';
    });
    const existing = membersSnap.docs.find((m) => m.id === email);
    const existingStatus = existing ? (existing.data() || {}).status : null;

    if (existingStatus === 'active') {
      return { invited: false, reason: 'already_member', seatsUsed: occupied.length, seatsLimit: seats === Infinity ? null : seats };
    }
    // CL6: a DEACTIVATED member's Auth account is disabled — re-inviting them
    // would write a fresh 'invited' row they can never claim (they can't sign
    // in), leaving a permanently-stuck invite consuming a seat. Send the owner
    // to the Re-enable action in that member's row instead.
    if (existingStatus === 'deactivated') {
      throw new HttpsError('failed-precondition',
        'That person is on your team but disabled. Use "Re-enable" in their row to restore access — no new invite needed.');
    }
    // Re-inviting a member re-uses their seat only when that seat is still
    // occupied. A re-invite reuses the seat ONLY for a NON-expired pending
    // invite — the same predicate the `occupied` filter uses (line 409). An
    // EXPIRED pending invite was already freed from `occupied`, so re-inviting
    // it must count as taking a fresh seat; crediting it 0 (as the old
    // `existingStatus === 'invited' ? 0` did) let a full-cap tenant recreate a
    // live invite one seat over the plan limit. (active/deactivated are handled
    // above, so by here existingStatus is null or 'invited'.)
    const reusesSeat = existingStatus === 'invited' && !isInviteExpired(existing.data());
    const seatsAfter = occupied.length + (reusesSeat ? 0 : 1);
    if (seats !== Infinity && seatsAfter > seats) {
      throw new HttpsError('resource-exhausted', seatCapMessage(seats));
    }

    // Solo owners may not have a companies/{uid} doc yet (pre-Phase-2
    // accounts) — create it so rules' ownerId checks and member listing
    // work. Never touch an EXISTING doc (the old client write clobbered
    // `name` with the rep's displayName on every invite).
    if (!coSnap.exists && companyId === uid) {
      await coRef.set({
        ownerId: uid,
        name: request.auth.token.name || 'My Company',
        status: 'active',
        plan: 'free',
        source: 'invite-ensure',
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    // Re-invite of a pending invite: delete + recreate so the
    // teamInviteEmail onDocumentCreated trigger fires again (resend).
    // CL5: the delete is now transaction-guarded so a claimInvite that flipped
    // this exact doc to 'active' in the window since our seat read can't be
    // silently clobbered back to 'invited' (which would DEMOTE a just-joined
    // teammate and re-consume their seat). Re-read inside the txn; abort if it
    // raced to active/deactivated. The recreate stays a separate set() so the
    // onDocumentCreated resend trigger fires.
    const memberRef = db.doc(`companies/${companyId}/members/${email}`);
    if (existing) {
      await db.runTransaction(async (tx) => {
        const cur = await tx.get(memberRef);
        const st = cur.exists ? (cur.data() || {}).status : null;
        if (st === 'active') {
          throw new HttpsError('failed-precondition', 'That person just joined your team — no invite needed.');
        }
        if (st === 'deactivated') {
          throw new HttpsError('failed-precondition',
            'That person is on your team but disabled. Use "Re-enable" in their row to restore access.');
        }
        tx.delete(memberRef);
      });
    }
    // Atomic seat-cap re-check + invite write. The pre-check above (line ~478)
    // is a fast fail; this transaction is the AUTHORITATIVE guard that closes
    // the TOCTOU where N concurrent invites for DIFFERENT emails each read the
    // same stale roster, all pass, and overshoot the paid cap. For a resend of a
    // LIVE invite (reusesSeat) the seat is already counted, so we skip the
    // re-check — otherwise a concurrent add in the delete→recreate window could
    // strand the resend. tx.set always CREATES here (the doc was deleted above
    // for a re-invite, or never existed), so teamInviteEmail's onDocumentCreated
    // still fires.
    await db.runTransaction(async (tx) => {
      if (!reusesSeat && seats !== Infinity) {
        const rosterSnap = await tx.get(db.collection(`companies/${companyId}/members`));
        const occ = rosterSnap.docs.filter((m) => {
          const md = m.data() || {};
          if (md.status === 'invited') return !isInviteExpired(md);
          return md.status === 'active';
        }).length;
        if (occ + 1 > seats) {
          throw new HttpsError('resource-exhausted', seatCapMessage(seats));
        }
      }
      tx.set(memberRef, {
        email,
        role,
        status: 'invited',
        invitedAt: FieldValue.serverTimestamp(),
        invitedBy: uid,
      });
    });

    logger.info('createTeamInvite: invited', { companyId, role, plan, seatsAfter });
    return {
      invited: true,
      resent: existingStatus === 'invited',
      seatsUsed: seatsAfter,
      seatsLimit: seats === Infinity ? null : seats,
    };
  }
);

// ═══════════════════════════════════════════════════════════════
// assignSeats — the over-capacity SEAT PICKER (owner/admin choice).
//
// When a tenant has more claimed reps than the plan's seat cap (a
// downgrade-on-return, or a future mid-tier plan), the lapse cron's
// automatic oldest-first restore is only the DEFAULT. This callable lets
// the owner/company_admin (the bill-payer) explicitly choose WHICH reps
// hold the limited seats: the chosen set is activated (Auth re-enabled),
// everyone else claimed is benched (Auth disabled), and the chosen count
// is hard-capped at seatLimitForPlan(plan). The OWNER and pending invites
// (no uid) are never touched. Benched members carry deactivatedReason
// 'seat-unassigned' — NOT 'lapse' — so a later checkout's
// reactivateLapsedSeats does not silently un-bench them (mirrors the
// owner-removed contract).
// ═══════════════════════════════════════════════════════════════
exports.assignSeats = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 30,
    memory: '256MiB',
  },
  async (request) => {
    await callableRateLimit(request, 'assignSeats', 30, 3_600_000);
    const { uid, companyId, isGlobalAdmin } = await requireTeamAdmin(request);

    const wantActive = new Set(
      (Array.isArray(request.data && request.data.activeEmails) ? request.data.activeEmails : [])
        .map((e) => String(e || '').trim().toLowerCase()).filter(Boolean),
    );

    const db = getFirestore();
    const coSnap = await db.doc(`companies/${companyId}`).get();
    const ownerId = coSnap.exists ? (coSnap.data() || {}).ownerId : null;

    // Plan resolution — identical to createTeamInvite (subscription truth,
    // company-doc fallback; owner/global-admin are enterprise/uncapped;
    // purchasedSeats widens the cap only while the sub is entitled).
    let plan = 'free';
    let purchasedSeats = 0;
    if (isGlobalAdmin || isOwnerCaller(request.auth.token)) {
      plan = 'enterprise';
    } else {
      const subData = (await db.doc(`subscriptions/${companyId}`).get()).data() || {};
      const subActive = subData.status === 'active' || subData.status === 'trialing'
        || subData.status === 'past_due';
      if (subActive && subData.plan) {
        plan = subData.plan;
        purchasedSeats = Math.max(0, Number(subData.purchasedSeats) || 0);
      } else {
        plan = (coSnap.exists && (coSnap.data() || {}).plan) || 'free';
      }
    }
    const cap = seatLimitForPlan(plan) + purchasedSeats;

    // Only CLAIMED members (have a uid, not the owner) hold seats. Cap the
    // chosen-active count at the plan limit before writing anything.
    const membersSnap = await db.collection(`companies/${companyId}/members`).get();
    const claimed = membersSnap.docs.filter((m) => {
      const md = m.data() || {}; return md.uid && md.uid !== ownerId;
    });
    const targetActive = claimed.filter((m) => wantActive.has(m.id));
    if (cap !== Infinity && targetActive.length > cap) {
      throw new HttpsError('resource-exhausted',
        `Your ${plan} plan includes ${cap} team seat${cap === 1 ? '' : 's'}; you selected `
        + `${targetActive.length}. Deselect ${targetActive.length - cap} rep${targetActive.length - cap === 1 ? '' : 's'} or upgrade to add more.`);
    }

    let activated = 0, benched = 0;
    for (const m of claimed) {
      const md = m.data() || {};
      const shouldBeActive = wantActive.has(m.id);
      if (shouldBeActive && md.status !== 'active') {
        try {
          await getAuth().updateUser(md.uid, { disabled: false });
          await m.ref.set({
            status: 'active', active: true,
            deactivatedAt: null, deactivatedBy: null, deactivatedReason: null,
            reactivatedAt: FieldValue.serverTimestamp(), reactivatedBy: 'seat-assign',
          }, { merge: true });
          activated++;
        } catch (e) { logger.warn('assignSeats.activate_failed', { companyId, member: m.id, err: e.message }); }
      } else if (!shouldBeActive && md.status === 'active') {
        try {
          await getAuth().updateUser(md.uid, { disabled: true });
          await getAuth().revokeRefreshTokens(md.uid);
          await m.ref.set({
            status: 'deactivated', active: false,
            deactivatedAt: FieldValue.serverTimestamp(),
            deactivatedBy: uid, deactivatedReason: 'seat-unassigned',
          }, { merge: true });
          benched++;
        } catch (e) { logger.warn('assignSeats.bench_failed', { companyId, member: m.id, err: e.message }); }
      }
    }

    logger.info('assignSeats.applied', { companyId, plan, cap: cap === Infinity ? 'inf' : cap, activated, benched });
    return {
      ok: true, plan,
      seatsUsed: targetActive.length,
      seatsLimit: cap === Infinity ? null : cap,
      activated, benched,
    };
  },
);

exports._test = { resolveInviteRole, inviteEmailHtml, inviteEmailText, seatLimitForPlan, isInviteExpired, INVITE_TTL_DAYS };

// Single source of truth for the plan→seat helpers so the parallel member-add
// path (handlers/admin.js createTeamMember) enforces the IDENTICAL cap instead
// of a drifting copy. index.js cherry-picks the callable exports, so these
// extra named exports never register as functions.
exports.seatLimitForPlan = seatLimitForPlan;
exports.isInviteExpired = isInviteExpired;
