/**
 * prefs-sync.js — Wave 38 (Sticky kanban prefs across devices)
 *
 * Reps switch between desktop (in-office) and mobile (in-field)
 * constantly, and currently lose their preferred kanban setup
 * each time. View choice (insurance / cash / finance / jobs /
 * simple), Show Prospects toggle, Show Snoozed toggle — all
 * localStorage-only.
 *
 * This module mirrors a small allowlist of localStorage keys to
 * users/{uid}.uiPrefs in Firestore so they sync across devices
 * for the same signed-in user.
 *
 * Strategy:
 *   1. On auth ready: read users/{uid}.uiPrefs.
 *      For each key in the synced set:
 *        - if remote has a value AND local doesn't (or differs),
 *          write remote → local AND re-render the kanban so the
 *          UI reflects the synced state immediately.
 *   2. Then start a 10-second poll that compares local snapshot
 *      against the last-known-remote snapshot. On any change,
 *      debounced-write the new local values back to Firestore.
 *      Polling rather than wrapping localStorage.setItem so we
 *      don't have to touch every existing call site.
 *   3. On signout: stop polling; clear last-known cache.
 *
 * Synced keys (allowlist — anything not on this list is per-device
 * by design and won't be replicated):
 *   - nbd_kanban_view          which kanban view is active
 *   - nbd_crm_show_prospects   show prospects toggle
 *   - nbd_crm_show_snoozed     show snoozed toggle (Wave 35)
 *
 * NOT synced (per-device by design):
 *   - nbd_crm_search           no longer written (2026-10-02): the pipeline
 *                              search lives only in its box and clears on
 *                              refresh and on leaving the Pipeline
 *   - nbd_crm_followup_hidden  alert dismissal — per-device
 *   - any other key not in the allowlist
 *
 * Exposes: PrefsSync (debug/manual flush)
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['prefs-sync']) return;
  __NBD_LOADED['prefs-sync'] = true;

  const SYNCED_KEYS = ['nbd_kanban_view', 'nbd_crm_show_prospects', 'nbd_crm_show_snoozed'];
  const POLL_INTERVAL_MS = 10_000;
  const WRITE_DEBOUNCE_MS = 1500;

  // Last-known-remote snapshot. Populated on initial hydrate; used
  // to diff against current local state in the poll loop. Map of
  // { [key]: string|null }. null means "remote knows the key is
  // absent locally" — important so removing a flag pushes a
  // delete to Firestore, not just stale-stays.
  let remoteSnapshot = null;
  let pollHandle = null;
  let writeTimer = null;
  let writeRetryAfter = 0;

  // ─── Helpers ─────────────────────────────────────────────────────
  function _readLocal() {
    const out = {};
    for (const k of SYNCED_KEYS) {
      try {
        const v = localStorage.getItem(k);
        out[k] = (v === null) ? null : String(v);
      } catch (e) { out[k] = null; }
    }
    return out;
  }

  function _writeLocal(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const k of SYNCED_KEYS) {
      try {
        const v = snapshot[k];
        if (v === null || v === undefined) localStorage.removeItem(k);
        else                               localStorage.setItem(k, String(v));
      } catch (e) { /* quota / private mode — silent */ }
    }
  }

  function _shallowEqual(a, b) {
    if (!a || !b) return false;
    for (const k of SYNCED_KEYS) {
      if ((a[k] ?? null) !== (b[k] ?? null)) return false;
    }
    return true;
  }

  // ─── Firestore I/O ──────────────────────────────────────────────
  async function _readRemote() {
    if (!window.db || !window.doc || !window.getDoc || !window.auth) return null;
    const uid = window.auth.currentUser && window.auth.currentUser.uid;
    if (!uid) return null;
    try {
      const snap = await window.getDoc(window.doc(window.db, 'users', uid));
      // An answer from the on-phone cache (offline / boot connection cycle,
      // persistent cache since 2026-10-04) is not the account's prefs: a
      // cached "no doc" read as {} would let this device's local values
      // overwrite the real ones. Treat it like a failed read (null): local
      // becomes the baseline and nothing is written.
      if (snap.metadata && snap.metadata.fromCache) return null;
      if (!snap.exists()) return {};
      const data = snap.data() || {};
      const prefs = (data.uiPrefs && typeof data.uiPrefs === 'object') ? data.uiPrefs : {};
      const out = {};
      for (const k of SYNCED_KEYS) {
        const v = prefs[k];
        out[k] = (v === undefined || v === null) ? null : String(v);
      }
      return out;
    } catch (e) {
      console.warn('[prefs-sync] read failed', e.message);
      return null;
    }
  }

  async function _writeRemote(snapshot) {
    if (!window.db || !window.doc || !window.setDoc || !window.auth) return false;
    const uid = window.auth.currentUser && window.auth.currentUser.uid;
    if (!uid) return false;
    // Don't hammer Firestore on rejected writes — back off until
    // the timestamp.
    if (Date.now() < writeRetryAfter) return false;
    try {
      const payload = {};
      for (const k of SYNCED_KEYS) {
        // Only write keys that have a value; leave absent keys
        // off the doc so Firestore stays clean.
        if (snapshot[k] !== null && snapshot[k] !== undefined) {
          payload[k] = snapshot[k];
        }
      }
      await window.setDoc(
        window.doc(window.db, 'users', uid),
        { uiPrefs: payload },
        { merge: true }
      );
      remoteSnapshot = { ...snapshot };
      return true;
    } catch (e) {
      console.warn('[prefs-sync] write failed', e.message);
      // Back off for 30s on permission/network errors so we don't
      // burn through quota or spam logs.
      writeRetryAfter = Date.now() + 30_000;
      return false;
    }
  }

  function _scheduleWrite() {
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(async () => {
      writeTimer = null;
      const local = _readLocal();
      if (remoteSnapshot && _shallowEqual(local, remoteSnapshot)) return;
      await _writeRemote(local);
    }, WRITE_DEBOUNCE_MS);
  }

  // ─── Hydrate on auth ────────────────────────────────────────────
  async function _hydrate() {
    const remote = await _readRemote();
    if (!remote) {
      // No remote yet (or read failed) — adopt current local as the
      // baseline so we don't immediately overwrite with empties.
      remoteSnapshot = _readLocal();
      return;
    }
    remoteSnapshot = { ...remote };

    const local = _readLocal();
    // Conflict resolution policy:
    //   If remote has a value for a key and local is empty, prefer
    //   remote (sync from desktop → mobile).
    //   If both have values that differ, prefer the LATEST locally-
    //   modified value — but we don't have per-key timestamps, so
    //   we conservatively prefer the LOCAL value (the current
    //   browser is what the user just touched). This means a
    //   user changing prefs offline on device A and then signing
    //   into device B with stale prefs sees their device-B prefs
    //   "win"; a subsequent visit on device A reads their remote
    //   (which still reflects A's old state) — slight footgun but
    //   acceptable for a cross-device sync of soft UI state.
    let localChangedDuringHydrate = false;
    const merged = { ...remote };
    for (const k of SYNCED_KEYS) {
      if (local[k] !== null && local[k] !== remote[k]) {
        merged[k] = local[k];
        localChangedDuringHydrate = true;
      } else if (local[k] === null && remote[k] !== null) {
        // local is empty, remote has it → adopt remote.
        // Don't flag as localChangedDuringHydrate (we're applying
        // remote to local, not pushing local to remote).
      }
    }

    // Apply merged → localStorage.
    _writeLocal(merged);
    remoteSnapshot = { ...merged };

    // If local "won" a conflict, push merged back so remote agrees.
    if (localChangedDuringHydrate) {
      await _writeRemote(merged);
    }

    // Tell the kanban + the show-snoozed toggle button to re-render
    // off the new pref values so the user sees the synced state
    // immediately.
    try {
      window.dispatchEvent(new CustomEvent('nbd:prefs-hydrated', { detail: merged }));
    } catch (_) {}
    if (typeof window.renderLeads === 'function') {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
    }
    // Snoozed-toggle button needs an explicit nudge since it's not
    // wired to renderLeads.
    if (window.LeadSnooze && typeof window.LeadSnooze.updateSnoozedToggle === 'function') {
      try { window.LeadSnooze.updateSnoozedToggle(); } catch (_) {}
    }
  }

  // ─── Poll loop ──────────────────────────────────────────────────
  function _startPolling() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = setInterval(() => {
      const local = _readLocal();
      if (remoteSnapshot && _shallowEqual(local, remoteSnapshot)) return;
      // Local diverged — schedule a write.
      _scheduleWrite();
    }, POLL_INTERVAL_MS);
  }

  function _stopPolling() {
    if (pollHandle) clearInterval(pollHandle);
    pollHandle = null;
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = null;
    remoteSnapshot = null;
  }

  // ─── Auth wiring ────────────────────────────────────────────────
  function _onAuthReady() {
    if (!window.auth || !window.auth.currentUser) return;
    _hydrate().then(_startPolling).catch(e => {
      console.warn('[prefs-sync] hydrate failed', e.message);
      _startPolling();
    });
  }

  function _watchAuth() {
    if (!window.auth) return;
    if (typeof window.auth.onAuthStateChanged === 'function') {
      window.auth.onAuthStateChanged(user => {
        if (user) _onAuthReady();
        else _stopPolling();
      });
    } else if (typeof window._onAuthStateChanged === 'function') {
      window._onAuthStateChanged(window.auth, user => {
        if (user) _onAuthReady();
        else _stopPolling();
      });
    } else if (window.auth.currentUser) {
      _onAuthReady();
    }
  }

  // Defer until the firebase init has populated window.auth + window.db.
  function _init() {
    if (!window.auth || !window.db) {
      // Try again shortly — auth may still be initializing.
      setTimeout(_init, 500);
      return;
    }
    _watchAuth();
    // Also flush on page unload so a quick toggle right before the
    // user closes the tab still makes it to Firestore.
    window.addEventListener('beforeunload', () => {
      if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
        // Best-effort fire-and-forget; modern browsers won't
        // reliably wait but Firestore SDK does some background
        // queueing.
        const local = _readLocal();
        if (!remoteSnapshot || !_shallowEqual(local, remoteSnapshot)) {
          _writeRemote(local).catch(() => {});
        }
      }
    });
  }

  const PrefsSync = {
    SYNCED_KEYS,
    flush: () => {
      if (writeTimer) clearTimeout(writeTimer);
      writeTimer = null;
      return _writeRemote(_readLocal());
    },
    hydrate: _hydrate,
    snapshot: () => ({ local: _readLocal(), remote: remoteSnapshot ? { ...remoteSnapshot } : null }),
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
