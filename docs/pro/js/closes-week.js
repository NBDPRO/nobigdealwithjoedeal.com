/**
 * closes-week.js — the "What closes this week" Home card (2026-10-15).
 *
 * Open estimates and deals ranked by likelihood × projected value
 * (closes-week-logic.js — the SAME ranking the CRM MCP's closes_this_week tool
 * gives the bots), each with the reason and one next action.
 *
 * EVERY LAYOUT: the card paints into
 *   #homeClosesWeek        the Home template (Classic, Bento, Island: Home stays visible)
 *   [data-cwk-slot]        a slot each full-screen layout leaves in its own markup
 *                          (Field, Crew, Focus, Inbox, Mission). A layout that
 *                          repaints wipes the slot; the observer below refills it.
 *   [data-cwk-compact]     on a slot: one summary line (weighted total, count,
 *                          the top deal) that opens the full card. Crew and
 *                          Inbox use it so the card never buries their own job
 *                          (layouts audit D4, 2026-10-15).
 * Classes are cwk- (not cw-): Crew's own cw- rules were restyling the card (D3).
 *
 * NOTHING SENDS. Each row taps through to the customer; its one-tap action is a
 * plain tel: link, an sms: link with a draft already typed (Joe presses Send in
 * his own messages app), the estimate follow-ups share sheet (estimate-
 * followups.js data-ef-send, which opens the phone's share sheet), or a link.
 * Every sms: draft carries data-ps-check: phone-share.js asks the server's
 * "ok to text?" (STOP, Do Not Text, consent, texting hours) on the tap and opens
 * Messages only on a yes (D16).
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
  var expanded = false;      // "Show all N" in the full card
  var compactOpen = false;   // a compact slot opened to the full card
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
  // data-ps-check: phone-share.js runs checkText on the tap (fails closed).
  function smsAttrs(leadId) { return ' data-ps-check="1" data-ps-lead="' + esc(leadId) + '"'; }
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
    var a = function (href, extra) { return '<a class="cwk-act" href="' + esc(href) + '"' + (extra || '') + '>' + esc(label) + '</a>'; };
    if (k === 'call' && digits10(ph)) return a('tel:+1' + digits10(ph));
    if (k === 'text') {
      var t = smsDraft(ph, hi + "it's Joe with No Big Deal. Any questions on the estimate? Happy to walk through it.");
      if (t) return a(t, smsAttrs(r.leadId));
    }
    if (k === 'resend_estimate' && efIds[r.leadId]) return '<button type="button" class="cwk-act" data-ef-send="' + esc(r.leadId) + '">' + esc(label) + '</button>';
    if (k === 'check_rate') {
      var link = (lead && /^https:\/\//i.test(String(lead.preQualLink || ''))) ? String(lead.preQualLink) : (isNbd() ? ACORN : '');
      var c = link ? smsDraft(ph, hi + 'here is the link to check your rate (a soft credit check, it does not affect your credit score): ' + link) : '';
      if (c) return a(c, smsAttrs(r.leadId));
    }
    if (k === 'book_inspection') {
      var b = bookingUrl();
      var s = b ? smsDraft(ph, hi + "it's Joe with No Big Deal. Here's a link to pick a time for your free roof inspection: " + b) : '';
      if (s) return a(s, smsAttrs(r.leadId));
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

  function cardHtml(list, opts) {
    var o = opts || {};
    var byId = {};
    (w._leads || []).forEach(function (l) { if (l && l.id) byId[l.id] = l; });
    var efIds = followupIds();
    var shown = expanded ? list : list.slice(0, CAP);
    var total = list.reduce(function (s, r) { return s + r.score; }, 0);
    var out = '<div class="cwk-card" role="region" aria-label="What closes this week">' +
      '<div class="cwk-hdr"><h3 class="cwk-title">What closes this week</h3>' +
      (list.length ? '<span class="cwk-aside">' + esc(money(total)) + ' projected, weighted</span>' : '') +
      (o.collapsible ? '<button type="button" class="cwk-more cwk-hide" data-cwk-open="0" aria-expanded="true">Hide</button>' : '') + '</div>';
    if (!list.length) return out + '<p class="cwk-empty">No open estimates or deals with a value right now.</p></div>';
    out += '<ol class="cwk-list">' + shown.map(function (r) {
      return '<li class="cwk-row">' +
        '<a class="cwk-main" href="' + esc(custUrl(r.leadId)) + '">' +
          '<span class="cwk-name">' + esc(r.name) + '</span>' +
          '<span class="cwk-meta">' + esc(r.stageLabel) + ' · ' + esc(money(r.projectedValue)) + ' projected · ' + r.likelihoodPct + '% likely</span>' +
          '<span class="cwk-why">' + esc(r.reason) + '</span>' +
        '</a>' + actionHtml(r, byId[r.leadId], efIds) + '</li>';
    }).join('') + '</ol>';
    if (list.length > CAP) out += '<button type="button" class="cwk-more" data-cwk-more="1">' + (expanded ? 'Show fewer' : 'Show all ' + list.length) + '</button>';
    out += '<p class="cwk-note">Likelihood is a rule of thumb from stage, last touch, estimate opens, financing and follow-ups. Actions open a call, a text draft or the customer; nothing is sent for you.</p>';
    return out + '</div>';
  }

  /** Compact slots (Crew, Inbox): one line that opens the full card. */
  function compactHtml(list) {
    if (!list.length) {
      return '<div class="cwk-card cwk-compact" role="region" aria-label="What closes this week">' +
        '<p class="cwk-sum cwk-sum-none"><span class="cwk-sum-t">Closes this week</span><span class="cwk-sum-v">nothing open with a value</span></p></div>';
    }
    var total = list.reduce(function (s, r) { return s + r.score; }, 0);
    return '<div class="cwk-card cwk-compact" role="region" aria-label="What closes this week">' +
      '<button type="button" class="cwk-sum" data-cwk-open="1" aria-expanded="false">' +
        '<span class="cwk-sum-t">Closes this week</span>' +
        '<span class="cwk-sum-v">' + esc(money(total)) + ' weighted · ' + list.length + (list.length === 1 ? ' deal' : ' deals') +
          ' · top: ' + esc(list[0].name) + '</span>' +
        '<span class="cwk-sum-go">See all</span>' +
      '</button></div>';
  }

  function hosts() {
    var out = Array.prototype.slice.call(doc.querySelectorAll('[data-cwk-slot]'));
    var home = doc.getElementById('homeClosesWeek');
    if (home) out.unshift(home);
    return out;
  }
  var htmlCompact = '', htmlOpen = '';
  function htmlFor(el) {
    if (!html || !el.hasAttribute || !el.hasAttribute('data-cwk-compact')) return html;
    return compactOpen ? htmlOpen : htmlCompact;
  }
  function paintHost(el) {
    var h = htmlFor(el);
    if (el.__cwkHtml === h && el.firstChild) return;
    el.__cwkHtml = h;
    el.innerHTML = h;
    el.hidden = !h;
  }
  function render() {
    var list = compute();
    if (!list) return;
    rows = list;
    html = cardHtml(list);
    htmlCompact = compactHtml(list);
    htmlOpen = cardHtml(list, { collapsible: true });
    hosts().forEach(paintHost);
  }
  var pending = 0;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = 0; render(); }, 250); }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (!t) return;
    var m = t.closest('[data-cwk-more]');
    var o = m ? null : t.closest('[data-cwk-open]');
    if (!m && !o) return;
    ev.preventDefault();
    if (m) expanded = !expanded;
    else compactOpen = o.getAttribute('data-cwk-open') === '1';
    render();
    // the toggle was repainted: keep keyboard focus on its replacement
    var next = doc.querySelector(o ? (compactOpen ? '[data-cwk-open="0"]' : '[data-cwk-open="1"]') : '[data-cwk-more]');
    if (next && next.focus) { try { next.focus({ preventScroll: true }); } catch (_) { next.focus(); } }
  });
  ['nbd:data-refreshed', 'nbd:notifs-updated', 'nbd:invoices-loaded', 'nbd:estimate-followups', 'layoutchange', 'nbd:today-rendered'].forEach(function (n) { w.addEventListener(n, schedule); });
  // A layout repainting its overlay leaves an empty slot: refill it from the
  // last ranking (cheap; no recompute).
  var refillQueued = false;
  function refill() {
    refillQueued = false;
    if (!html) { schedule(); return; }
    hosts().forEach(function (el) { if (!el.firstChild || el.__cwkHtml !== htmlFor(el)) paintHost(el); });
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

  w.NBDClosesWeek = { render: render, rows: function () { return rows; }, _cardHtml: cardHtml, _compactHtml: compactHtml, _actionHtml: actionHtml };
})();
