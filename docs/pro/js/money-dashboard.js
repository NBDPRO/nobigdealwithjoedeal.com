/**
 * money-dashboard.js — the #/money P&L capstone.
 *
 * A consolidated financial snapshot that ties together the subsystems built
 * across the expense initiative: paid invoices (cash in), the expense ledger
 * (COGS + overhead), won-job contract value + per-job margin, supplier spend,
 * outstanding A/R, and the 1099 worklist.
 *
 * Exposes: window.MoneyDashboard
 *
 * Two clearly-labelled lenses to avoid the revenue-basis trap:
 *   - CASH (this year): collected (each payment by its own date via
 *     inv.payments[], legacy lastPaymentAt||paidAt lump) vs spent (expenses
 *     by date) -> net cash. Multi-payment invoices attribute deposits and
 *     balance payoffs to the periods they were received.
 *   - JOB PROFITABILITY: won-job contract value (jobValue) vs direct costs ->
 *     gross margin. Same basis as the Expenses view's per-job margin.
 *
 * computePnL() is pure (no DOM/Firebase) and exported for unit tests. Reads
 * costType denormalized off each expense doc (no ExpenseConfig dependency in
 * the compute), and the supplier's stored is1099Eligible flag.
 */
(function () {
  'use strict';

  function uid() { return (window._user && window._user.uid) || null; }
  function claims() { return window._userClaims || {}; }
  function companyId() { return claims().companyId || uid(); }
  function isStaff() { var r = claims().role; return r === 'company_admin' || r === 'manager' || r === 'admin'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toJSDate(v) { if (!v) return null; if (typeof v.toDate === 'function') return v.toDate(); if (v.seconds) return new Date(v.seconds * 1000); var d = new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmt(cents) {
    var n = (parseInt(cents, 10) || 0) / 100;
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }
  function invoiceCents(inv) { return Math.round((parseFloat(inv.total) || 0) * 100); }
  // Cash actually collected on an invoice = total - balanceDue (so a paid
  // invoice with a residual write-off, or a partial payment, counts the real
  // cash, not the full face value). QA finding. Used for legacy single-lump
  // fallback when inv.payments[] is absent.
  function collectedCentsOf(inv) {
    var total = parseFloat(inv.total) || 0;
    var bal = (inv.balanceDue != null) ? (parseFloat(inv.balanceDue) || 0) : 0;
    return Math.round(Math.max(0, total - bal) * 100);
  }

  // nbd:owed-rule:start — ONE "is this invoice still owed?" rule, kept
  // byte-identical in collected-revenue.js, money-dashboard.js,
  // analytics-kpi.js and invoice-pipeline.js
  // (tests/invoice-owed-rule-2026-10-03.test.js). A voided Stripe mirror is
  // written { status:'void', balanceDue:0 }; drafts were never sent. Neither
  // is owed. Amount = balanceDue when present (0 means nothing due — the old
  // `balanceDue || total` read 0 as "missing" and re-counted the full face).
  var NOT_OWED_STATUS = { paid: 1, draft: 1, cancelled: 1, canceled: 1, void: 1, voided: 1, uncollectible: 1 };
  function isOwedInvoice(inv) {
    if (!inv || inv.deleted === true) return false;
    return !NOT_OWED_STATUS[String(inv.status || '').toLowerCase()];
  }
  function owedDollarsOf(inv) {
    if (!isOwedInvoice(inv)) return 0;
    var b = inv.balanceDue;
    var v = parseFloat((b != null && b !== '') ? b : inv.total);
    return v > 0 ? v : 0;
  }
  // nbd:owed-rule:end
  // Per-payment cash ledger. Prefer inv.payments[] (stamped by markPaid + the
  // Stripe invoiceWebhook on every credit) so a deposit in May and a balance
  // payoff in July land in their own months/years. Legacy docs without the
  // array fall back to a single lump of total−balanceDue dated by
  // lastPaymentAt||paidAt (pre-#980/#990 multi-payment residual).
  //
  // TRANSITION RECONCILIATION: an invoice whose first partial predates the
  // ledger (pre-2026-07-19 deploy) gets payments[] entries only for credits
  // AFTER the deploy — trusting the ledger alone would silently drop the
  // earlier cash from Collected. When the ledger sums short of the invoice's
  // actual collected cash (total−balanceDue), append one synthetic remainder
  // entry so totals stay exact. Its date is the EARLIEST ledger entry (the
  // tightest upper bound we have for pre-ledger cash — lastPaymentAt is the
  // NEWEST credit, strictly later), falling back to lastPaymentAt||paidAt.
  // That dating degrades to the pre-ledger behavior at worst; totals never do.
  function paymentsOnlyOf(inv) {
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
        var actualCents = collectedCentsOf(inv);
        var remainderCents = actualCents - ledgerCents;
        if (remainderCents >= 1) {
          var remAt = earliestAt != null ? earliestAt
            : (inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt);
          if (remAt != null) out.push({ amount: remainderCents / 100, at: remAt, synthetic: true });
        }
        return out;
      }
    }
    var cents = collectedCentsOf(inv);
    if (cents <= 0) return [];
    var payDate = inv.lastPaymentAt != null ? inv.lastPaymentAt : inv.paidAt;
    if (payDate == null) return [];
    return [{ amount: cents / 100, at: payDate }];
  }

  // Refunds (invoices.refunds[], recorded by the Stripe ledger) come off
  // revenue on the day they happened — negative entries tagged refund:true.
  // They never touch payments[] / amountPaid / balanceDue, so the
  // remainder math in paymentsOnlyOf is unaffected. A failed or canceled
  // refund, or a dispute Jo won, returned nothing. Same helper in all four
  // revenue readers
  // (collected-revenue.js, money-dashboard.js, analytics-kpi.js,
  // pages/leaderboard.js) — tests/refunds-in-revenue-2026-09-29.test.js.
  function refundsOf(inv) {
    var out = [];
    var list = Array.isArray(inv && inv.refunds) ? inv.refunds : [];
    for (var i = 0; i < list.length; i++) {
      var r = list[i] || {};
      var amt = parseFloat(r.amount);
      var at = r.at != null ? r.at : r.date;
      if (!(amt > 0) || at == null || r.status === 'failed' || r.status === 'canceled' || r.status === 'won') continue;
      out.push({ amount: -amt, at: at, refund: true });
    }
    return out;
  }
  function paymentsOf(inv) {
    return paymentsOnlyOf(inv).concat(refundsOf(inv));
  }
  // Canonicalize a vendor name for 1099 matching (mirrors ExpenseConfig.normVendor;
  // inlined to keep this a dependency-free single-module bundle).
  function normVendor(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[.,#&]/g, ' ')
      .replace(/\b(inc|llc|l\.l\.c|co|corp|company|ltd)\b/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Calendar YEAR of a date in the house timezone (America/New_York) — the same
  // convention the monthly-overhead cron uses (monthly-overhead-logic.js), so
  // the client dashboard and the server bucket a date into the same period
  // instead of drifting by the viewer's local offset near year boundaries.
  // Accepts a Date or a raw/Firestore value; null for a null/invalid date. (#11)
  function etYear(v) {
    var d = (v && typeof v.getTime === 'function') ? v : toJSDate(v);
    if (!d || isNaN(d.getTime())) return null;
    return Number(d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 4));
  }

  // 2026-09-15: added 'collections' (Collections lane), then 'warranty_claim'
  // (Warranty Claim lane, same day) — WON_STAGES is only the fallback for a
  // lead with no _stageRole stamped yet, per the comment below, so this list
  // still needs to stay current even though the role-check is the real
  // safety net for everything else.
  var WON_STAGES = ['closed', 'install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'collections', 'warranty_claim', 'Complete'];
  // Role-aware (freeform-pipeline foundation): prefer the denormalized
  // _stageRole (custom-stage-safe), fall back to WON_STAGES for un-stamped leads.
  function isWon(l) {
    var won = (l && l._stageRole) ? l._stageRole === 'won' : WON_STAGES.indexOf((l && (l._stageKey || l.stage)) || '') !== -1;
    return won && !!l && !l.deleted;
  }
  // 1099-NEC threshold by tax year (OBBBA: $2,000 for 2026+). Cents.
  function thresholdCents(year) { var t = { 2024: 60000, 2025: 60000, 2026: 200000 }; return t[year] || 200000; }

  // ── Pure P&L computation (exported for tests) ───────────────────────
  function computePnL(data) {
    var leads = data.leads || [], expenses = data.expenses || [],
        invoices = data.invoices || [], suppliers = data.suppliers || [];
    var year = data.year || etYear(new Date());

    // Cash basis (dated): collected (paid invoices) vs spent (expenses) this year.
    // Year membership is decided in ET (house convention), same as the expense
    // + 1099 buckets below, so nothing straddles the boundary inconsistently.
    var collectedCents = 0;
    invoices.forEach(function (inv) {
      // Attribute EACH payment by the date it was received. A single
      // lastPaymentAt field is overwritten on every credit, so a deposit
      // taken in year Y would vanish from Y's Collected once the balance
      // paid in year Y+1 (multi-payment cash-basis residual of #980/#990).
      // paymentsOf() prefers inv.payments[] entries; legacy docs still use
      // the lastPaymentAt||paidAt lump of total−balanceDue.
      paymentsOf(inv).forEach(function (p) {
        if (etYear(toJSDate(p.at)) === year) {
          collectedCents += Math.round((parseFloat(p.amount) || 0) * 100);
        }
      });
    });
    var outstandingCents = 0;
    invoices.forEach(function (inv) {
      // isOwedInvoice/owedDollarsOf: void/draft/cancelled are not A/R, and a
      // balanceDue of 0 is 0 (not "missing → use total").
      outstandingCents += Math.round(owedDollarsOf(inv) * 100);
    });

    // ── Collections queue (2026-09-15 Collections foundation) ───────────
    // Same outstanding population as outstandingCents above, but bucketed
    // by days-past-due (off dueDate) so a rep sees WHICH invoice to chase,
    // not just one lump total, plus a per-invoice drill-down for the
    // "Move to Collections" driven-UX action. `data.now` lets tests pin
    // the clock; defaults to the real time in the browser.
    var now = data.now ? toJSDate(data.now) : new Date();
    var agingCents = { current: 0, d1_30: 0, d31_60: 0, d61_plus: 0 };
    var collectionsQueue = [];
    invoices.forEach(function (inv) {
      var balC = Math.round(owedDollarsOf(inv) * 100);
      if (balC <= 0) return;
      var due = toJSDate(inv.dueDate);
      var daysPastDue = due ? Math.floor((now.getTime() - due.getTime()) / 86400000) : 0;
      var bucket = daysPastDue <= 0 ? 'current' : daysPastDue <= 30 ? 'd1_30' : daysPastDue <= 60 ? 'd31_60' : 'd61_plus';
      agingCents[bucket] += balC;
      // Freeform-pipeline-safe: reads the LINKED lead's own current stage
      // (not a hardcoded string) so a tenant that renamed/relocated the
      // built-in 'collections' stage still shows the right badge.
      var lead = (inv.leadId && Array.isArray(leads)) ? leads.find(function (l) { return l && l.id === inv.leadId; }) : null;
      collectionsQueue.push({
        id: inv.id || null,
        leadId: inv.leadId || null,
        // Leads store firstName/lastName, not `name` (estimate#9, 2026-09-25):
        // the old `lead.name` fallback never fired, so every invoice saved
        // with a blank customerName queued as "Customer".
        customerName: inv.customerName
          || (lead && (lead.name || [lead.firstName, lead.lastName].filter(Boolean).join(' ')))
          || 'Customer',
        balanceCents: balC,
        dueDate: inv.dueDate || null,
        daysPastDue: daysPastDue,
        bucket: bucket,
        inCollections: !!lead && (lead._stageKey || lead.stage) === 'collections',
        // Set by invoice-reminder.js on a real send (2026-10-01).
        lastReminderAt: inv.lastReminderAt || null,
      });
    });
    collectionsQueue.sort(function (a, b) { return b.daysPastDue - a.daysPastDue; });

    var spentCents = 0, cogsCents = 0, overheadCents = 0;
    var directByLead = {}, supplierCents = {};
    expenses.forEach(function (e) {
      var d = toJSDate(e.date);
      if (etYear(d) !== year) return;
      // Cash out + COGS = the tax-INCLUDED total (amount + tax): you paid the
      // tax to the supplier, so it's real spend and belongs in job cost
      // (product decision 2026-07-08). Same rule in profit-tracker.js +
      // expenses.js aggregate(). NOTE: the 1099 YTD below stays PRE-tax.
      var c = (parseInt(e.amountCents, 10) || 0) + (parseInt(e.taxCents, 10) || 0);
      spentCents += c;
      if (e.costType === 'direct') { cogsCents += c; if (e.leadId) directByLead[e.leadId] = (directByLead[e.leadId] || 0) + c; }
      else overheadCents += c;
      // Group suppliers by NORMALIZED vendor so "ABC Supply" and "abc supply "
      // collapse to one row (same normVendor used for the 1099 match below).
      var supRaw = (e.supplier || '').trim() || 'Unknown';
      var supKey = normVendor(supRaw) || 'unknown';
      if (!supplierCents[supKey]) supplierCents[supKey] = { label: supRaw, cents: 0 };
      supplierCents[supKey].cents += c;
    });
    var netCashCents = collectedCents - spentCents;

    // Job profitability (jobValue basis), costed won jobs only — uncosted jobs
    // would inflate margin (the trap a unit test caught in the Insights cards).
    var wonLeads = leads.filter(isWon);
    var wonContractCents = 0, wonDirectCents = 0, costedJobs = 0;
    wonLeads.forEach(function (l) {
      var revC = Math.round((parseFloat(l.jobValue) || 0) * 100);
      var dc = directByLead[l.id] || 0;
      if (revC > 0 && dc > 0) { wonContractCents += revC; wonDirectCents += dc; costedJobs += 1; }
    });
    var grossMargin = wonContractCents > 0 ? Math.round(((wonContractCents - wonDirectCents) / wonContractCents) * 100) : null;

    // Top suppliers (this-year spend), grouped by normalized vendor above.
    var topSuppliers = Object.keys(supplierCents).map(function (k) { return { supplier: supplierCents[k].label, cents: supplierCents[k].cents }; })
      .sort(function (a, b) { return b.cents - a.cents; }).slice(0, 5);

    // 1099 worklist: eligible class (stored flag) + W-9 on file + YTD service
    // spend (matched by name) >= the year's threshold.
    var th = thresholdCents(year);
    var due1099 = 0, due1099Cents = 0;
    suppliers.forEach(function (s) {
      if (!s.is1099Eligible) return;
      if (s.w9Status !== 'received' && s.w9Status !== 'verified') return;
      var nm = normVendor(s.displayName);
      var ytd = expenses.reduce(function (sum, e) {
        if (e.category !== 'subcontractor' && e.category !== 'direct_labor') return sum;
        if (normVendor(e.supplier) !== nm) return sum;
        // 1099 box 1 = amounts paid for SERVICES, PRE-tax (sales tax is not
        // nonemployee compensation) — deliberately amountCents only, unlike the
        // cash/COGS totals above which include tax.
        return (etYear(toJSDate(e.date)) === year) ? sum + (parseInt(e.amountCents, 10) || 0) : sum;
      }, 0);
      if (ytd >= th) { due1099 += 1; due1099Cents += ytd; }
    });

    return {
      year: year,
      collectedCents: collectedCents, spentCents: spentCents, netCashCents: netCashCents,
      cogsCents: cogsCents, overheadCents: overheadCents, outstandingCents: outstandingCents,
      agingCents: agingCents, collectionsQueue: collectionsQueue,
      wonContractCents: wonContractCents, wonDirectCents: wonDirectCents, grossMargin: grossMargin,
      costedJobs: costedJobs, wonJobs: wonLeads.length,
      topSuppliers: topSuppliers, supplierCount: Object.keys(supplierCents).length,
      due1099: due1099, due1099Cents: due1099Cents, thresholdCents: th,
    };
  }

  // ── Month close (2026-10-01) ────────────────────────────────────────
  // Jo's idea triage: "Bookkeeper agent: on the 1st, categorize receipts and
  // close the month" — built Jo's way: an in-app checklist for the PREVIOUS
  // calendar month (America/New_York, the house convention etYear uses).
  // Nothing automatic, nothing sent. monthClose() is pure (exported for
  // tests/month-close-2026-10-01.test.js); render lives in monthCloseHtml().
  //
  //   collectedCents — paymentsOf() (the same per-payment ledger + refunds
  //                    computePnL and collected-revenue.js use), each entry
  //                    by its own date; deleted invoices skipped exactly as
  //                    NBDRevenue.collectedBetween skips them.
  //   expensesCents  — amountCents + taxCents (the computePnL "Spent" rule),
  //                    falling back to a legacy dollar `amount` field.
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  // { y, m (1-12), d } of a date in America/New_York; null when invalid.
  function etParts(v) {
    var d = (v && typeof v.getTime === 'function') ? v : toJSDate(v);
    if (!d || isNaN(d.getTime())) return null;
    var s = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return { y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)), d: Number(s.slice(8, 10)), iso: s.slice(0, 10) };
  }
  function monthKeyOf(v) { var p = etParts(v); return p ? p.iso.slice(0, 7) : null; }
  function prevMonthOf(now) {
    var p = etParts(now) || etParts(new Date());
    var y = p.m === 1 ? p.y - 1 : p.y, m = p.m === 1 ? 12 : p.m - 1;
    return { key: y + '-' + (m < 10 ? '0' : '') + m, label: MONTH_NAMES[m - 1] + ' ' + y, monthName: MONTH_NAMES[m - 1], dayOfMonth: p.d };
  }
  // Expense money in cents: amountCents (+ taxCents), legacy dollar `amount`.
  function expenseCentsOf(e) {
    var base = (e.amountCents != null && e.amountCents !== '')
      ? (parseInt(e.amountCents, 10) || 0)
      : Math.round((parseFloat(e.amount) || 0) * 100);
    return base + (parseInt(e.taxCents, 10) || 0);
  }
  function isUncategorized(cat) {
    var c = String(cat == null ? '' : cat).trim().toLowerCase();
    return !c || c === 'uncategorized' || c === 'other';
  }
  // Receipt fields: expenses.js writes receiptStoragePath; tolerate the other
  // shapes an import or older doc might carry. Mileage needs no receipt (same
  // exemption as the Expenses view's "without a receipt" nudge).
  function hasReceipt(e) {
    if (e.category === 'mileage') return true;
    return !!(e.receiptStoragePath || e.receiptUrl || e.receiptPath || e.receiptDocRef ||
      (Array.isArray(e.attachments) && e.attachments.length));
  }
  function expenseLabel(e) {
    return String(e.supplier || e.vendor || e.description || e.note || e.category || 'Expense').trim().slice(0, 80) || 'Expense';
  }

  function monthClose(data, now) {
    data = data || {};
    var pm = prevMonthOf(now ? toJSDate(now) : new Date());
    var key = pm.key;
    var invoices = data.invoices || [], expenses = data.expenses || [];

    var collectedCents = 0;
    invoices.forEach(function (inv) {
      if (!inv || inv.deleted === true) return;
      paymentsOf(inv).forEach(function (p) {
        if (monthKeyOf(p.at) === key) collectedCents += Math.round((parseFloat(p.amount) || 0) * 100);
      });
    });

    var expensesCents = 0, directCents = 0, overheadCents = 0, byCat = {};
    var uncategorized = [], untied = [], noReceipt = [];
    expenses.forEach(function (e) {
      if (!e || e.deleted === true) return;
      var p = etParts(e.date);
      if (!p || p.iso.slice(0, 7) !== key) return;
      var c = expenseCentsOf(e);
      expensesCents += c;
      var direct = e.costType === 'direct';
      if (direct) directCents += c; else overheadCents += c;
      var catKey = isUncategorized(e.category) ? 'uncategorized' : String(e.category);
      byCat[catKey] = (byCat[catKey] || 0) + c;
      var item = { id: e.id || null, label: expenseLabel(e), amountCents: c, date: p.iso, leadId: e.leadId || null };
      if (isUncategorized(e.category)) uncategorized.push(item);
      if (direct && !e.leadId) untied.push(item);
      if (!hasReceipt(e)) noReceipt.push(item);
    });

    // Invoices that went out last month and still carry a balance. Sent date
    // = sentAt (stamped when an invoice leaves draft), else createdAt for a
    // non-draft doc that predates sentAt.
    var unpaid = [];
    invoices.forEach(function (inv) {
      if (!isOwedInvoice(inv)) return;
      var p = etParts(inv.sentAt != null ? inv.sentAt : inv.createdAt);
      if (!p || p.iso.slice(0, 7) !== key) return;
      var balC = Math.round(owedDollarsOf(inv) * 100);
      if (balC <= 0) return;
      unpaid.push({ id: inv.id || null, label: String(inv.customerName || inv.invoiceNumber || 'Invoice').slice(0, 80), amountCents: balC, date: p.iso, leadId: inv.leadId || null });
    });

    function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }
    [uncategorized, untied, noReceipt, unpaid].forEach(function (l) { l.sort(byDate); });
    var categories = Object.keys(byCat).map(function (k) { return { category: k, cents: byCat[k] }; })
      .sort(function (a, b) { return b.cents - a.cents; }).slice(0, 5);
    var closes = data.monthCloses || {};
    var closed = closes[key] || null;
    return {
      monthKey: key, monthLabel: pm.label, monthName: pm.monthName, dayOfMonth: pm.dayOfMonth,
      collectedCents: collectedCents, expensesCents: expensesCents, netCents: collectedCents - expensesCents,
      directCents: directCents, overheadCents: overheadCents, categories: categories,
      uncategorized: uncategorized, untiedDirect: untied, missingReceipts: noReceipt, unpaidInvoices: unpaid,
      closed: !!closed, closedInfo: closed,
      // Prominent (open) during the first 10 days of the month while still
      // open; a closed month or a late one collapses to a small line.
      prominent: !closed && pm.dayOfMonth <= 10,
    };
  }

  // ── Data fetch ──────────────────────────────────────────────────────
  async function fetchData() {
    var db = window.db || window._db, u = uid();
    var out = { leads: window._leads || [], expenses: [], invoices: [], suppliers: [], monthCloses: {}, year: new Date().getFullYear() };
    if (!db || !u || !window.getDocs) return out;
    var col = window.collection, q = window.query, where = window.where, getDocs = window.getDocs;
    var staff = isStaff() && claims().companyId;
    var jobs = [
      // expenses + suppliers: staff -> companyId, else userId (rule-safe)
      getDocs(staff ? q(col(db, 'expenses'), where('companyId', '==', companyId())) : q(col(db, 'expenses'), where('userId', '==', u)))
        // `id` kept so the month-close tidy-up lists can name each expense.
        .then(function (s) { out.expenses = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); }).catch(function () {}),
      getDocs(staff ? q(col(db, 'suppliers'), where('companyId', '==', companyId())) : q(col(db, 'suppliers'), where('userId', '==', u)))
        .then(function (s) { out.suppliers = s.docs.map(function (d) { return d.data(); }); }).catch(function () {}),
      // invoices: staff -> companyId (team-wide A/R, matches the invoice
      // rules' isCompanyStaff() read branch — Collections foundation,
      // 2026-09-15), else createdBy (their own historical ownership field).
      // `id` is kept on every doc (previously dropped) so the Collections
      // queue below can act on a specific invoice, not just sum them.
      getDocs(staff ? q(col(db, 'invoices'), where('companyId', '==', companyId())) : q(col(db, 'invoices'), where('createdBy', '==', u)))
        .then(function (s) { out.invoices = s.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); }).catch(function () {}),
    ];
    // Month-close marks live on the user's own settings doc
    // (userSettings/{uid}: owner read/write in firestore.rules).
    if (window.getDoc && window.doc) {
      jobs.push(window.getDoc(window.doc(db, 'userSettings', u))
        .then(function (snap) {
          var d = snap && typeof snap.data === 'function' ? snap.data() : null;
          if (d && d.monthCloses && typeof d.monthCloses === 'object') out.monthCloses = d.monthCloses;
        }).catch(function () {}));
    }
    await Promise.all(jobs);
    return out;
  }

  // ── Render ──────────────────────────────────────────────────────────
  // KPI tile on the canonical .stat-card spec (dashboard-app.css). Column
  // layout + top accent are per-tile layout, not chrome. The colored value
  // sets -webkit-text-fill-color too because the polished .stat-val paints
  // via a background-clip gradient (fill-color transparent) — inline color
  // alone would be invisible.
  function card(label, value, sub, color) {
    return '<div class="stat-card" style="flex-direction:column;align-items:flex-start;gap:2px;border-top:2px solid ' + color + ';">' +
      '<div class="stat-lbl mdx-sec">' + esc(label) + '</div>' +
      '<div class="stat-val" style="font-weight:800;color:' + color + ';-webkit-text-fill-color:' + color + ';margin:2px 0;">' + value + '</div>' +
      '<div class="mdx-m10">' + esc(sub) + '</div></div>';
  }
  function grid(cards) {
    return '<div class="mdx-stats">' + cards.join('') + '</div>';
  }

  // ── Month-close card ────────────────────────────────────────────────
  // Native <details> for every collapse (no JS, CSP-clean). Every value that
  // reaches innerHTML goes through esc(); hrefs are encodeURIComponent'd too.
  function catLabel(k) {
    if (k === 'uncategorized') return 'Uncategorized';
    var EC = window.ExpenseConfig;
    if (EC && typeof EC.labelFor === 'function') { try { var l = EC.labelFor(k); if (l) return l; } catch (_) {} }
    return String(k).replace(/_/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
  }
  function closeItemHtml(it, kind) {
    // Expenses are fixed in the Expenses view (category, job, receipt); an
    // unpaid invoice is chased from its customer page.
    var href = kind === 'invoice'
      ? (it.leadId ? '/pro/customer.html?id=' + encodeURIComponent(it.leadId) : '')
      : '#/expenses';
    var name = '<span class="mdx-name">' + esc(it.label) + '</span>';
    return '<li class="mdx-row">' +
      '<div class="mdx-grow160">' +
        (href ? '<a href="' + esc(href) + '" class="mdx-link-chip">' + name + '</a>' : name) +
        '<div class="mdx-m11b">' + esc(it.date) + '</div></div>' +
      '<div class="mdx-amt">' + esc(fmt(it.amountCents)) + '</div></li>';
  }
  function closeListHtml(items, one, many, kind, fixHint) {
    if (!items.length) return '';
    var n = items.length;
    var shown = items.slice(0, 25);
    var html = '<details class="mdx-rule">' +
      '<summary class="mdx-toggle">' +
        esc(n + ' ' + (n === 1 ? one : many)) + '</summary>' +
      '<div class="mdx-m11-mb4">' + esc(fixHint) + '</div>' +
      '<ul class="mdx-list">';
    shown.forEach(function (it) { html += closeItemHtml(it, kind); });
    html += '</ul>';
    if (n > shown.length) html += '<div class="mdx-m11-pad">' + esc('+' + (n - shown.length) + ' more') + '</div>';
    return html + '</details>';
  }
  function monthCloseHtml(mc) {
    if (!mc) return '';
    var netColor = mc.netCents >= 0 ? 'var(--green)' : 'var(--red)';
    var shell = 'background:var(--s);border:1px solid var(--br);border-radius:12px;padding:12px 16px;margin-bottom:20px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;';
    var summaryText = mc.closed
      ? mc.monthName + ' closed ✓'
      : 'Close ' + mc.monthLabel;
    var summaryStyle = mc.prominent
      ? 'cursor:pointer;min-height:44px;display:flex;align-items:center;font-family:\'Barlow Condensed\',sans-serif;font-size:20px;font-weight:800;color:var(--t);'
      : 'cursor:pointer;min-height:44px;display:flex;align-items:center;font-size:13px;font-weight:700;color:' + (mc.closed ? 'var(--green)' : 'var(--orange)') + ';';
    var html = '<details id="nbd-month-close" data-month="' + esc(mc.monthKey) + '"' + (mc.prominent ? ' open' : '') +
      ' style="' + shell + (mc.prominent ? 'border-top:2px solid var(--orange);' : '') + '">' +
      '<summary style="' + summaryStyle + '">' + esc(summaryText) + '</summary>';
    var big = function (label, cents, color) {
      return '<div class="mdx-grow90"><div class="mdx-caps10">' + esc(label) + '</div>' +
        '<div style="font-size:20px;font-weight:800;color:' + color + ';white-space:nowrap;">' + esc(fmt(cents)) + '</div></div>';
    };
    html += '<div class="mdx-meta-row">' +
      big('Collected', mc.collectedCents, 'var(--green)') +
      big('Expenses', mc.expensesCents, 'var(--orange)') +
      big('Net', mc.netCents, netColor) + '</div>' +
      '<div class="mdx-m11-mb10">' + esc(mc.monthLabel + ' · collected money only (payments received, refunds taken off) · expenses incl. tax') + '</div>';
    if (mc.categories.length) {
      html += '<div class="mdx-caps11">Where it went</div><ul class="mdx-list-mb">';
      mc.categories.forEach(function (c) {
        html += '<li class="mdx-kv"><span class="mdx-wrap">' + esc(catLabel(c.category)) + '</span><span class="mdx-b-nw">' + esc(fmt(c.cents)) + '</span></li>';
      });
      html += '</ul>';
    } else {
      html += '<div class="mdx-m12-mb">' + esc('No expenses logged for ' + mc.monthLabel + '.') + '</div>';
    }
    var tidy = closeListHtml(mc.uncategorized, 'expense needs a category', 'expenses need a category', 'expense', 'Open Expenses and pick a category.') +
      closeListHtml(mc.untiedDirect, 'direct cost isn\'t tied to a job', 'direct costs aren\'t tied to a job', 'untied', 'Open Expenses and choose the customer this cost belongs to.') +
      closeListHtml(mc.missingReceipts, 'missing receipt', 'missing receipts', 'expense', 'Attach a photo or PDF in Expenses (recommended, never required).') +
      closeListHtml(mc.unpaidInvoices, 'invoice from last month still unpaid', 'invoices from last month still unpaid', 'invoice', 'Open the customer to chase it — nothing is sent from here.');
    html += tidy || '<div class="mdx-ok-row">Nothing to tidy up.</div>';
    if (mc.closed) {
      html += '<div class="mdx-ok-note">' + esc(mc.monthName + ' closed ✓') + '</div>';
    } else {
      html += '<div class="mdx-pt12"><button type="button" class="btn btn-orange mdx-btn-wrap" data-action="module" data-target="MoneyDashboard.markMonthClosed" data-arg="' + esc(mc.monthKey) + '">' +
        esc('Looks good — mark ' + mc.monthName + ' closed') + '</button></div>';
    }
    return html + '</details>';
  }

  // Last-rendered collections queue, keyed for moveToCollections() below —
  // the delegated data-action="module" click only carries the invoice id,
  // so this is how the handler recovers the leadId/inCollections it needs
  // without a second Firestore read.
  var _lastQueue = [];

  function render(m) {
    var scroll = document.querySelector('#view-money .view-scroll');
    if (!scroll) return;
    _lastQueue = m.collectionsQueue || [];
    var netColor = m.netCashCents >= 0 ? 'var(--green,#16a34a)' : 'var(--red,#dc2626)';
    var marginColor = m.grossMargin == null ? 'var(--t,#fff)' : m.grossMargin >= 40 ? 'var(--green,#16a34a)' : m.grossMargin >= 25 ? 'var(--gold,#eab308)' : 'var(--red,#dc2626)';
    var html = '';
    html += '<div class="mdx-mb18"><h2 class="mdx-title">💵 Money — ' + m.year + '</h2>' +
      '<div class="mdx-m12-mt">' + (isStaff() && claims().companyId ? 'Team-wide' : 'Your books') + ' · live snapshot</div></div>';

    // Close last month (2026-10-01) — checklist card, near the top.
    html += monthCloseHtml(m.monthClose);

    // Cash (this year)
    html += '<div class="mdx-caps12">Cash — ' + m.year + ' (collected vs spent)</div>';
    html += grid([
      card('Collected', fmt(m.collectedCents), 'paid invoices', 'var(--green,#16a34a)'),
      card('Spent', fmt(m.spentCents), 'COGS + overhead', 'var(--orange,#BD5728)'),
      card('Net Cash', fmt(m.netCashCents), m.netCashCents >= 0 ? 'in the black' : 'in the red', netColor),
      card('Outstanding A/R', fmt(m.outstandingCents), 'unpaid invoices', 'var(--blue,#3b82f6)'),
    ]);

    // Stripe panel (2026-09-29): balance, payouts, this month's Stripe
    // collected, the needs-review list and Sync from Stripe. Rendered by
    // stripe-ledger-panel.js into this host; hidden for sales reps and
    // viewers (they cannot read the ledger).
    html += '<div id="nbd-stripe-panel" hidden></div>';

    // Collections queue — same outstanding population as the Outstanding
    // A/R tile above, broken into aging buckets + a per-invoice
    // drill-down so a rep knows WHICH invoice to chase and can act on it
    // in one click (driven-UX: 2026-09-15 Collections foundation).
    var overdue = (m.collectionsQueue || []).filter(function (q) { return q.daysPastDue > 0; });
    html += '<div class="mdx-caps12">Collections Queue</div>';
    html += grid([
      card('Current', fmt(m.agingCents.current), 'not yet due', 'var(--blue,#3b82f6)'),
      card('1–30 Days', fmt(m.agingCents.d1_30), 'past due', 'var(--gold,#eab308)'),
      card('31–60 Days', fmt(m.agingCents.d31_60), 'past due', 'var(--orange,#BD5728)'),
      card('60+ Days', fmt(m.agingCents.d61_plus), 'past due', 'var(--red,#dc2626)'),
    ]);
    html += '<div class="ui-card mdx-mb20">';
    if (!overdue.length) {
      html += '<div class="nbd-empty mdx-pad14"><div class="ne-icon">✅</div><div class="ne-msg">Nothing overdue</div><div class="ne-sub">Every outstanding invoice is still inside its terms.</div></div>';
    } else {
      var shownQ = overdue.slice(0, 20);
      html += '<div class="mdx-col8">';
      shownQ.forEach(function (q) {
        var badgeColor = q.bucket === 'd61_plus' ? 'var(--red,#dc2626)' : q.bucket === 'd31_60' ? 'var(--orange,#BD5728)' : 'var(--gold,#eab308)';
        var nameHtml = q.leadId
          ? '<a href="/pro/customer.html?id=' + encodeURIComponent(q.leadId) + '" class="mdx-link">' + esc(q.customerName) + '</a>'
          : '<span class="mdx-strong">' + esc(q.customerName) + '</span>';
        var actionHtml = q.inCollections
          ? '<span class="mdx-label">⏰ In Collections</span>'
          : (q.leadId && q.id)
            ? '<button type="button" class="btn btn-orange btn-sm mdx-btn-xs" data-action="module" data-target="MoneyDashboard.moveToCollections" data-arg="' + esc(q.id) + '">Move to Collections</button>'
            : '';
        // One-tap payment reminder (invoice-reminder.js): the rep sees and
        // edits the message, then taps Text or Email — nothing auto-sends.
        if (q.id && window.NBDInvoiceReminder) {
          actionHtml = '<button type="button" class="btn btn-ghost btn-sm mdx-btn-sm" data-action="module" data-target="NBDInvoiceReminder.open" data-arg="' + esc(q.id) + '">Remind</button> ' + actionHtml;
        }
        var dueJS = q.dueDate ? toJSDate(q.dueDate) : null;
        var remJS = q.lastReminderAt ? toJSDate(q.lastReminderAt) : null;
        var remDays = remJS ? Math.max(0, Math.floor((Date.now() - remJS.getTime()) / 86400000)) : null;
        var dueLabel = (dueJS ? 'due ' + dueJS.toLocaleDateString() : 'no due date')
          + (remDays != null ? ' · reminded ' + (remDays === 0 ? 'today' : remDays + 'd ago') : '');
        html += '<div class="mdx-row-wrap">' +
          '<div class="mdx-minw140">' + nameHtml + '<div class="mdx-m11">' + dueLabel + '</div></div>' +
          '<div style="font-size:12px;font-weight:700;color:' + badgeColor + ';white-space:nowrap;">' + q.daysPastDue + 'd overdue</div>' +
          '<div class="mdx-amt-strong">' + fmt(q.balanceCents) + '</div>' +
          '<div class="mdx-nw">' + actionHtml + '</div>' +
          '</div>';
      });
      html += '</div>';
      if (overdue.length > shownQ.length) html += '<div class="mdx-m11-mt10">+' + (overdue.length - shownQ.length) + ' more overdue invoice' + (overdue.length - shownQ.length === 1 ? '' : 's') + '</div>';
    }
    html += '</div>';

    // Job profitability
    html += '<div class="mdx-caps12">Job profitability (won jobs)</div>';
    html += grid([
      card('Contract Value', fmt(m.wonContractCents), m.costedJobs + ' of ' + m.wonJobs + ' won jobs costed', 'var(--blue,#3b82f6)'),
      card('Direct Costs', fmt(m.wonDirectCents), 'materials, labor, subs', 'var(--orange,#BD5728)'),
      card('Gross Margin', m.grossMargin == null ? '—' : m.grossMargin + '%', 'before overhead & commission', marginColor),
      card('Overhead', fmt(m.overheadCents), 'operating costs YTD', 'var(--purple,#8b5cf6)'),
    ]);

    // Two-column: top suppliers + 1099
    html += '<div class="mdx-cols">';
    html += '<div class="ui-card">' +
      '<h3 class="mdx-h3">Top Suppliers — ' + m.year + '</h3>';
    if (!m.topSuppliers.length) html += '<div class="nbd-empty mdx-pad14"><div class="ne-icon">🧾</div><div class="ne-msg">No spend logged yet</div><div class="ne-sub">Log expenses in the Expenses view and they roll up here.</div></div>';
    else {
      var max = m.topSuppliers[0].cents || 1;
      m.topSuppliers.forEach(function (s) {
        var w = Math.max(4, Math.round(s.cents / max * 100));
        html += '<div class="mdx-mb10"><div class="mdx-kv-tight"><span>' + esc(s.supplier) + '</span><span class="mdx-b">' + fmt(s.cents) + '</span></div>' +
          '<div class="mdx-bar"><div style="height:100%;width:' + w + '%;background:var(--orange,#BD5728);"></div></div></div>';
      });
    }
    html += '</div>';
    html += '<div class="ui-card">' +
      '<h3 class="mdx-h3">1099 Worklist — ' + m.year + '</h3>' +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:40px;font-weight:800;color:' + (m.due1099 ? 'var(--orange,#BD5728)' : 'var(--t,#fff)') + ';">' + m.due1099 + '</div>' +
      '<div class="mdx-m12">supplier(s) need a 1099-NEC · ' + fmt(m.due1099Cents) + ' in service payments</div>' +
      '<div class="mdx-m10-mt">Eligible + W-9 on file + ≥ ' + fmt(m.thresholdCents) + ' (' + m.year + ' threshold). Manage in Expenses → Suppliers.</div>' +
      '</div>';
    html += '</div>';

    scroll.innerHTML = html;
    if (window.StripeLedgerPanel) { try { window.StripeLedgerPanel.mount('nbd-stripe-panel'); } catch (e) { console.warn('[money] stripe panel', e); } }
  }

  // Lazily-loaded, cached handle on stage-write.js's shared
  // commitStageChange — same pattern as crm-pipeline.js's _stageWriteMod()
  // and customer-bootstrap.module.js's progressStage(). money-dashboard.js
  // is a plain <script> (not a module), so this is a dynamic import; both
  // dashboard.html and customer.html already modulepreload the file.
  var _stageWriteModPromise = null;
  function _stageWriteMod() {
    if (!_stageWriteModPromise) _stageWriteModPromise = import('./stage-write.js');
    return _stageWriteModPromise;
  }

  // "Move to Collections" — the Collections queue's driven-UX action.
  // Looks the invoice up in the last-rendered queue (for its leadId +
  // current inCollections flag), then writes the stage through the same
  // transactional commitStageChange() every other stage move uses, so this
  // gets the same race guards, activity note, drip trigger, and stage-entry
  // task as a kanban drag or the customer page's "Move to Next Stage".
  async function moveToCollections(invoiceId) {
    var entry = _lastQueue.find(function (q) { return q.id === invoiceId; });
    if (!entry || !entry.leadId) {
      if (typeof showToast === 'function') showToast('No linked customer on this invoice — open it from the lead instead.', 'error');
      return;
    }
    if (entry.inCollections) return; // already there — the button shouldn't even render, but stay a safe no-op
    var lead = (window._leads || []).find(function (l) { return l && l.id === entry.leadId; });
    var oldStage = lead ? (lead._stageKey || lead.stage) : null;
    try {
      var mod = await _stageWriteMod();
      await mod.commitStageChange(entry.leadId, 'collections', oldStage, {
        actorLabel: (window._currentUser && window._currentUser.email) || undefined,
        jobType: (lead && lead.jobType) || null,
      });
      if (lead) {
        lead.stage = 'collections';
        if (typeof window.stageRole === 'function') lead.stageRole = window.stageRole('collections');
      }
      if (typeof showToast === 'function') showToast('Moved to Collections — a follow-up task was added.', 'success');
      refreshAndRender();
    } catch (e) {
      var msg = e && e.message;
      if (msg === 'STAGE_RACE_NOOP') {
        if (typeof showToast === 'function') showToast('Already on that stage.', 'info');
        refreshAndRender();
        return;
      }
      if (msg === 'STAGE_RACE_LOST') {
        if (typeof showToast === 'function') showToast('This lead moved elsewhere — refresh to see its current stage.', 'error');
        return;
      }
      console.warn('[money] moveToCollections failed', e);
      if (typeof showToast === 'function') showToast('Could not move to Collections — try again.', 'error');
    }
  }

  // "Looks good — mark September closed". Stores the close (with the totals
  // Jo saw) on userSettings/{uid}.monthCloses[YYYY-MM] — merge:true so other
  // months and other settings fields are untouched. Nothing else is written
  // or sent. Re-renders from the last fetched data, no refetch.
  var _lastData = null;
  async function markMonthClosed(monthKey) {
    var u = uid(), db = window.db || window._db;
    if (!/^\d{4}-\d{2}$/.test(String(monthKey || ''))) return false;
    if (!u || !db || !window.setDoc || !window.doc) {
      if (typeof showToast === 'function') showToast('Not signed in — could not save the close.', 'error');
      return false;
    }
    var mc = _lastData ? monthClose(_lastData, new Date()) : null;
    var entry = {
      closedAt: typeof window.serverTimestamp === 'function' ? window.serverTimestamp() : new Date(),
      collectedCents: mc && mc.monthKey === monthKey ? mc.collectedCents : null,
      expensesCents: mc && mc.monthKey === monthKey ? mc.expensesCents : null,
      netCents: mc && mc.monthKey === monthKey ? mc.netCents : null,
    };
    var patch = { monthCloses: {} };
    patch.monthCloses[monthKey] = entry;
    try {
      await window.setDoc(window.doc(db, 'userSettings', u), patch, { merge: true });
    } catch (e) {
      console.warn('[money] mark month closed failed', e && e.code);
      if (typeof showToast === 'function') showToast('Could not save — try again.', 'error');
      return false;
    }
    if (_lastData) {
      _lastData.monthCloses = Object.assign({}, _lastData.monthCloses || {});
      _lastData.monthCloses[monthKey] = { closedAt: new Date(), collectedCents: entry.collectedCents, expensesCents: entry.expensesCents, netCents: entry.netCents };
      try { renderData(_lastData); } catch (e) { console.warn('[money] re-render failed', e); }
    }
    if (typeof showToast === 'function') showToast((mc ? mc.monthName : 'Month') + ' closed ✓', 'success');
    return true;
  }

  function renderData(data) {
    var m = computePnL(data);
    m.monthClose = monthClose(data, new Date());
    render(m);
  }

  var _loaded = false;
  async function refreshAndRender() {
    var scroll = document.querySelector('#view-money .view-scroll');
    if (scroll && !_loaded) scroll.innerHTML = '<div class="mdx-empty">Loading your books…</div>';
    var data = await fetchData();
    _loaded = true;
    _lastData = data;
    try { renderData(data); }
    catch (e) { console.warn('[money] render failed', e); if (scroll) scroll.innerHTML = '<div class="mdx-empty">Could not load the money dashboard.</div>'; }
  }
  function init() { refreshAndRender(); }

  window.MoneyDashboard = {
    init: init,
    render: render,
    refresh: refreshAndRender,
    computePnL: computePnL, // pure — exported for unit tests
    moveToCollections: moveToCollections, // Collections queue's data-action="module" target
    monthClose: monthClose, // pure — previous ET calendar month's close checklist
    monthCloseHtml: monthCloseHtml, // the card's markup (exported for tests)
    markMonthClosed: markMonthClosed, // month-close button's data-action="module" target
    _setLastData: function (d) { _lastData = d; }, // test hook
  };
})();
