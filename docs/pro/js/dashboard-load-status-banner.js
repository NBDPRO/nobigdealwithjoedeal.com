/*
 * Load-status banner — compact corner-pill variant.
 *
 * Behaviors:
 *   1. Hidden by default while the page is loading normally.
 *   2. After ~6s grace, if leads haven't loaded, shows a small pill in
 *      the bottom-right corner with a single "Retry" button. Details
 *      (UA, error code, phase trail, hard-reset, gstatic test) hide
 *      behind a "?" icon so the rep doesn't see them unless they look.
 *   3. On success: silently disappears, no green flash.
 *   4. Auto-dismisses after 30s of being shown so it doesn't camp
 *      forever; user can tap the × at any time.
 *
 * Self-recovery globals stay on window so the user can fire them from
 * devtools if the on-page UI isn't reachable.
 */
let _bootStartedAt; // module-local (globals Tranche 1 — was window.*)
(function _loadStatusBanner() {
  const VERSION = 'v159.8';
  const FAIL_GRACE_MS = 6000;         // wait this long before assuming "stuck"
  const AUTO_DISMISS_MS = 30000;      // hide the banner after 30s of being shown
  let banner;
  let _detailsOpen = false;
  let _dismissedByUser = false;
  let _shownAt = null;

  // Self-recovery globals (also callable from devtools if banner is gone).
  window.__nbdHardReset = async function _nbdHardReset() {
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister().catch(() => {})));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
      }
    } catch (e) { /* non-fatal */ }
    const u = new URL(location.href);
    u.searchParams.set('nosw', '1');
    location.replace(u.toString());
  };
  window.__nbdGstaticTest = async function _nbdGstaticTest() {
    const btn = document.getElementById('nbd-ls-gstatic-btn');
    if (btn) btn.textContent = 'testing…';
    const url = '/assets/vendor/firebase/10.12.2/firebase-app.js';
    const t0 = Date.now();
    try {
      const res = await fetch(url, { cache: 'no-store', mode: 'cors' });
      const ms = Date.now() - t0;
      if (window.__nbdLoadErrors && window.__nbdLoadErrors.length < 8) {
        window.__nbdLoadErrors.push('gstatic ' + res.status + ' in ' + ms + 'ms');
      }
      if (btn) btn.textContent = 'gstatic: ' + res.status + ' (' + ms + 'ms)';
    } catch (e) {
      if (window.__nbdLoadErrors && window.__nbdLoadErrors.length < 8) {
        window.__nbdLoadErrors.push('gstatic FAIL: ' + (e && e.message || e));
      }
      if (btn) btn.textContent = 'gstatic BLOCKED';
    }
  };

  function _state() {
    const loaded = !!window._leadsLoaded;
    const count = (window._leads && window._leads.length) || 0;
    const err = window._loadLeadsLastError || null;
    const retry = (window._loadLeadsRetryAttempt || 0) + (window._loadLeadsSlowAttempt || 0);
    const exhausted = !!window._loadLeadsExhausted;
    // Kept (unused by the render gate now) purely as the honest name for
    // "loaded AND non-empty". Do NOT reintroduce it as the success condition —
    // that is the bug described below.
    const hasData = loaded && count > 0;
    const online = navigator.onLine;
    // loadedOk — the load COMPLETED without error. Distinct from hasData on
    // purpose: a tenant with zero leads has successfully loaded zero leads.
    //
    // This banner's success path used to test hasData (loaded && count > 0), so
    // a brand-new account — which by definition has no leads — never satisfied
    // it. Every single new signup got a persistent "Data not loaded" pill with a
    // Retry button on their very first dashboard, for the full 30s auto-dismiss
    // window, while _leadsLoaded was true and _loadLeadsLastError was null.
    // Nothing had failed; the account was simply empty. Retry could not help,
    // because there was nothing to fix.
    //
    // Invisible to anyone with data, which is why it survived: the owner's
    // account has always had leads, so count > 0 was always true for him.
    const loadedOk = loaded && !err;
    return { loaded, loadedOk, count, err, retry, exhausted, hasData, online };
  }

  function _ensureBanner() {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'nbd-load-status';
    // Bottom-right corner pill. Lower z-index than dialogs but above the
    // page chrome. On mobile we clear the 62px nav bar.
    const mobileBottom = (window.matchMedia && window.matchMedia('(max-width: 768px)').matches)
      ? 'calc(72px + env(safe-area-inset-bottom, 0px))'
      : 'calc(16px + env(safe-area-inset-bottom, 0px))';
    banner.style.cssText =
      'position:fixed;right:16px;bottom:' + mobileBottom + ';z-index:2147483646;' +
      'max-width:300px;background:#1a1a1a;color:#fff;' +
      'padding:10px 12px;border-radius:10px;' +
      'font:12px/1.3 -apple-system,system-ui,sans-serif;' +
      'box-shadow:0 6px 20px rgba(0,0,0,.45);' +
      'border:1px solid rgba(255,255,255,.15);border-left:3px solid #f80;' +
      'display:none;transition:opacity .2s,transform .2s;';
    banner.setAttribute('role', 'status');
    document.body.appendChild(banner);
    return banner;
  }

  function _retry() {
    if (typeof window.loadLeads !== 'function') return;
    window._loadLeadsSlowAttempt = 0;
    window._loadLeadsExhausted = false;
    window._loadLeadsNextRetryAt = null;
    if (banner) {
      const btn = banner.querySelector('.nbd-ls-retry');
      if (btn) { btn.textContent = '↻ Retrying…'; btn.disabled = true; }
    }
    window.loadLeads().catch(e => console.warn('user retry failed:', e.message));
  }

  function _dismiss() {
    _dismissedByUser = true;
    if (banner) {
      banner.style.opacity = '0';
      banner.style.transform = 'translateY(20px)';
      setTimeout(() => { if (banner) { banner.remove(); banner = null; } }, 250);
    }
  }

  // A full-screen overlay owns the screen while it's up. This banner is
  // pinned bottom-right at z-index max-int, so without this check it paints
  // over ANY of them. Caught by the occlusion sweep (2026-07-27): at 390x844
  // it sat exactly on the V2 builder's mobile step bar, blocking BOTH the
  // "② Items" step button and the live grand total — and the same corner is
  // where modal primary actions live. Suppress while an overlay is open; the
  // 1s render loop restores it the moment the overlay closes.
  function _overlayOpen() {
    try {
      return !!(
        document.querySelector('#estV2Modal.open') ||   // V2 estimate builder
        document.getElementById('nbd-ep-overlay') ||    // estimate preview sheet
        document.getElementById('v2Present') && document.getElementById('v2Present').classList.contains('open') ||
        document.querySelector('.modal-bg.open')        // every standard modal
      );
    } catch (e) { return false; }
  }

  function _render() {
    if (_dismissedByUser) return;
    // Overlay up → stay hidden, and hold the auto-dismiss clock so the
    // banner doesn't silently burn its 30s while invisible behind a modal.
    if (_overlayOpen()) {
      if (banner) banner.style.display = 'none';
      if (_shownAt) _shownAt = Date.now();
      return;
    }
    const s = _state();
    const ageMs = Date.now() - (_bootStartedAt || Date.now());

    // Success path: silently remove if we'd been showing.
    // Gated on loadedOk, NOT hasData — an empty account is a successful load,
    // and claiming otherwise is the difference between "you have no leads yet"
    // and "this product is broken" on someone's first ever screen.
    if (s.loadedOk) {
      if (banner) {
        banner.style.opacity = '0';
        banner.style.transform = 'translateY(20px)';
        setTimeout(() => { if (banner) { banner.remove(); banner = null; } }, 250);
      }
      return;
    }

    // Wait out the grace period unless we already have an explicit error.
    if (!s.err && ageMs < FAIL_GRACE_MS) {
      if (banner) banner.style.display = 'none';
      return;
    }

    // Auto-dismiss after 30s of being shown.
    if (_shownAt && Date.now() - _shownAt > AUTO_DISMISS_MS) {
      _dismiss();
      return;
    }

    const b = _ensureBanner();
    if (b.style.display !== 'block') {
      b.style.display = 'block';
      b.style.opacity = '1';
      b.style.transform = 'none';
      _shownAt = Date.now();
    }
    b.style.borderLeftColor = s.exhausted ? '#dc2626' : '#f80';

    const offlineNote = !s.online ? ' · offline' : '';
    const phases = (window.__nbdPhases || []).slice(-8).join(' › ');
    const firstErr = (window.__nbdLoadErrors && window.__nbdLoadErrors[0]) || null;
    const errCount = (window.__nbdLoadErrors && window.__nbdLoadErrors.length) || 0;

    const detailsHtml = _detailsOpen
      ? '<div style="font-size:10px;line-height:1.4;opacity:.7;margin-top:8px;padding-top:6px;border-top:1px solid rgba(255,255,255,.15);word-break:break-all;">' +
          VERSION + ' · retry: ' + s.retry + offlineNote +
          ' · auth: ' + (window._user ? 'yes' : 'no') +
          ' · db: ' + (window.db ? 'yes' : 'no') +
          (s.err ? '<br><span style="color:#fb6;">' + _esc(s.err.code || s.err.name || 'err') + '</span>: ' + _esc((s.err.message || '').slice(0, 120)) : '') +
          (phases ? '<br><span style="color:#9cf;">phase:</span> ' + _esc(phases) : '') +
          (firstErr ? '<br><span style="color:#fb6;">⚠ ' + _esc(firstErr) +
            (errCount > 1 ? ' <span style="opacity:.6;">(+' + (errCount - 1) + ')</span>' : '') + '</span>' : '') +
          '<div style="display:flex;gap:4px;margin-top:8px;">' +
            '<button data-action="call" data-fn="hardResetTest" ' +
              'style="background:#c33;border:none;color:#fff;border-radius:4px;padding:5px 8px;font-size:10px;font-weight:600;cursor:pointer;flex:1;">↻ Hard reset</button>' +
            '<button id="nbd-ls-gstatic-btn" data-action="call" data-fn="gstaticTest" ' +
              'style="background:#246;border:none;color:#fff;border-radius:4px;padding:5px 8px;font-size:10px;font-weight:600;cursor:pointer;flex:1;">Test fetch</button>' +
          '</div>' +
        '</div>'
      : '';

    b.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;">' +
        '<span class="nbd-ls-spin" style="display:inline-block;width:10px;height:10px;border:2px solid rgba(255,255,255,.25);border-top-color:#fff;border-radius:50%;animation:nbd-ls-spin 0.8s linear infinite;flex-shrink:0;"></span>' +
        '<span style="flex:1;font-weight:600;font-size:12px;">Data not loaded</span>' +
        '<button class="nbd-ls-retry" type="button" style="background:#f80;color:#fff;border:none;border-radius:5px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;">Retry</button>' +
        '<button class="nbd-ls-details-toggle" type="button" aria-label="Details" style="background:none;border:1px solid rgba(255,255,255,.3);color:#fff;border-radius:50%;width:22px;height:22px;font-size:11px;line-height:1;cursor:pointer;padding:0;">?</button>' +
        '<button class="nbd-ls-close" type="button" aria-label="Dismiss" style="background:none;border:none;color:rgba(255,255,255,.7);font-size:18px;line-height:1;cursor:pointer;padding:0 2px;">×</button>' +
      '</div>' +
      detailsHtml;

    const retryBtn = b.querySelector('.nbd-ls-retry');
    if (retryBtn) retryBtn.addEventListener('click', (e) => { e.stopPropagation(); _retry(); });
    const detailsBtn = b.querySelector('.nbd-ls-details-toggle');
    if (detailsBtn) detailsBtn.addEventListener('click', (e) => { e.stopPropagation(); _detailsOpen = !_detailsOpen; _render(); });
    const closeBtn = b.querySelector('.nbd-ls-close');
    if (closeBtn) closeBtn.addEventListener('click', (e) => { e.stopPropagation(); _dismiss(); });
  }

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  const _styleEl = document.createElement('style');
  _styleEl.textContent = '@keyframes nbd-ls-spin{to{transform:rotate(360deg);}}';
  document.head.appendChild(_styleEl);

  function _start() {
    if (!_bootStartedAt) _bootStartedAt = Date.now();
    setTimeout(_render, FAIL_GRACE_MS);
    setInterval(_render, 1000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _start, { once: true });
  } else {
    _start();
  }
})();
