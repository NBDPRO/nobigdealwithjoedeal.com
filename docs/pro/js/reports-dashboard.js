/**
 * reports-dashboard.js — Wave 153 (Reports view dashboard panel)
 *
 * Adds a KPI tile row + conversion funnel + period comparison
 * panel to the top of the Reports view. Reuses the existing
 * analytics-kpi.js engine for the underlying compute, but adds
 * period-over-period delta logic the existing engine didn't
 * expose.
 *
 * Sections rendered:
 *   1. KPI tiles (this period) with delta arrows vs last period
 *   2. Conversion funnel (Leads → Inspected → Estimate Sent →
 *      Viewed → Signed)
 *   3. Period selector (7d / 30d / 90d / YTD)
 *
 * Mounts into a #reportsDashboardPanel slot in view-reports.
 * Computes off in-memory caches (window._leads, window._estimates,
 * window._photos, window._knocks) — same source as the existing
 * KPI engine, no extra Firestore reads.
 *
 * Auto-refreshes on every nbd:data-refreshed event.
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['reports-dashboard']) return;
  __NBD_LOADED['reports-dashboard'] = true;

  const TARGET_ID = 'reportsDashboardPanel';
  const STORAGE_KEY = 'nbd_reports_period_v1';

  // Period definitions in days. 'ytd' is special-cased.
  const PERIODS = [
    { key: '7d',   label: '7 days',  days: 7 },
    { key: '30d',  label: '30 days', days: 30 },
    { key: '90d',  label: '90 days', days: 90 },
    { key: 'ytd',  label: 'YTD',     days: null },
  ];

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _money(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '$0';
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (n >= 10_000)    return '$' + Math.round(n / 1000) + 'k';
    return '$' + Math.round(n).toLocaleString();
  }
  function _toMillis(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) { return 0; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
    return 0;
  }

  function _readPeriod() {
    try { return localStorage.getItem(STORAGE_KEY) || '30d'; }
    catch (_) { return '30d'; }
  }
  function _writePeriod(key) {
    try { localStorage.setItem(STORAGE_KEY, key); } catch (_) {}
  }

  function _periodRange(periodKey) {
    const now = Date.now();
    if (periodKey === 'ytd') {
      const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
      const lastYearStart = new Date(new Date().getFullYear() - 1, 0, 1).getTime();
      return {
        currentStart: yearStart,
        currentEnd: now,
        prevStart: lastYearStart,
        prevEnd: yearStart,
      };
    }
    const period = PERIODS.find(p => p.key === periodKey) || PERIODS[1];
    const ms = period.days * 86_400_000;
    return {
      currentStart: now - ms,
      currentEnd: now,
      prevStart: now - 2 * ms,
      prevEnd: now - ms,
    };
  }

  // When an estimate reached the homeowner: the earliest stamp that proves it.
  // 0 = never sent (a draft) — never createdAt.
  function _sentMs(e) {
    const ms = [e.sentAt, e.sharedAt, e.viewedAt, e.signedAt].map(_toMillis).filter(Boolean);
    return ms.length ? Math.min.apply(null, ms) : 0;
  }

  // ─── Compute metrics for a window ────────────────────────────
  function _computeWindow(start, end) {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const ests = Array.isArray(window._estimates) ? window._estimates : [];

    const inWindow = (ms) => ms >= start && ms <= end;

    const leadsInWindow = leads.filter(l => inWindow(_toMillis(l.createdAt)));
    // ONE definition of "sent" for the whole panel: the earliest of sentAt /
    // sharedAt / viewedAt / signedAt — a view or a signature proves it went out.
    // Before 2026-09-28 the close-rate denominator fell back to createdAt (an
    // unsent DRAFT counted as "sent") while the funnel required sentAt, which the
    // homeowner share-link flow never stamps (it writes sharedAt): the emulator
    // showed "0 / 3 sent" beside a funnel reading Estimate sent 0 → Viewed 1.
    const estsInWindow = ests.filter(e => { const m = _sentMs(e); return !!m && inWindow(m); });
    const signedInWindow = ests.filter(e => inWindow(_toMillis(e.signedAt)));

    // Revenue = money COLLECTED in the window (Jo, 2026-09-28: "Revenue is
    // always collected only") — invoice payments by payment date, from the
    // shared NBDRevenue cache (null until the first load lands → "…").
    // Signed-estimate value is a promise: kept as signedValue, and Avg ticket
    // stays the average SIGNED job (a size-of-deal measure, not revenue).
    const R = window.NBDRevenue;
    const invs = R ? R.cached() : null;
    const collected = invs ? R.collectedBetween(invs, start, end) : null;
    const revenue = collected ? collected.total : null;
    const paymentCount = collected ? collected.count : 0;
    const signedValue = signedInWindow.reduce((sum, e) => sum + (Number(e.grandTotal || e.total) || 0), 0);
    const avgTicket = signedInWindow.length ? signedValue / signedInWindow.length : 0;
    // Close rate must be a SUBSET of its denominator or it can exceed 100%:
    // signedInWindow filters on signedAt while estsInWindow filters on sentAt,
    // so an estimate sent before the period but signed inside it landed in the
    // numerator without being in the denominator. Count only estimates that were
    // BOTH sent and signed within the window. (signedInWindow stays as-is for the
    // period revenue / avg-ticket figures above.)
    const signedOfSent = estsInWindow.filter(e => e.signedAt && inWindow(_toMillis(e.signedAt)));
    const closeRate = estsInWindow.length
      ? signedOfSent.length / estsInWindow.length
      : 0;

    // Conversion funnel — uses lead.stage progression for in-window leads
    // plus their estimate state. Five stages of interest.
    const funnel = {
      leads: leadsInWindow.length,
      inspected: leadsInWindow.filter(l => {
        const sk = String(l._stageKey || l.stage || '').toLowerCase();
        return sk && sk !== 'new' && sk !== 'contacted';
      }).length,
      estimateSent: 0,
      estimateViewed: 0,
      signed: 0,
    };
    // Match estimates back to leads in window
    const leadIds = new Set(leadsInWindow.map(l => l.id));
    ests.forEach(e => {
      if (!leadIds.has(e.leadId)) return;
      const sentMs = _sentMs(e);
      if (sentMs && sentMs >= start && sentMs <= end) funnel.estimateSent++;
      // Use inWindow (both bounds) not `>= start` — a bare lower bound let
      // views/signings AFTER a custom range's end leak into the funnel.
      if (e.viewedAt && inWindow(_toMillis(e.viewedAt))) funnel.estimateViewed++;
      if (e.signedAt && inWindow(_toMillis(e.signedAt))) funnel.signed++;
    });

    return {
      leadCount: leadsInWindow.length,
      estimateCount: estsInWindow.length,
      signedCount: signedInWindow.length,
      signedValue,
      paymentCount,
      revenue,
      avgTicket,
      closeRate,
      funnel,
    };
  }

  function _delta(cur, prev) {
    if (prev === 0) return cur === 0 ? 0 : 100;
    return ((cur - prev) / prev) * 100;
  }

  function _deltaBadge(deltaPct, invertColor) {
    if (!isFinite(deltaPct) || Math.abs(deltaPct) < 1) return '';
    const up = deltaPct > 0;
    // For "good = up" metrics (revenue, leads, close rate, avg ticket), green-up.
    // Caller can pass invertColor if the metric is "bad when up" (none here today).
    const color = (up && !invertColor) || (!up && invertColor) ? '#10b981' : '#ef4444';
    const arrow = up ? '↑' : '↓';
    const sign = up ? '+' : '';
    return '<span style="font-size:11px;color:' + color + ';font-weight:700;margin-left:6px;">' +
      arrow + ' ' + sign + Math.round(deltaPct) + '%</span>';
  }

  // ─── Render ─────────────────────────────────────────────────
  function render() {
    const host = document.getElementById(TARGET_ID);
    if (!host) return;
    const period = _readPeriod();
    const range = _periodRange(period);
    const cur = _computeWindow(range.currentStart, range.currentEnd);
    if (cur.revenue === null && window.NBDRevenue) {
      window.NBDRevenue.loadInvoices().then(function () { if (window.NBDRevenue.cached()) render(); });
    }
    const prev = _computeWindow(range.prevStart, range.prevEnd);

    const periodTabs = PERIODS.map(p =>
      '<button type="button" class="nbd-rdash-period" data-period="' + p.key + '" ' +
        'style="padding:6px 12px;background:' + (p.key === period ? 'var(--orange, #A14A22)' : 'transparent') + ';' +
        'color:' + (p.key === period ? '#fff' : 'var(--m, #888)') + ';' +
        'border:1px solid ' + (p.key === period ? 'var(--orange, #A14A22)' : 'var(--br, #2a2f35)') + ';' +
        'border-radius:5px;font:inherit;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;">' +
        _esc(p.label) +
      '</button>'
    ).join('');

    const tile = (label, value, deltaPct, sub) =>
      '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:8px;padding:14px 16px;flex:1;min-width:160px;">' +
        '<div style="font-size:10px;color:var(--m, #888);letter-spacing:0.08em;text-transform:uppercase;font-weight:600;margin-bottom:5px;">' + _esc(label) + '</div>' +
        '<div style="font-size:22px;font-weight:800;color:var(--t, #e8eaf0);font-variant-numeric:tabular-nums;line-height:1.05;">' +
          _esc(value) + _deltaBadge(deltaPct) +
        '</div>' +
        (sub ? '<div style="font-size:11px;color:var(--m, #888);margin-top:5px;">' + _esc(sub) + '</div>' : '') +
      '</div>';

    // Funnel rendering — horizontal bars with proportional widths.
    const f = cur.funnel;
    const max = Math.max(f.leads, 1);
    const funnelRow = (label, value, color) => {
      const w = (value / max) * 100;
      return (
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:13px;">' +
          '<span style="width:120px;flex-shrink:0;color:var(--m, #888);">' + _esc(label) + '</span>' +
          '<div style="flex:1;height:22px;background:var(--bg, #0a0c0f);border-radius:4px;overflow:hidden;border:1px solid var(--br, #2a2f35);position:relative;">' +
            '<div style="position:absolute;inset:0 auto 0 0;width:' + Math.max(w, 2) + '%;background:' + color + ';transition:width 280ms ease;"></div>' +
            '<div style="position:relative;padding:3px 8px;color:var(--t, #fff);font-weight:600;font-variant-numeric:tabular-nums;font-size:12px;">' +
              _esc(String(value)) + (label !== 'Leads' && f.leads > 0 ? ' (' + Math.round((value / f.leads) * 100) + '%)' : '') +
            '</div>' +
          '</div>' +
        '</div>'
      );
    };

    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px;flex-wrap:wrap;gap:10px;">' +
        '<div>' +
          '<div style="font-size:11px;color:var(--m, #888);letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:3px;">Performance dashboard</div>' +
          '<div style="font-size:11px;color:var(--m, #888);">vs. previous ' + (period === 'ytd' ? 'year' : period) + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + periodTabs + '</div>' +
      '</div>' +

      '<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:18px;">' +
        tile('Revenue',     cur.revenue === null ? '…' : _money(cur.revenue),
             cur.revenue === null ? '' : _delta(cur.revenue, prev.revenue || 0),
             'collected · ' + cur.paymentCount + ' payment' + (cur.paymentCount === 1 ? '' : 's') + (cur.signedCount ? ' · ' + _money(cur.signedValue) + ' signed' : '')) +
        tile('Avg ticket',  _money(cur.avgTicket),     _delta(cur.avgTicket, prev.avgTicket),   prev.avgTicket ? 'was ' + _money(prev.avgTicket) : '') +
        tile('Leads added', String(cur.leadCount),     _delta(cur.leadCount, prev.leadCount),   prev.leadCount + ' previous') +
        tile('Close rate',  Math.round(cur.closeRate * 100) + '%', _delta(cur.closeRate, prev.closeRate), cur.signedCount + ' / ' + cur.estimateCount + ' sent') +
      '</div>' +

      '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:8px;padding:14px 16px;">' +
        '<div style="font-size:11px;color:var(--m, #888);letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:10px;">Conversion funnel</div>' +
        funnelRow('Leads',          f.leads,          'rgba(59, 130, 246, 0.55)') +
        funnelRow('Inspected',      f.inspected,      'rgba(59, 130, 246, 0.7)') +
        funnelRow('Estimate sent',  f.estimateSent,   'rgba(155, 109, 255, 0.7)') +
        funnelRow('Viewed',         f.estimateViewed, 'rgba(46, 204, 138, 0.7)') +
        funnelRow('Signed',         f.signed,         'rgba(16, 185, 129, 0.85)') +
      '</div>';

    Array.from(host.querySelectorAll('.nbd-rdash-period')).forEach(b => {
      b.addEventListener('click', () => {
        _writePeriod(b.dataset.period);
        render();
      });
    });
  }

  function _bootstrap() {
    render();
    window.addEventListener('nbd:data-refreshed', render);
    // W159 HIGH #6: also re-render whenever the rep navigates TO
    // the Reports view. The original setTimeout(1500/4500) timers
    // fire while the rep is still on the CRM view; if loadEstimates
    // hasn't completed by then, the panel renders "no data" and
    // never refreshes for the rest of the session because the next
    // nbd:data-refreshed event already fired before the rep
    // navigated. This hash-listener catches the actual view-change.
    window.addEventListener('hashchange', () => {
      if (window.location.hash && window.location.hash.indexOf('reports') !== -1) {
        // Give loadEstimates a beat to finish if it's still pending.
        setTimeout(render, 250);
      }
    });
    // W159 HIGH #9: remove the data-refreshed listener on pagehide
    // so a bfcache restore doesn't accumulate render subscriptions
    // (each restore previously added another one, causing N×
    // re-renders on every subsequent data event).
    window.addEventListener('pagehide', () => {
      try { window.removeEventListener('nbd:data-refreshed', render); } catch (_) {}
    }, { once: true });
    setTimeout(render, 1500);
    setTimeout(render, 4500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap, { once: true });
  } else {
    setTimeout(_bootstrap, 0);
  }

  const NBDReportsDashboard = {
    render,
  };
})();
