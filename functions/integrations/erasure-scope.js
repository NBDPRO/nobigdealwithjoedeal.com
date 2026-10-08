/**
 * integrations/erasure-scope.js — who is asking to be erased, and what an
 * erasure may touch (Jo's ruling 2026-10-08, review r3 item 1).
 *
 * THE BUG
 *   confirmAccountErasure deleted every lead, estimate, invoice... carrying
 *   the erasing user's uid, with no company check. A team member's records
 *   are the COMPANY's customers (they carry the member's uid only as the
 *   author), so a rep who left and asked to be erased wiped every customer
 *   they had ever entered.
 *
 * JO'S RULE
 *   "If it's a team member, save all their info, just remove their own
 *   access or ability to reconnect or reactivate their account. Leave it
 *   suspended but optional for owner or leader to turn back on."
 *
 * So an erasure request resolves to one of three modes:
 *   - 'member'           someone on another person's company. Nothing is
 *                        deleted. The account is SUSPENDED: Auth disabled,
 *                        sessions revoked, bot keys + calendar feeds turned
 *                        off, roster row 'deactivated' with reason
 *                        'self-erasure'. The companyId claim is KEPT, so the
 *                        owner or a company_admin can turn them back on with
 *                        the existing Re-enable (deactivateUser reactivate),
 *                        which requires that claim. 'self-erasure' is not
 *                        'lapse', so a re-checkout never restores them on its
 *                        own.
 *   - 'solo'             the owner of their own company with nobody else on
 *                        it: the old erasure, but every doc is checked against
 *                        the tenant (belongsToOtherTenant) so a record that
 *                        carries their uid inside ANOTHER company is kept.
 *   - 'owner_with_team'  an owner whose company still has other members.
 *                        Erasing them would delete the customers the team
 *                        works from, so it is refused with nothing changed.
 *
 * Pure of firebase-admin at load time; db / auth are injected so the suite
 * (tests/member-erasure-suspend-2026-10-08.test.js) drives it with fakes.
 */
'use strict';

const SUSPEND_REASON = 'self-erasure';
const OUTCOME_NOTE = 'Team member: account suspended, company data retained. '
  + 'The company owner or an admin can turn it back on.';
const SUSPEND_MESSAGE = 'Your account is suspended. Because you are on a team, the customer '
  + 'records you worked on stay with your company, and so does your account information. '
  + 'You can no longer sign in. Only your company owner or an admin can turn the account back on.';
const OWNER_WITH_TEAM_MESSAGE = 'You own a company that still has other team members, so your '
  + 'account cannot be deleted from here: deleting it would delete the customers your team works '
  + 'from. Hand the company to another admin first (Team screen, "Make owner"): after that you are '
  + 'a team member and closing your account suspends it instead. Or remove your team members, or '
  + 'contact support. Nothing has been deleted.';

function cleanId(v) {
  return typeof v === 'string' && v && v.indexOf('/') === -1 ? v : null;
}

/**
 * Resolve the erasure mode for `uid`. Throws on any read failure: the caller
 * must refuse rather than guess (a guess of 'solo' is the delete-everything
 * branch).
 * Returns { mode, companyId, ownerId, email, role, teamSize }.
 */
async function resolveErasureScope({ db, auth, uid }) {
  if (!cleanId(uid)) throw new Error('resolveErasureScope: bad uid');
  let rec = null;
  try {
    rec = await auth.getUser(uid);
  } catch (e) {
    if (!(e && e.code === 'auth/user-not-found')) throw e;
  }
  const claims = (rec && rec.customClaims) || {};
  let companyId = cleanId(claims.companyId);
  if (!companyId && !rec) {
    // No Auth account left to read claims from: fall back to the profile doc,
    // so an account deleted out from under a retry still resolves its tenant.
    const u = await db.doc('users/' + uid).get();
    companyId = cleanId(u.exists ? (u.data() || {}).companyId : null);
  }
  companyId = companyId || uid;
  const email = rec && typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : null;
  const role = typeof claims.role === 'string' ? claims.role : null;

  const coSnap = await db.doc('companies/' + companyId).get();
  const ownerId = coSnap.exists ? (cleanId((coSnap.data() || {}).ownerId)) : null;
  const isOwner = ownerId ? ownerId === uid : companyId === uid;
  if (!isOwner) {
    return { mode: 'member', companyId, ownerId, email, role, teamSize: null };
  }
  // An owner: does anyone else hold a place on this company? Any roster row
  // with a uid counts, whatever its status: createTeamMember stamps claims on
  // a row that still says 'invited', and a deactivated member is still on the
  // team. Only a pending invite with no account (no uid) does not. Then a
  // second net for a member holding the companyId with no roster row at all:
  // their users/{uid} profile names the company (claimInvite /
  // activateInvitedRep write it). A profile alone is not proof: removeMember
  // strips the claim but leaves the profile's companyId behind, so each one is
  // confirmed against the person's Auth claim before it counts.
  const roster = await db.collection('companies/' + companyId + '/members').get();
  const others = new Set();
  (roster.docs || []).forEach((d) => {
    const m = (d.data && d.data()) || {};
    if (typeof m.uid === 'string' && m.uid && m.uid !== uid) others.add(m.uid);
  });
  if (!others.size) {
    const profiles = await db.collection('users').where('companyId', '==', companyId).limit(50).get();
    for (const p of (profiles.docs || [])) {
      if (!p.id || p.id === uid || others.has(p.id)) continue;
      let r = null;
      try { r = await auth.getUser(p.id); } catch (e) {
        if (!(e && e.code === 'auth/user-not-found')) throw e;
      }
      const cc = r && r.customClaims && r.customClaims.companyId;
      if (cc === companyId) { others.add(p.id); break; }
    }
  }
  if (others.size) return { mode: 'owner_with_team', companyId, ownerId, email, role, teamSize: others.size };
  return { mode: 'solo', companyId, ownerId, email, role, teamSize: 0 };
}

/**
 * Solo erasure guard: true when a doc that carries the erasing user's uid
 * belongs to a DIFFERENT company (kept, never deleted). Evidence mirrors
 * member-offboarding.js inCompany: the doc's own companyId, else the
 * companyId of the lead it points at (leadId field, or its parent lead for a
 * leads/{id}/<sub>/{doc} path). No evidence = the user's own = erasable.
 * `leadCompanyOf(leadId)` returns that lead's companyId or null.
 */
async function belongsToOtherTenant(data, docPath, ownCompany, leadCompanyOf) {
  const d = data || {};
  if (typeof d.companyId === 'string' && d.companyId) return d.companyId !== ownCompany;
  let leadId = cleanId(d.leadId);
  if (!leadId && typeof docPath === 'string') {
    const seg = docPath.split('/');
    if (seg.length === 4 && seg[0] === 'leads') leadId = cleanId(seg[1]);
  }
  if (!leadId) return false;
  const lc = await leadCompanyOf(leadId);
  return !!lc && lc !== ownCompany;
}

/**
 * Suspend a team member who asked to be erased. Deletes nothing. Every step
 * is idempotent; any failure throws so the request stays retryable.
 * `revokeTokens` is member-offboarding.js revokeMemberAccessTokens.
 * Returns { agentKeys, calendarFeeds, roster } for the audit row.
 */
async function suspendMemberForErasure({ db, auth, uid, scope, revokeTokens, serverTimestamp }) {
  const ts = typeof serverTimestamp === 'function' ? serverTimestamp : () => new Date();

  // Auth FIRST, so a run that fails part-way fails closed: the person is
  // already locked out while the rest is retried with the same link.
  await auth.updateUser(uid, { disabled: true });
  await auth.revokeRefreshTokens(uid);

  const revoked = await revokeTokens(db, uid, 'member-self-erasure');

  // Roster rows: every row on this company that is theirs, found by the
  // email key the team tab reads AND by uid (a row keyed by an older email
  // still carries the uid). The email row is created when missing so the
  // owner can still see the person and turn them back on.
  const base = 'companies/' + scope.companyId + '/members';
  const refs = new Map();
  if (scope.email) refs.set(base + '/' + scope.email, db.doc(base + '/' + scope.email));
  const byUid = await db.collection(base).where('uid', '==', uid).get();
  (byUid.docs || []).forEach((d) => refs.set(d.ref.path, d.ref));
  for (const ref of refs.values()) {
    const patch = {
      uid,
      status: 'deactivated',
      active: false,
      deactivatedAt: ts(),
      deactivatedBy: uid,
      deactivatedReason: SUSPEND_REASON,
    };
    const cur = await ref.get();
    if (!cur.exists) {
      if (scope.email) patch.email = scope.email;
      if (scope.role) patch.role = scope.role;
    }
    await ref.set(patch, { merge: true });
  }
  const rosterPaths = [...refs.keys()];
  return Object.assign({}, revoked, { roster: rosterPaths.length ? rosterPaths : null });
}

module.exports = {
  resolveErasureScope,
  belongsToOtherTenant,
  suspendMemberForErasure,
  SUSPEND_REASON,
  OUTCOME_NOTE,
  SUSPEND_MESSAGE,
  OWNER_WITH_TEAM_MESSAGE,
};
