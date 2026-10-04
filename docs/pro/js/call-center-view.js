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

  // ── Matching a caller to a customer (2026-10-03) ─────────────────────
  // Last-10 digits, the same key the server files by (phone-utils.js).
  function digits10(v) { var d = String(v || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? d : ''; }
  // Leads made from a call screen this session, by number — so a second
  // card for the same caller can't make a second lead before _leads refreshes.
  var madeLeads = {};
  /** The customer this number is already on, or null. Never creates. */
  function leadForNumber(num) {
    var d = digits10(num);
    if (!d) return null;
    var hits = (window._leads || []).filter(function (l) {
      return l && l.id && !l.deleted && [l.phoneDigits, l.phone, l.phone2, l.altPhone, l.mobilePhone, l.secondaryPhone].some(function (p) { return digits10(p) === d; });
    });
    var hit = hits[0];
    // A number on 3+ customers is a proxy line (functions/call-center-logic.js
    // proxyNumbers): it says nothing about who this caller is.
    if (hit && hits.length < 3) return { leadId: hit.id, name: leadName(hit) };
    if (hit) return null;
    return madeLeads[d] || null;
  }
  /**
   * "File on X" for a call on no customer: the customer its number is
   * already on (a sure thing), else the one the notes point at (stored by
   * the server as suggestedLeadId when the notes were written). Never
   * filed by itself — the card offers it, Jo taps it.
   */
  function fileTarget(c) {
    if (!c || c.leadId || c.channel === 'text') return null;
    var byNum = leadForNumber(c.phoneDigits);
    if (byNum) return { leadId: byNum.leadId, name: byNum.name, why: 'this number is already on them' };
    if (!c.suggestedLeadId) return null;
    var L = leadsById(), l = L[c.suggestedLeadId], any = Object.keys(L).length;
    if (any && (!l || l.deleted)) return null;
    return { leadId: c.suggestedLeadId, name: l ? leadName(l) : (c.suggestedLeadName || 'the customer'), why: c.suggestedWhy || '' };
  }
  // A phone contact Jo tagged "NBD Customer" that no lead carries.
  function taggedNotInCrm(c) { return !!(c && !c.leadId && c.channel !== 'text' && (c.tags || []).indexOf('customer') !== -1); }
  // The one-tap row on a card: "Looks like X — why. [File on X]", or for a
  // tagged contact on no lead, "Not in CRM yet — [＋ Make lead]".
  function fileRow(c, ids) {
    if (!c || isViewer() || c.leadId || c.channel === 'text') return '';
    var t = fileTarget(c);
    var idsAttr = ids && ids.length > 1 ? ' data-ids="' + esc(ids.join(',')) + '"' : '';
    if (t) {
      return '<div class="cc-suggest" data-cc-suggest="' + esc(c.id) + '"><span>Looks like <b>' + esc(t.name) + '</b>' + (t.why ? ' — ' + esc(t.why) : '') + '.</span>' +
        '<button type="button" class="btn btn-orange pc-play cc-suggest-btn" data-ccp="suggest" data-id="' + esc(c.id) + '" data-lead="' + esc(t.leadId) + '" data-name="' + esc(t.name) + '"' + idsAttr + '>File on ' + esc(t.name) + '</button></div>';
    }
    if (taggedNotInCrm(c)) {
      return '<div class="cc-suggest cc-suggest-new" data-cc-suggest="' + esc(c.id) + '"><span>Tagged “NBD Customer” in your phone — not in the CRM yet.</span>' +
        '<button type="button" class="btn btn-orange pc-play cc-suggest-btn" data-ccp="newlead" data-id="' + esc(c.id) + '"' + idsAttr + '>＋ Make lead</button></div>';
    }
    return '';
  }

  // THE rule lives in home-attention.js (callNeedsYou), shared with the Home
  // strip so the two never disagree. The fallback is only for a page without it.
  // Who Jo has reached since a missed call (home-attention.js reachIndex),
  // rebuilt whenever the call list is reloaded.
  var reach = { rows: null, ctx: null };
  function reachCtx() {
    var HA = window.NBDHomeAttention;
    if (!HA || typeof HA.reachIndex !== 'function') return null;
    if (reach.rows !== state.calls) { reach.rows = state.calls; reach.ctx = HA.reachIndex(state.calls); }
    return reach.ctx;
  }
  function needsAttention(c) {
    if (window.NBDHomeAttention && typeof window.NBDHomeAttention.callNeedsYou === 'function') return window.NBDHomeAttention.callNeedsYou(c, Date.now(), reachCtx());
    if (c.handledAtMs || c.status === 'personal' || c.taskDone === true || c.callType === 'spam') return false;
    var mine =(c.promises || []).some(function (p) { return p && p.who === 'jo'; });
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

  // Call / Text straight from a card (2026-10-03): the call's number, else
  // the customer's. Plain tel: / sms: links — no handler needed.
  function telOf(c, lead) {
    var d = String((c && c.phoneDigits) || '').replace(/\D/g, '').slice(-10);
    if (d.length !== 10 && lead) d = String(lead.phone || lead.altPhone || '').replace(/\D/g, '').slice(-10);
    return d.length === 10 ? '+1' + d : '';
  }
  function reachButtons(c, lead) {
    var t = telOf(c, lead);
    if (!t) return '';
    return '<a class="btn btn-ghost pc-play cc-reach" href="tel:' + t + '" data-cc-reach="call">📞 Call</a>' +
      '<a class="btn btn-ghost pc-play cc-reach" href="sms:' + t + '" data-cc-reach="text">💬 Text</a>';
  }
  function reachMenu(c, lead) {
    var t = telOf(c, lead);
    return t ? [{ label: '📞 Call', href: 'tel:' + t }, { label: '💬 Text', href: 'sms:' + t }] : [];
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
    var actions = reachButtons(c, lead);
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
    var actions = reachButtons(c, lead);
    if (c.storagePath) actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="play" data-id="' + esc(c.id) + '">▶ Play</button>';
    if (lead) actions += '<a class="btn btn-ghost pc-play cc-link" href="/pro/customer.html?id=' + encodeURIComponent(c.leadId) + '">Open ' + esc(leadName(lead)) + '</a>';
    if (!isViewer()) {
      actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="' + (c.handledAtMs ? 'unhandled' : 'handled') + '" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>' + (c.handledAtMs ? 'Not handled' : '✓ Handled') + '</button>';
      if (c.status === 'personal') {
        actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="notpersonal" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>It wasn\'t personal</button>';
      }
      if (!c.leadId) {
        // No "+ New lead" when the number is already a customer's (that's
        // a duplicate — the File on row above offers them instead).
        actions += (leadForNumber(c.phoneDigits) || taggedNotInCrm(c) ? '' : '<button type="button" class="btn btn-ghost pc-play" data-cc="newlead" data-id="' + esc(c.id) + '"' + (busy ? ' disabled' : '') + '>+ New lead</button>') +
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
      fileRow(c) +
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
    var actions = reachButtons(latest, lead);
    // Filing goes through a CALL (texts are matched by the text ingest; the
    // server re-files the number's texts with it).
    var anchor = g.calls.filter(function (c) { return c.channel !== 'text'; })[0] || null;
    var withTarget = g.calls.filter(function (c) { return fileTarget(c); })[0] || anchor;
    if (lead) actions += '<a class="btn btn-ghost pc-play cc-link" href="/pro/customer.html?id=' + encodeURIComponent(latest.leadId) + '">Open ' + esc(leadName(lead)) + '</a>';
    if (!isViewer()) {
      actions += '<button type="button" class="btn btn-ghost pc-play" data-cc="handledgroup" data-ids="' + esc(ids.join(',')) + '" data-id="' + esc(latest.id) + '"' + (busy ? ' disabled' : '') + '>✓ Handled (all ' + g.calls.length + ')</button>';
      if (!latest.leadId && anchor) {
        actions += (leadForNumber(anchor.phoneDigits) || taggedNotInCrm(anchor) ? '' : '<button type="button" class="btn btn-ghost pc-play" data-cc="newlead" data-ids="' + esc(ids.join(',')) + '" data-id="' + esc(anchor.id) + '"' + (busy ? ' disabled' : '') + '>+ New lead</button>') +
          '<button type="button" class="btn btn-ghost pc-play" data-cc="attachopen" data-id="' + esc(anchor.id) + '">Attach to customer…</button>';
      }
    }
    return '<div class="panel pc-card cc-card cc-group" data-call-id="' + esc(latest.id) + '" data-group="' + esc(g.key) + '">' +
      '<div class="pc-head"><div class="pc-who">' + esc(who) + (!lead && latest.contactName && latest.phoneDigits ? ' <span class="pc-meta">' + esc(fmtPhone(latest.phoneDigits)) + '</span>' : '') + '</div>' +
      '<div class="pc-meta">' + g.calls.length + ' open · latest ' + esc(latest.startedAtMs ? new Date(latest.startedAtMs).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '') + '</div></div>' +
      '<div class="pc-chips">' + chips + '</div>' +
      '<ul class="cc-group-calls">' + items + '</ul>' +
      (latest.leadId ? '' : fileRow(withTarget, ids)) +
      '<div class="pc-actions">' + actions + '</div>' +
      '<div class="cc-attach" data-cc-attach="' + esc((anchor || latest).id) + '" data-ids="' + esc(ids.join(',')) + '" hidden></div>' +
      '<div class="pc-meta pc-status" data-cc-status="' + esc((anchor || latest).id) + '"></div>' +
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
      '<p class="cc-sub">Calls and texts from your phone, filed automatically. AI notes list who promised what. "Needs attention" covers the last 14 days.</p>' +
      (counts.attention && !isViewer() && window.NBDTriageDeck ? '<button type="button" class="btn btn-orange pc-play cc-deck-btn" data-cc="deck">One at a time (' + counts.attention + ')</button>' : '') +
      (promises.items.length && !isViewer() && window.NBDTriageDeck ? ' <button type="button" class="btn btn-orange pc-play cc-deck-btn" data-cc="promises">Said you\'d do (' + groupPromises(promises.items).length + ')</button>' : '') +
      // Owner only (the callable refuses anyone else; promises.denied = not the owner).
      (promises.loaded && !promises.denied && !isViewer() ? ' <button type="button" class="btn btn-ghost pc-play cc-deck-btn" data-cc="tagmatch">Match my tagged contacts</button>' : '') +
      '</div>' + tagPanel() +
      '<div class="cc-toolbar"><input type="search" class="cc-search" id="ccSearch" placeholder="Search name, number, notes…" aria-label="Search calls" value="' + esc(state.q) + '">' +
      '<div class="cc-filters" role="tablist">' + FILTERS.map(function (f) {
        return '<button type="button" role="tab" class="cc-tab' + (state.filter === f[0] ? ' is-on' : '') + '" aria-selected="' + (state.filter === f[0]) + '" data-cc="filter" data-arg="' + f[0] + '">' +
          esc(f[1]) + ' <span class="cc-count">' + counts[f[0]] + '</span></button>';
      }).join('') + '</div></div>';
    var body;
    if (!state.loaded) body = '<div class="cc-empty">Loading calls…</div>';
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
    focusedCard();
    if (hadFocus) { var s = document.getElementById('ccSearch'); if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
  }

  function status(id, text) {
    var k = CSS.escape(id);
    document.querySelectorAll('[data-cc-status="' + k + '"],[data-ccp-status="' + k + '"]').forEach(function (s) { s.textContent = text || ''; });
  }

  // What attach did on the server, mirrored here: the call, and every other
  // call / day of texts from its number still on no customer (refileNumber).
  function mirrorFiled(id, leadId) {
    var c = byId(id);
    var p0 = promises.items.filter(function (x) { return x.callId === id; })[0];
    var num = digits10((c && c.phoneDigits) || (p0 && p0.phoneDigits));
    state.calls.forEach(function (x) {
      if (x.id === id || (num && !x.leadId && digits10(x.phoneDigits) === num)) { x.leadId = leadId; x.bucket = 'customer'; x.alternateLeadIds = []; }
    });
    promises.items.forEach(function (x) {
      if (x.callId === id || (num && !x.leadId && digits10(x.phoneDigits) === num)) { x.leadId = leadId; x.suggest = null; }
    });
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
        if (action === 'attach' && r && r.leadId) mirrorFiled(id, r.leadId);
        if (action === 'notpersonal' && r && r.requeued) { c.status = 'stored'; c.notPersonal = true; c.summary = null; }
      }
      delete state.busy[id];
      render();
      if (action === 'notpersonal') status(id, 'Got it. The recording is back and the notes will be redone within about 30 minutes.');
      if (action === 'attach') status(id, 'Filed on the customer' + refiledText(r) + (r && r.phoneAdded ? '; their number is saved so the next call matches by itself.' : '.'));
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
        if (c && action === 'attach' && last && last.leadId) mirrorFiled(ids[i], last.leadId);
        ok++;
      } catch (e) { failed++; }
    }
    ids.forEach(function (id) { delete state.busy[id]; });
    render();
    if (failed) status(lead, ok + ' saved, ' + failed + ' did not — try again.');
    return { ok: ok, failed: failed, last: last };
  }
  function idsOf(b) { return String(b.getAttribute('data-ids') || '').split(',').filter(Boolean); }
  function refiledText(r) {
    var f = r && r.refiled, n = f ? (Number(f.calls) || 0) + (Number(f.textDays) || 0) : 0;
    return n ? ' (plus ' + n + ' more from this number)' : '';
  }

  // One at a time (Jo, 2026-10-02): the Needs attention people as a deck —
  // swipe right = everything open for that person is handled (saved right
  // away, Undo puts it back), left = later, ⋯ = open the customer.
  function deckCard(g) {
    var L = leadsById();
    var latest = g.calls[0];
    var lead = latest.leadId ? L[latest.leadId] : null;
    var who = leadName(lead) || latest.contactName || fmtPhone(latest.phoneDigits) || 'Unknown caller';
    return '<div class="deck-name">' + esc(who) + '</div>' +
      '<div class="deck-sub">' + g.calls.length + ' open' + (lead ? ' · customer' : (latest.phoneDigits && who !== fmtPhone(latest.phoneDigits) ? ' · ' + esc(fmtPhone(latest.phoneDigits)) : '')) +
        (g.calls.some(function (c) { return c.urgent; }) ? ' · <b>urgent</b>' : '') + '</div>' +
      g.calls.map(function (c) {
        var when = c.startedAtMs ? new Date(c.startedAtMs).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        var kind = c.channel === 'text' ? '💬 texts' : c.direction === 'outbound' ? '↗ you called' : '↙ they called';
        var mine = (c.promises || []).filter(function (p) { return p && p.who === 'jo'; });
        return '<div class="deck-why"><div class="deck-sub">' + esc(when) + ' · ' + esc(kind) + '</div>' +
          (c.summary ? '<div>' + esc(c.summary) + '</div>' : '') +
          (mine.length ? '<div class="deck-big">You: ' + mine.map(function (p) { return esc(p.text); }).join(' · ') + '</div>' : '') +
          (c.followUpDate ? '<div class="deck-sub">Follow up ' + esc(c.followUpDate) + '</div>' : '') + '</div>';
      }).join('') + deckFileRow(g.calls);
  }
  // "Looks like X" / "Not in CRM yet" on a deck card for a caller on no
  // customer, through one of their CALLS (texts can't be attached).
  function deckFileRow(calls) {
    if (!calls.length || calls[0].leadId) return '';
    var anchor = calls.filter(function (c) { return fileTarget(c); })[0] || calls.filter(function (c) { return c.channel !== 'text'; })[0];
    var row = anchor ? fileRow(anchor) : '';
    return row ? row + '<div class="deck-sub" data-ccp-status="' + esc(anchor.id) + '"></div>' : '';
  }
  function openDeck() {
    if (!window.NBDTriageDeck) return;
    var groups = groupNeeds(state.calls).map(function (g) { return Object.assign({ id: g.key }, g); });
    window.NBDTriageDeck.open({
      id: 'calls-attention',
      title: 'Needs attention',
      items: groups,
      card: deckCard,
      right: function (g) {
        var ids = g.calls.map(function (c) { return c.id; });
        return {
          label: g.calls.length > 1 ? 'Handled (all ' + g.calls.length + ')' : 'Handled',
          act: async function () {
            var r = await actMany(ids, 'handled');
            if (r.failed) throw new Error(r.failed + ' did not save — try again.');
            return { undo: async function () { await actMany(ids, 'unhandled'); ids.forEach(function (id) { var c = byId(id); if (c) c.handledAtMs = null; }); render(); } };
          },
        };
      },
      left: { label: 'Later' },
      more: function (g) {
        var latest = g.calls[0];
        var lead = latest.leadId ? leadsById()[latest.leadId] : null;
        return reachMenu(latest, lead).concat(latest.leadId ? [{ label: 'Open customer ↗', href: '/pro/customer.html?id=' + encodeURIComponent(latest.leadId) }] : []);
      },
      doneText: 'Nothing needs you. Every call is handled or filed.',
      onClose: function () { render(); },
    });
  }

  // ── "Said you'd do" (2026-10-03) ─────────────────────────────────────
  // The twice-daily email's list, worked one at a time. Same server logic as
  // the email (callPromisesList → gatherSweep), uncapped. Right = Done (ticks
  // the call's follow-up task, or marks a call with no customer handled);
  // Left = Later; ⋯ = snooze 1 / 3 / 7 days, call or text them, open the
  // customer, mark the whole call handled. A call with no customer gets a
  // "file on a customer" picker on its card. Every action has an Undo.
  // The email links here: dashboard.html?open=promises[&item=<callId>]#calls.
  var promises = { items: [], counts: null, loaded: false, denied: false, loading: false };

  async function loadPromises() {
    if (promises.loading || promises.denied || isViewer()) return;
    promises.loading = true;
    try {
      var r = await callable('callPromisesList', {});
      promises.items = (r && r.items) || [];
      promises.counts = (r && r.counts) || null;
      promises.loaded = true;
    } catch (e) {
      if (e && /permission-denied/.test(e.code || e.message || '')) promises.denied = true;
    }
    promises.loading = false;
    render();
  }

  // Said-you'd-do cards are grouped by CALLER (2026-10-03): two open calls
  // from one number used to be two cards, and "Make this a lead" on each
  // made two leads. One card per customer / number; Done ticks them all.
  function promiseKey(p) {
    if (p.leadId) return 'lead:' + p.leadId;
    var d = digits10(p.phoneDigits);
    return d ? 'num:' + d : 'id:' + p.callId;
  }
  function groupPromises(items) {
    var by = {}, order = [];
    (items || []).forEach(function (p) {
      var k = promiseKey(p);
      if (!by[k]) { by[k] = { key: k, items: [] }; order.push(k); }
      by[k].items.push(p);
    });
    // The deck card's id is its most pressing call (the email's deep links
    // and the deck's own bookkeeping name calls, not callers).
    return order.map(function (k) { return Object.assign(by[k], { id: by[k].items[0].callId }); });
  }

  function promiseLabel(p) {
    return p.kind === 'urgent' ? 'Urgent' : p.kind === 'due' ? 'Due ' + p.due : 'No customer on file' + (p.due ? ' · ' + p.due : '');
  }
  function promiseCard(g) {
    var L = leadsById();
    var first = g.items[0];
    var lead = first.leadId ? L[first.leadId] : null;
    var many = g.items.length > 1;
    var leads = (window._leads || []).filter(function (l) { return l && l.id && !l.deleted; });
    // Filing goes through one of the caller's CALLS; the server files the
    // rest of the number's calls and texts with it.
    var anchor = g.items.filter(function (p) { return p.channel !== 'text'; })[0] || null;
    var withSuggest = g.items.filter(function (p) { return p.suggest; })[0];
    var byNum = anchor ? leadForNumber(anchor.phoneDigits) : null;
    var target = byNum ? { leadId: byNum.leadId, name: byNum.name, why: 'this number is already on them' }
      : (withSuggest ? withSuggest.suggest : (anchor ? fileTarget(byId(anchor.callId)) : null));
    var isLead = g.items.some(function (p) { return p.callType === 'lead'; });
    var tagged = g.items.some(function (p) { return taggedNotInCrm(byId(p.callId)); });
    var subType = g.items.map(function (p) { return p.callType; }).filter(function (t) { return t === 'sub' || t === 'supplier'; })[0];
    var open = !first.leadId && anchor && !isViewer();
    return '<div class="deck-sub' + (first.kind === 'urgent' ? ' deck-urgent' : '') + '">' + esc(promiseLabel(first)) + (many ? ' · ' + g.items.length + ' open' : '') + '</div>' +
      '<div class="deck-name">' + esc(lead ? leadName(lead) : first.who) + '</div>' +
      g.items.map(function (p) {
        var when = p.startedAtMs ? new Date(p.startedAtMs).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        return '<div class="cc-deck-item" data-ccp-item="' + esc(p.callId) + '">' +
          '<div class="deck-sub">' + esc((p.channel === 'text' ? 'Texts · ' : 'Call · ') + when) + (many ? ' · ' + esc(promiseLabel(p)) : '') + '</div>' +
          (p.promises && p.promises.length ? '<div class="deck-big">You said: ' + p.promises.map(esc).join(' · ') + '</div>' : '') +
          (p.summary ? '<div class="deck-why">' + esc(p.summary) + '</div>' : '') + '</div>';
      }).join('') +
      // One-tap fixes for a caller with no customer (2026-10-03): the one
      // existing customer it matches, or — for a prospect — a new lead.
      (open && target ? '<div class="cc-deck-hint">Looks like <b>' + esc(target.name) + '</b> — ' + esc(target.why) + '.</div>' +
        '<button type="button" class="btn btn-orange pc-play cc-deck-one" data-ccp="suggest" data-id="' + esc(anchor.callId) + '" data-lead="' + esc(target.leadId) + '" data-name="' + esc(target.name) + '">File on ' + esc(target.name) + '</button>' : '') +
      (open && !target && (isLead || tagged) ? '<div class="cc-deck-hint">' + (tagged ? 'Tagged “NBD Customer” in your phone — not in the CRM yet.' : '🆕 Sounds like a new lead — not in the CRM yet.') + '</div>' +
        '<button type="button" class="btn btn-orange pc-play cc-deck-one" data-ccp="newlead" data-id="' + esc(anchor.callId) + '">＋ Make this a lead</button>' : '') +
      (!first.leadId && subType ? '<div class="cc-deck-hint">' + (subType === 'sub' ? 'A sub' : 'A supplier') + ' — not a customer. Mark it done when it\'s done.</div>' : '') +
      (open ? '<div class="cc-attach-row cc-deck-attach">' +
        '<input class="cc-search" id="ccpAttach-' + esc(anchor.callId) + '" list="ccpAttachList" autocomplete="off" placeholder="File on a customer…" aria-label="File this call on a customer">' +
        '<button type="button" class="btn btn-ghost pc-play" data-ccp="attach" data-id="' + esc(anchor.callId) + '">File</button></div>' +
        '<div class="deck-sub" data-ccp-status="' + esc(anchor.callId) + '"></div>' +
        '<datalist id="ccpAttachList">' + leads.slice(0, 600).map(function (l) {
          return '<option value="' + esc(leadName(l) + ' — ' + (l.address || '') + ' #' + l.id) + '"></option>';
        }).join('') + '</datalist>' : '');
  }

  // The same action on every item of a caller's card; undo reverses them all.
  function eachItem(g, pick) {
    return async function () {
      var done = [];
      for (var i = 0; i < g.items.length; i++) {
        var on = pick(g.items[i]);
        if (!on) continue;
        await callable('callCenterAction', Object.assign({ id: g.items[i].callId, action: on[0] }, on[2] || {}));
        done.push([g.items[i].callId, on[1]]);
      }
      return { undo: async function () { for (var j = 0; j < done.length; j++) await callable('callCenterAction', { id: done[j][0], action: done[j][1] }); } };
    };
  }
  function snoozeOpt(g, days, label) {
    return { label: label, act: eachItem(g, function () { return ['snooze', 'unsnooze', { days: days }]; }) };
  }

  function openPromiseDeck(startId) {
    if (!window.NBDTriageDeck) return;
    var items = groupPromises(promises.items);
    if (startId) {
      var i = items.findIndex(function (g) { return g.items.some(function (p) { return p.callId === startId; }); });
      if (i > 0) items.unshift(items.splice(i, 1)[0]);
    }
    window.NBDTriageDeck.open({
      id: 'calls-promises',
      title: 'Said you\'d do',
      items: items,
      card: promiseCard,
      right: function (g) {
        if (isViewer()) return null;
        var tasks = g.items.every(function (p) { return p.hasTask; });
        return {
          label: g.items.length > 1 ? '✓ Done (all ' + g.items.length + ')' : (tasks ? '✓ Done' : '✓ Handled'),
          act: eachItem(g, function (p) { return p.hasTask ? ['taskDone', 'taskUndone'] : ['handled', 'unhandled']; }),
        };
      },
      left: { label: 'Later' },
      more: function (g) {
        var p = g.items[0];
        var out = [];
        if (!isViewer()) out.push(snoozeOpt(g, 1, '💤 Tomorrow'), snoozeOpt(g, 3, '💤 In 3 days'), snoozeOpt(g, 7, '💤 Next week'));
        if (p.phoneDigits) {
          var tel = '+1' + String(p.phoneDigits).replace(/\D/g, '').slice(-10);
          out.push({ label: '📞 Call', href: 'tel:' + tel }, { label: '💬 Text', href: 'sms:' + tel });
        }
        if (p.leadId) out.push({ label: 'Open customer ↗', href: '/pro/customer.html?id=' + encodeURIComponent(p.leadId) });
        if (g.items.some(function (x) { return x.hasTask; }) && !isViewer()) {
          out.push({
            label: g.items.length > 1 ? 'Mark all these calls handled' : 'Mark the whole call handled',
            act: eachItem(g, function (x) { return x.hasTask ? ['handled', 'unhandled'] : null; }),
          });
        }
        return out;
      },
      doneText: 'That\'s everything you said you\'d do. Nice.',
      onClose: function () { promises.loaded = false; loadPromises(); load(); },
    });
  }

  // ── One way to file a caller or make them a lead, on every call screen ──
  // (main cards, both decks; 2026-10-03). Filing never happens by itself:
  // every path is a tap. A lead is never made for a number that is already
  // a customer's — that offers "File on <name>" instead.
  function callInfo(id) {
    var c = byId(id);
    var p = promises.items.filter(function (x) { return x.callId === id; })[0];
    if (c) {
      return { phoneDigits: c.phoneDigits, contactName: c.contactName, summary: c.summary, callType: c.callType || '',
        promises: (c.promises || []).filter(function (x) { return x && x.who === 'jo'; }).map(function (x) { return x.text; }),
        insurance: c.callType === 'insurance' || c.bucket === 'insurance' };
    }
    if (p) return { phoneDigits: p.phoneDigits, contactName: p.contactName, summary: p.summary, callType: p.callType || '', promises: p.promises || [], insurance: p.callType === 'insurance' };
    return null;
  }
  async function leadFromCall(info) {
    var have = leadForNumber(info.phoneDigits);
    if (have) return { existing: have };
    if (typeof window._saveLead !== 'function') throw new Error('Leads are still loading — try again in a moment.');
    var name = String(info.contactName || '').replace(/\bNBD\b|\blead\b/gi, ' ').replace(/\s+/g, ' ').trim();
    var parts = name ? name.split(/\s+/) : [];
    var data = {
      firstName: parts.length ? parts[0] : 'Caller',
      lastName: parts.length > 1 ? parts.slice(1).join(' ') : fmtPhone(info.phoneDigits),
      phone: fmtPhone(info.phoneDigits),
      source: 'Phone call',
      stage: 'new',
      notes: (info.summary ? 'From a phone call: ' + info.summary : 'From a phone call.') + (info.promises && info.promises.length ? '\nYou said you would: ' + info.promises.join('; ') : ''),
    };
    if (info.insurance) data.jobType = 'insurance';
    var leadId = await window._saveLead(data);
    if (!leadId) return { leadId: null };
    var d = digits10(info.phoneDigits);
    if (d) madeLeads[d] = { leadId: leadId, name: (data.firstName + ' ' + data.lastName).trim() };
    return { leadId: leadId };
  }
  async function fileOn(id, leadId) {
    var r = await callable('callCenterAction', { id: id, action: 'attach', leadId: leadId });
    mirrorFiled(id, leadId);
    return r;
  }
  // A "File on X" / "Make lead" tap, wherever it sits (the decks are an
  // overlay outside #view-calls). Status lands on every slot for the call.
  document.addEventListener('click', async function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ccp="suggest"],[data-ccp="newlead"]') : null;
    if (!b) return;
    var id = b.getAttribute('data-id');
    var info = callInfo(id);
    if (!info) return;
    var inView = !!b.closest('#view-calls');
    var after = inView ? '' : ' Swipe it done when it\'s done.';
    b.disabled = true;
    try {
      if (b.getAttribute('data-ccp') === 'suggest') {
        var name = b.getAttribute('data-name') || 'the customer';
        var r = await fileOn(id, b.getAttribute('data-lead'));
        if (inView) render();
        status(id, 'Filed on ' + name + refiledText(r) + '.' + after);
      } else {
        status(id, 'Creating the lead…');
        var made = await leadFromCall(info);
        if (made.existing) {
          // Already a customer: offer them instead of a duplicate lead.
          b.setAttribute('data-ccp', 'suggest');
          b.setAttribute('data-lead', made.existing.leadId);
          b.setAttribute('data-name', made.existing.name);
          b.textContent = 'File on ' + made.existing.name;
          b.disabled = false;
          status(id, 'This number is already on ' + made.existing.name + ' — no new lead made. File it on them?');
          return;
        }
        if (!made.leadId) throw new Error('Lead not created.');
        var r2 = await fileOn(id, made.leadId);
        if (inView) render();
        status(id, 'New lead created and the call' + refiledText(r2) + ' filed on it — it\'s in your pipeline with a follow-up task.');
      }
      // Gone, not [hidden]: .btn's display rule beats the hidden attribute,
      // and a second tap must not be on offer.
      b.hidden = true;
      if (b.remove) b.remove();
    } catch (err) {
      status(id, (err && err.message) || 'That did not save — try again.');
      b.disabled = false;
    }
  });

  // "File on a customer" on a deck card (the deck overlay sits outside #view-calls).
  document.addEventListener('click', async function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-ccp="attach"]') : null;
    if (!b) return;
    var id = b.getAttribute('data-id');
    var input = document.getElementById('ccpAttach-' + id);
    var m = /#([A-Za-z0-9_-]{5,})\s*$/.exec((input && input.value) || '');
    var out = document.querySelector('[data-ccp-status="' + CSS.escape(id) + '"]');
    if (!m) { if (out) out.textContent = 'Pick a customer from the list.'; return; }
    b.disabled = true;
    try {
      var r = await fileOn(id, m[1]);
      if (out) out.textContent = 'Filed on the customer' + refiledText(r) + '. Swipe it done when it\'s done.';
    } catch (err) {
      if (out) out.textContent = (err && err.message) || 'Could not file it — try again.';
    }
    b.disabled = false;
  });

  // Deep link from the email: ?open=promises[&item=<callId>].
  // One call's card (2026-10-03): ?call=<callId> — the urgent push, callWatch
  // with one person, the sweep email's names. Opens the tab the call shows
  // on (Needs attention when it is still open, else All), scrolls its card
  // into view and marks it (.cc-focus). Pure part exported for the test.
  function focusTarget(calls, id, needs) {
    var c = (calls || []).filter(function (x) { return x && x.id === id; })[0];
    if (!c) return null;
    return { call: c, filter: needs(c) ? 'attention' : 'all' };
  }
  // The opened card keeps its mark through later re-renders (render() calls this).
  function focusedCard() {
    if (!state.focusId) return null;
    var row = document.querySelector('#view-calls [data-call-id="' + CSS.escape(state.focusId) + '"]');
    var card = row && row.closest('.cc-card');
    if (card) card.classList.add('cc-focus');
    return card;
  }
  function focusCall(id) {
    var tries = 0, refetch = 0;
    (function wait() {
      if (!state.loaded) { if (++tries <= 80) setTimeout(wait, 250); return; }
      var t = focusTarget(state.calls, id, needsAttention);
      // A cold-boot read can come back from the empty local cache (Firestore
      // still connecting): read again a few times before giving up.
      if (!t) {
        if (++refetch <= 4) setTimeout(function () { load().then(wait); }, 1500);
        return;
      }
      state.filter = t.filter; state.q = ''; state.focusId = id;
      render();
      var card = focusedCard();
      if (!card) return;
      try { card.scrollIntoView({ block: 'start' }); } catch (_) { card.scrollIntoView(); }
    })();
  }

  function deepLink() {
    var q;
    try { q = new URLSearchParams(window.location.search); } catch (_) { return; }
    var callId = q.get('call') || '';
    if (callId && /^[A-Za-z0-9_-]{5,140}$/.test(callId)) {
      try {
        q.delete('call');
        var left = q.toString();
        history.replaceState(null, '', window.location.pathname + (left ? '?' + left : '') + window.location.hash);
      } catch (_) {}
      focusCall(callId);
      return;
    }
    if (q.get('open') !== 'promises') return;
    var item = q.get('item') || '';
    try {
      q.delete('open'); q.delete('item');
      var rest = q.toString();
      history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : '') + window.location.hash);
    } catch (_) {}
    // Wait out the boot splash (#nbd-loader, z-index 99999) too, or the deck
    // opens underneath it on a cold start from the email.
    var splashGone = function () {
      var l = document.getElementById('nbd-loader');
      if (!l) return true;
      var cs = getComputedStyle(l);
      return cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0;
    };
    var tries = 0;
    (function wait() {
      if (promises.loaded && window.NBDTriageDeck && splashGone()) return openPromiseDeck(item);
      if (promises.denied || ++tries > 60) return;
      setTimeout(wait, 250);
    })();
  }

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

  // "+ New lead" on a main card. Never a second lead for a number that is
  // already a customer's (leadFromCall); one attach files the number's other
  // calls and texts with it (server: refileNumber).
  async function newLead(id) {
    var info = callInfo(id);
    if (!info) return;
    state.busy[id] = true; render();
    status(id, 'Creating the lead…');
    try {
      var made = await leadFromCall(info);
      delete state.busy[id];
      if (made.existing) { render(); status(id, 'This number is already on ' + made.existing.name + ' — no new lead made. Tap File on ' + made.existing.name + '.'); return; }
      if (!made.leadId) { render(); status(id, 'Lead not created.'); return; }
      var r = await act(id, 'attach', { leadId: made.leadId });
      status(id, 'New lead created and the call' + refiledText(r) + ' filed on it. Give it a job type on the customer page.');
    } catch (e) {
      delete state.busy[id];
      render();
      status(id, (e && e.message) || 'Could not create the lead.');
    }
  }

  // ── "Match my tagged contacts" (owner, 2026-10-03) ──────────────────
  // Calls to phone contacts Jo tagged "NBD Customer" that sit on no
  // customer: a preview first (callTaggedMatch {} writes nothing), each row
  // tickable, then one confirm tap files only the ticked rows.
  function tagPanel() {
    var t = state.tag;
    if (!t) return '';
    var body;
    if (t.loading) body = '<div class="pc-meta">Looking through your tagged contacts…</div>';
    else if (t.error) body = '<div class="pc-meta">' + esc(t.error) + '</div>';
    else if (t.done) body = '<div class="pc-meta">' + esc(t.done) + '</div>';
    else {
      var on = t.rows.filter(function (r) { return !t.off[r.key]; }).length;
      body = (t.rows.length ? '<ul class="cc-tag-list">' + t.rows.map(function (r, i) {
        return '<li><label class="cc-tag-row" for="ccTag-' + i + '"><input type="checkbox" id="ccTag-' + i + '" data-cc-tag="' + esc(r.key) + '"' + (t.off[r.key] ? '' : ' checked') + '>' +
          '<span><b>' + esc(r.contactName || fmtPhone(r.phoneDigits)) + '</b> (' + r.callIds.length + ' call' + (r.callIds.length === 1 ? '' : 's') + ') → <b>' + esc(r.leadName) + '</b>' +
          '<span class="pc-meta"> — ' + esc(r.why) + '</span></span></label></li>';
      }).join('') + '</ul>' : '<div class="pc-meta">No tagged contact matches a customer.</div>') +
        (t.notInCrm ? '<div class="pc-meta">' + t.notInCrm + ' tagged contact' + (t.notInCrm === 1 ? ' isn\'t' : 's aren\'t') + ' in the CRM yet — their calls show “Make lead”.</div>' : '') +
        '<div class="pc-actions">' + (t.rows.length ? '<button type="button" class="btn btn-orange pc-play" data-cc="tagconfirm"' + (on && !t.saving ? '' : ' disabled') + '>' + (t.saving ? 'Filing…' : 'File ' + on + ' on their customers') + '</button>' : '') +
        '<button type="button" class="btn btn-ghost pc-play" data-cc="tagcancel">' + (t.rows.length ? 'Cancel' : 'Close') + '</button></div>';
    }
    if (t.loading || t.error || t.done) body += '<div class="pc-actions"><button type="button" class="btn btn-ghost pc-play" data-cc="tagcancel">Close</button></div>';
    return '<div class="panel pc-card cc-tagmatch"><div class="pc-who">Tagged “NBD Customer” contacts on no customer</div>' + body + '</div>';
  }
  async function tagPreview() {
    state.tag = { loading: true, rows: [], off: {} };
    render();
    try {
      var r = await callable('callTaggedMatch', {});
      state.tag = { rows: (r && r.matches) || [], notInCrm: ((r && r.notInCrm) || []).length, off: {} };
    } catch (e) {
      state.tag = { error: (e && e.message) || 'Could not check your tagged contacts.', rows: [], off: {} };
    }
    render();
  }
  async function tagConfirm() {
    var t = state.tag;
    if (!t || !t.rows || t.saving) return;
    var pick = t.rows.filter(function (r) { return !t.off[r.key]; }).map(function (r) { return { key: r.key, leadId: r.leadId }; });
    if (!pick.length) return;
    t.saving = true; render();
    try {
      var r = await callable('callTaggedMatch', { confirm: pick });
      state.tag = { done: 'Filed ' + ((r && r.calls) || 0) + ' call' + ((r && r.calls) === 1 ? '' : 's') + ' on ' + ((r && r.filed) || 0) + ' customer' + ((r && r.filed) === 1 ? '' : 's') + '.' + (r && r.skipped ? ' ' + r.skipped + ' skipped (changed since the preview).' : ''), rows: [], off: {} };
      render();
      load();
    } catch (e) {
      t.saving = false;
      t.error = (e && e.message) || 'Could not file them — try again.';
      render();
    }
  }
  document.addEventListener('change', function (e) {
    var k = e.target && e.target.getAttribute && e.target.getAttribute('data-cc-tag');
    if (!k || !state.tag) return;
    state.tag.off[k] = !e.target.checked;
    render();
  });


  // A cold start straight onto #/calls (a push, the email, a bookmark) runs
  // init() before Firestore and the signed-in user exist: fetchFrom() then
  // read nothing and the screen said "No calls yet". Wait for them (up to
  // ~30 s) so a ?call= link lands on a loaded list.
  var bootWait = 0;
  function dataReady() { return !!(window.db && window._user && window._user.uid && window.query && window.getDocs); }
  async function load() {
    if (state.loading) return;
    if (!dataReady() && bootWait < 120) {
      bootWait++;
      render();
      setTimeout(load, 250);
      return;
    }
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
    if (a === 'filter') { state.filter = b.getAttribute('data-arg') || 'attention'; state.focusId = null; render(); }
    else if (a === 'play') play(id);
    else if (a === 'handled' || a === 'unhandled' || a === 'notpersonal') act(id, a);
    else if (a === 'handledgroup') actMany(idsOf(b), 'handled');
    else if (a === 'deck') openDeck();
    else if (a === 'promises') openPromiseDeck();
    else if (a === 'attachopen') openAttach(id);
    else if (a === 'attach') {
      var leadId = pickedLeadId(id);
      if (!leadId) { status(id, 'Pick a customer from the list.'); return; }
      // One attach files every other unfiled call and text from the number
      // too (server: refileNumber), so a group card needs just its one call.
      act(id, 'attach', { leadId: leadId });
    }
    else if (a === 'newlead') newLead(id);
    else if (a === 'tagmatch') tagPreview();
    else if (a === 'tagconfirm') tagConfirm();
    else if (a === 'tagcancel') { state.tag = null; render(); }
  });
  document.addEventListener('input', function (e) {
    if (e.target && e.target.id === 'ccSearch') { state.q = e.target.value || ''; render(); }
  });

  window.NBDCallCenter = {
    init: function () { load(); loadPromises(); deepLink(); },
    reload: load,
    openPromises: openPromiseDeck,
    _groupPromises: groupPromises,
    _leadForNumber: leadForNumber,
    _fileTarget: fileTarget,
    _promises: promises,
    _state: state,
    _needsAttention: needsAttention,
    _focusTarget: focusTarget,
    _telOf: telOf,
    focusCall: focusCall,
  };
})();
