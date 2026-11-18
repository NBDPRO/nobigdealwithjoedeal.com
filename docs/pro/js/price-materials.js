/**
 * price-materials.js: the materials list at the company's own suppliers (live
 * supplier pricing slice 7, 2026-11-18, flag supplierPricing; Jo's choices).
 *
 * Loaded only when the flag is on, by dark-features.js (bundle `supplierpricing`),
 * so the dashboard's boot bytes do not grow. It wraps NBDMaterials.open
 * (js/materials-list.js, which is not edited): the list opens exactly as before,
 * then this file reads the company's supplier items and prices and repaints it.
 *
 *   - a line is priced only when exactly one library product it can be has a
 *     supplier item linked (NBDPriceLogic.materialsPricing); otherwise it keeps the
 *     estimate's quantity and says "No price yet"
 *   - the store is the supplier the company set as usual for that kind of product,
 *     else the cheapest fresh price; the quantity is whole purchase units from the
 *     item's confirmed pack size
 *   - the company's own suppliers replace the list's two built-in store names
 *   - for the owner, admins and managers only: a sales_rep reads no supplier item
 *     or price (rules, Jo 2026-11-18), so a rep's list stays exactly as
 *     materials-list.js draws it
 *   - the copied text never carries a price
 *
 * Every store or supplier string goes through esc(). No inline handlers.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var w = window;
  var FLAG = 'supplierPricing';
  var BUY_WORDS = { BDL: 'bundles', RL: 'rolls', BX: 'boxes', PC: 'pieces', EA: 'each', SHT: 'sheets', SQ: 'squares', LF: 'linear ft', SF: 'sq ft', GAL: 'gallons', PAIL: 'pails', TUBE: 'tubes', BAG: 'bags', CTN: 'cartons', PLT: 'pallets', LB: 'lb' };
  var WHY = { not_linked: 'no supplier item linked yet', ambiguous: 'more than one product matches this line', unit: 'the product is priced in another unit', no_price: 'no fresh supplier price' };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var dollars = function (n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  // Shown in whole cents: a buy list is read as dollars and cents, not as a unit price to four places.
var microsText = function (m) { var L = w.NBDPriceLogic; return L ? L.microsToText(L.centsToMicros(L.microsToCents(m))) : ''; };
  var flagOn = function () { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled(FLAG)); };

  /**
   * The list regrouped by the company's own suppliers (pure). results: one per item
   * in list order. accounts: the company's supplier accounts; supplierOf: the registry
   * lookup; distributor / retail: the list's two built-in store names. A priced line
   * moves to its supplier with the supplier's quantity, unit and price; an unpriced
   * one keeps the estimate's quantity and goes to the company's distributor or store
   * (its own account when it has exactly one of that kind, else a plain "your …").
   */
  function supplierView(list, results, accounts, supplierOf, distributor, retail) {
    var active = (accounts || []).filter(function (a) { return a && a.active !== false; });
    var idOf = function (a) { return a.supplierId || a.id; };
    var kindOf = function (a) { var reg = supplierOf ? supplierOf(idOf(a)) : null; return a.type || (reg ? reg.type : ''); };
    var labelOf = function (id) {
      var a = (accounts || []).filter(function (x) { return x && idOf(x) === id; })[0];
      if (a && a.label) return a.label;
      var reg = supplierOf ? supplierOf(id) : null;
      return reg ? reg.label : String(id || '');
    };
    var only = function (kind) { var m = active.filter(function (a) { return kindOf(a) === kind; }); return m.length === 1 ? labelOf(idOf(m[0])) : null; };
    var fallback = {};
    fallback[distributor] = only('distributor') || 'Your roofing distributor';
    fallback[retail] = only('retail') || 'Your hardware store';
    var groups = {}, order = [], k = 0, priced = 0, unpriced = 0, supplierMicros = 0, unpricedCost = 0;
    (list.groups || []).forEach(function (g) {
      (g.items || []).forEach(function (i) {
        var r = (results || [])[k++] || { state: 'no_price' };
        var store, item;
        if (r.state === 'priced') {
          store = labelOf(r.supplierId);
          item = Object.assign({}, i, { buyQty: r.buyQty, buyUnit: BUY_WORDS[r.purchaseUnit] || r.purchaseUnit, priced: true, totalMicros: r.totalMicros,
            perMicros: r.perPurchaseMicros, purchaseUnit: r.purchaseUnit, observedAtMs: r.observedAtMs, kind: r.kind, preferred: r.preferred === true });
          priced++; supplierMicros += r.totalMicros;
        } else {
          store = fallback[g.store] || g.store;
          item = Object.assign({}, i, { priced: false, why: r.state });
          unpriced++; unpricedCost += Number(i.cost) || 0;
        }
        if (!groups[store]) { groups[store] = []; order.push(store); }
        groups[store].push(item);
      });
    });
    return {
      groups: order.map(function (store) { return { store: store, items: groups[store] }; }),
      total: list.total, skipped: list.skipped, priced: priced, unpriced: unpriced, supplierMicros: supplierMicros, unpricedCost: unpricedCost,
    };
  }

  /** The list's body at the company's suppliers. showPrices: owner, admins, managers. */
  function bodyHtml(view, showPrices, taxNote) {
    var P = showPrices;
    return '<p class="ml-sub">Buy list from this estimate at your own suppliers. ' + (P ? 'Supplier prices are your latest receipts and quotes' + (taxNote ? ', tax included' : '') + '; internal only. ' : '') +
      'A line with no price yet keeps the estimate’s quantity.</p>' +
      view.groups.map(function (g) {
        return '<div class="ml-group"><div class="ml-store">' + esc(g.store) + '</div>' +
          g.items.map(function (i) {
            var meta = i.estQty + ' ' + i.estUnit + ' on the estimate' + (i.priced ? '' : ' · No price yet' + (P && WHY[i.why] ? ' (' + WHY[i.why] + ')' : ''));
            var src = (P && i.priced) ? microsText(i.perMicros) + ' per ' + String(BUY_WORDS[i.purchaseUnit] || i.purchaseUnit).replace(/s$/, '') + ' · ' +
              (i.kind === 'paid' ? 'paid' : i.kind === 'quote' ? 'quoted' : 'priced') + (typeof i.observedAtMs === 'number' ? ' ' + new Date(i.observedAtMs).toISOString().slice(0, 10) : '') + (i.preferred ? ' · your usual supplier' : '') : '';
            return '<div class="ml-row"><div class="ml-buy">' + esc(i.buyQty) + ' <span>' + esc(i.buyUnit) + '</span></div>' +
              '<div class="ml-name">' + esc(i.name) + '<div class="ml-meta">' + esc(meta) + '</div>' + (src ? '<div class="ml-meta">' + esc(src) + '</div>' : '') + '</div>' +
              '<div class="ml-cost">' + (P ? (i.priced ? esc(microsText(i.totalMicros)) : '<em>No price yet</em>') : '') + '</div></div>';
          }).join('') + '</div>';
      }).join('') +
      (P ? '<div class="ml-total">At your suppliers <strong>' + esc(microsText(view.supplierMicros)) + '</strong> for ' + esc(view.priced) + ' of ' + esc(view.priced + view.unpriced) + ' lines' +
        (view.unpriced ? '<div class="ml-meta">Not priced yet: ' + esc(view.unpriced) + ' line' + (view.unpriced === 1 ? '' : 's') + ' (the estimate assumed ' + esc(dollars(view.unpricedCost)) + ')</div>' : '') + '</div>' : '') +
      '<div class="ml-actions"><button type="button" class="ml-btn" data-mlp-action="copy">Copy list (no prices)</button><button type="button" class="ml-btn" data-ml-action="print">Print</button></div>';
  }

  var current = null;   // { overlay, view, title } of the open list

  /** Read the company's items and prices and repaint the open list. Anything missing leaves it as it was. */
  function enrich(est, lead) {
    var M = w.NBDMaterials, ov = document.getElementById('mlOverlay');
    if (!M || !ov || !flagOn()) return Promise.resolve();
    var list = M.buildList((est && Array.isArray(est.rows)) ? est.rows : []);
    if (!list.groups.length) return Promise.resolve();
    var titleEl = ov.querySelector('#mlTitle');
    var title = titleEl ? titleEl.textContent.replace(/^🧾\s*/, '') : 'Materials';
    var ready = w.NBDPriceLedger ? Promise.resolve() : (w.ScriptLoader && typeof w.ScriptLoader.loadBundle === 'function' ? w.ScriptLoader.loadBundle('estimates') : Promise.resolve());
    return ready.then(function () {
      var PL = w.NBDPriceLedger, LG = w.NBDPriceLogic, cat = w.NBD_XACT_CATALOG;
      // A sales_rep reads no supplier item or price (rules, Jo 2026-11-18): the list stays as materials-list.js drew it.
      if (!PL || !LG || !PL.enabled() || !PL.canRecord()) return null;
      var products = (w._productLib && typeof w._productLib.getProducts === 'function') ? w._productLib.getProducts() : (w.NBD_PRODUCTS || []);
      var items = [];
      list.groups.forEach(function (g) { g.items.forEach(function (i) { items.push(i); }); });
      var lines = items.map(function (i) {
        var it = cat && typeof cat.find === 'function' ? cat.find(i.code) : null;
        return { code: i.code, sub: (it && it.sub) || '', qty: i.estQty, unit: i.estUnit };
      });
      var ids = {};
      lines.forEach(function (l) { LG.materialProductsFor(l.code, l.sub, products).forEach(function (p) { ids[p.id] = true; }); });
      return Promise.all([PL.offersFor(Object.keys(ids)), PL.suppliers()]).then(function (got) {
        if (document.getElementById('mlOverlay') !== ov) return null;   // closed or reopened meanwhile
        var settings = PL.compareSettings();
        var results = LG.materialsPricing(lines, products, got[0], { nowMs: Date.now(), accounts: got[1], taxBps: settings.taxBps });
        var view = supplierView(list, results, got[1], LG.supplierOf, M.DISTRIBUTOR, M.HOME_DEPOT);
        var role = PL.role();
        var modal = ov.querySelector('.ml-modal'), head = ov.querySelector('.ml-head');
        if (!modal || !head) return null;
        while (head.nextSibling) modal.removeChild(head.nextSibling);
        var box = document.createElement('div');
        box.innerHTML = bodyHtml(view, role === 'admin' || role === 'manager', typeof settings.taxBps === 'number');
        while (box.firstChild) modal.appendChild(box.firstChild);
        current = { overlay: ov, view: view, title: title };
        return view;
      });
    });
  }

  function install() {
    var M = w.NBDMaterials;
    if (!M || M.__supplierPricing) return !!M;
    var open = M.open;
    M.open = function (est, lead) {
      var out = open.apply(this, arguments);
      current = null;
      enrich(est, lead).catch(function (e) { console.warn('[price-materials] supplier prices:', (e && e.message) || e); });
      return out;
    };
    M.__supplierPricing = true;
    return true;
  }

  if (!w._NBD_MLP_DELEGATE) {
    w._NBD_MLP_DELEGATE = true;
    document.addEventListener('click', function (ev) {
      var t = ev.target.closest && ev.target.closest('[data-mlp-action="copy"]');
      if (!t || !current || document.getElementById('mlOverlay') !== current.overlay) return;
      var text = w.NBDMaterials.toText(current.view, current.title);
      Promise.resolve().then(function () { return navigator.clipboard.writeText(text); })
        .then(function () { if (w.showToast) w.showToast('Materials list copied', 'success'); })
        .catch(function () { if (w.showToast) w.showToast('Could not copy. Select and copy by hand', 'error'); });
    });
  }

  if (!install()) document.addEventListener('DOMContentLoaded', install);
  w.NBDPriceMaterials = { supplierView: supplierView, bodyHtml: bodyHtml, enrich: enrich, install: install, FLAG: FLAG };
})();
