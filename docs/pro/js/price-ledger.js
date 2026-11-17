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
  const linkOffer = (offerId, productId, match) => save('linkOffer', { offerId, productId, match });
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

  // The Product Library may draw its cards before the flags arrive: ask for one re-render.
  w.addEventListener('nbd:flags-loaded', function () {
    try { if (enabled() && w._productLib && typeof w._productLib.render === 'function' && document.querySelector('.plx-card-foot')) w._productLib.render(); } catch (e) { warn('re-render', e); }
  });

  w.NBDPriceLedger = {
    FLAG, enabled, role, canSave, canRecord, companyKey,
    suppliers, offersFor, history, unlinked,
    saveAccount, saveOffer, linkOffer, verifyPack, archiveOffer, voidObservation, record, recordHdReceipts,
  };
})();
