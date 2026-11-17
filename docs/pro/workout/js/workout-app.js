/**
 * workout-app.js - the standalone Workout app's own screen (/pro/workout). Loaded AFTER workout-coach.js.
 *
 *   - draws the Workout Coach card into the page (the coach re-draws #wcCard in place; on Daily Success the Fitness section holds it)
 *   - the header line: today's date, and whether the workouts are backed up (the 'nbd-ds-sync' event from ds-firebase-sync.js)
 *   - signed out: shows the sign-in link. An installed iPhone app keeps its own storage, so signing in here is how it gets
 *     the workouts logged in Daily Success or on another device
 *   - asks the service worker to keep an offline copy of this page (same request Daily Success makes for itself)
 *
 * No account data is read here. CSP: external classic script, delegated listener, textContent only.
 */
(function () {
  'use strict';
  if (window.NBDWorkoutApp) return;
  const SHELL_KEY = '/pro/__app-shell__/workout';
  const $ = (id) => document.getElementById(id);

  function drawCard() {
    const ui = window.NBDCoachUI;
    if (ui && typeof ui.refresh === 'function') { ui.refresh(); return true; }
    const el = $('wcCard');
    if (el) el.textContent = 'The workout coach did not load. Check your connection and reopen the app.';
    return false;
  }

  function drawDate() {
    const el = $('waDate');
    if (el) el.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  }

  // { cloud: 'idle' | 'syncing' | 'synced' | 'failed' | 'paused', signedIn: true | false | null (not known yet) }
  const st = { cloud: 'idle', signedIn: null, online: typeof navigator === 'undefined' || navigator.onLine !== false };
  function statusOf(s) {
    if (s.signedIn === false) return { text: 'Saved on this phone', cls: '', signIn: true };
    if (s.signedIn !== true) return { text: '', cls: '' };
    if (!s.online) return { text: 'Offline · saved on this phone', cls: '' };
    if (s.cloud === 'failed') return { text: 'Not backed up', cls: 'err', retry: true };
    if (s.cloud === 'paused') return { text: 'Backup paused', cls: 'err' };
    if (s.cloud === 'synced') return { text: 'Backed up', cls: 'ok' };
    return { text: 'Syncing…', cls: '' };
  }
  function drawStatus() {
    const el = $('waStatus'), link = $('waSignIn');
    const v = statusOf(st);
    if (el) {
      el.textContent = v.text;
      el.className = 'wa-status' + (v.cls ? ' ' + v.cls : '');
      if (v.retry) {
        const b = document.createElement('button');
        b.type = 'button'; b.dataset.waAction = 'retry'; b.textContent = 'Retry';
        el.appendChild(b);
      }
    }
    if (link) link.hidden = !v.signIn;
  }

  window.addEventListener('nbd-ds-sync', (ev) => {
    const d = (ev && ev.detail) || {};
    if (d.cloud) st.cloud = d.cloud;
    if (typeof d.signedIn === 'boolean') st.signedIn = d.signedIn;
    drawStatus();
  });
  window.addEventListener('online', () => { st.online = true; drawStatus(); });
  window.addEventListener('offline', () => { st.online = false; drawStatus(); });
  // Settings pulled from the cloud (rotation, routines, custom lifts): the card shows them at once.
  window.addEventListener('nbd-ds-settings-restored', drawCard);
  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-wa-action="retry"]') : null;
    if (t && window.NBDDsCloud && typeof window.NBDDsCloud.retry === 'function') window.NBDDsCloud.retry();
  });
  // Left open overnight: the date line and "today's workout" follow the day.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { drawDate(); drawCard(); } });

  // Offline copy of this page (see daily-success/js/offline-shell.js for why the page asks for its own shell).
  function keepOffline() {
    if (!('serviceWorker' in navigator)) return;
    let asked = false;
    const ask = () => {
      try {
        if (navigator.onLine === false) return;
        const c = navigator.serviceWorker.controller;
        if (!c) return;
        c.postMessage({ type: 'CACHE_APP_SHELL', keys: [SHELL_KEY] });
        asked = true;
      } catch (_) { /* best effort: the app works either way */ }
    };
    const later = () => setTimeout(ask, 3000);
    if (document.readyState === 'complete') later(); else window.addEventListener('load', later);
    try { navigator.serviceWorker.addEventListener('controllerchange', () => { if (!asked) later(); }); } catch (_) { /* ignore */ }
  }

  function boot() { drawDate(); drawCard(); drawStatus(); keepOffline(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDWorkoutApp = { statusOf, drawCard };
})();
