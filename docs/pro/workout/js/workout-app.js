/**
 * workout-app.js - the standalone Workout app's own screen (/pro/workout). Loaded AFTER workout-coach.js.
 *
 *   - draws the Workout Coach card into the page (the coach re-draws #wcCard in place; on Daily Success the Fitness section holds it)
 *   - the header line: today's date, and whether the workouts are backed up (the 'nbd-ds-sync' event from ds-firebase-sync.js)
 *   - signed out: shows the sign-in link. An installed iPhone app keeps its own storage, so signing in here is how it gets
 *     the workouts logged in Daily Success or on another device
 *   - asks the service worker to keep an offline copy of this page (same request Daily Success makes for itself)
 *   - the Theme and Accent controls: this app's own, or "Same as Daily Success" (workout-theme.js setOwn / setOwnAccent; the choice
 *     syncs with the account)
 *   - at Finish asks "Workout done. Tick the floor?" and stores the answer on the workout (NBDCoachUI.answerFloor). There are no floors
 *     or day pages here, so nothing is ticked on this screen: Daily Success applies a yes the next time it opens, and never asks again
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
  // ── Theme: this app's own, or the Daily Success one ────────────────────────
  function drawTheme() {
    const sel = $('waTheme'), T = window.NBDWorkoutTheme;
    if (sel && T && typeof T.own === 'function') sel.value = T.own();
    const acc = $('waAccent');
    if (acc && T && typeof T.ownAccent === 'function') acc.value = T.ownAccent();
  }
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t || (t.id !== 'waTheme' && t.id !== 'waAccent')) return;
    const T = window.NBDWorkoutTheme;
    if (!T) return;
    if (t.id === 'waTheme') { if (typeof T.setOwn === 'function') t.value = T.setOwn(t.value); }
    else if (typeof T.setOwnAccent === 'function') t.value = T.setOwnAccent(t.value);
  });
  // A look that arrived with the account (look-sync.js has applied it by now: it registered first): the control shows it.
  window.addEventListener('nbd-ds-settings-restored', drawTheme);

  // ── "Workout done. Tick the floor?" ────────────────────────────────────────
  const TICK_IDLE_MS = 30000, TICK_DONE_MS = 5000;
  let tickId = null, tickTimer = null;
  // Is there a floor a workout ticks? Jo's own floors when he has set some (nbd_user_config, the same list Daily Success reads);
  // with none set the default floors apply, and they include one.
  function hasWorkoutFloor(config) {
    const floors = config && Array.isArray(config.floors) && config.floors.length ? config.floors : null;
    if (!floors) return true;
    const F = window.NBDFloorTick;
    return !!F && floors.some((f) => f && F.RULES.workout.re.test(String(f.label || '')));
  }
  function tickEl() {
    let e = $('waTick');
    if (e) return e;
    e = document.createElement('div');
    e.id = 'waTick'; e.className = 'wa-tick'; e.hidden = true;
    e.setAttribute('role', 'status'); e.setAttribute('aria-live', 'polite');
    document.body.appendChild(e);
    return e;
  }
  function piece(tag, text, action) {
    const n = document.createElement(tag);
    n.textContent = text;
    if (action) { n.type = 'button'; n.dataset.waAction = action; }
    return n;
  }
  function tickDraw(title, sub, buttons) {
    const e = tickEl();
    e.textContent = '';
    const msg = document.createElement('div');
    msg.className = 'wa-tick-msg';
    msg.appendChild(piece('b', title)); msg.appendChild(piece('small', sub));
    e.appendChild(msg);
    buttons.forEach((b) => e.appendChild(piece('button', b[0], b[1])));
    e.hidden = false;
  }
  function tickHide() { clearTimeout(tickTimer); tickTimer = null; tickId = null; const e = $('waTick'); if (e) { e.hidden = true; e.textContent = ''; } }
  function askFloor(id) {
    const ui = window.NBDCoachUI;
    if (id == null || !ui || typeof ui.answerFloor !== 'function') return false;
    let config = null;
    try { config = JSON.parse(localStorage.getItem('nbd_user_config')); } catch (_) { config = null; }
    if (!hasWorkoutFloor(config)) return false;
    tickDraw('Workout done. Tick the floor?', 'Daily Success ticks it the next time it opens.', [['Tick it', 'tick-yes'], ['Not now', 'tick-no']]);
    tickId = id;
    clearTimeout(tickTimer); tickTimer = setTimeout(tickHide, TICK_IDLE_MS);   // no answer: Daily Success asks when it copies the workout in
    return true;
  }
  function answerFloor(ans) {
    const id = tickId, ui = window.NBDCoachUI;
    if (id == null || !ui || typeof ui.answerFloor !== 'function') { tickHide(); return; }
    if (!ui.answerFloor(id, ans)) {
      tickHide();
      if (typeof window.toastErr === 'function') window.toastErr('Could not save that on this phone. Daily Success will ask instead.');
      return;
    }
    if (ans !== 'yes') { tickHide(); return; }
    tickDraw('Got it', 'Daily Success will tick the floor.', [['Undo', 'tick-no']]);
    clearTimeout(tickTimer); tickTimer = setTimeout(tickHide, TICK_DONE_MS);
  }
  window.addEventListener('nbd-ds-did', (ev) => {
    const d = (ev && ev.detail) || {};
    if (d.kind === 'workout') askFloor(d.id);
  });

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-wa-action]') : null;
    if (!t) return;
    const a = t.dataset.waAction;
    if (a === 'retry') { if (window.NBDDsCloud && typeof window.NBDDsCloud.retry === 'function') window.NBDDsCloud.retry(); }
    else if (a === 'tick-yes') answerFloor('yes');
    else if (a === 'tick-no') answerFloor('no');
  });
  // Left open overnight: the date line and "today's workout" follow the day.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { drawDate(); drawCard(); drawTheme(); } });

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

  function boot() { drawDate(); drawCard(); drawStatus(); drawTheme(); keepOffline(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDWorkoutApp = { statusOf, drawCard, hasWorkoutFloor, askFloor };
})();
