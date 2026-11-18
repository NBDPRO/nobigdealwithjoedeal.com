/**
 * price-ledger-store.js: the only file that touches Firestore for the supplier
 * price ledger (design: documentation/projects/LIVE-SUPPLIER-PRICING-DESIGN-2026-11-17.md,
 * sections 1.4 and 3.1.2; slice 1).
 *
 * Everything lives under priceBook/{companyId}/…. Every path here is built from the
 * `companyId` argument: no function takes a path, so one tenant's call can never
 * name another tenant's tree.
 *
 *   appendObservations(db, companyId, rows, ctx)  the one write path for prices
 *   recomputeLatest(db, companyId, offerId, nowMs)  the only writer of an offer's `latest`
 *   writeAudit(db, companyId, entry)
 *   saveOps.<op>(db, companyId, data, caller, nowMs)  the priceLedgerSave operations
 *
 * An append is not atomic across rows, by design (500 rows and their summaries do not
 * fit one transaction). Every step is idempotent instead: a retry finds the rows that
 * were written as duplicates, writes the missing ones and rebuilds each summary from a
 * full read. Nothing in `latest` is an increment.
 *
 * Logs carry event names and counts only: never a price, a SKU or a supplier's text.
 */
'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const L = require('./price-logic');

const DAILY_ROW_CAP = 5000;
const MAX_ROWS_PER_CALL = 500;
const HOUR_MS = 3600000;
const SUMMARY_READ = 201;        // one more than summarize keeps, so it can say "capped"
const GET_ALL_CHUNK = 100;
const WRITE_PARALLEL = 20;
const RECOMPUTE_PARALLEL = 10;
const MAX_REVISIONS = 9;
const ID_RE = /^[A-Za-z0-9_-]{1,140}$/;

const base = (companyId) => 'priceBook/' + companyId;
const accountRef = (db, companyId, supplierId) => db.doc(base(companyId) + '/supplierAccounts/' + supplierId);
const offerRef = (db, companyId, offerId) => db.doc(base(companyId) + '/priceOffers/' + offerId);
const obsCol = (db, companyId) => db.collection(base(companyId) + '/priceObservations');
const auditCol = (db, companyId) => db.collection(base(companyId) + '/priceAudit');
const meterRef = (db, companyId, dayKey) => db.doc(base(companyId) + '/priceMeter/rows_' + dayKey);
const seenRef = (db, companyId) => db.doc(base(companyId) + '/priceConfig/seen');
const SEEN_MAX = 2000;
// Slice 4: the one product's link doc, and the three company docs an approval reads.
const linkRef = (db, companyId, productId) => db.doc(base(companyId) + '/productLinks/' + productId);
const costBookRef = (db, companyId) => db.doc('catalogCosts/' + companyId);
const libraryRef = (db, companyId) => db.doc('productLibrary/' + companyId);
const profileRef = (db, companyId) => db.doc('companyProfile/' + companyId);
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
// The fields an approval or an undo owns on a productLinks doc; anything else there (a later slice's photo) is kept.
const LINK_FIELDS = ['productId', 'preferredOfferId', 'applied', 'updatedAt', 'updatedBy'];
// Product photos (2026-11-18): the fields a photo save owns on a productLinks doc, the size cap and the long edge.
const PHOTO_LINK_FIELDS = ['productId', 'photo', 'updatedAt', 'updatedBy'];
const PHOTO_MAX_BYTES = 3 * 1024 * 1024;
const PHOTO_EDGE = 640;
/** The bytes of a data: URL for a raster image (PNG, JPEG, WebP, GIF), or null. */
function decodePhoto(dataUrl) {
  const m = String(dataUrl == null ? '' : dataUrl).match(/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  return buf.length ? buf : null;
}
let SEED = null;
const seed = () => (SEED || (SEED = require('./product-seed-public.json')));

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (ymd) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
const tsMs = (t) => (t && typeof t.toMillis === 'function') ? t.toMillis() : (typeof t === 'number' ? t : 0);
const alreadyExists = (e) => !!e && (e.code === 6 || e.code === 'already-exists' || /already exists/i.test(e.message || ''));

function assertCompany(companyId) {
  if (typeof companyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) throw new HttpsError('permission-denied', 'No company');
}

async function inPool(items, limit, fn) {
  let next = 0;
  const run = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  const workers = [];
  for (let k = 0; k < Math.min(limit, items.length); k++) workers.push(run());
  await Promise.all(workers);
}

async function getMany(db, refs) {
  const out = [];
  for (let i = 0; i < refs.length; i += GET_ALL_CHUNK) {
    const chunk = refs.slice(i, i + GET_ALL_CHUNK);
    if (chunk.length) out.push(...(await db.getAll(...chunk)));
  }
  return out;
}

/** An observation document as summarize reads it. */
function rowOf(snap) {
  const d = snap.data() || {};
  return Object.assign({}, d, { obsId: snap.id, observedAtMs: tsMs(d.observedAt), createdAtMs: tsMs(d.createdAt) });
}

/**
 * The server fields of one sanitized row (pure). `actor.role` decides provenance:
 * a manager's typed row is stored as `manual` with the kind they asked for kept in
 * `claimedKind`, unattested, so it never ranks above paperwork.
 */
function deriveObservation(clean, offer, account, ctx) {
  const role = ctx.actor && ctx.actor.role;
  // The one-time copy of the legacy price book: what it holds was read from the
  // tenant's own receipts, so the kind stays `paid`, but no person vouched for it
  // here, so it is unattested. Keeping the kind is also what gives a copied row and
  // the same receipt line imported later one id (the id is hashed after the kind).
  const migration = ctx.origin === 'migration';
  const trusted = !migration && (role === 'owner' || role === 'company_admin' || role === 'admin');
  const kind = (trusted || migration) ? clean.kind : 'manual';
  const claimedKind = (!trusted && !migration && clean.kind !== 'manual') ? clean.kind : null;
  const known = L.validPack(offer.pack);
  const channel = ctx.channel || 'manual';
  const conv = L.catalogMicrosFor({ priceMicros: clean.priceMicros, per: clean.per, statedUnit: clean.statedUnit, channel }, offer);
  const observedAtMs = dateMs(clean.observedOn) + 12 * HOUR_MS;
  const validThroughMs = clean.validThroughOn ? dateMs(clean.validThroughOn) + 36 * HOUR_MS : null;
  const quoteDays = account && account.terms && account.terms.quoteValidDays;
  const flags = [];
  if (conv.flag) flags.push(conv.flag);
  const ref = offer.latest && offer.latest.best && offer.latest.best.catalogMicros;
  if (conv.micros !== null && L.suspectUnitSwap(conv.micros, ref, offer.pack, null)) flags.push('unit_suspect');
  return {
    v: 1, offerId: clean.offerId, supplierId: offer.supplierId, productId: offer.productId || null, match: offer.match || 'exact',
    locationId: clean.locationId, kind, claimedKind,
    priceMicros: clean.priceMicros, per: clean.per, statedUnit: clean.statedUnit, uomRaw: clean.uomRaw,
    qty: clean.qty, extCents: clean.extCents, currency: 'USD', priceType: clean.priceType,
    taxIncluded: clean.taxIncluded, delivered: clean.delivered,
    pack: known ? { num: offer.pack.num, den: offer.pack.den, purchaseUnit: offer.pack.purchaseUnit, catalogUnit: offer.pack.catalogUnit, verified: offer.pack.verified === true } : null,
    catalogMicros: conv.micros,
    observedOn: clean.observedOn, observedAt: Timestamp.fromMillis(observedAtMs),
    validThroughOn: clean.validThroughOn, validThroughMs,
    levelAtWrite: L.evidenceLevel({ kind, observedAtMs, validThroughMs }, ctx.nowMs, quoteDays),
    doc: { type: clean.doc.type, ref: clean.doc.ref, importId: null, expenseId: null, storagePath: null, leadId: null },
    source: { channel, adapter: null, actor: { type: migration ? 'script' : 'user', uid: ctx.actor.uid, role, fn: ctx.actor.fn || null } },
    attested: trusted, compare: true, flags, supersedes: null,
    voided: false, voidedBy: null, voidedAtMs: null, voidReason: null,
    note: clean.note,
  };
}

/**
 * Write one observation with create(). An id that exists and is live is a
 * duplicate; one that was voided takes the next free `-r<n>` revision.
 */
async function createObservation(db, companyId, id, doc) {
  const col = obsCol(db, companyId);
  if (id === null) {
    const ref = col.doc();
    await ref.create(doc);
    return { status: 'written', obsId: ref.id };
  }
  try {
    await col.doc(id).create(doc);
    return { status: 'written', obsId: id };
  } catch (e) {
    if (!alreadyExists(e)) throw e;
  }
  const first = await col.doc(id).get();
  if (first.exists && (first.data() || {}).voided !== true) return { status: 'duplicate', obsId: id };
  let supersedes = id;
  for (let n = 1; n <= MAX_REVISIONS; n++) {
    const rid = id + '-r' + n;
    try {
      await col.doc(rid).create(Object.assign({}, doc, { supersedes }));
      return { status: 'written', obsId: rid };
    } catch (e) {
      if (!alreadyExists(e)) throw e;
    }
    const snap = await col.doc(rid).get();
    if (snap.exists && (snap.data() || {}).voided !== true) return { status: 'duplicate', obsId: rid };
    supersedes = rid;
  }
  return { status: 'rejected', reason: 'too_many_revisions' };
}

/**
 * Rebuild one offer's `latest` from a full read, in a transaction. The only writer
 * of `latest`.
 */
async function recomputeLatest(db, companyId, offerId, nowMs) {
  assertCompany(companyId);
  if (!ID_RE.test(String(offerId))) return false;
  const ref = offerRef(db, companyId, offerId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const offer = snap.data() || {};
    const acct = await tx.get(accountRef(db, companyId, offer.supplierId));
    const obs = await tx.get(obsCol(db, companyId).where('offerId', '==', offerId).orderBy('observedAt', 'desc').limit(SUMMARY_READ));
    const terms = acct.exists ? ((acct.data() || {}).terms || null) : null;
    const latest = L.summarize(offer, obs.docs.map(rowOf), nowMs, terms && terms.quoteValidDays);
    tx.update(ref, { latest });
    return true;
  });
}

/**
 * The one write path for prices. Returns one result per input row, in order:
 * { i, status: 'written' | 'duplicate' | 'rejected', obsId?, reason? }.
 * ctx = { origin, channel, actor: { uid, role, fn }, nowMs }.
 */
async function appendObservations(db, companyId, rows, ctx) {
  assertCompany(companyId);
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_ROWS_PER_CALL) throw new HttpsError('invalid-argument', 'Send 1 to ' + MAX_ROWS_PER_CALL + ' rows');
  const nowMs = ctx.nowMs;
  const n = rows.length;

  // 1. The company's rows-per-day meter. Not given back for duplicates or rejects.
  // The one-time copy of the legacy price book (an operator script) is not metered.
  if (ctx.origin !== 'migration') {
    const meter = meterRef(db, companyId, utcDay(nowMs));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(meter);
      const used = snap.exists ? (Number((snap.data() || {}).rows) || 0) : 0;
      if (used + n > DAILY_ROW_CAP) throw new HttpsError('resource-exhausted', 'This company has recorded its ' + DAILY_ROW_CAP + ' prices for today. Try again tomorrow.');
      tx.set(meter, { rows: used + n, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
  }

  // 2. Sanitize. A bad row is rejected and does not stop the others.
  const results = new Array(n);
  const clean = new Array(n);
  for (let i = 0; i < n; i++) {
    const s = L.sanitizeObservation(rows[i], { origin: ctx.origin, channel: ctx.channel, nowMs });
    if (s.ok) clean[i] = s.value; else results[i] = { i, status: 'rejected', reason: s.reason };
  }

  // 3. The offers the rows name, and their supplier accounts.
  const offerIds = [...new Set(clean.filter(Boolean).map((c) => c.offerId))];
  const offers = {};
  (await getMany(db, offerIds.map((id) => offerRef(db, companyId, id)))).forEach((s) => { if (s.exists) offers[s.id] = s.data() || {}; });

  // 3a. A receipt line for a SKU the ledger has not seen carries a stub (the
  // sanitizer keeps one only on the store-export channels). Create that offer once,
  // unlinked; an offer that exists is never touched. No supplier account is needed.
  const stubs = {};
  for (let i = 0; i < n; i++) {
    const c = clean[i];
    if (!c || offers[c.offerId] || !c.offer) continue;
    if (c.offerId !== L.offerIdFor(c.offer.supplierId, c.offer.sku)) { results[i] = { i, status: 'rejected', reason: 'bad_offer' }; clean[i] = null; continue; }
    if (!stubs[c.offerId]) stubs[c.offerId] = c.offer;
  }
  await inPool(Object.keys(stubs), WRITE_PARALLEL, async (id) => {
    const ref = offerRef(db, companyId, id);
    const doc = Object.assign({}, L.stubOffer(stubs[id]), {
      photo: null, latest: null, nextCheckMs: null,
      createdAt: FieldValue.serverTimestamp(), createdBy: ctx.actor.uid,
      updatedAt: FieldValue.serverTimestamp(), updatedBy: ctx.actor.uid,
    });
    try { await ref.create(doc); offers[id] = doc; }
    catch (e) {
      if (!alreadyExists(e)) throw e;
      const snap = await ref.get();
      if (snap.exists) offers[id] = snap.data() || {};
    }
  });

  const supplierIds = [...new Set(Object.keys(offers).map((id) => offers[id].supplierId).filter((s) => typeof s === 'string' && s))];
  const accounts = {};
  (await getMany(db, supplierIds.map((id) => accountRef(db, companyId, id)))).forEach((s) => { if (s.exists) accounts[s.id] = s.data() || {}; });

  // 4. Derive the server fields.
  const work = [];
  for (let i = 0; i < n; i++) {
    const c = clean[i];
    if (!c) continue;
    const offer = offers[c.offerId];
    if (!offer) { results[i] = { i, status: 'rejected', reason: 'unknown_offer' }; continue; }
    const account = accounts[offer.supplierId] || null;
    if (c.locationId !== null && !((account && account.locations) || []).some((loc) => loc && loc.id === c.locationId)) {
      results[i] = { i, status: 'rejected', reason: 'unknown_location' }; continue;
    }
    // A receipt's store number names a branch only when the account lists it; an
    // unlisted store is simply no branch.
    if (c.locationId === null && c.storeNumber) {
      const hit = ((account && account.locations) || []).find((loc) => loc && loc.storeNumber === c.storeNumber);
      if (hit) c.locationId = hit.id;
    }
    const doc = deriveObservation(c, offer, account, ctx);
    doc.createdAt = FieldValue.serverTimestamp();
    // A row that names its document is the same fact every time it is sent; a bare typed price is not.
    const id = (doc.source.channel !== 'manual' || doc.doc.ref) ? L.obsIdFor(doc) : null;
    work.push({ i, id, doc });
  }

  // 5. Write. One duplicate never fails another row. Rows sharing an id go one after another.
  const groups = {};
  const order = [];
  work.forEach((w) => {
    const key = w.id === null ? 'auto:' + w.i : w.id;
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(w);
  });
  const touched = new Set();
  await inPool(order, WRITE_PARALLEL, async (key) => {
    for (const w of groups[key]) {
      const r = await createObservation(db, companyId, w.id, w.doc);
      results[w.i] = Object.assign({ i: w.i }, r);
      if (r.status === 'written') {
        touched.add(w.doc.offerId);
        if (w.doc.catalogMicros === null) results[w.i].needsUnit = true;
      }
    }
  });

  // 6. Rebuild the summary of every offer that got a new row.
  await inPool([...touched], RECOMPUTE_PARALLEL, (offerId) => recomputeLatest(db, companyId, offerId, nowMs));

  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    results,
    written: count('written'), duplicates: count('duplicate'), rejected: count('rejected'),
    needsUnit: results.filter((r) => r.needsUnit === true || r.reason === 'needs_unit').length,
    alertsOpened: 0,
  };
}

/** One append-only audit row. */
async function writeAudit(db, companyId, entry) {
  assertCompany(companyId);
  const ref = auditCol(db, companyId).doc();
  await ref.create({
    v: 1, type: entry.type, targetType: entry.targetType, targetId: entry.targetId,
    detail: entry.detail || null,
    actor: { uid: entry.actor.uid, role: entry.actor.role },
    createdAt: FieldValue.serverTimestamp(),
  });
  return ref.id;
}

const bad = (reason) => ({ ok: false, reason });
const samePack = (a, b) => !!a && !!b && a.status === b.status && a.purchaseUnit === b.purchaseUnit && a.catalogUnit === b.catalogUnit && a.num === b.num && a.den === b.den;
const stamp = (caller) => ({ updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid });

/**
 * A product's unit and sells, as the approval guards need them: the company's own
 * library row when it holds one (a product it added or edited), else the published
 * catalog's (functions/product-seed-public.json). A product the company deleted is
 * not found. Pure apart from the seed file.
 */
function productOf(productId, library) {
  const lib = library || {};
  if (Array.isArray(lib.deleted) && lib.deleted.indexOf(productId) !== -1) return null;
  const own = lib.items && lib.items[productId];
  if (own && typeof own === 'object') return { id: productId, unit: own.unit || null, pricing: own.pricing || {} };
  const pub = seed()[productId];
  if (!pub) return null;
  const pricing = {};
  ['good', 'better', 'best'].forEach((t) => { pricing[t] = { sell: pub.sell ? pub.sell[t] : null }; });
  return { id: productId, unit: pub.unit, pricing };
}

async function readOffer(db, companyId, offerId) {
  if (typeof offerId !== 'string' || !ID_RE.test(offerId)) return null;
  const snap = await offerRef(db, companyId, offerId).get();
  return snap.exists ? snap : null;
}

/**
 * The priceLedgerSave operations. Each takes (db, companyId, data, caller, nowMs)
 * and answers { ok: true, id } or { ok: false, reason }. They write named fields
 * with update() (create() for a new document) and never send `latest`,
 * `nextCheckMs`, `createdAt` or `createdBy` on an update.
 */
const saveOps = {
  async upsertSupplierAccount(db, companyId, data, caller) {
    assertCompany(companyId);
    const s = L.sanitizeSupplierAccount(data);
    if (!s.ok) return bad(s.reason);
    const ref = accountRef(db, companyId, s.value.supplierId);
    const snap = await ref.get();
    if (snap.exists) await ref.update(Object.assign({}, s.value, stamp(caller)));
    else {
      await ref.create(Object.assign({}, s.value, {
        link: { status: 'none', mode: 'none', linkedAtMs: null, lastOkAtMs: null, lastErrorCode: null },
        createdAt: FieldValue.serverTimestamp(), createdBy: caller.uid,
      }, stamp(caller)));
    }
    return { ok: true, id: s.value.supplierId };
  },

  async upsertOffer(db, companyId, data, caller, nowMs) {
    assertCompany(companyId);
    const s = L.sanitizeOffer(data);
    if (!s.ok) return bad(s.reason);
    const v = s.value;
    const acct = await accountRef(db, companyId, v.supplierId).get();
    if (!acct.exists) return bad('unknown_supplier_account');
    const editing = data && data.offerId != null;
    const id = editing ? data.offerId : L.offerIdFor(v.supplierId, v.sku, v.title, v.pack.purchaseUnit);
    if (typeof id !== 'string' || !ID_RE.test(id)) return bad('bad_offer');
    const ref = offerRef(db, companyId, id);
    const snap = await ref.get();
    if (!snap.exists) {
      if (editing) return bad('not_found');
      await ref.create(Object.assign({}, v, {
        photo: null, latest: null, nextCheckMs: null,
        createdAt: FieldValue.serverTimestamp(), createdBy: caller.uid,
      }, stamp(caller)));
      return { ok: true, id };
    }
    const cur = snap.data() || {};
    if (cur.supplierId !== v.supplierId || cur.sku !== v.sku) return bad('immutable');
    const packChanged = !samePack(cur.pack, v.pack);
    const pack = packChanged ? v.pack : Object.assign({}, v.pack, { verified: cur.pack.verified === true, verifiedBy: cur.pack.verifiedBy || null, verifiedAtMs: cur.pack.verifiedAtMs || null });
    await ref.update(Object.assign({
      skuKind: v.skuKind, altIds: v.altIds, title: v.title, brand: v.brand, url: v.url, productId: v.productId,
      variant: v.variant, tiers: v.tiers, match: v.match, pack, watch: v.watch, active: v.active,
    }, stamp(caller)));
    if (packChanged) await recomputeLatest(db, companyId, id, nowMs);
    return { ok: true, id };
  },

  async linkOffer(db, companyId, data, caller) {
    assertCompany(companyId);
    data = data || {};
    const snap = await readOffer(db, companyId, data.offerId);
    if (!snap) return bad('not_found');
    let productId = null;
    if (data.productId != null && data.productId !== '') {
      if (typeof data.productId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(data.productId)) return bad('bad_product');
      productId = data.productId;
    }
    const patch = { productId };
    // Slice 4 (Jo's Q3): which tiers of the product this item is bought for, ticked on the link form.
    if (data.tiers != null) {
      if (!Array.isArray(data.tiers) || !data.tiers.length || data.tiers.length > 3) return bad('bad_tiers');
      const tiers = [];
      for (const t of data.tiers) {
        if (['good', 'better', 'best'].indexOf(t) === -1) return bad('bad_tiers');
        if (tiers.indexOf(t) === -1) tiers.push(t);
      }
      patch.tiers = tiers;
    }
    if (data.match != null) {
      if (['exact', 'equivalent', 'comparable'].indexOf(data.match) === -1) return bad('bad_match');
      patch.match = data.match;
    }
    await snap.ref.update(Object.assign(patch, stamp(caller)));
    await writeAudit(db, companyId, { type: productId ? 'link' : 'unlink', targetType: 'offer', targetId: snap.id, detail: { productId, match: patch.match || null, tiers: patch.tiers || null }, actor: caller });
    return { ok: true, id: snap.id };
  },

  async verifyPack(db, companyId, data, caller, nowMs) {
    assertCompany(companyId);
    data = data || {};
    const snap = await readOffer(db, companyId, data.offerId);
    if (!snap) return bad('not_found');
    let pack = (snap.data() || {}).pack;
    if (data.pack != null) {
      const s = L.sanitizePack(data.pack);
      if (!s.ok) return bad(s.reason);
      pack = s.value;
    }
    if (!L.validPack(pack)) return bad('needs_unit');
    const verified = Object.assign({}, pack, { verified: true, verifiedBy: caller.uid, verifiedAtMs: nowMs });
    await snap.ref.update(Object.assign({ pack: verified }, stamp(caller)));
    await writeAudit(db, companyId, { type: 'conversion_verified', targetType: 'offer', targetId: snap.id, detail: { purchaseUnit: verified.purchaseUnit, catalogUnit: verified.catalogUnit, num: verified.num, den: verified.den }, actor: caller });
    await recomputeLatest(db, companyId, snap.id, nowMs);
    return { ok: true, id: snap.id };
  },

  async archiveOffer(db, companyId, data, caller) {
    assertCompany(companyId);
    data = data || {};
    const snap = await readOffer(db, companyId, data.offerId);
    if (!snap) return bad('not_found');
    await snap.ref.update(Object.assign({ active: data.active === true }, stamp(caller)));
    return { ok: true, id: snap.id };
  },

  /**
   * Slice 3: mark an on-screen alert seen. One shared list for the owner and company
   * admins: { marks: { <alertId>: { o: <newest obsId>, at } } }. The alert comes back
   * when a newer price arrives (its obsId no longer matches). Capped at 2000 marks;
   * the oldest goes first.
   */
  async markSeen(db, companyId, data, caller, nowMs) {
    assertCompany(companyId);
    const s = L.sanitizeSeenMark(data);
    if (!s.ok) return bad(s.reason);
    const ref = seenRef(db, companyId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const marks = Object.assign({}, (snap.exists && (snap.data() || {}).marks) || {});
      marks[s.value.alertId] = { o: s.value.obsId, at: nowMs };
      const keys = Object.keys(marks);
      if (keys.length > SEEN_MAX) {
        keys.sort((a, b) => (Number(marks[a] && marks[a].at) || 0) - (Number(marks[b] && marks[b].at) || 0));
        keys.slice(0, keys.length - SEEN_MAX).forEach((k) => { delete marks[k]; });
      }
      tx.set(ref, Object.assign({ marks }, stamp(caller)));
    });
    return { ok: true, id: s.value.alertId };
  },

  /**
   * Slice 4: approve one supplier price into the company's cost book, line by line
   * (one line per tier the item is for). data: { productId, offerId, obsId,
   * lines: [{ tier, fromCents, toCents }] (what the person saw), confirmBelowFloor,
   * confirmAboveSell, note }. In one transaction the server rebuilds every line from
   * the stored price, the cost book, the product and the company's settings, and
   * writes only if each asked line still matches and its guards pass: all the lines
   * or none. It writes `catalogCosts.costs.<productId>.cost.<tier>` and nothing else in
   * that document, one audit row, and productLinks/{productId}.applied.<tier> (what
   * tells the company's other devices). Never a sell, never labor, never another map.
   */
  async approveCost(db, companyId, data, caller, nowMs) {
    assertCompany(companyId);
    data = data || {};
    const productId = data.productId;
    if (typeof productId !== 'string' || !PRODUCT_ID_RE.test(productId)) return bad('bad_product');
    if (typeof data.offerId !== 'string' || !ID_RE.test(data.offerId) || typeof data.obsId !== 'string' || !ID_RE.test(data.obsId)) return bad('changed');
    const asked = Array.isArray(data.lines) ? data.lines : [];
    if (asked.length < 1 || asked.length > 3) return bad('no_lines');
    const tiersAsked = new Set();
    for (const a of asked) {
      if (!a || ['good', 'better', 'best'].indexOf(a.tier) === -1 || tiersAsked.has(a.tier)) return bad('no_lines');
      if (!(a.fromCents === null || Number.isSafeInteger(a.fromCents)) || !Number.isSafeInteger(a.toCents)) return bad('changed');
      tiersAsked.add(a.tier);
    }
    const note = String(data.note == null ? '' : data.note).replace(/\s+/g, ' ').trim().slice(0, 200);
    const confirm = { confirmBelowFloor: data.confirmBelowFloor === true, confirmAboveSell: data.confirmAboveSell === true };

    return db.runTransaction(async (tx) => {
      const offerSnap = await tx.get(offerRef(db, companyId, data.offerId));
      const obsSnap = await tx.get(obsCol(db, companyId).doc(data.obsId));
      const bookSnap = await tx.get(costBookRef(db, companyId));
      const libSnap = await tx.get(libraryRef(db, companyId));
      const profSnap = await tx.get(profileRef(db, companyId));
      const linkSnap = await tx.get(linkRef(db, companyId, productId));
      if (!offerSnap.exists || !obsSnap.exists) return bad('changed');
      const offer = offerSnap.data() || {};
      if (offer.productId !== productId || offer.active === false) return bad('changed');
      const point = offer.latest && offer.latest.bestComparable;
      if (!point || point.obsId !== data.obsId) return bad('changed');
      const acctSnap = await tx.get(accountRef(db, companyId, offer.supplierId));
      const product = productOf(productId, libSnap.exists ? (libSnap.data() || {}) : null);
      if (!product) return bad('bad_product');
      const obs = rowOf(obsSnap);
      // The per-unit price comes from the offer's summary: it is re-derived from the
      // CURRENT pack, which the row's own snapshot may predate.
      const row = Object.assign({}, obs, { catalogMicros: point.catalogMicros, validThroughMs: typeof obs.validThroughMs === 'number' ? obs.validThroughMs : null });
      const profile = profSnap.exists ? (profSnap.data() || {}) : {};
      const terms = acctSnap.exists ? ((acctSnap.data() || {}).terms || null) : null;
      const book = bookSnap.exists ? (bookSnap.data() || {}) : null;
      const built = L.proposalLines({
        product, offer, row, book, nowMs,
        taxBps: L.supplierCompareSettings(profile).taxBps, floorTenths: L.marginFloorTenths(profile),
        quoteValidDays: terms && terms.quoteValidDays,
      });
      const refused = [], accepted = [];
      for (const a of asked) {
        const line = built.lines.find((l) => l.tier === a.tier);
        let reason = null;
        if (!line) reason = 'bad_tier';
        else if (line.blocked) reason = line.blocked;
        else if (line.fromCents !== a.fromCents || line.toCents !== a.toCents) reason = 'changed';
        else reason = L.costGuardRefusal(line, confirm);
        if (reason) refused.push({ tier: a.tier, reason }); else accepted.push(line);
      }
      if (refused.length) return { ok: false, reason: refused[0].reason, refused };

      const dollarsOf = (cents) => L.microsToCostBookDollars(L.centsToMicros(cents));
      const audit = auditCol(db, companyId).doc();
      const patch = {}, applied = {}, out = [];
      accepted.forEach((l) => {
        const dollars = dollarsOf(l.toCents);
        const fromDollars = l.fromCents === null ? null : dollarsOf(l.fromCents);
        patch['costs.' + productId + '.cost.' + l.tier] = dollars;
        applied[l.tier] = { atMs: nowMs, dollars, fromDollars, created: l.created, auditId: audit.id, offerId: data.offerId, obsObservedAtMs: obs.observedAtMs, undo: false };
        out.push({ tier: l.tier, dollars, fromDollars, created: l.created });
      });
      tx.update(bookSnap.ref || costBookRef(db, companyId), patch);
      tx.set(audit, {
        v: 1, type: 'cost_change_applied', targetType: 'product', targetId: productId,
        detail: {
          offerId: data.offerId, obsId: data.obsId, supplierId: offer.supplierId || null,
          patch: out.map((o) => ({ path: 'costs.' + productId + '.cost.' + o.tier, fromDollars: o.fromDollars, toDollars: o.dollars, created: o.created })),
          guard: accepted.map((l) => ({ tier: l.tier, belowFloor: l.guard.belowFloor, aboveSell: l.guard.aboveSell, marginBefore: l.guard.marginBefore, marginAfter: l.guard.marginAfter, laborKnown: l.guard.laborKnown })),
          confirmBelowFloor: confirm.confirmBelowFloor, confirmAboveSell: confirm.confirmAboveSell, note,
        },
        actor: { uid: caller.uid, role: caller.role },
        createdAt: FieldValue.serverTimestamp(),
      });
      const prior = (linkSnap.exists && (linkSnap.data() || {}).applied) || {};
      tx.set(linkSnap.ref || linkRef(db, companyId, productId), {
        productId, preferredOfferId: data.offerId, applied: Object.assign({}, prior, applied),
        updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid,
      }, { mergeFields: LINK_FIELDS });
      return { ok: true, id: audit.id, applied: out };
    });
  },

  /**
   * Slice 4: undo the last approved change on one tier (Jo, 2026-11-17). Allowed only
   * while that approval is still the last one and the cost book still holds its value;
   * otherwise `changed` and nothing is written. Puts the old cost back by the same
   * field path (or removes the tier the approval created). It does not ask about the
   * floor: it restores what was there before. Logged as cost_change_undone.
   */
  async undoCost(db, companyId, data, caller, nowMs) {
    assertCompany(companyId);
    data = data || {};
    const productId = data.productId, tier = data.tier;
    if (typeof productId !== 'string' || !PRODUCT_ID_RE.test(productId)) return bad('bad_product');
    if (['good', 'better', 'best'].indexOf(tier) === -1 || typeof data.auditId !== 'string' || !ID_RE.test(data.auditId)) return bad('changed');
    return db.runTransaction(async (tx) => {
      const lref = linkRef(db, companyId, productId);
      const linkSnap = await tx.get(lref);
      const bookSnap = await tx.get(costBookRef(db, companyId));
      const a = linkSnap.exists && ((linkSnap.data() || {}).applied || {})[tier];
      if (!a || a.undo === true || a.auditId !== data.auditId || !bookSnap.exists) return bad('changed');
      const entry = (((bookSnap.data() || {}).costs || {})[productId]) || null;
      const cur = entry && entry.cost ? entry.cost[tier] : undefined;
      const centsOf = (d) => L.microsToCents(L.dollarsToMicros(d));
      if (typeof cur !== 'number' || typeof a.dollars !== 'number' || centsOf(cur) !== centsOf(a.dollars)) return bad('changed');
      const path = 'costs.' + productId + '.cost.' + tier;
      const back = a.created === true || typeof a.fromDollars !== 'number' ? null : a.fromDollars;
      const patch = {};
      patch[path] = back === null ? FieldValue.delete() : back;
      tx.update(bookSnap.ref || costBookRef(db, companyId), patch);
      const audit = auditCol(db, companyId).doc();
      tx.set(audit, {
        v: 1, type: 'cost_change_undone', targetType: 'product', targetId: productId,
        detail: { undoes: data.auditId, path, fromDollars: cur, toDollars: back, removed: back === null },
        actor: { uid: caller.uid, role: caller.role },
        createdAt: FieldValue.serverTimestamp(),
      });
      const ld = linkSnap.data() || {};
      const appliedNext = Object.assign({}, ld.applied || {});
      appliedNext[tier] = { atMs: nowMs, dollars: back, fromDollars: cur, created: false, auditId: audit.id, undoes: data.auditId, undo: true };
      tx.set(lref, {
        productId, preferredOfferId: ld.preferredOfferId || null, applied: appliedNext,
        updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid,
      }, { mergeFields: LINK_FIELDS });
      return { ok: true, id: audit.id, applied: [{ tier, dollars: back, fromDollars: cur, undo: true }] };
    });
  },

  /**
   * Product photos (2026-11-18, Jo: owner and admins add them; shown on the product
   * card and the Stores & prices sheet, inside the CRM only). data: { target:
   * 'product' | 'offer', id, image: 'data:image/...;base64,...' } to add or replace,
   * or { target, id, remove: true }. The image is re-encoded on the server (proves it
   * is an image, drops EXIF and GPS, at most 640 px, WebP) and stored at
   * product-photos/{companyId}/{id}/{sha}.webp. A product's photo lives on
   * productLinks/{productId}.photo (never on the product row), an item's on the
   * offer. The replaced file is deleted. Never a download URL: the screen reads it
   * with getBlob.
   */
  async savePhoto(db, companyId, data, caller, nowMs) {
    assertCompany(companyId);
    data = data || {};
    const target = data.target, id = data.id;
    if (target !== 'product' && target !== 'offer') return bad('bad_photo_target');
    if (typeof id !== 'string' || !(target === 'product' ? PRODUCT_ID_RE : ID_RE).test(id)) return bad('not_found');
    let ref, prev = null;
    if (target === 'offer') {
      const snap = await readOffer(db, companyId, id);
      if (!snap) return bad('not_found');
      ref = snap.ref; prev = (snap.data() || {}).photo || null;
    } else {
      const lib = await libraryRef(db, companyId).get();
      if (!productOf(id, lib.exists ? (lib.data() || {}) : null)) return bad('bad_product');
      ref = linkRef(db, companyId, id);
      const cur = await ref.get();
      prev = cur.exists ? ((cur.data() || {}).photo || null) : null;
    }
    let photo = null;
    if (data.remove !== true) {
      const raw = decodePhoto(data.image);
      if (!raw) return bad('photo_bad');
      if (raw.length > PHOTO_MAX_BYTES) return bad('photo_too_big');
      let out;
      try {
        out = await require('./photo-reencode').reencodePhoto(raw, 'webp', { maxEdge: PHOTO_EDGE });
      } catch (e) { return bad('photo_bad'); }
      let w = null, h = null;
      try { const meta = await require('sharp')(out).metadata(); w = meta.width || null; h = meta.height || null; } catch (_) { /* size is only for layout */ }
      const sha = require('crypto').createHash('sha256').update(out).digest('hex').slice(0, 32);
      const path = 'product-photos/' + companyId + '/' + id + '/' + sha + '.webp';
      await require('firebase-admin/storage').getStorage().bucket().file(path).save(out, { resumable: false, contentType: 'image/webp', metadata: { cacheControl: 'private, max-age=86400' } });
      photo = { path, w, h, atMs: nowMs, by: caller.uid };
    }
    if (target === 'offer') await ref.update(Object.assign({ photo }, stamp(caller)));
    else await ref.set({ productId: id, photo, updatedAt: FieldValue.serverTimestamp(), updatedBy: caller.uid }, { mergeFields: PHOTO_LINK_FIELDS });
    // The file it replaced (or the one removed): best effort, the new pointer is already written.
    if (prev && typeof prev.path === 'string' && (!photo || prev.path !== photo.path) && prev.path.indexOf('product-photos/' + companyId + '/' + id + '/') === 0) {
      try { await require('firebase-admin/storage').getStorage().bucket().file(prev.path).delete({ ignoreNotFound: true }); } catch (_) { /* an orphan file is harmless: nothing points at it */ }
    }
    await writeAudit(db, companyId, { type: photo ? 'photo_saved' : 'photo_removed', targetType: target, targetId: id, detail: { w: photo ? photo.w : null, h: photo ? photo.h : null }, actor: caller });
    return { ok: true, id };
  },

  async voidObservation(db, companyId, data, caller, nowMs) {
    assertCompany(companyId);
    data = data || {};
    if (typeof data.obsId !== 'string' || !ID_RE.test(data.obsId)) return bad('not_found');
    const ref = obsCol(db, companyId).doc(data.obsId);
    const snap = await ref.get();
    if (!snap.exists) return bad('not_found');
    const cur = snap.data() || {};
    if (cur.voided === true) return { ok: true, id: snap.id };
    const reason = String(data.reason == null ? '' : data.reason).replace(/\s+/g, ' ').trim().slice(0, 200);
    await ref.update({ voided: true, voidedBy: caller.uid, voidedAtMs: nowMs, voidReason: reason });
    await writeAudit(db, companyId, { type: 'void', targetType: 'observation', targetId: snap.id, detail: { offerId: cur.offerId || null }, actor: caller });
    if (cur.offerId) await recomputeLatest(db, companyId, cur.offerId, nowMs);
    return { ok: true, id: snap.id };
  },
};

module.exports = {
  appendObservations, recomputeLatest, writeAudit, saveOps,
  DAILY_ROW_CAP, MAX_ROWS_PER_CALL,
  _internal: { deriveObservation, createObservation, rowOf, productOf },
};
