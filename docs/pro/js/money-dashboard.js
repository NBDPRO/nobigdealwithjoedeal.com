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
      if (inv.status === 'paid') return;
      outstandingCents += Math.round((parseFloat(inv.balanceDue) || parseFloat(inv.total) || 0) * 100);
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
      if (inv.status === 'paid') return;
      var balC = Math.round((parseFloat(inv.balanceDue) || parseFloat(inv.total) || 0) * 100);
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

  // ── Data fetch ──────────────────────────────────────────────────────
  async function fetchData() {
    var db = window.db || window._db, u = uid();
    var out = { leads: window._leads || [], expenses: [], invoices: [], suppliers: [], year: new Date().getFullYear() };
    if (!db || !u || !window.getDocs) return out;
    var col = window.collection, q = window.query, where = window.where, getDocs = window.getDocs;
    var staff = isStaff() && claims().companyId;
    var jobs = [
      // expenses + suppliers: staff -> companyId, else userId (rule-safe)
      getDocs(staff ? q(col(db, 'expenses'), where('companyId', '==', companyId())) : q(col(db, 'expenses'), where('userId', '==', u)))
        .then(function (s) { out.expenses = s.docs.map(function (d) { return d.data(); }); }).catch(function () {}),
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
      '<div class="stat-lbl" style="margin-top:0;text-transform:uppercase;letter-spacing:.05em;">' + esc(label) + '</div>' +
      '<div class="stat-val" style="font-weight:800;color:' + color + ';-webkit-text-fill-color:' + color + ';margin:2px 0;">' + value + '</div>' +
      '<div style="font-size:10px;color:var(--m,#9ca3af);">' + esc(sub) + '</div></div>';
  }
  function grid(cards) {
    return '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px;">' + cards.join('') + '</div>';
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
    html += '<div style="margin-bottom:18px;"><h2 style="margin:0;font-family:\'Barlow Condensed\',sans-serif;font-size:26px;font-weight:800;color:var(--t,#fff);">💵 Money — ' + m.year + '</h2>' +
      '<div style="font-size:12px;color:var(--m,#9ca3af);margin-top:2px;">' + (isStaff() && claims().companyId ? 'Team-wide' : 'Your books') + ' · live snapshot</div></div>';

    // Cash (this year)
    html += '<div style="font-size:12px;font-weight:700;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Cash — ' + m.year + ' (collected vs spent)</div>';
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
    html += '<div style="font-size:12px;font-weight:700;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Collections Queue</div>';
    html += grid([
      card('Current', fmt(m.agingCents.current), 'not yet due', 'var(--blue,#3b82f6)'),
      card('1–30 Days', fmt(m.agingCents.d1_30), 'past due', 'var(--gold,#eab308)'),
      card('31–60 Days', fmt(m.agingCents.d31_60), 'past due', 'var(--orange,#BD5728)'),
      card('60+ Days', fmt(m.agingCents.d61_plus), 'past due', 'var(--red,#dc2626)'),
    ]);
    html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;margin-bottom:20px;">';
    if (!overdue.length) {
      html += '<div class="nbd-empty" style="padding:14px"><div class="ne-icon">✅</div><div class="ne-msg">Nothing overdue</div><div class="ne-sub">Every outstanding invoice is still inside its terms.</div></div>';
    } else {
      var shownQ = overdue.slice(0, 20);
      html += '<div style="display:flex;flex-direction:column;gap:8px;">';
      shownQ.forEach(function (q) {
        var badgeColor = q.bucket === 'd61_plus' ? 'var(--red,#dc2626)' : q.bucket === 'd31_60' ? 'var(--orange,#BD5728)' : 'var(--gold,#eab308)';
        var nameHtml = q.leadId
          ? '<a href="/pro/customer.html?id=' + encodeURIComponent(q.leadId) + '" style="color:var(--t,#fff);text-decoration:none;font-weight:700;">' + esc(q.customerName) + '</a>'
          : '<span style="color:var(--t,#fff);font-weight:700;">' + esc(q.customerName) + '</span>';
        var actionHtml = q.inCollections
          ? '<span style="font-size:10px;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;">⏰ In Collections</span>'
          : (q.leadId && q.id)
            ? '<button type="button" class="btn btn-orange btn-sm" data-action="module" data-target="MoneyDashboard.moveToCollections" data-arg="' + esc(q.id) + '" style="font-size:11px;padding:4px 10px;">Move to Collections</button>'
            : '';
        var dueJS = q.dueDate ? toJSDate(q.dueDate) : null;
        var dueLabel = dueJS ? 'due ' + dueJS.toLocaleDateString() : 'no due date';
        html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--br,rgba(255,255,255,.06));flex-wrap:wrap;">' +
          '<div style="min-width:140px;">' + nameHtml + '<div style="font-size:11px;color:var(--m,#9ca3af);">' + dueLabel + '</div></div>' +
          '<div style="font-size:12px;font-weight:700;color:' + badgeColor + ';white-space:nowrap;">' + q.daysPastDue + 'd overdue</div>' +
          '<div style="font-size:13px;font-weight:800;color:var(--t,#fff);white-space:nowrap;">' + fmt(q.balanceCents) + '</div>' +
          '<div style="white-space:nowrap;">' + actionHtml + '</div>' +
          '</div>';
      });
      html += '</div>';
      if (overdue.length > shownQ.length) html += '<div style="font-size:11px;color:var(--m,#9ca3af);margin-top:10px;">+' + (overdue.length - shownQ.length) + ' more overdue invoice' + (overdue.length - shownQ.length === 1 ? '' : 's') + '</div>';
    }
    html += '</div>';

    // Job profitability
    html += '<div style="font-size:12px;font-weight:700;color:var(--m,#9ca3af);text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Job profitability (won jobs)</div>';
    html += grid([
      card('Contract Value', fmt(m.wonContractCents), m.costedJobs + ' of ' + m.wonJobs + ' won jobs costed', 'var(--blue,#3b82f6)'),
      card('Direct Costs', fmt(m.wonDirectCents), 'materials, labor, subs', 'var(--orange,#BD5728)'),
      card('Gross Margin', m.grossMargin == null ? '—' : m.grossMargin + '%', 'before overhead & commission', marginColor),
      card('Overhead', fmt(m.overheadCents), 'operating costs YTD', 'var(--purple,#8b5cf6)'),
    ]);

    // Two-column: top suppliers + 1099
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;">';
    html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;">' +
      '<h3 style="margin:0 0 12px;font-size:14px;color:var(--t,#fff);">Top Suppliers — ' + m.year + '</h3>';
    if (!m.topSuppliers.length) html += '<div class="nbd-empty" style="padding:14px"><div class="ne-icon">🧾</div><div class="ne-msg">No spend logged yet</div><div class="ne-sub">Log expenses in the Expenses view and they roll up here.</div></div>';
    else {
      var max = m.topSuppliers[0].cents || 1;
      m.topSuppliers.forEach(function (s) {
        var w = Math.max(4, Math.round(s.cents / max * 100));
        html += '<div style="margin-bottom:10px;"><div style="display:flex;justify-content:space-between;font-size:13px;color:var(--t,#fff);"><span>' + esc(s.supplier) + '</span><span style="font-weight:700;">' + fmt(s.cents) + '</span></div>' +
          '<div style="height:6px;background:var(--s2,rgba(255,255,255,.06));border-radius:4px;overflow:hidden;margin-top:4px;"><div style="height:100%;width:' + w + '%;background:var(--orange,#BD5728);"></div></div></div>';
      });
    }
    html += '</div>';
    html += '<div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:16px;">' +
      '<h3 style="margin:0 0 12px;font-size:14px;color:var(--t,#fff);">1099 Worklist — ' + m.year + '</h3>' +
      '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:40px;font-weight:800;color:' + (m.due1099 ? 'var(--orange,#BD5728)' : 'var(--t,#fff)') + ';">' + m.due1099 + '</div>' +
      '<div style="font-size:12px;color:var(--m,#9ca3af);">supplier(s) need a 1099-NEC · ' + fmt(m.due1099Cents) + ' in service payments</div>' +
      '<div style="font-size:10px;color:var(--m,#9ca3af);margin-top:8px;">Eligible + W-9 on file + ≥ ' + fmt(m.thresholdCents) + ' (' + m.year + ' threshold). Manage in Expenses → Suppliers.</div>' +
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

  var _loaded = false;
  async function refreshAndRender() {
    var scroll = document.querySelector('#view-money .view-scroll');
    if (scroll && !_loaded) scroll.innerHTML = '<div style="padding:40px;text-align:center;color:var(--m,#9ca3af);">Loading your books…</div>';
    var data = await fetchData();
    _loaded = true;
    try { render(computePnL(data)); }
    catch (e) { console.warn('[money] render failed', e); if (scroll) scroll.innerHTML = '<div style="padding:40px;text-align:center;color:var(--m,#9ca3af);">Could not load the money dashboard.</div>'; }
  }
  function init() { refreshAndRender(); }

  window.MoneyDashboard = {
    init: init,
    render: render,
    refresh: refreshAndRender,
    computePnL: computePnL, // pure — exported for unit tests
    moveToCollections: moveToCollections, // Collections queue's data-action="module" target
  };
})();
