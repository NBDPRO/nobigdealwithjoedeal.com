/**
 * materials-list.js — the recommended materials list for a job (Jo,
 * 2026-10-02: "every single job … generates me a recommended materials list
 * with guessed or assumed pricing, material quantities, and where to buy
 * them"). Phase 3 of documentation/projects/STORE-PRICE-BOOK-PLAN-2026-10-02.md.
 *
 * Built from a SAVED estimate's rows (code, quantity, unit, materialTotal):
 *   - only material lines (materialTotal > 0) — labor, dumpsters, permits out;
 *   - the estimate quantity converted to what you BUY (bundles, rolls,
 *     10-ft pieces, sheets), always rounded UP — estimate quantities already
 *     carry waste, so none is added on top;
 *   - assumed cost = the estimate's own material cost for that line
 *     (a cost figure: internal only, never on a customer document);
 *   - where to buy = a suggested store per kind of material (roofing
 *     distributor for the roof system, Home Depot for metal and sundries).
 *
 * Pure core (buildList) is unit-tested; the modal is a thin shell.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  const DISTRIBUTOR = 'Gulf Eagle Supply';
  const HOME_DEPOT = 'Home Depot';

  // Purchase rules: [test(code, sub, unit) → { per, buyUnit, store }].
  // per = estimate units per purchase unit (e.g. 1/3 SQ per bundle).
  const RULES = [
    { test: (c, s) => /^shingles-/.test(s) && !/designer/.test(s), per: 1 / 3, buyUnit: 'bundles', store: DISTRIBUTOR, note: '3 bundles per square' },
    { test: (c, s) => s === 'shingles-designer', per: 1 / 3, buyUnit: 'bundles', store: DISTRIBUTOR, note: '3 per square — check the maker (some designer lines are 4–5)' },
    { test: (c) => /^RFG (SYN|VB-SYN)/.test(c), per: 10, buyUnit: 'rolls', store: DISTRIBUTOR, note: '10 squares per roll' },
    { test: (c) => /^RFG (IWS|RNB-MEM)/.test(c), per: 2, buyUnit: 'rolls', store: DISTRIBUTOR, note: '2 squares per roll' },
    { test: (c) => c === 'RFG 15F', per: 4, buyUnit: 'rolls', store: DISTRIBUTOR, note: '4 squares per roll' },
    { test: (c) => c === 'RFG 30F', per: 2, buyUnit: 'rolls', store: DISTRIBUTOR, note: '2 squares per roll' },
    { test: (c) => c === 'RFG STRT-TAMKO', per: 105, buyUnit: 'bundles', store: DISTRIBUTOR, note: '105 ft per bundle' },
    { test: (c, s) => s === 'starter', per: 100, buyUnit: 'bundles', store: DISTRIBUTOR, note: 'about 100 ft per bundle' },
    { test: (c) => c === 'RFG RIDG-TAMKO', per: 33.3, buyUnit: 'bundles', store: DISTRIBUTOR, note: '33 ft per bundle' },
    { test: (c, s) => s === 'ridge' || s === 'hip', per: 25, buyUnit: 'bundles', store: DISTRIBUTOR, note: 'about 25 ft per bundle' },
    { test: (c, s, u) => ['drip-edge', 'rake', 'gutter-apron', 'transition'].indexOf(s) !== -1 && u === 'LF', per: 10, buyUnit: '10-ft pieces', store: HOME_DEPOT },
    { test: (c, s, u) => s === 'valley' && c !== 'RFG VLY-CLS' && u === 'LF', per: 10, buyUnit: '10-ft pieces', store: HOME_DEPOT },
    { test: (c, s, u) => s === 'flashing' && u === 'LF', per: 10, buyUnit: '10-ft pieces', store: HOME_DEPOT },
    { test: (c, s, u) => s === 'ventilation' && u === 'LF' && /RIDG-VNT|HIP-VNT|SMT/.test(c), per: 4, buyUnit: '4-ft pieces', store: HOME_DEPOT },
    { test: (c, s, u) => s === 'decking' && u === 'SF', per: 32, buyUnit: '4×8 sheets', store: HOME_DEPOT, note: '32 sq ft per sheet' },
    { test: (c, s) => /^shingles|^metal|^wood|^tile|^slate|^low-slope/.test(s), per: 1, buyUnit: null, store: DISTRIBUTOR },
  ];
  const SKIP_CODE = /^(LAB|DSP|PRM|EQP|INS|ADM|OH)\b/;

  function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

  function subOf(code) {
    const cat = window.NBD_XACT_CATALOG;
    const it = cat && typeof cat.find === 'function' ? cat.find(code) : null;
    return it ? { sub: it.sub || '', name: it.name || '' } : { sub: '', name: '' };
  }

  /**
   * rows → { groups: [{ store, items:[{ name, code, estQty, estUnit, buyQty,
   * buyUnit, note, cost }], cost }], total, skipped }  (pure, given subOf)
   */
  function buildList(rows, lookup) {
    const find = lookup || subOf;
    const byStore = {};
    let total = 0, skipped = 0;
    (rows || []).forEach((r) => {
      if (!r) return;
      const code = String(r.code || '');
      const cost = num(r.materialTotal);
      const qty = num(r.quantity);
      if (!code || SKIP_CODE.test(code) || !(cost > 0) || !(qty > 0)) { if (code && cost > 0) skipped++; return; }
      const meta = find(code) || {};
      const unit = String(r.unit || '').toUpperCase();
      const rule = RULES.find((x) => x.test(code, meta.sub || '', unit)) || null;
      const store = rule ? rule.store : HOME_DEPOT;
      const buyQty = rule && rule.buyUnit ? Math.ceil((qty / rule.per) - 1e-9) : Math.ceil(qty * 100) / 100;
      const item = {
        name: r.desc || meta.name || code, code,
        estQty: Math.round(qty * 100) / 100, estUnit: unit,
        buyQty, buyUnit: rule && rule.buyUnit ? rule.buyUnit : unit,
        note: rule && rule.note ? rule.note : '',
        cost: Math.round(cost * 100) / 100,
      };
      (byStore[store] = byStore[store] || []).push(item);
      total += item.cost;
    });
    const order = [DISTRIBUTOR, HOME_DEPOT];
    const groups = Object.keys(byStore).sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((store) => ({
      store, items: byStore[store], cost: Math.round(byStore[store].reduce((s, i) => s + i.cost, 0) * 100) / 100,
    }));
    return { groups, total: Math.round(total * 100) / 100, skipped };
  }

  /** Plain text to paste into a text to the supplier (no prices). */
  function toText(list, title) {
    const lines = [title || 'Materials list'];
    list.groups.forEach((g) => {
      lines.push('', g.store + ':');
      g.items.forEach((i) => lines.push('- ' + i.buyQty + ' ' + i.buyUnit + ' — ' + i.name));
    });
    return lines.join('\n');
  }

  // ── modal ─────────────────────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => '$' + num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  let _last = null;

  function open(est, lead) {
    close();
    const rows = (est && Array.isArray(est.rows)) ? est.rows : [];
    const list = buildList(rows);
    const who = lead ? (((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.address || '') : '';
    const title = 'Materials — ' + (who || 'job') + (lead && lead.address ? ' (' + lead.address + ')' : '');
    _last = { list, title };
    const body = list.groups.length ? list.groups.map((g) =>
      '<div class="ml-group"><div class="ml-store">' + esc(g.store) + '<span class="ml-store-cost">' + esc(money(g.cost)) + '</span></div>' +
      g.items.map((i) => '<div class="ml-row"><div class="ml-buy">' + esc(i.buyQty) + ' <span>' + esc(i.buyUnit) + '</span></div>' +
        '<div class="ml-name">' + esc(i.name) + '<div class="ml-meta">' + esc(i.estQty + ' ' + i.estUnit + ' on the estimate' + (i.note ? ' · ' + i.note : '')) + '</div></div>' +
        '<div class="ml-cost">' + esc(money(i.cost)) + '</div></div>').join('') + '</div>').join('')
      : '<div class="ml-empty">No material lines on this estimate. A per-square quote with no roof system loaded has none — open it in the builder and load the roof system (Shingle &amp; add-ons).</div>';
    const ov = document.createElement('div');
    ov.className = 'ml-overlay'; ov.id = 'mlOverlay';
    ov.innerHTML = '<div class="ml-modal" role="dialog" aria-modal="true" aria-labelledby="mlTitle">' +
      '<div class="ml-head"><h2 class="ml-title" id="mlTitle">🧾 ' + esc(title) + '</h2><button type="button" class="ml-close" data-ml-action="close" aria-label="Close">✕</button></div>' +
      '<p class="ml-sub">Recommended buy list from this estimate. Quantities are rounded up to what you buy; costs are the estimate’s assumed material costs — internal only. Stores are suggestions.</p>' +
      body +
      (list.groups.length ? '<div class="ml-total">Assumed materials total <strong>' + esc(money(list.total)) + '</strong></div>' +
        '<div class="ml-actions"><button type="button" class="ml-btn" data-ml-action="copy">Copy list (no prices)</button><button type="button" class="ml-btn" data-ml-action="print">Print</button></div>' : '') +
      '</div>';
    document.body.appendChild(ov);
  }
  function close() { const o = document.getElementById('mlOverlay'); if (o) o.remove(); }

  async function copy() {
    if (!_last) return;
    const text = toText(_last.list, _last.title);
    try { await navigator.clipboard.writeText(text); if (window.showToast) window.showToast('Materials list copied', 'success'); }
    catch (e) { if (window.showToast) window.showToast('Could not copy — select and copy by hand', 'error'); }
  }

  if (!window._NBD_ML_DELEGATE) {
    window._NBD_ML_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target.closest && ev.target.closest('[data-ml-action]');
      if (t) {
        const a = t.dataset.mlAction;
        if (a === 'close') close(); else if (a === 'copy') copy(); else if (a === 'print') window.print();
        return;
      }
      if (ev.target && ev.target.id === 'mlOverlay') close();
    });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && document.getElementById('mlOverlay')) close(); });
  }

  window.NBDMaterials = { open, close, buildList, toText, DISTRIBUTOR, HOME_DEPOT };
})();
