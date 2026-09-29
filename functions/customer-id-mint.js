/**
 * functions/customer-id-mint.js — server-side customerId mint for leads the
 * backend creates (website-form / Thumbtack bridge, Cal.com, Thursday voice,
 * referrals, converted inbound SMS).
 * ═══════════════════════════════════════════════════════════════
 * WHY (2026-09-29): only client paths minted a customerId (customer page lazy
 * mint, _saveLead, data import), and the server backfill was retired
 * 2026-08-11 — so every server-created lead landed without one. 77 of Jo's 223
 * live leads had none that day. The Home Depot import (docs/pro/js/hd-import.js)
 * matches receipts by the customer number in the PO/Job name, so a lead needs
 * its number the moment it exists, not the first time someone opens its page.
 *
 * Byte-compatible with the client mint (customer-bootstrap.module.js): same
 * counters/{counterId} doc, same `{ next }` field and `(next || 0) + 1` step,
 * same formatCustomerId / resolveCustMint (functions/customer-id.js mirrors
 * company-profile.js). Client and server draw from ONE sequence per tenant.
 *
 * Rules:
 *   - Counter bump and lead create commit in ONE transaction, so a redelivered
 *     webhook (lead already exists) burns no number, and an existing lead is
 *     never touched — let alone its customerId.
 *   - A leadDoc that already carries a customerId is created as-is (no mint).
 *   - Mint failure never costs the lead: log, create it without a customerId,
 *     and the client lazy mint still backstops it on first open.
 *   - Platform-identity veto: the un-salted 'NBD-####' + shared counter is the
 *     right answer for exactly one tenant (NBD_OWNER_UID). Any other tenant
 *     whose brand still resolves as NBD (never set brand.legalName) is skipped
 *     rather than stamped with NBD's identity — "blank beats wrong", as in
 *     render-pdf.js and company-profile.js _tenantFilePrefix.
 */

'use strict';

const { formatCustomerId, isNbdBrand, resolveCustMint } = require('./customer-id');

const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

function defaultLogger() {
  try { return require('firebase-functions/v2').logger; } catch (_) { return console; }
}

function isAlreadyExists(e) {
  return !!e && (e.code === 6 || e.code === 'already-exists' || /already exists/i.test(e.message || ''));
}

// { prefix, counterId, companyId } for a tenant, or null when this tenant must
// not be minted server-side. `brand` is companyProfile/{companyId}.brand; pass
// undefined to have it read here. A failed profile read throws — callers treat
// that as a mint failure.
async function resolveLeadMint(db, companyId, brand, opts) {
  opts = opts || {};
  const cid = companyId ? String(companyId) : '';
  if (!cid) return null;
  if (brand === undefined) {
    const snap = await db.collection('companyProfile').doc(cid).get();
    brand = snap.exists ? ((snap.data() || {}).brand || null) : null;
  }
  const owner = opts.nbdOwnerUid || NBD_OWNER_UID;
  if (isNbdBrand(brand) && cid !== owner) return null;
  const m = resolveCustMint(brand, cid);
  return { prefix: m.prefix, counterId: m.counterId, companyId: cid };
}

// Bump counters/{counterId} inside `tx` and return the formatted id. Reads
// first, so callers may only add their own reads BEFORE calling this.
async function mintInTransaction(tx, db, mint) {
  const counterRef = db.collection('counters').doc(mint.counterId);
  const snap = await tx.get(counterRef);
  const next = ((snap.exists && (snap.data() || {}).next) || 0) + 1;
  tx.set(counterRef, { next: next }, { merge: true });
  return formatCustomerId(mint.prefix, next, mint.companyId);
}

// Standalone mint: returns the new customerId, or null (skipped or failed).
async function mintCustomerId(db, companyId, brand, opts) {
  opts = opts || {};
  const log = opts.logger || defaultLogger();
  try {
    const mint = await resolveLeadMint(db, companyId, brand, opts);
    if (!mint) return null;
    return await db.runTransaction((tx) => mintInTransaction(tx, db, mint));
  } catch (e) {
    log.warn('customerIdMint: mint failed', { companyId: String(companyId || ''), err: e && e.message });
    return null;
  }
}

// Drop-in for `leadRef.create(leadDoc)`: same ALREADY_EXISTS contract (throws
// an error with code 6 when the lead exists), plus a customerId minted in the
// same transaction. Returns { customerId } — null when no id was minted.
async function createLeadWithCustomerId(db, leadRef, leadDoc, opts) {
  opts = opts || {};
  const log = opts.logger || defaultLogger();
  if (leadDoc && leadDoc.customerId) {
    await leadRef.create(leadDoc);
    return { customerId: leadDoc.customerId };
  }

  let mint = null;
  try {
    mint = await resolveLeadMint(db, leadDoc && leadDoc.companyId, opts.brand, opts);
  } catch (e) {
    log.warn('customerIdMint: tenant profile read failed — creating lead without customerId', {
      leadId: leadRef.id, companyId: String((leadDoc && leadDoc.companyId) || ''), err: e && e.message,
    });
  }

  if (mint) {
    try {
      const customerId = await db.runTransaction(async (tx) => {
        const existing = await tx.get(leadRef);
        if (existing.exists) {
          throw Object.assign(new Error('6 ALREADY_EXISTS: lead ' + leadRef.id + ' already exists'), { code: 6 });
        }
        const id = await mintInTransaction(tx, db, mint);
        tx.create(leadRef, Object.assign({}, leadDoc, { customerId: id }));
        return id;
      });
      return { customerId: customerId };
    } catch (e) {
      if (isAlreadyExists(e)) throw e;
      log.warn('customerIdMint: mint transaction failed — creating lead without customerId', {
        leadId: leadRef.id, counterId: mint.counterId, err: e && e.message,
      });
    }
  }

  await leadRef.create(leadDoc);
  return { customerId: null };
}

module.exports = {
  NBD_OWNER_UID,
  isAlreadyExists,
  resolveLeadMint,
  mintInTransaction,
  mintCustomerId,
  createLeadWithCustomerId,
};
