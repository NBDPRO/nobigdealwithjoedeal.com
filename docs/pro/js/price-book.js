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

  // ── Viewer (Product Library → "Price book") ──────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (c) => '$' + (Number(c) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // A store's own search page for the SKU (a link, never a fetch).
  const STORE_SEARCH = {
    homedepot: (sku) => 'https://www.homedepot.com/s/' + encodeURIComponent(sku),
    lowes: (sku) => 'https://www.lowes.com/search?searchTerm=' + encodeURIComponent(sku),
    menards: (sku) => 'https://www.menards.com/main/search.html?search=' + encodeURIComponent(sku),
  };

  /**
   * Entries → display rows (pure): search on description / SKU / store,
   * newest purchase first, with the change since the previous purchase.
   */
  function viewRows(items, query) {
    const q = String(query || '').trim().toLowerCase();
    return Object.keys(items || {}).map((k) => {
      const e = items[k] || {};
      const h = Array.isArray(e.history) ? e.history : [];
      const prev = h[1] ? h[1].cents : null;
      const delta = (prev != null && e.lastPaidCents != null) ? e.lastPaidCents - prev : null;
      return { key: k, store: e.store || '', sku: e.sku || '', desc: e.desc || '', cents: e.lastPaidCents, date: e.lastPaidDate || '', times: e.timesBought || h.length, delta };
    }).filter((r) => !q || (r.desc + ' ' + r.sku + ' ' + (STORES[r.store] || r.store)).toLowerCase().indexOf(q) !== -1)
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.desc < b.desc ? -1 : 1)));
  }

  function rowHtml(r) {
    const link = STORE_SEARCH[r.store] ? ' · <a href="' + esc(STORE_SEARCH[r.store](r.sku)) + '" target="_blank" rel="noopener noreferrer">open at the store</a>' : '';
    const trend = r.delta ? ' <span class="' + (r.delta > 0 ? 'pb-trend-up' : 'pb-trend-down') + '">' + (r.delta > 0 ? '▲ ' : '▼ ') + esc(money(Math.abs(r.delta))) + '</span>' : '';
    return '<div class="pb-row">' +
      '<div class="pb-desc"><span class="pb-store">' + esc(STORES[r.store] || r.store) + '</span>' + esc(r.desc || r.sku) + '</div>' +
      '<div class="pb-price">' + esc(money(r.cents)) + trend + '</div>' +
      '<div class="pb-meta">SKU ' + esc(r.sku) + ' · last paid ' + esc(r.date) + ' · bought ' + esc(r.times) + '×' + link + '</div>' +
      '</div>';
  }

  let _items = null;
  function paint() {
    const list = document.getElementById('pbList');
    if (!list) return;
    if (_items === null) { list.innerHTML = '<div class="pb-empty">Loading…</div>'; return; }
    const q = (document.getElementById('pbSearch') || {}).value || '';
    const rows = viewRows(_items, q);
    list.innerHTML = rows.length ? rows.map(rowHtml).join('')
      : (Object.keys(_items).length ? '<div class="pb-empty">Nothing matches that search.</div>'
        : '<div class="pb-empty">No prices yet. Import your Home Depot Pro Xtra purchases (Expenses → Import Home Depot) and every SKU you bought shows up here with what you paid.</div>');
  }

  async function open() {
    close();
    const ov = document.createElement('div');
    ov.className = 'pb-overlay';
    ov.id = 'pbOverlay';
    ov.innerHTML = '<div class="pb-modal" role="dialog" aria-modal="true" aria-labelledby="pbTitle">' +
      '<div class="pb-head"><h2 class="pb-title" id="pbTitle">💲 Price book</h2><button type="button" class="pb-close" data-pb-action="close" aria-label="Close">✕</button></div>' +
      '<p class="pb-sub">What you actually paid, per store SKU, from your receipts. Internal only.</p>' +
      '<input type="search" class="pb-search" id="pbSearch" placeholder="Search item, SKU or store" autocomplete="off">' +
      '<div id="pbList"></div></div>';
    document.body.appendChild(ov);
    _items = null; paint();
    try { _items = await load(); } catch (e) { _items = {}; console.warn('[price-book] load failed:', (e && (e.code || e.message)) || e); }
    paint();
  }
  function close() { const o = document.getElementById('pbOverlay'); if (o) o.remove(); }

  if (!window._NBD_PB_DELEGATE) {
    window._NBD_PB_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest && ev.target.closest('[data-pb-action]');
      if (t) { if (t.dataset.pbAction === 'open') open(); else if (t.dataset.pbAction === 'close') close(); return; }
      if (ev.target && ev.target.id === 'pbOverlay') close();
    });
    document.addEventListener('input', (ev) => { if (ev.target && ev.target.id === 'pbSearch') paint(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('pbOverlay')) close(); });
  }

  window.NBDPriceBook = {
    COLLECTION, STORES, HISTORY_MAX,
    keyFor, mergePurchases, purchasesFromHdReceipts, load, record,
    open, close, viewRows,
  };
})();
