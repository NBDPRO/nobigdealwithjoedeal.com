/**
 * price-book.js — the company's price book: what it actually paid, per store
 * SKU (Jo, 2026-10-02; plan: documentation/projects/STORE-PRICE-BOOK-PLAN-2026-10-02.md).
 *
 * Phase 1: every Home Depot Pro Xtra import (hd-import.js) records each line
 * item's SKU, description, unit price, quantity and date here, so the CRM
 * learns real prices from real receipts. Later phases add manual Lowe's /
 * Menards / Gulf Eagle entries, links to Product Library items, and the
 * per-job materials list that reads "last paid" from here.
 *
 * Storage: priceBook/{companyId} → { items: { [key]: entry }, updatedAt }.
 * These are COST figures: Firestore only, company-scoped, owner/company_admin
 * write (same rule as catalogCosts), never under docs/ as data.
 *
 *   entry = { store, sku, desc, lastPaidCents, lastPaidDate, timesBought,
 *             history: [{ cents, qty, date, ref, leadId }] (newest first, ≤ HISTORY_MAX),
 *             productId (kept when set) }
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const COLLECTION = 'priceBook';
  const HISTORY_MAX = 12;
  const STORES = { homedepot: 'Home Depot', lowes: "Lowe's", menards: 'Menards', gulfeagle: 'Gulf Eagle Supply', other: 'Other' };

  /** Stable map key for a store SKU: letters, digits and dashes only. */
  function keyFor(store, sku) {
    const s = String(store || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const k = String(sku == null ? '' : sku).trim().replace(/[^A-Za-z0-9-]/g, '');
    return (s && k) ? s + '_' + k : null;
  }

  /**
   * Fold purchases into a book (pure; returns a NEW items map, never mutates).
   * purchases: [{ store, sku, desc, cents, qty, date: 'YYYY-MM-DD', ref, leadId }]
   * A purchase already in an entry's history (same ref + cents) is skipped,
   * so importing the same receipt twice never double-counts. A zero-price
   * line (a free item, a return) never becomes "last paid".
   */
  function mergePurchases(items, purchases) {
    const out = {};
    Object.keys(items || {}).forEach((k) => {
      const e = items[k];
      out[k] = Object.assign({}, e, { history: Array.isArray(e && e.history) ? e.history.slice() : [] });
    });
    let added = 0;
    (purchases || []).forEach((p) => {
      const k = keyFor(p && p.store, p && p.sku);
      const cents = Math.round(Number(p && p.cents));
      if (!k || !(cents > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date || ''))) return;
      const e = out[k] || (out[k] = { store: String(p.store).toLowerCase(), sku: String(p.sku).trim(), desc: '', history: [], timesBought: 0 });
      const ref = String(p.ref || '');
      if (e.history.some((h) => h.ref === ref && h.cents === cents && ref)) return;
      e.history.push({ cents, qty: Number(p.qty) || 0, date: p.date, ref, leadId: p.leadId || null });
      e.history.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      e.history = e.history.slice(0, HISTORY_MAX);
      e.timesBought = (Number(e.timesBought) || 0) + 1;
      e.lastPaidCents = e.history[0].cents;
      e.lastPaidDate = e.history[0].date;
      if (p.desc && (!e.desc || p.date >= e.lastPaidDate)) e.desc = String(p.desc).slice(0, 160);
      added++;
    });
    return { items: out, added };
  }

  /** Home Depot receipts (hd-import rows, items carry sku) → purchases. */
  function purchasesFromHdReceipts(rows) {
    const list = [];
    (rows || []).forEach((r) => {
      (r.items || []).forEach((i) => {
        if (!i || !i.sku) return;
        list.push({ store: 'homedepot', sku: i.sku, desc: i.desc, cents: i.unitCents || i.cents, qty: i.qty, date: r.date, ref: r.key, leadId: r.leadId || null });
      });
    });
    return list;
  }

  function companyKey() {
    const c = window._userClaims || {};
    return c.companyId || (window._user && window._user.uid) || null;
  }

  async function load() {
    const id = companyKey();
    if (!id || !window.getDoc || !window.doc || !window.db) return {};
    const snap = await window.getDoc(window.doc(window.db, COLLECTION, id));
    const d = snap && snap.exists() ? (snap.data() || {}) : {};
    return (d.items && typeof d.items === 'object') ? d.items : {};
  }

  /**
   * Record purchases. Never throws: a rep without write access (owner /
   * company_admin only) or a network blip must not break the import that
   * called it — it resolves { added, error }.
   */
  async function record(purchases) {
    try {
      if (!purchases || !purchases.length) return { added: 0 };
      const id = companyKey();
      if (!id || !window.setDoc) return { added: 0, error: 'not signed in' };
      const current = await load();
      const merged = mergePurchases(current, purchases);
      if (!merged.added) return { added: 0 };
      await window.setDoc(window.doc(window.db, COLLECTION, id), {
        items: merged.items,
        updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
      }, { merge: true });
      return { added: merged.added };
    } catch (e) {
      console.warn('[price-book] record failed:', (e && (e.code || e.message)) || e);
      return { added: 0, error: (e && (e.code || e.message)) || 'failed' };
    }
  }

  window.NBDPriceBook = {
    COLLECTION, STORES, HISTORY_MAX,
    keyFor, mergePurchases, purchasesFromHdReceipts, load, record,
  };
})();
