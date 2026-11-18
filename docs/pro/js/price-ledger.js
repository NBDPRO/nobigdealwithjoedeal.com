/**
 * price-ledger.js: the browser side of the supplier price ledger (2026-11-17, flag
 * supplierPricing, off by default). Exposes window.NBDPriceLedger.
 *
 * Reads are plain Firestore reads under priceBook/{companyId}/… (the rules decide who
 * sees what: a permission error is an empty list here, never a thrown error). Every
 * write goes through the two callables priceLedgerSave and priceLedgerRecord; the
 * browser can not write the ledger directly.
 *
 * Nothing here changes a cost book, a sell price or an estimate. A typed price is
 * turned into integer micro-dollars with NBDPriceLogic.moneyTextToMicros, by digits,
 * so no float ever touches a price.
 *
 * Never throws into a caller: every function resolves { ok, ... } or a list.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const FLAG = 'supplierPricing';
  const BASE = 'priceBook';
  const HISTORY_MAX = 50;
  const HD_CHUNK = 500;                 // the callable's rows-per-call limit
  const callables = {};

  const LG = () => w.NBDPriceLogic;
  function enabled() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); }
  function claims() { return w._userClaims || {}; }
  function uid() { return (w._user && w._user.uid) || null; }
  function companyKey() { return claims().companyId || uid(); }
  /** What this person may do. The server decides again on every call. */
  function role() {
    const r = String(claims().role || '').toLowerCase();
    if (r === 'admin' || r === 'company_admin') return 'admin';
    if (r === 'manager') return 'manager';
    if (!r && !claims().companyId) return 'admin';       // a solo owner: no role claim, the company is the uid
    return 'none';
  }
  const canSave = () => role() === 'admin';
  const canRecord = () => role() === 'admin' || role() === 'manager';
  const warn = (what, e) => { try { console.warn('[price-ledger] ' + what + ':', (e && (e.code || e.message)) || e); } catch (_) { /* no console */ } };
  const ready = () => !!(companyKey() && w.db && w.getDocs && w.collection && w.query && w.where);

  function withId(d) { return Object.assign({ id: d.id }, d.data() || {}); }
  function ms(t) { return (t && typeof t.toMillis === 'function') ? t.toMillis() : (t && typeof t.seconds === 'number' ? new Date(0).setUTCSeconds(t.seconds) : 0); }

  /** The company's stores and suppliers. */
  async function suppliers() {
    if (!ready()) return [];
    try {
      const snap = await w.getDocs(w.collection(w.db, BASE, companyKey(), 'supplierAccounts'));
      return snap.docs.map(withId);
    } catch (e) { warn('suppliers', e); return []; }
  }

  /** The offers linked to these products (chunks of 10, the `in` limit). */
  async function offersFor(productIds) {
    const ids = (productIds || []).filter((x) => typeof x === 'string' && x);
    if (!ready() || !ids.length) return [];
    const out = [];
    try {
      for (let i = 0; i < ids.length; i += 10) {
        const snap = await w.getDocs(w.query(w.collection(w.db, BASE, companyKey(), 'priceOffers'), w.where('productId', 'in', ids.slice(i, i + 10))));
        snap.docs.forEach((d) => out.push(withId(d)));
      }
    } catch (e) { warn('offersFor', e); return []; }
    return out;
  }

  /** One offer's price rows, newest first, shaped for NBDPriceLogic. A sales rep gets an empty list (rules). */
  async function history(offerId) {
    if (!ready() || !offerId || !w.orderBy || !w.limit) return [];
    try {
      const snap = await w.getDocs(w.query(w.collection(w.db, BASE, companyKey(), 'priceObservations'),
        w.where('offerId', '==', offerId), w.orderBy('observedAt', 'desc'), w.limit(HISTORY_MAX)));
      return snap.docs.map((d) => { const r = withId(d); r.obsId = d.id; r.observedAtMs = ms(r.observedAt); r.createdAtMs = ms(r.createdAt); return r; });
    } catch (e) { warn('history', e); return []; }
  }

  async function callable(name) {
    if (callables[name]) return callables[name];
    if (!(w._httpsCallable && w._functions)) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      w._functions = w._functions || mod.getFunctions();
      w._httpsCallable = mod.httpsCallable;
    }
    callables[name] = w._httpsCallable(w._functions, name);
    return callables[name];
  }
  /** Plain words for a refused call. The server's message is already written for a person. */
  function refusal(e) {
    const code = String((e && e.code) || '').replace('functions/', '');
    const reason = e && e.details && e.details.reason;
    let message = (e && e.message) || 'That did not go through. Try again.';
    if (code === 'internal' || code === 'unknown' || !code) message = 'That did not go through. Try again.';
    return { ok: false, code, reason: reason || null, message };
  }
  async function save(op, data) {
    try {
      const fn = await callable('priceLedgerSave');
      const res = await fn({ op, data });
      return Object.assign({ ok: true }, (res && res.data) || {});
    } catch (e) { warn(op, e); return refusal(e); }
  }

  const saveAccount = (data) => save('upsertSupplierAccount', data);
  const saveOffer = (data) => save('upsertOffer', data);
  const linkOffer = (offerId, productId, match, tiers) => save('linkOffer', tiers ? { offerId, productId, match, tiers } : { offerId, productId, match });
  const verifyPack = (offerId, pack) => save('verifyPack', pack ? { offerId, pack } : { offerId });
  const archiveOffer = (offerId, active) => save('archiveOffer', { offerId, active: active === true });
  const voidObservation = (obsId, reason) => save('voidObservation', { obsId, reason });

  /**
   * Record typed prices. Each row carries `priceText` (what the person typed) or
   * `priceMicros`; text is converted by digits, and a row that does not parse is
   * reported, never sent as a guess.
   */
  async function record(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const out = [], send = [], map = [];
    list.forEach((r, i) => {
      const row = Object.assign({}, r);
      if (row.priceMicros == null && row.priceText != null) row.priceMicros = LG() ? LG().moneyTextToMicros(row.priceText) : null;
      delete row.priceText;
      if (row.priceMicros == null) { out[i] = { i, status: 'rejected', reason: 'bad_price' }; return; }
      map.push(i); send.push(row);
    });
    if (!send.length) return { ok: false, results: out, written: 0, message: 'Type the price as a number, like 11.11.' };
    try {
      const fn = await callable('priceLedgerRecord');
      const res = await fn({ rows: send });
      const data = (res && res.data) || {};
      (data.results || []).forEach((r, k) => { out[map[k]] = Object.assign({}, r, { i: map[k] }); });
      return { ok: true, results: out, written: data.written || 0, duplicates: data.duplicates || 0, rejected: (data.rejected || 0) + (list.length - send.length), needsUnit: data.needsUnit || 0 };
    } catch (e) { warn('record', e); return Object.assign(refusal(e), { results: out, written: 0 }); }
  }

  /** Offers no product is linked to yet (receipt lines for SKUs nobody has matched). 200 at most. */
  async function unlinked() {
    if (!ready() || !w.limit) return [];
    try {
      const snap = await w.getDocs(w.query(w.collection(w.db, BASE, companyKey(), 'priceOffers'), w.where('productId', '==', null), w.limit(200)));
      return snap.docs.map(withId);
    } catch (e) { warn('unlinked', e); return []; }
  }

  /**
   * Home Depot receipts (hd-import.js rows, items carry the store SKU) into the dated
   * history, beside the legacy price-book call. Does nothing unless the flag is on
   * and this person is the owner or a company admin (the server refuses a manager
   * on this channel too). Each line is built with the same expression the legacy
   * price book uses, so a line copied from the old book and the same line imported
   * again are one row. Rows carry no unit: the export has none. Never throws.
   */
  async function recordHdReceipts(receipts) {
    const out = { ok: true, skipped: false, sent: 0, written: 0, duplicates: 0, rejected: 0, needsUnit: 0 };
    try {
      if (!enabled() || !canSave() || !LG()) return Object.assign(out, { ok: false, skipped: true });
      const rows = [];
      (receipts || []).forEach((r) => {
        ((r && r.items) || []).forEach((i) => {
          if (!i || !i.sku) return;
          const row = LG().legacyPurchaseToRow({ store: 'homedepot', sku: i.sku, desc: i.desc, cents: i.unitCents || i.cents, qty: i.qty, date: r.date, ref: r.key });
          if (!row) return;
          if (r.store) row.storeNumber = String(r.store);
          if (i.internetSku) row.offer.internetSku = String(i.internetSku);
          rows.push(row);
        });
      });
      if (!rows.length) return out;
      const fn = await callable('priceLedgerRecord');
      for (let k = 0; k < rows.length; k += HD_CHUNK) {
        const chunk = rows.slice(k, k + HD_CHUNK);
        const res = await fn({ rows: chunk, channel: 'hd_csv' });
        const d = (res && res.data) || {};
        out.sent += chunk.length; out.written += d.written || 0; out.duplicates += d.duplicates || 0; out.rejected += d.rejected || 0; out.needsUnit += d.needsUnit || 0;
      }
      return out;
    } catch (e) { warn('recordHdReceipts', e); return Object.assign(out, refusal(e)); }
  }

  /** Every offer of the company (the Compare suppliers list and the import's "new item" count). 2000 at most. */
  async function allOffers() {
    if (!ready() || !w.limit) return [];
    try {
      const snap = await w.getDocs(w.query(w.collection(w.db, BASE, companyKey(), 'priceOffers'), w.limit(2000)));
      return snap.docs.map(withId);
    } catch (e) { warn('allOffers', e); return []; }
  }

  /** The shared "seen" marks as { alertId: obsId }. Owner and company admins only (rules). */
  async function seenMarks() {
    if (!ready() || !w.doc || !w.getDoc) return {};
    try {
      const snap = await w.getDoc(w.doc(w.db, BASE, companyKey(), 'priceConfig', 'seen'));
      const marks = (snap && snap.exists && snap.exists() && (snap.data() || {}).marks) || {};
      const out = {};
      Object.keys(marks).forEach((k) => { if (marks[k] && typeof marks[k].o === 'string') out[k] = marks[k].o; });
      return out;
    } catch (e) { warn('seenMarks', e); return {}; }
  }
  const markSeen = (alertId, obsId) => save('markSeen', { alertId, obsId });
  /** A product's estimate codes (2026-11-18): the codes whose materials-list lines price from it. reset: back to the starter list. */
  const setEstimateCodes = (productId, codes) => save('setEstimateCodes', { productId, codes });
  const resetEstimateCodes = (productId) => save('setEstimateCodes', { productId, reset: true });
  /** One code's ratio (2026-11-18): 1 product unit = num/den estimate units; clear removes it. */
  const setCodeRatio = (productId, code, ratio) => save('setCodeRatio', ratio ? { productId, code, num: ratio.num, den: ratio.den } : { productId, code, clear: true });

  /** One price row with its full provenance (slice 4: what Update my cost checks). Owner, admin, manager (rules). */
  async function observation(obsId) {
    if (!ready() || !obsId || !w.doc || !w.getDoc) return null;
    try {
      const d = await w.getDoc(w.doc(w.db, BASE, companyKey(), 'priceObservations', obsId));
      if (!d || !d.exists || !d.exists()) return null;
      const r = withId(d); r.obsId = d.id; r.observedAtMs = ms(r.observedAt); r.createdAtMs = ms(r.createdAt);
      return r;
    } catch (e) { warn('observation', e); return null; }
  }

  /** The company's comparison settings (companyProfile.pricing.supplierCompare) as basis points; nulls when not set. */
  function compareSettings() { return LG() ? LG().supplierCompareSettings(w._companyProfile || {}) : { taxBps: null, alertBps: null }; }

  /**
   * A supplier file's rows (NBDPriceLogic.buildImport) into the history on channel
   * csv_import, 500 a call. Owner and company admins only. onProgress(done, total)
   * after each call. Never throws.
   */
  async function importRows(rows, onProgress) {
    const out = { ok: true, sent: 0, written: 0, duplicates: 0, rejected: 0, needsUnit: 0 };
    try {
      if (!enabled() || !canSave()) return Object.assign(out, { ok: false, message: 'Only the owner or an admin can import prices.' });
      const list = Array.isArray(rows) ? rows : [];
      if (!list.length) return out;
      const fn = await callable('priceLedgerRecord');
      for (let k = 0; k < list.length; k += HD_CHUNK) {
        const chunk = list.slice(k, k + HD_CHUNK);
        const res = await fn({ rows: chunk, channel: 'csv_import' });
        const d = (res && res.data) || {};
        out.sent += chunk.length; out.written += d.written || 0; out.duplicates += d.duplicates || 0; out.rejected += d.rejected || 0; out.needsUnit += d.needsUnit || 0;
        if (typeof onProgress === 'function') { try { onProgress(out.sent, list.length); } catch (_) { /* a screen gone */ } }
      }
      return out;
    } catch (e) { warn('importRows', e); return Object.assign(out, refusal(e)); }
  }

  // ── Slice 4: approve a supplier price into the cost book ──────────────

  /** Show an approved (or undone) cost on this device: its copy of the book, and the product. */
  function applyHere(productId, applied) {
    (applied || []).forEach((a) => {
      if (!a || !a.tier) return;
      const dollars = typeof a.dollars === 'number' ? a.dollars : null;
      try { if (w.NBDCatalogCosts && typeof w.NBDCatalogCosts.noteApproved === 'function') w.NBDCatalogCosts.noteApproved(productId, a.tier, dollars); } catch (e) { warn('noteApproved', e); }
      try { if (w._productLib && typeof w._productLib.applyApprovedCost === 'function') w._productLib.applyApprovedCost(productId, a.tier, dollars); } catch (e) { warn('applyApprovedCost', e); }
    });
  }

  /**
   * Approve one supplier price into the cost book, the ticked tiers at once.
   * data: { productId, offerId, obsId, lines: [{ tier, fromCents, toCents }],
   * confirmBelowFloor, confirmAboveSell, note }. The server rebuilds every line and
   * writes all of them or none. On success this device shows the new cost at once.
   */
  async function approveCost(data) {
    if (!enabled() || !canSave()) return { ok: false, message: 'Only the owner or an admin can update a cost.' };
    const r = await save('approveCost', data);
    if (r.ok) { applyHere(data.productId, r.applied); markApplied(data.productId, r.applied); }
    return r;
  }
  /** Undo the last approved change on one tier, while the cost book still holds it. */
  async function undoCost(productId, tier, auditId) {
    if (!enabled() || !canSave()) return { ok: false, message: 'Only the owner or an admin can undo a cost change.' };
    const r = await save('undoCost', { productId, tier, auditId });
    if (r.ok) { applyHere(productId, r.applied); markApplied(productId, r.applied); }
    return r;
  }

  /** The productLinks docs (per product: the last approved cost per tier). 500 at most. */
  async function productLinks(productIds) {
    if (!ready() || !w.limit) return [];
    try {
      const c = w.collection(w.db, BASE, companyKey(), 'productLinks');
      const ids = (productIds || []).filter((x) => typeof x === 'string' && x);
      if (ids.length && w.documentId) {
        const out = [];
        for (let i = 0; i < ids.length; i += 10) (await w.getDocs(w.query(c, w.where(w.documentId(), 'in', ids.slice(i, i + 10))))).docs.forEach((d) => out.push(withId(d)));
        return out;
      }
      return (await w.getDocs(w.query(c, w.limit(500)))).docs.map(withId);
    } catch (e) { warn('productLinks', e); return []; }
  }

  // Which approvals this device has already applied: { '<productId>|<tier>': atMs }, per company.
  const markerKey = () => 'nbd_pl_applied_' + companyKey();
  function readMarkers() { try { return JSON.parse(w.localStorage.getItem(markerKey()) || '{}') || {}; } catch (_) { return {}; } }
  function writeMarkers(m) { try { w.localStorage.setItem(markerKey(), JSON.stringify(m)); } catch (_) { /* private mode: the next load checks again */ } }
  function markApplied(productId, applied) {
    const m = readMarkers();
    (applied || []).forEach((a) => { if (a && a.tier) m[productId + '|' + a.tier] = Date.now(); });
    writeMarkers(m);
  }

  /**
   * The other devices' half (design section 6 step 8). After the cost book loads,
   * an approval made elsewhere reaches a product this device has edited (which the
   * book's own hydrate deliberately leaves alone). Applied once per approval; only
   * while the book still holds that approved value, so a later edit, here or on
   * another device, wins. Flag off: productLinks is never read.
   */
  let syncing = null;
  function syncApplied() {
    if (syncing) return syncing;
    syncing = (async () => {
      if (!enabled() || !ready()) { syncing = null; return 0; }
      const CC = w.NBDCatalogCosts;
      try { if (CC && typeof CC.hydrate === 'function') await CC.hydrate(); } catch (_) { /* hydrate never rejects */ }
      const links = await productLinks();
      const book = (CC && typeof CC.get === 'function' && CC.get()) || {};
      const m = readMarkers();
      let n = 0;
      links.forEach((l) => {
        const applied = (l && l.applied) || {};
        Object.keys(applied).forEach((tier) => {
          const a = applied[tier], k = l.id + '|' + tier;
          if (!a || typeof a.atMs !== 'number' || (m[k] && m[k] >= a.atMs)) return;
          m[k] = a.atMs;
          const entry = book.costs && book.costs[l.id];
          const inBook = entry && entry.cost ? entry.cost[tier] : undefined;
          const same = (typeof a.dollars === 'number') ? (typeof inBook === 'number' && LG() && LG().bookMicros(LG().dollarsToMicros(inBook)) === LG().dollarsToMicros(a.dollars)) : (inBook === undefined);
          if (!same) return;
          try { if (w._productLib && typeof w._productLib.applyApprovedCost === 'function' && w._productLib.applyApprovedCost(l.id, tier, typeof a.dollars === 'number' ? a.dollars : null)) n++; } catch (e) { warn('sync', e); }
        });
      });
      writeMarkers(m);
      return n;
    })().catch((e) => { warn('syncApplied', e); syncing = null; return 0; });
    return syncing;
  }

  // ── Product photos (2026-11-18) ──────────────────────────────────────
  // Owner and admins add a photo to a product or a supplier item. The server
  // re-encodes it into Storage (product-photos/{companyId}/…). It is read here with
  // getBlob into a blob: URL, never a download link, and shown only inside the CRM.
  const STORAGE_SDK = '/assets/vendor/firebase/10.12.2/firebase-storage.js';
  const PHOTO_MAX = 3 * 1024 * 1024;
  const blobUrls = {};

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(fr.error || new Error('read failed'));
      fr.readAsDataURL(file);
    });
  }
  /** Save a photo for a product ('product', productId) or an item ('offer', offerId) from a picked file. */
  async function savePhoto(target, id, file) {
    if (!enabled() || !canSave()) return { ok: false, message: 'Only the owner or an admin can add a photo.' };
    if (!file || !/^image\/(png|jpeg|jpg|webp|gif)$/.test(file.type || '')) return { ok: false, message: 'Choose a JPG, PNG, WebP or GIF photo.' };
    if (file.size > PHOTO_MAX) return { ok: false, message: 'That photo is over 3 MB. Choose a smaller one.' };
    let image;
    try { image = await readAsDataUrl(file); } catch (e) { warn('readPhoto', e); return { ok: false, message: 'That file could not be read.' }; }
    const r = await save('savePhoto', { target, id, image });
    if (r.ok) linksCache = null;
    return r;
  }
  async function removePhoto(target, id) {
    if (!enabled() || !canSave()) return { ok: false, message: 'Only the owner or an admin can remove a photo.' };
    const r = await save('savePhoto', { target, id, remove: true });
    if (r.ok) linksCache = null;
    return r;
  }
  /** A blob: URL for a stored photo path, or null. Cached for the page's life. */
  async function photoUrl(path) {
    if (typeof path !== 'string' || path.indexOf('product-photos/') !== 0 || !w.storage) return null;
    if (blobUrls[path]) return blobUrls[path];
    try {
      const st = await import(STORAGE_SDK);
      const blob = await st.getBlob(st.ref(w.storage, path));
      blobUrls[path] = URL.createObjectURL(blob);
      return blobUrls[path];
    } catch (e) { warn('photo', e); return null; }
  }
  // ── Slice 9 (2026-11-18): read a supplier's PDF or photo ──────────────
  const DOC_MAX = 7 * 1024 * 1024;
  /**
   * Send a supplier document to the reader (priceDocRead). Owner and company admins.
   * Answers the reader's draft lines ({ ok, docId, read, spentUsd, capUsd }) or
   * { ok: false, message }. Nothing is saved as a price here.
   */
  async function readDocument(file, supplierId) {
    if (!enabled() || !canSave()) return { ok: false, message: 'Only the owner or an admin can read a document.' };
    // An iPhone photo (HEIC / HEIF) is accepted too (2026-11-18): many browsers report no
    // type for it, so its name decides, and the server converts it to JPEG before reading.
    const heic = !!file && (/^image\/(heic|heif)$/.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || ''));
    if (!file || (!heic && !/^(application\/pdf|image\/(png|jpeg|jpg|webp|gif))$/.test(file.type || ''))) return { ok: false, message: 'Choose a PDF, or a JPG, PNG, WebP or iPhone (HEIC) photo.' };
    if (file.size > DOC_MAX) return { ok: false, message: 'That file is over 7 MB. Choose a smaller one, or split the PDF.' };
    let dataUrl;
    try { dataUrl = await readAsDataUrl(file); } catch (e) { warn('readDocFile', e); return { ok: false, message: 'That file could not be read.' }; }
    if (heic) dataUrl = dataUrl.replace(/^data:[^;,]*(;base64,)/, 'data:image/heic$1');
    try {
      const fn = await callable('priceDocRead');
      const res = await fn({ file: dataUrl, fileName: file.name, supplierId: supplierId || null });
      return (res && res.data) || { ok: false, message: 'That did not go through. Try again.' };
    } catch (e) { warn('readDocument', e); return refusal(e); }
  }
  /** The documents the reader has read for this company, newest first (owner and company admins; rules). */
  async function priceDocs() {
    if (!ready() || !w.limit) return [];
    try {
      const snap = await w.getDocs(w.query(w.collection(w.db, BASE, companyKey(), 'priceDocs'), w.limit(50)));
      return snap.docs.map((d) => { const r = withId(d); r.createdAtMs = ms(r.createdAt); return r; }).sort((a, b) => b.createdAtMs - a.createdAtMs);
    } catch (e) { warn('priceDocs', e); return []; }
  }
  const removeDocument = (docId) => save('removeDocument', { docId });
  /** A blob: URL for a stored supplier document (never a download link), or null. */
  async function documentUrl(path) {
    if (typeof path !== 'string' || path.indexOf('price-docs/') !== 0 || !w.storage) return null;
    if (blobUrls[path]) return blobUrls[path];
    try {
      const st = await import(STORAGE_SDK);
      blobUrls[path] = URL.createObjectURL(await st.getBlob(st.ref(w.storage, path)));
      return blobUrls[path];
    } catch (e) { warn('document', e); return null; }
  }

  /** Fill every <img data-prl-photo="<path>"> under root that has no picture yet. */
  async function paintPhotos(root) {
    const imgs = Array.prototype.slice.call((root || document).querySelectorAll('img[data-prl-photo]:not([src])'));
    for (const img of imgs) {
      const url = await photoUrl(img.getAttribute('data-prl-photo'));
      if (url) img.src = url; else img.hidden = true;
    }
  }
  // The product cards: one productLinks read per page view (refreshed after a save).
  let linksCache = null;
  async function cardPhotos() {
    const slots = Array.prototype.slice.call(document.querySelectorAll('[data-prl-card-photo]:not([data-prl-done])'));
    if (!slots.length || !enabled()) return;
    slots.forEach((s) => s.setAttribute('data-prl-done', '1'));
    if (!linksCache) linksCache = productLinks();
    const links = await linksCache;
    const byId = {};
    (links || []).forEach((l) => { if (l && l.photo && l.photo.path) byId[l.id] = l.photo.path; });
    for (const s of slots) {
      const p = byId[s.getAttribute('data-prl-card-photo')];
      if (!p) continue;
      const url = await photoUrl(p);
      if (!url) continue;
      const img = document.createElement('img');
      img.className = 'prl-card-img'; img.alt = ''; img.src = url; img.loading = 'lazy';
      s.appendChild(img);
      s.hidden = false;
    }
  }
  let cardTimer = null;
  function watchCards() {
    if (typeof MutationObserver !== 'function' || !document.body) return;
    new MutationObserver(() => {
      if (cardTimer || !enabled()) return;
      cardTimer = setTimeout(() => { cardTimer = null; cardPhotos().catch((e) => warn('cardPhotos', e)); }, 150);
    }).observe(document.body, { childList: true, subtree: true });
    cardPhotos().catch((e) => warn('cardPhotos', e));
  }
  try { watchCards(); } catch (e) { warn('watchCards', e); }

  // The Product Library may draw its cards before the flags arrive: ask for one re-render.
  w.addEventListener('nbd:flags-loaded', function () {
    try { if (enabled() && w._productLib && typeof w._productLib.render === 'function' && document.querySelector('.plx-card-foot')) w._productLib.render(); } catch (e) { warn('re-render', e); }
    syncApplied();
  });
  if (enabled()) syncApplied();

  w.NBDPriceLedger = {
    FLAG, enabled, role, canSave, canRecord, companyKey,
    suppliers, offersFor, history, unlinked, allOffers, seenMarks, compareSettings,
    setEstimateCodes, resetEstimateCodes, setCodeRatio,
    saveAccount, saveOffer, linkOffer, verifyPack, archiveOffer, voidObservation, record, recordHdReceipts, importRows, markSeen,
    approveCost, undoCost, productLinks, syncApplied, observation,
    savePhoto, removePhoto, photoUrl, paintPhotos, cardPhotos,
    readDocument, priceDocs, removeDocument, documentUrl,
  };
})();
