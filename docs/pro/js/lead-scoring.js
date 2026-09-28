/**
 * NBD Pro — AI Lead Scoring Engine
 * Rule-based scoring system that assigns a 0-100 "heat score" to every lead
 * based on signals already in Firestore: job value, insurance status, source,
 * response time, follow-up engagement, stage velocity, and more.
 *
 * Exposes: window.LeadScoring
 */

(function() {
  'use strict';

  // ═════════════════════════════════════════════════════════════
  // SCORING RULES — weighted signals (total max ≈ 100)
  // ═════════════════════════════════════════════════════════════

  const RULES = {
    // Job value signals (max 25 pts)
    jobValue: {
      weight: 25,
      score: (lead) => {
        const v = parseFloat(lead.jobValue) || 0;
        if (v >= 20000) return 1.0;
        if (v >= 12000) return 0.85;
        if (v >= 8000)  return 0.7;
        if (v >= 5000)  return 0.5;
        if (v > 0)      return 0.3;
        return 0.05; // No value set = low but not zero
      }
    },

    // Insurance status (max 20 pts)
    insurance: {
      weight: 20,
      score: (lead) => {
        const cs = (lead.claimStatus || '').toLowerCase();
        if (cs.includes('approved')) return 1.0;
        if (cs.includes('filed') || cs.includes('pending')) return 0.7;
        if (lead.insCarrier || lead.insuranceCarrier) return 0.5;
        if (cs === 'no claim' || !cs) return 0.15;
        if (cs.includes('denied')) return 0.1;
        return 0.2;
      }
    },

    // Stage progression speed (max 15 pts)
    stageVelocity: {
      weight: 15,
      score: (lead) => {
        const created = toDate(lead.createdAt);
        if (!created) return 0.3;
        const daysSinceCreated = (Date.now() - created.getTime()) / 86400000;
        const stageHistory = lead.stageHistory || [];

        if (stageHistory.length === 0) {
          // New lead, no movement — score by recency
          if (daysSinceCreated < 1) return 0.9;
          if (daysSinceCreated < 3) return 0.7;
          if (daysSinceCreated < 7) return 0.4;
          return 0.15;
        }

        // Stages per day
        const velocity = stageHistory.length / Math.max(daysSinceCreated, 0.5);
        if (velocity > 2) return 1.0;
        if (velocity > 1) return 0.85;
        if (velocity > 0.5) return 0.65;
        if (velocity > 0.2) return 0.4;
        return 0.2;
      }
    },

    // Lead source quality (max 15 pts)
    source: {
      weight: 15,
      score: (lead) => {
        const src = (lead.source || '').toLowerCase();
        if (src.includes('referral')) return 1.0;
        if (src.includes('google') || src.includes('seo')) return 0.85;
        if (src.includes('website') || src.includes('form')) return 0.75;
        if (src.includes('facebook') || src.includes('social')) return 0.6;
        if (src.includes('door knock') || src.includes('d2d')) return 0.55;
        if (src.includes('storm') || src.includes('canvass')) return 0.7;
        if (src.includes('repeat') || src.includes('existing')) return 0.95;
        return 0.3;
      }
    },

    // Engagement signals (max 10 pts)
    engagement: {
      weight: 10,
      score: (lead) => {
        let s = 0;
        if (lead.email) s += 0.2;
        if (lead.phone) s += 0.2;
        if (lead.notes && lead.notes.length > 20) s += 0.15;
        if (lead.portalUrl) s += 0.15; // Portal was generated
        if (lead.reviewRequested) s += 0.1;
        if (lead.referralCode) s += 0.1;
        if (lead.scheduledDate) s += 0.1;
        return Math.min(s, 1.0);
      }
    },

    // Follow-up responsiveness (max 10 pts)
    followUp: {
      weight: 10,
      score: (lead) => {
        if (!lead.followUp) return 0.3;
        // Local day ('YYYY-MM-DD' parses as UTC — a day early in the US).
        const _m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(lead.followUp));
        const fDate = _m ? new Date(+_m[1], +_m[2] - 1, +_m[3]) : new Date(lead.followUp);
        const now = new Date();
        now.setHours(0,0,0,0);
        fDate.setHours(0,0,0,0);
        const diff = (fDate - now) / 86400000;

        if (diff < -7) return 0.1;   // Way overdue
        if (diff < -3) return 0.2;   // Overdue
        if (diff < 0)  return 0.4;   // Recently overdue
        if (diff === 0) return 0.95;  // Due today
        if (diff <= 2) return 0.8;   // Due soon
        if (diff <= 7) return 0.6;
        return 0.4;
      }
    },

    // Recency bonus (max 5 pts)
    recency: {
      weight: 5,
      score: (lead) => {
        const updated = toDate(lead.updatedAt) || toDate(lead.createdAt);
        if (!updated) return 0.2;
        const daysAgo = (Date.now() - updated.getTime()) / 86400000;
        if (daysAgo < 1) return 1.0;
        if (daysAgo < 3) return 0.8;
        if (daysAgo < 7) return 0.6;
        if (daysAgo < 14) return 0.4;
        if (daysAgo < 30) return 0.2;
        return 0.1;
      }
    }
  };

  // ═════════════════════════════════════════════════════════════
  // SCORING ENGINE
  // ═════════════════════════════════════════════════════════════

  function scoreLead(lead) {
    let total = 0;
    const breakdown = {};

    for (const [key, rule] of Object.entries(RULES)) {
      const raw = rule.score(lead);
      const pts = Math.round(raw * rule.weight);
      breakdown[key] = { raw: Math.round(raw * 100), pts, max: rule.weight };
      total += pts;
    }

    total = Math.min(Math.max(total, 0), 100);

    return {
      score: total,
      grade: getGrade(total),
      color: getColor(total),
      label: getLabel(total),
      breakdown
    };
  }

  function scoreAllLeads() {
    const leads = window._leads || [];
    return leads.filter(l => !l.deleted).map(l => ({
      id: l.id,
      lead: l,
      ...scoreLead(l)
    })).sort((a, b) => b.score - a.score);
  }

  function getGrade(score) {
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 50) return 'C';
    if (score >= 30) return 'D';
    return 'F';
  }

  function getColor(score) {
    if (score >= 85) return '#16a34a';
    if (score >= 70) return '#22c55e';
    if (score >= 50) return '#eab308';
    if (score >= 30) return '#f97316';
    return '#ef4444';
  }

  function getLabel(score) {
    if (score >= 85) return '🔥 Hot';
    if (score >= 70) return '♨️ Warm';
    if (score >= 50) return '🌤️ Moderate';
    if (score >= 30) return '❄️ Cool';
    return '🧊 Cold';
  }

  // ═════════════════════════════════════════════════════════════
  // UI: Score badge for kanban cards
  // ═════════════════════════════════════════════════════════════

  function getScoreBadgeHTML(lead) {
    const { score, color, grade } = scoreLead(lead);
    return `<span style="display:inline-flex;align-items:center;gap:3px;font-size:10px;font-weight:800;font-family:'Barlow Condensed',sans-serif;padding:2px 6px;border-radius:4px;background:${color}22;color:${color};letter-spacing:.04em;" title="Lead Score: ${score}/100">${grade}<span style="font-size:8px;opacity:.7;">${score}</span></span>`;
  }

  /**
   * Render a detailed score breakdown panel
   */
  // NOT MOUNTED ANYWHERE, on purpose (2026-09-07).
// customer-bootstrap.module.js used to call this as
// window.LeadScoring.renderScorePanel(...), which never fired because the
// export key below is `renderPanel`, not `renderScorePanel`. That call was
// removed rather than corrected: lead-score.js / lead-score-panel.js is the
// newer engine, it owns the header chip and its own breakdown on the customer
// page, and it derives a different number from a different factor set. Mount
// this and the page shows two disagreeing 0-100 "lead scores" at once.
// If the deal-quality factors here (jobValue / insurance / source) are worth
// surfacing — they are not in NBDLeadScore — fold them into
// NBDLeadScore.breakdown() or retitle this panel something that is not "Lead
// Score". Do not simply re-point the caller.
function renderScorePanel(containerId, leadId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    const lead = (window._leads || []).find(l => l.id === leadId);
    if (!lead) return;

    const result = scoreLead(lead);
    const { score, color, grade, label, breakdown } = result;

    el.innerHTML = `
      <div style="background:var(--s,#12223D);border:1px solid var(--br,rgba(255,255,255,.08));border-radius:12px;padding:20px;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <h4 style="margin:0;font-family:'Barlow Condensed',sans-serif;font-size:16px;font-weight:700;color:var(--t);">🎯 Lead Score</h4>
          <div style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:28px;font-weight:900;color:${color};font-family:'Barlow Condensed',sans-serif;">${score}</span>
            <div>
              <div style="font-size:14px;font-weight:800;color:${color};">${grade}</div>
              <div style="font-size:10px;color:var(--m,#9ca3af);">${label}</div>
            </div>
          </div>
        </div>
        ${Object.entries(breakdown).map(([key, b]) => {
          const pct = Math.round((b.pts / b.max) * 100);
          return `
          <div style="margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;">
              <span style="color:var(--m,#9ca3af);text-transform:capitalize;">${key.replace(/([A-Z])/g, ' $1')}</span>
              <span style="color:var(--t);font-weight:700;">${b.pts}/${b.max}</span>
            </div>
            <div style="height:4px;background:var(--br,rgba(255,255,255,.08));border-radius:2px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;transition:width .3s;"></div>
            </div>
          </div>`;
        }).join('')}
      </div>
    `;
  }

  // ═════════════════════════════════════════════════════════════
  // HELPERS
  // ═════════════════════════════════════════════════════════════

  function toDate(val) {
    if (!val) return null;
    if (val.toDate) return val.toDate();
    if (val.seconds) return new Date(val.seconds * 1000);
    if (typeof val === 'string') return new Date(val);
    if (val instanceof Date) return val;
    return null;
  }

  window.LeadScoring = {
    score: scoreLead,
    scoreAll: scoreAllLeads,
    badge: getScoreBadgeHTML,
    renderPanel: renderScorePanel,
    getGrade,
    getColor,
    getLabel
  };

})();
