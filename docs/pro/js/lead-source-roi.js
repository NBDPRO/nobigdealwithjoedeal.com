/**
 * NBD Pro — Lead-source table (Reports → "Lead Sources").
 *
 * One row per source (2026-10-04, "knowing your numbers"):
 *   Leads · Won % · Booked (PROJECTED) · Collected · Spend · Cost per job won
 *   · Booked per $1 spent
 * Sorted by collected money, then booked.
 *
 * Every figure comes from numbers-logic.js (window.NBDNumbers):
 *   - Won % is THE close rate — won ÷ (won + lost), won = won / in production
 *     / Contract Signed. Same function as the Home KPI card and Reports.
 *     A source with nothing decided shows "—", not 0%.
 *   - Collected = invoice payments (collected-revenue.js), Jo 2026-09-28:
 *     revenue is collected only. Booked is jobValue and is labelled projected.
 *   - Spend = the owner's monthly spend for the source (numbers-data.js,
 *     owner-only) where entered, else the per-lead leadCost Thumbtack sends;
 *     for a source with neither, marketing expenses logged against it. Spend,
 *     cost per job and booked-per-dollar are owner-only cost figures: anyone
 *     else sees the table without those columns.
 *   - "Website — Cal.com booking" and every other site funnel fold into
 *     Website (normalizeSource).
 *
 * compute() keeps the old field names (total / closed / collectedRev /
 * bookedRev / conversionRate / avgDealSize, in dollars) beside the new ones.
 *
 * IIFE exposed as window.LeadSourceROI.
 */
(function() {
  'use strict';

  function N() { return window.NBDNumbers || null; }

  // ────────────────────────────────────────────────────────────────────
  // Aggregation
  // ────────────────────────────────────────────────────────────────────
  // Every JOB of these customers (jobs-store.js recordsFor): won / booked
  // count a repeat customer's second sale too (review R6-2-13); leads and
  // collected stay per customer. The leads as-is before jobs load.
  function jobRecs(leads) {
    const J = window.NBDJobs;
    return J && typeof J.recordsFor === 'function' ? J.recordsFor(leads || []) : null;
  }
  function computeMetrics(leads, collectedByLead, spend, marketingByKey, jobRecords) {
    const Nn = N();
    if (!Nn) return { rows: [], totals: { total: 0, closed: 0, lost: 0, collectedRev: 0, conversionRate: null }, bestByRevenue: null, bestByConversion: null };
    const t = Nn.sourceTable(leads || [], { collectedByLead: collectedByLead || {}, spend: spend || null, jobRecords: jobRecords || null });
    const mk = marketingByKey || {};
    const adapt = (r) => {
      // Marketing expenses fill in only for a source with no spend at all.
      let spendCents = r.spendCents;
      let spendBasis = spendCents > 0 ? 'spend' : 'none';
      const fromExp = mk[Nn.spendKey(r.source)] || 0;
      if (!(spendCents > 0) && fromExp > 0) { spendCents = fromExp; spendBasis = 'expenses'; }
      const costPerWonCents = (spendCents > 0 && r.won > 0) ? Math.round(spendCents / r.won) : null;
      const bookedPerDollar = spendCents > 0 ? r.bookedCents / spendCents : null;
      return Object.assign({}, r, {
        spendCents, spendBasis, costPerWonCents, bookedPerDollar,
        // legacy names (dollars)
        total: r.leads, closed: r.won,
        collectedRev: r.collectedCents / 100,
        bookedRev: r.bookedCents / 100,
        conversionRate: r.winRate == null ? null : Math.round(r.winRate * 100),
        avgDealSize: r.won ? Math.round(r.bookedCents / 100 / r.won) : 0,
        leadCost: spendCents / 100,
      });
    };
    const rows = t.rows.map(adapt);
    const tot = adapt(t.totals);
    // Totals' spend = the sum of the rows' (so expense fill-ins count too).
    tot.spendCents = rows.reduce((s, r) => s + (r.spendCents || 0), 0);
    tot.costPerWonCents = (tot.spendCents > 0 && tot.won > 0) ? Math.round(tot.spendCents / tot.won) : null;
    tot.bookedPerDollar = tot.spendCents > 0 ? tot.bookedCents / tot.spendCents : null;
    return {
      rows,
      totals: tot,
      bestByRevenue: rows[0] || null,
      bestByConversion: rows.filter(r => (r.won + r.lost) >= 3 && r.winRate != null)
                            .sort((a, b) => b.winRate - a.winRate)[0] || null,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Marketing expenses by source (cents) — the fallback spend for a source
  // with no monthly spend and no per-lead cost. null = not fetched yet.
  let _marketingByKey = null;
  let _spend = null;
  let _targetId = null;
  let _fetching = false;

  async function _fetchMarketing() {
    const db = window.db || window._db;
    const uid = window._user && window._user.uid;
    const out = {};
    if (!db || !uid || !window.getDocs || !window.query || !window.where || !window.collection || !N()) return out;
    try {
      const snap = await window.getDocs(window.query(
        window.collection(db, 'expenses'), window.where('userId', '==', uid)));
      snap.docs.forEach(function (d) {
        const e = d.data();
        if (!e || e.category !== 'marketing') return;
        const c = parseInt(e.amountCents, 10) || 0;
        const k = N().spendKey(e.marketingSource);
        if (k && c > 0) out[k] = (out[k] || 0) + c;
      });
    } catch (e) { /* no expenses → no fallback */ }
    return out;
  }

  function _ownerSees() {
    const D = window.NBDNumbersData;
    return !!(D && D.isOwner());
  }

  function render(targetId) {
    const el = document.getElementById(targetId);
    if (!el) return;
    _targetId = targetId;
    const Nn = N();
    if (!Nn) { el.innerHTML = '<div class="empty">The numbers module did not load — refresh the page.</div>'; return; }
    const leads = window._leads || [];
    const _R = window.NBDRevenue, _invs = _R ? _R.cached() : null;
    if (_R && !_invs) _R.loadInvoices().then(function () { if (_R.cached() && document.getElementById(targetId)) render(targetId); });
    const owner = _ownerSees();
    if (owner && (_spend === null || _marketingByKey === null) && !_fetching) {
      _fetching = true;
      Promise.all([
        window.NBDNumbersData.loadSpend(),
        _fetchMarketing(),
      ]).then(function (r) {
        _spend = r[0] || { months: {} };
        _marketingByKey = r[1] || {};
      }).catch(function () { _spend = { months: {} }; _marketingByKey = {}; })
        .then(function () { _fetching = false; if (_targetId && document.getElementById(_targetId)) render(_targetId); });
    }
    const m = computeMetrics(leads, _invs ? _R.collectedByLead(_invs, null, null) : {}, owner ? _spend : null, owner ? _marketingByKey : null, jobRecs(leads));

    if (m.totals.total === 0) {
      el.innerHTML =
        '<div class="lsroi-empty">' +
          '<div class="lsroi-empty-icon">📊</div>' +
          '<div class="lsroi-empty-title">No leads yet</div>' +
          '<div class="lsroi-empty-sub">Once leads come in, this shows what each source books and collects.</div>' +
        '</div>';
      return;
    }

    const money = (c) => Nn.fmtMoney(c);
    const perDollar = (v) => v == null ? '—' : '$' + (Math.round(v * 100) / 100).toFixed(2);
    const T = m.totals;
    const tot = (label, val, cls) =>
      '<div class="lsroi-tot"><div class="lsroi-tot-label">' + label + '</div>' +
      '<div class="lsroi-tot-val' + (cls ? ' ' + cls : '') + '">' + val + '</div></div>';
    const totalsBar =
      '<div class="lsroi-totals">' +
        tot('Leads', String(T.total)) +
        tot('Won %', escHtml(Nn.fmtRate(T.winRate)), 'nb-green') +
        tot('Booked <span class="nb-dim">(projected)</span>', money(T.bookedCents)) +
        tot('Collected', _invs ? money(T.collectedCents) : '…', 'nb-green') +
        (owner
          ? tot('Spend', _spend === null ? '…' : money(T.spendCents), 'nb-red') +
            tot('Cost / job won', T.costPerWonCents == null ? '—' : money(T.costPerWonCents))
          : '') +
      '</div>';

    const callouts = [];
    if (m.bestByRevenue && m.bestByRevenue.collectedCents > 0) {
      callouts.push(
        '<div class="lsroi-callout"><span class="lsroi-callout-icon">🏆</span><div>' +
          '<div class="lsroi-callout-label">Most money collected</div>' +
          '<div class="lsroi-callout-value">' + escHtml(m.bestByRevenue.source) + ' — ' + money(m.bestByRevenue.collectedCents) + ' collected</div>' +
        '</div></div>');
    }
    if (m.bestByConversion && (!m.bestByRevenue || m.bestByConversion.source !== m.bestByRevenue.source)) {
      callouts.push(
        '<div class="lsroi-callout"><span class="lsroi-callout-icon">🎯</span><div>' +
          '<div class="lsroi-callout-label">Best win rate (3+ decided)</div>' +
          '<div class="lsroi-callout-value">' + escHtml(m.bestByConversion.source) + ' — ' + escHtml(Nn.fmtRate(m.bestByConversion.winRate)) + '</div>' +
        '</div></div>');
    }
    const calloutsHtml = callouts.length ? '<div class="lsroi-callouts">' + callouts.join('') + '</div>' : '';

    const tableRows = m.rows.map(r =>
      '<tr>' +
        '<td class="lsroi-source">' + escHtml(r.source) + (r.spendBasis === 'expenses' ? '<div class="nb-dim nb-xs">spend from marketing expenses</div>' : '') + '</td>' +
        '<td class="lsroi-num">' + r.leads + '</td>' +
        '<td class="lsroi-num lsroi-rate">' + escHtml(Nn.fmtRate(r.winRate)) + '<div class="nb-dim nb-xs">' + r.won + '/' + (r.won + r.lost) + '</div></td>' +
        '<td class="lsroi-num">' + money(r.bookedCents) + '</td>' +
        '<td class="lsroi-num lsroi-rev">' + (_invs ? money(r.collectedCents) : '…') + '</td>' +
        (owner
          ? '<td class="lsroi-num">' + (r.spendCents > 0 ? money(r.spendCents) : '—') + '</td>' +
            '<td class="lsroi-num">' + (r.costPerWonCents == null ? '—' : money(r.costPerWonCents)) + '</td>' +
            '<td class="lsroi-num">' + perDollar(r.bookedPerDollar) + '</td>'
          : '') +
      '</tr>').join('');

    el.innerHTML =
      totalsBar + calloutsHtml +
      '<div class="lsroi-table-wrap">' +
        '<table class="lsroi-table lsroi-v2">' +
          '<thead><tr>' +
            '<th>Source</th><th>Leads</th><th>Won %</th>' +
            '<th>Booked <span class="nb-dim">(projected)</span></th><th>Collected</th>' +
            (owner ? '<th>Spend</th><th>Cost / job won</th><th>Booked per $1</th>' : '') +
          '</tr></thead>' +
          '<tbody>' + tableRows + '</tbody>' +
        '</table>' +
      '</div>' +
      '<div class="nb-foot">Won % = won ÷ (won + lost); a signed contract counts as won. Booked is job value — projected, not money in hand.' +
        (owner ? ' Spend: your monthly spend per source where entered (Sunday review → Lead spend), else each lead’s own cost.' : '') + '</div>';
  }

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────
  const LeadSourceROI = {
    render,
    compute: (spend) => {
      const R = window.NBDRevenue, invs = R ? R.cached() : null;
      return computeMetrics(window._leads || [], invs ? R.collectedByLead(invs, null, null) : {}, spend || null, null, jobRecs(window._leads || []));
    },
    computeMetrics,
    init(targetId) {
      this._targetId = targetId;
      render(targetId);
      // Live-update on lead changes; spend is re-read too (it may have been
      // edited on the Sunday review).
      document.addEventListener('leadsChanged', () => { _spend = null; _marketingByKey = null; render(targetId); });
    }
  };

  window.LeadSourceROI = LeadSourceROI;
})();
