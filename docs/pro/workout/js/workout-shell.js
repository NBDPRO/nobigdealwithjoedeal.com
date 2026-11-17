/**
 * workout-shell.js - what the Workout Coach expects from its page, for the standalone Workout app (/pro/workout).
 *
 * On the Daily Success page app.js supplies these as globals. Here there is no app.js (no day pages, no tabs), so this file
 * supplies the same ones, with the same behaviour, and nothing else. Loaded BEFORE workout-coach.js.
 *
 *   todayKey()            the LOCAL date as YYYY-MM-DD (the coach's own fallback is the UTC date, which is tomorrow after 7-8 pm)
 *   toast / toastErr      window.showToast (/pro/js/toast.js)
 *   dsSettingsChanged(k)  stamp `<k>_at` and send the settings to the cloud, so a change made here wins or loses by time
 *                         exactly as one made in Daily Success does (ds-firebase-sync.js pushSettingsOrThrow skips unstamped keys)
 *   savePages()           there are no day pages here: reports "nothing written" (false). ds-firebase-sync.js waits for this
 *                         function before it wraps it; without it that wait would poll twice a second for as long as the app is open.
 *
 * Deliberately NOT here: collectPage / renderPage / buildFitnessSection. Without them the coach skips its write into the day
 * page's Exercise Log (workout-coach.js writeToPage); the workout itself is saved the same way in both apps.
 */
(function () {
  'use strict';
  if (window.NBDWorkoutShell) return;

  function todayKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function toast(msg) { if (typeof window.showToast === 'function') window.showToast(msg, 'success'); }
  function toastErr(msg) { if (typeof window.showToast === 'function') window.showToast(msg, 'error'); }
  function dsSettingsChanged(key) {
    try { localStorage.setItem(key + '_at', String(Date.now())); } catch (_) { /* a full or blocked storage: the change still shows on this screen */ }
    if (window.NBDDsCloud && typeof window.NBDDsCloud.pushSettings === 'function') window.NBDDsCloud.pushSettings();
  }
  function savePages() { return false; }

  window.todayKey = todayKey;
  window.toast = toast;
  window.toastErr = toastErr;
  window.dsSettingsChanged = dsSettingsChanged;
  window.savePages = savePages;
  window.NBDWorkoutShell = { todayKey, dsSettingsChanged };
})();
