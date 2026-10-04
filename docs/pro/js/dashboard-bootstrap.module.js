/*! © 2026 No Big Deal Home Solutions — All Rights Reserved. Proprietary; no license granted — see LICENSE at the repo root. https://nobigdealwithjoedeal.com */
// Firebase bootstrap module + dashboard top-level wiring (extracted
// from an inline <script type="module"> in dashboard.html for CSP
// compliance — production `script-src-elem 'self'` blocks inline
// scripts, which had been hanging the dashboard at the load screen).
//
// Module scripts are implicitly deferred and execute in document
// order, so this still runs after dashboard-appcheck-config.js sets
// window.__NBD_APP_CHECK_KEY and after dashboard-auth-gate.module.js.
  import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
  import { initializeAppCheck, ReCaptchaEnterpriseProvider, CustomProvider } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";
  import { getAuth, onAuthStateChanged, signOut, updateProfile, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
  import { getFirestore, collection, addDoc, getDocs, getDoc, updateDoc, deleteDoc, doc, orderBy, query, serverTimestamp, where, arrayUnion, increment, limit, startAfter, setDoc, writeBatch, runTransaction, onSnapshot, disableNetwork, enableNetwork } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
  import { getStorage, ref, uploadBytes, getDownloadURL, listAll } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
  import { connectEmulatorsIfLocal, isLocalEmulatorEnv, emulatorAppCheckFakeToken } from "./nbd-emulator-connect.js"; // Audit #3: localhost-only, no-op in prod

  // ═══ GLOBAL CRM STATE (MUST BE TOP-LEVEL) ═══
  // Per S27 architectural rule: All CRM global state declared before any function definitions
  // NOTE: Module scope is isolated - must expose to window for global access
  import {
    S, STAGE_META, LEGACY_MAP, KANBAN_VIEWS,
    VIEW_SIMPLE, VIEW_INSURANCE, VIEW_CASH, VIEW_FINANCE, VIEW_WARRANTY, VIEW_SERVICE, VIEW_JOBS, VIEW_JOBS_BOARD,
    normalizeStage, stageLabel, stageColor, resolveColumn, partitionLeadsByColumn,
    stageRole, isWonStage, isLostStage, isJobStage, isTerminalStage, ROLE, resolvePipelineConfig,
    stageOptionsForType, inferJobType, suggestJobType, JOB_TYPES, JOB_TYPE_META, jobTypeLabel,
    SUB_TYPES, subTypeOptionsFor, subTypeLabel,
    TRADES, tradeLabel, tradesLabel,
    STAGE_ACTIONS, actionsForStage, preferredActionFor,
    REQUIRED_FIELDS_BY_TYPE, requiredFieldsFor, missingRequiredFields, requiredFieldLabel,
    CLAIM_STATUSES, CLAIM_STATUS_ACTIONS, preferredActionForClaim,
    REQUIRED_FIELDS_BY_CLAIM_STATUS, missingClaimFields,
    tagClass as _tagClass
  } from './crm-stages.js';
  // Expose the new helpers to non-module scripts (crm.js)
  window.actionsForStage = actionsForStage;
  window.preferredActionFor = preferredActionFor;
  window.requiredFieldsFor = requiredFieldsFor;
  window.missingRequiredFields = missingRequiredFields;
  // Human labels for missingRequiredFields keys — the Edit Lead form's stage
  // gate (crm-leads.js saveLead) names the fields it needs.
  window.requiredFieldLabel = requiredFieldLabel;
  // subTypeOptionsFor/subTypeLabel: registered in __NBD_CALL_REGISTRY at the
  // end of this file (Globals Tranche 3 T3-C, 2026-09-18) instead — this
  // comment block's "crm.js" framing was stale for these two specifically
  // (crm.js never actually read them; warranty-claim.js is the real, sole
  // external consumer).
  window.tradeLabel = tradeLabel;
  window.tradesLabel = tradesLabel;
  window.jobTypeLabel = jobTypeLabel;
  window.TRADES = TRADES;
  window.SUB_TYPES = SUB_TYPES;
  window.JOB_TYPE_META = JOB_TYPE_META;
  // 2026-09-15 (Warranty Claim lane): the claim-DOCUMENT's own status
  // sub-workflow — separate from the lead's stage. Exposed so warranty-claim.js
  // (a plain deferred script, same window-global convention as paperwork-write.js)
  // can read them without its own copy.
  window.CLAIM_STATUSES = CLAIM_STATUSES;
  window.CLAIM_STATUS_ACTIONS = CLAIM_STATUS_ACTIONS;
  window.preferredActionForClaim = preferredActionForClaim;
  window.REQUIRED_FIELDS_BY_CLAIM_STATUS = REQUIRED_FIELDS_BY_CLAIM_STATUS;
  // missingClaimFields: registered in __NBD_CALL_REGISTRY at the end of
  // this file (Globals Tranche 3 T3-C, 2026-09-18) instead.

  // ─── Estimate money: one reader, one stamping rule ──────────────────
  //
  // Three separate places in this file stamped lead.jobValue from an estimate,
  // and all three read `Number(est.grandTotal) || 0` — grandTotal ONLY. Classic
  // estimates carry their value on `total` or `amount` (it is what the customer
  // page's own Log Estimate flow writes), so every one of them scored 0.
  //
  // The guard was applied inconsistently on top of that: the first-estimate
  // branch of _assignEstimateToLead had `if (newVal > 0)` with the comment
  // "never zero a KPI off an estimate with no total" — while its own re-assign
  // branch, and BOTH branches of the duplicate-estimate flow, wrote the 0
  // straight through. So the same rule the author wrote down was enforced in
  // one of four places.
  //
  // That matters because lead.jobValue is the number the kanban column totals,
  // the KPI tiles, the leaderboard and the customer header all read. Zeroing it
  // silently deletes a deal's value from every money surface at once, and the
  // confirm the rep clicked through said "Use this estimate's $0 instead?" —
  // which reads like a bug in the estimate, not a warning about the lead.
  //
  // _estValue: the canonical two-shape reader (customer-estimate-rows.js, loaded
  // on this page since #1110), with a fallback mirroring its numFrom so a
  // missing script degrades to the same answers rather than to zero.
  const _estValue = (est) => {
    const api = window.NBDCustomerEstimateRows;
    if (api && typeof api.estimateValue === 'function') return api.estimateValue(est);
    if (!est) return 0;
    const v = est.grandTotal != null ? est.grandTotal
      : est.total != null ? est.total
      : est.amount != null ? est.amount : 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    const m = String(v == null ? '' : v).match(/-?\d[\d,]*\.?\d*/);
    const n = m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
    return isFinite(n) ? n : 0;
  };
  // _canStampJobValue: the rule, in one place. A 0 is never worth writing —
  // not over an existing value, and not as a lead's first one. A genuine $0
  // draft is indistinguishable here from an estimate we simply failed to read,
  // and the cost of the two mistakes is not symmetric: skipping the stamp loses
  // nothing (the rep can set it), writing the 0 destroys a real number.
  const _canStampJobValue = (v) => Number.isFinite(v) && v > 0;
  // Phase marker for the pre-module error trap (v159.5+) so the diag
  // banner can pinpoint where init died if a downstream import throws.
  window.__nbdMark && window.__nbdMark('m2:stagesImport');

  // Legacy compat — default to insurance pipeline view
  const _currentViewKey = localStorage.getItem('nbd_kanban_view') || 'insurance';
  const _currentViewStages = KANBAN_VIEWS[_currentViewKey]?.stages || VIEW_INSURANCE;

  // Legacy STAGES array — now derived from current view's stage labels
  const STAGES = _currentViewStages.map(k => STAGE_META[k]?.label || k);
  let _dragId = null;
  let _filteredLeads = null;

  // Expose stage system to window for non-module scripts (crm.js, etc.)
  window.STAGES = STAGES;
  window._stageKeys = _currentViewStages;        // Internal stage keys for current view
  window._currentViewKey = _currentViewKey;
  window.S = S;
  window.STAGE_META = STAGE_META;
  window.KANBAN_VIEWS = KANBAN_VIEWS;
  window.normalizeStage = normalizeStage;
  window.stageLabel = stageLabel;
  window.stageColor = stageColor;
  window.resolveColumn = resolveColumn;
  // Board bucketer (partitionLeadsByColumn): registered in __NBD_CALL_REGISTRY
  // at the end of this file (Globals Tranche 3 T3-C, 2026-09-18) instead of a
  // bare window global — crm-pipeline.js's renderLeads is its sole consumer.
  // Semantic-role helpers (freeform-pipeline foundation) — consumers classify a
  // lead by role (won/lost/active/job/new) instead of hardcoded stage-key lists.
  window.stageRole = stageRole;
  window.isWonStage = isWonStage;
  window.isLostStage = isLostStage;
  // 2026-09-15 (Kanban filter unification) — canonical job-stage /
  // terminal-stage membership tests, replacing ~9 hand-copied stage-key
  // lists that had already drifted out of sync with each other within
  // hours of the Collections stage being added.
  window.isJobStage = isJobStage;
  window.isTerminalStage = isTerminalStage;
  window.VIEW_JOBS_BOARD = VIEW_JOBS_BOARD;
  // STAGE_ROLE/resolvePipelineConfig/applyPipelineConfig: registered in
  // __NBD_CALL_REGISTRY at the end of this file (Globals Tranche 3 T3-C,
  // 2026-09-18) instead of bare window globals — the Phase-2 pipelines
  // builder (pipeline-builder.js) is their sole consumer.

  // ── Phase 1: apply a per-tenant pipeline config over the built-in defaults ──
  // Config lives at companyProfile.pipelines (owner/admin-writable). No config →
  // early-return, so current tenants (none configured yet) are byte-identical.
  // When a config exists it re-points the stage globals + re-renders. Exposed so
  // the Phase-2 builder can re-apply immediately after a save.
  function applyPipelineConfig() {
    const raw = window._companyProfile && window._companyProfile.pipelines;
    // A config counts only if it has at least one override; `{stages:{},views:{}}`
    // (what "Reset to defaults" writes) is NOT a config. Crucially, when there's
    // no config we RESOLVE WITH null (default clones) and apply them rather than
    // early-returning — otherwise a Reset couldn't REVERT previously-applied
    // overrides on window.STAGE_META / KANBAN_VIEWS without a page reload.
    const hasCfg = raw && typeof raw === 'object'
      && (((raw.stages && Object.keys(raw.stages).length) || (raw.views && Object.keys(raw.views).length)));
    let resolved;
    try { resolved = resolvePipelineConfig(hasCfg ? raw : null); } catch (e) { console.warn('[pipelines] resolve failed', e); return; }
    window.STAGE_META = resolved.stageMeta;
    window.KANBAN_VIEWS = resolved.views;
    window.stageRole = resolved.roleOf;
    window.isWonStage = (k) => resolved.roleOf(k) === ROLE.WON;
    window.isLostStage = (k) => resolved.roleOf(k) === ROLE.LOST;
    // isJobStage's CONTRACT_SIGNED carve-out is a built-in-key fact (a
    // custom tenant stage is never literally 'contract_signed'), so it
    // stays a plain comparison; the job/won-role half re-points at the
    // tenant's resolved role the same way isWonStage/isLostStage do above.
    window.isJobStage = (k) => k === S.CONTRACT_SIGNED || resolved.roleOf(k) === ROLE.JOB || resolved.roleOf(k) === ROLE.WON;
    window.isTerminalStage = (k) => resolved.roleOf(k) === ROLE.WON || resolved.roleOf(k) === ROLE.LOST;
    window.stageLabel = (k) => (resolved.stageMeta[k] || resolved.stageMeta[normalizeStage(k)] || {}).label || k;
    window.stageColor = (k) => (resolved.stageMeta[k] || resolved.stageMeta[normalizeStage(k)] || {}).color || '#374151';
    // stageOptionsForType is the STAGE PICKER's list — the kanban card ⋮
    // "Move to stage…" submenu and the card-detail stage chip both read it
    // (kanban-context-menu.js). The imported version closes over the
    // module-local defaults, so leaving it pointed there meant a tenant with a
    // custom pipeline got the BUILT-IN stages after their config resolved:
    // custom stages absent, renamed stages showing their old label, the ✓
    // current-stage marker never matching, and hidden stages still offered.
    window.stageOptionsForType = function (jobType) {
      const view = resolved.views[jobType] || resolved.views.insurance || { stages: [] };
      let keys = (view.stages || []).slice();
      // Warranty + Service terminate on their own; every other track converges
      // into the job board after contract_signed (mirrors the default helper).
      if (jobType !== 'warranty' && jobType !== 'service') {
        // The track boards carry Installing + Closed columns themselves
        // (2026-10-01). Take the board's own job columns out first, then lay
        // the full job sequence in after Contract Signed: otherwise Installing
        // and Closed sat AFTER the finer job steps and "next after Installing"
        // read Closed (caught by phone-pipeline.spec's swipe check).
        const jobs = ((resolved.views.jobs && resolved.views.jobs.stages) || []).filter(k => k !== 'contract_signed');
        keys = keys.filter(k => !jobs.includes(k));
        const at = keys.indexOf('contract_signed');
        if (at !== -1) keys.splice(at + 1, 0, ...jobs);
      }
      return keys
        .filter(k => !(resolved.stageMeta[k] && resolved.stageMeta[k].hidden))
        .map(k => ({ value: k, label: (resolved.stageMeta[k] || {}).label || k }));
    };
    const vk = window._currentViewKey || 'insurance';
    const vs = (resolved.views[vk] && resolved.views[vk].stages) || [];
    window._stageKeys = vs;
    window.STAGES = vs.map(k => (resolved.stageMeta[k] || {}).label || k);
    // Custom stages may reclassify a lead's role AND column — re-stamp the
    // loaded book. A lead hydrated BEFORE this config applied got _stageKey via
    // the module-local normalizeStage (which didn't know the tenant's custom
    // keys), so a custom-stage lead was stamped 'new' and mis-bucketed into the
    // New column. window.STAGE_META now carries the custom keys (set above), so
    // re-deriving _stageKey resolves custom_* to its own column. #921.
    (window._leads || []).forEach(l => {
      if (!l) return;
      l._stageKey = normalizeStage(l.stage);
      l._stageRole = resolved.roleOf(l._stageKey || l.stage);
    });
    // Rebuild the COLUMNS from the new config (buildKanbanColumns now reads the
    // window.* overrides), then re-render cards into them — otherwise renamed /
    // custom / reordered / hidden stages wouldn't appear until a full reload.
    if (typeof window.buildKanbanColumns === 'function') {
      try { window.buildKanbanColumns(window._currentViewKey || vk); } catch (_) {}
    }
    if (typeof window.renderLeads === 'function') { try { window.renderLeads(); } catch (_) {} }
  }
  // The company profile landed (company-profile.js dispatches this once, after
  // the first successful read): apply the tenant's pipeline config. The boot
  // read used to be the only thing that applied it, so a read that was
  // retried — or started late by company-profile.js itself — left the
  // built-in stages up all session (2026-09-25, lane profretry).
  window.addEventListener('nbd:company-profile-loaded', () => { applyPipelineConfig(); });
  window.stageOptionsForType = stageOptionsForType;
  window.inferJobType = inferJobType;
  window.suggestJobType = suggestJobType; // "Sort my customers" (sort-customers.js)
  window.JOB_TYPES = JOB_TYPES;
  window._dragId = _dragId;
  window._filteredLeads = _filteredLeads;

  // ── Dynamic kanban column builder ──
  window.buildKanbanColumns = function(viewKey) {
    // Read the LIVE (possibly tenant-overridden) views + stage meta that
    // applyPipelineConfig writes to window.*, not the module-local default
    // consts — otherwise a tenant's custom views / renamed / custom / reordered
    // stages never actually render on the board (the Phase-2 builder wrote the
    // config but the board ignored it). Fall back to the defaults pre-config.
    const VIEWS = window.KANBAN_VIEWS || KANBAN_VIEWS;
    const META = window.STAGE_META || STAGE_META;
    const view = VIEWS[viewKey || _currentViewKey];
    if (!view) return;
    // Skip stages flagged hidden in the tenant config (builder eye-toggle) —
    // but NEVER let the hide-filter blank the whole board (which would silently
    // hide every lead with no recovery). If hiding empties the view, fall back
    // to showing all its stages.
    const _all = view.stages || [];
    let stages = _all.filter(k => !(META[k] && META[k].hidden));
    if (!stages.length && _all.length) stages = _all.slice();
    const board = document.getElementById('kanbanBoard');
    if (!board) return;
    // Delegated column DnD — the old per-column inline ondragover/ondrop
    // attributes are dead under the prod CSP (script-src-attr 'none'), so
    // dropping a lead card on a column silently did nothing. The board node
    // persists across innerHTML rebuilds; bind exactly once.
    if (!board.dataset.nbdDndBound) {
      board.dataset.nbdDndBound = '1';
      board.addEventListener('dragover', (ev) => {
        if (ev.target.closest && ev.target.closest('.kcol-body')) ev.preventDefault();
      });
      board.addEventListener('drop', (ev) => {
        const body = ev.target.closest && ev.target.closest('.kcol-body');
        if (body) window.drop(ev, body.id.replace(/^kbody-/, ''));
      });
    }
    // Stage labels come from the team-shared tenant pipeline config, so a
    // company_admin could store markup. The prod CSP (script-src-attr 'none',
    // no unsafe-inline) blocks script execution, but escape here too — defence
    // in depth so an unescaped '<'/'&' can't corrupt the board and a future CSP
    // regression can't turn this innerHTML sink back into a live XSS.
    const _escLbl = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    board.innerHTML = stages.map(stageKey => {
      const meta = META[stageKey] || {};
      const label = _escLbl(meta.label || stageKey);
      // The key flows into id="" too. A well-formed custom key is a charset-safe
      // slug (builder's makeCustomKey), so this is identity for real keys — but a
      // company_admin writing companyProfile.pipelines directly could store a key
      // with '"'/'<'; escape so it can't break out of the attribute (defence in
      // depth alongside the label — #921).
      const keyAttr = _escLbl(stageKey);
      const hdrClass = meta.headerClass || 'kh-new';
      return `
      <div class="kanban-col" id="kcol-${keyAttr}">
        <div class="kcol-header ${hdrClass}">
          <div class="kcol-label">${label}</div>
          <div class="kcol-meta">
            <div class="kcol-count" id="kcount-${keyAttr}">0</div>
            <div class="kcol-total dn" id="ktotal-${keyAttr}"></div>
          </div>
        </div>
        <div class="kcol-body" id="kbody-${keyAttr}">
          <div class="k-empty">No leads</div>
        </div>
      </div>`;
    }).join('');

    // Update STAGES + _stageKeys for crm.js compat
    window.STAGES = stages.map(k => META[k]?.label || k);
    window._stageKeys = stages;
    window._currentViewKey = viewKey || _currentViewKey;
    localStorage.setItem('nbd_kanban_view', window._currentViewKey);
  };

  // ── Job type field toggle ──
  function toggleInsuranceFields() {
    const jt = document.getElementById('lJobType')?.value || '';
    const ins = document.getElementById('insuranceFieldsBlock');
    const fin = document.getElementById('financeFieldsBlock');
    const job = document.getElementById('jobFieldsBlock');
    if (ins) ins.style.display = (jt === 'insurance' || jt === '') ? (document.getElementById('lInsCarrier')?.value ? 'block' : (jt === 'insurance' ? 'block' : 'none')) : 'none';
    if (ins && jt === 'insurance') ins.style.display = 'block';
    if (fin) fin.style.display = jt === 'finance' ? 'block' : 'none';
    // Job Details (Scheduled Date, crew, arrival window, week, paperwork) is
    // ALWAYS shown (2026-09-30). It used to appear only once the stage reached
    // contract_signed or later, and it was inserted mid-form the moment the
    // Stage select changed. Everything below it jumped, so the next click
    // landed on the wrong field (Jo's live CRM session). It also hid
    // Scheduled Date for an inspection or repair booked before a contract,
    // while the customer page's Edit Customer always showed it. Saving never
    // depended on visibility: saveLead reads these fields regardless.
    if (job) job.style.display = 'block';
    // Smart stage dropdown — hide irrelevant track optgroups based on jobType
    filterStageDropdownByJobType(jt);
    // Sub-type + trades row: visible only when a job type is set
    refreshSubTypeAndTrades(jt);
    // Next Actions panel: refreshes whenever job type or stage changes
    window.renderNextActionsPanel && window.renderNextActionsPanel();
  }

  // ── Sub-type + trades row population ──
  // Sub-type options come from SUB_TYPES[jobType]. Trades is a fixed list
  // of multi-select chips; the selection lives on the chip's data-selected
  // attribute and is read on save. Both hide together until job type is set.
  function refreshSubTypeAndTrades(jobType) {
    const row = document.getElementById('lSubTypeRow');
    if (!row) return;
    if (!jobType) { row.style.display = 'none'; return; }
    row.style.display = '';

    // Sub-type select — preserve current value if still valid for the new type
    const subSel = document.getElementById('lSubType');
    if (subSel) {
      const prev = subSel.value;
      // subTypeOptionsFor is an imported binding (crm-stages.js), always
      // available once this module has parsed — no guard needed.
      const options = subTypeOptionsFor(jobType);
      subSel.innerHTML = '<option value="">— optional —</option>' +
        options.map(o => `<option value="${o.value}">${o.label}</option>`).join('');
      const stillValid = options.some(o => o.value === prev);
      if (stillValid) subSel.value = prev;
    }

    // Trades chips — render once, preserve selection across job type changes
    const tradeGroup = document.getElementById('lTradesGroup');
    if (tradeGroup && tradeGroup.children.length === 0 && Array.isArray(window.TRADES)) {
      tradeGroup.innerHTML = window.TRADES.map(t => `
        <button type="button" class="trade-chip dbx-fs11px-p4px10px-r14px" data-value="${t.value}" data-selected="0"
         
          data-action="tradeChip">${t.icon || ''} ${t.label}</button>
      `).join('');
    }
  }

  // ── Stage select population ──
  // #lStage ships as a STATIC <option> list in dashboard.html, so a tenant
  // running a custom pipeline had no <option> for its own stages: the select
  // read back as '' and saveLead persisted that empty string, DESTROYING the
  // lead's stage on every edit. Repopulate from the live (tenant-resolved)
  // window.STAGE_META on every modal open — same repopulate-on-open contract
  // as refreshSubTypeAndTrades above.
  //
  // Grouping is by stage `track` so filterStageDropdownByJobType — which hides
  // optgroups by matching keywords in their label — keeps working unchanged.
  // Every non-hidden stage stays in the list regardless of job type: the
  // filter only display:none's the off-track groups, and dropping their
  // options would reintroduce the exact blanking this fixes.
  const _STAGE_GROUPS = [
    ['lead',      'Lead Pipeline'],
    ['insurance', 'Insurance Track'],
    ['cash',      'Cash Track'],
    ['finance',   'Finance Track'],
    ['warranty',  'Warranty Track'],
    ['service',   'Service Track'],
    ['contract',  'Contract'],
    ['job',       'Job Pipeline'],
    ['custom',    'Custom Stages'],
    ['exit',      'Exit']
  ];
  function _stageGroupFor(key, meta) {
    if (key === 'lost') return 'exit';
    if (key === 'contract_signed') return 'contract';
    const track = meta.track || '';
    if (track === 'insurance' || track === 'cash' || track === 'finance' ||
        track === 'warranty'  || track === 'service') return track;
    if (track === 'shared') return meta.type === 'job' ? 'job' : 'lead';
    return 'custom'; // resolvePipelineConfig stamps track:'custom' on tenant-invented stages
  }
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer a bare window global —
  // crm-leads.js's openLeadModal is its sole consumer.
  function refreshStageOptions(keepValue) {
    const sel = document.getElementById('lStage');
    if (!sel) return;
    const META = window.STAGE_META || STAGE_META;
    // editLead assigns #lStage BEFORE it calls openLeadModal, so a stage with
    // no matching option has ALREADY collapsed to '' by the time we run —
    // hence the explicit keepValue, with the live selection as the fallback.
    const want = keepValue || sel.value || '';
    const groups = {};
    Object.keys(META).forEach(key => {
      const meta = META[key] || {};
      // Hidden stages are off the board so they aren't pickable — except the
      // one this lead is actually sitting on, which must stay selectable or
      // saving would blank it.
      if (meta.hidden && key !== want) return;
      const g = _stageGroupFor(key, meta);
      (groups[g] || (groups[g] = [])).push(key);
    });
    // Labels and custom keys come from the tenant pipeline config (company_
    // admin writable) and flow into innerHTML — escape both, same defence-in-
    // depth reasoning as buildKanbanColumns.
    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    sel.innerHTML = _STAGE_GROUPS.map(([g, label]) => {
      const keys = groups[g];
      if (!keys || !keys.length) return '';
      return `<optgroup label="${label}">` + keys.map(k =>
        `<option value="${esc(k)}">${esc((META[k] || {}).label || k)}</option>`
      ).join('') + '</optgroup>';
    }).join('');
    if (want) sel.value = want;
    // Stage the config no longer knows about at all (a custom stage the owner
    // later deleted, still stored on an old lead). Keep it as its own option
    // so the value round-trips untouched instead of saving as ''.
    if (want && sel.value !== want) {
      const opt = document.createElement('option');
      opt.value = want;
      opt.textContent = (META[want] && META[want].label) || want;
      sel.appendChild(opt);
      sel.value = want;
    }
  }

  // Toggle a trade chip selection on/off (visual + data-selected flag)
  window.toggleTradeChip = function(btn) {
    const on = btn.dataset.selected === '1';
    btn.dataset.selected = on ? '0' : '1';
    if (on) {
      btn.style.background = 'var(--s2)';
      btn.style.color = 'var(--m)';
      btn.style.borderColor = 'var(--br)';
    } else {
      btn.style.background = 'var(--orange)';
      btn.style.color = 'var(--accent-fg)';
      btn.style.borderColor = 'var(--orange)';
    }
  };

  // Read currently-selected trades as an array of values
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer a bare window global.
  //
  // Returns null — UNKNOWN, not "none" — when no .trade-chip exists: the
  // chips render only once refreshSubTypeAndTrades sees a non-empty job type
  // (and window.TRADES), so editing a lead whose job type is "Not Set" never
  // draws them and setSelectedTrades has nothing to reflect the stored trades
  // onto. Returning [] there made saveLead wipe that lead's trades. The only
  // caller (crm-leads.js saveLead) omits the key on null. Once the chips
  // exist, a user who clears every one still gets [] and saves it.
  function getSelectedTrades() {
    const group = document.getElementById('lTradesGroup');
    if (!group || !group.querySelector('.trade-chip')) return null;
    return Array.from(group.querySelectorAll('.trade-chip[data-selected="1"]'))
      .map(b => b.dataset.value);
  }

  // Reflect a saved trades array onto the chip UI
  function setSelectedTrades(trades) {
    const group = document.getElementById('lTradesGroup');
    if (!group) return;
    const set = new Set(Array.isArray(trades) ? trades : []);
    group.querySelectorAll('.trade-chip').forEach(b => {
      const on = set.has(b.dataset.value);
      b.dataset.selected = on ? '1' : '0';
      b.style.background = on ? 'var(--orange)' : 'var(--s2)';
      b.style.color = on ? 'var(--accent-fg)' : 'var(--m)';
      b.style.borderColor = on ? 'var(--orange)' : 'var(--br)';
    });
  }

  // ── Next Actions panel ──
  // Driven by STAGE_ACTIONS in crm-stages.js. Renders the context-aware
  // list of actions for the current stage + job type. Buttons emit a
  // CustomEvent('nbd:lead-action', {detail:{actionId, ...}}) — wire-up
  // happens incrementally as each action lands.
  window.renderNextActionsPanel = function() {
    const panel = document.getElementById('nextActionsPanel');
    if (!panel) return;
    const stage = document.getElementById('lStage')?.value || '';
    const jt    = document.getElementById('lJobType')?.value || '';
    const editId = document.getElementById('lEditId')?.value || '';
    if (!editId) { panel.style.display = 'none'; return; } // hide on new lead
    const actions = (window.actionsForStage ? window.actionsForStage(stage, jt) : []);
    if (!actions.length) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';
    const stageName = (window.STAGE_META && window.STAGE_META[stage])?.label || stage || 'this stage';
    panel.querySelector('.nap-title').textContent = `Next actions — ${stageName}`;
    const body = panel.querySelector('.nap-body');
    body.innerHTML = actions.map(a => `
      <button type="button" class="nap-btn" data-action-id="${a.id}" data-kind="${a.kind}"
        data-action="call" data-fn="runLeadAction" data-arg="${a.id}" data-arg2="${a.kind}"
        title="${a.kind === 'doc' ? 'Generate document' : a.kind === 'stage' ? 'Advance stage' : 'Action'}">
        <span class="nap-ico">${a.icon || ''}</span>
        <span class="nap-lbl">${a.label}</span>
        <span class="nap-kind nap-kind-${a.kind}">${a.kind}</span>
      </button>
    `).join('');
  };

  // ── Next Actions dispatch ──
  // Routes a chip click to the right handler. Three families:
  //   - kind: 'stage'  → advance the lead to a target stage via moveCard
  //   - kind: 'doc'    → route to the doc generator (estimate, photo report,
  //                      etc.) when we have an implementation; otherwise
  //                      log a timeline note + honest toast.
  //   - kind: 'action' → log a timeline note + honest toast (most are
  //                      "log that you did this" workflow markers).
  // Every action also emits the nbd:lead-action CustomEvent so callers
  // (Ask Joe proactive, telemetry) can observe.
  //
  // ACTION_MAP keys are action IDs from STAGE_ACTIONS (crm-stages.js).
  // The default branch is reached for anything not yet enumerated;
  // those still get the timeline-log fallback so the chip is useful
  // even without a custom handler.
  const STAGE_TARGETS = {
    mark_adj_done:  'adjuster_inspection_done',
    create_job:     'job_created',
    start_install:  'install_in_progress',
    close_job:      'closed',
    // 2026-09-15 (Warranty Claim lane): both route through moveCard() same as
    // every other kind:'stage' action above — the actual UI (gathering a
    // reason/description, or requiring resolution notes) is a GUARD inside
    // moveCard() itself (crm-pipeline.js), not here. See warranty-claim.js.
    file_warranty_claim:    'warranty_claim',
    resolve_warranty_claim: 'closed',
  };

  // Map our Next-Action chip IDs → NBDDocGen document types. The doc
  // templates already exist in document-generator.js + -templates.js;
  // we're just wiring the chips to them. inspect_report is special-cased
  // below to pick the homeowner vs insurance variant by job type.
  const ACTION_DOC_MAP = {
    send_contract:   'contract',
    work_order:      'work_authorization',
    change_order:    'change_order',
    closeout:        'certificate_of_completion',
    final_invoice:   'invoice',
    warranty_cert:   'warranty_certificate',
    warranty_report: 'before_after_report',
    // 2026-09-15 (Paperwork Filing): pull_permit was kind:'action' with no
    // handler (a named-dead "workflow marker") until crm-stages.js flipped
    // it to kind:'doc' the same session — this is what makes the chip
    // actually generate a document instead of logging a note.
    pull_permit:     'permit',
    // The finance track's "Send Pre-Qual Link" chip ships as kind:'doc' but was
    // unmapped, so it fell through to the log-only tail even though the
    // financing_options template is fully defined (doc-preflight.js:762).
    send_prequal:    'financing_options'
  };

  // Convert a lead record to the merge-data shape the NBDDocGen templates
  // expect. Different templates pull different fields out of the bag —
  // this helper populates the superset so any template gets what it needs.
  // Missing values become empty strings; the templates already substitute
  // their own placeholders ("[Homeowner Name]") for falsy values.
  function _leadToDocData(lead) {
    if (!lead) return {};
    const fname = (lead.firstName || lead.fname || '').trim();
    const lname = (lead.lastName  || lead.lname || '').trim();
    const homeownerName = (fname + ' ' + lname).trim() || lead.address || '';
    const job = Number(lead.jobValue) || Number(lead.estimateAmount) || 0;
    const ded = Number(lead.deductibleOrOwedByHO) || 0;
    return {
      // Universal fields used by most templates + the simple {{token}} renderer
      homeownerName,
      address:           lead.address || '',
      homeownerPhone:    lead.phone || '',
      homeownerEmail:    lead.email || '',
      phone:             lead.phone || '',
      email:             lead.email || '',
      // Insurance fields (renderSupplementRequest, renderClaimGuide, etc.)
      insuranceCompany:  lead.insCarrier || lead.insuranceCarrier || '',
      claimNumber:       lead.claimNumber || '',
      policyNumber:      lead.policyNumber || '',
      dateOfLoss:        lead.dateOfLoss || '',
      scopeSummary:      lead.scopeOfWork || (lead.damageType ? lead.damageType + ' repair' : ''),
      // Financial fields (invoice, change order, contract)
      originalTotal:     job || undefined,
      totalPrice:        job ? '$' + job.toLocaleString() : '$0.00',
      deductible:        ded || undefined,
      // Project description for {{token}} templates
      projectDescription: lead.scopeOfWork || lead.damageType || '',
      // Job-type / sub-type / trades (Pre-W159 data compat sweep) —
      // Future doc variants will switch on sub-type (storm AOB vs
      // fire AOB) and trades (roof+gutters combo line items). Surface
      // them defensively here so templates can read data.subType
      // and data.trades without guards.
      jobType:           lead.jobType || '',
      subType:           lead.subType || '',
      trades:            Array.isArray(lead.trades) ? lead.trades : [],
      tradesLabel:       Array.isArray(lead.trades) && lead.trades.length
                           ? (typeof window.tradesLabel === 'function' ? window.tradesLabel(lead.trades) : lead.trades.join(', '))
                           : '',
      // Identifiers
      leadId:            lead.id,
      customer:          { id: lead.id, name: homeownerName, address: lead.address, phone: lead.phone, email: lead.email },
      // Pass through the whole lead so any template can dig in if needed
      lead:              lead
    };
  }

  function _findLead(id) {
    if (!id || !Array.isArray(window._leads)) return null;
    return window._leads.find(l => l && l.id === id) || null;
  }

  // "Open this lead" deep link → the lead id, else null. Two shapes exist:
  // ?tab=crm&lead=ID (notification bell, tasks.js) and ?tab=leads&leadId=ID
  // (push notifications, firebase-messaging-sw.js). A bare ?lead=ID (no tab)
  // stays the NEW-ESTIMATE deep link, and an ?est= link is never a lead open.
  function leadDeepLinkId(params) {
    if (!params || params.get('est')) return null;
    const tab = params.get('tab');
    if (tab !== 'crm' && tab !== 'leads') return null;
    return params.get('lead') || params.get('leadId') || null;
  }

  function _logLeadActivity(leadId, actionId, label) {
    // Append a lightweight activity entry. We use updateDoc with
    // arrayUnion so concurrent activity entries from other tabs don't
    // clobber each other. If Firestore isn't loaded yet this no-ops
    // gracefully — the toast still fires.
    if (!leadId || !window.db || !window.doc || !window.updateDoc || !window.arrayUnion) return Promise.resolve(false);
    const entry = {
      type: 'next_action',
      actionId: actionId,
      label: label || actionId,
      ts: new Date().toISOString(),
      user: (window._user && window._user.email) || 'unknown'
    };
    return window.updateDoc(window.doc(window.db, 'leads', leadId), {
      activityLog: window.arrayUnion(entry),
      updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
    }).then(() => true).catch(err => {
      console.warn('logLeadActivity failed:', err && err.message);
      return false;
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Next-Action handlers — the chips that have a real destination.
  //
  // Availability is NOT symmetric on dashboard.html: ReviewEngine,
  // InvoicePipeline and smart-calendar are eager <script defer> tags, while
  // PhotoEngine lives in the lazy 'photos' bundle. dashboard-actions.js
  // installs a load-then-run stub on window.PhotoEngine, so we call THAT
  // rather than reaching for ScriptLoader here — but every handler still
  // feature-checks its own target and returns false if it isn't there, which
  // drops the chip back to the honest timeline-log tail instead of no-opping.
  // ─────────────────────────────────────────────────────────────────
  function _actionRequestReview(leadId) {
    if (!(window.ReviewEngine && typeof window.ReviewEngine.sendReviewSMS === 'function')) return false;
    window.ReviewEngine.sendReviewSMS(leadId);
    return true;
  }

  // Deposits and final payments both open the invoice builder on this lead.
  // The lead modal closes first — the invoice modal is a sibling overlay and
  // stacking the two leaves the rep looking at the wrong one.
  function _actionOpenInvoice(leadId) {
    if (!(window.InvoicePipeline && typeof window.InvoicePipeline.createInvoiceUI === 'function')) return false;
    if (typeof window.closeLeadModal === 'function') window.closeLeadModal();
    window.InvoicePipeline.createInvoiceUI(leadId);
    return true;
  }

  function _actionOpenCamera(leadId) {
    if (!(window.PhotoEngine && typeof window.PhotoEngine.openCamera === 'function')) return false;
    if (typeof window.closeLeadModal === 'function') window.closeLeadModal();
    window.PhotoEngine.openCamera(leadId);
    return true;
  }

  // Scheduling chips land the rep on the Today's Schedule timeline.
  // goTo('schedule') is the call smart-calendar.js wraps to repaint itself;
  // loadSmartCalendar is the direct fallback for pages without the nav helper
  // (registry-only — smart-calendar.js registers it, Globals Tranche 3 T3-C).
  function _actionOpenSchedule() {
    const hasNav  = typeof window.goTo === 'function';
    const _nbdReg = window.__NBD_CALL_REGISTRY;
    const hasCal  = !!(_nbdReg && typeof _nbdReg.loadSmartCalendar === 'function');
    if (!hasNav && !hasCal) return false;
    if (typeof window.closeLeadModal === 'function') window.closeLeadModal();
    if (hasNav) window.goTo('schedule');
    else _nbdReg.loadSmartCalendar();
    return true;
  }

  // request_supp is kind:'action' because it doesn't generate anything — it
  // moves the claim's supplement to "requested" (the value the lead form and
  // the supplement approval flow both read). Leads have NO snapshot listener,
  // so refresh the in-memory lead and the open form field by hand; otherwise
  // the rep keeps seeing the stale value until a full reload.
  function _actionRequestSupplement(leadId) {
    if (!(leadId && window.db && window.doc && window.updateDoc)) return false;
    window.updateDoc(window.doc(window.db, 'leads', leadId), {
      supplementStatus: 'requested',
      updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
    }).then(() => {
      const lead = _findLead(leadId);
      if (lead) lead.supplementStatus = 'requested';
      const sel = document.getElementById('lSupplementStatus');
      if (sel && (document.getElementById('lEditId')?.value || '') === leadId) sel.value = 'requested';
      if (typeof showToast === 'function') showToast('✓ Supplement marked as requested', 'success');
    }).catch(err => {
      console.warn('request_supp write failed:', err && err.message);
      if (typeof showToast === 'function') showToast('Could not mark the supplement as requested — try again', 'warning');
    });
    return true;
  }

  // mark_permit_filed is kind:'action' because it doesn't generate anything —
  // it stamps permitFiledAt so REQUIRED_FIELDS_BY_TYPE's MATERIALS_ORDERED
  // gate (crm-stages.js) is satisfiable. Same shape as _actionRequestSupplement
  // above: no snapshot listener on leads, so refresh the in-memory lead and
  // the open form field by hand. Routes through the shared
  // commitPaperworkFiled() (paperwork-write.js) rather than a bare updateDoc
  // so the customer-checklist.js Permit row's toggle uses the identical path.
  function _actionMarkPermitFiled(leadId) {
    if (!(leadId && window.PaperworkWrite && typeof window.PaperworkWrite.commitPaperworkFiled === 'function')) return false;
    window.PaperworkWrite.commitPaperworkFiled(leadId, 'permitFiledAt', true, { actorLabel: window._currentUser?.email }).then(() => {
      const lead = _findLead(leadId);
      const stamp = new Date().toISOString();
      if (lead) lead.permitFiledAt = stamp;
      const chk = document.getElementById('lPermitFiled');
      if (chk && (document.getElementById('lEditId')?.value || '') === leadId) chk.checked = true;
      if (typeof showToast === 'function') showToast('✓ Permit marked as filed', 'success');
    }).catch(err => {
      console.warn('mark_permit_filed write failed:', err && err.message);
      if (typeof showToast === 'function') showToast('Could not mark the permit as filed — try again', 'warning');
    });
    return true;
  }

  // Chip ID → handler. Only IDs whose target subsystem genuinely exists are
  // listed. The ones deliberately absent (log_contact, follow_up,
  // log_adjuster, follow_supp, follow_lender, confirm_delivery, log_diagnosis,
  // upload_scope) are workflow markers with nothing to open — their "Logged"
  // toast is the honest outcome, so they keep falling through.
  const ACTION_HANDLER_MAP = {
    request_review:  _actionRequestReview,
    collect_deposit: _actionOpenInvoice,
    request_payment: _actionOpenInvoice,
    photo_intake:    _actionOpenCamera,
    progress_photos: _actionOpenCamera,
    final_photos:    _actionOpenCamera,
    sched_inspect:   _actionOpenSchedule,
    sched_crew:      _actionOpenSchedule,
    request_supp:    _actionRequestSupplement,
    mark_permit_filed: _actionMarkPermitFiled
  };

  // ─────────────────────────────────────────────────────────────────
  // Doc-data bridge — lets DocPreflight (js/doc-preflight.js) run from
  // the dashboard the same way it runs on customer.html. The customer
  // page defines its own getCustomerDocData / checkPrerequisites /
  // DOC_PREREQUISITES; we mirror the shape here for the dashboard
  // context, sourcing from window._leads / _estimates / _photoCache.
  //
  // We don't clobber the customer-page versions — these only assign
  // to window.* when the customer-page copies haven't been set yet.
  // ─────────────────────────────────────────────────────────────────
  const _DASH_DOC_PREREQUISITES = {
    proposal:                   { needs: ['estimate'],                  label: 'Proposal / Estimate', msg: 'Build an estimate first.' },
    contract:                   { needs: ['estimate', 'contact'],       label: 'Roofing Contract',    msg: 'Build an estimate and add customer contact info.' },
    work_authorization:         { needs: ['address', 'scope'],          label: 'Work Authorization',  msg: 'Add property address and scope of work.' },
    scope_of_work:              { needs: ['estimate'],                  label: 'Scope of Work',       msg: 'Build an estimate to generate scope details.' },
    inspectionHomeowner:        { needs: ['photos'],                    label: 'Inspection Report',   msg: 'Upload inspection photos first.' },
    inspectionInsurance:        { needs: ['photos', 'claim'],           label: 'Insurance Report',    msg: 'Upload photos and add insurance carrier + claim #.' },
    supplement_request:         { needs: ['estimate', 'claim'],         label: 'Supplement Request',  msg: 'Requires an estimate and filed insurance claim.' },
    warranty_certificate:       { needs: ['jobComplete'],               label: 'Warranty Certificate',msg: 'Job must be marked Complete to generate warranty.' },
    certificate_of_completion:  { needs: ['jobComplete', 'beforeAfterPhotos'], label: 'Certificate of Completion', msg: 'Job must be complete with before & after photos.' },
    invoice:                    { needs: ['jobValue'],                  label: 'Invoice',             msg: 'Add a job value or build an estimate first.' },
    change_order:               { needs: ['estimate'],                  label: 'Change Order',        msg: 'Requires an existing estimate to modify.' },
    before_after_report:        { needs: ['beforeAfterPhotos'],         label: 'Before & After Report', msg: 'Need BOTH before and after photos uploaded.' },
    financing_options:          { needs: ['jobValue'],                  label: 'Financing Options',   msg: 'Add a job value or build an estimate.' },
    payment_agreement:          { needs: ['jobValue', 'contact'],       label: 'Payment Agreement',   msg: 'Add job value and customer contact info.' },
    storm_history_report:       { needs: ['address'],                  label: 'Storm History Report', msg: 'Add a property address first — it\'s used to pull the NOAA storm history.' }
  };

  function _dashGetCustomerDocData(leadId) {
    const lead = (window._leads || []).find(l => l && l.id === leadId) || {};
    const id = leadId;
    const estimates = (window._estimates || []).filter(e => e && (e.leadId === leadId || e.customerId === leadId));
    const photoBag = (window._photoCache && window._photoCache[leadId]) || [];
    const est = estimates.length > 0 ? estimates[0] : null;
    // Job Template estimates (2026-09-25) carry a job-type warranty and no
    // tier; null for every other estimate, which keeps its tier wording.
    const _rowsApi = window.NBDCustomerEstimateRows;
    const _jw = (_rowsApi && typeof _rowsApi.estimateWarranty === 'function' && _rowsApi.estimateWarranty(est)) || null;
    const before = photoBag.filter(p => (p.phase || '').toLowerCase() === 'before');
    const after  = photoBag.filter(p => (p.phase || '').toLowerCase() === 'after');
    const during = photoBag.filter(p => (p.phase || '').toLowerCase() === 'during');
    const fname = (lead.firstName || lead.fname || '').trim();
    const lname = (lead.lastName  || lead.lname || '').trim();
    const name  = (fname + ' ' + lname).trim();
    const jobVal = lead.jobValue || (est ? est.grandTotal : 0);
    const isComplete = (lead.stage || '').toLowerCase().includes('complete') ||
                       (lead.stage || '').toLowerCase().includes('closed');
    return {
      // Customer
      homeownerName: name, customerName: name,
      firstName: fname, lastName: lname,
      address: lead.address || '', homeownerAddress: lead.address || '',
      phone:   lead.phone   || '', customerPhone:   lead.phone   || '',
      email:   lead.email   || '', customerEmail:   lead.email   || '',
      // Already-geocoded pin (set on save / from the map), if any — lets the
      // Storm History Report doc skip a fresh Nominatim lookup.
      lat: (lead.lat != null ? lead.lat : null), lng: (lead.lng != null ? lead.lng : null),
      // Job — subType + trades added for parity with customer.html's
      // getCustomerDocData (Pre-W159 data compat sweep). Without these,
      // doc templates that switch on sub-type (e.g. storm AOB vs fire
      // AOB) or list trades (e.g. roof+gutters line items) would see
      // undefined and either crash on .join() or render blank.
      damageType: lead.damageType || '', stage: lead.stage || '',
      source: lead.source || '', notes: lead.notes || '',
      jobType: lead.jobType || '', jobValue: jobVal,
      subType: lead.subType || '',
      trades:  Array.isArray(lead.trades) ? lead.trades : [],
      tradesLabel: Array.isArray(lead.trades) && lead.trades.length
                     ? (typeof window.tradesLabel === 'function' ? window.tradesLabel(lead.trades) : lead.trades.join(', '))
                     : '',
      scopeOfWork: lead.scopeOfWork || '',
      projectDescription: lead.scopeOfWork || (est && est.description) || '',
      // Insurance
      insCarrier: lead.insCarrier || '', insuranceCompany: lead.insCarrier || '',
      claimNumber: lead.claimNumber || '', claimStatus: lead.claimStatus || '',
      policyNumber: lead.policyNumber || '',
      dateOfLoss: lead.dateOfLoss || '',
      deductible: lead.deductibleOrOwedByHO || '',
      supplementStatus: lead.supplementStatus || '',
      // Estimate
      totalPrice:     jobVal ? '$' + Number(jobVal).toLocaleString() : '',
      estimateAmount: jobVal ? '$' + Number(jobVal).toLocaleString() : '',
      contractPrice:  jobVal ? '$' + Number(jobVal).toLocaleString() : '',
      warrantyTier:   _jw ? _jw.wordingTier : ((est && (est.tier || est.tierName)) || lead.warrantyTier || ''),
      workmanshipWarranty: (_jw && _jw.text !== null) ? _jw.text : null,
      workmanshipWarrantyYears: _jw ? _jw.years : null,
      // See the twin in customer-tasks-ui.js: `est.lineItems` is always empty
      // for a V2 estimate (V2 writes `rows`), which made resolveDocManufacturer
      // fall back to its hardcoded GAF default on every job.
      estimateLineItems: (window.NBDCustomerEstimateRows
        && window.NBDCustomerEstimateRows.buildDocLineItems
        && window.NBDCustomerEstimateRows.buildDocLineItems(est))
        || (est && est.lineItems) || [],
      // Photos
      beforePhotoUrl: (before[0] && before[0].url) || '',
      afterPhotoUrl:  (after[0]  && after[0].url)  || '',
      beforePhotos: before, afterPhotos: after, duringPhotos: during,
      photoCount: photoBag.length, allPhotos: photoBag,
      // Meta
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      leadId: id,
      // Prerequisite flags
      _hasEstimate: estimates.length > 0,
      _hasPhotos:   photoBag.length > 0,
      _hasBeforeAfterPhotos: before.length > 0 && after.length > 0,
      _hasClaim:    !!(lead.claimNumber && lead.insCarrier),
      _hasContact:  !!(lead.phone || lead.email),
      _hasAddress:  !!lead.address,
      _hasScope:    !!(lead.scopeOfWork || (est && est.description)),
      _hasJobValue: !!jobVal,
      _isJobComplete: isComplete
    };
  }

  function _dashCheckPrerequisites(type, data) {
    const prereq = _DASH_DOC_PREREQUISITES[type];
    if (!prereq) return { ok: true };
    // Shape mirrors customer-tasks-ui.js's checkPrerequisites: each entry
    // keeps the `need` id alongside its human `text` so _showPrereqModal's
    // "Fix" button knows which field in the lead modal to focus.
    const missing = [];
    for (const need of prereq.needs) {
      switch (need) {
        case 'estimate':  if (!data._hasEstimate)  missing.push({ need, text: 'Build an estimate' }); break;
        case 'contact':   if (!data._hasContact)   missing.push({ need, text: 'Add phone or email' }); break;
        case 'address':   if (!data._hasAddress)   missing.push({ need, text: 'Add property address' }); break;
        case 'scope':     if (!data._hasScope)     missing.push({ need, text: 'Add scope of work' }); break;
        case 'photos':    if (!data._hasPhotos)    missing.push({ need, text: 'Upload inspection photos' }); break;
        case 'claim':     if (!data._hasClaim)     missing.push({ need, text: 'Add insurance carrier & claim number' }); break;
        case 'jobValue':  if (!data._hasJobValue)  missing.push({ need, text: 'Add job value or build estimate' }); break;
        case 'jobComplete': if (!data._isJobComplete) missing.push({ need, text: 'Mark job as Complete / Closed' }); break;
        case 'beforeAfterPhotos': if (!data._hasBeforeAfterPhotos) missing.push({ need, text: 'Upload both Before AND After photos' }); break;
      }
    }
    return missing.length ? { ok: false, missing, label: prereq.label, msg: prereq.msg } : { ok: true };
  }

  // ── "Fix the issue" routing (dashboard side) ────────────────────────
  // Parity with customer-tasks-ui.js's _fixDocNeed, one entry point for
  // both dashboard doc-gen surfaces (desktop lead-card chips + mobile
  // job-detail sheet — both call _generateDocWithPreflight, both land on
  // _showPrereqModal below). Dashboard's single lead modal (#leadModal,
  // opened by editLead) already carries every field customer.html splits
  // across Edit Info + the claim editor + the stage button, INCLUDING
  // Scope of Work (#lScopeOfWork) and Stage (#lStage) — so unlike
  // customer.html, jobComplete is a real one-step fix here (a <select>
  // option), not a scroll-to-the-kanban-button consolation. Only
  // estimate/photos genuinely live outside that modal.
  function _dashFixNeedFieldId(need) {
    switch (need) {
      case 'contact': return 'lPhone';
      case 'address': return 'lAddr';
      case 'scope': return 'lScopeOfWork';
      case 'jobValue': return 'lJobValue';
      case 'claim': return 'lInsCarrier';
      case 'jobComplete': return 'lStage';
      default: return null;
    }
  }

  function _dashFixDocNeed(need, leadId) {
    if (!leadId) return;
    if (need === 'estimate') {
      if (typeof window.startNewEstimate === 'function') window.startNewEstimate(leadId);
      return;
    }
    if (need === 'photos' || need === 'beforeAfterPhotos') {
      // No standing photo surface on the desktop board itself — send the
      // rep to the same customer.html Photos tab the mobile sheet's own
      // "View full record" link uses, rather than fake a fix in place.
      _stageWindowStateForLead(leadId);
      const base = (window.NBDUrl && window.NBDUrl.customer(leadId))
        || ('/pro/customer.html?id=' + encodeURIComponent(leadId));
      window.location.href = base + '#photosTab';
      return;
    }
    const fieldId = _dashFixNeedFieldId(need);
    if (typeof window.editLead === 'function') window.editLead(leadId);
    if (fieldId) {
      setTimeout(() => {
        // #insuranceFieldsBlock is hidden by toggleInsuranceFields (fired by
        // editLead's own setTimeout above) whenever jobType isn't already
        // 'insurance' — exactly the case a rep routed here for a MISSING
        // claim is likely to hit. Force it open rather than focus a field
        // the rep can't see.
        if (need === 'claim') {
          const block = document.getElementById('insuranceFieldsBlock');
          if (block) block.style.display = 'block';
        }
        const f = document.getElementById(fieldId);
        if (!f) return;
        f.focus();
        if (typeof f.select === 'function') f.select();
        f.style.transition = 'box-shadow .2s ease';
        const prevShadow = f.style.boxShadow;
        f.style.boxShadow = '0 0 0 3px var(--orange,#BD5728)';
        setTimeout(() => { f.style.boxShadow = prevShadow; }, 1600);
      }, 150);
    }
  }
  window._dashFixDocNeed = _dashFixDocNeed;

  // Expose only if the customer-page versions aren't there. Customer
  // page wins because it has fresh-loaded estimates/photos for the
  // open lead; the dashboard variant pulls from cached _leads /
  // _estimates / _photoCache.
  if (typeof window.getCustomerDocData !== 'function') {
    window.getCustomerDocData = function(maybeLeadId) {
      const id = maybeLeadId || window._customerId || document.getElementById('lEditId')?.value;
      return _dashGetCustomerDocData(id);
    };
  }
  if (typeof window.checkPrerequisites !== 'function') {
    window.checkPrerequisites = _dashCheckPrerequisites;
  }

  // Stage the window globals doc-preflight.js reads from. The preflight
  // module uses window._leadDoc / _customerId / _customerEstimates /
  // _allPhotos as its source of truth; on the dashboard these aren't
  // set, so we mirror them just-in-time before opening the modal.
  function _stageWindowStateForLead(leadId) {
    const lead = (window._leads || []).find(l => l && l.id === leadId);
    if (!lead) return false;
    window._leadDoc = lead;
    window._customerId = leadId;
    window._customerEstimates = (window._estimates || []).filter(e => e && (e.leadId === leadId || e.customerId === leadId));
    window._allPhotos = (window._photoCache && window._photoCache[leadId]) || [];
    return true;
  }
  // Exported: the mobile job-detail Documents tab (dashboard-actions.js
  // _mountDocumentsHub) needs the same window._customerId staging that
  // customer-documents.js's load()/viewGeneratedDoc() read, and this is
  // the one function that already does it correctly — no second copy.
  window._stageWindowStateForLead = _stageWindowStateForLead;

  // Render the "Can't generate — missing X" modal. Copy of the same UX
  // pattern used on customer.html, so the rep sees the same message
  // regardless of where they triggered generation from.
  function _showPrereqModal(check, leadId) {
    const escFn = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;z-index:var(--z-overlay,10000);background:rgba(0,0,0,.8);display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div class="dbx-bgs-bd1pxsolid-r14px">
        <div class="dbx-fs32px-mb12px">⚠️</div>
        <div class="dbx-ffbarlowco-fs20px-w700">Can't generate ${escFn(check.label || 'document')}</div>
        <div class="dbx-fs13px-cm-mb16px">${escFn(check.msg || 'This document needs data that hasn’t been added yet:')}</div>
        <div class="dbx-taleft-bgs2-r8px">
          ${check.missing.map(m => '<div class="dbx-dflex-aicenter-jcspacebet">'
            + '<span>• ' + escFn(m.text) + '</span>'
            + '<button type="button" class="nbd-preq-fix dbx-fxnone-p5px12px-bgrgba2552" data-need="' + escFn(m.need) + '">Fix &rarr;</button>'
            + '</div>').join('')}
        </div>
        <button class="nbd-preq-close dbx-p12px28px-bgorange-caccentfg">Got it</button>
      </div>`;
    modal.querySelector('.nbd-preq-close').addEventListener('click', () => modal.remove());
    modal.querySelectorAll('.nbd-preq-fix').forEach((btn) => {
      btn.addEventListener('click', () => {
        modal.remove();
        _dashFixDocNeed(btn.dataset.need, leadId);
      });
    });
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    document.body.appendChild(modal);
  }

  // Helper used by the doc branch — runs prerequisites + opens the
  // preflight modal (which calls NBDDocGen.generate on submit). Falls
  // through to direct generate if DocPreflight isn't loaded yet.
  function _generateDocWithPreflight(docType, leadId) {
    if (!leadId) {
      if (typeof showToast === 'function') showToast('Open a lead first', 'warning');
      return;
    }
    if (!_stageWindowStateForLead(leadId)) {
      if (typeof showToast === 'function') showToast('Lead not found — refresh the page and try again', 'error');
      return;
    }
    const data = _dashGetCustomerDocData(leadId);
    const check = _dashCheckPrerequisites(docType, data);
    if (!check.ok) {
      _showPrereqModal(check, leadId);
      return;
    }
    // PR 2b: the doc-generation cluster (DocPreflight + NBDDocGen) is now
    // lazy. If the rep hit a doc chip before the `docgen` bundle loaded
    // (e.g. before ever opening the Docs view), load it on demand, then run.
    // DocPreflight is preferred; NBDDocGen.generate is the fall-through so
    // the rep isn't blocked.
    const _run = () => {
      if (window.DocPreflight && typeof window.DocPreflight.open === 'function') {
        window.DocPreflight.open(docType, leadId);
        return;
      }
      if (window.NBDDocGen && typeof window.NBDDocGen.generate === 'function') {
        window.NBDDocGen.generate(docType, data);
      } else if (typeof showToast === 'function') {
        showToast('Document generator is still loading — try again in a moment', 'warning');
      }
    };
    if (window.DocPreflight || window.NBDDocGen) { _run(); return; }
    if (window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      window.ScriptLoader.loadBundle('docgen').then(_run);
      return;
    }
    _run();
  }
  // Shared with the mobile job-detail Documents tab's "Generate a document"
  // picker (dashboard-actions.js _mJdOpenDocCreate/_mJdPickDocType), which
  // reuses this SAME staging+prereq+DocPreflight chain instead of a second
  // copy, and needs the prerequisite labels to build its type list.
  // _generateDocWithPreflight is registered in __NBD_CALL_REGISTRY at the end
  // of this file (Globals Tranche 3 T3-C, 2026-09-18), no longer a bare
  // window global. _DASH_DOC_PREREQUISITES is DATA (a static config object),
  // not a callable — it stays on window.
  window._DASH_DOC_PREREQUISITES = _DASH_DOC_PREREQUISITES;

  // explicitLeadId (2026-09-15): the kanban card's next-action chip calls
  // this directly (crm-pipeline.js wireKanbanCardListeners) with the
  // card's own lead id, since there's no open edit modal to infer it from
  // out there. Every existing 2-arg caller (the Next Actions panel inside
  // the edit modal) is unaffected — explicitLeadId is undefined for them,
  // so the fallback below still reads lEditId exactly as before.
  const runLeadAction = function(actionId, kind, explicitLeadId) {
    const leadId = explicitLeadId || document.getElementById('lEditId')?.value || null;
    const lead = _findLead(leadId);
    // Emit for observers regardless of how the action is handled.
    document.dispatchEvent(new CustomEvent('nbd:lead-action', {
      detail: { actionId, kind, leadId }
    }));

    // ── Stage advances ──
    if (kind === 'stage') {
      const target = STAGE_TARGETS[actionId];
      if (target && leadId && typeof window.moveCard === 'function') {
        // Close the lead modal first so the kanban renders the new stage
        if (typeof window.closeLeadModal === 'function') window.closeLeadModal();
        window.moveCard(leadId, target);
        return;
      }
      // Fall through — stage actions without a target shouldn't happen,
      // but if they do we toast honestly rather than silently doing nothing.
      if (typeof showToast === 'function') showToast('Stage target not configured for this action', 'warning');
      return;
    }

    // ── Document generators ──
    if (kind === 'doc') {
      // 1. Native (lead-aware) handlers first — these have their own
      //    UI flows and don't route through the generic NBDDocGen viewer.
      if (actionId === 'photo_report') {
        // Route to the customer page's report BUILDER rather than firing a
        // report straight off. This called generatePhotoReport(leadId) with no
        // second argument, which silently defaulted to homeowner mode — so a
        // rep who wanted the adjuster dossier could not get one from the
        // dashboard at all, and nobody could reach cover, numbering, section
        // or note options, all of which live in the builder.
        //
        // customer.html auto-opens the builder on a #photo-report hash
        // (customer-photo-report-picker.js maybeAutoOpenFromHash), so this is
        // the existing deep-link path, not a new one.
        // NBDUrl.customer is the one builder for the customer-page URL; the
        // literal is the documented fallback for a boot race (nbd-url.js is a
        // defer script). Absolute /pro/… per the CI-guarded inter-page nav rule.
        if (leadId) {
          try { if (typeof window._stashLeadForCustomerPage === 'function') window._stashLeadForCustomerPage(leadId); } catch (e) { /* stash is an optimisation */ }
          const base = (window.NBDUrl && window.NBDUrl.customer(leadId))
            || ('/pro/customer.html?id=' + encodeURIComponent(leadId));
          window.location.href = base + '#photo-report';
          return;
        }
      } else if (actionId === 'send_estimate' || actionId === 'send_quote' || actionId === 'revise_estimate') {
        if (typeof window.startNewEstimate === 'function' && leadId) {
          try { window.startNewEstimate(leadId); return; } catch (e) { console.warn('startNewEstimate threw:', e.message); }
        }
      } else if (actionId === 'inspect_report') {
        // Pick the right inspection variant — insurance leads get the
        // technical (code citations) report, others get the homeowner
        // (cleaner, readable) variant.
        const docType = (lead && lead.jobType === 'insurance') ? 'inspectionInsurance' : 'inspectionHomeowner';
        _generateDocWithPreflight(docType, leadId);
        return;
      } else if (ACTION_DOC_MAP[actionId]) {
        // 2. Mapped doc types — every other chip with a doc kind whose
        //    action ID is in ACTION_DOC_MAP (AOB, contract, change order,
        //    invoice, warranty cert, etc.) goes through DocPreflight,
        //    which gathers any missing merge fields and persists the
        //    rep's edits (LEAD / DOCUMENT / EPHEMERAL) before calling
        //    NBDDocGen.generate. Prereq check happens inside the
        //    helper — if the lead is missing required data (claim #,
        //    estimate, before/after photos, etc.) we show a clear
        //    modal listing what's needed instead of generating a doc
        //    full of placeholder strings.
        _generateDocWithPreflight(ACTION_DOC_MAP[actionId], leadId);
        return;
      }
      // 3. Generic fallback for any doc-kind chip we haven't mapped yet.
      //    Logs to the lead activity so the rep at least has a marker.
      const docLabel = (actionId || 'document').replace(/_/g, ' ');
      if (typeof showToast === 'function') {
        showToast(`"${docLabel}" — logged on the lead (generator wiring pending)`, 'info');
      }
      if (leadId) _logLeadActivity(leadId, actionId, docLabel);
      return;
    }

    // ── Plain workflow actions ──
    // Two families. Chips with a real destination open it (ACTION_HANDLER_MAP
    // above) AND log the fact; everything else is a "log that you did this"
    // marker — "Log Contact", "Follow Up", "Order Materials" — with nothing
    // to open, so recording it IS the whole action.
    const label = (actionId || 'action').replace(/_/g, ' ');
    const handler = ACTION_HANDLER_MAP[actionId];
    if (handler) {
      if (!leadId) {
        if (typeof showToast === 'function') showToast('Open a lead first', 'warning');
        return;
      }
      // A handler that reports false means its subsystem wasn't loaded — fall
      // through to the log tail rather than swallowing the click.
      if (handler(leadId)) { _logLeadActivity(leadId, actionId, label); return; }
    }
    if (leadId) {
      _logLeadActivity(leadId, actionId, label).then(ok => {
        if (typeof showToast === 'function') {
          showToast(ok ? `✓ Logged: ${label}` : `Couldn't log ${label} — try again`, ok ? 'success' : 'warning');
        }
      });
    } else {
      if (typeof showToast === 'function') showToast('Open a lead first to log this action', 'warning');
    }
  };

  // ── Smart stage dropdown filter ──
  // Hide optgroups from other tracks based on the selected jobType.
  // Preserves the current selection even if its track would be hidden —
  // shows a small warning instead of silently switching stages.
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer a bare window global.
  function filterStageDropdownByJobType(jobType) {
    const sel = document.getElementById('lStage');
    if (!sel) return;
    const currentVal = sel.value;
    const groups = sel.querySelectorAll('optgroup');
    let currentOptVisible = true;
    groups.forEach(g => {
      const label = (g.label || '').toLowerCase();
      let show = true;
      // Hide optgroups labeled for other tracks. Empty jobType shows everything.
      if (jobType === 'insurance') {
        if (label.includes('cash') || label.includes('finance') || label.includes('warranty') || label.includes('service')) show = false;
      } else if (jobType === 'cash') {
        if (label.includes('insurance') || label.includes('finance') || label.includes('warranty') || label.includes('service')) show = false;
      } else if (jobType === 'finance') {
        if (label.includes('insurance') || label.includes('cash') || label.includes('warranty') || label.includes('service')) show = false;
      } else if (jobType === 'warranty') {
        if (label.includes('insurance') || label.includes('cash') || label.includes('finance') || label.includes('service')) show = false;
      } else if (jobType === 'service') {
        if (label.includes('insurance') || label.includes('cash') || label.includes('finance') || label.includes('warranty')) show = false;
      }
      g.style.display = show ? '' : 'none';
      // Check if the currently selected option lives in a hidden group
      g.querySelectorAll('option').forEach(o => {
        if (o.value === currentVal && !show) currentOptVisible = false;
      });
    });
    // Show or hide a warning about cross-track stage mismatch
    let warn = document.getElementById('lStageWarning');
    if (!currentOptVisible && currentVal) {
      if (!warn) {
        warn = document.createElement('div');
        warn.id = 'lStageWarning';
        warn.style.cssText = 'font-size:10px;color:var(--orange);margin-top:4px;padding:4px 8px;background:rgba(234,88,12,.08);border-left:2px solid var(--orange);border-radius:3px;';
        sel.parentElement.appendChild(warn);
      }
      warn.textContent = '⚠ Current stage is from a different track. Change stage to match the new job type.';
      warn.style.display = 'block';
    } else if (warn) {
      warn.style.display = 'none';
    }
  }

  // Attach listener after DOM ready
  document.addEventListener('DOMContentLoaded', () => {
    const jtSel = document.getElementById('lJobType');
    if (jtSel) jtSel.addEventListener('change', toggleInsuranceFields);
    const stSel = document.getElementById('lStage');
    if (stSel) stSel.addEventListener('change', toggleInsuranceFields);

    // Drop "?" help icons next to high-impact labels. The helper is
    // defer-loaded so we retry a couple times until it's available.
    function _attachHelpIcons() {
      if (!window.HelpIcon) return false;
      const findLabel = (id) => {
        const el = document.getElementById(id);
        return el?.closest('.mfield')?.querySelector('label') || null;
      };
      // Job Type — links to the new job-types section since we just shipped it
      const jtLbl = findLabel('lJobType');
      if (jtLbl) window.HelpIcon.attach(jtLbl, 'job-types', { position: 'inside' });
      // Stage — links to the kanban section
      const stLbl = findLabel('lStage');
      if (stLbl) window.HelpIcon.attach(stLbl, 'kanban', { position: 'inside' });
      return true;
    }
    if (!_attachHelpIcons()) {
      let n = 0;
      const t = setInterval(() => {
        if (_attachHelpIcons() || ++n > 20) clearInterval(t);
      }, 250);
    }
  });

  // ── Global drop handler for kanban columns ──
  window.drop = function(event, stageKey) {
    event.preventDefault();
    // closest first: under board-level delegation currentTarget is the
    // board itself; the drag-over highlight lives on the column body.
    const el = (event.target.closest && event.target.closest('.kcol-body')) || event.currentTarget;
    if (el) el.classList.remove('drag-over');
    const dragId = window._dragId || event.dataTransfer?.getData('text/plain');
    if (!dragId) return;
    if (typeof moveCard === 'function') moveCard(dragId, stageKey, { isDrag: true });
    window._dragId = null;
  };

  // ── View switcher ──
  window.switchKanbanView = function(viewKey) {
    window.buildKanbanColumns(viewKey);
    // Update active button state
    document.querySelectorAll('.kview-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === viewKey);
    });
    // Re-render leads into new columns
    if (typeof renderLeads === 'function') {
      renderLeads(window._leads, window._filteredLeads);
    }
  };

  const firebaseConfig = {
    apiKey: "AIzaSyDTrotINzl2YjdGbH25BpC-FPv8i_fXNvg",
    authDomain: "nobigdeal-pro.firebaseapp.com",
    projectId: "nobigdeal-pro",
    storageBucket: "nobigdeal-pro.firebasestorage.app",
    messagingSenderId: "717435841570",
    appId: "1:717435841570:web:c2338e11052c96fde02e7b"
  };

  // v159.7: stop hiding the page during init.
  // Up through v159.6 we set visibility:hidden here, relying on either
  // _showPage() in nbd-auth.js or the catch handler to restore it. On
  // mobile this has been failing — the hide DOES land but the show
  // never fires because module 1's promise hangs. Removing the hide is
  // a deliberate trade-off: the page may flash unauth content for a
  // few hundred ms, but at least it never gets stuck on a permanently
  // invisible page if module init dies. The diagnostic banner is the
  // only ground-truth we have right now and it must be visible.
  // (Original line: document.documentElement.style.visibility="hidden";)
  window.__nbdMark && window.__nbdMark('m2:beforeApp');
  // v159.6: Singleton-aware app init.
  // nbd-auth.js (the FIRST module on this page) already calls
  // initializeApp(FIREBASE_CONFIG) and exposes the result on
  // window._firebaseApp. Reusing the already-initialized instance
  // removes any duplicate-app risk and — equally important —
  // guarantees we share the SAME long-polling-enabled Firestore
  // instance that nbd-auth.js created via initializeFirestore(_app, {
  // experimentalForceLongPolling: true }). Without this share, our
  // getFirestore(app) below would silently get the default WebChannel
  // transport, which is the very thing PR #289 was trying to avoid.
  const app     = window._firebaseApp || initializeApp(firebaseConfig);
  window.__nbdMark && window.__nbdMark(window._firebaseApp ? 'm2:app:reused' : 'm2:app:fresh');

  // ─── App Check (C-4) ──────────────────────────────────────
  // Functions declare `enforceAppCheck: true` but previously nothing
  // on this page was minting attestation tokens. That meant either:
  //  (a) enforcement was silently off in the project (curl could
  //      hit claudeProxy / imageProxy with just an ID token), or
  //  (b) enforcement was on and half the app was failing silently.
  // Either way the guarantee was broken. We now initialize App Check
  // with ReCaptchaV3 so every Firebase SDK request (auth callables,
  // Firestore, Functions) carries a real token.
  //
  // The site key lives in window.__NBD_APP_CHECK_KEY, set via a
  // <meta> tag below. Keys are per-origin and safe to include in
  // HTML (they're validated by reCAPTCHA, not secret). An unset key
  // falls back to an init-skipped warning so dev/local still works.
  const APP_CHECK_KEY = (window.__NBD_APP_CHECK_KEY || '').trim();
  if (isLocalEmulatorEnv() && !window.__NBD_APP_CHECK_INITIALIZED) {
    // Emulator rig: reCAPTCHA can't mint tokens off the registered origin,
    // but enforced callables (claimInvite, createCompany, …) still demand a
    // decodable App Check JWT even in the Functions emulator. Sync init (no
    // dynamic import) so no callable can race ahead of the shim.
    try {
      // Keep the AppCheck instance on window so raw-fetch callers
      // (NBDComms, claude-proxy) can mint X-Firebase-AppCheck headers.
      window.__NBD_APP_CHECK = initializeAppCheck(app, {
        provider: new CustomProvider({ getToken: async () => emulatorAppCheckFakeToken() }),
        isTokenAutoRefreshEnabled: false
      });
      window.__NBD_APP_CHECK_INITIALIZED = true;
    } catch (e) {
      console.warn('App Check emulator shim init failed:', e);
    }
  } else if (APP_CHECK_KEY && !window.__NBD_APP_CHECK_INITIALIZED) {
    try {
      window.__NBD_APP_CHECK = initializeAppCheck(app, {
        provider: new ReCaptchaEnterpriseProvider(APP_CHECK_KEY),
        isTokenAutoRefreshEnabled: true
      });
      window.__NBD_APP_CHECK_INITIALIZED = true;
    } catch (e) {
      console.error('App Check init failed:', e);
    }
  } else if (!APP_CHECK_KEY) {
    console.warn('App Check not configured. Set window.__NBD_APP_CHECK_KEY via the meta tag in dashboard.html <head>. Callable functions with enforceAppCheck: true WILL reject these requests in production.');
  }

  const auth    = getAuth(app);
  const db      = getFirestore(app);
  const storage = getStorage(app);
  // Audit #3: localhost-only emulator wiring. On dashboard.html, auth+db were
  // already wired by nbd-auth (reused instances → deduped); this connects the
  // fresh storage instance (uploads happen far later, so no await needed) and
  // covers the no-nbd-auth fallback path. Hard no-op in production.
  connectEmulatorsIfLocal({ auth, db, storage });

  // CRITICAL: Expose Firebase functions to window for drag & drop and other global handlers
  window.db = db;
  // _db mirror — invoice-pipeline.js and a handful of other modules
  // were written against this name before the codebase settled on
  // window.db. Expose both so existing call sites keep working.
  window._db = db;
  // _project — offline-manager.js uses this when building Firestore
  // REST URLs to flush the queued writes. Without it the URL became
  // /v1/projects/undefined/databases/(default)/... and every flush
  // 404'd. Stamp it from the canonical config.
  window._project = firebaseConfig.projectId;
  window.storage = storage;
  window.auth = auth;
  window.doc = doc;
  window.getDoc = getDoc;
  window.getDocs = getDocs;
  window.addDoc = addDoc;
  window.updateDoc = updateDoc;
  window.deleteDoc = deleteDoc;
  window.collection = collection;
  window.query = query;
  window.where = where;
  window.orderBy = orderBy;
  window.limit = limit;
  window.onSnapshot = onSnapshot;  // live team activity (d2d-tracker) + realtime consumers
  window.startAfter = startAfter;  // Audit #4 / 5.1: enables cursor pagination
  window.serverTimestamp = serverTimestamp;
  window.arrayUnion = arrayUnion;
  window.increment = increment;  // referral-rewards-ui.js ledger reconcile
  window.ref = ref;
  window.uploadBytes = uploadBytes;
  window.getDownloadURL = getDownloadURL;
  window.listAll = listAll;
  window._signOut = signOut;
  window._onAuthStateChanged = onAuthStateChanged;
  window.setDoc = setDoc;
  window.writeBatch = writeBatch;
  // Expose runTransaction so crm.js can use a stage-compare transaction
  // to prevent two-tab double-moves from creating duplicate stageHistory
  // entries (T18). Already used inside this module for the customer-ID
  // counter; the export just lets it run in a different file.
  window.runTransaction = runTransaction;
  window.sendPasswordResetEmail = sendPasswordResetEmail;
  // Expose connection cycling so the visibilitychange handler in the
  // outer (non-module) script block at the bottom of this page can
  // call them when the tab returns to foreground after iOS suspended JS.
  window.disableNetwork = disableNetwork;
  window.enableNetwork = enableNetwork;

  // ── GLOBAL ERROR BOUNDARY ──────────────────────────────────
  // Log errors to console only. NEVER show toasts from global
  // handlers — they fire on benign Firebase rejections, network
  // hiccups, and deferred-script timing issues that don't affect
  // the user. Real errors should be caught locally by the
  // functions that throw them, with specific user-friendly messages.
  window.addEventListener('error', e => {
    console.error('Uncaught error:', e.error || e.message);
  });
  window.addEventListener('unhandledrejection', e => {
    console.warn('Unhandled promise rejection:', e.reason);
  });

  // ── IN-MEMORY ACCOUNT BOUNDARY ─────────────────────────────
  // Two module-scope caches outlive a same-tab account switch, and neither is
  // reachable by the server-side companyId scoping that keeps tenants apart —
  // a cache that is served is a request that is never made.
  //
  // 1. ANALYTICS CARDS. adjuster-tactic-card.js and ai-texting-stats-card.js
  //    each memoize their callable response in a module-scope `_cache` and
  //    serve it forever (`if (_cache) return _cache;`), so a stale cache
  //    renders the PREVIOUS tenant's carrier/adjuster and AI-texting board.
  // 2. THE LEAD BOOK. window._leads + window._leadsLoaded describe ONE
  //    account's book, and `_leadsLoaded === true` is what the destructive
  //    and bulk guards trust as "this book is real": loadSampleData's
  //    empty-book check (dashboard-actions.js), runImport's dedup
  //    (data-import.js), canDeleteStage (pipeline-builder.js). Nothing ever
  //    set the flag back to false, so after a switch it stayed true over the
  //    PREVIOUS account's leads — or over [] while the new account's first
  //    load was in flight or had failed — and all three guards passed
  //    against the wrong book.
  //
  // Both clears key on THIS tab's signed-in uid, NOT on localStorage's
  // nbd_last_uid (see the purge block at the top of the callback): that key is
  // shared by every tab on the origin while these caches are per-module.
  // Same-tab account switch, two tabs: tab 1 holds A's data; tab 2 signs in as
  // B, and tab 2's own callback writes nbd_last_uid = B. Tab 1's callback runs
  // later — Firebase restores auth state from IndexedDB, and a backgrounded
  // tab's timers are throttled, so "later" is routine, not exotic — reads
  // nbd_last_uid, finds B, and concludes nothing changed. A's data stayed in
  // memory and the next goTo('board') rendered it into B's session. A storage
  // exception skips that block outright, with the same result.
  //
  // ONE binder, not two. These arrived as separate PRs (#1679 cards, #1676
  // leads) and were collapsed when the second landed, so a later change to
  // what counts as an account switch cannot update one cache and miss the
  // other. The lead book additionally tracks WHICH account its rows belong to
  // (_leadsCacheUid) so an in-flight load that resolves after its account
  // stopped being current is discarded rather than committed.
  let _sessionUid;               // uid onAuthStateChanged last reported (undefined = not yet, null = signed out)
  let _leadsCacheUid = null;     // account whose leads window._leads holds (null = none)
  function _clearAnalyticsCardCaches() {
    // Separately guarded so one card throwing cannot leave the OTHER
    // tenant's board memoized — the whole point of this call.
    try {
      if (window.AdjusterTacticCard && typeof window.AdjusterTacticCard._clearCache === 'function') {
        window.AdjusterTacticCard._clearCache();
      }
    } catch (_) { /* best-effort */ }
    try {
      if (window.AiTextingStatsCard && typeof window.AiTextingStatsCard._clearCache === 'function') {
        window.AiTextingStatsCard._clearCache();
      }
    } catch (_) { /* best-effort */ }
  }
  function _resetLeadsCache() {
    window._leadsLoaded = false;
    window._leads = [];
    _leadsCacheUid = null;
    // The next account gets a full cold-start retry budget and a clean
    // load-status banner, not the previous account's leftovers.
    window._loadLeadsRetryAttempt = 0;
    window._loadLeadsSlowAttempt = 0;
    window._loadLeadsExhausted = false;
    window._loadLeadsNextRetryAt = null;
    window._loadLeadsLastError = null;
  }
  function _bindCachesToSession(uid) {
    const prev = _sessionUid;
    _sessionUid = uid;
    // First tick of the page has nothing cached behind it to clear; every
    // later change of account — including a sign-out (uid null) — does.
    if (prev === undefined || prev === uid) return;
    // Each reset is isolated. _clearAnalyticsCardCaches already swallows its
    // own errors, and _resetLeadsCache is plain assignment today — but that
    // makes the guarantee depend on the ORDER of these two lines and on
    // _resetLeadsCache never growing a throwing statement. Both are one edit
    // away, and the failure is silent: whichever cache is skipped keeps
    // serving the PREVIOUS account. So the isolation is written down here
    // instead of being argued from the current bodies.
    _clearAnalyticsCardCaches();
    try { _resetLeadsCache(); } catch (_) { /* best-effort */ }
    // The company profile too (2026-09-25, PR #1774 review). Nothing reset
    // it: _companyProfileLoaded stayed true with the previous account's
    // profile in memory (or bare defaults, after the shared-device storage
    // purge), and the Estimates panel still counted as painted from it — so
    // Save All could full-replace the NEW account's company jurisdictions
    // and county rates with the old account's rows, or with nothing. The
    // boot below reads this account's profile afresh. (No storage purge
    // here: see the nbd_last_uid block in the auth callback.)
    try { if (typeof window._resetCompanyProfile === 'function') window._resetCompanyProfile(); } catch (_) { /* best-effort */ }
    // A painted Estimates panel goes back to its loading state too, so the
    // new account never sees (or types over) the old account's company
    // rates, and this account's landing repaints it (second review of
    // #1774). Not on a sign-out: the page is leaving for the login screen.
    try { _forgetEstimatePanelPaint(!!uid); } catch (_) { /* best-effort */ }
  }

  onAuthStateChanged(auth, async user => {
    // FIRST, before the redirect and before any await: the cards must stop
    // serving the old account's board, and the lead-book guards must refuse,
    // from the instant the account changes — not from whenever the claims and
    // subscription reads below finish and loadLeads() runs for the new uid.
    _bindCachesToSession(user ? user.uid : null);
    if (!user) { window.location.replace("/pro/login.html"); return; }

    // Shared-device PII guard: if a DIFFERENT account was last active on this
    // device, purge the prior rep's cached data (leads, filters, company
    // profile, usage tallies) BEFORE loading this user's. Covers both account-
    // switch and fresh-login — the sign-out controls historically bypassed
    // NBDAuth.logout()'s purge, so the prior user's customer PII lingered.
    // nbd_last_uid is in the purge KEEP set, so it survives the wipe.
    try {
      const _lastUid = localStorage.getItem('nbd_last_uid');
      if (_lastUid && _lastUid !== user.uid) {
        if (window.NBDAuth && typeof window.NBDAuth.purgeAccountStorage === 'function') {
          window.NBDAuth.purgeAccountStorage();
        }
        // The IN-MEMORY analytics card caches used to be cleared here too.
        // They are not, any more: nbd_last_uid is shared by every tab and
        // these caches are per-module, so another tab's write silently
        // skipped this branch and left the prior tenant's board in memory.
        // _bindCachesToSession (declared above onAuthStateChanged)
        // owns that now, keyed on this tab's own uid. The purge below stays
        // keyed on nbd_last_uid on purpose — localStorage IS shared, and
        // purging on an in-memory switch would wipe prefs the new account
        // has already written in another tab.
      }
      localStorage.setItem('nbd_last_uid', user.uid);
    } catch (_) { /* best-effort; never block boot on a storage error */ }

    // ── SUBSCRIPTION CHECK ────────────────────────────────────
    // Owner bypass — claims-based: keyed on the { owner: true } custom
    // claim minted server-side by mintOwnerClaims (single email list in
    // functions/handlers/_shared.js). Ensures a missing/stale
    // subscriptions/ doc never flips Joe to 'free' and triggers the
    // "upgrade to unlock" wall for his own product.
    //
    // Claim-ONLY since the OWNER_EMAILS retirement (2026-07-06): the
    // email-literal fallback this block carried is gone. nbd-auth's
    // login path heals a missing founder claim (mint + token refresh)
    // before the dashboard bootstraps, so this read sees owner:true on
    // founder sessions; if it somehow doesn't, the session degrades to
    // the normal subscription path below and heals on the next login.
    //
    // NOTE: the previous `isDemoAccount = user.email === 'demo@nobigdeal.pro'`
    // hardcoded bypass was REMOVED (2026-04-23). Demo accounts now flow
    // through NBDAuth's claim-based demo path (H-02). Trusting an email
    // literal here was a second auth surface that could diverge from the
    // claim-based path and silently grant professional-tier access —
    // the same reasoning that retired the owner-email literals.
    let _bootClaims = null;
    try {
      const _tr = await user.getIdTokenResult();
      _bootClaims = (_tr && _tr.claims) || null;
    } catch (_) { /* claims unread — owner short-circuit simply won't fire */ }
    const isOwnerAccount = (_bootClaims && _bootClaims.owner === true);

    if (isOwnerAccount) {
      window._userPlan = 'growth';
      window._subscription = { plan: 'growth', status: 'active', _owner: true };
      console.log('✓ Owner account — growth plan granted');
    } else {
      // Subscription check — SOFT. Never block the dashboard load.
      // The billing-gate module handles limits via soft gates.
      // Access code users, free tier, and trial users all have no
      // subscription doc — that's normal, not an error.
      try {
        // 4s timeout — on iOS bfcache restore this getDoc can hang
        // forever instead of rejecting, blocking the visibility=visible
        // flip below and leaving the dashboard invisible. Soft failure
        // here drops to free tier (billing-gate enforces real limits).
        // Pillar 4: billing is company-level — a team member reads the
        // company's subscription (doc keyed by owner uid == their companyId
        // claim). Solo owners resolve to their own uid as before. Claims
        // read is cached (no extra network on a warm token).
        let _subKey = user.uid;
        if (_bootClaims) {
          // Reuse the claims read hoisted above the owner check.
          _subKey = _bootClaims.companyId || user.uid;
        } else {
          try {
            const _tr = await user.getIdTokenResult();
            _subKey = (_tr && _tr.claims && _tr.claims.companyId) || user.uid;
          } catch (_) { /* fall back to uid */ }
        }
        const subSnap = await Promise.race([
          getDoc(doc(db, 'subscriptions', _subKey)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Subscription check timed out')), 4000))
        ]);
        if (subSnap.exists()) {
          const subscription = subSnap.data();
          window._subscription = subscription;
          // Read-boundary alias resolution — production docs carry
          // legacy plan keys forever (mirrors PLAN_ALIASES in
          // nbd-auth.js); window._userPlan is always canonical.
          const _planAliases = { foundation: 'starter', blueprint: 'starter', professional: 'growth' };
          const _rawPlan = subscription.plan || 'free';
          window._userPlan = _planAliases[_rawPlan] || _rawPlan;
          // H-03: do NOT persist plan in localStorage — it reintroduces
          // the fail-open hole that nbd-auth.js explicitly removed.
          console.log('✓ Subscription:', subscription.plan, subscription.status);
        } else {
          // No subscription doc — normal for access code / free tier users
          window._subscription = { plan: 'free', status: 'active' };
          window._userPlan = 'free';
          console.log('No subscription doc — defaulting to free tier');
        }
      } catch (error) {
        // Fail CLOSED — on Firestore error, restrict to the most limited
        // tier. The old comment here said "Fail open" but the code already
        // set plan='free' (which IS fail-closed). Renamed the flag and
        // comment to match intent so this doesn't get "fixed" back to
        // actually-fail-open by a future reader misled by the label.
        console.warn('Subscription check failed — failing closed to free:', error.message);
        window._subscription = { plan: 'free', status: 'active', _failClosed: true };
        window._userPlan = 'free';
      }
    }
    
    document.documentElement.style.visibility="visible";
    
    // Show upgrade banner for free-tier users. 'free' = organic no-sub
    // signups (the audience the Stripe funnel targets); 'lite' = expired
    // access-code trials. The old 'lite'-only gate meant the primary in-app
    // upgrade CTA never showed to actual free signups. Skip when the plan
    // resolution failed closed (_failClosed) — don't upsell a paying user
    // over a network blip.
    if ((window._userPlan === 'free' || window._userPlan === 'lite')
        && !(window._subscription && window._subscription._failClosed)) {
      setTimeout(() => {
        const banner = document.createElement('div');
        banner.id = 'liteBanner';
        // Geometry moved OUT of this cssText and into .nbd-bottom-strip
        // (dashboard-app.css). Hand-rolling the pinned box here meant nothing
        // else in the app could know the banner existed, so it silently ate the
        // last row of every scroll surface and painted over #mobile-nav.
        // data-nbd-bottom-strip is the declaration fab-stack-coordinator.js
        // measures; it publishes the summed strip height as --nbd-bottom-chrome
        // and every bottom-anchored consumer reserves against that. Do NOT set
        // that custom property from here — measurement has exactly one writer,
        // which is also what makes "both banners mounted at once" correct for
        // free: the coordinator sums the strips rather than picking one.
        // The class additionally brings env(safe-area-inset-bottom) padding, so
        // the CTA and ✕ clear the iPhone home indicator.
        banner.className = 'nbd-bottom-strip';
        banner.setAttribute('data-nbd-bottom-strip', '');
        // Colours only. The palette is the one thing NOT shared with the lapse
        // strip below, so it is the only thing left inline.
        banner.style.cssText = 'background:linear-gradient(90deg,var(--s),var(--s2));border-top:2px solid var(--orange);color:rgba(255,255,255,.8);';
        banner.innerHTML = `
          <span>🚀 You're on the <strong class="fg-orange">NBD Pro Free plan</strong> (10 leads/month)</span>
          <a href="/pro/pricing.html" class="dbx-bgorange-caccentfg-p6px16px">Upgrade — Starter $99/mo →</a>
          <button data-action="removeParent" class="dbx-bgnone-bdnone-crgba2552">✕</button>
        `;
        document.body.appendChild(banner);
      }, 2000);
    }
    // Lapse lifecycle banner (gauntlet batch 2): a cancelled subscription
    // keeps the team working for a 14-day grace window, then the daily
    // enforceLapsedSeats cron pauses non-owner seats (reversibly). Tell
    // the OWNER where they are in that lifecycle — silence was the failure
    // mode that let a 6-person team ride a cancelled plan indefinitely.
    if (window._subscription && window._subscription.status === 'cancelled'
        && !window._subscription._failClosed) {
      setTimeout(() => {
        if (document.getElementById('lapseBanner')) return;
        const sub = window._subscription;
        const cancelledMs = sub.cancelledAt && typeof sub.cancelledAt.toMillis === 'function'
          ? sub.cancelledAt.toMillis() : null;
        const graceEnds = cancelledMs ? new Date(cancelledMs + 14 * 24 * 3600 * 1000) : null;
        const paused = sub.lapseEnforced === true;
        const msg = paused
          ? 'Your subscription ended and team seats are paused. Your data is safe — resubscribe to restore your team instantly.'
          : 'Your subscription was cancelled. Your team keeps full access' +
            (graceEnds ? ' until ' + graceEnds.toLocaleDateString() : ' during the grace period') +
            ' — resubscribe to keep them active.';
        const banner = document.createElement('div');
        banner.id = 'lapseBanner';
        // Same contract as #liteBanner above — see the comment there. The
        // flex-wrap:wrap this used to declare now comes from .nbd-bottom-strip,
        // where it belongs: a strip that wraps to two rows is exactly the case
        // that made a hard-coded height guess wrong, and the coordinator
        // measures the rendered box instead of guessing.
        banner.className = 'nbd-bottom-strip';
        banner.setAttribute('data-nbd-bottom-strip', '');
        // Colours only. This strip keeps its own alarm palette (raw hex, not
        // theme tokens) on purpose — a lapsed-subscription warning must read
        // the same on every one of the 186 themes.
        banner.style.cssText = 'background:linear-gradient(90deg,#3a1e1e,#2a1414);border-top:2px solid #c53030;color:rgba(255,255,255,.85);';
        const span = document.createElement('span');
        span.textContent = (paused ? '⏸ ' : '⚠️ ') + msg;
        const cta = document.createElement('a');
        cta.href = '/pro/pricing.html';
        cta.textContent = paused ? 'Resubscribe & restore team →' : 'Resubscribe →';
        cta.style.cssText = 'background:var(--orange);color:var(--accent-fg);padding:6px 16px;border-radius:6px;text-decoration:none;font-weight:700;font-size:11px;';
        const x = document.createElement('button');
        x.textContent = '✕';
        x.setAttribute('aria-label', 'Dismiss');
        x.style.cssText = 'background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;font-size:16px;margin-left:8px;';
        x.addEventListener('click', () => banner.remove());
        banner.append(span, cta, x);
        document.body.appendChild(banner);
      }, 2000);
    }
    window._user = user;
    // Prime the client billing gate once per login so enforceGate/softGate have
    // the real plan + usage before the first lead write. loadSubscription() was
    // ONLY called when Settings → Billing opened, so on the normal lead-entry
    // flow _loaded stayed false and both gates failed open ALL session — a free
    // stranger could create unlimited leads and the 10/mo cap + nudges never
    // fired. Fire-and-forget: the gate fails open until this resolves, which is
    // the intended brief pre-load grace, not a permanent hole. NBDBilling is a
    // deferred script and this callback is async post-auth, so it's always
    // defined by now; the typeof guard is belt-and-suspenders.
    if (window.NBDBilling && typeof window.NBDBilling.loadSubscription === 'function') {
      window.NBDBilling.loadSubscription();
    }
    // Fetch the shop-wide Company Profile so every doc generated this
    // session uses the rep's saved legal text / financing / marketing.
    // Fire-and-forget — defaults are already in window._companyProfile,
    // so docs work even if this hangs.
    // A read that gave up is retried (2026-09-25, lane profretry): on a cold
    // Firestore channel the first read threw "client is offline" three times
    // and nothing asked again, so _companyProfileLoaded stayed unset all
    // session — county rates and jurisdictions could not be saved and the
    // tenant's pipeline stages never applied. A landing applies the pipeline
    // config through the 'nbd:company-profile-loaded' listener (module top
    // level); a read that failed applies this tenant's cache straight away and
    // hands over to the retry. If company-profile.js has not run yet (it is
    // deferred far down the page) this guard used to skip the read for good;
    // now it leaves word, and that file starts the read when it arrives.
    if (typeof window._loadCompanyProfile === 'function') {
      window._loadCompanyProfile()
        .then(() => {
          if (window._companyProfileLoaded === true) return;
          applyPipelineConfig();
          if (typeof window._ensureCompanyProfile === 'function') return window._ensureCompanyProfile();
        })
        .catch(() => {});
    } else {
      window.__nbdCompanyProfileWanted = true;
    }
    // Pre-warm the notification-settings cache from Firestore so a rep
    // signing in on a new device gets their saved preferences before
    // they ever open Settings → Notifications. Fire-and-forget — the
    // tab-open path falls back to localStorage if this is still pending.
    if (typeof _syncNotifSettingsFromFirestore === 'function') {
      _notifFirestoreSynced = true;
      _syncNotifSettingsFromFirestore();
    }
    // Load custom claims for role-based access (Enterprise)
    // Claims include: companyId, role, plan, subscriptionStatus
    try {
      const tokenResult = await user.getIdTokenResult();
      window._userClaims = tokenResult.claims || {};
      // Invite-check flags are keyed PER UID and cleared on sign-out. The old
      // device-global 'nbd_invite_checked' bricked invite claiming in three
      // ordinary scenarios (gauntlet blocker #1): rep signed up before the
      // invite existed (terminal no_invite set the flag forever), invitee with
      // a pre-existing account, and shared machines where the OWNER's own load
      // set the flag. Legacy unkeyed flags are intentionally ignored so
      // already-stranded devices get a fresh re-check after this ships.
      const _inviteCheckedKey = 'nbd_invite_checked_' + user.uid;
      const _repActivatedKey = 'nbd_rep_activated_' + user.uid;
      // If this is a newly invited rep, activate their membership
      if (window._userClaims.companyId && window._userClaims.companyId !== user.uid
          && !localStorage.getItem(_repActivatedKey)) {
        try {
          const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
          const fns = getFunctions();
          await connectEmulatorsIfLocal({ functions: fns }); // no-op in prod
          const fn = httpsCallable(fns, 'activateInvitedRep');
          // Bounded: this await gates loadLeads and the greeting, so a hung
          // callable left the whole dashboard on its empty first paint. On
          // timeout the flag stays unset and the next load retries.
          await Promise.race([
            fn({}),
            new Promise((_, rej) => setTimeout(() => rej(new Error('activateInvitedRep timed out')), 8000)),
          ]);
          localStorage.setItem(_repActivatedKey, '1');
        } catch (e) { console.warn('Rep activation skipped:', e.message); }
      }
      // PILLAR1 Phase 3 (de-GCIP'd invites): a user with no team claim — or
      // only the Phase-2 solo default (companyId == uid) — may have a pending
      // team invite. onRepSignup (the blocking trigger that was meant to stamp
      // these claims at signup) can never deploy without GCIP, so the claim
      // happens here on first dashboard load instead. One callable per uid+
      // device; the flag is NOT set on transient failures (e.g. email not
      // verified yet) so it retries on the next load.
      else if ((!window._userClaims.companyId || window._userClaims.companyId === user.uid)
          && !localStorage.getItem(_inviteCheckedKey)) {
        try {
          const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
          const fns = getFunctions();
          await connectEmulatorsIfLocal({ functions: fns }); // no-op in prod
          const fn = httpsCallable(fns, 'claimInvite');
          const res = await Promise.race([
            fn({}),
            new Promise((_, rej) => setTimeout(() => rej(new Error('claimInvite timed out')), 8000)),
          ]);
          const out = (res && res.data) || {};
          // An account that owns its own company must choose to join
          // (claimInvite answers confirm_required; invite-join.js asks). Not
          // awaited: the prompt waits on a person, and this await gates
          // loadLeads. The flag stays unset, so a later load asks again unless
          // the company was declined (remembered on userSettings, which
          // survives sign-out).
          if (out.reason === 'confirm_required') {
            if (window.NBDInviteJoin) {
              window.NBDInviteJoin.handle(out, (p) => fn(p), { fromBoot: true }).then(async (outcome) => {
                if (outcome !== 'joined') return;
                await user.getIdToken(true);
                localStorage.setItem(_inviteCheckedKey, '1');
                localStorage.setItem(_repActivatedKey, '1');
                window.location.reload();
              }).catch((e) => console.warn('Invite prompt failed:', e && e.message));
            }
          } else if (out.claimed) {
            // Claims changed → the whole tenant scope changed. Refresh the
            // token FIRST, then set the flags + reboot so every scoped query
            // re-runs under the team's companyId. Setting the flags before the
            // refresh stranded the rep in stale solo scope for up to ~1h if
            // getIdToken(true) rejected (transient network) — the flags
            // blocked the re-check while the old token still resolved billing/
            // leads under their own uid. Order it so a refresh failure leaves
            // the flags unset and the next load retries.
            await user.getIdToken(true);
            localStorage.setItem(_inviteCheckedKey, '1');
            localStorage.setItem(_repActivatedKey, '1');
            window.location.reload();
            return;
          }
          // 'no_invite' is only terminal for ESTABLISHED accounts. A fresh
          // signup often precedes the owner's invite by minutes or days
          // (the invite email even says "sign in if you already have one"),
          // so young accounts keep re-checking — one cheap rate-limited
          // callable per dashboard load for at most 14 days.
          const _createdMs = Date.parse((user.metadata && user.metadata.creationTime) || '') || 0;
          const _youngAccount = _createdMs && (Date.now() - _createdMs) < 14 * 24 * 3600 * 1000;
          if ((out.reason === 'no_invite' && _youngAccount) || out.reason === 'invite_expired'
              || out.reason === 'ambiguous_invite' || out.reason === 'confirm_required') {
            // leave the flag unset — re-check next load. invite_expired
            // stays non-terminal so a Re-send (fresh 30-day invite) is
            // picked up without any manual recovery step. ambiguous_invite
            // (two companies invited this email) stays non-terminal so the
            // claim self-heals once an owner cancels the stray invite —
            // otherwise the rep would be stuck behind the terminal flag.
          } else {
            // Other terminal answers (already member / own company) or a
            // mature account with no invite: stop asking for this uid+device.
            localStorage.setItem(_inviteCheckedKey, '1');
          }
        } catch (e) {
          // failed-precondition = invite exists but email unverified — leave
          // the flag unset so we re-check after they verify. This used to be
          // console-only: the rep saw a normal solo dashboard and reasonably
          // believed they'd joined, while the owner's roster row sat at
          // 'invited' forever (gauntlet gap). Now it renders a persistent
          // banner with a resend-verification action.
          console.warn('Invite check skipped:', e.message);
          if (/verify your email/i.test(String(e.message || '')) && !document.getElementById('nbdVerifyBanner')) {
            const banner = document.createElement('div');
            banner.id = 'nbdVerifyBanner';
            banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:var(--z-overlay,10000);background:var(--orange,#BD5728);color:#fff;padding:10px 16px;font-size:13px;display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;';
            const msg = document.createElement('span');
            msg.textContent = 'You have a pending team invite — verify ' + (user.email || 'your email') + ' to join.';
            const resend = document.createElement('button');
            resend.textContent = 'Resend verification email';
            resend.style.cssText = 'background:#fff;color:#1A3057;border:none;border-radius:6px;padding:6px 12px;font-weight:700;font-size:12px;cursor:pointer;';
            resend.addEventListener('click', async () => {
              resend.disabled = true; resend.textContent = 'Sending…';
              try {
                const { sendEmailVerification } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js');
                await sendEmailVerification(user);
                resend.textContent = 'Sent — check your inbox';
              } catch (err) {
                resend.disabled = false;
                resend.textContent = 'Retry sending';
                console.warn('resend verification failed:', err.message);
              }
            });
            const dismiss = document.createElement('button');
            dismiss.textContent = '✕';
            dismiss.setAttribute('aria-label', 'Dismiss');
            dismiss.style.cssText = 'background:none;border:none;color:#fff;cursor:pointer;font-size:14px;';
            dismiss.addEventListener('click', () => banner.remove());
            banner.append(msg, resend, dismiss);
            document.body.appendChild(banner);
          }
        }
      }
      // Login-time provisioning self-heal (first-run audit 2026-07-28, root
      // cause). A signup whose createCompany never landed (offline, App Check
      // hiccup, rate limit) carries the per-uid nbd_provision_pending_ marker
      // set by provisioning-retry.js — finish the job here on dashboard load.
      // Marker-gated so the invitee flow is untouched: ?invite=1 signups
      // never call createCompany and never set the marker, and the claimInvite
      // semantics above (incl. the 14-day young-account re-check) are
      // unchanged. createCompany is idempotent and refuses invited reps
      // server-side. Reload fires ONLY after a successful provision + marker
      // removal (no reload loop); a failure keeps the marker so the next
      // dashboard load retries.
      const _provisionPendingKey = 'nbd_provision_pending_' + user.uid;
      if (!window._userClaims.companyId && window._userClaims.owner !== true
          && localStorage.getItem(_provisionPendingKey)) {
        try {
          const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
          const fns = getFunctions();
          await connectEmulatorsIfLocal({ functions: fns }); // no-op in prod
          const fn = httpsCallable(fns, 'createCompany');
          // Server requires a 2-80 char name; a 1-char email local-part
          // (j@x.com) would reject as invalid-argument — fall back to the
          // full email (mirrors the onboarding skip() fallback).
          const healName = (user.displayName || (user.email || '').split('@')[0] || '').trim();
          await fn({ name: (healName.length >= 2 ? healName : (user.email || 'New Contractor')).slice(0, 80) });
          // Claims changed → refresh the token FIRST, then clear the marker
          // and reboot so every scoped query re-runs under the new companyId
          // (same ordering rationale as the claimed-invite path above).
          await user.getIdToken(true);
          localStorage.removeItem(_provisionPendingKey);
          window.location.reload();
          return;
        } catch (e) {
          // Keep the marker — the next dashboard load retries.
          console.warn('Provisioning heal skipped (will retry next load):', e && e.message);
        }
      }
    } catch (e) { window._userClaims = {}; }
    // Notification permission is now opt-in via a user gesture.
    // A page-load requestPermission() call is auto-denied by modern
    // browsers and poisons the permission state. See crm.js enable-
    // notifications click handler.
    // Pick up pending warranty cert from customer page.
    // warranty-cert.js is lazy-loaded via ScriptLoader when the Docs
    // view activates, so wait for that before invoking the wizard.
    try {
      const pending = sessionStorage.getItem('_pendingCert');
      if (pending) {
        sessionStorage.removeItem('_pendingCert');
        const data = JSON.parse(pending);
        setTimeout(() => {
          goTo('docs');
          const preload = (window.ScriptLoader && window.ScriptLoader.preloadForView)
            ? window.ScriptLoader.preloadForView('docs')
            : Promise.resolve();
          preload.then(() => {
            if (typeof openWarrantyCertWizard === 'function') {
              openWarrantyCertWizard(data);
            } else {
              // Previously this silently returned — users clicked "Generate
              // Cert" from customer.html and landed on Docs with nothing
              // happening. Surface the failure so we at least know the
              // handoff dropped the data.
              console.warn('[dashboard] _pendingCert pickup failed: openWarrantyCertWizard not loaded');
              if (typeof showToast === 'function') showToast('Warranty wizard failed to load — open Docs → Warranty manually', 'warning');
            }
          }).catch(err => {
            console.warn('[dashboard] _pendingCert preload failed:', err);
            if (typeof showToast === 'function') showToast('Warranty wizard couldn\u2019t load — try again from Docs', 'error');
          });
        }, 800);
      }
    } catch(e) {
      // JSON.parse failure means the sessionStorage payload is corrupt —
      // clear it so we don't keep retrying with bad data on every reload.
      console.warn('[dashboard] _pendingCert parse failed, clearing:', e);
      try { sessionStorage.removeItem('_pendingCert'); } catch(_) {}
    }
    // If subscription check failed open, show a subtle non-blocking warning
    if (window._subscription?._failOpen) {
      setTimeout(() => showToast('Subscription check had a hiccup - you are in. Refreshing will resolve it.', 'warning'), 2000);
    }
    // New-user onboarding is handled by OnboardingTour (js/onboarding-tour.js).
    // The legacy modal-based flow that lived here referenced DOM that was
    // never built (#onboardingModal, #onbStep1, etc.); call removed.
    const name = user.displayName || user.email.split('@')[0];
    // Template-hydration safety: the greetings and the
    // settings inputs live inside <template id="tpl-view-*"> mounts
    // that don't exist in the live DOM until dashboard-main.js
    // hydrates the view. Without these guards, the first null throw
    // aborts the rest of onAuthStateChanged → loadLeads is never
    // called → kanban shows zero cards.
    //
    // 2026-09-25 (phone audit): that comment used to promise "view-hydrate
    // code re-populates these from window._user" — nothing did, so the
    // Dashboard greeting kept its hard-coded default whenever its template was
    // cloned after this ran. The greetings are now [data-user-greeting] slots
    // painted by _paintUserGreetings (dashboard-ui.js), which _hydrateViewTemplate
    // also calls on every clone; the settings inputs are re-read by
    // _loadProfileSettings when the Profile tab opens.
    const _setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    const _setVal  = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    _setText('userName',     name);
    _setText('userAvatar',   name[0].toUpperCase());
    if (typeof window._paintUserGreetings === 'function') window._paintUserGreetings();
    _setVal('settingsName',  user.displayName || '');
    _setVal('settingsEmail', user.email || '');
    // Cal.com username — pull from the user profile if set and prime
    // the shareable link preview so reps can copy the URL straight
    // into an SMS / email. Also stash on window._currentRep so
    // sendBookingSMS / sendFollowUpSMS (crm.js) + homeowner portal
    // resolve the right URL without a second Firestore read.
    try {
      const usrSnap = await getDoc(doc(db, 'users', user.uid));
      if (usrSnap.exists()) {
        const d = usrSnap.data();
        const calVal = d.calcomUsername || '';
        window._currentRep = Object.assign({}, window._currentRep || {}, {
          uid: user.uid,
          displayName: d.displayName || user.displayName || '',
          email: d.email || user.email || '',
          calcomUsername: calVal,
          calcomEventSlug: d.calcomEventSlug || 'roof-inspection'
        });
        // The Schedule view's Cal.com box loaded at DOMContentLoaded, before
        // this profile existed — repaint it now from the account setting.
        if (calVal && typeof window.loadCalSettings === 'function') { try { window.loadCalSettings(); } catch (_) {} }
        // Same for Settings → Profile when a refresh landed on #/settings: the
        // tab's own load ran before sign-in, so saved Phone / review link /
        // Company showed blank and the next Save wrote the blanks back.
        if (document.getElementById('settingsPhone')) {
          setTimeout(() => {
            const reg = window.__NBD_CALL_REGISTRY;
            if (reg && typeof reg._loadProfileSettings === 'function') { try { reg._loadProfileSettings(); } catch (_) {} }
          }, 0);
        }
        const calEl = document.getElementById('settingsCalcom');
        const calPrev = document.getElementById('settingsCalcomPreview');
        if (calEl) calEl.value = calVal;
        if (calPrev) {
          if (calVal) {
            const url = 'https://cal.com/' + calVal;
            calPrev.textContent = url;
            calPrev.href = url;
            calPrev.style.display = '';
          } else {
            calPrev.style.display = 'none';
          }
        }
        // Wave 16: prime the digest opt-in checkbox from the user
        // doc. Default ON when the field is missing or true; only OFF
        // when explicitly false.
        const digestEl = document.getElementById('settingsWeeklyDigest');
        if (digestEl) digestEl.checked = d.weeklyDigestEnabled !== false;
        // Wave 28: prime the dormant-nudge opt-in checkbox using the
        // same default-ON semantics.
        const dormantEl = document.getElementById('settingsDormantNudge');
        if (dormantEl) dormantEl.checked = d.dormantNudgeEnabled !== false;
        // Review-nudge opt-in (2026-07-14), same default-ON semantics.
        const revNudgeEl = document.getElementById('settingsReviewNudge');
        if (revNudgeEl) revNudgeEl.checked = d.reviewNudgeEnabled !== false;
      }
    } catch (e) { /* silent — rules may deny during bootstrap */ }
    // Seed demo data first if this is the demo account, then load normally
    if(typeof maybeSeedDemoData==='function') await maybeSeedDemoData(user).catch(()=>{});
    // Build dynamic kanban columns before loading leads
    const savedView = localStorage.getItem('nbd_kanban_view') || 'insurance';
    if (typeof window.buildKanbanColumns === 'function') {
      window.buildKanbanColumns(savedView);
      // Sync view switcher button active state
      document.querySelectorAll('.kview-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === savedView);
      });
    }
    loadLeads().then(() => {
      // Stage B slice 1 (2026-07-04): flag-gated SHADOW comparison of a
      // server-side count() against the just-fetched cache. Fire-and-forget,
      // logs only, no UI reads it — see docs/pro/js/server-aggregates.js.
      try {
        if (window.NBDServerAggregates) window.NBDServerAggregates.shadowCompare();
      } catch (_) { /* shadow must never affect boot */ }
      // ── Wave 120: stuck-skeleton reliability fix ────────────────────
      // Previously this gated render on `window._leads?.length` — which
      // meant any user with ZERO leads (brand-new accounts, or leads
      // filtered out by stage/sales_rep) would NEVER escape the kanban
      // skeleton. Combined with the 3-step nested setTimeout, that
      // produced the ~50% "stuck on loading" bug.
      //
      // New behaviour:
      //   1. Render path no longer requires leads to exist — an empty
      //      array is a valid state (we render the empty kanban cleanly).
      //   2. Retry loop polls every 250ms for up to 30s. Each tick
      //      checks if renderLeads is now available; first hit wins.
      //   3. If the 30s window elapses without renderLeads arriving,
      //      we fall back to a plain "Couldn't load — refresh" state
      //      instead of leaving the user on a forever-skeleton.
      function _attemptRender() {
        if (typeof renderLeads !== 'function') return false;
        // If the kanban container has no stage columns, rebuild them
        // before rendering — otherwise renderLeads has no `#kbody-{key}`
        // targets and silently produces an empty board (the symptom
        // observed in the W158 "blank kanban" report). buildKanbanColumns
        // can no-op if it ran earlier and was wiped, or if the auth-time
        // call at line ~609 raced the DOM.
        const _board = document.getElementById('kanbanBoard');
        if (_board && !_board.querySelector('.kanban-col') &&
            typeof window.buildKanbanColumns === 'function') {
          try { window.buildKanbanColumns(window._currentViewKey || 'insurance'); }
          catch (e) { console.warn('[render-retry] buildKanbanColumns threw:', e.message); }
        }
        // window._leads may be undefined if loadLeads catch-path never
        // assigned it; coalesce to [] so renderLeads never throws.
        const leads = Array.isArray(window._leads) ? window._leads : [];
        // Home widgets first, in their own try: they only read window._leads,
        // and a throw from any kanban call below used to skip them, leaving
        // Home on its pre-data $0 / "0 leads" paint while Pipeline had data.
        try { if (window.NBDWidgets) window.NBDWidgets.render(); }
        catch (e) { console.warn('[render-retry] NBDWidgets.render threw:', e.message); }
        try {
          renderLeads(leads);
          if (typeof restoreCrmSearch === 'function') restoreCrmSearch();
          if (typeof updatePipeline === 'function') updatePipeline(leads);
          if (typeof calculateWeeklyStats === 'function') calculateWeeklyStats();
          if (typeof refreshTrashBadge === 'function') refreshTrashBadge();
          if (typeof renderKPIRow === 'function') renderKPIRow();
        } catch (renderErr) {
          console.warn('[render-retry] renderLeads threw:', renderErr.message);
          return false;
        }
        return true;
      }
      function _renderFallback() {
        const board = document.getElementById('kanbanBoard');
        if (!board) return;
        board.innerHTML =
          '<div class="dbx-gri11-p40px20px-tacenter">' +
          '<div class="dbx-fs32px-mb12px">⚠️</div>' +
          '<div class="dbx-fs16px-w600-mb8px">Couldn\'t finish loading the CRM.</div>' +
          '<div class="dbx-fs13px-mb18px">Your data is safe — this is usually a slow connection during cold start.</div>' +
          '<button type="button" data-action="reload" class="dbx-p10px22px-r6px-bgorange">Reload</button>' +
          '</div>';
      }
      // First attempt fires synchronously after loadLeads resolves.
      if (_attemptRender()) return;
      // W134 fix: track the poll handle on window so a second
      // loadLeads call (e.g. visibilitychange or auth re-fire) can
      // clearInterval it instead of double-running the poll. Same
      // class of bug as the W120 _loadLeadsRetryTimer fix, but for
      // the 30s render-retry interval.
      if (window._renderRetryHandle) {
        try { clearInterval(window._renderRetryHandle); } catch (_) {}
      }
      let _ticks = 0;
      const _MAX_TICKS = 120;
      window._renderRetryHandle = setInterval(() => {
        _ticks++;
        if (_attemptRender()) {
          clearInterval(window._renderRetryHandle);
          window._renderRetryHandle = null;
          return;
        }
        if (_ticks >= _MAX_TICKS) {
          clearInterval(window._renderRetryHandle);
          window._renderRetryHandle = null;
          console.error('[render-retry] renderLeads never became available after 30s');
          _renderFallback();
        }
      }, 250);
    });
    loadEstimates(); loadPins(); loadZones();
    // B3: wire the live estimates listener so signature webhook
    // updates + V2 saves land in the UI without a reload.
    if (typeof window._subscribeEstimates === 'function') {
      try { window._subscribeEstimates(); } catch (e) { /* degrade to one-shot */ }
    }
    // D9 was: register device fingerprint so new-device sign-ins fire
    // a Slack alert. The backend `registerDeviceFingerprint` callable
    // was never deployed, so every dashboard load produced a 401 (no
    // AppCheck) and later a CORS-failed preflight in the console.
    // Removed the call until the function actually ships — silent
    // failure was masking the dead path.

    // Check for query params (edit=xxx or tasks=xxx from customer.html)
    // Every branch below cleans the query off the URL with replaceState. It
    // KEEPS location.hash: goTo() has just written '#/<view>', and the
    // hashchange that write queued fires AFTER a synchronous replaceState —
    // dropping the hash made dashboard-main.js's hashchange handler read ''
    // and route to Home over the view the link asked for (?settings=billing,
    // Stripe Connect's return URL, landed on Home; so did ?edit= / ?tasks= /
    // ?templates= behind their modals). CRM sweep R13, 2026-09-28.
    const urlParams = new URLSearchParams(window.location.search);
    const editId = urlParams.get('edit');
    const tasksId = urlParams.get('tasks');
    
    const estParam = urlParams.get('est');
    const leadParam = urlParams.get('lead');
    const templatesParam = urlParams.get('templates');

    if (templatesParam && leadParam) {
      // ── JOB TEMPLATES for a lead, from customer.html's Estimates panel
      //    "Job Templates" button (2026-09-17, Jo: "job templates are way
      //    faster than an estimate"). Checked BEFORE the estParam||leadParam
      //    branch below so a plain ?lead= doesn't swallow this one.
      //    openJobTemplatesForLead already owns its own lazy-load-then-run
      //    (loads the 'estimates' bundle if JobTemplatesUI isn't ready) —
      //    the SAME entry point the dashboard's own card-detail "Template
      //    Quote" button calls, not a second picker.
      setTimeout(() => {
        goTo('crm');
        if (typeof window.openJobTemplatesForLead === 'function') {
          window.openJobTemplatesForLead(leadParam);
        } else if (typeof showToast === 'function') {
          showToast('Templates are still loading — try again in a moment', 'warning');
        }
        window.history.replaceState({}, '', '/pro/dashboard.html' + window.location.hash);
      }, 500);
    } else if (estParam && editId) {
      // ── REOPEN SAVED ESTIMATE from customer page ──
      // URL: ?edit=LEAD_ID&est=ESTIMATE_ID  (edit here = lead context, est = estimate to reopen)
      (async () => {
        // Wait for estimates to actually finish loading
        try { await loadEstimates(); } catch(e) { console.warn('loadEstimates retry:', e); }
        goTo('est');
        // If the estimate isn't in the loaded list, try fetching it directly
        const tryReopen = async (attempts) => {
          let estimates = window._estimates || [];
          let found = estimates.find(e => e.id === estParam);
          if (!found && attempts < 15) {
            await new Promise(r => setTimeout(r, 400));
            estimates = window._estimates || [];
            found = estimates.find(e => e.id === estParam);
            if (!found) return tryReopen(attempts + 1);
          }
          if (!found) {
            // Last resort: fetch the single estimate directly from Firestore
            try {
              const snap = await getDoc(doc(db, 'estimates', estParam));
              if (snap.exists()) {
                found = { id: snap.id, ...snap.data() };
                window._estimates = [...(window._estimates || []), found];
              }
            } catch(e) { console.error('Direct estimate fetch failed:', e); }
          }
          if (typeof viewEstimate === 'function') {
            viewEstimate(estParam);
            window._estLinkedLeadId = editId;
            const titleEl = document.getElementById('estBuilderTitle');
            if (titleEl) titleEl.textContent = 'Edit Estimate';
          } else {
            showToast('Estimate builder not ready — try again', 'error');
          }
        };
        await tryReopen(0);
        window.history.replaceState({}, '', '/pro/dashboard.html' + window.location.hash);
      })();
    } else if (editId && !estParam) {
      // ── EDIT LEAD in CRM ──
      // Wait for the lead cache: editLead() looks the id up in window._leads,
      // and at a fixed 500 ms it usually wasn't loaded yet — editLead fell
      // through to a BLANK new-lead form, which saves a duplicate (R14,
      // 2026-09-28; the customer page's "Open full editor" lands here).
      window.history.replaceState({}, '', '/pro/dashboard.html' + window.location.hash);
      (async () => {
        for (let i = 0; i < 40 && window._leadsLoaded !== true; i++) {
          await new Promise(r => setTimeout(r, 250));
        }
        goTo('crm');
        if ((window._leads || []).some(l => l && l.id === editId)) {
          editLead(editId);
        } else {
          window.location.href = '/pro/customer.html?id=' + encodeURIComponent(editId);
        }
      })();
    } else if (leadDeepLinkId(urlParams)) {
      // ── OPEN A LEAD: ?tab=crm&lead=ID (notification bell, tasks) and
      //    ?tab=leads&leadId=ID (push notifications). CRM sweep R13,
      //    2026-09-28: `tab` was never read, so the bell's links fell into
      //    the NEW-ESTIMATE branch below — tapping "New referral" / "Document
      //    signed" opened a blank estimate for that lead — and push's
      //    `leadId` matched nothing and landed on Home. Waits for the lead
      //    cache (the card modal reads window._leads); a lead not in this
      //    rep's cache opens on its customer page instead of doing nothing.
      const _openId = leadDeepLinkId(urlParams);
      window.history.replaceState({}, '', '/pro/dashboard.html' + window.location.hash);
      (async () => {
        for (let i = 0; i < 40 && window._leadsLoaded !== true; i++) {
          await new Promise(r => setTimeout(r, 250));
        }
        goTo('crm');
        const _hit = (window._leads || []).some(l => l && l.id === _openId);
        if (_hit && typeof window.openCardDetailModal === 'function') {
          window.openCardDetailModal(_openId);
        } else {
          window.location.href = '/pro/customer.html?id=' + encodeURIComponent(_openId);
        }
      })();
    } else if (estParam || leadParam) {
      // ── NEW ESTIMATE (optionally pre-filled from lead) ──
      (async () => {
        try { await loadEstimates(); } catch(e) { console.warn('loadEstimates failed:', e); }
        goTo('est');
        if (estParam && !editId) {
          // Reopen estimate by ID (direct link, no lead context)
          let found = (window._estimates || []).find(e => e.id === estParam);
          if (!found) {
            try {
              const snap = await getDoc(doc(db, 'estimates', estParam));
              if (snap.exists()) {
                found = { id: snap.id, ...snap.data() };
                window._estimates = [...(window._estimates || []), found];
              }
            } catch(e) { console.error('Direct estimate fetch failed:', e); }
          }
          if (typeof viewEstimate === 'function') viewEstimate(estParam);
        } else {
          // Rock 2 PR 5 (Jo, 2026-07-04: V2-only for NEW estimates): the
          // deep-link new-estimate path opens the V2 builder directly —
          // { leadId } drives V2's own prefillFromLead + save linkage, so
          // the old classic-DOM pre-fill (estAddr/estOwner + updateEstCalc)
          // is gone with it. startNewEstimate() remains the fallback and
          // itself routes to V2 (or the picker if V2 failed to load).
          if (typeof window.openEstimateV2Builder === 'function') {
            window.openEstimateV2Builder(leadParam ? { leadId: leadParam } : {});
          } else if (typeof startNewEstimate === 'function') {
            if (leadParam) window._estLinkedLeadId = leadParam;
            startNewEstimate();
          }
        }
        window.history.replaceState({}, '', '/pro/dashboard.html' + window.location.hash);
      })();
    } else if (tasksId) {
      // Wait for leads to load, then open task modal
      setTimeout(() => {
        goTo('crm');
        openTaskModal(tasksId);
        // Clean URL
        window.history.replaceState({}, '', '/pro/dashboard.html' + window.location.hash);
      }, 500);
    } else if (urlParams.get('settings')) {
      // ── DEEP LINK: Settings → <tab> ──
      // Stripe Connect onboarding returns here
      // (/pro/dashboard?settings=billing&connect=return|refresh) because
      // /pro/settings does NOT exist — Settings is a view inside this page, and
      // a Stripe return URL pointing at a non-existent page 404'd for every
      // user once already (stripe.js:947).
      //
      // ALLOWLIST, not passthrough: switchSettingsTab() hides EVERY .stab-panel
      // and then shows one only `if (panel)`, so an unrecognised value from the
      // URL leaves the user staring at a blank Settings screen.
      const SETTINGS_TABS = ['access', 'ai-texting', 'appearance', 'billing', 'company',
        'company-profile', 'daily', 'estimates', 'help', 'notifications', 'pipelines',
        'profile', 'team'];
      const wantTab = String(urlParams.get('settings') || '').toLowerCase();
      const connectParam = String(urlParams.get('connect') || '').toLowerCase();
      if (connectParam === 'return' || connectParam === 'refresh') {
        // Force a live re-read on arrival: Stripe redirects the moment the
        // owner finishes, and the account.updated webhook may not have landed
        // yet, so the stored mirror is legitimately stale for a few seconds.
        // Consumed by the billing-tab hook in dashboard-connect-tab.js — a flag
        // rather than a call, because that script lives in a lazily hydrated
        // template and may not have executed yet.
        window._nbdConnectPendingRefresh = true;
        // 'refresh' is Stripe telling us the AccountLink expired before it was
        // used. Deliberately NOT auto-minting a replacement: an auto-redirect
        // that keeps failing is an infinite bounce. Show it and let them click.
        if (connectParam === 'refresh') window._nbdConnectLinkExpired = true;
      }
      if (SETTINGS_TABS.indexOf(wantTab) !== -1) {
        (async () => {
          if (typeof goTo === 'function') goTo('settings', { id: wantTab });
          // The settings view is LAZILY hydrated, so switchSettingsTab and the
          // panel may both be missing for a while. Poll instead of guessing a
          // delay — openSettingsTab()'s fixed 200ms is exactly that race.
          for (let i = 0; i < 40; i++) {
            if (typeof window.switchSettingsTab === 'function'
                && document.getElementById('stab-panel-' + wantTab)) break;
            await new Promise((r) => setTimeout(r, 150));
          }
          if (typeof window.switchSettingsTab === 'function'
              && document.getElementById('stab-panel-' + wantTab)) {
            window.switchSettingsTab(wantTab);
          }
          window.history.replaceState({}, '', '/pro/dashboard.html' + window.location.hash);
        })();
      }
    }
  });

  window._auth    = auth;
  window._db      = db;
  window._storage = storage;
  window._signOut = () => {
    // Clear per-uid invite/activation flags on the way out so the NEXT
    // account on this device gets its own fresh invite check (shared office
    // computers were permanently bricked by the old device-global flag).
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && (k.indexOf('nbd_invite_checked') === 0 || k.indexOf('nbd_rep_activated') === 0)) {
          localStorage.removeItem(k);
        }
      }
    } catch (_) { /* storage unavailable — sign out anyway */ }
    // Queued offline texts (homeowner numbers + message text in IndexedDB,
    // docs/pro/js/sms-outbox.js) never outlive the session that wrote them.
    // Bounded inside purgeSmsOutbox (2s), so sign-out cannot hang on it.
    const purgeSms = (window.NBDAuth && typeof window.NBDAuth.purgeSmsOutbox === 'function')
      ? window.NBDAuth.purgeSmsOutbox()
      : Promise.resolve(window.NBDSmsOutbox && typeof window.NBDSmsOutbox.purgeAll === 'function'
        ? window.NBDSmsOutbox.purgeAll() : false);
    return Promise.resolve(purgeSms).catch(() => false)
      .then(() => signOut(auth))
      .then(() => window.location.replace("/pro/login.html"));
  };

  // (Removed the window.activateMyAccount console helper: it setDoc'd directly
  // to /subscriptions, which is admin-SDK-write-only — `allow write: if false`
  // — so the client write could never succeed. Real activation flows through
  // the Stripe webhook / validateAccessCode callable, which use the admin SDK.)

  // ── GLOBAL KEYBOARD SHORTCUTS ──
  // isHotkeyEnabled is defined inside an IIFE in dashboard-hotkey-toggles.js
  // (a classic script), so this ES module can't see it — a bare reference
  // threw `ReferenceError: isHotkeyEnabled is not defined` on EVERY keydown,
  // which both spammed the console and broke all the shortcuts below. Mirror
  // the same localStorage flag here so the module is self-sufficient and
  // stays in sync with the toggle settings.
  const isHotkeyEnabled = (id) => {
    try { return localStorage.getItem('nbd_hk_disabled_' + id) !== '1'; }
    catch (_) { return true; }
  };

  document.addEventListener('keydown', (e) => {
    // Don't trigger if user is typing in any form control. SELECT was
    // missing: typing a letter to pick a Stage option fired "e" → New
    // Estimate. contentEditable covers the rich-text notes.
    const t = e.target || {};
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable) return;
    // A modifier chord is the browser's or another handler's (Ctrl+N, Cmd+E…).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // No single-letter hotkeys while a modal/dialog is open (2026-09-30: "e"
    // opened New Estimate over the Edit Lead modal). Esc stays live — the
    // modal's own handler closes it.
    if (e.key !== 'Escape' && window.nbdModal && typeof window.nbdModal.anyOpen === 'function' && window.nbdModal.anyOpen()) return;

    // ESC - Close modals. leadModal / cardDetailModal / taskModal are now
    // nbdModal-managed on dashboard.html, so nbdModal's own Esc handler closes
    // the top one (restoring focus) and fires its onClose cleanup — running
    // these unconditionally here would double-fire. On a page without
    // nbd-modal.js (none since the legacy twin retired 2026-09-02) this stays the sole Esc path; each closeXxx runs the
    // classList fallback + reset directly.
    if (e.key === 'Escape' && !window.nbdModal) {
      closeLeadModal();
      closeCardDetailModal();
      closeTaskModal();
    }
    
    // Shift+N - Quick Add Lead (one-tap / GPS-first flow) — checked
    // BEFORE the bare 'N' branch so the shifted variant doesn't
    // accidentally fire both handlers.
    if ((e.key === 'N') && e.shiftKey && isHotkeyEnabled('hk_n')) {
      e.preventDefault();
      if (typeof window.openQuickAddLead === 'function') window.openQuickAddLead();
      return;
    }

    // N - New lead (toggleable)
    if ((e.key === 'n' || e.key === 'N') && !e.shiftKey && isHotkeyEnabled('hk_n')) {
      goTo('crm');
      setTimeout(() => openLeadModal(), 100);
    }

    // E - New estimate (toggleable)
    if ((e.key === 'e' || e.key === 'E') && isHotkeyEnabled('hk_e')) {
      goTo('est');
      setTimeout(() => startNewEstimate(), 100);
    }

    // / - Focus search (toggleable)
    if (e.key === '/' && isHotkeyEnabled('hk_slash')) {
      e.preventDefault();
      const searchInput = document.querySelector('#crmSearch, #mapSearch');
      if (searchInput) searchInput.focus();
    }

    // ? - Show shortcuts help (toggleable)
    if (e.key === '?' && isHotkeyEnabled('hk_help')) {
      showShortcutsHelp();
    }
  });
  
  function showShortcutsHelp() {
    const helpHTML = `
      <div class="dbx-posfixed-top0-lef0" data-action="removeSelf">
        <div class="dbx-bgs-bd1pxsolid-r12px" data-action="stopProp">
          <div class="dbx-fs18px-w700-mb16px">⌨️ Keyboard Shortcuts</div>
          <div class="dbx-dgrid-gtcauto1fr-gap8px16px">
            <kbd class="kbd-input">N</kbd>
            <span>New Lead</span>
            <kbd class="kbd-input">E</kbd>
            <span>New Estimate</span>
            <kbd class="kbd-input">/</kbd>
            <span>Focus Search</span>
            <kbd class="kbd-input">ESC</kbd>
            <span>Close Modals</span>
            <kbd class="kbd-input">?</kbd>
            <span>Show This Help</span>
          </div>
          <button class="btn btn-orange dbx-wd100-mt16px-jccenter" data-action="removeClosest" data-target="div[style*=fixed]">Got it</button>
        </div>
      </div>
    `;
    document.body.insertAdjacentHTML('beforeend', helpHTML);
  }

  // ── RECENTLY VIEWED CUSTOMERS ──
  function toggleRecentDropdown() {
    const dropdown = document.getElementById('recentDropdown');
    const isOpen = dropdown.style.display === 'block';
    dropdown.style.display = isOpen ? 'none' : 'block';
    if (!isOpen) renderRecentCustomers();
  }
  
  function renderRecentCustomers() {
    try {
      const recent = JSON.parse(localStorage.getItem('nbd_recent_customers') || '[]');
      const list = document.getElementById('recentList');
      if (!recent.length) {
        list.innerHTML = '<div class="dbx-fs12px-cm-p8px">No recent customers</div>';
        return;
      }
      const leads = window._leads || [];
      const e = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));

      // Wave 53: inline reshare buttons. Last priority-ish surface
      // to get the share trio. Recent dropdown rows already navigate
      // to the customer page on click; this just adds 📞/💬/📧
      // affordances next to the name so the rep can re-text/recall
      // a customer they were just looking at without opening the
      // detail page first.
      function _recentActions(lead) {
        const phoneDigits = String(lead.phone || '').replace(/\D+/g, '');
        const email = String(lead.email || '').trim();
        const buttons = [];
        if (phoneDigits) {
          buttons.push(
            `<a class="rc-action dbx-dflex-aicenter-jccenter" href="tel:${e(phoneDigits)}" title="Call ${e(lead.phone)}"
              
               data-action="stopProp"
             >📞</a>`);
          buttons.push(
            `<button class="rc-action dbx-dflex-aicenter-jccenter-2" type="button" data-action="sms" data-lead-id="${e(lead.id)}" title="Text portal link to ${e(lead.phone)}"
              
             >💬</button>`);
        }
        if (email) {
          buttons.push(
            `<button class="rc-action dbx-dflex-aicenter-jccenter-3" type="button" data-action="email" data-lead-id="${e(lead.id)}" title="Email portal link to ${e(email)}"
              
             >📧</button>`);
        }
        // Wave 67: portal preview action — finishes the recent-
        // dropdown action row to match cmd+K (W63) and the home
        // widgets (W64/W65/W66). Mirrors W63 like W62 mirrored
        // W61. Always available, no contact gate. Sits between
        // share trio and snooze so the row reads "talk / look /
        // set aside" everywhere it appears.
        if (window.PortalLinkHelpers
            && typeof window.PortalLinkHelpers.previewForLead === 'function') {
          buttons.push(
            `<button class="rc-action dbx-dflex-aicenter-jccenter-4" type="button" data-action="preview" data-lead-id="${e(lead.id)}" title="Preview the portal — see what the customer will see"
              
             >🔍</button>`);
        }
        // Wave 62: state-aware snooze/unsnooze button on the recent
        // dropdown. Mirrors W61 cmd+K — power-user workflow where
        // the rep just looked at a customer and wants to push it
        // out for follow-up without opening the detail page.
        // Always available (snoozing doesn't need contact info),
        // so it shows even when phone/email are missing.
        if (window.LeadSnooze) {
          const isSnoozed = window.LeadSnooze.isSnoozed(lead);
          if (isSnoozed) {
            const untilLabel = window.LeadSnooze.formatSnoozeLabel(window.LeadSnooze.snoozedUntilDate(lead));
            buttons.push(
              `<button class="rc-action dbx-dflex-aicenter-jccenter-5" type="button" data-action="unsnooze" data-lead-id="${e(lead.id)}" title="Unsnooze (was until ${e(untilLabel)})"
                
               >⏰</button>`);
          } else {
            buttons.push(
              `<button class="rc-action dbx-dflex-aicenter-jccenter-6" type="button" data-action="snooze" data-lead-id="${e(lead.id)}" title="Snooze this lead"
                
               >💤</button>`);
          }
        }
        if (buttons.length === 0) return '';
        return `<div class="dbx-dflex-gap3px-fle0">${buttons.join('')}</div>`;
      }

      list.innerHTML = recent.map(r => {
        const lead = leads.find(l => l.id === r.id);
        if (!lead) return '';
        const name = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Unknown';
        const shortAddr = (lead.address || '').split(',')[0];
        return `
          <div class="nbd-recent-row dbx-dflex-gap8px-aicenter" data-id="${e(r.id)}">
            <div class="dbx-fx1-minw0">
              <div class="dbx-w600-mb2px-whinowrap">${e(name)}</div>
              <div class="dbx-fs10px-cm-whinowrap">${e(shortAddr)}</div>
            </div>
            ${_recentActions(lead)}
          </div>
        `;
      }).filter(Boolean).join('');

      // Wave 53: action button handlers fire BEFORE row click so
      // stopPropagation takes effect. SMS + Email delegate to
      // PortalLinkHelpers (W42) for the prefilled-body flow + W44
      // lastSharedAt tracking. Call uses native <a href="tel:...">.
      list.querySelectorAll('.rc-action[data-action]').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const action = btn.getAttribute('data-action');
          const id = btn.getAttribute('data-lead-id');
          if (!id) return;
          const lead = (window._leads || []).find(l => l && l.id === id);
          if (!lead) return;
          let closeDropdown = true;
          if (action === 'sms' && window.PortalLinkHelpers) {
            window.PortalLinkHelpers.smsForLead(lead);
          } else if (action === 'email' && window.PortalLinkHelpers) {
            window.PortalLinkHelpers.emailForLead(lead);
          } else if (action === 'preview' && window.PortalLinkHelpers) {
            // Wave 67: preview opens the W56 iframe modal on top
            // of the dropdown. Modal z-index 99997 > dropdown
            // 9999. Don't close the dropdown — when the rep
            // dismisses the preview they keep their recent-
            // customers context, useful for chaining previews
            // across the four most-recent leads.
            window.PortalLinkHelpers.previewForLead(lead);
            closeDropdown = false;
          } else if (action === 'snooze' && window.LeadSnooze) {
            // Wave 62: opens the W35 preset modal on top of the
            // dropdown. Modal z-index (99996) > dropdown z-index
            // (9999) so it stacks correctly. Don't close the
            // dropdown — when the rep dismisses the modal they
            // can keep glancing at recent customers.
            const fullName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
            window.LeadSnooze.prompt(lead.id, fullName);
            closeDropdown = false;
          } else if (action === 'unsnooze' && window.LeadSnooze) {
            // Wave 62: unsnooze fires immediately + re-renders the
            // dropdown so the button flips 💤/⏰ in place. Keep
            // the dropdown open so the rep can verify + keep
            // working.
            window.LeadSnooze.promptUnsnooze(lead.id).then(() => {
              renderRecentCustomers();
            });
            closeDropdown = false;
          }
          // Close the dropdown only on share actions so the rep
          // sees the SMS composer / mail client without the
          // dropdown obscuring. Snooze/unsnooze stay open.
          if (closeDropdown) {
            const dd = document.getElementById('recentDropdown');
            if (dd) dd.style.display = 'none';
          }
        });
      });

      list.querySelectorAll('.nbd-recent-row').forEach(row => {
        row.addEventListener('click', (ev) => {
          // Defensive: a click on a child element of an action
          // button should already have been stopped by the action
          // handler, but guard anyway.
          if (ev.target && ev.target.closest && ev.target.closest('.rc-action')) return;
          const id = row.dataset.id;
          if (!id) return;
          // Reuse Wave 11 handoff for instant render.
          try {
            if (typeof window._stashLeadForCustomerPage === 'function') {
              window._stashLeadForCustomerPage(id);
            }
          } catch (_) {}
          window.location.href = '/pro/customer.html?id=' + encodeURIComponent(id);
        });
      });
    } catch (err) {
      console.error('Failed to render recent:', err);
    }
  }
  
  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('recentDropdown');
    const btn = document.getElementById('recentBtn');
    if (dropdown && !dropdown.contains(e.target) && !btn.contains(e.target)) {
      dropdown.style.display = 'none';
    }
  });

  // STAGES, _dragId, _filteredLeads now declared at top-level (lines 91-93)

  // ── LEADS ──────────────────────────────────────
  async function loadLeads() {
    // Wave 120: clear any stale retry timer from a prior loadLeads
    // call. Without this, a setTimeout-scheduled retry from the
    // previous load could fire mid-way through a fresh load — the
    // retry would see stale window._user state from before bfcache
    // restore + auth resettling, hit the 1-second wait + bail path
    // below, and call renderLeads([]) right when fresh data was
    // about to render. (One source of the 50% reload-stuck bug.)
    if (window._loadLeadsRetryTimer) {
      try { clearTimeout(window._loadLeadsRetryTimer); } catch (_) {}
      window._loadLeadsRetryTimer = null;
    }
    // Wave 134: same cleanup for the W120 30s render-retry interval —
    // a stale poll from a prior loadLeads call could call renderLeads
    // mid-fresh-load and stomp on the new data with old leads. The
    // .then() block below installs a fresh _renderRetryHandle on
    // every call; clearing here ensures only one is ever live.
    if (window._renderRetryHandle) {
      try { clearInterval(window._renderRetryHandle); } catch (_) {}
      window._renderRetryHandle = null;
    }
    // Update health indicator to loading
    const healthBadge = document.getElementById('crmHealthBadge');
    if (healthBadge) {
      healthBadge.className = 'health-indicator loading';
      healthBadge.title = 'Loading CRM data...';
    }
    
    // Show skeleton loading state (replaces old spinner)
    const kanbanBoard = document.getElementById('kanbanBoard');
    if (kanbanBoard && !window._leads?.length) {
      showKanbanSkeleton();
    }
    
    try {
      const uid = window._user?.uid;
      
      if (!uid) { 
        console.warn('⚠️ loadLeads: No user ID — waiting for auth...');
        // Wait a bit for auth to settle
        await new Promise(resolve => setTimeout(resolve, 1000));
        const retryUid = window._user?.uid;
        if (!retryUid) {
          console.error('❌ loadLeads: Still no user after retry — auth failure');
          // Not just `_leads = []`: a still-true _leadsLoaded would present
          // the emptied cache as a confirmed-empty book to the guards.
          _resetLeadsCache();
          // Update health indicator to error
          if (healthBadge) {
            healthBadge.className = 'health-indicator error';
            healthBadge.title = 'CRM Error: Authentication failed';
          }
          // Restore kanban empty state
          if (typeof renderLeads === 'function') renderLeads([]);
          return;
        }
      }
      
      const finalUid = window._user?.uid;
      // A load for a different account than the one the cache holds (the
      // switch reached window._user before this module's auth callback):
      // drop the old book NOW, so nothing reads it as this account's while
      // the read below is in flight — or keeps it as a "stale cache" if the
      // read fails.
      if (_leadsCacheUid !== null && _leadsCacheUid !== finalUid) _resetLeadsCache();

      // Wave 187: PRE-FLIGHT connection cycle on FIRST loadLeads per
      // page load. The Firestore SDK's WebSocket/long-poll often
      // survives same-tab reloads in a "warm-but-dead" state — the
      // browser killed the underlying socket during navigation but
      // the SDK doesn't notice until getDocs hits the 10s timeout
      // below. Doing the cycle BEFORE the first query (instead of
      // reactively in the catch path) eliminates the "every other
      // reload shows skeleton" alternation pattern: the user used to
      // hit 50% stuck loads because each successful load "warmed" a
      // socket that the next reload would inherit and then hang on.
      //
      // Cost: ~250-400ms added to cold start, ONCE per tab (gated by
      // window._firestoreCycledOnBoot so subsequent loadLeads calls
      // — view switches, manual refreshes — skip the cycle).
      //
      // Escape hatch: append ?nocycle=1 to the URL to skip this if it
      // ever regresses on a specific browser. Mirror of ?nosw=1.
      const _nocycle = new URLSearchParams(location.search).has('nocycle');
      if (!window._firestoreCycledOnBoot && !_nocycle) {
        window._firestoreCycledOnBoot = true;
        try {
          await disableNetwork(db);
          await new Promise(r => setTimeout(r, 100));
          await enableNetwork(db);
        } catch (preflightErr) {
          console.warn('Pre-flight network cycle failed (non-fatal):', preflightErr.message);
        }
      }

      // 10s timeout — getDocs on a stale iOS bfcache connection hangs
      // forever instead of rejecting, leaving healthBadge stuck on the
      // 'loading' class (yellow dot in connection-status-btn).
      //
      // On failure (despite the pre-flight cycle above), cycle the
      // Firestore connection AGAIN and retry once. The pre-flight covers
      // the common reload-stale case; this reactive cycle remains the
      // belt-and-suspenders fallback for transient iOS background-tab
      // throttling and other in-session connection deaths.
      // Audit #4 / 5.1 — Stage A: paginate the FETCH instead of pulling
      // every lead in one unbounded getDocs. A rep with thousands of leads
      // used to load them all in a single query that (a) risked the 10s
      // timeout on a big book and (b) spiked memory. We now page by
      // document id (limit + startAfter) and concatenate. The RESULT is
      // identical — same docs, just assembled from N round-trips — so the
      // `snap.docs` consumer below and all 68 window._leads readers are
      // unchanged. Each page keeps the original 10s timeout. Stage B
      // (later) moves KPI counts/search server-side to actually bound reads.
      //
      // Page by __name__ (documentId) ordering, which is implicit and
      // needs no composite index for a single equality filter. Verified in
      // the emulator: identical set, no dupes/gaps across pages.
      const _PAGE = 500;
      // Team pipeline visibility (2026-07): company_admin/manager/viewer
      // fetch the whole tenant book — firestore.rules now allows the
      // company-scoped read (the /expenses pattern) and this single
      // equality filter is what makes the list query provable under it.
      // Provisioned SOLO owners are company_admin with companyId == uid,
      // so their company fetch returns the identical set as the old
      // userId fetch (every lead carries companyId per the Rock 3
      // backfill). sales_rep keeps the own-leads fetch — the Wave-110
      // privacy decision (teammates' data must never reach their
      // browser) — as do legacy claim-less accounts and platform-admin
      // (role 'admin') sessions. Same implicit __name__ paging either
      // way — no composite index needed.
      const _claims = window._userClaims || {};
      const _teamReader = ['company_admin', 'manager', 'viewer'].includes(_claims.role || '')
        && !!_claims.companyId;
      // Team readers fetch the tenant book AND their own leads. The second
      // scope is load-bearing for claimed-in members (review finding,
      // 2026-07-06): their pre-invite solo leads carry companyId == their
      // OWN uid, not the tenant's — a company-only fetch made a member's
      // entire pre-invite book vanish from the dashboard. It also keeps an
      // owner's legacy no-companyId docs visible. For provisioned solo
      // owners both scopes return the same set and the dedupe collapses it.
      const _leadScopes = _teamReader && _claims.companyId !== finalUid
        ? [where('companyId', '==', _claims.companyId), where('userId', '==', finalUid)]
        : [_teamReader ? where('companyId', '==', _claims.companyId) : where('userId', '==', finalUid)];
      const _runQuery = async () => {
        const allDocs = [];
        const seenIds = new Set();
        for (const scope of _leadScopes) {
          let cursor = null;
          // Hard ceiling so a pathological/corrupt cursor can't loop forever:
          // 200 pages × 500 = 100k leads, far beyond any real rep.
          for (let page = 0; page < 200; page++) {
            let q = query(collection(db,'leads'), scope, limit(_PAGE));
            if (cursor) q = query(collection(db,'leads'), scope, startAfter(cursor), limit(_PAGE));
            const pageSnap = await Promise.race([
              getDocs(q),
              new Promise((_, reject) => setTimeout(() => reject(new Error('getDocs(leads) timeout after 10000ms')), 10000))
            ]);
            for (const d of pageSnap.docs) {
              if (!seenIds.has(d.id)) { seenIds.add(d.id); allDocs.push(d); }
            }
            if (pageSnap.size < _PAGE) break;   // last (partial) page
            cursor = pageSnap.docs[pageSnap.docs.length - 1];
          }
        }
        // Stage B shadow: stash the PRE-filter page-union total so
        // server-aggregates.js can compare count() against the same
        // population (window._leads itself is post-filter).
        window._leadsRawCount = allDocs.length;
        // Return a snapshot-shaped object so downstream code is untouched.
        return { docs: allDocs, size: allDocs.length };
      };

      let snap;
      try {
        snap = await _runQuery();
      } catch (firstErr) {
        console.warn('loadLeads first attempt failed, cycling connection and retrying:', firstErr.message);
        if (healthBadge) {
          healthBadge.className = 'health-indicator loading';
          healthBadge.title = 'Reconnecting…';
        }
        try {
          await disableNetwork(db);
          await new Promise(r => setTimeout(r, 250));
          await enableNetwork(db);
        } catch (cycleErr) {
          console.warn('Network cycle failed (non-fatal):', cycleErr.message);
        }
        // Second attempt — if this fails the outer catch handles it.
        snap = await _runQuery();
        console.log('✅ loadLeads recovered on retry');
      }

      // The signed-in account changed (or signed out) while this read was in
      // flight: these are the PREVIOUS account's leads. Committing them would
      // re-arm _leadsLoaded over the wrong book, so drop the result — the new
      // account's own loadLeads() fills the cache.
      if (finalUid !== _sessionUid) {
        console.warn('loadLeads: account changed mid-load — discarding the stale result');
        return;
      }

      // Wave 110: when the rep has the 'sales_rep' role claim,
      // narrow the in-memory cache to ONLY leads they own. Was
      // previously a render-time filter in crm.js — meaning all
      // leads still lived in window._leads and any rep with
      // DevTools could read teammates' data. Firestore rules
      // already restrict writes (a rep can't mutate someone else's
      // lead), but the client-side cache leaked the read shape.
      // Sourcing the filter at hydration so the data isn't in the
      // browser at all.
      const _userRole = (window._userClaims && window._userClaims.role) || null;
      window._leads = snap.docs
        .map(d => ({id:d.id,...d.data()}))
        .filter(l => !l.deleted)
        .filter(l => l._test !== true) // NEW-C5: never surface a stray testFirestoreRules() probe doc as a real lead
        .filter(l => {
          if (_userRole !== 'sales_rep') return true;
          // sales_rep: keep only own leads
          return l.userId === (window._user && window._user.uid);
        })
        .sort((a,b) => {
          const ta = a.createdAt?.toDate?.()?.getTime() || 0;
          const tb = b.createdAt?.toDate?.()?.getTime() || 0;
          return tb - ta;
        });
      // Normalize stages: convert legacy display names → internal keys
      window._leads.forEach(l => {
        if (l.stage) l._stageKey = normalizeStage(l.stage);
        else l._stageKey = S.NEW;
        // Use the TENANT-AWARE window.stageRole (applyPipelineConfig upgrades
        // it to the custom pipeline's roleOf) — NOT the module-local built-in
        // stageRole, which only knows built-in keys and returns 'active' for
        // every custom/freeform stage. loadLeads re-runs on every save/refresh,
        // so the built-in was clobbering custom won/lost leads back to 'active'
        // each time, silently dropping them out of role-keyed revenue/close-rate
        // KPIs (money-dashboard isWon, analytics-kpi win-rate) for the session.
        l._stageRole = (window.stageRole || stageRole)(l._stageKey);
      });
      // Flag so downstream modules (Ask Joe Proactive morning briefing,
      // widgets, etc.) know the lead cache is hydrated vs still pending.
      window._leadsLoaded = true;
      _leadsCacheUid = finalUid;
      console.log('✅ loadLeads: Processed', window._leads.length, 'leads after filtering deleted');
      // Multi-job (2026-09-30, stage 2a): the customers' jobs, in ONE
      // collection-group query (jobs-store.js), then a re-render so a
      // customer with a second open job shows a second card. Never blocks
      // the first paint; a failed load leaves one card per customer (as before).
      if (window.NBDJobs && typeof window.NBDJobs.load === 'function') {
        window.NBDJobs.load()
          .then(() => {
            if (typeof renderLeads === 'function') renderLeads(window._leads, window._filteredLeads);
            // The money tiles count every job (jobs-store recordsFor): repaint
            // them now the jobs are in — never while someone is typing in one.
            const grid = document.getElementById('widgetGrid');
            const typing = grid && grid.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
            try { if (typeof window.renderKPIRow === 'function') window.renderKPIRow(); } catch (_) {}
            try { if (!typing && typeof window.renderWidgetHome === 'function') window.renderWidgetHome(); } catch (_) {}
          })
          .catch((e) => console.warn('[loadLeads] jobs load failed — one card per customer:', e && (e.code || e.message)));
      }
      // Wave 13: tell the notification bell + any other listeners that
      // the lead cache just refreshed so they can recompute counts.
      try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'leads' } })); } catch (_) {}
      
      // Update health indicator to healthy
      if (healthBadge) {
        healthBadge.className = 'health-indicator healthy';
        healthBadge.title = `CRM Connected • ${window._leads.length} leads loaded`;
      }
      
    } catch(e) {
      console.error('❌ loadLeads failed:', e.message, e.code, e);
      console.error('Full error:', e);
      // W159 P1: stash last error so the on-page mobile diagnostic
      // banner can show it without devtools.
      try {
        window._loadLeadsLastError = {
          message: String(e && e.message || e),
          code: String(e && e.code || ''),
          name: String(e && e.name || ''),
          ts: Date.now()
        };
      } catch (_) {}
      // Only zero out the cache on FIRST load. On subsequent failures
      // (e.g. transient iOS connection drop after the user saved a
      // lead), keep the existing cache so just-saved leads added via
      // optimistic update don't vanish from the kanban while we're
      // offline. The next successful loadLeads — or the visibilitychange
      // handler — will overwrite with fresh data. The same holds for a
      // FIRST load that fails after a save: _optimisticInsertLead claimed the
      // cache for this account (without marking it loaded), so keep its cards.
      if (!window._leadsLoaded && _leadsCacheUid === null) {
        window._leads = [];
      } else {
        console.warn('loadLeads kept stale cache of ' + (window._leads?.length || 0) + ' leads (transient failure)');
      }

      // Update health indicator to error
      if (healthBadge) {
        healthBadge.className = 'health-indicator error';
        const errorMsg = e.code === 'permission-denied'
          ? 'CRM Error: Firestore rules blocking access'
          : `CRM Error: ${e.message}`;
        healthBadge.title = errorMsg;
      }

      // iOS Safari frequently fails its first Firestore read on cold
      // start (app coming back from background, network re-handshake).
      // The user used to fix this by spam open/close. Now we auto-retry
      // a few times with exponential backoff before giving up — only on
      // the FIRST cold-start failure (when nothing was ever loaded), and
      // only for transient error codes. Permission-denied is permanent
      // and we let the user see it normally.
      const isTransient = e.code === 'unavailable'
        || e.code === 'deadline-exceeded'
        || e.code === 'cancelled'
        || e.code === 'internal'
        || /network|offline|timeout|failed to fetch/i.test(e.message || '');
      if (!window._leadsLoaded && isTransient) {
        const attempt = (window._loadLeadsRetryAttempt = (window._loadLeadsRetryAttempt || 0) + 1);
        if (attempt <= 3) {
          const delay = 600 * attempt; // 600ms, 1.2s, 1.8s
          console.warn(`loadLeads cold-start retry ${attempt}/3 in ${delay}ms`);
          // Wave 120: track the timer handle so a fresh loadLeads call
          // can cancel a stale retry before scheduling new work.
          window._loadLeadsRetryTimer = setTimeout(() => {
            window._loadLeadsRetryTimer = null;
            // Bail if a successful load happened in the meantime.
            if (window._leadsLoaded) return;
            try { loadLeads(); } catch (_) {}
          }, delay);
        } else {
          // ── Slow-loop fallback ──
          // The 3 fast retries already failed. Instead of giving up
          // entirely, keep trying at a 15s cadence for another 5 attempts
          // (~75s recovery window). This catches the iOS Safari case
          // where the network handshake takes longer than the fast-retry
          // budget allows. The diag banner shows the live state.
          const slowAttempt = (window._loadLeadsSlowAttempt = (window._loadLeadsSlowAttempt || 0) + 1);
          if (slowAttempt <= 5) {
            const slowDelay = 15000;
            window._loadLeadsNextRetryAt = Date.now() + slowDelay;
            console.warn(`loadLeads slow retry ${slowAttempt}/5 in ${slowDelay}ms`);
            window._loadLeadsRetryTimer = setTimeout(() => {
              window._loadLeadsRetryTimer = null;
              window._loadLeadsNextRetryAt = null;
              if (window._leadsLoaded) return;
              try { loadLeads(); } catch (_) {}
            }, slowDelay);
          } else {
            console.error('loadLeads exhausted slow-loop retries — user can tap the diag banner to retry');
            window._loadLeadsExhausted = true;
            window._loadLeadsNextRetryAt = null;
          }
        }
      }
    }
    // Reset retry counters on success so the next transient failure gets
    // the full retry budget again. Without this, a single recovered load
    // followed by a later failure would skip straight to slow-loop / give-up.
    if (window._leadsLoaded) {
      window._loadLeadsRetryAttempt = 0;
      window._loadLeadsSlowAttempt = 0;
      window._loadLeadsExhausted = false;
      window._loadLeadsNextRetryAt = null;
    }
    // Load photo cache for thumbnails. Team visibility (2026-07): company
    // readers ALSO pull the tenant's stamped photos so teammate kanban
    // cards get thumbnails — the loadLeads two-scope shape. The own-userId
    // query always runs (it covers the caller's pre-backfill photos that
    // have no companyId yet — the same "pre-invite docs vanish" class the
    // #863 review caught on leads); the company query only adds docs that
    // migration 004 / post-2026-07 clients stamped. Deduped by doc id.
    try {
      const _puid = window._user?.uid;
      const _pClaims = window._userClaims || {};
      const _pScopes = [];
      if (_puid) {
        _pScopes.push(where('userId','==',_puid));
        if (['company_admin','manager','viewer'].includes(_pClaims.role || '') && _pClaims.companyId) {
          _pScopes.push(where('companyId','==',_pClaims.companyId));
        }
      }
      window._photoCache = {};
      const _pSeen = new Set();
      for (const _scope of _pScopes) {
        const psnap = await getDocs(query(collection(db,'photos'), _scope));
        psnap.docs.forEach(d => {
          if (_pSeen.has(d.id)) return;
          _pSeen.add(d.id);
          const p = {id:d.id,...d.data()};
          if(!window._photoCache[p.leadId]) window._photoCache[p.leadId] = [];
          window._photoCache[p.leadId].push(p);
        });
      }
    } catch(e) { window._photoCache = {}; }
    // Wave 120: replace one-shot 500ms retry with a polling loop so
    // a slow crm.js load doesn't leave the kanban skeleton up forever.
    // The OUTER loadLeads().then() block at line ~611 also runs a
    // 30s polling loop; this inner block is the fast path when crm.js
    // is already there. We coalesce window._leads to [] so a transient
    // failure that left it undefined doesn't render-throw.
    function _innerRender() {
      if (typeof renderLeads !== 'function') return false;
      // Same kanban-column rebuild guard as the outer _attemptRender —
      // see the W158 comment there. Without this the fast-path render
      // can paint into a board that has no columns.
      const _board = document.getElementById('kanbanBoard');
      if (_board && !_board.querySelector('.kanban-col') &&
          typeof window.buildKanbanColumns === 'function') {
        try { window.buildKanbanColumns(window._currentViewKey || 'insurance'); }
        catch (e) { console.warn('[loadLeads] buildKanbanColumns threw:', e.message); }
      }
      const leads = Array.isArray(window._leads) ? window._leads : [];
      try {
        renderLeads(leads);
        if (typeof restoreCrmSearch === 'function') restoreCrmSearch();
        if (typeof updatePipeline === 'function') updatePipeline(leads);
        if (typeof calculateWeeklyStats === 'function') calculateWeeklyStats();
        return true;
      } catch (e) {
        console.warn('[loadLeads] inner render threw:', e.message);
        return false;
      }
    }
    if (!_innerRender()) {
      console.warn('⚠️ renderLeads not loaded yet — outer poll loop will pick it up');
      // The outer loadLeads().then() block runs its own 30s poll loop.
      // Don't double-poll here — single source of truth for the retry.
    }
    // Fire follow-up notifications after leads are fresh — over OWN leads
    // only (team visibility, 2026-07): staff caches now hold the whole
    // tenant book, and running the nag engines over teammates' leads
    // spammed every staff member with follow-ups they can't act on (the
    // review engine even tried lead writes the rules deny). Actionability
    // follows ownership, so the engines keep the pre-team scope.
    const _ownLeads = () => (window._leads || []).filter(l =>
      !l.userId || l.userId === (window._user && window._user.uid));
    setTimeout(() => checkAndCreateFollowUpNotifications(_ownLeads()), 1200);
    // Needs-field auto-notifier — flags leads stuck without a required
    // field for their current stage so the rep doesn't discover it
    // mid-drag. Delayed slightly past the follow-up check so the
    // existing-keys dedupe (which reads window._notifications) sees
    // any fresh follow-ups before deciding what to add on top.
    setTimeout(() => {
      if (typeof window.checkAndCreateNeedsFieldNotifications === 'function') {
        window.checkAndCreateNeedsFieldNotifications(_ownLeads());
      }
    }, 2400);
    // Render KPI analytics row on home dashboard (with margin card)
    if (typeof renderKPIRow === 'function') setTimeout(() => {
      renderKPIRow();
      // Inject margin KPI card if profit data exists
      if (window.ProfitTracker?.getMarginKPICard) {
        const kpiGrid = document.querySelector('#kpiRow .kpi-grid');
        if (kpiGrid) {
          const marginHTML = window.ProfitTracker.getMarginKPICard();
          if (marginHTML) kpiGrid.insertAdjacentHTML('beforeend', marginHTML);
        }
      }
      // Append the D2D "Doors Verified" data-quality card (async, self-fetching;
      // only renders when the rep has knocks). Registry-only — analytics-kpi.js
      // registers it (Globals Tranche 3 T3-C); a missing entry is a no-op.
      const _nbdReg = window.__NBD_CALL_REGISTRY;
      if (_nbdReg && typeof _nbdReg.renderDoorsVerifiedCard === 'function') _nbdReg.renderDoorsVerifiedCard();
    }, 200);
    // Auto-check for review requests on recently closed jobs
    if (window.ReviewEngine?.checkAutoReviews) setTimeout(() => window.ReviewEngine.checkAutoReviews(), 3000);
    // Keep the Customers map layer in step with the book (no-op unless the
    // overlay is currently on — maps-customers.js guards on overlayState).
    if (typeof window.refreshCustomersLayer === 'function') window.refreshCustomersLayer();
    // Supplier pricing: feature was removed; archive folder deleted with
    // the 2026-04-23 dead-code cleanup.
  }
  window._loadLeads = loadLeads;
  // Alias without the underscore prefix so external callers (refresh
  // button in connection-status-btn.js, Cypress/Playwright scripts,
  // browser-console debugging) can use the documented short name too.
  // The underscore convention is the older internal style; we keep
  // both pointing at the same function so neither breaks.
  window.loadLeads = loadLeads;
  // DO NOT call loadLeads() here at module parse time.
  // Auth hasn't fired yet so window._user is null → loadLeads
  // gets no uid → returns empty → kanban shows 0 cards.
  // loadLeads() is called at line 486 INSIDE onAuthStateChanged
  // where the user is guaranteed to exist.

  // ══════════════════════════════════════════════════════════════
  // DEBUG CONSOLE HELPERS
  // ══════════════════════════════════════════════════════════════
  function toggleDebugConsole() {
    const console = document.getElementById('debugConsole');
    const toggle = document.getElementById('debugConsoleToggle');
    if (!console || !toggle) return;
    
    const isHidden = console.style.display === 'none';
    console.style.display = isHidden ? 'block' : 'none';
    toggle.textContent = isHidden ? '▼' : '▶';
    
    if (isHidden) {
      // Populate with recent console logs
      const content = document.getElementById('debugConsoleContent');
      if (content && window._debugLogs) {
        content.textContent = window._debugLogs.join('\n');
      }
    }
  }
  
  function retryLoadLeads() {
    const healthBadge = document.getElementById('crmHealthBadge');
    if (healthBadge) {
      healthBadge.className = 'health-indicator loading';
      healthBadge.title = 'Retrying...';
    }
    showToast('Retrying CRM data load...', 'info');
    loadLeads();
  }
  
  function copyDebugInfo() {
    const debugText = [
      '═══ NBD PRO CRM DEBUG INFO ═══',
      '',
      'User:',
      `  Email: ${window._user?.email || 'Not authenticated'}`,
      `  UID: ${window._user?.uid || 'None'}`,
      '',
      'Database:',
      `  Connected: ${window.db ? 'Yes' : 'No'}`,
      `  Auth State: ${window._auth?.currentUser?.uid || 'No current user'}`,
      '',
      'CRM State:',
      `  Leads in Memory: ${window._leads?.length || 0}`,
      `  Filtered Leads: ${window._filteredLeads?.length || 'N/A'}`,
      '',
      'Console Logs:',
      ...(window._debugLogs || ['No debug logs captured']),
      '',
      '═══ END DEBUG INFO ═══'
    ].join('\n');
    
    navigator.clipboard.writeText(debugText).then(() => {
      showToast('✅ Debug info copied to clipboard', 'success');
    }).catch(() => {
      showToast('❌ Failed to copy — check console', 'error');
      console.log(debugText);
    });
  }
  
  // Test Firestore Rules
  async function testFirestoreRules() {
    if (!window._user?.uid) {
      showToast('❌ Not authenticated — sign in first', 'error');
      return;
    }
    
    showToast('Testing Firestore rules...', 'info');
    const results = [];
    const uid = window._user.uid;
    
    try {
      // Test 1: Read own leads
      results.push('Testing: Read leads collection...');
      const leadsSnap = await getDocs(query(collection(db,'leads'), where('userId','==',uid)));
      results.push(`✅ Read leads: Success (${leadsSnap.docs.length} docs)`);
      
      // Test 2: Write to leads
      results.push('Testing: Write to leads collection...');
      const testDoc = await addDoc(collection(db, 'leads'), {
        userId: uid,
        companyId: window._userClaims?.companyId || uid,
        firstName: 'Test',
        lastName: 'Rule Check',
        address: 'Rule Validator',
        stage: 'New',
        createdAt: serverTimestamp(),
        deleted: false,
        _test: true
      });
      results.push(`✅ Write leads: Success (id: ${testDoc.id})`);
      
      // Test 3: Delete test doc
      results.push('Testing: Delete from leads collection...');
      await deleteDoc(doc(db, 'leads', testDoc.id));
      results.push(`✅ Delete leads: Success`);
      
      // Test 4: Read estimates
      results.push('Testing: Read estimates collection...');
      const estSnap = await getDocs(query(collection(db,'estimates'), where('userId','==',uid)));
      results.push(`✅ Read estimates: Success (${estSnap.docs.length} docs)`);
      
      // Test 5: Read photos
      results.push('Testing: Read photos collection...');
      const photoSnap = await getDocs(query(collection(db,'photos'), where('userId','==',uid)));
      results.push(`✅ Read photos: Success (${photoSnap.docs.length} docs)`);
      
      results.push('');
      results.push('🎉 All tests passed! Firestore rules are correctly configured.');
      
    } catch(e) {
      results.push('');
      results.push(`❌ Test failed: ${e.message}`);
      results.push(`Error code: ${e.code || 'unknown'}`);
      
      if (e.code === 'permission-denied') {
        results.push('');
        results.push('⚠️ PERMISSION DENIED — Your Firestore rules are blocking access.');
        results.push('Fix: Deploy rules from FIRESTORE_RULES.txt in repo');
        results.push('Firebase Console → Firestore → Rules tab');
      }
    }
    
    // Show results in diagnostic panel
    const detailsEl = document.getElementById('crmDiagnosticDetails');
    if (detailsEl) {
      detailsEl.textContent = results.join('\n');
    }
    
    // Also log to console
    console.log('═══ FIRESTORE RULES TEST ═══');
    results.forEach(r => console.log(r));
    console.log('═══ END TEST ═══');
    
    const lastLine = results[results.length - 1];
    if (lastLine.includes('passed')) {
      showToast('✅ Firestore rules test passed!', 'success');
    } else {
      showToast('❌ Firestore rules test failed — check diagnostic panel', 'error');
    }
  }
  
  // Capture console logs for debug panel.
  //
  // CRITICAL: stringify must NOT throw — Firebase's WebChannel error
  // objects are circular (Y.i = Ka with src closing the cycle), and
  // a previous version of this block called JSON.stringify directly
  // on every object arg. On any transient Firestore network blip the
  // SDK would call console.warn(circularError), our override would
  // throw inside JSON.stringify, that uncaught throw killed Firebase's
  // internal logger, the logger threw on every retry, and Firestore
  // wedged into the offline state with no recovery. Symptoms in the
  // field: "Failed to get document because the client is offline",
  // kanban never loads, theme-achievements + mobile-nav-customizer
  // both error out, all originating from the same JSON.stringify trap.
  //
  // _safeStringify uses a circular-ref-aware replacer that returns
  // '[Circular]' instead of throwing, plus a try/catch as last-resort
  // so even getter-throwing objects can't kill the override.
  if (!window._debugLogs) {
    window._debugLogs = [];
    const originalLog   = console.log;
    const originalWarn  = console.warn;
    const originalError = console.error;

    function _safeStringify(value) {
      try {
        const seen = new WeakSet();
        return JSON.stringify(value, function (_key, v) {
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
          }
          if (typeof v === 'function') return '[Function]';
          return v;
        });
      } catch (_e) {
        try { return String(value); } catch (_e2) { return '[Unstringifiable]'; }
      }
    }

    function _formatArgs(args) {
      return args.map(a => typeof a === 'object' && a !== null ? _safeStringify(a) : String(a)).join(' ');
    }

    console.log = function(...args) {
      const msg = _formatArgs(args);
      if (msg.includes('loadLeads') || msg.includes('CRM') || msg.includes('🔍') || msg.includes('✅') || msg.includes('❌')) {
        window._debugLogs.push(`[LOG] ${msg}`);
        if (window._debugLogs.length > 50) window._debugLogs.shift(); // Keep last 50
      }
      originalLog.apply(console, args);
    };

    console.warn = function(...args) {
      const msg = _formatArgs(args);
      if (msg.includes('loadLeads') || msg.includes('CRM') || msg.includes('⚠️')) {
        window._debugLogs.push(`[WARN] ${msg}`);
        if (window._debugLogs.length > 50) window._debugLogs.shift();
      }
      originalWarn.apply(console, args);
    };

    console.error = function(...args) {
      const msg = _formatArgs(args);
      if (msg.includes('loadLeads') || msg.includes('CRM') || msg.includes('❌')) {
        window._debugLogs.push(`[ERROR] ${msg}`);
        if (window._debugLogs.length > 50) window._debugLogs.shift();
      }
      originalError.apply(console, args);
    };
  }

  function calculateWeeklyStats() {
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    
    // New leads this week
    const newLeads = (window._leads || []).filter(l => {
      if (!l.createdAt) return false;
      const createdDate = l.createdAt.toDate ? l.createdAt.toDate() : new Date(l.createdAt);
      return createdDate >= weekAgo;
    });
    
    // Estimates this week
    const newEstimates = (window._estimates || []).filter(e => {
      if (!e.createdAt) return false;
      const createdDate = e.createdAt.toDate ? e.createdAt.toDate() : new Date(e.createdAt);
      return createdDate >= weekAgo;
    });
    
    // Revenue added this week (from new leads)
    const weekRevenue = newLeads.reduce((sum, l) => sum + parseFloat(l.jobValue || 0), 0);
    
    // Tasks completed this week
    let weekTasks = 0;
    Object.values(window._taskCache || {}).forEach(tasks => {
      tasks.forEach(t => {
        if (!t.done || !t.completedAt) return;
        const completedDate = t.completedAt.toDate ? t.completedAt.toDate() : new Date(t.completedAt);
        if (completedDate >= weekAgo) weekTasks++;
      });
    });
    
    // Update DOM — all 4 stat tiles live inside the lazy-hydrated
    // tpl-view-home template. When loadLeads resolves before the home
    // view has been mounted (cold-load race), getElementById returns
    // null and the first textContent assignment throws — the catch in
    // _attemptRender then kicks in a 30s retry loop that the user sees
    // as a half-loaded / blank dashboard. Guard each access so the
    // function is a clean no-op when its targets don't exist yet, and
    // the retry only fires when there's actually something to do.
    const _setStat = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    _setStat('weekNewLeads',  newLeads.length);
    _setStat('weekEstimates', newEstimates.length);
    _setStat('weekRevenue',   '$' + weekRevenue.toLocaleString());
    _setStat('weekTasks',     weekTasks);
  }

  // Optimistic kanban refresh helper — push the just-saved lead into
  // window._leads in-memory and re-render so the card appears IMMEDIATELY,
  // before loadLeads makes its round-trip. On iOS where loadLeads can
  // fail intermittently, this is the difference between "I saved a lead
  // and I see it on the kanban" and "I saved a lead and nothing happened".
  function _optimisticInsertLead(leadId, data) {
    if (!leadId) return;
    // Never mix accounts: a cache still holding another account's book is
    // dropped before this account's card goes in.
    const _uid = window._user?.uid || null;
    if (_leadsCacheUid !== null && _leadsCacheUid !== _uid) _resetLeadsCache();
    window._leads = window._leads || [];
    // If we already have this lead (edit case), replace it; otherwise prepend.
    const idx = window._leads.findIndex(l => l.id === leadId);
    // saveLead OMITS the `stage` key when #lStage had no option matching the
    // lead's stage — writing '' would destroy it (see crm-leads.js). Firestore
    // leaves the stored stage alone on such a partial update, so mirror that
    // here: without this the spread drops the field and the card silently
    // re-buckets into New until loadLeads round-trips.
    const _stage = data.stage != null ? data.stage : window._leads[idx]?.stage;
    const merged = {
      id: leadId,
      ...data,
      stage: _stage,
      userId: window._user?.uid,
      createdAt: window._leads[idx]?.createdAt || new Date(),
      _stageKey: typeof normalizeStage === 'function'
        ? normalizeStage(_stage)
        : (_stage || 'new')
    };
    merged._stageRole = stageRole(merged._stageKey);
    if (idx >= 0) window._leads[idx] = merged;
    else window._leads.unshift(merged);
    // Claim the cache for this account so a failed loadLeads() keeps this
    // card (its catch path only zeroes an UNOWNED cache) — but do NOT set
    // _leadsLoaded. That flag means "a server load of this book succeeded";
    // setting it here after a failed first load made one saved lead read as
    // the whole confirmed book (loadSampleData / runImport / canDeleteStage
    // all passed) and stopped the cold-start retry, whose timer bails once
    // the flag is true, so the real book never loaded.
    _leadsCacheUid = _uid;
    if (typeof renderLeads === 'function') {
      try { renderLeads(window._leads); } catch (_) {}
    }
  }

  window._saveLead = async (data) => {
    try {
      const editId = data.id;
      delete data.id;

      // LITE (trial-expired free): hard-cap new leads at the free-tier
      // allowance. 10 matches PLAN_LIMITS.free.leads in
      // functions/billing.js / billing-gate.js PLANS.free (was a stale
      // hardcoded 25 that predated the canonical tier table). Note this
      // counts TOTAL loaded leads, not this-cycle usage — the server
      // meter (trackUsage) is the real monthly gate; this is a blunt
      // client-side stop for lapsed trials.
      if ((!editId || editId.startsWith('d-')) && window._userPlan === 'lite') {
        const currentCount = (window._leads || []).length;
        if (currentCount >= 10) {
          showToast('Free plan lead limit reached. Upgrade to Starter ($99/mo) for more leads.', 'error');
          return null;
        }
      }

      // Monthly plan caps (gauntlet batch 2 — product decision 2026-07-16):
      // caps are enforced with nudges on the way. enforceGate warns at 80%,
      // and at the cap shows the upgrade modal + blocks. New leads only —
      // edits are always allowed. Fails open before the plan loads and for
      // owners; the server meter (trackUsage below) is the cross-device
      // source of truth.
      if ((!editId || editId.startsWith('d-'))
          && window.NBDBilling && typeof window.NBDBilling.enforceGate === 'function'
          && !window.NBDBilling.enforceGate('leads', 'leads')) {
        return null;
      }

      // Wave 15: dedup guard — only on new leads (not edits). Surfaces
      // matching existing leads before we write so reps can open the
      // dupe instead of creating a second one. Skipped if the dedup
      // module hasn't loaded yet (degrades gracefully).
      let _duplicateOf = null;
      if ((!editId || editId.startsWith('d-')) && window.LeadDedup) {
        try {
          const result = await window.LeadDedup.checkAndPrompt(data, window._leads || []);
          if (!result.proceed) {
            if (result.openLeadId) {
              // Rep chose to open the existing lead — navigate there.
              // "Add a job to them" lands on the add-job sheet (customer-jobs.js).
              window.location.href = `/pro/customer.html?id=${encodeURIComponent(result.openLeadId)}${result.addJob ? '#addJob' : ''}`;
            }
            return null;
          }
          if (result.duplicateOf) _duplicateOf = result.duplicateOf;
        } catch (dedupErr) {
          console.warn('[lead-dedup] check failed; proceeding without dedup:', dedupErr);
        }
      }
      // Stamp duplicateOf on the payload so it persists in Firestore
      // for audit / future cleanup. Falsy values won't get written.
      if (_duplicateOf) data.duplicateOf = _duplicateOf;

      // Normalized phone match key (last-10 US digits) so an inbound SMS
      // from this lead ties back to it — incomingSMS queries leads by
      // phoneDigits (Twilio sends E.164; reps type free-form). Stamped on
      // `data` once here so it flows into ALL write branches below: the
      // NBDRepos.leads.create path, both inline addDoc fallbacks, AND the
      // edit updateDoc (so editing a lead's phone refreshes the key).
      // Canonical transform — keep identical to functions/phone-utils.js.
      data.phoneDigits = String(data.phone || '').replace(/\D/g, '').replace(/^1/, '').slice(-10);

      // NEW LEAD: Geocode address and create map pin
      if (!editId || editId.startsWith('d-')) {
        if (data.address) {
          try {
            const geo = await geocode(data.address, { quiet: true });
            if (!geo && typeof showToast === 'function') {
              showToast('Couldn’t place this address on the map — the lead still saves', 'info');
            }
            if (geo && geo.lat && geo.lon) {
              // Store lat/lng on lead
              data.lat = parseFloat(geo.lat);
              data.lng = parseFloat(geo.lon);
              
              // Create map pin
              const pinData = {
                lat: data.lat,
                lng: data.lng,
                name: `${data.firstName || ''} ${data.lastName || ''}`.trim(),
                address: data.address,
                leadId: null, // Will be set after lead is created
                stage: data.stage || 'New',
                type: 'customer'
              };
              
              // Save lead first to get ID. stageStartedAt is stamped at
              // create-time so the days-in-stage badge has a real
              // anchor for brand-new leads (without it, the badge fell
              // back to updatedAt/createdAt — usable but not the same
              // semantic).
              //
              // companyId scoping (Rock 3 PR 2): every lead is now
              // tagged with the caller's companyId so multi-tenant
              // queries and the upcoming E2E test cleanup can reliably
              // filter by tenant. Solo operators get their own uid as
              // companyId (matches the convention in functions/index.js
              // line 283: "callerCompanyId = decoded.companyId || decoded.uid").
              //
              // Audit batch 6 (2026-05-13): migrated to NBDRepos.leads.create
              // which centralizes the userId/companyId/createdAt/updatedAt
              // stamping. Falls back to the inline addDoc when NBDRepos
              // isn't loaded (defensive; the repos module is now in the
              // defer chain so this should always be available, but a
              // failed lazy-load shouldn't break lead creation).
              let leadRef;
              if (window.NBDRepos && window.NBDRepos.leads && typeof window.NBDRepos.leads.create === 'function') {
                const { id } = await window.NBDRepos.leads.create({
                  ...data,
                  stageStartedAt: serverTimestamp(),
                });
                leadRef = doc(db, 'leads', id);
              } else {
                leadRef = await addDoc(collection(db,'leads'), {
                  ...data,
                  createdAt: serverTimestamp(),
                  stageStartedAt: serverTimestamp(),
                  userId: window._user?.uid,
                  companyId: window._userClaims?.companyId || window._user?.uid || null
                });
              }

              // Optimistic insert — show on kanban immediately, even
              // if loadLeads later fails on a flaky iOS connection.
              _optimisticInsertLead(leadRef.id, data);
              // Meter the create (server-authoritative monthly counter —
              // the enforceGate check above reads what this writes).
              if (window.NBDBilling && typeof window.NBDBilling.trackUsage === 'function') {
                window.NBDBilling.trackUsage('leads');
              }

              // Now save pin with leadId
              pinData.leadId = leadRef.id;
              await _savePin(pinData);

              // Auto-assign customer ID (NBD-0001 format).
              // NBD-leak gate (2026-07-29, same as customer-bootstrap): never
              // mint from the 'NBD'/'customerIds' typeof fallbacks — on a
              // fresh device the first-seconds race against profile hydration
              // stamps a tenant lead with the platform prefix + shared
              // counter. Skip instead; the customer-page mint backfills later.
              try {
                if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
                  await window._loadCompanyProfile();
                }
                if (window._companyProfileLoaded !== true
                    || typeof window._custIdMint !== 'function'
                    || typeof window._formatCustomerId !== 'function') {
                  throw new Error('company profile not hydrated — customer-ID mint deferred');
                }
                const _cid = window._userClaims?.companyId || window._user?.uid;
                // Platform-identity veto (company-profile.js _custIdMint).
                const _mint = window._custIdMint(_cid);
                if (!_mint) throw new Error('tenant brand not set — customer-ID mint skipped (platform-identity veto)');
                const _ctrId = _mint.counterId;
                const _pfx = _mint.prefix;
                const counterRef = doc(db, 'counters', _ctrId);
                const custId = await runTransaction(db, async (tx) => {
                  const snap = await tx.get(counterRef);
                  let nextNum = snap.exists() ? (snap.data().next || 0) + 1 : 1;
                  tx.set(counterRef, { next: nextNum }, { merge: true });
                  return window._formatCustomerId(_pfx, nextNum, _cid);
                });
                await updateDoc(doc(db, 'leads', leadRef.id), { customerId: custId });
                console.log('✓ Assigned customer ID:', custId);
              } catch (cidErr) { console.warn('Customer ID assignment failed:', cidErr); }

              console.log('✓ Auto-pinned lead:', leadRef.id);

              // If this came from a D2D knock, mark it as converted
              if (data.d2dKnockId) {
                try {
                  await updateDoc(doc(db, 'knocks', data.d2dKnockId), { convertedToLead: true, leadId: leadRef.id, updatedAt: serverTimestamp() });
                } catch (d2dErr) { console.warn('Could not mark D2D knock as converted:', d2dErr); }
              }
              // If this came from a pin, link the pin to the lead
              if (window._pendingPinId) {
                try {
                  await _savePin({ id: window._pendingPinId, leadId: leadRef.id });
                } catch (pinErr) { console.warn('Could not link pin:', pinErr); }
                window._pendingPinId = null;
              }
              // The coordinate latch is consumed by THIS create and must not
              // outlive it. It was only ever cleared inside the _pendingPinId
              // block above — but Quick-Add's "Use my location" arms the coords
              // with no pin id, so the latch survived, and every later lead
              // whose address failed to geocode (Nominatim rate-limit, flaky
              // field connection) was silently stamped with the FIRST house's
              // location. Cleared before the refresh awaits so a loadPins/
              // loadLeads failure can't leave it armed.
              window._pendingPinLatLng = null;

              await loadPins(); // Refresh map pins
              await loadLeads();
              // Return the new leadId so callers (e.g. Quick Add) can
              // chain follow-up writes — initial activity entry, first
              // task, etc. — without re-querying Firestore.
              return leadRef.id;
            }
          } catch (geoError) {
            console.warn('Geocoding failed, creating lead without pin:', geoError);
            // Continue to create lead without pin
          }
        }
        
        // Fallback: create lead without geocoding
        // Use lat/lng from D2D knock or pin if available
        if (!data.lat && window._pendingPinLatLng) {
          data.lat = window._pendingPinLatLng.lat;
          data.lng = window._pendingPinLatLng.lng;
        }
        // companyId tagged here too — see comment on the geocoded path above.
        const fallbackRef = await addDoc(collection(db,'leads'), {
          ...data,
          createdAt: serverTimestamp(),
          stageStartedAt: serverTimestamp(),
          userId: window._user?.uid,
          companyId: window._userClaims?.companyId || window._user?.uid || null
        });
        // Optimistic insert — show on kanban immediately even if the
        // post-save loadLeads fails (iOS flaky connection scenario).
        _optimisticInsertLead(fallbackRef.id, data);
        // Meter the create (see geocoded branch).
        if (window.NBDBilling && typeof window.NBDBilling.trackUsage === 'function') {
          window.NBDBilling.trackUsage('leads');
        }
        // Auto-assign customer ID.
        // NBD-leak gate (2026-07-29): see the geocoded branch above.
        try {
          if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
            await window._loadCompanyProfile();
          }
          if (window._companyProfileLoaded !== true
              || typeof window._custIdMint !== 'function'
              || typeof window._formatCustomerId !== 'function') {
            throw new Error('company profile not hydrated — customer-ID mint deferred');
          }
          const _cid = window._userClaims?.companyId || window._user?.uid;
          // Platform-identity veto (company-profile.js _custIdMint).
          const _mint = window._custIdMint(_cid);
          if (!_mint) throw new Error('tenant brand not set — customer-ID mint skipped (platform-identity veto)');
          const _ctrId = _mint.counterId;
          const _pfx = _mint.prefix;
          const counterRef = doc(db, 'counters', _ctrId);
          const custId = await runTransaction(db, async (tx) => {
            const snap = await tx.get(counterRef);
            let nextNum = snap.exists() ? (snap.data().next || 0) + 1 : 1;
            tx.set(counterRef, { next: nextNum }, { merge: true });
            return window._formatCustomerId(_pfx, nextNum, _cid);
          });
          await updateDoc(doc(db, 'leads', fallbackRef.id), { customerId: custId });
          console.log('✓ Assigned customer ID:', custId);
        } catch (cidErr) { console.warn('Customer ID assignment failed:', cidErr); }
        // Mark D2D knock as converted
        if (data.d2dKnockId) {
          try {
            await updateDoc(doc(db, 'knocks', data.d2dKnockId), { convertedToLead: true, leadId: fallbackRef.id, updatedAt: serverTimestamp() });
          } catch (d2dErr) { console.warn('Could not mark D2D knock as converted:', d2dErr); }
        }
        // Link pin if pending
        if (window._pendingPinId) {
          try { await _savePin({ id: window._pendingPinId, leadId: fallbackRef.id }); } catch (pe) {}
          window._pendingPinId = null;
        }
        // Consumed by this create — see the geocoded branch above. This is the
        // branch that READ the latch (line ~3305), so leaving it armed here is
        // what handed the next un-geocodable lead the wrong coordinates.
        window._pendingPinLatLng = null;
        await loadLeads();
        // Return the newly-created lead's id (no-geocode fallback path).
        return fallbackRef.id;
      } else {
        // EDIT EXISTING: re-geocode when the address changed (or coords are
        // missing) so the Customers map layer + Jobs overlay stay accurate.
        // Best-effort — a geocode miss/timeout leaves the prior coords
        // untouched and never blocks the save (geocode() self-aborts at 5s).
        if (data.address) {
          const _prev = (window._leads || []).find(l => l && l.id === editId);
          const _addrChanged = !_prev || String(_prev.address || '') !== String(data.address || '');
          const _missingCoords = !_prev || _prev.lat == null || _prev.lng == null;
          if (_addrChanged || _missingCoords) {
            try {
              // Quiet: a lead with an unmappable address re-geocodes on every
              // save (coords stay missing) and used to flash a red error each time.
              const geo = await geocode(data.address, { quiet: true });
              if (geo && geo.lat && geo.lon) { data.lat = parseFloat(geo.lat); data.lng = parseFloat(geo.lon); }
              else if (_addrChanged && typeof showToast === 'function') {
                showToast('Couldn’t place this address on the map — changes still saved', 'info');
              }
            } catch (_) { /* keep existing coords */ }
          }
        }
        // EDIT EXISTING: Just update
        await updateDoc(doc(db,'leads',editId), {
          ...data,
          updatedAt: serverTimestamp()
        });
        // Optimistic merge — reflect the edit on the kanban immediately
        // (e.g. stage changes that should move the card to a new column)
        // without waiting on the loadLeads round-trip.
        _optimisticInsertLead(editId, data);
        await loadLeads();
        // Return the edited lead's id so callers know which doc was touched.
        return editId;
      }
    } catch(e) {
      // Surface the failure rather than fabricating a ghost lead. The
      // previous catch unshifted a {id:'d-...', ...data} record into
      // window._leads — but the very next line called loadLeads()
      // which overwrites that array, so the ghost flashed on the
      // kanban for ~200ms then vanished with no error toast. Result:
      // silent lead-loss. Now toast the error AND re-throw so the
      // caller can react (e.g., D2D auto-convert can leave the knock
      // unmarked instead of claiming it converted).
      console.error('saveLead error:', e);
      const msg = (e && e.message) ? e.message : 'unknown error';
      if (typeof showToast === 'function') {
        showToast('Lead save failed — ' + msg + '. Try again or check connection.', 'error');
      }
      throw e;
    }
    await loadLeads();
  };

  // Lightweight coord-only persister used by the Customers map layer's rolling
  // geocode-backfill (maps-customers.js). Writes just lat/lng so a lead mapped
  // once is never re-geocoded. Owner/staff-writable per the leads rule (only
  // userId/companyId are frozen); a denied/failed write is non-fatal — the
  // marker still shows this session, we just re-geocode next time.
  window._saveLeadCoords = async (id, lat, lng) => {
    if (!id || String(id).startsWith('d-')) return;
    try {
      // Do NOT bump updatedAt: this is a PASSIVE map backfill (a manager opening
      // the Customers layer geocodes teammates' team-scoped leads), and bumping
      // updatedAt would float those leads to the top of every "recently updated"
      // sort as if someone worked them (audit round 2).
      await updateDoc(doc(db,'leads',id), { lat, lng });
      const l = (window._leads || []).find(x => x && x.id === id);
      if (l) { l.lat = lat; l.lng = lng; }
    } catch(e) { console.warn('saveLeadCoords failed:', e && e.code); }
  };

  // Resolves true ONLY when the soft-delete write landed (or the lead is a
  // local-only 'd-' draft with nothing server-side), false when it failed or
  // the rules denied it — same contract as _deleteZone. Until 2026-09-18 this
  // swallowed the error and resolved undefined, so confirmDeleteLead toasted
  // "Lead moved to Deleted bin" for a viewer whose write the leads update rule
  // had refused. The local re-render sits OUTSIDE the write's try on purpose:
  // a renderLeads exception after a successful write is not a failed delete.
  async function _deleteLead(id) {
    if (!id) return false;
    if (!String(id).startsWith('d-')) {
      try {
        await updateDoc(doc(db,'leads',id), {
          deleted: true,
          deletedAt: serverTimestamp()
        });
      } catch(e) { console.error('deleteLead error:', e && e.code, e); return false; }
    }
    try {
      window._leads = (window._leads||[]).filter(l=>l.id!==id);
      renderLeads(window._leads);
    } catch(e) { console.warn('deleteLead re-render:', e); }
    return true;
  }

  // Same true/false contract as _deleteLead (2026-09-22, a #1663 residual):
  // resolves true ONLY when the un-delete write landed (or the id is a
  // local-only 'd-' draft), false when it failed or the rules denied it. It
  // used to swallow the error and resolve undefined, so the trash drawer's
  // restoreDeletedLead toasted "Lead restored" for a lead that was still in
  // the Deleted bin on the server.
  window._restoreLead = async (id) => {
    if (!id) return false;
    if (String(id).startsWith('d-')) return true; // local-only: nothing server-side
    try { await updateDoc(doc(db,'leads',id), { deleted: false, deletedAt: null }); return true; }
    catch(e) { console.error('restoreLead error:', e && e.code, e); return false; }
  };

  // Same true/false contract as _deleteLead: the trash drawer's "Remove"
  // (crm-portal-bridge.js permanentDeleteLead) toasts "Permanently deleted"
  // only on === true, so a denied or failed deleteDoc must say so here rather
  // than resolve like a success.
  window._permanentDeleteLead = async (id) => {
    if (!id) return false;
    if (String(id).startsWith('d-')) return true; // local-only: nothing server-side
    try { await deleteDoc(doc(db,'leads',id)); return true; }
    catch(e) { console.error('permanentDelete error:', e && e.code, e); return false; }
  };

  async function _loadDeletedLeads() {
    try {
      const uid = window._user?.uid;
      if (!uid) return;
      const snap = await getDocs(query(collection(db,'leads'), where('userId','==',uid), where('deleted','==',true)));
      return snap.docs.map(d => ({id:d.id,...d.data()}));
    } catch(e) { return []; }
  }

  // ── ESTIMATES ──────────────────────────────────
  async function loadEstimates() {
    try {
      const uid = window._user?.uid;
      if (!uid) { window._estimates = []; return; }
      // Team visibility: company readers (admin/manager/viewer) also pull the tenant's estimates
      // (companyId scope) so estCount + estimate rows reflect the whole team —
      // the /estimates rule permits this read. Own-userId query ALWAYS runs (it
      // covers the caller's legacy pre-companyId estimates). Two equality
      // queries, deduped by id — same two-scope shape as loadLeads/_photoCache.
      const claims = window._userClaims || {};
      const scopes = [where('userId','==',uid)];
      if (['company_admin','manager','viewer'].includes(claims.role || '') && claims.companyId) {
        scopes.push(where('companyId','==',claims.companyId));
      }
      const byId = {};
      for (const scope of scopes) {
        const snap = await getDocs(query(collection(db,'estimates'), scope));
        snap.docs.forEach(d => { byId[d.id] = {id:d.id,...d.data()}; });
      }
      window._estimates = Object.values(byId)
        .sort((a,b) => {
          const ta = a.createdAt?.toDate?.()?.getTime() || 0;
          const tb = b.createdAt?.toDate?.()?.getTime() || 0;
          return tb - ta;
        });
    } catch(e) { window._estimates = []; }
    renderEstimatesList(window._estimates);
    // Wave 13: notify the bell so stale-estimate counts update.
    try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'estimates' } })); } catch (_) {}
  }
  window._loadEstimates = loadEstimates;
  // Alias for consistency with window.loadLeads above.
  window.loadEstimates = loadEstimates;

  // B3: Live Firestore listener for estimates. Wire-once on auth.
  // BoldSign webhooks land on the server, flip
  // estimates/{id}.signatureStatus → the snapshot fires → UI rerenders.
  // Handles create + update + delete. Idempotent re-subscribe safe.
  let _estimatesUnsub = null;
  window._subscribeEstimates = function () {
    if (_estimatesUnsub) { try { _estimatesUnsub(); } catch(e) {} _estimatesUnsub = null; }
    const uid = window._user?.uid;
    if (!uid) return;
    const claims = window._userClaims || {};
    const teamRead = ['company_admin','manager','viewer'].includes(claims.role || '') && claims.companyId;
    // Two live slices merged by doc id: own estimates (ALWAYS — also covers
    // legacy docs with no companyId) + the tenant's estimates for company
    // readers (admin/manager/viewer). A solo/rep user gets EXACTLY the previous
    // single-listener behavior (own map only), so nothing regresses for them;
    // only team readers gain the second listener. Merging is required — a plain
    // own-only listener would clobber team estimates loadEstimates() merged in
    // every time it fired.
    const sortDesc = (a, b) => {
      const ta = a.createdAt?.toDate?.()?.getTime() || 0;
      const tb = b.createdAt?.toDate?.()?.getTime() || 0;
      return tb - ta;
    };
    const own = {}, comp = {};
    const rebuild = () => {
      const merged = Object.assign({}, comp, own); // own wins on a shared doc
      window._estimates = Object.values(merged).sort(sortDesc);
      renderEstimatesList(window._estimates);
    };
    const onErr = (err) => {
      console.warn('estimates snapshot error:', err && err.message);
      // Fall back to one-shot fetch so the UI isn't stuck empty.
      loadEstimates();
    };
    // Both slices are BOUNDED to the newest ESTIMATES_LIVE_LIMIT estimates
    // (orderBy createdAt desc — the same key sortDesc renders by). Unbounded,
    // every snapshot re-shipped the whole history. 500 = 60x the whole prod
    // estimates collection (8, every one with a Timestamp createdAt — the
    // 2026-10-03 count; every addDoc writer stamps it). Indexes: userId ASC +
    // createdAt DESC and companyId ASC + createdAt DESC (firestore.indexes.json).
    const ESTIMATES_LIVE_LIMIT = 500;
    const unsubs = [];
    unsubs.push(onSnapshot(query(collection(db, 'estimates'), where('userId', '==', uid), orderBy('createdAt', 'desc'), limit(ESTIMATES_LIVE_LIMIT)), (snap) => {
      for (const k in own) delete own[k];
      snap.docs.forEach(d => { own[d.id] = { id: d.id, ...d.data() }; });
      rebuild();
    }, onErr));
    if (teamRead) {
      unsubs.push(onSnapshot(query(collection(db, 'estimates'), where('companyId', '==', claims.companyId), orderBy('createdAt', 'desc'), limit(ESTIMATES_LIVE_LIMIT)), (snap) => {
        for (const k in comp) delete comp[k];
        snap.docs.forEach(d => { comp[d.id] = { id: d.id, ...d.data() }; });
        rebuild();
      }, onErr));
    }
    _estimatesUnsub = () => unsubs.forEach(u => { try { u(); } catch(e) {} });
  };

  window._saveEstimate = async (data) => {
    try {
      const editId = window._editingEstimateId;
      if (editId) {
        // Update existing estimate
        await updateDoc(doc(db,'estimates',editId), {...data, updatedAt:serverTimestamp()});
        window._editingEstimateId = null;
        await loadEstimates();
        return editId;
      } else {
        // Create new estimate. Stamp companyId (claims.companyId || uid) — the
        // tenant key that lets same-company managers read team estimates (the
        // /estimates rule's isCompanyStaff read) and powers team estCount. Solo
        // operators key by uid, mirroring /pins + /invoices.
        const ref2 = await addDoc(collection(db,'estimates'), {...data, createdAt:serverTimestamp(),
          userId:window._user?.uid,
          companyId: (window._userClaims && window._userClaims.companyId) || window._user?.uid || null});
        await loadEstimates();
        // Pipeline wiring: Pipeline/dashboard-KPI/Leaderboard all read
        // lead.jobValue, not the estimate itself — nothing wrote that back
        // before this. Stamp it here, once, so every caller (Job Templates,
        // classic builder, V2 builder) gets correct pipeline reflection for
        // free instead of needing this re-applied per caller. Best-effort:
        // a stamp-back failure must never fail the estimate save itself.
        if (data.leadId) {
          try {
            const leadRef = doc(db, 'leads', data.leadId);
            const leadSnap = await getDoc(leadRef);
            if (leadSnap.exists()) {
              const lead = leadSnap.data();
              if (!lead.primaryEstimateId) {
                // First estimate this lead has ever had — unambiguous, stamp
                // it straight through. Only bump a stone-cold "new" lead
                // forward (to Contacted, since a real number now exists);
                // never regress a lead already further along the funnel.
                const stampUpdate = {
                  primaryEstimateId: ref2.id,
                  lastEstimateAt: serverTimestamp(),
                };
                // Only stamp a jobValue the pipeline can trust (see _estValue /
                // _canStampJobValue). Previously wrote `Number(data.grandTotal) || 0`
                // unconditionally, so a Classic estimate set the lead's very first
                // job value to $0.
                const _firstVal = _estValue(data);
                if (_canStampJobValue(_firstVal)) stampUpdate.jobValue = _firstVal;
                if (normalizeStage(lead.stage) === S.NEW) {
                  stampUpdate.stage = S.CONTACTED;
                  stampUpdate.stageRole = stageRole(S.CONTACTED);
                }
                await updateDoc(leadRef, stampUpdate);
              } else if (lead.primaryEstimateId !== ref2.id) {
                // Lead already has a primary estimate (a revision/second
                // quote is being created) — don't silently clobber a
                // rep-confirmed number. Same confirm helper estimates.js
                // already uses elsewhere (nbdConfirm, falling back to the
                // native confirm()).
                const existingVal = Number(lead.jobValue) || 0;
                const newVal = _estValue(data);
                // Never OFFER to trade a real job value for a zero. The old code
                // read grandTotal alone, so a Classic estimate produced the
                // prompt "Use this new estimate's $0 instead?" — which reads as a
                // broken estimate rather than a warning, and clicking through
                // wiped the deal's value from the kanban, KPIs and leaderboard.
                if (!_canStampJobValue(newVal)) {
                  await updateDoc(leadRef, {
                    primaryEstimateId: ref2.id,
                    lastEstimateAt: serverTimestamp(),
                  });
                } else {
                  const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
                  const useNew = await ask(
                    `This lead's job value is currently $${existingVal.toLocaleString()} (from an earlier estimate). ` +
                    `Use this new estimate's $${newVal.toLocaleString()} instead?`
                  );
                  if (useNew) {
                    await updateDoc(leadRef, {
                      jobValue: newVal,
                      primaryEstimateId: ref2.id,
                      lastEstimateAt: serverTimestamp(),
                    });
                  }
                }
              }
              // Claim unification: claim facts typed into the estimate
              // builder flow back to the lead — but ONLY into empty lead
              // fields, so the CRM record (edited via the Claim Details
              // panel / lead modal) always wins over an estimate draft.
              const estClaim = data.claim || {};
              const claimBack = {};
              if (estClaim.carrier && !lead.insCarrier && !lead.insuranceCarrier) claimBack.insCarrier = estClaim.carrier;
              if (estClaim.number && !lead.claimNumber) claimBack.claimNumber = estClaim.number;
              if (estClaim.policyNumber && !lead.policyNumber) claimBack.policyNumber = estClaim.policyNumber;
              if (estClaim.dateOfLoss && !lead.dateOfLoss) claimBack.dateOfLoss = estClaim.dateOfLoss;
              if (estClaim.adjuster && !lead.adjusterName) claimBack.adjusterName = estClaim.adjuster;
              if (Object.keys(claimBack).length) await updateDoc(leadRef, claimBack);
            }
          } catch (stampErr) {
            console.warn('[_saveEstimate] lead stamp-back failed:', stampErr);
          }
        }
        return ref2.id;
      }
    } catch (e) {
      // Re-throw — the previous swallow + return-null was making the
      // caller in estimates.js fire its success toast even when the
      // Firestore write failed. Silent estimate-loss in production.
      // The caller now gets a real exception it can surface to the user.
      console.error('Save estimate error:', e);
      throw e;
    }
  };

  // ── ESTIMATE CRUD HELPERS ─────────────────────
  // Delete an estimate by document id. Cascade: we don't have
  // child collections under an estimate, so a single deleteDoc is
  // enough. Called from the estimates list overflow menu.
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer a bare window global.
  async function _deleteEstimate(id) {
    try {
      if (!id) return false;
      await deleteDoc(doc(db, 'estimates', id));
      await loadEstimates();
      return true;
    } catch (e) {
      console.error('Delete estimate error:', e);
      return false;
    }
  }

  // Duplicate an existing estimate. Clones the document into a new
  // one with a new id and a "(copy)" name suffix so it shows up as
  // a separate row in the list. The duplicate is intentionally
  // unassigned (leadId = null) so the user can re-assign it.
  window._duplicateEstimate = async (id) => {
    try {
      if (!id) return null;
      const src = (window._estimates || []).find(e => e.id === id);
      if (!src) return null;
      // Strip fields that should not carry over: id, createdAt,
      // updatedAt, leadId. Keep everything else verbatim so the
      // copy opens in the same builder with the same numbers.
      const copy = { ...src };
      delete copy.id;
      delete copy.createdAt;
      delete copy.updatedAt;
      copy.leadId = null;
      const baseName = (src.name || src.addr || 'Estimate').toString().substring(0, 80);
      copy.name = baseName + ' (copy)';
      const ref2 = await addDoc(collection(db, 'estimates'), {
        ...copy,
        createdAt: serverTimestamp(),
        userId: window._user?.uid
      });
      await loadEstimates();
      return ref2.id;
    } catch (e) {
      console.error('Duplicate estimate error:', e);
      return null;
    }
  };

  // Rename an estimate in place — just writes back the name field.
  // Cheap and atomic.
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer a bare window global.
  async function _renameEstimate(id, newName) {
    try {
      if (!id) return false;
      const name = String(newName || '').trim().substring(0, 120);
      if (!name) return false;
      await updateDoc(doc(db, 'estimates', id), { name, updatedAt: serverTimestamp() });
      await loadEstimates();
      return true;
    } catch (e) {
      console.error('Rename estimate error:', e);
      return false;
    }
  }

  // Assign (or re-assign) an estimate to a customer/lead. Writes
  // leadId and also copies the lead's address/owner over for faster
  // list display. Passing leadId=null clears the assignment.
  //
  // Linkage invariant (CRM audit 2026-07): attaching is only half the
  // job — Pipeline/KPIs/Leaderboard read lead.jobValue + lead
  // .primaryEstimateId, not the estimate itself, so an assign that only
  // wrote leadId left the pipeline under-reporting. This now mirrors
  // _saveEstimate's create-path stamp-back exactly (first estimate →
  // stamp through + NEW→Contacted bump; existing primary → confirm
  // before clobbering a rep-confirmed number). It's also the manual
  // remediation path for migration 005's reported skips — hand-assigning
  // an orphan must leave the same state a correctly-linked save would.
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer a bare window global.
  async function _assignEstimateToLead(id, leadId) {
    try {
      if (!id) return false;
      // Snapshot the estimate BEFORE the write — the stamp-back needs its
      // grandTotal, and the un-dangle pass needs its previous leadId.
      let est = (window._estimates || []).find(e => e.id === id) || null;
      if (!est) {
        try {
          const s = await getDoc(doc(db, 'estimates', id));
          if (s.exists()) est = { id, ...s.data() };
        } catch (_) { /* stamp-back degrades gracefully below */ }
      }
      const prevLeadId = (est && est.leadId) || null;
      const patch = { leadId: leadId || null, updatedAt: serverTimestamp() };
      if (leadId) {
        const lead = (window._leads || []).find(l => l.id === leadId);
        if (lead) {
          if (lead.address) patch.addr = lead.address;
          if (lead.firstName || lead.lastName) {
            patch.owner = [lead.firstName, lead.lastName].filter(Boolean).join(' ');
          }
        }
      }
      await updateDoc(doc(db, 'estimates', id), patch);
      // Stamp-back — best-effort: a stamp failure must never fail the
      // assign itself (same contract as _saveEstimate's create path).
      if (leadId && leadId !== prevLeadId) {
        try {
          const leadRef = doc(db, 'leads', leadId);
          const leadSnap = await getDoc(leadRef);
          if (leadSnap.exists()) {
            const lead = leadSnap.data();
            const newVal = _estValue(est);
            if (!lead.primaryEstimateId) {
              const stampUpdate = {
                primaryEstimateId: id,
                lastEstimateAt: serverTimestamp(),
              };
              // Only stamp a jobValue the pipeline can trust — never
              // zero a KPI off an estimate with no total.
              if (_canStampJobValue(newVal)) stampUpdate.jobValue = newVal;
              if (normalizeStage(lead.stage) === S.NEW) {
                stampUpdate.stage = S.CONTACTED;
                stampUpdate.stageRole = stageRole(S.CONTACTED);
              }
              await updateDoc(leadRef, stampUpdate);
            } else if (lead.primaryEstimateId !== id) {
              // Same rule as the branch above, which this one did NOT share:
              // it wrote jobValue unconditionally, so re-assigning a Classic
              // estimate offered "Use this estimate's $0 instead?" and, on Yes,
              // zeroed a live deal across every money surface.
              if (!_canStampJobValue(newVal)) {
                await updateDoc(leadRef, {
                  primaryEstimateId: id,
                  lastEstimateAt: serverTimestamp(),
                });
              } else {
                const existingVal = Number(lead.jobValue) || 0;
                const ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
                const useNew = await ask(
                  `This lead's job value is currently $${existingVal.toLocaleString()} (from an earlier estimate). ` +
                  `Use this estimate's $${newVal.toLocaleString()} instead?`
                );
                if (useNew) {
                  await updateDoc(leadRef, {
                    jobValue: newVal,
                    primaryEstimateId: id,
                    lastEstimateAt: serverTimestamp(),
                  });
                }
              }
            }
          }
        } catch (stampErr) {
          console.warn('[_assignEstimateToLead] lead stamp-back failed:', stampErr);
        }
      }
      // Un-dangle: a re-assign/unassign can leave the PREVIOUS lead's
      // primaryEstimateId pointing at an estimate that's no longer its
      // own. Break the pointer; leave jobValue as-is — it may be a
      // rep-confirmed number, and "never clobber a rep-confirmed number"
      // outranks tidiness (same principle as migration 005's stamp gate).
      if (prevLeadId && prevLeadId !== (leadId || null)) {
        try {
          const prevRef = doc(db, 'leads', prevLeadId);
          const prevSnap = await getDoc(prevRef);
          if (prevSnap.exists() && prevSnap.data().primaryEstimateId === id) {
            await updateDoc(prevRef, { primaryEstimateId: null });
          }
        } catch (_) { /* dangling pointer is display-only; next assign heals it */ }
      }
      await loadEstimates();
      return true;
    } catch (e) {
      console.error('Assign estimate error:', e);
      return false;
    }
  }
  // ── END ESTIMATE CRUD HELPERS ─────────────────

  // ── REPORTS CRUD HELPERS ──────────────────────
  // Firestore-backed persistence for generated reports. Every report
  // that gets saved goes into a `reports` collection scoped by userId.
  // The Rep Report Generator UI calls these helpers; the viewer lists
  // them in the My Reports history panel.
  async function _loadReports() {
    try {
      const uid = window._user?.uid;
      if (!uid) { window._reports = []; return []; }
      const snap = await getDocs(query(
        collection(db, 'reports'),
        where('userId', '==', uid),
        orderBy('createdAt', 'desc'),
        limit(100)
      ));
      window._reports = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      return window._reports;
    } catch (e) {
      console.error('[Reports] loadReports failed:', e);
      window._reports = [];
      return [];
    }
  }

  async function _saveReport(data) {
    const uid = window._user?.uid;
    if (!uid) throw new Error('Not signed in');
    // The /reports create rule REQUIRES companyId (string, non-empty, equal to
    // the caller's tenant or their uid) — it is pinned there so a crafted write
    // cannot inject a report into another tenant's team-visible feed. This
    // writer never stamped it, so every save through it was rejected. The rule's
    // own comment says "saveReport already stamps companyId" and it is right
    // about the OTHER saveReport (inspection-report-engine.js); this one is a
    // second, separate writer that was missed.
    //
    // Solo operators key by uid — the companyId == uid convention the rule
    // allows explicitly, and the same fallback /invoices uses.
    const companyId = window._userClaims?.companyId || uid;
    try {
      const ref2 = await addDoc(collection(db, 'reports'), {
        ...data,
        userId: uid,
        companyId,
        createdAt: serverTimestamp()
      });
      await _loadReports();
      return ref2.id;
    } catch (e) {
      // Rethrow rather than swallowing. Returning null made a rules rejection
      // indistinguishable from success to the caller, which toasted
      // "✓ Report saved to My Reports" over a write that never landed — the
      // report then simply was not in My Reports, with a console.error as the
      // only trace. A failed save must be able to reach the user.
      console.error('[Reports] saveReport failed:', e);
      throw e;
    }
  }

  async function _deleteReport(id) {
    try {
      if (!id) return false;
      await deleteDoc(doc(db, 'reports', id));
      await _loadReports();
      return true;
    } catch (e) {
      console.error('[Reports] deleteReport failed:', e);
      return false;
    }
  }
  // ── END REPORTS CRUD HELPERS ──────────────────

  // ── PINS ───────────────────────────────────────
  async function loadPins() {
    try {
      const uid = window._user?.uid;
      if (!uid) { console.warn('📌 loadPins: no uid, skipping'); window._pins = []; return; }
      // Team territory map (2026-07-08): company_admin / manager / viewer fetch
      // the whole tenant's pins so the shared map shows every rep's knocks —
      // same dual-scope shape as loadLeads. The second (own-uid) scope keeps a
      // claimed-in member's PRE-invite pins (companyId == their own uid) and any
      // legacy no-companyId pins visible. sales_rep + solo + legacy-claim stay
      // own-only (matches the leads Wave-110 privacy decision).
      const _claims = window._userClaims || {};
      const _teamReader = ['company_admin', 'manager', 'viewer'].includes(_claims.role || '') && !!_claims.companyId;
      const _scopes = _teamReader && _claims.companyId !== uid
        ? [where('companyId', '==', _claims.companyId), where('userId', '==', uid)]
        : [_teamReader ? where('companyId', '==', _claims.companyId) : where('userId', '==', uid)];
      const _seen = new Set();
      const _out = [];
      for (const scope of _scopes) {
        const snap = await getDocs(query(collection(db,'pins'), scope));
        snap.docs.forEach(d => { if (!_seen.has(d.id)) { _seen.add(d.id); _out.push({id:d.id,...d.data()}); } });
      }
      window._pins = _out;
    } catch(e) { console.error('📌 loadPins FAILED:', e.code, e.message, e); window._pins = []; }
  }
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer bare window globals.
  async function _savePin(data) {
    try {
      if (data.id) {
        // Update existing pin
        const pinId = data.id;
        delete data.id;
        await updateDoc(doc(db,'pins',pinId), {...data, updatedAt:serverTimestamp()});
        return pinId;
      }
      // Create new pin. Stamp companyId (claim, or uid for solo operators —
      // same convention as leads/reports) so the pin is team-visible AND passes
      // the /pins create rule, which now requires a tenant-scoped companyId.
      const _uid = window._user?.uid;
      const pinDoc = {...data, userId:_uid, companyId: (window._userClaims?.companyId) || _uid || null, createdAt:serverTimestamp()};
      const r = await addDoc(collection(db,'pins'), pinDoc);
      return r.id;
    }
    catch(e) { console.error('📌 savePin FAILED:', e.code, e.message, e); return 'd-'+Date.now(); }
  }
  // Returns true when the doc is gone (or was local-only), false when the
  // delete was denied/failed — so the caller can skip an optimistic marker
  // removal that would silently reappear on reload (a team reader can SEE a
  // teammate's pin but the /pins rule denies deleting it).
  async function _deletePin(id) {
    if (!id || String(id).startsWith('d-')) return true; // local-only pin
    try { await deleteDoc(doc(db,'pins',id)); return true; }
    catch(e){ console.warn('deletePin failed:', e && e.code); return false; }
  }

  // ── TERRITORY ZONES ───────────────────────────
  // Persisted, team-shared canvassing areas (optionally rep-assigned). Same
  // company dual-scope + companyId stamping as pins, so a drawn territory
  // survives reload and every teammate sees it.
  async function loadZones() {
    try {
      const uid = window._user?.uid;
      if (!uid) { window._zones = []; return; }
      const _claims = window._userClaims || {};
      const _teamReader = ['company_admin', 'manager', 'viewer'].includes(_claims.role || '') && !!_claims.companyId;
      const _scopes = _teamReader && _claims.companyId !== uid
        ? [where('companyId', '==', _claims.companyId), where('userId', '==', uid)]
        : [_teamReader ? where('companyId', '==', _claims.companyId) : where('userId', '==', uid)];
      const _seen = new Set();
      const _out = [];
      for (const scope of _scopes) {
        const snap = await getDocs(query(collection(db,'zones'), scope));
        snap.docs.forEach(d => { if (!_seen.has(d.id)) { _seen.add(d.id); _out.push({id:d.id,...d.data()}); } });
      }
      window._zones = _out;
      // Draw them if the map is already up (order-independent with initMainMap,
      // which also calls renderSavedZones once _zones exists — both idempotent).
      if (typeof window.renderSavedZones === 'function') { try { window.renderSavedZones(); } catch (_) {} }
    } catch(e) { console.error('🗺 loadZones FAILED:', e.code, e.message, e); window._zones = []; }
  }
  window.loadZones = loadZones;
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer bare window globals.
  async function _saveZone(data) {
    try {
      if (data.id && !String(data.id).startsWith('d-')) {
        const zoneId = data.id;
        const patch = {...data}; delete patch.id;
        await updateDoc(doc(db,'zones',zoneId), {...patch, updatedAt:serverTimestamp()});
        return zoneId;
      }
      const _uid = window._user?.uid;
      const zoneDoc = {...data}; delete zoneDoc.id;
      zoneDoc.userId = _uid;
      zoneDoc.companyId = (window._userClaims?.companyId) || _uid || null;
      zoneDoc.createdAt = serverTimestamp();
      const r = await addDoc(collection(db,'zones'), zoneDoc);
      return r.id;
    }
    catch(e) { console.error('🗺 saveZone FAILED:', e.code, e.message, e); return 'd-'+Date.now(); }
  }
  // Returns true if the zone is gone server-side (or was never persisted), false
  // if the delete was denied/failed — so the caller can avoid an optimistic
  // removal that silently reappears on reload (a team reader can SEE a
  // teammate's zone but the /zones rule denies deleting it).
  async function _deleteZone(id) {
    if (!id || String(id).startsWith('d-')) return true; // local-only zone
    try { await deleteDoc(doc(db,'zones',id)); return true; }
    catch(e){ console.warn('deleteZone failed:', e && e.code); return false; }
  }

  // ── PHOTOS ─────────────────────────────────────
  // Storage rules (storage.rules, 2026-04-11 hardening) require
  // `photos/{uid}/{...}`. The old `photos/{leadId}/...` path
  // hits the default-deny rule and returns permission-denied —
  // root cause of "upload failed" errors reported by users.
  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer bare window globals.
  async function _uploadPhoto(leadId, file) {
    try {
      const uid = window._user?.uid;
      if (!uid) throw new Error('Not signed in');
      const safeName = (file.name || 'upload').replace(/[^A-Za-z0-9._-]+/g, '_').substring(0, 120);
      const storagePath = `photos/${uid}/${leadId}/${Date.now()}_${safeName}`;
      const r = ref(storage, storagePath);
      await uploadBytes(r, file);
      const url = await getDownloadURL(r);
      await addDoc(collection(db,'photos'), {leadId, url, name:file.name, userId:uid, createdAt:serverTimestamp(),
        // Canonical Storage object name — the image pipeline
        // (functions/image-pipeline.js) finds this doc by storagePath
        // equality to stamp `urls:{thumb,med,full}` variants.
        storagePath,
        // Tenant key (claims.companyId || uid) — company-scoped photo reads.
        companyId: (window._userClaims && window._userClaims.companyId) || uid});
      return url;
    } catch(e) { console.error('Upload failed',e); return null; }
  }

  async function _getPhotos(leadId) {
    try {
      const uid = window._user?.uid;
      if (!uid) return [];
      // Team visibility: the photo WRITE stamps companyId and _photoCache already
      // reads dual-scope, but this modal path was userId-only — so a manager
      // opening a teammate's lead saw a "📷 3" badge (from the company-scoped
      // cache) then an EMPTY gallery. Mirror _photoCache's two-scope shape: own
      // userId always (covers pre-backfill photos with no companyId), plus the
      // companyId scope for company readers. Each is two equality filters
      // (leadId + userId/companyId) → single-field merge-join, no composite
      // index. Deduped by doc id; the /photos rule permits both reads.
      const claims = window._userClaims || {};
      const scopes = [where('userId','==',uid)];
      if (['company_admin','manager','viewer'].includes(claims.role || '') && claims.companyId) {
        scopes.push(where('companyId','==',claims.companyId));
      }
      const seen = new Set();
      const out = [];
      for (const scope of scopes) {
        const snap = await getDocs(query(collection(db,'photos'), where('leadId','==',leadId), scope));
        snap.docs.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); out.push({id:d.id,...d.data()}); } });
      }
      return out;
    } catch(e) { console.warn('[_getPhotos] load failed:', e && e.message); return []; }
  }

  // ── SETTINGS ───────────────────────────────────
  // Populate the Profile tab from the saved user doc. The boot-time
  // onAuthStateChanged priming (see ~line 1047) runs while these inputs
  // are still inert inside <template id="tpl-view-settings">, so every
  // getElementById there returns null and the writes no-op. This runs
  // from switchSettingsTab('profile') AFTER _hydrateViewTemplate has
  // cloned the template into the live DOM, so the fields reflect what
  // was actually saved (default-ON digest/nudge: only OFF when the
  // stored value is explicitly false — matches the cron `=== false`
  // opt-out checks in functions/weekly-digest.js + dormant-leads.js).
  async function _loadProfileSettings() {
    // Refreshing on #/settings runs this ~50ms after load, before sign-in
    // resolves — it used to return here, leaving Phone / Google review /
    // Cal.com blank, and the next Save then wrote those blanks back.
    for (let i = 0; i < 60 && !window._user; i++) await new Promise(r => setTimeout(r, 250));
    const u = window._user;
    if (!u) return;
    const _setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    // Display Name + Email come straight off the auth user (no read needed).
    _setVal('settingsName',  u.displayName || '');
    _setVal('settingsEmail', u.email || '');
    try {
      const usrSnap = await getDoc(doc(db, 'users', u.uid));
      if (!usrSnap.exists()) return;
      const d = usrSnap.data();
      // Cal.com username + shareable preview link.
      const calVal = d.calcomUsername || '';
      _setVal('settingsCalcom', calVal);
      // Keep the in-memory rep shadow's cal.com username in sync with what we
      // just read so booking-SMS / portal link helpers use the current value
      // within this session (parity with the boot-time priming, which also
      // seeds window._currentRep).
      window._currentRep = Object.assign({}, window._currentRep || {}, { calcomUsername: calVal });
      const calPrev = document.getElementById('settingsCalcomPreview');
      if (calPrev) {
        if (calVal) {
          const url = 'https://cal.com/' + calVal;
          calPrev.textContent = url; calPrev.href = url; calPrev.style.display = '';
        } else {
          calPrev.style.display = 'none';
        }
      }
      // Digest + dormant-nudge opt-in: default ON unless explicitly false.
      const digestEl = document.getElementById('settingsWeeklyDigest');
      if (digestEl) digestEl.checked = d.weeklyDigestEnabled !== false;
      const dormantEl = document.getElementById('settingsDormantNudge');
      if (dormantEl) dormantEl.checked = d.dormantNudgeEnabled !== false;
      const revNudgeEl = document.getElementById('settingsReviewNudge');
      if (revNudgeEl) revNudgeEl.checked = d.reviewNudgeEnabled !== false;
      // Per-rep Phone + Google review link — load both. The homeowner portal
      // reads users/{uid}.phone (the "Call your rep" tap-to-call button + the
      // warranty-claim SMS recipient) and users/{uid}.googleReviewUrl (the
      // 4-5★ review nudge); without a writer those features were dead for
      // everyone. Persisted in _saveSettings below.
      _setVal('settingsPhone', d.phone || '');
      _setVal('settingsGoogleReview', d.googleReviewUrl || '');
      // Company / Role / License # — the rep's own profile text (2026-09-28;
      // they used to be unwired and silently dropped). The tenant-wide brand
      // still lives in the Company Profile tab.
      if (d.profileCompany != null) _setVal('settingsCompany', d.profileCompany);
      if (d.licenseNumber != null) _setVal('settingsLicense', d.licenseNumber);
      if (d.jobTitle) {
        const roleEl = document.getElementById('settingsRole');
        if (roleEl && [...roleEl.options].some(o => (o.value || o.textContent) === d.jobTitle)) roleEl.value = d.jobTitle;
      }
    } catch (e) { /* silent — rules may deny mid-bootstrap */ }
  };

  const _saveSettings = async () => {
    const name = document.getElementById('settingsName').value.trim();
    // Cal.com username — stored on users/{uid}.calcomUsername so the
    // calcomWebhook can resolve incoming bookings back to this rep.
    // Normalize: lowercase, strip trailing slashes / leading @.
    const rawCal = (document.getElementById('settingsCalcom')?.value || '').trim();
    // A pasted link ("https://cal.com/joe" or "cal.com/joe/roof-inspection")
    // used to be saved whole, so every booking link read
    // cal.com/https%3A%2F%2Fcal.com%2Fjoe and calcomWebhook never matched
    // the rep. Keep only the username segment.
    const calcomUsername = rawCal.replace(/^https?:\/\//i, '').replace(/^(www\.)?cal\.com\//i, '')
                                 .replace(/^@+/, '').split(/[/?#]/)[0]
                                 .toLowerCase().slice(0, 60) || null;
    // Wave 16: weekly digest opt-in/out. Stored as a boolean so the
    // weeklyDigest cron's `=== false` check works as expected (default
    // is "send" if the field is missing or true).
    const digestEl = document.getElementById('settingsWeeklyDigest');
    const weeklyDigestEnabled = digestEl ? !!digestEl.checked : true;
    // Wave 28: dormant-nudge opt-in/out. Same default-ON semantics as
    // weeklyDigestEnabled; the dormantLeadNudge cron does an explicit
    // `=== false` skip check.
    const dormantEl = document.getElementById('settingsDormantNudge');
    const dormantNudgeEnabled = dormantEl ? !!dormantEl.checked : true;
    // Review-nudge opt-in/out (2026-07-14). Same default-ON semantics;
    // the reviewRequestNudge cron does an explicit `=== false` skip check.
    const revNudgeEl = document.getElementById('settingsReviewNudge');
    const reviewNudgeEnabled = revNudgeEl ? !!revNudgeEl.checked : true;
    // Per-rep phone (homeowner portal "Call your rep" + warranty-claim SMS) and
    // Google review link (the 4-5★ review nudge). googleReviewUrl is stored only
    // when it's a real http(s) URL — the portal enforces the same before
    // rendering it as a link; an empty/invalid value clears it.
    const phone = (document.getElementById('settingsPhone')?.value || '').trim().slice(0, 30);
    const rawReview = (document.getElementById('settingsGoogleReview')?.value || '').trim();
    const googleReviewUrl = /^https?:\/\//i.test(rawReview) ? rawReview.slice(0, 500) : '';
    // Company / Role / License # had no writer: typed values vanished on the
    // next load while the save said "Settings saved!". Kept on the rep's own
    // user doc (never `role` — that key is claims-owned and rules-protected).
    const profileCompany = (document.getElementById('settingsCompany')?.value || '').trim().slice(0, 120);
    const jobTitle = (document.getElementById('settingsRole')?.value || '').trim().slice(0, 60);
    const licenseNumber = (document.getElementById('settingsLicense')?.value || '').trim().slice(0, 60);
    try {
      await updateProfile(window._user, {displayName: name});
      document.getElementById('userName').textContent = name;
      // A rename should reach the greetings too, not wait for a reload.
      if (typeof window._paintUserGreetings === 'function') window._paintUserGreetings();
      // Persist Cal.com username on the user profile.
      if (window.db && window.doc && window.setDoc) {
        await window.setDoc(window.doc(window.db, 'users', window._user.uid), {
          displayName: name,
          calcomUsername,
          weeklyDigestEnabled,
          dormantNudgeEnabled,
          reviewNudgeEnabled,
          phone,
          googleReviewUrl,
          profileCompany,
          jobTitle,
          licenseNumber
        }, { merge: true });
      }
      // Refresh the in-memory rep shadow so the next booking SMS
      // uses the new URL immediately (no page reload needed).
      window._currentRep = Object.assign({}, window._currentRep || {}, {
        calcomUsername: calcomUsername || '',
        displayName: name,
        phone,
        googleReviewUrl
      });
      if (rawReview && !googleReviewUrl) {
        showToast('Saved — but the Google review link must start with https:// and was cleared', 'warning');
      } else {
        showToast('Settings saved!', 'success');
      }
    } catch(e) { showToast('Save failed','error'); }
  };

  // V2 Estimate Engine settings — read from EstimateBuilderV2 settings store
  // and sync to/from localStorage + Firestore.
  function _v2ReadSettings() {
    const EB2 = window.EstimateBuilderV2;
    if (!EB2 || typeof EB2.loadSettings !== 'function') return null;
    return EB2.loadSettings();
  }

  // companyProfile writes are owner/company_admin-only (firestore.rules), so a
  // plain sales_rep pressing Save gets a rules denial, NOT a network blip. The
  // two are indistinguishable in the old "check your connection" copy, which
  // told a rep to retry something that can never succeed for them.
  function _pricingDenied(e) {
    const code = (e && (e.code || e.message)) || '';
    return /permission[-_ ]denied|insufficient permissions|PERMISSION_DENIED/i.test(String(code));
  }

  // Same settings, but with the tenant's COUNTY policy overlaid — what the
  // settings panel must DISPLAY. County permit costs and tax rates are
  // company-wide (companyProfile.pricing), so the 14 inputs have to show what
  // the company prices at, not whatever this device last saved locally.
  // The SAVE path deliberately keeps using the pure _v2ReadSettings() so the
  // overlay can never be written back into localStorage as device state.
  function _v2ReadResolvedSettings() {
    const EB2 = window.EstimateBuilderV2;
    if (!EB2) return null;
    if (typeof EB2.getResolvedCountySettings === 'function') return EB2.getResolvedCountySettings();
    return _v2ReadSettings();
  }

  function _v2WriteSettings(patch) {
    const EB2 = window.EstimateBuilderV2;
    if (!EB2 || typeof EB2.updateSettings !== 'function') return null;
    return EB2.updateSettings(patch);
  }

  // Populate the Estimates settings tab from current v2 engine settings
  // Did the 14 county inputs get populated FROM a hydrated tenant profile?
  // Distinct from window._companyProfileLoaded, which only says the profile is
  // hydrated NOW. The save path needs the former: publishing inputs that were
  // painted before hydration is a full-replace of company money with factory
  // values. Reset on every (re)paint so it always describes what is on screen.
  let _countyInputsResolved = false;
  // …and FOR WHICH TENANT (2026-09-25, second review of PR #1774). The flag
  // says the inputs came from a loaded profile, not whose: when the same
  // account's company changed under this tab (claims), a re-read loaded the
  // new company while the panel still showed the old one's rates, and Save
  // All published them onto the new company. The loaded key at paint time;
  // Save All publishes only when it is the key it writes to.
  let _countyInputsKey = null;

  // Registered in __NBD_CALL_REGISTRY at the end of this file (Globals
  // Tranche 3 T3-C, 2026-09-18), no longer a bare window global. ui.js's
  // switchSettingsTab reads it off the registry; the in-module callers
  // (the reset, Save All) call it directly.
  //
  // Two halves since 2026-09-25 (PR #1774 review): the per-device inputs,
  // and the company-wide ones. A company profile that lands AFTER the tab was
  // painted repaints only the company half (_repaintCompanyFromProfile) — it
  // used to re-run this whole loader, which silently put back the saved tier
  // rates / cost basis / markup over whatever the rep had typed there but not
  // yet saved, and those inputs never depended on the profile at all.
  function _loadEstimateDefaultsV2() {
    // Resolved (tenant county policy overlaid) — the permit/tax inputs below
    // must show COMPANY values, not this device's stale localStorage copy.
    const s = _v2ReadResolvedSettings();
    if (s) _paintDeviceEstimateInputs(s);
    _paintCompanyEstimateInputs(s);
  }

  // Per-device inputs: this device's saved engine settings (localStorage),
  // never the company profile — so nothing about a profile landing touches them.
  function _paintDeviceEstimateInputs(s) {
    const byId = (id) => document.getElementById(id);

    // Five tiers (2026-10-02). Defaults come from estimate-config.js, never
    // a literal here (the old 545/595/660 literals outlived the repricing).
    const _cfgRates = (window.NBD_ESTIMATE_CONFIG && window.NBD_ESTIMATE_CONFIG.TIER_RATES) || {};
    for (const [t, id] of [['economy', 'Economy'], ['good', 'Good'], ['better', 'Better'], ['best', 'Best'], ['beyond', 'Beyond']]) {
      if (byId('v2rate' + id)) byId('v2rate' + id).value = s.tierRates?.[t] ?? _cfgRates[t] ?? '';
      if (byId('v2cost' + id)) byId('v2cost' + id).value = s.costBasis?.[t] ?? 0;
    }

    if (byId('v2minJob'))   byId('v2minJob').value   = s.minJobCharge ?? 2500;
    if (byId('v2minRepair')) byId('v2minRepair').value = s.minRepairCharge ?? 0;
    if (byId('v2roundTo'))  byId('v2roundTo').value  = s.roundTo ?? 25;

    if (byId('v2matMarkup')) byId('v2matMarkup').value = Math.round((s.materialMarkupPct ?? 0.25) * 100);
    if (byId('v2overhead'))  byId('v2overhead').value  = Math.round((s.overheadPct ?? 0.10) * 100);
    if (byId('v2profit'))    byId('v2profit').value    = Math.round((s.profitPct ?? 0.10) * 100);

    if (byId('defDumpFee'))    byId('defDumpFee').value    = s.dumpFee ?? 550;
    if (byId('defExtraLayer')) byId('defExtraLayer').value = s.tearOffExtraPerSq ?? 50;
  }

  // The company-wide inputs this panel paints and Save All publishes to
  // companyProfile.pricing (the fallback tax rate, the 14 county permit/tax
  // inputs, the add-on rates), recorded by the last company paint so a late
  // landing can tell which of them the rep has typed into since.
  let _companyInputIds = [];

  // Company-wide inputs: county policy + fallback tax (resolved over the
  // tenant profile), My Jurisdictions, upgrade prices and add-on rates.
  // Called with no argument by a late profile landing.
  function _paintCompanyEstimateInputs(s) {
    if (s === undefined) s = _v2ReadResolvedSettings();
    _countyInputsResolved = !!s && window._companyProfileLoaded === true;
    _countyInputsKey = _countyInputsResolved ? _loadedProfileKey() : null;
    if (!s) return;
    const byId = (id) => document.getElementById(id);
    const ids = ['defTaxRate'];

    if (byId('defTaxRate'))    byId('defTaxRate').value    = ((s.fallbackTaxRate ?? 0.07) * 100).toFixed(2);

    // Permit costs
    const permits = s.permits || {};
    const permMap = {
      'permHamOh': 'hamilton-oh', 'permButOh': 'butler-oh',
      'permWarOh': 'warren-oh',   'permCleOh': 'clermont-oh',
      'permKenKy': 'kenton-ky',   'permBooKy': 'boone-ky',
      'permCamKy': 'campbell-ky'
    };
    Object.keys(permMap).forEach(id => {
      const el = byId(id);
      ids.push(id);
      if (el && permits[permMap[id]]) el.value = permits[permMap[id]].cost;
    });

    // County tax
    const tax = s.countyTax || {};
    const taxMap = {
      'taxHamOh': 'hamilton-oh', 'taxButOh': 'butler-oh',
      'taxWarOh': 'warren-oh',   'taxCleOh': 'clermont-oh',
      'taxKenKy': 'kenton-ky',   'taxBooKy': 'boone-ky',
      'taxCamKy': 'campbell-ky'
    };
    Object.keys(taxMap).forEach(id => {
      const el = byId(id);
      ids.push(id);
      if (el && tax[taxMap[id]] != null) el.value = (tax[taxMap[id]] * 100).toFixed(2);
    });

    // My Jurisdictions rows (county-jurisdiction settings, 2026-07-29) —
    // rendered fresh on every Estimates-tab open from the per-tenant
    // companyProfile.pricing.customJurisdictions map (NOT the localStorage
    // engine settings; companyProfile is the single store for custom rows).
    _renderJurisdictionRows();

    // Upgrade prices (Upgrades & Add-ons stage 2, 2026-09-25) repaint from
    // companyProfile.pricing.upgradePrices on every paint, like every other
    // input here. The module rides the same lazy estimates bundle as
    // EstimateBuilderV2, and carries its own hydration guard.
    //
    // The module can be MISSING when this runs (2026-09-25 review of PR
    // #1762): ui.js paints this tab as soon as EstimateBuilderV2 exists, but
    // the upgrade files sit at the END of that bundle, so a tab opened while
    // the bundle is still arriving — or after an upgrade file failed to
    // load — left an empty box, a dead Save and nothing to repaint it. Wait
    // for the bundle (loadBundle is deduped, and retries a file that failed)
    // and paint then; if the module still isn't there, say so.
    const _upgPaint = () => {
      const m = window.NBDUpgradePriceSettings;
      if (!m || typeof m.render !== 'function') return false;
      m.render();
      return true;
    };
    if (!_upgPaint()) {
      const _upgUnavailable = () => {
        const h = byId('upgPriceRows');
        if (!h || h.getAttribute('data-state') !== 'loading') return;
        h.setAttribute('data-state', 'unavailable');
        h.textContent = '';
        const p = document.createElement('p');
        p.className = 'upg-loading';
        p.textContent = 'Upgrade prices could not load. Reload the page to try again.';
        h.appendChild(p);
        const b = byId('upgPriceSave');
        if (b) b.disabled = true;
      };
      if (window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
        window.ScriptLoader.loadBundle('estimates').then(() => {
          // Only ever replaces the loading line — never rows someone may
          // already be typing in from a later paint.
          const h = byId('upgPriceRows');
          if (!h || h.getAttribute('data-state') !== 'loading') return;
          if (!_upgPaint()) _upgUnavailable();
        }, _upgUnavailable);
      } else {
        _upgUnavailable();
      }
    }

    // Catalog summary
    if (byId('v2matCount'))  byId('v2matCount').textContent  = (window.NBD_PRODUCTS || []).length;
    if (byId('v2labCount'))  byId('v2labCount').textContent  = (window.NBD_LABOR?.count) || 0;
    if (byId('v2xactCount')) byId('v2xactCount').textContent = (window.NBD_XACT_CATALOG?.count) || 0;

    // Add-on rates from the shop profile (companyProfile.pricing.addonPrices),
    // falling back to the estimate-config.js defaults. Shop-wide; written back by
    // _saveEstimateDefaultsV2 via _saveCompanyProfile.
    const cfg = window.NBD_ESTIMATE_CONFIG || {};
    const cpAddon = (window._companyProfile && window._companyProfile.pricing && window._companyProfile.pricing.addonPrices) || {};
    const addonField = (id, key, cfgKey, fb) => {
      ids.push(id);
      const el = byId(id); if (!el) return;
      const cp = cpAddon[key];
      el.value = (cp != null && cp !== '') ? cp : (cfgKey && cfg[cfgKey] != null ? cfg[cfgKey] : fb);
    };
    addonField('v2addonSteep',           'steepPerSq',           'ADDON_STEEP_PER_SQ',            25);
    addonField('v2addonVerySteep',       'verySteepPerSq',       'ADDON_VERY_STEEP_PER_SQ',       45);
    addonField('v2addonExtremeSteep',    'extremeSteepPerSq',    'ADDON_EXTREME_STEEP_PER_SQ',    75);
    addonField('v2addonTwoStory',        'twoStoryPerSq',        'ADDON_TWO_STORY_PER_SQ',        15);
    addonField('v2addonThreeStory',      'threeStoryPerSq',      'ADDON_THREE_STORY_PER_SQ',      30);
    addonField('v2addonCutUp',           'cutUpPerSq',           'ADDON_CUTUP_PER_SQ',            15);
    addonField('v2addonAccessModerate',  'accessModeratePerSq',  'ADDON_ACCESS_MODERATE_PER_SQ',  15);
    addonField('v2addonAccessDifficult', 'accessDifficultPerSq', 'ADDON_ACCESS_DIFFICULT_PER_SQ', 35);
    addonField('v2addonChimney',         'chimneyFlash',         'ADDON_CHIMNEY_FLASH',           425);
    addonField('v2addonSkylight',        'skylightFlash',        'ADDON_SKYLIGHT_FLASH',          350);
    addonField('v2addonPipeBoot',        'extraPipeBoot',        null,                            85);
    addonField('v2addonValleyLf',        'valleyMetalLf',        null,                            8.5);
    addonField('v2addonGuttersLf',       'guttersLf',            null,                            8.5);
    addonField('v2addonMatDelivery',     'matDelivery',          'ADDON_MAT_DELIVERY',            150);

    // Remember what each company input was painted with, so a late landing
    // can tell typing (value moved since) from a value it simply replaces.
    ids.forEach((id) => {
      const el = byId(id);
      if (el && typeof el.setAttribute === 'function') el.setAttribute('data-nbd-painted', String(el.value));
    });
    _companyInputIds = ids;
  }

  // Company inputs the rep has changed since they were painted.
  function _companyInputsEdited() {
    return _companyInputIds.filter((id) => {
      const el = document.getElementById(id);
      return !!el && typeof el.getAttribute === 'function'
        && el.getAttribute('data-nbd-painted') != null
        && String(el.value) !== el.getAttribute('data-nbd-painted');
    });
  }

  // ── My Jurisdictions (county-jurisdiction settings, 2026-07-29) ──
  // Per-tenant custom counties/cities: display name + permit cost (USD) +
  // tax rate (%). Stored ONLY in companyProfile/{companyId}
  // .pricing.customJurisdictions as { 'custom-<slug>': { name, cost, rate } }
  // (rate is a DECIMAL) — never in the localStorage nbd_est_settings_v3 patch
  // and never in userSettings.estimateSettingsV2 (write-only dead store).

  // Slug: 'custom-' + slugified name (lowercase, non-alphanumerics → '-',
  // trimmed, capped ~40 chars). A name with NO ASCII alphanumerics (all-CJK,
  // all-symbols) gets a stable hash-derived slug so the row is KEPT, not
  // silently dropped on save. Returns '' only for a blank name. Never emits a
  // bare '' and can never shadow a canonical slug (the 'custom-' prefix
  // guarantees it); '' stays reserved for "Other".
  function _jurSlugify(name) {
    const base = String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '');
    if (base) return 'custom-' + base;
    const s = String(name || '').trim();
    if (!s) return '';
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return 'custom-j' + h.toString(36);
  }

  function _renderJurisdictionRow(name, cost, ratePct) {
    const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
    const row = document.createElement('div');
    row.className = 'sf-row';
    row.setAttribute('data-jur-row', '');
    // Inputs are found by data attribute (rows repeat — no fixed ids). The
    // tenant-entered name is escaped into the value attribute (stored-XSS rule).
    row.innerHTML =
      '<div class="sf"><label>County / City Name</label><input type="text" data-jur-name maxlength="80" placeholder="e.g. Metro Nashville, TN" value="' + esc(name || '') + '"></div>' +
      '<div class="sf"><label>Permit Cost ($)</label><input type="number" data-jur-cost min="0" step="5" value="' + esc(cost != null ? cost : '') + '"></div>' +
      '<div class="sf"><label>Tax Rate %</label><input type="number" data-jur-rate min="0" step="0.01" value="' + esc(ratePct != null ? ratePct : '') + '"></div>' +
      '<div class="sf"><label>&nbsp;</label><button class="btn btn-ghost fs-11" type="button" data-action="call" data-fn="_removeJurisdictionRow" data-pass-el>✕ Remove</button></div>';
    return row;
  }

  // Did the rows on screen come FROM the hydrated tenant profile? Same idea as
  // _countyInputsResolved: the save full-replaces customJurisdictions with
  // whatever rows are in #jurRows, so it must know those rows are the
  // company's list and not a loading line (or a failure message) that a
  // profile landing a moment later has not repainted yet.
  let _jurRowsResolved = false;
  // Which tenant those rows were painted for — see _countyInputsKey.
  let _jurRowsKey = null;
  let _jurWaiting = false;

  // The tenant key whose SERVER copy of the company profile is in memory
  // (company-profile.js), or null: what a company paint records, and what
  // Save All compares that record with.
  function _loadedProfileKey() {
    return (typeof window._companyProfileLoadedKey === 'function') ? window._companyProfileLoadedKey() : null;
  }

  // Painted from a loaded profile, but not the one loaded NOW: the account's
  // company changed under this tab, and a re-read loaded the new one.
  function _paintedForAnotherTenant() {
    const now = _loadedProfileKey();
    return (_jurRowsResolved && _jurRowsKey !== now) || (_countyInputsResolved && _countyInputsKey !== now);
  }

  // The signed-in account changed (_bindCachesToSession): whatever this
  // panel shows was painted from the PREVIOUS account's company profile, so
  // none of it may be published for this one. Save All then skips the company
  // write, says so, and asks for this account's profile.
  // repaint (a new account signed in): take the previous account's company
  // values off the screen as well (2026-09-25, second review of #1774). The
  // company half is repainted from the just-reset profile: My Jurisdictions
  // and the upgrade prices show their loading lines and ask for this
  // account's profile, whose landing repaints them; the county, tax and
  // add-on inputs lose the previous company's rates. Only a panel that was
  // painted at all.
  function _forgetEstimatePanelPaint(repaint) {
    _jurRowsResolved = false;
    _countyInputsResolved = false;
    _jurRowsKey = null;
    _countyInputsKey = null;
    if (repaint && _companyInputIds.length) _paintCompanyEstimateInputs();
  }
  // The panel message's fade timer (#v2save-msg, one per page): Save All and
  // the late-landing notice below share it, so an earlier clean save's fade
  // can never blank a newer warning.
  let _v2SaveMsgTimer = null;

  // Save All's company writes are still out (no signal: they settle only on
  // the server's ack). Say so in the panel message — the device half is
  // already saved — until the final message replaces it.
  function _showCompanyWritePending() {
    const msg = document.getElementById('v2save-msg');
    if (!msg) return;
    msg.style.display = 'block';
    msg.textContent = '⏳ Saved on this device. Still sending your company’s county rates, jurisdictions and add-on rates — waiting for a connection. Keep this page open; this message changes once they are saved.';
    msg.setAttribute('data-kind', 'pending');
    msg.style.color = 'var(--m,#888)';
    clearTimeout(_v2SaveMsgTimer);
    _v2SaveMsgTimer = null;
  }

  // Ask for the profile read, and repaint the panel when it lands (2026-09-25,
  // lane profretry). This used to be a 500ms poll that only WATCHED
  // _companyProfileLoaded for 30s and then quit — but when the boot read gave
  // up nothing else would ever set the flag, so the tab said "Loading your
  // saved jurisdictions…" for good. _ensureCompanyProfile retries the read
  // with backoff (sharing the boot's run), and every call makes the next read
  // happen now, so opening this tab or pressing Save asks straight away.
  //
  // A landing — from this wait or from ANY other read (the online event, a
  // document generator's own load) — arrives as 'nbd:company-profile-loaded'.
  // Repaint every COMPANY input, not just these rows: the 14 canonical county
  // inputs (and the add-on rates) were also painted pre-hydration (from
  // factory / device values) and had no other refresh hook, so they stayed
  // stale until the tab was re-entered — and a Save then published those
  // stale numbers company-wide as a dot-path full replace. Only a panel still
  // showing the loading line or the failure message is repainted: anything
  // else was painted from the hydrated profile already and may hold typing.
  // No recursion risk: this pass sees _companyProfileLoaded === true, so it
  // starts no new wait.
  // A panel painted for ANOTHER tenant is repainted too (2026-09-25, second
  // review of #1774): the account's company changed under this tab, and this
  // landing is the new company's. Its rows and rates are not this company's,
  // and Save All would refuse them anyway; the rep is told if any typing goes.
  function _jurProfileLanded() {
    const h = document.getElementById('jurRows');
    if (!h || window._companyProfileLoaded !== true) return;
    if (!h.hasAttribute('data-jur-wait') && !_paintedForAnotherTenant()) return;
    _repaintCompanyFromProfile();
  }
  try { window.addEventListener('nbd:company-profile-loaded', _jurProfileLanded); } catch (_) { /* no event target */ }

  // A landing can now arrive at ANY point in the session (the online event,
  // another panel's read, the retry schedule), so it must not quietly undo
  // typing (2026-09-25, PR #1774 review: a rep's unsaved tier rate 777 and
  // cost 321 came back as 545 and 0, with no word). Only the company half is
  // repainted — the per-device inputs are left exactly as typed — and if the
  // rep had changed any company input since it was painted, those values are
  // replaced by the company's saved ones (they were never saveable while the
  // profile was missing), and the rep is told so, in the message that stays.
  function _repaintCompanyFromProfile() {
    const replaced = _companyInputsEdited().length;
    _paintCompanyEstimateInputs();
    if (replaced) _noticeCompanyValuesReplaced(replaced);
  }

  function _noticeCompanyValuesReplaced(n) {
    const what = n === 1 ? 'a county, tax or add-on rate' : n + ' county, tax or add-on rates';
    const msg = document.getElementById('v2save-msg');
    if (msg) {
      msg.style.display = 'block';
      msg.textContent = '⚠ Your company’s saved rates just loaded and replaced ' + what
        + ' you had changed here. Those are company-wide: make the change again, then press Save. Your other settings are as you left them.';
      msg.setAttribute('data-kind', 'warn');
      msg.style.color = 'var(--orange,#e8720c)';
      clearTimeout(_v2SaveMsgTimer);
      _v2SaveMsgTimer = null;
    }
    if (typeof showToast === 'function') showToast('⚠ Company rates loaded — make your ' + (n === 1 ? 'change' : n + ' changes') + ' to them again', 'info');
  }

  // "↻ Try again" on the failure message: ask for the read again, with only
  // the jurisdiction box going back to "Loading…". It used to re-run the
  // whole loader, which also put back every per-device input over unsaved
  // typing. (Landed meanwhile: repaint the company half now.)
  function _retryJurisdictions() {
    if (window._companyProfileLoaded === true) { _repaintCompanyFromProfile(); return; }
    _renderJurisdictionRows();
  }

  function _waitForJurisdictions() {
    const ensure = (typeof window._ensureCompanyProfile === 'function')
      ? window._ensureCompanyProfile
      : () => Promise.resolve(typeof window._loadCompanyProfile === 'function' ? window._loadCompanyProfile() : null)
        .then(() => window._companyProfileLoaded === true);
    let p;
    try { p = ensure(); } catch (_) { p = null; }
    if (_jurWaiting) return;
    _jurWaiting = true;
    // The run gave up (or the landing event never came): say so, and offer
    // the retry, rather than leave "Loading…" up for good.
    const settle = () => {
      _jurWaiting = false;
      const h = document.getElementById('jurRows');
      if (!h || h.getAttribute('data-jur-wait') !== 'loading') return;
      if (window._companyProfileLoaded === true) { _jurProfileLanded(); return; }
      h.setAttribute('data-jur-wait', 'failed');
      h.innerHTML = '<div class="fs-11 dbx-corange-p6px2px" data-jur-failed>'
        + 'Your saved jurisdictions did not load, so they can\'t be changed right now. Check your connection, then try again.</div>'
        + '<button class="btn btn-ghost fs-11" type="button" data-action="call" data-fn="_retryJurisdictions">↻ Try again</button>';
    };
    Promise.resolve(p).then(settle, settle);
  }

  function _renderJurisdictionRows() {
    const host = document.getElementById('jurRows');
    if (!host) return;
    if (window._companyProfileLoaded !== true) {
      // companyProfile still hydrating (fresh device / slow network / a boot
      // read that gave up): render a placeholder, ask for the read, and
      // re-render when it lands. Saving is gated on _jurRowsResolved, so a
      // pre-hydration empty list can never be persisted as a tenant-wide wipe.
      _jurRowsResolved = false;
      _jurRowsKey = null;
      host.setAttribute('data-jur-wait', 'loading');
      host.innerHTML = '<div class="fs-11 dbx-cm-p6px2px">Loading your saved jurisdictions…</div>';
      _waitForJurisdictions();
      return;
    }
    host.removeAttribute('data-jur-wait');
    _jurRowsResolved = true;
    _jurRowsKey = _loadedProfileKey();
    host.innerHTML = '';
    const cj = (window._companyProfile
      && window._companyProfile.pricing
      && window._companyProfile.pricing.customJurisdictions) || {};
    Object.keys(cj).forEach(slug => {
      const e = cj[slug];
      if (!slug || !e || typeof e !== 'object') return;
      const rate = Number(e.rate);
      const ratePct = (e.rate != null && e.rate !== '' && Number.isFinite(rate)) ? (rate * 100).toFixed(2) : null;
      const cost = Number(e.cost);
      const costVal = (e.cost != null && e.cost !== '' && Number.isFinite(cost)) ? cost : null;
      host.appendChild(_renderJurisdictionRow(typeof e.name === 'string' ? e.name : '', costVal, ratePct));
    });
  }

  const _addJurisdictionRow = function() {
    const host = document.getElementById('jurRows');
    if (!host) return;
    // A row typed next to "Loading…" could never be saved (the save needs the
    // company's list on screen to replace it with), and the repaint when the
    // profile lands would wipe it. Say so instead of taking the typing
    // (2026-09-25, lane profretry).
    // (Loaded since the tab painted: paint the company's list first, then add.)
    if (!_jurRowsResolved && window._companyProfileLoaded === true) _repaintCompanyFromProfile();
    if (!_jurRowsResolved) {
      if (typeof showToast === 'function') showToast('Your saved jurisdictions are still loading — add one once they appear.', 'info');
      _renderJurisdictionRows();
      return;
    }
    host.appendChild(_renderJurisdictionRow('', null, null));
    const inp = host.lastElementChild && host.lastElementChild.querySelector('[data-jur-name]');
    if (inp) inp.focus();
  };

  const _removeJurisdictionRow = function(el) {
    const row = el && el.closest ? el.closest('[data-jur-row]') : null;
    if (row) row.remove();
  };

  // Read the rows container into the COMPLETE customJurisdictions map.
  // Returns null when the container isn't in the DOM (defensive — the save
  // button lives in the same hydrated panel).
  function _collectJurisdictionRows() {
    const host = document.getElementById('jurRows');
    if (!host) return null;
    const map = {};
    host.querySelectorAll('[data-jur-row]').forEach(row => {
      const nameEl = row.querySelector('[data-jur-name]');
      const costEl = row.querySelector('[data-jur-cost]');
      const rateEl = row.querySelector('[data-jur-rate]');
      const name = String((nameEl && nameEl.value) || '').trim();
      if (!name) return;                    // blank row — ignore
      const base = _jurSlugify(name);
      if (!base) return;                    // name has no sluggable characters
      let slug = base, n = 2;
      while (map[slug]) { slug = base + '-' + n; n++; }
      const cost = parseFloat(costEl && costEl.value);
      const ratePct = parseFloat(rateEl && rateEl.value);
      map[slug] = {
        name,
        // Blank/garbage numbers persist as null — the engine overlay drops
        // them so the default permit ($150) / fallback tax stand (never a
        // silent $0, the L-1 class).
        cost: (Number.isFinite(cost) && cost >= 0) ? cost : null,
        rate: (Number.isFinite(ratePct) && ratePct >= 0) ? (ratePct / 100) : null
      };
    });
    return map;
  }

  // Save every v2 engine setting from the Estimates tab form
  window._saveEstimateDefaultsV2 = async function() {
    // Honest-save flags: the success message below must not claim a sync
    // that was skipped (profile not hydrated) or that threw (caught below).
    let jurSaveSkipped = false;
    let pricingSaveFailed = false;
    let pricingSaveDenied = false;
    let countySaveSkipped = false;
    let upgradeSaveSkipped = false;
    // Upgrade-price edits left out because the profile in memory is not this
    // tenant's; and whether that is why the company write was skipped.
    let upgradeHeldBack = false;
    let tenantMismatch = false;
    // The "still sending" notice's timer (see the company writes below).
    let companyWritePending = null;
    const byId = (id) => document.getElementById(id);
    const num = (id, fallback) => {
      const v = parseFloat(byId(id)?.value);
      return isNaN(v) ? fallback : v;
    };

    // Five tiers (2026-10-02); fallbacks from estimate-config.js. The saved
    // rates carry the config's rate generation so loadSettings honours them
    // (and drops any saved under an older one).
    const _cfg = window.NBD_ESTIMATE_CONFIG || {};
    const _cfgRates = _cfg.TIER_RATES || {};
    const _tierIds = [['economy', 'Economy'], ['good', 'Good'], ['better', 'Better'], ['best', 'Best'], ['beyond', 'Beyond']];
    const patch = {
      tierRates: Object.fromEntries(_tierIds.map(([t, id]) => [t, num('v2rate' + id, _cfgRates[t])])),
      tierRatesVersion: _cfg._ratesVersion || null,
      // 0 = not configured (EBv2 ships zero defaults on purpose — real
      // cost basis is tenant data, never published in the public tree)
      costBasis: Object.fromEntries(_tierIds.map(([t, id]) => [t, num('v2cost' + id, 0)])),
      minJobCharge: num('v2minJob', 2500),
      roundTo: num('v2roundTo', 25),
      minRepairCharge: num('v2minRepair', 0),
      materialMarkupPct: num('v2matMarkup', 25) / 100,
      overheadPct: num('v2overhead', 10) / 100,
      profitPct: num('v2profit', 10) / 100,
      dumpFee: num('defDumpFee', 550),
      tearOffExtraPerSq: num('defExtraLayer', 50),
      fallbackTaxRate: num('defTaxRate', 7) / 100
    };

    // Permit map
    const current = _v2ReadSettings() || {};
    patch.permits = Object.assign({}, current.permits);
    const permMap = {
      'permHamOh': { key: 'hamilton-oh', name: 'Hamilton County, OH' },
      'permButOh': { key: 'butler-oh',   name: 'Butler County, OH' },
      'permWarOh': { key: 'warren-oh',   name: 'Warren County, OH' },
      'permCleOh': { key: 'clermont-oh', name: 'Clermont County, OH' },
      'permKenKy': { key: 'kenton-ky',   name: 'Kenton County, KY' },
      'permBooKy': { key: 'boone-ky',    name: 'Boone County, KY' },
      'permCamKy': { key: 'campbell-ky', name: 'Campbell County, KY' }
    };
    Object.keys(permMap).forEach(id => {
      const v = num(id, null);
      if (v != null) patch.permits[permMap[id].key] = { name: permMap[id].name, cost: v };
    });

    // County tax
    patch.countyTax = Object.assign({}, current.countyTax);
    const taxMap = {
      'taxHamOh': 'hamilton-oh', 'taxButOh': 'butler-oh',
      'taxWarOh': 'warren-oh',   'taxCleOh': 'clermont-oh',
      'taxKenKy': 'kenton-ky',   'taxBooKy': 'boone-ky',
      'taxCamKy': 'campbell-ky'
    };
    Object.keys(taxMap).forEach(id => {
      const v = num(id, null);
      if (v != null) patch.countyTax[taxMap[id]] = v / 100;
    });

    // Apply locally (flows through EstimateBuilderV2.updateSettings → localStorage)
    _v2WriteSettings(patch);

    // Sync to Firestore for cross-device. NOT awaited (2026-09-25, PR #1774
    // review): a Firestore write settles only when the server acks it, so on
    // a phone with no signal this await held back everything below — the
    // rep pressed Save All and saw nothing at all, not even the "NOT saved
    // for your company" warning, until the connection came back. The SDK
    // queues the write and sends it on reconnect; nothing below reads it, and
    // a failure was only ever logged.
    try {
      if (window._db && window._user) {
        const { setDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        Promise.resolve(setDoc(
          doc(window._db, 'userSettings', window._user.uid),
          { estimateSettingsV2: patch, updatedAt: new Date().toISOString() },
          { merge: true }
        )).catch((e) => { console.warn('Firestore sync failed:', e); });
      }
    } catch (e) { console.warn('Firestore sync failed:', e); }

    // Add-on rates → shop-wide companyProfile.pricing.addonPrices (estimate-qa-2026-06-08).
    // num() returns the config fallback for a blank field; applyCompanyPricing also
    // sanitizes non-numbers, so a blank never silently zeroes a charge.
    try {
      if (typeof window._saveCompanyProfile === 'function') {
        const addonPrices = {
          steepPerSq:           num('v2addonSteep', 25),
          verySteepPerSq:       num('v2addonVerySteep', 45),
          extremeSteepPerSq:    num('v2addonExtremeSteep', 75),
          twoStoryPerSq:        num('v2addonTwoStory', 15),
          threeStoryPerSq:      num('v2addonThreeStory', 30),
          cutUpPerSq:           num('v2addonCutUp', 15),
          accessModeratePerSq:  num('v2addonAccessModerate', 15),
          accessDifficultPerSq: num('v2addonAccessDifficult', 35),
          chimneyFlash:         num('v2addonChimney', 425),
          skylightFlash:        num('v2addonSkylight', 350),
          extraPipeBoot:        num('v2addonPipeBoot', 85),
          valleyMetalLf:        num('v2addonValleyLf', 8.5),
          guttersLf:            num('v2addonGuttersLf', 8.5),
          matDelivery:          num('v2addonMatDelivery', 150)
        };
        // My Jurisdictions rows ride the same per-tenant save (county-
        // jurisdiction settings, 2026-07-29). NOT added to the localStorage
        // patch above — companyProfile is the single store for custom rows.
        // GATED on hydration: before _loadCompanyProfile's getDoc lands, the
        // rows container holds only a placeholder, and persisting that empty
        // collection would FULL-REPLACE the field below — wiping every
        // jurisdiction for the whole tenant from one stale device.
        // And the profile in memory must be the SERVER copy of the tenant
        // this save lands on (2026-09-25, PR #1774 review): the key is
        // resolved ONCE here for every company write below, and it must be
        // the key that copy was loaded for. After an account switch in this
        // tab the flag said "loaded" over the previous account's profile, and
        // the full-replace below landed that account's rows (or none) on the
        // new account's company.
        const companyKey = (typeof window._resolveCompanyKey === 'function')
          ? await window._resolveCompanyKey()
          : ((window._userClaims && window._userClaims.companyId) || (window._user && window._user.uid) || null);
        const loadedKey = (typeof window._companyProfileLoadedKey === 'function') ? window._companyProfileLoadedKey() : undefined;
        const profileLoaded = window._companyProfileLoaded === true;
        // (No key at all — auth not ready — writes nothing: _saveCompanyProfile
        // skips a keyless save too, and so does the full-replace below.)
        tenantMismatch = profileLoaded && companyKey != null && loadedKey !== undefined && loadedKey !== String(companyKey);
        const profileReady = profileLoaded && companyKey != null && !tenantMismatch;
        // Painted for THAT key, too (2026-09-25, second review of #1774).
        // profileReady says the server copy in memory is companyKey's; the
        // panel may still show another tenant's — the same account's company
        // changed under this tab and a re-read loaded the new one — and the
        // resolved flags below only say it was painted from some loaded profile.
        // Published, that was the previous company's rows and rates as a full
        // replace of this one's (reproduced on the rig). (No key function —
        // an older company-profile.js — leaves the flags to decide, as before.)
        const paintedHere = (k) => loadedKey === undefined || (k != null && k === loadedKey);
        // The rows must also have been PAINTED from that profile (2026-09-25,
        // lane profretry): between a profile landing and the panel repainting,
        // #jurRows can still hold the loading line — collecting it would
        // full-replace the company's list with nothing.
        const jurReady = profileReady && _jurRowsResolved && paintedHere(_jurRowsKey);
        if (!jurReady) jurSaveSkipped = true;
        // The 14 canonical county inputs may have been PAINTED before the tenant
        // profile landed (fresh device / cleared cache / slow network), and
        // _loadEstimateDefaultsV2 is what records whether they were. Publishing
        // stale inputs would dot-path FULL-REPLACE company county money with
        // factory values for every rep — profileReady alone does not catch that,
        // because it only says the profile is hydrated NOW, at save time.
        const countyReady = profileReady && _countyInputsResolved && paintedHere(_countyInputsKey);
        if (!countyReady) countySaveSkipped = true;
        // The add-on rate inputs are painted in that SAME _loadEstimateDefaultsV2
        // pass, from window._companyProfile — before hydration that is this
        // device's cache or the config defaults. Every key goes out through a
        // merge write, so publishing them un-hydrated overwrote the company's
        // add-on rates just as surely (2026-09-25, lane profretry). Same gate.
        const addonReady = countyReady;
        const customJurisdictions = jurReady ? _collectJurisdictionRows() : null;
        const prevJurSlugs = Object.keys((window._companyProfile
          && window._companyProfile.pricing
          && window._companyProfile.pricing.customJurisdictions) || {});
        const pricing = {};
        if (addonReady) pricing.addonPrices = addonPrices;
        if (customJurisdictions) pricing.customJurisdictions = customJurisdictions;
        // Upgrade prices ride the same company write (2026-09-25), so Save
        // All never silently discards an edit made in that panel — the
        // NEW-D43a class. collect() is null unless the panel was painted
        // from the hydrated profile by someone who may write it; a bad
        // price leaves them all out and the message below says so.
        // ONLY the entries edited on this device since the paint
        // (upg.changes) are written: the full map from a device painted
        // hours ago put back prices another device had saved since
        // (2026-09-25 review of PR #1762), and an untouched panel now adds
        // nothing to this write at all.
        const upg = (window.NBDUpgradePriceSettings && typeof window.NBDUpgradePriceSettings.collect === 'function')
          ? window.NBDUpgradePriceSettings.collect() : null;
        if (upg && upg.errors && upg.errors.length) upgradeSaveSkipped = true;
        else if (upg && upg.changes && Object.keys(upg.changes).length) {
          // Never onto a company whose profile is not the one in memory.
          if (profileReady) pricing.upgradePrices = upg.changes;
          else upgradeHeldBack = true;
        }
        // County policy is per-TENANT (migrated off per-device localStorage
        // 2026-07-29). patch.permits / patch.countyTax were just built from the
        // 14 inputs above; the same values go to companyProfile so every rep and
        // device prices identically. fallbackTaxRate rides along — it is the
        // blank-county rate, meaningless as a per-device preference.
        if (countyReady) {
          pricing.permits = patch.permits;
          pricing.countyTax = patch.countyTax;
          pricing.fallbackTaxRate = patch.fallbackTaxRate;
        }
        // The company writes below settle only when the server acks them, so
        // with no signal the rep saw nothing at all until the connection came
        // back (2026-09-25, second review of #1774). Say what is happening if
        // they are still out after a moment; the final message replaces it.
        companyWritePending = setTimeout(_showCompanyWritePending, 2500);
        // Each await below can outlast the session that started it (offline,
        // until reconnect). Whatever lands after one reconciles only the
        // in-memory profile — and the upgrade panel's baseline — of the
        // tenant it was written to, never an account that signed in since.
        const stillThisTenant = () => loadedKey === undefined || _loadedProfileKey() === String(companyKey);
        // Nothing hydrated to publish: skip the write rather than send an
        // empty one (offline, it would only turn the skip into a "sync failed").
        if (Object.keys(pricing).length) await window._saveCompanyProfile({ pricing });
        // Those upgrade entries are saved: a second press must not resend
        // them over a newer save from another device.
        if (pricing.upgradePrices && stillThisTenant() && typeof window.NBDUpgradePriceSettings?.markSaved === 'function') {
          window.NBDUpgradePriceSettings.markSaved(pricing.upgradePrices);
        }
        // FULL-REPLACE the customJurisdictions field. _saveCompanyProfile
        // deep-merges (cache) and setDoc({merge:true}) merges nested map keys
        // on the server — either would silently RESURRECT deleted rows. An
        // updateDoc at the dot-notation field path replaces the map wholesale
        // so removal sticks; then reconcile the in-memory profile (and, when
        // rows were actually deleted, re-pull so the tenant cache matches).
        if (customJurisdictions && window._db && window._user) {
          const removed = prevJurSlugs.filter(k => !(k in customJurisdictions));
          const { updateDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
          // companyKey (above) comes from the SAME helper _saveCompanyProfile
          // uses — a divergent key would land the merge-write and the
          // full-replace on different docs (deleted rows resurrect, save
          // reads as success).
          if (companyKey) {
            // The canonical county maps get the same full-replace treatment so
            // a later reset (which writes {}) actually CLEARS them instead of
            // merging into the previous values.
            const replace = { 'pricing.customJurisdictions': customJurisdictions };
            if (countyReady) {
              replace['pricing.permits'] = patch.permits;
              replace['pricing.countyTax'] = patch.countyTax;
            }
            await updateDoc(doc(window._db, 'companyProfile', String(companyKey)), replace);
            if (stillThisTenant() && window._companyProfile && window._companyProfile.pricing) {
              window._companyProfile.pricing.customJurisdictions = Object.assign({}, customJurisdictions);
              if (countyReady) {
                window._companyProfile.pricing.permits = Object.assign({}, patch.permits);
                window._companyProfile.pricing.countyTax = Object.assign({}, patch.countyTax);
                window._companyProfile.pricing.fallbackTaxRate = patch.fallbackTaxRate;
              }
            }
            if (removed.length && typeof window._loadCompanyProfile === 'function') {
              await window._loadCompanyProfile();
            }
          }
        }
      }
    } catch (e) {
      console.warn('Add-on rates / jurisdictions save failed:', e);
      pricingSaveFailed = true;
      pricingSaveDenied = _pricingDenied(e);
    }
    clearTimeout(companyWritePending);

    // A company write skipped for want of a hydrated panel must be SEEN, and
    // must not leave the rep stuck (2026-09-25, lane profretry). It used to
    // read "✓ … saved on this device", in the success green, for five
    // seconds, under a "✓ Estimate settings saved" toast — easy to take for
    // a full save. Now it is a warning that stays up, and the tab gets the
    // company's values in front of the rep: repainted now if the profile has
    // landed since the paint, otherwise the read is asked for again and the
    // panel repaints when it lands.
    const companySkipped = !pricingSaveFailed && (jurSaveSkipped || countySaveSkipped);
    let companyShownNow = false;
    if (companySkipped) {
      // The profile in memory belongs to another tenant (the account changed
      // under this tab): forget it rather than repaint from it, and ask for
      // this tenant's — the panel repaints when it lands.
      if (tenantMismatch && typeof window._resetCompanyProfile === 'function') window._resetCompanyProfile();
      if (window._companyProfileLoaded === true) { _loadEstimateDefaultsV2(); companyShownNow = true; }
      else _renderJurisdictionRows();
    }
    const msg = document.getElementById('v2save-msg');
    if (msg) {
      msg.style.display = 'block';
      msg.textContent = pricingSaveFailed
        ? (pricingSaveDenied
            ? '⚠ Saved on this device only. County rates and add-on pricing are company-wide — ask an owner or company admin to change them.'
            : '⚠ Rates saved on this device, but the company pricing sync failed — check your connection and press Save again.')
        : companySkipped
          ? (companyShownNow
              ? '⚠ Saved on this device only. County rates, jurisdictions and add-on rates were NOT saved for your company: this tab was showing them from before your company settings loaded. It now shows the company\'s saved values — make those changes again and press Save.'
              : '⚠ Saved on this device only. Your company\'s county rates, jurisdictions and add-on rates have not loaded, so they were NOT saved for your company. Loading them again now — once they appear, make those changes again and press Save.')
            + (upgradeSaveSkipped ? ' Upgrade prices were not saved either — fix the highlighted price.'
              : upgradeHeldBack ? ' Your upgrade price changes were not saved either.' : '')
          : upgradeSaveSkipped
            ? '⚠ Estimate settings saved, but NOT the upgrade prices — fix the highlighted upgrade price and save again.'
            : '✓ Estimate settings saved. Every linked estimate will use these rates.';
      const warn = pricingSaveFailed || companySkipped || upgradeSaveSkipped;
      msg.setAttribute('data-kind', warn ? 'warn' : 'ok');
      msg.style.color = warn ? 'var(--orange,#e8720c)' : '#4caf82';
      // A warning stays until the next save; only a clean save fades. One
      // timer, so an earlier save's fade can't blank a newer warning.
      clearTimeout(_v2SaveMsgTimer);
      _v2SaveMsgTimer = warn ? null : setTimeout(() => { msg.style.display = 'none'; }, 5000);
    }
    if (typeof showToast === 'function') {
      showToast(pricingSaveFailed ? '⚠ Company pricing sync failed — Save again'
        : companySkipped ? '⚠ Company rates not saved — they had not loaded'
          : upgradeSaveSkipped ? '⚠ Upgrade prices not saved — fix the highlighted price'
            : '✓ Estimate settings saved',
        (pricingSaveFailed || companySkipped || upgradeSaveSkipped) ? 'info' : 'success');
    }
  };

  // Batch 2 (iOS PWA): standalone-compat.js replaces window.confirm with a
  // toast that ALWAYS returns true, so in the installed app a native confirm()
  // is not a gate at all — this company-wide wipe would just fire. nbdConfirm
  // (defined only in standalone mode) returns a real Promise<boolean> from a
  // modal; the fallback keeps native confirm on desktop. Same shape as the
  // primary-estimate prompts above.
  const _resetEstimateDefaultsV2 = async function() {
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (!(await _ask('Reset all estimate settings to factory defaults? County permit costs and tax rates are COMPANY-wide, so this resets them for every rep. This cannot be undone.'))) return;
    const EB2 = window.EstimateBuilderV2;
    if (!EB2) return;
    const defaults = EB2.getDefaultSettings();
    EB2.saveSettings(defaults);

    // Clearing localStorage alone would be cosmetic for counties: the tenant
    // overlay re-applies the company's saved values on the very next calc, so
    // "reset to factory defaults" has to clear the per-tenant county maps too.
    // Gated on a hydrated profile — never write a wipe from a stale page.
    let tenantResetFailed = false;
    let tenantResetErr = null;
    // Hydrated FOR THE TENANT THE RESET LANDS ON (2026-09-25, second review
    // of #1774). The flag alone let the wipe go to the resolved key while the
    // profile in memory was another tenant's (the account's company changed
    // under this tab): it cleared the new company's county rates, then wrote
    // {} into the OLD company's in-memory copy under a flag still naming it.
    // Now a mismatch resets nothing company-wide, forgets the other tenant's
    // copy, and the repaint below asks for this one's.
    let resetHere = false;
    let companyKey = null;
    if (window._companyProfileLoaded === true && window._db && window._user) {
      companyKey = (typeof window._resolveCompanyKey === 'function')
        ? await window._resolveCompanyKey()
        : ((window._userClaims && window._userClaims.companyId) || window._user.uid);
      const loadedKey = (typeof window._companyProfileLoadedKey === 'function') ? window._companyProfileLoadedKey() : undefined;
      resetHere = companyKey != null && (loadedKey === undefined || loadedKey === String(companyKey));
      if (!resetHere && companyKey != null && typeof window._resetCompanyProfile === 'function') window._resetCompanyProfile();
    }
    if (resetHere) {
      try {
        const { updateDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        await updateDoc(doc(window._db, 'companyProfile', String(companyKey)), {
          'pricing.permits': {},
          'pricing.countyTax': {},
          'pricing.fallbackTaxRate': null,
        });
        // Only into THAT tenant's copy: the account can change while the
        // write is out (offline, until reconnect).
        const loadedNow = (typeof window._companyProfileLoadedKey === 'function') ? window._companyProfileLoadedKey() : undefined;
        if ((loadedNow === undefined || loadedNow === String(companyKey)) && window._companyProfile && window._companyProfile.pricing) {
          window._companyProfile.pricing.permits = {};
          window._companyProfile.pricing.countyTax = {};
          window._companyProfile.pricing.fallbackTaxRate = null;
        }
      } catch (e) {
        tenantResetFailed = true;
        tenantResetErr = e;
        console.warn('[estimate-settings] tenant county reset failed:', e && e.message);
      }
      // A tenant that never saved a company profile has no doc, so the dot-path
      // updateDoc rejects NOT_FOUND — but there is nothing to clear, so that IS
      // success. Only a real failure should be reported to the user.
      if (tenantResetFailed && /not-found|NOT_FOUND/i.test(String((tenantResetErr && (tenantResetErr.code || tenantResetErr.message)) || ''))) {
        tenantResetFailed = false;
        tenantResetErr = null;
      }
    }

    // Signed in, but the company profile never loaded: the company rates were
    // left alone by the gate above. Say so — "Reset to factory defaults" read
    // as done while every estimate kept pricing from the company's saved
    // county rates (2026-09-25, lane profretry). The repaint below asks for
    // the profile read again. Same when the profile in memory was another
    // tenant's (resetHere false with the flag up, just forgotten above).
    const tenantResetSkipped = !tenantResetFailed && !resetHere && !!(window._db && window._user);

    _loadEstimateDefaultsV2();
    if (typeof showToast === 'function') {
      showToast(tenantResetSkipped
        ? '↺ Reset on this device. Company county rates had not loaded, so they were NOT reset — try again once they appear.'
        : !tenantResetFailed
          ? '↺ Reset to factory defaults'
          : _pricingDenied(tenantResetErr)
            ? '↺ Reset on this device. Company county rates are owner/admin-only.'
            : '↺ Reset on this device — company county rates could not be reset. Try again.',
        (tenantResetFailed || tenantResetSkipped) ? 'info' : 'success');
    }
  };

  // Legacy stubs kept for backwards compat with any other caller
  window._saveEstimateDefaults = function() { return window._saveEstimateDefaultsV2(); };
  // (The load-side twin, _loadEstimateDefaults, was deleted in Globals
  // Tranche 3 T3-C, 2026-09-18: zero readers repo-wide, and keeping it would
  // have left _loadEstimateDefaultsV2 reachable off window under an alias.)

  // ═════════════════════════════════════════════════════════
  // COMPANY SETTINGS
  // ═════════════════════════════════════════════════════════
  const CO_FIELDS = [
    'coName','coDba','coEin','coState','coPhone','coEmail','coAddress','coCity',
    'coWebsite','coGbp','coLicOh','coLicKy','coGl','coWc','coGaf','coCerts',
    'coTerritory','coRadius'
  ];

  const _saveCompanySettings = async function() {
    const data = {};
    CO_FIELDS.forEach(f => {
      const el = document.getElementById(f);
      if (el) data[f] = el.value || '';
    });
    try { localStorage.setItem('nbd_company_settings', JSON.stringify(data)); } catch(e){}
    try {
      if (window._db && window._user) {
        const { setDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        await setDoc(
          doc(window._db, 'userSettings', window._user.uid),
          { company: data, updatedAt: new Date().toISOString() },
          { merge: true }
        );
      }
    } catch (e) { console.warn('Company settings Firestore sync failed:', e); }

    const msg = document.getElementById('co-save-msg');
    if (msg) {
      msg.style.display = 'block';
      msg.textContent = '✓ Company info saved';
      setTimeout(() => msg.style.display = 'none', 3000);
    }
    if (typeof showToast === 'function') showToast('✓ Company info saved', 'success');
  };

  async function _loadCompanySettings() {
    let data = {};
    try {
      const raw = localStorage.getItem('nbd_company_settings');
      if (raw) data = JSON.parse(raw);
    } catch(e){}

    // Firestore wins if present
    try {
      if (window._db && window._user) {
        const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        const snap = await getDoc(doc(window._db, 'userSettings', window._user.uid));
        if (snap.exists() && snap.data().company) {
          data = Object.assign({}, data, snap.data().company);
        }
      }
    } catch (e) {}

    CO_FIELDS.forEach(f => {
      const el = document.getElementById(f);
      if (el && data[f] != null) el.value = data[f];
    });
  };

  // ═════════════════════════════════════════════════════════
  // COMPANY PROFILE — doc-constants editable from Settings UI
  // (legal text, financing tiers, marketing copy, code refs)
  // Backed by Firestore singleton `companyProfile/main` via
  // company-profile.js. _loadCompanyProfile() runs on boot, this
  // tab just populates form fields from window._companyProfile.
  // ═════════════════════════════════════════════════════════
  const _CP_LEGAL_FIELDS = [
    'cancellationWindowText','cancellationStatute',
    'cancellationContractClause','cancellationProposalShort',
    'changeOrderClause','changeOrderClauseShort',
    'disputeResolutionClause','entireAgreementClause',
    'paymentTermsContract','paymentTermsProposal','paymentMethodsNoCash',
    'materialsWarrantyDisclaimer','limitationOfLiability','latePaymentChargeText',
    'proposalValidityDays'
  ];
  const _CP_MARKETING_FIELDS = ['tagline','serviceArea','financePartner','codeCycle','codeJurisdiction'];
  const _CP_LETTERHEAD_FIELDS = ['businessName','businessPhone','businessEmail','businessWebsite','businessAddress','businessLicense'];

  // Brand Identity sub-panel (gauntlet Batch 3). An <input type="color"> always
  // reports a value, so — mirroring onboarding.js state.colorsTouched — we only
  // persist brand.colors once the user deliberately moves a swatch. Reset false
  // on every populate; flipped true by the 'input' listener wired in
  // _cpWireColorInputs().
  let _cpColorsTouched = false;

  // Wire the two Brand-Identity color <input>s once. A real 'input' listener
  // (not an inline oninput — CSP forbids it on /pro pages) flips _cpColorsTouched
  // so a deliberate swatch move is written while an untouched picker never is.
  function _cpWireColorInputs() {
    ['cp_brand_colorPrimary', 'cp_brand_colorAccent'].forEach(id => {
      const el = document.getElementById(id);
      if (el && !el.dataset.cpWired) {
        el.dataset.cpWired = '1';
        el.addEventListener('input', () => { _cpColorsTouched = true; });
      }
    });
  }

  // FIX 1 (gauntlet Batch 3) — diff-against-default. The form is pre-populated
  // from the MERGED profile (NBD defaults + overrides), so a stranger who opens
  // the panel and clicks Save would otherwise freeze NBD's Kentucky statute,
  // 'NBD' party-name clauses, and 'No Big Deal' marketing copy into their doc as
  // explicit overrides — defeating window._legal()'s default-side neutralization
  // forever. Strip every field still equal to its NBD default so only genuine
  // edits are written; untouched fields stay absent and fall through to defaults.
  // For NBD (merged==defaults) this empties `out`, so the stored doc and rendered
  // output stay byte-identical. Mutates + returns `out`. (Editing a
  // previously-custom field back to the exact default won't clear the old stored
  // override under merge:true — accepted edge for now.)
  function _cpStripDefaults(out, defaults) {
    _CP_LEGAL_FIELDS.concat(_CP_MARKETING_FIELDS).concat(_CP_LETTERHEAD_FIELDS).forEach(k => {
      if (!(k in out)) return;
      const dv = defaults[k];
      if (k === 'proposalValidityDays') {
        if (Number(out[k]) === Number(dv)) delete out[k];
      } else if (String(out[k]) === String(dv == null ? '' : dv)) {
        delete out[k];
      }
    });
    ['financingTiers', 'services', 'valueProps', 'budgetDefaults'].forEach(k => {
      if (!(k in out)) return;
      try {
        if (JSON.stringify(out[k]) === JSON.stringify(defaults[k])) delete out[k];
      } catch (_) { /* keep on compare failure */ }
    });
    return out;
  }

  function _cpReadFormToProfile() {
    const defaults = window.NBD_COMPANY_PROFILE_DEFAULTS || {};
    const out = {};
    _CP_LEGAL_FIELDS.concat(_CP_MARKETING_FIELDS).concat(_CP_LETTERHEAD_FIELDS).forEach(k => {
      const el = document.getElementById('cp_' + k);
      if (!el) return;
      const v = el.value;
      if (k === 'proposalValidityDays') {
        const n = parseInt(v, 10);
        out[k] = Number.isFinite(n) && n > 0 ? n : (defaults[k] || 30);
      } else {
        out[k] = v == null ? '' : String(v);
      }
    });
    // Financing tiers — 3 fixed slots.
    out.financingTiers = [0, 1, 2].map(i => {
      const apr = parseFloat(document.getElementById('cp_tier' + i + '_apr')?.value);
      const months = parseInt(document.getElementById('cp_tier' + i + '_months')?.value, 10);
      const label = document.getElementById('cp_tier' + i + '_label')?.value || '';
      const badge = document.getElementById('cp_tier' + i + '_badge')?.value || '';
      const def = (defaults.financingTiers || [])[i] || {};
      // Key order mirrors NBD_COMPANY_PROFILE_DEFAULTS.financingTiers so the
      // JSON deep-compare in _cpStripDefaults strips an untouched NBD tiers array.
      return {
        months: Number.isFinite(months) && months > 0 ? months : (def.months || 12),
        apr: Number.isFinite(apr) ? apr : (def.apr || 0),
        label: label || def.label || '',
        badge: badge || def.badge || '',
        color: def.color || '#0ea5e9'
      };
    });
    // Services — 6 fixed slots; skip rows where all three fields are blank.
    out.services = [];
    for (let i = 0; i < 6; i++) {
      const icon = document.getElementById('cp_svc' + i + '_icon')?.value || '';
      const name = document.getElementById('cp_svc' + i + '_name')?.value || '';
      const desc = document.getElementById('cp_svc' + i + '_desc')?.value || '';
      if (icon || name || desc) out.services.push({ icon, name, desc });
    }
    // Value props — 4 fixed slots; skip blanks.
    out.valueProps = [];
    for (let i = 0; i < 4; i++) {
      const icon = document.getElementById('cp_vp' + i + '_icon')?.value || '';
      const title = document.getElementById('cp_vp' + i + '_title')?.value || '';
      const desc = document.getElementById('cp_vp' + i + '_desc')?.value || '';
      if (icon || title || desc) out.valueProps.push({ icon, title, desc });
    }
    // Job Budget Alerts — nested object like financingTiers. Out-of-range /
    // blank values persist the default so budgetStatus never sees garbage
    // (it also guards per-field, but keep the stored doc clean).
    const bdDef = defaults.budgetDefaults || { directCostPctWarn: 65, marginFloorPct: 30 };
    const bdPct = (id, fb) => {
      const n = parseFloat(document.getElementById(id)?.value);
      return (Number.isFinite(n) && n > 0 && n < 100) ? n : fb;
    };
    out.budgetDefaults = {
      directCostPctWarn: bdPct('cp_budget_directCostPctWarn', bdDef.directCostPctWarn),
      marginFloorPct: bdPct('cp_budget_marginFloorPct', bdDef.marginFloorPct)
    };
    // Sales links (2026-10-03): deal accept-link life in days, 1–90. Blank /
    // out of range keeps the default (14) — the server clamps the same way.
    const slDef = (defaults.salesLinks && defaults.salesLinks.dealLinkDays) || 14;
    const slDays = Math.floor(parseFloat(document.getElementById('cp_salesLinks_dealLinkDays')?.value));
    out.salesLinks = { dealLinkDays: (Number.isFinite(slDays) && slDays >= 1 && slDays <= 90) ? slDays : slDef };

    // FIX 1 — drop every field still equal to its NBD default (see helper).
    _cpStripDefaults(out, defaults);

    // FIX 2 (gauntlet Batch 3) — Brand Identity + Letterhead↔brand.contact lockstep.
    // Resolve each contact value with the dedicated Brand-Identity input winning
    // over the Letterhead input (single source of truth), then write BOTH the
    // Letterhead top-levels AND brand.contact from the same value so the two can
    // never diverge (the portal / SMS / lead-alert surfaces read brand.contact).
    const cpv = (id) => { const el = document.getElementById(id); return el ? String(el.value == null ? '' : el.value).trim() : ''; };
    const cPhone    = cpv('cp_brand_phone')   || cpv('cp_businessPhone');
    const cEmailRaw = cpv('cp_brand_email')   || cpv('cp_businessEmail');
    const cEmail    = cEmailRaw ? cEmailRaw.toLowerCase() : '';
    const cSiteRaw  = cpv('cp_brand_website') || cpv('cp_businessWebsite');
    const cWebsite  = cSiteRaw ? cSiteRaw.replace(/^https?:\/\//i, '').replace(/\/$/, '') : '';
    const cAddress  = cpv('cp_brand_address') || cpv('cp_businessAddress');
    const cMailing  = cpv('cp_brand_mailingAddress');
    // Lockstep: keep the Letterhead top-levels equal to the resolved values. Only
    // write when a value is present so an unedited NBD field stays absent (it was
    // stripped above) and byte-identical; clearing a saved field is the accepted
    // merge:true edge and does not re-emit an empty override.
    if (cPhone)   out.businessPhone   = cPhone;
    if (cEmail)   out.businessEmail   = cEmail;
    if (cWebsite) out.businessWebsite = cWebsite;
    if (cAddress) out.businessAddress = cAddress;

    // Brand override — onboarding.js buildOverrides() semantics: omit empties,
    // derive displayName from legalName, only write colors on a deliberate swatch
    // move, never write brand.seal / brand.docPrefix (reserved, callable-only).
    const brand = {};
    const bLegal = cpv('cp_brand_legalName');
    const bDisplay = cpv('cp_brand_displayName');
    if (bLegal) {
      brand.legalName = bLegal;
      brand.displayName = bDisplay || bLegal;
    } else if (bDisplay) {
      brand.displayName = bDisplay;
    }
    const bLogo = cpv('cp_brand_logoUrl');
    if (bLogo) brand.logoUrl = bLogo;
    if (_cpColorsTouched) {
      const dColors = (defaults.brand && defaults.brand.colors) || {};
      brand.colors = {
        primary: cpv('cp_brand_colorPrimary') || dColors.primary || '#1A3057',
        accent:  cpv('cp_brand_colorAccent')  || dColors.accent  || '#BD5728'
      };
    }
    const contact = {};
    if (cPhone)   contact.phone = cPhone;
    if (cEmail)   { contact.email = cEmail; contact.alertEmail = cEmail; }
    if (cWebsite) contact.website = cWebsite;
    if (cAddress) contact.address = cAddress;
    // CAN-SPAM postal address for the marketing-email footer
    // (functions/email-suppression.js tenantPostalAddress). Deliberately NOT
    // mirrored into businessAddress / contact.address: those are the public
    // microsite + document letterhead address, and a contractor may well want
    // a PO box on marketing mail and nothing at all on the letterhead. Blank
    // means "print no address", never a platform default.
    if (cMailing) contact.mailingAddress = cMailing;
    if (Object.keys(contact).length) brand.contact = contact;

    // AUTO-SEED legalName — belt-and-suspenders against the skip→Letterhead-only
    // NBD leak: a tenant who fills only a business name (never the Brand panel)
    // stays stranded on NBD's seal/logo/phone because brand.legalName was never
    // set. When a non-empty, non-NBD name is present AND the tenant's resolved
    // brand is still NBD, seed brand.legalName so the tenant flips off NBD
    // defaults. Owner/NBD accounts leave the name blank (default '') → seedName
    // '' → no brand key → NBD stays byte-identical.
    if (!brand.legalName) {
      const NBD_LEGAL = (defaults.brand && defaults.brand.legalName) || 'No Big Deal Home Solutions';
      const seedName = bLegal || cpv('cp_businessName');
      let brandIsNbd = true;
      try {
        const rb = (typeof window._brand === 'function') ? window._brand() : null;
        brandIsNbd = !rb || !rb.legalName || rb.legalName === NBD_LEGAL;
      } catch (_) { brandIsNbd = true; }
      if (seedName && seedName !== NBD_LEGAL && brandIsNbd) {
        brand.legalName = seedName;
        if (!brand.displayName) brand.displayName = seedName;
      }
    }
    if (Object.keys(brand).length) out.brand = brand;
    return out;
  }

  function _cpPopulateFormFromProfile(profile) {
    const defaults = window.NBD_COMPANY_PROFILE_DEFAULTS || {};
    const p = profile || defaults;
    _CP_LEGAL_FIELDS.concat(_CP_MARKETING_FIELDS).concat(_CP_LETTERHEAD_FIELDS).forEach(k => {
      const el = document.getElementById('cp_' + k);
      if (el) el.value = p[k] != null ? p[k] : (defaults[k] != null ? defaults[k] : '');
    });
    const tiers = (Array.isArray(p.financingTiers) && p.financingTiers.length === 3) ? p.financingTiers : (defaults.financingTiers || []);
    [0, 1, 2].forEach(i => {
      const t = tiers[i] || {};
      const apr = document.getElementById('cp_tier' + i + '_apr');     if (apr)    apr.value = t.apr != null ? t.apr : '';
      const months = document.getElementById('cp_tier' + i + '_months'); if (months) months.value = t.months != null ? t.months : '';
      const label = document.getElementById('cp_tier' + i + '_label');   if (label)  label.value = t.label || '';
      const badge = document.getElementById('cp_tier' + i + '_badge');   if (badge)  badge.value = t.badge || '';
    });
    const services = (Array.isArray(p.services) ? p.services : (defaults.services || []));
    for (let i = 0; i < 6; i++) {
      const s = services[i] || {};
      const iconEl = document.getElementById('cp_svc' + i + '_icon'); if (iconEl) iconEl.value = s.icon || '';
      const nameEl = document.getElementById('cp_svc' + i + '_name'); if (nameEl) nameEl.value = s.name || '';
      const descEl = document.getElementById('cp_svc' + i + '_desc'); if (descEl) descEl.value = s.desc || '';
    }
    const valueProps = (Array.isArray(p.valueProps) ? p.valueProps : (defaults.valueProps || []));
    for (let i = 0; i < 4; i++) {
      const v = valueProps[i] || {};
      const iconEl = document.getElementById('cp_vp' + i + '_icon');   if (iconEl)  iconEl.value = v.icon || '';
      const titleEl = document.getElementById('cp_vp' + i + '_title'); if (titleEl) titleEl.value = v.title || '';
      const descEl = document.getElementById('cp_vp' + i + '_desc');   if (descEl)  descEl.value = v.desc || '';
    }
    const bd = p.budgetDefaults || defaults.budgetDefaults || {};
    const warnEl = document.getElementById('cp_budget_directCostPctWarn');
    if (warnEl) warnEl.value = bd.directCostPctWarn != null ? bd.directCostPctWarn : '';
    const floorEl = document.getElementById('cp_budget_marginFloorPct');
    if (floorEl) floorEl.value = bd.marginFloorPct != null ? bd.marginFloorPct : '';
    const sl = p.salesLinks || defaults.salesLinks || {};
    const slEl = document.getElementById('cp_salesLinks_dealLinkDays');
    if (slEl) slEl.value = sl.dealLinkDays != null ? sl.dealLinkDays : '';

    // ── Brand Identity sub-panel (gauntlet Batch 3) ─────────────────
    // Fill from the RAW (un-merged) tenant override so a field the tenant never
    // set renders BLANK — not NBD's default bleeding through the deep merge.
    const rawBrand = (typeof window._brandOverride === 'function' && window._brandOverride()) || {};
    const rawContact = rawBrand.contact || {};
    const setCp = (id, v) => { const el = document.getElementById(id); if (el) el.value = v != null ? v : ''; };
    setCp('cp_brand_legalName', rawBrand.legalName || '');
    setCp('cp_brand_displayName', rawBrand.displayName || '');
    setCp('cp_brand_logoUrl', rawBrand.logoUrl || '');
    setCp('cp_brand_phone', rawContact.phone || '');
    setCp('cp_brand_email', rawContact.email || '');
    setCp('cp_brand_website', rawContact.website || '');
    setCp('cp_brand_address', rawContact.address || '');
    setCp('cp_brand_mailingAddress', rawContact.mailingAddress || '');
    // Color <input>s always report a value: seed from the raw override's colors
    // when present, else the NBD default swatch (cosmetic — an untouched picker
    // is never written, see _cpColorsTouched).
    const dBrandColors = (defaults.brand && defaults.brand.colors) || {};
    const rawColors = rawBrand.colors || {};
    const primEl = document.getElementById('cp_brand_colorPrimary');
    if (primEl) primEl.value = rawColors.primary || dBrandColors.primary || '#1A3057';
    const accEl = document.getElementById('cp_brand_colorAccent');
    if (accEl) accEl.value = rawColors.accent || dBrandColors.accent || '#BD5728';
    // A fresh populate = user hasn't moved a swatch yet (mirror onboarding.js).
    _cpColorsTouched = false;
    _cpWireColorInputs();
  }

  async function _loadCompanyProfileSettings() {
    // Refresh from Firestore (sets window._companyProfile), then mirror
    // into the form. Falls back to whatever's already in memory if the
    // network call fails.
    try {
      if (typeof window._loadCompanyProfile === 'function') await window._loadCompanyProfile();
    } catch (_) {}
    _cpPopulateFormFromProfile(window._companyProfile);
    _loadSiteSlug().catch(() => {});
  };

  // ── Pillar 5 Settings surface: tenant microsite address ──────────
  // Reads companies/{companyId||uid}.siteSlug into the "Your Website"
  // panel; saving goes through the setSiteSlug callable (reserved-name
  // + uniqueness checks are server-side).
  function _siteCompanyKey() {
    return (window._userClaims && window._userClaims.companyId) || (window._user && window._user.uid) || '';
  }
  function _renderSiteLink(slug) {
    const link = document.getElementById('cp-site-link');
    const key = slug || _siteCompanyKey();
    if (!link || !key) return;
    const url = '/sites/t/' + key;
    link.textContent = window.location.origin + url;
    link.href = url;
  }
  async function _loadSiteSlug() {
    const key = _siteCompanyKey();
    if (!key || !db) return;
    let slug = '';
    try {
      const snap = await getDoc(doc(db, 'companies', key));
      if (snap.exists()) slug = (snap.data() || {}).siteSlug || '';
    } catch (_) { /* solo owners may have no doc yet */ }
    const input = document.getElementById('cp_siteSlug');
    if (input) input.value = slug;
    _renderSiteLink(slug);
  }
  const _saveSiteSlug = async function () {
    const input = document.getElementById('cp_siteSlug');
    const msg = document.getElementById('cp-slug-msg');
    const slug = (input && input.value || '').trim().toLowerCase();
    try {
      if (!(window._functions && window._httpsCallable)) {
        const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
        window._functions = window._functions || mod.getFunctions();
        await connectEmulatorsIfLocal({ functions: window._functions }); // no-op in prod
        window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      }
      const fn = window._httpsCallable(window._functions, 'setSiteSlug');
      const res = await fn({ slug });
      const out = (res && res.data) || {};
      if (input) input.value = out.slug || '';
      _renderSiteLink(out.slug);
      if (msg) {
        msg.textContent = out.slug ? '✓ Address saved — your site is live at the link above' : '✓ Custom address cleared — the account-id link still works';
        msg.style.color = 'var(--green)';
        msg.style.display = 'block';
        setTimeout(() => { msg.style.display = 'none'; }, 4000);
      }
    } catch (e) {
      // Callable errors carry the human validation message (taken/reserved/format).
      if (msg) {
        msg.textContent = '✗ ' + ((e && e.message) || 'could not save');
        msg.style.color = 'var(--red, #e05252)';
        msg.style.display = 'block';
      }
      if (typeof showToast === 'function') showToast('Address not saved: ' + ((e && e.message) || 'error'), 'error');
    }
  };

  const _saveCompanyProfileSettings = async function () {
    const overrides = _cpReadFormToProfile();
    try {
      if (typeof window._saveCompanyProfile !== 'function') {
        throw new Error('company-profile.js not loaded');
      }
      await window._saveCompanyProfile(overrides);
      const msg = document.getElementById('cp-save-msg');
      if (msg) {
        msg.style.display = 'block';
        setTimeout(() => msg.style.display = 'none', 3000);
      }
      if (typeof showToast === 'function') showToast('✓ Company profile saved — new docs will use these values', 'success');
    } catch (e) {
      console.warn('Company profile save failed:', e);
      if (typeof showToast === 'function') showToast('Save failed: ' + (e && e.message || 'unknown'), 'error');
    }
  };

  // async only for the nbdConfirm gate (see _resetEstimateDefaultsV2 above);
  // the sole caller is the [data-action="call"] delegate, which discards the
  // return value.
  const _resetCompanyProfileSettings = async function () {
    const defaults = window.NBD_COMPANY_PROFILE_DEFAULTS;
    if (!defaults) return;
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (!(await _ask('Reset every Company Profile field to factory defaults? Unsaved edits will be lost. (You still need to click Save to persist.)'))) return;
    _cpPopulateFormFromProfile(defaults);
    if (typeof showToast === 'function') showToast('↶ Fields reset to defaults — click Save to persist', 'info');
  };

  // ═════════════════════════════════════════════════════════
  // NOTIFICATION SETTINGS
  // ═════════════════════════════════════════════════════════
  // Trigger IDs match the checkbox element IDs in the Notifications
  // settings tab. notifNeedsField is new (added with the auto-needs-
  // field notifier) so the user can opt out of the "this lead is
  // missing required data" pings.
  const NOTIF_TRIGGERS = ['notifOverdue','notifHot','notifStorm','notifApproval','notifInbound','notifD2d','notifNeedsField'];
  const NOTIF_CHANNELS = ['chInApp','chPush','chEmail','chSms'];

  // Default state — used when no localStorage settings exist yet.
  // Matches the defaults baked into the settings UI HTML (notifOverdue
  // through notifApproval default on; notifD2d off; needs-field on).
  const _NOTIF_DEFAULTS = {
    mode: 'critical',
    triggers: {
      notifOverdue: true,  notifHot: true,    notifStorm: true,
      notifApproval: true, notifInbound: true, notifD2d: false,
      notifNeedsField: true
    },
    channels: { chInApp: true, chPush: false, chEmail: true, chSms: false }
  };

  // Map a notification's `type` field to the settings trigger that
  // gates it. Anything not in the map is treated as "no specific
  // trigger" and falls through to the mode check only.
  const _NOTIF_TYPE_TO_TRIGGER = {
    follow_up:    'notifOverdue',
    task_overdue: 'notifOverdue',
    needs_field:  'notifNeedsField',
    lead_review:  'notifApproval',
    estimate_approved: 'notifApproval',
    inbound_msg:  'notifInbound',
    storm_alert:  'notifStorm',
    hot_lead:     'notifHot',
    d2d_update:   'notifD2d'
  };

  function _readNotifSettings() {
    try {
      const raw = localStorage.getItem('nbd_notif_settings');
      if (!raw) return _NOTIF_DEFAULTS;
      const data = JSON.parse(raw) || {};
      // Merge against defaults so missing keys (e.g. brand-new
      // notifNeedsField on accounts that saved settings before it
      // existed) still get a sane value.
      return {
        mode: data.mode || _NOTIF_DEFAULTS.mode,
        triggers: Object.assign({}, _NOTIF_DEFAULTS.triggers, data.triggers || {}),
        channels: Object.assign({}, _NOTIF_DEFAULTS.channels, data.channels || {})
      };
    } catch (_) { return _NOTIF_DEFAULTS; }
  }

  // Public predicate: "should this notification fire?"
  //   notifType  — string from the canonical list (or any string;
  //                unknown types skip the trigger check).
  //   channel    — 'inApp' | 'push' | 'email' | 'sms' | 'firestore'
  //                ('firestore' = persisting into the notifications
  //                collection, the in-app bell dropdown source).
  //   priority   — 'high' | 'normal' | 'low'. Critical mode only
  //                fires 'high'. Digest mode suppresses 'normal'/'low'
  //                in real time (they accumulate for the digest).
  // Returns true if the firing code should proceed.
  window.shouldFireNotif = function (notifType, channel, priority) {
    const s = _readNotifSettings();

    // Mode check
    const pr = priority || 'normal';
    if (s.mode === 'critical' && pr !== 'high') return false;
    if (s.mode === 'digest' && pr !== 'high') {
      // Digest mode: only the digest scheduler should fire normal/low
      // priority items at 7am / 3pm. The digest scheduler passes a
      // 'digest' channel marker; everything else is suppressed.
      if (channel !== 'digest') return false;
    }
    // Firehose mode: every priority passes the mode check.

    // Trigger check — if the type maps to a known trigger and the user
    // turned that trigger off, suppress.
    const triggerId = _NOTIF_TYPE_TO_TRIGGER[notifType];
    if (triggerId && s.triggers[triggerId] === false) return false;

    // Channel check — translate channel name to its setting ID.
    if (channel) {
      const channelMap = {
        inApp:     'chInApp',
        push:      'chPush',
        email:     'chEmail',
        sms:       'chSms',
        // 'firestore' / 'digest' aren't user-gated channels (they're
        // internal persistence / scheduling, not delivery surfaces).
      };
      const channelId = channelMap[channel];
      if (channelId && s.channels[channelId] === false) return false;
    }

    return true;
  };

  // Convenience peek (mostly for tests/devtools).
  window._getNotifSettings = _readNotifSettings;

  const _saveNotifSettings = async function() {
    const modeEl = document.querySelector('input[name="notifMode"]:checked');
    const data = {
      mode: modeEl ? modeEl.value : 'critical',
      triggers: {},
      channels: {}
    };
    NOTIF_TRIGGERS.forEach(id => {
      const el = document.getElementById(id);
      if (el) data.triggers[id] = !!el.checked;
    });
    NOTIF_CHANNELS.forEach(id => {
      const el = document.getElementById(id);
      if (el) data.channels[id] = !!el.checked;
    });

    try { localStorage.setItem('nbd_notif_settings', JSON.stringify(data)); } catch(e){}
    try {
      if (window._db && window._user) {
        const { setDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js");
        await setDoc(
          doc(window._db, 'userSettings', window._user.uid),
          { notifications: data, updatedAt: new Date().toISOString() },
          { merge: true }
        );
      }
    } catch (e) {}

    const msg = document.getElementById('notif-save-msg');
    if (msg) {
      msg.style.display = 'block';
      setTimeout(() => msg.style.display = 'none', 3000);
    }
    if (typeof showToast === 'function') showToast('✓ Notification preferences saved', 'success');
  };

  // Apply a settings object to the Notifications-tab form controls.
  // Tolerates partial objects (missing triggers / channels / mode are
  // skipped, not zeroed).
  function _applyNotifSettingsToUI(s) {
    if (!s) return;
    try {
      const mode = s.mode || 'critical';
      const modeId = 'notif' + mode.charAt(0).toUpperCase() + mode.slice(1);
      const modeEl = document.getElementById(modeId);
      if (modeEl) modeEl.checked = true;
      if (s.triggers) {
        NOTIF_TRIGGERS.forEach(id => {
          const el = document.getElementById(id);
          if (el && s.triggers[id] != null) el.checked = !!s.triggers[id];
        });
      }
      if (s.channels) {
        NOTIF_CHANNELS.forEach(id => {
          const el = document.getElementById(id);
          if (el && s.channels[id] != null) el.checked = !!s.channels[id];
        });
      }
    } catch (_) {}
  }

  // Cross-device sync flag — keeps the Firestore fetch single-flight
  // per page load. If the user switches to the Notifications tab a
  // second time we just re-read the (now-populated) localStorage cache.
  let _notifFirestoreSynced = false;

  // Pull saved settings from Firestore userSettings/{uid}, cache to
  // localStorage, and refresh the UI if the panel is open. Tolerates
  // missing doc / missing notifications subfield (returns silently).
  async function _syncNotifSettingsFromFirestore() {
    const _db = window._db || window.db;
    const uid = window._user && window._user.uid;
    if (!_db || !uid) return;
    try {
      const { getDoc, doc } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      // QA 2026-06-21 #1: retry transient cold-boot offline (WebChannel not up yet).
      const snap = await (window.nbdRetryOffline || (f => f()))(() => getDoc(doc(_db, 'userSettings', uid)));
      if (!snap.exists()) return;
      const data = snap.data();
      if (!data || !data.notifications) return;
      try { localStorage.setItem('nbd_notif_settings', JSON.stringify(data.notifications)); } catch (_) {}
      _applyNotifSettingsToUI(_readNotifSettings());
    } catch (e) {
      console.warn('Notif settings server sync failed:', e && e.message);
    }
  }

  function _loadNotifSettings() {
    // Fast path — always paint from the localStorage cache (instant, sync).
    _applyNotifSettingsToUI(_readNotifSettings());
    // Slow path — once per page load, pull the source of truth from
    // Firestore so a rep signing in on a new device gets their saved
    // preferences instead of seeing the on-disk defaults.
    if (!_notifFirestoreSynced && window._user && window._user.uid) {
      _notifFirestoreSynced = true;
      _syncNotifSettingsFromFirestore();
    }
  };

  const _testNotif = function() {
    if (typeof showToast === 'function') {
      showToast('🔔 Test notification — your alerts work!', 'success');
    } else {
      alert('🔔 Test notification — your alerts work!');
    }
  };

  // ── Data Retention exports ─────────────────────────
  // Three buttons in Settings → Access → Data Retention pointed at
  // these functions but nothing defined them — the short-circuit
  // `_exportAllData && ...` just silently no-oped. Real
  // implementations below. For a full GDPR-compliant JSON dump use
  // window._gdprExport (Settings → Your Rights panel); these are
  // convenience CSVs for the common ops workflows.
  function _csvEscape(v) {
    if (v == null) return '';
    let s = String(v);
    // Same formula-injection neutralizer as data-export.js's csvEscape and
    // expenses.js's. This is the OTHER "Export All Leads (CSV)" button — the
    // one in Settings → Access → Data Retention — and it maps firstName /
    // lastName / address / notes straight off window._leads, all of which
    // arrive from the PUBLIC intake form. Fixing only the first export left
    // this one live over the same data, one panel away.
    // Character class and the plain-number exemption are pinned across all
    // three copies by tests/data-export.test.js.
    if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(s)) {
      s = "'" + s;
    }
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function _downloadCsv(rows, filename) {
    if (!rows || !rows.length) {
      if (typeof showToast === 'function') showToast('Nothing to export — the list is empty.', 'info');
      return;
    }
    const keys = Object.keys(rows[0]);
    const lines = [keys.join(',')].concat(
      rows.map(r => keys.map(k => _csvEscape(r[k])).join(','))
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 250);
    if (typeof showToast === 'function') showToast('✓ ' + filename + ' downloaded.', 'success');
  }

  const _exportAllData = function () {
    const leads = (window._leads || []).map(l => ({
      id:         l.id,
      firstName:  l.firstName || l.fname || '',
      lastName:   l.lastName  || l.lname || '',
      email:      l.email     || '',
      phone:      l.phone     || '',
      address:    l.address   || '',
      stage:      l.stage     || '',
      source:     l.source    || '',
      damageType: l.damageType || '',
      jobValue:   l.jobValue  || '',
      carrier:    l.carrier   || '',
      claimNumber: l.claimNumber || '',
      dateOfLoss: l.dateOfLoss || '',
      lat:        l.lat != null ? l.lat : '',
      lng:        l.lng != null ? l.lng : '',
      notes:      l.notes || '',
      createdAt:  l.createdAt?.toDate?.()?.toISOString() || '',
      updatedAt:  l.updatedAt?.toDate?.()?.toISOString() || ''
    }));
    _downloadCsv(leads, 'nbd-leads-' + new Date().toISOString().slice(0, 10) + '.csv');
  };

  const _exportEstimates = function () {
    const rows = (window._estimates || []).map(e => ({
      id:          e.id,
      address:     e.addr || e.address || '',
      tierName:    e.tierName || '',
      grandTotal:  e.grandTotal || e.total || '',
      builder:     e.builder || 'classic',
      signatureStatus: e.signatureStatus || 'none',
      signedAt:    e.signedAt?.toDate?.()?.toISOString() || '',
      leadId:      e.leadId || '',
      createdAt:   e.createdAt?.toDate?.()?.toISOString() || ''
    }));
    _downloadCsv(rows, 'nbd-estimates-' + new Date().toISOString().slice(0, 10) + '.csv');
  };

  // Photos ZIP — we don't bundle every photo blob client-side (too
  // much memory for a big account). Instead export a CSV manifest
  // with direct download links; reps can wget / curl the list.
  const _exportPhotos = async function () {
    try {
      const uid = window._user?.uid;
      if (!uid) { if (typeof showToast === 'function') showToast('Sign in first', 'error'); return; }
      const snap = await getDocs(query(collection(db, 'photos'), where('userId', '==', uid)));
      const rows = snap.docs.map(d => {
        const p = d.data();
        return {
          id:         d.id,
          leadId:     p.leadId || '',
          url:        p.url || '',
          thumbUrl:   p.thumbUrl || '',
          description: p.description || '',
          tags:       Array.isArray(p.tags) ? p.tags.join('|') : '',
          quality:    p.quality || '',
          fileSize:   p.fileSize || '',
          uploadedAt: p.uploadedAt?.toDate?.()?.toISOString() || (p.capturedAt ? new Date(p.capturedAt).toISOString() : '')
        };
      });
      _downloadCsv(rows, 'nbd-photos-manifest-' + new Date().toISOString().slice(0, 10) + '.csv');
    } catch (e) {
      console.error('export photos failed:', e);
      if (typeof showToast === 'function') showToast('Export failed: ' + e.message, 'error');
    }
  };

  // ═════════════════════════════════════════════════════════
  // ACCESS TAB — populate current session info
  // ═════════════════════════════════════════════════════════
  function _loadAccessInfo() {
    const byId = (id) => document.getElementById(id);
    if (byId('accSignedInAs') && window._user) {
      byId('accSignedInAs').textContent = window._user.displayName || window._user.email || 'Joe';
    }
    if (byId('accUserId') && window._user) {
      byId('accUserId').textContent = window._user.uid || '—';
    }
    if (byId('accLoginMethod') && window._user) {
      const method = window._user.providerData?.[0]?.providerId || 'email';
      byId('accLoginMethod').textContent = method === 'password' ? 'Email + Password' :
                                           method === 'google.com' ? 'Google OAuth' :
                                           'Access Code';
    }
    if (byId('accSessionStarted')) {
      const start = sessionStorage.getItem('nbd_session_start') || new Date().toISOString();
      if (!sessionStorage.getItem('nbd_session_start')) sessionStorage.setItem('nbd_session_start', start);
      byId('accSessionStarted').textContent = new Date(start).toLocaleString();
    }
  };

  // ═════════════════════════════════════════════════════════
  // BILLING TAB — populate Ask Joe AI usage stats
  // ═════════════════════════════════════════════════════════
  function _loadBillingInfo() {
    const byId = (id) => document.getElementById(id);
    try {
      const usageRaw = localStorage.getItem('nbd_ai_usage') || '{}';
      const usage = JSON.parse(usageRaw);
      const now = new Date();
      const monthKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const thisMonth = usage[monthKey] || { calls: 0, tokens: 0, cost: 0 };
      if (byId('aiUsageMonth'))  byId('aiUsageMonth').textContent  = thisMonth.calls || 0;
      if (byId('aiUsageTokens')) byId('aiUsageTokens').textContent = (thisMonth.tokens || 0).toLocaleString();
      if (byId('aiUsageCost'))   byId('aiUsageCost').textContent   = '$' + (thisMonth.cost || 0).toFixed(2);
    } catch (e) {
      if (byId('aiUsageMonth'))  byId('aiUsageMonth').textContent  = '0';
      if (byId('aiUsageTokens')) byId('aiUsageTokens').textContent = '0';
      if (byId('aiUsageCost'))   byId('aiUsageCost').textContent   = '$0.00';
    }
  };

// ── Delegate registration (Globals Tranche 2c-4f — 2026-07-07) ──
// The settings/debug/export handlers here are dispatched ONLY from markup
// (data-action="call" data-fn) through dashboard-ui.js _nbdResolveCall, which
// resolves window.__NBD_CALL_REGISTRY FIRST. Registration here replaces each
// name's _NBD_CALL_ALLOWLIST entry as the security opt-in; the functions stay
// module-scoped (this is a real ES module — no IIFE needed). MUST-STAY siblings
// keep their window.X exposure: _saveEstimateDefaultsV2 (intra-module self-read).
// (loadSampleData used to be listed here too. This module carried a
// confirm-less twin of it, always shadowed by dashboard-actions.js's
// top-level declaration, which loads later. The twin was deleted 2026-09-22;
// dashboard-actions.js owns the only loadSampleData.)
// Tranche 3 map-graduate follow-on (2026-09-02): toggleDebugConsole and
// toggleRecentDropdown joined — dispatched via _NBD_TOGGLE_FNS through
// _nbdResolveMapped (registry-first since T3-M), never data-fn, so they have
// no allowlist history; their window exports are deleted.
// Tranche 3 T3-C edge (2026-09-17): _loadCompanySettings and
// _loadCompanyProfileSettings graduated too — the "ui.js cross-file window
// calls" this file's own comment cited as their MUST-STAY reason are exactly
// switchSettingsTab's bare window.X() reads in ui.js, now rewired to read
// this registry instead (same fix ui.js needed either way, so the other
// four settings-tab loaders below — none of them markup-dispatched, all of
// them the SAME "ui.js cross-file window call" shape — graduated alongside
// them rather than leaving a half-migrated set).
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  runLeadAction: runLeadAction,
  retryLoadLeads: retryLoadLeads,
  copyDebugInfo: copyDebugInfo,
  toggleDebugConsole: toggleDebugConsole,
  toggleRecentDropdown: toggleRecentDropdown,
  testFirestoreRules: testFirestoreRules,
  _saveSettings: _saveSettings,
  _saveNotifSettings: _saveNotifSettings,
  _saveCompanySettings: _saveCompanySettings,
  _testNotif: _testNotif,
  _resetEstimateDefaultsV2: _resetEstimateDefaultsV2,
  // Globals Tranche 3 T3-C (2026-09-18): the 7th ui.js-edge settings-tab
  // loader, deferred from the 2026-09-17 sextet for its in-module callers.
  _loadEstimateDefaultsV2: _loadEstimateDefaultsV2,
  _addJurisdictionRow: _addJurisdictionRow,
  _removeJurisdictionRow: _removeJurisdictionRow,
  // The My Jurisdictions failure message's "↻ Try again" (2026-09-25).
  _retryJurisdictions: _retryJurisdictions,
  _saveSiteSlug: _saveSiteSlug,
  _saveCompanyProfileSettings: _saveCompanyProfileSettings,
  _resetCompanyProfileSettings: _resetCompanyProfileSettings,
  _exportAllData: _exportAllData,
  _exportEstimates: _exportEstimates,
  _exportPhotos: _exportPhotos,
  _loadCompanySettings: _loadCompanySettings,
  _loadCompanyProfileSettings: _loadCompanyProfileSettings,
  _loadAccessInfo: _loadAccessInfo,
  _loadBillingInfo: _loadBillingInfo,
  _loadNotifSettings: _loadNotifSettings,
  _loadProfileSettings: _loadProfileSettings,
  toggleInsuranceFields: toggleInsuranceFields,
  refreshSubTypeAndTrades: refreshSubTypeAndTrades,
  setSelectedTrades: setSelectedTrades,
  _deleteLead: _deleteLead,
  _loadDeletedLeads: _loadDeletedLeads,
  _saveReport: _saveReport,
  _deleteReport: _deleteReport,
  _loadReports: _loadReports,
  // Globals Tranche 3 T3-C (2026-09-18): the pins + zones CRUD edges —
  // maps-overlays.js's dropPin/deletePin and dashboard-actions.js's
  // saveZone/deleteZone. _zones and _DASH_DOC_PREREQUISITES were also
  // census candidates for these same two edges but are DATA (a loaded-zones
  // cache; a static doc-type config object), not callables — both stay on
  // window, same reasoning as _reports above.
  _savePin: _savePin,
  _deletePin: _deletePin,
  _saveZone: _saveZone,
  _deleteZone: _deleteZone,
  // Globals Tranche 3 T3-C (2026-09-18): the mobile doc-picker edge —
  // dashboard-actions.js's _mJdOpenDocCreate/_mJdPickDocType. Its data
  // sibling _DASH_DOC_PREREQUISITES stays on window (see above).
  _generateDocWithPreflight: _generateDocWithPreflight,
  // Globals Tranche 3 T3-C (2026-09-18): the estimate CRUD edge —
  // estimate-crm-ops.js's renameEstimateAction/deleteEstimateAction/
  // assignEstimateAction. _duplicateEstimate was NOT a candidate for this
  // edge (multiple consumers, out of scope for a one-consumer T3-C slice).
  _deleteEstimate: _deleteEstimate,
  _renameEstimate: _renameEstimate,
  _assignEstimateToLead: _assignEstimateToLead,
  // Globals Tranche 3 T3-C (2026-09-18): the crm-leads.js edge.
  filterStageDropdownByJobType: filterStageDropdownByJobType,
  getSelectedTrades: getSelectedTrades,
  refreshStageOptions: refreshStageOptions,
  // Globals Tranche 3 T3-C (2026-09-18): the warranty-claim.js edge. All
  // three are crm-stages.js imports bridged to a classic script — the
  // "Expose the new helpers to non-module scripts (crm.js)" comment
  // higher in this file was stale for subTypeOptionsFor/subTypeLabel
  // specifically; warranty-claim.js is the real, sole consumer of all 3.
  // Also loaded on customer.html, where these were already unavailable
  // before this change too (customer-bootstrap.module.js never defined
  // them) — all 3 call sites there were already guarded and degrade
  // gracefully (a shorter reason list, a raw reason instead of a label),
  // unchanged by this migration.
  missingClaimFields: missingClaimFields,
  subTypeLabel: subTypeLabel,
  subTypeOptionsFor: subTypeOptionsFor,
  // Globals Tranche 3 T3-C (2026-09-18): the pipeline-builder.js edge.
  // STAGE_ROLE is a rename-on-export (the imported binding is ROLE, the
  // public name pipeline-builder.js reads is STAGE_ROLE) — key differs
  // from value here, unlike every other entry in this block.
  applyPipelineConfig: applyPipelineConfig,
  resolvePipelineConfig: resolvePipelineConfig,
  STAGE_ROLE: ROLE,
  // Globals Tranche 3 T3-C (2026-09-18): the crm-pipeline.js edge — another
  // crm-stages.js import bridged to a classic script (renderLeads is its sole
  // consumer). Deliberately does NOT touch crm-pipeline.js's _dragId, which
  // stays a shared implicit global (drag state read/written cross-file).
  partitionLeadsByColumn: partitionLeadsByColumn,
  // Globals Tranche 3 T3-C (2026-09-18): the dashboard-widgets.js photo
  // modal edge.
  _uploadPhoto: _uploadPhoto,
  _getPhotos: _getPhotos,
});
