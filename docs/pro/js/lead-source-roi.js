/**
 * NBD Pro — Lead Source ROI Dashboard
 *
 * Reads window._leads, groups by lead.source, and surfaces:
 *   - Total leads / qualified / closed per source
 *   - Pipeline value generated per source
 *   - Closed revenue per source
 *   - Conversion rate (closed / total) per source
 *   - Best / worst source callouts
 *
 * No backend dependency — pure client-side aggregation off the live
 * lead cache. Re-renders on the `leadsChanged` event dispatched by crm.js.
 *
 * IIFE exposed as window.LeadSourceROI.
 */
(function() {
  'use strict';

  // REVENUE-recognition stages only: a job counts toward closed REVENUE once it
  // is complete/paid — NOT when merely signed or in-progress (those can still
  // fall through). Deliberately NARROWER than crm.js's pipeline "closed" bucket:
  // this set drives dollar ROI, so it must reflect money actually earned, not
  // committed pipeline. (Jo's definition call, 2026-06-25.)
  const CLOSED_STAGE_KEYS = new Set([
    'final_payment', 'deductible_collected', 'closed', 'Complete'
  ]);
  const LOST_STAGE_KEYS = new Set(['lost', 'Lost']);

  // Source normalization. DOOR KNOCK IS CANONICAL (Joe, 2026-09-06) — this
  // map used to fold the other way, onto 'Door-to-Door'. The stored data was
  // normalized to 'Door Knock' the same day and d2d-tracker now writes it, so
  // the aliases below are a safety net for old imports and restored backups
  // rather than the load-bearing path they used to be.
  const SOURCE_ALIASES = {
    'door knock':    'Door Knock',
    'door-to-door':  'Door Knock',
    'door_knock':    'Door Knock',
    'door to door':  'Door Knock',
    'd2d':           'Door Knock',
    'storm canvass': 'Storm Canvass',
    'storm_alert':   'Storm Alert',
    'storm alert':   'Storm Alert',
    'google':        'Google',
    'referral':      'Referral',
  // Paid marketplaces are their OWN buckets, not 'Online'. The Add Lead select
  // shipped without them while the Thumbtack ingest wrote source:'Thumbtack',
  // so those leads rendered blank in the dropdown and any save overwrote the
  // real source with whatever was selected. Fixed 2026-09-06; NINE leads were
  // downgraded to 'Online' before it was caught, and were repaired the same
  // day by scripts/fix-lead-source-thumbtack.js.
  'thumbtack':     'Thumbtack',
  'yelp':          'Yelp',
  'angi':          'Angi',
  'angies list':   'Angi',
  // The two public funnels keep their own stored values (contact_leads__ and
  // inspect_leads__ write them and the distinction is real), but they report
  // as one Website line — folding belongs here, not in the stored data.
  'website':       'Website',
  'website — contact form':             'Website',
  'website - contact form':             'Website',
  'website — inspection / storm tool':  'Website',
  'website - inspection / storm tool':  'Website',
    'online':        'Online',
    '':              'Unknown',
    'other':         'Other'
  };

  function normalizeSource(raw) {
    const s = String(raw || '').trim().toLowerCase();
    return SOURCE_ALIASES[s] || (raw || 'Unknown');
  }

  function toNum(v) { return parseFloat(v) || 0; }

  // ────────────────────────────────────────────────────────────────────
  // Aggregation
  // ────────────────────────────────────────────────────────────────────
  function computeMetrics(leads) {
    const buckets = {};
    let aggTotal = 0, aggClosed = 0, aggPipe = 0, aggRev = 0, aggLost = 0, aggLeadCost = 0;

    for (const lead of leads) {
      // Skip prospects — they're pre-qualification leads. ROI math should
      // only count leads the rep has actually touched.
      if (lead.isProspect) continue;
      // Skip soft-deleted records.
      if (lead.deleted) continue;

      const source = normalizeSource(lead.source);
      const stageKey = lead._stageKey || lead.stage || 'new';
      // Semantic role (crm-stages, custom-pipeline aware) — the same test the
      // Pipeline header and Home widgets use. The hand-copied set below missed
      // install_complete / final_photos / collections / warranty_claim and any
      // custom won stage, so those jobs counted as open pipeline here.
      const role = lead._stageRole
        || (typeof window.stageRole === 'function' ? (function () { try { return window.stageRole(stageKey); } catch (_) { return null; } })() : null);
      const isClosed = role ? role === 'won' : CLOSED_STAGE_KEYS.has(stageKey);
      const isLost   = role ? role === 'lost' : LOST_STAGE_KEYS.has(stageKey);
      const value    = toNum(lead.jobValue);

      if (!buckets[source]) {
        buckets[source] = {
          source, total: 0, closed: 0, lost: 0,
          pipeValue: 0, closedRev: 0, openCount: 0, leadCost: 0
        };
      }
      const b = buckets[source];
      b.total++;
      aggTotal++;
      // Lead cost accrues on EVERY lead, won or lost — the money is spent
      // either way, and counting it only on closes would flatter every source.
      const acqCost = toNum(lead.leadCost);
      b.leadCost += acqCost; aggLeadCost += acqCost;
      if (isClosed) {
        b.closed++; aggClosed++;
        b.closedRev += value;  aggRev += value;
      } else if (isLost) {
        b.lost++; aggLost++;
      } else {
        b.openCount++;
        b.pipeValue += value;  aggPipe += value;
      }
    }

    // Compute derived metrics + sort by closed revenue desc
    const rows = Object.values(buckets).map(b => ({
      ...b,
      conversionRate: b.total ? Math.round((b.closed / b.total) * 100) : 0,
      costPerLead:    b.total ? b.leadCost / b.total : 0,
      costPerClosed:  b.closed ? b.leadCost / b.closed : 0,
      leadRoi:        b.leadCost > 0 ? Math.round((b.closedRev / b.leadCost) * 100) : null,
      avgDealSize:    b.closed ? Math.round(b.closedRev / b.closed) : 0,
    })).sort((a, b) => b.closedRev - a.closedRev);

    return {
      rows,
      totals: {
        total:     aggTotal,
        closed:    aggClosed,
        lost:      aggLost,
        pipeValue: aggPipe,
        closedRev: aggRev,
        conversionRate: aggTotal ? Math.round((aggClosed / aggTotal) * 100) : 0,
        // Acquisition cost carried on the lead itself. Narrower and more honest
        // than the expenses join above: it is what THIS lead cost, not a
        // company-wide marketing figure spread across sources by name match.
        leadCost:     aggLeadCost,
        costPerLead:  aggTotal ? aggLeadCost / aggTotal : 0,
        costPerClosed: aggClosed ? aggLeadCost / aggClosed : 0,
        leadRoi:      aggLeadCost > 0 ? Math.round((aggRev / aggLeadCost) * 100) : null,
      },
      bestByRevenue: rows[0] || null,
      bestByConversion: [...rows].filter(r => r.total >= 3)
                                 .sort((a, b) => b.conversionRate - a.conversionRate)[0] || null
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Render
  // ────────────────────────────────────────────────────────────────────
  function fmtMoney(n) {
    if (!n) return '$0';
    if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1000)      return '$' + Math.round(n / 1000) + 'K';
    return '$' + Math.round(n).toLocaleString();
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Marketing spend (dollars) from the expense ledger — drives a REAL ROI.
  // null = not yet fetched. Total drives the overall ROI; the by-source map
  // (keyed by lowercased marketingSource) drives per-source ROI in the table
  // for sources whose name matches a lead-source bucket.
  let _marketingSpend = null;
  let _marketingBySource = {};   // lowercased source -> dollars
  let _marketingTargetId = null;

  async function _fetchMarketingSpend() {
    const db = window.db || window._db;
    const uid = window._user && window._user.uid;
    _marketingBySource = {};
    if (!db || !uid || !window.getDocs || !window.query || !window.where || !window.collection) return 0;
    try {
      // userId-scoped (single-field auto-index); filter category client-side to
      // avoid a new composite index.
      const snap = await window.getDocs(window.query(
        window.collection(db, 'expenses'), window.where('userId', '==', uid)));
      let cents = 0;
      snap.docs.forEach(function (d) {
        const e = d.data();
        if (!e || e.category !== 'marketing') return;
        const c = parseInt(e.amountCents, 10) || 0;
        cents += c;
        // Key through the SAME normalizer the table lookup uses (line ~252),
        // so 'd2d'/'Door-to-Door' spend joins the canonical 'Door Knock'
        // bucket instead of silently missing (QA finding).
        const src = normalizeSource(e.marketingSource).trim().toLowerCase();
        if (src) _marketingBySource[src] = (_marketingBySource[src] || 0) + c / 100;
      });
      return cents / 100;
    } catch (e) { return 0; }
  }

  function render(targetId) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const leads = window._leads || [];
    const m = computeMetrics(leads);

    // Pull marketing spend once, then re-render with the real ROI tiles.
    _marketingTargetId = targetId;
    if (_marketingSpend === null) {
      _marketingSpend = 0; // guard against re-entry
      _fetchMarketingSpend().then(function (spend) {
        _marketingSpend = spend;
        if (_marketingTargetId) render(_marketingTargetId);
      });
    }

    if (m.totals.total === 0) {
      el.innerHTML = `
        <div class="lsroi-empty">
          <div class="lsroi-empty-icon">📊</div>
          <div class="lsroi-empty-title">No closed deals yet</div>
          <div class="lsroi-empty-sub">Once you close a few leads, this panel will surface which sources actually generate revenue.</div>
        </div>
      `;
      return;
    }

    // Marketing ROI must be ATTRIBUTED: credit only revenue from sources that
    // actually have marketing spend, against that matched spend — not all-source
    // revenue ÷ marketing-only spend (which overstates for referral/D2D shops).
    // QA finding.
    let _attribRev = 0, _attribSpend = 0;
    m.rows.forEach(r => {
      const sp = _marketingBySource[normalizeSource(r.source).trim().toLowerCase()];
      if (sp > 0) { _attribRev += r.closedRev; _attribSpend += sp; }
    });
    const _marketingRoi = _attribSpend > 0 ? Math.round((_attribRev / _attribSpend) * 100) : null;

    const totalsBar = `
      <div class="lsroi-totals">
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Total Leads</div>
          <div class="lsroi-tot-val">${m.totals.total}</div>
        </div>
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Closed</div>
          <div class="lsroi-tot-val" style="color:var(--green);">${m.totals.closed}</div>
        </div>
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Closed Revenue</div>
          <div class="lsroi-tot-val" style="color:var(--green);">${fmtMoney(m.totals.closedRev)}</div>
        </div>
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Open Pipeline</div>
          <div class="lsroi-tot-val" style="color:var(--orange);">${fmtMoney(m.totals.pipeValue)}</div>
        </div>
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Conv. Rate</div>
          <div class="lsroi-tot-val">${m.totals.conversionRate}%</div>
        </div>
        ${m.totals.leadCost > 0 ? `
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Lead Spend</div>
          <div class="lsroi-tot-val" style="color:var(--red,#E5484D);">${fmtMoney(m.totals.leadCost)}</div>
        </div>
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Per Lead</div>
          <div class="lsroi-tot-val">${fmtMoney(m.totals.costPerLead)}</div>
        </div>
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Return on Lead Spend</div>
          <div class="lsroi-tot-val" style="color:${m.totals.leadRoi >= 100 ? 'var(--green)' : 'var(--red,#E5484D)'};">${m.totals.leadRoi == null ? '—' : m.totals.leadRoi + '%'}</div>
        </div>` : ''}
        ${_marketingSpend > 0 ? `
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Marketing Spend</div>
          <div class="lsroi-tot-val" style="color:var(--red,#E5484D);">${fmtMoney(_marketingSpend)}</div>
        </div>
        <div class="lsroi-tot">
          <div class="lsroi-tot-label">Marketing ROI <span style="opacity:.55;font-weight:normal;">(attributed)</span></div>
          <div class="lsroi-tot-val" style="color:var(--green);">${_marketingRoi == null ? '—' : _marketingRoi + '%'}</div>
        </div>` : ''}
      </div>
    `;

    const callouts = [];
    if (m.bestByRevenue && m.bestByRevenue.closedRev > 0) {
      callouts.push(`
        <div class="lsroi-callout">
          <span class="lsroi-callout-icon">🏆</span>
          <div>
            <div class="lsroi-callout-label">Top revenue source</div>
            <div class="lsroi-callout-value">${escHtml(m.bestByRevenue.source)} — ${fmtMoney(m.bestByRevenue.closedRev)}</div>
          </div>
        </div>
      `);
    }
    if (m.bestByConversion && m.bestByConversion.source !== m.bestByRevenue?.source) {
      callouts.push(`
        <div class="lsroi-callout">
          <span class="lsroi-callout-icon">🎯</span>
          <div>
            <div class="lsroi-callout-label">Best conversion (3+ leads)</div>
            <div class="lsroi-callout-value">${escHtml(m.bestByConversion.source)} — ${m.bestByConversion.conversionRate}%</div>
          </div>
        </div>
      `);
    }
    const calloutsHtml = callouts.length
      ? `<div class="lsroi-callouts">${callouts.join('')}</div>`
      : '';

    const maxRev = Math.max(...m.rows.map(r => r.closedRev), 1);
    const tableRows = m.rows.map(r => {
      const barPct = Math.round((r.closedRev / maxRev) * 100);
      // Per-source marketing ROI (when this source's name matches logged
      // marketing spend). closedRev / spend.
      const srcSpend = r.leadCost > 0 ? r.leadCost : (_marketingBySource[(r.source || '').trim().toLowerCase()] || 0);
      const srcRoiTag = srcSpend > 0
        ? `<div style="font-size:10px;color:var(--m,#8892A4);">${fmtMoney(srcSpend)} spent · ROI ${Math.round((r.closedRev / srcSpend) * 100)}%</div>`
        : '';
      return `
        <tr>
          <td class="lsroi-source">${escHtml(r.source)}${srcRoiTag}</td>
          <td class="lsroi-num">${r.total}</td>
          <td class="lsroi-num">${r.closed}</td>
          <td class="lsroi-num">${r.lost}</td>
          <td class="lsroi-num lsroi-rate">${r.conversionRate}%</td>
          <td class="lsroi-num">${fmtMoney(r.pipeValue)}</td>
          <td class="lsroi-num lsroi-rev">
            ${fmtMoney(r.closedRev)}
            <div class="lsroi-bar"><div class="lsroi-bar-fill" style="width:${barPct}%;"></div></div>
          </td>
          <td class="lsroi-num">${fmtMoney(r.avgDealSize)}</td>
        </tr>
      `;
    }).join('');

    el.innerHTML = `
      ${totalsBar}
      ${calloutsHtml}
      <div class="lsroi-table-wrap">
        <table class="lsroi-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Leads</th>
              <th>Closed</th>
              <th>Lost</th>
              <th>Conv.</th>
              <th>Open Pipeline</th>
              <th>Closed Rev</th>
              <th>Avg Deal</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    `;
  }

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────
  const LeadSourceROI = {
    render,
    compute: () => computeMetrics(window._leads || []),
    init(targetId) {
      this._targetId = targetId;
      render(targetId);
      // Live-update on lead changes.
      document.addEventListener('leadsChanged', () => { _marketingSpend = null; render(targetId); });
    }
  };

  window.LeadSourceROI = LeadSourceROI;
})();
