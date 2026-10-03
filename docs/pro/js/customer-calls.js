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
 * Phone calls (2026-10-01): Jo's own calls recorded by Cube ACR and filed by
 * functions/call-center.js into phone_calls (matched to this lead by phone
 * number) list here too, newest first alongside Thursday's. Their audio sits
 * in Storage calls/{owner}/cube-acr/ (owner-only read) and plays through
 * getBlob → blob: URL, never a download link.
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
  // Texts from Jo's phone (functions/text-inbox.js → phone_texts), 2026-10-01.
  var texts = [];
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
    var sources = [['thursday_calls', 'thursday'], ['phone_calls', 'phone']];
    for (var k = 0; k < sources.length; k++) {
      for (var i = 0; i < scopes.length; i++) {
        try {
          var q = window.query.apply(null, [window.collection(db, sources[k][0])].concat(scopes[i]));
          var snap = await window.getDocs(q);
          snap.docs.forEach(function (d) { byId[sources[k][1] + ':' + d.id] = Object.assign({ _id: d.id, _kind: sources[k][1] }, d.data()); });
        } catch (e) {
          console.warn('[calls] read failed', sources[k][0], e && e.code);
        }
      }
    }
    return Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) {
      return callTime(b) - callTime(a);
    });
  }

  function callTime(c) {
    if (c._kind === 'phone') return Number(c.startedAtMs) || 0;
    var d = toDate(c.startedAt) || toDate(c.createdAt);
    return d ? d.getTime() : 0;
  }
  function fmtPhone(d) {
    var s = String(d || '');
    return /^\d{10}$/.test(s) ? '(' + s.slice(0, 3) + ') ' + s.slice(3, 6) + '-' + s.slice(6) : s;
  }

  function chip(text, bg, fg) {
    return '<span style="display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:999px;background:' +
      bg + ';color:' + fg + ';margin-right:4px;">' + esc(text) + '</span>';
  }

  var TYPE_LABEL = {
    new_lead: 'New lead', existing_customer: 'Existing customer', adjuster: 'Adjuster', supplier_sub: 'Supplier / sub',
    job_seeker: 'Job seeker', spam: 'Spam', test: 'Test', silent: 'Silent', unknown: 'Needs review',
  };

  // A Cube ACR call: Jo's own phone, either direction.
  function renderPhoneCall(c) {
    var id = 'phone:' + c._id;
    var when = c.startedAtMs ? new Date(c.startedAtMs) : null;
    var dir = c.direction === 'outbound' ? '↗ Outgoing' : c.direction === 'inbound' ? '↙ Incoming' : 'Call';
    var chips = chip(dir, 'var(--s3,rgba(255,255,255,.08))', 'var(--m,#9ca3af)');
    if ((c.alternateLeadIds || []).length) chips += chip('Number on ' + (c.alternateLeadIds.length + 1) + ' customers', '#78350f', '#fde68a');
    var who = c.contactName || fmtPhone(c.phoneDigits) || 'Phone call';
    var summary = c.summary || (c.transcript ? '' : c.status === 'short' ? 'Short call (under 15 seconds).' : 'Recorded on your phone. Notes appear here once it is transcribed.');
    if (c.urgent) chips += chip('Urgent', '#7f1d1d', '#fecaca');
    // AI notes (functions/call-center.js stage 2): who promised what.
    var promises = Array.isArray(c.promises) ? c.promises : [];
    var promisesHtml = promises.length ? '<ul class="pc-promises">' + promises.map(function (p) {
      return '<li class="pc-promise pc-promise-' + (p.who === 'jo' ? 'jo' : 'them') + '"><span class="pc-promise-who">' + (p.who === 'jo' ? 'You' : 'They') + '</span> ' +
        esc(p.text) + (p.due ? ' <span class="pc-meta">by ' + esc(p.due) + '</span>' : '') + '</li>';
    }).join('') + '</ul>' : '';
    if (c.followUpDate) promisesHtml += '<div class="pc-meta pc-follow">Follow up ' + esc(c.followUpDate) + '</div>';
    if (c.handledAtMs) chips += chip('Handled', '#14532d', '#bbf7d0');
    // ✓ Handled and "Wrong customer → move to…" (2026-10-03) go through the
    // callCenterAction callable (phone_calls is server-written; the move
    // re-checks both customers are in the caller's company).
    var acts = c.storagePath ? '<button type="button" class="btn pc-play" data-calls-act="play" data-call-id="' + esc(id) + '">▶ Play recording</button>' : '';
    if (!isViewer()) {
      acts += '<button type="button" class="btn pc-play" data-calls-act="' + (c.handledAtMs ? 'pc-unhandled' : 'pc-handled') + '" data-call-id="' + esc(id) + '">' + (c.handledAtMs ? 'Not handled' : '✓ Handled') + '</button>' +
        '<button type="button" class="btn pc-play" data-calls-act="pc-moveopen" data-call-id="' + esc(id) + '">Wrong customer → move to…</button>';
    }
    // Styled by css/phone-calls.css (no inline style attributes).
    return '<div class="panel pc-card" data-call-card="' + esc(id) + '">' +
      '<div class="pc-head">' +
        '<div class="pc-who">📱 ' + esc(who) + '</div>' +
        '<div class="pc-meta">' + esc(when ? when.toLocaleString() : '') + '</div>' +
      '</div>' +
      '<div class="pc-chips">' + chips + '</div>' +
      (summary ? '<div class="pc-summary">' + esc(summary) + '</div>' : '') + promisesHtml +
      (acts ? '<div class="pc-actions">' + acts + '</div>' : '') +
      '<div class="pc-move" data-calls-move="' + esc(id) + '" hidden></div>' +
      '<div class="pc-audio" data-calls-audio="' + esc(id) + '"></div>' +
      (c.transcript ? '<details class="pc-transcript"><summary>Transcript</summary>' +
        '<div class="pc-transcript-body">' + esc(c.transcript) + '</div></details>' : '') +
      '<div class="pc-meta pc-status" data-calls-status="' + esc(id) + '"></div>' +
    '</div>';
  }

  function renderCall(c) {
    if (c._kind === 'phone') return renderPhoneCall(c);
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

  async function fetchTexts(leadId) {
    var db = window.db, uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
    if (!db || !uid || !window.orderBy || !window.limit) return [];
    try {
      var q = window.query(window.collection(db, 'phone_texts'), window.where('leadId', '==', leadId), window.where('userId', '==', uid),
        window.orderBy('sentAtMs', 'desc'), window.limit(80));
      var snap = await window.getDocs(q);
      return snap.docs.map(function (d) { return Object.assign({}, d.data(), { _id: d.id }); }).reverse();
    } catch (e) {
      console.warn('[calls] texts read failed', e && e.code);
      return [];
    }
  }

  // The phone's text thread with this customer, oldest → newest, newest in view.
  function renderTexts() {
    if (!texts.length) return '';
    var lastDay = '';
    var rows = texts.map(function (t) {
      var d = t.sentAtMs ? new Date(t.sentAtMs) : null;
      var day = d ? d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      var sep = day && day !== lastDay ? '<div class="pt-day">' + esc(day) + '</div>' : '';
      lastDay = day || lastDay;
      return sep + '<div class="pt-msg pt-' + (t.direction === 'outbound' ? 'out' : 'in') + '">' +
        '<div class="pt-body">' + esc(t.body || '') + '</div>' +
        '<div class="pt-time">' + esc(d ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '') + (t.group ? ' · group' : '') + '</div></div>';
    }).join('');
    return '<details class="panel pt-panel" open><summary class="pt-summary">💬 Texts from your phone <span class="pc-meta">' + texts.length + (texts.length >= 80 ? '+ (newest 80)' : '') + '</span></summary>' +
      '<div class="pt-thread" data-pt-thread>' + rows + '</div></details>';
  }

  function render() {
    var el = root();
    if (!el) return;
    if (typeof window.nbdNavCount === 'function') window.nbdNavCount('navCountCalls', calls.length + (texts.length ? 1 : 0));
    var top = notice ? '<div class="panel pc-notice" data-calls-notice>' + esc(notice) +
      (noticeLead ? ' <a class="cc-link" href="/pro/customer.html?id=' + encodeURIComponent(noticeLead) + '">Open them →</a>' : '') + '</div>' : '';
    if (!calls.length && !texts.length) {
      el.innerHTML = top + '<div style="color:var(--m);font-size:13px;text-align:center;padding:24px 12px;">No calls yet. Calls Thursday answers, and calls recorded on your phone, show up here with the recording.</div>';
      return;
    }
    el.innerHTML = top + renderTexts() + calls.map(renderCall).join('');
    var th = el.querySelector('[data-pt-thread]');
    if (th) th.scrollTop = th.scrollHeight;
  }

  function status(callId, text) {
    var s = document.querySelector('[data-calls-status="' + CSS.escape(callId) + '"]');
    if (s) s.textContent = text;
  }

  async function play(callId) {
    var slot = document.querySelector('[data-calls-audio="' + CSS.escape(callId) + '"]');
    if (!slot) return;
    if (!blobUrls[callId] && callId.indexOf('phone:') === 0) {
      status(callId, 'Loading recording…');
      try {
        var pc = calls.find(function (c) { return c._kind === 'phone' && 'phone:' + c._id === callId; });
        var st = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js');
        var blob = await st.getBlob(st.ref(window.storage, pc.storagePath));
        blobUrls[callId] = URL.createObjectURL(blob);
        status(callId, '');
      } catch (e) {
        status(callId, 'Could not load the recording' + (e && e.message ? ': ' + e.message : '') + '.');
        return;
      }
    }
    if (!blobUrls[callId]) {
      status(callId, 'Loading recording…');
      try {
        // Streamed in parts (5 MB each; a 10-minute WAV is two).
        var chunks = [], type = 'audio/mpeg', parts = 1;
        for (var part = 0; part < parts; part++) {
          var r = await callable('getThursdayRecording', { callId: callId, part: part });
          parts = r.parts || 1;
          type = r.contentType || type;
          var bin = atob(r.base64);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          chunks.push(bytes);
          if (parts > 1) status(callId, 'Loading recording… ' + (part + 1) + '/' + parts);
        }
        blobUrls[callId] = URL.createObjectURL(new Blob(chunks, { type: type }));
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

  // ── A phone call on this customer: ✓ Handled, or move it to the right one ──
  function phoneCall(id) { return calls.find(function (c) { return c._kind === 'phone' && 'phone:' + c._id === id; }); }
  function leadLabel(l) { return (((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.address || 'Customer'); }
  var moveLeads = null; // this tenant's customers, read once on the first "move" tap
  async function loadMoveLeads() {
    if (moveLeads) return moveLeads;
    var db = window.db, uid = window.auth && window.auth.currentUser && window.auth.currentUser.uid;
    var c = claims();
    var qs = [window.query(window.collection(db, 'leads'), window.where('userId', '==', uid))];
    if (['company_admin', 'manager'].indexOf(c.role || '') !== -1 && c.companyId) qs.push(window.query(window.collection(db, 'leads'), window.where('companyId', '==', c.companyId)));
    var byId = {};
    for (var i = 0; i < qs.length; i++) {
      try { (await window.getDocs(qs[i])).docs.forEach(function (d) { var v = d.data() || {}; if (v.deleted !== true) byId[d.id] = Object.assign({ id: d.id }, v); }); }
      catch (e) { console.warn('[calls] leads read failed', e && e.code); }
    }
    moveLeads = Object.keys(byId).map(function (k) { return byId[k]; }).sort(function (a, b) { return leadLabel(a).localeCompare(leadLabel(b)); });
    return moveLeads;
  }
  async function openMove(id) {
    var box = document.querySelector('[data-calls-move="' + CSS.escape(id) + '"]');
    var pc = phoneCall(id);
    if (!box || !pc) return;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    box.innerHTML = '<div class="pc-meta">Loading your customers…</div>';
    var here = window._customerId;
    var all = (await loadMoveLeads()).filter(function (l) { return l.id !== here; });
    var byId = {};
    all.forEach(function (l) { byId[l.id] = l; });
    // The other customers this number is on come first (the ingest's alternates).
    var alts = (pc.alternateLeadIds || []).filter(function (x) { return byId[x]; });
    box.innerHTML = (alts.length ? '<div class="pc-meta">This number is also on:</div><div class="pc-move-picks">' + alts.map(function (x) {
      return '<button type="button" class="btn pc-play" data-calls-act="pc-move" data-call-id="' + esc(id) + '" data-lead="' + esc(x) + '">Move to ' + esc(leadLabel(byId[x])) + '</button>';
    }).join('') + '</div>' : '') +
      '<label class="pc-meta" for="pcMove-' + esc(pc._id) + '">Type the right customer\'s name or address</label>' +
      '<div class="cc-attach-row"><input class="cc-search" id="pcMove-' + esc(pc._id) + '" list="pcMoveList-' + esc(pc._id) + '" autocomplete="off">' +
      '<button type="button" class="btn btn-orange pc-play" data-calls-act="pc-move" data-call-id="' + esc(id) + '">Move</button></div>' +
      '<datalist id="pcMoveList-' + esc(pc._id) + '">' + all.slice(0, 800).map(function (l) {
        return '<option value="' + esc(leadLabel(l) + ' — ' + (l.address || '') + ' #' + l.id) + '"></option>';
      }).join('') + '</datalist>';
    var input = box.querySelector('input');
    if (input) input.focus();
  }
  var notice = '';
  async function moveCall(id, b) {
    var pc = phoneCall(id);
    if (!pc) return;
    var to = b.getAttribute('data-lead');
    if (!to) {
      var input = document.getElementById('pcMove-' + pc._id);
      var m = input && /#([A-Za-z0-9_-]{6,})\s*$/.exec(input.value || '');
      to = m ? m[1] : '';
    }
    if (!to) { status(id, 'Pick a customer from the list.'); return; }
    var name = (moveLeads || []).filter(function (l) { return l.id === to; }).map(leadLabel)[0] || 'the other customer';
    b.disabled = true;
    status(id, 'Moving…');
    try {
      await callable('callCenterAction', { id: pc._id, action: 'move', leadId: to });
      notice = 'Moved the ' + (pc.startedAtMs ? new Date(pc.startedAtMs).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' : '') + 'call to ' + name + ', with its notes and follow-up task.';
      noticeLead = to;
      await load();
    } catch (e) {
      b.disabled = false;
      status(id, (e && e.message) || 'Could not move it — try again.');
    }
  }
  var noticeLead = '';
  async function setHandled(id, on) {
    var pc = phoneCall(id);
    if (!pc) return;
    status(id, 'Saving…');
    try {
      await callable('callCenterAction', { id: pc._id, action: on ? 'handled' : 'unhandled' });
      pc.handledAtMs = on ? Date.now() : null;
      render();
    } catch (e) {
      status(id, (e && e.message) || 'That did not save.');
    }
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-calls-act]') : null;
    if (!b) return;
    var id = b.getAttribute('data-call-id');
    var a = b.getAttribute('data-calls-act');
    if (a === 'pc-handled' || a === 'pc-unhandled') { setHandled(id, a === 'pc-handled'); return; }
    if (a === 'pc-moveopen') { openMove(id); return; }
    if (a === 'pc-move') { moveCall(id, b); return; }
    if (a === 'play') play(id);
    else if (a === 'confirm') act(id, 'confirm_match');
    else if (a === 'not-them') act(id, 'create_lead');
  });

  async function load() {
    var leadId = window._customerId;
    if (!leadId) return;
    var both = await Promise.all([fetchCalls(leadId), fetchTexts(leadId)]);
    calls = both[0];
    texts = both[1];
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
