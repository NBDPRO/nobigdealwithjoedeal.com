/**
 * home-strips.js — two small strips for the field layouts (2026-10-15,
 * layouts ideas #8 and #10):
 *
 *   Call back now   [data-stl-slot]  Field, Focus
 *     A missed call or a brand-new lead from the last 30 minutes: the first
 *     roofer to call back wins the job. Missed calls are the Call Center's own
 *     rows and rule (NBDHomeAttention.groupNeeds over its lastRows, one row per
 *     PERSON; isMissedCall = inbound, not a text, under 15 s); new leads are
 *     stage "new" created in the last 30 minutes (Inbox's new-lead rule, a
 *     shorter window). Call is a tel: link; Text back is an sms: link held by
 *     phone-share.js's checkText (data-ps-check: STOP, Do Not Text, consent,
 *     texting hours) — with the missed-call reply already written when the
 *     call carries one (missed-call-reply-logic.js replyDraft). Nothing sends.
 *
 *   Needs you       [data-ny-slot]   Field, Mission
 *     Money and momentum only, counted by the Today list's own rules
 *     (NBDToday.compute()): estimates to follow up, unpaid invoices (the one
 *     owed rule, with the total), overdue follow-ups (Stalled), and new leads
 *     from the last 7 days. Each chip opens the view that holds them.
 *
 * Both hide when there is nothing to show. A layout that repaints wipes its
 * slot; the observer refills it (the closes-week.js pattern).
 *
 * Pure half (speedToLead / needsYou / safeSmsHref) is require()-able for tests.
 * Loaded lazily (ScriptLoader bundle 'homestrips', kicked by today-home.js boot).
 */
(function (root) {
  'use strict';

  var WINDOW_MS = 30 * 60000;
  var NEW_LEAD_DAYS = 7;
  var MAX_ROWS = 3;
  var SMS_RE = /^sms:\+1[0-9]{10}\?(&)?body=[A-Za-z0-9%._~!*'()-]{1,600}$/;

  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = new Date(v).getTime();
    return isFinite(t) ? t : 0;
  }
  function digits10(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length === 11 && d.charAt(0) === '1') d = d.slice(1);
    return d.length === 10 ? d : '';
  }
  function leadName(l) {
    if (!l) return '';
    return (String(l.firstName || '') + ' ' + String(l.lastName || '')).trim() || String(l.name || '').trim();
  }
  function isMissed(c) { return !!c && c.channel !== 'text' && c.status === 'short' && c.direction === 'inbound'; }
  function safeSmsHref(h) { return typeof h === 'string' && SMS_RE.test(h) ? h : ''; }
  function stageOf(l) { return String((l && (l._stageKey || l.stage)) || '').toLowerCase(); }

  // ── pure ─────────────────────────────────────────────────────────────
  /**
   * o: { groups (NBDHomeAttention.groupNeeds output), leads, nowMs }
   * -> [{ key, kind:'missed'|'lead', name, phone, leadId, atMs, smsHref, source }] newest first, at most 3.
   */
  function speedToLead(o) {
    var x = o || {};
    var now = Number(x.nowMs) || Date.now();
    var byId = {};
    (x.leads || []).forEach(function (l) { if (l && l.id != null) byId[String(l.id)] = l; });
    var out = [], seenLead = {};
    (x.groups || []).forEach(function (g) {
      var c = g && g.calls && g.calls[0];
      if (!isMissed(c)) return;
      var at = toMs(c.startedAtMs);
      if (!at || now - at > WINDOW_MS || at > now + 60000) return;
      var lead = c.leadId ? byId[String(c.leadId)] : null;
      if (lead && lead.deleted === true) return;
      var phone = digits10(c.phoneDigits) || digits10(lead && (lead.phone || lead.phoneDigits));
      out.push({
        key: 'call:' + (g.key || c.id), kind: 'missed', at: at, atMs: at, leadId: lead ? String(lead.id) : '',
        name: leadName(lead) || String(c.contactName || c.callerName || '').trim() || (phone ? '(' + phone.slice(0, 3) + ') ' + phone.slice(3, 6) + '-' + phone.slice(6) : 'Unknown caller'),
        phone: phone, smsHref: safeSmsHref(c.replyDraft && c.replyDraft.smsHref), source: '',
      });
      if (lead) seenLead[String(lead.id)] = 1;
    });
    (x.leads || []).forEach(function (l) {
      if (!l || l.id == null || l.deleted === true || l.e2eTestData || seenLead[String(l.id)]) return;
      if (stageOf(l) !== 'new') return;
      var at = toMs(l.createdAt);
      if (!at || now - at > WINDOW_MS || at > now + 60000) return;
      out.push({ key: 'lead:' + l.id, kind: 'lead', atMs: at, leadId: String(l.id), name: leadName(l) || String(l.address || '').split(',')[0] || 'New lead', phone: digits10(l.phone || l.phoneDigits), smsHref: '', source: String(l.source || '').slice(0, 30) });
    });
    out.sort(function (a, b) { return b.atMs - a.atMs; });
    return out.slice(0, MAX_ROWS);
  }
  /**
   * plan: NBDToday.compute() (estimates, money, stalled). leads: window._leads.
   * -> { estimates, unpaid:{ count, cents }, overdue, newLeads }
   */
  function needsYou(plan, leads, nowMs) {
    var p = plan || {};
    var now = Number(nowMs) || Date.now();
    var inv = (p.money || []).filter(function (r) { return r && r.kind === 'invoice' && r.cents > 0; });
    var fresh = (leads || []).filter(function (l) {
      if (!l || l.deleted === true || l.e2eTestData || stageOf(l) !== 'new') return false;
      var at = toMs(l.createdAt);
      return at && now - at <= NEW_LEAD_DAYS * 86400000;
    });
    return {
      estimates: (p.estimates || []).length,
      unpaid: { count: inv.length, cents: inv.reduce(function (s, r) { return s + r.cents; }, 0) },
      overdue: (p.stalled || []).length,
      newLeads: fresh.length,
    };
  }

  var pure = { speedToLead: speedToLead, needsYou: needsYou, safeSmsHref: safeSmsHref, WINDOW_MS: WINDOW_MS, MAX_ROWS: MAX_ROWS };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (!root || !root.document || root.NBDHomeStrips) return;

  // ── browser ──────────────────────────────────────────────────────────
  var w = root, doc = root.document;
  var html = { stl: '', ny: '' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ago(ms) { var m = Math.max(0, Math.round((Date.now() - ms) / 60000)); return m < 1 ? 'just now' : m + ' min ago'; }
  function money(cents) { var d = Math.round(cents / 100); return d >= 10000 ? '$' + (Math.round(d / 100) / 10) + 'k' : '$' + d.toLocaleString('en-US'); }
  function plan() { try { return w.NBDToday && w._leadsLoaded === true ? w.NBDToday.compute() : null; } catch (_) { return null; } }

  function stlHtml(rows) {
    if (!rows.length) return '';
    return '<div class="hs-card hs-stl" role="region" aria-label="Call back now"><div class="hs-hdr"><h3 class="hs-title">Call back now</h3>' +
      '<span class="hs-aside">first to call back wins the job</span></div><ul class="hs-list">' + rows.map(function (r) {
        var what = r.kind === 'missed' ? 'Missed call' : 'New lead' + (r.source ? ' from ' + r.source.replace(/_/g, ' ') : '');
        var tel = r.phone ? 'tel:+1' + r.phone : '';
        var sms = r.smsHref || (r.phone ? 'sms:+1' + r.phone : '');
        return '<li class="hs-row"><div class="hs-main"><span class="hs-name">' + esc(r.name) + '</span><span class="hs-sub">' + esc(what + ' · ' + ago(r.atMs)) + '</span></div>' +
          '<div class="hs-acts">' +
          (tel ? '<a class="hs-btn hs-btn-primary" href="' + esc(tel) + '">Call</a>' : '<button type="button" class="hs-btn" disabled>No number</button>') +
          (sms ? '<a class="hs-btn" href="' + esc(sms) + '" data-ps-check="1" data-ps-lead="' + esc(r.leadId) + '">' + (r.smsHref ? 'Text back (draft)' : 'Text') + '</a>' : '') +
          '</div></li>';
      }).join('') + '</ul><p class="hs-fine">Text opens your own Messages after the texting check; nothing is sent for you.</p></div>';
  }
  function nyHtml(n) {
    var chips = [];
    if (n.unpaid.count) chips.push(['money', n.unpaid.count + (n.unpaid.count === 1 ? ' unpaid invoice · ' : ' unpaid invoices · ') + money(n.unpaid.cents)]);
    if (n.estimates) chips.push(['closeboard', n.estimates + (n.estimates === 1 ? ' estimate to follow up' : ' estimates to follow up')]);
    if (n.overdue) chips.push(['crm', n.overdue + (n.overdue === 1 ? ' overdue follow-up' : ' overdue follow-ups')]);
    if (n.newLeads) chips.push(['crm', n.newLeads + (n.newLeads === 1 ? ' new lead this week' : ' new leads this week')]);
    if (!chips.length) return '';
    return '<div class="hs-card hs-ny" role="region" aria-label="Needs you"><h3 class="hs-title">Needs you</h3><div class="hs-chips">' + chips.map(function (c) {
      return '<button type="button" class="hs-chip" data-ny-go="' + c[0] + '">' + esc(c[1]) + '</button>';
    }).join('') + '</div></div>';
  }

  function render() {
    if (w._leadsLoaded !== true) return;
    var HA = w.NBDHomeAttention, now = Date.now(), groups = [];
    try { if (HA && typeof HA.groupNeeds === 'function' && Array.isArray(HA.lastRows)) groups = HA.groupNeeds(HA.lastRows, now, HA.lastLabels || null); } catch (_) { groups = []; }
    html.stl = stlHtml(speedToLead({ groups: groups, leads: w._leads || [], nowMs: now }));
    var p = plan();
    html.ny = p ? nyHtml(needsYou(p, w._leads || [], now)) : '';
    paintAll();
  }
  function paint(el, h) {
    if (el.__hsHtml === h && (el.firstChild || !h)) return;
    el.__hsHtml = h;
    el.innerHTML = h;
    el.hidden = !h;
  }
  function paintAll() {
    Array.prototype.forEach.call(doc.querySelectorAll('[data-stl-slot]'), function (el) { paint(el, html.stl); });
    Array.prototype.forEach.call(doc.querySelectorAll('[data-ny-slot]'), function (el) { paint(el, html.ny); });
  }
  var pending = 0;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = 0; render(); }, 250); }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-ny-go]') : null;
    if (!t) return;
    ev.preventDefault();
    if (typeof w.goTo === 'function') w.goTo(t.getAttribute('data-ny-go'));
  });
  ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:invoices-loaded', 'layoutchange', 'nbd:today-rendered'].forEach(function (n) { w.addEventListener(n, schedule); });
  setInterval(function () { if (!doc.hidden) schedule(); }, 60000);   // "12 min ago" moves; a 30-minute row ages out
  var queued = false;
  try {
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      (w.requestAnimationFrame || setTimeout)(function () { queued = false; paintAll(); });
    }).observe(doc.body, { childList: true, subtree: true });
  } catch (_) { /* events still paint */ }
  var tries = 0;
  (function kick() { if (w._leadsLoaded === true) { render(); return; } if (++tries < 120) setTimeout(kick, 500); })();

  w.NBDHomeStrips = { render: render, _stlHtml: stlHtml, _nyHtml: nyHtml };
})(typeof window !== 'undefined' ? window : null);
