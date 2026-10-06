/**
 * functions/member-offboarding.js — what a team member loses when an owner or
 * admin removes, deactivates or demotes them (review R3-1, 2026-10-06).
 *
 * Before this, removeMember stripped claims and revoked refresh tokens, and
 * that was all. The ex-rep kept three ways in:
 *   (a) Rules authorize company records on isOwner(userId) with no tenant
 *       check, and userId is frozen, so the rep signed back in (now a claimless
 *       solo user) and read, edited or exported every lead they had owned.
 *   (b) Their calendar feed token never expires and was never revoked.
 *   (c) Bot keys they created kept reading the company's CRM; crmMcp never
 *       re-checked the creator.
 *
 * WHY REASSIGN, NOT A RULES CHANGE (the two options Jo was offered)
 * ─────────────────────────────────────────────────────────────────
 * The rules alternative is "the owner branch also needs resource.companyId ==
 * the caller's companyId claim". It looks smaller, but Firestore evaluates a
 * LIST query against the query's own constraints, and the CRM has ~90 client
 * queries shaped where('userId','==',uid) with no companyId filter. A
 * condition on resource.data.companyId cannot be proven from those, so every
 * one of them would start failing for every rep. That fails closed for the
 * whole CRM, not just for leavers. It would also need editing ~140 isOwner
 * sites. Reassigning instead moves the records to the owner at removal, so
 * the rules deny the ex-rep with no rule change: get, update, delete and list
 * alike. The owner already reads them as company_admin; now they also own
 * them, and the records stay in the company.
 *
 * What moves: every collection in the user-owned registry
 * (integrations/user-owned.js) whose rule keys on the owner field, minus the
 * ones that are about the member themselves (NOT_REASSIGNED), plus
 * esign_envelopes (owner-keyed by rule, not in the registry). A doc moves only
 * with tenant evidence: its companyId is this company, or it has no companyId
 * and its leadId points at a lead of this company. A doc whose companyId is the
 * member's own uid is their solo data from before they joined, so it stays.
 * A doc with no evidence either way also stays; the sweep never guesses. Under
 * each moved lead, the subcollections that carry their own userId move too:
 * recordings and storm_proofs (their rules key on it), and jobs and tasks
 * (calendar feed and CRM summaries read them by userId).
 *
 * Only the owner field is rewritten. Nothing is stamped onto the doc, because
 * some rules (suppliers) allowlist every key on later client updates.
 *
 * Deactivation does NOT reassign. It is reversible (reactivate: true), the
 * Auth account is disabled so it cannot sign in, and the key and feed
 * re-checks below refuse a disabled person.
 *
 * Pure of firebase-admin at load time. The rules emulator test drives
 * reassignMemberRecords with a compat client db, and only the revocation path
 * needs FieldValue, which is required lazily.
 */
'use strict';

const { FLAT_USER_COLLECTIONS } = require('./integrations/user-owned');
const { keyOf, ledgerEntry } = require('./member-storage-move');

// Registry collections that are about the member, not company records, or
// credentials revoked separately (calendar_feed_tokens).
const NOT_REASSIGNED = new Set([
  'notifications',     // their own bell
  'dailyTracker',      // their own daily numbers
  'training_sessions', // their own sales practice
  'api_usage',         // their own AI token meter
  'userCostMeter',     // their own Vision spend meter
  'sms_client_ids',    // send-idempotency claims, TTL'd in ~8 days
  'calendar_feed_tokens',
]);

const REASSIGN_TARGETS = FLAT_USER_COLLECTIONS
  .filter((c) => !NOT_REASSIGNED.has(c.name))
  .map((c) => ({ name: c.name, ownerField: c.ownerField || 'userId' }))
  .concat([{ name: 'esign_envelopes', ownerField: 'ownerUid' }]);

const LEAD_SUBCOLLECTIONS = ['recordings', 'storm_proofs', 'jobs', 'tasks'];

const BATCH_MAX = 400;

// With a ledger (member-storage-move.js), each moved doc's path is recorded
// in the SAME batch as its reassignment, so a crash can never leave a moved
// record the storage move does not know about. Two writes per doc, so half
// the chunk size.
async function commitUpdates(db, refs, patch, ledger) {
  const step = ledger ? BATCH_MAX / 2 : BATCH_MAX;
  for (let i = 0; i < refs.length; i += step) {
    const b = db.batch();
    refs.slice(i, i + step).forEach((r) => {
      b.update(r, patch);
      if (ledger) b.set(ledger.doc(keyOf(r.path)), ledgerEntry(r, 'record'));
    });
    await b.commit();
  }
}

/**
 * Move a departing member's company records to `toUid` (the company owner).
 * Idempotent: a retry finds only what is still owned by `fromUid`. Throws on
 * any read or write failure, so the caller can stop before stripping claims.
 * Returns { moved: {collection: n}, skipped, total }.
 * `ledger` (optional): a collection ref that receives one row per moved doc
 * (removeMember passes the storage move's ledger).
 */
async function reassignMemberRecords(db, { fromUid, toUid, companyId, ledger } = {}) {
  const ids = [fromUid, toUid, companyId];
  if (!ids.every((v) => typeof v === 'string' && v.length > 0) || fromUid === toUid) {
    throw new Error('reassignMemberRecords: fromUid, toUid and companyId are required, and fromUid must differ from toUid');
  }
  const leadCompany = new Map();
  async function leadCompanyOf(leadId) {
    if (!leadCompany.has(leadId)) {
      const s = await db.doc('leads/' + leadId).get();
      leadCompany.set(leadId, s.exists ? ((s.data() || {}).companyId || null) : null);
    }
    return leadCompany.get(leadId);
  }

  const moved = {};
  let skipped = 0;
  async function inCompany(data) {
    if (data.companyId === companyId) return true;
    if (data.companyId || typeof data.leadId !== 'string' || !data.leadId || data.leadId.includes('/')) return false;
    return (await leadCompanyOf(data.leadId)) === companyId;
  }

  // Leads first. Under each lead, the rows that carry their own userId move
  // BEFORE the lead itself, so an interrupted run still finds the lead owned
  // by fromUid on retry and finishes its subcollections.
  const leadSnap = await db.collection('leads').where('userId', '==', fromUid).get();
  const leadRefs = [];
  for (const d of leadSnap.docs) {
    if ((d.data() || {}).companyId === companyId) leadRefs.push(d.ref); else skipped++;
  }
  for (const sub of LEAD_SUBCOLLECTIONS) {
    const refs = [];
    for (const lr of leadRefs) {
      const snap = await db.collection('leads/' + lr.id + '/' + sub).where('userId', '==', fromUid).get();
      snap.docs.forEach((d) => refs.push(d.ref));
    }
    await commitUpdates(db, refs, { userId: toUid }, ledger);
    if (refs.length) moved['leads/*/' + sub] = refs.length;
  }
  await commitUpdates(db, leadRefs, { userId: toUid }, ledger);
  if (leadRefs.length) moved.leads = leadRefs.length;

  for (const { name, ownerField } of REASSIGN_TARGETS) {
    if (name === 'leads') continue;
    const snap = await db.collection(name).where(ownerField, '==', fromUid).get();
    const refs = [];
    for (const d of snap.docs) {
      if (await inCompany(d.data() || {})) refs.push(d.ref); else skipped++;
    }
    await commitUpdates(db, refs, { [ownerField]: toUid }, ledger);
    if (refs.length) moved[name] = refs.length;
  }

  const total = Object.values(moved).reduce((a, n) => a + n, 0);
  return { moved, skipped, total };
}

/**
 * Turn off the member's bot keys (made by them, or their personal key) and
 * their calendar feed links. Throws on failure. Returns
 * { agentKeys, calendarFeeds } counts of what was switched off.
 */
async function revokeMemberAccessTokens(db, uid, reason) {
  if (typeof uid !== 'string' || !uid) throw new Error('revokeMemberAccessTokens: uid required');
  const { FieldValue } = require('firebase-admin/firestore');
  const why = String(reason || 'member-offboarded');

  const [byCreator, byOwner, feeds] = await Promise.all([
    db.collection('agent_keys').where('createdBy', '==', uid).get(),
    db.collection('agent_keys').where('ownerUid', '==', uid).get(),
    db.collection('calendar_feed_tokens').where('uid', '==', uid).get(),
  ]);
  const keyRefs = new Map();
  byCreator.docs.concat(byOwner.docs).forEach((d) => {
    if ((d.data() || {}).active === true) keyRefs.set(d.ref.path || d.id, d.ref);
  });
  const feedRefs = feeds.docs.filter((d) => (d.data() || {}).status === 'active').map((d) => d.ref);

  await commitUpdates(db, [...keyRefs.values()], {
    active: false, revokedAt: FieldValue.serverTimestamp(), revokedBy: 'offboarding', revokedReason: why,
  });
  await commitUpdates(db, feedRefs, {
    status: 'revoked', revokedAt: FieldValue.serverTimestamp(), revokedReason: why,
  });
  return { agentKeys: keyRefs.size, calendarFeeds: feedRefs.length };
}

// The company a person acts for: their companyId claim, or their own uid
// (a solo owner whose claim was never minted).
function effectiveCompany(user) {
  const c = (user && user.customClaims) || {};
  return c.companyId || (user && user.uid) || null;
}

/**
 * crmMcp, on every call: is the person who made this key still entitled to it?
 * `creator` is the Auth user record (null when the account is gone).
 */
function keyCreatorAllowed(key, creator) {
  const k = key || {};
  // Explicit: a key with no human creator was minted server-side (a platform
  // or house key from a script). There is no person to offboard.
  if (!k.createdBy) return true;
  if (!creator || creator.disabled === true) return false;
  const c = creator.customClaims || {};
  // The platform admin (Jo) makes NBD's house keys; they keep working while
  // that account is enabled and still the platform admin.
  if (c.role === 'admin') return true;
  if (c.role === 'viewer') return false;
  return effectiveCompany(creator) === k.companyId;
}

/**
 * getCalendarFeed, on every fetch: is the rep behind this feed still an
 * enabled, non-viewer member of the company the feed was minted in?
 */
function feedOwnerAllowed(tok, user) {
  const t = tok || {};
  if (!user || user.disabled === true) return false;
  const c = user.customClaims || {};
  if (c.role === 'viewer') return false;
  return effectiveCompany(user) === (t.companyId || t.uid);
}

// Team role order, highest first (handlers/_shared.js TEAM_ROLES).
const ROLE_RANK = { company_admin: 3, manager: 2, sales_rep: 1, viewer: 0 };

/**
 * updateUserRole: does this role change turn off the member's bot keys and
 * calendar feed links? (R3-1 follow-up, Jo 2026-10-06.) Yes for any move to
 * viewer (neither can be minted by one), and for any DOWNGRADE away from
 * company_admin or manager: the keys they made were made with that role's
 * reach, and they can mint new ones if the lower role allows it. A move up,
 * a no-op, or a change between the lower roles leaves them alone. An unknown
 * old role (no claim yet) is not a downgrade.
 */
function roleChangeRevokesAccess(oldRole, newRole) {
  if (newRole === 'viewer') return true;
  if (oldRole !== 'company_admin' && oldRole !== 'manager') return false;
  const to = ROLE_RANK[newRole];
  return typeof to === 'number' && to < ROLE_RANK[oldRole];
}

module.exports = {
  reassignMemberRecords,
  revokeMemberAccessTokens,
  roleChangeRevokesAccess,
  keyCreatorAllowed,
  feedOwnerAllowed,
  REASSIGN_TARGETS,
  LEAD_SUBCOLLECTIONS,
  NOT_REASSIGNED,
};
