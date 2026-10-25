/**
 * customer-engagement-score.js — Wave 91 (Per-lead engagement tier)
 *
 * Combines the engagement signals the system already collects
 * (W44 share, W57/W58 freshness, W58 viewed, estimate respondedAt)
 * into a single 0-4 tier displayed as a chip on the customer
 * detail header. The rep gets one number to prioritize by
 * instead of having to scan three separate badges.
 *
 * The tiers (highest signal wins):
 *
 *   Tier 4 ✅ Responded  — any estimate has respondedAt set
 *   Tier 3 🔥 Hot        — viewed + (fresh share <24h OR multi-view)
 *   Tier 2 👀 Viewed     — any estimate viewed by customer
 *   Tier 1 📨 Sent       — share sent, not yet viewed
 *   Tier 0 🌱 New        — no signals (chip hidden)
 *
 * Colors register with the visual vocabulary the rep already knows:
 *
 *   Responded → gold     (#fbbf24 — same family as W17 hot lead)
 *   Hot       → orange   (#fb923c — distinct from share/preview)
 *   Viewed    → green    (#5eead4 — matches W58 viewed badge)
 *   Sent      → violet   (#cab8ff — matches W44 share badge)
 *   New       → (chip hidden)
 *
 * Path-gated to /pro/customer.html. Updates on:
 *   - DOMContentLoaded + 1.5s defer (so caches populate)
 *   - 'nbd:data-refreshed' event (W14 background revalidate)
 *
 * Compounds W44 (lastSharedAt), W58 (viewedAt), respondedAt,
 * and the customer-detail header chip pattern (W52, W59, W74).
 */
(function () {
  'use strict';

  if (window.CustomerEngagementScore
      && window.CustomerEngagementScore.__sentinel === 'nbd-customer-engagement-score-v1') return;

  // W92: path-gate only the UI render path. computeTier() needs to
  // be available everywhere so the kanban (W92) and other surfaces
  // can call it without re-implementing the tier logic.
  const PATH = window.location.pathname || '';
  const IS_CUSTOMER_PAGE = /\/pro\/customer(?:\.html)?$/.test(PATH);

  const FRESH_SHARE_MS = 24 * 60 * 60 * 1000; // W57 freshness window

  function toMillis(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function')   return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? 0 : d.getTime(); }
    return 0;
  }

  // ─── Tier compute ─────────────────────────────────────────────────
  // Returns { tier: 0|1|2|3|4, label, icon, bg, color, border, title }.
  // Highest signal wins — even if a lead has both 'sent' and 'viewed'
  // signals, viewed takes precedence.
  function computeTier(lead, estimates) {
    if (!lead) return null;
    const ests = (Array.isArray(estimates) ? estimates : [])
      .filter(e => e && e.leadId === lead.id);

    // Tier 4 — any responded estimate
    if (ests.some(e => e.respondedAt)) {
      return {
        tier: 4, label: 'Responded', icon: '✅',
        bg: 'rgba(251,191,36,0.18)', color: 'var(--ui-warn-text, var(--gold))',
        border: 'rgba(251,191,36,0.45)',
        title: 'Customer has responded to an estimate.',
      };
    }

    // Compute view signals
    let viewCount = 0;
    let latestViewMs = 0;
    for (const e of ests) {
      const ms = toMillis(e.viewedAt);
      if (ms > 0) {
        viewCount++;
        if (ms > latestViewMs) latestViewMs = ms;
      }
    }
    // 2026-09-16 (view-tracking fix): estimate.viewedAt only fires from the
    // standalone /pro/estimate-view.html link — a homeowner who opens the
    // MAIN portal (functions/portal.js's getHomeownerPortalView, which now
    // stamps lead.lastPortalOpenAt on a genuine open) never moved this tier,
    // so a rep watching this chip saw "waiting for the customer to open it"
    // even after they had. A portal open counts as a view exactly like an
    // estimate view does — same viewCount/latestViewMs the Hot/Viewed tiers
    // below already key off, so no other logic needed to change.
    const portalOpenMs = toMillis(lead.lastPortalOpenAt);
    if (portalOpenMs > 0) {
      viewCount++;
      if (portalOpenMs > latestViewMs) latestViewMs = portalOpenMs;
    }

    const sharedMs = toMillis(lead.lastSharedAt);
    const sharedAgeMs = sharedMs ? Date.now() - sharedMs : Infinity;
    const isFreshShare = sharedAgeMs < FRESH_SHARE_MS;

    // Tier 3 — viewed AND (fresh share OR multiple views)
    if (viewCount > 0 && (isFreshShare || viewCount >= 2)) {
      return {
        tier: 3, label: 'Hot', icon: '🔥',
        bg: 'rgba(251,146,60,0.18)', color: 'var(--ui-accent-text, var(--orange))',
        border: 'rgba(251,146,60,0.45)',
        title: viewCount >= 2
          ? `Customer viewed ${viewCount}× — strong signal.`
          : 'Customer viewed within 24h of the share — strong signal.',
      };
    }

    // Tier 2 — any view
    if (viewCount > 0) {
      return {
        tier: 2, label: 'Viewed', icon: '👀',
        bg: 'rgba(46,204,138,0.18)', color: 'var(--ui-success-text, #5eead4)',
        border: 'rgba(46,204,138,0.45)',
        title: 'Customer has opened the portal at least once.',
      };
    }

    // Tier 1 — share sent, no view yet
    if (sharedMs > 0) {
      return {
        tier: 1, label: 'Sent', icon: '📨',
        bg: 'rgba(155,109,255,0.14)', color: 'color-mix(in srgb, var(--purple) 50%, var(--t, #e8eaf0))',
        border: 'rgba(155,109,255,0.45)',
        title: 'Portal link sent — waiting for the customer to open it.',
      };
    }

    // Tier 0 — no signals
    return { tier: 0, label: 'New', icon: '🌱' };
  }

  // ─── Render ──────────────────────────────────────────────────────
  function update() {
    const chip = document.getElementById('engagementChip');
    if (!chip) return;
    const lead = window._currentLead;
    const estimates = Array.isArray(window._estimates) ? window._estimates : [];
    const tierInfo = computeTier(lead, estimates);
    if (!tierInfo || tierInfo.tier === 0) {
      chip.style.display = 'none';
      return;
    }
    chip.textContent = `${tierInfo.icon} ${tierInfo.label}`;
    chip.title = tierInfo.title || '';
    chip.style.background = tierInfo.bg;
    chip.style.color = tierInfo.color;
    chip.style.border = `1px solid ${tierInfo.border}`;
    chip.style.display = '';
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    setTimeout(update, 1500);
    window.addEventListener('nbd:data-refreshed', update);
  }

  window.CustomerEngagementScore = {
    __sentinel: 'nbd-customer-engagement-score-v1',
    update,
    computeTier,
  };

  // Only wire the UI render path on the customer page.
  if (IS_CUSTOMER_PAGE) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }
})();
