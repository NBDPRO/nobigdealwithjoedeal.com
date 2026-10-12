/**
 * reports-trends.js — Wave 154 (revenue trend + top performers)
 *
 * Two add-ons to the Reports view's W153 dashboard panel:
 *
 *   1. Revenue trend sparkline — last 12 weeks of signed-estimate
 *      revenue, rendered as a compact SVG line chart with the
 *      latest week highlighted. Gives the rep a fast read on
 *      "are we trending up, flat, or down?"
 *
 *   2. Top performers leaderboard — three lists side by side:
 *        - Top customers by lifetime revenue (signed estimate
 *          totals attributed to the lead)
 *        - Top sources by signed-estimate revenue (lead.source
 *          field grouping — answers "where do my best deals
 *          come from?")
 *        - Most-engaged leads (highest viewCount / interactions
 *          in last 30 days, regardless of close status)
 *
 * Mounts into a #reportsTrendsPanel slot. Same data sources as
 * W153 (window._leads, window._estimates) — pure compute on
 * what's already in memory.
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['reports-trends']) return;
  __NBD_LOADED['reports-trends'] = true;

  const TARGET_ID = 'reportsTrendsPanel';
  const TREND_WEEKS = 12;
  const ROW_LIMIT = 5;

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

  // Revenue = money COLLECTED (Jo, 2026-09-28: "Revenue is always collected
  // only"). This panel used signed estimates' totals — a signature is a
  // promise, not money. Invoices come from the shared NBDRevenue cache; null
  // until the first load lands (the panel shows "…" and re-renders once).
  function _invoices() {
    const R = window.NBDRevenue;
    if (!R) return [];
    const inv = R.cached();
    if (!inv) {
      R.loadInvoices().then(function () { if (R.cached() && document.getElementById(TARGET_ID)) render(); });
      return null;
    }
    return inv;
  }

  // ─── Compute weekly revenue buckets ─────────────────────────
  function _computeWeeklyRevenue(weeks, invoices) {
    const now = new Date();
    // Snap to the start of the current week — MONDAY (ISO-8601; Jo's call
    // 2026-06-25). getDay() is 0=Sun..6=Sat; (getDay()+6)%7 is days since Monday
    // (Mon→0, Sun→6), so subtracting it lands on this week's Monday at 00:00 local.
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setHours(0, 0, 0, 0);
    startOfThisWeek.setDate(startOfThisWeek.getDate() - ((startOfThisWeek.getDay() + 6) % 7));
    const buckets = new Array(weeks).fill(0);
    const labels = new Array(weeks);
    for (let i = 0; i < weeks; i++) {
      const d = new Date(startOfThisWeek);
      d.setDate(startOfThisWeek.getDate() - (weeks - 1 - i) * 7);
      labels[i] = (d.getMonth() + 1) + '/' + d.getDate();
    }
    const R = window.NBDRevenue;
    for (const inv of (invoices || [])) {
      if (!inv || inv.deleted === true || !R) continue;
      for (const p of R.paymentsOf(inv)) {
        const paidMs = _toMillis(p.at);
        if (!paidMs) continue;
        // This week (Monday 00:00 onward) is the last bucket; each earlier
        // Monday-to-Sunday week steps one bucket left. The old
        // floor((weekStart − t) / week) dropped THIS week's money (index =
        // weeks, off the chart) and put last week's into "this week".
        const start = startOfThisWeek.getTime();
        const idx = paidMs >= start ? weeks - 1 : weeks - 2 - Math.floor((start - paidMs - 1) / (7 * 86_400_000));
        if (idx >= 0 && idx < weeks) buckets[idx] += Number(p.amount) || 0;
      }
    }
    return { buckets, labels };
  }

  // ─── Render SVG sparkline ───────────────────────────────────
  function _renderSparkline(buckets, labels) {
    const w = 480, h = 60, pad = 4;
    const max = Math.max(...buckets, 1);
    const len = buckets.length;
    if (len < 2) return '<div style="color:var(--m, #888);font-size:12px;">Not enough data yet.</div>';
    const stepX = (w - pad * 2) / (len - 1);
    let pathD = '';
    let areaD = '';
    let dots = '';
    for (let i = 0; i < len; i++) {
      const x = pad + i * stepX;
      const y = h - pad - (buckets[i] / max) * (h - pad * 2);
      pathD += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      if (i === 0) areaD += 'M' + x.toFixed(1) + ',' + (h - pad).toFixed(1) + ' L';
      areaD += x.toFixed(1) + ',' + y.toFixed(1) + ' ';
      const isLast = i === len - 1;
      const dotR = isLast ? 4 : 2;
      const dotColor = isLast ? '#A14A22' : '#94a3b8';
      dots += '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + dotR + '" fill="' + dotColor + '"/>';
    }
    areaD += 'L' + (pad + (len - 1) * stepX).toFixed(1) + ',' + (h - pad).toFixed(1) + ' Z';
    return (
      '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" ' +
        'style="width:100%;height:80px;display:block;background:var(--bg, #0a0c0f);border-radius:6px;border:1px solid var(--br, #2a2f35);">' +
        '<defs>' +
          '<linearGradient id="nbd-rt-area" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="#A14A22" stop-opacity="0.4"/>' +
            '<stop offset="100%" stop-color="#A14A22" stop-opacity="0"/>' +
          '</linearGradient>' +
        '</defs>' +
        '<path d="' + areaD + '" fill="url(#nbd-rt-area)" stroke="none"/>' +
        '<path d="' + pathD + '" fill="none" stroke="#A14A22" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
        dots +
      '</svg>'
    );
  }

  // ─── Compute leaderboard data ───────────────────────────────
  function _computeLeaderboards(invoices) {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const ests = Array.isArray(window._estimates) ? window._estimates : [];
    const R = window.NBDRevenue;
    const paid = (R && invoices) ? R.collectedByLead(invoices, null, null) : {};

    // Top customers by COLLECTED revenue (all time)
    const customerTotals = new Map();
    for (const leadId of Object.keys(paid)) {
      if (!(paid[leadId] > 0)) continue;
      customerTotals.set(leadId, { leadId, total: paid[leadId], count: 1 });
    }
    const topCustomers = Array.from(customerTotals.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, ROW_LIMIT)
      .map(c => {
        const lead = leads.find(l => l.id === c.leadId);
        const name = lead
          ? ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || (lead.address || '')
          : '(deleted lead)';
        return { name, total: c.total, count: c.count };
      });

    // Top sources by COLLECTED revenue (count = paying customers)
    const sourceTotals = new Map();
    for (const leadId of Object.keys(paid)) {
      if (!(paid[leadId] > 0)) continue;
      const lead = leads.find(l => l.id === leadId);
      const source = (lead && lead.source) || 'unknown';
      const cur = sourceTotals.get(source) || { source, total: 0, count: 0 };
      cur.total += paid[leadId];
      cur.count++;
      sourceTotals.set(source, cur);
    }
    const topSources = Array.from(sourceTotals.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, ROW_LIMIT);

    // Most-engaged leads — last 30 days, by lead.engagementScore +
    // estimate viewCount + W123 unreadHomeownerMessages.
    const cutoff = Date.now() - 30 * 86_400_000;
    const engaged = leads
      .map(l => {
        const lastActivityMs = _toMillis(l.updatedAt) || _toMillis(l.createdAt);
        if (lastActivityMs < cutoff) return null;
        let score = 0;
        score += Number(l.engagementScore || 0);
        const leadEsts = ests.filter(e => e.leadId === l.id);
        score += leadEsts.reduce((s, e) => s + (Number(e.viewCount || 0) * 5), 0);
        score += Number(l.unreadHomeownerMessages || 0) * 8;
        if (l.lastHomeownerMessageAt) score += 6;
        if (l.lastUploadAt) score += 4;
        if (score === 0) return null;
        return { lead: l, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, ROW_LIMIT);

    return { topCustomers, topSources, engaged };
  }

  // ─── Render ─────────────────────────────────────────────────
  function render() {
    const host = document.getElementById(TARGET_ID);
    if (!host) return;
    const invoices = _invoices();
    const { buckets, labels } = _computeWeeklyRevenue(TREND_WEEKS, invoices || []);
    const { topCustomers, topSources, engaged } = _computeLeaderboards(invoices);

    const totalThisWeek = buckets[buckets.length - 1];
    const totalLastWeek = buckets[buckets.length - 2] || 0;
    const wow = totalLastWeek > 0
      ? ((totalThisWeek - totalLastWeek) / totalLastWeek) * 100
      : 0;
    const wowBadge = isFinite(wow) && Math.abs(wow) >= 1
      ? '<span style="font-size:11px;color:' + (wow > 0 ? '#10b981' : '#ef4444') + ';font-weight:700;margin-left:6px;">' +
        (wow > 0 ? '↑ +' : '↓ ') + Math.round(wow) + '% vs last wk</span>'
      : '';

    const customerRows = topCustomers.length
      ? topCustomers.map((c, i) =>
          '<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;font-size:12px;">' +
            '<span style="color:var(--m, #888);">' + (i + 1) + '. ' + _esc(c.name) + (c.count > 1 ? ' <span style="opacity:0.6;">×' + c.count + '</span>' : '') + '</span>' +
            '<span style="font-weight:700;font-variant-numeric:tabular-nums;color:var(--green, #2ecc8a);">' + _money(c.total) + '</span>' +
          '</div>'
        ).join('')
      : '<div style="color:var(--m, #888);font-size:12px;font-style:italic;">' + (invoices ? 'No payments collected yet.' : 'Loading…') + '</div>';

    const sourceRows = topSources.length
      ? topSources.map((s, i) =>
          '<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;font-size:12px;">' +
            '<span style="color:var(--m, #888);">' + (i + 1) + '. ' + _esc(s.source) + ' <span style="opacity:0.6;">×' + s.count + '</span></span>' +
            '<span style="font-weight:700;font-variant-numeric:tabular-nums;color:var(--green, #2ecc8a);">' + _money(s.total) + '</span>' +
          '</div>'
        ).join('')
      : '<div style="color:var(--m, #888);font-size:12px;font-style:italic;">' + (invoices ? 'No payments collected yet.' : 'Loading…') + '</div>';

    const engagedRows = engaged.length
      ? engaged.map((e, i) => {
          const name = ((e.lead.firstName || '') + ' ' + (e.lead.lastName || '')).trim()
            || e.lead.address
            || '(no name)';
          return (
            '<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;font-size:12px;">' +
              '<span style="color:var(--m, #888);">' + (i + 1) + '. ' + _esc(name) + '</span>' +
              '<span style="font-weight:700;font-variant-numeric:tabular-nums;color:#fbbf24;">' + Math.round(e.score) + '</span>' +
            '</div>'
          );
        }).join('')
      : '<div style="color:var(--m, #888);font-size:12px;font-style:italic;">No active engagement yet.</div>';

    host.innerHTML =
      '<div style="margin-bottom:18px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;flex-wrap:wrap;gap:8px;">' +
          '<div>' +
            '<div style="font-size:11px;color:var(--m, #888);letter-spacing:0.06em;text-transform:uppercase;font-weight:600;">Weekly revenue · collected</div>' +
            '<div style="font-size:18px;font-weight:800;color:var(--t, #e8eaf0);font-variant-numeric:tabular-nums;">' +
              (invoices ? _money(totalThisWeek) + ' this week' + wowBadge : '…') +
            '</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--m, #888);">Last ' + TREND_WEEKS + ' weeks</div>' +
        '</div>' +
        _renderSparkline(buckets, labels) +
      '</div>' +

      '<div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:12px;">' +
        '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:8px;padding:14px 16px;">' +
          '<div style="font-size:11px;color:var(--m, #888);letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Top customers · collected</div>' +
          customerRows +
        '</div>' +
        '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:8px;padding:14px 16px;">' +
          '<div style="font-size:11px;color:var(--m, #888);letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Top sources · collected</div>' +
          sourceRows +
        '</div>' +
        '<div style="background:var(--s, #13171d);border:1px solid var(--br, #2a2f35);border-radius:8px;padding:14px 16px;">' +
          '<div style="font-size:11px;color:var(--m, #888);letter-spacing:0.06em;text-transform:uppercase;font-weight:600;margin-bottom:8px;">Most engaged (30d)</div>' +
          engagedRows +
        '</div>' +
      '</div>';
  }

  function _bootstrap() {
    render();
    window.addEventListener('nbd:data-refreshed', render);
    // W159 HIGH #6: re-render on hashchange when navigating to
    // Reports. Same fix as reports-dashboard.js — see comment there.
    window.addEventListener('hashchange', () => {
      if (window.location.hash && window.location.hash.indexOf('reports') !== -1) {
        setTimeout(render, 250);
      }
    });
    // W159 HIGH #9: pagehide cleanup so bfcache restore doesn't
    // accumulate listeners.
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

  const NBDReportsTrends = {
    render,
  };
})();
