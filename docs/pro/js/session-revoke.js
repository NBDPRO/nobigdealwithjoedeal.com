/**
 * session-revoke.js — the "Sign Out Everywhere" button's real behaviour.
 *
 * WHAT WAS WRONG (2026-09-08 claims audit)
 * ────────────────────────────────────────
 * Settings → Security shipped a red "Sign Out Everywhere" button wired to
 * data-action="signOut" → window._signOut(), whose entire body is a
 * localStorage sweep plus signOut(auth). That is a purely LOCAL sign-out: it
 * clears THIS browser's persistence and nothing else. An attacker holding a
 * session on another device kept refreshing it indefinitely, and
 * /pro/how-to.html told users to rely on exactly that button after a
 * suspected password compromise.
 *
 * WHY THIS IS A SEPARATE ACTION, NOT A FIX TO _signOut
 * ───────────────────────────────────────────────────
 * data-action="signOut" is on THREE buttons in dashboard.html: the header
 * "Sign Out →" (:378), Danger Zone's plain "Sign Out" (:3138), and the
 * Security panel's "Sign Out Everywhere" (:4113). Teaching _signOut to
 * revoke would silently make every ordinary sign-out nuke the user's phone
 * and tablet too — a much worse bug than the one being fixed. So the
 * everywhere button gets its own dispatch, and _signOut stays local.
 *
 * Registered in __NBD_CALL_REGISTRY, which dashboard-ui.js's _nbdResolveCall
 * consults BEFORE the _NBD_CALL_ALLOWLIST/window fallback — so this needs no
 * allowlist entry and no global. Markup stays CSP-clean (no inline script, no
 * on*= attribute); this file loads with defer.
 */
'use strict';

(function () {
  // Single owner — a second copy of this file would double-bind the action.
  if (window.__NBD_SESSION_REVOKE_READY) return;
  window.__NBD_SESSION_REVOKE_READY = true;

  var inFlight = false;

  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
    else console.log('[session-revoke]', kind || 'info', msg);
  }

  /**
   * Resolve the revokeMySessions callable.
   *
   * Prefers the module's already-bootstrapped window._functions (it has been
   * through connectEmulatorsIfLocal). If this runs first, build one AND run
   * the emulator connect ourselves — nbd-emulator-connect.js is an ES module,
   * so a classic script reaches it by dynamic import. Skipping that step is
   * how a local emulator run would silently call PRODUCTION and revoke real
   * sessions.
   */
  async function getCallable() {
    if (!window._functions || !window._httpsCallable) {
      var mod = await import('/assets/vendor/firebase/10.12.2/firebase-functions.js');
      window._functions = window._functions || mod.getFunctions();
      try {
        var emu = await import('./nbd-emulator-connect.js');
        await emu.connectEmulatorsIfLocal({ functions: window._functions }); // no-op in prod
      } catch (_) { /* prod path: module absent or already connected */ }
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
    }
    return window._httpsCallable(window._functions, 'revokeMySessions');
  }

  /**
   * Confirm → revoke server-side → sign out locally.
   *
   * The confirm text says "every device" because that is what this does BY
   * DESIGN: the user's own phone, tablet and office desktop are logged out
   * alongside the attacker's. Someone reaching for this mid-breach should not
   * be surprised by it, and someone who only wanted to leave this browser has
   * the plain Sign Out button one panel away.
   *
   * The "within an hour" line is not hedging — revokeRefreshTokens kills
   * refresh tokens, while an ID token already in another device's memory
   * stays valid until it expires. Promising "instantly" would be the same
   * class of lie this whole change exists to remove.
   *
   * @param {HTMLElement} [el] The button (passed via data-pass-el), disabled
   *                           while the call is in flight.
   */
  async function signOutEverywhere(el) {
    if (inFlight) return;

    // Fail CLOSED: no answer is a no. This started as `true`, so with the
    // modal helper missing (nbd-modal.js failed to load) one tap revoked
    // every device with no prompt at all. The fallback mirrors
    // storm-center.js confirmDeleteZone — the native confirm, reached through
    // nbdConfirm first so the iOS-PWA modal still wins where it exists — and
    // only an explicit `true` proceeds.
    var title = 'Sign out everywhere?';
    var body = 'This signs out every device on your account — your phone and '
        + 'tablet included, not just this browser. Anyone already signed '
        + 'in loses access the next time their session refreshes, within '
        + 'an hour at most. You will need to sign in again here.';
    var okToGo = false;
    try {
      if (window.nbdModal && typeof window.nbdModal.confirm === 'function') {
        okToGo = await window.nbdModal.confirm({
          title: title,
          body: body,
          okLabel: 'Sign out everywhere',
          cancelLabel: 'Cancel',
          danger: true
        });
      } else {
        var ask = window.nbdConfirm || function (m) { return Promise.resolve(typeof window.confirm === 'function' ? window.confirm(m) : false); };
        okToGo = await ask(title + '\n\n' + body);
      }
    } catch (_) { okToGo = false; }
    if (okToGo !== true) return;

    inFlight = true;
    var label = el && el.textContent;
    if (el) { el.disabled = true; el.textContent = 'Signing out…'; }

    try {
      var fn = await getCallable();
      await fn({});

      // Server-side revocation succeeded. NOW drop this browser's session —
      // without it the current tab keeps an ID token that is dead on refresh
      // but still passes local checks until it expires.
      toast('Signed out on every device. Signing you out here…', 'success');
      // Let the toast land before the redirect eats the page. showToast
      // self-removes at 2600ms, so 1400ms is comfortably inside its life.
      setTimeout(function () {
        if (typeof window._signOut === 'function') window._signOut();
        else window.location.replace('/pro/login.html');
      }, 1400);
    } catch (e) {
      // DELIBERATELY no local sign-out here. If revocation failed, the other
      // sessions are still live; signing this user out would tell them they
      // are safe when they are not, and make retrying harder (they would have
      // to log back in first). Leave them where they are and say so.
      inFlight = false;
      if (el) { el.disabled = false; if (label) el.textContent = label; }
      var msg = (e && e.message) || 'Something went wrong.';
      toast('Could not sign out your other devices — ' + msg + ' Your other sessions are still active.', 'error');
      console.warn('[session-revoke] revokeMySessions failed:', e);
    }
  }

  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, { _signOutEverywhere: signOutEverywhere });
})();
