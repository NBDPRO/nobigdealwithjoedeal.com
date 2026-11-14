/**
 * offline-banner.js — Wave 151 (network status banner)
 *
 * Surfaces a persistent yellow banner across the top of the page
 * when the browser reports `navigator.onLine === false`. Reads
 * are still served from cache (W124+W127 SW), but writes are
 * queued via offline-manager.js — the banner gives the rep
 * confidence that:
 *   - The app is still working
 *   - Their writes will sync when reconnection happens
 *   - The "save failed" toasts they might see are network-related,
 *     not data-related
 *
 * Reappears on every transition online → offline. Auto-hides on
 * reconnection.
 *
 * iOS Safari + Android Chrome both fire `online` / `offline`
 * window events when the radio status changes. Reliable enough for
 * a status banner; we don't try to actively probe (cellular
 * "online but no LTE" stays as online here, which matches user
 * expectation).
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['offline-banner']) return;
  __NBD_LOADED['offline-banner'] = true;

  const BANNER_ID = 'nbd-offline-banner';

  // Weak signal (wave-1 field #14, Joe 2026-11-14): this banner read only
  // navigator.onLine, and one bar of LTE is "online", so on a roof the rep
  // saw nothing while saves sat on the phone. The banner now also shows
  //   - when the browser reports a slow link (navigator.connection 2g or a
  //     round trip of 1.5 s or more; not on iOS, which has no such API), or
  //   - when changes have been waiting to sync for WEAK_AFTER_MS while the
  //     phone claims to be online (NBDOfflineSync.pending(), the same count
  //     the sync badge shows): the signal that works on an iPhone.
  const WEAK_AFTER_MS = 30000;
  const POLL_MS = 10000;
  let _pendingSince = 0;
  let _lastPending = 0;
  let _hideTimer = null;
  // A slow-link estimate alone is only trusted on a phone: Chrome on a desktop
  // or a VPN can report 2g / a high rtt and would keep the banner up idle.
  function _phone() {
    try { return !!(window.matchMedia && window.matchMedia('(pointer:coarse)').matches); } catch (_) { return false; }
  }
  function _weakLink() {
    try {
      const c = navigator.connection;
      if (!c || !_phone()) return false;
      if (c.effectiveType === 'slow-2g' || c.effectiveType === '2g') return true;
      return typeof c.rtt === 'number' && c.rtt >= 1500;
    } catch (_) { return false; }
  }
  function _pendingCount() {
    try {
      const S = window.NBDOfflineSync;
      const n = S && typeof S.pending === 'function' ? Number(S.pending()) : 0;
      return n > 0 ? n : 0;
    } catch (_) { return 0; }
  }
  // 'offline' | 'weak' | 'ok'
  function _state(now) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      _pendingSince = 0; _lastPending = 0;   // the clock starts again on reconnect
      return 'offline';
    }
    const n = _pendingCount();
    // The clock measures saves NOT moving: it restarts whenever the waiting
    // count drops (they are syncing), so a rep saving steadily on a good link
    // never sees "weak signal".
    if (n === 0) _pendingSince = 0;
    else if (!_pendingSince || n < _lastPending) _pendingSince = now;
    _lastPending = n;
    if (_weakLink() || (n > 0 && now - _pendingSince >= WEAK_AFTER_MS)) return 'weak';
    return 'ok';
  }
  function _message(state) {
    if (state === 'offline') return 'You\'re offline. Saves will queue and sync when you reconnect.';
    const n = _pendingCount();
    return n > 0
      ? 'Weak signal. ' + n + ' change' + (n === 1 ? ' is' : 's are') + ' saved on this phone and will sync when the signal improves.'
      : 'Weak signal. Saves may be slow; they are kept on this phone until they sync.';
  }

  function _render(state) {
    const existing = document.getElementById(BANNER_ID);
    if (existing) {
      // It may be fading out: keep it, and make it visible again.
      if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
      existing.style.opacity = '';
      existing.style.transform = '';
      const t = existing.querySelector('[data-ob-text]');
      if (t) t.textContent = _message(state);
      existing.setAttribute('data-state', state);
      return;
    }
    const banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.style.cssText =
      // z: --z-banner-status (dashboard-app.css :root; customer.html mirrors
      // it inline since it doesn't load that sheet). Deliberately ABOVE
      // --z-toast — this banner explains the save toasts, so it must not
      // rank below them, and it has to stay readable over an open modal.
      // Literal fallback kept so a page that somehow ships without the
      // token degrades to today's value instead of z-index:auto.
      'position:fixed;top:0;left:0;right:0;z-index:var(--z-banner-status,10006);' +
      'background:var(--gold);color:#1a1a1a;font:inherit;font-size:13px;' +
      'font-weight:600;padding:8px 14px;text-align:center;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.18);' +
      'padding-top:calc(8px + env(safe-area-inset-top, 0px));' +
      'padding-left:calc(14px + env(safe-area-inset-left, 0px));' +
      'padding-right:calc(14px + env(safe-area-inset-right, 0px));' +
      'animation:nbd-offline-in 220ms ease-out;';
    banner.setAttribute('data-state', state);
    banner.innerHTML =
      '<span style="font-size:14px;margin-right:6px;">📡</span><span data-ob-text></span>';
    banner.querySelector('[data-ob-text]').textContent = _message(state);
    document.body.appendChild(banner);
    if (!document.getElementById('nbd-offline-css')) {
      const css = document.createElement('style');
      css.id = 'nbd-offline-css';
      css.textContent =
        '@keyframes nbd-offline-in {' +
          'from { opacity:0; transform:translateY(-100%); }' +
          'to { opacity:1; transform:translateY(0); }' +
        '}';
      document.head.appendChild(css);
    }
  }
  function _hide() {
    const b = document.getElementById(BANNER_ID);
    if (!b || _hideTimer) return;
    b.style.transition = 'opacity 200ms ease, transform 200ms ease';
    b.style.opacity = '0';
    b.style.transform = 'translateY(-100%)';
    _hideTimer = setTimeout(() => { _hideTimer = null; try { b.remove(); } catch (_) {} }, 220);
  }

  function _check() {
    if (typeof navigator === 'undefined') return;
    if (typeof document !== 'undefined' && document.hidden) return;   // nothing to show a hidden tab
    const state = _state(Date.now());
    if (state === 'ok') _hide();
    else _render(state);
  }

  window.addEventListener('online', _check);
  window.addEventListener('offline', _check);
  try { if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', _check); } catch (_) {}
  setInterval(_check, POLL_MS);
  // Also recheck on focus — some browsers don't fire online/offline
  // reliably on bfcache restore.
  window.addEventListener('focus', _check);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _check, { once: true });
  } else {
    setTimeout(_check, 0);
  }

  const NBDOfflineBanner = {
    check: _check,
  };
})();
