/**
 * standalone-compat.js — Safari "Add to Home Screen" compatibility layer
 *
 * Fixes:
 *  1. alert() — turned into a non-blocking toast (see the note by the override)
 *  2. window.open() — exits to Safari, breaking the app experience
 *  3. 100vh — doesn't account for status bar in standalone
 *  4. Scroll/keyboard issues on iOS
 *  5. nbdAlert / nbdConfirm / nbdPrompt — real promise-based modals, which is
 *     what call sites should use for anything that decides something
 *
 * CORRECTED 2026-09-03: this header used to read "alert() / confirm() /
 * prompt() — blocked in iOS standalone mode". That premise is not true and
 * appears never to have been — WebKit has no standalone gate on dialogs. The
 * confirm() and prompt() overrides written against it answered on the user's
 * behalf and have been removed; the full argument is at the override site
 * below. Do not reintroduce them without new evidence.
 *
 * Load EARLY — before any other scripts that might call alert.
 */
let nbdAlert; // module-local (globals Tranche 1 — was window.*)
(function() {
  'use strict';

  const isStandalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;

  // Expose for other modules to check
  window._isStandalone = isStandalone;

  if (!isStandalone) return; // Only patch in standalone mode

  // =========================================================================
  // 1. MODAL-BASED alert / confirm / prompt REPLACEMENTS
  // =========================================================================

  // Inject modal styles once
  const style = document.createElement('style');
  style.textContent = `
    .sa-overlay{position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,.55);z-index:999999;display:flex;align-items:center;justify-content:center;padding:20px;-webkit-backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);animation:sa-fade-in .15s ease;}
    @keyframes sa-fade-in{from{opacity:0}to{opacity:1}}
    .sa-box{background:var(--s2,#1c1c1e);border:1px solid var(--br,rgba(255,255,255,.1));border-radius:14px;padding:22px;max-width:320px;width:100%;color:var(--t,#fff);font-family:-apple-system,BlinkMacSystemFont,'Barlow',sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.5);animation:sa-pop .2s ease;}
    @keyframes sa-pop{from{transform:scale(.92);opacity:0}to{transform:scale(1);opacity:1}}
    .sa-title{font-size:17px;font-weight:600;margin-bottom:8px;line-height:1.3;}
    .sa-msg{font-size:14px;color:var(--m,#aaa);line-height:1.5;margin-bottom:16px;white-space:pre-wrap;word-break:break-word;}
    .sa-input{width:100%;padding:10px 12px;border:1px solid var(--br,rgba(255,255,255,.15));border-radius:8px;background:var(--s,#111);color:var(--t,#fff);font-size:15px;margin-bottom:14px;-webkit-appearance:none;outline:none;}
    .sa-input:focus{border-color:var(--orange,#BD5728);}
    .sa-btns{display:flex;gap:10px;justify-content:flex-end;}
    .sa-btn{padding:10px 20px;border:none;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;min-height:44px;}
    .sa-btn-cancel{background:var(--s,#333);color:var(--m,#aaa);}
    .sa-btn-ok{background:var(--orange,#BD5728);color:#fff;}
  `;
  document.head.appendChild(style);

  function createModal(msg, { type = 'alert', defaultVal = '' } = {}) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'sa-overlay';

      const box = document.createElement('div');
      box.className = 'sa-box';

      // Title
      const title = document.createElement('div');
      title.className = 'sa-title';
      title.textContent = type === 'confirm' ? 'Confirm' : type === 'prompt' ? 'Input' : 'NBD Pro';
      box.appendChild(title);

      // Message
      const msgEl = document.createElement('div');
      msgEl.className = 'sa-msg';
      msgEl.textContent = msg || '';
      box.appendChild(msgEl);

      // Input for prompt
      let input;
      if (type === 'prompt') {
        input = document.createElement('input');
        input.className = 'sa-input';
        input.type = 'text';
        input.value = defaultVal || '';
        box.appendChild(input);
      }

      // Buttons
      const btns = document.createElement('div');
      btns.className = 'sa-btns';

      function close(val) {
        overlay.remove();
        resolve(val);
      }

      if (type === 'confirm' || type === 'prompt') {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'sa-btn sa-btn-cancel';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => close(type === 'confirm' ? false : null));
        cancelBtn.addEventListener('touchend', (e) => { e.preventDefault(); close(type === 'confirm' ? false : null); });
        btns.appendChild(cancelBtn);
      }

      const okBtn = document.createElement('button');
      okBtn.className = 'sa-btn sa-btn-ok';
      okBtn.textContent = 'OK';
      okBtn.addEventListener('click', () => {
        if (type === 'prompt') close(input.value);
        else if (type === 'confirm') close(true);
        else close(undefined);
      });
      okBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        if (type === 'prompt') close(input.value);
        else if (type === 'confirm') close(true);
        else close(undefined);
      });
      btns.appendChild(okBtn);

      box.appendChild(btns);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      // Focus input or OK button
      setTimeout(() => { (input || okBtn).focus(); }, 100);

      // ESC to cancel
      function onKey(e) {
        if (e.key === 'Escape') {
          document.removeEventListener('keydown', onKey);
          close(type === 'confirm' ? false : type === 'prompt' ? null : undefined);
        } else if (e.key === 'Enter') {
          document.removeEventListener('keydown', onKey);
          if (type === 'prompt') close(input.value);
          else if (type === 'confirm') close(true);
          else close(undefined);
        }
      }
      document.addEventListener('keydown', onKey);
    });
  }

  // ── confirm() and prompt() are NO LONGER OVERRIDDEN (2026-09-03) ──
  //
  // This file used to replace window.confirm with a stub that toasted the
  // message and unconditionally `return true`, and window.prompt with one that
  // returned the default value without ever showing a box. Both answered on
  // the user's behalf. Both are gone. The reasoning, because the original was
  // written down confidently and was wrong:
  //
  // THE STATED PREMISE WAS NEVER TRUE. The header claimed dialogs are "blocked
  // in iOS standalone mode". No such rule exists in WebKit. Source/WebCore/
  // page/LocalDOMWindow.cpp gates alert/confirm/prompt on exactly four things
  // — no frame, an iframe sandboxed without allow-modals, no page, and page
  // dismissal — and none of them is display-mode, navigator.standalone, or
  // "web clip". bugs.webkit.org carries ~28 open "Home Screen" bugs filed
  // through 2026 and not one is about dialogs. Apple has run a dedicated
  // "Home Screen Web Apps" release-note section since Safari 16.4 documenting
  // exactly this class of standalone-only defect (Wake Lock 18.4, camera
  // re-prompt 17.2, audio-on-reopen 26.2) and has never listed a dialog one.
  //
  // The comment on the old confirm stub gave the real reason away: "it's used
  // synchronously in if-statements. We CANNOT make it async without rewriting
  // call sites." That is an async/sync mismatch with this file's own
  // promise-based modal, not a platform limitation — and _origConfirm was
  // captured here and never called, which nobody does to a function they
  // believe is dead.
  //
  // AND `true` IS THE ONE VALUE THE PLATFORM CANNOT PRODUCE. Every suppression
  // path at every layer resolves confirm to FALSE: the sandbox and unload
  // branches above, WKWebView's APIUIClient defaults when a host does not
  // implement the dialog delegate, a backgrounded tab, the browser's
  // suppress-further-dialogs UI, and the still-unfixed pushState+back bug
  // (turbolinks#336, 2017 → Apple Forums 684407, still live 2025). Native
  // confirm fails CLOSED — the guard cancels. The stub inverted that into
  // fail-OPEN. It did not defend against the destructive-action problem; it
  // WAS the destructive-action problem, and it is what emailed a photo report
  // to a homeowner and wiped the product library on a mis-tap.
  //
  // prompt() had the same shape with a quieter failure: returning defaultVal
  // meant "Copy this link" boxes never appeared (clipboard-fix.js,
  // dashboard-api.js, customer-bootstrap.module.js) and
  // `prompt('Rename estimate:', current)` returned the current name, so rename
  // silently did nothing (estimate-crm-ops.js).
  //
  // NOTE the gate at the top of this file is `navigator.standalone === true ||
  // matchMedia('(display-mode: standalone)').matches` — so this was also
  // firing on installed Android and desktop PWAs, where nobody has ever
  // claimed a dialog bug at all.
  //
  // alert() IS still overridden, deliberately — see below.
  //
  // Destructive guards should not depend on native confirm regardless: it is a
  // blocking API the engine may resolve to false on any of the paths above.
  // Use window.nbdConfirm (defined below), which is a real DOM modal and
  // immune to all of them. tests/pwa-confirm-guard.test.js holds the line.

  // alert() stays patched. It has no return value, so it cannot answer
  // anything on the user's behalf — the failure mode the two above had is
  // structurally impossible here. Turning a blocking OS dialog into a toast is
  // a deliberate improvement on a phone, and if a suppression path ever does
  // fire, a toast still shows the message where a native alert would show
  // nothing. Removing it would be a UX regression, not a fix.
  window.alert = function(msg) {
    // Use showToast if available for simple alerts (non-blocking)
    if (window.showToast) {
      window.showToast(String(msg).replace(/^[✅⚠️✓]/u, '').trim(), 'info');
      return;
    }
    createModal(msg, { type: 'alert' });
  };

  // Also provide async versions for code that CAN use them
  nbdAlert = function(msg) {
    return createModal(msg, { type: 'alert' });
  };
  window.nbdConfirm = function(msg) {
    return createModal(msg, { type: 'confirm' });
  };
  window.nbdPrompt = function(msg, defaultVal) {
    return createModal(msg, { type: 'prompt', defaultVal: defaultVal || '' });
  };

  // =========================================================================
  // 2. window.open() PATCH — stay in the web app
  // =========================================================================

  const _origOpen = window.open;

  window.open = function(url, target, features) {
    // If it's a data URL or blob (document generation), use original
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) {
      return _origOpen.call(window, url, target, features);
    }

    // For tel:, mailto:, sms: links — use original (system handles these)
    if (/^(tel:|mailto:|sms:)/.test(url)) {
      return _origOpen.call(window, url, target, features);
    }

    // For same-origin URLs, navigate in-place instead of opening new tab
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin === window.location.origin) {
        // Same origin — navigate to it
        window.location.href = parsed.href;
        return window;
      }
    } catch (e) {
      // Relative URL — navigate in place
      if (!url.startsWith('http')) {
        window.location.href = url;
        return window;
      }
    }

    // External URLs — open in Safari (no way around this in standalone)
    return _origOpen.call(window, url, target, features);
  };

  // =========================================================================
  // 3. VIEWPORT HEIGHT FIX — set CSS custom property for real viewport height
  // =========================================================================

  function setVH() {
    const vh = window.innerHeight * 0.01;
    document.documentElement.style.setProperty('--svh', vh + 'px');
  }
  setVH();
  window.addEventListener('resize', setVH);
  // iOS fires orientationchange before resize sometimes
  window.addEventListener('orientationchange', () => setTimeout(setVH, 200));

  // =========================================================================
  // 4. KEYBOARD / SCROLL FIXES
  // =========================================================================

  // When virtual keyboard opens, iOS shifts the viewport. Fix it.
  if ('visualViewport' in window) {
    window.visualViewport.addEventListener('resize', function() {
      // Scroll active input into view if keyboard pushed it off screen
      const active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
        setTimeout(() => {
          active.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 100);
      }
    });
  }

  // Prevent overscroll / bounce on the body (allows scroll inside content areas)
  document.addEventListener('touchmove', function(e) {
    // Allow scrolling inside scrollable containers
    let el = e.target;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      if (style.overflowY === 'auto' || style.overflowY === 'scroll' ||
          style.overflow === 'auto' || style.overflow === 'scroll') {
        // This element is scrollable — allow the touch
        return;
      }
      // Leaflet map container — always allow touch
      if (el.classList.contains('leaflet-container')) return;
      el = el.parentElement;
    }
    // If we got here, nothing is scrollable — prevent bounce
    if (e.touches.length === 1) {
      // Only prevent single-finger (scroll), not pinch-zoom
      // Actually, don't prevent on the main content area
      const main = document.querySelector('.content, .view-scroll, .app-body');
      if (main && main.contains(e.target)) return;
    }
  }, { passive: true });

  // =========================================================================
  // 5. SAFE AREA PADDING — for notched iPhones
  // =========================================================================
  // The top inset is reserved ONCE. A page whose own header already pads for
  // it (dashboard.html, customer.html: <html data-safe-top="header">) must not
  // get a body padding as well, or the installed app shows a second, empty
  // black band under the status bar (Joe's phone, 2026-10-15). Pages with no
  // such header (login, register, onboarding, analytics, ask-joe) keep it.
  const headerOwnsTop = document.documentElement.getAttribute('data-safe-top') === 'header';
  const safeStyle = document.createElement('style');
  safeStyle.textContent = `
    @supports(padding-top: env(safe-area-inset-top)){
      ${headerOwnsTop ? '' : 'body{ padding-top: env(safe-area-inset-top); }'}
      .mn{ padding-bottom: env(safe-area-inset-bottom); }
    }
  `;
  document.head.appendChild(safeStyle);

  // =========================================================================
  // 6. LINK INTERCEPTION — keep <a> clicks inside the web app
  // =========================================================================
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;

    // Skip anchors, javascript:, tel:, mailto:, sms:, blob:, data:, and any
    // anchor carrying a download attribute. blob:/data: URLs are always a
    // file the app just generated (CSV/backup exports — data-export.js
    // creates a Blob, sets a[download], appends it, and calls .click()) —
    // new URL('blob:https://<origin>/<uuid>', location.origin).origin
    // equals location.origin, so before this fix these matched NO prefix
    // above, fell through to the same-origin branch, and got
    // preventDefault() + location.href'd instead of downloaded: the export
    // silently vanished into a navigation to the blob URL. Standalone-PWA
    // only (this whole listener is gated on isStandalone above), so this
    // never affected the site in a normal browser tab.
    if (href.startsWith('#') || href.startsWith('javascript:') ||
        href.startsWith('tel:') || href.startsWith('mailto:') || href.startsWith('sms:') ||
        href.startsWith('blob:') || href.startsWith('data:') || a.hasAttribute('download')) {
      return;
    }

    // Same-origin links — navigate in-app
    try {
      const url = new URL(href, window.location.origin);
      if (url.origin === window.location.origin) {
        e.preventDefault();
        window.location.href = url.href;
      }
    } catch (err) {
      // Relative URL
      e.preventDefault();
      window.location.href = href;
    }
  }, true);

  console.log('[standalone-compat] Safari standalone patches active');
})();
