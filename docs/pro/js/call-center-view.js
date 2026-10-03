/**
 * call-center-view.js — the Call Center view (#/calls), 2026-10-01.
 *
 * Every phone call Jo's phone recorded (Cube ACR → functions/call-center.js
 * → phone_calls), newest first:
 *   - filters: Needs attention / All / Customers / Insurance / Contacts /
 *     Unknown, plus search over name, number, summary and transcript
 *   - each call: who, when, direction, the AI notes (summary, You/They
 *     promises, follow-up, urgent), the transcript, and Play (Storage
 *     getBlob → blob: <audio>, owner-only path — never a download URL)
 *   - actions through the callCenterAction callable (phone_calls is
 *     server-written only): Mark handled / Not handled, Attach to customer,
 *     and New lead (window._saveLead, then attach) for a number the CRM
 *     doesn't know yet
 *
 * "Needs attention" = not handled, not personal, and either Jo promised
 * something, a follow-up date has come, it's urgent, or there's no
 * customer on file.
 *
 * Reads mirror firestore.rules on phone_calls: own userId always, plus
 * companyId for company_admin / manager / viewer. Viewers get no buttons.
 * Lazy bundle 'callcenter' (script-loader.js); goTo('calls') calls init().
 * Styles: css/phone-calls.css (pc-*, cc-*). No inline handlers.
 */
(function () {
  'use strict';
  if (window.NBDCallCenter) return;

  var FUNCTIONS_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
  var STORAGE_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';
  var LIMIT = 300;
  var state = { calls: [], filter: 'attention', q: '', loading: false, loaded: false, error: '', blobUrls: {}, busy: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function claims() { return window._userClaims || {}; }
  function isViewer() { return claims().role === 'viewer'; }
  function todayYmd() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); }
  function fmtPhone(d) {
    var s = String(d || '');
    return /^\d{10}$/.test(s) ? '(' + s.slice(0, 3) + ') ' + s.slice(3, 6) + '-' + s.slice(6) : s;
  }
  function fmtDur(sec) {
    var s = Math.round(Number(sec) || 0);
    return s ? Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's' : '';
  }
  function leadsById() {
    var m = {};
    (window._leads || []).forEach(function (l) { if (l && l.id) m[l.id] = l; });
    return m;
  }
  function leadName(l) { return l ? (((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.address || 'Customer') : ''; }

  // THE rule lives in home-attention.js (callNeedsYou), shared with the Home
  // strip so the two never disagree. The fallback is only for a page without it.
  function needsAttention(c) {
    if (window.NBDHomeAttention && typeof window.NBDHomeAttention.callNeedsYou === 'function') return window.NBDHomeAttention.callNeedsYou(c, Date.now());
    if (c.handledAtMs || c.status === 'personal') return false;
    var mine = (c.promises || []).some(function (p) { return p && p.who === 'jo'; });
    var dueNow = c.followUpDate && c.followUpDate <= todayYmd();
    return !!(mine || dueNow || c.urgent);
  }

  // "Needs attention" is grouped by person (home-attention.js groupNeeds —
  // the same grouping Home and callWatch count). The fallback mirrors it.
  function groupNeeds(rows) {
    var HA = window.NBDHomeAttention;
    if (HA && typeof HA.groupNeeds === 'function') return HA.groupNeeds(rows, Date.now());
    var by = {}, order = [];
    rows.filter(needsAttention).forEach(function (c) {
      var k = c.leadId ? 'lead:' + c.leadId : (c.phoneDigits ? 'num:' + String(c.phoneDigits).slice(-10) : 'id:' + c.id);
      if (!by[k]) { by[k] = { key: k, calls: [] }; order.push(k); }
      by[k].calls.push(c);
    });
    return order.map(function (k) { return by[k]; });
  }

  var FILTERS = [
    ['attention', 'Needs attention', needsAttention],
    ['all', 'All', function () { return true; }],
    ['customer', 'Customers', function (c) { return !!c.leadId; }],
    ['insurance', 'Insurance', function (c) { return c.bucket === 'insurance' || c.callType === 'insurance'; }],
    ['contact', 'Contacts', function (c) { return !c.leadId && c.bucket === 'contact'; }],
    ['unknown', 'Unknown', function (c) { return !c.leadId && c.bucket === 'unknown' && c.channel !== 'text'; }],
    // A day of texts with one person (phone_text_days, AI-noted; 2026-10-02).
    ['texts', 'Texts', function (c) { return c.channel === 'text'; }],
  ];

  async function fetchCalls() {
    var rows = await fetchFrom('phone_calls', 'call');
    var texts = await fetchFrom('phone_text_days', 'text');
    return rows.concat(texts).sort(function (a, b) { return (b.startedAtMs || 0) - (a.startedAtMs || 0); });
  }

  async function fetchFrom(name, channel) {
    var db = window.db, uid = window._user && window._user.uid;
    if (!db || !uid || !window.query) return [];
    var col = window.collection(db, name);
    var c = claims();
    var qs = [window.query(col, window.where('userId', '==', uid), window.orderBy('startedAtMs', 'desc'), window.limit(LIMIT))];
    if (['company_admin', 'manager', 'viewer'].indexOf(c.role || '') !== -1 && c.companyId) {
      qs.push(window.query(col, window.where('companyId', '==', c.companyId), window.orderBy('startedAtMs', 'desc'), window.limit(LIMIT)));
    }
    var byId = {};
    for (var i = 0; i < qs.length; i++) {
      try {
        var snap = await window.getDocs(qs[i]);
        snap.docs.forEach(function (d) { byId[d.id] = Object.assign({}, d.data(), { id: d.id, channel: channel }); });
      } catch (e) {
        console.warn('[call-center] read failed', name, e && e.code);
        if (i === 0 && channel === 'call') state.error = 'Could not load calls (' + ((e && e.code) || 'error') + ').';
      }
    }
    return Object.keys(byId).map(function (k) { return byId[k]; })
      .sort(function (a, b) { return (b.startedAtMs || 0) - (a.startedAtMs || 0); });
  }

  function root() {
    var v = document.querySelector('#view-calls .view-scroll');
    return v;
  }

  function matchesSearch(c, L) {
    var q = state.q.trim().toLowerCase();
    if (!q) return true;
    var digits = q.replace(/\D/g, '');
    var hay = [c.contactName, leadName(L[c.leadId]), c.summary, c.transcript, (c.promises || []).map(function (p) { return p.text; }).join(' ')].join(' ').toLowerCase();
    return hay.indexOf(q) !== -1 || (digits.length >= 3 && String(c.phoneDigits || '').indexOf(digits) !== -1);
  }

  function chip(text, cls) { return '<span class="cc-chip ' + (cls || '') + '">' + esc(text) + '</span>'; }

  // A day of texts: who, how many messages, the AI notes, Handled.
  function renderTextDay(c, L) {
    var lead = c.leadId ? L[c.leadId] : null;
    var who = c.contactName || leadName(lead) || fmtPhone(c.phoneDigits) || 'Unknown number';
    var when = c.startedAtMs ? new Date(c.startedAtMs).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
    var chips = chip('💬 ' + (c.messageCount || 0) + ' text' + (c.messageCount === 1 ? '' : 's')) + (lead ? chip('Customer', 'cc-chip-customer') : '') +
      (c.urgent ? chip('Urgent', 'cc-chip-urgent') : '') + (c.handledAtMs ? chip('Handled', 'cc-chip-done') : '') + (c.status === 'personal' ? chip('Personal', '') : '');
    var promises = (c.promises || []).length ? '<ul class="pc-promises">' + c.promises.map(function (p) {
      return '<li class="pc-promise pc-promise-' + (p.who === 'jo' ? 'jo' : 'them') + '"><span class="pc-promise-who">' + (p.who === 'jo' ? 'You' : 'They') + '</span> ' +
        esc(p.text) + (p.due ? ' <span class="pc-meta">by ' + esc(p.due) + '</span>' : '') + '</li>';
    }).join('') + '</ul>' : '';
    var actions = '';
    if (lead) actions += '<a class="btn btn-ghost pc-play cc-link" href="/pro/customer.html?id=' + encodeURIComponent(c.leadId) + '">Open ' + esc(leadName(lead)) + '</a>';
    if (!isViewer()) actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="' + (c.handledAtMs ? 'unhandled' : 'handled') + '" data-id="' + esc(c.id) + '"' + (state.busy[c.id] ? ' disabled' : '') + '>' + (c.handledAtMs ? 'Not handled' : '✓ Handled') + '</button>';
    return '<div class="panel pc-card cc-card cc-text' + (c.handledAtMs ? ' is-handled' : '') + '" data-call-id="' + esc(c.id) + '">' +
      '<div class="pc-head"><div class="pc-who">' + esc(who) + (c.contactName && c.phoneDigits ? ' <span class="pc-meta">' + esc(fmtPhone(c.phoneDigits)) + '</span>' : '') + '</div>' +
      '<div class="pc-meta">' + esc(when) + '</div></div>' +
      '<div class="pc-chips">' + chips + '</div>' +
      (c.summary ? '<div class="pc-summary">' + esc(c.summary) + '</div>' : '') + promises +
      (c.followUpDate ? '<div class="pc-meta pc-follow">Follow up ' + esc(c.followUpDate) + '</div>' : '') +
      '<div class="pc-actions">' + actions + '</div>' +
      '<div class="pc-meta pc-status" data-cc-status="' + esc(c.id) + '"></div>' +
      '</div>';
  }

  function renderCall(c, L) {
    if (c.channel === 'text') return renderTextDay(c, L);
    var lead = c.leadId ? L[c.leadId] : null;
    var who = c.contactName || leadName(lead) || fmtPhone(c.phoneDigits) || 'Unknown caller';
    var when = c.startedAtMs ? new Date(c.startedAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    var dir = c.direction === 'outbound' ? '↗ You called' : c.direction === 'inbound' ? '↙ They called' : 'Call';
    var bucketLabel = { customer: 'Customer', insurance: 'Insurance', contact: 'Contact', unknown: 'Unknown number' }[c.bucket] || '';
    var chips = chip(dir) + (bucketLabel ? chip(bucketLabel, 'cc-chip-' + esc(c.bucket)) : '') +
      (c.urgent ? chip('Urgent', 'cc-chip-urgent') : '') +
      (c.handledAtMs ? chip('Handled', 'cc-chip-done') : '') +
      (c.status === 'personal' ? chip('Personal', '') : '') +
      ((c.alternateLeadIds || []).length ? chip('Number on ' + (c.alternateLeadIds.length + 1) + ' customers', 'cc-chip-warn') : '');
    var status = c.status === 'noted' || c.status === 'personal' ? '' :
      c.status === 'too_large' ? 'Too long to transcribe automatically.' : c.status === 'short' ? 'Short call (under 15 seconds), not transcribed.' :
      (c.transcribeAttempts ? 'Transcription failed; it will retry.' : 'Notes appear here once it is transcribed.');
    var promises = (c.promises || []).length ? '<ul class="pc-promises">' + c.promises.map(function (p) {
      return '<li class="pc-promise pc-promise-' + (p.who === 'jo' ? 'jo' : 'them') + '"><span class="pc-promise-who">' + (p.who === 'jo' ? 'You' : 'They') + '</span> ' +
        esc(p.text) + (p.due ? ' <span class="pc-meta">by ' + esc(p.due) + '</span>' : '') + '</li>';
    }).join('') + '</ul>' : '';
    var busy = state.busy[c.id];
    var actions = '';
    if (c.storagePath) actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="play" data-id="' + esc(c.id) + '">▶ Play</button>';
    if (lead) actions += '<a class="btn btn-ghost pc-play cc-link" href="/pro/customer.html?id=' + encodeURIComponent(c.leadId) + '">Open ' + esc(leadName(lead)) + '</a>';
    if (!isViewer()) {
      actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="' + (c.handledAtMs ? 'unhandled' : 'handled') + '" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>' + (c.handledAtMs ? 'Not handled' : '✓ Handled') + '</button>';
      if (c.status === 'personal') {
        actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="notpersonal" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>It wasn\'t personal</button>';
      }
      if (!c.leadId) {
        actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="newlead" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>+ New lead</button>' +
          '<button type="button" class="btn btn-ghost pc-play" data-cc="attachopen" data-id="' + esc(c.id) + '">Attach to customer…</button>';
      }
    }
    return '<div class="panel pc-card cc-card' + (c.handledAtMs ? ' is-handled' : '') + '" data-call-id="' + esc(c.id) + '">' +
      '<div class="pc-head"><div class="pc-who">' + esc(who) + (c.contactName && c.phoneDigits ? ' <span class="pc-meta">' + esc(fmtPhone(c.phoneDigits)) + '</span>' : '') + '</div>' +
      '<div class="pc-meta">' + esc(when) + (c.durationSec ? ' · ' + esc(fmtDur(c.durationSec)) : '') + '</div></div>' +
      '<div class="pc-chips">' + chips + '</div>' +
      (c.summary ? '<div class="pc-summary">' + esc(c.summary) + '</div>' : '') + promises +
      (c.followUpDate ? '<div class="pc-meta pc-follow">Follow up ' + esc(c.followUpDate) + '</div>' : '') +
      (status ? '<div class="pc-meta">' + esc(status) + '</div>' : '') +
      '<div class="pc-actions">' + actions + '</div>' +
      '<div class="cc-attach" data-cc-attach="' + esc(c.id) + '" hidden></div>' +
      '<div class="pc-audio" data-cc-audio="' + esc(c.id) + '"></div>' +
      (c.transcript ? '<details class="pc-transcript"><summary>Transcript</summary><div class="pc-transcript-body">' + esc(c.transcript) + '</div></details>' : '') +
      '<div class="pc-meta pc-status" data-cc-status="' + esc(c.id) + '"></div>' +
      '</div>';
  }

  // One person's open calls and text days in one card, newest first, with
  // one ✓ Handled for all of them. A person with a single open call keeps
  // the ordinary call card.
  function renderGroup(g, L) {
    var latest = g.calls[0];
    var lead = latest.leadId ? L[latest.leadId] : null;
    var who = leadName(lead) || latest.contactName || fmtPhone(latest.phoneDigits) || 'Unknown caller';
    var ids = g.calls.map(function (c) { return c.id; });
    var busy = ids.some(function (id) { return state.busy[id]; });
    var bucketLabel = lead ? 'Customer' : ({ insurance: 'Insurance', contact: 'Contact', unknown: 'Unknown number' }[latest.bucket] || '');
    var chips = chip(g.calls.length + ' open') + (bucketLabel ? chip(bucketLabel, 'cc-chip-' + esc(lead ? 'customer' : latest.bucket)) : '') +
      (g.calls.some(function (c) { return c.urgent; }) ? chip('Urgent', 'cc-chip-urgent') : '');
    var items = g.calls.map(function (c) {
      var when = c.startedAtMs ? new Date(c.startedAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      var kind = c.channel === 'text' ? '💬 ' + (c.messageCount || 0) + ' text' + (c.messageCount === 1 ? '' : 's')
        : c.direction === 'outbound' ? '↗ You called' : c.direction === 'inbound' ? '↙ They called' : 'Call';
      var promises = (c.promises || []).length ? '<ul class="pc-promises">' + c.promises.map(function (p) {
        return '<li class="pc-promise pc-promise-' + (p.who === 'jo' ? 'jo' : 'them') + '"><span class="pc-promise-who">' + (p.who === 'jo' ? 'You' : 'They') + '</span> ' +
          esc(p.text) + (p.due ? ' <span class="pc-meta">by ' + esc(p.due) + '</span>' : '') + '</li>';
      }).join('') + '</ul>' : '';
      return '<li class="cc-group-call" data-call-id="' + esc(c.id) + '">' +
        '<div class="pc-meta">' + esc(when) + ' · ' + esc(kind) + (c.durationSec ? ' · ' + esc(fmtDur(c.durationSec)) : '') + (c.urgent ? ' · <b>urgent</b>' : '') + '</div>' +
        (c.summary ? '<div class="pc-summary">' + esc(c.summary) + '</div>' : '') + promises +
        (c.followUpDate ? '<div class="pc-meta pc-follow">Follow up ' + esc(c.followUpDate) + '</div>' : '') +
        (c.storagePath ? '<div class="pc-actions"><button type="button" class="btn btn-ghost pc-play" data-cc="play" data-id="' + esc(c.id) + '">▶ Play</button></div>' +
          '<div class="pc-audio" data-cc-audio="' + esc(c.id) + '"></div><div class="pc-meta pc-status" data-cc-status="' + esc(c.id) + '"></div>' : '') +
        '</li>';
    }).join('');
    var actions = '';
    if (lead) actions += '<a class="btn btn-ghost pc-play cc-link" href="/pro/customer.html?id=' + encodeURIComponent(latest.leadId) + '">Open ' + esc(leadName(lead)) + '</a>';
    if (!isViewer()) {
      actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="handledgroup" data-ids="' + esc(ids.join(',')) + '" data-id="' + esc(latest.id) + '"' + (busy ? ' disabled' : '') + '>✓ Handled (all ' + g.calls.length + ')</button>';
      if (!latest.leadId) {
        actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="newlead" data-ids="' + esc(ids.join(',')) + '" data-id="' + esc(latest.id) + '"' + (busy ? ' disabled' : '') + '>+ New lead</button>' +
          '<button type="button" class="btn btn-ghost pc-play" data-cc="attachopen" data-id="' + esc(latest.id) + '">Attach to customer…</button>';
      }
    }
    return '<div class="panel pc-card cc-card cc-group" data-call-id="' + esc(latest.id) + '" data-group="' + esc(g.key) + '">' +
      '<div class="pc-head"><div class="pc-who">' + esc(who) + (!lead && latest.contactName && latest.phoneDigits ? ' <span class="pc-meta">' + esc(fmtPhone(latest.phoneDigits)) + '</span>' : '') + '</div>' +
      '<div class="pc-meta">' + g.calls.length + ' open · latest ' + esc(latest.startedAtMs ? new Date(latest.startedAtMs).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '') + '</div></div>' +
      '<div class="pc-chips">' + chips + '</div>' +
      '<ul class="cc-group-calls">' + items + '</ul>' +
      '<div class="pc-actions">' + actions + '</div>' +
      '<div class="cc-attach" data-cc-attach="' + esc(latest.id) + '" data-ids="' + esc(ids.join(',')) + '" hidden></div>' +
      '<div class="pc-meta pc-status" data-cc-status="' + esc(latest.id) + '"></div>' +
      '</div>';
  }

  function render() {
    var el = root();
    if (!el) return;
    var L = leadsById();
    var counts = {};
    FILTERS.forEach(function (f) { counts[f[0]] = state.calls.filter(f[2]).length; });
    // Needs attention counts PEOPLE (Jo, 2026-10-02), like Home and the alert.
    counts.attention = groupNeeds(state.calls).length;
    var badge = document.getElementById('callsNavBadge');
    if (badge) { badge.textContent = counts.attention ? String(counts.attention) : ''; badge.classList.toggle('dn', !counts.attention); }
    var active = FILTERS.filter(function (f) { return f[0] === state.filter; })[0] || FILTERS[0];
    var rows = state.calls.filter(active[2]).filter(function (c) { return matchesSearch(c, L); });
    var head = '<div class="page-hdr cc-hdr"><h1 class="cc-title">📞 Call Center</h1>' +
      '<p class="cc-sub">Calls and texts from your phone, filed automatically. AI notes list who promised what. "Needs attention" covers the last 14 days.</p></div>' +
      '<div class="cc-toolbar"><input type="search" class="cc-search" id="ccSearch" placeholder="Search name, number, notes…" aria-label="Search calls" value="' + esc(state.q) + '">' +
      '<div class="cc-filters" role="tablist">' + FILTERS.map(function (f) {
        return '<button type="button" role="tab" class="cc-tab' + (state.filter === f[0] ? ' is-on' : '') + '" aria-selected="' + (state.filter === f[0]) + '" data-cc="filter" data-arg="' + f[0] + '">' +
          esc(f[1]) + ' <span class="cc-count">' + counts[f[0]] + '</span></button>';
      }).join('') + '</div></div>';
    var body;
    if (state.loading && !state.loaded) body = '<div class="cc-empty">Loading calls…</div>';
    else if (state.error && !state.calls.length) body = '<div class="cc-empty">' + esc(state.error) + '</div>';
    else if (!state.calls.length) body = '<div class="cc-empty">No calls yet. Recordings from your phone (Cube ACR) show up here within about 30 minutes of the call.</div>';
    else if (!rows.length) body = '<div class="cc-empty">' + (state.filter === 'attention' && !state.q ? 'Nothing needs you. Every call is handled or filed.' : 'No calls match.') + '</div>';
    else if (state.filter === 'attention') {
      // A person shows when any of their open calls matches the search.
      var hit = {};
      rows.forEach(function (c) { hit[c.id] = true; });
      body = groupNeeds(state.calls).filter(function (g) { return g.calls.some(function (c) { return hit[c.id]; }); })
        .map(function (g) { return g.calls.length === 1 ? renderCall(g.calls[0], L) : renderGroup(g, L); }).join('');
    }
    else body = rows.slice(0, 150).map(function (c) { return renderCall(c, L); }).join('') +
      (rows.length > 150 ? '<div class="cc-empty">Showing the newest 150. Search to narrow it down.</div>' : '');
    var hadFocus = document.activeElement && document.activeElement.id === 'ccSearch';
    el.innerHTML = '<div class="cc-wrap">' + head + '<div class="cc-list">' + body + '</div></div>';
    if (hadFocus) { var s = document.getElementById('ccSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  }

  function status(id, text) {
    var s = document.querySelector('[data-cc-status="' + CSS.escape(id) + '"]');
    if (s) s.textContent = text || '';
  }

  async function callable(name, data) {
    if (!window._functions || !window._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    var res = await window._httpsCallable(window._functions, name)(data);
    return res && res.data;
  }

  function byId(id) { return state.calls.filter(function (c) { return c.id === id; })[0]; }

  async function play(id) {
    var c = byId(id);
    var slot = document.querySelector('[data-cc-audio="' + CSS.escape(id) + '"]');
    if (!c || !slot || !c.storagePath) return;
    if (!state.blobUrls[id]) {
      status(id, 'Loading recording…');
      try {
        var st = await import(STORAGE_SDK);
        var blob = await st.getBlob(st.ref(window.storage, c.storagePath));
        state.blobUrls[id] = URL.createObjectURL(blob);
        status(id, '');
      } catch (e) {
        status(id, 'Could not load the recording' + (e && e.message ? ': ' + e.message : '') + '.');
        return;
      }
    }
    slot.innerHTML = '';
    var a = document.createElement('audio');
    a.controls = true; a.preload = 'auto'; a.src = state.blobUrls[id];
    slot.appendChild(a);
    a.play().catch(function () {});
  }

  async function act(id, action, extra) {
    state.busy[id] = true;
    status(id, 'Saving…');
    try {
      var r = await callable('callCenterAction', Object.assign({ id: id, action: action }, extra || {}));
      var c = byId(id);
      if (c) {
        if (action === 'handled') c.handledAtMs = Date.now();
        if (action === 'unhandled') c.handledAtMs = null;
        if (action === 'attach' && r && r.leadId) { c.leadId = r.leadId; c.bucket = 'customer'; c.alternateLeadIds = []; }
        if (action === 'notpersonal' && r && r.requeued) { c.status = 'stored'; c.notPersonal = true; c.summary = null; }
      }
      delete state.busy[id];
      render();
      if (action === 'notpersonal') status(id, 'Got it. The recording is back and the notes will be redone within about 30 minutes.');
      if (action === 'attach') status(id, 'Filed on the customer' + (r && r.phoneAdded ? '; their number is saved so the next call matches by itself.' : '.'));
      return r;
    } catch (e) {
      delete state.busy[id];
      render();
      status(id, (e && e.message) || 'That did not work.');
      return null;
    }
  }

  // The same action on every call in a person's group (✓ Handled all, or
  // filing all of an unknown number's calls on one customer). Status shows
  // on the group's card (keyed by its newest call).
  async function actMany(ids, action, extra) {
    var lead = ids[0];
    ids.forEach(function (id) { state.busy[id] = true; });
    status(lead, 'Saving ' + ids.length + '…');
    var ok = 0, failed = 0, last = null;
    for (var i = 0; i < ids.length; i++) {
      try {
        last = await callable('callCenterAction', Object.assign({ id: ids[i], action: action }, extra || {}));
        var c = byId(ids[i]);
        if (c && action === 'handled') c.handledAtMs = Date.now();
        if (c && action === 'attach' && last && last.leadId) { c.leadId = last.leadId; c.bucket = 'customer'; c.alternateLeadIds = []; }
        ok++;
      } catch (e) { failed++; }
    }
    ids.forEach(function (id) { delete state.busy[id]; });
    render();
    if (failed) status(lead, ok + ' saved, ' + failed + ' did not — try again.');
    return { ok: ok, failed: failed, last: last };
  }
  function idsOf(b) { return String(b.getAttribute('data-ids') || '').split(',').filter(Boolean); }

  function openAttach(id) {
    var box = document.querySelector('[data-cc-attach="' + CSS.escape(id) + '"]');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; return; }
    var leads = (window._leads || []).filter(function (l) { return l && l.id && !l.deleted; });
    box.innerHTML = '<label class="pc-meta" for="ccAttach-' + esc(id) + '">Type a customer\'s name or address</label>' +
      '<div class="cc-attach-row"><input class="cc-search" id="ccAttach-' + esc(id) + '" list="ccAttachList-' + esc(id) + '" autocomplete="off">' +
      '<button type="button" class="btn btn-orange pc-play" data-cc="attach" data-id="' + esc(id) + '">Attach</button></div>' +
      '<datalist id="ccAttachList-' + esc(id) + '">' + leads.slice(0, 600).map(function (l) {
        return '<option value="' + esc(leadName(l) + ' — ' + (l.address || '') + ' #' + l.id) + '"></option>';
      }).join('') + '</datalist>';
    box.hidden = false;
    var input = box.querySelector('input');
    if (input) input.focus();
  }

  function pickedLeadId(id) {
    var input = document.getElementById('ccAttach-' + id);
    var m = input && /#([A-Za-z0-9_-]{6,})\s*$/.exec(input.value || '');
    return m ? m[1] : '';
  }

  async function newLead(id, moreIds) {
    var c = byId(id);
    if (!c || typeof window._saveLead !== 'function') return;
    state.busy[id] = true; render();
    status(id, 'Creating the lead…');
    try {
      var name = (c.contactName || '').trim();
      var parts = name ? name.split(/\s+/) : [];
      var leadId = await window._saveLead({
        firstName: parts.length ? parts[0] : 'Caller',
        lastName: parts.length > 1 ? parts.slice(1).join(' ') : fmtPhone(c.phoneDigits),
        phone: fmtPhone(c.phoneDigits),
        source: 'Phone call',
        stage: 'new',
        jobType: c.callType === 'insurance' || c.bucket === 'insurance' ? 'insurance' : '',
        notes: c.summary ? 'From a phone call: ' + c.summary : 'From a phone call.',
      });
      delete state.busy[id];
      if (!leadId) { render(); status(id, 'Lead not created.'); return; }
      await act(id, 'attach', { leadId: leadId });
      var rest = (moreIds || []).filter(function (x) { return x !== id; });
      if (rest.length) await actMany(rest, 'attach', { leadId: leadId });
      status(id, 'New lead created and ' + (rest.length ? 'all ' + (rest.length + 1) + ' calls are' : 'the call is') + ' filed on it. Give it a job type on the customer page.');
    } catch (e) {
      delete state.busy[id];
      render();
      status(id, (e && e.message) || 'Could not create the lead.');
    }
  }

  async function load() {
    if (state.loading) return;
    state.loading = true; state.error = '';
    render();
    state.calls = await fetchCalls();
    state.loading = false; state.loaded = true;
    render();
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-cc]') : null;
    if (!b || !b.closest('#view-calls')) return;
    var a = b.getAttribute('data-cc'), id = b.getAttribute('data-id');
    if (a === 'filter') { state.filter = b.getAttribute('data-arg') || 'attention'; render(); }
    else if (a === 'play') play(id);
    else if (a === 'handled' || a === 'unhandled' || a === 'notpersonal') act(id, a);
    else if (a === 'handledgroup') actMany(idsOf(b), 'handled');
    else if (a === 'attachopen') openAttach(id);
    else if (a === 'attach') {
      var leadId = pickedLeadId(id);
      if (!leadId) { status(id, 'Pick a customer from the list.'); return; }
      // From a group card, file every one of that number's open calls.
      var box = document.querySelector('[data-cc-attach="' + CSS.escape(id) + '"]');
      var all = box ? idsOf(box) : [];
      if (all.length > 1) actMany(all, 'attach', { leadId: leadId }).then(function (r) { status(id, r.failed ? '' : 'All ' + r.ok + ' calls filed on the customer.'); });
      else act(id, 'attach', { leadId: leadId });
    }
    else if (a === 'newlead') newLead(id, idsOf(b));
  });
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'ccSearch') { state.q = e.target.value || ''; render(); }
  });

  window.NBDCallCenter = {
    init: function () { load(); },
    reload: load,
    _state: state,
    _needsAttention: needsAttention,
  };
})();
