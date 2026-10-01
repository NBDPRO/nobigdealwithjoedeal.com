/**
 * NBD Pro — Pipeline Forecasting Widget
 *
 * Multiplies each open lead's jobValue by an industry-typical close
 * probability for its stage, summing to an expected-revenue figure.
 * Surfaces:
 *   - Weighted pipeline value (Σ jobValue × stageProbability)
 *   - Best / Likely / Worst-case scenarios
 *   - Top 5 weighted deals (highest jobValue × probability)
 *   - At-risk callout (deals stuck >30 days at high value)
 *
 * Uses the same window._leads cache as the rest of the dashboard.
 * Re-renders on `leadsChanged`.
 *
 * IIFE exposed as window.Forecasting.
 */
(function() {
  'use strict';

  // Stage close-probability table. Calibrated for residential roofing
  // pipelines — adjust per company by editing this map. Stage keys
  // mirror crm-stages.js S.* constants (snake_case).
  const STAGE_PROB = {
    'new':                          0.05,
    'contacted':                    0.10,
    'inspected':                    0.25,
    'claim_filed':                  0.35,
    'adjuster_meeting_scheduled':   0.45,
    'adjuster_inspection_done':     0.55,
    'scope_received':               0.65,
    'estimate_submitted':           0.70,
    'supplement_requested':         0.65,
    'supplement_approved':          0.80,
    'estimate_sent_cash':           0.50,
    'negotiating':                  0.60,
    'prequal_sent':                 0.40,
    'loan_approved':                0.70,
    'contract_signed':              0.95,
    // Anything past contract is essentially won (job phase)
    'job_created':                  1.00,
    'permit_pulled':                1.00,
    'materials_ordered':            1.00,
    'materials_delivered':          1.00,
    'crew_scheduled':               1.00,
    'install_in_progress':          1.00,
    'install_complete':             1.00,
    'final_photos':                 1.00,
    'deductible_collected':         1.00,
    'final_payment':                1.00,
    'closed':                       1.00,
    'lost':                         0.00
  };

  // Best / worst case multipliers — applied to the WEIGHTED expected
  // value. Best = pipeline closes at +30% above expectation, Worst = -40%.
  const SCENARIO_MULT = {
    best:    1.30,
    likely:  1.00,
    worst:   0.60
  };

  function probability(lead, emp) {
    const key = lead._stageKey || lead.stage || 'new';
    const prior = STAGE_PROB[key] != null ? STAGE_PROB[key] : 0.10;
    // Blend the tenant's own stageHistory-derived win-rate toward the industry
    // prior when the empirical engine is loaded and has samples for this stage.
    const FE = (typeof window !== 'undefined') && window.ForecastEmpirical;
    if (emp && FE) return FE.blendedProbability(key, emp, prior);
    return prior;
  }

  // Build the tenant-specific empirical model once per forecast (or null when
  // the engine isn't loaded — probability() then uses the static table).
  function buildEmpirical(leads) {
    const FE = (typeof window !== 'undefined') && window.ForecastEmpirical;
    if (!FE) return null;
    const isWon = (typeof window.isWonStage === 'function')
      ? window.isWonStage : (k => STAGE_PROB[k] === 1.00);
    const isLost = (typeof window.isLostStage === 'function')
      ? window.isLostStage : (k => STAGE_PROB[k] === 0.00);
    return FE.computeEmpiricalRates(leads, { isWon, isLost });
  }
  function toNum(v) { return parseFloat(v) || 0; }

  function ageInDays(lead) {
    const ts = lead.stageStartedAt?.toDate ? lead.stageStartedAt.toDate()
            : lead.createdAt?.toDate     ? lead.createdAt.toDate()
            : null;
    if (!ts) return null;
    return Math.floor((Date.now() - ts.getTime()) / 86400000);
  }

  // ────────────────────────────────────────────────────────────────────
  // Compute
  // ────────────────────────────────────────────────────────────────────
  function computeForecast() {
    const leads = (window._leads || []).filter(l => !l.isProspect && !l.deleted);
    const emp = buildEmpirical(leads);
    let weighted = 0;
    let unweighted = 0;
    let openCount = 0;
    const ranked = [];

    // The empirical win rates stay per customer; the forecast sums every JOB
    // (a customer's second job's value is its own — jobs-store.js recordsFor).
    const recs = (window.NBDJobs && typeof window.NBDJobs.recordsFor === 'function') ? window.NBDJobs.recordsFor(leads) : leads;
    for (const lead of recs) {
      const value = toNum(lead.jobValue);
      const stageKey = lead._stageKey || lead.stage || 'new';
      const prior = STAGE_PROB[stageKey] != null ? STAGE_PROB[stageKey] : 0.10;

      // Skip won/job (prior 1.00) and lost (0.00) — those are revenue/dead,
      // not open pipeline. Gate on the ROLE (static prior + stageRole), NEVER
      // the blended value, so a 0.99 empirical win-rate on a job stage can't
      // leak a completed job back into the open forecast.
      if (prior === 1.00 || prior === 0.00) continue;
      if (typeof window.isWonStage === 'function' && window.isWonStage(stageKey)) continue;
      if (typeof window.isLostStage === 'function' && window.isLostStage(stageKey)) continue;
      if (value <= 0) continue;

      const prob = probability(lead, emp);
      openCount++;
      const expected = value * prob;
      weighted += expected;
      unweighted += value;

      ranked.push({
        id:     lead.id,
        name:   (`${lead.firstName || ''} ${lead.lastName || ''}`.trim() || lead.address || 'Lead') + (lead._jobTitle ? ' — ' + lead._jobTitle : ''),
        stage:  stageKey,
        value,
        prob,
        expected,
        ageDays: ageInDays(lead),
      });
    }

    // Top 5 weighted deals (highest expected $)
    const topDeals = [...ranked].sort((a, b) => b.expected - a.expected).slice(0, 5);

    // At-risk: high value (>$10K) AND stuck 30+ days AND not yet
    // contract-signed. The contract-signed stage (0.95 prob) is treated
    // as effectively won so we exclude it from risk; everything below it
    // can still slip if the homeowner ghosts the rep.
    const atRisk = ranked.filter(r =>
      r.value >= 10000 && r.prob < 0.95 && r.ageDays != null && r.ageDays > 30
    ).sort((a, b) => b.value - a.value).slice(0, 5);

    return {
      openCount,
      unweighted,
      weighted,
      scenarios: {
        best:   weighted * SCENARIO_MULT.best,
        likely: weighted * SCENARIO_MULT.likely,
        worst:  weighted * SCENARIO_MULT.worst
      },
      topDeals,
      atRisk,
      // How the weights were derived, for the confidence line. Empirical once
      // the tenant has a meaningful resolved sample; industry table until then.
      basis: (emp && emp.totalResolved >= 5)
        ? { mode: 'empirical', resolved: emp.totalResolved, won: emp.totalWon }
        : { mode: 'industry', resolved: emp ? emp.totalResolved : 0 }
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

  function render(targetId) {
    const el = document.getElementById(targetId);
    if (!el) return;
    const f = computeForecast();
    const stageLabel = window.stageLabel || (k => String(k).replace(/_/g, ' '));

    if (f.openCount === 0) {
      el.innerHTML = `
        <div class="fc-empty">
          <div class="fc-empty-icon">📈</div>
          <div class="fc-empty-title">No open deals to forecast yet</div>
          <div class="fc-empty-sub">Once you have a few leads in flight, this panel projects expected revenue based on stage probabilities.</div>
        </div>
      `;
      return;
    }

    const scenariosHtml = `
      <div class="fc-scenarios">
        <div class="fc-scenario fc-scenario-worst">
          <div class="fc-scen-label">Worst Case</div>
          <div class="fc-scen-val">${fmtMoney(f.scenarios.worst)}</div>
          <div class="fc-scen-sub">Pipeline × 60%</div>
        </div>
        <div class="fc-scenario fc-scenario-likely">
          <div class="fc-scen-label">Most Likely</div>
          <div class="fc-scen-val">${fmtMoney(f.scenarios.likely)}</div>
          <div class="fc-scen-sub">Stage × Probability</div>
        </div>
        <div class="fc-scenario fc-scenario-best">
          <div class="fc-scen-label">Best Case</div>
          <div class="fc-scen-val">${fmtMoney(f.scenarios.best)}</div>
          <div class="fc-scen-sub">Pipeline × 130%</div>
        </div>
      </div>
    `;

    const breakdownHtml = `
      <div class="fc-breakdown">
        <div class="fc-bd-row">
          <span class="fc-bd-label">Open deals</span>
          <span class="fc-bd-val">${f.openCount}</span>
        </div>
        <div class="fc-bd-row">
          <span class="fc-bd-label">Total pipeline (raw)</span>
          <span class="fc-bd-val">${fmtMoney(f.unweighted)}</span>
        </div>
        <div class="fc-bd-row fc-bd-emphasis">
          <span class="fc-bd-label">Weighted (expected)</span>
          <span class="fc-bd-val">${fmtMoney(f.weighted)}</span>
        </div>
      </div>
    `;

    const topRows = f.topDeals.map(d => `
      <div class="fc-deal-row" data-lead-id="${escHtml(d.id)}">
        <div class="fc-deal-name">${escHtml(d.name)}</div>
        <div class="fc-deal-stage">${escHtml(stageLabel(d.stage))}</div>
        <div class="fc-deal-prob">${Math.round(d.prob * 100)}%</div>
        <div class="fc-deal-value">${fmtMoney(d.value)}</div>
        <div class="fc-deal-expected">${fmtMoney(d.expected)}</div>
      </div>
    `).join('');

    const atRiskHtml = f.atRisk.length ? `
      <div class="fc-section">
        <div class="fc-section-title">⚠️ At-risk deals (high value, stalled 30+ days)</div>
        ${f.atRisk.map(d => `
          <div class="fc-deal-row fc-risk" data-lead-id="${escHtml(d.id)}">
            <div class="fc-deal-name">${escHtml(d.name)}</div>
            <div class="fc-deal-stage">${escHtml(stageLabel(d.stage))} · ${d.ageDays}d</div>
            <div class="fc-deal-prob">${Math.round(d.prob * 100)}%</div>
            <div class="fc-deal-value">${fmtMoney(d.value)}</div>
            <div class="fc-deal-expected">${fmtMoney(d.expected)}</div>
          </div>
        `).join('')}
      </div>
    ` : '';

    el.innerHTML = `
      ${scenariosHtml}
      ${breakdownHtml}
      ${f.basis && f.basis.mode === 'empirical'
        ? `<div class="fc-basis" style="font-size:11px;color:var(--m);padding:4px 2px 8px;">📊 Forecast tuned to your ${f.basis.resolved} closed deals (${Math.round(100 * f.basis.won / Math.max(1, f.basis.resolved))}% overall win-rate)</div>`
        : `<div class="fc-basis" style="font-size:11px;color:var(--m);padding:4px 2px 8px;">Using industry-standard stage odds — your own win-rates take over after ~5 closed deals${f.basis && f.basis.resolved ? ` (${f.basis.resolved} logged)` : ''}.</div>`}
      <div class="fc-section">
        <div class="fc-section-title">Top 5 weighted deals</div>
        <div class="fc-deal-list">
          <div class="fc-deal-row fc-deal-head">
            <div>Customer</div>
            <div>Stage</div>
            <div>Prob.</div>
            <div>Value</div>
            <div>Expected</div>
          </div>
          ${topRows}
        </div>
      </div>
      ${atRiskHtml}
    `;

    // Click a deal row → open the card detail modal
    el.querySelectorAll('.fc-deal-row[data-lead-id]').forEach(row => {
      row.addEventListener('click', () => {
        if (typeof window.openCardDetailModal === 'function') {
          window.openCardDetailModal(row.dataset.leadId);
        }
      });
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────────────
  const Forecasting = {
    render,
    compute: computeForecast,
    STAGE_PROB,  // exposed so power users can edit the probability table
    init(targetId) {
      this._targetId = targetId;
      render(targetId);
      document.addEventListener('leadsChanged', () => render(targetId));
    }
  };

  window.Forecasting = Forecasting;
})();
