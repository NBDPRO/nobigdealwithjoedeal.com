/**
 * integrations-client.js — thin client wrappers around the server
 * callable functions. Exposes window.NBDIntegrations so any view can
 * trigger a roof measurement (Instant Roofer by default), look up a parcel,
 * or pull hail history. (E-signature left this file with BoldSign on
 * 2026-10-04 — the estimate builder calls sendEstimateEnvelope itself; there
 * is no vendor to gate on.)
 *
 * Every call:
 *   1. Lazy-imports the Firebase Functions SDK (reuses window._functions
 *      if rep-report-generator / admin-manager already bootstrapped it).
 *   2. Checks window._integrationStatus cache so disabled providers
 *      show a toast instead of a cryptic 400.
 *   3. Falls back gracefully — every method returns a { ok, … } shape.
 *
 * Public API:
 *   NBDIntegrations.requestMeasurement({ address, leadId })
 *   NBDIntegrations.lookupParcel(address)
 *   NBDIntegrations.getHailHistory(lat, lng, { radiusMi, daysBack })
 *   NBDIntegrations.status()       // forces reload of the status cache
 */

(function () {
  'use strict';

  if (window.NBDIntegrations && window.NBDIntegrations.__sentinel === 'nbd-int-v1') return;

  async function callable(name) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    return window._httpsCallable(window._functions, name);
  }

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }

  const state = { status: null, statusFetchedAt: 0 };
  const STATUS_TTL_MS = 5 * 60 * 1000;

  // integrationAvailability is the non-admin-safe subset of the
  // admin-only integrationStatus callable (functions/handlers/integrations.js —
  // see its H-06 comment for why integrationStatus itself stays admin-gated).
  // Every signed-in rep can call it, so status() no longer needs a client-side
  // short-circuit for non-admins — that short-circuit used to fake a
  // permanently-empty `configured: {}` without ever hitting the network,
  // which made requireConfigured() unconditionally false for every ordinary
  // rep regardless of whether the integration was actually configured.
  async function status(force) {
    if (!force && state.status && (Date.now() - state.statusFetchedAt) < STATUS_TTL_MS) {
      return state.status;
    }
    try {
      const fn = await callable('integrationAvailability');
      const res = await fn({});
      state.status = res.data || { configured: {} };
      state.statusFetchedAt = Date.now();
      window._integrationStatus = state.status;
    } catch (e) {
      state.status = { configured: {}, error: e.message };
    }
    return state.status;
  }

  function requireConfigured(key, humanName) {
    // Fail CLOSED on missing status: allowing calls through pretends the
    // integration is configured, which surfaces cryptic server errors
    // mid-flow (and quietly bills against API quotas). A short "still
    // checking" toast + false is a much better UX and forces the caller
    // to retry after the background status() fetch lands.
    if (!state.status) {
      toast(humanName + ' integration status still loading — try again in a second.', 'info');
      return false;
    }
    if (!state.status.configured || !state.status.configured[key]) {
      toast(humanName + ' integration not set up. Contact support.', 'error');
      return false;
    }
    return true;
  }

  // lat/lng are optional — pass them when the caller already has the roof's
  // point (a lead's stored coords, a D2D knock pin); the server otherwise
  // resolves the address itself. reportType 'human' orders the ~1 h Human
  // Certified Report instead of the instant AI measure.
  async function requestMeasurement({ address, leadId, lat, lng, reportType }) {
    await status();
    const chosen = state.status?.providers?.measurement || 'instantroofer';
    if (!requireConfigured(chosen, 'Roof measurement')) return { ok: false };
    try {
      const fn = await callable('requestMeasurement');
      const payload = { address, leadId: leadId || null };
      if (typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng)) {
        payload.lat = lat; payload.lng = lng;
      }
      if (reportType === 'human') payload.reportType = 'human';
      const res = await fn(payload);
      const d = (res && res.data) || {};
      toast(d.status === 'ready'
        ? (d.cached ? 'Measurement loaded from a recent report — no new charge' : 'Measurement ready')
        : 'Measurement requested — ready in ~' + (d.estimatedMinutes || 30) + ' minutes', 'success');
      return { ok: true, ...d };
    } catch (e) {
      toast(e.message || 'Measurement request failed', 'error');
      return { ok: false, error: e.message };
    }
  }

  async function lookupParcel(address) {
    await status();
    if (!requireConfigured('regrid', 'Parcel intel')) return { ok: false };
    try {
      const fn = await callable('lookupParcel');
      const res = await fn({ address });
      return { ok: true, ...res.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async function getHailHistory(lat, lng, opts) {
    opts = opts || {};
    try {
      const fn = await callable('getHailHistory');
      const res = await fn({
        lat: Number(lat), lng: Number(lng),
        radiusMi: Number(opts.radiusMi) || 3,
        daysBack: Number(opts.daysBack) || 365
      });
      return { ok: true, ...res.data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  window.NBDIntegrations = {
    __sentinel: 'nbd-int-v1',
    status,
    requestMeasurement,
    lookupParcel,
    getHailHistory
  };

  // Kick off a status fetch once auth is live so later UI interactions
  // have the cache warm.
  let authTries = 0;
  const t = setInterval(() => {
    authTries++;
    if (window._user) { clearInterval(t); status(true); }
    else if (authTries > 40) { clearInterval(t); }
  }, 250);
})();
