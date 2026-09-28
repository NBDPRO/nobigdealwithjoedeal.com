/**
 * collected-revenue.js — the ONE definition of "revenue" in NBD Pro.
 *
 * Jo, 2026-09-28: "Revenue is always collected only. We can do projected
 * separately but that's literally projected." Any figure LABELLED revenue sums
 * money actually received — invoice payments, attributed to the date each
 * payment arrived. Won-job value, signed-estimate totals, accepted deals and
 * pipeline are projections and must be labelled that way where they appear.
 *
 * Before this file, 30 surfaces showed a revenue-type number and only five were
 * cash (the Home tile said "$32.7k" from closed leads while Reports said "$0"
 * from signed estimates). paymentsOf / collectedDollarsOf are the same logic as
 * money-dashboard.js, analytics-kpi.js and pages/leaderboard.js (kept in sync by
 * tests/money-field-contract.test.js); this module is the one the dashboard's
 * revenue surfaces share, plus ONE cached invoice load so they don't each query.
 *
 *   window.NBDRevenue.loadInvoices({force})  → Promise<invoice[]> (cached per account)
 *   window.NBDRevenue.cached()               → invoice[] | null (sync, last load)
 *   window.NBDRevenue.collectedBetween(invs, startMs, endMs, leadIdFilter?)
 *                                            → { total, count }  (dollars, payments)
 *   window.NBDRevenue.collectedByLead(invs, startMs, endMs) → { leadId: dollars }
 *   window.NBDRevenue.paymentsOf(inv)        → [{ amount, at, synthetic? }]
 *
 * Emits 'nbd:invoices-loaded' on window after each load. Invalidated on
 * 'nbd:data-refreshed' and when the signed-in account changes.
 */
(function () {
  'use strict';

  function toJSDate(v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') return v.toDate();
    if (typeof v.seconds === 'number') return new Date(v.seconds * 1000);
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function toMs(v) { var d = toJSDate(v); return d ? d.getTime() : 0; }

  function collectedDollarsOf(inv) {
    var total = parseFloat(inv.total) || 0;
    var bal = (inv.balanceDue != null) ? (parseFloat(inv.balanceDue) || 0) : 0;
    return Math.round(Math.max(0, total - bal) * 100) / 100;
  }

  // Same as money-dashboard.js / analytics-kpi.js / pages/leaderboard.js:
  // prefer the payments[] ledger (each credit dated), append a synthetic
  // remainder when the ledger sums short of total−balanceDue (pre-ledger
  // partials), and fall back to one lump dated lastPaymentAt||paidAt.
  function paymentsOf(inv) {
    if (Array.isArray(inv.payments) && inv.payments.length > 0) {
      var out = [];
      var ledgerCents = 0;
      var earliestAt = null, earliestMs = Infinity;
      for (var i = 0; i < inv.payments.length; i++) {
        var p = inv.payments[i] || {};
        var amt = parseFloat(p.amount);
        var at = p.at != null ? p.at : p.date;
        if (!(amt > 0) || at == null) continue;
        out.push({ amount: amt, at: at });
        ledgerCents += Math.round(amt * 100);
        var d = toJSDate(at);
        if (d && d.getTime() < earliestMs) { earliestMs = d.getTime(); earliestAt = at; }
      }
      if (out.length) {
        var actualCents = Math.round(collectedDollarsOf(inv) * 100);
        var remainderCents = actualCents - ledgerCents;
        if (remainderCents >= 1) {
          var remAt = earliestAt != null ? earliestAt
            : (inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt);
          if (remAt != null) out.push({ amount: remainderCents / 100, at: remAt, synthetic: true });
        }
        return out;
      }
    }
    var collected = collectedDollarsOf(inv);
    if (collected <= 0) return [];
    var payDate = inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt;
    if (payDate == null) return [];
    return [{ amount: collected, at: payDate }];
  }

  // start/end in ms, inclusive; either may be null (open-ended).
  function inRange(ms, startMs, endMs) {
    if (!ms) return false;
    if (startMs != null && ms < startMs) return false;
    if (endMs != null && ms > endMs) return false;
    return true;
  }

  function collectedBetween(invoices, startMs, endMs, leadIdFilter) {
    var totalCents = 0, count = 0;
    (invoices || []).forEach(function (inv) {
      if (!inv || inv.deleted === true) return;
      if (leadIdFilter && !leadIdFilter(inv.leadId)) return;
      paymentsOf(inv).forEach(function (p) {
        if (!inRange(toMs(p.at), startMs, endMs)) return;
        totalCents += Math.round((parseFloat(p.amount) || 0) * 100);
        count++;
      });
    });
    return { total: totalCents / 100, count: count };
  }

  function collectedByLead(invoices, startMs, endMs) {
    var cents = {};
    (invoices || []).forEach(function (inv) {
      if (!inv || inv.deleted === true || !inv.leadId) return;
      paymentsOf(inv).forEach(function (p) {
        if (!inRange(toMs(p.at), startMs, endMs)) return;
        cents[inv.leadId] = (cents[inv.leadId] || 0) + Math.round((parseFloat(p.amount) || 0) * 100);
      });
    });
    var out = {};
    Object.keys(cents).forEach(function (k) { out[k] = cents[k] / 100; });
    return out;
  }

  // ── One cached invoice load, scoped like money-dashboard.js ──
  function uid() { return (window._user && window._user.uid) || null; }
  function claims() { return window._userClaims || {}; }
  function isStaff() { var r = claims().role; return r === 'company_admin' || r === 'manager' || r === 'admin'; }
  function scopeKey() { return (uid() || '') + '|' + (claims().companyId || '') + '|' + (isStaff() ? 's' : 'u'); }

  var _cache = null, _cacheKey = null, _inflight = null, _failedAt = 0;
  var RETRY_AFTER_FAIL_MS = 30000;

  // Resolves to the invoices, or [] when they can't be loaded yet (no db /
  // user at boot, or a failed query). An empty resolve is NOT cached: callers
  // re-render only when cached() is non-null — re-rendering on every resolve
  // looped forever (render → load → [] → render …) and froze the page.
  function loadInvoices(opts) {
    var force = !!(opts && opts.force);
    var key = scopeKey();
    if (!force && _cache && _cacheKey === key) return Promise.resolve(_cache);
    if (!force && _inflight && _inflight.key === key) return _inflight.p;
    if (!force && _failedAt && Date.now() - _failedAt < RETRY_AFTER_FAIL_MS) return Promise.resolve([]);
    var db = window.db || window._db;
    var u = uid();
    if (!db || !u || !window.getDocs || !window.query || !window.where || !window.collection) {
      return Promise.resolve([]);
    }
    var staff = isStaff() && claims().companyId;
    var q = staff
      ? window.query(window.collection(db, 'invoices'), window.where('companyId', '==', claims().companyId))
      : window.query(window.collection(db, 'invoices'), window.where('createdBy', '==', u));
    var p = window.getDocs(q).then(function (snap) {
      if (scopeKey() !== key) return _cache || []; // account switched mid-flight
      _cache = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      _cacheKey = key;
      _failedAt = 0;
      try { window.dispatchEvent(new CustomEvent('nbd:invoices-loaded', { detail: { count: _cache.length } })); } catch (_) {}
      return _cache;
    }).catch(function (e) {
      console.warn('[NBDRevenue] invoice load failed:', e && e.message);
      _failedAt = Date.now();
      return (_cacheKey === key && _cache) ? _cache : [];
    }).finally(function () { if (_inflight && _inflight.p === p) _inflight = null; });
    _inflight = { key: key, p: p };
    return p;
  }

  function cached() { return (_cache && _cacheKey === scopeKey()) ? _cache : null; }
  function invalidate() { _cache = null; _cacheKey = null; }

  try { window.addEventListener('nbd:data-refreshed', invalidate); } catch (_) {}

  window.NBDRevenue = {
    paymentsOf: paymentsOf,
    collectedDollarsOf: collectedDollarsOf,
    collectedBetween: collectedBetween,
    collectedByLead: collectedByLead,
    loadInvoices: loadInvoices,
    cached: cached,
    invalidate: invalidate,
    _toMs: toMs,
  };
})();
