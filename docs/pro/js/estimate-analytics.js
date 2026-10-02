/**
 * estimate-analytics.js — Wave 147 (Estimate analytics summary band)
 *
 * Reads from window._estimates (populated by loadEstimates) and
 * renders a compact stat band into #estStats on the estimates view.
 *
 * Stats:
 *   - Total estimates + status breakdown (draft / sent / signed / lost)
 *   - Close rate (signed / sent), with absolute counts
 *   - Average ticket per signed estimate
 *   - View → sign conversion (signed / viewed)
 *   - Tier breakdown of signed estimates (Economy / Good / Better / Best / Beyond %)
 *   - Time-to-sign (median days from sentAt → signedAt)
 *   - Top 3 leaderboard: highest-grandTotal signed estimates
 *
 * Auto-refreshes on every `nbd:data-refreshed` event so a fresh
 * loadEstimates() or W146 viewedAt-bump reflects immediately.
 *
 * Path-gated to dashboard.html (only place #estStats lives).
 *
 * Public API:
 *   window.NBDEstimateAnalytics.render()
 *   window.NBDEstimateAnalytics.compute()  // returns the raw stats
 */
(function () {
  'use strict';

  // Every tier, cheapest first (five since 2026-10-02) — estimate-config.js
  // TIER_ORDER, with a copy for a page that didn't load it.
  function _tierOrder() {
    const cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    return (cfg && Array.isArray(cfg.TIER_ORDER)) ? cfg.TIER_ORDER.slice() : ['economy', 'good', 'better', 'best', 'beyond'];
  }
  // Rep-facing dashboard: the internal Good/Better/Best names it always
  // showed, plus the two new tiers.
  function _tierName(k) {
    return ({ economy: 'Economy', good: 'Good', better: 'Better', best: 'Best', beyond: 'Beyond' })[k] || k;
  }
  const TIER_MIX_COLORS = { economy: '#a8a29e', good: '#3b82f6', better: '#9b6dff', best: '#10b981', beyond: '#0e7490' };
  if (window.NBDEstimateAnalytics
      && window.NBDEstimateAnalytics.__sentinel === 'nbd-est-analytics-v1') return;

  const TARGET_ID = 'estStats';

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _money(n) {
    const v = Number(n);
    if (!isFinite(v)) return '$0';
    if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (v >= 10_000)    return '$' + Math.round(v / 1000) + 'k';
    return '$' + Math.round(v).toLocaleString();
  }
  function _pct(num, den) {
    if (!den || den === 0) return '—';
    return Math.round((num / den) * 100) + '%';
  }
  function _toMillis(ts) {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts.toMillis === 'function') {
      try { return ts.toMillis(); } catch (_) { return 0; }
    }
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
    return 0;
  }

  // ─── Compute summary stats from window._estimates ──────────────
  function compute() {
    const list = Array.isArray(window._estimates) ? window._estimates : [];
    const out = {
      total:        list.length,
      draft:        0,
      sent:         0,
      viewed:       0,
      signed:       0,
      signedViewed: 0,
      lost:         0,
      signedTotal:  0,
      signedTickets: [],
      // Five tiers since 2026-10-02 (TIER_ORDER), each counted.
      tierCounts:   _tierOrder().reduce((m, k) => { m[k] = 0; return m; }, {}),
      timeToSignDays: [],
      topSigned:    [],
    };
    for (const e of list) {
      if (!e || e.deleted) continue;
      const status = String(e.status || (e.signedAt ? 'signed' : 'draft')).toLowerCase();
      const tier = String(e.tier || '').toLowerCase();
      // Two-shape read — the grandTotal||total ladder had no `amount` rung, so
      // Classic estimates scored 0 in every funnel/value rollup below.
      const _api = window.NBDCustomerEstimateRows;
      const grandTotal = (_api && typeof _api.estimateValue === 'function')
        ? _api.estimateValue(e)
        : (Number(e.grandTotal != null ? e.grandTotal
            : e.total != null ? e.total : e.amount) || 0);
      const sentMs = _toMillis(e.sentAt);
      const viewedMs = _toMillis(e.viewedAt);
      const signedMs = _toMillis(e.signedAt);

      // Metrics audit F5: `viewed` counts EVERY estimate the homeowner
      // opened, whatever bucket it ended in. The old code only counted
      // views on sent-not-yet-signed estimates, so View→Sign compared
      // disjoint populations — 3 viewed that all signed showed "—", and
      // 2 signed + 1 viewed-unsigned showed 200%.
      if (viewedMs) out.viewed++;

      if (status === 'draft' && !sentMs) out.draft++;
      else if (status === 'lost' || status === 'rejected') out.lost++;
      else if (signedMs || status === 'signed') {
        out.signed++;
        if (viewedMs) out.signedViewed++;
        out.signedTotal += grandTotal;
        out.signedTickets.push(grandTotal);
        if (Object.prototype.hasOwnProperty.call(out.tierCounts, tier)) {
          out.tierCounts[tier]++;
        }
        if (sentMs && signedMs && signedMs > sentMs) {
          const days = (signedMs - sentMs) / 86_400_000;
          if (days >= 0 && days <= 365) out.timeToSignDays.push(days);
        }
        out.topSigned.push({
          id: e.id,
          owner: e.owner || ((e.firstName || '') + ' ' + (e.lastName || '')).trim() || '(no name)',
          addr: e.addr || e.address || '',
          tier: tier || 'better',
          grandTotal,
        });
      }
      else if (sentMs) {
        out.sent++;
      }
    }

    out.avgTicket = out.signed
      ? Math.round(out.signedTotal / out.signed)
      : 0;
    out.medianTimeToSign = _median(out.timeToSignDays);
    // Metrics audit F6: lost/rejected estimates stay in the close-rate
    // denominator. Excluding them was survivor bias — losing a deal made
    // the close rate go UP.
    out.closeRate = out.sent + out.signed + out.lost > 0
      ? out.signed / (out.sent + out.signed + out.lost)
      : 0;
    // F5: of the estimates homeowners actually opened, how many signed.
    // Numerator is a strict subset of the denominator — can't exceed 100%.
    out.viewToSignRate = out.viewed > 0
      ? out.signedViewed / out.viewed
      : 0;
    out.topSigned.sort((a, b) => b.grandTotal - a.grandTotal);
    out.topSigned = out.topSigned.slice(0, 3);
    return out;
  }

  function _median(arr) {
    if (!arr.length) return 0;
    const sorted = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ─── Render into #estStats ─────────────────────────────────────
  function render() {
    const host = document.getElementById(TARGET_ID);
    if (!host) return;
    const list = Array.isArray(window._estimates) ? window._estimates : [];
    if (list.length === 0) {
      host.style.display = 'none';
      return;
    }
    host.style.display = 'block';
    const s = compute();

    // Stat tile factory — keeps the markup tidy below.
    const tile = (label, value, sub) =>
      '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:7px;padding:10px 12px;min-width:120px;">' +
        '<div style="font-size:10px;color:var(--m, #888);letter-spacing:0.08em;text-transform:uppercase;font-weight:600;margin-bottom:3px;">' + _esc(label) + '</div>' +
        '<div style="font-size:18px;font-weight:700;color:var(--t, #e8eaf0);font-variant-numeric:tabular-nums;line-height:1.1;">' + _esc(value) + '</div>' +
        (sub ? '<div style="font-size:10px;color:var(--m, #888);margin-top:3px;">' + _esc(sub) + '</div>' : '') +
      '</div>';

    // Tier mix bar — proportional fill per tier (five since 2026-10-02) so
    // a "70% Better" mix is obvious at a glance.
    const _mix = _tierOrder().map(k => ({ key: k, n: s.tierCounts[k] || 0, color: TIER_MIX_COLORS[k] || '#888' }));
    const totalTiered = _mix.reduce((a, t) => a + t.n, 0);
    let tierBar = '';
    if (totalTiered > 0) {
      _mix.forEach(t => { t.pct = (t.n / totalTiered) * 100; t.name = _tierName(t.key); });
      tierBar =
        '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:7px;padding:10px 12px;flex:2;min-width:240px;">' +
          '<div style="font-size:10px;color:var(--m, #888);letter-spacing:0.08em;text-transform:uppercase;font-weight:600;margin-bottom:6px;">Signed tier mix</div>' +
          '<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--bg, #0a0c0f);margin-bottom:6px;">' +
            _mix.map(t => t.pct ? '<div style="width:' + t.pct + '%;background:' + t.color + ';" title="' + _esc(t.name) + '"></div>' : '').join('') +
          '</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:10px;color:var(--m, #888);font-variant-numeric:tabular-nums;">' +
            _mix.filter(t => t.n > 0 || ['good', 'better', 'best'].indexOf(t.key) !== -1)
              .map(t => '<span><span style="color:' + t.color + ';">●</span> ' + _esc(t.name) + ' ' + Math.round(t.pct) + '%</span>').join('') +
          '</div>' +
        '</div>';
    }

    const topSignedList = s.topSigned.length
      ? s.topSigned.map(t =>
          '<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:11px;">' +
            '<span style="color:var(--m, #888);">🏆 ' + _esc(t.owner) + ' <span style="opacity:0.7;">' + _esc(t.tier) + '</span></span>' +
            '<span style="font-weight:700;font-variant-numeric:tabular-nums;color:var(--green, #2ecc8a);">' + _money(t.grandTotal) + '</span>' +
          '</div>'
        ).join('')
      : '';

    host.innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:stretch;">' +
        tile('Total', s.total, s.draft + ' draft · ' + s.sent + ' sent · ' + s.signed + ' signed' + (s.lost ? ' · ' + s.lost + ' lost' : '')) +
        tile('Close rate', _pct(s.signed, s.sent + s.signed + s.lost), s.signed + ' / ' + (s.sent + s.signed + s.lost) + ' sent+signed+lost') +
        tile('Avg ticket', _money(s.avgTicket), 'across ' + s.signed + ' signed') +
        tile('View → sign', _pct(s.signedViewed, s.viewed), s.viewed + ' viewed → ' + s.signedViewed + ' signed') +
        tile('Median time-to-sign', s.medianTimeToSign ? Math.round(s.medianTimeToSign) + 'd' : '—', s.timeToSignDays.length + ' samples') +
        tierBar +
      '</div>' +
      (topSignedList ? (
        '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:7px;padding:10px 12px;margin-top:8px;">' +
          '<div style="font-size:10px;color:var(--m, #888);letter-spacing:0.08em;text-transform:uppercase;font-weight:600;margin-bottom:6px;">Top signed</div>' +
          topSignedList +
        '</div>'
      ) : '');
  }

  function _bootstrap() {
    render();
    window.addEventListener('nbd:data-refreshed', render);
    // Defer one more render after window-level loadEstimates has had
    // time to populate window._estimates on first dashboard load.
    setTimeout(render, 1200);
    setTimeout(render, 4000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap, { once: true });
  } else {
    setTimeout(_bootstrap, 0);
  }

  window.NBDEstimateAnalytics = {
    __sentinel: 'nbd-est-analytics-v1',
    render,
    compute,
  };
})();
