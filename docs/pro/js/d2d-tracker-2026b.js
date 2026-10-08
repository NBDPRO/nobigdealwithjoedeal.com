/**
 * d2d-tracker-2026b.js — public API shim (window.D2D)
 *
 * Step 4f (2026-05-17): the 3539-line monolith got split into:
 *   - d2d-tracker-core-2026b.js  — state + CRUD + utilities + map
 *   - d2d-tracker-ui-2026b.js    — renderD2D + modals + capture
 *   - d2d-tracker-2026b.js       — this file: aggregates window.D2D
 *
 * Load order (dashboard.html): core → ui → shim. Each sibling
 * publishes helpers onto window._D2DState so this shim can compose
 * the public surface from both halves. Behavior is byte-for-byte
 * identical to the pre-split file from a caller's perspective.
 */
(function() {
  'use strict';

  const state = window._D2DState || (window._D2DState = {});

  if (typeof state.initD2D !== 'function' || typeof state.renderD2D !== 'function') {
    console.error('[d2d-tracker] core/ui modules missing — load order should be core → ui → shim');
    return;
  }

  window.D2D = {
    init: state.initD2D,
    renderD2D: state.renderD2D,
    loadKnocks: state.loadKnocks,
    // "Search this area" — viewport-scoped knock pull + plain refresh. Fixes
    // the loadKnocks 500-most-recent cap for reps panning to older territory.
    loadKnocksInViewport: state.loadKnocksInViewport,
    searchThisArea: state.runSearchThisArea,
    refreshKnocks: state.refreshKnocks,
    // Map-data diagnostic — "why is my map empty?" Returns {loadedOnMap,
    // withCoordinates, totalInAccount, ...} and shows a plain-English verdict.
    mapDiagnostics: state.runMapDiagnostics,
    // Flip the map's mark look between detailed dots and color pins.
    toggleMarkStyle: state.toggleMarkStyle,
    // Follow mode — keep the map centered on the rep as they move.
    toggleFollow: state.toggleFollow,
    // Opt-in/beta: spin the map to the rep's heading (lazy-loads the plugin).
    toggleMapRotate: state.toggleMapRotate,
    // On-map address search (ported from the retired Maps & Pins).
    d2dSearchAddress: state.d2dSearchAddress,
    // Collapse/expand the map layers+tools panel.
    toggleLayerPanel: state.toggleLayerPanel,
    openQuickKnock: state.openQuickKnock,
    closeQuickKnock: state.closeQuickKnock,
    selectDispo: state.selectDispo,
    // One-tap outcome row on the knock sheet (2026-10-08).
    quickOutcome: state.quickOutcome,
    submitKnock: state.handleSubmitKnock,
    // Address-accuracy actions (data-d2d-action triggers in the knock modal)
    verifyKnockAddress: state.verifyKnockAddress,
    pickAddrSource: state.pickAddrSource,
    resolveDoorAt: state.resolveDoorAt,
    verifyAddressString: state.verifyAddressString,
    // Address data-quality / re-verify queue
    reverifyKnock: (id) => state.reverifyKnock(id),
    reverifyPending: () => state.reverifyPending(25),
    reverifyTeam: () => state.reverifyTeam(300),
    runCoach: state.runCoach,
    getAddressQuality: state.getAddressQuality,
    loadPropertyIntel: state.loadPropertyIntel,
    orderRoofReport: state.orderRoofReport,
    openKnockDetail: state.openKnockDetail,
    closeKnockDetail: state.closeKnockDetail,
    // These have data-d2d-action triggers in the UI (photo thumbnails in the
    // knock-detail modal; the 📞 button in the follow-up list) but were never
    // exported here, so the click delegate (window.D2D[action]) no-op'd them.
    openImage: state.openImage,
    callPhone: state.callPhone,
    convertToLead: state.convertToLead,
    convertToLeadWithEdit: state.convertToLeadWithEdit,
    // The hot-lead conversion prompt and the follow-ups banner dispatch these
    // composed ui helpers via data-d2d-action; the click delegate resolves
    // actions ONLY through window.D2D, so anything missing here is a dead
    // button ('[d2d] no dispatch').
    convertToLeadAndDismissPrompt: state.convertToLeadAndDismissPrompt,
    convertToLeadWithEditAndDismissPrompt: state.convertToLeadWithEditAndDismissPrompt,
    dismissConvertPrompt: state.dismissConvertPrompt,
    dismissFollowupsBanner: state.dismissFollowupsBanner,
    deleteKnock: state.deleteKnock,
    toggleHeatMap: state.toggleHeatMap,
    setDateFilter: state.setDateFilter,
    setDispoFilter: state.setDispoFilter,
    setTab: state.setTab,
    refreshMapMarkers: state.refreshMapMarkers,
    getMetrics: state.getMetrics,
    getRevenueMetrics: state.getRevenueMetrics,
    getTimeOfDayStats: state.getTimeOfDayStats,
    getInsuranceMetrics: state.getInsuranceMetrics,
    centerOnMe: state.centerOnMe,
    capturePhoto: state.capturePhoto,
    startVoice: state.startVoiceRecording,
    stopVoice: state.stopVoiceRecording,
    sendFollowUpSMS: state.sendFollowUpSMS,
    sendFollowUpEmail: state.sendFollowUpEmail,
    openSMSChooser: (knockId) => {
      const k = state.knocks.find(x => x.id === knockId);
      if (!k) return;
      // Door-knock texts need the homeowner's OK on file (2026-10-05).
      if (typeof state.canTextKnock === 'function' && !state.canTextKnock(k)) {
        window.showToast?.(state.NO_CONSENT_MSG || 'No texting OK on file for this homeowner.', 'error');
        return;
      }
      state.openSMSTemplateChooser(k);
    },
    recordSmsConsent: (knockId) => state.recordSmsConsent && state.recordSmsConsent(knockId),
    exportCSV: state.exportKnocksCSV,
    calcRoute: () => {
      state.calculateWalkingRoute();
      state.drawWalkingRoute();
      state.renderD2D();
      // Detailed toast — stops + distance + walking time at 3mph — so the
      // rep knows immediately whether to commit the walk or break it up.
      // Falls back to a bare count for the < 2 stop edge case where _stats
      // distance is zero.
      const stats = state.walkingRoute?._stats;
      const n = state.walkingRoute?.length || 0;
      const msg = stats && stats.totalMiles > 0
        ? `${n} stops · ${stats.totalMiles.toFixed(2)} mi · ${Math.round(stats.walkMinutes)} min walk`
        : n === 0 ? 'No unvisited doors to route'
        : `Route calculated: ${n} stops`;
      window.showToast?.(msg, 'info');
    },
    clearRoute: () => { state.clearWalkingRoute(); state.renderD2D(); },
    // Hand the optimized walking route to the phone's native map app.
    navRoute: state.openRouteInMaps,
    loadRepProfile: state.loadRepProfile,
    loadTeamKnocks: state.loadTeamKnocks,
    loadTerritories: state.loadTerritories,
    saveTerritory: state.saveTerritory,
    toggleTeamMode: () => {
      state.teamMode = !state.teamMode;
      if (state.teamMode) { state.subscribeTeamActivity(); }
      else { state.unsubscribeTeamActivity(); }
      state.loadKnocks().then(() => state.renderD2D());
    },
    getTeamActivity: state.getTeamActivity,
    refreshMap: () => { if (state.d2dMap) { state.d2dMap.invalidateSize(); } },
    // Hail overlay — pulls recent hail reports for the visible map
    // center and draws circle markers sized by hail stone diameter.
    // Re-run any time to refresh for the current view.
    showHail: async (opts) => {
      opts = opts || {};
      if (!state.d2dMap || !window.L || !window.NBDIntegrations) return { ok: false, reason: 'map-not-ready' };
      const center = state.d2dMap.getCenter();
      const radiusMi = Number(opts.radiusMi) || 5;
      const daysBack = Number(opts.daysBack) || 365;
      const toastFn = window.showToast || (() => {});
      toastFn('Loading hail history...', 'info');
      const res = await window.NBDIntegrations.getHailHistory(center.lat, center.lng, { radiusMi, daysBack });
      if (!res || !res.ok) {
        toastFn('Hail lookup failed', 'error');
        return res;
      }
      // Clear any prior hail layer, rebuild fresh.
      if (window._d2dHailLayer) {
        try { state.d2dMap.removeLayer(window._d2dHailLayer); } catch (e) {}
      }
      const layer = L.layerGroup();
      (res.hits || []).forEach(h => {
        if (h.lat == null || h.lng == null) return;
        const size = Number(h.sizeInches) || 0.5;
        const color = size >= 1.5 ? '#ff3b3b' : size >= 1.0 ? '#ff8c00' : '#ffd54a';
        const m = L.circleMarker([h.lat, h.lng], {
          radius: Math.max(4, Math.min(18, size * 6)),
          color: color,
          fillColor: color,
          fillOpacity: 0.45,
          weight: 2
        });
        const when = h.at ? new Date(h.at).toLocaleDateString() : 'unknown date';
        // h.source is a third-party vendor string (copied verbatim from the
        // NOAA/IEM storm-report feed) rendered into innerHTML by bindPopup —
        // escape it so markup in the feed can't inject into the /pro page.
        const src = String(h.source || 'unknown').replace(/[&<>"']/g, c => (
          { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        m.bindPopup('<strong>' + size.toFixed(2) + '&quot; hail</strong><br>'
          + when + '<br><small>source: ' + src + '</small>');
        layer.addLayer(m);
        // If the provider returned a swath polygon (HailTrace does),
        // draw it under the marker.
        if (h.polygon && Array.isArray(h.polygon.coordinates)) {
          try {
            const poly = L.geoJSON({ type: 'Polygon', coordinates: h.polygon.coordinates }, {
              style: { color, weight: 1, fillColor: color, fillOpacity: 0.12 }
            });
            layer.addLayer(poly);
          } catch (e) {}
        }
      });
      layer.addTo(state.d2dMap);
      window._d2dHailLayer = layer;
      toastFn((res.hits || []).length + ' hail reports in last ' + daysBack + ' days', 'success');
      return res;
    },
    hideHail: () => {
      if (window._d2dHailLayer && state.d2dMap) {
        try { state.d2dMap.removeLayer(window._d2dHailLayer); } catch (e) {}
        window._d2dHailLayer = null;
      }
    },
    // The ⛈ Hail button dispatches toggleHail (ui module helper that flips
    // between showHail/hideHail based on the current overlay state).
    toggleHail: state.toggleHail,
    // Turn recent significant hail into a canvassing territory
    stormZone: () => state.createStormTerritory({ minSizeInches: 1.0, radiusMi: 15, daysBack: 365 }),
    // iOS-safe DOM confirm/prompt. dashboard-actions.js (uiConfirmShared),
    // crm-pipeline.js and estimates.js all guard-call window.D2D.uiConfirm —
    // but it was never exported here, so every one of those calls silently
    // fell through to native confirm() (blocked in iOS PWA standalone).
    uiConfirm: state.uiConfirm,
    uiPrompt: state.uiPrompt,
    DISPOSITIONS: state.DISPOSITIONS,
    DISPO_ORDER: state.DISPO_ORDER,
    CARRIERS: state.CARRIERS
  };
})();
