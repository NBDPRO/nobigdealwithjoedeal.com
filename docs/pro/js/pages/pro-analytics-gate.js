/**
 * NBD Pro — /pro/analytics.html auth gate.
 * Extracted from an inline <script type="module"> so strict CSP can drop
 * 'unsafe-inline'. Initializes the shared NBDAuth gate and boots the
 * analytics controller once the user is verified.
 */
import { NBDAuth } from '/pro/js/nbd-auth.js';

// The html.nbd-embedded marker (the AI Usage pane inside the dashboard drops
// its own top nav) is set by pro-embed-mode.js, shared with the other tool pages.

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
