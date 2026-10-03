/**
 * NBD Pro — Profit Margin Tracker
 * Adds cost tracking per job (material cost, labor cost, overhead)
 * and computes margins across the pipeline. Extends KPI dashboard with
 * margin analytics, per-job P&L breakdown, and profitability trends.
 *
 * Exposes: window.ProfitTracker
 */

let _NBD_PT_DELEGATE; // module-local (globals Tranche 1 — was window.*)
(function() {
  'use strict';

  // Default overhead % applied to all jobs (configurable)
  const DEFAULT_OVERHEAD_PCT = 10;

  // Overhead % reader: `parseFloat(x) || DEFAULT` swallows a legit 0 (the
  // #1139 rule) — a shop that runs 0% overhead could never save it; the value
  // silently re-wrote itself to 10 on save, read AND form re-hydration. 0 is
  // a real business answer here, so only non-numeric falls to the default.
  function overheadPctFrom(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : DEFAULT_OVERHEAD_PCT;
  }

  // ═════════════════════════════════════════════════════════════
  // COST DATA MANAGEMENT
  // ═════════════════════════════════════════════════════════════

  /**
   * Save cost data for a lead/job
   * Fields: materialCost, laborCost, overheadPct, miscCosts, costNotes
   */
  async function saveJobCosts(leadId, costs) {
    if (!window.db || !window._user || !leadId) return false;
    try {
      const data = {
        materialCost: parseFloat(costs.materialCost) || 0,
        laborCost: parseFloat(costs.laborCost) || 0,
        overheadPct: overheadPctFrom(costs.overheadPct),
        miscCosts: parseFloat(costs.miscCosts) || 0,
        costNotes: (costs.costNotes || '').trim()
      };

      await window.updateDoc(window.doc(window.db, 'leads', leadId), data);

      // Update local lead object
      const lead = (window._leads || []).find(l => l.id === leadId);
      if (lead) Object.assign(lead, data);

      if (typeof window.showToast === 'function') window.showToast('Job costs saved', 'ok');
      return true;
    } catch(e) {
      console.error('Save job costs failed:', e);
      if (typeof window.showToast === 'function') window.showToast('Failed to save costs', 'error');
      return false;
    }
  }

  /**
   * Compute P&L for a single lead
   */
  function computeJobPL(lead) {
    const revenue = parseFloat(lead.jobValue) || 0;
    const materialCost = parseFloat(lead.materialCost) || 0;
    const laborCost = parseFloat(lead.laborCost) || 0;
    const overheadPct = overheadPctFrom(lead.overheadPct);
    const miscCosts = parseFloat(lead.miscCosts) || 0;

    const overhead = revenue * (overheadPct / 100);
    const totalCost = materialCost + laborCost + overhead + miscCosts;
    const grossProfit = revenue - materialCost - laborCost - miscCosts;
    const netProfit = revenue - totalCost;
    const grossMargin = revenue > 0 ? Math.round((grossProfit / revenue) * 100) : 0;
    const netMargin = revenue > 0 ? Math.round((netProfit / revenue) * 100) : 0;

    return {
      revenue,
      materialCost,
      laborCost,
      overhead,
      miscCosts,
      totalCost,
      grossProfit,
      netProfit,
      grossMargin,
      netMargin
    };
  }

  /**
   * Compute P&L for a job using its EXPENSE LEDGER as the source of direct
   * costs, instead of the manual materialCost/laborCost/miscCosts fields.
   * This is how the expenses subsystem "feeds" the margin engine.
   *
   * Stays dependency-free: it reads costType/category straight off the expense
   * docs (stamped per expense-config.js), so it needs neither ExpenseConfig nor
   * Firestore. Overhead% + jobValue still come from the lead.
   *   - category 'materials'      -> materialCost
   *   - category 'direct_labor'   -> laborCost
   *   - any other costType==='direct' (subcontractor/equipment/permits/disposal)
   *                               -> miscCosts
   * Overhead-type expenses are intentionally ignored here — they are company
   * operating costs, not a single job's COGS (so gross margin excludes them,
   * matching the "before overhead & commission" label).
   *
   * @param {object} lead
   * @param {Array}  expenses  expense docs for this lead ({amountCents, taxCents, category, costType})
   */
  function computeJobPLWithExpenses(lead, expenses) {
    expenses = expenses || [];
    var matCents = 0, laborCents = 0, miscCents = 0;
    expenses.forEach(function(e) {
      // COGS = the tax-INCLUDED total (amount + tax): sales tax on materials
      // is real cash paid to the supplier, so it belongs in job cost (product
      // decision 2026-07-08). Kept dependency-free — same amount+tax rule is
      // inlined in money-dashboard.js computePnL and expenses.js aggregate().
      var c = (parseInt(e.amountCents, 10) || 0) + (parseInt(e.taxCents, 10) || 0);
      if (e.category === 'materials') matCents += c;
      else if (e.category === 'direct_labor') laborCents += c;
      else if (e.costType === 'direct') miscCents += c;
    });
    var merged = Object.assign({}, lead, {
      materialCost: matCents / 100,
      laborCost: laborCents / 100,
      miscCosts: miscCents / 100
    });
    return computeJobPL(merged);
  }

  /**
   * Compute aggregate margin analytics across all won jobs
   */
  function computeMarginAnalytics() {
    const leads = window._leads || [];
    const WON = ['closed','install_complete','final_photos','final_payment','deductible_collected','collections','warranty_claim','Complete'];
    // Stage role first (custom-pipeline aware, same as Pipeline/Home); the
    // list is the fallback for a page without crm-stages loaded.
    const isWon = (l) => {
      const k = l._stageKey || l.stage || '';
      const r = l._stageRole || (typeof window.stageRole === 'function' ? (function () { try { return window.stageRole(k); } catch (_) { return null; } })() : null);
      return r ? r === 'won' : WON.includes(k);
    };

    const wonJobs = leads.filter(l => isWon(l) && !l.deleted);
    const jobsWithCosts = wonJobs.filter(l => (parseFloat(l.materialCost) || 0) > 0 || (parseFloat(l.laborCost) || 0) > 0);

    if (jobsWithCosts.length === 0) {
      return {
        avgGrossMargin: 0,
        avgNetMargin: 0,
        totalRevenue: wonJobs.reduce((s, l) => s + (parseFloat(l.jobValue) || 0), 0),
        totalCost: 0,
        totalProfit: 0,
        jobsTracked: 0,
        totalJobs: wonJobs.length,
        topMarginJob: null,
        worstMarginJob: null,
        materialPct: 0,
        laborPct: 0
      };
    }

    let totalRevenue = 0, totalMaterial = 0, totalLabor = 0, totalMisc = 0, totalOverhead = 0;
    const pls = [];

    jobsWithCosts.forEach(l => {
      const pl = computeJobPL(l);
      pls.push({ lead: l, pl });
      totalRevenue += pl.revenue;
      totalMaterial += pl.materialCost;
      totalLabor += pl.laborCost;
      totalMisc += pl.miscCosts;
      totalOverhead += pl.overhead;
    });

    const totalCost = totalMaterial + totalLabor + totalMisc + totalOverhead;
    const totalProfit = totalRevenue - totalCost;
    // Portfolio-WEIGHTED margins, not a simple mean of per-job percentages: a
    // $100 job at 50% and a $1M job at 5% blend to ~5%, not 27.5%. Averaging the
    // raw percentages overstated profitability whenever job sizes varied.
    const avgGrossMargin = totalRevenue > 0
      ? Math.round(((totalRevenue - totalMaterial - totalLabor - totalMisc) / totalRevenue) * 100)
      : 0;
    const avgNetMargin = totalRevenue > 0
      ? Math.round((totalProfit / totalRevenue) * 100)
      : 0;

    pls.sort((a, b) => b.pl.grossMargin - a.pl.grossMargin);
    const topMarginJob = pls[0] || null;
    const worstMarginJob = pls[pls.length - 1] || null;

    return {
      avgGrossMargin,
      avgNetMargin,
      totalRevenue,
      totalCost,
      totalProfit,
      jobsTracked: jobsWithCosts.length,
      totalJobs: wonJobs.length,
      topMarginJob: topMarginJob ? {
        name: ((topMarginJob.lead.firstName || '') + ' ' + (topMarginJob.lead.lastName || '')).trim(),
        margin: topMarginJob.pl.grossMargin
      } : null,
      worstMarginJob: worstMarginJob ? {
        name: ((worstMarginJob.lead.firstName || '') + ' ' + (worstMarginJob.lead.lastName || '')).trim(),
        margin: worstMarginJob.pl.grossMargin
      } : null,
      materialPct: totalRevenue > 0 ? Math.round((totalMaterial / totalRevenue) * 100) : 0,
      laborPct: totalRevenue > 0 ? Math.round((totalLabor / totalRevenue) * 100) : 0
    };
  }

  // ═════════════════════════════════════════════════════════════
  // UI: Cost Entry Panel (injected into lead detail/modal)
  // ═════════════════════════════════════════════════════════════

  /**
   * Render cost entry fields — call from customer detail or lead modal
   * @param {string} containerId - DOM element ID to inject into
   * @param {string} leadId
   */
  function renderCostPanel(containerId, leadId, expenses) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return;

    // When the job has logged expenses, the margin summary reflects them
    // (computeJobPLWithExpenses); otherwise fall back to the manual cost fields.
    const expFed = !!(expenses && expenses.length);
    const pl = expFed ? computeJobPLWithExpenses(lead, expenses) : computeJobPL(lead);
    const marginColor = pl.grossMargin >= 40 ? 'var(--green,#16a34a)' : pl.grossMargin >= 25 ? 'var(--gold,#eab308)' : 'var(--red,#dc2626)';
    // No direct cost entered = the margin is UNKNOWN, not 100% (2026-09-29).
    // With every box blank the panel read "100% margin · $9.8K gross profit ·
    // $980 total cost" — a perfect margin nobody supplied, beside a total that
    // was only the overhead percentage. Same rule as the Product Library's
    // "Cost not set".
    const costsSet = expFed || (pl.materialCost + pl.laborCost + pl.miscCosts) > 0;
    const escT = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    el.innerHTML = `
      <div class="ptx-bgs-bd1pxsolid-r12px">
        <div class="ptx-dflex-aicenter-jcspacebet">
          <h4 class="ptx-m0-ffbarlowco-fs16px">💲 Job Costs & Profit</h4>
          ${pl.revenue > 0 && costsSet ? `<span style="background:color-mix(in srgb, ${marginColor} 13%, transparent);color:${marginColor};padding:4px 12px;border-radius:20px;font-size:13px;font-weight:700;">${pl.grossMargin}% margin</span>` : ''}
        </div>
        ${expFed ? `<div class="ptx-fs10px-cgreen-m10px014p">✓ Margin reflects ${expenses.length} logged expense${expenses.length > 1 ? 's' : ''} — $${formatPT(pl.materialCost + pl.laborCost + pl.miscCosts)} direct cost from the Expenses ledger.</div>` : ''}
        <div class="ptx-dgrid-gtc1fr1fr-gap12px">
          <div>
            <label class="ptx-fs11px-cm-ttuppercas">Material Cost</label>
            <input id="ptMaterial" type="number" step="0.01" value="${lead.materialCost || ''}"
              style="width:100%;padding:10px;background:var(--s2,rgba(255,255,255,.04));border:1px solid var(--br,rgba(255,255,255,.1));border-radius:8px;color:var(--t,#fff);font-size:14px;margin-top:4px;box-sizing:border-box;">
          </div>
          <div>
            <label class="ptx-fs11px-cm-ttuppercas">Labor Cost</label>
            <input id="ptLabor" type="number" step="0.01" value="${lead.laborCost || ''}"
              style="width:100%;padding:10px;background:var(--s2,rgba(255,255,255,.04));border:1px solid var(--br,rgba(255,255,255,.1));border-radius:8px;color:var(--t,#fff);font-size:14px;margin-top:4px;box-sizing:border-box;">
          </div>
          <div>
            <label class="ptx-fs11px-cm-ttuppercas">Misc / Other</label>
            <input id="ptMisc" type="number" step="0.01" value="${lead.miscCosts || ''}"
              style="width:100%;padding:10px;background:var(--s2,rgba(255,255,255,.04));border:1px solid var(--br,rgba(255,255,255,.1));border-radius:8px;color:var(--t,#fff);font-size:14px;margin-top:4px;box-sizing:border-box;">
          </div>
          <div>
            <label class="ptx-fs11px-cm-ttuppercas">Overhead %</label>
            <input id="ptOverhead" type="number" step="1" value="${overheadPctFrom(lead.overheadPct)}"
              style="width:100%;padding:10px;background:var(--s2,rgba(255,255,255,.04));border:1px solid var(--br,rgba(255,255,255,.1));border-radius:8px;color:var(--t,#fff);font-size:14px;margin-top:4px;box-sizing:border-box;">
          </div>
        </div>
        <div class="ptx-mb16px">
          <label class="ptx-fs11px-cm-ttuppercas">Cost Notes</label>
          <textarea id="ptNotes" rows="2" class="ptx-wd100-p10px-bgs2">${escT(lead.costNotes)}</textarea>
        </div>

        ${pl.revenue > 0 && !costsSet ? '<div class="ptx-cm-fs12px-tacenter">Costs not set — enter material, labor or misc cost (or log expenses on this job) to see the margin.</div>' : ''}
        ${pl.revenue > 0 && costsSet ? `
        <div class="ptx-bgs2-r8px-p14px">
          <div class="ptx-dgrid-gtcrepeat31-gap10px">
            <div>
              <div class="ptx-fs18px-w800-cgreen">$${formatPT(pl.grossProfit)}</div>
              <div class="ptx-fs10px-cm">GROSS PROFIT <span class="ptx-opa75">(before overhead)</span></div>
            </div>
            <div>
              <div style="font-size:18px;font-weight:800;color:${marginColor};">${pl.grossMargin}%</div>
              <div class="ptx-fs10px-cm">GROSS MARGIN</div>
            </div>
            <div>
              <div class="ptx-fs18px-w800-corange">$${formatPT(pl.totalCost)}</div>
              <div class="ptx-fs10px-cm">TOTAL COST <span class="ptx-opa75">(incl. ${escT(overheadPctFrom(lead.overheadPct))}% overhead)</span></div>
            </div>
          </div>
        </div>` : ''}
        ${pl.revenue > 0 ? '' : '<div class="ptx-cm-fs12px-tacenter">Set a Job Value on this lead to see margin calculations</div>'}

        <button type="button" class="btn btn-orange" data-pt-action="save" data-pt-id="${leadId}"
          style="width:100%;justify-content:center;">
          Save Costs
        </button>
      </div>
    `;

    // On the first (no-expenses) render, pull this job's logged expenses and
    // re-render with ledger-fed margin. Non-breaking: existing 2-arg callers
    // still work; the panel just upgrades once expenses load. Owner-scoped
    // query (userId==uid + leadId) — falls back silently on any error.
    if (expenses === undefined) {
      _fetchLeadExpenses(leadId).then(function (exps) {
        if (exps && exps.length) renderCostPanel(containerId, leadId, exps);
      });
    }
  }

  // Fetch a lead's expenses for the cost panel. Returns [] on any failure.
  async function _fetchLeadExpenses(leadId) {
    const db = window.db || window._db;
    const uid = window._user && window._user.uid;
    if (!db || !uid || !window.getDocs || !window.query || !window.where || !window.collection) return [];
    try {
      // Role-scoped to match the Expenses/Money views: staff read the whole
      // tenant's expenses for the job (companyId); everyone else their own
      // (userId). Otherwise the same job showed different costs by role+surface
      // (QA finding). Both shapes ride the {userId|companyId, leadId, date} index.
      const claims = window._userClaims || {};
      const staff = (claims.role === 'company_admin' || claims.role === 'manager' || claims.role === 'admin') && claims.companyId;
      const scope = staff ? window.where('companyId', '==', claims.companyId) : window.where('userId', '==', uid);
      const snap = await window.getDocs(window.query(
        window.collection(db, 'expenses'), scope, window.where('leadId', '==', leadId)));
      return snap.docs.map(function (d) { return d.data(); });
    } catch (e) { return []; }
  }

  /**
   * Save from the rendered cost panel
   */
  function saveFromPanel(leadId) {
    saveJobCosts(leadId, {
      materialCost: document.getElementById('ptMaterial')?.value,
      laborCost: document.getElementById('ptLabor')?.value,
      miscCosts: document.getElementById('ptMisc')?.value,
      overheadPct: document.getElementById('ptOverhead')?.value,
      costNotes: document.getElementById('ptNotes')?.value
    }).then(ok => {
      if (ok) {
        // NEW-D17: re-render this panel so totals / margin badge update live
        // (it re-reads the lead that saveJobCosts just updated).
        renderCostPanel('profitPanel', leadId);
        // Re-render KPI row to reflect updated margins
        if (typeof window.renderKPIRow === 'function') window.renderKPIRow();
      }
    });
  }

  // ═════════════════════════════════════════════════════════════
  // KPI EXTENSION: Margin card added to KPI row
  // ═════════════════════════════════════════════════════════════

  /**
   * Returns HTML for a margin KPI card — call after renderKPIRow
   */
  function getMarginKPICard() {
    const m = computeMarginAnalytics();
    if (m.jobsTracked === 0) return '';

    const marginColor = m.avgGrossMargin >= 40 ? 'var(--green,#16a34a)' : m.avgGrossMargin >= 25 ? 'var(--gold,#eab308)' : 'var(--red,#dc2626)';

    return `
      <div class="kpi-card" style="border-left:3px solid ${marginColor};">
        <div class="kpi-icon">💲</div>
        <div class="kpi-data">
          <div class="kpi-value" style="color:${marginColor};">${m.avgGrossMargin}%</div>
          <div class="kpi-label">Avg Margin</div>
          <div class="kpi-sub">${m.jobsTracked} jobs tracked · $${formatPT(m.totalProfit)} profit</div>
        </div>
      </div>
    `;
  }

  function formatPT(n) {
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(Math.abs(n) >= 10000 ? 0 : 1) + 'K';
    return Math.round(n).toLocaleString();
  }

  window.ProfitTracker = {
    save: saveFromPanel,
    saveJobCosts,
    computeJobPL,
    computeJobPLWithExpenses,
    computeMarginAnalytics,
    renderCostPanel,
    getMarginKPICard
  };

})();


(function(){if(_NBD_PT_DELEGATE)return;_NBD_PT_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-pt-action]');if(!t)return;if(t.dataset.ptAction==='save'&&window.ProfitTracker&&window.ProfitTracker.save)window.ProfitTracker.save(t.dataset.ptId);});})();
