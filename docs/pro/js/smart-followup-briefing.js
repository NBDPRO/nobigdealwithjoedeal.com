/**
 * smart-followup-briefing.js — Wave 115 (Morning briefing widget)
 *
 * Dashboard home widget that surfaces the rep's top 5 follow-up
 * suggestions for the day. Compounds the W111 SmartFollowup
 * compute + W114 Claude enrichment + the existing dashboard
 * widget pattern (W29 Hot Leads / W45 Almost There / W55 Stale
 * Shares).
 *
 * Render flow:
 *   1. Compute heuristic suggestions for every active lead
 *   2. Filter to priority ∈ {urgent, today} and confidence ≥ 50
 *   3. Sort by SmartFollowup.score (priority × 100 + confidence)
 *   4. Take top 5
 *   5. Render rows: priority chip + headline + reasoning + W47-style
 *      inline action buttons (📞/💬/📧/🔍/💤)
 *   6. Optionally enrich the top 5 via AI in the background and
 *      re-render rows with improved headlines
 *
 * Bounded API spend: only the top 5 hit Claude, not every lead.
 *
 * Path-gated to /pro/dashboard.html. Updates on:
 *   - DOMContentLoaded + 1.7s defer
 *   - 'nbd:data-refreshed' event
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['smart-followup-briefing']) return;
  __NBD_LOADED['smart-followup-briefing'] = true;

  const PATH = window.location.pathname || '';
  // /pro/explore/dashboard is the sample account's copy of the same page.
  if (!/\/pro\/(?:explore\/)?dashboard(?:\.html)?$/.test(PATH)) return;

  const TOP_N = 5;
  const TERMINAL_STAGES = new Set(['closed', 'lost', 'complete']);

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function leadName(l) {
    if (!l) return 'Unknown';
    const full = `${l.firstName || ''} ${l.lastName || ''}`.trim();
    return full || (l.address || '').split(',')[0] || 'Lead';
  }

  // ─── Compute top-5 candidates ────────────────────────────────────
  // W138: sort by NBDLeadScore (W135) when the engine is loaded —
  // this gives the briefing the same priority signal as kanban
  // (W136), customer page (W137), bell (W138). Falls back to the
  // W111 SmartFollowup score when the engine isn't available so the
  // briefing keeps working even on older client builds mid-deploy.
  function computeTopCandidates() {
    if (!window.SmartFollowup || typeof window.SmartFollowup.computeSuggestion !== 'function') return [];
    const SF = window.SmartFollowup;
    const useUnifiedScore = !!(window.NBDLeadScore && window.NBDLeadScore.breakdown);
    const ctx = { estimates: window._estimates || [] };
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const candidates = [];
    for (const lead of leads) {
      if (!lead || lead.deleted) continue;
      const sk = (lead._stageKey || lead.stage || '').toString().toLowerCase();
      if (TERMINAL_STAGES.has(sk)) continue;
      const sug = SF.computeSuggestion(lead);
      if (!sug) continue;
      // Only briefing-worthy: urgent or today, with confidence ≥ 50
      if (sug.priority !== 'urgent' && sug.priority !== 'today') continue;
      if ((sug.confidence || 0) < 50) continue;
      // W138: prefer the unified W135 score so a lead at 92 with
      // 'today' priority outranks a lead at 70 with 'urgent' — the
      // unified score already incorporates priority into its 'smart'
      // weight, plus pulls in engagement, hot signals, and recency
      // that priorityRank alone misses.
      const score = useUnifiedScore
        ? window.NBDLeadScore.breakdown(lead, ctx).score
        : SF.score(sug);
      candidates.push({ lead, sug, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, TOP_N);
  }

  // ─── Render ──────────────────────────────────────────────────────
  function render() {
    const body = document.getElementById('smart-followup-briefing-body');
    if (!body) return;
    const candidates = computeTopCandidates();
    if (candidates.length === 0) {
      body.innerHTML = `
        <div style="padding:22px 18px; text-align:center; color:var(--m,#9aa3b2); font-size:12px;">
          <div style="font-size:24px; margin-bottom:6px; opacity:0.6;">☕</div>
          <div style="font-weight:600; color:var(--t,#e8eaf0); margin-bottom:3px;">Nothing urgent today.</div>
          <div>Your active leads are quiet — good time to prospect.</div>
        </div>`;
      return;
    }

    body.innerHTML = candidates.map(({ lead, sug }) => _renderRow(lead, sug)).join('');
    _wireRows(body);

    // W115 + W114: enrich the top 5 via AI in the background.
    // Bounded — exactly 5 API calls max per render. Re-render
    // each row in place when AI returns.
    // Not in the sample account: its callClaude has no model and answers each
    // call with an "AI features run on NBD Pro servers" toast, five a visit.
    if (typeof window.SmartFollowup.enrichSuggestionAI === 'function'
        && !(window.__NBD_DEMO__ && window.__NBD_DEMO__.active)) {
      candidates.forEach(({ lead, sug }) => {
        window.SmartFollowup.enrichSuggestionAI(lead).then(enriched => {
          if (!enriched || !enriched._aiEnriched) return;
          const row = body.querySelector(`[data-sfb-lead-id="${escapeHtml(lead.id)}"]`);
          if (!row) return;
          // Update headline + add ✨ AI badge in the priority chip area.
          const headlineEl = row.querySelector('.sfb-headline');
          if (headlineEl) headlineEl.textContent = enriched.headline;
          const reasonEl = row.querySelector('.sfb-reason');
          if (reasonEl) reasonEl.textContent = enriched.reasoning;
          const aiBadge = row.querySelector('.sfb-ai-badge');
          if (aiBadge) aiBadge.style.display = 'inline-flex';
        }).catch(() => { /* silent — heuristic stays */ });
      });
    }
  }

  // Priority-label inks (phone audit views#11, 2026-09-25). The pastels were
  // drawn for the dark palette; on the light palette the 9px "TODAY" was
  // #fcd34d on its amber-tinted row at 1.27:1. Light gets a deep ink of the
  // same hue (TODAY 6.25:1, URGENT 5.28:1 on their row tints). The pick reads
  // the palette actually PAINTED (page background luminance), not data-mode —
  // a fresh login's first boot has data-mode="light" on the still-navy page
  // until the lazy theme bundle lands — and _reinkLabels() repaints in place on
  // themechange / modechange, because a full render() would re-spend the five
  // AI enrichment calls.
  const LABEL_INK = {
    urgent: { dark: '#fca5a5', light: '#b91c1c' },
    today:  { dark: '#fcd34d', light: '#92400e' },
  };
  function _paletteIsLight() {
    try {
      const m = String(getComputedStyle(document.body).backgroundColor).match(/[\d.]+/g);
      if (!m || m.length < 3 || (m.length > 3 && +m[3] === 0)) return false;
      return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 > 0.5;
    } catch (_) { return false; }
  }
  function _labelInk(prio) {
    const ink = LABEL_INK[prio] || LABEL_INK.today;
    return _paletteIsLight() ? ink.light : ink.dark;
  }
  function _reinkLabels() {
    const body = document.getElementById('smart-followup-briefing-body');
    if (!body) return;
    body.querySelectorAll('.sfb-label[data-sfb-prio]').forEach((el) => {
      el.style.color = _labelInk(el.getAttribute('data-sfb-prio'));
    });
  }

  function _renderRow(lead, sug) {
    let bg, color, border, icon, label, prio;
    if (sug.priority === 'urgent') {
      prio = 'urgent'; bg = 'rgba(239,68,68,0.10)'; color = _labelInk(prio); border = 'rgba(239,68,68,0.45)'; icon = '⚡'; label = 'Urgent';
    } else {
      prio = 'today'; bg = 'rgba(245,158,11,0.10)'; color = _labelInk(prio); border = 'rgba(245,158,11,0.45)'; icon = '💡'; label = 'Today';
    }

    const phone = String(lead.phone || '').replace(/\D+/g, '');
    const email = String(lead.email || '').trim();
    const actions = [];
    if (phone) {
      actions.push(`<a class="sfb-action" data-sfb-action="call" data-sfb-lead-id="${escapeHtml(lead.id)}" href="tel:${escapeHtml(phone)}" title="Call ${escapeHtml(lead.phone)}" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:rgba(16,185,129,0.14);color:#10b981;text-decoration:none;font-size:14px;-webkit-tap-highlight-color:transparent;transition:transform .12s;">📞</a>`);
      actions.push(`<button class="sfb-action" data-sfb-action="sms" data-sfb-lead-id="${escapeHtml(lead.id)}" type="button" title="Text portal link" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:rgba(59,130,246,0.14);color:#3b82f6;border:none;font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .12s;">💬</button>`);
    }
    if (email) {
      actions.push(`<button class="sfb-action" data-sfb-action="email" data-sfb-lead-id="${escapeHtml(lead.id)}" type="button" title="Email portal link" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:rgba(139,92,246,0.14);color:#8b5cf6;border:none;font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .12s;">📧</button>`);
    }
    if (window.PortalLinkHelpers && typeof window.PortalLinkHelpers.previewForLead === 'function') {
      actions.push(`<button class="sfb-action" data-sfb-action="preview" data-sfb-lead-id="${escapeHtml(lead.id)}" type="button" title="Preview portal" style="display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:6px;background:rgba(245,158,11,0.14);color:#f59e0b;border:none;font-size:14px;cursor:pointer;-webkit-tap-highlight-color:transparent;transition:transform .12s;">🔍</button>`);
    }

    // .sfb-text / .sfb-actions are the phone hooks: at <=600px
    // dashboard-app.css drops the actions to a second grid row and lets the
    // headline wrap to two lines, because four actions beside the text left
    // the headline 43-95px and cut every row to "Send portal lin…" before
    // the customer's name (phone audit views#5, 2026-09-25).
    return `
      <div class="sfb-row" data-sfb-lead-id="${escapeHtml(lead.id)}"
        style="display:grid; grid-template-columns:auto 1fr auto; gap:10px; align-items:center; padding:10px 12px; border-radius:8px; background:${bg}; border:1px solid ${border}; margin-bottom:6px; cursor:pointer; -webkit-tap-highlight-color:transparent;"
        title="Open ${escapeHtml(leadName(lead))}">
        <div style="font-size:18px; flex-shrink:0;" aria-hidden="true">${icon}</div>
        <div class="sfb-text" style="min-width:0;">
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:2px;">
            <span class="sfb-label" data-sfb-prio="${prio}" style="font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:${color};">${escapeHtml(label)}</span>
            <span style="font-size:9px; color:var(--m,#9aa3b2); font-weight:500;">· ${escapeHtml(String(sug.confidence))}%</span>
            <span class="sfb-ai-badge" title="AI-enriched" style="display:none; font-size:9px; color:#a78bfa; font-weight:600; padding:1px 6px; border-radius:8px; background:rgba(167,139,250,0.14); border:1px solid rgba(167,139,250,0.35);">✨ AI</span>
          </div>
          <div class="sfb-headline" style="font-size:13px; font-weight:600; color:var(--t,#e8eaf0); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(sug.headline)}</div>
          <div class="sfb-reason" style="font-size:11px; color:var(--m,#9aa3b2); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(sug.reasoning)}</div>
        </div>
        <div class="sfb-actions" style="display:flex; gap:4px; flex-shrink:0; align-items:center;">${actions.join('')}</div>
      </div>`;
  }

  function _wireRows(body) {
    body.querySelectorAll('.sfb-action').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const action = btn.getAttribute('data-sfb-action');
        const id = btn.getAttribute('data-sfb-lead-id');
        if (!id) return;
        const lead = (Array.isArray(window._leads) ? window._leads : []).find(l => l && l.id === id);
        if (!lead) return;
        // W116: record the action as a positive outcome so the
        // confidence-adjustment loop learns this rep listens to
        // this signal pattern.
        const sug = (window.SmartFollowup && typeof window.SmartFollowup.computeSuggestion === 'function')
          ? window.SmartFollowup.computeSuggestion(lead) : null;
        if (window.SmartFollowup && window.SmartFollowup.recordOutcome
            && (action === 'sms' || action === 'email' || action === 'call')) {
          window.SmartFollowup.recordOutcome(lead.id, 'acted', sug);
        }
        if (action === 'sms' && window.PortalLinkHelpers) {
          ev.preventDefault();
          window.PortalLinkHelpers.smsForLead(lead);
        } else if (action === 'email' && window.PortalLinkHelpers) {
          ev.preventDefault();
          window.PortalLinkHelpers.emailForLead(lead);
        } else if (action === 'preview' && window.PortalLinkHelpers) {
          ev.preventDefault();
          window.PortalLinkHelpers.previewForLead(lead);
        }
        // 'call' = native tel:; let browser handle.
      });
    });
    // Row click → navigate to customer detail page (W11 handoff).
    body.querySelectorAll('.sfb-row').forEach(row => {
      row.addEventListener('click', (ev) => {
        if (ev.target && ev.target.closest && ev.target.closest('.sfb-action')) return;
        const id = row.getAttribute('data-sfb-lead-id');
        if (!id) return;
        try {
          if (typeof window._stashLeadForCustomerPage === 'function') {
            window._stashLeadForCustomerPage(id);
          }
        } catch (_) {}
        window.location.href = `/pro/customer.html?id=${encodeURIComponent(id)}`;
      });
    });
  }

  // ─── Init ────────────────────────────────────────────────────────
  let _intervalId = null;
  function init() {
    setTimeout(render, 1700);
    window.addEventListener('nbd:data-refreshed', render);
    document.addEventListener('themechange', _reinkLabels);
    document.addEventListener('modechange', _reinkLabels);
    if (_intervalId) clearInterval(_intervalId);
    _intervalId = setInterval(render, 5 * 60_000);
  }
  function destroy() {
    if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
    window.removeEventListener('nbd:data-refreshed', render);
    document.removeEventListener('themechange', _reinkLabels);
    document.removeEventListener('modechange', _reinkLabels);
  }
  window.addEventListener('pagehide', destroy);

  const SmartFollowupBriefing = {
    render,
    computeTopCandidates,
    destroy,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
