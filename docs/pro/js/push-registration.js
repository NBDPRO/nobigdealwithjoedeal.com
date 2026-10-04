/**
 * push-registration.js — FCM Web Push token registration (client side).
 *
 * Background: the backend push pipeline (functions/push-functions.js —
 * onAppointmentReminder, onFollowUpDue, new-lead/claim/team/d2d) and the
 * messaging service worker (firebase-messaging-sw.js) were both fully built,
 * but NOTHING on the client ever registered a push token: no getToken(), no
 * users/{uid}/fcmTokens write, and the messaging SW was never registered. So
 * every push landed on ZERO recipients. This module closes that last gap:
 *   1. Registers /pro/firebase-messaging-sw.js on its own dedicated scope
 *      (SW_SCOPE below — NOT '/pro/', which sw.js owns).
 *   2. Mints an FCM token via getToken({ vapidKey }).
 *   3. Persists it to users/{uid}/fcmTokens/{sha256(token)} — the exact shape
 *      getUserFCMTokens() reads ({ token, lastActive }). The owner-write is
 *      permitted by the users/{uid}/{subcol} rule; since 2026-09-25 that
 *      rule's WRITE is an allowlist of names and fcmTokens is on it.
 *   4. Wires a foreground onMessage handler (toast while the tab is open).
 *
 * Config: the VAPID key lives in dashboard-fcm-config.js
 * (window.__NBD_VAPID_KEY). With no key the module no-ops with one console
 * hint, so this ships inert until the key is pasted.
 *
 * Permission UX: a page-load requestPermission() is auto-denied by modern
 * browsers and poisons the permission state, so we only request inside a USER
 * GESTURE — a one-time opt-in card, any [data-action="enable-notifications"]
 * control, or NBDPush.enable(). When permission is already granted we
 * silently refresh the token on load (FCM tokens rotate).
 *
 * Uses the modular Firebase globals dashboard-bootstrap.module.js exposes
 * (window._firebaseApp / db / setDoc / doc / serverTimestamp). The messaging
 * SDK isn't on window, so it's pulled in via a dynamic import() (allowed in a
 * classic script — same SDK version as the rest of the app).
 */
(function () {
  'use strict';

  var MESSAGING_SDK = '/assets/vendor/firebase/12.19.0/firebase-messaging.js';
  var SW_URL = '/pro/firebase-messaging-sw.js';
  // DEDICATED scope — NOT '/pro/'. The offline/PWA service worker (sw.js) owns
  // scope '/pro/' (dashboard-sw-bootstrap.js / offline-manager.js), and a scope
  // holds exactly ONE service worker: registering the messaging SW at '/pro/'
  // would CLOBBER sw.js (killing offline caching) or, the other way, drop
  // background pushes. FCM only needs the registration we hand to getToken — it
  // doesn't have to control any page — so we give it the canonical
  // firebase-cloud-messaging-push-scope under /pro/. Both SWs then coexist:
  // sw.js keeps /pro/, the messaging SW receives push on its own scope.
  var SW_SCOPE = '/pro/firebase-cloud-messaging-push-scope';
  var SNOOZE_KEY = 'nbd_push_optin_snoozed_until';
  var SNOOZE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  var _onMessageWired = false;
  var _busy = false;

  function vapidKey() { return (window.__NBD_VAPID_KEY || '').trim(); }

  function supported() {
    return ('serviceWorker' in navigator) &&
           ('PushManager' in window) &&
           ('Notification' in window);
  }

  function currentUid() {
    if (window._user && window._user.uid) return window._user.uid;
    if (window.auth && window.auth.currentUser) return window.auth.currentUser.uid;
    return null;
  }

  function ready() {
    return !!(window._firebaseApp && currentUid() &&
              typeof window.setDoc === 'function' &&
              typeof window.doc === 'function' &&
              window.db && typeof window.serverTimestamp === 'function');
  }

  // SHA-256 hex of the token → a stable doc id, so re-minting the SAME token
  // (every load) overwrites its row instead of piling up duplicates.
  function tokenDocId(token) {
    try {
      var enc = new TextEncoder().encode(token);
      return crypto.subtle.digest('SHA-256', enc).then(function (buf) {
        var bytes = new Uint8Array(buf), hex = '';
        for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
        return 'fcm_' + hex.slice(0, 32);
      });
    } catch (e) {
      // Fallback (no SubtleCrypto): last 32 url-safe chars; FCM tokens never
      // contain '/', so this is a valid, reasonably-unique Firestore id.
      return Promise.resolve('fcm_' + String(token).replace(/[^A-Za-z0-9_-]/g, '').slice(-32));
    }
  }

  async function persistToken(token) {
    var uid = currentUid();
    if (!uid) return;
    var id = await tokenDocId(token);
    await window.setDoc(
      window.doc(window.db, 'users', uid, 'fcmTokens', id),
      {
        token: token,
        platform: (navigator.platform || '').slice(0, 64),
        userAgent: (navigator.userAgent || '').slice(0, 200),
        lastActive: window.serverTimestamp(),
        updatedAt: window.serverTimestamp()
      },
      { merge: true }
    );
  }

  // Core: register SW → mint token → persist. opts.requestPermission gates the
  // permission prompt (true ONLY from a user gesture). Returns {ok, reason?}.
  async function registerAndMint(opts) {
    opts = opts || {};
    if (_busy) return { ok: false, reason: 'busy' };
    if (!supported()) return { ok: false, reason: 'unsupported' };
    if (!vapidKey()) {
      console.info('[push] VAPID key not set (dashboard-fcm-config.js → window.__NBD_VAPID_KEY) — push disabled.');
      return { ok: false, reason: 'no-vapid' };
    }
    if (!ready()) return { ok: false, reason: 'not-ready' };

    var perm = Notification.permission;
    if (perm === 'default' && opts.requestPermission) {
      try { perm = await Notification.requestPermission(); }
      catch (e) { perm = 'denied'; }
    }
    if (perm !== 'granted') return { ok: false, reason: perm };

    _busy = true;
    try {
      var reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
      var mod = await import(MESSAGING_SDK);
      var isSup = await mod.isSupported().catch(function () { return false; });
      if (!isSup) return { ok: false, reason: 'unsupported' };
      var messaging = mod.getMessaging(window._firebaseApp);
      var token = await mod.getToken(messaging, {
        vapidKey: vapidKey(),
        serviceWorkerRegistration: reg
      });
      if (!token) return { ok: false, reason: 'no-token' };
      await persistToken(token);

      if (!_onMessageWired) {
        _onMessageWired = true;
        mod.onMessage(messaging, function (payload) {
          var n = (payload && payload.notification) || {};
          var line = (n.title || 'NBD Pro') + (n.body ? ' — ' + n.body : '');
          if (typeof window.showToast === 'function') window.showToast(line.slice(0, 160), 'info');
        });
      }
      return { ok: true, token: token };
    } catch (e) {
      console.warn('[push] registration failed:', e && e.message);
      return { ok: false, reason: 'error', error: e && e.message };
    } finally {
      _busy = false;
    }
  }

  // ─── one-time opt-in card (only when permission is 'default') ──
  function snoozed() {
    try { return parseInt(localStorage.getItem(SNOOZE_KEY) || '0', 10) > Date.now(); }
    catch (e) { return false; }
  }
  function snooze() {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch (e) {}
  }

  function showOptInCard() {
    if (document.getElementById('nbd-push-optin')) return;
    if (Notification.permission !== 'default') return; // re-check at fire time
    var card = document.createElement('div');
    card.id = 'nbd-push-optin';
    card.setAttribute('role', 'dialog');
    card.style.cssText = [
      'position:fixed', 'right:16px', 'bottom:16px', 'z-index:9999',
      'max-width:320px', 'background:var(--nbd-surface,#fff)',
      'color:var(--nbd-text,#1a1a1a)', 'border:1px solid var(--nbd-border,#e2e2e2)',
      'border-radius:12px', 'box-shadow:0 8px 28px rgba(0,0,0,.18)',
      'padding:14px 16px', 'font-family:inherit', 'font-size:14px', 'line-height:1.4'
    ].join(';');
    // Anchor the card ABOVE the fixed bottom tab bar on phones. At
    // bottom:16px / z-index:9999 it sat directly on top of #mobile-nav
    // (z-index 1900) and, being ~320px wide on a ~390px viewport, silently
    // swallowed every tap on the nav — "buttons do nothing" until the card
    // was dismissed.
    try {
      var nav = document.getElementById('mobile-nav');
      if (nav) {
        var r = nav.getBoundingClientRect();
        if (r.height > 0 && getComputedStyle(nav).display !== 'none' && r.top < window.innerHeight) {
          card.style.bottom = (Math.round(window.innerHeight - r.top) + 12) + 'px';
        }
      }
    } catch (e) { /* keep the default offset */ }

    var title = document.createElement('div');
    title.style.cssText = 'font-weight:700;margin-bottom:4px;';
    title.textContent = '🔔 Turn on appointment reminders';
    var msg = document.createElement('div');
    msg.style.cssText = 'margin-bottom:10px;opacity:.85;';
    msg.textContent = 'Get a push before each job so you never miss an appointment.';
    var rowEl = document.createElement('div');
    rowEl.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';

    var no = document.createElement('button');
    no.type = 'button';
    no.textContent = 'Not now';
    // min-height:44px on both (2026-10-03): they measured 27px tall on an
    // iPhone — under the 44px floor every other phone control holds to.
    no.style.cssText = 'background:transparent;border:0;color:var(--nbd-muted,#666);cursor:pointer;padding:6px 12px;min-height:44px;';
    no.addEventListener('click', function () { snooze(); card.remove(); });

    var yes = document.createElement('button');
    yes.type = 'button';
    yes.textContent = 'Enable';
    yes.style.cssText = 'background:var(--nbd-accent,#e8511f);color:#fff;border:0;border-radius:8px;cursor:pointer;padding:6px 16px;font-weight:600;min-height:44px;';
    yes.addEventListener('click', function () {
      card.remove();
      registerAndMint({ requestPermission: true }).then(function (r) {
        if (typeof window.showToast !== 'function') return;
        if (r.ok) window.showToast('Reminders enabled', 'success');
        else if (r.reason === 'denied') window.showToast('Notifications blocked — enable them in your browser settings', 'error');
      });
    });

    rowEl.appendChild(no); rowEl.appendChild(yes);
    card.appendChild(title); card.appendChild(msg); card.appendChild(rowEl);
    document.body.appendChild(card);
    wireKeyboardYield(card);
  }

  // Stand aside while the rep is typing (2026-10-03). The card floats above
  // the bottom nav; with a phone keyboard up the screen is ~half height and
  // the card covered the very results a search had just narrowed to
  // (phone-pipeline.spec.js pipeline#7: the one match sat under it). Hidden
  // while a text field has focus, back when it loses it. Listeners remove
  // themselves once the card is gone.
  function isTextField(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    if (el.tagName !== 'INPUT') return false;
    return !/^(button|submit|reset|checkbox|radio|file|range|color|image|hidden)$/i.test(el.type || 'text');
  }
  function wireKeyboardYield(card) {
    function sync() {
      if (!card.isConnected) {
        document.removeEventListener('focusin', sync, true);
        document.removeEventListener('focusout', later, true);
        return;
      }
      card.style.display = isTextField(document.activeElement) ? 'none' : '';
    }
    function later() { setTimeout(sync, 0); }
    document.addEventListener('focusin', sync, true);
    document.addEventListener('focusout', later, true);
    sync();
  }

  // ─── boot ──────────────────────────────────────────────────────
  function boot() {
    if (!supported() || !vapidKey()) return; // inert without support or key
    var perm = Notification.permission;
    if (perm === 'granted') {
      registerAndMint({ requestPermission: false }); // refresh existing opt-in
    } else if (perm === 'default' && !snoozed()) {
      setTimeout(showOptInCard, 4000); // defer past first paint
    }
  }

  function waitForReady(tries) {
    tries = tries || 0;
    if (ready()) { boot(); return; }
    if (tries > 60) return; // ~30s — user never authenticated
    setTimeout(function () { waitForReady(tries + 1); }, 500);
  }

  // Public API + the shared gesture convention (also honored by crm-snooze.js,
  // which requests browser permission + toasts; both are idempotent).
  const NBDPush = {
    enable: function () { return registerAndMint({ requestPermission: true }); },
    isSupported: supported,
    _registerAndMint: registerAndMint
  };
  window.addEventListener('click', function (e) {
    var el = e.target && e.target.closest && e.target.closest('[data-action="enable-notifications"]');
    if (el) registerAndMint({ requestPermission: true });
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { waitForReady(0); });
  } else {
    waitForReady(0);
  }
})();
