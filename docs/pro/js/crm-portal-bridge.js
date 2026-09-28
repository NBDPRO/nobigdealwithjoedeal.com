/**
 * crm-portal-bridge.js — bulk operations, trash drawer, prospect
 * promote, and SMS helpers.
 *
 * Extracted from crm.js (Step 4b — 2026-05-16) as one of four
 * sibling modules. Load order is critical and locked in
 * dashboard.html:
 *
 *   leads → pipeline → snooze → portal-bridge → crm (shim)
 *
 * This file holds:
 *   - the NBDStore-backed bulk-selection model
 *     (getBulkSelected / updateBulkSelection / toggleBulkMode /
 *     exitBulkMode / toggleCardSelection / selectAllVisibleLeads /
 *     clearBulkSelection / updateBulkToolbar)
 *   - bulk actions (bulkMoveStage / bulkDelete / bulkAssignField
 *     and its bulkAssignCarrier / bulkAssignDamage /
 *     bulkAssignSource / bulkAssignJobType wrappers, bulkSnoozeLeads)
 *   - the writeBatch chunker (commitBulkLeadOp)
 *   - misc CRM helpers (restoreCrmSearch / scrollToFollowUps /
 *     isOverdue)
 *   - editLead / deleteLead + the delete-confirm modal helpers
 *   - the deleted-leads drawer (openDeletedDrawer /
 *     renderDeletedDrawer / restoreDeletedLead /
 *     permanentDeleteLead / refreshTrashBadge)
 *   - prospect surface (window.toggleProspectsView /
 *     window.promoteProspect)
 *   - booking-link + follow-up SMS helpers (window._repBookingUrl /
 *     window.sendBookingSMS / window.sendFollowUpSMS)
 *
 * "portal-bridge" in the module name refers to this file owning the
 * link between the CRM and the homeowner portal (sendBookingSMS /
 * _repBookingUrl) plus the bulk surface reps use to clean up batches
 * of leads before sending. It references the Firebase shim consts
 * (col, _serverTimestamp, …) declared in crm-leads.js as outer-
 * scope globals (classic-script sibling scope).
 *
 * Globals Tranche 2c-3 (2026-07-07): the whole file is IIFE-wrapped so
 * its top-level names no longer auto-attach to `window`. Bare reads of
 * OTHER files' globals (showToast, moveCard, renderLeads, escHtml,
 * _serverTimestamp, …) still resolve through the outer/global scope, so
 * only this file's OWN exports change. Names with live cross-file
 * consumers are re-exported explicitly at the bottom (crm.js no longer
 * re-exports them); the 11 markup-only handlers register in
 * window.__NBD_CALL_REGISTRY (dispatched FIRST by dashboard-ui.js
 * _nbdResolveCall) and are removed from _NBD_CALL_ALLOWLIST. See
 * docs/dev/dashboard-decomposition-plan.md.
 */
(function () {


// ═══════════════════════════════════════════════════════════════
// BULK ACTIONS SYSTEM
//
// Selection state lives at `leads.bulkSelected` in NBDStore (see
// docs/pro/js/state-store.js). The legacy `window._bulkSelected`
// global is mirrored read-only via store.bind so any older read
// site keeps working during migration. All writes go through
// updateBulkSelection() which swaps the Set ref to trigger
// subscriber notify (mutate-in-place would identity-equal and
// be silently ignored by the store).
//
// Bulk toolbar now refreshes via a store subscriber rather than
// every call site remembering to call updateBulkToolbar() — the
// pattern matches the photos.selected migration in PR #76.
// ═══════════════════════════════════════════════════════════════

window._bulkMode = false;
if (window.NBDStore) {
  window.NBDStore.set('leads.bulkSelected', new Set());
  window.NBDStore.bind('_bulkSelected', 'leads.bulkSelected');
  window.NBDStore.subscribe('leads.bulkSelected', function () {
    if (typeof updateBulkToolbar === 'function') updateBulkToolbar();
  });
} else {
  window._bulkSelected = window._bulkSelected || new Set();
}

function getBulkSelected() {
  return (window.NBDStore && window.NBDStore.get('leads.bulkSelected'))
    || window._bulkSelected
    || new Set();
}

function updateBulkSelection(mutate) {
  const prev = getBulkSelected();
  const next = new Set(prev);
  mutate(next);
  if (window.NBDStore) {
    window.NBDStore.set('leads.bulkSelected', next);
  } else {
    window._bulkSelected = next;
    if (typeof updateBulkToolbar === 'function') updateBulkToolbar();
  }
}

function toggleBulkMode() {
  window._bulkMode = !window._bulkMode;
  const btn = document.getElementById('bulkModeBtn');
  const kanbanBoard = document.querySelector('.kanban-board');

  if (window._bulkMode) {
    if (btn) { btn.textContent = 'Cancel'; btn.classList.add('btn-orange'); btn.classList.remove('btn-ghost'); }
    if (kanbanBoard) kanbanBoard.classList.add('bulk-mode-active');
  } else {
    if (btn) { btn.textContent = 'Select'; btn.classList.remove('btn-orange'); btn.classList.add('btn-ghost'); }
    if (kanbanBoard) kanbanBoard.classList.remove('bulk-mode-active');
    clearBulkSelection();
  }
}

// Force-exit bulk mode regardless of current state. Called on view changes
// so a bulk selection started on the kanban can't bleed into another view's
// click handlers.
function exitBulkMode() {
  if (!window._bulkMode) return;
  window._bulkMode = false;
  const btn = document.getElementById('bulkModeBtn');
  const kanbanBoard = document.querySelector('.kanban-board');
  if (btn) { btn.textContent = 'Select'; btn.classList.remove('btn-orange'); btn.classList.add('btn-ghost'); }
  if (kanbanBoard) kanbanBoard.classList.remove('bulk-mode-active');
  clearBulkSelection();
}

function toggleCardSelection(leadId) {
  if (!window._bulkMode) return;

  const card = document.querySelector(`.k-card[data-id="${leadId}"]`);
  if (!card) return;

  const sel = getBulkSelected();
  const isSelectedNow = !sel.has(leadId);
  updateBulkSelection(function (next) {
    if (next.has(leadId)) next.delete(leadId);
    else next.add(leadId);
  });
  card.classList.toggle('bulk-selected', isSelectedNow);
  // updateBulkToolbar runs via store subscriber when NBDStore is
  // present; manual fallback otherwise.
  if (!window.NBDStore) updateBulkToolbar();
}

// Select every currently-rendered (visible) kanban card. Matches
// the kanban filter — anything filtered out via search/stage isn't
// in the DOM, so it isn't selected. Joe's most common need is "all
// cards in this column" or "all visible after filter".
function selectAllVisibleLeads() {
  if (!window._bulkMode) return;
  const cards = document.querySelectorAll('.kanban-board .k-card');
  if (!cards.length) {
    if (typeof showToast === 'function') showToast('No leads visible to select', 'info');
    return;
  }
  updateBulkSelection(function (next) {
    cards.forEach(function (c) {
      const id = c.dataset.id;
      if (id) next.add(id);
    });
  });
  cards.forEach(function (c) { c.classList.add('bulk-selected'); });
  if (!window.NBDStore) updateBulkToolbar();
}

function updateBulkToolbar() {
  const count = getBulkSelected().size;
  const toolbar = document.getElementById('bulkActionBar');
  const countSpan = document.getElementById('bulkSelectedCount');

  if (countSpan) countSpan.textContent = count + ' selected';

  if (!toolbar) return;
  if (count > 0) {
    toolbar.classList.add('active');
    toolbar.style.display = 'flex';
  } else {
    toolbar.classList.remove('active');
    toolbar.style.display = 'none';
  }
}

function clearBulkSelection() {
  updateBulkSelection(function (next) { next.clear(); });
  document.querySelectorAll('.k-card.bulk-selected').forEach(card => {
    card.classList.remove('bulk-selected');
  });
  if (!window.NBDStore) updateBulkToolbar();
}

async function bulkMoveStage() {
  const stageSelect = document.getElementById('bulkStageSelect');
  const newStage = stageSelect.value;

  if (!newStage) {
    showToast('Please select a stage', 'error');
    return;
  }

  // Wave 103: read selection through getBulkSelected() so the
  // NBDStore-backed selection is honored. Previously this read
  // `window._bulkSelected` directly, which becomes stale when the
  // store replaces the reference on every mutation. The guard
  // could pass with stale `.size === 0` while the store held a
  // real selection — bulk-move on zero cards or wrong cards.
  const sel = getBulkSelected();
  if (sel.size === 0) {
    showToast('No cards selected', 'error');
    return;
  }

  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _ask(`Move ${sel.size} lead(s) to "${newStage}"?`))) {
    return;
  }

  const selectedIds = Array.from(sel);

  try {
    // Wave 103: collect failures separately so we can report
    // partial success accurately. Previously a mid-loop failure
    // jumped straight to the catch and the toast claimed all
    // moves succeeded — but the first N had committed and N+1
    // through M had not. Cards 1-N were silently in the new
    // stage, cards N+1 to M still in the old. No way for the
    // rep to know which.
    const failures = [];
    for (const leadId of selectedIds) {
      try { await moveCard(leadId, newStage); }
      catch (err) {
        console.warn('[bulkMoveStage] failed for', leadId, err);
        failures.push(leadId);
      }
    }

    // Clear selection and exit bulk mode regardless — partial
    // success still moved at least some cards, and re-trying the
    // failed ones via individual drag is the cleaner UX.
    clearBulkSelection();
    toggleBulkMode();

    const movedCount = selectedIds.length - failures.length;
    if (failures.length > 0) {
      showToast(`Moved ${movedCount}/${selectedIds.length}. ${failures.length} failed — try again.`, 'error');
    } else {
      showToast(`Moved ${movedCount} lead(s) to ${newStage}`, 'ok');
    }
    return; // skip the outer catch — we handled failures explicitly
    
  } catch (error) {
    console.error('Bulk move error:', error);
    showToast('Some moves failed. Please try again.', 'error');
  }
}

async function bulkDelete() {
  const selSet = getBulkSelected();
  if (selSet.size === 0) {
    showToast('No cards selected', 'error');
    return;
  }

  const _askDel = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _askDel(`Delete ${selSet.size} lead(s)? They will be moved to the trash.`))) {
    return;
  }

  const selectedIds = Array.from(selSet);

  // writeBatch is atomic + 1 round-trip vs N for a serial loop. Caps
  // at 500 ops per batch (Firestore hard limit). Joe's biggest manual
  // selection in practice is ~30, but the chunk loop is here for the
  // someday-flat-CSV-import case that sweeps a few hundred dupes.
  if (!window.writeBatch || !window.db || !window.doc) {
    showToast('Bulk delete unavailable — Firestore not loaded', 'error');
    return;
  }

  try {
    await commitBulkLeadOp(selectedIds, function (batch, ref) {
      batch.update(ref, { deleted: true, deletedAt: _serverTimestamp() });
    });

    await loadLeads();
    clearBulkSelection();
    toggleBulkMode();
    showToast(`Deleted ${selectedIds.length} lead(s)`, 'ok');
  } catch (error) {
    console.error('Bulk delete error:', error);
    showToast('Bulk delete failed: ' + (error && error.message || 'unknown error'), 'error');
  }
}

// Apply a single field write to every selected lead via writeBatch.
// Used by bulkAssignCarrier + bulkAssignDamage. Field allowlist is
// enforced so a future caller can't accidentally bulk-write
// privileged fields (companyId, role, isAdmin) — those are blocked
// by firestore.rules anyway, but a client-side allowlist gives a
// faster failure than a write that the rules silently reject for
// the entire batch.
// Wave 32: extended allowlist — source + jobType are common
// post-import cleanup ops, e.g. fixing 50 imported leads' source
// to "Spring Hailstorm" or routing all cash deals to the cash
// pipeline at once.
const BULK_LEAD_FIELDS = new Set(['carrier', 'damageType', 'followUp', 'tags', 'source', 'jobType']);

async function bulkAssignField(field, value, label) {
  if (!BULK_LEAD_FIELDS.has(field)) {
    console.error('Bulk field not allowlisted:', field);
    showToast('Bulk field not supported', 'error');
    return;
  }
  const selSet = getBulkSelected();
  if (selSet.size === 0) { showToast('No cards selected', 'error'); return; }

  const _askSet = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _askSet(`Set ${label || field} on ${selSet.size} lead(s) to "${value}"?`))) return;

  if (!window.writeBatch || !window.db || !window.doc) {
    showToast('Bulk update unavailable — Firestore not loaded', 'error');
    return;
  }

  const ids = Array.from(selSet);
  try {
    await commitBulkLeadOp(ids, function (batch, ref) {
      const patch = {};
      patch[field] = value;
      patch.updatedAt = _serverTimestamp();
      batch.update(ref, patch);
    });

    // Optimistic local state update so the kanban reflects without
    // a full reload.
    (window._leads || []).forEach(function (l) {
      if (selSet.has(l.id)) l[field] = value;
    });
    if (typeof renderLeads === 'function') {
      renderLeads(window._leads, window._filteredLeads);
    }

    clearBulkSelection();
    toggleBulkMode();
    showToast(`Updated ${ids.length} lead(s) → ${label || field}: ${value}`, 'ok');
  } catch (error) {
    console.error('Bulk assign error:', error);
    showToast('Bulk update failed: ' + (error && error.message || 'unknown error'), 'error');
  }
}

async function bulkAssignCarrier() {
  const sel = document.getElementById('bulkCarrierSelect');
  const value = sel && sel.value;
  if (!value) { showToast('Pick a carrier first', 'error'); return; }
  return bulkAssignField('carrier', value, 'Carrier');
}

async function bulkAssignDamage() {
  const sel = document.getElementById('bulkDamageSelect');
  const value = sel && sel.value;
  if (!value) { showToast('Pick a damage type first', 'error'); return; }
  return bulkAssignField('damageType', value, 'Damage');
}

// Wave 32: bulk-set source — useful after a CSV import where the
// source column was missing or mis-labeled (e.g. all imports come
// in tagged 'Unknown' and need to be re-classified to 'Spring
// Hailstorm Campaign' or similar).
async function bulkAssignSource() {
  const sel = document.getElementById('bulkSourceSelect');
  const customEl = document.getElementById('bulkSourceCustom');
  // Prefer an explicit free-text entry if the rep typed one. Lets
  // them tag a custom campaign without needing to add it to the
  // dropdown first.
  const custom = customEl && customEl.value.trim();
  const value = custom || (sel && sel.value);
  if (!value) { showToast('Pick or type a source first', 'error'); return; }
  return bulkAssignField('source', value, 'Source');
}

// Wave 32: bulk-set jobType — primary use is post-import routing
// (e.g. an export from a finance CRM comes in flat, all rows need
// to be flagged jobType:'finance' so the kanban view filter picks
// them up correctly).
async function bulkAssignJobType() {
  const sel = document.getElementById('bulkJobTypeSelect');
  const value = sel && sel.value;
  if (!value) { showToast('Pick a job type first', 'error'); return; }
  return bulkAssignField('jobType', value, 'Job Type');
}

// Wave 37: bulk-snooze. Hands selected lead IDs to LeadSnooze.bulkPrompt
// which handles the modal + writeBatch commit + cache patch + clear-
// bulk-selection. We just gather + delegate.
async function bulkSnoozeLeads() {
  const selSet = getBulkSelected();
  if (selSet.size === 0) { showToast('No cards selected', 'error'); return; }
  if (!window.LeadSnooze || typeof window.LeadSnooze.bulkPrompt !== 'function') {
    showToast('Snooze module not loaded — refresh and try again', 'error');
    return;
  }
  window.LeadSnooze.bulkPrompt(Array.from(selSet));
}

// Chunk a single Firestore writeBatch op across an arbitrary list of
// lead ids. Each chunk is committed independently — a network blip
// on chunk 2 leaves chunks 0-1 committed and the toast surfaces a
// partial-failure error. Joe's manual selections (~30) fit in one
// chunk; the loop is defense for someday-larger sweeps.
async function commitBulkLeadOp(ids, applyToBatch) {
  // Team visibility (2026-07): staff kanbans can now SELECT teammate-owned
  // cards, but lead writes are rules-denied for non-owners — and a
  // writeBatch is atomic, so a single denied teammate doc would void the
  // whole chunk INCLUDING the caller's own leads. Filter to mutable leads
  // up front and say what was skipped instead of failing everything.
  const _me = window._user && window._user.uid;
  const _claims = window._userClaims || {};
  const _role = _claims.role || '';
  const _isPlatformAdmin = _role === 'admin';
  // Manager edit rights (2026-07): same-company staff can mutate any
  // tenant lead (matches the rules' staff-update clause), so their bulk
  // selections no longer skip teammate cards. Viewers stay filtered.
  const _isStaff = ['company_admin', 'manager'].includes(_role) && !!_claims.companyId;
  const _byId = new Map((window._leads || []).map(l => [l.id, l]));
  const mutable = ids.filter((id) => {
    const l = _byId.get(id);
    // Unknown-to-cache ids and legacy docs without userId keep the old
    // behavior — they only reach a non-owner's selection via cache
    // states the fetch already scopes.
    if (_isPlatformAdmin || !l || !l.userId || !_me) return true;
    if (l.userId === _me) return true;
    return _isStaff && l.companyId === _claims.companyId;
  });
  const skipped = ids.length - mutable.length;
  if (skipped > 0 && typeof window.showToast === 'function') {
    window.showToast(`Skipped ${skipped} teammate-owned lead${skipped === 1 ? '' : 's'} — only the owner can change them.`, 'info');
  }
  const CHUNK = 450; // Firestore hard limit is 500; leave headroom.
  for (let i = 0; i < mutable.length; i += CHUNK) {
    const slice = mutable.slice(i, i + CHUNK);
    const batch = window.writeBatch(window.db);
    for (const id of slice) {
      const ref = window.doc(window.db, 'leads', id);
      applyToBatch(batch, ref);
    }
    await batch.commit();
  }
  return { applied: mutable.length, skipped };
}


function restoreCrmSearch(){
  const saved = localStorage.getItem('nbd_crm_search');
  if(saved){
    const searchInput = document.getElementById('crmSearch');
    if(searchInput){
      searchInput.value = saved;
      kanbanFilter();
    }
  }
}

function scrollToFollowUps(){
  // #followUpAlerts is the inner list; the element renderLeads() shows/hides
  // is its container #followUpAlertsWrap (dashboard.html). Unhiding only the
  // inner div left the wrap display:none, so this scrolled to an invisible
  // target and the click appeared dead. Show + scroll the wrap when it has
  // rendered alerts.
  const wrap=document.getElementById('followUpAlertsWrap');
  const el=document.getElementById('followUpAlerts');
  if(!wrap||!el) return;
  if(el.children.length) wrap.style.display='block';
  if(wrap.style.display!=='none') wrap.scrollIntoView({behavior:'smooth'});
}

function isOverdue(d){ if(!d) return false; const dt=new Date(d); dt.setHours(0,0,0,0); const t=new Date(); t.setHours(0,0,0,0); return dt<t; }

// (exportLeadsCSV removed — canonical definition is in tools.js)

// Edit lead
function editLead(id){
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  const l=(window._leads||[]).find(x=>x.id===id);
  if(!l) return;
  const setV=(eid,val)=>{ const e=document.getElementById(eid); if(e) e.value=val||''; };
  setV('lFname',l.firstName||l.fname||'');
  setV('lLname',l.lastName||l.lname||'');
  setV('lAddr',l.address||'');
  setV('lPhone',l.phone||'');
  setV('lEmail',l.email||'');
  setV('lStage', l._stageKey || l.stage || 'new');
  setV('lJobType', l.jobType || '');
  // Repopulate sub-type options for this job type BEFORE setting the value
  if (_nbdReg && typeof _nbdReg.refreshSubTypeAndTrades === 'function') {
    _nbdReg.refreshSubTypeAndTrades(l.jobType || '');
  }
  setV('lSubType', l.subType || '');
  // Restore selected trades on the chip UI
  if (_nbdReg && typeof _nbdReg.setSelectedTrades === 'function') {
    _nbdReg.setSelectedTrades(Array.isArray(l.trades) ? l.trades : []);
  }
  setV('lSource',l.source||'Door Knock');
  setV('lReferralCode', l.redeemReferralCode||'');
  setV('lDamageType',l.damageType||'');
  setV('lClaimStatus',l.claimStatus||'No Claim');
  setV('lJobValue',l.jobValue||'');
  setV('lLeadCost',l.leadCost||'');
  setV('lFollowUp',l.followUp||'');
  setV('lInsCarrier',l.insCarrier||l.insuranceCarrier||'');
  // Insurance fields
  setV('lClaimNumber', l.claimNumber||'');
  setV('lClaimFiledBy', l.claimFiledBy||'');
  setV('lPolicyNumber', l.policyNumber||'');
  setV('lDateOfLoss', l.dateOfLoss||'');
  setV('lCarrierDecisionAt', l.carrierDecisionAt||'');
  setV('lEstimateAmount', l.estimateAmount||'');
  setV('lDeductible', l.deductibleOrOwedByHO||'');
  setV('lSupplementStatus', l.supplementStatus||'');
  setV('lScopeOfWork', l.scopeOfWork||'');
  // Finance fields
  setV('lFinanceCompany', l.financeCompany||'');
  setV('lLoanAmount', l.loanAmount||'');
  setV('lLoanStatus', l.loanStatus||'');
  setV('lPreQualLink', l.preQualLink||'');
  // Job fields
  setV('lScheduledDate', l.scheduledDate||'');
  setV('lCrew', l.crew||'');
  // 2026-09-15 (Paperwork Filing) — checkboxes use .checked, not .value
  // (setV above would leave every one permanently checked: an unattributed
  // <input type="checkbox"> with no value= attribute reads "on" regardless
  // of checked state). Without this, saveLead()'s
  // `checked ? new Date().toISOString() : ''` would read every checkbox as
  // UNCHECKED on open (default DOM state) and silently WIPE an
  // already-filed timestamp on the next unrelated save (a phone-number fix,
  // say) — populate from the lead's real state so a re-save only refreshes
  // an already-true stamp, never blanks one.
  const setChecked = (eid, val) => { const e = document.getElementById(eid); if (e) e.checked = !!val; };
  setChecked('lContractFiled', l.contractFiledAt);
  setChecked('lPermitFiled', l.permitFiledAt);
  setChecked('lAobFiled', l.aobFiledAt);
  setChecked('lWarrantyCertFiled', l.warrantyCertFiledAt);
  setChecked('lCocFiled', l.cocFiledAt);
  setV('lNotes',l.notes||'');
  const editId=document.getElementById('lEditId'); if(editId) editId.value=id;
  const title=document.getElementById('leadModalTitle'); if(title) title.textContent='Edit Lead';
  openLeadModal();
  // Toggle field visibility based on job type
  if(_nbdReg && typeof _nbdReg.toggleInsuranceFields === 'function') setTimeout(_nbdReg.toggleInsuranceFields, 50);
}

// Delete lead — soft delete with confirm modal
let _pendingDeleteId = null;

function deleteLead(id) {
  const lead = (window._leads||[]).find(l=>l.id===id);
  const name = lead ? (((lead.firstName||'')+' '+(lead.lastName||'')).trim() || lead.address || 'This Lead') : 'This Lead';
  showDeleteConfirm(id, name);
}

function showDeleteConfirm(id, name) {
  _pendingDeleteId = id;
  const nameEl = document.getElementById('delConfirmName');
  const overlay = document.getElementById('delConfirmOverlay');
  if (nameEl) nameEl.textContent = name;
  if (overlay) overlay.classList.add('open');
}

function cancelDeleteConfirm() {
  _pendingDeleteId = null;
  const overlay = document.getElementById('delConfirmOverlay');
  if (overlay) overlay.classList.remove('open');
}

async function confirmDeleteLead() {
  if(!_pendingDeleteId) return;
  const id = _pendingDeleteId;
  const overlay = document.getElementById('delConfirmOverlay');
  if (overlay) overlay.classList.remove('open');
  _pendingDeleteId = null;
  try {
    // _deleteLead resolves true only when the soft-delete write landed. Check
    // === true, not truthiness of "it resolved": an older callee resolved
    // undefined after swallowing a denied write, and this toasted success for
    // a lead that never left the board (e.g. a viewer, whom the leads update
    // rule refuses). The card is untouched on failure — _deleteLead only
    // drops it from window._leads after the write succeeds.
    const ok = await window.__NBD_CALL_REGISTRY._deleteLead(id);
    if (ok !== true) {
      showToast('Could not delete this lead — your role may not allow it. It was not moved to the Deleted bin.', 'error');
      return;
    }
    showToast('Lead moved to Deleted bin');
    refreshTrashBadge();
  } catch(e) { showToast('Delete failed','error'); }
}

// ── DELETED LEADS DRAWER ─────────────────────
async function openDeletedDrawer() {
  const drawer = document.getElementById('deletedDrawer');
  if (!drawer) return;
  drawer.classList.add('open');
  await renderDeletedDrawer();
}
function closeDeletedDrawer() {
  const drawer = document.getElementById('deletedDrawer');
  if (drawer) drawer.classList.remove('open');
}

async function renderDeletedDrawer() {
  const body = document.getElementById('deletedDrawerBody');
  if (!body) return; // drawer not in DOM
  body.innerHTML = '<div class="deleted-empty">Loading...</div>';
  const deleted = await window.__NBD_CALL_REGISTRY._loadDeletedLeads();
  if(!deleted.length) {
    body.innerHTML = '<div class="empty"><div class="empty-icon"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;vertical-align:middle;"><circle cx="10" cy="10" r="7"/><path d="M7 10l2 2 4-5"/></svg></div><div class="empty-title">All Clear</div><div class="empty-sub">No deleted leads in the trash.</div></div>';
    return;
  }
  // Every deleted-lead field is escaped via escHtml before interpolation,
  // and the action buttons use data-* + event delegation so an attacker-
  // controlled lead name/address can never break out of an attribute.
  body.innerHTML = deleted.map(l => {
    const rawName = ((l.firstName||'')+' '+(l.lastName||'')).trim() || l.address || 'Lead';
    const name = escHtml(rawName);
    const addr = escHtml((l.address||'').split(',').slice(0,2).join(','));
    const deletedDate = escHtml(l.deletedAt?.toDate ? l.deletedAt.toDate().toLocaleDateString() : 'Recently');
    const val = l.jobValue ? ' · $'+parseFloat(l.jobValue).toLocaleString() : '';
    const stage = escHtml((typeof window.stageLabel === 'function' && l.stage && window.stageLabel(l.stage)) || l.stage || 'New');
    const safeId = escHtml(l.id);
    return `<div class="deleted-card" id="dc-${safeId}">
      <div class="deleted-card-name">${name}</div>
      <div class="deleted-card-addr">${addr}</div>
      <div class="deleted-card-meta">Stage: ${stage}${val} · Deleted ${deletedDate}</div>
      <div class="deleted-card-btns">
        <button type="button" class="dc-restore nbd-dc-restore" data-id="${safeId}">Restore</button>
        <button type="button" class="dc-perm nbd-dc-perm" data-id="${safeId}" data-name="${name}">Remove</button>
      </div>
    </div>`;
  }).join('');
  // Wire delegated listeners.
  body.querySelectorAll('.nbd-dc-restore').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof restoreDeletedLead === 'function') restoreDeletedLead(btn.dataset.id);
    });
  });
  body.querySelectorAll('.nbd-dc-perm').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof permanentDeleteLead === 'function') permanentDeleteLead(btn.dataset.id, btn.dataset.name || '');
    });
  });
}

// _restoreLead resolves true only when the un-delete write landed. On anything
// else the lead is still deleted on the server: un-dim its trash card so the
// restore can be retried, say it failed, and leave the board and the badge
// alone — never "Lead restored" for a lead that is still in the Deleted bin.
async function restoreDeletedLead(id) {
  const card = document.getElementById('dc-'+id);
  if(card) { card.style.opacity='0.4'; card.style.pointerEvents='none'; }
  let ok = false;
  try { ok = await window._restoreLead(id); } catch (e) { ok = false; }
  if (ok !== true) {
    if(card) { card.style.opacity=''; card.style.pointerEvents=''; }
    showToast('Could not restore this lead — your role may not allow it. It is still in the Deleted bin.', 'error');
    return;
  }
  // The write landed: reload the board from the server, so the restored lead
  // shows exactly as the server now holds it.
  try { await window._loadLeads(); } catch (e) { console.warn('restore reload:', e); }
  showToast('Lead restored');
  refreshTrashBadge();
  await renderDeletedDrawer();
}

async function permanentDeleteLead(id, name) {
  const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
  if (!(await _ask(`Permanently delete "${name}"? This CANNOT be undone.`))) return;
  const card = document.getElementById('dc-'+id);
  if(card) { card.style.opacity='0.4'; card.style.pointerEvents='none'; }
  // _permanentDeleteLead resolves true only when deleteDoc succeeded. On
  // anything else the lead is still in the trash: un-dim its card so it can
  // be retried, and say it failed — never "Permanently deleted" for a
  // homeowner record that still exists.
  let ok = false;
  try { ok = await window._permanentDeleteLead(id); } catch (e) { ok = false; }
  if (ok !== true) {
    if(card) { card.style.opacity=''; card.style.pointerEvents=''; }
    showToast('Could not permanently delete this lead — your role may not allow it. It is still in the Deleted bin.', 'error');
    return;
  }
  showToast('Permanently deleted');
  refreshTrashBadge();
  await renderDeletedDrawer();
}

async function refreshTrashBadge() {
  try {
    const deleted = await window.__NBD_CALL_REGISTRY._loadDeletedLeads();
    const badge = document.getElementById('trashCountBadge');
    if(badge) {
      badge.textContent = deleted.length || '';
      badge.style.display = deleted.length ? 'flex' : 'none';
    }
  } catch(e) { console.warn('refreshTrashBadge:', e.message); }
}

// ─── Prospects toggle (April 2026) ───
// Flips the 'nbd_crm_show_prospects' localStorage flag and re-renders
// the kanban. When ON, raw unqualified knocks that auto-created leads
// with isProspect:true show up alongside real customers. When OFF
// (default), they're hidden to keep the kanban clean.
window.toggleProspectsView = function() {
  const current = localStorage.getItem('nbd_crm_show_prospects') === '1';
  if (current) {
    localStorage.removeItem('nbd_crm_show_prospects');
    if (typeof window.showToast === 'function') window.showToast('Prospects hidden', 'info');
  } else {
    localStorage.setItem('nbd_crm_show_prospects', '1');
    if (typeof window.showToast === 'function') window.showToast('Prospects visible', 'info');
  }
  renderLeads(window._leads, window._filteredLeads);
};

// ─── Promote a prospect to a full customer ───
// Strips the isProspect flag + bumps stage from 'prospect' to 'new'
// if that's the current stage. Called from the lead detail modal's
// "Promote to Customer" button (added in a separate edit) or
// programmatically after a photo is uploaded / phone is captured.
window.promoteProspect = async function(leadId) {
  if (!leadId) return;
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) { if (typeof window.showToast === 'function') window.showToast('Lead not found', 'error'); return; }
  if (!lead.isProspect) { if (typeof window.showToast === 'function') window.showToast('Already a full customer', 'info'); return; }
  try {
    const leadRef = window.doc(window.db, 'leads', leadId);
    const patch = { isProspect: false, promotedAt: window.serverTimestamp(), updatedAt: window.serverTimestamp() };
    // If the lead is still sitting in 'prospect' pseudo-stage, bump
    // it to 'new' so the kanban has a real home for it.
    if ((lead.stage || '').toLowerCase() === 'prospect') patch.stage = 'new';
    await window.updateDoc(leadRef, patch);
    lead.isProspect = false;
    if (patch.stage) lead.stage = patch.stage;
    renderLeads(window._leads, window._filteredLeads);
    if (typeof window.showToast === 'function') window.showToast('✓ Promoted to customer', 'success');
  } catch (e) {
    console.error('promoteProspect failed:', e);
    if (typeof window.showToast === 'function') window.showToast('Failed to promote: ' + e.message, 'error');
  }
};
// ── Booking SMS from Kanban Card ─────────────────────
// ── Rep booking URL helper ─────────────────────
// Returns the Cal.com URL for the signed-in rep. Priority:
//   1. window._currentRep.calcomUsername (hydrated from users/{uid}
//      on auth state change — authoritative).
//   2. localStorage 'nbd_cal_settings' (legacy cache from older
//      versions of the app; kept so reps who haven't re-saved
//      still get a link).
//   3. Default nobigdeal/roof-inspection (Joe's pooled link).
// Usage:
//   const url = window._repBookingUrl();
// Exposed so any other surface (customer portal, email templates,
// notifications) can reuse the same resolution logic instead of
// re-implementing it.
window._repBookingUrl = function () {
  const rep = window._currentRep || {};
  const username = (rep.calcomUsername || '').trim();
  if (username) {
    const slug = (rep.calcomEventSlug || 'roof-inspection').trim();
    return 'https://cal.com/' + encodeURIComponent(username) + '/' + encodeURIComponent(slug);
  }
  // Legacy fallback
  try {
    const legacy = JSON.parse(localStorage.getItem('nbd_cal_settings') || '{}');
    if (legacy.username) {
      const slug = legacy.eventSlug || 'roof-inspection';
      return 'https://cal.com/' + encodeURIComponent(legacy.username) + '/' + encodeURIComponent(slug);
    }
  } catch (e) {}
  // House account — for the NBD tenant ONLY. Returning it unconditionally
  // meant a contractor who never configured Cal.com texted his homeowner a
  // link to the platform owner's calendar, and every booking landed there.
  // A tenant with nothing configured gets '' so callers can decline to send;
  // see the !url guards in dashboard-ui.js shareCalViaSMS / shareCalViaEmail.
  try {
    const _b = (typeof window._brand === 'function') ? (window._brand() || null) : null;
    const _isNbd = !_b || !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
    if (!_isNbd) return '';
  } catch (e) { /* fall through to the house account */ }
  return 'https://cal.com/nobigdeal/roof-inspection';
};

window.sendBookingSMS = function(leadId, phone, firstName) {
  const bookingUrl = window._repBookingUrl();
  // _repBookingUrl now returns '' for a tenant with no calendar configured
  // (it used to hand back the platform owner's). Sending "Pick a time here: "
  // with nothing after it is worse than not sending — tell the rep what to fix.
  if (!bookingUrl) {
    if (typeof showToast === 'function') {
      showToast('Set up your booking link first — Schedule → Your Booking Link', 'error');
    }
    return;
  }
  const cleanPhone = (phone || '').replace(/\D/g, '');
  // M1 brand parity (customer-bootstrap.module.js pattern): NBD keeps
  // 'Joe from No Big Deal Roofing'; a non-NBD tenant uses its own smsSignOff
  // (or its legalName if unset) — never NBD's name in another company's SMS.
  const _b = (window._brand && window._brand()) || {};
  const signOff = _b.smsSignOff || ((!_b.legalName || _b.legalName === 'No Big Deal Home Solutions') ? 'Joe from No Big Deal Roofing' : _b.legalName);
  const body = encodeURIComponent(`Hey${firstName ? ' ' + firstName : ''}, this is ${signOff}! I'd love to set up a free roof inspection at your convenience. Pick a time that works for you here: ${bookingUrl}`);
  window.open(`sms:${cleanPhone}?body=${body}`, '_self');
};

// ── Follow-Up SMS Reminder ─────────────────────
// Quick SMS from notification or follow-up alert
window.sendFollowUpSMS = function(leadId) {
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead || !lead.phone) {
    if (typeof showToast === 'function') showToast('No phone number on file for this lead', 'error');
    return;
  }
  const firstName = lead.firstName || lead.fname || '';
  const cleanPhone = lead.phone.replace(/\D/g, '');
  const bookingUrl = window._repBookingUrl();
  // Sign-off resolves per tenant — this hardcoded "Joe from No Big Deal Home
  // Solutions", so a contractor's follow-up introduced him as the platform
  // owner. Same resolution sendBookingSMS directly above already does.
  const _b = (window._brand && window._brand()) || {};
  const _isNbd = !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
  const signOff = _b.smsSignOff || (_isNbd ? 'Joe from No Big Deal Home Solutions' : (_b.legalName || ''));
  // The booking link is optional here (the message stands without it), unlike
  // sendBookingSMS whose entire purpose is the link.
  const bookingLine = bookingUrl ? ` If you'd like to schedule a time to chat: ${bookingUrl}` : '';
  const intro = signOff ? `, this is ${signOff}` : '';
  const body = encodeURIComponent(
    `Hi${firstName ? ' ' + firstName : ''}${intro}. Just following up on your project — wanted to check in and see if you have any questions.${bookingLine}`
  );
  window.open(`sms:${cleanPhone}?body=${body}`, '_self');
};


// ─────────────────────────────────────────────────────────────────────
// Globals Tranche 2c-3: deliberate window surface + registry wiring
// ─────────────────────────────────────────────────────────────────────
// (a) These names have LIVE cross-file consumers that resolve OUTSIDE
// the dashboard-ui.js registry — a bare cross-file read, a window[fn]
// dispatch via _NBD_TOGGLE_FNS / _NBD_MODAL_CLOSE_FNS, or a direct
// window.X() call — so they must stay on window. crm.js no longer
// re-exports them (those bare re-exports would ReferenceError now that
// the names are IIFE-scoped); this file owns its window surface.
window.editLead = editLead;                        // crm-pipeline.js:351 (bare), dashboard-actions/bootstrap, kanban-context-menu
window.deleteLead = deleteLead;                    // kanban-context-menu.js:273 (window.deleteLead)
window.showDeleteConfirm = showDeleteConfirm;      // maps-overlays.js:358 (bare) — was only a classic auto-global before
window.toggleCardSelection = toggleCardSelection;  // crm-pipeline.js:2007
window.clearBulkSelection = clearBulkSelection;    // lead-snooze.js:773 (direct window.clearBulkSelection()) — stays allowlisted too
window.updateBulkToolbar = updateBulkToolbar;      // internal callers + smoke pin (crm.test.js)
window.restoreCrmSearch = restoreCrmSearch;        // dashboard-bootstrap.module.js:1253,2068
window.refreshTrashBadge = refreshTrashBadge;      // dashboard-bootstrap.module.js:1256
// (toggleProspectsView, promoteProspect, _repBookingUrl, sendBookingSMS,
//  sendFollowUpSMS keep their in-file window.* assignments above.)

// (b) The 12 markup-dispatched handlers register in __NBD_CALL_REGISTRY —
// (closeDeletedDrawer joined 2026-09-02, Tranche 3 dispatch-map slice: its
// only reach is the _NBD_MODAL_CLOSE_FNS entry, registry-first since T3-M,
// so its export above is gone — the conversion the old comment there queued.)
// dashboard-ui.js's _nbdResolveCall checks the registry BEFORE the
// allowlisted-window fallback, so registration IS the security opt-in the
// _NBD_CALL_ALLOWLIST entry used to be. Their allowlist entries are removed
// in dashboard-state.js. (clearBulkSelection is NOT registered — it keeps
// its window re-export above AND its allowlist entry, the same MUST-STAY
// shape as goToMyLocation, because lead-snooze.js calls it as
// window.clearBulkSelection() outside the dispatcher.)
//
// (c) Globals Tranche 3 T3-C (2026-09-18): three names whose cross-file
// consumers now read this registry instead of window, so their window
// exports are gone. exitBulkMode — dashboard-actions.js goTo(). toggleBulkMode
// — lead-snooze.js's post-bulk-snooze exit, plus the #bulkModeBtn
// _NBD_TOGGLE_FNS.bulkMode map entry (resolved registry-first by
// dashboard-ui.js _nbdResolveMapped). scrollToFollowUps — analytics-kpi.js's
// data-ak-action delegate. Every consumer treats a missing entry as a no-op.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  selectAllVisibleLeads: selectAllVisibleLeads,
  openDeletedDrawer: openDeletedDrawer,
  closeDeletedDrawer: closeDeletedDrawer,
  confirmDeleteLead: confirmDeleteLead,
  cancelDeleteConfirm: cancelDeleteConfirm,
  bulkSnoozeLeads: bulkSnoozeLeads,
  bulkMoveStage: bulkMoveStage,
  bulkDelete: bulkDelete,
  bulkAssignSource: bulkAssignSource,
  bulkAssignJobType: bulkAssignJobType,
  bulkAssignDamage: bulkAssignDamage,
  bulkAssignCarrier: bulkAssignCarrier,
  exitBulkMode: exitBulkMode,
  toggleBulkMode: toggleBulkMode,
  scrollToFollowUps: scrollToFollowUps
});

})();
