/**
 * reports-numbers.js — three Reports panels (2026-10-04, "knowing your
 * numbers"), all computed by numbers-logic.js off the live lead cache:
 *
 *   - What sells: package mix + average ticket per package (sold soldTier;
 *     ticket = job value, PROJECTED).
 *   - Why we lose: losses by reason, and by source × reason.
 *   - Results per storm: leads, wins and booked $ (projected) per stormId.
 *
 * Plus a link to the Sunday review. Mounts into #reportsNumbersPanel
 * (dashboard.html tpl-view-reports); goTo('reports') calls render().
 * No money here is "revenue" — booked figures say projected.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.NBDReportsNumbers) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function render() {
    const host = document.getElementById('reportsNumbersPanel');
    const N = window.NBDNumbers;
    if (!host || !N) return;
    const leads = window._leads || [];
    const money = (c) => N.fmtMoney(c);

    const mix = N.packageMix(leads);
    const mixHtml = mix.sales
      ? '<div class="wr-table-wrap"><table class="wr-table"><thead><tr><th>Package</th><th>Jobs</th><th>Share</th><th>Avg ticket <span class="nb-dim">(projected)</span></th></tr></thead><tbody>' +
          mix.rows.map((r) => '<tr><td>' + esc(r.label) + '</td><td class="wr-num">' + r.count + '</td><td class="wr-num">' + Math.round(r.count / mix.sales * 100) + '%</td>' +
            '<td class="wr-num">' + (r.avgTicketCents == null ? '—' : money(r.avgTicketCents)) + '</td></tr>').join('') +
          (mix.unknown ? '<tr class="wr-muted"><td>Not recorded</td><td class="wr-num">' + mix.unknown + '</td><td class="wr-num">' + Math.round(mix.unknown / mix.sales * 100) + '%</td><td></td></tr>' : '') +
        '</tbody></table></div>' +
        (mix.unknown ? '<div class="wr-dim wr-small">' + mix.unknown + ' of ' + mix.sales + ' wins have no package yet — pick it on the customer page or in the Sunday review.</div>' : '')
      : '<div class="wr-dim">No wins yet.</div>';

    const L = N.lossesByReason(leads);
    const reasons = N.LOST_REASONS.map((r) => r.key).concat(['unknown']);
    const label = (k) => k === 'unknown' ? 'No reason' : N.lostReasonLabel(k);
    const srcs = Object.keys(L.bySource).sort((a, b) => {
      const sa = Object.keys(L.bySource[a]).reduce((s, k) => s + L.bySource[a][k], 0);
      const sb = Object.keys(L.bySource[b]).reduce((s, k) => s + L.bySource[b][k], 0);
      return sb - sa;
    });
    const usedReasons = reasons.filter((k) => L.byReason[k]);
    const lossHtml = L.total
      ? '<ul class="nb-bars">' + usedReasons.map((k) => {
          const n = L.byReason[k]; const pct = Math.round(n / L.total * 100);
          return '<li><span class="nb-bar-l">' + esc(label(k)) + '</span><span class="nb-bar"><span class="nb-bar-f nb-w' + Math.min(100, Math.max(2, Math.round(pct / 2) * 2)) + '"></span></span><span class="nb-bar-n">' + n + ' · ' + pct + '%</span></li>';
        }).join('') + '</ul>' +
        '<div class="wr-table-wrap"><table class="wr-table"><thead><tr><th>Source</th>' + usedReasons.map((k) => '<th>' + esc(label(k)) + '</th>').join('') + '</tr></thead><tbody>' +
          srcs.map((s) => '<tr><td>' + esc(s) + '</td>' + usedReasons.map((k) => '<td class="wr-num">' + (L.bySource[s][k] || '') + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>' +
        (L.missing ? '<div class="wr-dim wr-small">' + L.missing + ' of ' + L.total + ' losses have no reason — set them in bulk on the Sunday review.</div>' : '')
      : '<div class="wr-dim">No losses recorded.</div>';

    const storms = N.stormResults(leads);
    const stormHtml = storms.length
      ? '<div class="wr-table-wrap"><table class="wr-table"><thead><tr><th>Storm</th><th>Leads</th><th>Won</th><th>Booked <span class="nb-dim">(projected)</span></th></tr></thead><tbody>' +
          storms.map((s) => '<tr><td>' + esc(s.date) + (s.place ? ' <span class="wr-dim">' + esc(s.place) + '</span>' : '') + '</td><td class="wr-num">' + s.leads + '</td><td class="wr-num">' + s.won + '</td><td class="wr-num">' + money(s.bookedCents) + '</td></tr>').join('') +
        '</tbody></table></div>'
      : '<div class="wr-dim">No leads tagged to a storm yet. New leads within 14 days and 10 miles of a stored storm report are tagged automatically; accepting a storm-report date of loss tags one too.</div>';

    host.innerHTML =
      '<div class="rn-top"><div><div class="panel-label">Knowing your numbers</div><div class="panel-title">What sells, why we lose, what storms bring</div></div>' +
        '<button type="button" class="wr-btn wr-btn-primary" data-action="goTo" data-target="weekreview">🗓️ Sunday review</button></div>' +
      '<div class="rn-grid">' +
        '<section class="wr-card"><h2 class="wr-h">📦 Package mix</h2>' + mixHtml + '</section>' +
        '<section class="wr-card"><h2 class="wr-h">❌ Losses by reason</h2>' + lossHtml + '</section>' +
        '<section class="wr-card"><h2 class="wr-h">⛈️ Results per storm</h2>' + stormHtml + '</section>' +
      '</div>';
  }

  window.addEventListener('nbd:data-refreshed', () => {
    const v = document.getElementById('view-reports');
    if (v && v.classList.contains('active')) { try { render(); } catch (_) { /* next refresh */ } }
  });

  window.NBDReportsNumbers = { render };
})();
