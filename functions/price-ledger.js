/**
 * price-ledger.js: the supplier price ledger's two callables (slice 1 of
 * documentation/projects/LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md; flag
 * `supplierPricing`, ships dark).
 *
 *   priceLedgerSave    { op, data }   owner / company_admin
 *     ops: upsertSupplierAccount, upsertOffer, linkOffer, verifyPack, archiveOffer,
 *     voidObservation. Answers { ok, id }.
 *   priceLedgerRecord  { rows: [1..500], channel? }   owner / company_admin / manager
 *     Typed prices into the dated, append-only history. A manager's row is stored
 *     as a note (`manual`, unattested) until an owner or company_admin confirms it.
 *     channel 'hd_csv' (slice 2; owner / company_admin only): receipt lines from a
 *     store's purchase export. They may have no unit and may carry a stub that
 *     creates an unlinked offer for a SKU the ledger has not seen.
 *     Answers { results, written, duplicates, rejected, needsUnit, alertsOpened }.
 *
 * Nothing here changes a cost book, a sell price or an estimate, and nothing calls a
 * vendor: a person types their own price. So there is no kill switch and no plan
 * gate in this slice; the per-person flag is the allowlist.
 *
 * Who is calling, and for which tenant, is decided by priceCaller and nowhere else.
 * No callable takes a company id in its data, so a platform admin acts on their own
 * tenant only.
 *
 * Logs: event names and counts. Never a price, a SKU or a supplier's text.
 */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore } = require('firebase-admin/firestore');
const { withSentry } = require('./integrations/sentry');
const { callableRateLimit, assertNotViewer } = require('./shared');
const { requireTeamAdmin, assertCallerAccountEnabled, SUBORDINATE_ROLES } = require('./handlers/_shared');
const L = require('./price-logic');
const Store = require('./price-ledger-store');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

const MESSAGES = {
  feature_off: 'Supplier pricing is not switched on for this account.',
  flag_read: 'Could not check your settings just now. Try again in a moment.',
  denied: 'Owner or admin access required',
};

const REASONS = {
  bad_supplier: 'Pick a store or supplier from the list.',
  label_required: 'Give this supplier a name.',
  bad_type: 'Say whether this is a store or a distributor.',
  bad_locations: 'Check the branches: each needs its own short id and exactly one is the usual branch.',
  bad_rep: 'Check the rep details.',
  bad_terms: 'Check the terms: quote days must be 1 to 365.',
  bad_preferred_for: 'Check the product categories.',
  bad_sku: 'That SKU is too long.',
  title_required: 'Give the item a name.',
  bad_url: 'The link must be an https link on that supplier\'s own site.',
  bad_product: 'That product was not recognised.',
  bad_upc: 'A UPC is 8 to 14 digits.',
  bad_tiers: 'Check the tiers.',
  bad_match: 'Check the match grade.',
  bad_pack: 'Check the pack size: both numbers must be whole and above zero.',
  bad_offer: 'That item was not recognised.',
  unknown_supplier_account: 'Add this store or supplier first.',
  immutable: 'The supplier and SKU of an item can not be changed. Add a new item instead.',
  needs_unit: 'Set the pack size first.',
  not_found: 'That was not found.',
};

async function priceLedgerSave(request) {
  const caller = await priceCaller(request, 'admin', 'priceLedgerSave', 60);
  const op = request.data && request.data.op;
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(Store.saveOps, op)) throw new HttpsError('invalid-argument', 'Unknown operation');
  const data = (request.data && typeof request.data.data === 'object' && request.data.data) || {};
  const out = await Store.saveOps[op](getFirestore(), caller.companyId, data, { uid: caller.uid, role: caller.role }, Date.now());
  if (!out.ok) {
    logger.info('[priceLedgerSave] refused', { op, reason: out.reason });
    throw new HttpsError(out.reason === 'not_found' ? 'not-found' : 'invalid-argument', REASONS[out.reason] || 'That could not be saved.', { reason: out.reason });
  }
  logger.info('[priceLedgerSave] done', { op });
  return { ok: true, id: out.id };
}

async function priceLedgerRecord(request) {
  const caller = await priceCaller(request, 'staff', 'priceLedgerRecord', 20);
  const rows = request.data && request.data.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > Store.MAX_ROWS_PER_CALL) throw new HttpsError('invalid-argument', 'Send 1 to ' + Store.MAX_ROWS_PER_CALL + ' rows');
  // A caller may name one other channel: `hd_csv`, a store's purchase export read by
  // the importer. Anything else (the migration channel included) is a typed price.
  const channel = (request.data && request.data.channel) === 'hd_csv' ? 'hd_csv' : 'manual';
  // Receipts feed the history as attested `paid` rows, so only the owner or a
  // company admin sends them (Jo, 2026-11-17). A manager still types notes.
  if (channel === 'hd_csv' && caller.role === 'manager') throw new HttpsError('permission-denied', MESSAGES.denied);
  const out = await Store.appendObservations(getFirestore(), caller.companyId, rows, {
    origin: 'callable', channel,
    actor: { uid: caller.uid, role: caller.role, fn: 'priceLedgerRecord' },
    nowMs: Date.now(),
  });
  logger.info('[priceLedgerRecord] done', { rows: rows.length, written: out.written, duplicates: out.duplicates, rejected: out.rejected, needsUnit: out.needsUnit });
  return out;
}

/**
 * Who is calling, and for which tenant. `need` is 'admin' (owner, company_admin) or
 * 'staff' (those plus a manager). Returns { uid, companyId, role } where role is
 * owner, company_admin, manager or admin. The ghost check runs first, on the export
 * (tenant-guard.wrapCallable).
 */
async function priceCaller(request, need, name, perMinute) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');
  const claims = request.auth.token || {};
  assertNotViewer(claims);
  await callableRateLimit(request, name, perMinute, 60_000);

  const role = typeof claims.role === 'string' ? claims.role.trim().toLowerCase() : '';
  // A subordinate role with no companyId claim is an access-code or invited user, never an owner.
  if (role !== 'admin' && !claims.companyId && SUBORDINATE_ROLES.has(role)) throw new HttpsError('permission-denied', MESSAGES.denied);

  let caller;
  if (need === 'staff' && role === 'manager' && claims.companyId) {
    await assertCallerAccountEnabled(uid);
    caller = { uid, companyId: String(claims.companyId), role: 'manager' };
  } else {
    if (role === 'member' || role === 'sales_rep' || role === 'manager') throw new HttpsError('permission-denied', MESSAGES.denied);
    const who = await requireTeamAdmin(request);
    caller = { uid, companyId: who.companyId, role: who.isGlobalAdmin ? 'admin' : (who.isOwner ? 'owner' : 'company_admin') };
  }

  // The per-person flag. (The doc id sits in a variable so the owner-keyed-prefix scan does not read it as a storage prefix.)
  const db = getFirestore();
  const flagDocId = uid;
  let flagsDefault, flagsMine;
  try {
    const [d, m] = await Promise.all([db.doc('feature_flags/_default').get(), db.doc('feature_flags/' + flagDocId).get()]);
    flagsDefault = d.exists ? (d.data() || {}) : {};
    flagsMine = m.exists ? (m.data() || {}) : {};
  } catch (e) {
    throw new HttpsError('unavailable', MESSAGES.flag_read);
  }
  if (!L.flagOn(flagsDefault, flagsMine)) throw new HttpsError('failed-precondition', MESSAGES.feature_off);
  return caller;
}

const OPTS = { region: 'us-central1', cors: CORS_ORIGINS, enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' };
exports.priceLedgerSave = onCall(OPTS, withSentry('priceLedgerSave', require('./tenant-guard').wrapCallable(priceLedgerSave)));
exports.priceLedgerRecord = onCall(OPTS, withSentry('priceLedgerRecord', require('./tenant-guard').wrapCallable(priceLedgerRecord)));
exports._internal = { priceCaller, priceLedgerSave, priceLedgerRecord, MESSAGES, REASONS };
