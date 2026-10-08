/**
 * catchup-logic.js — "Catch up my numbers" (2026-10-04). Pure rules, no DOM.
 *
 * The owner tenant's read-only audit behind #2150: 38 won jobs ($92.5k
 * booked) with payments on 6 ($3,650), job costs on 1, a sold package on
 * none, 10 close dates equal to the created date, 25 losses with 3 reasons,
 * and 36 of 104 Thumbtack leads costed. The numbers screens are only as real
 * as that data, so this screen walks Jo through it one card at a time.
 *
 *   jobDeck(leads, ctx)      — every won job (numbers-logic isSale), what it
 *                              is missing, and the progress ("12 of 38 done").
 *   lostDeck(leads, ctx)     — losses with no reason.
 *   thumbtackMonths(...)     — each month since the first Thumbtack lead, with
 *                              the spend entered (or not).
 *   paidInFullPlan(target)   — the ONE amount "Paid in full? Yes" records:
 *                              the job total from the invoice / estimate / job
 *                              value already on file. No total → no shortcut
 *                              (never an invented amount).
 *   defaultPaymentYmd(lead)  — a sensible date to offer for that payment (the
 *                              day the job reached Final Payment / Install
 *                              Complete, else the sale date). Jo can change it;
 *                              it is never silently "today".
 *   undo helpers             — every write is logged with what it replaced.
 *
 * Rules shared with the numbers screens come from numbers-logic.js
 * (window.NBDNumbers / require) so the deck and the Sunday review agree.
 * Money in cents. window.NBDCatchUpLogic in the browser; module.exports for
 * tests (tests/catchup-2026-10-04.test.js).
 */
(function (root) {
  'use strict';

  var N = (root && root.NBDNumbers) || null;
  if (!N && typeof require === 'function') {
    try { N = require('./numbers-logic.js'); } catch (_) { N = null; }
  }
  function Nn() { return (root && root.NBDNumbers) || N; }

  var MISSING_KEYS = ['payment', 'closeDate', 'package', 'costs'];
  var MISSING_LABELS = { payment: 'Payments', closeDate: 'Close date', package: 'Package', costs: 'Job costs' };
  var LOG_MAX = 40;
  var DAY = 86400000;

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdOf(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  /** Lead ids with a job cost: linked expenses + the lead's own cost fields. */
  function costedIds(leads, expenses, roleFn) {
    var cn = Nn().costsNeeded(leads || [], expenses || [], roleFn);
    var out = {};
    Object.keys(cn.costCentsByLead || {}).forEach(function (k) { if (cn.costCentsByLead[k] > 0) out[k] = 1; });
    return out;
  }

  /**
   * What one won job is missing.
   * ctx: { collectedByLead: { leadId: dollars }, costed: { leadId: 1 }, roleFn }
   */
  function missingFor(lead, ctx) {
    var c = ctx || {};
    var N1 = Nn();
    var paid = (c.collectedByLead || {})[lead.id];
    return {
      payment: !(Number(paid) > 0),
      closeDate: N1.needsCloseDate(lead, c.roleFn),
      package: !N1.soldTierOf(lead),
      costs: !(c.costed || {})[lead.id],
    };
  }
  function missingCount(m) { return MISSING_KEYS.reduce(function (s, k) { return s + (m[k] ? 1 : 0); }, 0); }

  /**
   * The won-jobs deck.
   * ctx: { collectedByLead, expenses, roleFn,
   *        progress: { doneJobs: { leadId: true } },   // Jo tapped Done
   *        skipped: [leadId…] }                         // this session's Skips
   * A job is DONE when Jo tapped Done on it or nothing is missing.
   * queue = the jobs still to do: most gaps first, then the biggest booked
   * value; skipped jobs go to the back in the order they were skipped.
   * → { items, queue (lead ids), done, total, text }
   */
  function jobDeck(leads, ctx) {
    var c = ctx || {};
    var N1 = Nn();
    var marked = (c.progress && c.progress.doneJobs) || {};
    var wins = (leads || []).filter(function (l) { return l && l.id && !l.deleted && !l.isProspect && N1.isSale(l, c.roleFn); });
    var costed = c.costed || costedIds(leads, c.expenses, c.roleFn);
    var items = wins.map(function (l) {
      var m = missingFor(l, { collectedByLead: c.collectedByLead, costed: costed, roleFn: c.roleFn });
      var n = missingCount(m);
      var markedDone = marked[l.id] === true;
      return { id: l.id, lead: l, missing: m, missingCount: n, complete: n === 0, markedDone: markedDone, done: markedDone || n === 0, bookedCents: N1.bookedCents(l) };
    });
    var skipped = Array.isArray(c.skipped) ? c.skipped : [];
    var open = items.filter(function (i) { return !i.done; });
    var fresh = open.filter(function (i) { return skipped.indexOf(i.id) === -1; })
      .sort(function (a, b) { return (b.missingCount - a.missingCount) || (b.bookedCents - a.bookedCents) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
    var later = skipped.filter(function (id) { return open.some(function (i) { return i.id === id; }); });
    var queue = fresh.map(function (i) { return i.id; }).concat(later);
    var done = items.length - open.length;
    return { items: items, queue: queue, done: done, total: items.length, text: progressText(done, items.length, 'job') };
  }

  function progressText(done, total, noun) {
    var n = noun || 'job';
    return done + ' of ' + total + ' ' + n + (total === 1 ? '' : 's') + ' done';
  }

  /**
   * The lost-reasons deck: losses with no reason (numbers-logic
   * lostReasonKeyOf reads older free-text reasons too). Newest loss first;
   * this session's Skips go to the back.
   * → { queue (lead ids), withReason, total, text }
   */
  function lostDeck(leads, ctx) {
    var c = ctx || {};
    var N1 = Nn();
    var lost = (leads || []).filter(function (l) { return l && l.id && !l.deleted && !l.isProspect && N1.isLostLead(l, c.roleFn); });
    var open = lost.filter(function (l) { return !N1.lostReasonKeyOf(l); });
    var skipped = Array.isArray(c.skipped) ? c.skipped : [];
    var t = function (l) { return N1.toMs(l.closedAt) || N1.toMs(l.stageStartedAt) || N1.toMs(l.createdAt); };
    var fresh = open.filter(function (l) { return skipped.indexOf(l.id) === -1; }).sort(function (a, b) { return t(b) - t(a); });
    var later = skipped.filter(function (id) { return open.some(function (l) { return l.id === id; }); });
    var withReason = lost.length - open.length;
    return {
      queue: fresh.map(function (l) { return l.id; }).concat(later),
      withReason: withReason, total: lost.length,
      text: withReason + ' of ' + lost.length + ' loss' + (lost.length === 1 ? '' : 'es') + ' have a reason'
    };
  }

  /**
   * Each month from the first Thumbtack lead's month to this month (newest
   * first): the Thumbtack leads that month, how many carry their own price,
   * and the spend entered for the month (cents, null = not entered).
   * A month counts as covered when its spend is entered, or every lead that
   * month already has its own price.
   */
  function thumbtackMonths(leads, spend, nowMs, sourceName) {
    var N1 = Nn();
    var src = N1.normalizeSource(sourceName || 'Thumbtack');
    var key = N1.spendKey(src);
    var months = (spend && spend.months) || {};
    var by = {}, first = 0;
    (leads || []).forEach(function (l) {
      if (!l || l.deleted || l.isProspect || N1.normalizeSource(l.source) !== src) return;
      var ms = N1.toMs(l.createdAt); if (!ms) return;
      if (!first || ms < first) first = ms;
      var mk = N1.monthKey(ms);
      var r = by[mk] || (by[mk] = { leads: 0, priced: 0 });
      r.leads++;
      if (N1.dollarsToCents(l.leadCost) > 0) r.priced++;
    });
    var rows = [];
    if (!first) return { key: key, source: src, rows: rows, covered: 0, total: 0 };
    var d = new Date(first); d.setDate(1); d.setHours(12, 0, 0, 0);
    var end = N1.monthKey(nowMs || Date.now());
    for (var guard = 0; guard < 240; guard++) {
      var mk = N1.monthKey(d.getTime());
      var r = by[mk] || { leads: 0, priced: 0 };
      var has = Object.prototype.hasOwnProperty.call(months[mk] || {}, key);
      var cents = has ? (Number(months[mk][key]) || 0) : null;
      rows.push({ month: mk, leads: r.leads, priced: r.priced, spendCents: cents, covered: cents != null || (r.leads > 0 && r.priced === r.leads) });
      if (mk === end) break;
      d.setMonth(d.getMonth() + 1);
    }
    rows.reverse();
    var covered = rows.filter(function (x) { return x.covered; }).length;
    return { key: key, source: src, rows: rows, covered: covered, total: rows.length };
  }

  /**
   * "Paid in full? Yes" — the one amount it records, from the target the
   * Record Payment sheet resolves (invoice-pipeline.js recordPaymentTarget):
   *   existing  → the job's ONE live invoice, its balance (nothing paid yet);
   *   estimate  → the estimate's total (the invoice is made from it);
   *   jobValue  → the job value already on the lead.
   * No figure on file, several open invoices, or money already on the invoice
   * → { ok: false, reason } and the card offers Record payment instead.
   */
  function paidInFullPlan(target, opts) {
    var t = target || {};
    // Money already recorded for this customer (a Stripe deposit the ledger
    // booked after the deck loaded, a check on another device): "paid in
    // full" would add the whole total on top of it (R6-2-8, the reverse
    // order). The deck only asks when nothing is collected; the write
    // re-checks, fresh.
    var o = opts || {};
    if (Number(o.collectedCents) > 0) return { ok: false, reason: 'already_collected' };
    if (t.kind === 'existing') {
      var live = t.invoices || [];
      if (live.length !== 1) return { ok: false, reason: 'several_invoices' };
      var inv = live[0] || {};
      var totalC = Math.round((Number(inv.total) || 0) * 100);
      var paidC = Math.round((Number(inv.amountPaid) || 0) * 100);
      if (paidC > 0) return { ok: false, reason: 'part_paid' };
      if (!(totalC > 0)) return { ok: false, reason: 'no_total' };
      return { ok: true, cents: totalC, basis: 'invoice', invoiceId: inv.id || null };
    }
    if (t.kind === 'estimate') {
      var c = Math.round(Number(t.totalCents) || 0);
      return c > 0 ? { ok: true, cents: c, basis: 'estimate', invoiceId: null } : { ok: false, reason: 'no_total' };
    }
    if (t.kind === 'jobValue') {
      var j = Math.round(Number(t.suggestedCents) || 0);
      return j > 0 ? { ok: true, cents: j, basis: 'jobValue', invoiceId: null } : { ok: false, reason: 'no_total' };
    }
    return { ok: false, reason: 'no_target' };
  }
  var PLAN_BASIS_LABELS = { invoice: 'the open invoice', estimate: 'the estimate', jobValue: 'the job value on file' };

  function c100(v) { return Math.round((parseFloat(v) || 0) * 100); }
  /**
   * Cents already recorded on a customer's invoices (any job): per invoice the
   * larger of amountPaid and its payments[] sum. Deleted / void invoices do
   * not count. The fresh re-check behind paidInFullPlan's already_collected.
   */
  function collectedCentsOf(invoices) {
    return (invoices || []).reduce(function (s, inv) {
      if (!inv || inv.deleted === true || inv.deletedAt) return s;
      var st = String(inv.status || '').toLowerCase();
      if (st === 'void' || st === 'voided' || st === 'cancelled' || st === 'canceled') return s;
      var ledger = (Array.isArray(inv.payments) ? inv.payments : []).reduce(function (t, p) { var a = c100(p && p.amount); return t + (a > 0 ? a : 0); }, 0);
      return s + Math.max(ledger, Math.max(0, c100(inv.amountPaid)));
    }, 0);
  }

  /**
   * Undo of a catch-up payment, refused when the invoice has taken Stripe
   * money since (R6-2-8): the ledger may have replaced part of the catch-up
   * entry with a real payment, and restoring / deleting the invoice would
   * wipe that payment out. current = the invoice as it is now (null = gone);
   * entry = the log entry. → '' (ok) or the reason to show.
   */
  function paymentUndoBlocked(current, entry) {
    if (!current || !entry) return '';
    var stripeKeys = function (inv) {
      var out = {};
      (Array.isArray(inv && inv.payments) ? inv.payments : []).forEach(function (p) {
        if (p && (p.stripeRef || p.paymentIntentId || p.source === 'stripe_ledger')) out[p.stripeRef || p.paymentIntentId || 'stripe'] = 1;
      });
      return out;
    };
    var now = stripeKeys(current);
    var then = entry.created ? {} : stripeKeys(entry.restore || {});
    var added = Object.keys(now).some(function (k) { return !then[k]; });
    return added ? 'A Stripe payment was recorded on this invoice since — undo would erase it. Fix the invoice itself instead.' : '';
  }

  var PAID_STAGES = ['final_payment', 'deductible_collected', 'install_complete', 'final_photos', 'closed'];
  /**
   * A date to offer for "paid in full": the latest move into Final Payment /
   * Deductible Collected / Install Complete / Final Photos / Closed, else the
   * sale date when it is real (not the created date). '' when nothing is
   * known — Jo picks. Never later than today.
   */
  function defaultPaymentYmd(lead, nowMs) {
    var N1 = Nn();
    var now = nowMs || Date.now();
    var hist = (lead && Array.isArray(lead.stageHistory)) ? lead.stageHistory : [];
    var best = 0;
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i] || {};
      if (PAID_STAGES.indexOf(N1.canonStage(h.to)) === -1) continue;
      var t = N1.toMs(h.timestamp || h.at);
      if (t && t <= now && t > best) best = t;
    }
    if (!best && lead && !N1.needsCloseDate(lead)) {
      var s = N1.saleDateMs(lead);
      if (s && s <= now) best = s;
    }
    return best ? ymdOf(best) : '';
  }

  /** A close date to offer: the first move into a sale stage that is not the created moment. */
  function suggestCloseYmd(lead) {
    var N1 = Nn();
    var created = N1.toMs(lead && lead.createdAt);
    var hist = (lead && Array.isArray(lead.stageHistory)) ? lead.stageHistory : [];
    for (var i = 0; i < hist.length; i++) {
      var h = hist[i] || {};
      var to = N1.canonStage(h.to);
      if (to !== N1.CONTRACT_SIGNED && N1.WON_KEYS.indexOf(to) === -1 && N1.JOB_KEYS.indexOf(to) === -1) continue;
      var t = N1.toMs(h.timestamp || h.at);
      if (t && !(created && Math.abs(t - created) < 60000)) return ymdOf(t);
    }
    return '';
  }

  /** 'YYYY-MM-DD' → a Date at local noon, or null when bad / in the future. */
  function dateFromYmd(ymd, nowMs) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
    if (d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
    var now = nowMs || Date.now();
    // Local noon of today is fine even before noon: compare calendar days.
    if (ymdOf(d.getTime()) > ymdOf(now)) return null;
    return d;
  }

  // ── The action log (undo) ──────────────────────────────────────────────
  /**
   * The patch that puts back what a lead write replaced: each key the write
   * touched gets its earlier value, or null when it had none.
   */
  function leadUndoPatch(before, keys) {
    var b = before || {};
    var out = {};
    (keys || []).forEach(function (k) { out[k] = Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined ? b[k] : null; });
    return out;
  }
  function pick(obj, keys) {
    var o = obj || {}, out = {};
    (keys || []).forEach(function (k) { out[k] = Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined ? o[k] : null; });
    return out;
  }
  /** The invoice fields a recorded payment changes (applyPaymentToInvoice). */
  var PAYMENT_FIELDS = ['amountPaid', 'depositPaid', 'balanceDue', 'status', 'paidAt', 'lastPaymentAt', 'payments'];
  /**
   * How to reverse a recorded payment, from the job's invoices before and
   * after it. The invoice the payment made is deleted; an existing invoice
   * gets its earlier ledger back. → { invoiceId, created, restore } | null
   */
  function paymentUndoFrom(beforeInvoices, afterInvoices, invoiceId) {
    var before = (beforeInvoices || []).filter(function (i) { return i && i.id === invoiceId; })[0] || null;
    var after = (afterInvoices || []).filter(function (i) { return i && i.id === invoiceId; })[0] || null;
    if (!after && !before) return null;
    if (!before) return { invoiceId: invoiceId, created: true, restore: null };
    var r = pick(before, PAYMENT_FIELDS);
    if (r.payments == null) r.payments = [];
    return { invoiceId: invoiceId, created: false, restore: r };
  }
  /** Which invoice a Record Payment sheet changed: a new one, or one whose ledger grew. */
  function changedInvoiceId(beforeInvoices, afterInvoices) {
    var b = {};
    (beforeInvoices || []).forEach(function (i) { if (i && i.id) b[i.id] = i; });
    var hit = null;
    (afterInvoices || []).forEach(function (i) {
      if (hit || !i || !i.id) return;
      var p = b[i.id];
      if (!p) { hit = i.id; return; }
      var n0 = Array.isArray(p.payments) ? p.payments.length : 0;
      var n1 = Array.isArray(i.payments) ? i.payments.length : 0;
      if (n1 > n0 || (Number(i.amountPaid) || 0) > (Number(p.amountPaid) || 0)) hit = i.id;
    });
    return hit;
  }
  /** Add an entry; keep the newest LOG_MAX. Returns a new array. */
  function pushLog(log, entry) {
    var out = (Array.isArray(log) ? log : []).concat([entry]);
    return out.length > LOG_MAX ? out.slice(out.length - LOG_MAX) : out;
  }
  function lastEntry(log) { return Array.isArray(log) && log.length ? log[log.length - 1] : null; }
  function popLog(log) { return Array.isArray(log) && log.length ? log.slice(0, -1) : []; }

  var api = {
    MISSING_KEYS: MISSING_KEYS, MISSING_LABELS: MISSING_LABELS, LOG_MAX: LOG_MAX, PAYMENT_FIELDS: PAYMENT_FIELDS,
    PLAN_BASIS_LABELS: PLAN_BASIS_LABELS, DAY: DAY,
    costedIds: costedIds, missingFor: missingFor, missingCount: missingCount,
    jobDeck: jobDeck, lostDeck: lostDeck, progressText: progressText, thumbtackMonths: thumbtackMonths,
    paidInFullPlan: paidInFullPlan, defaultPaymentYmd: defaultPaymentYmd, suggestCloseYmd: suggestCloseYmd,
    dateFromYmd: dateFromYmd, ymdOf: ymdOf,
    leadUndoPatch: leadUndoPatch, pick: pick, paymentUndoFrom: paymentUndoFrom, changedInvoiceId: changedInvoiceId,
    collectedCentsOf: collectedCentsOf, paymentUndoBlocked: paymentUndoBlocked,
    pushLog: pushLog, lastEntry: lastEntry, popLog: popLog
  };
  if (root) root.NBDCatchUpLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
