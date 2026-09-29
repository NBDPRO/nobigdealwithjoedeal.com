
function openEditCustomerModal() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const lead = window._currentLead;
  if (!lead) return;
  document.getElementById('editFirstName').value = lead.firstName || '';
  document.getElementById('editLastName').value = lead.lastName || '';
  document.getElementById('editPhone').value = lead.phone || '';
  document.getElementById('editEmail').value = lead.email || '';
  document.getElementById('editAddress').value = lead.address || '';
  document.getElementById('editDamageType').value = lead.damageType || lead.serviceType || '';
  document.getElementById('editScope').value = lead.scopeOfWork || '';
  // Extra properties worked under the same job (see the SERVICE LOCATIONS
  // block on generated documents). Legacy leads have no array — render zero
  // rows rather than one empty one, so an untouched modal saves [] and not ['']. 
  renderServiceAddressRows(Array.isArray(lead.serviceAddresses) ? lead.serviceAddresses : []);
  // Job Value is now a type="number" input, so it must be SEEDED with a bare
  // number. Legacy leads hold display strings like "$45,000"; assigning one to
  // a number input makes the browser sanitize .value to '' — the field looks
  // empty, the rep saves an unrelated edit, and parseFloat('')||0 writes
  // jobValue:0 over a live $45,000 deal with no error and no visible cue.
  // Strip on the way IN with the same rule the save path uses on the way out.
  const _rawJv = lead.jobValue != null && lead.jobValue !== '' ? lead.jobValue : lead.estimatedValue;
  const _jv = parseFloat(String(_rawJv == null ? '' : _rawJv).replace(/[^0-9.\-]/g, ''));
  document.getElementById('editJobValue').value = isFinite(_jv) ? _jv : '';
  // Install day + arrival window (2026-09-29). Null-guarded: a cached
  // customer.html from before the field existed has neither.
  const _sd = document.getElementById('editScheduledDate');
  if (_sd) _sd.value = lead.scheduledDate || '';
  if (_sd && window.NBDScheduleWindowUI) window.NBDScheduleWindowUI.fill('edit', lead);
  // nbdModal owns visibility + Esc/backdrop close (batch-4 consolidation).
  window.nbdModal.open('editCustomerModal');
}

function closeEditCustomerModal() {
  window.nbdModal.close('editCustomerModal');
}

// ── ADDITIONAL SERVICE LOCATIONS ────────────────────────────────────
// A job can span several properties (Anthony Scandariato: 1944 AND 1942
// Kentucky Ave on one invoice). `address` remains the primary/billing
// address; these are extras. Values are read back off the DOM at save
// time rather than mirrored into JS state, so there is one source of
// truth and no keystroke syncing to drift.

function _svcAddrRowHTML(value, idx) {
  var esc = window.nbdEsc || function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  return '<div class="svc-addr-row" style="display:flex;gap:6px;margin-bottom:6px;">' +
    '<input type="text" class="svc-addr-input" aria-label="Additional service address ' + (idx + 1) + '"' +
    ' value="' + esc(value) + '"' +
    ' placeholder="1942 Kentucky Ave, Cincinnati, OH 45223"' +
    ' style="flex:1;padding:10px 12px;background:var(--s);border:1px solid var(--br);border-radius:8px;color:var(--t);font-size:14px;box-sizing:border-box;" />' +
    '<button type="button" data-action="removeServiceAddressRow" data-arg="' + idx + '"' +
    ' aria-label="Remove this service address" title="Remove"' +
    ' class="btn" style="padding:0 12px;font-size:16px;line-height:1;">&times;</button>' +
    '</div>';
}

function _readServiceAddressRows() {
  var host = document.getElementById('editServiceAddresses');
  if (!host) return [];
  return Array.prototype.map.call(
    host.querySelectorAll('.svc-addr-input'),
    function (el) { return String(el.value || '').trim(); }
  );
}

function renderServiceAddressRows(values) {
  var host = document.getElementById('editServiceAddresses');
  if (!host) return;
  var list = Array.isArray(values) ? values : [];
  host.innerHTML = list.map(_svcAddrRowHTML).join('');
}

function addServiceAddressRow() {
  // Keep what's already typed, then append a blank row.
  renderServiceAddressRows(_readServiceAddressRows().concat(['']));
  var host = document.getElementById('editServiceAddresses');
  var inputs = host ? host.querySelectorAll('.svc-addr-input') : [];
  if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeServiceAddressRow(idx) {
  var i = parseInt(idx, 10);
  var vals = _readServiceAddressRows();
  if (!isFinite(i) || i < 0 || i >= vals.length) return;
  vals.splice(i, 1);
  renderServiceAddressRows(vals);
}

// data-action dispatch resolves these off window.
window.renderServiceAddressRows = renderServiceAddressRows;
window.addServiceAddressRow = addServiceAddressRow;
window.removeServiceAddressRow = removeServiceAddressRow;

async function saveCustomerEdits() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const btn = document.getElementById('saveEditBtn');
  btn.disabled = true;
  btn.textContent = 'SAVING...';
  try {
    const updates = {
      firstName: document.getElementById('editFirstName').value.trim(),
      lastName: document.getElementById('editLastName').value.trim(),
      phone: document.getElementById('editPhone').value.trim(),
      email: document.getElementById('editEmail').value.trim(),
      address: document.getElementById('editAddress').value.trim(),
      // Blank rows are dropped so an untouched modal never writes ['']; the
      // field is always an array so downstream .map/.length are safe without
      // a guard on every consumer.
      serviceAddresses: _readServiceAddressRows().filter(function (a) { return a; }),
      damageType: document.getElementById('editDamageType').value.trim(),
      scopeOfWork: document.getElementById('editScope').value.trim(),
      // Coerce to a NUMBER before writing. Every downstream consumer
      // (kanban column totals, dashboard KPI tiles, leaderboard, the profit
      // panel) does Number(lead.jobValue) — a rep typing "$45,000" stored
      // the raw string, which reads back NaN and silently under-counts as
      // $0. Mirrors the canonical writer in crm-leads.js:243 (saveLead);
      // the strip is needed because a type="number" input still hands back
      // a string and existing leads already hold "$45,000"-shaped values.
      jobValue: parseFloat(String(document.getElementById('editJobValue').value).replace(/[^0-9.\-]/g, '')) || 0,
      updatedAt: new Date()
    };
    // Same rules as the pipeline lead editor (crm-leads.js saveLead). This
    // form saved phone "123", email "bad" and a NEGATIVE job value (which
    // subtracts from every pipeline total) without a word.
    const _bad = (msg, id) => {
      if (typeof showToast === 'function') showToast(msg, 'error');
      const el = document.getElementById(id); if (el) { try { el.focus(); } catch (_) {} }
      btn.disabled = false; btn.textContent = 'SAVE CHANGES';
    };
    if (updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email)) { _bad('Email looks invalid (e.g. name@example.com).', 'editEmail'); return; }
    if (updates.phone) {
      const _d = updates.phone.replace(/\D/g, '');
      if (_d.length < 10 || _d.length > 15) { _bad('Phone needs at least 10 digits.', 'editPhone'); return; }
    }
    if (updates.jobValue < 0) { _bad('Job value can’t be negative.', 'editJobValue'); return; }
    // Install day + arrival window (2026-09-29). Written only when the field
    // is on the page — an older cached modal has no date input, and writing
    // '' from a missing one would wipe a date set on the dashboard.
    const _sdEl = document.getElementById('editScheduledDate');
    if (_sdEl) {
      const _winUI = window.NBDScheduleWindowUI;
      const _winErr = _winUI ? _winUI.validate('edit') : null;
      if (_winErr) { _bad(_winErr, 'editSchedStart'); return; }
      updates.scheduledDate = String(_sdEl.value || '').trim();
      if (_winUI) Object.assign(updates, _winUI.read('edit'));
    }
    // Refresh the normalized inbound-SMS match key alongside phone —
    // incomingSMS queries leads by phoneDigits; writing phone without it
    // leaves the OLD number's key on the lead, so texts from the corrected
    // number stop matching. Keep identical to functions/phone-utils.js.
    updates.phoneDigits = String(updates.phone || '').replace(/\D/g, '').replace(/^1/, '').slice(-10);
    await window.updateDoc(window.doc(window.db, 'leads', window._customerId), updates);
    // Update display
    document.getElementById('customerName').textContent = ((updates.firstName + ' ' + updates.lastName).trim()) || 'Unknown';
    var _extra = (updates.serviceAddresses || []).length;
    document.getElementById('customerAddress').textContent =
      (updates.address || '—') + (_extra ? '  (+' + _extra + ' more ' + (_extra === 1 ? 'property' : 'properties') + ')' : '');
    document.getElementById('customerPhone').textContent = updates.phone || '—';
    document.getElementById('customerEmail').textContent = updates.email || '—';
    const callLink = document.getElementById('callLink');
    if (callLink) callLink.href = 'tel:' + updates.phone.replace(/\D/g, '');
    const emailLink = document.getElementById('emailLink');
    if (emailLink) emailLink.href = 'mailto:' + updates.email;
    // NEW-D17: refresh the header value cells live (mirrors loadCustomerData
    // lines ~3449-3451) so the Job Value / Damage Type don't stay stale until
    // a full reload.
    const _jvCell = document.getElementById('infoJobValue');
    if (_jvCell && ('jobValue' in updates)) _jvCell.textContent = updates.jobValue ? `$${parseFloat(updates.jobValue).toLocaleString()}` : '—';
    const _dtCell = document.getElementById('infoDamageType');
    if (_dtCell && ('damageType' in updates)) _dtCell.textContent = updates.damageType || '—';
    // Update local state
    Object.assign(window._currentLead, updates);
    // jobValue feeds the profit-panel margin math → re-render it too
    if (window.ProfitTracker && typeof window.ProfitTracker.renderCostPanel === 'function') {
      try { window.ProfitTracker.renderCostPanel('profitPanel', window._customerId); } catch (e) {}
    }
    closeEditCustomerModal();
    if (typeof showToast === 'function') showToast('Customer info updated', 'success');
  } catch(e) {
    console.error('Save failed:', e);
    if (typeof showToast === 'function') showToast('Failed to save: ' + e.message, 'error');
  }
  btn.disabled = false;
  btn.textContent = 'SAVE CHANGES';
}

// Backdrop click + Esc dismiss are handled by nbdModal (batch-4 consolidation).
