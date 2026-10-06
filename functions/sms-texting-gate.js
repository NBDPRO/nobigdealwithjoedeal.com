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

module.exports = {
  NBD_OWNER_UID,
  tenantKeyOf,
  tenantKeyOfRecord,
};
