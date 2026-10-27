/**
 * engagement-cohort-widget.js — Wave 94 (Pipeline tier distribution)
 *
 * Aggregate dashboard widget showing how the rep's leads break
 * down by W91/W92 engagement tier. Five horizontal bars:
 *
 *   ✅ Responded
 *   🔥 Hot
 *   👀 Viewed
 *   📨 Sent
 *   🌱 New
 *
 * Each bar's width is proportional to the largest tier count so
 * the dominant cohort always shows full-width and the smaller
 * cohorts read as relative shares. Counts on the right; total
 * shows in the panel header.
 *
 * Excludes:
 *   - Deleted leads
 *   - Terminal-stage leads (closed/lost/complete) — those are
 *     not in the active engagement pipeline. The W91/W92
 *     compute already skips terminal stages for tier ≥ 2 but
 *     we filter them out at the cohort level too so the New
 *     bucket doesn't accumulate every won/lost lead in history.
 *
 * Surfaces patterns:
 *   - Lots of Hot, zero Responded → conversion gap
 *   - Everyone's New → no shares going out (rep needs the
 *     Almost There / Stale Shares widgets)
 *   - Big Sent, no Viewed → broken share links or wrong contact
 *
 * Path-gated to /pro/dashboard.html. Updates on:
 *   - DOMContentLoaded + 1.7s defer
 *   - 'nbd:data-refreshed' event
 *
 * Compounds W91 (CustomerEngagementScore.computeTier) + W92
 * (kanban tier badge) + W93 (sort by tier).
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['engagement-cohort-widget']) return;
  __NBD_LOADED['engagement-cohort-widget'] = true;

  const PATH = window.location.pathname || '';
  // /pro/explore/dashboard is the sample account's copy of the same page.
  if (!/\/pro\/(?:explore\/)?dashboard(?:\.html)?$/.test(PATH)) return;

  const TIER_DEFS = [
    { tier: 4, key: 'responded', label: 'Responded', icon: '✅', bg: 'rgba(251,191,36,0.18)', color: '#fbbf24', border: 'rgba(251,191,36,0.45)' },
    { tier: 3, key: 'hot',       label: 'Hot',       icon: '🔥', bg: 'rgba(251,146,60,0.18)', color: '#fb923c', border: 'rgba(251,146,60,0.45)' },
    { tier: 2, key: 'viewed',    label: 'Viewed',    icon: '👀', bg: 'rgba(46,204,138,0.18)', color: '#5eead4', border: 'rgba(46,204,138,0.45)' },
    { tier: 1, key: 'sent',      label: 'Sent',      icon: '📨', bg: 'rgba(155,109,255,0.18)', color: '#cab8ff', border: 'rgba(155,109,255,0.45)' },
    { tier: 0, key: 'new',       label: 'New',       icon: '🌱', bg: 'rgba(154,163,178,0.14)', color: '#9aa3b2', border: 'rgba(154,163,178,0.45)' },
  ];

  // Light-palette inks (phone audit views#11, 2026-09-25). The tier colours
  // above are pastels drawn for the dark palette; on the light palette's cream
  // panel they fell to 1.40-2.41:1 (Viewed 1.40, Responded 1.58, Sent 1.68).
  // Each tier keeps its hue with a deep ink that clears 4.5:1 there
  // (Responded 4.76, Hot 4.91, Viewed 5.19, Sent 6.73, New 7.18).
  // The switch reads the palette actually PAINTED (the page background's
  // luminance), not data-mode: on a fresh login's first boot the preboot has
  // already stamped data-mode="light" from the OS while the lazy theme bundle
  // has not painted the light palette yet, so a data-mode switch would put
  // these deep inks on the still-navy page. render() re-runs on themechange /
  // modechange, so the inks follow the palette when the bundle lands.
  const LIGHT_INK = { 4: '#b45309', 3: '#c2410c', 2: '#0f766e', 1: '#6d28d9', 0: '#475569' };
  function paletteIsLight() {
    try {
      const m = String(getComputedStyle(document.body).backgroundColor).match(/[\d.]+/g);
      if (!m || m.length < 3 || (m.length > 3 && +m[3] === 0)) return false;
      return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255 > 0.5;
    } catch (_) { return false; }
  }

  function computeCounts() {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const ests  = Array.isArray(window._estimates) ? window._estimates : [];
    const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
    if (!window.CustomerEngagementScore
        || typeof window.CustomerEngagementScore.computeTier !== 'function') {
      return { counts, total: 0 };
    }
    let total = 0;
    for (const l of leads) {
      if (!l || l.deleted) continue;
      const sk = (l._stageKey || l.stage || 'new').toString().toLowerCase();
      if (sk === 'closed' || sk === 'lost' || sk === 'complete') continue;
      const t = window.CustomerEngagementScore.computeTier(l, ests);
      const tier = t ? t.tier : 0;
      counts[tier]++;
      total++;
    }
    return { counts, total };
  }

  // ─── Render ──────────────────────────────────────────────────────
  function render() {
    const body = document.getElementById('engagement-cohort-body');
    const totalEl = document.getElementById('engagement-cohort-total');
    if (!body) return;
    const { counts, total } = computeCounts();

    if (totalEl) totalEl.textContent = total === 0 ? '—' : `${total} total`;

    if (total === 0) {
      body.innerHTML = `
        <div style="padding:22px 18px; text-align:center; color:var(--m,#9aa3b2); font-size:12px;">
          <div style="font-size:24px; margin-bottom:6px; opacity:0.6;">📊</div>
          <div style="font-weight:600; color:var(--t,#e8eaf0); margin-bottom:3px;">No active leads yet.</div>
          <div>Tier distribution will appear once you have pipeline.</div>
        </div>`;
      return;
    }

    // Find the largest count so we can scale bars proportionally.
    const maxCount = Math.max(...TIER_DEFS.map(d => counts[d.tier])) || 1;
    const light = paletteIsLight();

    body.innerHTML = `
      <div style="display:flex; flex-direction:column; gap:8px; padding:6px 4px;">
        ${TIER_DEFS.map(d => {
          const c = counts[d.tier];
          const pct = (c / maxCount) * 100;
          const empty = c === 0;
          const ink = light ? LIGHT_INK[d.tier] : d.color;
          return `
            <div class="ec-row" data-ec-tier="${d.key}" style="display:grid; grid-template-columns:74px 1fr 32px; gap:10px; align-items:center; opacity:${empty ? 0.45 : 1};">
              <div class="ec-label" style="font-size:12px; font-weight:600; color:${ink}; white-space:nowrap;">
                ${d.icon} ${d.label}
              </div>
              <div style="position:relative; height:14px; background:var(--s2,#0f1419); border:1px solid var(--br,#1e2530); border-radius:7px; overflow:hidden;">
                <div style="position:absolute; inset:0 auto 0 0; width:${pct}%; background:${ink}; opacity:${empty ? 0 : 0.55}; transition:width .35s ease;"></div>
              </div>
              <div style="font-size:13px; font-weight:700; color:${empty ? 'var(--m,#9aa3b2)' : ink}; text-align:right;">
                ${c}
              </div>
            </div>`;
        }).join('')}
      </div>
      <div style="margin-top:10px; font-size:11px; color:var(--m,#9aa3b2); text-align:center; line-height:1.5;">
        Active pipeline only — closed / lost / complete leads excluded.
      </div>`;
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    setTimeout(render, 1700);
    window.addEventListener('nbd:data-refreshed', render);
    // Re-ink when the palette changes under us (theme bundle landing after
    // this widget's first render, a Settings theme/mode pick, an OS flip).
    document.addEventListener('themechange', render);
    document.addEventListener('modechange', render);
  }

  const EngagementCohortWidget = {
    render,
    computeCounts,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
