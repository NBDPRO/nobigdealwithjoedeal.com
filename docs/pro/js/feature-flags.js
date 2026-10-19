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
  const TTL_MS = 10 * 60 * 1000;

  function snapshotReady() {
    return !!(window.db && window.doc && window.getDoc);
  }

  async function load() {
    if (state.loaded && (Date.now() - state.loadedAt) < TTL_MS) return state.flags;
    if (!snapshotReady() || !window._user) return state.flags;
    try {
      const [defSnap, mySnap] = await Promise.all([
        window.getDoc(window.doc(window.db, 'feature_flags', '_default')),
        window.getDoc(window.doc(window.db, 'feature_flags', window._user.uid))
      ]);
      const def = defSnap.exists() ? defSnap.data() : {};
      const mine = mySnap.exists() ? mySnap.data() : {};
      state.flags = Object.assign({}, def, mine);
      state.loaded = true;
      state.loadedAt = Date.now();
      // Surfaces drawn before the flags arrived (the Expenses buttons) redraw on this.
      try { window.dispatchEvent(new CustomEvent('nbd:flags-loaded')); } catch (e) { /* no DOM events: nothing to redraw */ }
    } catch (e) {
      // Swallow — rules may deny the per-uid doc for a user who
      // hasn't had any overrides written. That's fine; the default
      // doc alone is enough.
    }
    return state.flags;
  }

  function get(name)         { return state.flags[name]; }
  function enabled(name)     { return !!state.flags[name]; }
  function gate(name, cb)    { if (enabled(name) && typeof cb === 'function') cb(); }

  // Eager load on auth ready so subsequent UI decisions don't need
  // to await.
  let tries = 0;
  const poll = setInterval(() => {
    tries++;
    if (window._user && snapshotReady()) { clearInterval(poll); load(); }
    else if (tries > 40) clearInterval(poll);
  }, 250);

  window.NBDFlags = {
    __sentinel: 'nbd-flags-v1',
    load, get, enabled, gate
  };
})();
