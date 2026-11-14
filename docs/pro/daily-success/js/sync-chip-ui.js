/**
 * sync-chip-ui.js - draws the one sync chip into #sdot (audit M9). The rules are in sync-chip-logic.js.
 *
 * Inputs: app.js markDirty / markSaved (NBDSyncChip.setDirty), the 'nbd-ds-sync' event from ds-firebase-sync.js
 * ({ cloud, signedIn, at }), and the window online / offline events. The failed chip is a button: a tap calls NBDDsCloud.retry().
 */
(function () {
  'use strict';
  const L = window.NBDSyncChip;
  if (!L || typeof L.chipState !== 'function') return;
  const st = { signedIn: null, online: typeof navigator === 'undefined' || navigator.onLine !== false, dirty: false, cloud: 'idle', at: 0 };
  let last = null;

  function render() {
    const el = document.getElementById('sdot');
    if (!el) return;
    const c = L.chipState(st);
    last = c;
    el.textContent = '';
    c.parts.forEach((p) => { const sp = document.createElement('span'); if (p[1]) sp.className = 'sd-l'; sp.textContent = p[0]; el.appendChild(sp); });
    el.className = c.cls;
    if (c.retry) {
      el.setAttribute('role', 'button'); el.tabIndex = 0;
      el.setAttribute('aria-label', 'Not synced to the cloud. Tap to retry.');
    } else {
      if (el.getAttribute('role') === 'button') el.removeAttribute('role');
      el.removeAttribute('tabindex'); el.removeAttribute('aria-label');
    }
  }
  function retry() {
    if (!last || !last.retry) return;
    const c = window.NBDDsCloud;
    if (c && typeof c.retry === 'function') c.retry();
  }

  window.addEventListener('nbd-ds-sync', (ev) => {
    const d = (ev && ev.detail) || {};
    if (d.cloud) st.cloud = d.cloud;
    if (typeof d.signedIn === 'boolean') st.signedIn = d.signedIn;
    if (d.at) st.at = d.at;
    render();
  });
  window.addEventListener('online', () => { st.online = true; render(); });
  window.addEventListener('offline', () => { st.online = false; render(); });
  document.addEventListener('click', (ev) => { if (ev.target && ev.target.closest && ev.target.closest('#sdot')) retry(); });
  document.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target && ev.target.id === 'sdot' && last && last.retry) { ev.preventDefault(); retry(); }
  });

  window.NBDSyncChip.setDirty = (b) => { st.dirty = !!b; render(); };
  window.NBDSyncChip.state = () => Object.assign({}, st);
})();
