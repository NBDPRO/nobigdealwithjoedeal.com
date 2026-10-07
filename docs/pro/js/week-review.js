/**
 * week-review.js — the Sunday business review (#/weekreview, 2026-10-04).
 *
 * One CRM page for the last 7 days, owner-only:
 *   1. Cash — collected this week (payments by payment date) and still owed
 *      (the one owed rule, collected-revenue.js).
 *   2. Wins booked this week — job value, labelled PROJECTED.
 *   3. New leads by source, with spend and cost per won job.
 *   4. Win rate this week vs the 4 weeks before (THE close rate,
 *      numbers-logic.js).
 *   5. Stuck deals — the top 3 slow stages and the oldest lead in Contacted.
 *   6. Data gaps, each fixable from here:
 *        costs needed (won jobs with no cost — one tap to add an expense on
 *        that job, or the Home Depot Pro Xtra import), wins with no payment,
 *        wins with no package (pick it here), close dates that are really
 *        the created date (fix here), losses with no reason (bulk), paid
 *        leads with no cost.
 *   7. Reviews & referrals — asks sent, reviews received, referral links
 *      opened, referred leads, referred wins.
 *   8. Lead spend — monthly spend per paid source + Thumbtack CSV import.
 *   9. "One decision to make" — free text, saved per week.
 *
 * Linked from Home and Reports. Does not read or write Jo's personal tracker
 * (the personal bot reads only the tracker). Cost and spend figures are
 * CRM-only and owner-only (firestore.rules owner_numbers).
 *
 * Lazy bundle 'weekreview' (script-loader.js); goTo('weekreview') calls
 * NBDWeekReview.init(). CSP-safe: one delegated listener, classes only.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDWeekReview) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = () => window.NBDNumbers;
  const D = () => window.NBDNumbersData;
  const SCROLL_SEL = '#view-weekreview .view-scroll';

  let _data = null;        // last loaded inputs
  let _review = null;      // last computed review
  let _note = null;        // this week's saved decision
  let _csv = null;         // parsed CSV awaiting save
  let _open = {};          // which gap lists are expanded
  let _loading = false;

  function host() { return document.querySelector(SCROLL_SEL); }
  function leadName(l) {
    return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || l.address || 'Unnamed lead';
  }
  function custLink(l, text) {
    return '<a class="wr-link" href="/pro/customer.html?id=' + encodeURIComponent(l.id) + '">' + esc(text || leadName(l)) + '</a>';
  }
  function money(c) { return N().fmtMoney(c); }
  function stageLabel(k) { return typeof window.stageLabel === 'function' ? window.stageLabel(k) : k; }
  function toast(m, t) { if (typeof window.showToast === 'function') window.showToast(m, t || 'info'); }
  function ymd(ms) { return N().ymd(ms); }

  async function load() {
    const R = window.NBDRevenue;
    const invs = R ? await R.loadInvoices().catch(() => []) : [];
    const d = D();
    const results = await Promise.all([
      d.loadSpend({ force: true }),
      d.loadExpenses(),
      d.loadReviewAsks(),
      d.loadReviews(),
      d.loadClicks(),
    ]);
    const now = Date.now();
    _data = {
      invs: invs || [],
      spend: results[0] || { months: {} },
      expenses: results[1] || [],
      reviewAsks: results[2] || [],
      reviews: results[3] || [],
      clicks: results[4] || {},
      now,
    };
    const wk = N().weekKey(now);
    const note = await d.loadWeekNote(wk);
    _note = note && typeof note.decision === 'string' ? note.decision : '';
  }

  function compute() {
    const R = window.NBDRevenue;
    const leads = window._leads || [];
    const inv = _data.invs;
    const owedCents = R ? inv.reduce((s, i) => s + Math.round(R.owedDollarsOf(i) * 100), 0) : null;
    _review = N().weeklyReview({
      nowMs: _data.now,
      leads,
      labelFn: stageLabel,
      spend: _data.spend,
      collectedBetween: R ? (a, b) => R.collectedBetween(inv, a, b) : null,
      owedCents,
      collectedByLead: R ? R.collectedByLead(inv, null, null) : {},
      expenses: _data.expenses,
      reviewAsks: _data.reviewAsks,
      reviews: _data.reviews,
      clicks: _data.clicks,
    });
    _review.monthly = N().reviewsReferralsByMonth({ leads, reviewAsks: _data.reviewAsks, reviews: _data.reviews, clicks: _data.clicks }).slice(0, 6);
    _review.costs = N().costsNeeded(leads, _data.expenses);
    return _review;
  }

  // ── Render ──────────────────────────────────────────────────────────
  function card(title, body, opts) {
    const o = opts || {};
    return '<section class="wr-card' + (o.cls ? ' ' + o.cls : '') + '"' + (o.id ? ' id="' + o.id + '"' : '') + '>' +
      '<h2 class="wr-h">' + title + '</h2>' + body + '</section>';
  }
  function stat(label, value, sub, cls) {
    return '<div class="wr-stat' + (cls ? ' ' + cls : '') + '"><div class="wr-stat-v">' + value + '</div>' +
      '<div class="wr-stat-l">' + label + '</div>' + (sub ? '<div class="wr-stat-s">' + sub + '</div>' : '') + '</div>';
  }

  function renderGapList(key, title, list, rowFn, extra) {
    const n = list.length;
    const open = !!_open[key];
    return '<div class="wr-gap' + (n ? '' : ' wr-gap-ok') + '" data-gap="' + key + '">' +
      '<button type="button" class="wr-gap-head" data-wr="toggle" data-key="' + key + '" aria-expanded="' + (open ? 'true' : 'false') + '"' + (n ? '' : ' disabled') + '>' +
        '<span class="wr-gap-n">' + n + '</span><span class="wr-gap-t">' + title + '</span>' +
        (n ? '<span class="wr-gap-chev">' + (open ? '▾' : '▸') + '</span>' : '<span class="wr-gap-chev">✓</span>') +
      '</button>' +
      (open && n ? '<div class="wr-gap-body">' + (extra || '') + '<ul class="wr-list">' + list.slice(0, 60).map(rowFn).join('') + '</ul>' +
        (n > 60 ? '<div class="wr-dim">…and ' + (n - 60) + ' more</div>' : '') + '</div>' : '') +
    '</div>';
  }

  function tierSelect(l) {
    const Nn = N();
    return '<select class="wr-sel" data-wr="tier" data-id="' + esc(l.id) + '" aria-label="Sold package for ' + esc(leadName(l)) + '">' +
      '<option value="">Package…</option>' +
      Nn.TIERS.map((t) => '<option value="' + t + '">' + esc(Nn.TIER_LABELS[t]) + '</option>').join('') + '</select>';
  }

  function render() {
    const h = host();
    if (!h) return;
    const Nn = N(), d = D();
    if (!Nn || !d) { h.innerHTML = '<div class="wr-empty">The numbers modules did not load — refresh the page.</div>'; return; }
    if (!d.isOwner()) {
      h.innerHTML = '<div class="wr-page"><div class="wr-empty">The Sunday review is for the account owner — it shows spend and cost figures.</div></div>';
      return;
    }
    if (!_review) { h.innerHTML = '<div class="wr-page"><div class="wr-empty">Loading the week…</div></div>'; return; }
    const r = _review;
    const start = new Date(r.start), end = new Date(r.end);
    const fmtD = (x) => x.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    // 1–2: cash + wins
    const money1 = card('💵 Money this week',
      '<div class="wr-stats">' +
        stat('Collected', r.cash ? money(r.cash.collectedCents) : '…', r.cash ? r.cash.payments + ' payment' + (r.cash.payments === 1 ? '' : 's') : '', 'wr-good') +
        stat('Still owed', r.owedCents == null ? '…' : money(r.owedCents), 'sent invoices not paid') +
        stat('Wins booked', String(r.bookedWins.count), money(r.bookedWins.bookedCents) + ' <span class="wr-proj">projected</span>') +
      '</div>' +
      (r.bookedWins.count ? '<ul class="wr-list wr-list-tight">' + r.bookedWins.leads.map((l) =>
        '<li>' + custLink(l) + ' <span class="wr-dim">' + money(Nn.bookedCents(l)) + ' projected</span></li>').join('') + '</ul>' : ''));

    // 3: new leads by source
    const src = r.newLeads.bySource;
    const leadsCard = card('🧲 New leads: ' + r.newLeads.count,
      src.length
        ? '<div class="wr-table-wrap"><table class="wr-table"><thead><tr><th>Source</th><th>Leads</th><th>Spend</th><th>Cost / job won</th></tr></thead><tbody>' +
          src.map((s) => '<tr><td>' + esc(s.source) + '</td><td class="wr-num">' + s.leads + '</td><td class="wr-num">' + (s.spendCents ? money(s.spendCents) : '—') + '</td>' +
            '<td class="wr-num">' + (s.costPerWonCents == null ? '—' : money(s.costPerWonCents)) + '</td></tr>').join('') +
          '</tbody></table></div><div class="wr-dim wr-small">Spend this week: each lead’s own cost, else the month’s spend ÷ that month’s leads. Cost / job won is all-time.</div>'
        : '<div class="wr-dim">No new leads in the last 7 days.</div>');

    // 4: win rate
    const wk = r.winRate.week, p4 = r.winRate.prior4;
    let trend = '';
    if (wk.rate != null && p4.rate != null) {
      const diff = Math.round((wk.rate - p4.rate) * 100);
      trend = diff === 0 ? 'same as' : (diff > 0 ? '▲ ' + diff + ' pts above' : '▼ ' + Math.abs(diff) + ' pts below');
      trend += ' the 4-week average';
    }
    const rateCard = card('🎯 Win rate',
      '<div class="wr-stats">' +
        stat('This week', esc(Nn.fmtRate(wk)), wk.decided ? wk.won + ' won / ' + wk.decided + ' decided' : 'nothing won or lost') +
        stat('4 weeks before', esc(Nn.fmtRate(p4)), p4.decided ? p4.won + ' won / ' + p4.decided + ' decided' : 'no data') +
      '</div>' + (trend ? '<div class="wr-trend">' + esc(trend) + '</div>' : '') +
      '<div class="wr-dim wr-small">Won ÷ (won + lost). A signed contract counts as won.</div>');

    // 5: stuck
    const st = r.stuck;
    const stuckCard = card('🧱 Stuck deals',
      (st.bottlenecks.length
        ? '<ol class="wr-list">' + st.bottlenecks.map((b) => '<li><strong>' + esc(b.label) + '</strong> — ' + b.count + ' leads, ' + b.avgDays + ' days on average' +
            (b.oldest ? ' <span class="wr-dim">(oldest: ' + custLink(b.oldest.lead) + ', ' + b.oldest.days + ' d)</span>' : '') + '</li>').join('') + '</ol>'
        : '<div class="wr-dim">No stage has two or more deals waiting.</div>') +
      (st.oldestContacted ? '<div class="wr-callout">Oldest in Contacted: ' + custLink(st.oldestContacted.lead) + ' — ' + st.oldestContacted.days + ' days</div>' : ''));

    // 6: data gaps
    const g = r.gaps;
    const c = r.costs;
    const costsExtra = '<div class="wr-gap-actions"><span class="wr-dim">Costed ' + c.costed + ' of ' + c.total + ' won jobs.</span> ' +
      '<button type="button" class="wr-btn wr-btn-ghost" data-wr="hd-import">🧡 Import Home Depot</button></div>';
    const gaps = card('🕳️ Data gaps',
      '<div class="wr-dim wr-small">Costed ' + c.costed + ' of ' + c.total + ' won jobs · ' + (c.total - g.noPayment.length) + ' of ' + c.total + ' with a payment recorded.</div>' +
      // One card at a time on the phone (catchup.js, 2026-10-04).
      '<div class="wr-row-end"><button type="button" class="wr-btn wr-btn-primary" id="wrCatchUpBtn" data-action="goTo" data-target="catchup">📋 Catch up my numbers — one job at a time</button></div>' +
      renderGapList('cost', 'Won jobs with no costs (sub invoice, materials, receipts)', g.noCost, (l) =>
        '<li class="wr-row">' + custLink(l) + '<span class="wr-dim">' + money(Nn.bookedCents(l)) + '</span>' +
        '<button type="button" class="wr-btn" data-wr="add-cost" data-id="' + esc(l.id) + '">+ Add cost</button></li>', costsExtra) +
      renderGapList('pay', 'Wins with no payment recorded', g.noPayment, (l) =>
        '<li class="wr-row">' + custLink(l) + '<span class="wr-dim">' + money(Nn.bookedCents(l)) + ' booked</span></li>') +
      renderGapList('pkg', 'Wins with no package', g.noPackage, (l) =>
        '<li class="wr-row">' + custLink(l) + tierSelect(l) + '</li>') +
      renderGapList('close', 'Wins whose close date is really the created date', g.closeDates, (l) =>
        '<li class="wr-row">' + custLink(l) +
        '<input type="date" class="wr-date" data-wr="close-date" data-id="' + esc(l.id) + '" aria-label="Close date for ' + esc(leadName(l)) + '"' +
          (Nn.toMs(l.closedAt) ? ' value="' + ymd(Nn.toMs(l.closedAt)) + '"' : '') + ' max="' + ymd(Date.now()) + '">' +
        '<button type="button" class="wr-btn" data-wr="save-close" data-id="' + esc(l.id) + '">Save</button></li>') +
      renderGapList('lost', 'Losses with no reason', g.lostNoReason, (l) =>
        '<li class="wr-row"><label class="wr-check"><input type="checkbox" data-wr="lost-pick" data-id="' + esc(l.id) + '"> ' + esc(leadName(l)) + '</label>' +
        '<span class="wr-dim">' + esc(Nn.normalizeSource(l.source)) + '</span></li>',
        '<div class="wr-bulk"><select class="wr-sel" id="wrLostReason" aria-label="Reason for the checked losses"><option value="">Reason…</option>' +
          Nn.LOST_REASONS.map((x) => '<option value="' + x.key + '">' + esc(x.label) + '</option>').join('') + '</select>' +
          '<input type="text" class="wr-input" id="wrLostNote" maxlength="300" placeholder="Note (needed for Other)">' +
          '<button type="button" class="wr-btn" data-wr="lost-all">Check all</button>' +
          '<button type="button" class="wr-btn wr-btn-primary" data-wr="lost-apply">Set reason on checked</button></div>') +
      renderGapList('paidcost', 'Paid-source leads with no cost (and no monthly spend entered)', g.paidNoCost, (l) =>
        '<li class="wr-row">' + custLink(l) + '<span class="wr-dim">' + esc(Nn.normalizeSource(l.source)) + ' · ' + esc(Nn.monthKey(Nn.toMs(l.createdAt) || Date.now())) + '</span></li>',
        '<div class="wr-dim wr-small">Enter the month’s spend below and these are covered: cost per lead = spend ÷ that month’s leads.</div>'),
      { id: 'wrGaps' });

    // 7: reviews & referrals
    const rr = r.reviewsReferrals;
    const months = r.monthly;
    const rrCard = card('⭐ Reviews & referrals',
      '<div class="wr-stats">' +
        stat('Review asks', String(rr.asks), 'this week') +
        stat('Reviews', String(rr.reviews), 'on Google, this week') +
        stat('Referred leads', String(rr.referredLeads), rr.referredWins + ' referred win' + (rr.referredWins === 1 ? '' : 's')) +
        stat('Link opens', String(rr.clicksThisMonth), 'referral links, this month') +
      '</div>' +
      (months.length ? '<div class="wr-table-wrap"><table class="wr-table"><thead><tr><th>Month</th><th>Asks</th><th>Reviews</th><th>Link opens</th><th>Referred</th><th>Ref. wins</th></tr></thead><tbody>' +
        months.map((m) => '<tr><td>' + esc(m.month) + '</td><td class="wr-num">' + m.asks + '</td><td class="wr-num">' + m.reviews + '</td><td class="wr-num">' + m.clicks + '</td><td class="wr-num">' + m.referredLeads + '</td><td class="wr-num">' + m.referredWins + '</td></tr>').join('') +
        '</tbody></table></div>' : '') +
      '<div class="wr-dim wr-small">Reviews come from the Google reviews feed (only the newest few until the Business Profile sync is approved).</div>');

    // 8: spend
    const spendCard = card('💸 Lead spend', renderSpend(), { id: 'wrSpend' });

    // 9: one decision
    const decide = card('🧭 One decision to make this week',
      '<textarea class="wr-note" id="wrDecision" rows="3" maxlength="2000" placeholder="The one call this week’s numbers point to…">' + esc(_note || '') + '</textarea>' +
      '<div class="wr-row-end"><span class="wr-dim" id="wrDecisionState"></span><button type="button" class="wr-btn wr-btn-primary" data-wr="save-decision">Save</button></div>');

    h.innerHTML =
      '<div class="wr-page">' +
        '<div class="wr-top"><div><div class="wr-title">Sunday review</div>' +
          '<div class="wr-sub">' + esc(fmtD(start)) + ' – ' + esc(fmtD(end)) + ' · last 7 days</div></div>' +
          '<button type="button" class="wr-btn wr-btn-ghost" data-wr="refresh">↻ Refresh</button></div>' +
        money1 + rateCard + leadsCard + stuckCard + gaps + rrCard + spendCard + decide +
      '</div>';
  }

  function monthOptions() {
    const out = [];
    const d = new Date(); d.setDate(1);
    for (let i = 0; i < 12; i++) {
      out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }
  function renderSpend() {
    const Nn = N();
    const months = (_data && _data.spend && _data.spend.months) || {};
    const ms = monthOptions().slice(0, 3);
    const sources = Nn.PAID_SOURCES.slice();
    // Any other source that already has spend entered.
    Object.keys(months).forEach((m) => Object.keys(months[m] || {}).forEach((k) => {
      if (!sources.some((s) => Nn.spendKey(s) === k)) sources.push(k);
    }));
    const head = '<tr><th>Source</th>' + ms.map((m) => '<th>' + esc(m) + '</th>').join('') + '</tr>';
    const rows = sources.map((s) => {
      const k = Nn.spendKey(s);
      return '<tr><td>' + esc(Nn.normalizeSource(s)) + '</td>' + ms.map((m) => {
        const c = Number((months[m] || {})[k]) || 0;
        return '<td><input type="number" inputmode="decimal" min="0" step="0.01" class="wr-money" data-wr="spend" data-month="' + m + '" data-key="' + esc(k) + '"' +
          ' aria-label="' + esc(Nn.normalizeSource(s)) + ' spend ' + m + '" value="' + (c ? (c / 100).toFixed(2) : '') + '" placeholder="$0"></td>';
      }).join('') + '</tr>';
    }).join('');
    const csv = _csv
      ? '<div class="wr-csv-preview"><strong>' + esc(_csv.sourceLabel) + '</strong> — ' + _csv.rows.length + ' charges' + (_csv.skipped ? ', ' + _csv.skipped + ' rows skipped' : '') + ':<ul class="wr-list wr-list-tight">' +
          Object.keys(_csv.byMonth).sort().reverse().map((m) => '<li>' + esc(m) + ': ' + money(_csv.byMonth[m]) + '</li>').join('') + '</ul>' +
          '<div class="wr-row-end"><button type="button" class="wr-btn wr-btn-ghost" data-wr="csv-cancel">Cancel</button>' +
          '<button type="button" class="wr-btn wr-btn-primary" data-wr="csv-save">Save these months</button></div></div>'
      : '';
    return '<div class="wr-dim wr-small">Monthly spend per paid source. When a lead has no price of its own, its cost is that month’s spend ÷ that month’s leads from the source. Owner-only.</div>' +
      '<div class="wr-table-wrap"><table class="wr-table wr-spend">' + head + rows + '</table></div>' +
      '<div class="wr-csv"><label class="wr-dim" for="wrCsvFile">Import a billing CSV (Thumbtack: Billing › Download) — date + amount columns:</label>' +
        '<div class="wr-row-end"><select class="wr-sel" id="wrCsvSource" aria-label="Source the CSV is for">' +
          sources.map((s) => '<option value="' + esc(Nn.spendKey(s)) + '">' + esc(Nn.normalizeSource(s)) + '</option>').join('') + '</select>' +
          '<input type="file" id="wrCsvFile" accept=".csv,text/csv" class="wr-file"></div></div>' + csv;
  }

  // ── Actions ─────────────────────────────────────────────────────────
  function leadById(id) { return (window._leads || []).find((l) => l && l.id === id) || null; }
  function canWrite() { return !(window.NBDRole && !window.NBDRole.guard()); }

  async function writeLead(id, patch) {
    if (!canWrite() || !window.updateDoc || !window.doc) return false;
    try {
      await window.updateDoc(window.doc(window.db || window._db, 'leads', id), Object.assign({}, patch, { updatedAt: window.serverTimestamp() }));
      const l = leadById(id); if (l) Object.assign(l, patch);
      return true;
    } catch (e) {
      toast('Could not save: ' + ((e && (e.code || e.message)) || 'error'), 'error');
      return false;
    }
  }

  async function onClick(e) {
    const b = e.target.closest ? e.target.closest('[data-wr]') : null;
    if (!b || !b.closest(SCROLL_SEL)) return;
    const a = b.dataset.wr;
    if (a === 'toggle') { _open[b.dataset.key] = !_open[b.dataset.key]; render(); return; }
    if (a === 'refresh') { refresh(); return; }
    if (a === 'add-cost') {
      const id = b.dataset.id;
      try { if (window.ScriptLoader) await window.ScriptLoader.loadBundle('expenses'); } catch (_) { /* fall through */ }
      if (window.Expenses && typeof window.Expenses.openForm === 'function') window.Expenses.openForm({ leadId: id, category: 'materials' });
      else toast('Expenses did not load — open Expenses and try again', 'error');
      return;
    }
    if (a === 'hd-import') {
      try { if (window.ScriptLoader) await window.ScriptLoader.loadBundle('expenses'); } catch (_) { /* fall through */ }
      if (window.NBDHdImport && typeof window.NBDHdImport.open === 'function') window.NBDHdImport.open();
      else toast('The Home Depot import did not load — open Expenses and try again', 'error');
      return;
    }
    if (a === 'save-close') {
      const id = b.dataset.id;
      const inp = b.parentNode.querySelector('[data-wr="close-date"]');
      const v = inp && inp.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) { toast('Pick the date the contract was signed', 'error'); return; }
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const at = new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
      if (at.getTime() > Date.now()) { toast('A close date cannot be in the future', 'error'); return; }
      if (await writeLead(id, { closedAt: at, closedAtSource: 'manual' })) { toast('Close date saved ✓', 'success'); recompute(); }
      return;
    }
    if (a === 'lost-all') {
      Array.prototype.forEach.call(host().querySelectorAll('[data-wr="lost-pick"]'), (x) => { x.checked = true; });
      return;
    }
    if (a === 'lost-apply') {
      const Nn = N();
      const key = (document.getElementById('wrLostReason') || {}).value || '';
      const note = ((document.getElementById('wrLostNote') || {}).value || '').trim();
      const problem = Nn.validateLostReason({ key, note });
      if (problem) { toast(problem, 'error'); return; }
      const ids = Array.prototype.filter.call(host().querySelectorAll('[data-wr="lost-pick"]'), (x) => x.checked).map((x) => x.dataset.id);
      if (!ids.length) { toast('Check the losses to set', 'error'); return; }
      const fields = Nn.lostReasonFields({ key, note });
      let n = 0;
      for (const id of ids) { if (await writeLead(id, fields)) n++; }
      toast('Reason set on ' + n + ' loss' + (n === 1 ? '' : 'es'), 'success');
      recompute();
      return;
    }
    if (a === 'save-decision') {
      const t = (document.getElementById('wrDecision') || {}).value || '';
      const ok = await D().saveWeekNote(_review.weekKey, t);
      const s = document.getElementById('wrDecisionState');
      if (ok) { _note = t; if (s) s.textContent = 'Saved for the week of ' + _review.weekKey; toast('Saved ✓', 'success'); }
      else toast('Could not save the note', 'error');
      return;
    }
    if (a === 'csv-cancel') { _csv = null; render(); return; }
    if (a === 'csv-save') {
      if (!_csv) return;
      const ok = await D().mergeSpendMonths(_csv.byMonth, _csv.key);
      if (ok) { toast('Spend saved for ' + Object.keys(_csv.byMonth).length + ' month(s)', 'success'); _csv = null; await refresh(); }
      else toast('Could not save the spend', 'error');
    }
  }

  async function onChange(e) {
    const t = e.target;
    if (!t || !t.closest || !t.closest(SCROLL_SEL)) return;
    const a = t.dataset && t.dataset.wr;
    if (a === 'tier') {
      const id = t.dataset.id, tier = t.value;
      if (!tier) return;
      if (await writeLead(id, { soldTier: tier, soldTierSource: 'manual', soldTierAt: new Date() })) {
        toast('Package saved ✓', 'success');
        recompute();
      }
      return;
    }
    if (a === 'spend') {
      const cents = N().dollarsToCents(t.value);
      const ok = await D().saveSpendMonth(t.dataset.month, t.dataset.key, cents);
      if (ok) {
        const m = _data.spend.months[t.dataset.month] = _data.spend.months[t.dataset.month] || {};
        m[t.dataset.key] = cents;
        toast('Spend saved ✓', 'success');
        recompute();
      } else toast('Could not save the spend', 'error');
      return;
    }
    if (t.id === 'wrCsvFile' && t.files && t.files[0]) {
      const f = t.files[0];
      if (f.size > 2 * 1024 * 1024) { toast('That file is over 2 MB — is it the billing CSV?', 'error'); return; }
      const text = await f.text();
      const parsed = N().parseSpendCsv(text);
      if (parsed.error) { toast(parsed.error, 'error'); return; }
      const sel = document.getElementById('wrCsvSource');
      const key = sel ? sel.value : 'thumbtack';
      const label = sel && sel.selectedOptions && sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : key;
      _csv = { key, sourceLabel: label, rows: parsed.rows, byMonth: parsed.byMonth, skipped: parsed.skipped };
      render();
    }
  }

  function recompute() { if (_data) { compute(); render(); } }

  async function refresh() {
    if (_loading) return;
    _loading = true;
    try {
      if (!D() || !D().isOwner()) { _review = null; render(); return; }
      await load();
      compute();
    } catch (e) {
      console.warn('[weekreview] load failed', e);
    } finally {
      _loading = false;
    }
    render();
  }

  let _wired = false;
  function init() {
    if (!_wired) {
      _wired = true;
      document.addEventListener('click', onClick);
      document.addEventListener('change', onChange);
      window.addEventListener('nbd:expenses-changed', () => { if (host() && _data) refresh(); });
      window.addEventListener('nbd:data-refreshed', (e) => {
        const src = e && e.detail && e.detail.source;
        if ((!src || src === 'leads') && host() && document.getElementById('view-weekreview') && document.getElementById('view-weekreview').classList.contains('active') && _data) recompute();
      });
    }
    render();
    refresh();
  }

  window.NBDWeekReview = { init, refresh, _render: render, _state: () => ({ review: _review, data: _data }) };
})();
