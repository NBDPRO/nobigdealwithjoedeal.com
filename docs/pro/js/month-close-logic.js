/**
 * month-close-logic.js — the pure math behind the "Month close" screen
 * (flag monthClose, 2026-10-19). No DOM, no Firestore, no network; the screen
 * (month-close.js) feeds it the CRM's own invoices, expenses and leads.
 *
 * Rules this file holds:
 *   - Cash basis, "collected only": payments by the day they arrived, refunds
 *     subtracted (the caller passes NBDRevenue.paymentsOf, the one definition).
 *   - Money is integer cents everywhere. The tax rate is basis points (25.5% =
 *     2550) so no float ever multiplies money.
 *   - A month is an Eastern-time calendar month (America/New_York, the house
 *     convention in money-dashboard.js), the same on every device and server.
 *   - The set-aside is computed on PROFIT: collected - direct costs - the
 *     overhead the owner types. Never on deposits. No rate lives in this file:
 *     the owner enters it, and every rate or date is "confirm with the CPA".
 *   - Nothing is sent anywhere. The summary is text the owner saves himself.
 *
 * Exposed as window.NBDMonthCloseLogic and module.exports.
 */
(function (root) {
  'use strict';

  var CPA_NOTE = 'Confirm with the CPA';
  var CPA_LC = 'confirm with the CPA';
  var OFFSETS = [14, 7, 2, 0];
  var NOTES_MAX = 2000;
  var EXPLAIN_MAX = 300;
  var LOG_MAX = 25;
  var CENTS_MAX = 99999999999; // $999,999,999.99, under the rules' ceiling
  var ITEMS = [
    { id: 'basis', label: 'Window is one calendar month, cash basis, collected only', auto: true },
    { id: 'collected', label: 'Collected revenue for the month looks right (payments in, refunds out)' },
    { id: 'deposits', label: 'Bank deposits typed in and the gap explained' },
    { id: 'costs', label: 'Direct costs per finished job reviewed (job profit table)' },
    { id: 'zero_jobs', label: 'Finished jobs with no costs: zero, or each one explained' },
    { id: 'zero_payments', label: 'Payments with no job: zero, or each one explained' },
    { id: 'zero_receipts', label: 'Receipts with no job: zero, or each one explained' },
    { id: 'checks', label: 'Check scans not tied to a payment or job: resolved or carried forward' },
    { id: 'cash', label: 'Cash and Zelle crew payments are in the log against a job' },
    { id: 'setaside', label: 'Tax set-aside computed on profit and moved by the owner' },
    { id: 'quarter', label: 'Month before an estimated-tax date: year-to-date set-aside compared with the CPA figure' },
    { id: 'report', label: 'One-page summary saved to the private vault' }
  ];
  var ITEM_IDS = ITEMS.map(function (i) { return i.id; });
  var EXPLAIN_IDS = ['deposits', 'zero_jobs', 'zero_payments', 'zero_receipts', 'checks', 'cash'];

  function int(v) { var n = parseInt(v, 10); return isFinite(n) ? n : 0; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function toMs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    if (v instanceof Date) return v.getTime() || 0;
    if (typeof v.toDate === 'function') { var d = v.toDate(); return d ? d.getTime() || 0 : 0; }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = new Date(v).getTime();
    return isFinite(t) ? t : 0;
  }

  // ── months ───────────────────────────────────────────────────────────
  function isMonthKey(k) { return typeof k === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(k); }
  // The house timezone, same convention as money-dashboard.js ("Close last
  // month" card): a payment at 11:30pm on the 30th Eastern belongs to that
  // month on every device, whatever zone the phone or a server is set to.
  var HOUSE_TZ = 'America/New_York';
  var etFmt = null;
  function etIso(ms) {
    if (!etFmt) etFmt = new Intl.DateTimeFormat('en-CA', { timeZone: HOUSE_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    return etFmt.format(new Date(ms)); // YYYY-MM-DD
  }
  /** 'YYYY-MM' of an instant in Eastern time; '' for no/invalid time. */
  function monthKeyOf(ms) {
    if (!ms || !isFinite(ms)) return '';
    return etIso(ms).slice(0, 7);
  }
  /** The month before `nowMs` in Eastern time (the one the owner closes in the first week). */
  function previousMonthKey(nowMs) {
    var k = monthKeyOf(nowMs == null ? Date.now() : nowMs);
    var y = int(k.slice(0, 4)), m = int(k.slice(5, 7));
    return m === 1 ? (y - 1) + '-12' : y + '-' + pad(m - 1);
  }
  /** { key, label, year, month } for a 'YYYY-MM' key (Eastern calendar month); null for a bad key. */
  function monthRange(key) {
    if (!isMonthKey(key)) return null;
    var y = int(key.slice(0, 4)), m = int(key.slice(5, 7));
    var names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    return { key: key, label: names[m - 1] + ' ' + y, year: y, month: m, tz: HOUSE_TZ };
  }
  function inRange(ms, range) { return !!ms && !!range && monthKeyOf(ms) === range.key; }

  // ── money parsing / formatting ───────────────────────────────────────
  /** "$1,250.50" -> 125050. Anything that is not a plain non-negative amount -> null. */
  function parseCents(input) {
    var s = String(input == null ? '' : input).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var parts = s.split('.');
    var c = int(parts[0]) * 100 + (parts[1] ? int((parts[1] + '0').slice(0, 2)) : 0);
    return c > CENTS_MAX ? null : c;
  }
  /** "25.5" -> 2550 basis points. 0 to 100 percent, at most two decimals; else null. */
  function parseRateBp(input) {
    var s = String(input == null ? '' : input).replace(/[%\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var parts = s.split('.');
    var bp = int(parts[0]) * 100 + (parts[1] ? int((parts[1] + '0').slice(0, 2)) : 0);
    return bp > 10000 ? null : bp;
  }
  function fmtMoney(cents) {
    var neg = cents < 0, c = Math.abs(Math.round(Number(cents) || 0));
    var d = Math.floor(c / 100), r = pad(c % 100);
    return (neg ? '-$' : '$') + String(d).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '.' + r;
  }
  function fmtRate(bp) {
    if (bp == null) return '';
    var whole = Math.floor(bp / 100), frac = bp % 100;
    return whole + (frac ? '.' + (frac < 10 ? '0' + frac : String(frac)).replace(/0$/, '') : '') + '%';
  }

  // ── collected revenue ────────────────────────────────────────────────
  /**
   * Collected in the month. paymentsOf = NBDRevenue.paymentsOf (refunds come
   * back as negative entries). Voided / deleted invoices are skipped.
   * -> { collectedCents, grossCents, refundsCents, paymentCount, unlinkedCents,
   *      unlinkedCount, byLead{} }
   */
  function collectedForMonth(invoices, paymentsOf, range) {
    var gross = 0, refunds = 0, count = 0, unl = 0, unlCount = 0, byLead = {};
    (invoices || []).forEach(function (inv) {
      if (!inv || inv.deleted === true) return;
      (paymentsOf(inv) || []).forEach(function (p) {
        var ms = toMs(p && p.at);
        if (!inRange(ms, range)) return;
        var c = Math.round((parseFloat(p.amount) || 0) * 100);
        if (!c) return;
        if (c > 0) gross += c; else refunds += -c;
        count++;
        if (inv.leadId) byLead[inv.leadId] = (byLead[inv.leadId] || 0) + c;
        else { unl += c; unlCount++; }
      });
    });
    return { collectedCents: gross - refunds, grossCents: gross, refundsCents: refunds, paymentCount: count, unlinkedCents: unl, unlinkedCount: unlCount, byLead: byLead };
  }

  // ── costs ────────────────────────────────────────────────────────────
  function costCents(e) { return int(e && e.amountCents) + int(e && e.taxCents); }
  function liveCost(e) { return !!e && e.deleted !== true && costCents(e) > 0; }

  /**
   * Costs dated in the month. Direct = job costs; overhead = what the CRM has
   * logged as overhead (a hint: the owner types the number used).
   * -> { directCents, directCount, estimatedCents, noJobCents, noJobCount, loggedOverheadCents, byLead{} }
   */
  function costsForMonth(expenses, range) {
    var out = { directCents: 0, directCount: 0, estimatedCents: 0, noJobCents: 0, noJobCount: 0, loggedOverheadCents: 0, byLead: {} };
    (expenses || []).forEach(function (e) {
      if (!liveCost(e) || !inRange(toMs(e.date), range)) return;
      var c = costCents(e);
      if (e.costType === 'direct') {
        out.directCents += c; out.directCount++;
        if (e.estimated === true) out.estimatedCents += c;
        if (e.leadId) out.byLead[e.leadId] = (out.byLead[e.leadId] || 0) + c;
        else { out.noJobCents += c; out.noJobCount++; }
      } else if (e.costType === 'overhead') {
        out.loggedOverheadCents += c;
      }
    });
    return out;
  }

  /** Lead ids that have ANY live, real (not estimated) direct cost, ever. */
  function jobsWithRealCost(expenses) {
    var m = {};
    (expenses || []).forEach(function (e) {
      if (liveCost(e) && e.costType === 'direct' && e.estimated !== true && e.leadId) m[e.leadId] = true;
    });
    return m;
  }

  /**
   * The job-profit table for the month: every job with money collected or a
   * direct cost dated in the month. A job with no real cost logged ANYWHERE has
   * marginPct null and costsNotLogged true, never a flattering 100%.
   * leads: [{id, name?...}], nameOf(lead) -> string.
   */
  function jobTable(leads, coll, costs, realCost, nameOf) {
    var byId = {};
    (leads || []).forEach(function (l) { if (l && l.id) byId[l.id] = l; });
    var ids = {};
    Object.keys(coll.byLead || {}).forEach(function (k) { ids[k] = true; });
    Object.keys(costs.byLead || {}).forEach(function (k) { ids[k] = true; });
    var rows = Object.keys(ids).map(function (id) {
      var col = (coll.byLead || {})[id] || 0, dir = (costs.byLead || {})[id] || 0;
      var notLogged = !(realCost || {})[id];
      var profit = col - dir;
      return {
        id: id, name: byId[id] ? nameOf(byId[id]) : 'Job not found',
        collectedCents: col, directCents: dir, profitCents: profit,
        costsNotLogged: notLogged,
        marginPct: (col > 0 && !notLogged) ? Math.round(profit / col * 100) : null
      };
    });
    rows.sort(function (a, b) { return (b.collectedCents - a.collectedCents) || (a.id < b.id ? -1 : 1); });
    return rows;
  }

  // ── set-aside ────────────────────────────────────────────────────────
  /**
   * Tax set-aside on PROFIT. profit = collected - direct - overhead (can be
   * negative). A loss month sets aside 0, never a negative amount.
   * rateBp null (not entered) -> setAsideCents null: the screen says "enter a rate".
   * Rounds half up, in integers.
   */
  function setAside(collectedCents, directCents, overheadCents, rateBp) {
    var profit = int(collectedCents) - int(directCents) - int(overheadCents);
    var taxable = profit > 0 ? profit : 0;
    var amount = null;
    if (rateBp != null && rateBp >= 0 && rateBp <= 10000) amount = Math.floor((taxable * rateBp + 5000) / 10000);
    return { profitCents: profit, taxableCents: taxable, setAsideCents: amount, loss: profit < 0 };
  }

  /** Bank minus CRM. null while the owner has not typed the bank total. */
  function depositGap(collectedCents, depositsCents) {
    if (depositsCents == null) return { gapCents: null, status: 'not_entered' };
    var gap = int(depositsCents) - int(collectedCents);
    return { gapCents: gap, status: gap === 0 ? 'match' : (gap > 0 ? 'bank_higher' : 'bank_lower') };
  }

  // ── the zero-flag rows ───────────────────────────────────────────────
  /**
   * counts: { jobsNoCosts, paymentsNoJob, receiptsNoJob, cashNoJob, auditorNoSub } each a number,
   * or null when that source is not enabled / not loaded. -> rows with status ok | open | off.
   */
  function flagRows(counts) {
    var c = counts || {};
    function row(id, label, n, extra) {
      return Object.assign({ id: id, label: label, count: n, status: n == null ? 'off' : (n === 0 ? 'ok' : 'open') }, extra || {});
    }
    return [
      row('zero_jobs', 'Finished jobs paid this month with no costs logged', c.jobsNoCosts, { allTime: c.jobsNoCostsAll }),
      row('zero_payments', 'Payments this month with no job', c.paymentsNoJob),
      row('zero_receipts', 'Receipts this month with no job', c.receiptsNoJob, { allTime: c.receiptsNoJobAll }),
      row('cash', 'Cash / Zelle crew payouts this month with no job', c.cashNoJob),
      row('auditor', 'Jobs the cost auditor says have no sub or labor cost', c.auditorNoSub)
    ];
  }

  /**
   * Receipts and crew cash dated in the month that are tied to no job.
   *   receiptsNoJob: an unsorted store receipt (isUnsorted), or a direct cost with
   *                  no job that is not a crew payout.
   *   cashNoJob:     a live cash_payout row with no job.
   * Voided and $0 rows never count. isUnsorted is receipt-health's rule, passed in.
   */
  function noJobCounts(expenses, range, isUnsorted) {
    var receipts = 0, cash = 0;
    (expenses || []).forEach(function (e) {
      if (!liveCost(e) || !inRange(toMs(e.date), range)) return;
      if (e.source === 'cash_payout') { if (!e.leadId) cash++; return; }
      var unsorted = typeof isUnsorted === 'function' && isUnsorted(e);
      if (unsorted || (e.costType === 'direct' && !e.leadId)) receipts++;
    });
    return { receiptsNoJob: receipts, cashNoJob: cash };
  }

  // ── reminder dates (a helper to read from; creates nothing) ──────────
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function validYmd(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var d = new Date(Date.UTC(int(s.slice(0, 4)), int(s.slice(5, 7)) - 1, int(s.slice(8, 10))));
    return d.getUTCFullYear() === int(s.slice(0, 4)) && d.getUTCMonth() === int(s.slice(5, 7)) - 1 && d.getUTCDate() === int(s.slice(8, 10));
  }
  function addDaysYmd(ymd, delta) {
    var d = new Date(Date.UTC(int(ymd.slice(0, 4)), int(ymd.slice(5, 7)) - 1, int(ymd.slice(8, 10)) + delta));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function weekdayOf(ymd) {
    return DAYS[new Date(Date.UTC(int(ymd.slice(0, 4)), int(ymd.slice(5, 7)) - 1, int(ymd.slice(8, 10)))).getUTCDay()];
  }
  /**
   * 14 / 7 / 2 days before and the day of, for one due date the OWNER confirmed.
   * Pure calendar arithmetic (UTC, so daylight saving cannot shift a day).
   * -> [{ offset, ymd, weekday, label }], or [] for a bad date.
   */
  function reminderSchedule(dueYmd, offsets) {
    if (!validYmd(dueYmd)) return [];
    return (offsets || OFFSETS).map(function (o) {
      var y = addDaysYmd(dueYmd, -o);
      return { offset: o, ymd: y, weekday: weekdayOf(y), label: o === 0 ? 'Day of' : o + ' days before' };
    });
  }
  /**
   * The four dates the owner has been told are usual, as a STARTING POINT for
   * him to edit: Apr 15, Jun 15, Sep 15 of `year`, Jan 15 of year + 1. They are
   * not facts: weekends, holidays and state rules shift them.
   */
  function suggestedDueDates(year) {
    var y = int(year);
    return [y + '-04-15', y + '-06-15', y + '-09-15', (y + 1) + '-01-15'];
  }
  /** Plain text the owner copies into his calendar. */
  function reminderText(dueDates, offsets) {
    var lines = ['Estimated-tax reminder dates (' + CPA_LC + ' before using any of them)', ''];
    (dueDates || []).forEach(function (d) {
      var sched = reminderSchedule(d, offsets);
      if (!sched.length) return;
      lines.push('Due ' + d + ' (' + weekdayOf(d) + ')' + (/^(Saturday|Sunday)$/.test(weekdayOf(d)) ? ' - falls on a weekend, the real due date may shift' : ''));
      sched.forEach(function (s) { lines.push('  ' + s.label + ': ' + s.ymd + ' (' + s.weekday + ')'); });
      lines.push('');
    });
    return lines.join('\n').replace(/\s+$/, '') + '\n';
  }

  // ── the saved close doc ──────────────────────────────────────────────
  function cleanText(s, max) { return String(s == null ? '' : s).replace(/\r\n?/g, '\n').trim().slice(0, max); }
  function closeDocId(companyId, monthKey) { return companyId + '_' + monthKey; }
  function intIn(v, lo, hi) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= lo && v <= hi; }

  /** The numbers a close stores. All integers or null. */
  function totalsOf(collected, costs, overheadCents, depositsCents, rateBp) {
    var aside = setAside(collected.collectedCents, costs.directCents, overheadCents, rateBp);
    return {
      collectedCents: collected.collectedCents, grossCents: collected.grossCents, refundsCents: collected.refundsCents,
      directCents: costs.directCents, overheadCents: int(overheadCents), profitCents: aside.profitCents,
      depositsCents: depositsCents == null ? null : depositsCents,
      rateBp: rateBp == null ? null : rateBp, setAsideCents: aside.setAsideCents
    };
  }
  function totalsOk(t) {
    if (!t || typeof t !== 'object') return false;
    var money = ['grossCents', 'refundsCents', 'directCents', 'overheadCents'];
    for (var i = 0; i < money.length; i++) if (!intIn(t[money[i]], 0, CENTS_MAX)) return false;
    // Refunds can exceed payments in a month, so collected and profit may be negative.
    if (!intIn(t.collectedCents, -CENTS_MAX, CENTS_MAX)) return false;
    if (!intIn(t.profitCents, -CENTS_MAX, CENTS_MAX)) return false;
    if (t.depositsCents != null && !intIn(t.depositsCents, 0, CENTS_MAX)) return false;
    if (t.rateBp != null && !intIn(t.rateBp, 0, 10000)) return false;
    if (t.setAsideCents != null && !intIn(t.setAsideCents, 0, CENTS_MAX)) return false;
    return true;
  }

  function appendLog(prev, entry) {
    var base = Array.isArray(prev) ? prev.slice() : [];
    base.push(entry);
    return base.slice(-LOG_MAX);
  }

  /**
   * The doc written to monthCloses/{companyId_YYYY-MM}. `ts` is serverTimestamp()
   * in the browser; `existing` is the saved doc being re-saved (or null).
   * -> { doc } or { error }.
   */
  function buildCloseDoc(p) {
    p = p || {};
    if (!p.companyId) return { error: 'No company on this account' };
    if (!p.uid) return { error: 'Sign in again' };
    if (!isMonthKey(p.monthKey)) return { error: 'Pick a month' };
    if (!totalsOk(p.totals)) return { error: 'The totals are not valid numbers' };
    var checks = {};
    ITEM_IDS.forEach(function (id) { if (p.checks && p.checks[id] === true) checks[id] = true; });
    var explain = {};
    EXPLAIN_IDS.forEach(function (id) {
      var t = cleanText(p.explain && p.explain[id], EXPLAIN_MAX);
      if (t) explain[id] = t;
    });
    var ex = p.existing || null;
    var what = ex ? 'updated the close' : 'saved the close';
    var doc = {
      companyId: p.companyId,
      monthKey: p.monthKey,
      totals: p.totals,
      checks: checks,
      explain: explain,
      notes: cleanText(p.notes, NOTES_MAX),
      editLog: appendLog(ex && ex.editLog, { at: int(p.nowMs), by: p.uid, what: what, note: '' }),
      createdAt: ex && ex.createdAt != null ? ex.createdAt : p.ts,
      createdBy: ex && ex.createdBy ? ex.createdBy : p.uid,
      updatedAt: p.ts,
      updatedBy: p.uid
    };
    return { doc: doc };
  }

  /** Which saved totals differ from a fresh calculation (so a reopened close can say "numbers moved"). */
  function changedSince(saved, live) {
    var keys = ['collectedCents', 'directCents', 'refundsCents'];
    return keys.filter(function (k) { return saved && live && saved[k] !== live[k]; });
  }

  /** Owner / company_admin / platform admin; a solo operator (no role, own uid) is the owner. */
  function canClose(claims, uid) {
    var c = claims || {}, role = c.role || '';
    if (role === 'admin' || role === 'company_admin') return true;
    if (role) return false;
    return !!uid && (!c.companyId || c.companyId === uid);
  }
  /** Company money: the owner / company_admin only (and the platform admin). Managers, viewers and reps never see it. */
  function canView(claims, uid) { return canClose(claims, uid); }

  /**
   * The Expenses list is the newest 1000 rows. When that cap was hit and the
   * oldest row loaded is not before the month, rows of this month may be missing,
   * so its costs (and the profit and set-aside built on them) are understated.
   */
  function expensesTruncated(expenses, monthKey, limit) {
    var cap = limit || 1000;
    if (!expenses || expenses.length < cap) return false;
    var oldest = Infinity;
    expenses.forEach(function (e) { var ms = toMs(e && e.date); if (ms && ms < oldest) oldest = ms; });
    if (oldest === Infinity) return true;
    return monthKeyOf(oldest) >= monthKey;
  }

  // ── the one-page summary (text / markdown) ───────────────────────────
  /**
   * s: { monthKey, totals, checks, explain, notes, flags[], jobs[], rateNote }.
   * Plain markdown for the owner's private vault. Nothing here is sent anywhere.
   */
  function summaryMarkdown(s) {
    s = s || {};
    var t = s.totals || {}, r = monthRange(s.monthKey);
    var L = [];
    L.push('# Month close: ' + (r ? r.label : s.monthKey));
    L.push('');
    L.push('Basis: cash, collected only (payments by the day they arrived, refunds subtracted). Not tax advice. Every rate and date below is an owner entry: ' + CPA_LC + '.');
    L.push('');
    L.push('## Numbers');
    L.push('- Collected: ' + fmtMoney(t.collectedCents) + ' (payments ' + fmtMoney(t.grossCents) + ', refunds ' + fmtMoney(t.refundsCents) + ')');
    L.push('- Direct job costs: ' + fmtMoney(t.directCents));
    L.push('- Overhead (owner entered): ' + fmtMoney(t.overheadCents));
    L.push('- Profit (collected - direct - overhead): ' + fmtMoney(t.profitCents) + (t.profitCents < 0 ? ' (a loss month: nothing to set aside)' : ''));
    if (t.depositsCents == null) {
      L.push('- Bank deposits: not entered');
    } else {
      var g = depositGap(t.collectedCents, t.depositsCents);
      L.push('- Bank deposits (owner typed): ' + fmtMoney(t.depositsCents) + '; gap vs collected ' + fmtMoney(g.gapCents) + (g.status === 'match' ? ' (match)' : g.status === 'bank_higher' ? ' (bank is higher)' : ' (bank is lower)'));
    }
    if (t.rateBp == null) L.push('- Tax set-aside: no rate entered');
    else L.push('- Tax set-aside: ' + fmtMoney(t.setAsideCents) + ' = ' + fmtRate(t.rateBp) + ' of profit. The rate is the owner\'s assumption: ' + CPA_LC + '.');
    L.push('');
    if (s.flags && s.flags.length) {
      L.push('## Zero-flag checks');
      s.flags.forEach(function (f) {
        L.push('- ' + f.label + ': ' + (f.status === 'off' ? 'not enabled' : f.count) + (f.status === 'open' ? ' (open)' : ''));
      });
      L.push('');
    }
    if (s.jobs && s.jobs.length) {
      L.push('## Job profit this month');
      s.jobs.forEach(function (j) {
        L.push('- ' + j.name + ': collected ' + fmtMoney(j.collectedCents) + ', costs ' + fmtMoney(j.directCents) + ', ' +
          (j.costsNotLogged ? 'costs not logged' : (j.marginPct == null ? 'no margin' : 'margin ' + j.marginPct + '%')));
      });
      L.push('');
    }
    L.push('## Checklist');
    ITEMS.forEach(function (i) { L.push('- [' + ((s.checks && s.checks[i.id]) || i.auto ? 'x' : ' ') + '] ' + i.label); });
    var ex = Object.keys(s.explain || {});
    if (ex.length) {
      L.push('');
      L.push('## Explanations');
      ex.forEach(function (k) { L.push('- ' + k.replace(/_/g, ' ') + ': ' + s.explain[k]); });
    }
    if (s.notes) { L.push(''); L.push('## Notes'); L.push(s.notes); }
    L.push('');
    return L.join('\n');
  }

  var API = {
    CPA_NOTE: CPA_NOTE, CPA_LC: CPA_LC, OFFSETS: OFFSETS, NOTES_MAX: NOTES_MAX, EXPLAIN_MAX: EXPLAIN_MAX, LOG_MAX: LOG_MAX,
    ITEMS: ITEMS, ITEM_IDS: ITEM_IDS, EXPLAIN_IDS: EXPLAIN_IDS,
    isMonthKey: isMonthKey, monthKeyOf: monthKeyOf, previousMonthKey: previousMonthKey, monthRange: monthRange, inRange: inRange,
    parseCents: parseCents, parseRateBp: parseRateBp, fmtMoney: fmtMoney, fmtRate: fmtRate,
    collectedForMonth: collectedForMonth, costsForMonth: costsForMonth, jobsWithRealCost: jobsWithRealCost, jobTable: jobTable,
    setAside: setAside, depositGap: depositGap, flagRows: flagRows, noJobCounts: noJobCounts,
    reminderSchedule: reminderSchedule, suggestedDueDates: suggestedDueDates, reminderText: reminderText, validYmd: validYmd,
    closeDocId: closeDocId, totalsOf: totalsOf, totalsOk: totalsOk, buildCloseDoc: buildCloseDoc, appendLog: appendLog, changedSince: changedSince,
    canClose: canClose, canView: canView, expensesTruncated: expensesTruncated, summaryMarkdown: summaryMarkdown, toMs: toMs
  };
  if (root && typeof root === 'object') root.NBDMonthCloseLogic = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : null);
