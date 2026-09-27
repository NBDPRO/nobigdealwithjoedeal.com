/**
 * customer-calls.js — "Calls" section on the customer card (2026-09-26).
 *
 * Lists the Thursday (Bland AI receptionist) calls attached to this lead:
 * when, how long, what the caller wanted, URGENT / possible-match chips, the
 * transcript, and the recording. Server side: functions/integrations/thursday.js
 * (vault: documentation/architecture/THURSDAY-BLAND-2026-09-26.md).
 *
 *   - Reads thursday_calls with the repo's two-scope shape (own userId always;
 *     companyId added for company_admin / manager / viewer), matching the
 *     firestore.rules read on that collection.
 *   - The recording is never a URL: getThursdayRecording streams it as base64,
 *     played from a blob: URL (CSP media-src 'self' blob:).
 *   - A possible-match call shows "Yes, it's them" / "Not them — new lead",
 *     which go through the thursdayCallAction callable (viewers are refused
 *     there; the buttons are hidden for them here too).
 *
 * No inline handlers (CSP script-src-attr 'none'): one delegated listener.
 */
(function () {
  'use strict';

  var LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (LOADED['customer-calls']) return;
  LOADED['customer-calls'] = true;
  if (!/\/pro\/customer(?:\.html)?$/.test(window.location.pathname || '')) return;

  var FUNCTIONS_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
  var calls = [];
  var blobUrls = {};

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function toDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtDur(sec) {
    var s = Math.max(0, Math.round(Number(sec) || 0));
    return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  }
  function claims() { return window._userClaims || {}; }
  function isViewer() { return claims().role === 'viewer'; }

  async function callable(name, data) {
    if (!window._functions || !window._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    var res = await window._httpsCallable(window._functions, name)(data);
    return res && res.data;
  }

  function root() { return document.getElementById('callsList'); }

  async function fetchCalls(leadId) {
    var db = window.db, auth = window.auth;
    var uid = auth && auth.currentUser && auth.currentUser.uid;
    if (!db || !uid) return [];
    var c = claims();
    var scopes = [[window.where('leadId', '==', leadId), window.where('userId', '==', uid)]];
    if (['company_admin', 'manager', 'viewer'].indexOf(c.role || '') !== -1 && c.companyId) {
      scopes.push([window.where('leadId', '==', leadId), window.where('companyId', '==', c.companyId)]);
    }
    var byId = {};
    for (var i = 0; i < scopes.length; i++) {
      try {
        var q = window.query.apply(null, [window.collection(db, 'thursday_calls')].concat(scopes[i]));
        var snap = await window.getDocs(q);
        snap.docs.forEach(function (d) { byId[d.id] = Object.assign({ _id: d.id }, d.data()); });
      } catch (e) {
        console.warn('[calls] read failed', e && e.code);
      }
    }
    return Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) {
      var ta = toDate(a.startedAt) || toDate(a.createdAt) || new Date(0);
      var tb = toDate(b.startedAt) || toDate(b.createdAt) || new Date(0);
      return tb - ta;
    });
  }

  function chip(text, bg, fg) {
    return '<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:' +
      bg + ';color:' + fg + ';margin-right:4px;">' + esc(text) + '</span>';
  }

  var TYPE_LABEL = {
    new_lead: 'New lead', existing_customer: 'Existing customer', adjuster: 'Adjuster', supplier_sub: 'Supplier / sub',
    job_seeker: 'Job seeker', spam: 'Spam', test: 'Test', silent: 'Silent', unknown: 'Needs review',
  };

  function renderCall(c) {
    var when = toDate(c.startedAt) || toDate(c.createdAt);
    var ex = c.extraction || {};
    var callId = c.callId || String(c._id || '').replace(/^bland_calls__/, '');
    // The caller-type chip only adds information when it is not implied by the
    // route: a possible match or an attach is not a 'New lead' on this card.
    var action = c.route && c.route.action;
    var showType = !(c.callerType === 'new_lead' && action !== 'create_lead');
    var chips = showType ? chip(TYPE_LABEL[c.callerType] || 'Call', 'var(--s3,rgba(255,255,255,.08))', 'var(--m,#9ca3af)') : '';
    if (c.urgent) chips += chip('Urgent', '#7f1d1d', '#fecaca');
    var possible = action === 'possible_match';
    if (possible) chips += chip('Possible match', '#78350f', '#fde68a');
    if (c.status === 'failed') chips += chip('Needs review', '#7f1d1d', '#fecaca');

    var facts = [];
    if (ex.callback_number) facts.push('📱 ' + esc(ex.callback_number.replace(/(\d{3})(\d{3})(\d{4})/, '($1) $2-$3')));
    else if (c.from) facts.push('📱 ' + esc(c.from));
    if (ex.callback_window) facts.push('🕑 ' + esc(ex.callback_window));
    if (ex.insurance && ex.insurance.involved === 'yes') {
      facts.push('🛡 ' + esc(ex.insurance.carrier || 'Insurance') + (ex.insurance.claim_filed === 'yes' ? ' · claim filed' : ''));
    }
    if (ex.heard_about_us) facts.push('🔎 ' + esc(ex.heard_about_us));

    var actions = '';
    if (c.recordingPath) {
      actions += '<button type="button" class="btn" data-calls-act="play" data-call-id="' + esc(callId) + '">▶ Play recording</button>';
    }
    if (possible && !isViewer()) {
      actions += '<button type="button" class="btn btn-orange" data-calls-act="confirm" data-call-id="' + esc(callId) + '">Yes, it\'s them</button>' +
        '<button type="button" class="btn" data-calls-act="not-them" data-call-id="' + esc(callId) + '">Not them — new lead</button>';
    }

    var transcript = (c.call && c.call.transcript) || '';
    return '<div class="panel" style="margin-bottom:12px;padding:14px 16px;" data-call-card="' + esc(callId) + '">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;">' +
        '<div style="font-weight:700;">📞 ' + esc(ex.caller_name || c.callerName || 'Caller') + '</div>' +
        '<div style="font-size:12px;color:var(--m);">' + esc(when ? when.toLocaleString() : '') + ' · ' + esc(fmtDur(c.durationSec)) + '</div>' +
      '</div>' +
      '<div style="margin:6px 0;">' + chips + '</div>' +
      '<div style="font-size:14px;line-height:1.45;">' + esc(c.issue || (c.call && c.call.summary) || 'No summary yet.') + '</div>' +
      (ex.urgent_reason ? '<div style="font-size:13px;color:#fca5a5;margin-top:4px;">' + esc(ex.urgent_reason) + '</div>' : '') +
      (facts.length ? '<div style="font-size:12px;color:var(--m);margin-top:6px;display:flex;flex-wrap:wrap;gap:10px;">' + facts.join('') + '</div>' : '') +
      (actions ? '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;">' + actions + '</div>' : '') +
      '<div data-calls-audio="' + esc(callId) + '" style="margin-top:8px;"></div>' +
      (transcript ? '<details style="margin-top:8px;"><summary style="cursor:pointer;font-size:12px;color:var(--m);">Transcript</summary>' +
        '<div style="white-space:pre-wrap;font-size:13px;line-height:1.5;margin-top:6px;max-height:320px;overflow-y:auto;">' + esc(transcript) + '</div></details>' : '') +
      '<div data-calls-status="' + esc(callId) + '" style="font-size:12px;color:var(--m);margin-top:6px;"></div>' +
    '</div>';
  }

  function render() {
    var el = root();
    if (!el) return;
    if (typeof window.nbdNavCount === 'function') window.nbdNavCount('navCountCalls', calls.length);
    if (!calls.length) {
      el.innerHTML = '<div style="color:var(--m);font-size:13px;text-align:center;padding:24px 12px;">No calls yet. When Thursday answers a call from this customer it shows up here with the summary, transcript and recording.</div>';
      return;
    }
    el.innerHTML = calls.map(renderCall).join('');
  }

  function status(callId, text) {
    var s = document.querySelector('[data-calls-status="' + CSS.escape(callId) + '"]');
    if (s) s.textContent = text;
  }

  async function play(callId) {
    var slot = document.querySelector('[data-calls-audio="' + CSS.escape(callId) + '"]');
    if (!slot) return;
    if (!blobUrls[callId]) {
      status(callId, 'Loading recording…');
      try {
        var r = await callable('getThursdayRecording', { callId: callId });
        var bin = atob(r.base64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        blobUrls[callId] = URL.createObjectURL(new Blob([bytes], { type: r.contentType || 'audio/mpeg' }));
        status(callId, '');
      } catch (e) {
        status(callId, 'Could not load the recording' + (e && e.message ? ': ' + e.message : '') + '.');
        return;
      }
    }
    slot.innerHTML = '';
    var audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'auto';
    audio.style.width = '100%';
    audio.src = blobUrls[callId];
    slot.appendChild(audio);
    audio.play().catch(function () { /* user can press play */ });
  }

  async function act(callId, action) {
    var call = calls.find(function (c) { return (c.callId || '') === callId; }) || {};
    var leadId = window._customerId;
    var data = { callId: callId, action: action };
    if (action === 'confirm_match') data.leadId = leadId;
    status(callId, 'Working…');
    try {
      var r = await callable('thursdayCallAction', data);
      if (action === 'create_lead' && r && r.leadId) {
        status(callId, 'New lead created — opening it…');
        window.location.href = '/pro/customer.html?id=' + encodeURIComponent(r.leadId);
        return;
      }
      status(callId, action === 'confirm_match' ? 'Confirmed — the call is attached to this customer.' : 'Done.');
      await load();
    } catch (e) {
      status(callId, (e && e.message) || 'That did not work.');
    }
    return call;
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-calls-act]') : null;
    if (!b) return;
    var id = b.getAttribute('data-call-id');
    var a = b.getAttribute('data-calls-act');
    if (a === 'play') play(id);
    else if (a === 'confirm') act(id, 'confirm_match');
    else if (a === 'not-them') act(id, 'create_lead');
  });

  async function load() {
    var leadId = window._customerId;
    if (!leadId) return;
    calls = await fetchCalls(leadId);
    render();
  }

  // The bootstrap module sets window.db / auth / _customerId asynchronously;
  // wait for all three (max ~30 s) rather than racing it.
  var tries = 0;
  (function wait() {
    var ready = window.db && window.auth && window.auth.currentUser && window._customerId && window.getDocs && window.collection;
    if (ready) { load(); return; }
    if (++tries < 100) setTimeout(wait, 300);
  })();
  window.addEventListener('nbd:data-refreshed', function () { load(); });
})();
