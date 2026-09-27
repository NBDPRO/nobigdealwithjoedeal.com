/**
 * crm-leads.js — lead CRUD: utilities, Firebase shim, lead modal,
 * saveLead.
 *
 * Extracted from crm.js (Step 4b — 2026-05-16) as one of four
 * sibling modules. Load order is critical and locked in
 * dashboard.html:
 *
 *   leads → pipeline → snooze → portal-bridge → crm (shim)
 *
 * This file is loaded FIRST so every later split module + the shim
 * can rely on:
 *   - escHtml + debounce (used by every render path)
 *   - the Firebase aliases (db, col, _addDoc, _updateDoc, _doc,
 *     _getDoc, _getDocs, _where, _orderBy, _query, _serverTimestamp,
 *     _arrayUnion) — declared ONCE here so later modules just read
 *     them as outer-scope globals (classic-script sibling scope)
 *   - openLeadModal / closeLeadModal / saveLead (window-exposed)
 *
 * LOAD-ORDER CONTRACT: crm-leads.js MUST load after the Firebase
 * ES-module script in the host page (dashboard.html / customer.html)
 * populates window.db, window.collection, etc. The _assertFirebaseLoaded
 * IIFE below fails loud at load time so misordered script tags show
 * up in the console immediately instead of as invisible "nothing
 * saved" bugs later.
 */

// ══════════════════════════════════════════════
// UTILITIES
// ══════════════════════════════════════════════
function escHtml(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

// Debounce helper — returns a wrapper that delays invocation by `ms`
let _debounceTimers = {};
function debounce(fn, ms, key){
  key = key || fn.name || 'default';
  return function(...args){
    clearTimeout(_debounceTimers[key]);
    _debounceTimers[key] = setTimeout(()=> fn.apply(this, args), ms);
  };
}

// ══════════════════════════════════════════════
// CRM
// ══════════════════════════════════════════════
// Firebase shim — aliases window globals for use in this file.
//
// LOAD-ORDER CONTRACT: crm.js MUST load after the Firebase ES-module
// script in the host page (dashboard.html / customer.html) populates
// window.db, window.collection, etc. If any of these are undefined at
// parse time the module locks them in as undefined forever and every
// Firestore call below silently no-ops. The assertion below fails loud
// at load time so misordered script tags show up in the console
// immediately instead of as invisible "nothing saved" bugs later.
const db = window.db;
const col = window.collection;
const _addDoc = window.addDoc;
const _updateDoc = window.updateDoc;
const _deleteDoc = window.deleteDoc;
const _doc = window.doc;
const _getDoc = window.getDoc;
const _getDocs = window.getDocs;
const _where = window.where;
const _orderBy = window.orderBy;
const _query = window.query;
const _serverTimestamp = window.serverTimestamp;
const _arrayUnion = window.arrayUnion;
(function _assertFirebaseLoaded() {
  const missing = [
    ['db', db], ['collection', col], ['addDoc', _addDoc], ['updateDoc', _updateDoc],
    ['deleteDoc', _deleteDoc], ['doc', _doc], ['getDoc', _getDoc], ['getDocs', _getDocs],
    ['where', _where], ['orderBy', _orderBy], ['query', _query],
    ['serverTimestamp', _serverTimestamp], ['arrayUnion', _arrayUnion]
  ].filter(([, v]) => !v).map(([n]) => n);
  if (missing.length) {
    console.error('[crm.js] Firebase not ready at parse time — missing: ' + missing.join(', ') +
                  '. Every Firestore call in this file will silently no-op. Check script order in the host page.');
  }
})();


function openLeadModal(){
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const modal = document.getElementById('leadModal');
  if (!modal) return; // standalone compat — modal not in DOM
  // nbdModal owns Esc/backdrop/focus on dashboard.html; classList fallback on
  // pages without nbd-modal.js (none since the legacy twin retired 2026-09-02). onClose runs the full form reset on every dismiss.
  if (window.nbdModal) { window.nbdModal.open('leadModal', { onClose: _leadModalReset }); }
  else { modal.classList.add('open'); }
  // Auto-infer jobType from current view: when user is on Cash view and clicks Add Lead,
  // default the new lead to jobType=cash (same for Insurance/Finance).
  const jtEl = document.getElementById('lJobType');
  const isEdit = !!(document.getElementById('lEditId')?.value);
  if (jtEl && !isEdit && !jtEl.value) {
    const view = window._currentViewKey || '';
    if (['insurance','cash','finance'].includes(view)) {
      jtEl.value = view;
    }
  }
  // Rebuild the stage <select> from the RESOLVED tenant pipeline before the
  // track filter runs. The page markup carries a static option list of the
  // built-in stages only, so a tenant with a custom pipeline had no option
  // matching the lead's stage: the select read back as '' and saveLead wrote
  // that empty string over the stored stage. editLead assigns #lStage BEFORE
  // it calls us, so by now an unknown key has already collapsed to '' —
  // recover the intended value from the in-memory lead and hand it over.
  // Both stage-picker helpers below are registry-only (Globals Tranche 3
  // T3-C, 2026-09-18), not bare window globals. Registry missing (module
  // failed) → the static built-in option list stays, as before.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (_nbdReg && typeof _nbdReg.refreshStageOptions === 'function') {
    const stEl = document.getElementById('lStage');
    let want = stEl?.value || '';
    if (!want && isEdit) {
      const editing = (window._leads || []).find(l => l && l.id === document.getElementById('lEditId').value);
      if (editing) want = editing._stageKey || editing.stage || '';
    }
    _nbdReg.refreshStageOptions(want || 'new');
  }
  // Apply smart stage dropdown filter based on current jobType
  if (_nbdReg && typeof _nbdReg.filterStageDropdownByJobType === 'function') {
    _nbdReg.filterStageDropdownByJobType(jtEl?.value || '');
  }
}
function closeLeadModal(){
  // Visibility toggle is dual-path (nbdModal on dashboard.html, classList on
  // pages without nbd-modal.js (none since the legacy twin retired 2026-09-02)). The form reset lives in _leadModalReset so it runs
  // on EVERY dismiss — nbdModal fires it via onClose (button/backdrop/Esc), and
  // the legacy branch calls it directly.
  if (window.nbdModal) { window.nbdModal.close('leadModal'); return; }
  const modal = document.getElementById('leadModal');
  if (modal) modal.classList.remove('open');
  _leadModalReset();
}

function _leadModalReset(){
  // Null-safe one-liner helpers — DOM elements may be absent in
  // standalone/compat mode or if the modal was removed from the view.
  const setVal = (id) => { const el = document.getElementById(id); if (el) el.value = ''; };
  const hide   = (id) => { const el = document.getElementById(id); if (el) el.style.display = 'none'; };

  hide('mErr'); hide('mOk');

  ['lFname','lLname','lAddr','lPhone','lEmail','lNotes',
   'lJobValue','lLeadCost','lFollowUp','lInsCarrier','lReferralCode'].forEach(setVal);

  const editId = document.getElementById('lEditId'); if(editId) editId.value='';
  const title = document.getElementById('leadModalTitle'); if(title) title.textContent='Add Lead';
  const jt=document.getElementById('lJobType'); if(jt) jt.value='';
  // Pre-existing gap: this reset list never touched #lStage, so a stage
  // picked while editing one lead silently carried over as the default for
  // the NEXT lead opened in this modal (including via
  // EntityResolver.openQuickCreate) — reset it back to New on every dismiss.
  const st=document.getElementById('lStage'); if(st) st.value='new';
  // Clear insurance/finance/job fields
  ['lClaimNumber','lEstimateAmount','lDeductible','lScopeOfWork','lFinanceCompany','lLoanAmount','lPreQualLink','lScheduledDate','lCrew'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
  ['lClaimFiledBy','lSupplementStatus','lLoanStatus'].forEach(id=>{ const e=document.getElementById(id); if(e) e.value=''; });
  // 2026-09-25: editLead fills these six (crm-portal-bridge.js) but no reset
  // ever cleared them, so dismissing an edit and tapping Add Lead opened the
  // NEXT lead pre-filled with the last one's damage type, claim status,
  // source, sub-type, policy number and date of loss — a rep typing a new
  // name saved another homeowner's claim onto it. Selects go back to their
  // first option ('' / Door Knock / No Claim), which is each one's default.
  ['lPolicyNumber','lDateOfLoss'].forEach(setVal);
  ['lDamageType','lClaimStatus','lSource','lSubType'].forEach(id=>{ const e=document.getElementById(id); if(e && e.options && e.options.length) e.value=e.options[0].value; });
  // 2026-09-15 (Paperwork Filing) — checkboxes, not text fields: .value='' is
  // a no-op on an <input type="checkbox"> (it never uncheckes one). Without
  // this, a filed checkbox ticked while editing lead A would still read
  // checked when the modal reopened blank for "Add Lead", silently stamping
  // a fresh contractFiledAt/etc. on a brand-new lead that was never filed.
  ['lContractFiled','lPermitFiled','lAobFiled','lWarrantyCertFiled','lCocFiled'].forEach(id=>{ const e=document.getElementById(id); if(e) e.checked=false; });
  // Hide conditional field blocks
  ['insuranceFieldsBlock','financeFieldsBlock','jobFieldsBlock'].forEach(id=>{ const e=document.getElementById(id); if(e) e.style.display='none'; });
  window._modalIntel = null;
  // Drop the map-pin / GPS latch with the form it belongs to. maps-overlays
  // sets _pendingPinId + _pendingPinLatLng ~100ms AFTER openLeadModal, so this
  // reset (dismiss-only) never races the flow that populates them — but an
  // abandoned pin-lead used to leave the coordinates armed, and the next lead
  // that failed to geocode inherited that house's location silently.
  window._pendingPinId = null;
  window._pendingPinLatLng = null;
  const mir = document.getElementById('modalIntelResult');
  if(mir) { mir.classList.remove('visible'); mir.innerHTML=''; }
  const pib = document.getElementById('pullIntelBtn');
  if(pib) { pib.classList.remove('loading'); pib.innerHTML='<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:11px;height:11px;vertical-align:middle;"><path d="M2 10l8-7 8 7"/><path d="M4 9v7a1 1 0 001 1h10a1 1 0 001-1V9"/></svg> Pull Property Intel'; }
}
// Null-guarded — if leadModal doesn't exist yet (deferred script
// running before DOM is fully painted in web app standalone mode),
// this would crash and kill ALL of crm.js including renderLeads().
const _leadModal = document.getElementById('leadModal');

// The free-text fields the rep fills in by hand. Selects are deliberately
// LEFT OUT: openLeadModal auto-infers #lJobType from the current view and
// _leadModalReset parks #lStage on 'new', so both read non-empty on a form
// nobody has touched — counting them would prompt on every single dismiss.
const _LEAD_TYPED_FIELDS = [
  'lFname','lLname','lAddr','lPhone','lEmail','lNotes','lJobValue','lLeadCost','lFollowUp',
  'lInsCarrier','lReferralCode','lClaimNumber','lPolicyNumber','lDateOfLoss','lEstimateAmount','lDeductible',
  'lScopeOfWork','lFinanceCompany','lLoanAmount','lPreQualLink','lScheduledDate','lCrew'
];
function _leadFormHasContent(){
  return _LEAD_TYPED_FIELDS.some(id => {
    const el = document.getElementById(id);
    return !!(el && String(el.value || '').trim());
  });
}

// Backdrop dismiss, guarded. On a phone the lead modal is a bottom sheet, so a
// live strip of backdrop sits above it exactly where a thumb lands — and the
// dismiss path runs _leadModalReset, which blanks ~25 fields with no undo. A
// half-typed lead at the door was disappearing on a stray tap. Empty form still
// closes instantly (nothing to lose); a form with typed work asks first.
//
// This has to be fixed HERE, on the element listener. Opening with
// { static: true } only silences nbdModal's own delegated backdrop handler —
// and it silences its Esc handler too, which must keep working. So we guard
// this listener and stopPropagation the backdrop click so nbdModal's delegated
// handler (which would close unguarded) never sees it. The explicit ✕ buttons
// and Esc still close in one action, deliberately: this guards the ACCIDENT.
let _leadDiscardAsking = false;
if (_leadModal) _leadModal.addEventListener('click', async (e) => {
  if (e.target !== _leadModal) return;
  // The address autocomplete closes itself from a document-level BUBBLE
  // listener (dashboard-ui.js, initAddressAutocomplete on #lAddr), so the
  // stopPropagation below would leave its suggestion dropdown hanging open
  // over the sheet. There is no per-listener stop, so dismiss it explicitly
  // first — a backdrop tap should close the dropdown whichever way the rest
  // of this handler goes.
  if (typeof window.hideAcDrop === 'function') { try { window.hideAcDrop('lAddr'); } catch (_) {} }
  e.stopPropagation();
  if (!_leadFormHasContent()) { closeLeadModal(); return; }
  if (_leadDiscardAsking) return; // a second backdrop tap while the prompt is up
  _leadDiscardAsking = true;
  try {
    // Edit mode arrives pre-filled, so "has content" can't tell an untouched
    // edit from a modified one — we ask either way and word it honestly.
    const isEdit = !!(document.getElementById('lEditId')?.value);
    const title = isEdit ? 'Discard your changes?' : 'Discard this lead?';
    const body  = isEdit ? 'Edits made here have not been saved yet.'
                         : 'Nothing here has been saved yet, and it cannot be recovered.';
    const ok = window.nbdModal
      ? await window.nbdModal.confirm({ title: title, body: body, okLabel: 'Discard', cancelLabel: 'Keep editing', danger: true })
      : await (window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m))))(title + ' ' + body);
    if (ok) closeLeadModal();
  } finally { _leadDiscardAsking = false; }
});
document.addEventListener('DOMContentLoaded',()=>{const tm=document.getElementById('taskModal');if(tm)tm.addEventListener('click',e=>{if(e.target===tm)closeTaskModal();});});

async function saveLead(){
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const mErr=document.getElementById('mErr'),mOk=document.getElementById('mOk');
  const saveBtn=document.querySelector('#leadModal .msave');
  // Lead modal may be absent in standalone/compat mode — bail cleanly.
  if(!mErr||!mOk||!saveBtn){console.warn('saveLead: lead modal not in DOM');return;}
  mErr.style.display='none';mOk.style.display='none';
  // Validation feedback. #mErr sits at the TOP of the lead modal while the
  // Save button is ~230 lines of markup lower, so on a phone the rep has
  // scrolled the strip out of view by the time they tap Save — the
  // "silent failure" the 2026-08-18 address audit observed live. Scroll
  // the strip back into view and toast as well, so the reason is seen
  // wherever the rep is looking.
  const showFormError = (msg, focusEl) => {
    mErr.textContent = msg;
    mErr.style.display = 'block';
    try { mErr.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    if (typeof showToast === 'function') showToast(msg, 'error');
    if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
  };
  const fnameEl=document.getElementById('lFname');
  const addrEl =document.getElementById('lAddr');
  if(!fnameEl||!addrEl){showFormError('Lead form missing — reload the page.');return;}
  const fname=fnameEl.value.trim();
  const addr=addrEl.value.trim();
  if(!fname||!addr){showFormError('Name and address required.', !fname ? fnameEl : addrEl);return;}

  // Email + phone validation. The native <input type="email"> validation
  // is bypassed when this function is called via the Save button's
  // onclick handler (no form submit), so we have to validate explicitly
  // before passing the data to _saveLead. Failing here means the rep
  // sees a clear inline error instead of the data silently writing
  // through and breaking the SMS/email-prefill flows downstream.
  const phoneEl = document.getElementById('lPhone');
  const emailEl = document.getElementById('lEmail');
  const phoneRaw = (phoneEl?.value || '').trim();
  const emailRaw = (emailEl?.value || '').trim();
  if (emailRaw) {
    // RFC-5322-lite — good enough to catch typos without rejecting valid edge cases.
    const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw);
    if (!emailOk) {
      showFormError('Email looks invalid (e.g. name@example.com).', emailEl);
      return;
    }
  }
  if (phoneRaw) {
    // Accept any input with at least 10 digits. The display normalization
    // happens downstream — we just want to reject obvious junk.
    const digits = phoneRaw.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) {
      showFormError('Phone needs at least 10 digits.', phoneEl);
      return;
    }
  }

  // Prevent double-submit
  if(saveBtn.disabled) return;
  saveBtn.disabled=true;
  const origText=saveBtn.textContent;
  saveBtn.textContent='Saving...';
  const intelData = window._modalIntel || {};
  // Keep the denormalized stageRole in sync with the edited stage. moveCard
  // stamps stageRole on drags, but the Edit-modal save path only wrote `stage`
  // — leaving a STALE persisted stageRole that the server's won/lost classifier
  // trusts (missed referral payouts + review nudges; wrong role-keyed KPIs).
  // Tenant-aware via window.stageRole (custom-pipeline roleOf); normalize the
  // dropdown value to an internal key first.
  const _editStageVal = document.getElementById('lStage')?.value || '';
  const _editStageRole = _editStageVal
    ? (typeof window.stageRole === 'function'
        ? window.stageRole(typeof window.normalizeStage === 'function' ? window.normalizeStage(_editStageVal) : _editStageVal)
        : undefined)
    : undefined;
  // saveLead: proceed with save
  try {
    // Field reads below all use optional chaining; the 6 that previously
    // assumed `.value` directly (lLname/lPhone/lEmail/lStage/lSource/lNotes)
    // would null-deref if the lead-modal markup ever ships without one of
    // them. The entry guards on lines 139/143 cover the common case but
    // we make the field-level reads safe too for consistency with the
    // rest of the object literal.
    const _leadPayload = {
      id: (document.getElementById('lEditId')?.value||undefined)||undefined,
      firstName: fname,
      lastName: document.getElementById('lLname')?.value?.trim() || '',
      address: addr,
      phone: document.getElementById('lPhone')?.value?.trim() || '',
      email: document.getElementById('lEmail')?.value?.trim() || '',
      // OMIT `stage` entirely when the select came back blank. A blank means
      // the dropdown had no option matching this lead's stage (a custom
      // pipeline stage, or one the tenant later removed) — writing '' would
      // DESTROY the stored stage on every save, while a missing key leaves it
      // untouched. openLeadModal repopulates the options so this should now be
      // unreachable; it stays as the last line of defence because the cost of
      // being wrong is silent data loss.
      ...(_editStageVal ? { stage: _editStageVal } : {}),
      // Sync the denormalized role with the stage (see _editStageRole above).
      ...(_editStageRole ? { stageRole: _editStageRole } : {}),
      jobType: document.getElementById('lJobType')?.value || '',
      subType: document.getElementById('lSubType')?.value || '',
      // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
      // OMIT `trades` when the chip state is UNKNOWN, same rule as `stage`
      // above: this payload is spread straight into updateDoc on an edit, so
      // a `[]` stand-in overwrote the lead's stored trades with nothing. That
      // happened when the registry helper was missing (a stale cached
      // bootstrap) AND on a normal load whenever the chips were never drawn —
      // getSelectedTrades() now returns null for that (a lead with job type
      // "Not Set" never renders them). A user who deliberately clears every
      // chip still gets a real [] and saves it.
      ...(() => {
        const _t = (window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.getSelectedTrades === 'function')
          ? window.__NBD_CALL_REGISTRY.getSelectedTrades() : null;
        return Array.isArray(_t) ? { trades: _t } : {};
      })(),
      source: document.getElementById('lSource')?.value || '',
      // Referral-code redemption: the code this lead was referred with (if any).
      // Stamped raw + uppercased; the server-side onReferralLeadWrite trigger
      // resolves it to the referrer and credits the $100 bonus on close.
      redeemReferralCode: (document.getElementById('lReferralCode')?.value || '').toUpperCase().replace(/[^A-Z0-9-]/g, ''),
      damageType: document.getElementById('lDamageType')?.value||'',
      claimStatus: document.getElementById('lClaimStatus')?.value||'No Claim',
      jobValue: parseFloat(document.getElementById('lJobValue')?.value)||0,
      // What this lead cost to acquire (Thumbtack/Yelp/Angi fee). Deliberately
      // sits beside jobValue: the two numbers only mean something next to each
      // other. DOLLARS, matching jobValue — expenses/{id} is the subsystem that
      // stores integer cents, lead docs do not.
      leadCost: parseFloat(document.getElementById('lLeadCost')?.value)||0,
      followUp: document.getElementById('lFollowUp')?.value||'',
      insCarrier: document.getElementById('lInsCarrier')?.value?.trim()||'',
      // Insurance fields
      claimNumber: document.getElementById('lClaimNumber')?.value?.trim()||'',
      claimFiledBy: document.getElementById('lClaimFiledBy')?.value||'',
      policyNumber: document.getElementById('lPolicyNumber')?.value?.trim()||'',
      dateOfLoss: document.getElementById('lDateOfLoss')?.value||'',
      estimateAmount: parseFloat(document.getElementById('lEstimateAmount')?.value)||0,
      deductibleOrOwedByHO: parseFloat(document.getElementById('lDeductible')?.value)||0,
      supplementStatus: document.getElementById('lSupplementStatus')?.value||'',
      scopeOfWork: document.getElementById('lScopeOfWork')?.value?.trim()||'',
      // Finance fields
      financeCompany: document.getElementById('lFinanceCompany')?.value?.trim()||'',
      loanAmount: parseFloat(document.getElementById('lLoanAmount')?.value)||0,
      loanStatus: document.getElementById('lLoanStatus')?.value||'',
      preQualLink: document.getElementById('lPreQualLink')?.value?.trim()||'',
      // Job fields
      scheduledDate: document.getElementById('lScheduledDate')?.value||'',
      crew: document.getElementById('lCrew')?.value?.trim()||'',
      // 2026-09-15 (Paperwork Filing) — gate fields for REQUIRED_FIELDS_BY_TYPE
      // (crm-stages.js). '' when unchecked, never false/0 — missingRequiredFields
      // only treats undefined/null/'' as missing. editLead() (crm-portal-bridge.js)
      // populates these checkboxes from the lead's own filed state on open, so a
      // re-save of an already-filed field just refreshes its stamp, never blanks it.
      contractFiledAt: document.getElementById('lContractFiled')?.checked ? new Date().toISOString() : '',
      permitFiledAt: document.getElementById('lPermitFiled')?.checked ? new Date().toISOString() : '',
      aobFiledAt: document.getElementById('lAobFiled')?.checked ? new Date().toISOString() : '',
      warrantyCertFiledAt: document.getElementById('lWarrantyCertFiled')?.checked ? new Date().toISOString() : '',
      cocFiledAt: document.getElementById('lCocFiled')?.checked ? new Date().toISOString() : '',
      notes: document.getElementById('lNotes')?.value?.trim() || '',
      yearBuilt:     intelData.yearBuilt   || null,
      marketValue:   intelData.marketValue || null,
      lastSaleDate:  intelData.lastSaleDate || null,
      lastSaleAmt:   intelData.lastSaleAmount || null,
      propertyType:  intelData.propertyType || null,
      parcelId:      intelData.parcelId || null,
      isLLC:         intelData.isLLC || false,
      homestead:     intelData.homestead || false,
      // Audit batch 11: stamp the parcel polygon when the Regrid lookup
      // returned one. photo-smart-ingest.js:getPropertyPolygon reads
      // `lead.parcel.geometry.coordinates` to power the photo-system
      // Phase 2 slope inference; without this the slope suggestion
      // falls back to heading-only mode.
      parcel:        intelData.parcelGeometry ? {
        geometry: intelData.parcelGeometry,
        center:   intelData.parcelCenter || null,
        source:   'regrid',
        fetchedAt: new Date().toISOString()
      } : null,
      // D2D knock linkage (set by convertToLeadWithEdit flow)
      d2dKnockId:    window._pendingD2DConvertId || null
    };
    // Captured before the save so quick-create listeners (EntityResolver)
    // can tell "brand-new lead" from "edit" — _saveLead returns the same
    // id right back on an edit, so a truthy return value alone can't
    // distinguish the two.
    const _wasNewLead = !_leadPayload.id;
    const _savedId = await window._saveLead(_leadPayload);
    // _saveLead returns null when it deliberately did NOT write: the Lite
    // lead cap, the billing gate's upgrade modal, or the rep choosing
    // cancel / "open the existing lead" on the dedup prompt. Each of
    // those has already shown its own feedback. Until 2026-09-02 this
    // function fell through to "Lead saved!" + closeLeadModal regardless,
    // so the rep saw a success message for a lead that does not exist.
    // Return before touching _modalIntel / the pending D2D knock so a
    // retry after the prompt still carries the parcel data and converts
    // the knock.
    if (_wasNewLead && !_savedId) return;
    window._modalIntel = null;
    // If this save came from a D2D conversion (Edit First flow), mark the knock as converted.
    // The lead was already saved successfully above — only the knock-side
    // bookkeeping is at risk here. We toast the rep so they know to remove
    // the duplicate knock manually if the conversion mark didn't land.
    if (window._pendingD2DConvertId) {
      try {
        if (window.updateDoc && window.doc && window._db) {
          await window.updateDoc(window.doc(window._db, 'knocks', window._pendingD2DConvertId), {
            convertedToLead: true,
            updatedAt: window.serverTimestamp()
          });
        }
        if (window.D2D?.renderD2D) window.D2D.renderD2D();
      } catch (d2dErr) {
        console.warn('Could not mark D2D knock as converted:', d2dErr);
        if (typeof showToast === 'function') {
          showToast('Lead saved, but the D2D knock didn’t flip to "converted". Remove the duplicate knock manually.', 'warning');
        }
      }
      window._pendingD2DConvertId = null;
    }
    // Lets whatever opened this modal for quick-create (e.g. Job
    // Templates' EntityResolver picker) know a new lead now exists,
    // without this file needing to know who's listening. Skipped on
    // edits and on the dedup-abort path (_savedId is null there).
    if (_wasNewLead && _savedId) {
      document.dispatchEvent(new CustomEvent('nbd:lead-created', {
        detail: { lead: Object.assign({}, _leadPayload, { id: _savedId }) }
      }));
    }
    mOk.textContent='Lead saved!';mOk.style.display='block';
    setTimeout(closeLeadModal,800);
  } catch(e) {
    console.error('saveLead error:', e);
    mErr.textContent='Save failed — check your connection and try again.';mErr.style.display='block';
  } finally {
    saveBtn.disabled=false;
    saveBtn.textContent=origText;
  }
}
