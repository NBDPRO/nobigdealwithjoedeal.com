/**
 * functions/sms-texting-gate.js — whose texting is this?
 * ═══════════════════════════════════════════════════════════════
 *
 * Every outbound text belongs to ONE tenant (the companyId claim, or a solo
 * owner's own uid — the companyProfile convention). That tenant's Do Not Text
 * list (functions/sms-optout.js) is checked before it goes.
 *
 * NBD is one tenant. Its key comes from NBD_OWNER_UID, the same convention
 * lead-alert.js, customer-id-mint.js, agent-mcp.js and call-center.js use —
 * never from a brand name a tenant could type into its own profile.
 *
 * The NBD-owned audiences that have no lead or rep behind them (the storm
 * alert subscriber list, the /estimate ack) are NBD's, so they check NBD's
 * list.
 */

'use strict';

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

/** The tenant key of an authenticated caller (decoded ID token). '' if none. */
function tenantKeyOf(decoded) {
  if (!decoded) return '';
  return String(decoded.companyId || decoded.uid || '');
}

/** The tenant key a stored record belongs to (lead, knock, AI draft). */
function tenantKeyOfRecord(rec) {
  if (!rec) return '';
  return String(rec.companyId || rec.userId || '');
}

// ── The master switch (texting review 2026-10-05, fix #5) ────────────────
//
// One on/off for ALL outbound texting, per company, checked on the server
// before every send — live, queued, door-knock, AI-draft, storm, /estimate
// ack. Before this the only switch was the storm one.
//
//   sms_settings/{tenantKey}
//     enabled:    boolean — the company's own toggle (owner / company_admin,
//                 manageSmsCompliance setEnabled). Absent = on.
//     registered: boolean — the company has its OWN registered texting brand
//                 and number. Admin-SDK only; nothing in the CRM can set it.
//
// Allowed = (NBD, or registered === true) AND enabled !== false.
//
// NBD is registered by definition (its A2P brand is the one on the shared
// number), so with no doc at all NBD texts exactly as before. Every OTHER
// company fails CLOSED until per-company registration exists (designed
// separately): one Twilio number serves every tenant, and texting another
// business's customers under NBD's registered brand breaks the A2P rules for
// platforms. A settings read that fails answers "unverified" — never "on".
const SETTINGS_COLLECTION = 'sms_settings';

/**
 * @returns {Promise<{allowed: boolean, reason: null|'no_tenant'|'not_registered'|'switched_off',
 *   isNbd: boolean, registered: boolean, enabled: boolean}>}
 *   REJECTS on a read error (callers: do not send).
 */
async function textingStatus(db, tenantKey) {
  const key = String(tenantKey || '');
  if (!key || key.indexOf('/') !== -1) {
    return { allowed: false, reason: 'no_tenant', isNbd: false, registered: false, enabled: false };
  }
  const snap = await db.doc(SETTINGS_COLLECTION + '/' + key).get();
  const d = snap.exists ? (snap.data() || {}) : {};
  const isNbd = key === module.exports.NBD_OWNER_UID;
  const registered = isNbd || d.registered === true;
  const enabled = d.enabled !== false;
  const reason = !registered ? 'not_registered' : (!enabled ? 'switched_off' : null);
  return { allowed: !reason, reason, isNbd, registered, enabled };
}

const REFUSAL_MESSAGES = Object.freeze({
  not_registered: 'Texting needs registration for your company — coming soon. Nothing was sent.',
  switched_off: 'Texting is switched off for your company (Settings → Texting). Nothing was sent.',
  no_tenant: 'Texting is not set up for this account. Nothing was sent.',
});

/** The 403 body a send path answers when the switch says no. */
function refusalBody(status) {
  const reason = (status && status.reason) || 'no_tenant';
  return { error: REFUSAL_MESSAGES[reason] || REFUSAL_MESSAGES.no_tenant, code: 'texting_disabled', reason };
}

const UNVERIFIED_BODY = Object.freeze({
  error: 'Could not check whether texting is switched on — nothing was sent. Try again in a moment.',
  code: 'texting_unverified',
});

module.exports = {
  NBD_OWNER_UID,
  SETTINGS_COLLECTION,
  tenantKeyOf,
  tenantKeyOfRecord,
  textingStatus,
  refusalBody,
  UNVERIFIED_BODY,
};
