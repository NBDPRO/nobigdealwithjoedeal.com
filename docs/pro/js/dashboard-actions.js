/**
 * dashboard-actions.js — action handlers, lead / prospect ops, zone
 * draw, daily program logic, mobile-action wrappers, card-detail
 * forwarders, and the main goTo() router.
 *
 * Extracted from dashboard-main.js (Step 4a — 2026-05-16). Fifth in
 * the state→api→widgets→ui→actions→main load chain. The shim file
 * (dashboard-main.js) loads after this and owns DOMContentLoaded +
 * hashchange + waitForLeaflet only.
 *
 * Lives here:
 *   - goTo() router (depends on _hydrateViewTemplate from ui.js +
 *     showToast + numerous lazy-init module checks)
 *   - the giant block of `if (typeof X !== 'undefined') window.X = X`
 *     forward references that surface other modules' globals
 *   - all cda* card-detail action wrappers + compound onclick rewrites
 *     (mCreateFabRoute, openDailyProgramFromMore, etc.)
 *   - mobile job-detail / mobile inspection / mobile create-popover
 *     action handlers (_mJdAct, _mJdShare, _mJdSwitchTab, _mCreate,
 *     _mCreatePhotoPicked, openLeadDetail)
 *   - territory zone draw (selectZoneColor, startZoneDraw,
 *     cancelZoneDraw, saveZone, deleteZone)
 *   - prospect/customer page handoff (_stashLeadForCustomerPage,
 *     openPhotosForLead, openDocsForLead, openFullCustomerDetails,
 *     editCardDetails)
 *   - prospect ops (confirmPromoteProspect, toggleProspectHidden,
 *     viewProspectOnMap, absoluteDeleteProspect)
 *   - loadSampleData / damageNearMePhotos
 *   - daily-program config logic (dsGetConfig, dsLoadConfig,
 *     dsDefaultFloors, dsAddFloor, dsRemoveFloor, dsSaveConfig,
 *     dsResetDefaults)
 */

// ══════════════════════════════════════════════
// CARD-DETAIL ACTION WRAPPERS (registered first
// so the data-action delegate can resolve them
// the moment a card-detail modal opens)
// ══════════════════════════════════════════════
// C.4 finale — card-detail action helpers. These wrap the live
// `window._cardDetailLeadId` global (set when a card-detail modal
// opens) and the defensive module-load fallback into single named
// globals that the `call` delegate dispatches.
let _NBD_DA_DELEGATE; // module-local (globals Tranche 1 — was window.*)

// ══════════════════════════════════════════════
// ONE-OFF OPENERS + MOBILE-ROUTE TAIL — Globals Tranche 2c-4c (2026-07-07)
// ══════════════════════════════════════════════
// 20 markup-dispatched compound-rewrite openers (+ the two 2c-4b mobile-route
// tail names mCreateFabRoute/mQuickAddRoute), consolidated OFF window into this
// IIFE and registered in __NBD_CALL_REGISTRY (resolved first by the
// dashboard-ui.js `call` delegate). All markup-only — none has a window/bare/
// dynamic cross-boundary consumer, so none is re-exported and all 20 leave
// _NBD_CALL_ALLOWLIST. Bare callees (goTo, showToast, closeMobileMore,
// openLeadModal, nbdPickerOpen, switchSettingsTab, setDrawMode) and the
// window.* module APIs resolve up-scope, unaffected by the wrap. See
// docs/dev/dashboard-actions-globals-audit.md.
(function () {

// C.4 finale — More-drawer compound rewrites. The original onclicks
// were `mobileNav('home');closeMobileMore()` style chains; we
// consolidate the side-effects here so the markup uses data-action="call".
function openDailyProgramFromMore() {
  if (typeof closeMobileMore === 'function') closeMobileMore();
  window.location.href = '/pro/daily-success';
};

// C.4 finale — mobile FAB create routing. Replaces the ternary
// `window.toggleMobileCreatePopover ? toggleMobileCreatePopover() : openLeadModal()`.
function mCreateFabRoute() {
  if (typeof window.toggleMobileCreatePopover === 'function') {
    window.toggleMobileCreatePopover();
  } else if (typeof openLeadModal === 'function') {
    openLeadModal();
  }
};


// C.4 finale — ternary / compound rewrites for the few one-off handlers
// that don't fit the generic call / module shapes.
function mQuickAddRoute() {
  if (typeof closeQuickAddLead === 'function') closeQuickAddLead();
  if (typeof openLeadModal === 'function') openLeadModal();
};
function restartOnboardingTour() {
  if (window.OnboardingTour && typeof window.OnboardingTour.forceRestart === 'function') {
    window.OnboardingTour.forceRestart();
  } else if (typeof showToast === 'function') {
    showToast('Tour module loading...', 'error');
  }
};
function openDecisionPicker() {
  // NEW-D15: the decision-engine bundle is lazy and wired (in script-loader's
  // VIEW_BUNDLES) only to aitree/understand — never to #/joe, where the
  // "⚡ Scenarios" button lives. Load the 'decision' bundle on demand before
  // opening, mirroring the estimate/photo lazy stubs below.
  const _open = function () {
    if (window.DecisionEngine && typeof window.DecisionEngine.openPicker === 'function') {
      window.DecisionEngine.openPicker();
    } else if (typeof showToast === 'function') {
      showToast('Decision engine loading...', 'error');
    }
  };
  if (window.DecisionEngine && typeof window.DecisionEngine.openPicker === 'function') {
    _open();
  } else if (window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
    window.ScriptLoader.loadBundle('decision').then(_open);
  } else {
    _open();
  }
};
function openD2DOrGo() {
  const ready = function () { return !!(window.D2D && typeof window.D2D.openQuickKnock === 'function'); };
  if (ready()) { window.D2D.openQuickKnock(); return; }
  if (typeof goTo !== 'function') return;
  // The tracker rides the lazy 'd2d' ScriptLoader bundle, so on a cold tap
  // window.D2D does not exist yet. This used to stop at goTo('d2d') — the
  // rep asked for a knock form and got the map, then had to find KNOCK and
  // tap again (phone audit 2026-09-25, pipeline#8; same on Prospects'
  // "＋ New Knock"). goTo('d2d') loads the bundle and inits the tracker;
  // wait for the API, then open the form — but only if the rep is still on
  // D2D, so a slow load can't pop a knock sheet over wherever they went next.
  // 8s matches goTo's own waitForD2D budget, which shows the failure UI.
  goTo('d2d');
  let tries = 0;
  const iv = setInterval(function () {
    tries++;
    if (ready()) {
      clearInterval(iv);
      const onD2D = document.getElementById('view-d2d');
      if (onD2D && onD2D.classList.contains('active')) window.D2D.openQuickKnock();
    } else if (tries > 80) {
      clearInterval(iv);
    }
  }, 100);
};
function clearAccentTheme() {
  if (window.ThemeGX && typeof window.ThemeGX.clearAccentOverride === 'function') {
    window.ThemeGX.clearAccentOverride();
  }
  const picker = document.getElementById('customAccentColorPicker');
  if (picker) picker.value = '#BD5728';
};
function openSettingsTab(tabKey) {
  if (typeof nbdPickerOpen === 'function') {
    nbdPickerOpen();
  } else {
    if (typeof goTo === 'function') goTo('settings');
    setTimeout(function(){
      if (typeof switchSettingsTab === 'function') switchSettingsTab(tabKey);
    }, 200);
  }
};
function openPhotoEngineOrClickProxy(fallbackInputId) {
  if (window.PhotoEngine && typeof window.PhotoEngine.openCamera === 'function') {
    window.PhotoEngine.openCamera();
  } else if (fallbackInputId) {
    document.getElementById(fallbackInputId)?.click();
  }
};
function openReportGenerator() {
  if (window.NBDReports && typeof window.NBDReports.openGenerator === 'function') {
    window.NBDReports.openGenerator();
  } else if (typeof showToast === 'function') {
    showToast('Report engine loading…', 'error');
  }
};
function enrichReportData() {
  if (window.NBDReports && typeof window.NBDReports.enrichData === 'function') {
    window.NBDReports.enrichData();
  } else if (typeof showToast === 'function') {
    showToast('Report engine loading…', 'error');
  }
};
function openPhotoEngineCurrentLead() {
  if (window.PhotoEngine && typeof window.PhotoEngine.openCamera === 'function') {
    window.PhotoEngine.openCamera(window._currentPhotoLeadId || '');
  } else if (typeof showToast === 'function') {
    showToast('Photo engine loading…', 'error');
  }
};
function openInspectionBuilderCurrentLead() {
  if (!(window.InspectionReportEngine && typeof window.InspectionReportEngine.openBuilder === 'function')) {
    if (typeof showToast === 'function') showToast('Report engine loading…', 'error');
    return;
  }
  const lid = window._currentPhotoLeadId || window._leadId || window._currentLeadId || '';
  if (!lid) {
    // openBuilder('') said "Lead not found", which reads like data loss. The
    // real problem is that no property has been picked yet — say that, and
    // put the rep on the picker.
    if (typeof showToast === 'function') showToast('Pick a property first, then tap New Report.', 'info');
    const sel = document.getElementById('photoLeadSelect');
    if (sel) { try { sel.scrollIntoView({ block: 'center' }); } catch (_) {} sel.focus(); }
    return;
  }
  // "📄 New Report" rendered the whole builder into #inspectionBuilderContainer
  // and never showed the overlay around it — the builder existed, 0x0, and the
  // tap did nothing visible (phone audit 2026-09-25, views#2; a CSP-extraction
  // carry-over — the old inline onclick had the same gap). cdaInspectionDeep
  // below shows the overlay first; this does the same, but only once
  // openBuilder has actually rendered (it bails with a toast on an unknown
  // lead, and an empty full-screen overlay would be worse than nothing).
  const overlay = document.getElementById('inspectionBuilderOverlay');
  const container = document.getElementById('inspectionBuilderContainer');
  if (container) container.innerHTML = '';
  Promise.resolve(window.InspectionReportEngine.openBuilder('inspectionBuilderContainer', lid)).then(function () {
    if (overlay && container && container.children.length) {
      overlay.style.display = 'block';
      overlay.scrollTop = 0;
    }
  });
};
function closeInspectionBuilder() {
  const overlay = document.getElementById('inspectionBuilderOverlay');
  const container = document.getElementById('inspectionBuilderContainer');
  if (overlay) overlay.style.display = 'none';
  if (container) container.innerHTML = '';
};
function hideFollowUpAlerts() {
  const wrap = document.getElementById('followUpAlertsWrap');
  if (wrap) wrap.style.display = 'none';
  try { localStorage.setItem('nbd_crm_followup_hidden', '1'); } catch (e) {}
};
function goToD2DFromMaps() {
  if (typeof goTo === 'function') goTo('d2d');
  // The clicked #nav-map keeps focus, and its :focus-visible/:hover styling
  // read as a second active item beside Door-to-Door.
  try { const ae = document.activeElement; if (ae && ae !== document.body && !/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) && typeof ae.blur === 'function') ae.blur(); } catch (e) {}
  try {
    if (!localStorage.getItem('nbd_maps_redirect_seen')) {
      if (typeof showToast === 'function') {
        showToast('Maps features are now part of D2D Tracker — use the layer toggles on the map', 'info');
      }
      localStorage.setItem('nbd_maps_redirect_seen', '1');
    }
  } catch (e) {}
};
function openCalBookingUrl() {
  const input = document.getElementById('calBookingUrl');
  if (input && input.value) window.open(input.value, '_blank', 'noopener');
};
function hardResetTest() {
  if (typeof window.__nbdHardReset === 'function') window.__nbdHardReset();
};
function gstaticTest() {
  if (typeof window.__nbdGstaticTest === 'function') window.__nbdGstaticTest();
};
function modeLineDraw() {
  // The original onclick was setDrawMode('line', document.getElementById('modeLineBtn'))
  // — explicit element ref because the user might activate via keyboard shortcut
  // and we still want the active-state ring on the line button.
  if (typeof setDrawMode === 'function') {
    setDrawMode('line', document.getElementById('modeLineBtn'));
  }
};

  // 🛡️ Storm Proof (card detail) — storm-integration.js rides the lazy
  // 'storm' ScriptLoader bundle, but its button sits on EVERY customer
  // card's detail, reachable without ever entering the Storm view. Until
  // the bundle loads there is no registry entry, and the data-action="call"
  // delegate no-ops silently on an unresolved fn — a dead button. This
  // eager stub loads the bundle on first tap and hands off; when the
  // bundle lands, storm-integration.js's own Object.assign REPLACES this
  // stub in the registry, so every later tap dispatches straight through.
  async function verifyStormProofForLeadLazy() {
    if (window.StormIntegration && typeof window.StormIntegration.verifyStormProofForLead === 'function') {
      return window.StormIntegration.verifyStormProofForLead();
    }
    if (typeof showToast === 'function') showToast('Loading storm tools…', 'info');
    try {
      await window.ScriptLoader.loadBundle('storm');
    } catch (e) {
      if (typeof showToast === 'function') showToast('Could not load storm tools — check your connection', 'error');
      return;
    }
    if (window.StormIntegration && typeof window.StormIntegration.verifyStormProofForLead === 'function') {
      return window.StormIntegration.verifyStormProofForLead();
    }
    if (typeof showToast === 'function') showToast('Storm tools unavailable', 'error');
  }

  // Registration IS the security opt-in; all entries are markup-dispatched
  // only (no window re-export — none has a cross-boundary consumer).
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, {
    verifyStormProofForLead: verifyStormProofForLeadLazy,
    openDailyProgramFromMore: openDailyProgramFromMore,
    mCreateFabRoute: mCreateFabRoute,
    mQuickAddRoute: mQuickAddRoute,
    restartOnboardingTour: restartOnboardingTour,
    openDecisionPicker: openDecisionPicker,
    openD2DOrGo: openD2DOrGo,
    clearAccentTheme: clearAccentTheme,
    openSettingsTab: openSettingsTab,
    openPhotoEngineOrClickProxy: openPhotoEngineOrClickProxy,
    openReportGenerator: openReportGenerator,
    enrichReportData: enrichReportData,
    openPhotoEngineCurrentLead: openPhotoEngineCurrentLead,
    openInspectionBuilderCurrentLead: openInspectionBuilderCurrentLead,
    closeInspectionBuilder: closeInspectionBuilder,
    hideFollowUpAlerts: hideFollowUpAlerts,
    goToD2DFromMaps: goToD2DFromMaps,
    openCalBookingUrl: openCalBookingUrl,
    hardResetTest: hardResetTest,
    gstaticTest: gstaticTest,
    modeLineDraw: modeLineDraw,
  });
})();

// ══════════════════════════════════════════════
// NAVIGATION ROUTER — goTo()
// ══════════════════════════════════════════════
function goTo(name, params = {}) {
  // ── Lite tier gate: block Pro-only views ──
  if (window._userPlan === 'lite' && PRO_ONLY_VIEWS.includes(name)) {
    showToast('Upgrade to access this feature — plans start at $99/mo', 'error');
    return;
  }

  // ── Maps & Pins is retired → D2D (map unification, phase C) ──
  // Its pins/heat/jobs/territories are all unified into the D2D map, plus
  // knocks, the dots⇄pins look, follow mode, and on-map search. Route the
  // legacy 'map' key to 'd2d' (placed AFTER the lite gate so 'map' keeps its
  // Pro gating). One-time heads-up so the change isn't a surprise. The
  // #view-map DOM stays in the page — only the nav entry point moves — so
  // this is trivially reversible.
  if (name === 'map') {
    name = 'd2d';
    try {
      if (!localStorage.getItem('nbd_maps_redirect_seen')) {
        showToast('Maps & Pins is now the D2D map — same pins, plus knocks, layers, follow mode & search', 'info', 5000);
        localStorage.setItem('nbd_maps_redirect_seen', '1');
      }
    } catch (e) {}
  }

  // Force-exit bulk-select mode whenever leaving the kanban — otherwise a
  // bulk selection started on the CRM bleeds into the next view's click
  // handlers (e.g. tapping a prospect card opens a checkbox toggle instead
  // of the detail modal). Audit fix H4. exitBulkMode is registry-only
  // (crm-portal-bridge.js, Globals Tranche 3 T3-C); a missing entry is a no-op.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (name !== 'crm' && window._bulkMode && _nbdReg && typeof _nbdReg.exitBulkMode === 'function') {
    _nbdReg.exitBulkMode();
  }

  // Update URL hash (without triggering hashchange event)
  if (!params.skipHash) {
    const hash = params.id ? `#/${name}/${params.id}` : `#/${name}`;
    if (window.location.hash !== hash) {
      window.location.hash = hash;
    }
  }

  // Hydrate templated views the first time they're shown.
  _hydrateViewTemplate(name);

  // Update UI
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.ni').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.crm-sec-btn').forEach(btn => btn.classList.remove('active'));
  const view = document.getElementById('view-'+name);
  const nav  = document.getElementById('nav-'+name);
  // NEW-E1 hardening: an unknown route key (a stale bookmark, a renamed view,
  // or a hand-typed #/<garbage> hash) has no `view-<name>` element at all —
  // _hydrateViewTemplate no-ops on it — so the .view deactivation above would
  // leave a blank screen with no view active. Fall back to the always-present
  // CRM pipeline instead. The `name !== 'crm'` guard prevents infinite
  // recursion in the impossible case that view-crm itself is missing.
  if (!view && name !== 'crm') { goTo('crm'); return; }
  if(view) view.classList.add('active');
  if(nav)  nav.classList.add('active');

  // Highlight active secondary toolbar tab
  const secBtns = document.querySelectorAll('.crm-sec-btn');
  secBtns.forEach(btn => {
    const onclick = btn.getAttribute('onclick');
    if(onclick && onclick.includes(`'${name}'`)) btn.classList.add('active');
  });

  // Update breadcrumb
  updateBreadcrumb(name, params);

  // Lazy-load the view's script bundle. ScriptLoader resolves an
  // already-eager-loaded bundle immediately, so this is a no-op for
  // views not in the bundle map. Returning a promise lets specific
  // views below chain init onto it when their module ships lazy.
  const _lazyPreload = (window.ScriptLoader && typeof window.ScriptLoader.preloadForView === 'function')
    ? window.ScriptLoader.preloadForView(name)
    : Promise.resolve();

  // View-specific initialization
  // Maps require both Leaflet (sync) AND maps.js (deferred) to be loaded.
  // waitForLeaflet handles the first; we also need to wait for initDrawMap/initMainMap.
  function waitForMapFn(fnName, cb) {
    if (typeof window[fnName] === 'function') { cb(); return; }
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (typeof window[fnName] === 'function') { clearInterval(t); cb(); }
      else if (tries > 80) { clearInterval(t); console.error(fnName + ' never loaded'); }
    }, 50);
  }
  // Helper: ensure Leaflet map is properly sized after view becomes visible.
  // Uses rAF → rAF to guarantee the browser has painted the container with
  // real dimensions before Leaflet measures it.
  function ensureMapSize(mapObj, retries) {
    if (!mapObj) return;
    requestAnimationFrame(function() {
      requestAnimationFrame(function() {
        mapObj.invalidateSize();
        // Extra retries to cover Safari standalone paint delays
        if (retries !== false) {
          setTimeout(function() { if(mapObj) mapObj.invalidateSize(); }, 200);
          setTimeout(function() { if(mapObj) mapObj.invalidateSize(); }, 800);
          setTimeout(function() { if(mapObj) mapObj.invalidateSize(); }, 2000);
        }
      });
    });
  }
  if(name==='dash') {
    // QA 2026-06-21 #9: the ops-overview KPI tiles (statLeads / statVal /
    // statClosed / statEsts) are populated only as a side-effect of
    // renderLeads / renderEstimatesList during BOOT. SPA route-enter to #/dash
    // never refreshed them, so the overview showed the $0 HTML defaults until a
    // full reload. Repopulate from the in-memory sets on every dash entry.
    // Metrics audit F1: statVal is written ONLY by renderLeads now
    // (renderEstimatesList no longer touches it), so the call order below is
    // no longer load-bearing. _filteredLeads is passed through so the hidden
    // CRM filter state is preserved (renderLeads keeps it when the 2nd arg is
    // the current filter).
    try {
      if (typeof window.renderEstimatesList === 'function') window.renderEstimatesList(window._estimates || []);
      if (typeof window.renderLeads === 'function' && Array.isArray(window._leads)) window.renderLeads(window._leads, window._filteredLeads);
    } catch (e) { console.warn('dash KPI refresh failed:', e); }
    // QA 2026-06-21 #9b: the dashboard widget SECTIONS (hot-leads, smart-followup
    // briefing, almost-there, stale-shares, engagement-cohort, bottleneck) render
    // off the 'nbd:data-refreshed' signal, which fires during boot — BEFORE the
    // view-dash template is hydrated, so their body elements didn't exist yet and
    // the sections stayed stuck on 'Loading…' when reached via SPA route-enter
    // (only a full page load fixed them). The template is hydrated by this point
    // (_hydrateViewTemplate ran above), so re-emit the signal to make every
    // widget re-render into its now-present body. Idempotent + already fires
    // frequently in normal use (task/snooze/lead-load), so no new churn.
    try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'dash-enter' } })); } catch (e) {}
  }
  if(name==='est') {
    // Same QA #9b pattern as view-dash above: the estimate-analytics band
    // (#estStats, estimate-analytics.js) renders off 'nbd:data-refreshed',
    // which mostly fires during boot — before the est template is hydrated
    // (Rock 4 Phase 4 templated the last raw view). Re-emit post-hydration
    // so the band renders on first open instead of waiting for the next
    // natural data event. Idempotent; the renderer null-guards #estStats.
    //
    // Phone audit 2026-09-25 (estimate#0): the LIST itself had the same
    // problem and nobody re-ran it. loadEstimates() and the live snapshot both
    // call renderEstimatesList during boot, while #estListWrap is still inside
    // the un-hydrated <template> — so it returns at its `if (!wrap)` bail, and
    // the first real open showed the template's static "No estimates yet"
    // under a KPI band counting them. Not rig-specific: it hits any session
    // whose estimates land before the rep first opens the view, i.e. every
    // normal one; only a cold load straight to #/est (hydrated at boot) or a
    // later snapshot (a save, a signature webhook) ever painted it. Repaint
    // from the in-memory set on every entry, as the dash branch above does.
    // Array-gated: before the first load resolves there is nothing true to
    // paint, and loadEstimates renders into the now-present wrapper itself.
    try {
      if (typeof window.renderEstimatesList === 'function' && Array.isArray(window._estimates)) {
        window.renderEstimatesList(window._estimates);
      }
    } catch (e) { console.warn('est list refresh failed:', e); }
    try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'est-enter' } })); } catch (e) {}
  }
  if(name==='map') {
    if (!mapInited.map) {
      waitForLeaflet(()=>{ waitForMapFn('initMainMap', ()=>{
        (()=>{ initMainMap(); mapInited.map=true; ensureMapSize(mainMap); })();
      }); });
    } else if (typeof mainMap !== 'undefined' && mainMap) {
      ensureMapSize(mainMap);
    }
  }
  if(name==='draw') {
    if (!mapInited.draw) {
      waitForLeaflet(()=>{ waitForMapFn('initDrawMap', ()=>{
        (()=>{ initDrawMap(); mapInited.draw=true; ensureMapSize(drawMap); })();
      }); });
    } else if (typeof drawMap !== 'undefined' && drawMap) {
      // Re-entry: map already created, just refresh the size
      ensureMapSize(drawMap);
    }
  }
  // CRM: re-render kanban on every entry (not just first)
  if(name==='crm') {
    // NOT gated on _leads.length. That gate meant a tenant with zero leads got
    // no buildKanbanColumns() and no renderLeads() at all — so Pipeline, their
    // primary nav item, painted the header ("0 leads · $0 pipeline") and then
    // literally nothing: no columns, no drop targets, no message. It reads as a
    // board that failed to load, on the screen a new contractor opens first.
    //
    // The empty state was already written and simply never ran —
    // dashboard-bootstrap.module.js emits a per-column "No leads" cell. Same
    // count-gate was removed from the boot path in Wave 120 and left behind
    // here; this is that removal finished.
    if (typeof renderLeads === 'function') {
      // Ensure kanban columns exist
      if (!document.getElementById('kanbanBoard')?.children?.length && typeof window.buildKanbanColumns === 'function') {
        window.buildKanbanColumns(window._currentViewKey || 'insurance');
      }
      renderLeads(window._leads || [], window._filteredLeads);
    }
  }
  // These views' modules are lazy-loaded — chain init onto the preload
  // promise so the init call runs AFTER the module has defined the
  // window global it needs.
  if(name==='storm')      { _lazyPreload.then(() => { if (window.StormCenter) window.StormCenter.init(); }); }
  if(name==='closeboard') { _lazyPreload.then(() => { if (window.CloseBoard)  window.CloseBoard.init();  }); }
  if(name==='expenses')   { _lazyPreload.then(() => { if (window.Expenses)    window.Expenses.init();    }); }
  if(name==='money')      { _lazyPreload.then(() => { if (window.MoneyDashboard) window.MoneyDashboard.init(); }); }
  if(name==='refrewards') { if (window.ReferralRewards) window.ReferralRewards.render(); }
  if(name==='repos')      { _lazyPreload.then(() => { if (window.RepOS)       window.RepOS.init();       }); }
  if(name==='talk-tank')  { _lazyPreload.then(() => { if (window.TalkTank)  window.TalkTank.init();  }); }
  if(name==='board') { if(window.AnalyticsKPI) window.AnalyticsKPI.render('analyticsContainer'); if(window.AiTextingStatsCard) window.AiTextingStatsCard.render(); if(window.AdjusterTacticCard) window.AdjusterTacticCard.render(); renderLeaderboard(); }
  if(name==='photos') {
    // Consolidation 2026-07-19: the skeleton system existed with zero
    // callers — the view booted on whatever was previously painted.
    if (typeof window.showPhotosSkeleton === 'function') { try { window.showPhotosSkeleton(); } catch (_) {} }
    renderPhotoLeads();
    // Populate lead selector for photo engine
    const sel = document.getElementById('photoLeadSelect');
    if (sel && window._leads) {
      sel.innerHTML = '<option value="">Select a property...</option>';
      window._leads.forEach(l => {
        const opt = document.createElement('option');
        opt.value = l.id;
        // Form-created leads carry firstName/lastName, not `name`.
        const nm = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || 'Unknown';
        opt.textContent = nm + ' — ' + (l.address || 'No address');
        sel.appendChild(opt);
      });
      // Restore last selected lead
      if (window._currentPhotoLeadId) sel.value = window._currentPhotoLeadId;
    }
  }
  if(name==='settings') { setTimeout(() => switchSettingsTab('profile'), 50); }
  if(name==='home') { if(window.NBDWidgets) window.NBDWidgets.render(); }
  if(name==='prospects') {
    // Init / refresh on every entry so a prospect promoted from another
    // view immediately disappears here, and a new D2D knock immediately appears.
    if (window.Prospects) {
      if (!window.Prospects._inited) {
        window.Prospects.init();
        window.Prospects._inited = true;
      } else {
        window.Prospects.refresh();
      }
    }
  }
  if(name==='d2d') {
    // D2D content (feed, stats, knocks) loads independently of Leaflet.
    // waitForD2D polls for window.D2D (set at the end of d2d-tracker.js IIFE).
    // In practice window.D2D is always set before goTo('d2d') can fire
    // (defer scripts run before DOMContentLoaded), but we poll defensively
    // to cover edge cases where d2d-tracker.js is served a 503 by the SW
    // on first load after a cache-version bump (poor connectivity + empty
    // nbd-cdn cache). In that case we surface a retry button instead of
    // leaving the spinner up forever.
    function waitForD2D(cb) {
      if (window.D2D) { cb(); return; }
      let t2 = 0;
      const iv = setInterval(()=> {
        t2++;
        if (window.D2D) {
          clearInterval(iv);
          cb();
        } else if (t2 > 160) { // 8 seconds
          clearInterval(iv);
          console.error('D2D never loaded — d2d-tracker.js may have failed to load');
          const c = document.getElementById('d2dContent');
          if (c) c.innerHTML = '<div class="nbd-empty"><div class="ne-icon">😕</div><div class="ne-msg">D2D Tracker failed to load.</div><div class="ne-sub">Check your connection and try again.</div><button data-da-action="reload" style="background:var(--orange);color:var(--accent-fg);border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">Reload</button></div>';
        }
      }, 50);
    }
    waitForD2D(()=>{
      // Always call init() — initD2D() is idempotent via its internal
      // d2dInited flag. On first load it runs full init + renderD2D.
      // On re-entry it re-renders + invalidates the map size. This also
      // handles the case where a previous init() threw before completing:
      // window._d2dInited would be stale-true but d2dInited would be
      // false, so init() correctly re-runs the full sequence.
      //
      // Direct call (not requestAnimationFrame) — RAF is the only timing
      // primitive Chrome FULLY PAUSES on hidden/occluded tabs. If the
      // user's window briefly loses focus (alt-tab, another window covers
      // it, multi-monitor switch), an RAF callback queued moments before
      // never fires, leaving the map blank until the user does something
      // that forces re-init. initD2D's own setTimeout(initD2DMap, 200)
      // handles the "wait for paint before Leaflet measures" need
      // without depending on tab visibility.
      window.D2D.init();

      // Belt-and-suspenders watchdog: independent of d2d-tracker.js. If
      // #d2dContent still shows the static "Loading…" placeholder after
      // 14 seconds (8s Firestore timeout + padding), something inside
      // initD2D() hung silently. Replace with a user-visible retry UI so
      // the spinner never stays forever regardless of root cause.
      setTimeout(() => {
        const c = document.getElementById('d2dContent');
        if (c && c.textContent.includes('Loading Door-to-Door')) {
          console.error('[d2d-watchdog] initD2D hung — replacing spinner with retry UI');
          c.innerHTML = '<div class="nbd-empty"><div class="ne-icon">😕</div><div class="ne-msg">D2D Tracker took too long to load.</div><div class="ne-sub">Check your connection and try again.</div><button data-da-action="reload" style="background:var(--orange);color:var(--accent-fg);border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">Reload</button></div>';
        }
      }, 14000);
    });
  }
  if(name==='training') { _lazyPreload.then(() => { if (window.SalesTraining) window.SalesTraining.init(); }); }
  if(name==='academy') {
    _lazyPreload.then(() => {
      if (window.RealDealAcademy) {
        window.RealDealAcademy.init();
        window.RealDealAcademy.renderAcademy('academyContainer');
      }
    });
  }
  if(name==='products') {
    // PR 2c: product-library ships in the lazy 'estimates' bundle, which the
    // products view preloads (VIEW_BUNDLES). Chain the render on that preload
    // so window._productLib exists when we read it. The fallback render lives
    // in __NBD_CALL_REGISTRY, not on window (Globals Tranche 3 T3-C,
    // 2026-09-18) — read here, after the bundle load, never captured before.
    _lazyPreload.then(function () {
      const pc = document.getElementById('productLibraryContainer');
      if (pc && window._productLib) { pc.innerHTML = window._productLib.render(); }
      else if (pc && window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.renderProductLibrary === 'function') { pc.innerHTML = window.__NBD_CALL_REGISTRY.renderProductLibrary(); }
    });
  }
  if(name==='job-templates') {
    // Job-template library rides the same lazy 'estimates' bundle as the
    // products view (it resolves pricing through EstimateLogic). Same
    // registry-only fallback as the products branch above (T3-C, 2026-09-18).
    _lazyPreload.then(function () {
      const jc = document.getElementById('jobTemplatesContainer');
      if (jc && window.JobTemplatesUI) { jc.innerHTML = window.JobTemplatesUI.render(); }
      else if (jc && window.__NBD_CALL_REGISTRY && typeof window.__NBD_CALL_REGISTRY.renderJobTemplatesLibrary === 'function') { jc.innerHTML = window.__NBD_CALL_REGISTRY.renderJobTemplatesLibrary(); }
    });
  }
  if(name==='reports') {
    // rep-report-generator is lazy-loaded via ScriptLoader.preloadForView.
    // Chain init so it runs once the module has registered NBDReports.
    _lazyPreload.then(() => {
      if (window.NBDReports && typeof window.NBDReports.init === 'function') {
        window.NBDReports.init();
      }
    });
    // Lead Source ROI panel — instant render off the live lead cache.
    // Init only once; afterward it self-updates on the leadsChanged event.
    if (window.LeadSourceROI && !window.LeadSourceROI._inited) {
      window.LeadSourceROI.init('leadSourceROIPanel');
      window.LeadSourceROI._inited = true;
    } else if (window.LeadSourceROI) {
      window.LeadSourceROI.render('leadSourceROIPanel');
    }
    // Pipeline Forecast — same init-once-then-live-update pattern.
    if (window.Forecasting && !window.Forecasting._inited) {
      window.Forecasting.init('forecastPanel');
      window.Forecasting._inited = true;
    } else if (window.Forecasting) {
      window.Forecasting.render('forecastPanel');
    }
  }
  // ── AI tool iframes — lazy-load on first open ──
  // Each AI tool page is embedded as an iframe inside its view.
  // The iframe src is stored in data-src and only set on first
  // navigation, so pages don't load until the user actually opens
  // the tool. This keeps dashboard startup fast.
  const _iframeMap = {
    'aitree': 'iframe-aitree',
    'understand': 'iframe-understand',
    'projectcodex': 'iframe-projectcodex',
    'aiusage': 'iframe-aiusage'
  };
  if (_iframeMap[name]) {
    const iframe = document.getElementById(_iframeMap[name]);
    if (iframe && !iframe.src && iframe.dataset.src) {
      iframe.src = iframe.dataset.src;
    }
  }
}

// ══════════════════════════════════════════════
// TERRITORY ZONES — draw / save / delete
// ══════════════════════════════════════════════
// Globals Tranche 3 slice T3-0 (2026-08-31): the whole zone cluster is
// wrapped in this in-file IIFE so its top-level declarations stop becoming
// auto-globals. The five markup/cross-file entry points register in
// __NBD_CALL_REGISTRY (dashboard-ui.js resolves it BEFORE the allowlisted
// window fallback); the eight helpers below them have no external caller and
// stay private. renderSavedZones is the one deliberate export — maps-core.js
// and dashboard-bootstrap.module.js both invoke it through window after their
// own async work resolves, so it keeps its window binding at the foot of this
// IIFE.
//
// This slice was unblocked, not merely deferred: the audit deferred zone-draw
// because maps.js re-stated these names with an UNGUARDED right-hand side, so
// scoping them would ReferenceError at maps.js load and take the map surface
// down. That block became typeof-guarded and try/catch-fenced on 2026-08-07
// (PR #1194), so the guards simply evaluate false now and the re-export lines
// were deleted with this slice.
(function () {
function selectZoneColor(color, el) {
  zoneColor = color;
  document.querySelectorAll('#zoneColorPicker > div').forEach(d => d.style.borderColor = 'transparent');
  el.style.borderColor = '#fff';
}

// Fill the zone rep picker from the shared rep palette (maps-customers). Keeps
// the leading "no rep" option; each rep option carries its palette colour in a
// data attribute so saveZone can shade the zone without re-deriving.
function _populateZoneReps() {
  const sel = document.getElementById('zoneRepSelect');
  if (!sel) return;
  const reps = (typeof window.nbdRepList === 'function') ? (window.nbdRepList() || []) : [];
  const prev = sel.value;
  let html = '<option value="">Assign to rep (optional)…</option>';
  reps.forEach(function (r) {
    html += '<option value="' + String(r.key).replace(/"/g, '&quot;') + '" data-color="' + r.color + '">'
      + String(r.label).replace(/</g, '&lt;') + '</option>';
  });
  sel.innerHTML = html;
  if (prev) sel.value = prev;
}

function startZoneDraw() {
  if(!mainMap) { showToast('Open the map first','error'); return; }
  zoneDrawing = true;
  zonePoints = [];
  zoneDots = [];
  // zonePanel lives inside tpl-view-map (lazy-hydrated). Use optional
  // chaining so a stray invocation outside #/map doesn't null-deref.
  document.getElementById('zonePanel')?.classList.add('visible');
  // Populate the rep picker so a zone can be assigned to (and shaded by) a rep.
  _populateZoneReps();
  showToast('Click map to draw zone boundary. Click Save when done.');
  mainMap.getContainer().style.cursor = 'crosshair';

  // Attach zone click handler. Re-entering zone-draw overwrites
  // _zoneClick before cancel/save can off() it, leaving the orphaned
  // handler attached — each click then adds 2+ points (NEW-D38).
  if (mainMap._zoneClick) mainMap.off('click', mainMap._zoneClick);
  mainMap._zoneClick = (e) => {
    if(!zoneDrawing) return;
    zonePoints.push(e.latlng);
    const dot = L.circleMarker(e.latlng, {radius:5, color:'#fff', fillColor:zoneColor, fillOpacity:1, weight:2}).addTo(mainMap);
    zoneDots.push(dot);
    if(zoneTempPoly) mainMap.removeLayer(zoneTempPoly);
    if(zonePoints.length >= 3) {
      zoneTempPoly = L.polygon(zonePoints, {
        color: zoneColor, weight:2, fillColor:zoneColor, fillOpacity:.12, dashArray:'6,4'
      }).addTo(mainMap);
    }
  };
  mainMap.on('click', mainMap._zoneClick);
}

function cancelZoneDraw() {
  zoneDrawing = false;
  if(mainMap) {
    mainMap.off('click', mainMap._zoneClick);
    mainMap.getContainer().style.cursor = '';
  }
  zonePoints = [];
  zoneDots.forEach(d => mainMap?.removeLayer(d));
  zoneDots = [];
  if(zoneTempPoly) { mainMap?.removeLayer(zoneTempPoly); zoneTempPoly = null; }
  document.getElementById('zonePanel')?.classList.remove('visible');
}

async function saveZone() {
  if(zonePoints.length < 3) { showToast('Draw at least 3 points to define a zone','error'); return; }
  const name = document.getElementById('zoneNameInput')?.value?.trim() || 'Zone ' + (zones.length+1);
  mainMap.off('click', mainMap._zoneClick);
  mainMap.getContainer().style.cursor = '';
  zoneDrawing = false;
  // Remove temp dots
  zoneDots.forEach(d => mainMap.removeLayer(d));
  if(zoneTempPoly) mainMap.removeLayer(zoneTempPoly);

  // Rep assignment (optional) — a rep-owned territory is shaded in that rep's
  // colour and labelled with their name, for dividing canvassing areas.
  const repSel = document.getElementById('zoneRepSelect');
  const repKey = repSel && repSel.value ? repSel.value : '';
  const repOpt = repSel && repSel.selectedOptions && repSel.selectedOptions[0];
  // Persist a NON-viewer-relative label: nbdRepList returns "Me" for the
  // assigner's own uid, and storing that into the team-shared /zones doc would
  // show "Me" to every teammate. Store the assigner's real name for self;
  // renderSavedZones re-resolves the label per-viewer anyway (audit round 2).
  let repLabel = repKey && repOpt ? repOpt.textContent : '';
  if (repKey && window._user && repKey === window._user.uid) {
    repLabel = window._user.displayName || window._user.email || repKey;
  }
  const repColor = repKey && repOpt ? (repOpt.getAttribute('data-color') || zoneColor) : '';
  const fillColor = repColor || zoneColor;
  const _esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  // Serialize points to plain {lat,lng} for Firestore (L.LatLng isn't storable).
  const pts = zonePoints.map(p => ({ lat: p.lat, lng: p.lng }));

  const layer = L.polygon(zonePoints, {
    color: fillColor, weight:2.5, fillColor: fillColor, fillOpacity:.1
  }).addTo(mainMap);
  const _tipName = repLabel ? `${name} · ${repLabel}` : name;
  // Team-shared zones render another user's name in my browser — escape it.
  layer.bindTooltip(`<div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;">${_esc(_tipName)}</div>`, {permanent:true, className:'zone-tooltip', direction:'center'});
  _bindZoneInsights(layer, { name, repLabel, points: pts, rep: repKey });

  // Persist so the territory survives reload + syncs to the team (fall back to
  // a local id if the write is unavailable — the zone still shows this session).
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
  let id = 'd-' + Date.now();
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (_nbdReg && typeof _nbdReg._saveZone === 'function') {
    try { id = await _nbdReg._saveZone({ name, color: fillColor, points: pts, rep: repKey, repLabel }); } catch (_) {}
  }
  zones.push({id, name, color:fillColor, points:pts, layer, rep:repKey, repLabel});
  zonePoints = []; zoneDots = [];
  document.getElementById('zonePanel')?.classList.remove('visible');
  const _zni = document.getElementById('zoneNameInput');
  if (_zni) _zni.value = '';
  const _zrs = document.getElementById('zoneRepSelect');
  if (_zrs) _zrs.value = '';
  renderZoneList();
  showToast(`Zone "${name}" saved ✓`);
}

// `ok` below starts as "is this a local-only zone" — no id, or saveZone's 'd-'
// fallback id, i.e. nothing server-side to delete (the same short-circuit as
// _deleteZone in dashboard-bootstrap.module.js). It must NEVER start as true:
// it was `let ok = true` until 2026-09-18, so a missing __NBD_CALL_REGISTRY.
// _deleteZone entry skipped the server delete, removed a persisted zone from
// the map as if it had succeeded, and it came back on reload and for every
// teammate. A missing registry now fails CLOSED for server zones — the same
// default deletePin uses in maps-overlays.js. Pinned behaviorally by
// tests/failopen-destructive-false-success-2026-09-18.test.js.
async function deleteZone(id) {
  // Ids are Firestore doc strings (or a 'd-' local fallback); compare loosely so
  // a numeric-vs-string mismatch from the list's data attr still matches.
  const idx = zones.findIndex(z => String(z.id) === String(id));
  if(idx < 0) return;
  const zone = zones[idx];
  // Confirm the server delete BEFORE touching the UI — a team reader sees a
  // teammate's zone in the list, but the /zones rule denies deleting it. The
  // old code removed it optimistically and it silently reappeared on reload.
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
  let ok = !zone.id || String(zone.id).startsWith('d-');
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (_nbdReg && typeof _nbdReg._deleteZone === 'function') { try { ok = await _nbdReg._deleteZone(zone.id); } catch (_) { ok = false; } }
  if (!ok) { if (typeof showToast === 'function') showToast('Could not delete — only the owner or a company admin can remove this zone', 'error'); return; }
  if (zone.layer) mainMap?.removeLayer(zone.layer);
  // Recompute the index by identity AFTER the await — a second concurrent
  // delete may have spliced the array while our server round-trip was in
  // flight, so the `idx` captured before the await is now stale and would drop
  // the wrong zone.
  const realIdx = zones.findIndex(z => String(z.id) === String(zone.id));
  if (realIdx >= 0) zones.splice(realIdx, 1);
  renderZoneList();
}

// ── ZONE INSIGHTS — what's inside a drawn territory ──────────────
// Ray-casting point-in-polygon (poly = [{lat,lng}]). Local roofing territories
// don't cross the antimeridian, so the simple form is fine.
function _pointInPolygon(lat, lng, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].lng, yi = poly[i].lat, xj = poly[j].lng, yj = poly[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// Aggregate the leads whose coords fall inside the zone: count, pipeline $,
// role breakdown, top damage type. Uses the live pipeline engine for roles so
// custom stages classify correctly.
function _zoneInsights(zone) {
  const poly = (zone.points || []).filter(p => p && p.lat != null && p.lng != null);
  const roles = { new: 0, active: 0, job: 0, won: 0, lost: 0 };
  const dmg = {};
  let total = 0, count = 0;
  if (poly.length >= 3) {
    (window._leads || []).forEach(l => {
      if (!l || l.deleted || l.lat == null || l.lng == null) return;
      if (!_pointInPolygon(parseFloat(l.lat), parseFloat(l.lng), poly)) return;
      count++;
      total += parseFloat(l.jobValue || l.value || l.contractValue || 0) || 0;
      const r = (typeof window.stageRole === 'function') ? window.stageRole(l._stageKey || l.stage) : (l._stageRole || 'active');
      if (roles[r] != null) roles[r]++;
      const d = String(l.damageType || '').trim();
      if (d) dmg[d] = (dmg[d] || 0) + 1;
    });
  }
  let topDmg = '', topN = 0;
  Object.keys(dmg).forEach(k => { if (dmg[k] > topN) { topN = dmg[k]; topDmg = k; } });
  return { count, total, roles, topDmg };
}
// Resolve a zone's rep label in the CURRENT viewer's context (so a viewer sees
// "Me" for their own zone + colleagues' real names), rather than the label the
// assigner happened to persist. Falls back to the stored real-name label when
// the rep has no leads in this viewer's book.
function _zoneRepLabel(zoneData) {
  if (!zoneData) return '';
  if (zoneData.rep && typeof window.nbdRepList === 'function') {
    const r = (window.nbdRepList() || []).find(x => x && x.key === zoneData.rep);
    if (r && r.label) {
      // nbdRepList's last-resort label is a uid-slice (String(uid).slice(0,6))
      // when the rep has no leads in THIS viewer's book. Don't let that
      // degenerate slice clobber the real name the assigner persisted —
      // prefer the stored repLabel whenever the live label is just the slice.
      const isUidSlice = r.label === String(zoneData.rep).slice(0, 6);
      if (!isUidSlice || !zoneData.repLabel) return r.label;
    }
  }
  return zoneData.repLabel || '';
}
function _zonePopupHTML(zone) {
  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const s = _zoneInsights(zone);
  const money = '$' + Math.round(s.total).toLocaleString();
  const repLbl = _zoneRepLabel(zone);
  return `<div style="font-family:sans-serif;min-width:184px;">`
    + `<div style="font-weight:800;font-size:13px;margin-bottom:3px;">${esc(zone.name || 'Zone')}${repLbl ? ` · ${esc(repLbl)}` : ''}</div>`
    + `<div style="font-size:12px;color:var(--t,#111);">${s.count} customer${s.count === 1 ? '' : 's'} · <b>${esc(money)}</b> pipeline</div>`
    + `<div style="font-size:11px;color:var(--m,#6b7280);margin-top:4px;">Won ${s.roles.won} · Active ${s.roles.active} · Job ${s.roles.job} · New ${s.roles.new} · Lost ${s.roles.lost}</div>`
    + (s.topDmg ? `<div style="font-size:11px;color:var(--m,#6b7280);">Top damage: ${esc(s.topDmg)}</div>` : '')
    + `</div>`;
}
// Bind a click-popup that recomputes on each open (leads change over time).
function _bindZoneInsights(layer, zoneData) {
  if (!layer || typeof layer.bindPopup !== 'function') return;
  layer.bindPopup(() => _zonePopupHTML(zoneData), { maxWidth: 240, minWidth: 190 });
}

// Draw the persisted, team-shared zones (window._zones) onto the map and
// rebuild the in-memory `zones` list. Idempotent — clears prior zone layers
// first — so it's safe to call on map init AND after loadZones resolves.
function renderSavedZones() {
  if (!mainMap || !Array.isArray(window._zones)) return;
  const _esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const safeColor = c => /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#4A9EFF';
  zones.forEach(z => { if (z.layer && mainMap) { try { mainMap.removeLayer(z.layer); } catch (_) {} } });
  zones.length = 0;
  window._zones.forEach(zd => {
    const pts = (zd.points || []).filter(p => p && p.lat != null && p.lng != null).map(p => [p.lat, p.lng]);
    if (pts.length < 3) return;
    const color = safeColor(zd.color);
    const layer = L.polygon(pts, { color, weight:2.5, fillColor:color, fillOpacity:.1 }).addTo(mainMap);
    const _rl = _zoneRepLabel(zd); // per-viewer (not the stored "Me")
    const tip = _rl ? (zd.name + ' · ' + _rl) : (zd.name || 'Zone');
    layer.bindTooltip(`<div style="font-family:'Barlow Condensed',sans-serif;font-weight:700;font-size:12px;">${_esc(tip)}</div>`, {permanent:true, className:'zone-tooltip', direction:'center'});
    _bindZoneInsights(layer, { name: zd.name, repLabel: zd.repLabel, points: zd.points, rep: zd.rep });
    zones.push({ id: zd.id, name: zd.name, color, points: zd.points, layer, rep: zd.rep, repLabel: zd.repLabel });
  });
  if (typeof renderZoneList === 'function') renderZoneList();
}

// Registry-first dispatch for the five zone entry points (Tranche 3, T3-0).
// startZoneDraw / cancelZoneDraw / saveZone are markup-dispatched from
// dashboard.html; deleteZone is dispatched from the delete button that
// renderZoneList generates; selectZoneColor is reached through the
// dashboard-ui.js `zoneColor` action. All five dropped their
// _NBD_CALL_ALLOWLIST entries in the same change — per the Tranche 2c-2 rule,
// a registered name must not keep a window fallback, or the stale fallback
// shadow-resurrects the global the tranche removed.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  selectZoneColor: selectZoneColor,
  startZoneDraw: startZoneDraw,
  cancelZoneDraw: cancelZoneDraw,
  saveZone: saveZone,
  deleteZone: deleteZone
});
// Deliberate export (NOT a vestigial alias): maps-core.js re-draws zones 400ms
// after map init and dashboard-bootstrap.module.js re-draws them once the
// /zones read resolves — both call it off window, from outside this file.
window.renderSavedZones = renderSavedZones;
})();

// ══════════════════════════════════════════════
// SAMPLE DATA + damage-near-me overrides
// ══════════════════════════════════════════════
async function loadSampleData() {
  // FAIL CLOSED on an unhydrated lead cache (mirrors pipeline-builder.js
  // canDeleteStage). window._leads is [] both before the first loadLeads()
  // resolves and after a failed first load (dashboard-bootstrap.module.js
  // resets it to [] and leaves _leadsLoaded false), so the empty-book check
  // below read "not loaded yet" as "account is empty" and seeded 13 demo
  // leads + 6 tasks into a live tenant with no confirm. Only a confirmed
  // load may be treated as empty.
  if (window._leadsLoaded !== true) {
    showToast("Your leads haven't finished loading yet — wait for the board to load, then try again.", 'error');
    return;
  }
  const leads = window._leads || [];
  if(leads.length > 0) {
    // Batch 2 (iOS PWA): native confirm() always returns true in standalone
    // mode (see standalone-compat.js), so this guard was silently bypassed on
    // the installed app and five demo leads landed in a real book. nbdConfirm
    // returns a real Promise<boolean> from a modal there; desktop (where
    // nbdConfirm is never defined) falls back to native confirm.
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if(!(await _ask(`You already have ${leads.length} leads. Add sample data anyway?`))) return;
  }
  showToast('Loading sample data...');
  const user = window._user;
  if(!user) { showToast('Not logged in','error'); return; }
  try {
    await seedDemoLeads(user.uid);
    await window._loadLeads();
    showToast('Sample data loaded ✓ — check your CRM');
    goTo('crm');
  } catch(e) {
    showToast('Error loading sample data: ' + e.message, 'error');
  }
}

// Globals Tranche 3 slice T3-0 (2026-08-31): scoped to this IIFE + registered.
// Its only external reference was maps.js's typeof-GUARDED re-export (the
// audit's "borderline" case — convertible iff that shim went in the same
// change, which it did), plus the dashboard.html "📍 Near Me" button, which
// dispatches through the registry now.
(function () {
function damageNearMePhotos(){
  navigator.geolocation?.getCurrentPosition(async pos=>{
    showToast('Finding nearby inspections...');
    goTo('map');
    if(mainMap) mainMap.setView([pos.coords.latitude,pos.coords.longitude],14);
  },()=>showToast('Location access denied','error'));
}
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  damageNearMePhotos: damageNearMePhotos
});
})();

// (damagNearMe override removed 2026-08-07 — the single implementation lives
//  in maps-overlays.js and registers in __NBD_CALL_REGISTRY; the aliases here
//  and in maps.js shadowed its per-PositionError user messaging.)

// ══════════════════════════════════════════════
// (nothing to export here)
// ══════════════════════════════════════════════
// Slice T3-A part 1 (2026-08-31) deleted the 86 *guarded* forward-reference
// re-exports that used to fill this region — see the block further down.
// Three UNGUARDED ones survived that sweep because its regex only matched the
// `if (typeof X …)` form, and the header left behind called them "OWN EXPORTS",
// which was wrong:
//     window.mobileNav = mobileNav;
//     window.toggleMobileMore = toggleMobileMore;
//     window.closeMobileMore = closeMobileMore;
// All three are defined in dashboard-ui.js, which loads first. On 2026-09-01
// each was a TOP-LEVEL declaration there (verified by brace depth, not
// indentation, since the house style puts IIFE bodies at column 0 too), so all
// three were already window properties when these lines ran: `window.X = window.X`.
// Since the Tranche 3 T3-A whole-file IIFE wrap of dashboard-ui.js (2026-09-18)
// they reach window through that file's explicit export block instead.
// Deleted 2026-09-01. Verified by running tests/e2e/globals-surface-snapshot.spec.js
// against the live emulator-backed dashboard AFTER the deletion: all three still
// resolve as functions on window (via dashboard-ui.js's auto-globals), which is
// what the spec pins them for (today via dashboard-ui.js's explicit exports,
// not auto-globals — see above). Note this is an after-state check, not a
// before/after diff — the BEFORE7/AFTER7 pair on disk belongs to slice T3-A
// part 1, which did NOT touch these three lines.

// ══ REMOVED: Duplicate QM Import, QuickAddLead, Warranty Cert, Lead Export CSV ══
// Canonical definitions live in js/tools.js and js/warranty-cert.js (both loaded above)
// ══ See audit H2 ═══════════════════════════════════════════════════════════════


// ══ ONBOARDING FLOW ═════════════════════════════════════════════════════
// Legacy modal-based onboarding (checkAndShowOnboarding + onbNext + onbSaveLead
// + onbSkipLead + onbShowFinal + onbFinish) was removed 2026-05-12. Every
// function in the original block referenced DOM (#onboardingModal, #onbStep1,
// #onbCompany, #onbAddr, etc.) that was never built — calling them threw on
// the first getElementById, so a previously-injected stub had to silently
// no-op the whole flow.
//
// Replaced by OnboardingTour (js/onboarding-tour.js) — a self-contained
// spotlight tour that auto-fires for users with zero leads.
// ════════════════════════════════════════════════════════════════════════

// PR 2c: the estimate engine is lazy (ScriptLoader 'estimates' bundle).
// startNewEstimate / openEstimateV2Builder can be invoked (lead-card chips,
// command palette, 'E' shortcut, maps) before the bundle loads, so install
// load-then-run stubs. estimates.js / estimate-v2-ui.js overwrite these with
// the real functions when the bundle finishes loading.
if (typeof startNewEstimate === 'function') {
  window.startNewEstimate = startNewEstimate;
} else {
  const _lazyEstimate = function (fnName, args) {
    if (!(window.ScriptLoader && window.ScriptLoader.loadBundle)) {
      if (typeof showToast === 'function') showToast('Estimate builder is still loading — try again in a moment', 'warning');
      return;
    }
    window.ScriptLoader.loadBundle('estimates').then(function () {
      const fn = window[fnName];
      if (typeof fn === 'function' && !fn.__nbdLazyEstimateStub) { fn.apply(null, args); }
      else if (typeof showToast === 'function') { showToast('Estimate builder is still loading — try again in a moment', 'warning'); }
    });
  };
  window.startNewEstimate = function () { _lazyEstimate('startNewEstimate', arguments); };
  window.startNewEstimate.__nbdLazyEstimateStub = true;
  if (typeof window.openEstimateV2Builder !== 'function') {
    window.openEstimateV2Builder = function () { _lazyEstimate('openEstimateV2Builder', arguments); };
    window.openEstimateV2Builder.__nbdLazyEstimateStub = true;
  }
  // The estimate ROW actions ship in the same bundle and are reachable from
  // surfaces that render before it loads — the customer estimate hub, the
  // estimates list and the mobile job-detail preview sheet. Callers guard with
  // a bare `typeof window.X === 'function'` (see _mJdOpenEstimate's onAssign),
  // which turns a pre-bundle tap into a SILENT no-op rather than a toast. The
  // stub makes that guard pass and defers the real call until the bundle lands.
  ['assignEstimateAction', 'duplicateEstimateAction', 'deleteEstimateAction'].forEach(function (n) {
    if (typeof window[n] === 'function') return;
    window[n] = function () { _lazyEstimate(n, arguments); };
    window[n].__nbdLazyEstimateStub = true;
  });
}

// PR 2d: the photo + inspection engine is lazy (ScriptLoader 'photos' bundle).
// Install load-then-run stubs for the entry points (camera, gallery, upload,
// inspection builder, photo report) so a click before the bundle loads still
// works. photo-engine.js / inspection-report-engine.js / photo-report.js
// overwrite these globals (unconditionally) when the bundle finishes loading.
if (typeof window.PhotoEngine === 'undefined' || typeof window.InspectionReportEngine === 'undefined' || typeof window.generatePhotoReport !== 'function') {
  const _lazyPhotos = function (run) {
    if (!(window.ScriptLoader && window.ScriptLoader.loadBundle)) {
      if (typeof showToast === 'function') showToast('Photos are still loading — try again in a moment', 'warning');
      return;
    }
    window.ScriptLoader.loadBundle('photos').then(run);
  };
  if (typeof window.PhotoEngine === 'undefined') {
    const _peStub = { __nbdLazyPhotosStub: true };
    ['openCamera', 'openGallery', 'uploadFromFile', 'renderGallery', 'openLightbox'].forEach(function (m) {
      _peStub[m] = function () {
        const a = arguments;
        _lazyPhotos(function () {
          if (window.PhotoEngine && window.PhotoEngine !== _peStub && typeof window.PhotoEngine[m] === 'function') window.PhotoEngine[m].apply(window.PhotoEngine, a);
          else if (typeof showToast === 'function') showToast('Photos are still loading — try again in a moment', 'warning');
        });
      };
    });
    window.PhotoEngine = _peStub;
  }
  if (typeof window.InspectionReportEngine === 'undefined') {
    window.InspectionReportEngine = {
      __nbdLazyPhotosStub: true,
      openBuilder: function () {
        const a = arguments;
        _lazyPhotos(function () {
          if (window.InspectionReportEngine && !window.InspectionReportEngine.__nbdLazyPhotosStub && typeof window.InspectionReportEngine.openBuilder === 'function') window.InspectionReportEngine.openBuilder.apply(window.InspectionReportEngine, a);
          else if (typeof showToast === 'function') showToast('Photos are still loading — try again in a moment', 'warning');
        });
      }
    };
  }
  if (typeof window.generatePhotoReport !== 'function') {
    window.generatePhotoReport = function () {
      const a = arguments;
      _lazyPhotos(function () {
        if (typeof window.generatePhotoReport === 'function' && !window.generatePhotoReport.__nbdLazyPhotosStub) window.generatePhotoReport.apply(null, a);
        else if (typeof showToast === 'function') showToast('Photos are still loading — try again in a moment', 'warning');
      });
    };
    window.generatePhotoReport.__nbdLazyPhotosStub = true;
  }
}
// ══════════════════════════════════════════════════════════════════
// FORWARD-REFERENCE BLOCK — DELETED (Globals Tranche 3, slice T3-A part 1,
// 2026-08-31). 86 guarded re-exports of the shape
//     if (typeof X !== 'undefined') window.X = X;
// lived here (in two separate runs), left over from the original monolith
// split. Every one of them was inert, and a live before/after snapshot of all
// 85 distinct names was byte-identical — same typeof, same function-source
// fingerprint (tests/e2e/globals-surface-snapshot.spec.js):
//
//   • 62 were DEAD. The subject is defined in a script that loads AFTER this
//     one (maps-overlays, maps-routing, maps, ai, ui, crm, crm-portal-bridge,
//     tasks) or, for the estimates.js names, only ever arrives through the
//     lazy ScriptLoader bundle and is never a static <script> at all. A
//     `typeof` read at THIS file's execution time therefore always saw
//     'undefined' and the assignment never ran. Four names (drop, saveJoeKey,
//     markAllNotificationsRead, markNotificationRead) have no definition
//     anywhere in the tree.
//   • 24 were REDUNDANT. The subject is a top-level `function` declaration in
//     an EARLIER classic script, which already makes it a window property, so
//     `window.X = X` re-assigned a name to the value it already held. (True
//     on 2026-08-31. dashboard-ui.js has since been wrapped in one IIFE, so
//     its names now reach window only through its explicit export block.)
//
// KEPT DELIBERATELY: the `if (typeof startNewEstimate === 'function') { … }
// else { … }` block above only LOOKS like one of these. Its else-branch is
// load-bearing — it installs the load-then-run stubs for the whole lazy
// estimates bundle — and that branch is in fact the one that always runs.
//
// Deleting the block changes no behaviour. What it does change is the globals
// census: scripts/globals-xref.js infers ownership from the literal text
// `window.X =`, so this block made dashboard-actions.js look like the assigner
// of ~60 names it does not define. That mis-attribution is what produced the
// Tranche 3 plan's "dashboard-actions.js (33) mechanically-safe" figure — of
// those 33, only a handful were even owned by this file. See
// docs/dev/globals-tranche3-plan.md.
//
// DO NOT RE-ADD A FORWARD REFERENCE HERE. A module exposes its own API; if a
// name needs to cross a file boundary, register it in __NBD_CALL_REGISTRY or
// export it from the module that defines it. tests/smoke/dashboard.test.js
// pins this block at zero.
//
// Names previously listed here that earlier tranches moved to the registry —
// do not resurrect these on window either: spyglassSearch, spyglassGoToLocation,
// fabToggle, quickStormCheck, openUploadDoc, printDoc (Tranche 2c-4h H2);
// pullIntelForModal, executePullPropertyIntel, confirmPropertyIntelPull
// (2c-4h H2 pt2); the ds* daily-settings cluster (2c-4d); damageNearMePhotos,
// selectZoneColor, startZoneDraw, cancelZoneDraw, saveZone, deleteZone (T3-0).
// renderSavedZones is exported from inside the zone IIFE above, deliberately.
// ══════════════════════════════════════════════════════════════════


// ══════════════════════════════════════════════
// DAILY PROGRAM — config logic — Globals Tranche 2c-4d (2026-07-07)
// ══════════════════════════════════════════════
// The cluster AND its callers (the goTo settings-hook + the DOMContentLoaded
// handler, both of which call dsLoadConfig) are wrapped in this one IIFE so the
// internal helpers (dsGetConfig/dsLoadConfig/dsDefaultFloors) go module-local.
// dsAddFloor/dsSaveConfig/dsResetDefaults register in __NBD_CALL_REGISTRY;
// dsRemoveFloor keeps a window re-export (bare-called by dashboard-ui.js's
// dsRenderFloors remove buttons).
// Shared state (dsFloors, DS_* consts) lives in dashboard-state.js up-scope and
// dsRenderFloors/dsBuildThemeGrid in dashboard-ui.js — all resolve up-scope,
// unaffected by the wrap. See docs/dev/dashboard-actions-globals-audit.md.
(function () {
function dsGetConfig() {
  try { return JSON.parse(localStorage.getItem(DS_NBD_CFG)) || null; } catch { return null; }
}

function dsLoadConfig() {
  const cfg = dsGetConfig();
  if (cfg) {
    if (cfg.northStar) {
      const catEl = document.getElementById('ds-cat');
      if (catEl) catEl.value = cfg.northStar.category || 'Other';
      const tEl = document.getElementById('ds-target');
      if (tEl) tEl.value = cfg.northStar.target || '';
      const dEl = document.getElementById('ds-deadline');
      if (dEl) dEl.value = cfg.northStar.deadline || '';
    }
    if (cfg.floors && cfg.floors.length) {
      dsFloors = cfg.floors.map(f => ({...f}));
    } else {
      dsFloors = dsDefaultFloors();
    }
    const gEl = document.getElementById('ds-goose');
    if (gEl) gEl.value = cfg.goose || '';
    const sgEl = document.getElementById('ds-showgoose');
    if (sgEl) sgEl.checked = cfg.showGoose !== false;
  } else {
    dsFloors = dsDefaultFloors();
  }
  // Load daily theme
  try {
    const saved = localStorage.getItem(DS_THEME_KEY);
    dsSelectedTheme = (saved && DS_THEMES.find(t => t.key === saved)) ? saved : 'nbd-original';
  } catch { dsSelectedTheme = 'nbd-original'; }
  dsRenderFloors();
  dsBuildThemeGrid();
}

function dsDefaultFloors() {
  return [
    { id:'df1', label:'Doors knocked', targetValue:50, unit:'doors' },
    { id:'df2', label:'Workout', targetValue:1, unit:'done' },
    { id:'df3', label:'Sleep 7+ hrs', targetValue:7, unit:'hrs' },
    { id:'df4', label:'Protein goal', targetValue:150, unit:'g' },
    { id:'df5', label:'1 big task done', targetValue:1, unit:'done' },
  ];
}

function dsAddFloor() {
  if (dsFloors.length >= 7) { showToast('Max 7 floors'); return; }
  dsFloors.push({ id: 'f' + Date.now(), label: '', targetValue: 1, unit: 'done' });
  dsRenderFloors();
}

function dsRemoveFloor(i) {
  dsFloors.splice(i, 1);
  dsRenderFloors();
}

function dsSaveConfig() {
  const floors = dsFloors.filter(f => (f.label || '').trim());
  if (!floors.length) { showToast('Add at least one floor first'); return; }
  const config = {
    northStar: {
      category: document.getElementById('ds-cat')?.value || 'Other',
      target:   document.getElementById('ds-target')?.value || '',
      deadline: document.getElementById('ds-deadline')?.value || '',
    },
    floors: floors,
    goose:    document.getElementById('ds-goose')?.value || '',
    showGoose: document.getElementById('ds-showgoose')?.checked !== false,
  };
  localStorage.setItem(DS_NBD_CFG, JSON.stringify(config));
  // NEW-4: mirror into the derived 'nbd_ds_config' key that the Home widgets
  // read (north-star / daily-floors / golden-goose in js/widgets.js). Without
  // this, a North Star set here saves to nbd_user_config but the Home widget
  // (which reads nbd_ds_config) never sees it and stays on the placeholder.
  // Uses the EXACT shape transform as daily-success/js/app.js syncToWidgetKeys()
  // so the two save paths stay byte-consistent.
  try {
    const widgetCfg = {
      northStar: config.northStar.target || config.northStar.category || '',
      northStarDeadline: config.northStar.deadline || '',
      floors: config.floors.map(f => ({ label: f.label, target: parseFloat(f.targetValue) || 1, unit: f.unit || '' })),
      goldenGoose: config.goose || '',
    };
    localStorage.setItem('nbd_ds_config', JSON.stringify(widgetCfg));
  } catch {}
  try { localStorage.setItem(DS_THEME_KEY, dsSelectedTheme); } catch {}
  const msg = document.getElementById('ds-save-msg');
  if (msg) { msg.style.display = 'block'; setTimeout(() => msg.style.display = 'none', 3000); }
  showToast('Daily Program settings saved ✓');
}

function dsResetDefaults() {
  dsFloors = dsDefaultFloors();
  dsRenderFloors();
  const catEl = document.getElementById('ds-cat');
  if (catEl) catEl.value = 'Roofing Sales';
  const tEl = document.getElementById('ds-target');
  if (tEl) tEl.value = '';
  const dEl = document.getElementById('ds-deadline');
  if (dEl) dEl.value = '';
  const gEl = document.getElementById('ds-goose');
  if (gEl) gEl.value = '30 min of guilt-free screen time';
  const sgEl = document.getElementById('ds-showgoose');
  if (sgEl) sgEl.checked = true;
  dsSelectedTheme = 'nbd-original';
  dsBuildThemeGrid();
  showToast('Reset to defaults — click Save to apply');
}

// Hook into the existing goTo() nav so settings load fresh when the tab opens.
// Forward `arguments` rather than just `view` — the canonical goTo accepts
// (view, params) and downstream callers (admin-manager.js etc.) rely on
// the second arg surviving each wrapper layer.
const _origGoTo = typeof goTo === 'function' ? goTo : null;
window.goTo = function() {
  const view = arguments[0];
  if (_origGoTo) _origGoTo.apply(this, arguments);
  if (view === 'settings') {
    setTimeout(dsLoadConfig, 80);
    setTimeout(restoreSettingsSections, 100);
    // Load CRM secondary header toggle state
    setTimeout(() => {
      const toggle = document.getElementById('crmSecHeaderToggle');
      if (toggle) toggle.checked = getCrmSecHeaderEnabled();
    }, 100);
  }
};
// Also load on page ready in case settings is the first view
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('view-settings')?.classList.contains('active')) {
    dsLoadConfig();
    restoreSettingsSections();
  }
});

  // dsRemoveFloor is bare-called from dashboard-ui.js dsRenderFloors (the floor-row delete
  // button) — MUST keep a window export. The other three convert to the registry;
  // dsGetConfig/dsLoadConfig/dsDefaultFloors are private (intra-IIFE callers only).
  window.dsRemoveFloor = dsRemoveFloor;
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, {
    dsAddFloor: dsAddFloor,
    dsSaveConfig: dsSaveConfig,
    dsResetDefaults: dsResetDefaults,
  });
})();

// ══════════════════════════════════════════════
// MOBILE JOB-DETAIL / CREATE-POPOVER CLUSTER — Globals Tranche 2c-4b (2026-07-07)
// ══════════════════════════════════════════════
// This whole contiguous block is wrapped in one in-file IIFE so its top-level
// `function` declarations become module-local instead of auto-globals. The
// three markup-dispatched (data-fn=) convertibles — _mJdSwitchTab, _mJdShare,
// _mCreate — register in __NBD_CALL_REGISTRY (block at the bottom of the IIFE),
// which the dashboard-ui.js `call` delegate resolves first. Every name with a
// cross-boundary consumer keeps its explicit `window.X = X` re-export (those
// exports are now load-bearing — the function decl no longer globals itself):
//   _mJdSwitchTab        → dashboard-widgets.js:1176 bare call
//   _mJdAct              → 2c-4a cdaMjdAct calls window._mJdAct
//   openMobileInspection → 2c-4a cdaOpenMobileInspection calls window.openMobileInspection
//   (closeMobileInspection, closeMobileCreatePopover WERE here for
//    _NBD_MODAL_CLOSE_FNS window[fn] dispatch — converted 2026-09-01 once that
//    map became registry-first; they register below and are off window now)
//   toggleMobileCreatePopover → mCreateFabRoute (outside this IIFE) calls window.toggleMobileCreatePopover
//   openLeadDetail       → crm-pipeline.js:1267 bare call
// openMobileCreatePopover is fully PRIVATE — its only caller (toggleMobileCreatePopover)
// is co-located in this IIFE. See docs/dev/dashboard-actions-globals-audit.md.
(function () {
function _mJdSwitchTab(tab) {
  document.querySelectorAll('.m-jd-tab').forEach(t => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  const map = { activity:'mJdTabActivity', estimates:'mJdTabEstimates', photos:'mJdTabPhotos', documents:'mJdTabDocuments', messages:'mJdTabMessages', voice:'mJdTabVoice', details:'mJdTabDetails' };
  for (const [k, id] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.hidden = (k !== tab);
  }
  // Hubs mount lazily — a tab is inert markup until the rep actually opens it,
  // so a job-detail open costs nothing extra.
  if (tab === 'estimates') _mountEstimateHub();
  if (tab === 'photos') _mountPhotoHub();
  if (tab === 'documents') _mountDocumentsHub();
  if (tab === 'messages') _mountMessagesHub();
  if (tab === 'voice') _mountVoiceIntel();
  // Activity's estimates+stage-history list is already built synchronously
  // by openMobileJobDetail (dashboard-widgets.js) from in-memory data — this
  // is just the homeowner-portal audit feed underneath it, which needs its
  // own Firestore read.
  if (tab === 'activity') _mountCustomerActivityFeed();
  if (tab === 'details') { _mountCommsLog(); _mountNotesTab(); }
}

// Homeowner portal activity (customerAuditEvents) for the Activity tab —
// same audit batch 7 log customer.html's Timeline tab shows under "Customer
// Activity" (customer-bootstrap.module.js's loadCustomerActivity), reading
// the SAME collection/query shape rather than a second implementation. Not
// a literal call-through: that function is ES-module-scoped (db/auth are
// its own local imports, not window globals) so it can't be called directly
// from here — but dashboard-bootstrap.module.js publishes the identical set
// of Firestore helpers (window.db/getDocs/collection/query/where/orderBy/
// limit) customer-bootstrap.module.js does, so the query itself is portable.
// Cache flag lives on the host element's dataset (same convention
// _mountDocumentsHub uses) so openMobileJobDetail can clear it on every
// open the same way it already does for Documents — no second cross-file
// reset function needed.
function _mountCustomerActivityFeed() {
  const host = document.getElementById('mJdCustomerActivityFeed');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (host.dataset.loadedFor === leadId) return;
  host.dataset.loadedFor = leadId;
  host.innerHTML = '<div class="m-jd-empty">Loading…</div>';

  (async () => {
    try {
      if (!window.db || !window.auth || typeof window.getDocs !== 'function') {
        host.innerHTML = '<div class="m-jd-empty">Activity unavailable — reload the page.</div>';
        return;
      }
      const snap = await window.getDocs(window.query(
        window.collection(window.db, 'customerAuditEvents'),
        window.where('leadId', '==', leadId),
        window.where('ownerUid', '==', window.auth.currentUser && window.auth.currentUser.uid),
        window.orderBy('createdAt', 'desc'),
        window.limit(50)
      ));
      // Stale by the time the fetch resolves — a slow load must not paint
      // the wrong customer's activity (same guard _mountDocumentsHub uses).
      if (window._cardDetailLeadId !== leadId) return;
      const events = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
      if (!events.length) {
        host.innerHTML = '<div class="m-jd-empty">No activity yet. Activity appears here when the homeowner opens their portal link.</div>';
        return;
      }
      const ICON = { portal_open: '🔓', photo_view: '📷', estimate_view: '📋', document_view: '📄', photo_upload: '⬆️' };
      const LABEL = { portal_open: 'Opened portal', photo_view: 'Viewed photo', estimate_view: 'Viewed estimate', document_view: 'Viewed document', photo_upload: 'Uploaded photo' };
      const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])));
      host.innerHTML = '<div class="m-jd-act-list">' + events.map(e => {
        const t = e.createdAt && e.createdAt.toDate ? e.createdAt.toDate() : null;
        const when = t ? t.toLocaleDateString() : '';
        const icon = ICON[e.type] || '•';
        const label = LABEL[e.type] || esc(e.type);
        return '<div class="m-jd-act-item m-jd-act-item--static">'
          + '<span class="m-jd-act-item-ico">' + icon + '</span>'
          + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">' + label + '</span>'
          + (when ? '<span class="m-jd-act-item-s">' + esc(when) + '</span>' : '') + '</span>'
          + '</div>';
      }).join('') + '</div>';
    } catch (e) {
      if (window._cardDetailLeadId !== leadId) return;
      host.innerHTML = '<div class="m-jd-empty">Activity unavailable.</div>';
    }
  })();
}

// Communication Log for the Details tab — platform email/SMS SEND history
// (email_log/sms_log), not the live two-way homeowner chat (Messages tab,
// a different collection). Same query shape as loadCommunicationLog
// (customer-tasks-ui.js): team-thread vs individual-uid scoping by role,
// same 30/20 result caps. Not a literal call-through for the same reason
// _mountCustomerActivityFeed isn't — that function is customer.html-scoped
// (reads its own module-local uid/claims), but the query itself is portable
// since dashboard.html publishes the identical Firestore helper globals.
function _mountCommsLog() {
  const host = document.getElementById('mJdCommsLog');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (host.dataset.loadedFor === leadId) return;
  host.dataset.loadedFor = leadId;
  host.innerHTML = '<div class="m-jd-empty">Loading…</div>';

  (async () => {
    try {
      const uid = (window.auth && window.auth.currentUser && window.auth.currentUser.uid) || null;
      if (!uid || !window.db || typeof window.getDocs !== 'function') {
        host.innerHTML = '<div class="m-jd-empty">Sign in to view messages</div>';
        return;
      }
      const claims = window._userClaims || {};
      const role = claims.role || '';
      const companyId = claims.companyId || null;
      const teamThread = !!(companyId && (role === 'company_admin' || role === 'manager' || role === 'viewer' || claims.owner === true));

      const emailRef = window.collection(window.db, 'email_log');
      const smsRef = window.collection(window.db, 'sms_log');
      let emailQ, smsQ;
      if (teamThread) {
        emailQ = window.query(emailRef, window.where('leadId', '==', leadId), window.where('companyId', '==', companyId), window.orderBy('date', 'desc'), window.limit(30));
        smsQ = window.query(smsRef, window.where('leadId', '==', leadId), window.where('companyId', '==', companyId), window.orderBy('date', 'desc'), window.limit(30));
      } else {
        emailQ = window.query(emailRef, window.where('leadId', '==', leadId), window.where('uid', '==', uid), window.orderBy('date', 'desc'), window.limit(20));
        smsQ = window.query(smsRef, window.where('leadId', '==', leadId), window.where('uid', '==', uid), window.orderBy('date', 'desc'), window.limit(20));
      }
      const [emailSnap, smsSnap] = await Promise.all([window.getDocs(emailQ), window.getDocs(smsQ)]);
      if (window._cardDetailLeadId !== leadId) return;

      let comms = [];
      emailSnap.forEach((d) => {
        const data = d.data();
        comms.push({
          type: 'email',
          date: data.date && data.date.toDate ? data.date.toDate() : new Date(data.date),
          subject: data.subject || 'Email',
          fromUid: data.uid || null,
        });
      });
      smsSnap.forEach((d) => {
        const data = d.data();
        const smsText = data.body || data.message || '';
        comms.push({
          type: 'sms',
          date: data.date && data.date.toDate ? data.date.toDate() : new Date(data.date),
          subject: smsText || 'Text Message',
          fromUid: data.uid || null,
        });
      });
      comms.sort((a, b) => b.date - a.date);
      comms = comms.slice(0, 30);

      if (!comms.length) {
        host.innerHTML = '<div class="m-jd-empty">' + (teamThread ? 'No platform messages yet for this lead (team view).' : 'No messages yet — platform email/SMS will appear here.') + '</div>';
        return;
      }
      const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])));
      host.innerHTML = '<div class="m-jd-act-list">' + comms.map((c) => {
        const dateStr = c.date.toLocaleDateString() + ' ' + c.date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const who = (teamThread && c.fromUid && c.fromUid !== uid) ? ' · teammate' : '';
        return '<div class="m-jd-act-item m-jd-act-item--static">'
          + '<span class="m-jd-act-item-ico">' + (c.type === 'sms' ? '💬' : '✉️') + '</span>'
          + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">' + esc(c.subject) + '</span>'
          + '<span class="m-jd-act-item-s">' + esc(dateStr) + esc(who) + '</span></span>'
          + '</div>';
      }).join('') + '</div>';
    } catch (e) {
      if (window._cardDetailLeadId !== leadId) return;
      host.innerHTML = '<div class="m-jd-empty">Failed to load messages</div>';
    }
  })();
}

function _mJdTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 604800) return Math.floor(seconds / 86400) + 'd ago';
  return date.toLocaleDateString();
}

// Notes for the Details tab — same `notes` Firestore collection + field
// shape as customer.html's quick-add (loadNotes/quickAddNote in
// customer-photo-report-generator.js), read/written directly here rather
// than loading that whole 640-line file (it also owns unrelated
// photo-report code) for ~90 lines of notes logic — same "query shape is
// portable, DOM ids are page-scoped" precedent as the activity feed and
// comms log above.
function _mountNotesTab() {
  const host = document.getElementById('mJdNotesList');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (host.dataset.loadedFor === leadId) return;
  host.dataset.loadedFor = leadId;
  host.innerHTML = '<div class="m-jd-empty">Loading…</div>';

  (async () => {
    try {
      if (!window.db || typeof window.getDocs !== 'function') {
        host.innerHTML = '<div class="m-jd-empty">Notes unavailable — reload the page.</div>';
        return;
      }
      // leadId-only (no author filter), matching loadNotes — the whole
      // team's notes on this lead, not just the current rep's own.
      const snap = await window.getDocs(window.query(
        window.collection(window.db, 'notes'),
        window.where('leadId', '==', leadId)
      ));
      if (window._cardDetailLeadId !== leadId) return;
      const ms = (v) => (v && v.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0)) || 0;
      const notes = snap.docs.map((d) => d.data()).sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
      if (!notes.length) {
        host.innerHTML = '<div class="m-jd-empty">No notes yet — type one above and hit Send.</div>';
        return;
      }
      const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])));
      host.innerHTML = '<div class="m-jd-act-list">' + notes.map((n) => {
        const created = n.createdAt && n.createdAt.toDate ? n.createdAt.toDate() : new Date();
        const bodyHtml = esc(n.text).replace(/\n/g, '<br>');
        return '<div class="m-jd-act-item m-jd-act-item--static" style="display:block;">'
          + '<div style="font-size:13px;line-height:1.5;margin-bottom:4px;">' + bodyHtml + '</div>'
          + '<div class="m-jd-act-item-s">' + esc(n.createdBy || '') + ' · ' + esc(_mJdTimeAgo(created)) + '</div>'
          + '</div>';
      }).join('') + '</div>';
    } catch (e) {
      if (window._cardDetailLeadId !== leadId) return;
      host.innerHTML = '<div class="m-jd-empty">Failed to load notes.</div>';
    }
  })();
}

// Quick-add handler for the Send button next to #mJdNotesInput. Simpler
// than desktop's optimistic-prepend quickAddNote (no temp card / rollback
// dance) — write, then re-fetch via _mountNotesTab, consistent with how
// _mJdDeleteDoc/_mJdWireSignedUploadInputs already refresh their own lists.
async function _mJdQuickAddNote() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const input = document.getElementById('mJdNotesInput');
  const send = document.getElementById('mJdNotesSend');
  const status = document.getElementById('mJdNotesStatus');
  const leadId = window._cardDetailLeadId;
  if (!input) return;
  const text = input.value.trim();
  if (!text) { input.focus(); return; }
  if (!leadId || !window.db || !window.auth || !window.auth.currentUser) {
    if (typeof showToast === 'function') showToast('No customer selected', 'error');
    return;
  }
  input.disabled = true;
  if (send) { send.disabled = true; send.style.opacity = '0.6'; }
  if (status) { status.textContent = 'Saving…'; status.style.color = 'var(--m)'; }
  try {
    await window.addDoc(window.collection(window.db, 'notes'), {
      leadId: leadId,
      userId: window.auth.currentUser.uid,
      text: text,
      createdAt: window.serverTimestamp(),
      createdBy: window.auth.currentUser.email || 'Unknown',
    });
    input.value = '';
    if (status) {
      status.textContent = 'Saved ✓';
      status.style.color = 'var(--green)';
      setTimeout(() => { if (status.textContent === 'Saved ✓') status.textContent = ''; }, 1800);
    }
    const host = document.getElementById('mJdNotesList');
    if (host) delete host.dataset.loadedFor;
    _mountNotesTab();
  } catch (e) {
    input.value = text;
    if (status) { status.textContent = 'Save failed — try again'; status.style.color = 'var(--red)'; }
    if (typeof showToast === 'function') showToast('Note save failed: ' + (e.message || 'unknown'), 'error');
  } finally {
    input.disabled = false;
    if (send) { send.disabled = false; send.style.opacity = ''; }
  }
}
document.addEventListener('keydown', (ev) => {
  if (ev.target && ev.target.id === 'mJdNotesInput' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    _mJdQuickAddNote();
  }
});

// Job Checklist checkbox delegate — customer-checklist.js's checkboxes carry
// data-change-action="toggleJobChecklistItem" data-arg="<key>" data-pass-el
// and ride customer-tasks-ui.js's own change delegate on customer.html,
// which dashboard.html doesn't load. A single document-level listener
// (wired once here, not per-mount — #checklistPanel is populated
// synchronously in openMobileJobDetail, not through a lazy _mount*()) covers
// every checkbox regardless of which lead is currently open.
document.addEventListener('change', (ev) => {
  const el = ev.target && ev.target.closest && ev.target.closest('[data-change-action="toggleJobChecklistItem"]');
  if (!el) return;
  const key = el.getAttribute('data-arg');
  if (typeof window.toggleJobChecklistItem === 'function') window.toggleJobChecklistItem(key, el);
});

// Bring the tab row to the top of the scroller after an action-ring button
// switches tabs, so the rep lands ON the panel instead of having to scroll
// past the hero to find it. Shared by the 'estimate' and 'photos' actions.
function _scrollToTabs() {
  const tabsEl = document.querySelector('#mJobDetail .m-jd-tabs');
  if (tabsEl && typeof tabsEl.scrollIntoView === 'function') {
    tabsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Mount (or re-render) the embedded per-customer estimate hub into the
// Estimates tab for whichever lead the overlay is currently showing.
function _mountEstimateHub() {
  const host = document.getElementById('mJdTabEstimates');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (!window.CustomerEstimateHub) {
    host.innerHTML = '<div class="m-jd-empty">Estimate panel unavailable — reload the page.</div>';
    return;
  }
  window.CustomerEstimateHub.mount(host, leadId, {
    // Classic (non-V2) estimates live in the `est` view's DOM, so editing one
    // has to navigate. Close the overlay first so we don't leave it stranded
    // over the builder. V2 opens as a modal and never calls this.
    onLeaveForClassic: () => { if (typeof closeMobileJobDetail === 'function') closeMobileJobDetail(); },
    // Making an estimate primary changes the lead's job value — repaint the
    // overlay's own $ pill so the header can't disagree with the panel.
    onLeadChanged: (id, patch) => {
      const el = document.getElementById('mJdValue');
      if (!el || !patch) return;
      const v = Number(patch.jobValue) || 0;
      el.textContent = v ? '$' + v.toLocaleString() : '';
      el.hidden = !v;
    }
  });
}
// Mount (or re-render) the embedded per-customer photo workspace into the
// Photos tab. Replaces the read-only `<img>` grid openMobileJobDetail used to
// paint there — that grid had no click handler at all, so a rep could look at
// thumbnails and do nothing with them.
function _mountPhotoHub() {
  const host = document.getElementById('mJdTabPhotos');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (!window.CustomerPhotoHub) {
    host.innerHTML = '<div class="m-jd-empty">Photo panel unavailable — reload the page.</div>';
    return;
  }
  window.CustomerPhotoHub.mount(host, leadId, {
    // Adding, deleting or re-covering a photo changes the overlay's hero.
    onPhotosChanged: () => _repaintJobDetailHero(),
    onCoverChanged: () => _repaintJobDetailHero(),
  });
}

// Mount (or re-render) the Documents tab from the SAME leads/{id}/documents
// store customer.html reads (customer-documents.js), not a second copy of
// that read/normalize logic. Jo, from real use: "I can never click
// documents or see an area for it from my phone" — the mobile job-detail
// overlay simply never had a Documents tab. Reuses:
//   - window.NBDCustomerDocs.load() for the fetch+normalize (same rows,
//     same signed/status logic PR #1612 established as the source of truth)
//   - the docgen bundle (customer-documents.js added alongside it) for lazy
//     load, same contract as _generateDocWithPreflight
//   - customer-documents.js's own global `[data-doc-view]` click delegate
//     (viewGeneratedDoc) to open a generated doc's HTML — no new click
//     handler needed here, the delegate is document-level already
// Scope is read + open, matching what Activity/Details already are (no
// generate/delete/share from this tab yet — that's a bigger lift than "the
// rep can't see documents at all today").
function _mountDocumentsHub() {
  const host = document.getElementById('mJdTabDocuments');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (host.dataset.loadedFor === leadId) return;
  host.innerHTML = '<div class="m-jd-empty">Loading documents…</div>';

  (async () => {
    if (!window.NBDCustomerDocs && window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
      await window.ScriptLoader.loadBundle('docgen');
    }
    if (!window.NBDCustomerDocs) {
      host.innerHTML = '<div class="m-jd-empty">Documents unavailable — reload the page.</div>';
      return;
    }
    if (typeof window._stageWindowStateForLead === 'function') window._stageWindowStateForLead(leadId);

    let docs;
    try {
      docs = await window.NBDCustomerDocs.load(leadId);
    } catch (e) {
      host.innerHTML = '<div class="m-jd-empty">Could not load documents — try again.</div>';
      return;
    }
    // Stale by the time the fetch resolves (rep switched leads or closed the
    // overlay) — a slow load must not paint the wrong customer's documents.
    if (window._cardDetailLeadId !== leadId) return;
    host.dataset.loadedFor = leadId;

    _mJdWireSignedUploadInputs();

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    // 2026-09-17: Documents actions (generate/delete/share/homeowner-toggle)
    // — a doc row can't nest a delete/share BUTTON inside the tappable
    // View anchor/button itself (nested interactive elements, plus a tap
    // target conflict on a 375px screen), so secondary actions render as a
    // sibling row underneath the primary tappable one, not inside it.
    //
    // REGRESSION (Jo, same day as ship): these action rows only rendered
    // in the docs.length branch below — an empty Documents tab showed
    // "No documents yet" with no way to DO anything about it. They're
    // built once, up here, so both branches (empty and populated) show
    // Generate/Scan/Upload — the exact actions a rep needs BEFORE any
    // document exists, not just after.
    const genBtn = '<button type="button" class="m-jd-act-item" data-action="call" data-fn="_mJdOpenDocCreate">'
      + '<span class="m-jd-act-item-ico">➕</span>'
      + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">Generate a document</span></span>'
      + '<span class="m-jd-act-item-chev">›</span></button>';
    const scanBtn = '<button type="button" class="m-jd-act-item" data-action="call" data-fn="uploadSignedDoc" data-arg="camera">'
      + '<span class="m-jd-act-item-ico">📷</span>'
      + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">Scan a signed document</span></span>'
      + '<span class="m-jd-act-item-chev">›</span></button>';
    const uploadBtn = '<button type="button" class="m-jd-act-item" data-action="call" data-fn="uploadSignedDoc" data-arg="file">'
      + '<span class="m-jd-act-item-ico">📤</span>'
      + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">Upload a file</span></span>'
      + '<span class="m-jd-act-item-chev">›</span></button>';
    const actionRows = genBtn + scanBtn + uploadBtn;

    if (!docs.length) {
      host.innerHTML = '<div class="m-jd-act-list">' + actionRows + '</div>'
        + '<div class="m-jd-empty">No documents yet.</div>';
      return;
    }

    // Wrapped in .m-jd-act-list (same class the Activity tab uses) so rows
    // get real spacing via its gap:8px — .m-jd-act-item alone has none.
    host.innerHTML = '<div class="m-jd-act-list">' + actionRows + docs.map(d => {
      const icon = d.generated ? '📝' : '📄';
      const title = esc(d.typeName || d.name || 'Document');
      const dateStr = d.date ? d.date.toLocaleDateString() : '';
      const sub = d.signed ? ('✓ Signed' + (d.signedAt ? ' ' + d.signedAt.toLocaleDateString() : ''))
        : d.status === 'sent' ? 'Awaiting signature'
        : dateStr;
      const subHtml = sub ? '<span class="m-jd-act-item-s">' + esc(sub) + '</span>' : '';
      let row;
      if (d.url) {
        row = '<a class="m-jd-act-item" style="text-decoration:none;" href="' + esc(d.url) + '" target="_blank" rel="noopener noreferrer">'
          + '<span class="m-jd-act-item-ico">' + icon + '</span>'
          + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">' + title + '</span>' + subHtml + '</span>'
          + '<span class="m-jd-act-item-chev">›</span></a>';
      } else if (d.htmlPath) {
        row = '<button type="button" class="m-jd-act-item" data-doc-view="' + esc(d.id) + '">'
          + '<span class="m-jd-act-item-ico">' + icon + '</span>'
          + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">' + title + '</span>' + subHtml + '</span>'
          + '<span class="m-jd-act-item-chev">›</span></button>';
      } else {
        row = '<div class="m-jd-act-item m-jd-act-item--static">'
          + '<span class="m-jd-act-item-ico">' + icon + '</span>'
          + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">' + title + '</span>' + subHtml + '</span>'
          + '</div>';
      }
      // Secondary actions — same gates customer-documents.js's own desktop
      // row uses (rowHtml()): share only for a shareable photo report,
      // homeowner-toggle only for a non-generated, non-legacy upload,
      // delete always. Share and the toggle dispatch through
      // customer-documents.js's OWN document-wide [data-doc-share]/
      // [data-doc-homeowner-share] click delegates — already active once
      // that module loads, no second handler needed here. Delete calls
      // window.deleteCustomerDoc directly (its markup convention on
      // customer.html is a data-action delegate dashboard.html doesn't
      // register; simplest correct path is calling the exposed function).
      const actions = [];
      if (d.shareable) {
        actions.push('<button type="button" class="m-jd-doc-action" data-doc-share="' + esc(d.id) + '">'
          + (d.shareUrl ? 'Copy link' : 'Share link') + '</button>');
      }
      if (!d.generated && !d.legacy) {
        actions.push('<button type="button" class="m-jd-doc-action" data-doc-homeowner-share="' + esc(d.id) + '">'
          + (d.sharedWithHomeowner ? '✓ Shown to homeowner' : 'Show to homeowner') + '</button>');
      }
      actions.push('<button type="button" class="m-jd-doc-action m-jd-doc-action--danger" data-action="call" data-fn="_mJdDeleteDoc" data-arg="' + esc(d.id) + '" data-arg2="' + title + '">Delete</button>');
      return row + '<div class="m-jd-doc-actions">' + actions.join('') + '</div>';
    }).join('') + '</div>';
  })();
}

// data-fn dispatch target for the Delete button above. Kept as its own
// tiny wrapper (rather than pointing the button straight at
// window.deleteCustomerDoc) so it can re-run _mountDocumentsHub's fetch
// after a successful delete — deleteCustomerDoc() itself calls
// window.NBDCustomerDocs.refresh(), which repaints customer.html's OWN doc
// lists, not this mobile panel.
async function _mJdDeleteDoc(docId, label) {
  if (typeof window.deleteCustomerDoc !== 'function') return;
  await window.deleteCustomerDoc(docId, label);
  const host = document.getElementById('mJdTabDocuments');
  if (host) delete host.dataset.loadedFor;
  _mountDocumentsHub();
}

// One-time wiring for the two hidden signed-document file inputs (see
// dashboard.html — same signedDocFileInput/signedDocBrowseInput ids
// customer.html uses). uploadSignedDoc(mode) (the click target, dispatched
// through the registry below) just opens the matching picker; the actual
// upload happens in handleSignedDocUpload(input) from
// customer-signed-doc-upload.js, reused as-is. That file has no page of its
// own to repaint afterward — customer.html's own Documents surfaces listen
// to NBDCustomerDocs directly, but this mobile panel is a plain fetch-once
// render, so the change listener re-runs _mountDocumentsHub after the
// upload settles (success or failure — either way the list should show the
// truth). Guarded per-element so repeated tab visits don't stack listeners.
function _mJdWireSignedUploadInputs() {
  ['signedDocFileInput', 'signedDocBrowseInput'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el || el.dataset.mJdWired) return;
    el.dataset.mJdWired = '1';
    el.addEventListener('change', async () => {
      if (typeof window.handleSignedDocUpload === 'function') {
        await window.handleSignedDocUpload(el);
      }
      const host = document.getElementById('mJdTabDocuments');
      if (host) delete host.dataset.loadedFor;
      _mountDocumentsHub();
    });
  });
}

// Mobile "Generate a document" entry point.
//
// Reuses dashboard-bootstrap.module.js's _generateDocWithPreflight — the
// SAME staging (window._customerId etc.) + prerequisite-check + DocPreflight
// -open chain the desktop lead-card doc chips already use, built specifically
// so DocPreflight "can run from the dashboard the same way it runs on
// customer.html" (that file's own comment). No second copy of that logic.
// DocPreflight's own overlay is self-contained (position:fixed, z-index
// var(--z-overlay) = 10000 — well above #mJobDetail's 2100), so it stacks
// correctly on top of the mobile job-detail overlay with no CSS changes.
//
// The type list + labels come from window._DASH_DOC_PREREQUISITES (also
// exported from dashboard-bootstrap.module.js) rather than a second
// hand-written catalog — one list of "what documents exist and what they
// need," not two that could drift.
function _mJdOpenDocCreate() {
  const leadId = window._cardDetailLeadId;
  if (!leadId) return;
  const prereqs = window._DASH_DOC_PREREQUISITES;
  // _generateDocWithPreflight is registry-only (Globals Tranche 3 T3-C,
  // 2026-09-18), not a bare window global.
  const _nbdReg = window.__NBD_CALL_REGISTRY;
  if (!prereqs || !_nbdReg || typeof _nbdReg._generateDocWithPreflight !== 'function') {
    if (typeof showToast === 'function') showToast('Document generator unavailable — reload the page.', 'error');
    return;
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  const rows = Object.keys(prereqs).map((type) => {
    return '<button type="button" class="m-jd-act-item" data-action="call" data-fn="_mJdPickDocType" data-arg="' + esc(type) + '">'
      + '<span class="m-jd-act-item-ico">📄</span>'
      + '<span class="m-jd-act-item-body"><span class="m-jd-act-item-t">' + esc(prereqs[type].label) + '</span></span>'
      + '<span class="m-jd-act-item-chev">›</span></button>';
  }).join('');
  const modal = document.createElement('div');
  modal.id = 'mJdDocTypeSheet';
  // --z-overlay-top (10001): one tier above the base modal overlay
  // (--z-overlay:10000, what DocPreflight itself opens at) — this sheet is
  // an intermediate step that can be followed by DocPreflight stacking on
  // top of it, not a replacement for it.
  modal.style.cssText = 'position:fixed;inset:0;z-index:var(--z-overlay-top, 10001);background:rgba(0,0,0,.8);display:flex;align-items:flex-end;justify-content:center;';
  modal.innerHTML = '<div style="width:100%;max-width:500px;max-height:80vh;overflow-y:auto;background:var(--s, #111318);border-radius:20px 20px 0 0;border:1px solid var(--br, #1e2530);padding:16px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">'
    +   '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:18px;font-weight:800;color:var(--t);">Generate a document</div>'
    +   '<button type="button" data-action="call" data-fn="_mJdCloseDocTypeSheet" style="background:none;border:1px solid var(--br, #2a3040);border-radius:10px;color:var(--m);font-size:18px;width:34px;height:34px;">✕</button>'
    + '</div>' + rows + '</div>';
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });
  document.body.appendChild(modal);
}

function _mJdCloseDocTypeSheet() {
  const modal = document.getElementById('mJdDocTypeSheet');
  if (modal) modal.remove();
}

// Picks a document type from the sheet above, then runs the SAME
// staging+prereq+DocPreflight chain the desktop lead-card doc chips use.
function _mJdPickDocType(type) {
  _mJdCloseDocTypeSheet();
  const leadId = window._cardDetailLeadId;
  const _nbdReg = window.__NBD_CALL_REGISTRY;
  if (!leadId || !_nbdReg || typeof _nbdReg._generateDocWithPreflight !== 'function') return;
  _nbdReg._generateDocWithPreflight(type, leadId);
}

// ── Messages + Voice Intel: mount-once-per-lead, torn down on lead change ──
//
// Unlike Documents (a plain fetch, cheap to redo), Messages and Voice Intel
// both hold a LIVE Firestore onSnapshot listener once mounted. Re-mounting
// on every tab tap (like _mountDocumentsHub does) would pile up duplicate
// listeners; never tearing down would leak lead A's listener silently once
// the rep opens lead B without ever revisiting these tabs. So state tracks
// which lead each is CURRENTLY live for, mirrors _mountEstimateHub/
// _mountPhotoHub's own "unmount if leadId() !== leadId" pattern, and
// _mJdTeardownRealtimeTabs() (called from openMobileJobDetail, every open —
// not just when the rep taps these tabs) is the one place that actually
// tears one down on a lead change.
let _messagesInstance = null, _messagesMountedFor = null;
let _voiceInstance = null, _voiceMountedFor = null;

function _mountMessagesHub() {
  const host = document.getElementById('mJdTabMessages');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (_messagesMountedFor === leadId) return; // already live for this lead
  if (_messagesInstance) { try { _messagesInstance.cleanup(); } catch (_) {} _messagesInstance = null; }
  // Clear synchronously — the new lead's onSnapshot is async, and without
  // this the previous lead's message bubbles would sit visible in
  // #repMsgThread until that first snapshot arrives.
  const threadEl = document.getElementById('repMsgThread');
  const emptyEl = document.getElementById('repMsgEmpty');
  if (threadEl) Array.from(threadEl.querySelectorAll('.rep-bubble')).forEach(n => n.remove());
  if (emptyEl) emptyEl.style.display = 'block';
  const sendBtn = document.getElementById('repMsgSend');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.style.opacity = '0.55'; }
  const statusElReset = document.getElementById('repMsgStatus');
  if (statusElReset) statusElReset.textContent = '';
  if (!window.CustomerMessages || typeof window.CustomerMessages.mount !== 'function') {
    const statusEl = document.getElementById('repMsgStatus');
    if (statusEl) statusEl.textContent = 'Messages unavailable — reload the page.';
    return;
  }
  if (!window.db) return;
  _messagesInstance = window.CustomerMessages.mount({ leadId, db: window.db });
  _messagesMountedFor = leadId;
}

function _mountVoiceIntel() {
  const host = document.getElementById('mJdVoiceIntelRoot');
  const leadId = window._cardDetailLeadId;
  if (!host || !leadId) return;
  if (_voiceMountedFor === leadId) return; // already live for this lead
  if (_voiceInstance) { try { _voiceInstance.cleanup(); } catch (_) {} _voiceInstance = null; }
  if (!window.VoiceIntel || typeof window.VoiceIntel.mount !== 'function') {
    host.innerHTML = '<div class="m-jd-empty">Voice Intel unavailable — reload the page.</div>';
    return;
  }
  if (!window.auth || !window.db || !window.storage) return;
  host.innerHTML = '';
  try {
    _voiceInstance = window.VoiceIntel.mount({
      leadId, containerEl: host, auth: window.auth, db: window.db, storage: window.storage
    });
    _voiceMountedFor = leadId;
  } catch (e) {
    host.innerHTML = '<div class="m-jd-empty">Voice Intel failed to load — try again.</div>';
  }
}

// Called from openMobileJobDetail on EVERY open (not just when the rep taps
// these tabs) — a listener mounted for the previous lead must not keep
// running silently just because the rep never revisited its tab.
function _mJdTeardownRealtimeTabs(newLeadId) {
  if (_messagesMountedFor && _messagesMountedFor !== newLeadId) {
    if (_messagesInstance) { try { _messagesInstance.cleanup(); } catch (_) {} }
    _messagesInstance = null; _messagesMountedFor = null;
  }
  if (_voiceMountedFor && _voiceMountedFor !== newLeadId) {
    if (_voiceInstance) { try { _voiceInstance.cleanup(); } catch (_) {} }
    _voiceInstance = null; _voiceMountedFor = null;
  }
}
// Registered in this IIFE's own __NBD_CALL_REGISTRY block below (Globals
// Tranche 3 T3-C, 2026-09-18), no longer a bare window global.

// Recompute the job-detail hero from the same inputs openMobileJobDetail uses:
// the rep-chosen cover wins, else the first cached photo.
function _repaintJobDetailHero() {
  const heroEl = document.getElementById('mJdHero');
  const leadId = window._cardDetailLeadId;
  if (!heroEl || !leadId) return;
  const lead = (window._leads || []).find(l => l && l.id === leadId) || {};
  const photos = (window._photoCache && window._photoCache[leadId]) || [];
  const url = (lead.coverPhotoUrl && /^https?:/i.test(String(lead.coverPhotoUrl)) ? lead.coverPhotoUrl : null)
    || (photos[0] && (photos[0].url || photos[0].downloadUrl || photos[0].src));
  if (url) {
    heroEl.style.backgroundImage = 'url("' + String(url).replace(/"/g, '%22') + '")';
    heroEl.classList.add('has-photo');
  } else {
    heroEl.style.backgroundImage = '';
    heroEl.classList.remove('has-photo');
  }
  const emptyEl = document.getElementById('mJdHeroEmpty');
  if (emptyEl) emptyEl.hidden = !!url;
}

// Deliberately NOT exported to window — their only caller is _mJdSwitchTab,
// co-located in this IIFE (Globals Tranche 2c convention: no global unless
// markup or another slice actually dispatches it).
window._mJdSwitchTab = _mJdSwitchTab;

// ══════════════════════════════════════════════════════════════════════
// Wave 2D — Mobile inspection overlay
//
// Reuses the existing InspectionReportEngine (docs/pro/js/
// inspection-report-engine.js, ~2,300 lines) but hosts it in a full-
// screen mobile shell. Same engine the desktop uses → reports
// generated on phone are byte-identical to desktop-generated ones,
// no fork to maintain.
// ══════════════════════════════════════════════════════════════════════
function openMobileInspection(leadId) {
  if (!leadId) return;
  const root = document.getElementById('mInspection');
  if (!root) return;
  window._cardDetailLeadId = leadId;

  // Title — show customer name for context.
  const lead = (window._leads || []).find(l => l.id === leadId);
  const name = lead
    ? (((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.name || 'Inspection')
    : 'Inspection';
  const titleEl = document.getElementById('mInspTitle');
  if (titleEl) titleEl.textContent = name;

  // Mount the engine into the mobile container. The engine itself
  // handles loading state, template picker, photo capture, and PDF
  // generation — we just hand it a container and a lead.
  const container = document.getElementById('mInspectionContainer');
  if (container) container.innerHTML = '<div class="m-jd-empty">Loading inspection builder…</div>';

  root.hidden = false;
  root.classList.add('open');
  document.body.style.overflow = 'hidden';

  if (window.InspectionReportEngine && typeof window.InspectionReportEngine.openBuilder === 'function') {
    // The engine's openBuilder is async — fire-and-forget so we don't
    // block the slide-up animation.
    Promise.resolve(window.InspectionReportEngine.openBuilder('mInspectionContainer', leadId))
      .catch(err => {
        console.warn('inspection engine open failed:', err && err.message);
        if (container) container.innerHTML = '<div class="m-jd-empty">Inspection builder failed to load — try again in a moment.</div>';
      });
  } else {
    if (container) container.innerHTML = '<div class="m-jd-empty">Inspection engine not loaded on this page.</div>';
  }
}
window.openMobileInspection = openMobileInspection;

function closeMobileInspection() {
  const root = document.getElementById('mInspection');
  if (!root) return;
  root.classList.remove('open');
  root.hidden = true;
  // Clear the engine's contents so a stale render doesn't flash on
  // next open of a different lead.
  const container = document.getElementById('mInspectionContainer');
  if (container) container.innerHTML = '';
  // If the mobile job-detail is also open underneath, body-scroll
  // stays locked. Otherwise restore.
  const jd = document.getElementById('mJobDetail');
  if (!jd || jd.hidden) document.body.style.overflow = '';
}
// closeMobileInspection → __NBD_CALL_REGISTRY (block at the foot of this IIFE),
// Globals Tranche 3 2026-09-01. Reached ONLY through _NBD_MODAL_CLOSE_FNS
// (key `mobileInspection`), which resolves the registry first now — so the
// window export is gone. Was a MUST-STAY until the map learned about the
// registry; see the note at dashboard-actions.js's 2c-4b header.

// Wave 2C.2 — Mobile share, through the canonical minter.
//
// Tapping the share icon in the mobile job-detail top bar hands off to
// PortalLinkHelpers.copyForLead, the same path the kanban context menu and
// customer.html use. It mints a fresh revocable token URL on demand, owns the
// 3-layer clipboard fallback (clipboard API → execCommand → surface the URL)
// and — load-bearing — records the share in the Comm Log via _recordShare.
//
// This used to scrape lead.portalShortUrl / lead.portalUrl / lead.portalToken
// off the in-memory lead. PR #698 retired those persisted, permanently-valid
// Storage links and no writer for any of the three fields survives, so every
// tap read '' and fell straight into the "No portal link yet" dead end.
function _mJdShare() {
  const id = window._cardDetailLeadId;
  if (!id) return;
  // NOTE ON THE MINTER: do NOT reach for PortalLinkHelpers.resolveUrl /
  // .copyForLead here. Those hard-throw 'Portal module not loaded' unless
  // window.CustomerPortal exists, and customer-portal.js is loaded on
  // customer.html ONLY — never on either dashboard, which is where this sheet
  // lives. window._mintPortalUrl (dashboard-api.js) is the dashboard's own
  // createPortalToken path and is the one that actually works on this page.
  //
  // On a phone the share icon should raise the OS share sheet — that is how a
  // rep gets the link into whatever they actually text from. Fall back to
  // _sharePortalLink (clipboard + SMS shortcut), the same handler the desktop
  // card-detail share button uses.
  const fallback = () => {
    if (typeof window._sharePortalLink === 'function') { window._sharePortalLink(id); return; }
    if (typeof showToast === 'function') showToast('Portal links are still loading — try again in a moment', 'warning');
  };
  if (!(navigator.share && typeof window._mintPortalUrl === 'function')) { fallback(); return; }

  const lead = (window._leads || []).find(l => l && l.id === id) || {};
  const who = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || lead.name || 'your project';
  window._mintPortalUrl(id).then((portal) => {
    if (!portal) { fallback(); return; }
    return navigator.share({
      title: 'Project portal',
      text: 'Here is the project portal for ' + who + '.',
      url: portal,
    }).then(() => {
      // Every share path must reach recordShare — it stamps lastSharedAt /
      // lastSharedVia, and the fresh pulse, viewed badge, engagement tier,
      // smart-followup and stale-shares filter all read zero signal without it.
      // _sharePortalLink records on its own path; this branch must do it here.
      if (window.PortalLinkHelpers && typeof window.PortalLinkHelpers.recordShare === 'function') {
        window.PortalLinkHelpers.recordShare(id, 'share');
      }
    }).catch((err) => {
      // AbortError = the rep dismissed the OS sheet. Not a failure, and it must
      // not fall through to a surprise clipboard write + SMS composer.
      if (err && err.name === 'AbortError') return;
      fallback();
    });
  }).catch((e) => {
    console.warn('[_mJdShare] mint failed:', e && e.message);
    fallback();
  });
}

function _mJdAct(kind) {
  const id = window._cardDetailLeadId;
  if (!id) return;
  const lead = (window._leads || []).find(l => l.id === id);
  if (!lead) return;
  switch (kind) {
    case 'call':
      if (lead.phone) location.href = 'tel:' + String(lead.phone).replace(/[^0-9+]/g, '');
      break;
    case 'text':
      if (lead.phone) location.href = 'sms:' + String(lead.phone).replace(/[^0-9+]/g, '');
      break;
    case 'email':
      if (lead.email) location.href = 'mailto:' + lead.email;
      break;
    case 'photos':
      // Phase 1d: STAY on the customer, same as 'estimate' above. This used to
      // close the overlay and navigate to the GENERIC photos view (handing off
      // through window._currentPhotoLeadId), which dropped the customer context
      // the rep was working in. The overlay's own Photos tab now hosts a real
      // workspace — capture, upload, tag, set cover, delete — via
      // CustomerPhotoHub, so there is nowhere else to go.
      _mJdSwitchTab('photos');
      _scrollToTabs();
      break;
    case 'estimate': {
      // Phase 1c: STAY on the customer. This switches to the embedded
      // Estimates tab — the customer's hero, name, address and quick actions
      // remain above it in the same scroll — instead of closing the overlay
      // and navigating to the generic estimates view. Previously this guessed
      // at "the newest estimate for this lead" and threw the rep into the
      // full-screen builder with no way back to the customer; a lead with two
      // estimates could only ever reach one of them from here.
      _mJdSwitchTab('estimates');
      _scrollToTabs();
      break;
    }
  }
}
window._mJdAct = _mJdAct;

// Open a SPECIFIC estimate from a mobile job-detail Activity row
// (data-fn="_mJdOpenEstimate" data-arg="<estimateId>"). Registered below so the
// data-fn "call" dispatcher can resolve it, same as cdaMjdAct.
function _mJdOpenEstimate(estimateId) {
  if (!estimateId) return;
  // Phase 1a (RoofLink rebuild): preview sheet OVER the job detail — the
  // rep sees lines + total in one tap and only leaves this context if
  // they choose Edit. The old path (close detail → navigate to the
  // estimates view → full V2 builder) remains the Edit action and the
  // fallback when the preview module isn't loaded.
  const est = (window._estimates || []).find(e => e.id === estimateId);
  if (window.EstimatePreview && est) {
    window.EstimatePreview.open(est, {
      onEdit: () => {
        if (typeof closeMobileJobDetail === 'function') closeMobileJobDetail();
        if (typeof goTo === 'function') goTo('est');
        if (typeof window.viewEstimate === 'function') window.viewEstimate(estimateId);
      },
      onAssign: () => {
        if (typeof window.assignEstimateAction === 'function') window.assignEstimateAction(estimateId);
      }
    });
    return;
  }
  if (typeof closeMobileJobDetail === 'function') closeMobileJobDetail();
  if (typeof goTo === 'function') goTo('est');
  if (typeof window.viewEstimate === 'function') window.viewEstimate(estimateId);
}
// ⚠ LOAD-BEARING — DO NOT DELETE THIS LINE ON ITS OWN. It looks like a
// vestigial self-export (the function is already IIFE-scoped by 2c-4b), but the
// __NBD_CALL_REGISTRY entry `_mJdOpenEstimate: _mJdOpenEstimate` lives in a
// DIFFERENT IIFE further down this file. `_mJdOpenEstimate` is not lexically in
// scope there — that bare identifier resolves through the global object, i.e.
// through the property THIS line creates. Delete this alone and that entry
// throws a ReferenceError at load, which aborts its entire IIFE and silently
// takes ALL 19 registry entries in that block down with it — the whole
// customer-detail action bar (cdaReport, cdaEnrich, cdaPhotos, cdaInvoice,
// cdaInspection, cdPickStage, cdPickType, cdaInspectionDeep, cdaMjdAct,
// cdaEditLead, cdaOpenMobileInspection, cdaVoiceMemo, cdaOpenVoicemail,
// cdaSharePortalLink, cdaRevokePortalLink, cdaConfirmPromote, cdaOpenTaskModal,
// _mCreatePhotoPicked). To retire it safely: FIRST move the registry entry into
// this IIFE's own registration block below, THEN delete this line. In that
// order. (Found by the Tranche 3 T3-A slice-1 audit, 2026-08-31.)
window._mJdOpenEstimate = _mJdOpenEstimate;

// ══════════════════════════════════════════════════════════════════════
// Wave 2C.1 — Mobile create popover behind the bottom-nav "+" FAB
//
// Opens a bottom-sheet with 5 entry points (Lead / Photo / Task /
// Knock / Note). Each row hands off to an existing flow rather than
// duplicating modals. The popover closes itself before firing the
// handler so the destination modal isn't competing with our backdrop.
// ══════════════════════════════════════════════════════════════════════
function openMobileCreatePopover() {
  const bd = document.getElementById('mCreateBackdrop');
  const pop = document.getElementById('mCreatePopover');
  if (!bd || !pop) return;
  bd.hidden = false; pop.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeMobileCreatePopover() {
  const bd = document.getElementById('mCreateBackdrop');
  const pop = document.getElementById('mCreatePopover');
  if (!bd || !pop) return;
  bd.hidden = true; pop.hidden = true;
  document.body.style.overflow = '';
}
function toggleMobileCreatePopover() {
  const pop = document.getElementById('mCreatePopover');
  if (!pop) { if (typeof openLeadModal === 'function') openLeadModal(); return; }
  if (pop.hidden) openMobileCreatePopover();
  else closeMobileCreatePopover();
}
// openMobileCreatePopover is PRIVATE (Tranche 2c-4b) — sole caller
// toggleMobileCreatePopover is co-located in this IIFE; no window export.
// closeMobileCreatePopover → __NBD_CALL_REGISTRY (block at the foot of this
// IIFE), Globals Tranche 3 2026-09-01. Its only external reach was
// _NBD_MODAL_CLOSE_FNS (key `mobileCreatePopover`), which is registry-first
// now; its other two callers (toggleMobileCreatePopover just above, _mCreate
// just below) are co-located in this IIFE. Window export deleted.
// toggleMobileCreatePopover KEEPS its export — mCreateFabRoute, outside this
// IIFE, calls window.toggleMobileCreatePopover (see the 2c-4b header note).
window.toggleMobileCreatePopover = toggleMobileCreatePopover;

function _mCreate(kind) {
  closeMobileCreatePopover();
  switch (kind) {
    case 'lead':
      if (typeof openLeadModal === 'function') openLeadModal();
      break;
    case 'photo': {
      // This used to open the camera unconditionally through the hidden
      // <input capture>, and _mCreatePhotoPicked then THREW THE PHOTO AWAY —
      // it read the file, confirmed it existed, and opened the lead modal
      // with "add photos from its gallery". Four taps, a climb, and the shot
      // was gone. On a roof that is not a minor annoyance.
      //
      // The camera now opens only when there is somewhere to put the picture,
      // and it opens through PhotoEngine.openCamera — the real flow, with
      // tagging and the before/during/after phase — instead of a raw file
      // input whose result nothing consumed.
      const lid = window._cardDetailLeadId || window._currentPhotoLeadId || window._customerId || '';
      if (lid && window.PhotoEngine && typeof window.PhotoEngine.openCamera === 'function') {
        window.PhotoEngine.openCamera(lid);
        break;
      }
      // No customer in context: ask FIRST, so nothing is captured and lost.
      if (typeof showToast === 'function') {
        showToast('Pick a customer first — then the camera saves straight to their gallery.', 'info');
      }
      if (typeof openLeadModal === 'function') openLeadModal();
      break;
    }
    case 'task':
      // Deliberately NO lead argument, even though _cardDetailLeadId may be
      // set: closeMobileJobDetail() never clears it, and the "+" FAB can't
      // be tapped while a job detail is open anyway (the overlay covers it),
      // so any id here is the LAST lead viewed, not the one in front of the
      // rep. openTaskModal() with no lead now asks which customer first
      // (tasks.js) instead of opening nameless and refusing to save
      // (phone audit 2026-09-25, pipeline#3).
      if (typeof openTaskModal === 'function') openTaskModal();
      else if (typeof openLeadModal === 'function') openLeadModal();
      break;
    case 'knock': {
      // This used to try openKnock() and D2D.openNewKnock() — neither has
      // ever existed — and fall through to goTo('d2d'), so the row only
      // opened the map and the rep had to find KNOCK again (phone audit
      // 2026-09-25, pipeline#8). openD2DOrGo is the one real entry point:
      // it opens D2D.openQuickKnock, loading the lazy D2D bundle first.
      const reg = window.__NBD_CALL_REGISTRY;
      if (reg && typeof reg.openD2DOrGo === 'function') reg.openD2DOrGo();
      else goTo('d2d');
      break;
    }
    case 'note':
      // "Voice note for the day log" used to open the ADD LEAD form — there
      // was no note flow behind it. Quick Capture (quick-capture.js, loaded
      // eagerly on this page) IS that flow: record, get a summary, then save
      // it to Talk Tank or link it to a lead. The row's label now says so.
      if (window.NBDQuickCapture && typeof window.NBDQuickCapture.open === 'function') {
        if (typeof window.NBDQuickCapture.isSupported === 'function' && !window.NBDQuickCapture.isSupported()) {
          if (typeof showToast === 'function') showToast('Voice notes need microphone recording, which this browser does not support.', 'error');
          break;
        }
        window.NBDQuickCapture.open();
      } else if (typeof showToast === 'function') {
        showToast('Voice notes are still loading — try again in a moment.', 'info');
      }
      break;
  }
}

// Mobile-aware router. Card clicks (handleCardClick / openLeadDetail
// callers) go here; we pick mobile overlay vs desktop modal at click
// time so changing viewport (tablet rotation) just works.
function openLeadDetail(leadId) {
  const mobile = (typeof matchMedia === 'function')
    && matchMedia('(max-width: 768px)').matches;
  if (mobile && typeof openMobileJobDetail === 'function') {
    openMobileJobDetail(leadId);
  } else {
    openCardDetailModal(leadId);
  }
}
window.openLeadDetail = openLeadDetail;

  // Registration IS the security opt-in. The three markup-dispatched (data-fn=)
  // convertibles register here; the window re-exports above stay for the
  // cross-boundary consumers. tests/smoke/dashboard.test.js pins both sides.
  //
  // Globals Tranche 3 (2026-09-01) added the two modal-close handlers below.
  // They are dispatched through _NBD_MODAL_CLOSE_FNS (keys `mobileInspection`
  // and `mobileCreatePopover`), which used to resolve with a bare
  // window[fnName] — so they had to stay on window no matter how private they
  // were. dashboard-ui.js's _nbdResolveMapped now checks this registry first,
  // which is what let their window exports go.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, {
    _mJdSwitchTab: _mJdSwitchTab,
    _mJdShare: _mJdShare,
    _mCreate: _mCreate,
    closeMobileInspection: closeMobileInspection,
    closeMobileCreatePopover: closeMobileCreatePopover,
    // Mobile job-detail Documents tab actions (2026-09-17) — same
    // registry-not-allowlist convention as _mJdSwitchTab above.
    _mJdDeleteDoc: _mJdDeleteDoc,
    _mJdOpenDocCreate: _mJdOpenDocCreate,
    _mJdCloseDocTypeSheet: _mJdCloseDocTypeSheet,
    _mJdPickDocType: _mJdPickDocType,
    // uploadSignedDoc is customer-signed-doc-upload.js's own global
    // (loaded via the docgen bundle) — registered here, not redefined,
    // same convention _mJdDeleteDoc uses for window.deleteCustomerDoc.
    uploadSignedDoc: (...args) => (typeof window.uploadSignedDoc === 'function') && window.uploadSignedDoc(...args),
    _mJdQuickAddNote: _mJdQuickAddNote,
    // Globals Tranche 3 T3-C (2026-09-18): dashboard-widgets.js's sole
    // consumer of this teardown helper.
    _mJdTeardownRealtimeTabs: _mJdTeardownRealtimeTabs,
  });
})();

// ── Globals Tranche 3 T3-A (2026-09-18): the prospect-ops cluster is
// wrapped in this IIFE. Prior sessions' comments elsewhere calling these
// names MUST-STAY (e.g. tests/smoke/dashboard.test.js's T1_NAMES section)
// were written 2026-07-07 and are stale — that same comment block also
// lists _mJdSwitchTab as MUST-STAY, which graduated off window in a later
// tranche; nothing here reflects a live constraint, just an unfreshened
// note. Re-derived from a fresh three-way proof before wrapping:
// _prospectConfirm/_prospectPrompt are private helpers with no consumer
// outside this cluster (stay module-local, no registry entry needed).
// confirmPromoteProspect, toggleProspectHidden, viewProspectOnMap,
// absoluteDeleteProspect all register in __NBD_CALL_REGISTRY below.
// confirmPromoteProspect's own dashboard-state.js allowlist entry was
// ALSO stale — real markup dispatch goes through cdaConfirmPromote (a
// different, already-registered wrapper in the card-detail-action IIFE
// above), not this name directly; removed from the allowlist as part of
// this conversion.
(function () {
// Async confirm helper that prefers our themed in-app dialog (works in
// iOS PWA standalone where native confirm() can silently no-op) and
// falls back to native confirm only when neither is loaded yet.
async function _prospectConfirm(message, opts) {
  if (window.D2D && typeof window.D2D.uiConfirm === 'function') {
    return await window.D2D.uiConfirm(message, opts || {});
  }
  if (typeof window.uiConfirm === 'function') {
    return await window.uiConfirm(message, opts || {});
  }
  // Last-resort fallback. In PWA standalone the native call auto-answers YES
  // (same trap as loadSampleData above) and this helper gates the permanent
  // prospect erase, so take nbdConfirm's real modal ahead of it when present.
  if (typeof window.nbdConfirm === 'function') return await window.nbdConfirm(message);
  return confirm(message);
}
async function _prospectPrompt(message) {
  if (window.D2D && typeof window.D2D.uiPrompt === 'function') {
    return await window.D2D.uiPrompt(message);
  }
  if (typeof window.uiPrompt === 'function') {
    return await window.uiPrompt(message);
  }
  return prompt(message);
}

// Confirm-then-promote. Single confirm dialog before flipping isProspect.
// Registered in __NBD_CALL_REGISTRY at the end of this IIFE (Globals
// Tranche 3 T3-A, 2026-09-18), no longer a bare window global.
async function confirmPromoteProspect(leadId) {
  if (!leadId) return;
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) return;
  const name = (lead.firstName || lead.lastName)
    ? `${lead.firstName || ''} ${lead.lastName || ''}`.trim()
    : (lead.address || 'this prospect');
  const ok = await _prospectConfirm(
    `Promote ${name} to a full customer?\n\nThis adds them to your kanban as a real lead and removes them from the Prospects page.`,
    { okLabel: 'Promote', cancelLabel: 'Cancel' }
  );
  if (!ok) return;
  if (typeof window.promoteProspect === 'function') {
    await window.promoteProspect(leadId);
    closeCardDetailModal();
  }
}

// Hide / unhide a prospect from the default Prospects view. This is a
// soft-hide (writes prospectHidden:true) — the lead record stays intact
// so we don't lose its history. The Prospects page has a "Show hidden"
// toggle to bring them back.
// Registered in __NBD_CALL_REGISTRY at the end of this IIFE (Globals
// Tranche 3 T3-A, 2026-09-18), no longer a bare window global.
async function toggleProspectHidden(leadId) {
  if (!leadId) return;
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) return;
  const next = !lead.prospectHidden;
  try {
    const ref = window.doc(window.db || window._db, 'leads', leadId);
    await window.updateDoc(ref, { prospectHidden: next, updatedAt: window.serverTimestamp() });
    lead.prospectHidden = next;
    if (typeof window.showToast === 'function') {
      window.showToast(next ? 'Prospect hidden' : 'Prospect visible', 'success');
    }
    closeCardDetailModal();
    if (window.Prospects && typeof window.Prospects.refresh === 'function') window.Prospects.refresh();
  } catch (e) {
    if (typeof window.showToast === 'function') window.showToast('Failed: ' + e.message, 'error');
  }
}

// Jump to D2D map view and center on the prospect's coordinates.
// Registered in __NBD_CALL_REGISTRY at the end of this IIFE (Globals
// Tranche 3 T3-A, 2026-09-18), no longer a bare window global.
function viewProspectOnMap(leadId) {
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead || lead.lat == null || lead.lng == null) {
    if (typeof window.showToast === 'function') window.showToast('No coordinates on this prospect', 'error');
    return;
  }
  goTo('d2d');
  // After the D2D view inits, ask its map to fly to the lead.
  setTimeout(() => {
    if (window.D2D && typeof window.D2D.flyTo === 'function') {
      window.D2D.flyTo(lead.lat, lead.lng);
    } else if (window._d2dMap && typeof window._d2dMap.setView === 'function') {
      window._d2dMap.setView([lead.lat, lead.lng], 17);
    }
  }, 600);
}

// Three-step delete with TYPE 'DELETE' final gate. Permanently removes
// the lead record. Reserved STRICTLY for prospects — regular customers
// go through the soft-delete (trash) flow with recovery. The function
// hard-refuses to run on a non-prospect even if invoked directly.
// Registered in __NBD_CALL_REGISTRY at the end of this IIFE (Globals
// Tranche 3 T3-A, 2026-09-18), no longer a bare window global.
async function absoluteDeleteProspect(leadId) {
  if (!leadId) return;
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) return;

  // Hard guard — refuse to nuke a real customer record. The button only
  // appears in the prospect banner, but a stale modal state after promotion
  // could otherwise let this fire on a now-promoted lead.
  if (lead.isProspect !== true) {
    if (typeof window.showToast === 'function') {
      window.showToast('Cannot permanent-delete a customer — use Trash instead', 'error');
    }
    return;
  }

  const name = (lead.firstName || lead.lastName)
    ? `${lead.firstName || ''} ${lead.lastName || ''}`.trim()
    : (lead.address || 'this prospect');

  // Step 1
  const c1 = await _prospectConfirm(
    `Permanently delete ${name}?\n\nThis is for prospects you've decided will never be customers. The record will be ERASED — no recovery from trash. Use Hide if you just want to clear them from the view.`,
    { okLabel: 'Continue', cancelLabel: 'Cancel', danger: true }
  );
  if (!c1) return;

  // Step 2
  const c2 = await _prospectConfirm(
    `Are you ABSOLUTELY sure?\n\nLast chance to back out before the final confirmation. Click Cancel to keep them as a hidden prospect instead.`,
    { okLabel: "I'm sure", cancelLabel: 'Cancel', danger: true }
  );
  if (!c2) return;

  // Step 3 — typed gate
  const typed = await _prospectPrompt(`Final confirmation.\n\nType DELETE in all caps to permanently remove ${name}. Anything else cancels.`);
  if (typed !== 'DELETE') {
    if (typeof window.showToast === 'function') window.showToast('Delete cancelled', 'info');
    return;
  }

  try {
    const ref = window.doc(window.db || window._db, 'leads', leadId);
    await window.deleteDoc(ref);
    // Remove from in-memory cache so kanban + prospects refresh cleanly.
    window._leads = (window._leads || []).filter(l => l.id !== leadId);
    if (typeof window.showToast === 'function') window.showToast(`Permanently deleted ${name}`, 'success');
    closeCardDetailModal();
    if (window.Prospects && typeof window.Prospects.refresh === 'function') window.Prospects.refresh();
    if (typeof window.renderLeads === 'function') window.renderLeads(window._leads);
    // Notify badges + analytics that lead state changed.
    try { document.dispatchEvent(new CustomEvent('leadsChanged')); } catch (e) {}
  } catch (e) {
    if (typeof window.showToast === 'function') window.showToast('Delete failed: ' + e.message, 'error');
  }
}

window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  confirmPromoteProspect: confirmPromoteProspect,
  toggleProspectHidden: toggleProspectHidden,
  viewProspectOnMap: viewProspectOnMap,
  absoluteDeleteProspect: absoluteDeleteProspect,
});
})();

// ══════════════════════════════════════════════
// CUSTOMER-PAGE HANDOFF + CARD-DETAIL ACTIONS
// ══════════════════════════════════════════════
// Wave 11 (2026-05-05): hand off the in-memory lead to customer.html
// via sessionStorage so the customer page can render instantly from the
// already-loaded data instead of doing a cold Firestore round-trip.
// This eliminates the "data doesn't load even when leads loaded in
// kanban" failure mode on iOS Safari, where the second page load's
// Firestore connection sometimes hangs.
// ── Globals Tranche 2c-4e (2026-07-07): the customer-page handoff cluster is
// wrapped in this IIFE. The 4 openers register in __NBD_CALL_REGISTRY;
// _stashLeadForCustomerPage keeps its window export (7 typeof-guarded widget
// callers: activity-feed, almost-there, global-search, hot-leads,
// smart-followup-briefing, stale-shares, dashboard-bootstrap.module).
// editCardDetails' bare editLead/closeCardDetailModal resolve up-scope via the
// global object. See docs/dev/dashboard-actions-globals-audit.md.
(function () {
function _stashLeadForCustomerPage(leadId) {
  try {
    if (!leadId || !Array.isArray(window._leads)) return;
    const lead = window._leads.find(l => l && l.id === leadId);
    if (!lead) return;
    // Strip non-serializable Firestore Timestamp objects — convert to
    // plain millis so JSON.stringify doesn't choke.
    const safe = {};
    for (const k of Object.keys(lead)) {
      const v = lead[k];
      if (v && typeof v === 'object' && typeof v.toMillis === 'function') {
        safe[k] = { __ts: v.toMillis() };
      } else {
        safe[k] = v;
      }
    }
    sessionStorage.setItem('nbd_lead_handoff_' + leadId, JSON.stringify({
      lead: safe,
      stashedAt: Date.now()
    }));
  } catch (e) { /* sessionStorage unavailable — no-op */ }
}
// Wave 18: expose so global-search.js can stash before navigating.
window._stashLeadForCustomerPage = _stashLeadForCustomerPage;

// Canonical customer-page URL for these three navigations. NBDUrl.customer is
// the one builder for /pro/customer?id=… (it also owns the extensionless form
// the host 301s to); the literal is the documented fallback for a boot race,
// since nbd-url.js is a defer script like this one. Absolute /pro/… per the
// CI-guarded inter-page nav rule.
function _customerHref(id, hash) {
  const base = (window.NBDUrl && window.NBDUrl.customer(id))
    || ('/pro/customer.html?id=' + encodeURIComponent(id));
  return base + (hash || '');
}

function openPhotosForLead() {
  const lid = window._cardDetailLeadId;
  if (!lid) return;
  _stashLeadForCustomerPage(lid);
  // #photosTab / #documentsTab — the real element ids on customer.html. The
  // shorter '#photos' / '#documents' fragments matched nothing, so the page
  // opened scrolled to the top with no tab selected.
  window.location.href = _customerHref(lid, '#photosTab');
}

function openDocsForLead() {
  const lid = window._cardDetailLeadId;
  if (!lid) return;
  _stashLeadForCustomerPage(lid);
  window.location.href = _customerHref(lid, '#documentsTab');
}

function openFullCustomerDetails() {
  const lid = window._cardDetailLeadId;
  if (!lid) return;
  _stashLeadForCustomerPage(lid);
  window.location.href = _customerHref(lid);
}

function editCardDetails() {
  // 2026-09-25: a viewer is read-only (Jo's decision B; role-gate.js).
  if (window.NBDRole && !window.NBDRole.guard()) return;
  const lid = window._cardDetailLeadId;
  if (!lid) return;
  // Read the id BEFORE closing: closeCardDetailModal → nbdModal.close →
  // _cardDetailReset nulls window._cardDetailLeadId synchronously, so the
  // old `editLead(window._cardDetailLeadId)` always received null and the
  // edit modal never opened. (Same hoist as cdaEditLead / cdaInspectionDeep.)
  closeCardDetailModal();
  editLead(lid);
}

  // _stashLeadForCustomerPage keeps its window export above (7 widget callers).
  // The 4 openers are markup-only → registry, off window.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, {
    openPhotosForLead: openPhotosForLead,
    openDocsForLead: openDocsForLead,
    openFullCustomerDetails: openFullCustomerDetails,
    editCardDetails: editCardDetails,
  });
})();


(function(){if(_NBD_DA_DELEGATE)return;_NBD_DA_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-da-action]');if(!t)return;if(t.dataset.daAction==='reload')window.location.reload();});})();

// ══════════════════════════════════════════════
// CARD-DETAIL ACTION CLUSTER — Globals Tranche 2c-4a (2026-07-07)
// ══════════════════════════════════════════════
// The 18 card-detail action wrappers + chip pickers + the mobile photo-picker,
// consolidated OFF `window` into this IIFE and registered in
// window.__NBD_CALL_REGISTRY — which the dashboard-ui.js `call` delegate
// resolves FIRST (registration is the security opt-in that the
// _NBD_CALL_ALLOWLIST entry used to be; these names are removed from that
// allowlist in dashboard-state.js). Each wraps window._cardDetailLeadId and
// delegates to another module (NBDReports, PhotoEngine, InvoicePipeline,
// InspectionReportEngine, KanbanContextMenu, NBDVoiceMemo, NBDVoicemail) or a
// window-scoped helper — no shared top-level lexical state, so consolidating
// the scattered defs here is safe. Cross-slice calls to _mJdAct /
// openMobileInspection go through `window.*` so they survive when the mobile
// cluster (Tranche 2c-4b) goes module-local. See
// docs/dev/dashboard-actions-globals-audit.md.
(function () {
  function cdaReport() {
    if (window.NBDReports && typeof window.NBDReports.openGenerator === 'function') {
      window.NBDReports.openGenerator(window._cardDetailLeadId);
    } else if (typeof showToast === 'function') {
      showToast('Report module loading...', 'error');
    }
  }
  function cdaEnrich() {
    if (window.NBDReports && typeof window.NBDReports.enrichData === 'function') {
      window.NBDReports.enrichData(window._cardDetailLeadId);
    } else if (typeof showToast === 'function') {
      showToast('Report module loading...', 'error');
    }
  }
  function cdaPhotos() {
    if (window.PhotoEngine && typeof window.PhotoEngine.openCamera === 'function') {
      // Hoist the lead id ABOVE the close — closeCardDetailModal nulls
      // window._cardDetailLeadId synchronously (nbdModal.close →
      // _cardDetailReset), so reading it after handed openCamera null and
      // every photo captured from this button landed at photos/<uid>/null/
      // with leadId:null — attached to no customer and unrecoverable.
      const lid = window._cardDetailLeadId;
      if (typeof closeCardDetailModal === 'function') closeCardDetailModal();
      window.PhotoEngine.openCamera(lid);
    } else if (typeof showToast === 'function') {
      showToast('Photo engine loading...', 'error');
    }
  }
  function cdaInvoice() {
    if (window.InvoicePipeline && typeof window.InvoicePipeline.createInvoiceUI === 'function') {
      // Same read-before-close contract as cdaPhotos above.
      const lid = window._cardDetailLeadId;
      if (typeof closeCardDetailModal === 'function') closeCardDetailModal();
      window.InvoicePipeline.createInvoiceUI(lid);
    } else if (typeof showToast === 'function') {
      showToast('Invoice pipeline loading...', 'error');
    }
  }
  function cdaInspection() {
    if (window.InspectionReportEngine && typeof window.InspectionReportEngine.openBuilder === 'function') {
      // openBuilder(containerId, leadId) — the containerId MUST be first. The
      // original inline onclick passed 'inspectionBuilderContainer'; the CSP
      // extraction dropped it, so the builder never rendered (leadId was read as
      // the container id → getElementById miss → silent return).
      // It also never showed #inspectionBuilderOverlay, so even with the
      // container fixed the builder rendered invisibly — the same gap as the
      // Photo Library's "New Report" (phone audit 2026-09-25, views#2). No
      // markup calls this today; it stays registered, so close the gap anyway.
      const overlay = document.getElementById('inspectionBuilderOverlay');
      if (overlay) overlay.style.display = 'block';
      window.InspectionReportEngine.openBuilder('inspectionBuilderContainer', window._cardDetailLeadId);
    } else if (typeof showToast === 'function') {
      showToast('Inspection engine loading...', 'error');
    }
  }
  // Wave 28: card-detail chip pickers. Clicking either chip in the card-
  // detail modal opens the same floating menu the kanban right-click flow
  // uses — no full edit form needed to move a card or relabel its track.
  // Anchors below the chip so the menu drops down into view. The picker
  // implementation lives in kanban-context-menu.js (window.KanbanContextMenu).
  function cdPickStage(el) {
    const id = window._cardDetailLeadId;
    if (!id || !window.KanbanContextMenu) return;
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const anchor = r ? { x: r.left, y: r.bottom + 4 } : { x: 100, y: 100 };
    window.KanbanContextMenu.openStagePicker(id, anchor);
  }
  function cdPickType(el) {
    const id = window._cardDetailLeadId;
    if (!id || !window.KanbanContextMenu) return;
    const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const anchor = r ? { x: r.left, y: r.bottom + 4 } : { x: 100, y: 100 };
    window.KanbanContextMenu.openTypePicker(id, anchor);
  }
  function cdaInspectionDeep() {
    // The original onclick was: close the card-detail modal, then after 200ms
    // show the inspectionBuilderOverlay and call openBuilder. The setTimeout
    // gives the modal-close animation time to finish.
    if (window.InspectionReportEngine && typeof window.InspectionReportEngine.openBuilder === 'function') {
      const lid = window._cardDetailLeadId;
      if (typeof closeCardDetailModal === 'function') closeCardDetailModal();
      setTimeout(function(){
        const overlay = document.getElementById('inspectionBuilderOverlay');
        if (overlay) overlay.style.display = 'block';
        // openBuilder(containerId, leadId) — container first. The CSP extraction of
        // the original inline onclick dropped 'inspectionBuilderContainer', so the
        // card-detail "Report" button silently never opened the builder.
        window.InspectionReportEngine.openBuilder('inspectionBuilderContainer', lid);
      }, 200);
    } else if (typeof showToast === 'function') {
      showToast('Inspection engine loading...', 'error');
    }
  }
  // card-detail-lead-id guarded wrappers. cdaMjdAct / cdaOpenMobileInspection
  // call the mobile cluster (Tranche 2c-4b) via `window.*` so they keep
  // resolving once those callees go module-local.
  function cdaMjdAct(actionType) {
    if (!window._cardDetailLeadId || typeof window._mJdAct !== 'function') return;
    window._mJdAct(actionType, window._cardDetailLeadId);
  }
  function cdaEditLead() {
    if (window._cardDetailLeadId && typeof window.editLead === 'function') {
      const id = window._cardDetailLeadId;
      // Close the mobile job-detail overlay first. It sits at z-index 2100,
      // above the lead-edit modal's .modal-bg (z-index 2000), so without this
      // the edit modal opens *behind* the still-visible panel and the Edit
      // button appears to do nothing on mobile. (Matches cdaInspectionDeep,
      // which also closes the detail surface before opening its sub-flow.)
      if (typeof window.closeMobileJobDetail === 'function') window.closeMobileJobDetail();
      window.editLead(id);
    }
  }
  function cdaOpenMobileInspection() {
    if (window._cardDetailLeadId && typeof window.openMobileInspection === 'function') {
      window.openMobileInspection(window._cardDetailLeadId);
    }
  }
  // The voice-memo button is a TOGGLE. recordForLead's own toast already
  // promises "tap again to stop", but nothing was ever wired to stopNow()
  // (zero callers repo-wide), so the second tap opened a SECOND getUserMedia
  // stream: recorder #1 was orphaned but still live, still holding the mic,
  // and still uploading when its 60s cap fired — burning a second
  // transcribeVoiceMemo rate-limit slot for one memo. voice-memo.js keeps its
  // MediaRecorder private, so the in-flight state is tracked here.
  let _cdaVoiceRecording = false;
  function _cdaVoiceBtn() {
    // Two buttons share .cd-voice-btn in the card-detail share row (memo +
    // voicemail); match on data-fn so we never light up the voicemail one.
    return document.querySelector('.cd-voice-btn[data-fn="cdaVoiceMemo"]');
  }
  function cdaVoiceMemo() {
    if (!window._cardDetailLeadId ||
        !window.NBDVoiceMemo ||
        typeof window.NBDVoiceMemo.recordForLead !== 'function') return;
    if (_cdaVoiceRecording) {
      // stopNow only closes the recorder — recordForLead's promise carries on
      // through transcription and clears the flag below when it settles. If an
      // older voice-memo.js is cached without stopNow we still swallow the tap
      // rather than start a competing recorder; the 60s cap ends it.
      if (typeof window.NBDVoiceMemo.stopNow === 'function') window.NBDVoiceMemo.stopNow();
      return;
    }
    _cdaVoiceRecording = true;
    const btn = _cdaVoiceBtn();
    if (btn) btn.classList.add('recording');
    Promise.resolve(window.NBDVoiceMemo.recordForLead(window._cardDetailLeadId))
      .catch(() => { /* recordForLead resolves on every failure path — belt and braces */ })
      .then(() => {
        _cdaVoiceRecording = false;
        // Re-query: the card-detail modal may have been closed and rebuilt
        // during the recording, leaving `btn` detached.
        const b = _cdaVoiceBtn();
        if (b) b.classList.remove('recording');
      });
  }
  // step-4: opens the voicemail-pipeline modal for the current card-detail lead.
  function cdaOpenVoicemail() {
    if (window._cardDetailLeadId &&
        window.NBDVoicemail &&
        typeof window.NBDVoicemail.openForLead === 'function') {
      window.NBDVoicemail.openForLead(window._cardDetailLeadId);
    }
  }
  function cdaSharePortalLink() {
    if (window._cardDetailLeadId && typeof window._sharePortalLink === 'function') {
      window._sharePortalLink(window._cardDetailLeadId);
    }
  }
  function cdaRevokePortalLink() {
    if (window._cardDetailLeadId && typeof window._revokePortalLink === 'function') {
      window._revokePortalLink(window._cardDetailLeadId);
    }
  }
  function cdaConfirmPromote() {
    // Registry-only (Globals Tranche 3 T3-A, 2026-09-18), not a bare window global.
    var _nbdReg = window.__NBD_CALL_REGISTRY;
    if (window._cardDetailLeadId && _nbdReg && typeof _nbdReg.confirmPromoteProspect === 'function') {
      _nbdReg.confirmPromoteProspect(window._cardDetailLeadId);
    }
  }
  function cdaOpenTaskModal() {
    if (window._cardDetailLeadId && typeof openTaskModal === 'function') {
      openTaskModal(window._cardDetailLeadId, null);
    }
  }
  // Photo capture handler — shared by the mobile "+" create popover and the
  // view-photos shutter FAB's no-lead fallback. Both fire BEFORE any lead
  // exists, but a photo can only be stored against a lead
  // (PhotoEngine.uploadFromFile requires a leadId) and there is no
  // standalone-upload path. So route the rep to create/open a lead and add
  // photos from its gallery. (Previously called window.PhotoEngine.uploadOne —
  // not a real method — or pushed to window._pendingPhotoUploads, which
  // nothing consumed, silently dropping the photo behind a false success toast.)
  /**
   * Safety net for the hidden #mCreatePhotoInput.
   *
   * This used to read the captured file, confirm it existed, and then discard
   * it — opening the lead modal with "Create or open a lead, then add photos
   * from its gallery". The photo the rep had just climbed up and taken was
   * simply gone, and the toast read like success.
   *
   * The '+' → Photo action no longer opens the camera without a destination,
   * so this is now a fallback path. When a customer IS resolvable the file is
   * actually uploaded; when it is not, we say so plainly rather than implying
   * the shot was kept.
   */
  async function _mCreatePhotoPicked(event) {
    const input = event && event.target;
    try {
      const file = input && input.files && input.files[0];
      if (!file) return;

      const lid = window._cardDetailLeadId || window._currentPhotoLeadId || window._customerId || '';
      if (lid && window.PhotoEngine && typeof window.PhotoEngine.uploadFromFile === 'function') {
        if (typeof showToast === 'function') showToast('Uploading photo…', 'info');
        await window.PhotoEngine.uploadFromFile(lid, file);
        if (typeof showToast === 'function') showToast('✓ Photo saved to the customer’s gallery', 'success');
        return;
      }

      // Nowhere to put it. Do not pretend otherwise.
      if (typeof showToast === 'function') {
        showToast('That photo was not saved — no customer was selected. Open the customer, then tap the camera.', 'error');
      }
      if (typeof openLeadModal === 'function') openLeadModal();
    } catch (e) {
      console.warn('mobile photo upload failed:', e && e.message);
      if (typeof showToast === 'function') {
        showToast('Photo upload failed — check your signal and try from the customer’s gallery.', 'error');
      }
    } finally {
      // Reset input so the same file can be re-picked next time.
      if (input) input.value = '';
    }
  }

  // Registration IS the security opt-in (the role the _NBD_CALL_ALLOWLIST
  // entry used to play). tests/smoke/dashboard.test.js pins registration +
  // off-window status for every name below.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, {
    cdaReport: cdaReport,
    cdaEnrich: cdaEnrich,
    cdaPhotos: cdaPhotos,
    cdaInvoice: cdaInvoice,
    cdaInspection: cdaInspection,
    cdPickStage: cdPickStage,
    cdPickType: cdPickType,
    cdaInspectionDeep: cdaInspectionDeep,
    cdaMjdAct: cdaMjdAct,
    _mJdOpenEstimate: _mJdOpenEstimate,
    cdaEditLead: cdaEditLead,
    cdaOpenMobileInspection: cdaOpenMobileInspection,
    cdaVoiceMemo: cdaVoiceMemo,
    cdaOpenVoicemail: cdaOpenVoicemail,
    cdaSharePortalLink: cdaSharePortalLink,
    cdaRevokePortalLink: cdaRevokePortalLink,
    cdaConfirmPromote: cdaConfirmPromote,
    cdaOpenTaskModal: cdaOpenTaskModal,
    _mCreatePhotoPicked: _mCreatePhotoPicked,
  });
})();
