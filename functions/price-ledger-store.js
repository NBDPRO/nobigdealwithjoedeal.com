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
    if (data.match != null) {
      if (['exact', 'equivalent', 'comparable'].indexOf(data.match) === -1) return bad('bad_match');
      patch.match = data.match;
    }
    await snap.ref.update(Object.assign(patch, stamp(caller)));
    await writeAudit(db, companyId, { type: productId ? 'link' : 'unlink', targetType: 'offer', targetId: snap.id, detail: { productId, match: patch.match || null }, actor: caller });
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
  _internal: { deriveObservation, createObservation, rowOf },
};
