/**
 * prod-flags-panel.js — Settings -> Access -> "Live feature flags".
 * READ-ONLY readout of the env flags the deployed functions are really running
 * with (2026-10-13, Jo: "we need to figure out how to see the prod flags").
 * Owner / admin / company_admin only; everyone else sees nothing. Data is the
 * `flagStatus` callable (functions/handlers/integrations.js) - the server
 * re-checks the role. There is NO write path in this file: no toggles.
 *
 * Renders into #prodFlagsMount when the 'access' Settings tab opens
 * (switchSettingsTab is wrapped, the away-mode-settings.js pattern).
 * No inline handlers: one delegated click listener scoped to the mount.
 * Every server string goes through esc() before innerHTML.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.NBDProdFlags && window.NBDProdFlags.__v === 1) return;

  var seq = 0;
  var S = null;   // { data } | { error } | { denied }

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
    });
  };
  function claims() { return window._userClaims || {}; }
  function uid() { return (window._user && window._user.uid) || null; }
  // Client-side hide only (the callable is the real gate): admin / company_admin,
  // or the company's own owner (companyId === uid, or a solo owner with no role).
  function canSee() {
    var c = claims(), r = String(c.role || '').toLowerCase();
    if (!uid()) return false;
    if (r === 'admin' || r === 'company_admin') return true;
    if (c.companyId) return c.companyId === uid() && r !== 'viewer';
    return !r;
  }

  var CHIP = { ON: 'pf-on', OFF: 'pf-off', PAUSED: 'pf-paused', TEST: 'pf-test' };

  function rowHtml(f) {
    var state = String(f.state || 'OFF');
    var cls = CHIP[state] || 'pf-off';
    var hints = '';
    if (f.dark && state === 'OFF') {
      hints += '<div class="pf-hint pf-dark">Dark — needs Jo’s go</div>';
    }
    if (f.drift === true) {
      hints += '<div class="pf-hint pf-drift">Deployed file says <b>' + esc(f.committed) + '</b>, running says <b>' + esc(f.effective) + '</b></div>';
    }
    return '<li class="pf-row">' +
      '<div class="pf-top"><span class="pf-name">' + esc(f.name) + '</span>' +
      '<span class="pf-chip ' + cls + '">' + esc(state) + '</span></div>' +
      '<div class="pf-meaning">' + esc(f.meaning) + '</div>' +
      hints +
      '<div class="pf-meta">value: ' + esc(f.effective) + (f.file ? ' · ' + esc(f.file) : '') + '</div>' +
      '</li>';
  }

  // Pure: model -> HTML. Exposed for tests.
  function renderHtml(model) {
    if (!model) return '<div class="pf-note">Loading live flags…</div>';
    if (model.denied) return '';
    if (model.error) {
      return '<div class="pf-fail"><div class="pf-fail-t">Could not load the flags — this is not an all-clear.</div>' +
        '<div class="pf-meta">' + esc(model.error) + '</div>' +
        '<button type="button" class="pf-btn" data-pf="reload">Try again</button></div>';
    }
    var d = model.data || {};
    var flags = Array.isArray(d.flags) ? d.flags : [];
    var groups = Array.isArray(d.groups) ? d.groups.slice() : [];
    flags.forEach(function (f) { if (groups.indexOf(f.group) < 0) groups.push(f.group); });
    var n = { ON: 0, OFF: 0, PAUSED: 0, TEST: 0, drift: 0 };
    flags.forEach(function (f) { if (n[f.state] != null) n[f.state]++; if (f.drift === true) n.drift++; });
    var out = '<div class="pf-head">' +
      '<div class="pf-sum">' + esc(flags.length) + ' flags · ' + esc(n.ON) + ' on · ' + esc(n.OFF) + ' off · ' +
      esc(n.PAUSED) + ' paused' + (n.TEST ? ' · ' + esc(n.TEST) + ' test' : '') +
      (n.drift ? ' · <b class="pf-drift-n">' + esc(n.drift) + ' differ from the deployed file</b>' : '') + '</div>' +
      '<button type="button" class="pf-btn" data-pf="reload">Refresh</button></div>';
    if (d.committedAvailable === false) {
      out += '<div class="pf-note">The deployed env file could not be read, so “differs from file” is unknown.</div>';
    }
    groups.forEach(function (g) {
      var rows = flags.filter(function (f) { return f.group === g; });
      if (!rows.length) return;
      out += '<section class="pf-group"><h4 class="pf-gt">' + esc(g) + '</h4><ul class="pf-list">' +
        rows.map(rowHtml).join('') + '</ul></section>';
    });
    out += '<div class="pf-meta">Read-only. Values come from the running functions’ own environment' +
      (d.revision ? ' (revision ' + esc(d.revision) + ')' : '') +
      '. Changing one is a committed edit to functions/.env.nobigdeal-pro.</div>';
    return out;
  }

  function render() {
    var mount = document.getElementById('prodFlagsMount');
    if (!mount) return;
    if (!canSee()) { mount.innerHTML = ''; return; }
    var body = renderHtml(S);
    mount.innerHTML = body
      ? '<div class="panel mb-md"><div class="panel-hdr"><div><div class="panel-label">Owner / admin only</div>' +
        '<div class="panel-title">Live feature flags</div></div></div><div class="panel-body">' + body + '</div></div>'
      : '';
  }

  function callable() {
    // Same lazy import integrations-client.js uses (reuses window._functions).
    if (window._functions && window._httpsCallable) return window._httpsCallable(window._functions, 'flagStatus');
    return import('/assets/vendor/firebase/10.12.2/firebase-functions.js').then(function (mod) {
      window._functions = window._functions || mod.getFunctions();
      window._httpsCallable = window._httpsCallable || mod.httpsCallable;
      return mod.httpsCallable(window._functions, 'flagStatus');
    });
  }

  function load() {
    var my = ++seq;
    if (!document.getElementById('prodFlagsMount') || !canSee()) return;
    if (!S) render();
    return Promise.resolve(callable()).then(function (fn) { return fn({}); }).then(function (res) {
      if (my !== seq) return;
      S = { data: (res && res.data) || {} };
      render();
    }, function (e) {
      if (my !== seq) return;
      var code = e && e.code ? String(e.code) : '';
      S = /permission-denied/.test(code) ? { denied: true } : { error: (e && e.message) || 'error' };
      render();
    });
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('#prodFlagsMount [data-pf]') : null;
    if (!t) return;
    if (t.getAttribute('data-pf') === 'reload') { S = null; load(); }
  });

  function installTabHook() {
    var prev = window.switchSettingsTab;
    if (typeof prev !== 'function') return false;
    if (prev.__pfWrapped) return true;
    var wrapped = function (tab) {
      var out = prev.apply(this, arguments);
      if (tab === 'access') load();
      return out;
    };
    Object.keys(prev).forEach(function (k) { try { wrapped[k] = prev[k]; } catch (_) { /* read-only flag */ } });
    wrapped.__pfWrapped = true;
    window.switchSettingsTab = wrapped;
    var panel = document.getElementById('stab-panel-access');
    if (panel && panel.style && panel.style.display === 'block' && !seq) load();
    return true;
  }
  function boot() {
    if (installTabHook()) return;
    var tries = 0;
    var iv = setInterval(function () { if (installTabHook() || ++tries > 120) clearInterval(iv); }, 500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDProdFlags = { __v: 1, load: load, render: render, renderHtml: renderHtml, _set: function (s) { S = s; render(); } };
})();
