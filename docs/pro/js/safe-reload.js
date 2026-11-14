// safe-reload.js — deploy reloads that never throw away work (2026-11-14).
//
// A new deploy activates a new service worker, and both registration sites
// (dashboard-sw-bootstrap.js on the dashboard, offline-manager.js on the
// customer page) used to call location.reload() straight away. The update
// check runs every 60 s, so on a phone in the field a deploy wiped a
// half-typed lead or note and cut a live voice note.
//
// NBDSafeReload.request(reason) now reloads only when nothing would be lost:
//   - no modal or dialog is open,
//   - no visible text field holds text the user typed since it was rendered,
//   - no module holds a busy flag (recording, upload) via hold()/release().
// Otherwise it shows a "New version ready — tap to reload" bar and waits.
// It also reloads on its own the next time the page is hidden while idle,
// so the old code never lingers once the rep has stopped working.
(function () {
  'use strict';
  if (window.NBDSafeReload) return;

  var MODAL_SEL = '.modal-bg, .modal-overlay, [role="dialog"], [aria-modal="true"], dialog[open]';
  var TEXT_TYPES = { text: 1, email: 1, tel: 1, url: 1, number: 1, password: 1, '': 1 };
  var holds = Object.create(null);
  var pending = null;
  var reloaded = false;
  var bar = null;

  function visible(el) {
    try {
      if (!el || el.isConnected === false) return false;
      if (el.closest && el.closest('[hidden]')) return false;
      return !!(el.getClientRects && el.getClientRects().length);
    } catch (_) { return false; }
  }

  function modalOpen() {
    var els = document.querySelectorAll(MODAL_SEL);
    for (var i = 0; i < els.length; i++) {
      if (els[i] === bar || (bar && bar.contains && bar.contains(els[i]))) continue;
      if (visible(els[i])) return true;
    }
    return false;
  }

  function isTextField(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !!TEXT_TYPES[String(el.type || '').toLowerCase()];
    return !!el.isContentEditable;
  }

  function hasUnsavedText(el) {
    if (!visible(el)) return false;
    if (el.isContentEditable && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') {
      return String(el.textContent || '').trim() !== '';
    }
    var v = String(el.value == null ? '' : el.value);
    return v.trim() !== '' && v !== String(el.defaultValue == null ? '' : el.defaultValue);
  }

  // Fields the user has typed into on this page load. A plain Set (not a
  // WeakSet) so it can be walked; entries are pruned once disconnected.
  var touched = new Set();
  document.addEventListener('input', function (e) {
    if (isTextField(e.target)) touched.add(e.target);
  }, true);

  function dirtyField() {
    var found = false;
    touched.forEach(function (el) {
      if (el.isConnected === false) { touched.delete(el); return; }
      if (!found && hasUnsavedText(el)) found = true;
    });
    return found;
  }

  // Every recorder on the page (quick capture, voice memo, visit recorder,
  // D2D, voicemail...) is a MediaRecorder, so one wrap of start() covers them
  // all without each module having to remember a hold/release pair.
  var recorders = new Set();
  try {
    var MR = window.MediaRecorder;
    if (typeof MR === 'function' && MR.prototype && !MR.prototype.__nbdSafeReloadWrapped) {
      var origStart = MR.prototype.start;
      MR.prototype.start = function () {
        recorders.add(this);
        return origStart.apply(this, arguments);
      };
      MR.prototype.__nbdSafeReloadWrapped = true;
    }
  } catch (_) { /* no MediaRecorder: nothing to protect */ }

  function recording() {
    var live = false;
    recorders.forEach(function (rec) {
      if (rec.state === 'inactive') { recorders.delete(rec); return; }
      live = true;
    });
    return live;
  }

  function busyReasons() {
    var r = [];
    Object.keys(holds).forEach(function (k) { if (holds[k] > 0) r.push(k); });
    if (recording()) r.push('recording');
    if (modalOpen()) r.push('modal');
    if (dirtyField()) r.push('unsaved-text');
    return r;
  }

  function doReload(reason) {
    if (reloaded) return;
    reloaded = true;
    try { console.log('[safe-reload] reloading for new version (' + reason + ')'); } catch (_) {}
    // A 0 ms task break: iOS Safari can freeze on a reload inside
    // controllerchange (offline-manager.js history).
    setTimeout(function () { window.location.reload(); }, 0);
  }

  function showBar() {
    if (bar && bar.isConnected !== false) return;
    bar = document.createElement('div');
    bar.id = 'nbdUpdateBar';
    bar.className = 'nbd-update-bar';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));'
      + 'z-index:10050;display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;'
      + 'background:#1a3057;color:#fff;font:600 14px/1.3 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);';
    var msg = document.createElement('span');
    msg.style.flex = '1';
    msg.textContent = 'New version ready. Finish what you are doing, then tap to reload.';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nbd-update-bar-btn';
    btn.textContent = 'Reload';
    btn.style.cssText = 'min-height:44px;min-width:44px;padding:0 16px;border:0;border-radius:8px;'
      + 'background:#BD5728;color:#fff;font:700 14px system-ui,sans-serif;';
    btn.addEventListener('click', function () { doReload('tapped'); });
    bar.appendChild(msg);
    bar.appendChild(btn);
    (document.body || document.documentElement).appendChild(bar);
  }

  function request(reason) {
    if (reloaded) return 'reloading';
    var busy = busyReasons();
    if (!busy.length) { doReload(reason || 'update'); return 'reloading'; }
    pending = reason || 'update';
    try { console.log('[safe-reload] new version deferred: ' + busy.join(', ')); } catch (_) {}
    showBar();
    return 'deferred';
  }

  // Idle and out of sight: nobody is looking and nothing would be lost.
  document.addEventListener('visibilitychange', function () {
    if (!pending || reloaded) return;
    if (document.visibilityState === 'hidden' && !busyReasons().length) doReload(pending + ':hidden');
  });

  window.NBDSafeReload = {
    request: request,
    hold: function (key) { key = String(key || 'busy'); holds[key] = (holds[key] || 0) + 1; },
    release: function (key) { key = String(key || 'busy'); if (holds[key] > 0) holds[key] -= 1; },
    busyReasons: busyReasons,
    isPending: function () { return !!pending; },
  };
})();
