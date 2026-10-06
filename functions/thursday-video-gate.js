'use strict';
/**
 * thursday-video-gate.js — who may see "A video from Thursday" (2026-10-05).
 *
 * Thursday is NBD's AI assistant presenter. Her follow-up video card
 * (docs/pro/js/thursday-video.js) is NBD-only: other tenants never see it.
 * The decision is the tenant key (companyId) against NBD's owner uid, made on
 * the server — never the company name, and never anything the tenant-authored
 * deal page says about itself.
 *
 *   - getDealRoom (deal-acceptance.js) appends DEAL_ROOM_INJECT before
 *     </head> (a marker meta plus the card script) and widens its CSP by that
 *     one script + media-src 'self', for NBD deals only.
 *   - getPortalView (portal.js) sends company.isNbd = isNbdTenant(tenantKey).
 *
 * The card still renders nothing until a video is configured client-side.
 * Pure; tests/thursday-video-card-2026-10-05.test.js.
 */
const { NBD_OWNER_UID } = require('./tenant-ops-logic');

function isNbdTenant(companyId, nbdOwnerUid) {
  const owner = nbdOwnerUid || NBD_OWNER_UID;
  return typeof companyId === 'string' && companyId.length > 0 && companyId === owner;
}

// Root-relative so it resolves on whichever host served /deal/<token>; the
// deal-room CSP lists this exact path on all three hosts.
const DEAL_ROOM_SCRIPT_PATH = '/pro/js/thursday-video.js';
const DEAL_ROOM_INJECT = '<meta name="nbd-thursday" content="1">'
  + '<script src="' + DEAL_ROOM_SCRIPT_PATH + '?v=1" defer></script>';

module.exports = { isNbdTenant, DEAL_ROOM_INJECT, DEAL_ROOM_SCRIPT_PATH };
