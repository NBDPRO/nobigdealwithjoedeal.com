/**
 * NBD Pro — /pro/analytics.html auth gate.
 * Extracted from an inline <script type="module"> so strict CSP can drop
 * 'unsafe-inline'. Initializes the shared NBDAuth gate and boots the
 * analytics controller once the user is verified.
 */
import { NBDAuth } from '/pro/js/nbd-auth.js';

// Inside the dashboard (AI Usage view) the page is an iframe: drop its own
// top nav, which only duplicated the dashboard's (analytics.html CSS).
try { if (window.self !== window.top) document.documentElement.classList.add('nbd-embedded'); } catch (_) { document.documentElement.classList.add('nbd-embedded'); }

window._nbdAuth = NBDAuth.init({
  requiredPlan: 'starter',
  onReady: () => {
    document.getElementById('authGate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    // bootAnalytics is registry-only (Globals Tranche 3, T3-C) — registered by
    // pro-analytics.js. Missing entry = no boot, same as the old typeof guard.
    const _nbdReg = window.__NBD_CALL_REGISTRY;
    if (_nbdReg && typeof _nbdReg.bootAnalytics === 'function') _nbdReg.bootAnalytics();
  }
});
