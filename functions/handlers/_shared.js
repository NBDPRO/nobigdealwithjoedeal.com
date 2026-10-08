/**
 * functions/handlers/_shared.js — constants + helpers shared by the
 * inline-handler files extracted from index.js (Step 4c).
 *
 * Re-exports the constants every handler used to read from the top of
 * index.js (CORS_ORIGINS, Claude budget caps, Anthropic model allow-
 * list) plus the helper functions that were too small to deserve their
 * own module but get consumed by multiple handler files
 * (estimateInputTokens, reserveClaudeBudget, adjustClaudeBudget,
 * reverseGeocode, parseAddress, _generateE2EPassword,
 * requireTeamAdmin, normalizeRole, normalizeEmail, INVITE_ALLOWED_ROLES,
 * TEAM_ROLES, OWNER_EMAILS, isOwnerCaller, E2E_TEST_USER_EMAIL,
 * LEGACY_ACCESS_CODES).
 *
 * Imports nothing from ../index.js (no circular dep).
 */

'use strict';

const { getFirestore } = require('firebase-admin/firestore');
const { FieldValue } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');

// ── CORS origins — exact match, no startsWith, no wildcards. ─────────
const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ── Anthropic model allowlist — Opus removed; too expensive. ─────────
// 2026-10-04: claude-sonnet-4-20250514 is deprecated — removed; Sonnet 5.5
// replaces it (claudeProxy turns its thinking off and drops sampling params,
// which Sonnet 5.5 rejects — see handlers/ai.js shapeForModel).
const ALLOWED_CLAUDE_MODELS = new Set([
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5-5',
]);
const CLAUDE_MAX_TOKENS_CAP = 1024;
const CLAUDE_DAILY_TOKEN_BUDGET = 200000; // per uid per calendar day
// Per-minute claude ceiling moved to rate-limit-policy.js ROUTES.claudeProxy
// (uidLimit: 20) when the guardHttp wrapper took over enforcement, 2026-08-10.
// M-03 / blueprint placeholder — see header in original index.js.
const CLAUDE_COMPANY_BUDGET = {
  lite:          10_000,
  foundation:    50_000,
  starter:       50_000,
  blueprint:    120_000,
  // Team ($149/mo, 2 reps) had no row here, so it fell through to
  // CLAUDE_COMPANY_BUDGET_DEFAULT (10_000) -- the FREE-tier allowance --
  // silently below Starter's own 50_000. Interpolated between Starter
  // and Growth pending a real usage-based number; not a marketed figure.
  team:         100_000,
  growth:       250_000,
  professional: 1_000_000
};
const CLAUDE_COMPANY_BUDGET_DEFAULT = 10_000;
const CLAUDE_RESERVATION_MAX = 4 * CLAUDE_MAX_TOKENS_CAP;
const CLAUDE_MAX_MESSAGES      = 40;
const CLAUDE_MAX_PAYLOAD_BYTES = 200_000;

// ── Claude budget helpers (used by handlers/ai.js → claudeProxy) ─────
function estimateInputTokens(messages, system) {
  let chars = 0;
  try { chars += JSON.stringify(messages || []).length; } catch (_) {}
  if (typeof system === 'string') chars += system.length;
  return Math.ceil(chars / 4);
}

async function reserveClaudeBudget(db, uidRef, coRef, reservation, caps) {
  return db.runTransaction(async (tx) => {
    const [u, c] = await Promise.all([tx.get(uidRef), tx.get(coRef)]);
    const uConsumed = (u.exists && u.data().tokens) || 0;
    const cConsumed = (c.exists && c.data().tokens) || 0;
    if (!caps.isAdmin && uConsumed + reservation > caps.uidCap) {
      return { ok: false, scope: 'uid', consumed: uConsumed, cap: caps.uidCap };
    }
    if (!caps.isAdmin && cConsumed + reservation > caps.coCap) {
      return { ok: false, scope: 'company', consumed: cConsumed, cap: caps.coCap };
    }
    const srv = FieldValue.serverTimestamp();
    const inc = FieldValue.increment(reservation);
    tx.set(uidRef, {
      tokens: inc, updatedAt: srv,
      uid: caps.uid, dayKey: caps.dayKey, scope: 'uid'
    }, { merge: true });
    tx.set(coRef, {
      tokens: inc, updatedAt: srv,
      companyId: caps.companyId, dayKey: caps.dayKey, scope: 'company'
    }, { merge: true });
    return { ok: true };
  });
}

async function adjustClaudeBudget(uidRef, coRef, delta) {
  if (!delta) return;
  const inc = FieldValue.increment(delta);
  await Promise.all([
    uidRef.set({ tokens: inc }, { merge: true }),
    coRef.set({ tokens: inc }, { merge: true })
  ]);
}

// ── Geocoding helpers (used by handlers/migrations.js → backfillAnalytics) ─
async function reverseGeocode(lat, lng, apiKey) {
  const url = 'https://maps.googleapis.com/maps/api/geocode/json?latlng=' + lat + ',' + lng + '&key=' + apiKey;
  const response = await fetch(url);
  if (!response.ok) return null;
  const data = await response.json();
  if (data.status !== 'OK' || !data.results || !data.results.length) return null;
  const components = data.results[0].address_components || [];
  const result = {};
  for (const c of components) {
    if (c.types.includes('locality')) result.city = c.long_name;
    else if (c.types.includes('administrative_area_level_1')) result.state = c.short_name;
    else if (c.types.includes('postal_code')) result.zip = c.long_name;
  }
  return result;
}

function parseAddress(addr) {
  if (!addr || typeof addr !== 'string') return {};
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return {};
  const result = {};
  // Last part: "OH 45202" or "45202"
  const last = parts[parts.length - 1];
  const zipMatch = last.match(/\b(\d{5}(?:-\d{4})?)\b/);
  if (zipMatch) result.zip = zipMatch[1];
  const stateMatch = last.match(/\b([A-Z]{2})\b/);
  if (stateMatch) result.state = stateMatch[1];
  if (parts.length >= 2) {
    result.city = parts[parts.length - 2];
  }
  return result;
}

// ── E2E test helpers (used by handlers/auth.js → provisionE2ETestUser) ─
const E2E_TEST_USER_EMAIL = 'playwright-e2e@nobigdealwithjoedeal.com';

// ── Owner (root) accounts — THE single server-side email list ────────
// This is the ONLY place in functions/ where the owner emails may be
// written down. It exists for exactly one purpose: MINTING the
// { owner: true, role: 'admin' } custom claims via mintOwnerClaims in
// handlers/auth.js (a deployed onCall — the blocking auth triggers are
// NOT deployable: onRepSignup is in NBD_DEPLOY_SKIP_LIST and
// beforeUserSignedIn was never exported; see .github/workflows/
// firebase-deploy.yml + handlers/auth.js Q3 header).
//
// It is NOT a per-request authorization list. Server authorization must
// key on `request.auth.token.owner === true` (the minted claim). During
// the claims rollout, isOwnerCaller() below still falls back to this
// list so Jo can never be locked out before the claim has been minted —
// that fallback is DEPRECATED: remove it (make isOwnerCaller claim-only)
// after owner claims are confirmed in prod (sign in with both accounts,
// verify getIdTokenResult().claims.owner === true).
//
// Entries MUST be lowercase; compare against a lowercased caller email.
// Was previously named PROVISION_OWNER_EMAILS (E2E-provision gate only).
const OWNER_EMAILS = new Set([
  'jd@nobigdealwithjoedeal.com',
  'jonathandeal459@gmail.com'
]);

// Transition-period owner check for callables. Claim first — the email
// fallback is DEPRECATED (remove after owner claims confirmed in prod;
// see OWNER_EMAILS comment above).
function isOwnerCaller(token) {
  if (!token) return false;
  if (token.owner === true) return true;
  // The email fallback trusts the address only once Google has VERIFIED it
  // (security checklist 2026-10-01). Self-registration is open, and one of
  // the OWNER_EMAILS had no Firebase account: anyone could sign up with it,
  // unverified, and pass this check (unmatched-SMS inbox, uncapped seats,
  // usage-cap bypass, the E2E password). Jo's real account carries the
  // owner claim, so the line above still admits it.
  if (token.email_verified !== true) return false;
  const email = typeof token.email === 'string' ? token.email.trim().toLowerCase() : '';
  return !!email && OWNER_EMAILS.has(email);
}

function _generateE2EPassword() {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@$%';
  const crypto = require('crypto');
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// ── Invite/Team role constants ───────────────────────────────────────
// Role taxonomy — platform-wide allowlist. The `admin` role is PLATFORM
// admin and is reserved for support/ops — it grants cross-tenant reads via
// Firestore rules. Tenant-scoped admins use `company_admin`, which is
// bounded to their own `companyId` claim. Nothing below platform admin
// should ever be settable through the invite flow.
const INVITE_ALLOWED_ROLES = new Set(['company_admin', 'manager', 'sales_rep', 'viewer']);

// Tenant-scoped roles. `admin` (platform-global) is deliberately NOT in
// this list — granting it requires manual admin SDK script, never a UI
// path. Tenant admins use `company_admin`, which owns the company but
// cannot read other tenants' data.
const TEAM_ROLES = ['company_admin', 'manager', 'sales_rep', 'viewer'];

// Roles that sit BELOW owner/company-admin. A caller bearing one of these
// is, by definition, a subordinate member of someone else's company — never
// a company owner. Legitimate team members always carry a `companyId` claim
// (createTeamMember / updateUserRole stamp it); access-code logins
// (handlers/portal.js validateAccessCode) mint a bare { role } claim with NO
// companyId. requireTeamAdmin uses this set to reject the latter before its
// solo-owner fallback can mistake them for the owner of companies/{uid}.
// `member` is the access-code-only role (not in TEAM_ROLES) and is included
// here explicitly. `company_admin`/`admin` are deliberately absent.
const SUBORDINATE_ROLES = new Set(['member', 'manager', 'sales_rep', 'viewer']);

// Legacy access codes (handlers/admin.js → rotateAccessCodes)
const LEGACY_ACCESS_CODES = [
  'NBD-2026', 'NBD-DEMO', 'DEMO', 'TRYIT',
  'DEAL-2026', 'ROOFCON26', 'NBD-STORM'
];

// ── Team-admin helpers (used by handlers/admin.js callables) ─────────
// Post-read authority decision, extracted pure so tests can hit the whole
// matrix without Firestore (audit 2026-08-02 medium). The old inline check
// accepted ONLY companies.ownerId — an invited second company_admin (claims
// { companyId, role: 'company_admin' }, server-minted by handlers/admin.js /
// provisioning.js) was refused everywhere the client nav says they can go.
// `ownerOnly: true` preserves the deliberate owner-only carve-outs (seat
// money is the bill-payer's call alone — handlers/seats.js).
function teamAdminDecision({ uid, claims, companyId, ownerId, companyExists, ownerOnly = false }) {
  const c = claims || {};
  const isGlobalAdmin = c.role === 'admin';
  const isOwner = ownerId === uid || (!companyExists && companyId === uid);
  const isCompanyAdmin = !ownerOnly
    && c.role === 'company_admin'
    && !!c.companyId && c.companyId === companyId;
  return { allow: !!(isGlobalAdmin || isOwner || isCompanyAdmin), isOwner, isGlobalAdmin };
}

// Resolve the caller's company and confirm they can manage it.
// Returns { uid, companyId, isOwner, isGlobalAdmin } or throws HttpsError.
// opts.ownerOnly: refuse non-owner company_admins (money-path carve-out).
async function requireTeamAdmin(request, targetCompanyId = null, opts = null) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

  const claims = request.auth.token || {};
  const isGlobalAdmin = claims.role === 'admin';

  // SECURITY: a caller carrying a subordinate role (member/manager/sales_rep/
  // viewer) WITHOUT a companyId claim is an access-code / invited user, never
  // a company owner. Without this guard the solo-owner fallback below keys a
  // phantom company on their uid (companies/{uid} doesn't exist → isOwner
  // true), letting them pass requireTeamAdmin and drive createTeamMember /
  // updateUserRole / deactivateUser — provisioning team members and
  // self-escalating to company_admin. Legitimate solo owners carry NO role
  // claim; company_admins always carry a companyId. Reject before any
  // Firestore read. Mirrors the client-side solo-owner gate in
  // docs/pro/js/admin-manager.js.
  const callerRole = typeof claims.role === 'string' ? claims.role.trim().toLowerCase() : '';
  if (!isGlobalAdmin && !claims.companyId && SUBORDINATE_ROLES.has(callerRole)) {
    throw new HttpsError('permission-denied', 'Owner or admin access required');
  }

  // Solo operators own a company keyed by their uid. Team members carry a
  // companyId claim set by onRepSignup. Fall back to uid for solo owners.
  const callerCompanyId = claims.companyId || uid;
  const companyId = targetCompanyId || callerCompanyId;

  // Cross-company ops are admin-only.
  if (!isGlobalAdmin && companyId !== callerCompanyId) {
    throw new HttpsError('permission-denied', 'Cannot manage another company');
  }

  // Verify authority against the company doc if one exists: owner, global
  // admin, or (unless opts.ownerOnly) a company_admin of THIS company.
  const db = getFirestore();
  const companyRef = db.doc(`companies/${companyId}`);
  const companySnap = await companyRef.get();
  const ownerId = companySnap.exists ? (companySnap.data().ownerId || null) : null;
  const { allow, isOwner } = teamAdminDecision({
    uid, claims, companyId, ownerId,
    companyExists: companySnap.exists,
    ownerOnly: !!(opts && opts.ownerOnly),
  });

  if (!allow) {
    // Managers can list their team but not mutate — the caller gates mutations.
    throw new HttpsError('permission-denied', 'Owner or admin access required');
  }

  return { uid, companyId, isOwner, isGlobalAdmin, companyRef };
}

// Decide whether a team-admin caller may MUTATE a given target user (set role,
// disable, adopt). The cross-company guards in createTeamMember / updateUserRole
// / deactivateUser used to gate on `targetClaims.companyId && targetClaims.companyId
// !== companyId`, which FAILS OPEN when the target has no companyId — letting a
// legitimate company_admin of company A re-role / disable / adopt ANY no-companyId
// account (self-signup solo owners, access-code members) across tenant boundaries.
// Fail CLOSED instead: a target is mutable only if the caller is a global admin,
// OR the target was just created in this call (a brand-new invitee with no prior
// tenant), OR the target's own companyId claim already equals the caller's company.
// An absent/null target companyId is treated as "not mine" → not mutable.
//
// A PLATFORM admin (role 'admin') is never manageable by anyone but another
// platform admin, even when they carry this tenant's companyId (R3-9, Jo
// 2026-10-06): a second company_admin re-roling Jo would strip 'admin'.
function callerMayManageTarget(targetClaims, companyId, isGlobalAdmin, justCreated = false) {
  if (isGlobalAdmin) return true;
  if (justCreated) return true;
  if (targetClaims && targetClaims.role === 'admin') return false;
  return !!companyId && (targetClaims && targetClaims.companyId) === companyId;
}

// The accounts a company_admin may not change (R3-9): a platform admin
// (only another platform admin may), and the company OWNER (only the owner
// themself, or a platform admin). Used by updateUserRole / deactivateUser /
// removeMember before they touch the target's claims or Auth account.
// Returns null, or the refusal message.
function protectedTargetRefusal({ targetUid, targetClaims, ownerId, callerIsOwner, isGlobalAdmin }) {
  if (isGlobalAdmin) return null;
  if (targetClaims && targetClaims.role === 'admin') return 'Only a platform admin can change a platform admin account';
  if (ownerId && targetUid === ownerId && !callerIsOwner) return "Only the owner can change the owner's account";
  return null;
}

// Platform admin role is NEVER grantable through this function — not
// even by another platform admin. It is a manual admin-SDK script
// operation so it leaves a clear paper trail and cannot be triggered
// through a compromised browser session. The UI picker only offers
// the four tenant-scoped roles.
function normalizeRole(role) {
  if (typeof role !== 'string') return null;
  const r = role.trim().toLowerCase();
  if (r === 'admin') return null;  // platform admin — blocked here
  if (!TEAM_ROLES.includes(r)) return null;
  return r;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  if (!e.includes('@') || e.length < 5 || e.length > 200) return null;
  return e;
}

module.exports = {
  // CORS
  CORS_ORIGINS,
  // Anthropic / Claude
  ALLOWED_CLAUDE_MODELS,
  CLAUDE_MAX_TOKENS_CAP,
  CLAUDE_DAILY_TOKEN_BUDGET,
  CLAUDE_COMPANY_BUDGET,
  CLAUDE_COMPANY_BUDGET_DEFAULT,
  CLAUDE_RESERVATION_MAX,
  CLAUDE_MAX_MESSAGES,
  CLAUDE_MAX_PAYLOAD_BYTES,
  estimateInputTokens,
  reserveClaudeBudget,
  adjustClaudeBudget,
  // Geocoding
  reverseGeocode,
  parseAddress,
  // E2E test
  E2E_TEST_USER_EMAIL,
  // Owner-role (claims-based root; email list only mints claims)
  OWNER_EMAILS,
  isOwnerCaller,
  _generateE2EPassword,
  // Invite/Team
  INVITE_ALLOWED_ROLES,
  TEAM_ROLES,
  SUBORDINATE_ROLES,
  LEGACY_ACCESS_CODES,
  requireTeamAdmin,
  teamAdminDecision,
  callerMayManageTarget,
  protectedTargetRefusal,
  normalizeRole,
  normalizeEmail,
};
