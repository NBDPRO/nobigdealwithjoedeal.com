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

// ─────────────────────────────────────────────────────────────────────────
// 2026-10-08 (review R3 item 3) — ONE token check for every homeowner-portal
// endpoint.
//
// Only getHomeownerPortalView checked the whole link: expiry, the replay cap
// (uses >= maxUses) and the lead match (tokenMatchesLead). Six others —
// getPortalDocumentHtml, uploadHomeownerPhoto, requestCallback,
// reportWarrantyClaim, submitCustomerRating, sendPortalMessage — checked
// expiry alone, so a used-up link, or an old tenant's link to a lead id that
// another tenant has since re-created, kept opening documents and writing
// photos, tasks, claims, ratings and messages. Each endpoint wrote its own
// copy of the check; these two functions are now the only copy.
// ─────────────────────────────────────────────────────────────────────────

const DEAD_LINK = { status: 410, code: 'expired', error: 'This link has expired. Contact your rep for a new one.' };

/**
 * Token-only half (no lead read needed — lets an endpoint refuse a dead link
 * before it spends reads). Revocation moves expiresAt into the past AND stamps
 * revokedAt; either alone refuses.
 *
 * @param {object|null} tok   portal_tokens/{token} data (null = no such doc)
 * @param {number}      nowMs
 * @returns {null|{status:number, code:string, error:string}} null = allowed
 */
function portalTokenRefusal(tok, nowMs) {
  if (!tok || typeof tok.leadId !== 'string' || !tok.leadId || tok.leadId.includes('/')) {
    return { status: 404, code: 'unknown_link', error: 'Invalid link' };
  }
  const exp = tok.expiresAt && typeof tok.expiresAt.toMillis === 'function' ? tok.expiresAt.toMillis() : null;
  if (tok.revokedAt || (exp !== null && exp < nowMs)) return Object.assign({}, DEAD_LINK);
  if (typeof tok.maxUses === 'number' && (Number(tok.uses) || 0) >= tok.maxUses) {
    return { status: 429, code: 'too_many_opens', error: 'This link has been opened too many times. Ask your rep for a fresh one.' };
  }
  return null;
}

/**
 * The full check: the token half, then the lead it names must exist and be
 * held by the tenant the token was minted for (tokenMatchesLead).
 *
 * @param {object|null} tok
 * @param {object|null} lead  leads/{tok.leadId} data (null = no such doc)
 * @param {number}      nowMs
 * @returns {null|{status:number, code:string, error:string}}
 */
function portalLinkRefusal(tok, lead, nowMs) {
  const t = portalTokenRefusal(tok, nowMs);
  if (t) return t;
  if (!lead || !tokenMatchesLead(tok, lead)) {
    return { status: 404, code: 'project_missing', error: 'Project not found' };
  }
  return null;
}

/**
 * Does this getHomeownerPortalView request spend one of the link's uses?
 *
 * The page polls every 30s while the tab is in front, and a poll used to be
 * free on the client's say-so (`poll: true`) — which also skipped the cap
 * check, so a used-up link stayed readable forever by polling, and any caller
 * could read without ever spending a use. Now every request is cap-checked,
 * and a poll is free only inside a session: within POLL_SESSION_MS of the
 * last counted open (tok.lastOpenAt). A tab left open overnight, or a
 * `poll: true` sent with no recent open, spends one use and starts a new
 * session. So an open tab costs at most one use per 12 hours (polls inside a
 * session stay free, as before), and polling alone can no longer read a link
 * without spending its budget.
 */
const POLL_SESSION_MS = 12 * 60 * 60 * 1000;
function viewCountsAsOpen(tok, isPoll, nowMs) {
  if (!isPoll) return true;
  const t = tok && tok.lastOpenAt;
  const last = t && typeof t.toMillis === 'function' ? t.toMillis() : null;
  return last === null || nowMs - last > POLL_SESSION_MS || last > nowMs + 60_000;
}

module.exports = {
  canManageLead, portalTenant, recordInPortalTenant, tokenMatchesLead,
  portalTokenRefusal, portalLinkRefusal, viewCountsAsOpen, POLL_SESSION_MS,
};
