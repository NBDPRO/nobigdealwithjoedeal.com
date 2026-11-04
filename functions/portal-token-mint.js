/**
 * functions/portal-token-mint.js — writes a homeowner portal token (2026-11-04).
 * createPortalToken (the rep's button, functions/portal.js) and the key-moment
 * emails (functions/portal-moments.js) share it, so the token's shape — tenant
 * key, TTL, use budget — cannot drift between those two. estimate-send.js still
 * mints its own (same fields); folding it in is a separate change.
 * Callers do their own authorization first.
 */
'use strict';

const { Timestamp, FieldValue } = require('firebase-admin/firestore');

// 32-char no-confusable alphabet (no 0/O, 1/I/L), same as report-sharing.js.
const PORTAL_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function mintPortalToken() {
  const bytes = require('crypto').randomBytes(24);
  let s = '';
  for (const b of bytes) s += PORTAL_TOKEN_ALPHABET[b % PORTAL_TOKEN_ALPHABET.length];
  return s;
}

/** Write portal_tokens/{token} for a lead. → { token, expiresAt: Timestamp } */
async function writePortalToken(db, leadId, lead, mintedBy, ttlDaysIn) {
  const ttlDays = Math.min(90, Math.max(1, Number(ttlDaysIn) || 30));
  const expiresAt = Timestamp.fromMillis(Date.now() + ttlDays * 86_400_000);
  const token = mintPortalToken();
  await db.doc(`portal_tokens/${token}`).set({
    leadId,
    ownerUid: lead.userId,
    // Tenant key carried on the token so sendPortalMessage can stamp
    // companyId on the thread without a per-message lead read. ownerUid is
    // lead.userId — the REP's uid, which diverges from companyId on a team
    // tenant — so it is only a last-resort fallback, never the source.
    companyId: lead.companyId || null,
    mintedBy,
    mintedAt: FieldValue.serverTimestamp(),
    expiresAt,
    uses: 0,
    maxUses: 100,  // generous — homeowner may reload across days
  });
  return { token, expiresAt };
}

module.exports = { writePortalToken, mintPortalToken, PORTAL_TOKEN_ALPHABET };
