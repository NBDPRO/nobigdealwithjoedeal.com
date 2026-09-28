/**
 * portal-authz.js — pure authority check for portal-link mint/revoke
 * (audit 2026-08-02 medium). Dependency-free (no firebase) so
 * tests/smoke/portal.test.js can require() it directly and portal.js shares
 * the exact same code path — no logic mirror to drift (pattern:
 * inbound-sms-route-logic.js).
 *
 * WHY: the old gate accepted only `role === 'admin'` — the PLATFORM role —
 * so a tenant owner could not revoke a departed rep's portal link; the call
 * "succeeded" with revoked: 0 and the homeowner link stayed live.
 *
 * Who may mint/revoke portal links for a lead:
 *   - platform admin (role === 'admin')
 *   - the owning rep (lead.userId === uid)
 *   - a company_admin of the LEAD's tenant (claims.companyId ===
 *     lead.companyId, both present)
 *
 * Claims are server-minted only (handlers/provisioning.js,
 * handlers/admin.js), so the role+companyId pair is trustworthy. Fail-closed:
 * a missing companyId on EITHER side refuses — ownership gates key on
 * companyId, never brand strings or truthy fallbacks.
 */
'use strict';

function canManageLead(claims, uid, lead) {
  if (!claims || !uid || !lead) return false;
  if (claims.role === 'admin') return true;                 // platform admin
  if (lead.userId === uid) return true;                     // owning rep
  return claims.role === 'company_admin'
    && !!claims.companyId && !!lead.companyId
    && claims.companyId === lead.companyId;                 // tenant admin
}

// ─────────────────────────────────────────────────────────────────────────
// 2026-09-25 (review of PR #1777) — portal reads scoped to the TENANT, not
// just the lead id.
//
// getHomeownerPortalView found a lead's estimates, esign envelopes and
// invoices with `where('leadId', '==', tok.leadId)` and nothing else. Those
// are top-level collections that a lead hard-delete never removes (financial
// and executed-contract records), and a lead id can be re-created by anyone:
// a signed-in user of another tenant who created leads/{sameId} passed
// canManageLead on it, minted a portal token, and the portal view handed them
// the old tenant's latest shared estimate (total, tier, signed-document URL),
// its unpaid invoice with the Stripe link, and a fresh signed URL to its
// completed e-sign PDF. Reproduced on the emulator. The same query also let
// any user write an estimate or invoice with a victim's LIVE lead id (neither
// create rule checks leadId) and have it shown to the victim's homeowner as
// the rep's own, Stripe link included.
//
// So every such record must also belong to the token's tenant.
// ─────────────────────────────────────────────────────────────────────────

const str = (v) => (typeof v === 'string' ? v : '');

/**
 * The tenant a portal token speaks for: the lead's companyId (the token's
 * own, minted from the lead, when the lead has none), and the uids of the
 * lead's owner and the token's minted owner.
 *
 * @param {object} tok  portal_tokens/{token} data
 * @param {object} lead leads/{id} data
 * @returns {{companyId: string, uids: Set<string>}}
 */
function portalTenant(tok, lead) {
  const t = tok || {};
  const l = lead || {};
  return {
    companyId: str(l.companyId) || str(t.companyId),
    uids: new Set([str(l.userId), str(t.ownerUid)].filter(Boolean)),
  };
}

/**
 * Does a lead-keyed top-level record belong to the portal's tenant?
 * A record that carries a companyId must carry THIS one. One without (legacy
 * estimates; companyId is optional on them) must be owned, through one of
 * `uidFields`, by the lead's owner or the token's owner. Fails closed.
 *
 * @param {object}   rec       e.g. an estimates/{id} doc's data
 * @param {string[]} uidFields owner fields of that collection: estimates
 *                   ['userId'], invoices ['createdBy'], esign_envelopes ['ownerUid']
 * @param {{companyId: string, uids: Set<string>}} tenant portalTenant()
 * @returns {boolean}
 */
function recordInPortalTenant(rec, uidFields, tenant) {
  if (!rec || !tenant) return false;
  const cid = str(rec.companyId);
  if (cid) return !!tenant.companyId && cid === tenant.companyId;
  return (uidFields || []).some((f) => !!str(rec[f]) && tenant.uids.has(rec[f]));
}

/**
 * Was this token minted for the tenant that holds the lead NOW? A token for a
 * hard-deleted lead is revoked by onLeadDeleted, but only once it runs; a lead
 * re-created at the same id by another tenant in that window must not open
 * through the old tenant's link. A token or lead without a companyId (legacy)
 * cannot tell, and keeps the old behaviour.
 *
 * @returns {boolean}
 */
function tokenMatchesLead(tok, lead) {
  const tc = str((tok || {}).companyId);
  const lc = str((lead || {}).companyId);
  if (tc && lc) return tc === lc;
  return true;
}

module.exports = { canManageLead, portalTenant, recordInPortalTenant, tokenMatchesLead };
