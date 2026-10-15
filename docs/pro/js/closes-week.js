/**
 * closes-week.js — the "What closes this week" Home card (2026-10-15).
 *
 * Open estimates and deals ranked by likelihood × projected value
 * (closes-week-logic.js — the SAME ranking the CRM MCP's closes_this_week tool
 * gives the bots), each with the reason and one next action.
 *
 * EVERY LAYOUT: the card paints into
 *   #homeClosesWeek        the Home template (Classic, Bento, Island: Home stays visible)
 *   [data-cw-slot]         a slot each full-screen layout leaves in its own markup
 *                          (Field, Crew, Focus, Inbox, Mission). A layout that
 *                          repaints wipes the slot; the observer below refills it.
 *
 * NOTHING SENDS. Each row taps through to the customer; its one-tap action is a
 * plain tel: link, an sms: link with a draft already typed (Joe presses Send in
 * his own messages app), the estimate follow-ups share sheet (estimate-
 * followups.js data-ef-send, which opens the phone's share sheet), or a link.
 *
 * Loaded lazily (ScriptLoader bundle 'closesweek', kicked by today-home.js
 * boot): no boot <script> tag.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDClosesWeek) return;
  var w = window, doc = document;
  var CAP = 5;
  var ACORN = 'https://www.acornfinance.com/pre-qualify/?d=QU6WZ';
  var expanded = false;
  var rows = null;
  var html = '';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d[0] === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function custUrl(id) { return '/pro/customer.html?id=' + encodeURIComponent(id); }
  function money(n) { return '$' + Math.round(Number(n) || 0).toLocaleString('en-US'); }
  function firstName(l) { var f = String((l && (l.firstName || l.name)) || '').trim(); return f ? f.split(/\s+/)[0] : ''; }
  function isNbd() { return typeof w._isNbdPlatformTenant === 'function' && w._isNbdPlatformTenant() === true; }
  function smsDraft(phone, body) {
    var d = digits10(phone);
    return d ? 'sms:+1' + d + '?&body=' + encodeURIComponent(body) : '';
  }
  function bookingUrl() {
    try { var c = JSON.parse(localStorage.getItem('nbd_cal_settings') || '{}'); return c.username ? 'https://cal.com/' + c.username + '/' + (c.eventSlug || 'roof-inspection') : ''; }
    catch (_) { return ''; }
  }
  function followupIds() {
    var F = w.NBDEstimateFollowups, out = {};
    try { if (F && typeof F.computeFollowups === 'function') (F.computeFollowups(w._leads || [], Date.now()).rows || []).forEach(function (r) { out[r.leadId] = 1; }); } catch (_) { /* optional */ }
    return out;
  }

  /** The one action, as markup. Only ever opens something or makes a draft. */
  function actionHtml(r, lead, efIds) {
    var k = r.nextAction.kind, label = r.nextAction.label, ph = lead && (lead.phone || lead.altPhone), hi = firstName(lead) ? 'Hi ' + firstName(lead) + ', ' : 'Hi, ';
    var a = function (href, extra) { return '<a class="cw-act" href="' + esc(href) + '"' + (extra || '') + '>' + esc(label) + '</a>'; };
    if (k === 'call' && digits10(ph)) return a('tel:+1' + digits10(ph));
    if (k === 'text') {
      var t = smsDraft(ph, hi + "it's Joe with No Big Deal. Any questions on the estimate? Happy to walk through it.");
      if (t) return a(t);
    }
    if (k === 'resend_estimate' && efIds[r.leadId]) return '<button type="button" class="cw-act" data-ef-send="' + esc(r.leadId) + '">' + esc(label) + '</button>';
    if (k === 'check_rate') {
      var link = (lead && /^https:\/\//i.test(String(lead.preQualLink || ''))) ? String(lead.preQualLink) : (isNbd() ? ACORN : '');
      var c = link ? smsDraft(ph, hi + 'here is the link to check your rate (a soft credit check, it does not affect your credit score): ' + link) : '';
      if (c) return a(c);
    }
    if (k === 'book_inspection') {
      var b = bookingUrl();
      var s = b ? smsDraft(ph, hi + "it's Joe with No Big Deal. Here's a link to pick a time for your free roof inspection: " + b) : '';
      if (s) return a(s);
    }
    return a(custUrl(r.leadId));   // the fallback: open the customer
  }

  function compute() {
    var Lg = w.NBDClosesWeekLogic;
    if (!Lg || w._leadsLoaded !== true || !Array.isArray(w._leads)) return null;
    var now = Date.now();
    var views = (Array.isArray(w._notifications) ? w._notifications : []).filter(function (n) { return n && n.type === 'estimate_viewed' && n.leadId; })
      .map(function (n) { return { leadId: n.leadId, createdAt: n.createdAt }; });
    var deposit = [];
    try {
      var IP = w.InvoicePipeline, R = w.NBDRevenue, invs = R && typeof R.cached === 'function' ? R.cached() : null;
      if (IP && typeof IP.isDepositDraft === 'function' && Array.isArray(invs)) invs.forEach(function (i) { if (i && i.leadId && IP.isDepositDraft(i)) deposit.push(i.leadId); });
    } catch (_) { /* optional signal */ }
    return Lg.rank(w._leads, { nowMs: now, estimates: Array.isArray(w._estimates) ? w._estimates : [], views: views, depositDraftLeadIds: deposit });
  }

  function cardHtml(list) {
    var byId = {};
    (w._leads || []).forEach(function (l) { if (l && l.id) byId[l.id] = l; });
    var efIds = followupIds();
    var shown = expanded ? list : list.slice(0, CAP);
    var total = list.reduce(function (s, r) { return s + r.score; }, 0);
    var out = '<div class="cw-card" role="region" aria-label="What closes this week">' +
      '<div class="cw-hdr"><h3 class="cw-title">What closes this week</h3>' +
      (list.length ? '<span class="cw-aside">' + esc(money(total)) + ' projected, weighted</span>' : '') + '</div>';
    if (!list.length) return out + '<p class="cw-empty">No open estimates or deals with a value right now.</p></div>';
    out += '<ol class="cw-list">' + shown.map(function (r) {
      return '<li class="cw-row">' +
        '<a class="cw-main" href="' + esc(custUrl(r.leadId)) + '">' +
          '<span class="cw-name">' + esc(r.name) + '</span>' +
          '<span class="cw-meta">' + esc(r.stageLabel) + ' · ' + esc(money(r.projectedValue)) + ' projected · ' + r.likelihoodPct + '% likely</span>' +
          '<span class="cw-why">' + esc(r.reason) + '</span>' +
        '</a>' + actionHtml(r, byId[r.leadId], efIds) + '</li>';
    }).join('') + '</ol>';
    if (list.length > CAP) out += '<button type="button" class="cw-more" data-cw-more="1">' + (expanded ? 'Show fewer' : 'Show all ' + list.length) + '</button>';
    out += '<p class="cw-note">Likelihood is a rule of thumb from stage, last touch, estimate opens, financing and follow-ups. Actions open a call, a text draft or the customer; nothing is sent for you.</p>';
    return out + '</div>';
  }

  function hosts() {
    var out = Array.prototype.slice.call(doc.querySelectorAll('[data-cw-slot]'));
    var home = doc.getElementById('homeClosesWeek');
    if (home) out.unshift(home);
    return out;
  }
  function paintHost(el) {
    if (el.__cwHtml === html && el.firstChild) return;
    el.__cwHtml = html;
    el.innerHTML = html;
    el.hidden = !html;
  }
  function render() {
    var list = compute();
    if (!list) return;
    rows = list;
    html = cardHtml(list);
    hosts().forEach(paintHost);
  }
  var pending = 0;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = 0; render(); }, 250); }

  doc.addEventListener('click', function (ev) {
    var m = ev.target && ev.target.closest ? ev.target.closest('[data-cw-more]') : null;
    if (!m) return;
    ev.preventDefault();
    expanded = !expanded;
    render();
  });
  ['nbd:data-refreshed', 'nbd:notifs-updated', 'nbd:invoices-loaded', 'nbd:estimate-followups', 'layoutchange', 'nbd:today-rendered'].forEach(function (n) { w.addEventListener(n, schedule); });
  // A layout repainting its overlay leaves an empty slot: refill it from the
  // last ranking (cheap; no recompute).
  var refillQueued = false;
  function refill() {
    refillQueued = false;
    if (!html) { schedule(); return; }
    hosts().forEach(function (el) { if (!el.firstChild || el.__cwHtml !== html) paintHost(el); });
  }
  try {
    new MutationObserver(function () {
      if (refillQueued) return;
      refillQueued = true;
      (w.requestAnimationFrame || setTimeout)(refill);
    }).observe(doc.body, { childList: true, subtree: true });
  } catch (_) { /* events still paint */ }
  var tries = 0;
  (function kick() { if (w._leadsLoaded === true) { render(); return; } if (++tries < 120) setTimeout(kick, 500); })();

  w.NBDClosesWeek = { render: render, rows: function () { return rows; }, _cardHtml: cardHtml, _actionHtml: actionHtml };
})();
