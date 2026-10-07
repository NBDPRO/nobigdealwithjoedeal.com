// ============================================================
// NBD Pro — estimate-crm-ops.js
// Estimates-list row actions: duplicate / rename / assign / delete,
// plus the assign-to-customer lead picker.
// ============================================================
//
// Rock 2 PR 6 (2026-08-06): split out of estimates.js verbatim.
// These are Firestore CRM operations with no pricing math in them,
// so they survive the classic engine's retirement. Keeping them
// here leaves estimates.js as classic-wizard code only.
//
// Loads inside the lazy `estimates` ScriptLoader bundle. The
// load-then-run stubs in dashboard-actions.js resolve these off
// window once the bundle settles.

// ══════════════════════════════════════════════════════════════
// Estimates list row actions — duplicate / rename / assign / delete
// Called from the delegated click handler in renderEstimatesList
// (dashboard.html). Each one reads window._estimates, mutates via
// the window._* Firestore helpers, and the list re-renders because
// loadEstimates() is called inside those helpers.
// ══════════════════════════════════════════════════════════════

async function duplicateEstimateAction(id) {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  if (typeof window._duplicateEstimate !== 'function') {
    showToast('Duplicate not available — reload the page', 'error');
    return;
  }
  const src = (window._estimates || []).find(e => e.id === id);
  if (!src) { showToast('Estimate not found', 'error'); return; }
  const newId = await window._duplicateEstimate(id);
  if (newId) showToast('\u2713 Estimate duplicated', 'success');
  else showToast('Failed to duplicate', 'error');
}

async function renameEstimateAction(id) {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const src = (window._estimates || []).find(e => e.id === id);
  if (!src) { showToast('Estimate not found', 'error'); return; }
  const current = src.name || src.addr || '';
  // QA 2026-06-21 #7: native prompt() is BLOCKED in iOS standalone (PWA) mode,
  // so rename silently no-op'd there while delete/duplicate worked (they use
  // nbdConfirm). Prefer the modal nbdPrompt (defined by standalone-compat.js in
  // standalone mode) and fall back to native prompt in a normal browser.
  // eslint-disable-next-line no-alert
  const next = (typeof window.nbdPrompt === 'function')
    ? await window.nbdPrompt('Rename estimate:', current)
    : window.prompt('Rename estimate:', current);
  if (next === null) return;  // user hit Cancel
  const trimmed = String(next).trim();
  if (!trimmed) { showToast('Name cannot be empty', 'error'); return; }
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (!_nbdReg || typeof _nbdReg._renameEstimate !== 'function') {
    showToast('Rename not available', 'error');
    return;
  }
  const ok = await _nbdReg._renameEstimate(id, trimmed);
  if (ok) showToast('\u2713 Renamed', 'success');
  else showToast('Failed to rename', 'error');
}

async function assignEstimateAction(id) {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const src = (window._estimates || []).find(e => e.id === id);
  if (!src) { showToast('Estimate not found', 'error'); return; }
  const leads = window._leads || [];
  if (!leads.length) {
    showToast('No customers available — add a lead first', 'error');
    return;
  }
  // Show picker modal
  showAssignLeadPicker(id, src);
}

async function deleteEstimateAction(id) {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const src = (window._estimates || []).find(e => e.id === id);
  if (!src) { showToast('Estimate not found', 'error'); return; }
  const label = src.name || src.addr || 'this estimate';
  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  // _deleteEstimate is a SOFT delete since R5-8-2 (#2286): it archives the
  // estimate (sets its deleted flag), drops it from the estimate lists and the lead's
  // pipeline totals, and re-points the lead's primary estimate. "This cannot
  // be undone" described the old deleteDoc and is no longer true.
  if (!(await _ask('Archive "' + label + '"? It will be removed from your estimate lists and from this customer\'s totals.'))) return;
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (!_nbdReg || typeof _nbdReg._deleteEstimate !== 'function') {
    showToast('Archive not available', 'error');
    return;
  }
  const ok = await _nbdReg._deleteEstimate(id);
  if (ok) showToast('\u2713 Estimate archived', 'success');
  else showToast('Failed to archive', 'error');
}

// Lead picker modal for the Assign action. Built via createElement
// (no innerHTML string interpolation) so user-generated lead names
// can never smuggle markup into the page.
function showAssignLeadPicker(estimateId, estimate) {
  const leads = window._leads || [];
  // Reuse existing overlay if present
  let overlay = document.getElementById('assign-lead-picker');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'assign-lead-picker';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;'
    + 'background:rgba(0,0,0,.75);display:flex;align-items:center;'
    + 'justify-content:center;padding:20px;';

  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--s, #1a1d23);border:1px solid var(--br, #2a2d35);'
    + 'border-radius:12px;padding:24px;max-width:500px;width:100%;'
    + 'max-height:80vh;display:flex;flex-direction:column;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.5);';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'margin-bottom:14px;';
  const hdrTitle = document.createElement('div');
  hdrTitle.style.cssText = "font-family:'Barlow Condensed',sans-serif;font-size:18px;"
    + 'font-weight:800;color:var(--t, #fff);text-transform:uppercase;letter-spacing:.04em;';
  hdrTitle.textContent = 'Assign to Customer';
  const hdrSub = document.createElement('div');
  hdrSub.style.cssText = 'font-size:11px;color:var(--m, #888);margin-top:4px;';
  hdrSub.textContent = (estimate.name || estimate.addr || 'Untitled estimate');
  hdr.appendChild(hdrTitle);
  hdr.appendChild(hdrSub);
  sheet.appendChild(hdr);

  // Search box
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search customers...';
  search.style.cssText = 'background:var(--s2);border:1px solid var(--br);'
    + 'border-radius:6px;padding:10px 12px;font-size:13px;color:var(--t);'
    + 'margin-bottom:12px;font-family:inherit;outline:none;';
  sheet.appendChild(search);

  // Results container — scrollable
  const results = document.createElement('div');
  results.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:200px;';
  sheet.appendChild(results);

  const renderLeads = (filter) => {
    results.textContent = '';
    const q = (filter || '').toLowerCase().trim();
    const filtered = q
      ? leads.filter(l => {
          const text = [l.firstName, l.lastName, l.address, l.phone].filter(Boolean).join(' ').toLowerCase();
          return text.includes(q);
        })
      : leads;

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align:center;padding:30px 10px;color:var(--m);font-size:12px;';
      empty.textContent = q ? 'No customers match "' + q + '"' : 'No customers yet';
      results.appendChild(empty);
      return;
    }

    // "Unassign" option at the top if currently assigned
    if (estimate.leadId) {
      const unassign = document.createElement('button');
      unassign.type = 'button';
      unassign.style.cssText = 'background:var(--s2);border:1px dashed var(--br);'
        + 'color:var(--m);padding:10px 14px;border-radius:6px;text-align:left;'
        + 'cursor:pointer;font-family:inherit;font-size:12px;';
      unassign.textContent = '✕ Unassign (leave without customer)';
      unassign.addEventListener('click', async () => {
        overlay.remove();
        // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
        // _assignEstimateToLead is defined only in dashboard-bootstrap.module.js,
        // which customer.html never loads \u2014 guard like _deleteEstimate/_renameEstimate
        // above instead of letting an unhandled rejection swallow the click.
        var _nbdReg = window.__NBD_CALL_REGISTRY;
        if (!_nbdReg || typeof _nbdReg._assignEstimateToLead !== 'function') {
          showToast('Assign not available on this page \u2014 use the Dashboard estimates list', 'error');
          return;
        }
        const ok = await _nbdReg._assignEstimateToLead(estimateId, null);
        if (ok) showToast('\u2713 Estimate unassigned', 'success');
        else showToast('Failed to unassign', 'error');
      });
      results.appendChild(unassign);
    }

    filtered.slice(0, 100).forEach(lead => {
      const row = document.createElement('button');
      row.type = 'button';
      row.style.cssText = 'background:var(--s2);border:1px solid var(--br);'
        + 'border-radius:6px;padding:10px 14px;text-align:left;cursor:pointer;'
        + 'font-family:inherit;transition:border-color .15s;';
      row.addEventListener('mouseenter', () => { row.style.borderColor = 'var(--orange)'; });
      row.addEventListener('mouseleave', () => { row.style.borderColor = 'var(--br)'; });

      const name = document.createElement('div');
      name.style.cssText = 'font-size:13px;font-weight:600;color:var(--t);';
      name.textContent = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || '(no name)';
      row.appendChild(name);

      const addr = document.createElement('div');
      addr.style.cssText = 'font-size:11px;color:var(--m);margin-top:2px;';
      addr.textContent = lead.address || 'No address';
      row.appendChild(addr);

      row.addEventListener('click', async () => {
        overlay.remove();
        // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
        // _assignEstimateToLead is defined only in dashboard-bootstrap.module.js,
        // which customer.html never loads \u2014 guard like _deleteEstimate/_renameEstimate
        // above instead of letting an unhandled rejection swallow the click.
        var _nbdReg = window.__NBD_CALL_REGISTRY;
        if (!_nbdReg || typeof _nbdReg._assignEstimateToLead !== 'function') {
          showToast('Assign not available on this page \u2014 use the Dashboard estimates list', 'error');
          return;
        }
        const ok = await _nbdReg._assignEstimateToLead(estimateId, lead.id);
        if (ok) showToast('\u2713 Assigned to ' + (lead.firstName || lead.address || 'customer'), 'success');
        else showToast('Failed to assign', 'error');
      });
      results.appendChild(row);
    });
  };

  renderLeads('');
  search.addEventListener('input', () => renderLeads(search.value));

  // Footer — cancel button
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:14px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'background:none;border:1px solid var(--br);'
    + 'color:var(--m);padding:8px 18px;border-radius:6px;cursor:pointer;'
    + "font-family:'Barlow Condensed',sans-serif;font-size:12px;"
    + 'font-weight:700;letter-spacing:.08em;text-transform:uppercase;';
  cancelBtn.addEventListener('click', () => overlay.remove());
  footer.appendChild(cancelBtn);
  sheet.appendChild(footer);

  overlay.appendChild(sheet);
  document.body.appendChild(overlay);

  // Click outside + Esc to close
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  const escHandler = (e) => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
  setTimeout(() => search.focus(), 50);
}

// ══ Window Scope Exposures ══════════════════════════════════
// showAssignLeadPicker stays module-local — assignEstimateAction is its
// only caller and it was never on window.
window.duplicateEstimateAction = duplicateEstimateAction;
window.renameEstimateAction = renameEstimateAction;
window.assignEstimateAction = assignEstimateAction;
window.deleteEstimateAction = deleteEstimateAction;
