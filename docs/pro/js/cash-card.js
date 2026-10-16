/**
 * cash-card.js — the "Cash" card (2026-10-15, layouts feature N2).
 *
 * Close-and-collect on the screens that showed no money: Field, Crew, Focus,
 * Inbox and Mission (Classic and Bento already carry the Revenue tile, Island
 * the Classic Home under it). Each of those layouts leaves a [data-cash-slot]
 * in its own markup; a layout that repaints wipes it and the observer below
 * refills it (the closes-week.js pattern). data-cash-variant="compact" draws
 * the one-line strip.
 *
 * ONE definition of collected: NBDRevenue (collected-revenue.js) — the same
 * cached invoice load and the same collectedBetween() the Revenue tile and
 * Reports use, by the date each payment arrived. No second calculation.
 *   This week    since Monday 12:00 am, local time
 *   This month   since the 1st
 *   Goal         userSettings/{uid}.monthlyGoal — the same per-user field the
 *                Revenue tile's goal edits (Settings > Profile has the input).
 *                No goal set = no ring (this card never assumes one).
 *   Open         NBDRevenue.isOwedInvoice / owedDollarsOf (the one owed rule)
 *
 * Collect opens the existing Record payment flow for the OLDEST open invoice
 * (/pro/customer.html?id=<lead>&pay=<invoice>, the Today list's "Collect"
 * link); a viewer, or an invoice with no customer, lands on Money instead.
 * Nothing here charges, sends or writes.
 *
 * Loaded lazily (ScriptLoader bundle 'cashcard', kicked by today-home.js boot).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDCashCard) return;
  var w = window, doc = document;
  var html = { full: '', compact: '' };
  var model = null;
  var goalSynced = false;
  var askedAt = 0;                     // last invoice load this card asked for

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) {
    var v = Number(n) || 0;
    return v >= 10000 ? '$' + (Math.round(v / 100) / 10).toFixed(1).replace(/\.0$/, '') + 'k' : '$' + Math.round(v).toLocaleString('en-US');
  }
  function isViewer() { return ((w._userClaims || {}).role || '') === 'viewer'; }
  function toMs(v) {
    if (!v) return 0;
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = new Date(v).getTime();
    return isFinite(t) ? t : 0;
  }

  // ── pure ─────────────────────────────────────────────────────────────
  function weekStart(nowMs) {
    var d = new Date(nowMs); d.setHours(0, 0, 0, 0);
    var back = (d.getDay() + 6) % 7;            // Monday = 0
    d.setDate(d.getDate() - back);
    return d.getTime();
  }
  function monthStart(nowMs) { var d = new Date(nowMs); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }
  function goalOf(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : null; }
  /**
   * invs: invoice rows. R: NBDRevenue (collectedBetween, isOwedInvoice, owedDollarsOf).
   * Returns { week, month, goal, pct, open:{count,total}, oldest } — dollars.
   */
  function summarize(invs, R, nowMs, goal) {
    var list = Array.isArray(invs) ? invs : [];
    var week = R.collectedBetween(list, weekStart(nowMs), nowMs).total || 0;
    var month = R.collectedBetween(list, monthStart(nowMs), nowMs).total || 0;
    var open = list.filter(function (i) { return R.isOwedInvoice(i) && R.owedDollarsOf(i) > 0; });
    var total = open.reduce(function (s, i) { return s + R.owedDollarsOf(i); }, 0);
    var oldest = open.slice().sort(function (a, b) {
      return (toMs(a.createdAt) || toMs(a.issueDate) || Infinity) - (toMs(b.createdAt) || toMs(b.issueDate) || Infinity);
    })[0] || null;
    var g = goalOf(goal);
    return {
      week: week, month: month, goal: g, pct: g ? Math.min(100, Math.round(month / g * 100)) : null,
      open: { count: open.length, total: Math.round(total * 100) / 100 },
      oldest: oldest ? { id: String(oldest.id || ''), leadId: oldest.leadId ? String(oldest.leadId) : '', name: String(oldest.customerName || ''), owed: R.owedDollarsOf(oldest) } : null,
    };
  }
  function collectHref(oldest, viewer) {
    if (!oldest || !oldest.leadId || viewer) return '';
    return '/pro/customer.html?id=' + encodeURIComponent(oldest.leadId) + '&pay=' + encodeURIComponent(oldest.id || '1');
  }

  // ── goal: the Revenue tile's own field (local copy for the instant paint) ─
  function goal() {
    var g = null;
    try { g = goalOf(localStorage.getItem('nbd_monthly_goal')); } catch (_) {}
    if (g == null && !goalSynced && w._user && w.getDoc && w.doc && w.db) {
      goalSynced = true;
      Promise.resolve(w.getDoc(w.doc(w.db, 'userSettings', w._user.uid))).then(function (snap) {
        var v = snap && snap.exists() ? goalOf(snap.data().monthlyGoal) : null;
        if (v != null) {
          try { localStorage.setItem('nbd_monthly_goal', String(v)); } catch (_) {}
          var inp = doc.getElementById('cashGoalInput');
          if (inp && !inp.value) inp.__ccFilled = false;
          schedule();
        }
      }, function () {});
    }
    return g;
  }

  // ── paint ────────────────────────────────────────────────────────────
  function ring(pct) {
    var r = 16, c = 2 * Math.PI * r, on = Math.round(c * pct / 100 * 10) / 10;
    return '<svg class="cc-ring" viewBox="0 0 40 40" width="44" height="44" aria-hidden="true">' +
      '<circle class="cc-ring-bg" cx="20" cy="20" r="' + r + '" fill="none" stroke-width="5"/>' +
      '<circle class="cc-ring-on" cx="20" cy="20" r="' + r + '" fill="none" stroke-width="5" stroke-linecap="round" ' +
      'stroke-dasharray="' + on + ' ' + (Math.round(c * 10) / 10) + '" transform="rotate(-90 20 20)"/></svg>';
  }
  function collectBtn(m) {
    if (!m.open.count) return '';
    var href = collectHref(m.oldest, isViewer());
    var label = m.oldest && m.oldest.name && href ? 'Collect · ' + m.oldest.name.split(/\s+/)[0] : 'Collect';
    return href
      ? '<a class="cc-btn cc-btn-primary" href="' + esc(href) + '">' + esc(label) + '</a>'
      : '<button type="button" class="cc-btn cc-btn-primary" data-cc="money">Open invoices</button>';
  }
  function cardHtml(m, st, variant) {
    var compact = variant === 'compact';
    var out = '<div class="cc-card' + (compact ? ' cc-compact' : '') + '" role="region" aria-label="Cash collected">';
    if (st !== 'ok') {
      return out + '<div class="cc-hdr"><h3 class="cc-title">Cash</h3></div><p class="cc-note' + (st === 'failed' ? ' cc-warn' : '') + '" role="status">' +
        (st === 'failed' ? 'Could not load your invoices, so these numbers are not shown. This is not $0.' : 'Checking your invoices…') + '</p></div>';
    }
    var pctTxt = m.pct != null ? m.pct + '% of ' + money(m.goal) + ' goal' : '';
    out += '<div class="cc-hdr"><h3 class="cc-title">Cash collected</h3>' + (pctTxt ? '<span class="cc-aside">' + esc(pctTxt) + '</span>' : '') + '</div>';
    out += '<div class="cc-row">' + (m.pct != null ? ring(m.pct) : '') +
      '<div class="cc-fig"><span class="cc-num">' + esc(money(m.week)) + '</span><span class="cc-lbl">this week</span></div>' +
      '<div class="cc-fig"><span class="cc-num">' + esc(money(m.month)) + '</span><span class="cc-lbl">this month</span></div>' +
      '</div>';
    out += '<div class="cc-open"><span class="cc-open-txt">' + (m.open.count
      ? esc(m.open.count + (m.open.count === 1 ? ' open invoice · ' : ' open invoices · ') + money(m.open.total) + ' owed')
      : 'No open invoices') + '</span>' + collectBtn(m) + '</div>';
    if (!compact) out += '<p class="cc-fine">Collected = payments received, by the day they arrived.' + (m.pct == null ? ' Set a monthly goal in Settings to see progress.' : '') + '</p>';
    return out + '</div>';
  }

  function state() {
    var R = w.NBDRevenue;
    if (!R || typeof R.cached !== 'function') return { st: 'checking', invs: null };
    var invs = R.cached();
    if (invs) return { st: 'ok', invs: invs };
    var s = typeof R.status === 'function' ? R.status() : 'unknown';
    if (s === 'failed') return { st: 'failed', invs: null };
    // Ask once a minute at most: a read that stays unconfirmed must not loop.
    if (typeof R.loadInvoices === 'function' && Date.now() - askedAt > 60000) {
      askedAt = Date.now();
      Promise.resolve(R.loadInvoices()).then(schedule, schedule);
    }
    return { st: 'checking', invs: null };
  }
  function hosts() { return Array.prototype.slice.call(doc.querySelectorAll('[data-cash-slot]')); }
  function variantOf(el) { return el.getAttribute('data-cash-variant') === 'compact' ? 'compact' : 'full'; }
  function paintHost(el) {
    var h = html[variantOf(el)];
    if (el.__ccHtml === h && el.firstChild) return;
    el.__ccHtml = h;
    el.innerHTML = h;
    el.hidden = !h;
  }
  function render() {
    fillGoalInput();
    if (!hosts().length && html.full) return;
    var s = state();
    var R = w.NBDRevenue;
    model = s.st === 'ok' ? summarize(s.invs, R, Date.now(), goal()) : null;
    html.full = cardHtml(model, s.st, 'full');
    html.compact = cardHtml(model, s.st, 'compact');
    hosts().forEach(paintHost);
  }
  var pending = 0;
  function schedule() { if (pending) return; pending = setTimeout(function () { pending = 0; render(); }, 250); }

  // ── Settings > Profile: the monthly goal (#cashGoalPanel) ─────────────
  function toast(m, t) { if (typeof w.showToast === 'function') w.showToast(m, t || 'info'); }
  function fillGoalInput() {
    var el = doc.getElementById('cashGoalInput');
    if (!el || el.__ccFilled || doc.activeElement === el) return;
    el.__ccFilled = true;
    var g = goal();
    el.value = g != null ? String(g) : '';
  }
  function saveGoal(next) {
    try { if (next != null) localStorage.setItem('nbd_monthly_goal', String(next)); else localStorage.removeItem('nbd_monthly_goal'); } catch (_) {}
    var done = Promise.resolve(true);
    if (w._user && w.setDoc && w.doc && w.db) {
      // the Revenue tile's own field (widgets.js): 0 = no goal set
      done = Promise.resolve(w.setDoc(w.doc(w.db, 'userSettings', w._user.uid), { monthlyGoal: next != null ? next : 0 }, { merge: true }))
        .then(function () { return true; }, function () { return false; });
    }
    return done.then(function (ok) {
      try { w.dispatchEvent(new CustomEvent('nbd:monthly-goal', { detail: { goal: next } })); } catch (_) {}
      if (!ok) toast('Goal kept on this device, but it did not save to your account. Check your connection.', 'error');
      else toast(next != null ? 'Monthly goal set to ' + money(next) + ' collected.' : 'Monthly goal cleared.', 'success');
      return ok;
    });
  }
  doc.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest('[data-cc]') : null;
    if (!t) return;
    var a = t.getAttribute('data-cc');
    if (a === 'money') { ev.preventDefault(); if (typeof w.goTo === 'function') w.goTo('money'); return; }
    if (a === 'goal-save') {
      ev.preventDefault();
      var el = doc.getElementById('cashGoalInput');
      var raw = String(el ? el.value : '').replace(/[^0-9.]/g, '');
      var n = goalOf(raw);
      if (n == null) { toast('Enter a dollar amount above 0, or tap Clear for no goal.', 'warning'); return; }
      saveGoal(Math.round(n));
      return;
    }
    if (a === 'goal-clear') {
      ev.preventDefault();
      var el2 = doc.getElementById('cashGoalInput');
      if (el2) el2.value = '';
      saveGoal(null);
    }
  });
  ['nbd:data-refreshed', 'nbd:invoices-loaded', 'nbd:invoices-settled', 'layoutchange', 'nbd:monthly-goal'].forEach(function (n) { w.addEventListener(n, schedule); });
  var refillQueued = false;
  function refill() {
    refillQueued = false;
    fillGoalInput();
    if (!html.full) { schedule(); return; }
    hosts().forEach(function (el) { if (!el.firstChild || el.__ccHtml !== html[variantOf(el)]) paintHost(el); });
  }
  try {
    new MutationObserver(function () {
      if (refillQueued) return;
      refillQueued = true;
      (w.requestAnimationFrame || setTimeout)(refill);
    }).observe(doc.body, { childList: true, subtree: true });
  } catch (_) { /* events still paint */ }
  render();

  w.NBDCashCard = { render: render, model: function () { return model; }, _summarize: summarize, _cardHtml: cardHtml, _collectHref: collectHref, _weekStart: weekStart };
})();
