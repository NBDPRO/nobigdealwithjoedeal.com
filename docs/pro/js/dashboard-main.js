/**
 * dashboard-main.js — thin shim that owns the page lifecycle.
 *
 * As of Step 4a (2026-05-16) this file is the SIXTH and LAST script
 * in the dashboard load chain:
 *
 *   state → api → widgets → ui → actions → main (this file)
 *
 * Everything that used to live here got split into the five sibling
 * modules above. What stayed:
 *   - waitForLeaflet() — the callback wrapper that other code (mostly
 *     goTo's map view branches in dashboard-actions.js) uses to defer
 *     work until Leaflet is parsed and `L` is on window.
 *   - The hashchange listener that runs goTo() on browser back/forward.
 *   - The DOMContentLoaded boot that parses the initial #hash and
 *     loads Cal.com settings.
 *
 * If you're hunting for code that was here pre-split:
 *   - Module state / constants / boot IIFEs → dashboard-state.js
 *   - loadPhotoCounts, renderLeaderboard, fetchPropertyIntel,
 *     geocode, saveDocUpload, loadDocs, _gdpr*, _sharePortalLink,
 *     _revokePortalLink → dashboard-api.js
 *   - renderEstimatesList, viewEstimate, renderPhotoLeads,
 *     renderPhotoGrid, openPhotoFor, uploadPhotos,
 *     renderRecentPhotoFeed, renderIntelCard,
 *     fetchPropertyIntelModal, renderZoneList, updatePinStats,
 *     openCardDetailModal, closeCardDetailModal, openMobileJobDetail,
 *     closeMobileJobDetail, populateProspectQuickActions
 *     → dashboard-widgets.js
 *   - updateBreadcrumb, _hydrateViewTemplate, data-action delegate,
 *     Cal.com UI, autocomplete UI, DOC_TEMPLATES + doc
 *     viewer UI, property-intel modal UI, applyTheme + loadSavedTheme
 *     + nbdComfort*, kanban density UI, sidebar/fullscreen/Tools
 *     menu / scroll-collapse, ds floor/theme grid render, mobileNav,
 *     toggleMobileMore, closeMobileMore, toggleMapSidebar,
 *     syncMobileBadge, CRM secondary-header UI, spyglass /
 *     fabToggle / quickStormCheck → dashboard-ui.js
 *   - goTo() router, card-detail action wrappers (cda*),
 *     mCreateFabRoute, openDailyProgramFromMore, mQuickAddRoute,
 *     restartOnboardingTour, openDecisionPicker, openD2DOrGo,
 *     clearAccentTheme, openSettingsTab, openPhotoEngineOrClickProxy,
 *     openReportGenerator, enrichReportData, hideFollowUpAlerts,
 *     openCalBookingUrl, hardResetTest, gstaticTest, modeLineDraw,
 *     selectZoneColor, startZoneDraw, cancelZoneDraw, saveZone,
 *     deleteZone, loadSampleData, damageNearMePhotos, daily-program
 *     config (dsLoadConfig, dsAddFloor, dsRemoveFloor, dsSaveConfig,
 *     dsResetDefaults, dsGetConfig, dsDefaultFloors),
 *     _mJdSwitchTab, _mJdShare, _mJdAct, openMobileInspection,
 *     closeMobileInspection, openMobileCreatePopover,
 *     closeMobileCreatePopover, toggleMobileCreatePopover, _mCreate,
 *     _mCreatePhotoPicked, openLeadDetail, confirmPromoteProspect,
 *     toggleProspectHidden, viewProspectOnMap, absoluteDeleteProspect,
 *     _stashLeadForCustomerPage, openPhotosForLead, openDocsForLead,
 *     openFullCustomerDetails, editCardDetails → dashboard-actions.js
 *     (its long block of forward-references onto window was deleted
 *     in Globals Tranche 3 T3-A part 1, 2026-08-31)
 *   - showToast → js/ui.js (dashboard-ui.js's legacy copy was deleted
 *     in the T3-A whole-file IIFE wrap, 2026-09-18)
 *
 * The behavioural surface area is unchanged. Smoke tests pre-split
 * (`1404 passed, 0 failed`) must still pass post-split.
 */
// ══════════════════════════════════════════════
// WAIT FOR LEAFLET — safety guard
// ══════════════════════════════════════════════
function waitForLeaflet(cb) {
  if (typeof L !== 'undefined') { cb(); return; }
  const t = setInterval(() => { if (typeof L !== 'undefined') { clearInterval(t); cb(); } }, 50);
}

// ══════════════════════════════════════════════
// HASHCHANGE — browser back/forward navigation
// ══════════════════════════════════════════════
window.addEventListener('hashchange', () => {
  // routeFromHash (dashboard-state.js) is the single parser — it strips the
  // leading slash goTo() writes and defaults an empty hash to 'home', the
  // same default the boot below uses. Previously this path sent an empty
  // hash to 'dash' while the boot sent it to 'home', so browser Back from
  // the first view landed on the ops-overview Dashboard.
  const { name, id } = routeFromHash();
  if (routeConfig[name]) {
    goTo(name, { id, skipHash: true });
  }
});

// ══════════════════════════════════════════════
// DOMContentLoaded — initial route + Cal.com settings
// ══════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  // Same parser, same 'home' default as the hashchange handler above.
  const { name, id } = routeFromHash();
  if (name !== 'home' && routeConfig[name]) {
    goTo(name, { id, skipHash: true });
    return;
  }
  // Default to home (widget dashboard)
  goTo('home', { skipHash: true });

  // Render widgets on home page
  if(window.NBDWidgets) window.NBDWidgets.render();

  // Load Cal.com settings on page load
  loadCalSettings();
});

// ══ DEMO SEEDER (extracted to js/demo.js) ════════════════════

// ── sidebar keyboard nav (consolidation 2026-07-19) ─────────────────────
// .ni items are divs with a click delegate — unreachable by keyboard until
// the markup sweep added tabindex. Enter/Space activates like a click. The three
// collapsible section headers (TOOLS / INSIGHTS / AI TOOLS) are the same kind of div.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const ni = e.target && e.target.closest && e.target.closest('.ni[data-action], .nav-section-header[data-action]');
  if (!ni) return;
  e.preventDefault();
  ni.click();
});
