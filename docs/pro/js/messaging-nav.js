/**
 * messaging-nav.js - reveals the "Messaging" sidebar / More-menu entries (2026-10-19).
 *
 * The Messaging Control Center itself is a lazy bundle (js/messaging-center.js).
 * This 1 KB file is the only boot-time piece: it keeps both entries hidden
 * unless the Firestore flag `messagingControlCenter` is on AND the reader is
 * the owner or an admin (viewer and sales_rep never see the entry). No reads
 * of its own: it waits for NBDFlags, which loads feature_flags once per session.
 * The callable re-checks the role and the flag on the server.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  var w = window;
  var ROLES = ['owner', 'admin', 'company_admin'];

  function allowed() {
    var uid = w._user && w._user.uid;
    if (!uid) return false;
    var c = w._userClaims || {};
    var role = String(c.role || '').toLowerCase();
    if (ROLES.indexOf(role) !== -1) return true;
    if (!role) return !c.companyId || c.companyId === uid;
    return false;
  }
  function flagOn() { return !!(w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled('messagingControlCenter')); }

  function sync() {
    var show = flagOn() && allowed();
    ['nav-messaging', 'mm-messaging'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.toggle('dn', !show);
    });
    return show;
  }

  var tries = 0;
  function tick() {
    if (sync() || ++tries > 40) return;
    setTimeout(tick, 500);
  }
  w.addEventListener('nbd:flags-loaded', sync);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick); else tick();
})();
