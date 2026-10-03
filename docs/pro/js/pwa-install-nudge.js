/**
 * pwa-install-nudge.js — Wave 20 (PWA Install Nudge)
 *
 * Reps benefit massively from running NBD Pro as an installed app:
 * full-screen layout (no Safari chrome eating screen estate during
 * D2D), home-screen icon, faster cold start, no chance of accidental
 * tab close during a knock. But:
 *   - iOS Safari NEVER fires beforeinstallprompt; users can install
 *     only via Share → "Add to Home Screen" — discoverable only if
 *     the rep already knows the gesture.
 *   - Android Chrome fires beforeinstallprompt but auto-suppresses
 *     it after a few visits, leaving the install affordance buried
 *     in the 3-dot menu.
 *
 * This module:
 *   1. Detects whether the app is already installed (display-mode
 *      standalone or navigator.standalone). Never nudges installed
 *      users.
 *   2. Captures Android Chrome's beforeinstallprompt event so we can
 *      trigger the native dialog on demand.
 *   3. Tracks session count in localStorage; only nudges from the 3rd
 *      session onward (prevents annoying first-day users).
 *   4. On dashboard.html only.
 *   5. Bottom banner with two actions:
 *        - "Install" (Android: native prompt) / "How?" (iOS: modal
 *          with step-by-step Share-button instructions)
 *        - "Not now" (snoozes 7 days)
 *      Plus a × dismiss that hides forever (until storage cleared).
 *   6. iOS-aware: detects iOS Safari via UA + non-standalone +
 *      Apple touch device, shows the share-icon walkthrough.
 *
 * No exposed API beyond debug helpers.
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['pwa-install-nudge']) return;
  __NBD_LOADED['pwa-install-nudge'] = true;

  // Only nudge on rep-side surfaces (dashboard + customer detail); the
  // homeowner portal etc. should not promote "install our app" to non-rep
  // users. Hosting has cleanUrls:true, so match both URL forms — the old
  // regex only matched /pro/dashboard.html, so this module silently never
  // ran on the clean URL reps actually land on and the (since-retired) W150
  // pwa-install.js banner showed instead. This module is the single
  // install-prompt system as of 2026-07-05 — W150 pwa-install.js is deleted.
  const PATH = window.location.pathname || '';
  if (!/\/pro\/(dashboard|customer)(\.html)?$/.test(PATH)) return;

  const STORAGE_KEY_SESSIONS  = 'nbd_pwa_sessions';
  const STORAGE_KEY_DISMISSED = 'nbd_pwa_dismissed_v1';
  const STORAGE_KEY_SNOOZE    = 'nbd_pwa_snooze_until';
  const SHOW_AFTER_SESSIONS   = 3;
  const SNOOZE_DAYS           = 7;

  // ─── Platform detection ──────────────────────────────────────────
  function isStandalone() {
    try {
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (e) {}
    if (window.navigator && window.navigator.standalone === true) return true;
    return false;
  }

  function isIOS() {
    const ua = window.navigator.userAgent || '';
    if (/iP(ad|hone|od)/.test(ua)) return true;
    // iPadOS reports "MacIntel" with touch points — common detection trick.
    if (window.navigator.platform === 'MacIntel'
        && typeof window.navigator.maxTouchPoints === 'number'
        && window.navigator.maxTouchPoints > 1) return true;
    return false;
  }

  function isIOSSafari() {
    if (!isIOS()) return false;
    const ua = window.navigator.userAgent || '';
    // Filter out Chrome/Firefox/Edge on iOS (which all use WebKit but
    // don't expose Add to Home Screen the same way).
    if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua)) return false;
    return /Safari/.test(ua);
  }

  // ─── Session tracking ────────────────────────────────────────────
  function bumpSessionCount() {
    try {
      // Bump at most once per browser session.
      if (sessionStorage.getItem('nbd_pwa_session_counted') === '1') {
        return Number(localStorage.getItem(STORAGE_KEY_SESSIONS) || 0);
      }
      sessionStorage.setItem('nbd_pwa_session_counted', '1');
      const cur = Number(localStorage.getItem(STORAGE_KEY_SESSIONS) || 0);
      const next = cur + 1;
      localStorage.setItem(STORAGE_KEY_SESSIONS, String(next));
      return next;
    } catch (e) { return 0; }
  }

  function isDismissedForever() {
    try {
      if (localStorage.getItem(STORAGE_KEY_DISMISSED) === '1') return true;
      // Cross-honor the W150 pwa-install.js state (still live on
      // customer.html, and previously double-mounted on the dashboard —
      // dismissing one banner immediately surfaced the other because each
      // system only read its own flag). installedAt is permanent; a
      // dismissedAt there is its 7-day "not now", treated below as a snooze.
      const legacy = JSON.parse(localStorage.getItem('nbd_pwa_install_state_v1') || '{}');
      if (legacy.installedAt) return true;
    } catch (e) { /* fall through */ }
    return false;
  }
  function dismissForever() {
    try { localStorage.setItem(STORAGE_KEY_DISMISSED, '1'); } catch (e) {}
  }

  function isSnoozed() {
    try {
      const until = Number(localStorage.getItem(STORAGE_KEY_SNOOZE) || 0);
      if (until > Date.now()) return true;
      // W150 pwa-install.js "Not now" = dismissedAt + 7 days — honor it.
      const legacy = JSON.parse(localStorage.getItem('nbd_pwa_install_state_v1') || '{}');
      if (legacy.dismissedAt && Date.now() - legacy.dismissedAt < 7 * 86400000) return true;
    } catch (e) { /* fall through */ }
    return false;
  }
  function snooze() {
    try {
      localStorage.setItem(STORAGE_KEY_SNOOZE, String(Date.now() + SNOOZE_DAYS * 86400000));
    } catch (e) {}
  }

  // ─── beforeinstallprompt capture (Android Chrome) ───────────────
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (ev) => {
    // Hold onto the event so we can fire the native dialog from a
    // user gesture later. Default behavior on Chrome would auto-show
    // the mini-infobar; preventing the default keeps our UI tidy.
    ev.preventDefault();
    deferredPrompt = ev;
  });

  // ─── Banner UI ──────────────────────────────────────────────────
  function buildBanner() {
    // Both install systems share this element id (fab-stack-coordinator keys
    // on it). If one is already mounted, never stack a second banner.
    if (document.getElementById('nbd-pwa-install-banner')) return null;
    const banner = document.createElement('div');
    banner.id = 'nbd-pwa-install-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Install NBD Pro');
    // Theme-tokenized (batch-4): hex fallbacks preserve the original dark look
    // where the token set is absent; z-index moves onto the --z-* scale.
    banner.style.cssText = `
      position:fixed; left:50%; transform:translateX(-50%) translateY(100%);
      bottom:14px; z-index:var(--z-overlay, 99990);
      background:linear-gradient(135deg,var(--s2,#1f2937) 0%,var(--s,#111827) 100%);
      color:var(--t,#fff); border:1px solid var(--br,rgba(255,255,255,0.08));
      border-radius:14px; padding:14px 16px;
      box-shadow:0 8px 28px rgba(0,0,0,0.4);
      max-width:min(420px, calc(100vw - 28px));
      width:100%; box-sizing:border-box;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;
      transition:transform .35s cubic-bezier(0.16, 1, 0.3, 1);
      display:flex; gap:12px; align-items:center;`;
    banner.innerHTML = `
      <div class="pwx-fs26px-fle0">📱</div>
      <div class="pwx-fx1-minw0">
        <div class="pwx-fs13px-w700-mb2px">Install NBD Pro</div>
        <div class="pwx-fs11px-cm-lh14">
          Faster cold start, full-screen layout, home-screen icon. No app store needed.
        </div>
      </div>
      <div class="pwx-dflex-flecolumn-gap6px">
        <button id="nbd-pwa-install-action" class="pwx-bglineargr-caccentfg-bdnone">Install</button>
        <button id="nbd-pwa-install-later" class="pwx-bgtranspar-cm-bd1pxsolid">Not now</button>
      </div>
      <button id="nbd-pwa-install-x" aria-label="Dismiss"
        class="pwx-posabsolute-top6px-rig8px">×</button>`;
    // Anchor the banner ABOVE any fixed bottom bar. At bottom:14px /
    // z-index:99990 the ~420px-wide banner sat directly on top of
    // #mobile-nav (dashboard tab bar, z 1900) on phone viewports and
    // silently swallowed every tap on the nav until dismissed — "buttons
    // do nothing". customer.html has #nbd-quick-action-bar instead; clear
    // whichever visible bar reaches highest.
    try {
      let barTop = window.innerHeight;
      ['mobile-nav', 'nbd-quick-action-bar'].forEach((id) => {
        const bar = document.getElementById(id);
        if (!bar) return;
        const r = bar.getBoundingClientRect();
        if (r.height > 0 && getComputedStyle(bar).display !== 'none' && r.top < window.innerHeight) {
          barTop = Math.min(barTop, r.top);
        }
      });
      if (barTop < window.innerHeight) {
        banner.style.bottom = (Math.round(window.innerHeight - barTop) + 12) + 'px';
      }
    } catch (e) { /* keep the default offset */ }
    document.body.appendChild(banner);
    requestAnimationFrame(() => {
      banner.style.transform = 'translateX(-50%) translateY(0)';
    });
    return banner;
  }

  function hideBanner(banner) {
    if (!banner) return;
    banner.style.transform = 'translateX(-50%) translateY(120%)';
    setTimeout(() => banner.remove(), 350);
  }

  // ─── iOS instructions modal ─────────────────────────────────────
  function showIOSInstructionsModal() {
    if (document.getElementById('nbd-pwa-ios-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'nbd-pwa-ios-modal';
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:var(--z-overlay-top, 99995);
      display:flex; align-items:center; justify-content:center; padding:20px;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;`;
    overlay.innerHTML = `
      <div class="pwx-bgffffff-c1f2937-r14px">
        <div class="pwx-dflex-aicenter-gap10px">
          <div class="pwx-fs24px">📱</div>
          <h2 class="pwx-fs17px-m0-c111827">Add to Home Screen</h2>
        </div>
        <ol class="pwx-pad22px-m0014px-lh17">
          <li>Tap the <strong>Share</strong> button at the bottom of Safari
            <span class="pwx-dinlinebl-vermiddle-ml4px">
              <svg width="16" height="20" viewBox="0 0 16 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="pwx-c6366f1"><path d="M8 2v12"/><path d="M5 5l3-3 3 3"/><rect x="2" y="9" width="12" height="9" rx="1.5"/></svg>
            </span>
          </li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong></li>
          <li>Tap <strong>Add</strong> in the top-right corner</li>
        </ol>
        <div class="pwx-bgf9fafb-r8px-p10px12px">
          You'll see the NBD Pro icon on your home screen. Tap it any time — opens full-screen, no Safari address bar.
        </div>
        <button id="nbd-pwa-ios-close" class="pwx-wd100-bglineargr-cfff">
          Got it
        </button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#nbd-pwa-ios-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ─── Android fallback instructions ──────────────────────────────
  function showAndroidFallbackModal() {
    if (document.getElementById('nbd-pwa-and-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'nbd-pwa-and-modal';
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:var(--z-overlay-top, 99995);
      display:flex; align-items:center; justify-content:center; padding:20px;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;`;
    overlay.innerHTML = `
      <div class="pwx-bgffffff-c1f2937-r14px-2">
        <div class="pwx-dflex-aicenter-gap10px">
          <div class="pwx-fs24px">📱</div>
          <h2 class="pwx-fs17px-m0-c111827">Install NBD Pro</h2>
        </div>
        <ol class="pwx-pad22px-m0014px-lh17">
          <li>Tap the <strong>⋮</strong> menu (top-right of Chrome)</li>
          <li>Tap <strong>Install app</strong> or <strong>Add to Home screen</strong></li>
          <li>Confirm <strong>Install</strong></li>
        </ol>
        <button id="nbd-pwa-and-close" class="pwx-wd100-bglineargr-cfff">
          Got it
        </button>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#nbd-pwa-and-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  }

  // ─── Decide + show ──────────────────────────────────────────────
  let _shown = false;
  function maybeShow() {
    if (_shown) return;
    if (isStandalone()) return;          // already installed
    if (isDismissedForever()) return;
    if (isSnoozed()) return;

    const sessions = bumpSessionCount();
    if (sessions < SHOW_AFTER_SESSIONS) return;

    // Wait until the page settles so the banner doesn't compete with
    // initial render / sub-loaders.
    setTimeout(() => {
      if (_shown || isStandalone()) return;
      _shown = true;
      const banner = buildBanner();
      if (!banner) return; // another install banner already mounted
      const installBtn = banner.querySelector('#nbd-pwa-install-action');
      const laterBtn   = banner.querySelector('#nbd-pwa-install-later');
      const xBtn       = banner.querySelector('#nbd-pwa-install-x');

      // On iOS, the action is a "How?" since we can't trigger an
      // install programmatically. On Android, fire the captured
      // beforeinstallprompt if we have it; otherwise fall back to
      // instructions. Re-label accordingly.
      if (isIOSSafari()) {
        installBtn.textContent = 'How?';
      } else if (deferredPrompt) {
        installBtn.textContent = 'Install';
      } else {
        installBtn.textContent = 'How?';
      }

      installBtn.addEventListener('click', async () => {
        if (isIOSSafari()) {
          showIOSInstructionsModal();
          hideBanner(banner);
          return;
        }
        if (deferredPrompt && typeof deferredPrompt.prompt === 'function') {
          try {
            deferredPrompt.prompt();
            const choice = await deferredPrompt.userChoice;
            if (choice && choice.outcome === 'accepted') {
              dismissForever();
            } else {
              snooze();
            }
            deferredPrompt = null;
            hideBanner(banner);
            return;
          } catch (e) {
            console.warn('[PWAInstall] prompt error', e);
          }
        }
        // Fallback for Android without the deferred prompt.
        showAndroidFallbackModal();
        hideBanner(banner);
      });

      laterBtn.addEventListener('click', () => {
        snooze();
        hideBanner(banner);
      });
      xBtn.addEventListener('click', () => {
        dismissForever();
        hideBanner(banner);
      });

      // Treat successful install (Android Chrome fires this) as a
      // permanent dismiss so we don't keep nagging users who later
      // open the dashboard in a browser tab.
      window.addEventListener('appinstalled', () => {
        dismissForever();
        hideBanner(banner);
      }, { once: true });
    }, 2500);
  }

  // ─── Init ────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', maybeShow);
  } else {
    maybeShow();
  }

  // Debug helpers exposed for support / QA — clearable via console.
  const PWAInstallNudge = {
    isStandalone,
    isIOSSafari,
    reset() {
      try {
        localStorage.removeItem(STORAGE_KEY_SESSIONS);
        localStorage.removeItem(STORAGE_KEY_DISMISSED);
        localStorage.removeItem(STORAGE_KEY_SNOOZE);
        sessionStorage.removeItem('nbd_pwa_session_counted');
        console.log('[PWAInstall] state reset');
      } catch (e) {}
    },
    forceShow() {
      _shown = false;
      try {
        localStorage.removeItem(STORAGE_KEY_DISMISSED);
        localStorage.removeItem(STORAGE_KEY_SNOOZE);
        localStorage.setItem(STORAGE_KEY_SESSIONS, String(SHOW_AFTER_SESSIONS));
        sessionStorage.removeItem('nbd_pwa_session_counted');
      } catch (e) {}
      maybeShow();
    },
  };
})();
