/**
 * feature-flags.js — kill-switch / gradual-rollout reader (F9)
 *
 * Reads `feature_flags/_default` + `feature_flags/{uid}` (merged,
 * user-override wins) from Firestore once per session and exposes:
 *
 *   window.NBDFlags.get(name)          → boolean | value | null
 *   window.NBDFlags.enabled(name)      → boolean
 *   window.NBDFlags.gate(name, cb)     → cb() only if the flag is on
 *
 * Flags collection shape:
 *   feature_flags/_default  { v2Preview: true, voiceMemo: false, ... }
 *   feature_flags/{uid}     { voiceMemo: true }   // per-user overrides
 *
 * Rules (firestore.rules):
 *   - _default: read by any authed user, write by platform admin
 *   - {uid}:    read by owner or platform admin, write by platform admin
 *
 * Offline / unauth fallback: everything reads false, letting the
 * existing code paths degrade gracefully.
 */
(function () {
  'use strict';
  if (window.NBDFlags && window.NBDFlags.__sentinel === 'nbd-flags-v1') return;

  const state = { loaded: false, flags: {}, loadedAt: 0 };
  let retries = 0;
  const TTL_MS = 10 * 60 * 1000;

  function snapshotReady() {
    return !!(window.db && window.doc && window.getDoc);
  }

  async function load() {
    if (state.loaded && (Date.now() - state.loadedAt) < TTL_MS) return state.flags;
    if (!snapshotReady() || !window._user) return state.flags;
    try {
      // allSettled: a denied per-user doc must not throw away a readable _default (the header says the
      // default doc alone is enough). Only an unreadable _default leaves the flags unloaded.
      const [defRes, myRes] = await Promise.allSettled([
        window.getDoc(window.doc(window.db, 'feature_flags', '_default')),
        window.getDoc(window.doc(window.db, 'feature_flags', window._user.uid))
      ]);
      if (defRes.status !== 'fulfilled') throw defRes.reason;
      const defSnap = defRes.value;
      const mySnap = myRes.status === 'fulfilled' ? myRes.value : null;
      const def = defSnap.exists() ? defSnap.data() : {};
      const mine = mySnap && mySnap.exists() ? mySnap.data() : {};
      state.flags = Object.assign({}, def, mine);
      state.loaded = true;
      state.loadedAt = Date.now();
      // Surfaces drawn before the flags arrived (the Expenses buttons) redraw on this.
      try { window.dispatchEvent(new CustomEvent('nbd:flags-loaded')); } catch (e) { /* no DOM events: nothing to redraw */ }
    } catch (e) {
      // Only an unreadable _default lands here (a denied per-uid doc is
      // fine, see allSettled above). 2026-11-25: one flaky read used to
      // leave every flag off until the app was relaunched; try again soon.
      if (!state.loaded && retries++ < 5 && typeof setTimeout === 'function') setTimeout(load, 15000);
    }
    return state.flags;
  }

  function get(name)         { return state.flags[name]; }
  function enabled(name)     { return !!state.flags[name]; }
  function gate(name, cb)    { if (enabled(name) && typeof cb === 'function') cb(); }

  // Eager load on auth ready so subsequent UI decisions don't need
  // to await. 2026-11-25 (iPhone parity): this gave up after 10 s, and an
  // iPhone cold start on weak signal often signs in later than that, so the
  // whole session ran with every flag off. Wait up to 2 minutes instead.
  let tries = 0;
  const poll = setInterval(() => {
    tries++;
    if (window._user && snapshotReady()) { clearInterval(poll); load(); }
    else if (tries > 480) clearInterval(poll);
  }, 250);
  // A home-screen app resumes for days without reloading: read the flags
  // again when it comes back to the foreground (load() keeps its 10-minute
  // TTL, so a quick app switch costs nothing).
  try {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { retries = 0; load(); }
    });
  } catch (e) { /* no document: nothing to resume */ }

  window.NBDFlags = {
    __sentinel: 'nbd-flags-v1',
    load, get, enabled, gate,
    isLoaded: function () { return state.loaded; }
  };
})();
