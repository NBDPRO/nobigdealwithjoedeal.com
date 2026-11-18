/**
 * price-ledger.js: the supplier price ledger's two callables (slice 1 of
 * documentation/projects/LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md; flag
 * `supplierPricing`, ships dark).
 *
 *   priceLedgerSave    { op, data }   owner / company_admin
 *     ops: upsertSupplierAccount, upsertOffer, linkOffer, verifyPack, archiveOffer,
 *     voidObservation; markSeen (slice 3: the shared "seen" list for on-screen alerts,
 *     priceBook/{companyId}/priceConfig/seen); approveCost and undoCost (slice 4: a
 *     supplier price into the company's cost book, one tier at a time; the only
 *     callable path that writes catalogCosts, and only costs.<productId>.cost.<tier>);
 *     savePhoto (2026-11-18: a product's or an item's photo, re-encoded, in Storage
 *     product-photos/{companyId}/…; 20 an hour per person); setEstimateCodes (2026-11-18:
 *     which estimate codes price from a product on the materials list); removeDocument (slice 9:
 *     voids a read document's price rows, deletes its stored original).
 *     Answers { ok, id }, plus `applied` for approveCost and undoCost.
 *   priceLedgerRecord  { rows: [1..500], channel? }   owner / company_admin / manager
 *     Typed prices into the dated, append-only history. A manager's row is stored
 *     as a note (`manual`, unattested) until an owner or company_admin confirms it.
 *     channel 'hd_csv' (slice 2; owner / company_admin only): receipt lines from a
 *     store's purchase export. They may have no unit and may carry a stub that
 *     creates an unlinked offer for a SKU the ledger has not seen.
 *     channel 'csv_import' (slice 3; owner / company_admin only): a supplier's quote,
 *     price sheet or invoice read from a CSV on the import screen. Same stub path;
 *     paperwork kinds only, a quote needs its good-through date. The file is not kept.
 *     Answers { results, written, duplicates, rejected, needsUnit, alertsOpened }.
 *
 * Nothing here changes a sell price or an estimate, and nothing calls a vendor.
 * The cost book changes only through approveCost / undoCost, one tier a person
 * approved at a time. Otherwise: a person types their own price. So there is no kill switch and no plan
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
  bad_alert: 'That alert was not recognised.',
  // slice 4: approving a supplier price into the cost book
  changed: 'Something changed since this was shown (a newer price, or the cost was edited). Close it and look again.',
  no_lines: 'Tick at least one tier to update.',
  bad_tier: 'That tier is not one this item is set for.',
  no_price: 'This item has no price to use yet.',
  not_paperwork: 'Only your own paperwork can update a cost: a receipt, invoice, quote, price sheet or account price an owner or admin entered.',
  price_type: 'A list or sale price can not update your cost. Use your own net or account price.',
  delivered: 'A delivered price includes delivery, so it can not update your cost.',
  not_comparable: 'This price can not be used for cost changes.',
  unit_suspect: 'This price looks like it was entered in the wrong unit. Check it or void it first.',
  stale: 'This price is too old to trust. Get a current receipt or quote first.',
  needs_pack: 'Confirm the pack size first.',
  unit_changed: 'The product\'s unit changed. Set the pack size again first.',
  needs_tax_rate: 'Set your purchase sales tax rate first (Company Settings, Supplier Price Compare).',
  no_cost_book: 'Open the Product Library once on the owner\'s device so your costs are saved, then try again.',
  below_one_cent: 'That cost rounds to less than one cent.',
  no_change: 'Your cost book already has this cost.',
  confirm_floor: 'This takes the margin under your floor. Approve it again to confirm.',
  confirm_above_sell: 'This cost is above the sell price. Approve it again to confirm.',
  // product photos (2026-11-18)
  bad_photo_target: 'That photo could not be saved here.',
  photo_bad: 'That file could not be read as a photo. Choose a JPG, PNG, WebP or GIF.',
  photo_too_big: 'That photo is over 3 MB. Choose a smaller one.',
  // estimate codes (2026-11-18)
  bad_codes: 'Check the estimate codes: letters, numbers, spaces and dashes, up to 40 codes.',
  // supplier documents (slice 9, 2026-11-18)
  not_removed: 'The document file could not be deleted just now. Its prices are voided; try Remove again.',
};

async function priceLedgerSave(request) {
  const caller = await priceCaller(request, 'admin', 'priceLedgerSave', 60);
  const op = request.data && request.data.op;
  if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(Store.saveOps, op)) throw new HttpsError('invalid-argument', 'Unknown operation');
  // A photo is re-encoded on the server: its own, tighter limit (20 an hour per person).
  if (op === 'savePhoto') await callableRateLimit(request, 'priceLedgerSavePhoto', 20, 3_600_000);
  const data = (request.data && typeof request.data.data === 'object' && request.data.data) || {};
  const out = await Store.saveOps[op](getFirestore(), caller.companyId, data, { uid: caller.uid, role: caller.role }, Date.now());
  if (!out.ok) {
    logger.info('[priceLedgerSave] refused', { op, reason: out.reason });
    const details = { reason: out.reason };
    if (Array.isArray(out.refused)) details.refused = out.refused;
    throw new HttpsError(out.reason === 'not_found' ? 'not-found' : (out.reason === 'changed' ? 'aborted' : 'invalid-argument'), REASONS[out.reason] || 'That could not be saved.', details);
  }
  logger.info('[priceLedgerSave] done', Array.isArray(out.applied) ? { op, lines: out.applied.length } : { op });
  return Array.isArray(out.applied) ? { ok: true, id: out.id, applied: out.applied } : { ok: true, id: out.id };
}

async function priceLedgerRecord(request) {
  const caller = await priceCaller(request, 'staff', 'priceLedgerRecord', 20);
  const rows = request.data && request.data.rows;
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > Store.MAX_ROWS_PER_CALL) throw new HttpsError('invalid-argument', 'Send 1 to ' + Store.MAX_ROWS_PER_CALL + ' rows');
  // A caller may name two other channels: `hd_csv`, a store's purchase export read by
  // the importer, and `csv_import`, a supplier file from the import screen. Anything
  // else (the migration channel included) is a typed price.
  const asked = request.data && request.data.channel;
  const channel = (asked === 'hd_csv' || asked === 'csv_import') ? asked : 'manual';
  // Receipts and supplier files feed the history as attested paperwork, so only the
  // owner or a company admin sends them (Jo, 2026-11-17). A manager still types notes.
  if (channel !== 'manual' && caller.role === 'manager') throw new HttpsError('permission-denied', MESSAGES.denied);
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
// priceLedgerSave re-encodes product photos with sharp (savePhoto): more memory, as uploadCompanyLogo has.
exports.priceLedgerSave = onCall(Object.assign({}, OPTS, { memory: '512MiB' }), withSentry('priceLedgerSave', require('./tenant-guard').wrapCallable(priceLedgerSave)));
exports.priceLedgerRecord = onCall(OPTS, withSentry('priceLedgerRecord', require('./tenant-guard').wrapCallable(priceLedgerRecord)));
exports._internal = { priceCaller, priceLedgerSave, priceLedgerRecord, MESSAGES, REASONS };
