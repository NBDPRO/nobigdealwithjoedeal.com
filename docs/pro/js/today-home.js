/**
 * today-home.js — paints Jo's ONE Home, the "Today" list (#todayPlan at the
 * top of the Home view; the boot view AND the phone Home tab). 2026-10-03.
 *
 * What goes on the list and in what order is decided by today-plan.js
 * (NBDTodayPlan.buildTodayPlan, pure, unit-tested). This file only gathers
 * what the dashboard already holds and acts on a tap:
 *
 *   leads          window._leads (waits for _leadsLoaded)
 *   tasks          window._taskCache — tasks.js's ONE load (waits for it)
 *   calls          home-attention.js's own rows (NBDHomeAttention.lastRows)
 *                  grouped by ITS groupNeeds — the Call Center's rule
 *   invoices       NBDRevenue.loadInvoices() — the shared cached load
 *   appointments   today's appointments: two equality+range reads (repUid,
 *                  userId — smart-calendar.js's shapes and indexes), once
 *                  per day / 10 minutes
 *   optional       NBDNoNextStep (#2126), InvoicePipeline.isDepositDraft
 *                  (#2131), LeadSnooze — each used only when loaded
 *
 * Every row is one tap: tel: / sms: / Maps / customer links are plain
 * anchors; Done / Tomorrow / Handled / +1 week are buttons that write the
 * rep's OWN records (task done + due date, the lead's followUp, the call's
 * handled flag through callCenterAction). Nothing here sends anything to a
 * customer. A row acted on hides at once (optimistic) and comes back with a
 * toast if the write fails.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDToday) return;
  var w = window, doc = document;
  var FUNCTIONS_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js';
  var MAPS = 'https://www.google.com/maps/search/?api=1&query=';
  var CAP = 6;

  var handled = new Set();      // row keys acted on this session
  var expanded = {};            // section → show all
  var appts = { rows: [], at: 0, day: '', busy: false };
  var last = null;              // last plan painted (tests + the Today's Schedule widget)
  var inv = { rows: null, at: 0 };   // last invoice list (NBDRevenue drops its cache on every data refresh)

  function plan() { return w.NBDTodayPlan || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function uid() { return (w._user && w._user.uid) || null; }
  function isViewer() { return ((w._userClaims || {}).role || '') === 'viewer'; }
  function custUrl(id) { return '/pro/customer.html?id=' + encodeURIComponent(id); }
  function tel(d) { return d ? 'tel:+1' + d : ''; }
  function fmtPhone(d) { return d && d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : (d || ''); }

  // ── data ─────────────────────────────────────────────────────────────
  function ready() {
    return !!(plan() && w._leadsLoaded === true && Array.isArray(w._leads) && w.NBDTasks && w.NBDTasks.loaded());
  }
  async function loadAppointments(force) {
    var u = uid();
    var P = plan();
    if (!u || !P || !w.db || !w.getDocs || !w.query || !w.where || !w.collection || !w.orderBy) return;
    var day = P.ymdLocal(Date.now());
    if (appts.busy || (!force && appts.day === day && Date.now() - appts.at < 10 * 60 * 1000)) return;
    appts.busy = true;
    try {
      var start = new Date(); start.setHours(0, 0, 0, 0); start.setTime(start.getTime() - 12 * 3600 * 1000);
      var end = new Date(); end.setHours(23, 59, 59, 999); end.setTime(end.getTime() + 12 * 3600 * 1000);
      var col = w.collection(w.db, 'appointments');
      var byId = {};
      var lanes = ['repUid', 'userId'];
      for (var i = 0; i < lanes.length; i++) {
        try {
          var snap = await w.getDocs(w.query(col, w.where(lanes[i], '==', u), w.where('startTime', '>=', start), w.where('startTime', '<=', end), w.orderBy('startTime', 'asc')));
          snap.docs.forEach(function (d) { byId[d.id] = Object.assign({ id: d.id }, d.data()); });
        } catch (e) { console.warn('[today] appointments (' + lanes[i] + '):', e && (e.code || e.message)); }
      }
      appts.rows = Object.keys(byId).map(function (k) { return byId[k]; });
      appts.day = day; appts.at = Date.now();
    } finally { appts.busy = false; }
    schedule();
  }
  function jobsOf(leads) {
    var J = w.NBDJobs;
    if (!J || typeof J.forLead !== 'function') return [];
    var out = [];
    leads.forEach(function (l) {
      var list = [];
      try { list = J.forLead(l.id) || []; } catch (_) { list = []; }
      list.forEach(function (j) { if (j && j.id) out.push(Object.assign({ leadId: l.id }, j)); });
    });
    return out;
  }
  function stormCache() {
    try { return JSON.parse(localStorage.getItem('nbd_storm_alerts_cache') || 'null'); } catch (_) { return null; }
  }
  function compute() {
    var P = plan();
    var now = Date.now();
    var HA = w.NBDHomeAttention;
    var groups = [];
    if (HA && typeof HA.groupNeeds === 'function' && Array.isArray(HA.lastRows)) {
      try { groups = HA.groupNeeds(HA.lastRows, now); } catch (_) { groups = []; }
    }
    var R = w.NBDRevenue;
    var fresh = R && typeof R.cached === 'function' ? R.cached() : null;
    if (fresh) { inv.rows = fresh; inv.at = Date.now(); }
    else if (R && typeof R.loadInvoices === 'function' && Date.now() - inv.at > 600000) { inv.at = Date.now(); R.loadInvoices().then(schedule); }
    var invoices = inv.rows || [];
    var IP = w.InvoicePipeline;
    var nns = null;
    if (w.NBDNoNextStep && typeof w.NBDNoNextStep.compute === 'function') {
      // The deck (no-next-step.js openDeck) swipes r.people — count what it opens.
      try { var r = w.NBDNoNextStep.compute(); nns = isViewer() ? null : { count: ((r && r.people) || []).length }; } catch (_) { nns = null; }
    }
    var leads = w._leads || [];
    // Estimates to follow up (#2136): its own pure rule over the same leads.
    var EF = w.NBDEstimateFollowups;
    var estRows = [];
    if (EF && typeof EF.computeFollowups === 'function') {
      try { estRows = EF.computeFollowups(leads, now).rows || []; } catch (_) { estRows = []; }
    }
    return P.buildTodayPlan({
      now: now, leads: leads, tasksByLead: w._taskCache || {},
      appointments: appts.rows, jobs: jobsOf(leads),
      callGroups: groups,
      invoices: invoices,
      isOwedInvoice: R && R.isOwedInvoice, owedDollarsOf: R && R.owedDollarsOf,
      isDepositDraft: IP && typeof IP.isDepositDraft === 'function' ? IP.isDepositDraft : null,
      stripeNeedsReview: (HA && HA.lastCounts && HA.lastCounts.stripe) || 0,
      noNextStep: nns,
      estimateRows: estRows,
      isSnoozed: w.LeadSnooze && typeof w.LeadSnooze.isSnoozed === 'function' ? w.LeadSnooze.isSnoozed : null,
      handled: handled,
      env: { stageRole: w.stageRole },
    });
  }

  // ── paint ────────────────────────────────────────────────────────────
  function btn(act, key, label, extra) {
    return '<button type="button" class="tp-btn' + (extra ? ' ' + extra : '') + '" data-tp-act="' + act + '" data-tp-key="' + esc(key) + '">' + label + '</button>';
  }
  function link(href, label, cls, newTab) {
    if (!href) return '';
    return '<a class="tp-btn' + (cls ? ' ' + cls : '') + '" href="' + esc(href) + '"' + (newTab ? ' target="_blank" rel="noopener"' : '') + '>' + label + '</a>';
  }
  function row(key, main, sub, acts, cls) {
    return '<div class="tp-row' + (cls ? ' ' + cls : '') + '" data-tp-row="' + esc(key) + '">' +
      '<div class="tp-main"><div class="tp-name">' + main + '</div>' + (sub ? '<div class="tp-sub">' + sub + '</div>' : '') + '</div>' +
      '<div class="tp-acts">' + acts + '</div></div>';
  }
  function section(id, title, rows, extraHead) {
    if (!rows.length) return '';
    var all = !!expanded[id];
    var shown = all ? rows : rows.slice(0, CAP);
    var more = rows.length > CAP && !all ? '<button type="button" class="tp-more" data-tp-act="more" data-tp-key="' + id + '">Show all ' + rows.length + '</button>' : '';
    return '<div class="tp-sec" data-tp-sec="' + id + '"><div class="tp-sec-hd"><span class="tp-sec-title">' + title + ' <span class="tp-count">' + rows.length + '</span></span>' + (extraHead || '') + '</div>' +
      shown.join('') + more + '</div>';
  }
  function html(p) {
    var P = plan();
    var ro = isViewer();
    var a = p.appointments.map(function (it) {
      var sub = [esc(it.timeLabel), esc(it.type || ''), it.address ? esc(String(it.address).split(',')[0]) : ''].filter(Boolean).join(' · ');
      var d = String(it.phone || '').replace(/\D/g, '').slice(-10);
      var acts = link(it.address ? MAPS + encodeURIComponent(it.address) : '', 'Maps', '', true) + link(d.length === 10 ? tel(d) : '', 'Call') + link(it.leadId ? custUrl(it.leadId) : '', 'Open');
      return row(it.key, esc(it.name) + (it.title ? ' <span class="tp-dim">— ' + esc(it.title) + '</span>' : ''), sub, acts);
    });
    var c = p.calls.map(function (r) {
      var why = [r.urgent ? '<b class="tp-hot">urgent</b>' : '', r.missed ? 'missed call' : '', r.text && !r.missed ? 'texts' : '', r.count > 1 ? r.count + ' open' : ''].filter(Boolean).join(' · ');
      var sub = why + (r.summary ? (why ? ' · ' : '') + esc(r.summary) : '');
      var acts = link(tel(r.phone), 'Call') + link(r.phone ? 'sms:+1' + r.phone : '', 'Text') + (ro ? '' : btn('handled', r.key, '✓ Handled', 'tp-go'));
      return row(r.key, esc(r.name || fmtPhone(r.phone) || 'Unknown caller'), sub, acts);
    });
    var pr = p.promised.map(function (r) {
      var bits = r.tasks.map(function (t) { return esc(t.text || t.title || 'Task'); }).concat(r.promises.map(function (s) { return 'You said: ' + esc(s); }));
      var when = r.overdue ? '<b class="tp-hot">overdue</b>' : (r.dueYmd ? 'due today' : 'promised');
      var acts = (ro ? '' : btn('done', r.key, '✓ Done', 'tp-go') + btn('tomorrow', r.key, 'Tomorrow')) + link(custUrl(r.leadId), 'Open');
      return row(r.key, esc(r.name), when + (bits.length ? ' · ' + bits.slice(0, 3).join(' · ') : ''), acts);
    });
    // Estimate follow-ups: the buttons are estimate-followups.js's own
    // (data-ef-send / data-ef-share-now) — its click delegate opens the share
    // sheet with the pre-written message and stamps the lead only once sent.
    var EF = w.NBDEstimateFollowups;
    var e = (p.estimates || []).map(function (r) {
      var pend = EF && typeof EF.isPending === 'function' && EF.isPending(r.leadId);
      var go = ro ? '' : (pend
        ? '<button type="button" class="tp-btn tp-go" data-ef-share-now="' + esc(r.leadId) + '">📤 Share now</button>'
        : '<button type="button" class="tp-btn tp-go" data-ef-send="' + esc(r.leadId) + '">📤 Follow up</button>');
      var sub = 'Sent ' + esc(r.daysOut) + 'd ago · <span class="' + (r.opened ? 'tp-dim' : 'tp-hot') + '">' + esc(r.openedLabel) + '</span>';
      return '<div class="tp-row ef-row" data-tp-row="' + esc(r.key) + '" data-lead-id="' + esc(r.leadId) + '">' +
        '<div class="tp-main"><div class="tp-name">' + esc(r.name) + '</div><div class="tp-sub">' + sub + '</div></div>' +
        '<div class="tp-acts">' + go + link(custUrl(r.leadId), 'Open') + '</div></div>';
    });
    var m = p.money.map(function (r) {
      if (r.kind === 'stripe') return row(r.key, '💳 ' + r.count + ' Stripe payment' + (r.count === 1 ? '' : 's') + ' need' + (r.count === 1 ? 's' : '') + ' a customer', '', btn('goto', 'money', 'Assign', 'tp-go'));
      if (r.kind === 'deposit') return row(r.key, esc(r.name), 'Draft deposit ' + esc(P.fmtCents(r.cents)) + ' · not sent', link(r.leadId ? custUrl(r.leadId) : '', 'Review', 'tp-go') + (r.leadId ? '' : btn('goto', 'money', 'Review', 'tp-go')));
      return row(r.key, esc(r.name), esc(P.fmtCents(r.cents)) + ' owed' + (r.overdue ? ' · <b class="tp-hot">past due</b>' : '') + (r.number ? ' · #' + esc(r.number) : ''),
        link(tel(r.phone), 'Call') + (r.leadId ? link(custUrl(r.leadId), 'Open', 'tp-go') : btn('goto', 'money', 'Open', 'tp-go')));
    });
    var s = p.stalled.map(function (r) {
      var late = r.daysLate > 0 ? r.daysLate + (r.daysLate === 1 ? ' day' : ' days') + ' past follow-up' : 'follow-up due today';
      return row(r.key, esc(r.name), late, link(tel(r.phone), 'Call') + (ro ? '' : btn('fu7', r.key, '+1 week')) + link(custUrl(r.leadId), 'Open'));
    });
    if (p.noNextStep) {
      s.push(row('nns', '🧭 ' + p.noNextStep.count + ' lead' + (p.noNextStep.count === 1 ? '' : 's') + ' with no next step', 'No follow-up date, no open task',
        '<button type="button" class="tp-btn tp-go" data-nns-act="deck">Swipe through</button>', 'tp-nns'));
    }
    var deck = (w.NBDFollowUpDeck && w.NBDTriageDeck && p.stalled.length > 1) ? '<button type="button" class="tp-more tp-hd-btn" data-tp-act="fudeck" data-tp-key="stalled">One at a time</button>' : '';
    var storm = P.stormLine(stormCache(), Date.now());
    var body = section('appts', 'Appointments', a) + section('calls', 'Calls owed', c) + section('promised', 'Promised follow-ups', pr) + section('estimates', 'Estimates to follow up', e) +
      section('money', 'Money to collect', m) + section('stalled', 'Stalled leads', s, deck);
    return '<div class="tp-hd"><div class="tp-title" data-tp-total="' + p.total + '">' + esc(P.headline(p.total)) + '</div>' +
      (storm ? '<div class="tp-storm">' + esc(storm) + '</div>' : '') + '</div>' +
      (body || '<div class="tp-empty">Nothing on the list. Go knock some doors.</div>');
  }

  var _t = 0;
  function schedule() { clearTimeout(_t); _t = setTimeout(render, 120); }
  function render() {
    var el = doc.getElementById('todayPlan');
    if (!el) return;
    if (!ready()) {
      el.hidden = false;
      if (!el.getAttribute('data-tp-state')) { el.innerHTML = '<div class="tp-hd"><div class="tp-title">Today</div><div class="tp-sub">Loading your day…</div></div>'; el.setAttribute('data-tp-state', 'loading'); }
      return;
    }
    var p = compute();
    last = p;
    el.innerHTML = html(p);
    el.hidden = false;
    el.setAttribute('data-tp-state', 'ready');
    try { w.dispatchEvent(new CustomEvent('nbd:today-rendered', { detail: { total: p.total } })); } catch (_) { /* old browser */ }
  }

  // ── actions ──────────────────────────────────────────────────────────
  async function callable(name, data) {
    if (!w._functions || !w._httpsCallable) {
      var mod = await import(FUNCTIONS_SDK);
      w._functions = mod.getFunctions();
      w._httpsCallable = mod.httpsCallable;
    }
    var res = await w._httpsCallable(w._functions, name)(data);
    return res && res.data;
  }
  function findRow(key) {
    var p = last;
    if (!p) return null;
    var lists = [p.calls, p.promised, p.money, p.stalled];
    for (var i = 0; i < lists.length; i++) for (var j = 0; j < lists[i].length; j++) if (lists[i][j].key === key) return lists[i][j];
    return null;
  }
  async function setFollowUp(leadId, ymd) {
    var lead = (w._leads || []).filter(function (l) { return l && l.id === leadId; })[0];
    if (!lead) throw new Error('Customer not found.');
    if (w.NBDFollowUpDeck && typeof w.NBDFollowUpDeck.setFollowUp === 'function') return w.NBDFollowUpDeck.setFollowUp(lead, ymd);
    if (!w.updateDoc || !w.doc || !w.db) throw new Error('The database is not loaded. Refresh and try again.');
    await w.updateDoc(w.doc(w.db, 'leads', leadId), { followUp: ymd, updatedAt: w.serverTimestamp ? w.serverTimestamp() : new Date() });
    lead.followUp = ymd;
  }
  async function act(kind, key) {
    var P = plan();
    var r = findRow(key);
    if (!r) return;
    var T = w.NBDTasks;
    var jobs = [];
    if (kind === 'handled') {
      r.callIds.forEach(function (id) { jobs.push(callable('callCenterAction', { id: id, action: 'handled' })); });
    } else if (kind === 'done') {
      r.tasks.forEach(function (t) { jobs.push(T.setDone(r.leadId, t.id).then(function (ok) { if (!ok) throw new Error('task'); })); });
      var withTask = new Set(r.tasks.map(function (t) { return t.id; }));
      r.callIds.forEach(function (id) {
        if (withTask.has('cube-' + id) || withTask.has('sms-' + id)) return;   // ticking its task keeps the promise
        jobs.push(callable('callCenterAction', { id: id, action: 'handled' }));
      });
    } else if (kind === 'tomorrow') {
      var tmw = P.addDaysYmdLocal(Date.now(), 1);
      r.tasks.forEach(function (t) { jobs.push(T.setDue(r.leadId, t.id, tmw).then(function (ok) { if (!ok) throw new Error('task'); })); });
      var tasked = new Set(r.tasks.map(function (t) { return t.id; }));
      r.callIds.forEach(function (id) {
        if (tasked.has('cube-' + id) || tasked.has('sms-' + id)) return;
        jobs.push(callable('callCenterAction', { id: id, action: 'snooze', days: 1 }));
      });
    } else if (kind === 'fu7') {
      jobs.push(setFollowUp(r.leadId, P.addDaysYmdLocal(Date.now(), 7)));
    }
    if (!jobs.length) return;
    handled.add(key);
    render();
    var res = await Promise.allSettled(jobs);
    var bad = res.filter(function (x) { return x.status === 'rejected'; }).length;
    if (bad) {
      handled.delete(key);
      render();
      toast("Couldn't save that — check your connection and tap it again", 'error');
      return;
    }
    if (kind === 'handled' || r.callIds && r.callIds.length) { try { if (w.NBDHomeAttention && w.NBDHomeAttention.render) w.NBDHomeAttention.render(true); } catch (_) { /* strip refresh is best-effort */ } }
  }

  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-tp-act]') : null;
    if (!t) return;
    var a = t.getAttribute('data-tp-act'), key = t.getAttribute('data-tp-key') || '';
    if (a === 'more') { expanded[key] = true; render(); return; }
    if (a === 'goto') { if (typeof w.goTo === 'function') w.goTo(key); return; }
    if (a === 'fudeck') {
      var ids = new Set(((last && last.stalled) || []).map(function (r) { return r.leadId; }));
      var list = (w._leads || []).filter(function (l) { return l && ids.has(l.id); });
      if (w.NBDFollowUpDeck) w.NBDFollowUpDeck.open(list);
      return;
    }
    if (isViewer()) return;
    act(a, key).catch(function (e) { console.warn('[today] action failed', e); });
  });

  ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:invoices-loaded', 'nbd:estimate-followups'].forEach(function (n) { w.addEventListener(n, schedule); });
  w.addEventListener('hashchange', function () {
    if (/^#?\/?(home)?$/.test(location.hash || '')) { loadAppointments(false); setTimeout(render, 200); }
  });
  function boot() {
    // Home is a <template> mounted on navigation: paint when #todayPlan appears.
    try {
      new MutationObserver(function () {
        var el = doc.getElementById('todayPlan');
        if (el && !el.getAttribute('data-tp-mounted')) { el.setAttribute('data-tp-mounted', '1'); render(); }
      }).observe(doc.body, { childList: true, subtree: true });
    } catch (_) { /* no observer: events still paint */ }
    var tries = 0;
    (function kick() {
      if (uid() && w._leadsLoaded === true) {
        loadAppointments(true);
        schedule();
        return;
      }
      if (++tries < 120) setTimeout(kick, 500);
    })();
    render();
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();

  w.NBDToday = { render: render, compute: compute, last: function () { return last; }, refreshAppointments: function () { return loadAppointments(true); } };
})();
