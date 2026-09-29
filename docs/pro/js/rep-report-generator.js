// ═══════════════════════════════════════════════════════════════
// NBD Pro — Rep Report Generator (Stage 1)
//
// Legendary visual reports for rep coaching + owner meetings.
// Charts are pure server-generated static HTML/SVG built at
// generation time (CSP-safe — reports render inside an <iframe srcdoc>
// whose inherited CSP has no 'unsafe-inline' in script-src, so inline
// chart scripts were blocked and rendered blank). NBDDocViewer handles
// rendering/export; Firestore stores generated reports.
//
// Ships with: Rep Monthly Review template (Tier 3 metrics).
// Future stages add: Territory Deep Dive, Pipeline Health Check,
// Revenue Recap, Customer Journey Report, Claude narrative.
//
// Public API:
//   window.NBDReports.init()                    — called on tab open
//   window.NBDReports.openGenerator()           — shows template picker
//   window.NBDReports.generate(template, opts)  — builds + opens report
//   window.NBDReports.listSavedReports()        — renders My Reports
//   window.NBDReports.openSavedReport(id)       — re-opens a saved report
//
// Metric calculators (pure functions):
//   computeKnocksToDeal(leads, knocks, rangeStart, rangeEnd)
//   computeTimeOfDayHeatmap(knocks, rangeStart, rangeEnd)
//   computeTopCitiesZips(knocks, leads, rangeStart, rangeEnd)
//   computePipelineVelocity(leads, rangeStart, rangeEnd)
//   computeRevenuePerKnock(leads, knocks, rangeStart, rangeEnd)
//   computeEstimateAccuracy(estimates, leads, rangeStart, rangeEnd)
//
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.NBDReports && window.NBDReports.__sentinel === 'nbd-reports-v1') return;

  // ─── State ───────────────────────────────────────────────
  let initialized = false;
  // Last list rendered by listSavedReports() — openSavedReport() reads from
  // this instead of the window global _loadReports() used to leave cached,
  // since the Open button only ever exists after listSavedReports() has run.
  let _reportsCache = [];

  // ─── Helpers ─────────────────────────────────────────────
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const toDate = (ts) => {
    if (!ts) return null;
    if (ts.toDate) return ts.toDate();
    if (ts instanceof Date) return ts;
    const d = new Date(ts);
    return isNaN(d.getTime()) ? null : d;
  };

  const inRange = (d, start, end) => {
    if (!d) return false;
    const t = d.getTime();
    return t >= start.getTime() && t <= end.getTime();
  };

  const fmtMoney = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const fmtNumber = (n) => (Number(n) || 0).toLocaleString('en-US');
  const fmtPct = (n) => ((Number(n) || 0) * 100).toFixed(1) + '%';
  const fmtDate = (d) => d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  // ─── Static chart helpers (CSP-safe) ─────────────────────
  // Reports render inside an <iframe srcdoc> that inherits the
  // /pro/dashboard CSP — which has NO 'unsafe-inline' in script-src.
  // So every chart is built as pure server-generated HTML/SVG at
  // generation time. No inline <script>, no on* handlers, no CDN.

  // Clamp a value to a 0–100 width percentage of a max.
  const barPct = (v, max) => max > 0 ? Math.max(0, Math.min(100, (Number(v) || 0) / max * 100)) : 0;

  // Static time-of-day heatmap. `series` is the ApexCharts-shaped
  // array: [{ name:'Sat', data:[{x:'00:00',y:N}, …24] }, …7 rows].
  // Renders a 25-col CSS grid (day label + 24 hours), one row per day,
  // cell background ramped by absolute knock count.
  function renderStaticHeatmap(series) {
    const rows = Array.isArray(series) ? series : [];
    if (!rows.length) {
      return '<div class="empty-state">No activity data yet.</div>';
    }
    const intensity = (y) => {
      const n = Number(y) || 0;
      if (n <= 0) return '#f0f0ed';
      if (n <= 2) return '#ffdcc0';
      if (n <= 5) return '#ff9940';
      return '#BD5728';
    };
    // Hour header labels are taken from the first row's data (00:00 → 23:00).
    const firstData = (rows[0] && Array.isArray(rows[0].data)) ? rows[0].data : [];
    const hourLabels = firstData.map((c) => esc(c && c.x != null ? c.x : ''));
    const headerCells = '<div class="hm-corner"></div>' +
      hourLabels.map((h) => `<div class="hm-hour">${h.replace(':00', '')}</div>`).join('');
    const bodyRows = rows.map((row) => {
      const name = esc(row && row.name != null ? row.name : '');
      const data = (row && Array.isArray(row.data)) ? row.data : [];
      const cells = data.map((c) => {
        const hour = esc(c && c.x != null ? c.x : '');
        const y = Number(c && c.y) || 0;
        return `<div class="hm-cell" style="background:${intensity(y)};" title="${name} ${hour} — ${y} knocks"></div>`;
      }).join('');
      return `<div class="hm-daylabel">${name}</div>${cells}`;
    }).join('');
    return `<div class="hm-grid" style="display:grid;grid-template-columns:34px repeat(24,1fr);gap:2px;-webkit-print-color-adjust:exact;print-color-adjust:exact;">` +
      headerCells + bodyRows +
      `</div>`;
  }

  // Shared CSS for the static charts. Injected into every report's
  // <head> <style> block (no external sheet, srcdoc has no same-origin
  // assets). Reuses the report orange palette.
  const STATIC_CHART_CSS = `
  /* ── STATIC CHART PRIMITIVES (CSP-safe, no charting library) ── */
  .hm-grid { align-items: stretch; }
  .hm-corner { }
  .hm-hour { font-family: 'Barlow Condensed', sans-serif; font-size: 9px; color: #999; text-align: center; line-height: 1; padding-bottom: 2px; }
  .hm-daylabel { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; font-weight: 700; color: #666; display: flex; align-items: center; }
  .hm-cell { height: 22px; border-radius: 2px; }
  .terr-bar-row { display: grid; grid-template-columns: 130px 1fr 70px; gap: 12px; align-items: center; padding: 7px 0; font-size: 12px; }
  .terr-bar-city { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; text-transform: uppercase; color: #111; letter-spacing: .03em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .terr-bar-rev { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; color: var(--orange,#BD5728); text-align: right; }
  .funnel-wrap { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 6px 0; }
  .funnel-bar { color: #fff; font-weight: 700; font-family: 'Barlow Condensed', sans-serif; letter-spacing: .03em; padding: 12px 16px; border-radius: 4px; text-align: center; white-space: nowrap; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .revenue-svg { width: 100%; height: auto; display: block; }`;

  const WON_STAGES = new Set([
    'closed', 'install_complete', 'final_photos', 'final_payment',
    'deductible_collected', 'Complete', 'install_in_progress', 'contract_signed'
  ]);
  const LOST_STAGES = new Set(['lost', 'Lost']);

  // Role-aware first (custom-stage-safe, matches analytics-kpi.js): a lead
  // whose role is 'won' OR 'job' (in production — contract won, crew working)
  // counts as closed-won money. The key lists remain the fallback for any
  // un-stamped lead; they already include the production stages.
  const isWon = (lead) => {
    const r = lead && (lead._stageRole
      || (typeof window.stageRole === 'function' ? window.stageRole(lead._stageKey || lead.stage) : ''));
    if (r) return r === 'won' || r === 'job';
    const s = (lead.stage || lead._stageKey || '').toString();
    return WON_STAGES.has(s) || WON_STAGES.has(s.toLowerCase());
  };
  const isLost = (lead) => {
    const r = lead && (lead._stageRole
      || (typeof window.stageRole === 'function' ? window.stageRole(lead._stageKey || lead.stage) : ''));
    if (r) return r === 'lost';
    const s = (lead.stage || lead._stageKey || '').toString();
    return LOST_STAGES.has(s) || LOST_STAGES.has(s.toLowerCase());
  };

  // When did this lead reach its CURRENT stage? stageStartedAt is stamped on
  // every stage move (and backfilled by migrations 002/003), so for a won
  // lead it IS the close date. The old updatedAt proxy re-attributed a deal
  // to whatever month you last touched the record (adding a note to a
  // March close moved its revenue into July). updatedAt/createdAt remain
  // only as fallbacks for anything the backfill never saw.
  const stageDate = (lead) => toDate(lead.stageStartedAt || lead.updatedAt || lead.createdAt);

  // Revenue = money COLLECTED (Jo, 2026-09-28: "Revenue is always collected
  // only"): invoice payments on THESE leads, by the date each payment arrived
  // (collected-revenue.js). The report used to call won jobs' jobValue
  // "Revenue Closed" — booked, not banked. _repInvoices is loaded once per
  // generate(); booked value is still reported, labelled as such.
  let _repInvoices = [];
  function collectedOn(leads, rangeStart, rangeEnd) {
    const R = window.NBDRevenue;
    if (!R) return 0;
    const ids = new Set(leads.map(l => l && l.id).filter(Boolean));
    return R.collectedBetween(_repInvoices,
      rangeStart ? rangeStart.getTime() : null, rangeEnd ? rangeEnd.getTime() : null,
      id => ids.has(id)).total;
  }

  // ─── Metric calculators (pure functions) ─────────────────

  // Knocks-to-deal ratio — how many doors does it take to close one?
  function computeKnocksToDeal(leads, knocks, rangeStart, rangeEnd) {
    const knocksInRange = knocks.filter(k => inRange(toDate(k.timestamp || k.createdAt), rangeStart, rangeEnd));
    const wonInRange = leads.filter(l =>
      isWon(l) && inRange(stageDate(l), rangeStart, rangeEnd)
    );
    const ratio = wonInRange.length > 0 ? (knocksInRange.length / wonInRange.length) : 0;
    return {
      totalKnocks: knocksInRange.length,
      dealsClosed: wonInRange.length,
      knocksPerDeal: ratio,
      display: wonInRange.length > 0
        ? Math.round(ratio) + ' knocks per deal'
        : knocksInRange.length + ' knocks · 0 deals closed'
    };
  }

  // Time-of-day heatmap — 7-day × 24-hour grid of knock activity
  // Returns a 7×24 matrix suitable for ApexCharts heatmap series.
  // NOTE: hours are bucketed in the REP'S LOCAL timezone — getDay()/getHours()
  // below read the viewing browser's clock, not a fixed company TZ. A rep who
  // travels across timezones (or whose device clock differs) will see slots
  // relative to wherever they are. The "(local time)" label on the heatmap
  // sections surfaces this to the reader.
  function computeTimeOfDayHeatmap(knocks, rangeStart, rangeEnd) {
    const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
    const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    let total = 0;
    let bestHour = 0, bestDay = 0, bestCount = 0;
    knocks.forEach(k => {
      const d = toDate(k.timestamp || k.createdAt);
      if (!d || !inRange(d, rangeStart, rangeEnd)) return;
      const day = d.getDay();
      const hour = d.getHours();
      grid[day][hour]++;
      total++;
      if (grid[day][hour] > bestCount) {
        bestCount = grid[day][hour];
        bestHour = hour;
        bestDay = day;
      }
    });
    // Convert to ApexCharts series format
    const series = days.map((dayName, i) => ({
      name: dayName,
      data: grid[i].map((count, hour) => ({ x: (hour < 10 ? '0' : '') + hour + ':00', y: count }))
    })).reverse(); // Reverse so Sunday is at top in display
    return {
      series,
      total,
      bestSlot: bestCount > 0
        ? `${days[bestDay]} ${bestHour}:00 (${bestCount} knocks)`
        : 'No data',
      bestDay: days[bestDay],
      bestHour
    };
  }

  // Top cities/zips by conversion — ranks territories by appointments + deals
  function computeTopCitiesZips(knocks, leads, rangeStart, rangeEnd) {
    // Bucket knocks by city from reverse-geocoded field, falling
    // back to parsed address if city isn't populated yet.
    const cityStats = {};
    const parseCity = (address) => {
      if (!address) return 'Unknown';
      // Try to pull "City" from "street, city, state zip" format
      const parts = String(address).split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) return parts[parts.length - 2] || parts[0];
      return parts[0] || 'Unknown';
    };
    knocks.forEach(k => {
      const d = toDate(k.timestamp || k.createdAt);
      if (!d || !inRange(d, rangeStart, rangeEnd)) return;
      const city = k.city || parseCity(k.address);
      if (!cityStats[city]) cityStats[city] = { city, knocks: 0, appts: 0, deals: 0, revenue: 0 };
      cityStats[city].knocks++;
      if (k.disposition === 'appointment' || k.disposition === 'interested') {
        cityStats[city].appts++;
      }
    });
    // Deals by the date the lead reached its stage (stageDate — updatedAt
    // re-dated old closes to the last edit); revenue = cash collected in the
    // range on each city's leads, whatever their stage.
    const paidByLead = window.NBDRevenue
      ? window.NBDRevenue.collectedByLead(_repInvoices, rangeStart.getTime(), rangeEnd.getTime()) : {};
    leads.forEach(l => {
      const city = l.city || parseCity(l.address);
      const paid = paidByLead[l.id] || 0;
      const d = stageDate(l);
      const wonHere = isWon(l) && d && inRange(d, rangeStart, rangeEnd);
      if (!wonHere && !paid) return;
      if (!cityStats[city]) cityStats[city] = { city, knocks: 0, appts: 0, deals: 0, revenue: 0 };
      if (wonHere) cityStats[city].deals++;
      cityStats[city].revenue += paid;
    });
    const sorted = Object.values(cityStats)
      .sort((a, b) => (b.deals * 1000 + b.appts * 10 + b.knocks) - (a.deals * 1000 + a.appts * 10 + a.knocks))
      .slice(0, 10);
    return { topCities: sorted };
  }

  // Pipeline velocity — avg days per stage, bottleneck detection
  function computePipelineVelocity(leads, rangeStart, rangeEnd) {
    const relevant = leads.filter(l =>
      inRange(stageDate(l), rangeStart, rangeEnd)
    );
    const stages = {};
    relevant.forEach(l => {
      const s = (l.stage || l._stageKey || 'unknown').toString();
      if (!stages[s]) stages[s] = { stage: s, count: 0, totalDays: 0 };
      stages[s].count++;
      const created = toDate(l.createdAt);
      const updated = toDate(l.updatedAt);
      if (created && updated) {
        stages[s].totalDays += Math.max(0, (updated - created) / (1000 * 60 * 60 * 24));
      }
    });
    const list = Object.values(stages).map(s => ({
      ...s,
      avgDays: s.count > 0 ? (s.totalDays / s.count) : 0
    }));
    const bottleneck = list.reduce((a, b) => (a && a.avgDays > b.avgDays) ? a : b, null);
    return {
      stages: list,
      bottleneck: bottleneck
        ? bottleneck.stage + ' (avg ' + bottleneck.avgDays.toFixed(1) + ' days)'
        : 'No data'
    };
  }

  // Revenue per door — closed revenue / UNIQUE doors knocked, plus the raw
  // per-knock figure. The old version divided revenue by KNOCK COUNT (attempts)
  // yet the report labeled it "Revenue per Door" — so re-knocking a door
  // understated the per-door number. Doors are deduped by address, then GPS
  // coords (map-logged knocks have no address string), then knock id — the same
  // door identity the D2D dashboard uses.
  function computeRevenuePerKnock(leads, knocks, rangeStart, rangeEnd) {
    const normAddr = (a) => String(a || '').toLowerCase().trim().replace(/\s+/g, ' ');
    const doorKey = (k) => {
      const a = normAddr(k.address);
      if (a) return a;
      if (k.lat != null && k.lng != null && isFinite(k.lat) && isFinite(k.lng)) {
        return 'geo:' + Number(k.lat).toFixed(5) + ',' + Number(k.lng).toFixed(5);
      }
      return 'k:' + (k.id || '');
    };
    const inRangeKnocks = knocks.filter(k =>
      inRange(toDate(k.timestamp || k.createdAt), rangeStart, rangeEnd)
    );
    const knocksCount = inRangeKnocks.length;
    const doorsCount = new Set(inRangeKnocks.map(doorKey)).size;
    const revenue = collectedOn(leads, rangeStart, rangeEnd);
    return {
      knocks: knocksCount,
      doors: doorsCount,
      revenue,
      revenuePerKnock: knocksCount > 0 ? (revenue / knocksCount) : 0,
      revenuePerDoor: doorsCount > 0 ? (revenue / doorsCount) : 0,
      display: knocksCount > 0
        ? fmtMoney(revenue / knocksCount) + ' per knock'
        : 'No knocks yet'
    };
  }

  // Estimate accuracy — estimated vs. actual job value
  function computeEstimateAccuracy(estimates, leads, rangeStart, rangeEnd) {
    let totalEstimated = 0;
    let totalActual = 0;
    let sampleCount = 0;
    estimates.forEach(est => {
      const d = toDate(est.createdAt);
      if (!d || !inRange(d, rangeStart, rangeEnd)) return;
      const lead = leads.find(l => l.id === est.leadId);
      if (!lead || !isWon(lead)) return;
      // Fall back to .total for older estimates saved before grandTotal existed
      // (matches reports-dashboard.js) — reading grandTotal alone reported $0 for
      // them, silently shrinking the accuracy sample.
      const estVal = Number(est.grandTotal || est.total) || 0;
      const actualVal = Number(lead.jobValue) || 0;
      if (estVal > 0 && actualVal > 0) {
        totalEstimated += estVal;
        totalActual += actualVal;
        sampleCount++;
      }
    });
    const accuracy = totalEstimated > 0 ? (totalActual / totalEstimated) : 0;
    return {
      sampleCount,
      totalEstimated,
      totalActual,
      accuracy,
      display: sampleCount > 0
        ? (accuracy * 100).toFixed(1) + '% of estimate value'
        : 'No closed estimates in range'
    };
  }

  // Pipeline funnel — counts leads by stage, ordered conventionally
  // so we can render a proper funnel visualization. Returns stages
  // in the canonical order even if they're empty, so the funnel
  // shape is consistent across reports.
  function computePipelineFunnel(leads, rangeStart, rangeEnd) {
    // Standard roofing pipeline order (most-to-least likely to close)
    const canonicalOrder = [
      { key: 'new',                  label: 'New Leads' },
      { key: 'contacted',            label: 'Contacted' },
      { key: 'inspected',            label: 'Inspected' },
      { key: 'claim_filed',          label: 'Claim Filed' },
      { key: 'estimate_submitted',   label: 'Estimate Sent' },
      { key: 'contract_signed',      label: 'Contract Signed' },
      { key: 'install_in_progress', label: 'Installing' },
      { key: 'closed',               label: 'Closed Won' },
      { key: 'lost',                 label: 'Lost' }
    ];
    const counts = {};
    canonicalOrder.forEach(s => { counts[s.key] = 0; });
    leads.forEach(l => {
      const d = stageDate(l);
      if (!inRange(d, rangeStart, rangeEnd)) return;
      const stageRaw = (l.stage || l._stageKey || '').toString().toLowerCase();
      if (counts[stageRaw] != null) counts[stageRaw]++;
      else {
        // Map known synonyms
        if (['install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'complete'].includes(stageRaw)) counts.closed++;
      }
    });
    // Filter out stages with zero count from the canonical order for
    // the funnel — empty stages create ugly zero-width bars.
    const stages = canonicalOrder
      .map(s => ({ stage: s.label, key: s.key, count: counts[s.key] || 0 }))
      .filter(s => s.count > 0);
    const total = stages.reduce((sum, s) => sum + s.count, 0);
    return { stages, total };
  }

  // Stuck deals — leads that haven't moved stages in >14 days and
  // aren't won/lost. Useful for "you've got 5 stuck deals worth $47k"
  // call-outs in the Pipeline Health report.
  function computeStuckDeals(leads) {
    const now = Date.now();
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    const stuck = leads.filter(l => {
      if (isWon(l) || isLost(l)) return false;
      const updated = toDate(l.updatedAt || l.createdAt);
      if (!updated) return false;
      return (now - updated.getTime()) >= fourteenDays;
    }).map(l => ({
      id: l.id,
      name: [l.firstName, l.lastName].filter(Boolean).join(' ') || l.address || 'Unknown',
      address: l.address || '',
      stage: l.stage || l._stageKey || 'unknown',
      jobValue: Number(l.jobValue) || 0,
      daysStuck: Math.floor((now - toDate(l.updatedAt || l.createdAt).getTime()) / (24 * 60 * 60 * 1000))
    })).sort((a, b) => b.daysStuck - a.daysStuck);
    const totalValue = stuck.reduce((sum, l) => sum + l.jobValue, 0);
    return {
      count: stuck.length,
      totalValue,
      topStuck: stuck.slice(0, 10)
    };
  }

  // Revenue trend — monthly revenue buckets over the period. Used
  // by the Revenue Recap template's bar chart so the owner can see
  // month-over-month progression.
  function computeRevenueTrend(leads, rangeStart, rangeEnd) {
    const monthKey = (d) => d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    const monthLabel = (d) => d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });

    // Build an ordered list of months in the range
    const buckets = {};
    const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
    const endCursor = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), 1);
    while (cursor <= endCursor) {
      const key = monthKey(cursor);
      buckets[key] = { key, label: monthLabel(cursor), revenue: 0, deals: 0 };
      cursor.setMonth(cursor.getMonth() + 1);
    }

    leads.forEach(l => {
      if (!isWon(l)) return;
      const d = stageDate(l);
      if (!d || !inRange(d, rangeStart, rangeEnd)) return;
      const key = monthKey(d);
      if (buckets[key]) buckets[key].deals++;
    });
    // Revenue bars = payments collected in each month on these leads.
    const R = window.NBDRevenue;
    if (R) {
      const ids = new Set(leads.map(l => l && l.id).filter(Boolean));
      _repInvoices.forEach(inv => {
        if (!inv || inv.deleted === true || !ids.has(inv.leadId)) return;
        R.paymentsOf(inv).forEach(p => {
          const d = toDate(p.at);
          if (!d || !inRange(d, rangeStart, rangeEnd)) return;
          const b = buckets[monthKey(d)];
          if (b) b.revenue += Number(p.amount) || 0;
        });
      });
    }

    const list = Object.values(buckets);
    const best = list.reduce((a, b) => (a && a.revenue > b.revenue) ? a : b, null);
    const total = list.reduce((sum, b) => sum + b.revenue, 0);
    return {
      months: list,
      bestMonth: best ? (best.label + ' (' + fmtMoney(best.revenue) + ')') : 'No data',
      totalRevenue: total
    };
  }

  // Per-lead velocity — used by Customer Journey. Computes days
  // elapsed at each stage the lead passed through (best-effort
  // from createdAt/updatedAt since we don't log per-stage timestamps).
  function computeLeadVelocity(lead) {
    const created = toDate(lead.createdAt);
    const updated = toDate(lead.updatedAt);
    if (!created) return null;
    const now = new Date();
    const current = updated || now;
    const daysActive = Math.floor((current - created) / (24 * 60 * 60 * 1000));
    return {
      createdAt: created,
      currentStage: lead.stage || lead._stageKey || 'unknown',
      daysInPipeline: daysActive,
      isWon: isWon(lead),
      isLost: isLost(lead)
    };
  }

  // Core KPIs — revenue, leads, close rate, pipeline value
  function computeCoreKPIs(leads, rangeStart, rangeEnd) {
    const inRangeLeads = leads.filter(l =>
      inRange(toDate(l.createdAt), rangeStart, rangeEnd)
    );
    const decidedInRange = leads.filter(l =>
      inRange(stageDate(l), rangeStart, rangeEnd)
    );
    const won = decidedInRange.filter(isWon);
    const lost = decidedInRange.filter(isLost);
    const active = leads.filter(l => !isWon(l) && !isLost(l));
    const revenue = collectedOn(leads, rangeStart, rangeEnd);
    const bookedValue = won.reduce((sum, l) => sum + (Number(l.jobValue) || 0), 0);
    const pipelineValue = active.reduce((sum, l) => sum + (Number(l.jobValue) || 0), 0);
    const total = won.length + lost.length;
    const closeRate = total > 0 ? (won.length / total) : 0;
    return {
      leadsCreated: inRangeLeads.length,
      dealsClosed: won.length,
      dealsLost: lost.length,
      revenue,
      bookedValue,
      pipelineValue,
      closeRate,
      avgJobValue: won.length > 0 ? (bookedValue / won.length) : 0
    };
  }

  // ─── UI: Generator (template picker + date range) ────────
  function renderGeneratorUI() {
    const container = document.getElementById('reportGeneratorContainer');
    if (!container) return;

    // Default date range: last 30 days
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fmtInput = (d) => d.toISOString().split('T')[0];

    container.innerHTML = `
      <div class="panel" id="reportGenPanel">
        <div class="panel-hdr">
          <div>
            <div class="panel-label">Generator</div>
            <div class="panel-title">Create a New Report</div>
          </div>
        </div>
        <div class="panel-body">
          <div style="display:grid;grid-template-columns:1fr;gap:14px;">
            <!-- Template picker -->
            <div>
              <label style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m);display:block;margin-bottom:8px;">Template</label>
              <div id="reportTemplateGrid" style="display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:10px;">
                ${renderTemplateCard('rep-monthly', 'Rep Monthly Review', '🎯', 'Per-rep coaching deep dive: knocks, deals, revenue, velocity, top cities.', true)}
                ${renderTemplateCard('territory', 'Territory Deep Dive', '🗺️', 'Best cities/zips, where to knock. Revenue-per-territory heatmap + ranked table.', true)}
                ${renderTemplateCard('pipeline-health', 'Pipeline Health Check', '📊', 'Stage funnel, velocity, bottleneck detection, stuck deals. Perfect for weekly review.', true)}
                ${renderTemplateCard('revenue-recap', 'Revenue Recap', '💰', 'Owner/partner meeting view. Revenue breakdown, avg deal, closed vs pipeline, trend.', true)}
                ${renderTemplateCard('customer-journey', 'Customer Journey', '📖', 'Full story of one customer: lead \u2192 knocks \u2192 estimate \u2192 contract \u2192 install. Pick a customer to run.', true)}
              </div>
            </div>

            <!-- Date range -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
              <div>
                <label style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m);display:block;margin-bottom:6px;">Period Start</label>
                <input type="date" id="reportRangeStart" value="${fmtInput(thirtyDaysAgo)}" style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:6px;padding:10px 12px;color:var(--t);font-family:inherit;font-size:13px;">
              </div>
              <div>
                <label style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m);display:block;margin-bottom:6px;">Period End</label>
                <input type="date" id="reportRangeEnd" value="${fmtInput(now)}" style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:6px;padding:10px 12px;color:var(--t);font-family:inherit;font-size:13px;">
              </div>
            </div>

            <!-- Quick range presets -->
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn btn-ghost" data-nr-action="setQuickRange" data-nr-id="today" style="font-size:11px;padding:6px 12px;">Today</button>
              <button class="btn btn-ghost" data-nr-action="setQuickRange" data-nr-id="week" style="font-size:11px;padding:6px 12px;">Last 7 days</button>
              <button class="btn btn-ghost" data-nr-action="setQuickRange" data-nr-id="month" style="font-size:11px;padding:6px 12px;">Last 30 days</button>
              <button class="btn btn-ghost" data-nr-action="setQuickRange" data-nr-id="quarter" style="font-size:11px;padding:6px 12px;">Last 90 days</button>
              <button class="btn btn-ghost" data-nr-action="setQuickRange" data-nr-id="year" style="font-size:11px;padding:6px 12px;">Last 12 months</button>
              <button class="btn btn-ghost" data-nr-action="setQuickRange" data-nr-id="all" style="font-size:11px;padding:6px 12px;">All time</button>
            </div>

            <!-- Comparison + AI toggles -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:14px 0 4px;border-top:1px solid var(--br);border-bottom:1px solid var(--br);">
              <div>
                <label style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m);display:block;margin-bottom:6px;">Compare Against</label>
                <select id="reportCompareMode" style="width:100%;background:var(--s2);border:1px solid var(--br);border-radius:6px;padding:10px 12px;color:var(--t);font-family:inherit;font-size:12px;">
                  <option value="none">No comparison</option>
                  <option value="prior">vs Prior period (same length)</option>
                  <option value="yoy">vs Same period last year</option>
                </select>
              </div>
              <div>
                <label style="font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--m);display:block;margin-bottom:6px;">AI Narrative</label>
                <label style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--s2);border:1px solid var(--br);border-radius:6px;cursor:pointer;">
                  <input type="checkbox" id="reportIncludeNarrative" checked style="accent-color:var(--orange,#BD5728);">
                  <span style="font-size:12px;color:var(--t);">Include Claude-written insights</span>
                </label>
              </div>
            </div>

            <!-- Generate button -->
            <button class="btn btn-orange" data-nr-action="generateSelected" style="font-size:14px;padding:14px 20px;justify-content:center;">
              📈 Generate Report
            </button>
          </div>
        </div>
      </div>
    `;
  }

  function renderTemplateCard(id, name, icon, desc, available) {
    return `
      <div class="report-template-card ${available ? 'available' : 'disabled'}" data-template="${esc(id)}"
           style="background:var(--s2);border:2px solid ${available ? 'var(--br)' : 'var(--s3)'};border-radius:8px;padding:14px;cursor:${available ? 'pointer' : 'not-allowed'};opacity:${available ? '1' : '.45'};transition:all .15s;"
           ${available ? `data-nr-action="selectTemplate" data-nr-id="${esc(id)}"` : ""}>
        <div style="font-size:24px;margin-bottom:6px;">${icon}</div>
        <div style="font-family:'Barlow Condensed',sans-serif;font-size:14px;font-weight:700;color:var(--t);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px;">${esc(name)}</div>
        <div style="font-size:11px;color:var(--m);line-height:1.4;">${esc(desc)}</div>
      </div>
    `;
  }

  // Template selection state
  let _selectedTemplate = 'rep-monthly';

  function selectTemplate(id) {
    _selectedTemplate = id;
    document.querySelectorAll('.report-template-card').forEach(c => {
      const isActive = c.dataset.template === id;
      c.style.borderColor = isActive ? 'var(--orange)' : 'var(--br)';
      c.style.background = isActive ? 'color-mix(in srgb, var(--orange) 6%, transparent)' : 'var(--s2)';
    });
  }

  function setQuickRange(key) {
    const now = new Date();
    let start;
    switch (key) {
      case 'today':   start = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
      case 'week':    start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); break;
      case 'month':   start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); break;
      case 'quarter': start = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000); break;
      case 'year':    start = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000); break;
      case 'all':     start = new Date(2020, 0, 1); break;
      default:        start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    }
    const fmtInput = (d) => d.toISOString().split('T')[0];
    const startEl = document.getElementById('reportRangeStart');
    const endEl = document.getElementById('reportRangeEnd');
    if (startEl) startEl.value = fmtInput(start);
    if (endEl) endEl.value = fmtInput(now);
  }

  async function generateSelected() {
    const startEl = document.getElementById('reportRangeStart');
    const endEl = document.getElementById('reportRangeEnd');
    const compareEl = document.getElementById('reportCompareMode');
    const narrativeEl = document.getElementById('reportIncludeNarrative');
    if (!startEl || !endEl) return;
    const rangeStart = new Date(startEl.value + 'T00:00:00');
    const rangeEnd = new Date(endEl.value + 'T23:59:59');
    if (rangeStart > rangeEnd) {
      if (typeof showToast === 'function') showToast('Start date must be before end date', 'error');
      return;
    }
    const compareMode = compareEl ? compareEl.value : 'none';
    const includeNarrative = narrativeEl ? !!narrativeEl.checked : false;
    await generate(_selectedTemplate, { rangeStart, rangeEnd, compareMode, includeNarrative });
  }

  // ─── Delta helper (used by templates when comparison enabled) ─
  // Returns an HTML chip showing the +/- delta vs a comparison
  // value. Colors: green for up, red for down, gray for no change.
  // Used as string interpolation inside template HTML, so the
  // output is pre-escaped and safe for innerHTML.
  function deltaChip(current, prior, opts) {
    opts = opts || {};
    const format = opts.format || 'number';  // 'number' | 'money' | 'percent'
    const invert = !!opts.invert;  // true if down is good (e.g. knocks-per-deal)
    if (prior == null || current == null || isNaN(prior) || isNaN(current)) return '';
    if (prior === 0 && current === 0) {
      return '<span class="delta-chip flat">—</span>';
    }
    if (prior === 0) {
      return '<span class="delta-chip up">NEW</span>';
    }
    const diff = current - prior;
    const pct = ((current - prior) / Math.abs(prior)) * 100;
    const up = diff > 0;
    const colorClass = up === !invert ? 'up' : 'down';
    const arrow = up ? '▲' : '▼';
    const pctFmt = Math.abs(pct).toFixed(0) + '%';
    return '<span class="delta-chip ' + colorClass + '">' + arrow + ' ' + pctFmt + '</span>';
  }

  // ─── Narrative generators (Stage 4) ──────────────────────
  // Build a compact data summary for Claude. Not the full metrics
  // object — only the high-signal numbers so the prompt stays under
  // 500 input tokens and Claude can focus on insights.
  function buildNarrativePrompt(templateName, metrics, comparison, opts) {
    const core = metrics.core || {};
    const k2d = metrics.knocksToDeal || {};
    const heat = metrics.heatmap || {};
    const velocity = metrics.velocity || {};
    const rpk = metrics.revenuePerKnock || {};
    const topCity = (metrics.topCities && metrics.topCities.topCities && metrics.topCities.topCities[0]) || null;
    const stuck = metrics.stuckDeals || {};
    const trend = metrics.revenueTrend || {};

    const periodLabel = fmtDate(opts.rangeStart) + ' to ' + fmtDate(opts.rangeEnd);
    const lines = [
      'Report: ' + templateName,
      'Rep: ' + (opts.repName || 'Rep'),
      'Period: ' + periodLabel,
      'Revenue collected: ' + fmtMoney(core.revenue) + ' (' + (core.dealsClosed || 0) + ' deals closed, ' + fmtMoney(core.bookedValue || 0) + ' booked)',
      'Close rate: ' + fmtPct(core.closeRate || 0),
      'Pipeline value: ' + fmtMoney(core.pipelineValue) + ' (' + (core.leadsCreated || 0) + ' new leads)',
      'Avg deal size: ' + fmtMoney(core.avgJobValue)
    ];
    if (k2d.totalKnocks != null) {
      lines.push('Total knocks: ' + k2d.totalKnocks + ' · knocks per deal: ' + (k2d.knocksPerDeal ? Math.round(k2d.knocksPerDeal) : '—'));
    }
    if (heat.bestSlot) lines.push('Best time slot: ' + heat.bestSlot);
    if (rpk.revenuePerKnock) lines.push('Revenue per knock: ' + fmtMoney(rpk.revenuePerKnock));
    if (topCity) lines.push('Top territory: ' + topCity.city + ' (' + topCity.deals + ' deals, ' + fmtMoney(topCity.revenue) + ')');
    if (velocity.bottleneck) lines.push('Pipeline bottleneck: ' + velocity.bottleneck);
    if (stuck.count != null && stuck.count > 0) lines.push('Stuck deals: ' + stuck.count + ' worth ' + fmtMoney(stuck.totalValue));
    if (trend.bestMonth) lines.push('Best month: ' + trend.bestMonth);

    if (comparison && comparison.metrics && comparison.metrics.core) {
      const priorCore = comparison.metrics.core;
      lines.push('--- Compared period (' + comparison.mode + ') ---');
      lines.push('Prior revenue (collected): ' + fmtMoney(priorCore.revenue));
      lines.push('Prior deals: ' + priorCore.dealsClosed);
      lines.push('Prior close rate: ' + fmtPct(priorCore.closeRate || 0));
    }

    return lines.join('\n');
  }

  async function generateNarrative(templateName, metrics, comparison, opts) {
    const dataSummary = buildNarrativePrompt(templateName, metrics, comparison, opts);
    const systemPrompt = 'You are an expert sales coach writing a short insight paragraph '
      + 'for a roofing contractor rep performance report. Your audience is the rep and '
      + 'the owner. Write 3-4 sentences maximum. Focus on what the numbers mean, call out '
      + 'one specific strength and one specific thing to improve. Use plain English, no '
      + 'jargon. Never invent numbers not in the data. If comparison data is present, '
      + 'mention the trend. Never use markdown, bullets, or section headers — just plain '
      + 'prose sentences. Keep it under 400 characters total. Do not use exclamation marks.';
    const result = await window.callClaude({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: 'user', content: dataSummary }]
    });
    if (!result || !result.content || !result.content[0] || !result.content[0].text) {
      throw new Error('Claude returned empty response');
    }
    return result.content[0].text.trim();
  }

  // Deterministic fallback when Claude isn't available or errors.
  // Never as good as Claude but always works and never fails.
  function buildFallbackNarrative(templateName, metrics, comparison) {
    const core = metrics.core || {};
    const k2d = metrics.knocksToDeal || {};
    const topCity = (metrics.topCities && metrics.topCities.topCities && metrics.topCities.topCities[0]) || null;
    const parts = [];
    if (core.revenue > 0) {
      // Revenue is money COLLECTED (Jo, 2026-09-28) — it is not what the
      // closed deals were worth, so don't say the cash "closed across" them.
      parts.push(fmtMoney(core.revenue) + ' collected; ' + (core.dealsClosed || 0) + ' deals closed worth ' + fmtMoney(core.bookedValue || 0) + ' booked (avg ' + fmtMoney(core.avgJobValue) + ').');
    } else {
      parts.push('No revenue collected in this period — pipeline has ' + (core.leadsCreated || 0) + ' new leads worth ' + fmtMoney(core.pipelineValue) + '.');
    }
    if (k2d.totalKnocks > 0 && k2d.dealsClosed > 0) {
      parts.push('Conversion sits at ' + Math.round(k2d.knocksPerDeal) + ' knocks per deal across ' + k2d.totalKnocks + ' total doors.');
    }
    if (topCity && topCity.deals > 0) {
      parts.push('Top territory is ' + topCity.city + ' (' + topCity.deals + ' deals, ' + fmtMoney(topCity.revenue) + ').');
    }
    if (comparison && comparison.metrics && comparison.metrics.core) {
      const priorRev = comparison.metrics.core.revenue || 0;
      if (priorRev > 0) {
        const pct = Math.round(((core.revenue - priorRev) / priorRev) * 100);
        parts.push('Revenue is ' + (pct >= 0 ? 'up ' : 'down ') + Math.abs(pct) + '% vs the ' + (comparison.mode === 'yoy' ? 'same period last year' : 'prior period') + '.');
      }
    }
    return parts.join(' ');
  }

  // ─── Template registry ───────────────────────────────────
  // Each entry declares how to: (1) prompt for any extra input
  // (Customer Journey needs a lead ID), (2) compute metrics, and
  // (3) build the HTML. Adding a 6th template means adding one
  // entry to this object — the dispatcher below doesn't change.
  const TEMPLATES = {
    'rep-monthly': {
      name: 'Rep Monthly Review',
      icon: '🎯',
      filenamePrefix: 'Monthly',
      buildHTML: (metrics, meta) => buildRepMonthlyReviewHTML(metrics, meta),
      computeMetrics: (leads, knocks, estimates, rangeStart, rangeEnd) => ({
        core: computeCoreKPIs(leads, rangeStart, rangeEnd),
        knocksToDeal: computeKnocksToDeal(leads, knocks, rangeStart, rangeEnd),
        heatmap: computeTimeOfDayHeatmap(knocks, rangeStart, rangeEnd),
        topCities: computeTopCitiesZips(knocks, leads, rangeStart, rangeEnd),
        velocity: computePipelineVelocity(leads, rangeStart, rangeEnd),
        revenuePerKnock: computeRevenuePerKnock(leads, knocks, rangeStart, rangeEnd),
        estimateAccuracy: computeEstimateAccuracy(estimates, leads, rangeStart, rangeEnd)
      })
    },
    'territory': {
      name: 'Territory Deep Dive',
      icon: '🗺️',
      filenamePrefix: 'Territory',
      buildHTML: (metrics, meta) => buildTerritoryDeepDiveHTML(metrics, meta),
      computeMetrics: (leads, knocks, estimates, rangeStart, rangeEnd) => ({
        core: computeCoreKPIs(leads, rangeStart, rangeEnd),
        topCities: computeTopCitiesZips(knocks, leads, rangeStart, rangeEnd),
        heatmap: computeTimeOfDayHeatmap(knocks, rangeStart, rangeEnd),
        revenuePerKnock: computeRevenuePerKnock(leads, knocks, rangeStart, rangeEnd),
        knocksToDeal: computeKnocksToDeal(leads, knocks, rangeStart, rangeEnd)
      })
    },
    'pipeline-health': {
      name: 'Pipeline Health Check',
      icon: '📊',
      filenamePrefix: 'PipelineHealth',
      buildHTML: (metrics, meta) => buildPipelineHealthHTML(metrics, meta),
      computeMetrics: (leads, knocks, estimates, rangeStart, rangeEnd) => ({
        core: computeCoreKPIs(leads, rangeStart, rangeEnd),
        velocity: computePipelineVelocity(leads, rangeStart, rangeEnd),
        funnel: computePipelineFunnel(leads, rangeStart, rangeEnd),
        stuckDeals: computeStuckDeals(leads)
      })
    },
    'revenue-recap': {
      name: 'Revenue Recap',
      icon: '💰',
      filenamePrefix: 'Revenue',
      buildHTML: (metrics, meta) => buildRevenueRecapHTML(metrics, meta),
      computeMetrics: (leads, knocks, estimates, rangeStart, rangeEnd) => ({
        core: computeCoreKPIs(leads, rangeStart, rangeEnd),
        revenueTrend: computeRevenueTrend(leads, rangeStart, rangeEnd),
        topCities: computeTopCitiesZips(knocks, leads, rangeStart, rangeEnd),
        velocity: computePipelineVelocity(leads, rangeStart, rangeEnd)
      })
    },
    'customer-journey': {
      name: 'Customer Journey',
      icon: '📖',
      filenamePrefix: 'Journey',
      buildHTML: (metrics, meta) => buildCustomerJourneyHTML(metrics, meta),
      // Needs a lead picker — handled specially in generate()
      requiresLead: true,
      computeMetrics: (leads, knocks, estimates, rangeStart, rangeEnd, opts) => ({
        lead: opts.lead || null,
        knocks: knocks.filter(k => k.leadId === opts.leadId || (opts.lead && opts.lead.address && k.address && String(k.address).includes(String(opts.lead.address).split(',')[0]))),
        estimates: estimates.filter(e => e.leadId === opts.leadId),
        velocity: opts.lead ? computeLeadVelocity(opts.lead) : null
      })
    }
  };

  // window._knocks is published by the Analytics (Board) view's fetch — so a
  // rep who opens Reports WITHOUT visiting Board first would otherwise get an
  // empty array and see every knock metric (knocks-to-deal, heatmap,
  // revenue-per-knock, top-cities) silently render zero. Load the rep's knocks
  // on demand here (owner-scoped, unbounded — a single-field where needs no
  // composite index) the first time, and only when not already cached.
  async function ensureKnocks() {
    if (Array.isArray(window._knocks)) return; // already loaded (even if empty)
    const db = window._db || window.db;
    const uid = window._user && window._user.uid;
    if (!db || !uid || !window.collection || !window.query || !window.where || !window.getDocs) {
      window._knocks = Array.isArray(window._knocks) ? window._knocks : [];
      return;
    }
    try {
      const snap = await window.getDocs(
        window.query(window.collection(db, 'knocks'), window.where('userId', '==', uid))
      );
      window._knocks = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    } catch (e) {
      window._knocks = Array.isArray(window._knocks) ? window._knocks : [];
    }
  }

  // ─── Generate + open report ──────────────────────────────
  async function generate(template, opts) {
    opts = opts || {};
    const tmpl = TEMPLATES[template];
    if (!tmpl) {
      if (typeof showToast === 'function') {
        showToast('Unknown template: ' + template, 'error');
      }
      return;
    }

    await ensureKnocks();
    _repInvoices = window.NBDRevenue ? await window.NBDRevenue.loadInvoices() : [];
    const leads = window._leads || [];
    const knocks = window._knocks || [];
    const estimates = window._estimates || [];
    const rangeStart = opts.rangeStart || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const rangeEnd = opts.rangeEnd || new Date();

    // Customer Journey needs a specific lead — show a picker if
    // one wasn't passed via opts.leadId.
    if (tmpl.requiresLead && !opts.leadId) {
      showLeadPicker((leadId) => {
        const lead = (window._leads || []).find(l => l.id === leadId);
        if (!lead) {
          if (typeof showToast === 'function') showToast('Customer not found', 'error');
          return;
        }
        generate(template, Object.assign({}, opts, { leadId, lead }));
      });
      return;
    }

    // Compute metrics via the template's calculator bundle
    const metrics = tmpl.computeMetrics(leads, knocks, estimates, rangeStart, rangeEnd, opts);

    // ─ Comparison period (Stage 4) ─
    // If the user picked a comparison mode, compute metrics for
    // the prior period using the same calculator bundle. Template
    // builders see `meta.comparison` and can render delta chips.
    let comparison = null;
    if (opts.compareMode && opts.compareMode !== 'none') {
      const rangeMs = rangeEnd.getTime() - rangeStart.getTime();
      let compareStart, compareEnd;
      if (opts.compareMode === 'yoy') {
        compareStart = new Date(rangeStart);
        compareStart.setFullYear(compareStart.getFullYear() - 1);
        compareEnd = new Date(rangeEnd);
        compareEnd.setFullYear(compareEnd.getFullYear() - 1);
      } else {
        // 'prior' — immediately preceding period of the same length
        compareEnd = new Date(rangeStart.getTime() - 1);
        compareStart = new Date(compareEnd.getTime() - rangeMs);
      }
      try {
        const compareMetrics = tmpl.computeMetrics(leads, knocks, estimates, compareStart, compareEnd, opts);
        comparison = {
          mode: opts.compareMode,
          rangeStart: compareStart,
          rangeEnd: compareEnd,
          metrics: compareMetrics
        };
      } catch (e) {
        console.warn('[Reports] comparison calc failed:', e);
      }
    }

    // ─ Narrative (Stage 4) ─
    // Claude-written 3-4 sentence insight paragraph at the top
    // of the report. If it fails (no API key, network, etc), the
    // template falls back to a deterministic templated summary —
    // we never fail the report because the narrative couldn't
    // generate.
    let narrative = null;
    if (opts.includeNarrative !== false) {
      if (typeof window.callClaude === 'function') {
        try {
          narrative = await generateNarrative(tmpl.name, metrics, comparison, {
            rangeStart, rangeEnd, repName: window._user?.displayName || 'Rep'
          });
        } catch (e) {
          console.warn('[Reports] Claude narrative failed — falling back to templated:', e.message);
          narrative = buildFallbackNarrative(tmpl.name, metrics, comparison);
        }
      } else {
        narrative = buildFallbackNarrative(tmpl.name, metrics, comparison);
      }
    }

    // Build report HTML
    const meta = {
      template,
      templateName: tmpl.name,
      rangeStart,
      rangeEnd,
      comparison,
      narrative,
      rep: {
        name: window._user?.displayName || window._user?.email || 'Rep',
        email: window._user?.email || '',
        uid: window._user?.uid || ''
      }
    };
    const html = tmpl.buildHTML(metrics, meta);

    // Firestore can't serialize plain JS Date objects inside nested
    // fields reliably (it needs Timestamp). Deep-clone via JSON so
    // Dates become ISO strings — then the My Reports view can show
    // them without a re-computation.
    let metricsForStorage;
    try {
      metricsForStorage = JSON.parse(JSON.stringify(metrics));
    } catch (e) {
      metricsForStorage = null;
    }

    // Save to Firestore. The persist is best-effort relative to SHOWING the
    // report: the rep asked to see it, and losing the render because the write
    // failed would be the worse outcome. But the failure must be visible —
    // _saveReport used to swallow it and return null, so a rejected write was
    // indistinguishable from success and the report just quietly was not in My
    // Reports afterwards. Surface it and carry on.
    let reportId = null;
    try {
      reportId = await saveReport({
        name: tmpl.name + ' — ' + fmtDate(rangeStart) + ' to ' + fmtDate(rangeEnd),
        template,
        rangeStart: rangeStart.toISOString(),
        rangeEnd: rangeEnd.toISOString(),
        html, // stored so re-open is instant
        metrics: metricsForStorage
      });
    } catch (saveErr) {
      console.error('[Reports] save failed:', saveErr);
      if (typeof showToast === 'function') {
        showToast("Report generated, but couldn't be saved to My Reports", 'warning');
      }
    }

    // Open in NBDDocViewer
    if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
      // Tenant-resolved prefix — '' when the brand is not hydrated, never 'NBD'.
      const _genBase = 'Report-' + tmpl.filenamePrefix + '-' + fmtDate(rangeStart).replace(/,/g, '').replace(/\s/g, '') + '.pdf';
      const _genName = window._tenantFileName ? await window._tenantFileName(_genBase) : _genBase;
      window.NBDDocViewer.open({
        html,
        title: tmpl.name + ' — ' + meta.rep.name,
        filename: _genName,
        onSave: async () => {
          if (typeof showToast === 'function') {
            showToast('✓ Report saved to My Reports', 'success');
          }
        }
      });
    } else {
      if (typeof showToast === 'function') showToast('Doc viewer not loaded', 'error');
    }

    // Refresh the My Reports list
    await listSavedReports();
    return reportId;
  }

  // ─── Build HTML for Rep Monthly Review template ──────────
  function buildRepMonthlyReviewHTML(metrics, meta) {
    const { core, knocksToDeal, heatmap, topCities, velocity, revenuePerKnock, estimateAccuracy } = metrics;
    const periodLabel = fmtDate(meta.rangeStart) + ' → ' + fmtDate(meta.rangeEnd);
    const repName = esc(meta.rep.name || 'Rep');
    const priorCore = (meta.comparison && meta.comparison.metrics && meta.comparison.metrics.core) || null;
    // AI narrative block (optional)
    const narrativeBlock = meta.narrative
      ? `<div class="narrative">
          <div class="narrative-badge">AI Insight</div>
          <div class="narrative-label">Coach's Note</div>
          <div class="narrative-text">${esc(meta.narrative)}</div>
        </div>`
      : '';

    // Top cities list HTML
    const cityRows = (topCities.topCities || []).slice(0, 5).map((c, i) => `
      <div class="city-row">
        <div class="city-rank">${i + 1}</div>
        <div class="city-body">
          <div class="city-name">${esc(c.city)}</div>
          <div class="city-stats">${fmtNumber(c.knocks)} knocks · ${fmtNumber(c.deals)} deals · ${fmtMoney(c.revenue)}</div>
        </div>
      </div>
    `).join('') || '<div class="empty-state">No geographic data yet.</div>';

    // Velocity rows
    const velocityRows = (velocity.stages || []).slice(0, 8).map(s => `
      <div class="velocity-row">
        <div class="velocity-stage">${esc(s.stage)}</div>
        <div class="velocity-bar-wrap">
          <div class="velocity-bar" style="width:${Math.min(100, (s.avgDays / 30) * 100)}%"></div>
        </div>
        <div class="velocity-days">${s.avgDays.toFixed(1)} days</div>
        <div class="velocity-count">${s.count} leads</div>
      </div>
    `).join('') || '<div class="empty-state">No pipeline velocity data yet.</div>';

    return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Rep Monthly Review — ${repName}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Barlow', sans-serif;
    color: #111;
    background: #f7f7f5;
    padding: 0;
    line-height: 1.5;
  }
  .report-page {
    max-width: 960px;
    margin: 0 auto;
    background: #fff;
    padding: 0;
  }
  /* Wave 28: rep-report renders inside the docViewer modal on mobile
     (and inside the print viewport on desktop). The doc-viewer wraps
     in overflow-x:auto so wide table content can scroll, but the
     chart containers themselves shouldn't try to exceed the visible
     content width — static SVG/grid charts size to their container. */
  .report-page > * { max-width:100%; }
  .report-page canvas, .report-page svg { max-width:100% !important; }
  @media (max-width:600px) {
    .report-page { font-size:13px; }
  }

  /* ── HEADER ── */
  .report-hdr {
    background: #0a0c0f;
    color: #fff;
    padding: 40px 56px 32px;
    position: relative;
    overflow: hidden;
  }
  .report-hdr::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 6px;
    background: linear-gradient(90deg, #BD5728, #ff9030);
  }
  .report-brand {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 13px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: .2em;
    color: var(--orange,#BD5728);
    margin-bottom: 10px;
  }
  .report-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 52px;
    font-weight: 800;
    line-height: 1;
    text-transform: uppercase;
    letter-spacing: -.01em;
    margin-bottom: 12px;
  }
  .report-subtitle {
    font-size: 14px;
    color: #c7cad1;
    margin-bottom: 6px;
  }
  .report-period {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 11px;
    color: var(--orange,#BD5728);
    text-transform: uppercase;
    letter-spacing: .15em;
  }

  /* ── HERO NUMBERS ── */
  .hero-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    background: #111418;
    color: #fff;
  }
  .hero-cell {
    padding: 28px 20px;
    border-right: 1px solid #2a2f35;
    border-bottom: 1px solid #2a2f35;
  }
  .hero-cell:last-child { border-right: none; }
  .hero-label {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 10px;
    color: #8b8e96;
    text-transform: uppercase;
    letter-spacing: .15em;
    margin-bottom: 6px;
  }
  .hero-value {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 38px;
    font-weight: 800;
    color: #fff;
    line-height: 1;
    margin-bottom: 4px;
  }
  .hero-value.orange { color: var(--orange,#BD5728); }
  .hero-sub {
    font-size: 11px;
    color: #8b8e96;
  }

  /* ── SECTION ── */
  .section {
    padding: 40px 56px;
    border-bottom: 1px solid #eee;
  }
  .section-label {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .18em;
    color: var(--orange,#BD5728);
    margin-bottom: 8px;
  }
  .section-title {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 28px;
    font-weight: 800;
    text-transform: uppercase;
    color: #111;
    margin-bottom: 6px;
    line-height: 1;
  }
  .section-desc {
    font-size: 13px;
    color: #666;
    margin-bottom: 24px;
  }

  /* ── METRIC ROW ── */
  .metric-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 30px;
    margin-bottom: 30px;
  }
  .metric-card {
    background: #f7f7f5;
    border-left: 4px solid #BD5728;
    padding: 20px 24px;
  }
  .metric-card-label {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .12em;
    color: #999;
    margin-bottom: 4px;
  }
  .metric-card-value {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 34px;
    font-weight: 800;
    color: #111;
    line-height: 1;
    margin-bottom: 4px;
  }
  .metric-card-sub {
    font-size: 12px;
    color: #666;
  }

  /* ── CITY LIST ── */
  .city-row {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 14px 0;
    border-bottom: 1px solid #eee;
  }
  .city-row:last-child { border-bottom: none; }
  .city-rank {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 28px;
    font-weight: 800;
    color: var(--orange,#BD5728);
    line-height: 1;
    min-width: 36px;
  }
  .city-body { flex: 1; }
  .city-name {
    font-family: 'Barlow Condensed', sans-serif;
    font-size: 18px;
    font-weight: 700;
    color: #111;
    text-transform: uppercase;
  }
  .city-stats {
    font-size: 11px;
    color: #666;
    margin-top: 2px;
  }

  /* ── VELOCITY BARS ── */
  .velocity-row {
    display: grid;
    grid-template-columns: 140px 1fr 80px 80px;
    gap: 12px;
    align-items: center;
    padding: 10px 0;
    font-size: 12px;
  }
  .velocity-stage {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    text-transform: uppercase;
    color: #111;
    letter-spacing: .04em;
  }
  .velocity-bar-wrap {
    height: 10px;
    background: #eee;
    border-radius: 5px;
    overflow: hidden;
  }
  .velocity-bar {
    height: 100%;
    background: linear-gradient(90deg, #BD5728, #ff9030);
    border-radius: 5px;
  }
  .velocity-days {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 700;
    color: var(--orange,#BD5728);
    text-align: right;
  }
  .velocity-count {
    font-size: 11px;
    color: #999;
    text-align: right;
  }

  /* ── FOOTER ── */
  .report-footer {
    background: #0a0c0f;
    color: #8b8e96;
    padding: 24px 56px;
    display: flex;
    justify-content: space-between;
    font-size: 10px;
  }
  .report-footer-brand {
    font-family: 'Barlow Condensed', sans-serif;
    font-weight: 800;
    letter-spacing: .1em;
    color: #fff;
  }
  .report-footer-brand span { color: var(--orange,#BD5728); }

  .empty-state {
    padding: 20px;
    text-align: center;
    color: #999;
    font-style: italic;
    font-size: 12px;
  }

  /* ── CHART CONTAINER ── */
  .chart-box {
    background: #fafaf9;
    padding: 20px;
    border-radius: 8px;
    border: 1px solid #eee;
    min-height: 300px;
  }
  /* AI "Coach's Note" — same rules as the shared report shell. This template
     builds its own page and never had them, so the note rendered as bare
     text flush against the page edge (CRM sweep R14, 2026-09-28). */
  .narrative { background: #fff8f0; border-left: 5px solid #BD5728; padding: 24px 28px; margin: 0; border-bottom: 1px solid #eee; position: relative; }
  .narrative-label { font-family: 'Barlow Condensed', sans-serif; font-size: 10px; font-weight: 800; letter-spacing: .18em; color: var(--orange,#BD5728); text-transform: uppercase; margin-bottom: 8px; }
  .narrative-text { font-size: 16px; line-height: 1.6; color: #1a1a1a; font-weight: 500; }
  .narrative-badge { position: absolute; top: 12px; right: 20px; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--orange,#BD5728); background: #fff; border: 1px solid rgba(189,87,40,.3); padding: 3px 8px; border-radius: 10px; }
${STATIC_CHART_CSS}
  @media print {
    body { background: #fff; }
    .report-page { max-width: 100%; padding: 0; }
    .section { page-break-inside: avoid; }
    @page { margin: 0.5cm; size: letter; }
  }
</style>
</head>
<body>
  <div class="report-page">
    <!-- HEADER -->
    <div class="report-hdr">
      <div class="report-brand">NBD <span style="color:#fff;">PRO</span> — MONTHLY REVIEW</div>
      <div class="report-title">${repName}</div>
      <div class="report-subtitle">Personal performance review and coaching insights</div>
      <div class="report-period">${esc(periodLabel)}</div>
    </div>
    ${narrativeBlock}

    <!-- HERO NUMBERS -->
    <div class="hero-grid">
      <div class="hero-cell">
        <div class="hero-label">Revenue Collected</div>
        <div class="hero-value orange">${fmtMoney(core.revenue)} ${priorCore ? deltaChip(core.revenue, priorCore.revenue) : ''}</div>
        <div class="hero-sub">${fmtNumber(core.dealsClosed)} deals closed · ${fmtMoney(core.bookedValue || 0)} booked</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Close Rate</div>
        <div class="hero-value">${fmtPct(core.closeRate)} ${priorCore ? deltaChip(core.closeRate, priorCore.closeRate) : ''}</div>
        <div class="hero-sub">${fmtNumber(core.dealsClosed)}W / ${fmtNumber(core.dealsLost)}L</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Pipeline Value</div>
        <div class="hero-value">${fmtMoney(core.pipelineValue)} ${priorCore ? deltaChip(core.pipelineValue, priorCore.pipelineValue) : ''}</div>
        <div class="hero-sub">${fmtNumber(core.leadsCreated)} new leads</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Avg Deal Size</div>
        <div class="hero-value">${fmtMoney(core.avgJobValue)} ${priorCore ? deltaChip(core.avgJobValue, priorCore.avgJobValue) : ''}</div>
        <div class="hero-sub">per closed deal</div>
      </div>
    </div>

    <!-- KNOCKS + CONVERSION -->
    <div class="section">
      <div class="section-label">Door-to-Door Performance</div>
      <div class="section-title">Knocks & Conversion</div>
      <div class="section-desc">Your field activity and how efficiently you're converting doors to deals.</div>
      <div class="metric-row">
        <div class="metric-card">
          <div class="metric-card-label">Total Knocks</div>
          <div class="metric-card-value">${fmtNumber(knocksToDeal.totalKnocks)}</div>
          <div class="metric-card-sub">${fmtNumber(knocksToDeal.dealsClosed)} deals closed from this activity</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">Knocks per Deal</div>
          <div class="metric-card-value">${knocksToDeal.dealsClosed > 0 ? Math.round(knocksToDeal.knocksPerDeal) : '—'}</div>
          <div class="metric-card-sub">${esc(knocksToDeal.display)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">Revenue per Knock</div>
          <div class="metric-card-value">${fmtMoney(revenuePerKnock.revenuePerKnock)}</div>
          <div class="metric-card-sub">${esc(revenuePerKnock.display)}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">Estimate Accuracy</div>
          <div class="metric-card-value">${estimateAccuracy.sampleCount > 0 ? ((estimateAccuracy.accuracy * 100).toFixed(0) + '%') : '—'}</div>
          <div class="metric-card-sub">${esc(estimateAccuracy.display)}</div>
        </div>
      </div>
    </div>

    <!-- TIME-OF-DAY HEATMAP -->
    <div class="section">
      <div class="section-label">When You Knock Best</div>
      <div class="section-title">Activity Heatmap</div>
      <div class="section-desc">Hour × day grid showing your knocking pattern <span style="opacity:.7;">(local time)</span>. Best slot: <strong>${esc(heatmap.bestSlot)}</strong></div>
      <div class="chart-box" id="heatmap-chart">${(heatmap.series && heatmap.series.length) ? renderStaticHeatmap(heatmap.series) : '<div style="padding:40px;text-align:center;color:#999;">No activity data yet.</div>'}</div>
    </div>

    <!-- TOP CITIES -->
    <div class="section">
      <div class="section-label">Where You Work Best</div>
      <div class="section-title">Top Territories</div>
      <div class="section-desc">Cities ranked by total performance (deals weight 1000x, appointments 10x, knocks 1x).</div>
      ${cityRows}
    </div>

    <!-- PIPELINE VELOCITY -->
    <div class="section">
      <div class="section-label">How Fast Deals Move</div>
      <div class="section-title">Pipeline Velocity</div>
      <div class="section-desc">Average days a lead spends in each stage. Bottleneck: <strong>${esc(velocity.bottleneck)}</strong></div>
      ${velocityRows}
    </div>

    <!-- FOOTER -->
    <div class="report-footer">
      <div>
        <div class="report-footer-brand">NBD <span>PRO</span></div>
        <div>nobigdealwithjoedeal.com · Generated ${fmtDate(new Date())}</div>
      </div>
      <div style="text-align:right;">
        <div style="color:#fff;font-weight:700;">${repName}</div>
        <div>${esc(meta.rep.email)}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
  }

  // ═══════════════════════════════════════════════════════════
  // Shared report shell — the header, footer, and base CSS that
  // every template uses. Each template injects its own <body>
  // content (charts are static HTML/SVG built at generation time).
  // ═══════════════════════════════════════════════════════════
  function reportShell(opts) {
    const repName = esc(opts.repName || 'Rep');
    const periodLabel = esc(opts.periodLabel || '');
    const eyebrow = esc(opts.eyebrow || 'NBD PRO REPORT');
    const title = esc(opts.title || 'Report');
    const subtitle = esc(opts.subtitle || '');
    // Narrative block appears immediately below the dark header
    // if Claude (or the fallback) produced one.
    const narrativeBlock = opts.narrative
      ? `
    <div class="narrative">
      <div class="narrative-badge">AI Insight</div>
      <div class="narrative-label">Coach's Note</div>
      <div class="narrative-text">${esc(opts.narrative)}</div>
    </div>`
      : '';
    return {
      head: `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>${title} — ${repName}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Barlow', sans-serif; color: #111; background: #f7f7f5; padding: 0; line-height: 1.5; }
  .report-page { max-width: 960px; margin: 0 auto; background: #fff; }
  .report-hdr { background: #0a0c0f; color: #fff; padding: 40px 56px 32px; position: relative; overflow: hidden; }
  .report-hdr::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 6px; background: linear-gradient(90deg, #BD5728, #ff9030); }
  .report-brand { font-family: 'Barlow Condensed', sans-serif; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: .2em; color: var(--orange,#BD5728); margin-bottom: 10px; }
  .report-brand span { color: #fff; }
  .report-title { font-family: 'Barlow Condensed', sans-serif; font-size: 52px; font-weight: 800; line-height: 1; text-transform: uppercase; letter-spacing: -.01em; margin-bottom: 12px; }
  .report-subtitle { font-size: 14px; color: #c7cad1; margin-bottom: 6px; }
  .report-period { font-family: 'Barlow Condensed', sans-serif; font-size: 11px; color: var(--orange,#BD5728); text-transform: uppercase; letter-spacing: .15em; }
  .hero-grid { display: grid; grid-template-columns: repeat(4, 1fr); background: #111418; color: #fff; }
  .hero-cell { padding: 28px 20px; border-right: 1px solid #2a2f35; border-bottom: 1px solid #2a2f35; }
  .hero-cell:last-child { border-right: none; }
  .hero-label { font-family: 'Barlow Condensed', sans-serif; font-size: 10px; color: #8b8e96; text-transform: uppercase; letter-spacing: .15em; margin-bottom: 6px; }
  .hero-value { font-family: 'Barlow Condensed', sans-serif; font-size: 38px; font-weight: 800; color: #fff; line-height: 1; margin-bottom: 4px; }
  .hero-value.orange { color: var(--orange,#BD5728); }
  .hero-sub { font-size: 11px; color: #8b8e96; }
  .section { padding: 40px 56px; border-bottom: 1px solid #eee; }
  .section-label { font-family: 'Barlow Condensed', sans-serif; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .18em; color: var(--orange,#BD5728); margin-bottom: 8px; }
  .section-title { font-family: 'Barlow Condensed', sans-serif; font-size: 28px; font-weight: 800; text-transform: uppercase; color: #111; margin-bottom: 6px; line-height: 1; }
  .section-desc { font-size: 13px; color: #666; margin-bottom: 24px; }
  .metric-row { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-bottom: 30px; }
  .metric-card { background: #f7f7f5; border-left: 4px solid #BD5728; padding: 20px 24px; }
  .metric-card-label { font-family: 'Barlow Condensed', sans-serif; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .12em; color: #999; margin-bottom: 4px; }
  .metric-card-value { font-family: 'Barlow Condensed', sans-serif; font-size: 34px; font-weight: 800; color: #111; line-height: 1; margin-bottom: 4px; }
  .metric-card-sub { font-size: 12px; color: #666; }
  .city-row { display: flex; align-items: center; gap: 16px; padding: 14px 0; border-bottom: 1px solid #eee; }
  .city-row:last-child { border-bottom: none; }
  .city-rank { font-family: 'Barlow Condensed', sans-serif; font-size: 28px; font-weight: 800; color: var(--orange,#BD5728); line-height: 1; min-width: 36px; }
  .city-body { flex: 1; }
  .city-name { font-family: 'Barlow Condensed', sans-serif; font-size: 18px; font-weight: 700; color: #111; text-transform: uppercase; }
  .city-stats { font-size: 11px; color: #666; margin-top: 2px; }
  .velocity-row { display: grid; grid-template-columns: 140px 1fr 80px 80px; gap: 12px; align-items: center; padding: 10px 0; font-size: 12px; }
  .velocity-stage { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; text-transform: uppercase; color: #111; letter-spacing: .04em; }
  .velocity-bar-wrap { height: 10px; background: #eee; border-radius: 5px; overflow: hidden; }
  .velocity-bar { height: 100%; background: linear-gradient(90deg, #BD5728, #ff9030); border-radius: 5px; }
  .velocity-days { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; color: var(--orange,#BD5728); text-align: right; }
  .velocity-count { font-size: 11px; color: #999; text-align: right; }
  .report-footer { background: #0a0c0f; color: #8b8e96; padding: 24px 56px; display: flex; justify-content: space-between; font-size: 10px; }
  .report-footer-brand { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; letter-spacing: .1em; color: #fff; }
  .report-footer-brand span { color: var(--orange,#BD5728); }
  .empty-state { padding: 20px; text-align: center; color: #999; font-style: italic; font-size: 12px; }
  .chart-box { background: #fafaf9; padding: 20px; border-radius: 8px; border: 1px solid #eee; min-height: 300px; }
  .stuck-row { display: grid; grid-template-columns: 1fr 90px 90px 90px; gap: 12px; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; font-size: 12px; }
  .stuck-row:last-child { border-bottom: none; }
  .stuck-name { font-weight: 700; color: #111; }
  .stuck-addr { font-size: 11px; color: #666; margin-top: 2px; }
  .stuck-days { font-family: 'Barlow Condensed', sans-serif; font-weight: 800; color: #c53030; text-align: right; font-size: 16px; }
  .stuck-value { font-family: 'Barlow Condensed', sans-serif; font-weight: 700; color: var(--orange,#BD5728); text-align: right; font-size: 14px; }
  .stuck-stage { font-size: 10px; color: #999; text-align: right; text-transform: uppercase; letter-spacing: .05em; }
  /* Delta chip — up/down comparison vs prior period */
  .delta-chip { display: inline-block; font-family: 'Barlow Condensed', sans-serif; font-size: 10px; font-weight: 800; letter-spacing: .04em; padding: 2px 6px; border-radius: 3px; margin-left: 6px; text-transform: uppercase; vertical-align: middle; }
  .delta-chip.up   { background: rgba(34,197,94,.15); color: #22c55e; }
  .delta-chip.down { background: rgba(197,48,48,.15); color: #ff6b6b; }
  .delta-chip.flat { background: rgba(255,255,255,.08); color: #8b8e96; }
  /* AI narrative section (Stage 4) */
  .narrative { background: #fff8f0; border-left: 5px solid #BD5728; padding: 24px 28px; margin: 0; border-bottom: 1px solid #eee; position: relative; }
  .narrative-label { font-family: 'Barlow Condensed', sans-serif; font-size: 10px; font-weight: 800; letter-spacing: .18em; color: var(--orange,#BD5728); text-transform: uppercase; margin-bottom: 8px; }
  .narrative-text { font-size: 16px; line-height: 1.6; color: #1a1a1a; font-weight: 500; }
  .narrative-badge { position: absolute; top: 12px; right: 20px; font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--orange,#BD5728); background: #fff; border: 1px solid rgba(189,87,40,.3); padding: 3px 8px; border-radius: 10px; }
  @media print { body { background: #fff; } .report-page { max-width: 100%; padding: 0; } .section { page-break-inside: avoid; } @page { margin: 0.5cm; size: letter; } .narrative { background: #fff; border-left: 4px solid #BD5728; } }
${STATIC_CHART_CSS}
</style>
</head>
<body>
  <div class="report-page">
    <div class="report-hdr">
      <div class="report-brand">NBD <span>PRO</span> — ${eyebrow}</div>
      <div class="report-title">${title}</div>
      <div class="report-subtitle">${subtitle}</div>
      <div class="report-period">${periodLabel}</div>
    </div>` + narrativeBlock,
      footer: `
    <div class="report-footer">
      <div>
        <div class="report-footer-brand">NBD <span>PRO</span></div>
        <div>nobigdealwithjoedeal.com · Generated ${fmtDate(new Date())}</div>
      </div>
      <div style="text-align:right;">
        <div style="color:#fff;font-weight:700;">${repName}</div>
        <div>${esc(opts.repEmail || '')}</div>
      </div>
    </div>
  </div>
</body>
</html>`
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Template: Territory Deep Dive
  // Focus: where to knock, best cities/zips, geographic ROI
  // ═══════════════════════════════════════════════════════════
  function buildTerritoryDeepDiveHTML(metrics, meta) {
    const { core, topCities, heatmap, revenuePerKnock, knocksToDeal } = metrics;
    const priorCore = (meta.comparison && meta.comparison.metrics && meta.comparison.metrics.core) || null;
    const priorRpk = (meta.comparison && meta.comparison.metrics && meta.comparison.metrics.revenuePerKnock) || null;
    const shell = reportShell({
      repName: meta.rep.name,
      repEmail: meta.rep.email,
      eyebrow: 'TERRITORY DEEP DIVE',
      title: 'Where You Work Best',
      subtitle: 'Geographic performance breakdown and where to focus next',
      periodLabel: fmtDate(meta.rangeStart) + ' → ' + fmtDate(meta.rangeEnd),
      narrative: meta.narrative
    });

    const cityList = topCities.topCities || [];
    const hasCities = cityList.length > 0;
    const topCity = hasCities ? cityList[0] : null;

    // City bar chart data — top 10 by revenue
    const chartData = cityList.slice(0, 10).map(c => ({
      x: c.city.length > 18 ? c.city.substring(0, 18) + '…' : c.city,
      y: c.revenue,
      deals: c.deals,
      knocks: c.knocks,
      fullCity: c.city
    }));
    // Static horizontal revenue bars (CSP-safe; reuses .velocity-bar* classes).
    const maxRev = chartData.reduce((m, d) => Math.max(m, Number(d.y) || 0), 0);
    const territoryBars = chartData.length > 0
      ? chartData.map(d => `
        <div class="terr-bar-row">
          <div class="terr-bar-city" title="${esc(d.fullCity)}">${esc(d.x)}</div>
          <div class="velocity-bar-wrap">
            <div class="velocity-bar" style="width:${barPct(d.y, maxRev)}%"></div>
          </div>
          <div class="terr-bar-rev">$${Math.round((Number(d.y) || 0) / 1000)}K</div>
        </div>
      `).join('')
      : '<div style="padding:40px;text-align:center;color:#999;">No territory data yet.</div>';

    const cityTable = hasCities
      ? cityList.slice(0, 10).map((c, i) => `
        <div class="city-row">
          <div class="city-rank">${i + 1}</div>
          <div class="city-body">
            <div class="city-name">${esc(c.city)}</div>
            <div class="city-stats">${fmtNumber(c.knocks)} knocks · ${fmtNumber(c.appts)} appts · ${fmtNumber(c.deals)} deals · ${fmtMoney(c.revenue)}</div>
          </div>
        </div>
      `).join('')
      : '<div class="empty-state">No territory data yet. Start knocking and this map fills in automatically.</div>';

    return shell.head + `
    <div class="hero-grid">
      <div class="hero-cell">
        <div class="hero-label">Territories Worked</div>
        <div class="hero-value orange">${fmtNumber(cityList.length)}</div>
        <div class="hero-sub">cities active in period</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Top Territory</div>
        <div class="hero-value" style="font-size:22px;">${topCity ? esc(topCity.city) : '—'}</div>
        <div class="hero-sub">${topCity ? (fmtMoney(topCity.revenue) + ' closed') : 'no data'}</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Revenue Collected</div>
        <div class="hero-value">${fmtMoney(core.revenue)} ${priorCore ? deltaChip(core.revenue, priorCore.revenue) : ''}</div>
        <div class="hero-sub">${fmtNumber(core.dealsClosed)} deals closed · ${fmtMoney(core.bookedValue || 0)} booked</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Revenue per Door</div>
        <div class="hero-value">${fmtMoney(revenuePerKnock.revenuePerDoor)} ${priorRpk && priorRpk.revenuePerDoor != null ? deltaChip(revenuePerKnock.revenuePerDoor, priorRpk.revenuePerDoor) : ''}</div>
        <div class="hero-sub">${fmtNumber(revenuePerKnock.doors)} doors</div>
      </div>
    </div>

    <div class="section">
      <div class="section-label">Top 10 Territories by Revenue</div>
      <div class="section-title">Your Money Map</div>
      <div class="section-desc">Cities ranked by closed revenue. Where you should be doubling down.</div>
      <div class="chart-box" id="territory-bar-chart">${territoryBars}</div>
    </div>

    <div class="section">
      <div class="section-label">Full Territory Table</div>
      <div class="section-title">Detailed Breakdown</div>
      <div class="section-desc">Every city you worked this period. Top 10 shown. Scoring weights deals 1000x, appointments 10x, knocks 1x.</div>
      ${cityTable}
    </div>

    <div class="section">
      <div class="section-label">When You're Most Active</div>
      <div class="section-title">Activity Heatmap</div>
      <div class="section-desc">Hour × day grid of your knocking pattern <span style="opacity:.7;">(local time)</span>. Best slot: <strong>${esc(heatmap.bestSlot)}</strong></div>
      <div class="chart-box" id="territory-heatmap">${(heatmap.series && heatmap.series.length) ? renderStaticHeatmap(heatmap.series) : '<div style="padding:40px;text-align:center;color:#999;">No activity data yet.</div>'}</div>
    </div>
    ` + shell.footer;
  }

  // ═══════════════════════════════════════════════════════════
  // Template: Pipeline Health Check
  // Focus: funnel, velocity, bottlenecks, stuck deals
  // ═══════════════════════════════════════════════════════════
  function buildPipelineHealthHTML(metrics, meta) {
    const { core, velocity, funnel, stuckDeals } = metrics;
    const priorCore = (meta.comparison && meta.comparison.metrics && meta.comparison.metrics.core) || null;
    const shell = reportShell({
      repName: meta.rep.name,
      repEmail: meta.rep.email,
      eyebrow: 'PIPELINE HEALTH CHECK',
      title: 'Pipeline Health',
      subtitle: 'Stage funnel, velocity bottlenecks, and stuck deals that need attention',
      periodLabel: fmtDate(meta.rangeStart) + ' → ' + fmtDate(meta.rangeEnd),
      narrative: meta.narrative
    });

    // Static funnel — centered tapering bars (CSP-safe, no ApexCharts).
    const funnelData = funnel.stages.map(s => ({ x: s.stage, y: s.count }));
    const funnelMax = funnelData.reduce((m, d) => Math.max(m, Number(d.y) || 0), 0);
    const funnelPalette = ['#BD5728','#ff9030','#ffb870','#ffc68a','#ffce9a','#f0a060','#c58040','#8a5a28','#444'];
    const funnelHTML = funnelData.length > 0
      ? `<div class="funnel-wrap">` + funnelData.map((d, i) => `
          <div class="funnel-bar" style="width:${barPct(d.y, funnelMax)}%;min-width:90px;background:${funnelPalette[i % funnelPalette.length]};">${esc(d.x)}: ${d.y}</div>
        `).join('') + `</div>`
      : '<div style="padding:40px;text-align:center;color:#999;">No pipeline data for the selected period.</div>';
    const velocityRows = (velocity.stages || []).map(s => `
      <div class="velocity-row">
        <div class="velocity-stage">${esc(s.stage)}</div>
        <div class="velocity-bar-wrap">
          <div class="velocity-bar" style="width:${Math.min(100, (s.avgDays / 30) * 100)}%"></div>
        </div>
        <div class="velocity-days">${s.avgDays.toFixed(1)} days</div>
        <div class="velocity-count">${s.count} leads</div>
      </div>
    `).join('') || '<div class="empty-state">No velocity data yet.</div>';

    const stuckRows = (stuckDeals.topStuck || []).map(s => `
      <div class="stuck-row">
        <div>
          <div class="stuck-name">${esc(s.name)}</div>
          <div class="stuck-addr">${esc(s.address)}</div>
        </div>
        <div class="stuck-stage">${esc(s.stage)}</div>
        <div class="stuck-days">${s.daysStuck}d</div>
        <div class="stuck-value">${fmtMoney(s.jobValue)}</div>
      </div>
    `).join('') || '<div class="empty-state">No stuck deals. Everything is moving.</div>';

    return shell.head + `
    <div class="hero-grid">
      <div class="hero-cell">
        <div class="hero-label">Pipeline Value</div>
        <div class="hero-value orange">${fmtMoney(core.pipelineValue)} ${priorCore ? deltaChip(core.pipelineValue, priorCore.pipelineValue) : ''}</div>
        <div class="hero-sub">${fmtNumber(funnel.total)} active leads</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Close Rate</div>
        <div class="hero-value">${fmtPct(core.closeRate)} ${priorCore ? deltaChip(core.closeRate, priorCore.closeRate) : ''}</div>
        <div class="hero-sub">${fmtNumber(core.dealsClosed)}W / ${fmtNumber(core.dealsLost)}L</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Stuck Deals</div>
        <div class="hero-value" style="color:${stuckDeals.count > 0 ? '#c53030' : '#22c55e'}">${fmtNumber(stuckDeals.count)}</div>
        <div class="hero-sub">${fmtMoney(stuckDeals.totalValue)} at risk</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Bottleneck</div>
        <div class="hero-value" style="font-size:18px;">${esc(velocity.bottleneck.split(' (')[0] || '—')}</div>
        <div class="hero-sub">${esc((velocity.bottleneck.match(/\((.*)\)/) || [])[1] || 'healthy')}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-label">Stage Funnel</div>
      <div class="section-title">Your Pipeline Shape</div>
      <div class="section-desc">Lead count by stage. Notice where the shape gets narrow \u2014 that's where deals leak.</div>
      <div class="chart-box" id="funnel-chart">${funnelHTML}</div>
    </div>

    <div class="section">
      <div class="section-label">Stage Velocity</div>
      <div class="section-title">Time Per Stage</div>
      <div class="section-desc">How long leads linger at each stage. Longer bars = slower movement = bottleneck.</div>
      ${velocityRows}
    </div>

    <div class="section">
      <div class="section-label">Stuck Deals (>14 days since last update)</div>
      <div class="section-title">Needs Attention</div>
      <div class="section-desc">Call these customers this week. Every day they sit costs you money.</div>
      ${stuckRows}
    </div>
    ` + shell.footer;
  }

  // ═══════════════════════════════════════════════════════════
  // Template: Revenue Recap
  // Focus: owner/investor view of revenue, growth, best month
  // ═══════════════════════════════════════════════════════════
  function buildRevenueRecapHTML(metrics, meta) {
    const { core, revenueTrend, topCities, velocity } = metrics;
    const priorCore = (meta.comparison && meta.comparison.metrics && meta.comparison.metrics.core) || null;
    const shell = reportShell({
      repName: meta.rep.name,
      repEmail: meta.rep.email,
      eyebrow: 'REVENUE RECAP',
      title: 'Revenue Recap',
      subtitle: 'Business performance summary for partners and stakeholders',
      periodLabel: fmtDate(meta.rangeStart) + ' → ' + fmtDate(meta.rangeEnd),
      narrative: meta.narrative
    });

    // Static inline-SVG revenue trend (CSP-safe; inert markup, no <img>).
    const trendData = (revenueTrend.months || []).map(m => ({ x: m.label, y: m.revenue }));
    const revenueChartHTML = (function () {
      const n = trendData.length;
      if (n === 0) {
        return '<div style="padding:40px;text-align:center;color:#999;">No revenue in this period.</div>';
      }
      const VBW = 600, VBH = 240, padL = 40, padT = 10, padB = 24;
      const W = VBW - padL;
      const H = VBH - padT - padB;
      const maxRev = Math.max(trendData.reduce((m, d) => Math.max(m, Number(d.y) || 0), 0), 1);
      const xAt = (i) => padL + (n <= 1 ? W / 2 : i * W / (n - 1));
      const yAt = (v) => padT + H - barPct(v, maxRev) / 100 * H;
      const pts = trendData.map((d, i) => ({ px: xAt(i), py: yAt(d.y), d }));
      const polyline = pts.map(p => `${p.px.toFixed(1)},${p.py.toFixed(1)}`).join(' ');
      // Area polygon: line points + drop to baseline.
      const baselineY = (padT + H).toFixed(1);
      const polygon = `${padL.toFixed(1)},${baselineY} ` + polyline + ` ${(padL + W).toFixed(1)},${baselineY}`;
      const circles = pts.map(p => `<circle cx="${p.px.toFixed(1)}" cy="${p.py.toFixed(1)}" r="3" fill="#BD5728"/>`).join('');
      const xLabels = pts.map(p => `<text x="${p.px.toFixed(1)}" y="${(VBH - 6)}" fill="#666" font-size="11" font-family="Barlow, sans-serif" text-anchor="middle">${esc(p.d.x)}</text>`).join('');
      // A few y-axis $K gridline labels (0, 50%, 100% of max).
      const yTicks = [0, 0.5, 1].map(frac => {
        const v = maxRev * frac;
        const py = yAt(v);
        return `<text x="${(padL - 6)}" y="${(py + 3).toFixed(1)}" fill="#999" font-size="10" font-family="Barlow, sans-serif" text-anchor="end">$${Math.round(v / 1000)}K</text>`;
      }).join('');
      return `<svg class="revenue-svg" viewBox="0 0 ${VBW} ${VBH}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Monthly revenue trend">
  <defs>
    <linearGradient id="revfill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#BD5728" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#BD5728" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <polygon points="${polygon}" fill="url(#revfill)" stroke="none"/>
  <polyline points="${polyline}" fill="none" stroke="#BD5728" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
  ${circles}
  ${xLabels}
  ${yTicks}
</svg>`;
    })();
    const cityTopRows = (topCities.topCities || []).slice(0, 5).map((c, i) => `
      <div class="city-row">
        <div class="city-rank">${i + 1}</div>
        <div class="city-body">
          <div class="city-name">${esc(c.city)}</div>
          <div class="city-stats">${fmtMoney(c.revenue)} · ${fmtNumber(c.deals)} deals</div>
        </div>
      </div>
    `).join('') || '<div class="empty-state">No territory data yet.</div>';

    return shell.head + `
    <div class="hero-grid">
      <div class="hero-cell">
        <div class="hero-label">Revenue Collected</div>
        <div class="hero-value orange">${fmtMoney(core.revenue)} ${priorCore ? deltaChip(core.revenue, priorCore.revenue) : ''}</div>
        <div class="hero-sub">${fmtNumber(core.dealsClosed)} deals closed · ${fmtMoney(core.bookedValue || 0)} booked</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Pipeline Value</div>
        <div class="hero-value">${fmtMoney(core.pipelineValue)} ${priorCore ? deltaChip(core.pipelineValue, priorCore.pipelineValue) : ''}</div>
        <div class="hero-sub">${fmtNumber(core.leadsCreated)} new leads</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Avg Deal Size</div>
        <div class="hero-value">${fmtMoney(core.avgJobValue)} ${priorCore ? deltaChip(core.avgJobValue, priorCore.avgJobValue) : ''}</div>
        <div class="hero-sub">per closed deal</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Close Rate</div>
        <div class="hero-value">${fmtPct(core.closeRate)} ${priorCore ? deltaChip(core.closeRate, priorCore.closeRate) : ''}</div>
        <div class="hero-sub">of decided deals</div>
      </div>
    </div>

    <div class="section">
      <div class="section-label">Monthly Revenue Trend</div>
      <div class="section-title">Month-over-Month</div>
      <div class="section-desc">Best month: <strong>${esc(revenueTrend.bestMonth)}</strong></div>
      <div class="chart-box" id="revenue-chart">${revenueChartHTML}</div>
    </div>

    <div class="section">
      <div class="section-label">Revenue by Territory</div>
      <div class="section-title">Top 5 Markets</div>
      <div class="section-desc">Where the revenue is coming from.</div>
      ${cityTopRows}
    </div>
    ` + shell.footer;
  }

  // ═══════════════════════════════════════════════════════════
  // Template: Customer Journey
  // Focus: full story of one customer — knocks, estimate, install
  // ═══════════════════════════════════════════════════════════
  function buildCustomerJourneyHTML(metrics, meta) {
    const lead = metrics.lead;
    if (!lead) {
      return '<html><body><h1>No customer selected</h1></body></html>';
    }
    const customerName = [lead.firstName, lead.lastName].filter(Boolean).join(' ') || lead.address || 'Unnamed Customer';
    const shell = reportShell({
      repName: meta.rep.name,
      repEmail: meta.rep.email,
      eyebrow: 'CUSTOMER JOURNEY',
      title: customerName,
      subtitle: lead.address || '',
      periodLabel: 'Full History',
      narrative: meta.narrative
    });

    const vel = metrics.velocity;
    const relatedKnocks = metrics.knocks || [];
    const relatedEstimates = metrics.estimates || [];

    const knockTimeline = relatedKnocks.length > 0
      ? relatedKnocks.map(k => {
        const d = toDate(k.timestamp || k.createdAt);
        return `
          <div class="velocity-row">
            <div class="velocity-stage">${esc(d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—')}</div>
            <div style="font-size:12px;color:#111;">${esc(k.disposition || 'visit')}</div>
            <div class="velocity-days" style="color:#666;font-size:11px;">${esc(k.address || '')}</div>
            <div class="velocity-count">${k.carrier ? esc(k.carrier) : ''}</div>
          </div>
        `;
      }).join('')
      : '<div class="empty-state">No door-knocks linked to this customer.</div>';

    const estimateTimeline = relatedEstimates.length > 0
      ? relatedEstimates.map(e => {
        const d = toDate(e.createdAt);
        return `
          <div class="velocity-row">
            <div class="velocity-stage">${esc(d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—')}</div>
            <div style="font-size:12px;color:#111;">${esc(e.name || e.tierName || 'Estimate')}</div>
            <div class="velocity-days">${fmtMoney(e.grandTotal || 0)}</div>
            <div class="velocity-count">${esc(e.builder || 'classic')}</div>
          </div>
        `;
      }).join('')
      : '<div class="empty-state">No estimates generated for this customer yet.</div>';

    const createdD = toDate(lead.createdAt);
    const stageDisplay = (lead.stage || lead._stageKey || 'unknown').toString();
    const won = isWon(lead);
    const lost = isLost(lead);
    const statusLabel = won ? 'WON' : (lost ? 'LOST' : 'ACTIVE');
    const statusColor = won ? '#22c55e' : (lost ? '#c53030' : '#BD5728');

    return shell.head + `
    <div class="hero-grid">
      <div class="hero-cell">
        <div class="hero-label">Deal Status</div>
        <div class="hero-value" style="color:${statusColor};">${statusLabel}</div>
        <div class="hero-sub">${esc(stageDisplay)}</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Deal Value</div>
        <div class="hero-value orange">${fmtMoney(lead.jobValue || 0)}</div>
        <div class="hero-sub">${esc(lead.damageType || 'roof')}</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Days in Pipeline</div>
        <div class="hero-value">${vel ? fmtNumber(vel.daysInPipeline) : '—'}</div>
        <div class="hero-sub">since ${esc(createdD ? createdD.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '—')}</div>
      </div>
      <div class="hero-cell">
        <div class="hero-label">Contacts</div>
        <div class="hero-value">${fmtNumber(relatedKnocks.length)}</div>
        <div class="hero-sub">door visits logged</div>
      </div>
    </div>

    <div class="section">
      <div class="section-label">Customer Info</div>
      <div class="section-title">${esc(customerName)}</div>
      <div class="section-desc">${esc(lead.address || 'No address on file')}</div>
      <div class="metric-row">
        <div class="metric-card">
          <div class="metric-card-label">Phone</div>
          <div class="metric-card-value" style="font-size:20px;">${esc(lead.phone || '—')}</div>
          <div class="metric-card-sub">${esc(lead.email || 'no email')}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">Insurance</div>
          <div class="metric-card-value" style="font-size:20px;">${esc(lead.insCarrier || '—')}</div>
          <div class="metric-card-sub">${esc(lead.claimStatus || 'no claim')}</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">Source</div>
          <div class="metric-card-value" style="font-size:20px;">${esc(lead.source || '—')}</div>
          <div class="metric-card-sub">how they found you</div>
        </div>
        <div class="metric-card">
          <div class="metric-card-label">Stage</div>
          <div class="metric-card-value" style="font-size:20px;">${esc(stageDisplay)}</div>
          <div class="metric-card-sub">current pipeline position</div>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-label">Door-to-Door Timeline</div>
      <div class="section-title">Every Visit</div>
      <div class="section-desc">Chronological record of every touchpoint at this address.</div>
      ${knockTimeline}
    </div>

    <div class="section">
      <div class="section-label">Estimates Generated</div>
      <div class="section-title">Proposal History</div>
      <div class="section-desc">Every estimate built for this customer.</div>
      ${estimateTimeline}
    </div>

    <div class="section">
      <div class="section-label">Notes</div>
      <div class="section-title">Customer File</div>
      <div style="font-size:13px;color:#111;line-height:1.6;padding:16px;background:#fafaf9;border-left:4px solid #BD5728;">
        ${esc(lead.notes || 'No notes on file for this customer.')}
      </div>
    </div>
    ` + shell.footer;
  }

  // ═══════════════════════════════════════════════════════════
  // Lead picker modal — used by the Customer Journey template
  // ═══════════════════════════════════════════════════════════
  function showLeadPicker(onPick) {
    const leads = window._leads || [];
    if (!leads.length) {
      if (typeof showToast === 'function') showToast('No customers available yet', 'error');
      return;
    }

    // Reuse an existing picker if present
    let overlay = document.getElementById('report-lead-picker');
    if (overlay) overlay.remove();

    overlay = document.createElement('div');
    overlay.id = 'report-lead-picker';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;padding:20px;';

    const sheet = document.createElement('div');
    sheet.style.cssText = 'background:var(--s, #1a1d23);border:1px solid var(--br, #2a2d35);border-radius:12px;padding:24px;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;';
    overlay.appendChild(sheet);

    const hdr = document.createElement('div');
    hdr.style.cssText = 'margin-bottom:14px;';
    hdr.innerHTML = '<div style="font-family:\'Barlow Condensed\',sans-serif;font-size:18px;font-weight:800;color:var(--t);text-transform:uppercase;letter-spacing:.04em;">Pick a Customer</div>'
      + '<div style="font-size:11px;color:var(--m);margin-top:4px;">Generate a full journey report for this customer.</div>';
    sheet.appendChild(hdr);

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search customers...';
    search.style.cssText = 'background:var(--s2);border:1px solid var(--br);border-radius:6px;padding:10px 12px;font-size:13px;color:var(--t);margin-bottom:12px;font-family:inherit;outline:none;';
    sheet.appendChild(search);

    const results = document.createElement('div');
    results.style.cssText = 'flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:4px;min-height:240px;';
    sheet.appendChild(results);

    const renderList = (filter) => {
      results.textContent = '';
      const q = (filter || '').toLowerCase().trim();
      const filtered = q
        ? leads.filter(l => ([l.firstName, l.lastName, l.address, l.phone].filter(Boolean).join(' ').toLowerCase().includes(q)))
        : leads;
      if (!filtered.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'padding:30px;color:var(--m);text-align:center;font-size:12px;';
        empty.textContent = 'No customers match "' + q + '"';
        results.appendChild(empty);
        return;
      }
      filtered.slice(0, 100).forEach(l => {
        const row = document.createElement('button');
        row.type = 'button';
        row.style.cssText = 'background:var(--s2);border:1px solid var(--br);border-radius:6px;padding:10px 14px;text-align:left;cursor:pointer;font-family:inherit;transition:border-color .15s;';
        row.addEventListener('mouseenter', () => { row.style.borderColor = '#BD5728'; });
        row.addEventListener('mouseleave', () => { row.style.borderColor = 'var(--br)'; });
        const name = document.createElement('div');
        name.style.cssText = 'font-size:13px;font-weight:600;color:var(--t);';
        name.textContent = [l.firstName, l.lastName].filter(Boolean).join(' ') || '(no name)';
        row.appendChild(name);
        const addr = document.createElement('div');
        addr.style.cssText = 'font-size:11px;color:var(--m);margin-top:2px;';
        addr.textContent = l.address || 'No address';
        row.appendChild(addr);
        row.addEventListener('click', () => {
          overlay.remove();
          onPick(l.id);
        });
        results.appendChild(row);
      });
    };
    renderList('');
    search.addEventListener('input', () => renderList(search.value));

    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;margin-top:14px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:none;border:1px solid var(--br);color:var(--m);padding:8px 18px;border-radius:6px;cursor:pointer;font-family:\'Barlow Condensed\',sans-serif;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;';
    cancelBtn.addEventListener('click', () => overlay.remove());
    footer.appendChild(cancelBtn);
    sheet.appendChild(footer);

    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    setTimeout(() => search.focus(), 50);
  }

  // ─── Save report to Firestore ────────────────────────────
  async function saveReport(data) {
    const _nbdReg = window.__NBD_CALL_REGISTRY;
    if (!_nbdReg || typeof _nbdReg._saveReport !== 'function') {
      console.warn('[Reports] _saveReport helper not loaded');
      return null;
    }
    return await _nbdReg._saveReport(data);
  }

  // ─── My Reports list ─────────────────────────────────────
  async function listSavedReports() {
    const container = document.getElementById('myReportsList');
    if (!container) return;
    const _nbdReg = window.__NBD_CALL_REGISTRY;
    if (!_nbdReg || typeof _nbdReg._loadReports !== 'function') {
      container.innerHTML = '<div class="empty"><div class="empty-icon">📈</div>Reports store not loaded</div>';
      return;
    }
    const reports = await _nbdReg._loadReports();
    _reportsCache = reports;
    if (!reports.length) {
      container.innerHTML = '<div class="empty"><div class="empty-icon">📈</div>No reports saved yet. Click <strong>＋ New Report</strong> above to create your first one.</div>';
      return;
    }
    container.innerHTML = reports.map(r => {
      const created = toDate(r.createdAt);
      const createdStr = created ? fmtDate(created) : '—';
      return `
        <div class="est-card nbd-saved-report" data-id="${esc(r.id)}" style="margin-bottom:8px;cursor:pointer;padding:14px 16px;">
          <div style="font-size:22px;">📈</div>
          <div style="flex:1;min-width:0;">
            <div class="est-addr" style="font-size:13px;">${esc(r.name || 'Untitled report')}</div>
            <div class="est-meta" style="font-size:11px;color:var(--m);margin-top:2px;">
              ${esc(r.template || 'report')} · Generated ${esc(createdStr)}
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost" style="font-size:10px;padding:5px 10px;" data-nr-action="openSavedReport" data-nr-id="${esc(r.id)}" data-nr-stop="1">Open</button>
            <button class="btn btn-ghost" style="font-size:10px;padding:5px 10px;color:var(--red);" data-nr-action="deleteSavedReport" data-nr-id="${esc(r.id)}" data-nr-stop="1">🗑</button>
          </div>
        </div>
      `;
    }).join('');
  }

  // async since 2026-09-06: the filename carries a tenant-resolved prefix and
  // company-profile hydration must be awaited (company-profile.js
  // _tenantFilePrefix). Dispatched fire-and-forget by the data-nr-action
  // delegate, which discards the return value.
  async function openSavedReport(id) {
    const r = _reportsCache.find(x => x.id === id);
    if (!r) {
      if (typeof showToast === 'function') showToast('Report not found', 'error');
      return;
    }
    if (!window.NBDDocViewer || typeof window.NBDDocViewer.open !== 'function') {
      if (typeof showToast === 'function') showToast('Doc viewer not loaded', 'error');
      return;
    }
    // Tenant-resolved prefix — '' when the brand is not hydrated, never 'NBD'.
    const _repBase = (r.name || 'Report').replace(/[^A-Za-z0-9]+/g, '-') + '.pdf';
    const _repName = window._tenantFileName ? await window._tenantFileName(_repBase) : _repBase;
    window.NBDDocViewer.open({
      html: r.html || '<html><body><p>Report HTML not stored.</p></body></html>',
      title: r.name || 'Saved Report',
      filename: _repName
    });
  }

  async function deleteSavedReport(id) {
    // In the installed PWA, standalone-compat.js swaps native confirm() for a
    // stub that always returns true — so a destructive guard written against
    // window.confirm never actually stops anything on Joe's phone. nbdConfirm
    // is a real Promise<boolean> modal in standalone mode; it only exists
    // there, hence the native fallback for desktop.
    // eslint-disable-next-line no-alert
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (!(await _ask('Delete this report? This cannot be undone.'))) return;
    const _nbdReg = window.__NBD_CALL_REGISTRY;
    if (!_nbdReg || typeof _nbdReg._deleteReport !== 'function') return;
    const ok = await _nbdReg._deleteReport(id);
    if (ok) {
      if (typeof showToast === 'function') showToast('✓ Report deleted', 'success');
      await listSavedReports();
    } else if (typeof showToast === 'function') {
      // Surface the failure — the old silent path left the user believing
      // the report was deleted when the Firestore delete was denied.
      showToast('Delete failed — report was not removed', 'error');
    }
  }

  // ─── Init ────────────────────────────────────────────────
  async function init() {
    renderGeneratorUI();
    if (!initialized) {
      // Select first template by default
      setTimeout(() => selectTemplate('rep-monthly'), 50);
      initialized = true;
    }
    await listSavedReports();
  }

  function openGenerator() {
    // Scroll the generator into view if already initialized
    const panel = document.getElementById('reportGenPanel');
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    init();
  }

  // ─── Analytics enrichment (backfill) ─────────────────────
  // Calls the backfillAnalytics Cloud Function to:
  //   1. Derive hourOfDay + dayOfWeek from every knock's timestamp
  //   2. Reverse-geocode knock lat/lng -> city/zip/state (if the
  //      GOOGLE_GEOCODING_API_KEY secret is set in Firebase)
  //   3. Parse lead addresses -> city/zip/state
  //   4. Backfill closedAt for won/lost leads
  //
  // One call per user per 10 minutes (rate-limited server-side).
  async function enrichData() {
    if (typeof showToast !== 'function') return;
    if (!window._user?.uid) {
      showToast('Not signed in', 'error');
      return;
    }
    // eslint-disable-next-line no-alert
    const _ask = window.nbdConfirm || ((m) => Promise.resolve(window.confirm(m)));
    if (!(await _ask('Run one-time analytics enrichment?\n\n'
      + 'This will:\n'
      + '\u2022 Derive time-of-day buckets from every knock timestamp\n'
      + '\u2022 Reverse-geocode knock GPS coordinates into city/zip\n'
      + '\u2022 Parse lead addresses into city/state/zip fields\n\n'
      + 'Safe to run \u2014 only enriches missing fields, never overwrites data. Takes up to a few minutes if you have thousands of knocks. Limited to one run per 10 minutes.'))) {
      return;
    }
    const btn = document.getElementById('btnEnrichData');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '\u23f3 Enriching...'; }
    showToast('Starting backfill \u2014 this may take a minute...', 'info');
    try {
      // Use Firebase callable functions SDK via window.functions
      // (the client is initialized elsewhere in dashboard.html).
      if (!window._functions) {
        const { getFunctions, httpsCallable } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
        window._functions = getFunctions();
        window._httpsCallable = httpsCallable;
      }
      const fn = window._httpsCallable(window._functions, 'backfillAnalytics');
      const result = await fn({});
      const summary = result.data || {};
      const lines = [
        '\u2713 Backfill complete',
        summary.knocksProcessed + ' knocks processed (' + (summary.knocksEnriched || 0) + ' enriched)',
        summary.leadsProcessed + ' leads processed (' + (summary.leadsEnriched || 0) + ' enriched)',
        summary.knocksGeocoded > 0 ? (summary.knocksGeocoded + ' knocks reverse-geocoded') : 'Geocoding skipped (no API key set)'
      ];
      if (summary.warnings && summary.warnings.length) {
        lines.push('Warnings: ' + summary.warnings.length);
        console.warn('[Enrich] warnings:', summary.warnings);
      }
      // eslint-disable-next-line no-alert
      window.alert(lines.join('\n'));
      showToast('\u2713 Data enriched \u2014 reports now have full analytics', 'success');
    } catch (e) {
      console.error('[Enrich] failed:', e);
      const msg = e.message || 'Unknown error';
      if (msg.includes('resource-exhausted')) {
        showToast('Please wait 10 minutes between enrichment runs', 'error');
      } else if (msg.includes('unauthenticated')) {
        showToast('Sign-in expired \u2014 refresh the page', 'error');
      } else {
        showToast('Enrichment failed: ' + msg.substring(0, 100), 'error');
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
  }

  // ─── Public API ──────────────────────────────────────────
  window.NBDReports = {
    __sentinel: 'nbd-reports-v1',
    init,
    openGenerator,
    selectTemplate,
    setQuickRange,
    generateSelected,
    generate,
    enrichData,
    listSavedReports,
    openSavedReport,
    deleteSavedReport,
    // Expose calculators for future templates
    calculators: {
      computeCoreKPIs,
      computeKnocksToDeal,
      computeTimeOfDayHeatmap,
      computeTopCitiesZips,
      computePipelineVelocity,
      computeRevenuePerKnock,
      computeEstimateAccuracy
    }
  };

  console.log('[NBDReports] Stage 1 ready. Open Reports tab to generate.');

  // CSP-safe delegated click handler for 10 inline onclicks replaced with
  // data-nr-action attrs. addEventListener is not blocked by
  // `script-src-attr 'none'`.
  if (!window._NBD_NR_DELEGATE_BOUND) {
    window._NBD_NR_DELEGATE_BOUND = true;
    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-nr-action]');
      if (!t) return;
      if (t.dataset.nrStop === '1') ev.stopPropagation();
      const action = t.dataset.nrAction;
      const id = t.dataset.nrId;
      const fn = window.NBDReports && window.NBDReports[action];
      if (typeof fn !== 'function') { console.warn('[reports] no dispatch for', action); return; }
      try { id !== undefined ? fn(id) : fn(); }
      catch (e) { console.error('[reports] dispatch ' + action + ' failed:', e); }
    });
  }
})();
