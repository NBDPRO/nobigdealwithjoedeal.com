// ============================================================
// NBD Pro — Supplement Builder
//
// The insurance leverage tool. Takes an original estimate,
// lets Joe add newly-discovered line items and increase
// quantities on existing lines, tracks justifications + code
// refs + photos per change, and generates a formal supplement
// letter the adjuster can approve.
//
// Data model lives in window.EstimateSupplement. Firestore
// collection: 'supplements' (leadId + parentEstimateId indexed).
//
// Depends on:
//   - NBD_XACT_CATALOG (line item lookup)
//   - NBD_LABOR (labor rate lookup)
//   - EstimateLogic (resolver + formula evaluator)
//   - EstimateFinalization (reuses helpers for HTML output)
// ============================================================

(function () {
  'use strict';
  // Data-model functions (createSupplement / recordResponse / calculateDelta)
  // are pure and require() cleanly under Node — tests/invoice-pipeline.test.js
  // requires this file to lock the createSupplement→recordResponse→invoice
  // "billable" contract. Only the window.* export + DOM/Firestore functions are
  // browser-only, so guard those on _HAS_WINDOW instead of bailing out entirely.
  var _HAS_WINDOW = typeof window !== 'undefined';

  // ═════════════════════════════════════════════════════════
  // Data model
  // ═════════════════════════════════════════════════════════

  /**
   * Create a new supplement from a parent estimate.
   *
   * @param {Object} parentEstimate - The resolved parent estimate
   * @param {Object} opts
   *   - leadId: Firestore lead ID
   *   - parentEstimateId: Firestore estimate ID
   *   - version: Supplement number (1, 2, 3…)
   *   - reason: Short reason for the supplement
   * @returns {Object} Supplement document
   */
  function createSupplement(parentEstimate, opts) {
    opts = opts || {};
    const now = new Date().toISOString();
    return {
      id: 'sup_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
      leadId: opts.leadId || null,
      parentEstimateId: opts.parentEstimateId || null,
      version: opts.version || 1,
      createdAt: now,
      updatedAt: now,
      status: 'draft',                  // draft | submitted | approved | partial | denied
      reason: opts.reason || '',

      // Snapshot of the parent estimate's line items at supplement time.
      // Saved estimates persist line items under `rows` (BOTH builders) and the
      // customer total under `grandTotal` — NOT `lines`/`total`. Reading only
      // `.total`/`.lines` left originalTotal undefined (→ NaN newGrandTotal → the
      // Firestore save threw on the undefined field, so supplements silently never
      // saved: an #881-class inert bug) and originalLineItems empty (→ the
      // quantity-adjustment path could never match a line). Coerce from whichever
      // shape the parent carries: V2 rows already split material/labor + carry a
      // numeric `quantity`; classic rows carry only a combined `rate` string
      // (treated as labor so the 25% material markup doesn't over-bill), and a
      // display `qty` like "20.00SQ" we parse a number out of.
      originalLineItems: (parentEstimate.lines || parentEstimate.rows || []).map(l => {
        const qn = Number(l.quantity);
        const quantity = (Number.isFinite(qn) && qn !== 0) ? qn : (parseFloat(String(l.qty)) || 0);
        let mat = Number(l.materialCostPerUnit) || 0;
        let lab = Number(l.laborCostPerUnit) || 0;
        if (mat === 0 && lab === 0 && l.rate != null) {
          lab = parseFloat(String(l.rate).replace(/[^0-9.]/g, '')) || 0;
        }
        return {
          code: l.code,
          name: l.name || l.desc || '',
          unit: l.unit || '',
          quantity: quantity,
          materialCostPerUnit: mat,
          laborCostPerUnit: lab,
          lineTotal: Number(l.lineTotal) || Number(l.total) || 0
        };
      }),
      originalTotal: (parentEstimate.grandTotal != null
        ? Number(parentEstimate.grandTotal)
        : Number(parentEstimate.total)) || 0,
      originalMaterial: Number(parentEstimate.materialCost) || 0,
      originalLabor: Number(parentEstimate.laborCost) || 0,

      // Changes introduced by this supplement
      addedItems: [],                    // Brand-new line items
      modifiedItems: [],                 // Quantity increases on existing items

      // Calculated totals (populated by calculateDelta)
      supplementMaterial: 0,
      supplementLabor: 0,
      supplementSubtotal: 0,
      supplementOhp: 0,
      supplementTax: 0,
      supplementTotal: 0,
      newGrandTotal: 0,
      deltaPct: 0,

      // Submission tracking
      submission: {
        submittedAt: null,
        submittedTo: null,
        adjuster: null,
        method: null,                    // email | portal | print
        respondedAt: null,
        responseStatus: null,            // approved | partial | denied
        approvedAmount: null,
        responseNotes: ''
      },

      // Settings snapshot (so the delta calc doesn't drift if Joe edits rates
      // between supplements). Prefer the PARENT estimate's OWN persisted rates
      // (estimate-v2-ui.js stores materialMarkupPct/overheadPct/profitPct per-doc)
      // so the supplement marks up material + applies OH&P at the exact percentages
      // the original scope was priced at — global settings may have changed since,
      // or the estimate may have used a per-estimate override, and pricing the
      // supplement off current globals would diverge from the scope it extends.
      // Fall back to current globals, then the hardcoded defaults in calculateDelta.
      settingsSnapshot: (function () {
        const g = (_HAS_WINDOW && window.EstimateBuilderV2) ? window.EstimateBuilderV2.loadSettings() : null;
        const pe = parentEstimate || {};
        if (pe.materialMarkupPct != null || pe.overheadPct != null || pe.profitPct != null) {
          const pick = (a, b) => (a != null ? a : (b != null ? b : null));
          return Object.assign({}, g || {}, {
            materialMarkupPct: pick(pe.materialMarkupPct, g && g.materialMarkupPct),
            overheadPct: pick(pe.overheadPct, g && g.overheadPct),
            profitPct: pick(pe.profitPct, g && g.profitPct),
            roundTo: pick(pe.roundTo, g && g.roundTo),
          });
        }
        return g;
      })(),

      meta: Object.assign({}, opts.meta || {})
    };
  }

  /**
   * Add a brand-new line item to the supplement.
   *
   * @param {Object} supplement
   * @param {Object} itemData - At minimum: code, name, unit, quantity
   *   plus justification, codeRef, photos[], materialCost, laborCost
   */
  function addItem(supplement, itemData) {
    const entry = {
      code: itemData.code,
      name: itemData.name,
      unit: itemData.unit || 'EA',
      quantity: Number(itemData.quantity) || 0,
      materialCostPerUnit: Number(itemData.materialCost) || 0,
      laborCostPerUnit: Number(itemData.laborCost) || 0,
      lineTotal: 0,
      justification: itemData.justification || '',
      codeRef: itemData.codeRef || '',
      codeRefs: itemData.codeRefs || {},
      photos: itemData.photos || [],
      requiresPhoto: !!itemData.requiresPhoto,
      reason: itemData.reason || itemData.justification || '',
      addedAt: new Date().toISOString(),
      source: itemData.source || 'manual'  // manual | catalog | ai-suggested
    };
    entry.lineTotal = entry.quantity * (entry.materialCostPerUnit + entry.laborCostPerUnit);
    supplement.addedItems.push(entry);
    supplement.updatedAt = new Date().toISOString();
    calculateDelta(supplement);
    return entry;
  }

  /**
   * Add a brand-new line item from the Xactimate catalog by code.
   * Auto-fills cost, unit, code refs from the catalog entry.
   */
  function addFromCatalog(supplement, catalogCode, overrides) {
    const cat = window.NBD_XACT_CATALOG;
    if (!cat) return null;
    const item = cat.find(catalogCode);
    if (!item) {
      console.warn('[Supplement] Catalog code not found:', catalogCode);
      return null;
    }
    const data = Object.assign({}, {
      code: item.code,
      name: item.name,
      unit: item.unit,
      quantity: overrides && overrides.quantity != null ? overrides.quantity : 1,
      materialCost: item.materialCost,
      laborCost: item.laborCost,
      justification: (overrides && overrides.justification) || item.reason || '',
      codeRefs: item.codeRefs,
      requiresPhoto: item.requiresPhoto,
      reason: item.reason,
      source: 'catalog'
    }, overrides || {});
    return addItem(supplement, data);
  }

  /**
   * Modify quantity on an existing line item from the parent estimate.
   * Tracks original vs new qty, computes delta cost.
   */
  function modifyItemQuantity(supplement, originalCode, newQuantity, justification, photos) {
    const original = supplement.originalLineItems.find(l => l.code === originalCode);
    if (!original) {
      console.warn('[Supplement] Original line item not found:', originalCode);
      return null;
    }
    const deltaQty = Number(newQuantity) - Number(original.quantity);
    if (deltaQty <= 0) {
      console.warn('[Supplement] Supplement can only increase quantity, not decrease');
      return null;
    }
    // Remove any existing modification for this code (replace)
    supplement.modifiedItems = supplement.modifiedItems.filter(m => m.originalCode !== originalCode);

    const entry = {
      originalCode: originalCode,
      name: original.name,
      unit: original.unit,
      originalQuantity: Number(original.quantity),
      newQuantity: Number(newQuantity),
      deltaQuantity: deltaQty,
      materialCostPerUnit: Number(original.materialCostPerUnit),
      laborCostPerUnit: Number(original.laborCostPerUnit),
      deltaMaterial: deltaQty * Number(original.materialCostPerUnit),
      deltaLabor: deltaQty * Number(original.laborCostPerUnit),
      deltaLineTotal: deltaQty * (Number(original.materialCostPerUnit) + Number(original.laborCostPerUnit)),
      justification: justification || '',
      photos: photos || [],
      addedAt: new Date().toISOString()
    };
    supplement.modifiedItems.push(entry);
    supplement.updatedAt = new Date().toISOString();
    calculateDelta(supplement);
    return entry;
  }

  /**
   * Remove an added item by code
   */
  function removeAddedItem(supplement, code) {
    supplement.addedItems = supplement.addedItems.filter(i => i.code !== code);
    calculateDelta(supplement);
  }

  /**
   * Remove an added item by INDEX (the modal passes the row index). Removing by
   * code deleted ALL added lines sharing that code — a rep can add the same
   * catalog code twice (different qty/justification), so code-based removal
   * dropped lines they meant to keep and under-billed the supplement. Index is
   * unambiguous.
   */
  function removeAddedItemAt(supplement, index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= supplement.addedItems.length) return;
    supplement.addedItems.splice(i, 1);
    calculateDelta(supplement);
  }

  /**
   * Remove a quantity modification by original code
   */
  function removeModification(supplement, originalCode) {
    supplement.modifiedItems = supplement.modifiedItems.filter(m => m.originalCode !== originalCode);
    calculateDelta(supplement);
  }

  /**
   * Attach a photo to an added item or a modification
   */
  function attachPhoto(supplement, targetCode, photoId, isModification) {
    const list = isModification ? supplement.modifiedItems : supplement.addedItems;
    const target = list.find(i => (isModification ? i.originalCode : i.code) === targetCode);
    if (!target) return false;
    target.photos = target.photos || [];
    if (!target.photos.includes(photoId)) target.photos.push(photoId);
    supplement.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Replace an item's photo set by INDEX (code-keyed attachPhoto breaks on
   * duplicate catalog codes — same reason removeAddedItemAt exists). The
   * picker UI passes [{id, url}] entries so the formal letter can embed the
   * actual images, not just count them.
   *
   * @param {Object} supplement
   * @param {'added'|'modified'} kind
   * @param {number} index — row index within that list
   * @param {Array<{id:string,url:string}>} photos
   */
  function setItemPhotos(supplement, kind, index, photos) {
    const list = kind === 'modified' ? supplement.modifiedItems : supplement.addedItems;
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= list.length) return false;
    list[i].photos = Array.isArray(photos) ? photos.filter(Boolean) : [];
    supplement.updatedAt = new Date().toISOString();
    return true;
  }

  // ═════════════════════════════════════════════════════════
  // Delta calculator — rolls up added + modified items
  // ═════════════════════════════════════════════════════════

  function calculateDelta(supplement) {
    const s = supplement.settingsSnapshot || ((typeof window !== 'undefined' && window.EstimateBuilderV2) ? window.EstimateBuilderV2.loadSettings() : null) || {};

    // Added items total
    let addedMat = 0, addedLab = 0;
    supplement.addedItems.forEach(item => {
      addedMat += (Number(item.quantity) || 0) * (Number(item.materialCostPerUnit) || 0);
      addedLab += (Number(item.quantity) || 0) * (Number(item.laborCostPerUnit) || 0);
      item.lineTotal = (Number(item.quantity) || 0) * ((Number(item.materialCostPerUnit) || 0) + (Number(item.laborCostPerUnit) || 0));
    });

    // Modified items delta
    let modMat = 0, modLab = 0;
    supplement.modifiedItems.forEach(mod => {
      modMat += Number(mod.deltaMaterial) || 0;
      modLab += Number(mod.deltaLabor) || 0;
    });

    supplement.supplementMaterial = addedMat + modMat;
    supplement.supplementLabor    = addedLab + modLab;

    // Apply OH&P on the delta (insurance standard)
    const overheadPct = Number(s.overheadPct != null ? s.overheadPct : 0.10);
    const profitPct   = Number(s.profitPct != null ? s.profitPct : 0.10);
    const matMarkupPct = Number(s.materialMarkupPct != null ? s.materialMarkupPct : 0.25);

    const matRetail = supplement.supplementMaterial * (1 + matMarkupPct);
    const retailPreOhp = matRetail + supplement.supplementLabor;

    supplement.supplementMatRetail = matRetail;
    supplement.supplementRetailPreOhp = retailPreOhp;
    supplement.supplementOverhead = retailPreOhp * overheadPct;
    supplement.supplementProfit   = retailPreOhp * profitPct;
    supplement.supplementOhp      = supplement.supplementOverhead + supplement.supplementProfit;
    supplement.supplementSubtotal = retailPreOhp + supplement.supplementOhp;

    // Supplements in insurance mode skip tax
    supplement.supplementTax = 0;

    // Grand total (rounded to the nearest increment, default $25). Never collapse
    // a POSITIVE supplement to $0 — a small adjuster-approved supplement must still
    // bill at least one increment (nearest-rounding of a <$12.50 subtotal → $0
    // silently dropped approved revenue).
    const roundTo = Number(s.roundTo || 25);
    const rounded = Math.round(supplement.supplementSubtotal / roundTo) * roundTo;
    supplement.supplementTotal = supplement.supplementSubtotal > 0
      ? Math.max(roundTo, rounded)
      : rounded;
    // Number() guards against a legacy/malformed originalTotal yielding NaN (which
    // would poison newGrandTotal, the formal letter, and the Firestore write).
    const origTotal = Number(supplement.originalTotal) || 0;
    supplement.newGrandTotal = origTotal + supplement.supplementTotal;
    supplement.deltaPct = origTotal > 0
      ? (supplement.supplementTotal / origTotal) * 100
      : 0;

    return supplement;
  }

  // ═════════════════════════════════════════════════════════
  // Submission tracking
  // ═════════════════════════════════════════════════════════

  function markSubmitted(supplement, submission) {
    supplement.status = 'submitted';
    supplement.submission.submittedAt = new Date().toISOString();
    supplement.submission.submittedTo = submission.submittedTo || null;
    supplement.submission.adjuster    = submission.adjuster || null;
    supplement.submission.method      = submission.method || 'email';
    supplement.updatedAt = new Date().toISOString();
    return supplement;
  }

  function recordResponse(supplement, response) {
    supplement.status = response.status || 'partial';  // approved | partial | denied
    supplement.submission.respondedAt     = new Date().toISOString();
    supplement.submission.responseStatus  = response.status;
    supplement.submission.approvedAmount  = Number(response.approvedAmount) || null;
    supplement.submission.responseNotes   = response.notes || '';
    // Per-line adjuster verdicts (RoofLink-style Requested vs Approved):
    // which items were approved / reduced / denied on a partial. The single
    // approvedAmount above stays the billable number invoice-pipeline reads.
    supplement.submission.itemDecisions   = sanitizeItemDecisions(response.itemDecisions);
    supplement.updatedAt = new Date().toISOString();
    return supplement;
  }

  /**
   * Sanitize a per-line decision list to a fixed shape (or null). Each entry
   * records the adjuster's verdict on ONE supplement line:
   *   { kind:'added'|'modified', index, code, name, requested, approved,
   *     decision:'approved'|'reduced'|'denied' }
   */
  function sanitizeItemDecisions(decisions) {
    if (!Array.isArray(decisions) || !decisions.length) return null;
    return decisions.map(d => ({
      kind: d && d.kind === 'modified' ? 'modified' : 'added',
      index: (d && Number.isInteger(Number(d.index))) ? Number(d.index) : 0,
      code: String((d && d.code) || ''),
      name: String((d && d.name) || ''),
      requested: Number(d && d.requested) || 0,
      approved: Number(d && d.approved) || 0,
      decision: (d && (d.decision === 'denied' || d.decision === 'reduced')) ? d.decision : 'approved',
    }));
  }

  // ═════════════════════════════════════════════════════════
  // Formal supplement letter (HTML output)
  // ═════════════════════════════════════════════════════════

  function formatSupplementLetter(supplement, meta) {
    meta = meta || {};
    const customer = meta.customer || {};
    const claim    = meta.claim || {};
    const est      = meta.estimate || {};

    // Per-tenant brand — mirrors EstimateFinalization.resolveBrand() so this
    // adjuster-facing letter carries the ACTIVE tenant's identity, never NBD's.
    // For NBD (or no tenant loaded) every literal below resolves byte-identical
    // to what this file shipped with. window._brand() shape:
    // { legalName, displayName, seal, tagline, contact:{phone,email,address} }.
    let _rawBrand = {};
    try { _rawBrand = (typeof window !== 'undefined' && window._brand && window._brand()) || {}; }
    catch (_) { _rawBrand = {}; }
    // NBD is decided by the signed-in company key (tenant-rules.js), never
    // the brand name (2026-10-05); the brand test is only the fallback when
    // tenant-rules is not on the page. Another company never inherits NBD's
    // name or seal: un-hydrated NBD defaults on its page read as blank.
    const _TR = (typeof window !== 'undefined') ? window.NBDTenantRules : null;
    const isNbd = (_TR && typeof _TR.isPlatformTenant === 'function')
      ? _TR.isPlatformTenant()
      : (!_rawBrand.legalName || _rawBrand.legalName === 'No Big Deal Home Solutions');
    if (!isNbd && _rawBrand.legalName === 'No Big Deal Home Solutions') _rawBrand = {};
    const _bc = _rawBrand.contact || {};
    const _b = {
      isNbd,
      legalName: _rawBrand.legalName || (isNbd ? 'No Big Deal Home Solutions' : ''),
      seal: _rawBrand.seal || _rawBrand.displayName || _rawBrand.legalName || (isNbd ? 'NBD' : ''),
      contact: { phone: _bc.phone || '', email: _bc.email || '', address: _bc.address || '' }
    };

    // NBD keeps the exact hardcoded footer/company block (byte-identical); a
    // non-NBD tenant uses its own contact block. supplement-ui.js omits
    // meta.company on purpose so this default fills the footer per-tenant.
    const company  = meta.company || (isNbd ? {
      name: 'No Big Deal Home Solutions',
      phone: '(859) 420-7382',
      email: 'JD@nobigdealwithjoedeal.com',
      address: '' // no public street address
    } : {
      name: _b.legalName,
      phone: _b.contact.phone,
      email: _b.contact.email,
      address: _b.contact.address
    });

    const EF = window.EstimateFinalization;
    if (!EF) {
      console.warn('[Supplement] EstimateFinalization not loaded, using basic output');
    }

    const escape = EF ? EF.escapeHtml : (s => String(s || ''));
    const fmtMoney = EF ? EF.fmtMoney : (n => '$' + Number(n).toFixed(2));
    const fmtMoneyBig = EF ? EF.fmtMoneyBig : (n => '$' + Math.round(Number(n)).toLocaleString());
    const fmtQty = EF ? EF.fmtQty : (n => Number(n).toFixed(2));
    const fmtDate = EF ? EF.fmtDate : (d => new Date(d).toLocaleDateString());
    const baseCSS = EF ? EF.BASE_CSS : '';

    // Per-item photo strip — when the picker attached {id,url} entries,
    // embed the actual documentation images in the letter (print-safe).
    // Legacy string photo ids only get the count badge.
    const photoStripHtml = (photos) => {
      const withUrl = (photos || []).filter(p => p && typeof p === 'object' && p.url);
      if (!withUrl.length) return '';
      return `<div style="margin-top:4px;">` + withUrl.map(p =>
        `<img src="${escape(p.url)}" alt="Documentation photo" style="height:70px;max-width:110px;object-fit:cover;border-radius:3px;margin:2px 4px 0 0;print-color-adjust:exact;-webkit-print-color-adjust:exact;page-break-inside:avoid;">`
      ).join('') + `</div>`;
    };

    // Added items table
    const addedRows = supplement.addedItems.map((item, i) => {
      const photoFlag = item.photos && item.photos.length
        ? `<span style="display:inline-block;font-size:8px;font-weight:700;color:#065f46;background:#ecfdf5;padding:2px 6px;border-radius:2px;letter-spacing:.08em;margin-left:6px;">${item.photos.length} PHOTO${item.photos.length > 1 ? 'S' : ''}</span>`
        : '';
      const codeRefText = item.codeRef || (item.codeRefs && Object.values(item.codeRefs).filter(Boolean).join(' · ')) || '';
      const codeRef = codeRefText
        ? `<div class="code-refs">${escape(codeRefText)}</div>`
        : '';
      return `
        <tr>
          <td style="font-weight:700;color:#333;">${i + 1}.</td>
          <td class="code">${escape(item.code || '')}</td>
          <td>
            <strong>${escape(item.name || '')}</strong>${photoFlag}
            <div class="reason">${escape(item.justification || item.reason || '')}</div>
            ${codeRef}
            ${photoStripHtml(item.photos)}
          </td>
          <td class="num">${fmtQty(item.quantity, item.unit)} ${escape(item.unit)}</td>
          <td class="num">${fmtMoney(item.materialCostPerUnit)}</td>
          <td class="num">${fmtMoney(item.laborCostPerUnit)}</td>
          <td class="num"><strong>${fmtMoney(item.lineTotal)}</strong></td>
        </tr>
      `;
    }).join('');

    // Modified items table
    const modifiedRows = supplement.modifiedItems.map((mod, i) => {
      const photoFlag = mod.photos && mod.photos.length
        ? `<span style="display:inline-block;font-size:8px;font-weight:700;color:#065f46;background:#ecfdf5;padding:2px 6px;border-radius:2px;letter-spacing:.08em;margin-left:6px;">${mod.photos.length} PHOTO${mod.photos.length > 1 ? 'S' : ''}</span>`
        : '';
      return `
        <tr>
          <td style="font-weight:700;color:#333;">${i + 1}.</td>
          <td class="code">${escape(mod.originalCode || '')}</td>
          <td>
            <strong>${escape(mod.name || '')}</strong>${photoFlag}
            <div class="reason">${escape(mod.justification || '')}</div>
            ${photoStripHtml(mod.photos)}
          </td>
          <td class="num">${fmtQty(mod.originalQuantity, mod.unit)} → <strong>${fmtQty(mod.newQuantity, mod.unit)}</strong></td>
          <td class="num">+${fmtQty(mod.deltaQuantity, mod.unit)} ${escape(mod.unit)}</td>
          <td class="num"><strong>${fmtMoney(mod.deltaLineTotal)}</strong></td>
        </tr>
      `;
    }).join('');

    const addedTable = supplement.addedItems.length ? `
      <h2>Newly Discovered Items</h2>
      <p style="font-size:11px;color:#555;margin-bottom:8px;">The following items were discovered during the work
      and were not visible during the original adjuster inspection. Each includes photo documentation and
      code references where applicable.</p>
      <table>
        <thead>
          <tr>
            <th style="width:30px;">#</th>
            <th style="width:100px;">Code</th>
            <th>Description & Justification</th>
            <th class="num" style="width:75px;">Qty</th>
            <th class="num" style="width:75px;">Material</th>
            <th class="num" style="width:75px;">Labor</th>
            <th class="num" style="width:85px;">Line Total</th>
          </tr>
        </thead>
        <tbody>${addedRows}</tbody>
      </table>
    ` : '';

    const modifiedTable = supplement.modifiedItems.length ? `
      <h2>Quantity Adjustments</h2>
      <p style="font-size:11px;color:#555;margin-bottom:8px;">The following line items required more material
      or labor than the original scope specified. Each adjustment includes justification and photo
      documentation.</p>
      <table>
        <thead>
          <tr>
            <th style="width:30px;">#</th>
            <th style="width:100px;">Code</th>
            <th>Description & Justification</th>
            <th class="num" style="width:120px;">Qty Change</th>
            <th class="num" style="width:80px;">Delta Qty</th>
            <th class="num" style="width:85px;">Delta Total</th>
          </tr>
        </thead>
        <tbody>${modifiedRows}</tbody>
      </table>
    ` : '';

    // Financial summary
    const summaryRows = [
      ['Original Estimate Total', fmtMoney(supplement.originalTotal)],
      ['Supplement — Material', fmtMoney(supplement.supplementMatRetail || supplement.supplementMaterial)],
      ['Supplement — Labor', fmtMoney(supplement.supplementLabor)],
      ['Supplement — Overhead', fmtMoney(supplement.supplementOverhead)],
      ['Supplement — Profit', fmtMoney(supplement.supplementProfit)],
      ['SUPPLEMENT TOTAL', fmtMoneyBig(supplement.supplementTotal), 'grand'],
      ['NEW GRAND TOTAL', fmtMoneyBig(supplement.newGrandTotal), 'grand']
    ];

    const summaryTable = `
      <h2>Supplement Financial Summary</h2>
      <table>
        <tbody>
          ${summaryRows.map(r => {
            const cls = r[2] === 'grand' ? 'grand-row' : '';
            return `<tr class="${cls}"><td colspan="5"><strong>${escape(r[0])}</strong></td><td class="num"><strong>${r[1]}</strong></td></tr>`;
          }).join('')}
        </tbody>
      </table>
      <div style="font-size:11px;color:#555;margin-top:8px;">
        Delta from original: <strong>${supplement.deltaPct.toFixed(1)}%</strong> increase
      </div>
    `;

    // "PRO" is the SaaS product's name, not the contractor's. It was appended
    // here for every tenant, so a supplement request landed on an adjuster's
    // desk reading "<Their Company> PRO". Adjusters know the contractor.
    // Mirrors brandHeaderHtml in estimate-finalization.js — logo when the
    // brand has one, name always, and a missing logo never breaks the page.
    const _supplementBrandHeader = (nbd, b) => {
      const name = nbd ? 'No Big Deal Home Solutions'
                       : escape((b && (b.displayName || b.legalName)) || '');
      let logo = '';
      try {
        const src = (typeof window !== 'undefined' && window._brandLogoSrc)
          ? window._brandLogoSrc() : '';
        if (src) logo = '<img class="brand-logo-img" src="' + escape(src) + '" alt="' + name + '"/>';
      } catch (_) { /* no logo is fine; the wrong logo is not */ }
      return logo + '<span class="brand-name">' + name + '</span>';
    };

    const header = `
      <div class="hdr">
        <div>
          <div class="brand">${_supplementBrandHeader(isNbd, _b)}</div>
          <div class="sub">Insurance Restoration Supplement</div>
          <div class="badge">Supplement #${supplement.version}</div>
        </div>
        <div class="doc-hdr">
          <div class="doc-title">Supplement Request</div>
          <div class="doc-date">${fmtDate(supplement.createdAt)}</div>
          <div class="doc-date">Supplement ID: ${escape(supplement.id)}</div>
          ${supplement.parentEstimateId ? `<div class="doc-date">Parent Est: ${escape(supplement.parentEstimateId)}</div>` : ''}
          <div class="doc-total-lbl">Supplement Total</div>
          <div class="doc-total-val">${fmtMoneyBig(supplement.supplementTotal)}</div>
        </div>
      </div>
    `;

    const claimBlock = `
      <h2>Claim Information</h2>
      <div class="field-grid">
        <div class="field"><label>Insured</label><div class="v">${escape(customer.name || '—')}</div></div>
        <div class="field"><label>Property Address</label><div class="v">${escape(customer.address || '—')}</div></div>
        <div class="field"><label>Carrier</label><div class="v">${escape(claim.carrier || '—')}</div></div>
        <div class="field"><label>Claim Number</label><div class="v">${escape(claim.number || '—')}</div></div>
        <div class="field"><label>Adjuster</label><div class="v">${escape(claim.adjuster || '—')}</div></div>
        <div class="field"><label>Date of Loss</label><div class="v">${escape(claim.dateOfLoss || '—')}</div></div>
        <div class="field"><label>Original Est. Amount</label><div class="v">${fmtMoneyBig(supplement.originalTotal)}</div></div>
        <div class="field"><label>Supplement Reason</label><div class="v">${escape(supplement.reason || 'Additional work required')}</div></div>
      </div>
    `;

    const introBlock = `
      <h2>Purpose of Supplement</h2>
      <p style="font-size:12px;color:#333;line-height:1.6;">
        Dear ${escape(claim.adjuster || 'Adjuster')},
      </p>
      <p style="font-size:12px;color:#333;line-height:1.6;margin-top:8px;">
        During the course of repair work at the above property, additional damage or
        conditions were discovered that were not visible or accessible during the original
        inspection. This supplement request documents those findings with photo evidence,
        code references where applicable, and line-item pricing consistent with the original
        scope methodology.
      </p>
      <p style="font-size:12px;color:#333;line-height:1.6;margin-top:8px;">
        We respectfully request approval of the itemized supplement below. All items are
        priced at industry-standard rates for the ${isNbd ? 'Cincinnati/Northern Kentucky' : 'local'} market.
        Photo documentation is available upon request.
      </p>
    `;

    const signBlock = `
      <h2>Acknowledgment</h2>
      <div class="sig-block">
        <div>
          <div style="height:40px;"></div>
          <div class="sig-line">Contractor — ${escape(est.preparedBy || (isNbd ? 'Joe Deal' : (_b.seal || _b.legalName)))}<br>
               ${escape(company.name)}<br>
               Date: ${fmtDate(supplement.createdAt)}</div>
        </div>
        <div>
          <div style="height:40px;"></div>
          <div class="sig-line">Adjuster Acknowledgment<br>
               ${escape(claim.adjuster || '')}<br>
               Carrier: ${escape(claim.carrier || '')}<br>
               Date: ____________________</div>
        </div>
      </div>

      <div class="terms">
        <strong>Supplement Terms:</strong> This supplement is submitted in good faith based on
        conditions discovered during active repair work. Pricing is consistent with the original
        estimate methodology and reflects current market rates. Photo documentation for each
        line item is available for inspection upon request. Thank you for your timely review.
      </div>

      <div class="footer">
        <div style="display:flex;justify-content:space-between;">
          <span>${escape(company.name)} · ${escape(company.phone)} · ${escape(company.email)}</span>
          <span>Supplement #${supplement.version} · Generated ${fmtDate(supplement.createdAt)}</span>
        </div>
      </div>
    `;

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<title>Supplement #${supplement.version} — ${escape(customer.name || (isNbd ? 'NBD' : _b.seal))} — ${fmtDate(supplement.createdAt)}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" rel="stylesheet">
<style>${baseCSS}</style>
</head><body>
${header}
${claimBlock}
${introBlock}
${addedTable}
${modifiedTable}
${summaryTable}
${signBlock}
</body></html>`;

    return {
      format: 'supplement-letter',
      html,
      version: supplement.version,
      addedCount: supplement.addedItems.length,
      modifiedCount: supplement.modifiedItems.length,
      supplementTotal: supplement.supplementTotal,
      newGrandTotal: supplement.newGrandTotal,
      deltaPct: supplement.deltaPct
    };
  }

  // ═════════════════════════════════════════════════════════
  // Firestore persistence — wired by W144 supplement-ui.js
  // ═════════════════════════════════════════════════════════

  /**
   * Save a supplement to Firestore. Auto-increments version
   * based on existing supplements for the parent estimate.
   *
   * W159 fixes:
   *   - HIGH #11: switched updatedAt + createdAt from
   *     `new Date().toISOString()` (client clock) to
   *     `serverTimestamp()` so time-ordered queries work
   *     correctly across rep clock skew.
   *   - HIGH #4: also writes a `leads/{leadId}/activity` doc of
   *     type 'supplement_created' so the customer-page timeline
   *     surfaces the supplement and W135 lead-score consumers
   *     pick up the signal.
   */
  async function saveToFirestore(supplement) {
    if (typeof window.addDoc !== 'function' || !window.db || !window.auth?.currentUser) {
      console.warn('[Supplement] Firestore not available — cannot save');
      return null;
    }
    try {
      const ts = (typeof window.serverTimestamp === 'function')
        ? window.serverTimestamp()
        : new Date().toISOString(); // last-resort fallback
      const data = Object.assign({}, supplement, {
        userId: window.auth.currentUser.uid,
        updatedAt: ts,
        // W159: stamp createdAt with server time too so the doc has
        // a sortable canonical timestamp (the supplement object's
        // own createdAt is still a client ISO string for in-memory
        // ordering — we keep that for legacy code that reads it).
        createdAtServer: ts,
      });
      const ref = await window.addDoc(
        window.collection(window.db, 'supplements'),
        data
      );

      // W159 HIGH #4: activity log entry on the lead so the
      // customer-page timeline surfaces the supplement. Skip
      // silently if the supplement has no leadId (standalone
      // supplements aren't a thing today, but defensive).
      if (supplement.leadId) {
        try {
          // calculateDelta() has already stamped supplement.supplementTotal
          // (the canonical, OH&P-applied, rounded total the modal and formal
          // letter both display). Use it so the timeline label matches. Fall
          // back to summing the real engine fields — addedItems[].lineTotal +
          // modifiedItems[].deltaLineTotal — NOT the phantom totalDelta /
          // modifications[].delta fields the engine never sets.
          const totalDelta = (typeof supplement.supplementTotal === 'number' && isFinite(supplement.supplementTotal))
            ? supplement.supplementTotal
            : ((supplement.addedItems || []).reduce((s, it) => s + (Number(it.lineTotal) || 0), 0)
              + (supplement.modifiedItems || []).reduce((s, m) => s + (Number(m.deltaLineTotal) || 0), 0));
          await window.addDoc(
            window.collection(window.db, `leads/${supplement.leadId}/activity`),
            {
              userId: window.auth.currentUser.uid,
              source: 'rep', // F-05: client-written activity must declare source:'rep'
              type: 'supplement_created',
              label: 'Supplement #' + (supplement.version || 1)
                + (totalDelta ? ' (+$' + Math.round(totalDelta).toLocaleString() + ')' : ''),
              supplementId: ref.id,
              parentEstimateId: supplement.parentEstimateId || null,
              version: supplement.version || 1,
              reason: (supplement.reason || '').slice(0, 280),
              createdAt: ts,
            }
          );
        } catch (actErr) {
          console.warn('[Supplement] activity log write failed:', actErr.message);
        }
      }
      return ref.id;
    } catch (e) {
      console.error('[Supplement] Save failed:', e);
      return null;
    }
  }

  /**
   * Get all supplements for a parent estimate, ordered by version.
   */
  async function loadForEstimate(parentEstimateId) {
    if (typeof window.getDocs !== 'function') return [];
    try {
      const q = window.query(
        window.collection(window.db, 'supplements'),
        window.where('parentEstimateId', '==', parentEstimateId),
        window.where('userId', '==', window.auth.currentUser.uid)
      );
      const snap = await window.getDocs(q);
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.version || 0) - (b.version || 0));
    } catch (e) {
      console.warn('[Supplement] Load failed:', e);
      return [];
    }
  }

  /**
   * Persist a carrier's response onto an ALREADY-SAVED supplement so it reaches
   * a billable status. This is the runtime path that was missing: supplements
   * were created 'draft' and NOTHING ever flipped them to approved/partial, so
   * invoice-pipeline.supplementBillableAmount() always returned 0 and approved
   * supplement dollars silently never made it onto the invoice (the #881 fold
   * was inert). markSubmitted()/recordResponse() above are pure in-memory
   * mutators that never touched Firestore — this writes the same field shape
   * they produce, via updateDoc.
   *
   *   - 'approved' → bills the full supplementTotal (already stored at save).
   *   - 'partial'  → bills submission.approvedAmount (the adjuster's $ figure).
   *   - 'denied'   → not billable.
   *
   * The /supplements rule already permits this: an owner update passes as long
   * as userId + parentEstimateId are unchanged (which they are here).
   *
   * @param {string} supplementId  Firestore doc id in `supplements`
   * @param {Object} response  { status:'approved'|'partial'|'denied', approvedAmount?, notes? }
   * @returns {Promise<boolean>} true on success
   */
  async function updateResponse(supplementId, response) {
    if (!supplementId || !response || !response.status) return false;
    if (typeof window.updateDoc !== 'function' || !window.db || typeof window.doc !== 'function') {
      console.warn('[Supplement] Firestore not available — cannot record response');
      return false;
    }
    const status = response.status;
    if (status !== 'approved' && status !== 'partial' && status !== 'denied') {
      console.warn('[Supplement] invalid response status:', status);
      return false;
    }
    const ts = (typeof window.serverTimestamp === 'function')
      ? window.serverTimestamp()
      : new Date().toISOString();
    // For 'partial' the adjuster approved a specific dollar figure — that is
    // the billable amount invoice-pipeline reads (submission.approvedAmount).
    // For 'approved' the full supplementTotal bills, so approvedAmount stays null.
    const approvedAmount = (status === 'partial')
      ? (Number(response.approvedAmount) || 0)
      : null;
    try {
      await window.updateDoc(
        window.doc(window.db, 'supplements', supplementId),
        {
          status: status,
          'submission.responseStatus': status,
          'submission.approvedAmount': approvedAmount,
          'submission.responseNotes': (response.notes || ''),
          // Per-line verdicts (which items the adjuster approved/reduced/
          // denied). Recorded for ANY status when provided — the audit
          // trail matters even on a full approval — null otherwise.
          'submission.itemDecisions': sanitizeItemDecisions(response.itemDecisions),
          'submission.respondedAt': ts,
          updatedAt: ts,
        }
      );
      return true;
    } catch (e) {
      console.error('[Supplement] recordResponse persist failed:', e);
      return false;
    }
  }

  /**
   * Optional: stamp that the supplement letter was sent to the carrier. NOT a
   * gate for billing — a rep can record a response without first marking it
   * sent — it only tracks the outbound step for the timeline.
   */
  async function markSubmittedRemote(supplementId, submission) {
    if (!supplementId) return false;
    if (typeof window.updateDoc !== 'function' || !window.db || typeof window.doc !== 'function') return false;
    const ts = (typeof window.serverTimestamp === 'function')
      ? window.serverTimestamp() : new Date().toISOString();
    submission = submission || {};
    try {
      await window.updateDoc(
        window.doc(window.db, 'supplements', supplementId),
        {
          status: 'submitted',
          'submission.submittedAt': ts,
          'submission.submittedTo': submission.submittedTo || null,
          'submission.adjuster': submission.adjuster || null,
          'submission.method': submission.method || 'email',
          updatedAt: ts,
        }
      );
      return true;
    } catch (e) {
      console.error('[Supplement] markSubmitted persist failed:', e);
      return false;
    }
  }

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════

  const _api = {
    createSupplement,
    addItem,
    addFromCatalog,
    modifyItemQuantity,
    removeAddedItem,
    removeAddedItemAt,
    removeModification,
    attachPhoto,
    setItemPhotos,         // index-keyed photo set ({id,url} entries — letter embeds them)
    sanitizeItemDecisions, // per-line adjuster verdict shape guard
    calculateDelta,
    markSubmitted,
    recordResponse,
    formatSupplementLetter,
    saveToFirestore,
    loadForEstimate,
    updateResponse,        // NEW: persists carrier response → billable status
    markSubmittedRemote    // NEW: optional "sent to carrier" stamp
  };
  if (_HAS_WINDOW) {
    window.EstimateSupplement = _api;
    console.log('[EstimateSupplement] Supplement builder ready.');
  }
  // Node (unit tests) require() this file to lock the createSupplement →
  // recordResponse → invoice-pipeline "billable" contract; expose the same API.
  if (typeof module !== 'undefined' && module.exports) module.exports = _api;
})();
