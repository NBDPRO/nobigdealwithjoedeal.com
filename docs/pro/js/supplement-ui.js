/**
 * supplement-ui.js — Wave 144 (Supplement UI entry point)
 *
 * Wires the existing EstimateSupplement engine (which was a
 * fully-built, Firestore-ready module with no UI surface) into
 * an actionable button + modal flow. Engine handles createSupplement,
 * addFromCatalog, modifyItemQuantity, formatSupplementLetter, and
 * saveToFirestore. This module is the wrapper that the rep
 * actually clicks.
 *
 * UX:
 *   1. Tiny "+ Supplement" button on every estimate row in the
 *      customer-page estimates list (rendered by attaching to
 *      `.estimate-row` elements at boot + on data refresh)
 *   2. Click → full-screen modal: header (parent estimate ref +
 *      version), reason input, item picker (catalog search),
 *      list of added/modified items with delete buttons,
 *      live total + delta from parent
 *   3. Preview button → opens NBDDocViewer with formatted
 *      supplement letter HTML
 *   4. Save button → EstimateSupplement.saveToFirestore + toast
 *
 * Path-gated to customer.html (the only page where the
 * .estimate-row markup lives). dashboard.html doesn't expose
 * supplements directly — reps will navigate to the customer page
 * to trigger one.
 *
 * Public API:
 *   NBDSupplementUI.openForEstimate(estimateId, parentEstimateData)
 *   NBDSupplementUI.attachButtons()  // re-attaches on refresh
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['supplement-ui']) return;
  __NBD_LOADED['supplement-ui'] = true;

  const MODAL_ID = 'nbd-supplement-modal';
  let _currentSupplement = null;
  let _parentEstimate = null;
  let _existingVersions = 0;
  let _existingSupplements = [];   // saved supplements on this estimate (for response recording)

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }
  function _money(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '$0';
    return '$' + Math.round(n).toLocaleString();
  }

  // ─── Existing-supplement response recording ────────────────────
  // A supplement is created 'draft' and only bills once the carrier's response
  // is recorded (approved → full total; partial → the $ the adjuster approved).
  const _STATUS_META = {
    draft:     { c: '#94a3b8', label: 'Draft' },
    submitted: { c: '#eab308', label: 'Sent to carrier' },
    approved:  { c: '#22c55e', label: 'Approved' },
    partial:   { c: '#38bdf8', label: 'Partial' },
    denied:    { c: '#ef4444', label: 'Denied' },
  };
  function _statusBadge(status) {
    const m = _STATUS_META[status] || _STATUS_META.draft;
    return '<span style="display:inline-block;padding:2px 9px;border-radius:999px;font-size:11px;' +
      'font-weight:700;letter-spacing:0.03em;color:' + m.c + ';border:1px solid ' + m.c + ';' +
      'background:rgba(255,255,255,0.03);white-space:nowrap;">' + m.label + '</span>';
  }

  // Read-only per-line verdict table for an already-recorded response
  // (RoofLink-style Requested vs Approved columns).
  function _decisionsSummaryHtml(s) {
    const dec = s.submission && s.submission.itemDecisions;
    if (!dec || !dec.length) return '';
    const chip = function (d) {
      return d === 'denied' ? '<span class="sx-c-red">✗ Denied</span>'
        : d === 'reduced' ? '<span class="sx-c-gold">↓ Reduced</span>'
        : '<span class="sx-c-green">✓ Approved</span>';
    };
    const rows = dec.map(function (d) {
      return '<tr>' +
        '<td class="sx-tds">' + _esc(d.name || d.code) + '</td>' +
        '<td class="sx-tds sx-r sx-tab">' + _money(Number(d.requested) || 0) + '</td>' +
        '<td class="sx-tds sx-r sx-tab">' + (d.decision === 'denied' ? '$0' : _money(Number(d.approved) || 0)) + '</td>' +
        '<td class="sx-tds sx-r sx-nw sx-fs11">' + chip(d.decision) + '</td>' +
        '</tr>';
    }).join('');
    return '<table class="sx-table-sub">' +
      '<thead><tr class="sx-tr-caps sx-thead">' +
      '<th class="sx-ths sx-l sx-w600">Item</th>' +
      '<th class="sx-ths sx-r sx-w600">Requested</th>' +
      '<th class="sx-ths sx-r sx-w600">Approved</th>' +
      '<th class="sx-ths"></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // Editable per-line decision rows for recording a PARTIAL response —
  // uncheck what the adjuster denied, adjust approved $ per line; the
  // billable total auto-sums into the amount field.
  function _decisionEditorHtml(s) {
    const items = [];
    (s.addedItems || []).forEach(function (it, i) {
      items.push({ kind: 'added', index: i, code: it.code || '', name: it.name || '', requested: Number(it.lineTotal) || 0 });
    });
    (s.modifiedItems || []).forEach(function (m, i) {
      items.push({ kind: 'modified', index: i, code: m.originalCode || '', name: m.name || '', requested: Number(m.deltaLineTotal) || 0 });
    });
    if (!items.length) return '';
    const prior = {};
    ((s.submission && s.submission.itemDecisions) || []).forEach(function (d) { prior[d.kind + ':' + d.index] = d; });
    const rows = items.map(function (it) {
      const p = prior[it.kind + ':' + it.index];
      const on = !p || p.decision !== 'denied';
      const appr = p ? Number(p.approved) : it.requested;
      return '<div class="nbd-sup-dec-row" data-kind="' + it.kind + '" data-index="' + it.index + '" ' +
        'data-code="' + _esc(it.code) + '" data-name="' + _esc(it.name) + '" data-requested="' + it.requested + '" ' +
        'style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-top:1px solid #1a2540;">' +
        '<input type="checkbox" class="nbd-sup-dec-on sx-check"' + (on ? ' checked' : '') + '>' +
        '<div class="sx-grow">' + _esc(it.name || it.code) +
          ' <span class="sx-muted-nw">req ' + _money(it.requested) + '</span></div>' +
        '<input type="number" class="nbd-sup-dec-amt sx-amt" min="0" step="0.01" value="' + (on ? (Math.round(appr * 100) / 100) : '') + '"' + (on ? '' : ' disabled') +
          '>' +
        '</div>';
    }).join('');
    return '<div class="sx-meta sx-meta-gap">Uncheck what the adjuster denied; adjust approved $ per line. The billable total auto-sums (edit it after if the carrier applied O&amp;P differently).</div>' +
      '<div class="sx-box">' + rows + '</div>';
  }

  // Rows for each saved supplement + its "record carrier response" control.
  function _existingListHtml() {
    return (_existingSupplements || []).map(function (s) {
      const total = Number(s.supplementTotal) || 0;
      const st = s.status || 'draft';
      const priorAmt = (st === 'partial' && s.submission && s.submission.approvedAmount)
        ? String(s.submission.approvedAmount) : '';
      const bill = st === 'approved' ? _money(total)
                 : st === 'partial' ? _money(Number(priorAmt) || 0)
                 : st === 'denied' ? '$0' : null;
      return (
        '<div class="nbd-sup-existing" data-sup-id="' + _esc(s.id) + '" data-sup-total="' + total + '" ' +
          'style="background:#0a1424;border:1px solid #2a3344;border-radius:8px;padding:10px 12px;margin-bottom:8px;">' +
          '<div class="sx-between">' +
            '<div class="sx-fs13">' +
              '<span class="sx-w700">Supplement #' + _esc(String(s.version || 1)) + '</span>' +
              ' <span class="sx-num">' + _money(total) + '</span>' +
              (s.reason ? ' <span class="sx-muted">— ' + _esc(s.reason) + '</span>' : '') +
            '</div>' +
            _statusBadge(st) +
          '</div>' +
          (bill != null
            ? '<div class="sx-meta sx-mt6">Invoices bill <strong class="sx-c-light">' + bill + '</strong> for this supplement.</div>'
            : '') +
          _decisionsSummaryHtml(s) +
          '<div class="nbd-sup-decisions" style="display:none;"></div>' +
          '<div class="sx-wrap8 sx-wrap8-mt">' +
            '<select class="nbd-sup-resp-status sx-select">' +
              '<option value="">Record carrier response…</option>' +
              '<option value="approved"' + (st === 'approved' ? ' selected' : '') + '>Approved — bill full ' + _money(total) + '</option>' +
              '<option value="partial"' + (st === 'partial' ? ' selected' : '') + '>Partial — enter approved $</option>' +
              '<option value="denied"' + (st === 'denied' ? ' selected' : '') + '>Denied — bill $0</option>' +
            '</select>' +
            '<input type="number" class="nbd-sup-resp-amount" min="0" step="0.01" placeholder="Approved $" ' +
              'value="' + _esc(priorAmt) + '" ' +
              'style="width:120px;padding:7px 9px;border-radius:5px;border:1px solid #2a3344;background:#13171d;color:inherit;font:inherit;font-size:13px;display:' + (st === 'partial' ? 'inline-block' : 'none') + ';">' +
            '<button type="button" class="nbd-sup-resp-save sx-btn-resp">Save response</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
  }

  function _existingSectionHtml() {
    if (!(_existingSupplements && _existingSupplements.length)) return '';
    return (
      '<div class="sx-mb16">' +
        '<div class="sx-caps sx-caps-4">Previous supplements on this estimate</div>' +
        '<div class="sx-hint">Record what the carrier approved. Only <strong>Approved</strong> / <strong>Partial</strong> supplements are folded into invoices.</div>' +
        '<div id="nbd-sup-existing-list">' + _existingListHtml() + '</div>' +
      '</div>'
    );
  }

  // ─── Open the supplement modal for a given estimate ────────────
  async function openForEstimate(estimateId, parentEstimateData) {
    if (!window.EstimateSupplement) {
      _toast('Supplement engine not loaded.', 'error');
      return;
    }
    if (!parentEstimateData || !estimateId) {
      _toast('Missing estimate context.', 'error');
      return;
    }

    _parentEstimate = parentEstimateData;

    // Look up existing supplements to pick the next version number AND to let
    // the rep record the carrier's response on any of them (that response is
    // what flips a supplement to a billable status so invoicing folds it in).
    let existing = [];
    try {
      existing = await window.EstimateSupplement.loadForEstimate(estimateId) || [];
    } catch (_) { /* empty list is fine */ }
    _existingVersions = existing.length;
    _existingSupplements = existing;

    _currentSupplement = window.EstimateSupplement.createSupplement(parentEstimateData, {
      leadId: parentEstimateData.leadId || window._customerId || null,
      parentEstimateId: estimateId,
      version: _existingVersions + 1,
      reason: '',
    });

    _renderModal();
  }

  // ─── Modal render ──────────────────────────────────────────────
  function _renderModal() {
    let modal = document.getElementById(MODAL_ID);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = MODAL_ID;
      modal.style.cssText =
        'position:fixed;inset:0;z-index:10015;background:rgba(10,12,15,0.92);' +
        'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
        'display:flex;align-items:flex-start;justify-content:center;padding:20px;' +
        'overflow-y:auto;';
      document.body.appendChild(modal);
      // ESC closes
      const esc = (e) => { if (e.key === 'Escape') _close(); };
      document.addEventListener('keydown', esc);
      modal.addEventListener('click', (e) => { if (e.target === modal) _close(); });
      modal._escHandler = esc;
    }
    modal.innerHTML = _renderModalBody();
    _wireModalEvents(modal);
  }

  function _renderModalBody() {
    const sup = _currentSupplement;
    const parent = _parentEstimate;
    // Engine recomputes the added + modified rollup and stamps
    // supplementTotal / newGrandTotal / deltaPct onto `sup`.
    // (calculateDelta takes only the supplement — no second arg.)
    const delta = window.EstimateSupplement.calculateDelta(sup);
    const supTotal = Number(delta.supplementTotal) || 0;
    const parentTotal = (parent && (parent.grandTotal || parent.total)) || Number(sup.originalTotal) || 0;
    const newTotal = parentTotal + supTotal;

    // Per-item photo button — count shows attached photos; the picker
    // attaches {id,url} entries so the formal letter embeds the images.
    const photoBtn = (kind, idx, photos) => {
      const n = (photos || []).length;
      return '<button type="button" class="nbd-sup-photo" data-kind="' + kind + '" data-idx="' + idx + '" ' +
        'title="Attach documentation photos" ' +
        'style="background:transparent;border:1px solid var(--br, #2a3344);color:' + (n ? 'var(--orange, #A14A22)' : '#94a3b8') + ';padding:3px 8px;border-radius:4px;cursor:pointer;font-size:11px;margin-right:4px;">📷' + (n ? ' ' + n : '') + '</button>';
    };

    const addedRows = (sup.addedItems || []).map((it, idx) =>
      '<tr class="sx-tr">' +
        '<td class="sx-td sx-mono">' + _esc(it.code || '') + '</td>' +
        '<td class="sx-td sx-fs13">' + _esc(it.name || '') + '</td>' +
        '<td class="sx-td sx-r">' + _esc(String(it.quantity || 0)) + '</td>' +
        '<td class="sx-td sx-r sx-tab">' + _money(it.lineTotal || 0) + '</td>' +
        '<td class="sx-td-plain sx-r sx-nw">' +
          photoBtn('added', idx, it.photos) +
          '<button type="button" class="nbd-sup-remove-add sx-remove" data-idx="' + idx + '">Remove</button>' +
        '</td>' +
      '</tr>'
    ).join('');

    const modRows = (sup.modifiedItems || []).map((m, idx) =>
      '<tr class="sx-tr">' +
        '<td class="sx-td sx-mono">' + _esc(m.originalCode || '') + '</td>' +
        '<td class="sx-td sx-fs13">' + _esc(m.name || '') + '</td>' +
        '<td class="sx-td sx-r">' + _esc(String(m.originalQuantity)) + ' → ' + _esc(String(m.newQuantity)) + '</td>' +
        '<td class="sx-td sx-r sx-tab">' + _money(m.deltaLineTotal || 0) + '</td>' +
        '<td class="sx-td-plain sx-r sx-nw">' +
          photoBtn('modified', idx, m.photos) +
          '<button type="button" class="nbd-sup-remove-mod sx-remove" data-idx="' + idx + '">Remove</button>' +
        '</td>' +
      '</tr>'
    ).join('');

    return (
      '<div style="background:#0f1729;border:1px solid #2a3344;border-radius:14px;' +
        'width:100%;max-width:900px;color:#e2e8f0;font:inherit;padding:22px;' +
        'box-shadow:0 24px 60px rgba(0,0,0,0.6);">' +

        // Header
        '<div class="sx-head">' +
          '<div>' +
            '<div class="sx-caps sx-caps-3">' +
              'Supplement #' + sup.version +
            '</div>' +
            '<div class="sx-title">' +
              'Insurance Supplement' +
              (parent.number ? ' — ' + _esc(parent.number) : '') +
            '</div>' +
          '</div>' +
          '<button type="button" id="nbd-sup-close" class="sx-close">×</button>' +
        '</div>' +

        // Existing supplements + carrier-response recording (only when there
        // are already-saved supplements on this estimate).
        _existingSectionHtml() +

        // Reason input
        '<div class="sx-mb14">' +
          '<label class="sx-label">Reason for supplement</label>' +
          '<input type="text" id="nbd-sup-reason" value="' + _esc(sup.reason) + '" placeholder="Newly discovered hail damage on rear elevation" ' +
            'style="width:100%;padding:10px 12px;border-radius:6px;border:1px solid #2a3344;background:#0a1424;color:inherit;font:inherit;font-size:14px;box-sizing:border-box;">' +
        '</div>' +

        // Add line item
        '<div class="sx-panel">' +
          '<div class="sx-caps sx-caps-8">Add line item from catalog</div>' +
          '<div class="sx-wrap8">' +
            '<input type="text" id="nbd-sup-search" placeholder="Search by code, name, or tag…" ' +
              'style="flex:2;min-width:200px;padding:8px 10px;border-radius:5px;border:1px solid #2a3344;background:#13171d;color:inherit;font:inherit;font-size:13px;box-sizing:border-box;">' +
            '<input type="number" id="nbd-sup-qty" placeholder="Qty" min="0" step="0.5" ' +
              'style="width:90px;padding:8px 10px;border-radius:5px;border:1px solid #2a3344;background:#13171d;color:inherit;font:inherit;font-size:13px;box-sizing:border-box;">' +
            '<button type="button" id="nbd-sup-search-btn" class="sx-btn-sm">Search</button>' +
          '</div>' +
          '<div id="nbd-sup-search-results" style="margin-top:8px;display:none;max-height:200px;overflow-y:auto;border:1px solid #2a3344;border-radius:5px;"></div>' +
        '</div>' +

        // Tables
        ((addedRows || modRows) ? (
          '<div class="sx-mb14">' +
            '<div class="sx-caps sx-caps-8">Supplement scope</div>' +
            '<table class="sx-table">' +
              '<thead class="sx-thead">' +
                '<tr class="sx-tr-caps">' +
                  '<th class="sx-th sx-l">Code</th>' +
                  '<th class="sx-th sx-l">Item</th>' +
                  '<th class="sx-th sx-r">Qty</th>' +
                  '<th class="sx-th sx-r">Delta</th>' +
                  '<th class="sx-th sx-r">' +
                  '</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' +
                addedRows + modRows +
              '</tbody>' +
            '</table>' +
          '</div>'
        ) : (
          '<div class="sx-empty">' +
            'No items added yet. Search for a line item above.' +
          '</div>'
        )) +

        // Totals + actions
        '<div class="sx-foot">' +
          '<div>' +
            '<div class="sx-caps">Supplement delta</div>' +
            '<div class="sx-total">' +
              (supTotal >= 0 ? '+' : '') + _money(supTotal) +
            '</div>' +
            '<div class="sx-meta">' +
              'Original: ' + _money(parentTotal) + ' → Revised: ' + _money(newTotal) +
            '</div>' +
          '</div>' +
          '<div class="sx-wrap8">' +
            '<button type="button" id="nbd-sup-preview" class="sx-btn">Preview Letter</button>' +
            '<button type="button" id="nbd-sup-save" class="sx-btn-primary">Save Supplement</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function _wireModalEvents(modal) {
    modal.querySelector('#nbd-sup-close').addEventListener('click', _close);

    // Carrier-response controls on the existing-supplements list.
    _wireExistingControls(modal);

    const reasonEl = modal.querySelector('#nbd-sup-reason');
    if (reasonEl) reasonEl.addEventListener('input', (e) => {
      _currentSupplement.reason = e.target.value;
    });

    const searchBtn = modal.querySelector('#nbd-sup-search-btn');
    const searchEl = modal.querySelector('#nbd-sup-search');
    const qtyEl = modal.querySelector('#nbd-sup-qty');
    if (searchBtn && searchEl) {
      const runSearch = () => _runCatalogSearch(searchEl.value, qtyEl ? Number(qtyEl.value) || 1 : 1);
      searchBtn.addEventListener('click', runSearch);
      searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
    }

    Array.from(modal.querySelectorAll('.nbd-sup-remove-add')).forEach(b => {
      b.addEventListener('click', () => {
        const idx = Number(b.dataset.idx);
        // Remove by INDEX, not code — two added rows can share a catalog code and
        // code-based removal would drop both (uses removeAddedItemAt).
        window.EstimateSupplement.removeAddedItemAt(_currentSupplement, idx);
        _renderModal();
      });
    });
    Array.from(modal.querySelectorAll('.nbd-sup-remove-mod')).forEach(b => {
      b.addEventListener('click', () => {
        const idx = Number(b.dataset.idx);
        const m = _currentSupplement.modifiedItems[idx];
        if (m) {
          window.EstimateSupplement.removeModification(_currentSupplement, m.originalCode);
          _renderModal();
        }
      });
    });
    Array.from(modal.querySelectorAll('.nbd-sup-photo')).forEach(b => {
      b.addEventListener('click', () => {
        _openPhotoPicker(b.dataset.kind, Number(b.dataset.idx));
      });
    });

    const previewBtn = modal.querySelector('#nbd-sup-preview');
    if (previewBtn) previewBtn.addEventListener('click', _previewLetter);

    const saveBtn = modal.querySelector('#nbd-sup-save');
    if (saveBtn) saveBtn.addEventListener('click', _save);
  }

  // Wire the "record carrier response" controls for each existing supplement.
  // CSP-safe: addEventListener only, no inline handlers. Scoped to `root` so it
  // can re-wire just the list container after a save without a full re-render.
  function _wireExistingControls(root) {
    Array.from(root.querySelectorAll('.nbd-sup-existing')).forEach(function (rowEl) {
      const sel = rowEl.querySelector('.nbd-sup-resp-status');
      const amt = rowEl.querySelector('.nbd-sup-resp-amount');
      const btn = rowEl.querySelector('.nbd-sup-resp-save');
      const decBox = rowEl.querySelector('.nbd-sup-decisions');
      const sup = (_existingSupplements || []).find(function (x) { return x.id === rowEl.dataset.supId; });
      // Re-sum the enabled per-line approved amounts into the billable field.
      const resum = function () {
        if (!decBox || decBox.style.display === 'none') return;
        let sum = 0;
        Array.from(decBox.querySelectorAll('.nbd-sup-dec-row')).forEach(function (r) {
          const on = r.querySelector('.nbd-sup-dec-on');
          const a = r.querySelector('.nbd-sup-dec-amt');
          if (on && on.checked) sum += Number(a && a.value) || 0;
        });
        if (amt) amt.value = String(Math.round(sum * 100) / 100);
      };
      const wireDecisionRows = function () {
        Array.from(decBox.querySelectorAll('.nbd-sup-dec-row')).forEach(function (r) {
          const on = r.querySelector('.nbd-sup-dec-on');
          const a = r.querySelector('.nbd-sup-dec-amt');
          if (on) on.addEventListener('change', function () {
            if (on.checked) { a.disabled = false; a.value = String(Math.round((Number(r.dataset.requested) || 0) * 100) / 100); }
            else { a.disabled = true; a.value = ''; }
            resum();
          });
          if (a) a.addEventListener('input', resum);
        });
      };
      if (sel && amt) {
        sel.addEventListener('change', function () {
          if (sel.value === 'partial') {
            amt.style.display = 'inline-block';
            // Per-line decision editor: uncheck denied lines, adjust approved
            // $ per line — the billable total auto-sums from what survives.
            // (The old flow was one blind dollar figure; now the record shows
            // WHICH items the adjuster approved.)
            if (decBox && sup) {
              decBox.innerHTML = _decisionEditorHtml(sup);
              decBox.style.display = decBox.innerHTML ? 'block' : 'none';
              wireDecisionRows();
              resum();
            }
            amt.focus();
          } else {
            amt.style.display = 'none';
            if (decBox) { decBox.style.display = 'none'; decBox.innerHTML = ''; }
          }
        });
      }
      if (btn) btn.addEventListener('click', function () { _saveResponse(rowEl, sel, amt, btn); });
    });
  }

  // Collect the per-line verdicts from an open decision editor (null when
  // the editor isn't showing — plain single-figure responses stay valid).
  function _collectDecisions(rowEl) {
    const decBox = rowEl.querySelector('.nbd-sup-decisions');
    if (!decBox || decBox.style.display === 'none') return null;
    const rows = Array.from(decBox.querySelectorAll('.nbd-sup-dec-row'));
    if (!rows.length) return null;
    return rows.map(function (r) {
      const on = r.querySelector('.nbd-sup-dec-on');
      const a = r.querySelector('.nbd-sup-dec-amt');
      const requested = Number(r.dataset.requested) || 0;
      const approved = (on && on.checked) ? (Number(a && a.value) || 0) : 0;
      const decision = !(on && on.checked) ? 'denied'
        : (approved < requested - 0.005 ? 'reduced' : 'approved');
      return {
        kind: r.dataset.kind, index: Number(r.dataset.index) || 0,
        code: r.dataset.code || '', name: r.dataset.name || '',
        requested: requested, approved: approved, decision: decision,
      };
    });
  }

  async function _saveResponse(rowEl, sel, amt, btn) {
    const supId = rowEl.dataset.supId;
    const status = sel ? sel.value : '';
    if (!supId || !status) { _toast('Pick a carrier response first.', 'error'); return; }

    let approvedAmount = null;
    if (status === 'partial') {
      approvedAmount = Number(amt && amt.value);
      if (!isFinite(approvedAmount) || approvedAmount <= 0) {
        _toast('Enter the dollar amount the adjuster approved.', 'error');
        return;
      }
      // A 'partial' can't exceed the supplement's own total — guard the fat-finger
      // ($25,000 typed for $2,500) that would silently overbill the invoice.
      const supTotal = Number(rowEl.dataset.supTotal) || 0;
      if (supTotal > 0 && approvedAmount > supTotal) {
        _toast('Approved amount exceeds the supplement total (' + _money(supTotal) + '). Check the figure.', 'error');
        return;
      }
    }
    if (!window.EstimateSupplement || typeof window.EstimateSupplement.updateResponse !== 'function') {
      _toast('Supplement engine not loaded.', 'error');
      return;
    }

    btn.disabled = true;
    const prevLabel = btn.textContent;
    btn.textContent = 'Saving…';

    // Per-line adjuster verdicts from the decision editor (null when the
    // rep recorded a plain single-figure response).
    const itemDecisions = _collectDecisions(rowEl);

    const ok = await window.EstimateSupplement.updateResponse(supId, {
      status: status,
      approvedAmount: approvedAmount,
      itemDecisions: itemDecisions,
    });

    if (!ok) {
      _toast('Could not record response — check console.', 'error');
      btn.disabled = false;
      btn.textContent = prevLabel;
      return;
    }

    // Reflect locally so the badge + billable note update without a full reload.
    const s = (_existingSupplements || []).find(function (x) { return x.id === supId; });
    if (s) {
      s.status = status;
      s.submission = s.submission || {};
      s.submission.responseStatus = status;
      s.submission.approvedAmount = approvedAmount;
      s.submission.itemDecisions = itemDecisions;
    }
    const bill = status === 'approved' ? _money(Number(rowEl.dataset.supTotal) || 0)
               : status === 'partial' ? _money(approvedAmount)
               : '$0';
    _toast('Carrier response recorded — invoices will bill ' + bill + ' for this supplement.', 'success');

    // Re-render just the existing-supplements list (keeps any in-progress new
    // supplement in the builder below untouched).
    const listEl = document.getElementById('nbd-sup-existing-list');
    if (listEl) {
      listEl.innerHTML = _existingListHtml();
      _wireExistingControls(listEl);
    }

    // Same refresh signal the save path uses so the customer timeline / kanban
    // score badge pick up the status change.
    try {
      window.dispatchEvent(new CustomEvent('nbd:data-refreshed', {
        detail: { source: 'supplement-response', supplementId: supId }
      }));
    } catch (_) {}
  }

  // ─── Per-item photo picker ─────────────────────────────────────
  // Loads the lead's photo grid once per lead (same 'photos' collection
  // query the V2 builder uses), lets the rep toggle a selection, and
  // writes {id,url} entries onto the item via setItemPhotos — the formal
  // letter then embeds the actual images under the line.
  let _leadPhotoCache = null; // { leadId, list: [{id,url}] }
  async function _loadLeadPhotos(leadId) {
    if (_leadPhotoCache && _leadPhotoCache.leadId === leadId) return _leadPhotoCache.list;
    if (!leadId || !window.db || !window.getDocs || !window.query || !window.collection || !window.where) return [];
    try {
      const snap = await window.getDocs(window.query(
        window.collection(window.db, 'photos'),
        window.where('leadId', '==', leadId)));
      const list = [];
      snap.forEach(d => {
        const p = d.data() || {};
        if (p.url && !p.deleted) list.push({ id: d.id, url: p.url, _ms: (p.createdAt && p.createdAt.toMillis) ? p.createdAt.toMillis() : 0 });
      });
      list.sort((a, b) => b._ms - a._ms);
      _leadPhotoCache = { leadId: leadId, list: list.slice(0, 60) };
      return _leadPhotoCache.list;
    } catch (e) {
      console.warn('[Supplement] photo load failed:', e);
      return [];
    }
  }

  async function _openPhotoPicker(kind, idx) {
    const sup = _currentSupplement;
    if (!sup) return;
    const list = kind === 'modified' ? sup.modifiedItems : sup.addedItems;
    const item = list && list[idx];
    if (!item) return;
    const leadId = sup.leadId || window._customerId || null;
    const photos = await _loadLeadPhotos(leadId);
    const selected = new Set((item.photos || [])
      .map(p => (p && typeof p === 'object' ? p.id : p)).filter(Boolean));

    let overlay = document.getElementById('nbd-sup-photo-picker');
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.id = 'nbd-sup-photo-picker';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10016;background:rgba(10,12,15,0.94);display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;';
    const inner = document.createElement('div');
    inner.style.cssText = 'background:#0f1729;border:1px solid #2a3344;border-radius:12px;max-width:640px;width:100%;padding:18px;color:#e2e8f0;';
    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px;font-weight:700;margin-bottom:4px;';
    title.textContent = 'Photos for: ' + (item.name || item.code || item.originalCode || '');
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#94a3b8;margin-bottom:10px;';
    hint.textContent = photos.length
      ? 'Tap to select — selected photos embed in the supplement letter under this line.'
      : 'No photos on this customer yet — capture some from their customer page first.';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;max-height:50vh;overflow-y:auto;';
    photos.forEach(p => {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.style.cssText = 'position:relative;padding:0;border:2px solid ' + (selected.has(p.id) ? 'var(--orange, #A14A22)' : '#2a3344') + ';border-radius:6px;background:none;cursor:pointer;overflow:hidden;aspect-ratio:1;';
      const img = document.createElement('img');
      img.src = p.url; img.loading = 'lazy'; img.alt = 'Customer photo';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
      cell.appendChild(img);
      cell.addEventListener('click', () => {
        if (selected.has(p.id)) { selected.delete(p.id); cell.style.borderColor = '#2a3344'; }
        else { selected.add(p.id); cell.style.borderColor = 'var(--orange, #A14A22)'; }
      });
      grid.appendChild(cell);
    });
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px;';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:9px 16px;background:transparent;border:1px solid #2a3344;color:#94a3b8;border-radius:6px;cursor:pointer;font-size:13px;';
    cancel.addEventListener('click', () => overlay.remove());
    const done = document.createElement('button');
    done.type = 'button'; done.textContent = 'Attach selected';
    done.style.cssText = 'padding:9px 18px;background:var(--orange, #A14A22);border:none;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;font-weight:700;';
    done.addEventListener('click', () => {
      const chosen = photos.filter(p => selected.has(p.id)).map(p => ({ id: p.id, url: p.url }));
      window.EstimateSupplement.setItemPhotos(sup, kind, idx, chosen);
      overlay.remove();
      _renderModal();
    });
    bar.appendChild(cancel); bar.appendChild(done);
    inner.appendChild(title); inner.appendChild(hint); inner.appendChild(grid); inner.appendChild(bar);
    overlay.appendChild(inner);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  async function _runCatalogSearch(query, qty) {
    const wrap = document.getElementById('nbd-sup-search-results');
    if (!wrap) return;
    // window.NBD_XACT_CATALOG is assigned at exactly one site repo-wide
    // (estimate-catalog-xactimate.js), and that file has no static <script> tag
    // — it ships only inside the lazy 'estimates' bundle. Nothing loaded on
    // customer.html ever requests that bundle, so on the "+ Supplement" modal
    // there this bail was unconditional: every search returned a red "Catalog
    // not loaded.", and since createSupplement then left modifiedItems empty,
    // nothing could be added to a supplement from that surface at all.
    if (!(window.NBD_XACT_CATALOG && typeof window.NBD_XACT_CATALOG.search === 'function')
        && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      wrap.style.display = 'block';
      wrap.innerHTML = '<div class="sx-msg">Loading catalog…</div>';
      try { await window.ScriptLoader.loadBundle('estimates'); }
      catch (e) { console.warn('[supplement-ui] estimates bundle failed to load:', e && e.message); }
    }
    const cat = window.NBD_XACT_CATALOG;
    if (!cat || typeof cat.search !== 'function') {
      wrap.style.display = 'block';
      wrap.innerHTML = '<div class="sx-msg sx-msg-err">Catalog not loaded.</div>';
      return;
    }
    const q = String(query || '').trim();
    if (!q) { wrap.style.display = 'none'; return; }
    const hits = cat.search(q).slice(0, 8);
    if (hits.length === 0) {
      wrap.style.display = 'block';
      wrap.innerHTML = '<div class="sx-msg">No catalog matches.</div>';
      return;
    }
    wrap.style.display = 'block';
    wrap.innerHTML = hits.map(h =>
      '<button type="button" class="nbd-sup-pick" data-code="' + _esc(h.code) + '" ' +
        'style="display:block;width:100%;text-align:left;padding:8px 10px;background:transparent;border:none;border-bottom:1px solid #1a2540;color:inherit;font:inherit;font-size:12px;cursor:pointer;">' +
        '<span class="sx-code">' + _esc(h.code) + '</span> ' +
        _esc(h.name) +
      '</button>'
    ).join('');
    Array.from(wrap.querySelectorAll('.nbd-sup-pick')).forEach(b => {
      b.addEventListener('click', () => {
        const code = b.dataset.code;
        // Read the qty field at PICK time, not the value captured when Search ran
        // (the rep may have changed the qty after searching).
        const pickQty = Number(document.getElementById('nbd-sup-qty')?.value) || qty || 1;
        try {
          window.EstimateSupplement.addFromCatalog(_currentSupplement, code, { quantity: pickQty });
          _renderModal();
        } catch (e) {
          _toast('Could not add: ' + (e.message || 'unknown error'), 'error');
        }
      });
    });
  }

  function _previewLetter() {
    if (!_currentSupplement) return;
    const reason = _currentSupplement.reason || '';
    if (!reason.trim()) {
      _toast('Add a reason for the supplement first.', 'error');
      return;
    }
    if (!(_currentSupplement.addedItems || []).length
        && !(_currentSupplement.modifiedItems || []).length) {
      _toast('Add at least one item before previewing.', 'error');
      return;
    }
    try {
      // formatSupplementLetter reads meta.customer / meta.claim / meta.estimate /
      // meta.company — the old {parentEstimate, rep, company:{name}} keys were all
      // ignored, so the adjuster letter rendered every claim field as '—' and an
      // empty footer. Pass the real shape (best-effort from the estimate + its
      // insurance overlay), and OMIT company so the formatter's own default fills
      // the footer. That default is now per-tenant: formatSupplementLetter resolves
      // window._brand() and, for a non-NBD tenant, builds the company block from the
      // active tenant's contact info (NBD keeps its byte-identical hardcoded block).
      const pe = _parentEstimate || {};
      const ins = pe.insurance || {};
      const html = window.EstimateSupplement.formatSupplementLetter(_currentSupplement, {
        customer: {
          name: pe.customerName || pe.customer || '',
          address: pe.customerAddress || pe.address || '',
        },
        claim: {
          carrier: ins.carrier || pe.insCarrier || pe.carrier || '',
          number: ins.claimNumber || pe.claimNumber || '',
          adjuster: ins.adjuster || pe.adjuster || '',
          dateOfLoss: ins.dateOfLoss || pe.dateOfLoss || '',
        },
        estimate: { preparedBy: pe.preparedBy || (window._currentRep && window._currentRep.name) || '' },
      });
      if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
        window.NBDDocViewer.open({
          title: 'Supplement #' + _currentSupplement.version + ' — preview',
          html,
        });
      } else {
        // Fallback — open in a new window.
        const w = window.open('', '_blank');
        if (w) { w.document.write(html); w.document.close(); }
      }
    } catch (e) {
      _toast('Preview failed: ' + (e.message || 'unknown error'), 'error');
    }
  }

  async function _save() {
    if (!_currentSupplement) return;
    const reason = (_currentSupplement.reason || '').trim();
    if (!reason) {
      _toast('Add a reason for the supplement first.', 'error');
      return;
    }
    if (!(_currentSupplement.addedItems || []).length
        && !(_currentSupplement.modifiedItems || []).length) {
      _toast('Add at least one item before saving.', 'error');
      return;
    }
    const saveBtn = document.getElementById('nbd-sup-save');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
    try {
      const id = await window.EstimateSupplement.saveToFirestore(_currentSupplement);
      if (id) {
        _toast('Supplement #' + _currentSupplement.version + ' saved ✓', 'success');
        // W159 HIGH #5: dispatch nbd:data-refreshed so the customer-
        // page timeline + kanban score badge + Lead Intelligence
        // breakdown all pick up the new supplement signal without a
        // manual reload. Same pattern as quick-capture.js W130.
        try {
          window.dispatchEvent(new CustomEvent('nbd:data-refreshed', {
            detail: { source: 'supplement', supplementId: id, leadId: _currentSupplement.leadId }
          }));
        } catch (_) {}
        _close();
      } else {
        _toast('Save failed — check console.', 'error');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Supplement'; }
      }
    } catch (e) {
      _toast('Save failed: ' + (e.message || 'try again'), 'error');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Supplement'; }
    }
  }

  function _close() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) {
      if (modal._escHandler) document.removeEventListener('keydown', modal._escHandler);
      modal.remove();
    }
    _currentSupplement = null;
    _parentEstimate = null;
  }

  // ─── Attach "+ Supplement" buttons to estimate rows ────────────
  // The customer page renders estimate cards via a few different
  // code paths (estimate-list module, inline render in customer.html
  // bootstrap, etc). We attach by watching for any element with
  // `data-estimate-id` that's NOT already wired, then injecting a
  // small button inline. Mutation observer handles re-renders.
  function attachButtons() {
    // The customer-page estimate list (customer.html line ~3722)
    // renders rows with `class="nbd-est-row"` and `data-est-id`.
    // Other surfaces (dashboard estimates view, future modules) may
    // emit `data-estimate-id`. Match both.
    const sel = [
      '.nbd-est-row:not([data-supplement-wired])',
      '[data-estimate-id]:not([data-supplement-wired])',
    ].join(', ');
    const candidates = document.querySelectorAll(sel);
    candidates.forEach(el => {
      const estId = el.dataset.estId || el.dataset.estimateId;
      if (!estId) return;
      el.dataset.supplementWired = '1';
      if (el.querySelector('.nbd-sup-trigger')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nbd-sup-trigger';
      btn.textContent = '+ Supplement';
      btn.title = 'Build an insurance supplement for this estimate';
      btn.style.cssText =
        'margin-left:6px;padding:4px 10px;background:transparent;color:var(--orange, #A14A22);' +
        'border:1px solid var(--orange, #A14A22);border-radius:5px;font:inherit;font-size:11px;' +
        'font-weight:600;cursor:pointer;letter-spacing:0.04em;text-transform:uppercase;' +
        '-webkit-tap-highlight-color:transparent;';
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        // Try in-memory caches first — the customer page populates
        // window._customerEstimates, the dashboard populates
        // window._estimates. Either is fine.
        let parent = (window._customerEstimates || window._estimates || [])
          .find(es => es.id === estId);
        if (!parent && window.db && window.getDoc && window.doc) {
          try {
            const snap = await window.getDoc(window.doc(window.db, 'estimates', estId));
            if (snap.exists()) parent = { id: snap.id, ...snap.data() };
          } catch (_) {}
        }
        if (!parent) {
          _toast('Could not load that estimate.', 'error');
          return;
        }
        openForEstimate(estId, parent);
      });
      // Join the row's own right-hand actions cluster (amount + badges +
      // export/share/cert) when present, rather than becoming a THIRD
      // flex child of the row itself. .nbd-est-row is a 2-child flex row
      // (title/address block | actions cluster) — a bare el.appendChild
      // here forced the browser to split width three ways, squeezing the
      // address into a several-line-tall wrap (screenshot, 2026-09-20).
      // Other/future data-estimate-id surfaces have no known cluster to
      // join, so they keep the old row-level append.
      const actions = el.querySelector('.nbd-est-actions');
      (actions || el).appendChild(btn);
    });
  }

  // Run on load + watch for DOM mutations (estimate list re-renders).
  function _bootstrap() {
    attachButtons();
    if (typeof MutationObserver === 'function') {
      const obs = new MutationObserver(() => { attachButtons(); });
      obs.observe(document.body, { childList: true, subtree: true });
      // W159 HIGH #10: disconnect on pagehide so a bfcache restore
      // doesn't run a stale observer + the new one in parallel.
      window.addEventListener('pagehide', () => {
        try { obs.disconnect(); } catch (_) {}
        try { window.removeEventListener('nbd:data-refreshed', attachButtons); } catch (_) {}
      }, { once: true });
    }
    // Also re-attach on data refresh events.
    window.addEventListener('nbd:data-refreshed', attachButtons);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap, { once: true });
  } else {
    setTimeout(_bootstrap, 0);
  }

  const NBDSupplementUI = {
    openForEstimate,
    attachButtons,
  };
})();
