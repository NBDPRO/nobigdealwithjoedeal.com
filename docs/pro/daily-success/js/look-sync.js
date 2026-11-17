/**
 * look-sync.js - the theme and accent follow the account, not just the device (2026-11-17).
 *
 * Daily Success keeps its theme in device keys (nbd_pro_theme / nbd-theme / ds-theme) and its accent in nbd_ds_accent. That was
 * enough while every surface shared one browser's storage. An installed iPhone app has its own storage, so the Workout app (and a
 * second Daily Success install) never saw the choice. This file keeps two small records that ds-firebase-sync.js syncs like the
 * other settings (userSettings, newest stamp wins), and turns them back into the device keys when a newer one arrives:
 *
 *   nbd_ds_look = { theme, accent }   the Daily Success look (userSettings.dsLook)
 *   nbd_wk_look = { theme }           the Workout app's OWN theme (userSettings.dsWkLook). Jo, 2026-11-17: the apps may wear
 *                                     different themes. theme '' means "same as Daily Success". Device key: nbd_wk_theme.
 *
 * Two records, not one, because the sync replaces a record whole: a Workout-only choice made on a phone that has not yet received
 * the Daily Success look would otherwise send "default" along with it and overwrite the look chosen elsewhere.
 *
 *   changed()   Jo picked something here (app.js nbdApplyTheme, accent-ui.js set, workout-theme.js setOwn): each record that now
 *               differs is written, stamped and pushed. A call that changes nothing (the same look, or our own restore re-applying
 *               one) writes and stamps nothing.
 *   seed()      On load: a device that already carries a real choice (a theme other than the default, an accent, or a Workout
 *               theme) and has no record for it yet writes one WITHOUT a stamp. Unstamped, it loses to any copy the cloud already
 *               holds and is only sent when the cloud has none. A device with nothing chosen writes nothing, so a fresh install
 *               can never push "default" over the look chosen on another phone.
 *   restore()   The sync restored settings from the cloud ('nbd-ds-settings-restored'): a record that differs from what this
 *               device shows is applied. On Daily Success that is nbdApplyTheme() + NBDAccent.set() (they validate and persist);
 *               on the Workout app, which has neither, the device keys are written and workout-theme.js re-applies.
 *
 * The records hold theme ids and an accent id, nothing else. Ids are checked for shape before they are stored or applied; whether
 * a theme exists is decided by the page that draws it (an unknown id shows as the default skin). The records are account data and
 * are cleared on an account switch (nbd-auth.js purgeAccountStorage keeps only device preferences); the Daily Success device keys stay.
 * Classic script, no DOM, no inline handlers.
 */
(function () {
  'use strict';
  if (window.NBDLook) return;
  var KEY = 'nbd_ds_look', WK_KEY = 'nbd_wk_look', WK_DEVICE = 'nbd_wk_theme';
  var ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
  var busy = false;   // our own restore is re-applying a look: changed() must not treat it as a new choice

  function get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function put(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); return true; } catch (_) { return false; } }
  function parse(k) { try { return JSON.parse(get(k)); } catch (_) { return null; } }
  var isId = function (v) { return typeof v === 'string' && ID.test(v); };

  /** A Daily Success look with a well-formed theme id (and accent id or null), or null. */
  function norm(v) {
    if (!v || typeof v !== 'object' || !isId(v.theme)) return null;
    return { theme: v.theme, accent: isId(v.accent) ? v.accent : null };
  }
  /** A Workout-theme record: { theme: '<id>' } or { theme: '' } (same as Daily Success), or null. */
  function normWk(v) {
    if (!v || typeof v !== 'object') return null;
    if (v.theme === '') return { theme: '' };
    return isId(v.theme) ? { theme: v.theme } : null;
  }
  function same(a, b) { return !!a && !!b && a.theme === b.theme && (a.accent || null) === (b.accent || null); }

  /** What this device shows now, read the way app.js nbdBoot reads it. `chosen` is false when nothing was ever picked here. */
  function current() {
    var saved = get('nbd_pro_theme');
    if (saved === 'nbd-original') saved = 'default';
    if (!saved) saved = get('nbd-theme') || get('ds-theme');
    var look = norm({ theme: saved || 'default', accent: get('nbd_ds_accent') }) || { theme: 'default', accent: null };
    return { look: look, chosen: (!!saved && look.theme !== 'default') || !!look.accent };
  }
  function currentWk() {
    var v = get(WK_DEVICE);
    return { look: { theme: isId(v) ? v : '' }, chosen: isId(v) };
  }
  var stored = function () { return norm(parse(KEY)); };
  var storedWk = function () { return normWk(parse(WK_KEY)); };

  function stamp(key) { if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(key); }   // stamps <key>_at and pushes

  function changed() {
    if (busy) return false;
    var did = false;
    // For each record: no record yet and nothing picked on this device means there is nothing to say (the other app's choice made
    // here must not send "default" for this one). Otherwise a pick, or going back to the default, is recorded.
    var c = current(), was = stored();
    if ((was || c.chosen) && !same(c.look, was) && put(KEY, JSON.stringify(c.look))) { stamp(KEY); did = true; }
    var wk = currentWk(), had = storedWk();
    if ((had || wk.chosen) && !same(wk.look, had) && put(WK_KEY, JSON.stringify(wk.look))) { stamp(WK_KEY); did = true; }
    return did;
  }

  function seed() {
    var did = false;
    var c = current();
    if (!stored() && c.chosen && put(KEY, JSON.stringify(c.look))) did = true;        // no stamp: see the header
    var w = currentWk();
    if (!storedWk() && w.chosen && put(WK_KEY, JSON.stringify(w.look))) did = true;
    return did;
  }

  function restore() {
    var look = stored(), wk = storedWk();
    var newLook = !!look && !same(look, current().look);
    var newWk = !!wk && !same(wk, currentWk().look);
    if (!newLook && !newWk) return false;
    busy = true;
    try {
      // The Workout app's own theme is only a device key on both pages (Daily Success never draws it, it only must not lose it).
      if (newWk) put(WK_DEVICE, wk.theme || null);
      if (newLook && typeof window.nbdApplyTheme === 'function') {
        // Daily Success: the page's own functions check the theme exists, draw it and write the device keys.
        window.nbdApplyTheme(look.theme);
        if (window.NBDAccent && typeof window.NBDAccent.set === 'function') window.NBDAccent.set(look.accent || '');
      } else if (newLook) {
        put('nbd-theme', look.theme);
        put('nbd_pro_theme', look.theme === 'default' ? 'nbd-original' : look.theme);
        put('nbd_ds_accent', look.accent);
      }
      if (window.NBDWorkoutTheme && typeof window.NBDWorkoutTheme.apply === 'function') window.NBDWorkoutTheme.apply();
    } catch (_) { /* the records stay; the next load reads the device keys as they are */ }
    finally { busy = false; }
    return true;
  }

  window.NBDLook = { KEY: KEY, WK_KEY: WK_KEY, norm: norm, normWk: normWk, current: current, currentWk: currentWk, changed: changed, seed: seed, restore: restore };
  seed();
  if (typeof window.addEventListener === 'function') window.addEventListener('nbd-ds-settings-restored', restore);
})();
