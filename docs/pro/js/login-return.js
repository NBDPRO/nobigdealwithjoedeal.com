/**
 * login-return.js - where the login page goes back to when one of the personal web apps sent the visitor (2026-11-16).
 *
 * Daily Success and Workout install as their own home-screen apps. Their "Sign in" links open /pro/login?redirect=<name>;
 * without this, a sign-in ended on the CRM dashboard and the app had to be reopened from the home screen.
 *
 * The query carries a NAME, never an address: the name is looked up in the fixed list below, and anything that is not in it
 * (a URL, a path, a key of Object.prototype) gives null, so the login page cannot be made to send anyone anywhere else.
 * pages/login.js (POST_LOGIN_DEST) asks dest(location.search) and falls back to its own rules on null.
 *
 * Classic script, loaded before the login module. No inline handlers (CSP).
 */
(function () {
  'use strict';
  if (window.NBDLoginReturn) return;
  var APPS = { 'daily-success': '/pro/daily-success', 'workout': '/pro/workout' };

  function dest(search) {
    try {
      var name = new URLSearchParams(String(search || '')).get('redirect');
      return typeof name === 'string' && Object.prototype.hasOwnProperty.call(APPS, name) ? APPS[name] : null;
    } catch (_) { return null; }
  }

  window.NBDLoginReturn = { dest: dest };
})();
