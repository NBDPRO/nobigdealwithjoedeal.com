/**
 * estimate-preview.js — shared mobile-first estimate preview sheet.
 *
 * RoofLink-style editor rebuild, Phase 1a (2026-07-27). Before this,
 * tapping an estimate ANYWHERE (dashboard list, mobile job-detail
 * Activity tab) dropped the rep straight into the full V2 builder —
 * hostile on a phone — and the customer page's viewer modal read the
 * CLASSIC field shape (lineItems/title/amount), so a V2 estimate
 * (rows/name/grandTotal) rendered as "Untitled, $0, no lines".
 *
 * This module is the one preview surface for BOTH shapes:
 *   window.EstimatePreview.open(est, opts)
 *     est  — the estimate DOC OBJECT (caller resolves it from its own
 *            cache: window._estimates on dashboard,
 *            window._customerEstimates on customer.html)
 *     opts — { onEdit, onAssign, onDuplicate, onArchive } — an action
 *            button renders ONLY when its callback is provided, so each
 *            page offers exactly what it supports.
 *
 * Mobile: bottom sheet (slide-up, 85vh max, scrollable lines).
 * Desktop (≥720px): centered card. Backdrop tap + Esc + ✕ close.
 *
 * CSP: zero inline handlers — one delegated click listener on the
 * overlay keyed on data-ep-action; all user content escaped; styles via
 * an injected <style> tag (established module pattern — style-src
 * allows it) + inline style attributes like the rest of the app.
 */
(function () {
  'use strict';
  if (window.EstimatePreview && window.EstimatePreview.__sentinel === 'nbd-est-preview-v1') return;

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    // Cents when there are any (render-pdf's money helper does the same):
    // whole-dollar rounding left Subtotal + Tax + Rounding a dollar off Total.
    var c = Math.round(v * 100);
    var d = (c % 100 === 0) ? 0 : 2;
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  };

  // ── Normalize both estimate shapes to one view model ──────────────
  // V2:      name, addr, owner, rows[{desc,qty,rate,total}], grandTotal,
  //          tier, sq, builder:'v2', signatureStatus, leadId
  // Classic: title|name, lineItems[{description,quantity,unit,amount}],
  //          total|amount, subtotal, tax, status
  // Total = Subtotal + Tax rounded to the nearest $25 (either way), then
  // lifted to the shop minimum — print the difference so the rows foot.
  // Only alongside a printed Subtotal row.
  function adjustmentRow(v) {
    if (v.subtotal == null || v.total == null || v.subtotal === v.total) return '';
    // In cents from the printed (cent-rounded) figures, so the rows foot as shown.
    var adj = (Math.round((v.total) * 100) - Math.round((v.subtotal) * 100) - Math.round((v.tax || 0) * 100)) / 100;
    if (!adj) return '';
    return '<div class="epx-dflex-jcspacebet-p3px0"><span>' +
      ((v.minJobApplied && adj > 0) ? 'Minimum job charge adjustment' : 'Rounding') + '</span><span>' +
      (adj < 0 ? '−' : '') + money(Math.abs(adj)) + '</span></div>';
  }

  function normalize(est) {
    var lines = [];
    if (Array.isArray(est.rows) && est.rows.length) {
      lines = est.rows.map(function (r) {
        return {
          desc: r.desc || r.code || 'Item',
          qty: r.qty || (r.quantity != null ? r.quantity + ' ' + (r.unit || '') : ''),
          total: (r.total != null ? r.total : r.retailTotal)
        };
      });
    } else if (Array.isArray(est.lineItems) && est.lineItems.length) {
      lines = est.lineItems.map(function (i) {
        return {
          desc: i.description || i.name || 'Item',
          qty: i.quantity != null ? i.quantity + ' ' + (i.unit || '') : '',
          total: i.amount
        };
      });
    }
    var total = est.grandTotal != null ? est.grandTotal
      : est.total != null ? est.total
      : est.amount != null ? est.amount : 0;
    var created = '—';
    try {
      var d = est.createdAt && est.createdAt.toDate ? est.createdAt.toDate()
        : est.createdAt ? new Date(est.createdAt) : null;
      if (d && !isNaN(d.getTime())) {
        created = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      }
    } catch (e) {}
    return {
      name: est.name || est.title || est.addr || 'Untitled estimate',
      addr: est.addr || est.address || '',
      owner: est.owner || '',
      builder: (est.builder === 'v2' || est.estimateVersion === 'v2') ? 'V2' : 'CLASSIC',
      // No tier chip when no tier applies (Job Template estimate, 2026-09-25).
      tier: (window.NBDCustomerEstimateRows && typeof window.NBDCustomerEstimateRows.tierApplies === 'function'
        && window.NBDCustomerEstimateRows.tierApplies(est) === false) ? '' : (est.tier || est.tierName || ''),
      sq: est.sq != null ? Number(est.sq).toFixed(2) : null,
      status: est.status || '',
      signatureStatus: est.signatureStatus || '',
      leadId: est.leadId || null,
      lines: lines,
      subtotal: est.subtotal != null ? Number(est.subtotal) : null,
      // Classic-builder docs store taxAmount, not tax.
      tax: (function () { var t = est.tax != null ? est.tax : est.taxAmount; return t != null && Number(t) > 0 ? Number(t) : null; })(),
      minJobApplied: !!est.minJobApplied,
      total: total,
      created: created
    };
  }

  function ensureStyle() {
    if (document.getElementById('nbd-ep-style')) return;
    var st = document.createElement('style');
    st.id = 'nbd-ep-style';
    st.textContent =
      '.ep-overlay{position:fixed;inset:0;z-index:10040;background:rgba(0,0,0,.72);display:flex;align-items:flex-end;justify-content:center;}' +
      '.ep-sheet{background:var(--s,#14181f);border:1px solid var(--br,#2a2f37);border-bottom:none;border-radius:16px 16px 0 0;width:100%;max-width:640px;max-height:88vh;display:flex;flex-direction:column;animation:epUp .22s ease-out;}' +
      '@keyframes epUp{from{transform:translateY(40px);opacity:.4}to{transform:translateY(0);opacity:1}}' +
      '.ep-grab{width:40px;height:4px;border-radius:2px;background:var(--br,#333);margin:10px auto 0;flex:none;}' +
      '.ep-body{overflow-y:auto;padding:14px 18px 6px;-webkit-overflow-scrolling:touch;}' +
      '.ep-actions{display:flex;gap:8px;padding:12px 16px calc(14px + env(safe-area-inset-bottom));border-top:1px solid var(--br,#2a2f37);flex:none;}' +
      '.ep-btn{flex:1;padding:12px 8px;border-radius:9px;border:1px solid var(--br,#2a2f37);background:var(--s2,#1b2028);color:var(--t,#eee);font-family:\'Barlow Condensed\',sans-serif;font-weight:700;font-size:13px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer;}' +
      '.ep-btn.primary{background:var(--orange,#BD5728);border-color:var(--orange,#BD5728);color:#fff;}' +
      '.ep-chip{display:inline-block;padding:3px 9px;border-radius:20px;font-size:10px;font-weight:700;letter-spacing:.06em;border:1px solid var(--br,#2a2f37);color:var(--m,#98a0ab);margin-right:6px;}' +
      '@media(min-width:720px){.ep-overlay{align-items:center;padding:24px;}.ep-sheet{border-radius:14px;border-bottom:1px solid var(--br,#2a2f37);max-height:82vh;}.ep-grab{display:none;}}';
    document.head.appendChild(st);
  }

  var _escHandler = null;
  function close() {
    var ov = document.getElementById('nbd-ep-overlay');
    if (ov) ov.remove();
    if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
  }

  function open(est, opts) {
    if (!est) return;
    opts = opts || {};
    ensureStyle();
    close();

    var v = normalize(est);
    var sig = '';
    if (v.signatureStatus === 'signed') sig = '<span class="ep-chip epx-cgreen-borgreen">✓ SIGNED</span>';
    else if (v.signatureStatus === 'sent' || v.signatureStatus === 'viewed') sig = '<span class="ep-chip epx-corange-bororange">✍ AWAITING SIGN</span>';
    else if (v.signatureStatus === 'declined') sig = '<span class="ep-chip epx-cred-borred">✗ DECLINED</span>';

    var linkChip = v.leadId
      ? (v.owner ? '<span class="ep-chip">👤 ' + esc(v.owner) + '</span>' : '')
      : '<span class="ep-chip epx-corange-bororange">➕ NOT ATTACHED</span>';

    var linesHtml = v.lines.length
      ? v.lines.map(function (l) {
          return '<div class="epx-dflex-jcspacebet-gap10px">' +
            '<div class="epx-minw0"><div class="epx-fs13px-w600-ct">' + esc(l.desc) + '</div>' +
            (l.qty ? '<div class="epx-fs11px-cm-mt1px">' + esc(l.qty) + '</div>' : '') + '</div>' +
            '<div class="epx-fs13px-w700-whinowrap">' + (l.total != null ? money(l.total) : '—') + '</div></div>';
        }).join('')
      : '<div class="epx-p14px0-cm-fs12px">No line items on this estimate.</div>';

    var totalsHtml =
      (v.subtotal != null && v.subtotal !== v.total
        ? '<div class="epx-dflex-jcspacebet-p3px0"><span>Subtotal</span><span>' + money(v.subtotal) + '</span></div>' : '') +
      (v.tax != null
        ? '<div class="epx-dflex-jcspacebet-p3px0"><span>Tax</span><span>' + money(v.tax) + '</span></div>' : '') +
      adjustmentRow(v) +
      '<div class="epx-dflex-jcspacebet-aibaseline">' +
        '<span class="epx-ffbarlowco-fs14px-w800">TOTAL</span>' +
        '<span class="epx-ffbarlowco-fs28px-w800">' + money(v.total) + '</span></div>';

    var btn = function (action, label, primary) {
      return '<button type="button" class="ep-btn' + (primary ? ' primary' : '') + '" data-ep-action="' + action + '">' + label + '</button>';
    };
    var actions = '';
    if (typeof opts.onEdit === 'function') actions += btn('edit', '✎ Edit', true);
    if (!v.leadId && typeof opts.onAssign === 'function') actions += btn('assign', '👤 Attach');
    else if (typeof opts.onAssign === 'function') actions += btn('assign', '👤 Assign');
    if (typeof opts.onDuplicate === 'function') actions += btn('duplicate', '⎘ Copy');
    if (typeof opts.onArchive === 'function') actions += btn('archive', '🗄 Archive');
    actions += btn('close', 'Close');

    var ov = document.createElement('div');
    ov.className = 'ep-overlay';
    ov.id = 'nbd-ep-overlay';
    ov.innerHTML =
      '<div class="ep-sheet" role="dialog" aria-modal="true" aria-label="Estimate preview">' +
        '<div class="ep-grab"></div>' +
        '<div class="ep-body">' +
          '<div class="epx-dflex-jcspacebet-aiflexstar">' +
            '<div class="epx-minw0">' +
              '<div class="epx-ffbarlowco-fs19px-w800">' + esc(v.name) + '</div>' +
              (v.addr && v.addr !== v.name ? '<div class="epx-fs12px-cm-mt3px">' + esc(v.addr) + '</div>' : '') +
            '</div>' +
            '<button type="button" data-ep-action="close" aria-label="Close" class="epx-bgnone-bdnone-cm">✕</button>' +
          '</div>' +
          '<div class="epx-m10px04px">' + linkChip +
            '<span class="ep-chip">' + esc(v.builder) + '</span>' +
            (v.tier ? '<span class="ep-chip">' + esc(String(v.tier).toUpperCase()) + '</span>' : '') +
            (v.sq ? '<span class="ep-chip">' + esc(v.sq) + ' SQ</span>' : '') +
            sig +
            '<span class="ep-chip">' + esc(v.created) + '</span>' +
          '</div>' +
          ((Array.isArray(est.photos) && est.photos.length)
            ? '<div class="epx-dflex-gap6px-oxauto">' +
                est.photos.map(function (p) {
                  return '<img src="' + esc(p.url) + '" alt="" loading="lazy" class="epx-hei64px-r6px-fxnone">';
                }).join('') +
              '</div>'
            : '') +
          '<div class="epx-mt10px">' + linesHtml + '</div>' +
          '<div class="epx-m12px010p">' + totalsHtml + '</div>' +
        '</div>' +
        '<div class="ep-actions">' + actions + '</div>' +
      '</div>';

    // One delegated listener — backdrop, ✕, and every action button.
    ov.addEventListener('click', function (ev) {
      if (ev.target === ov) { close(); return; }
      var t = ev.target.closest('[data-ep-action]');
      if (!t) return;
      var act = t.dataset.epAction;
      if (act === 'close') { close(); return; }
      // Close first so the follow-on surface (editor, assign picker)
      // isn't stacked under the sheet.
      close();
      if (act === 'edit' && typeof opts.onEdit === 'function') opts.onEdit(est);
      else if (act === 'assign' && typeof opts.onAssign === 'function') opts.onAssign(est);
      else if (act === 'duplicate' && typeof opts.onDuplicate === 'function') opts.onDuplicate(est);
      else if (act === 'archive' && typeof opts.onArchive === 'function') opts.onArchive(est);
    });
    _escHandler = function (ev) { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', _escHandler);

    document.body.appendChild(ov);
  }

  window.EstimatePreview = { __sentinel: 'nbd-est-preview-v1', open: open, close: close,
    // Test hooks (tests/estimate-rounding-line-2026-09-28.test.js).
    _normalize: normalize, _adjustmentRow: adjustmentRow, _money: money };
})();
