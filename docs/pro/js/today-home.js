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
  var FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  var MAPS = 'https://www.google.com/maps/search/?api=1&query=';
  var CAP = 6;

  var handled = new Set();      // row keys acted on this session
  var handledAt = {};           // row key -> when (ms): a call NEWER than this brings the row back
  function markHandled(key) { handled.add(key); handledAt[key] = Date.now(); }
  function unmarkHandled(key) { handled.delete(key); delete handledAt[key]; }
  var expanded = {};            // section → show all
  var appts = { rows: [], at: 0, day: '', busy: false, failed: false };
  var last = null;              // last plan painted (tests + the Today's Schedule widget)
  var inv = { rows: null, at: 0, failed: false, busy: false };   // last invoice list (NBDRevenue drops its cache on every data refresh)

  function plan() { return w.NBDTodayPlan || null; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function uid() { return (w._user && w._user.uid) || null; }
  function isViewer() { return ((w._userClaims || {}).role || '') === 'viewer'; }
  function custUrl(id) { return '/pro/customer.html?id=' + encodeURIComponent(id); }
  // A viewer gets the plain customer link: they cannot record a payment.
  function payUrl(id, invoiceId) {
    return isViewer() ? custUrl(id) : custUrl(id) + '&pay=' + encodeURIComponent(invoiceId || '1');
  }
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
      var failedLanes = 0;
      for (var i = 0; i < lanes.length; i++) {
        try {
          var snap = await w.getDocs(w.query(col, w.where(lanes[i], '==', u), w.where('startTime', '>=', start), w.where('startTime', '<=', end), w.orderBy('startTime', 'asc')));
          // An empty snapshot served from the local cache never reached the server.
          if (snap && snap.metadata && snap.metadata.fromCache === true && (!snap.docs || !snap.docs.length)) { failedLanes++; continue; }
          snap.docs.forEach(function (d) { byId[d.id] = Object.assign({ id: d.id }, d.data()); });
        } catch (e) {
          // firestore.rules: appointments are readable by isOwner(resource.data.userId)
          // or a platform admin, so a repUid query is permission-denied for everyone
          // else BY DESIGN (smart-calendar.js says the same). The userId lane carries
          // the owner's rows; counting the repUid denial as a failed read put "could
          // not load today's appointments" on every Today (walk 2026-10-13).
          if (lanes[i] === 'repUid' && e && e.code === 'permission-denied') continue;
          failedLanes++; console.warn('[today] appointments (' + lanes[i] + '):', e && (e.code || e.message));
        }
      }
      // A failed lane must not blank the schedule: keep what an earlier read
      // found (same day) and SAY the list may be incomplete (appts.failed).
      if (failedLanes && appts.day === day) appts.rows.forEach(function (r) { if (r && r.id && !byId[r.id]) byId[r.id] = r; });
      appts.rows = Object.keys(byId).map(function (k) { return byId[k]; });
      appts.failed = failedLanes > 0;
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
    var computeFailed = [];   // a rule that threw is named on Today, never a quiet empty
    if (HA && typeof HA.groupNeeds === 'function' && Array.isArray(HA.lastRows)) {
      // Labels (2026-10-12): home-attention.js loaded them with the rows; a
      // personal / spam / quiet number is already off these groups.
      try { groups = HA.groupNeeds(HA.lastRows, now, HA.lastLabels || null); } catch (_) { groups = []; computeFailed.push('your calls list'); }
    }
    // A promise Jo made on a call is Jo's word: a label that hides the number
    // (contact labels, 'hide') must never swallow it. Any open, unhandled call
    // carrying one that the needs-you rule dropped comes back as its own group.
    if (HA && Array.isArray(HA.lastRows)) {
      var have = {};
      groups.forEach(function (g) { (g.calls || []).forEach(function (c) { have[c.id] = true; }); });
      HA.lastRows.forEach(function (c) {
        if (!c || have[c.id] || c.handledAtMs || c.taskDone === true || c.status === 'personal') return;
        var p = c.promise;
        if (!p || p.kind !== 'promise' || p.done === true) return;
        var key = typeof HA.callerKey === 'function' ? HA.callerKey(c) : 'id:' + c.id;
        var g = groups.filter(function (x) { return x.key === key; })[0];
        if (!g) { g = { key: key, calls: [], latestMs: 0 }; groups.push(g); }
        g.calls.push(c);
        have[c.id] = true;
      });
    }
    // Handled earlier this session, but the same person has a call NEWER than the
    // moment Jo handled it (a second missed call at 2 pm): that row comes back.
    groups.forEach(function (g) {
      if (handledAt[g.key] && (g.latestMs || (g.calls[0] && g.calls[0].startedAtMs) || 0) > handledAt[g.key]) unmarkHandled(g.key);
    });
    var R = w.NBDRevenue;
    var fresh = R && typeof R.cached === 'function' ? R.cached() : null;
    if (fresh) { inv.rows = fresh; inv.at = Date.now(); inv.failed = false; }
    else if (R && typeof R.loadInvoices === 'function' && Date.now() - inv.at > 600000) {
      inv.at = Date.now();
      // loadInvoices never rejects: a failed query resolves [] and leaves
      // cached() null (a genuinely empty list is cached as []). Only AFTER the
      // read settles with nothing cached AND nothing earlier to show is it
      // "failed"; while it is in flight it is merely pending.
      inv.busy = true;
      var settle = function () {
        inv.busy = false;
        // Take the rows NOW: a data refresh right after this drops the shared cache.
        var rows = typeof R.cached === 'function' ? R.cached() : null;
        var ok = typeof R.cached === 'function' ? !!rows : true;
        if (rows) { inv.rows = rows; inv.at = Date.now(); }
        if (ok) inv.failed = false; else if (inv.rows === null) inv.failed = true;
        schedule();
      };
      R.loadInvoices().then(settle, function () { inv.busy = false; if (inv.rows === null) inv.failed = true; schedule(); });
    }
    var invoices = inv.rows || [];
    var IP = w.InvoicePipeline;
    var nns = null;
    if (w.NBDNoNextStep && typeof w.NBDNoNextStep.compute === 'function') {
      // The deck (no-next-step.js openDeck) swipes r.people — count what it opens.
      try { var r = w.NBDNoNextStep.compute(); nns = isViewer() ? null : { count: ((r && r.people) || []).length }; } catch (_) { nns = null; computeFailed.push('leads with no next step'); }
    }
    var leads = w._leads || [];
    // Estimates to follow up (#2136): its own pure rule over the same leads.
    var EF = w.NBDEstimateFollowups;
    var estRows = [];
    if (EF && typeof EF.computeFollowups === 'function') {
      try { estRows = EF.computeFollowups(leads, now).rows || []; } catch (_) { estRows = []; computeFailed.push('estimate follow-ups'); }
    }
    var hiddenCalls = 0;
    if (HA && typeof HA.hiddenPeople === 'function' && Array.isArray(HA.lastRows)) {
      try { hiddenCalls = HA.hiddenPeople(HA.lastRows, now, HA.lastLabels || null); } catch (_) { hiddenCalls = 0; computeFailed.push('people hidden by labels'); }
    }
    var plan_ = P.buildTodayPlan({
      now: now, leads: leads, tasksByLead: w._taskCache || {},
      appointments: appts.rows, jobs: jobsOf(leads),
      callGroups: groups,
      invoices: invoices,
      isOwedInvoice: R && R.isOwedInvoice, owedDollarsOf: R && R.owedDollarsOf,
      invoiceOverdue: w.NBDJurisdiction && typeof w.NBDJurisdiction.invoiceOverdue === 'function' ? w.NBDJurisdiction.invoiceOverdue : null,
      tz: w.NBDJurisdiction ? w.NBDJurisdiction.resolveTimeZone(typeof w._legal === 'function' ? w._legal() : w._companyProfile) : undefined,
      isDepositDraft: IP && typeof IP.isDepositDraft === 'function' ? IP.isDepositDraft : null,
      stripeNeedsReview: (HA && HA.lastCounts && HA.lastCounts.stripe) || 0,
      noNextStep: nns,
      estimateRows: estRows,
      isSnoozed: w.LeadSnooze && typeof w.LeadSnooze.isSnoozed === 'function' ? w.LeadSnooze.isSnoozed : null,
      handled: handled,
      env: { stageRole: w.stageRole },
      // Promise capture (2026-10-12): the waiting threshold and, when contact
      // labels are loaded, whether a promised number is one Jo hid.
      waitingDays: w.NBDPromise ? w.NBDPromise.waitingDays() : undefined,
      isHiddenNumber: function (d) {
        var LB = w.NBDContactLabels;
        var l = LB && typeof LB.get === 'function' ? LB.get(d) : null;
        return !!(l && l.policy === 'hide');
      },
    });
    plan_.hiddenCalls = hiddenCalls;
    plan_.computeFailed = computeFailed;
    return plan_;
  }

  // ── paint ────────────────────────────────────────────────────────────
  function btn(act, key, label, extra) {
    return '<button type="button" class="tp-btn' + (extra ? ' ' + extra : '') + '" data-tp-act="' + act + '" data-tp-key="' + esc(key) + '">' + label + '</button>';
  }
  // A button that names one task (a promise / waiting item) inside its row.
  function pbtn(act, key, id, label, extra) {
    return '<button type="button" class="tp-btn' + (extra ? ' ' + extra : '') + '" data-tp-act="' + act + '" data-tp-key="' + esc(key) + '" data-tp-id="' + esc(id) + '">' + label + '</button>';
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
  // An unfiled call from a customer's own number rides INSIDE that person's row
  // (today-plan.js phoneCalls): one person is one row, and the call is still
  // there with its own button - never hidden behind the promise.
  function ucalls(r, ro) {
    return (r.phoneCalls || []).map(function (u) {
      var why = [u.urgent ? '<b class="tp-hot">urgent</b>' : '', u.missed ? 'missed call' : '', u.text && !u.missed ? 'texts' : '', u.count > 1 ? u.count + ' open' : ''].filter(Boolean).join(' · ');
      var txt = 'Also an unfiled call from this number' + (why ? ' · ' + why : '') + (u.summary ? ' · ' + esc(u.summary) : '');
      if (u.promise) txt += ' · Promised: ' + esc(u.promise.text);
      if (u.resurfaced) txt += ' · <b class="tp-hot">' + (u.resurfaced === 'lead' ? 'hidden number matches a customer' : 'hidden number is calling a lot') + '</b>';
      var canRehide = !ro && u.resurfaced && u.phone && (((w._userClaims || {}).role || '') !== 'sales_rep');
      var acts = (canRehide ? btn('rehide', u.key, 'Keep hidden') : '') + (ro ? '' : (u.promise ? pbtn('ckept', u.key, u.promise.callId, '✓ Kept it', 'tp-go') + pbtn('cmove', u.key, u.promise.callId, 'Move') : btn('handled', u.key, '✓ Handled', 'tp-go')));
      return '<div class="tp-sub tp-ucall" data-tp-ucall="' + esc(u.key) + '">' + txt + (acts ? '<div class="tp-acts">' + acts + '</div>' : '') + '</div>';
    }).join('');
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
      var kept = '';
      if (r.promise) {
        sub += (sub ? ' · ' : '') + 'Promised: ' + esc(r.promise.text) + (r.promise.missLabel ? ' <span class="tp-miss' + (r.promise.hot ? ' is-hot' : '') + '">' + esc(r.promise.missLabel) + '</span>' : '');
        // A promise cannot be dismissed: it is kept, or it gets a new date.
        kept = ro ? '' : pbtn('ckept', r.key, r.promise.callId, '✓ Kept it', 'tp-go') + pbtn('cmove', r.key, r.promise.callId, 'Move');
      }
      // Per-number label (2026-10-12): a chip when one is set, and a 🏷 Label
      // button for anyone who may write labels (not a viewer, not a rep).
      var LB = w.NBDContactLabels;
      var lab = LB && r.phone ? LB.get(r.phone) : null;
      var LG = w.NBDContactLabelsLogic;
      var chip = lab && LG ? LG.chipFor(lab) : null;
      if (r.resurfaced) sub += (sub ? ' · ' : '') + '<b class="tp-hot">' + (r.resurfaced === 'lead' ? 'hidden number matches a customer' : 'hidden number is calling a lot') + '</b>';
      if (chip) sub += (sub ? ' · ' : '') + '<span class="cl-chip cl-chip-' + chip.tone + '" title="' + esc(chip.title) + '">🏷 ' + esc(chip.text) + '</span>';
      var canLabel = !ro && r.phone && (((w._userClaims || {}).role || '') !== 'sales_rep');
      var acts = link(tel(r.phone), 'Call') + link(r.phone ? 'sms:+1' + r.phone : '', 'Text') + (canLabel && r.resurfaced ? btn('rehide', r.key, 'Keep hidden') : '') + (canLabel ? btn('label', r.key, '🏷 Label') : '') + (r.promise ? kept : (ro ? '' : btn('handled', r.key, '✓ Handled', 'tp-go')));
      return row(r.key, esc(r.name || fmtPhone(r.phone) || 'Unknown caller'), sub + ucalls(r, ro), acts);
    });
    // Promises (2026-10-12): each one listed with its why and its miss count;
    // the only exits are Kept it and a new date (Move).
    var pm = (p.promises || []).map(function (r) {
      var lines = r.promiseTasks.map(function (t) {
        var miss = t.missLabel ? ' <span class="tp-miss' + (t.hot ? ' is-hot' : '') + '">' + esc(t.missLabel) + '</span>' : '';
        var late = t.overdue ? '<b class="tp-hot">overdue</b> ' : '';
        var b = ro ? '' : '<div class="tp-prom-btns">' + pbtn('pkept', r.key, t.id, '✓ Kept it', 'tp-go') + pbtn('pmove', r.key, t.id, 'Move') + '</div>';
        return '<div class="tp-prom-line"><div class="tp-prom-text">' + late + esc(t.text) + miss + '</div>' + b + '</div>';
      }).join('');
      var tag = r.hiddenNumber ? ' <span class="tp-tag" title="You labeled this number hidden. Your promise still shows.">number hidden</span>' : '';
      var more = r.tasks.length ? '<div class="tp-sub">' + r.tasks.slice(0, 2).map(function (t) { return esc(t.text || t.title || 'Task'); }).join(' · ') + '</div>' : '';
      var acts = link(tel(r.phone), 'Call') + link(r.phone ? 'sms:+1' + r.phone : '', 'Text') + link(custUrl(r.leadId), 'Open');
      return '<div class="tp-row tp-promise" data-tp-row="' + esc(r.key) + '"><div class="tp-main"><div class="tp-name">' + esc(r.name) + tag + '</div><div class="tp-prom">' + lines + '</div>' + more + ucalls(r, ro) + '</div><div class="tp-acts">' + acts + '</div></div>';
    });
    // Waiting on them (2026-10-13): ONE row per PERSON, the count says people.
    // Each item inside keeps its own Nudge / Still waiting / Mark dead (they
    // can go to different recipients); the handlers look the item up by its
    // 'wait:<lead>/<task>' key in the flat p.waiting list.
    var wt = (p.waitingPeople || []).map(function (g) {
      var lines = g.items.map(function (r) {
        var bits = ['Waiting on ' + esc(r.onLabel) + ' · ' + r.days + (r.days === 1 ? ' day' : ' days')];
        if (r.why) bits.push(esc(r.why));
        if (r.nudgeCount) bits.push('nudged ' + r.nudgeCount + (r.nudgeCount === 1 ? ' time' : ' times'));
        if (r.missLabel) bits.push(esc(r.missLabel));
        var b = ro ? '' : '<div class="tp-acts">' + pbtn('pnudge', r.key, r.taskId, '✉ Nudge', 'tp-go') + pbtn('pstill', r.key, r.taskId, 'Still waiting') + pbtn('pdead', r.key, r.taskId, 'Mark dead') + '</div>';
        return '<div class="tp-prom-line"><div class="tp-prom-text">' + bits.join(' · ') + '</div>' + b + '</div>';
      }).join('');
      return '<div class="tp-row tp-promise tp-waitrow" data-tp-row="' + esc(g.key) + '"><div class="tp-main"><div class="tp-name">' + esc(g.name) + ' <span class="tp-tag">Waiting</span></div><div class="tp-prom">' + lines + '</div></div><div class="tp-acts">' + link(custUrl(g.leadId), 'Open') + '</div></div>';
    });
    var pr = p.promised.map(function (r) {
      var bits = r.tasks.map(function (t) { return esc(t.text || t.title || 'Task'); }).concat(r.promises.map(function (s) { return 'You said: ' + esc(s); }));
      var when = r.overdue ? '<b class="tp-hot">overdue</b>' : (r.dueYmd ? 'due today' : 'promised');
      var acts = (ro ? '' : btn('done', r.key, '✓ Done', 'tp-go') + btn('tomorrow', r.key, 'Tomorrow')) + link(custUrl(r.leadId), 'Open');
      return row(r.key, esc(r.name), when + (bits.length ? ' · ' + bits.slice(0, 3).join(' · ') : '') + ucalls(r, ro), acts);
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
      // Money figures carry .ui-money (the --font-money face, tabular).
      var money = '<span class="ui-money">' + esc(P.fmtCents(r.cents)) + '</span>';
      if (r.kind === 'deposit') return row(r.key, esc(r.name), 'Draft deposit ' + money + ' · not sent', link(r.leadId ? custUrl(r.leadId) : '', 'Review', 'tp-go') + (r.leadId ? '' : btn('goto', 'money', 'Review', 'tp-go')));
      // One tap to the Record payment sheet for THIS invoice (phone audit
      // 2026-10-07 #2: "Open" landed at the top of the customer page, ~12
      // screens above Record payment). customer-pay-link.js opens it.
      return row(r.key, esc(r.name), money + ' owed' + (r.overdue ? ' · <b class="tp-hot">past due</b>' : '') + (r.number ? ' · #' + esc(r.number) : ''),
        link(tel(r.phone), 'Call') + (r.leadId ? link(payUrl(r.leadId, r.invoiceId), ro ? 'Open' : '💵 Record payment', 'tp-go') : btn('goto', 'money', 'Open', 'tp-go')));
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
    var NP = w.NBDPromise;
    var wdays = '';
    var pend = p.waitingPending || 0;
    if ((wt.length || pend) && NP && !ro) {
      var opts = '';
      for (var wd = 1; wd <= 14; wd++) opts += '<option value="' + wd + '"' + (wd === NP.waitingDays() ? ' selected' : '') + '>' + wd + '</option>';
      // The "Nudge me on" date set on each item wins; this is the default a NEW
      // waiting item (and "Still waiting") starts from.
      wdays = '<label class="tp-wait-step">new items: nudge after <select data-tp-wdays aria-label="Default days before a new waiting item asks for a nudge">' + opts + '</select> days</label>';
    }
    // Label suggestions (phase 2b): at most 3, Accept / Not this, nothing hides on one tap.
    var CS = w.NBDContactSuggest;
    var sugList = [];
    try { sugList = !ro && CS && typeof CS.forToday === 'function' ? CS.forToday() : []; } catch (_) { sugList = []; }
    var sugHtml = sugList.length ? '<div class="tp-sec tp-sugs" data-tp-sec="suggestions">' + sugList.map(function (s) { return CS.chipHtml(s); }).join('') + '</div>' : '';
    var body = section('appts', 'Appointments', a) + section('promises', 'Promises', pm) + section('calls', 'Calls owed', c) + section('promised', 'Promised follow-ups', pr) + section('estimates', 'Estimates to follow up', e) +
      section('money', 'Money to collect', m) + section('waiting', 'Waiting on them', wt, wdays) + section('stalled', 'Stalled leads', s, deck) +
      // Thursday's calls + the daily "handled" recap (js/thursday-handled.js; '' until loaded, flag-gated).
      (w.NBDThursdayHandled ? w.NBDThursdayHandled.todayHtml() : '');
    // No item has been waited out yet: say how many are quietly waiting, and keep
    // the threshold reachable (otherwise the stepper would only exist once it is too late).
    var quiet = !wt.length && pend ? '<div class="tp-sub tp-waitquiet">Waiting on others for ' + pend + (pend === 1 ? ' customer' : ' customers') + ', no nudge due yet' + (wdays ? ' · ' + wdays : '') + '</div>' : '';
    // A failed calls read (home-attention.js lastCounts.callsFailed) is NOT an
    // empty day: say so, never "Nothing on the list" (QA 2026-10-13, fail-open).
    var HAn = w.NBDHomeAttention;
    var HAc = HAn && HAn.lastCounts;
    var readFailed = !!(HAc && HAc.callsFailed);
    // Not read YET (home-attention.js boots 1.5 s after the page): unknown, not clear.
    var notChecked = !(HAn && Array.isArray(HAn.lastRows)) && !readFailed;
    var partial = [];
    if (HAc && HAc.callsCapped) partial.push('only your newest ' + (HAc.callsCap || '') + ' calls were read');
    if (HAc && HAc.textsCapped) partial.push('only your newest ' + (HAc.textsCap || '') + ' days of texts were read');
    if (HAc && HAc.oldCapped) partial.push('older open promises may not be listed');
    if (HAc && HAc.oldFailed) partial.push('old promises could not be checked');
    var failBanner = readFailed ? '<div class="tp-sub tp-readfail" role="status"><b class="tp-hot">could not check your calls</b> This list may be missing people. It is NOT an all-clear. <button type="button" class="tp-btn" data-tp-act="retry" data-tp-key="calls">Try again</button></div>'
      : (partial.length ? '<div class="tp-sub tp-readfail" role="status"><b class="tp-hot">partial list</b> ' + esc(partial.join('; ')) + '. Not an all-clear. <button type="button" class="tp-btn" data-tp-act="goto" data-tp-key="calls">Open the Call Center</button></div>' : '');
    // Every OTHER read behind Today: a failure is named, never a quiet zero. A
    // read still in flight is not on this list (it is pending, not failed).
    var otherFail = [];
    if (HAc && HAc.stripeFailed) otherFail.push('Stripe payments that need a customer');
    if (appts.failed) otherFail.push("today's appointments");
    if (inv.failed) otherFail.push('money owed (invoices)');
    (p.computeFailed || []).forEach(function (n) { otherFail.push(n); });
    // Still being read (in flight): unknown, not clear - and not a failure either.
    var pendingOther = !!(appts.busy || inv.busy);
    if (otherFail.length) failBanner += '<div class="tp-sub tp-readfail" role="status" data-tp-fail="reads"><b class="tp-hot">could not load</b> ' + esc(otherFail.join('; ')) + '. Those parts of your day may be missing - this is NOT an all-clear. <button type="button" class="tp-btn" data-tp-act="retry" data-tp-key="reads">Try again</button></div>';
    var anyFail = readFailed || otherFail.length > 0;
    return '<div class="tp-hd"><div class="tp-title" data-tp-total="' + p.total + '">' + esc((anyFail || notChecked || pendingOther) && !p.total ? "Can't confirm your day yet" : P.headline(p.total)) + '</div>' +
      (storm ? '<div class="tp-storm">' + esc(storm) + '</div>' : '') + '</div>' + failBanner +
      (p.hiddenCalls > 0 ? '<div class="tp-sub tp-hidden">' + p.hiddenCalls + (p.hiddenCalls === 1 ? ' person' : ' people') + ' hidden by labels · <button type="button" class="tp-more tp-hd-btn" data-tp-act="goto" data-tp-key="calls">See them in the Call Center</button></div>' : '') +
      sugHtml + (body || (anyFail ? '' : (notChecked ? '<div class="tp-empty">Checking your calls…</div>' : (pendingOther ? '<div class="tp-empty">Checking your day…</div>' : '<div class="tp-empty">Nothing on the list. Go knock some doors.</div>')))) + quiet;
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
    var lists = [p.calls, p.promises || [], p.promised, p.waiting || [], p.money, p.stalled];
    for (var i = 0; i < lists.length; i++) for (var j = 0; j < lists[i].length; j++) if (lists[i][j].key === key) return lists[i][j];
    // An unfiled call riding inside a person's row (phoneCalls) acts as its own row.
    for (var i2 = 0; i2 < lists.length; i2++) for (var j2 = 0; j2 < lists[i2].length; j2++) {
      var pc = lists[i2][j2].phoneCalls || [];
      for (var k = 0; k < pc.length; k++) if (pc[k].key === key) return pc[k];
    }
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
    markHandled(key);
    render();
    var res = await Promise.allSettled(jobs);
    var bad = res.filter(function (x) { return x.status === 'rejected'; }).length;
    if (bad) {
      unmarkHandled(key);
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
    if (a === 'retry') {
      try {
        if (w.NBDHomeAttention && w.NBDHomeAttention.render) w.NBDHomeAttention.render(true);
        // 'reads': also re-ask for the appointments / invoices that failed.
        if (key === 'reads') {
          if (appts.failed) loadAppointments(true);
          if (inv.failed && w.NBDRevenue && typeof w.NBDRevenue.loadInvoices === 'function') {
            inv.failed = false; inv.at = Date.now(); inv.busy = true;
            w.NBDRevenue.loadInvoices({ force: true }).then(function () {
              inv.busy = false;
              var rows = typeof w.NBDRevenue.cached === 'function' ? w.NBDRevenue.cached() : null;
              if (rows) { inv.rows = rows; inv.at = Date.now(); }
              else if (inv.rows === null) inv.failed = true;
              schedule();
            }, function () { inv.busy = false; if (inv.rows === null) inv.failed = true; schedule(); });
          }
        }
      } catch (_) { /* best effort */ }
      return;
    }
    if (a === 'fudeck') {
      var ids = new Set(((last && last.stalled) || []).map(function (r) { return r.leadId; }));
      var list = (w._leads || []).filter(function (l) { return l && ids.has(l.id); });
      if (w.NBDFollowUpDeck) w.NBDFollowUpDeck.open(list);
      return;
    }
    if (isViewer()) return;
    if (/^(pkept|pmove|pdead|pstill|pnudge|ckept|cmove)$/.test(a)) { promiseAct(a, key, t.getAttribute('data-tp-id') || ''); return; }
    if (a === 'label') { openLabel(key); return; }
    if (a === 'rehide') { rehide(key); return; }
    // Handling a call asks what Jo owes (the promise sheet); Nothing owed is the old Handled.
    if (a === 'handled') { handleViaSheet(key); return; }
    act(a, key).catch(function (e) { console.warn('[today] action failed', e); });
  });

  // ── promises + waiting (2026-10-12; promise-ui.js, lazy bundle 'promise') ──
  // The 'promise' lazy bundle is registered HERE, not in script-loader.js (a
  // blocking script with no byte headroom: dashboard-boot-budget). This
  // deferred file always runs before the Call Center / customer page load it.
  if (w.ScriptLoader && w.ScriptLoader.bundles && !w.ScriptLoader.bundles.promise) {
    w.ScriptLoader.bundles.promise = ['css/promise.css?v=1', 'js/promise-logic.js?v=2', 'js/promise-ui.js?v=2'];
  }
  var promiseLoad = null;
  function ensurePromise() {
    if (w.NBDPromise) return Promise.resolve(true);
    if (!promiseLoad) {
      promiseLoad = (w.ScriptLoader && typeof w.ScriptLoader.loadBundle === 'function')
        ? w.ScriptLoader.loadBundle('promise').then(function () { schedule(); return !!w.NBDPromise; }, function () { promiseLoad = null; return false; })
        : Promise.resolve(false);
    }
    return promiseLoad;
  }
  function leadOf(id) { return (w._leads || []).filter(function (l) { return l && l.id === id; })[0] || null; }
  function taskOf(leadId, taskId) { return ((w._taskCache || {})[leadId] || []).filter(function (t) { return t && t.id === taskId; })[0] || null; }
  async function handleViaSheet(key) {
    var r = findRow(key);
    if (!r) return;
    var ok = await ensurePromise();
    if (!ok || !w.NBDPromise) { act('handled', key).catch(function (e) { console.warn('[today] action failed', e); }); return; }
    w.NBDPromise.openSheet({
      mode: 'handle', name: r.name, leadId: r.leadId, lead: leadOf(r.leadId), callIds: r.callIds.slice(),
      summary: r.summary, why: (r.said && r.said[0]) || '',
      onDone: function (res) {
        // A saved promise becomes its OWN row, keyed 'lead:<id>' - the same key as
        // this call's row. Remembering that key as "handled" hid the promise
        // until the next page load (QA H4). The call itself is marked handled
        // locally by promise-ui (mirrorSaved), so it leaves "Calls owed" anyway.
        if (res && res.saved && res.kind && res.kind !== 'none') unmarkHandled(key); else markHandled(key);
        render();
      },
    });
  }
  async function promiseAct(a, key, id) {
    var ok = await ensurePromise();
    var NP = w.NBDPromise;
    if (!ok || !NP) { toast("Couldn't load the promise tools - try again in a moment", 'error'); return; }
    var r = findRow(key);
    if (!r) return;
    if (a === 'ckept') {
      // A promise riding on a call (no customer on file): kept = the call is handled.
      try { await callable('callCenterAction', { id: id, action: 'handled' }); markHandled(key); render(); if (w.NBDHomeAttention && w.NBDHomeAttention.render) w.NBDHomeAttention.render(true); }
      catch (e) { toast("Couldn't save that - check your connection and tap it again", 'error'); }
      return;
    }
    if (a === 'cmove') {
      NP.openSheet({ mode: 'move', name: r.name, moveText: r.promise ? r.promise.text : '', move: { type: 'call', callId: id }, onDone: function () { unmarkHandled(key); schedule(); if (w.NBDHomeAttention && w.NBDHomeAttention.render) w.NBDHomeAttention.render(true); } });
      return;
    }
    var task = taskOf(r.leadId, id);
    if (!task) { toast("Couldn't find that promise - refresh and try again", 'error'); return; }
    if (a === 'pmove') {
      var pt = (r.promiseTasks || []).filter(function (p) { return p.id === id; })[0];
      NP.openSheet({ mode: 'move', name: r.name, moveText: pt ? pt.text : '', move: { type: 'task', leadId: r.leadId, task: task }, onDone: schedule });
      return;
    }
    var fn = { pkept: NP.keep, pdead: NP.dead, pstill: NP.stillWaiting }[a];
    if (fn) { await fn(r.leadId, task); schedule(); return; }
    if (a === 'pnudge') { await NP.nudge(r); schedule(); }
  }
  doc.addEventListener('change', function (ev) {
    var s = ev.target && ev.target.closest ? ev.target.closest('[data-tp-wdays]') : null;
    if (!s || !w.NBDPromise) return;
    w.NBDPromise.setWaitingDays(s.value).then(function () { schedule(); });
  });

  // "Keep hidden": a hidden number came back; acknowledge it (label ackAtMs).
  function rehide(key) {
    var r = findRow(key);
    if (!r || !r.phone || !w.NBDContactLabels) return;
    w.NBDContactLabels.ack(r.phone);
  }
  // 🏷 Label: the sheet lives in the lazy 'contactlabels' bundle.
  function openLabel(key) {
    var r = findRow(key);
    if (!r || !r.phone) return;
    var lead = r.leadId ? (w._leads || []).filter(function (l) { return l && l.id === r.leadId; })[0] : null;
    var leadName = lead ? (((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()) : '';
    var open = function () {
      if (w.NBDContactLabels) w.NBDContactLabels.openSheet({ digits: r.phone, name: r.name, leadName: leadName });
      else toast("Couldn't open labels — try again in a moment", 'error');
    };
    if (w.NBDContactLabels) { open(); return; }
    if (w.ScriptLoader && typeof w.ScriptLoader.loadBundle === 'function') w.ScriptLoader.loadBundle('contactlabels').then(open, open);
    else open();
  }

  ['nbd:data-refreshed', 'nbd:attention-loaded', 'nbd:invoices-loaded', 'nbd:estimate-followups', 'nbd:labels-changed', 'nbd:thursday-handled-changed', 'nbd:suggestions-changed'].forEach(function (n) { w.addEventListener(n, schedule); });
  w.addEventListener('hashchange', function () {
    if (/^#?\/?(home)?$/.test(location.hash || '')) { loadAppointments(false); setTimeout(render, 200); }
  });
  function boot() {
    ensurePromise();
    // Away mode (js/away-mode.js): status line / hand-back card / backup cover list
    // on Home. A lazy bundle, so it adds no boot <script> tag; best-effort.
    try { if (w.ScriptLoader && typeof w.ScriptLoader.loadBundle === 'function') w.ScriptLoader.loadBundle('away'); } catch (_) { /* optional surface */ }
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
