/**
 * dashboard-state.js — module state, constants, and boot-time
 * persistence/hydration for the dashboard surface.
 *
 * Extracted from dashboard-main.js (Step 4a — 2026-05-16) as one
 * of five sibling modules. Load order is critical and locked in
 * dashboard.html:
 *
 *   state → api → widgets → ui → actions → main (shim)
 *
 * This file is loaded FIRST so every later script can rely on
 * - the action delegate allowlists (_NBD_TOGGLE_FNS,
 *   _NBD_MODAL_CLOSE_FNS, _NBD_CALL_ALLOWLIST)
 * - the route config (routeConfig, PRO_ONLY_VIEWS, MOBILE_NAV_TABS)
 * - rates/theme/comfort/density constants
 * - module-state vars (currentPhotoLeadId, _docFile, _piCache,
 *   estimate state, zone state, etc.)
 *
 * Boot IIFEs at the bottom apply persisted prefs to <html>/<body>
 * BEFORE the UI script wires up listeners — that way the first
 * paint already shows the user's preferred theme + density.
 */

// ══════════════════════════════════════════════
// NAVIGATION & URL ROUTING — config and state
// ══════════════════════════════════════════════
const mapInited = {};

// Route configuration: maps view names to display labels and parent routes.
//
// Every `<div id="view-X">` in dashboard.html MUST have a matching entry
// here, otherwise the hashchange handler in dashboard-main.js silently
// ignores `#/X` URLs (it gates on `routeConfig[name]`), leaving the
// previous view active. The 8 entries below "// W160" were missing for
// months — clicking the sidebar item worked (calls goTo directly) but
// hard-refresh / direct URL / browser-back navigation didn't.
const routeConfig = {
  'home': { label: 'Home', parent: null },
  'dash': { label: 'Dashboard', parent: null },
  'schedule': { label: 'Schedule', parent: null },
  'crm': { label: 'Pipeline', parent: null },
  'est': { label: 'Estimates', parent: null },
  'd2d': { label: 'Door-to-Door', parent: null },
  'map': { label: 'Maps & Pins', parent: null },
  'photos': { label: 'Photos', parent: null },
  'docs': { label: 'Templates', parent: null },
  'draw': { label: 'Drawing', parent: null },
  'storm': { label: 'Storm Center', parent: null },
  'closeboard': { label: 'Close Board', parent: null },
  'repos': { label: 'Rep OS', parent: null },
  'joe': { label: 'Ask Joe', parent: null },
  'board': { label: 'Leaderboard', parent: null },
  'products': { label: 'Products', parent: null },
  'job-templates': { label: 'Job Templates', parent: null },
  'training': { label: 'Sales Training', parent: null },
  'settings': { label: 'Settings', parent: null },
  // W160: missing routes that left direct URLs / hard-refresh broken.
  'reports':      { label: 'Reports',           parent: null },
  'prospects':    { label: 'Prospects',         parent: null },
  'admin':        { label: 'Team Manager',      parent: null },
  'academy':      { label: 'Real Deal Academy', parent: null },
  'aitree':       { label: 'Decision Engine',   parent: null },
  'understand':   { label: 'Deep Dive',         parent: null },
  'projectcodex': { label: 'Project Intel',     parent: null },
  'aiusage':      { label: 'AI Usage',          parent: null },
  // Talk Tank — unified voice-capture inbox (#/talk-tank)
  'talk-tank':    { label: 'Talk Tank',         parent: null },
  // 2026-09-02: the W160 class recurred. These three views shipped in
  // 2026-06/07 (#783, #786, #897) with sidebar + mobile-More entries and
  // goTo() init branches but no route, so #/expenses, #/money and
  // #/refrewards deep links, hard refresh and browser-back all silently
  // fell back to the previous view. tests/smoke/dashboard.test.js now
  // set-compares every view-* mount against these keys.
  'expenses':     { label: 'Expenses',          parent: null },
  'money':        { label: 'Money',             parent: null },
  'refrewards':   { label: 'Referrals',         parent: null },
  'signs':        { label: 'Yard Signs',        parent: null }
};

/**
 * THE ONE parser for the URL hash. Everything that needs to know "which view
 * are we on?" must call this — do not re-derive it.
 *
 * goTo() writes `#/name` and `#/name/id` (dashboard-actions.js), so the hash
 * always carries a LEADING SLASH. Anything that strips only the '#' gets
 * '/crm' and then quietly fails to match the view id 'crm'. That is exactly
 * what mobile-nav-customizer's setActiveTab did: the bottom bar compared tab
 * ids against '/crm' and so never lit a tab after any navigation.
 *
 * The empty hash means HOME. The boot path already treated it that way while
 * the hashchange path sent it to 'dash', so pressing Back landed the user on
 * the ops-overview Dashboard — a screen they had never opened. One parser,
 * one default, both paths.
 *
 * @param {string} [rawHash] defaults to the live location.hash
 * @returns {{name: string, id: string|null}}
 */
function routeFromHash(rawHash) {
  const h = typeof rawHash === 'string'
    ? rawHash
    : ((typeof window !== 'undefined' && window.location && window.location.hash) || '');
  const parts = h.replace(/^#/, '').split('/').filter(function (p) { return p; });
  return { name: parts[0] || 'home', id: parts[1] || null };
}

// Pro-only views — Lite users see upgrade prompt instead
const PRO_ONLY_VIEWS = ['photos','docs','map','draw','storm','joe','schedule','board','closeboard','repos','training','academy','talk-tank'];

// ══════════════════════════════════════════════
// data-action DELEGATE ALLOWLISTS
// ══════════════════════════════════════════════
// Explicit registry of which modal IDs can be closed by the
// data-action="closeModal" delegate, and which function to dispatch.
// Adding a new modal? Register it here + use closeModal in markup.
// C.4 cluster 4 — no-arg toggle allowlist. data-target → window.<fn>().
// Add a new toggle? Register here + use data-action="toggle".
const _NBD_TOGGLE_FNS = {
  bulkMode:                'toggleBulkMode',
  debugConsole:            'toggleDebugConsole',
  dismissedNotifications:  'toggleDismissedNotifications',
  drawing:                 'toggleDraw',
  hdrMobileMenu:           'toggleHdrMobileMenu',
  historicalImagery:       'toggleHistoricalImagery',
  kanbanFullscreen:        'toggleKanbanFullscreen',
  mapLayer:                'toggleMapLayer',
  mobileMore:              'toggleMobileMore',
  notifications:           'toggleNotificationDropdown',
  recentDropdown:          'toggleRecentDropdown',
  sidebarCollapse:         'toggleSidebarCollapse',
  voiceControl:            'toggleVoiceControl',
  // Defensive-existence-check toggles — the inline form was
  //   onclick="window.toggleX && window.toggleX()"
  // because these functions live in defer'd scripts that may not be
  // loaded when the user clicks. The delegate naturally handles the
  // "function not yet defined" case via typeof fn === 'function'.
  engagementSort:          'toggleEngagementSort',
  needsAttention:          'toggleNeedsAttention',
  showSnoozed:             'toggleShowSnoozed',
  staleShares:             'toggleStaleShares',
};

// CSP close-button/backdrop allowlist for data-action="closeModal" (dispatched
// at dashboard-ui.js — maps a modal-id data-target to its close fn). This is NOT
// an Esc handler and is load-bearing: ~33 close buttons/backdrops in
// dashboard.html route through it, so entries must stay even for
// nbdModal-managed modals (the close BUTTON still calls closeXxx, which then
// routes through nbdModal). nbdModal-managed today: leadModal, quickAddModal,
// taskModal, cardDetailModal, photoModal, tipsModal, docViewerModal — their
// closeXxx dual-paths to nbdModal.close (Esc/backdrop handled by the helper).
// The rest are hand-rolled drawers/sheets/popovers, correctly left as-is.
const _NBD_MODAL_CLOSE_FNS = {
  leadModal:                   'closeLeadModal',
  taskModal:                   'closeTaskModal',
  photoModal:                  'closePhotoModal',
  quickAddModal:               'closeQuickAddLead',
  docViewerModal:              'closeDocViewer',
  cardDetailModal:             'closeCardDetailModal',
  propertyIntelModal:          'closePropertyIntelModal',
  propertyIntelConfirmModal:   'closePropertyIntelConfirmModal',
  comparisonModal:             'closeComparisonMode',
  mobileJobDetail:             'closeMobileJobDetail',
  mobileInspection:            'closeMobileInspection',
  mobileCreatePopover:         'closeMobileCreatePopover',
  mobileMore:                  'closeMobileMore',
  shortcutsPanel:              'closeShortcutsPanel',
  tipsModal:                   'closeTips',
  cmdPalette:                  'closeCmdPalette',
  deletedDrawer:               'closeDeletedDrawer',
  historicalImagery:           'closeHistoricalImagery',
  uploadDoc:                   'closeUploadDoc',
};

// C.4 finale — allowlist of window-globals the generic `call` action
// is permitted to invoke. Anything not in this Set is silently
// ignored by the delegate. Add functions here only when their inline
// onclick is being migrated to data-action="call" data-fn="...".
const _NBD_CALL_ALLOWLIST = new Set([
  // Mobile job-detail / create-popover internals — moved OFF window into an
  // IIFE in dashboard-actions.js (Globals Tranche 2c-4b, 2026-07-07).
  // _mJdSwitchTab / _mJdShare / _mCreate register in __NBD_CALL_REGISTRY;
  // _mJdAct is never markup-dispatched (reached via window._mJdAct from the
  // 2c-4a cdaMjdAct wrapper), so its allowlist entry was vestigial. Do NOT
  // re-add — a stale window fallback would shadow-resurrect the global.
  // CRM kanban + filters
  // (cycleKanbanDensity → __NBD_CALL_REGISTRY, Tranche 2c-4g — off window.
  //  setKanbanDensity STAYS: auto-global backing decl, not the clean form.)
  // (tlFilterCat, tlToggleCat → __NBD_CALL_REGISTRY, Tranche 2c-4h
  //  (dashboard-ui.js Slice H1) — off window. Do NOT re-add.)
  'setKanbanDensity',
  // Board/List layout toggle (2026-07-06 lean triage list — crm-list-view.js)
  'crmViewBoard', 'crmViewList', 'crmViewAuto', 'openDupReview',
  // Referral Rewards view — mark a $100 code-referral bonus paid / reverse it
  // (referral-rewards-ui.js)
  'markReferralPaid', 'markReferralUnpaid',
  // Joe AI quick prompts + chat lifecycle
  'joeQuick', 'clearJoeChat', 'clearJoeKey',
  // Draw / zone / pin tools
  // (selectZoneColor, startZoneDraw, cancelZoneDraw, saveZone, deleteZone →
  //  __NBD_CALL_REGISTRY, Globals Tranche 3 slice T3-0 (2026-08-31) — the whole
  //  zone cluster is IIFE-scoped in dashboard-actions.js. Do NOT re-add: a
  //  stale window fallback would shadow-resurrect the globals it removed.)
  'setDrawMode', 'clearDraw',
  'clearAllPins', 'commitPin', 'cancelPinConfirm',
  // Estimate flow
  'estNext', 'estBack', 'saveEstimate', 'exportEstimate', 'cancelEstimate',
  'importToEstimate', 'startNewEstimate', 'startNewEstimateOriginal', 'selectTier',
  'setDepositOverride', 'toggleInternalView', 'createEstimateRevision',
  'exportDrawReport',
  // Photos / damage / drawing
  // Globals Tranche 2c-2 (2026-07-06): the maps-routing.js drawing-tool
  // cluster moved OFF window — its 21 markup-dispatched handlers (the
  // auto-detect accept/cancel/start trio, structure add, smart waste,
  // Xactimate export, scope + comparison-file + drawing save/load,
  // comparison-mode open, draw recalc, solar, screenshot, the two
  // historical-imagery sliders, angles, material takeoff, presentation,
  // shadow pitch, zoom-fit) now register in __NBD_CALL_REGISTRY at the
  // bottom of maps-routing.js, which the dashboard-ui.js dispatchers
  // resolve FIRST. Do NOT re-add registered names here: a stale window
  // fallback would shadow-resurrect the global the tranche removed.
  // goToMyLocation deliberately REMAINS allowlisted below — dashboard.html's
  // "My Location" button dispatches it as data-fn="goToMyLocation" and it is
  // not yet registered in __NBD_CALL_REGISTRY (Tranche 3 candidate). The
  // maps.js shim's own bare re-export of this name was deleted 2026-09-17
  // (T3-B, pure window.X = window.X once maps-routing.js's own explicit
  // export already ran) — that specific reason no longer applies, but this
  // allowlist entry still does, independently.
  // (damagNearMe registry-registered in maps-overlays.js 2026-08-07 — per the
  //  Tranche 2c-2 rule above, registered names must not keep a window
  //  fallback entry here.)
  // (damageNearMePhotos → __NBD_CALL_REGISTRY, Tranche 3 T3-0 2026-08-31 —
  //  same rule as damagNearMe above: registered names keep no window fallback.)
  'setPhotoMode',
  // Customer / lead modals
  // QA 2026-06-07 (C-1 fix): saveLead was dropped from the allowlist during the
  // CSP onclick→data-action sweep, so the Add/Edit Lead modal's Save buttons
  // (data-action="call" data-fn="saveLead") silently no-op'd — no lead could be
  // created or edited via the UI. window._saveLead works directly; only the
  // delegate gate was missing this entry.
  'saveLead',
  // QA 2026-06-07 (H-4): the SAME CSP onclick→data-action sweep dropped 21 more
  // functions from this allowlist — every data-action="call" button wired to them
  // silently no-op'd (delegate gate at dashboard-ui.js:492). All exist on window.
  // Restores: Maps search/zone/spyglass/draw-search/save-drawing/material-takeoff/
  // solar/screenshot/angles, photo auto-detect, bulk select-all, lead retry-load,
  // doc upload, Ask Joe key+send+settings-key, cal-link share (SMS/email)+settings,
  // and Quick-Add (use-location + add-lead). (saveCustomTheme is now allowlisted
  // below — 2026-06-20. The earlier "does not exist on window" note was a
  // misdiagnosis: it's a top-level global in dashboard-custom-theme.js, reachable as
  // window.saveCustomTheme, so only the missing allowlist entry kept SAVE THEME dead.)
  // (2026-07-06: the maps-routing.js members of that H-4 restore list —
  // drawing save/load, material takeoff, solar, screenshot, angles and
  // photo auto-detect — are registry-registered now; see the Tranche
  // 2c-2 note above.)
  // (spyglassSearch → __NBD_CALL_REGISTRY, Tranche 2c-4h Slice H2 — off window.)
  // (saveZone → __NBD_CALL_REGISTRY with the rest of the zone cluster,
  //  Globals Tranche 3 slice T3-0, 2026-08-31 — do NOT re-add.)
  'searchMap', 'searchDraw',
  'saveDocUpload',
  // (saveJoeKey / saveJoeKeyFromSettings removed 2026-08-10 with the dead
  //  key-collection UI — the server proxy is the only AI transport.)
  'sendJoeMessage',
  // (shareCalViaSMS, shareCalViaEmail, saveCalSettings → __NBD_CALL_REGISTRY,
  //  Tranche 2c-4h (dashboard-ui.js Slice H1) — off window. Do NOT re-add.)
  'qaUseMyLocation', 'saveQuickLead',
  'openLeadModal', 'openTaskModal', 'openShortcutsPanel', 'openQMImportModal',
  // (openPhotosForLead, openFullCustomerDetails, openDocsForLead →
  //  __NBD_CALL_REGISTRY, Tranche 2c-4e — off window)
  // (openUploadDoc → __NBD_CALL_REGISTRY, Tranche 2c-4h Slice H2 — off window.)
  'openEstimateV2Builder',
  // (editCardDetails → __NBD_CALL_REGISTRY, Tranche 2c-4e — off window)
  // (confirmPropertyIntelPull, executePullPropertyIntel, pullIntelForModal →
  //  __NBD_CALL_REGISTRY via property-intel.js, Tranche 2c-4h Slice H2 pt2 — off window.)
  'addTask',
  // Bulk operations — the toolbar handlers register in __NBD_CALL_REGISTRY
  // (crm-portal-bridge.js, Globals Tranche 2c-3), so they leave the
  // allowlist. clearBulkSelection STAYS: lead-snooze.js calls
  // window.clearBulkSelection() directly, bypassing the registry-first
  // dispatcher — the same MUST-STAY shape as goToMyLocation.
  'clearBulkSelection',
  // Notifications
  'markAllNotificationsRead', 'clearAllNotifications',
  // Misc tools
  // (spyglassGoToLocation → __NBD_CALL_REGISTRY, Tranche 2c-4h Slice H2 — off window.)
  'goToMyLocation', 'dropPinByAddress',
  // (quickStormCheck → __NBD_CALL_REGISTRY, Tranche 2c-4h Slice H2 — off window.)
  'perimChooseType',
  // (copyCalLink → __NBD_CALL_REGISTRY, Tranche 2c-4h — off window. Do NOT re-add.)
  'loadSampleData', 'inviteTeamMember',
  // (printDoc → __NBD_CALL_REGISTRY, Tranche 2c-4h Slice H2 — off window.)
  'exportLeadsCSV', 'generateWarrantyCertPDF', 'clearCrmSearch',
  // Appearance picker
  'nbdPickerTab', 'nbdComfortSet', 'nbdHowtoOpen', 'nbdHowtoClose',
  'nbdSaveCustom', 'nbdRandom', 'nbdPickerClose', 'nbdNavToggle', 'nbdCopyFS',
  // nbdApplyLegacyFont = the Settings 28-font grid applier. Renamed from nbdApplyFont
  // (2026-06-20) to stop colliding with maps.js's theme-engine nbdApplyFont, which
  // loaded later and shadowed window.nbdApplyFont → every Settings font card no-op'd.
  'nbdApplyFont', 'nbdApplyCustom', 'nbdPickerOpen',
  // Display-mode segmented toggle (Light/Dark/Auto) above the theme grid
  'nbdSetModePref',
  'saveCustomTheme', 'resetCustomTheme', 'resetSidebarCustomizer',
  // FAB / scoreboard tabs
  // (fabToggle → __NBD_CALL_REGISTRY, Tranche 2c-4h Slice H2 — off window.)
  'switchScTab',
  // (Tranche 2c-4d 2026-07-07: dsAddFloor, dsSaveConfig, dsResetDefaults →
  //  __NBD_CALL_REGISTRY, off window. dsRemoveFloor stays window-exported
  //  (dashboard-ui.js bare call); ds* helpers are private. Do NOT re-add.)
  // (cancelDeleteConfirm moved into __NBD_CALL_REGISTRY — crm-portal-bridge.js,
  //  Globals Tranche 2c-3)
  // Settings page private setters (defensive: only fire if loaded).
  // (Tranche 2c-4f 2026-07-07: the dashboard-bootstrap.module.js settings /
  //  debug / export handlers moved OFF window into __NBD_CALL_REGISTRY —
  //  _saveSettings, _saveNotifSettings, _saveCompanySettings, _testNotif,
  //  runLeadAction, _resetEstimateDefaultsV2, _exportPhotos, _exportEstimates,
  //  _exportAllData, _saveCompanyProfileSettings, _resetCompanyProfileSettings,
  //  _saveSiteSlug, retryLoadLeads, copyDebugInfo, testFirestoreRules. Do NOT
  //  re-add. MUST-STAY (kept below): _saveEstimateDefaultsV2 (intra-module
  //  self-read), loadSampleData (declared ONLY in dashboard-actions.js — a
  //  top-level function in a classic script, so it is a window property
  //  that data-fn dispatch reaches through this allowlist; the module's
  //  shadowed confirm-less twin was deleted 2026-09-22).
  //  Tranche 3 T3-C (2026-09-17): _loadCompanySettings and
  //  _loadCompanyProfileSettings also moved OFF window into
  //  __NBD_CALL_REGISTRY — the "ui.js cross-file window calls" that kept
  //  them MUST-STAY were switchSettingsTab's bare window.X() reads, now
  //  rewired in ui.js to read the registry. Do NOT re-add.)
  '_saveEstimateDefaultsV2',
  '_sharePortalLink',
  '_revokePortalLink', 'exportLeadsCsv', 'exportEstimatesCsv',
  'openLeadsInSheets', 'openEstimatesInSheets',
  // confirmPromoteProspect removed (Globals Tranche 3 T3-A, 2026-09-18):
  // graduated off window into __NBD_CALL_REGISTRY. This entry was already
  // stale before that — the real markup dispatch target has always been
  // cdaConfirmPromote (a different, already-registered wrapper), not this
  // name directly. Do NOT re-add.
  'openLeadImport',
  // Quick-add flow
  'closeQuickAddLead',
  // Card-detail action helpers (glue around _cardDetailLeadId): the 18-name
  // cda* / chip-picker / _mCreatePhotoPicked cluster moved OFF window into an
  // IIFE in dashboard-actions.js and registers in __NBD_CALL_REGISTRY (Globals
  // Tranche 2c-4a, 2026-07-07); see docs/dev/dashboard-actions-globals-audit.md.
  // Do NOT re-add these names — a stale window fallback would shadow-resurrect
  // the global the tranche removed. Removed: cdaReport, cdaEnrich, cdaPhotos,
  // cdaInvoice, cdaInspection, cdaInspectionDeep, cdaMjdAct, cdaEditLead,
  // cdaOpenMobileInspection, cdaVoiceMemo, cdaOpenVoicemail, cdaSharePortalLink,
  // cdaRevokePortalLink, cdaConfirmPromote, cdaOpenTaskModal, cdPickStage,
  // cdPickType, _mCreatePhotoPicked.
  // (Tranche 2c-4c 2026-07-07: openDailyProgramFromMore, mCreateFabRoute +
  //  the other 18 one-off openers moved OFF window into an IIFE in
  //  dashboard-actions.js and register in __NBD_CALL_REGISTRY. Do NOT re-add —
  //  a stale window fallback would shadow-resurrect the global.)
  // Settings page private setters (defensive — delegate's typeof
  // guard makes the && existence-check redundant)
  '_nbdDismissTrial',
  '_gdprRequestErasure', '_gdprExport',
  // (_saveCompanyProfileSettings, _resetCompanyProfileSettings, _saveSiteSlug,
  //  testFirestoreRules → __NBD_CALL_REGISTRY, Tranche 2c-4f
  //  (dashboard-bootstrap.module.js), off window. Do NOT re-add.
  //  _loadCompanySettings / _loadCompanyProfileSettings → __NBD_CALL_REGISTRY,
  //  Tranche 3 T3-C (2026-09-17), off window. Do NOT re-add.)
  // (cdaMjdAct, cdaEditLead, cdaOpenMobileInspection, cdaVoiceMemo,
  //  cdaSharePortalLink, cdaRevokePortalLink, cdaConfirmPromote, cdaOpenTaskModal,
  //  cdPickStage, cdPickType → __NBD_CALL_REGISTRY, Tranche 2c-4a/4b, off window)
  // Draw / misc
  'undoLine',
  // (Tranche 2c-4b…4e 2026-07-07: mQuickAddRoute, restartOnboardingTour,
  //  openDecisionPicker, openD2DOrGo, clearAccentTheme, openSettingsTab,
  //  openPhotoEngineOrClickProxy, openReportGenerator, enrichReportData,
  //  openPhotoEngineCurrentLead, openInspectionBuilderCurrentLead,
  //  closeInspectionBuilder, hideFollowUpAlerts, goToD2DFromMaps,
  //  openCalBookingUrl, hardResetTest, gstaticTest, modeLineDraw →
  //  __NBD_CALL_REGISTRY, off window. Do NOT re-add.)
  // Misc directly-callable global referenced in surveyed onclicks
  'goTo',
  // (step-3 smart-calendar refresh button: loadSmartCalendar → __NBD_CALL_REGISTRY
  //  via smart-calendar.js, Tranche 3 T3-C 2026-09-18 — off window. Do NOT re-add.)
  // (cdaOpenVoicemail → __NBD_CALL_REGISTRY, Tranche 2c-4a — cluster note above)
  // ── CSP onchange/oninput sweep (Phase C.6) ──
  // The prefs-boot toggle wrappers that used to live here (Phase C.6:
  // toggleProfessionalMode, the nbdGx*/nbdComfortSet*/nbdSet*T families,
  // nbdSelectPhotoLead, nbdTogglePhotosOnly, d2dSetDispoFilter,
  // nbdSettingsUpdateCalcomPreview — plus nbdSetSize, nbdApplyLegacyFont
  // and nbdSetSidebarLabels from the sections above) moved OFF window in
  // Globals Tranche 2c: dashboard-ui-prefs-boot.js now registers them in
  // window.__NBD_CALL_REGISTRY, which the dashboard-ui.js dispatchers
  // resolve FIRST (registration replaces the allowlist entry — see
  // _nbdResolveCall). Do NOT re-add registered names here: a stale window
  // fallback would shadow-resurrect the global the tranche removed.
  // Pre-existing globals that also fire from inline onchange/oninput.
  // (Tranche 2c-2 moved the maps-routing.js members of this list — the
  // draw recalc, the comparison-file handler and the two historical-
  // imagery sliders — into the registry; see the drawing-cluster note
  // higher up.)
  'updateEstCalc', 'calcTierPrices',
  // (toggleInsuranceOverlay → __NBD_CALL_REGISTRY via dashboard-insurance-
  //  overlay-toggle.js, Globals Tranche 3 T3-C 2026-09-18 — off window. Do NOT re-add.)
  'applyEstimatePreset', 'applyCustomTheme', 'kanbanFilter', 'kanbanFilterDebounced',
  // (filterPhotoLeads, handleDocUpload, updateCalEmbed → __NBD_CALL_REGISTRY,
  //  Tranche 2c-4h (dashboard-ui.js Slice H1) — off window. Do NOT re-add.)
  // (updatePropertyIntelCost → __NBD_CALL_REGISTRY via property-intel.js, Tranche 2c-4h Slice H2 pt2.)
  'updateCertPreview', 'uploadPhotos',
  // (_mCreatePhotoPicked → __NBD_CALL_REGISTRY, Tranche 2c-4a — cluster note above)
  'nbdRenderThemes', 'nbdLiveCustom',
  // (nbdComfortSetWhisperHotkey, nbdComfortSetWhisperKey → __NBD_CALL_REGISTRY,
  //  Tranche 2c-4g — off window)
  // Help tab — Hotkey Toggles grid (dashboard-hotkey-toggles.js); data-on-change delegate
  'toggleHotkey',
  // Appearance tab — Sidebar Customizer grid (dashboard-sidebar-customizer.js);
  // its JS-built checkboxes carried CSP-dead inline onchange attrs until
  // 2026-06-09, now the data-on-change delegate (same shape as toggleHotkey)
  'toggleSidebarItem',
]);

// ══════════════════════════════════════════════
// ESTIMATE BUILDER state + rates
// ══════════════════════════════════════════════
let estCurrentStep=0, selectedTier=null, estData={};

// RATES (overrideable from settings)
const R = {
  shingle:185, felt:28, tear:55, starter:1.85, iws:72, drip:2.10,
  ridge:3.20, hip:3.20, pipe:65, deck:95, gutter:8.50, deckPct:0.15
};

// ══════════════════════════════════════════════
// DAMAGE PHOTOS state
// ══════════════════════════════════════════════
let currentPhotoLeadId=null, currentPhotoAddr='';

// ─── Photo count cache (April 2026) ───
// The "Photos Near Me" list used to show every lead in the CRM,
// sorted only by creation time. After knock segregation landed,
// knock-leads were still flooding this list. Worse: leads with
// zero photos were showing up first since they were newest,
// making it impossible to find a real customer with real photos
// when a homeowner was standing at the door.
//
// Fix: fetch photo counts per lead once, cache, then filter +
// sort the render to show photos-first and exclude prospects.
window._photoCountByLead = window._photoCountByLead || {};
window._photoCountsLoaded = false;

// Photo search — filters the photo leads list by name/address
window._photoSearchQuery = '';

// PHOTO upload limits
const PHOTO_MAX_SIZE = 15 * 1024 * 1024; // 15 MB per file
const PHOTO_MAX_BATCH = 25; // max photos per upload session (iOS 'Select All' safety cap)
const PHOTO_ALLOWED_TYPES = ['image/jpeg','image/png','image/webp','image/gif','image/heic','image/heif','image/avif'];

// ══════════════════════════════════════════════
// PROPERTY INTEL cache
// ══════════════════════════════════════════════
// Cache to avoid repeat lookups on same address
var _piCache = _piCache || {};

// ══════════════════════════════════════════════
// ADDRESS AUTOCOMPLETE caches + USPS data
// ══════════════════════════════════════════════
const _acTimers = {};
const _acCache  = {};

// Wave 141: USPS-standard road-suffix abbreviations + state name →
// 2-letter code mapping. Used by formatMailingAddress() below to
// produce a USPS-compliant single-line label like
// "1054 Klondyke Rd, Goshen, OH 45122" instead of the old
// comma-spliced "1054, Klondyke Road, Goshen".
//
// Source list mirrors USPS Pub 28 Appendix C — only the suffixes
// nominatim is realistically going to surface in the US (the full
// pub has 200+ variants we'd never see). Comparison is case-
// insensitive on the LAST whitespace-delimited token of road.
const _USPS_SUFFIX = Object.freeze({
  alley: 'Aly', avenue: 'Ave', boulevard: 'Blvd', branch: 'Br',
  bridge: 'Br', center: 'Ctr', circle: 'Cir', cliff: 'Clf',
  commons: 'Cmns', common: 'Cmn', corner: 'Cor', court: 'Ct',
  cove: 'Cv', creek: 'Crk', crossing: 'Xing', cross: 'Xrd',
  dale: 'Dl', divide: 'Dv', drive: 'Dr', estate: 'Est',
  expressway: 'Expy', extension: 'Ext', fall: 'Fall', fork: 'Frk',
  fort: 'Ft', freeway: 'Fwy', garden: 'Gdn', glen: 'Gln',
  green: 'Grn', grove: 'Grv', harbor: 'Hbr', haven: 'Hvn',
  heights: 'Hts', highway: 'Hwy', hill: 'Hl', hills: 'Hls',
  hollow: 'Holw', island: 'Is', junction: 'Jct', key: 'Ky',
  knoll: 'Knl', lake: 'Lk', land: 'Land', landing: 'Lndg',
  lane: 'Ln', light: 'Lgt', loaf: 'Lf', locks: 'Lcks',
  lodge: 'Ldg', loop: 'Loop', mall: 'Mall', manor: 'Mnr',
  meadow: 'Mdw', meadows: 'Mdws', mews: 'Mews', mill: 'Ml',
  mission: 'Msn', motorway: 'Mtwy', mount: 'Mt', mountain: 'Mtn',
  neck: 'Nck', orchard: 'Orch', overpass: 'Opas', park: 'Park',
  parkway: 'Pkwy', pass: 'Pass', passage: 'Psge', path: 'Path',
  pike: 'Pike', pine: 'Pne', place: 'Pl', plain: 'Pln',
  plaza: 'Plz', point: 'Pt', port: 'Prt', prairie: 'Pr',
  radial: 'Radl', ramp: 'Ramp', ranch: 'Rnch', rapids: 'Rpds',
  rest: 'Rst', ridge: 'Rdg', river: 'Riv', road: 'Rd',
  route: 'Rte', row: 'Row', run: 'Run', shoal: 'Shl',
  shore: 'Shr', skyway: 'Skwy', spring: 'Spg', square: 'Sq',
  station: 'Sta', stream: 'Strm', street: 'St', summit: 'Smt',
  terrace: 'Ter', throughway: 'Trwy', trace: 'Trce', track: 'Trak',
  trafficway: 'Trfy', trail: 'Trl', tunnel: 'Tunl', turnpike: 'Tpke',
  underpass: 'Upas', union: 'Un', valley: 'Vly', via: 'Via',
  viaduct: 'Via', view: 'Vw', village: 'Vlg', ville: 'Vl',
  vista: 'Vis', walk: 'Walk', way: 'Way', well: 'Wl',
});
const _STATE_2L = Object.freeze({
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR',
  california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI',
  idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME',
  maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE',
  nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM',
  'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX',
  utah: 'UT', vermont: 'VT', virginia: 'VA', washington: 'WA',
  'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
  // Territories that USPS handles
  'puerto rico': 'PR', 'us virgin islands': 'VI', guam: 'GU',
  'american samoa': 'AS', 'northern mariana islands': 'MP',
});

// ══════════════════════════════════════════════
// DOCUMENT LIBRARY state
// ══════════════════════════════════════════════
let _docFile = null;

// ══════════════════════════════════════════════
// THEME SYSTEM constants
// ══════════════════════════════════════════════
const THEME_KEYS = [
  // Original 16
  'nbd-original', 'midnight', 'cobalt', 'forest', 'crimson', 'gold', 'plasma', 'arctic', 'rose', 'obsidian', 'neon', 'steel', 'paper', 'slate', 'coffee', 'deep-space',
  // v5 additions
  'matrix','galaxy','ghost','glow','batman','darth-vader','lightsaber','pokemon','mario','zelda','arcade','retro','synthwave','vaporwave','lofi','typewriter','ink','blueprint-art',
  'army','cia','ninja','halloween','christmas','easter','underwater','volcanic','japan','wildwest','samurai',
  'android','ios','ios26','windows','terminal',
  'liquid','metal','translucent','frosted',
  'candlelit','ember','midnight-oil','deep-focus','neon-rain','noir','blood-moon','aurora','obsidian-v5','copper','sakura'
];
const DEFAULT_THEME = 'nbd-original';

// Declare that this surface (the dashboard) owns theming via the modern
// ThemeEngine. Set before maps.js executes (defer order: dashboard-state.js
// loads before maps.js) so maps.js's legacy boot defers to the engine instead
// of force-applying inline vars that fight it (audit F-1).
window.NBD_THEME_ENGINE = true;

// The theme cluster is a lazy bundle on dashboard.html (2026-08-07). Users
// with a saved non-default theme kick the fetch here — this file runs first
// in the defer queue, so the download overlaps the rest of boot instead of
// parse-blocking it. The eager-tag guard used to keep dashboard.legacy.html
// (which shipped the cluster as <script defer>) from double-loading; the twin
// was retired 2026-09-02 and the guard stays as cheap insurance. Default-
// theme users skip it entirely until Settings/picker.
(function () {
  try {
    const saved = localStorage.getItem('nbd_pro_theme') || localStorage.getItem('nbd-theme');
    if (saved && saved !== 'default'
        && !document.querySelector('script[src*="theme-engine"]')
        && window.ScriptLoader && window.ScriptLoader.loadBundle) {
      window.ScriptLoader.loadBundle('theme');
    }
  } catch (e) {}
})();

// Boot the theme immediately on page load — before any UI render happens so the
// first paint is themed. Canonical key first (nbd_pro_theme), then the legacy
// mirror (nbd-theme), matching the <head> preboot + ThemeEngine (audit F-1/F-2).
(function() {
  try {
    const saved = localStorage.getItem('nbd_pro_theme') || localStorage.getItem('nbd-theme');
    if(saved && saved !== '') document.documentElement.setAttribute('data-theme', saved);
    else document.documentElement.setAttribute('data-theme', DEFAULT_THEME);
  } catch(e) {
    document.documentElement.setAttribute('data-theme', DEFAULT_THEME);
  }
})();

// ══════════════════════════════════════════════
// KANBAN DENSITY + HIERARCHY constants + boot
// ══════════════════════════════════════════════
// Sets data-density / data-bold attrs on <html>; CSS reacts via :root[data-density="..."]
const KANBAN_DENSITY_KEY = 'nbd-kanban-density';
const KANBAN_BOLD_KEY = 'nbd-kanban-bold';

(function bootKanbanPrefs() {
  try {
    const d = localStorage.getItem(KANBAN_DENSITY_KEY) || 'comfortable';
    if (d !== 'comfortable') document.documentElement.setAttribute('data-density', d);
    const bold = localStorage.getItem(KANBAN_BOLD_KEY) === '1';
    if (bold) document.documentElement.setAttribute('data-bold', 'true');
  } catch (e) {}
})();

// ══════════════════════════════════════════════
// AUTO-THEME state (Wave 107)
// ══════════════════════════════════════════════
let _nbdAutoThemeInterval = null;

// Boot persisted comfort prefs on first load (alongside density
// which already gets applied in bootKanbanPrefs above).
(function bootComfortPrefs() {
  try {
    const size = localStorage.getItem('nbd_text_size');
    if (size && size !== 'medium') document.documentElement.setAttribute('data-text-size', size);
    const motion = localStorage.getItem('nbd_motion');
    if (motion === 'reduce') document.documentElement.setAttribute('data-motion', 'reduce');
    const pro = localStorage.getItem('nbd_professional_mode');
    if (pro === '1') document.body.classList.add('professional-mode');
    // W106: restore color-blind-safe pref on load
    const cbSafe = localStorage.getItem('nbd_cb_safe');
    if (cbSafe === '1') document.documentElement.setAttribute('data-cb-safe', '1');
  } catch (_) {}
})();

// ══════════════════════════════════════════════
// SIDEBAR / FULLSCREEN / SCROLL-COLLAPSE keys
// ══════════════════════════════════════════════
const SIDEBAR_COLLAPSED_KEY = 'nbd-sidebar-collapsed';
const CRM_AUTOCOLLAPSE_KEY = 'nbd-crm-autocollapse';

// Boot: restore sidebar collapse state so first paint shows the
// rep's preferred rail width.
(function bootSidebarCollapsed() {
  try {
    if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
      document.body.classList.add('sidebar-collapsed');
      const btn = document.getElementById('sidebarToggleBtn');
      if (btn) btn.classList.add('active');
    }
  } catch (e) {}
})();

// ══════════════════════════════════════════════
// DAILY PROGRAM SETTINGS constants + state
// ══════════════════════════════════════════════
const DS_NBD_CFG = 'nbd_user_config';
const DS_THEME_KEY = 'ds-theme';

const DS_THEMES = [
  { key:'nbd-original', label:'NBD Original', dot:'var(--orange)' },
  { key:'midnight',     label:'Midnight',     dot:'#6366f1' },
  { key:'cobalt',       label:'Cobalt',       dot:'#2563eb' },
  { key:'forest',       label:'Forest',       dot:'#16a34a' },
  { key:'crimson',      label:'Crimson',      dot:'#dc2626' },
  { key:'gold',         label:'Gold',         dot:'#d97706' },
  { key:'plasma',       label:'Plasma',       dot:'#a855f7' },
  { key:'arctic',       label:'Arctic',       dot:'#0ea5e9' },
  { key:'rose',         label:'Rose',         dot:'#e11d48' },
  { key:'obsidian',     label:'Obsidian',     dot:'#71717a' },
  { key:'neon',         label:'Neon',         dot:'#00cc6a' },
  { key:'coffee',       label:'Coffee',       dot:'#92400e' },
];

let dsFloors = [];
let dsSelectedTheme = 'nbd-original';

// ══════════════════════════════════════════════
// MOBILE NAVIGATION constants
// ══════════════════════════════════════════════
const MOBILE_NAV_TABS = ['dash','map','crm','est'];

// ══════════════════════════════════════════════
// TERRITORY ZONES state
// ══════════════════════════════════════════════
let zones = []; // {id, name, color, points, layer}
let zoneDrawing = false;
let zonePoints = [];
let zoneDots = [];
let zoneTempPoly = null;
let zoneColor = '#4A9EFF'; // hex (not var(--blue)) so a saved zone's colour survives reload through safeColor()
let zoneDrawLayer = null;

// ══════════════════════════════════════════════
// TASK SYSTEM state
// ══════════════════════════════════════════════
window._taskCache = {};
var _taskModalLeadId = _taskModalLeadId || null;

// ══════════════════════════════════════════════
// CRM SECONDARY HEADER setting
// ══════════════════════════════════════════════
const CRM_SEC_HEADER_SETTING = 'nbd_crm_sec_header_enabled';

// Auto-hide on scroll within kanban board — module-level scroll tracker
let _lastScrollTop = 0;

// ══════════════════════════════════════════════
// KANBAN CARD DETAIL MODAL state
// ══════════════════════════════════════════════
window._cardDetailLeadId = null;

// ══════════════════════════════════════════════
// DEMO DATA SEEDER constant
// ══════════════════════════════════════════════
const DEMO_EMAIL = 'demo@nobigdeal.pro';
