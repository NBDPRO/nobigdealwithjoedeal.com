/**
 * needs-attention-filter.js — Wave 25 (Kanban "Needs Attention" filter)
 *
 * Single header button that toggles the kanban to show ONLY leads
 * the rep should act on today. Composes prior waves into one
 * actionable view:
 *   - Wave 13 (notification bell): overdue tasks + stale estimates
 *   - Wave 17 (stage-aging cues):  ≥7 days in stage
 *
 * The kanban already has a renderLeads(leads, filtered) hook from
 * crm.js that respects a precomputed filtered subset and stores it
 * on window._filteredLeads. This module just feeds the right subset
 * in when the button is active.
 *
 * Triggers:
 *   - Click button     → toggle filter
 *   - 'nbd:data-refreshed' → recompute count + re-apply if active
 *   - Periodically every 60s so stale-stage / overdue counts tick
 *
 * The button's badge shows how many leads currently need attention
 * — a number reps can glance at across the day to know if their
 * pipeline is on the rails or going stale.
 *
 * Exposes: __NBD_CALL_REGISTRY.toggleNeedsAttention — _NBD_TOGGLE_FNS key
 *          'needsAttention' via _nbdResolveMapped (registry-only, Tranche 3
 *          2026-09-02). The NeedsAttention namespace const below is
 *          IIFE-local, never window-exposed.
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['needs-attention-filter']) return;
  __NBD_LOADED['needs-attention-filter'] = true;

  const STAGE_AGE_DAYS    = 7;     // matches Wave 17 'stale' threshold
  const ESTIMATE_STALE_DAYS = 3;   // matches Wave 13 stale-estimate
  // final_payment is NOT terminal: the work is done but the money isn't in.
  // It used to sit here, so an unpaid finished job never surfaced anywhere
  // (2026-09-24 lead-hygiene pass). It gets its own rule below instead.
  const TERMINAL_STAGES = new Set([
    'closed', 'lost', 'Lost', 'Complete',
    'deductible_collected',
  ]);
  const UNPAID_FINAL_DAYS = 7;
  // Thumbtack hands out masked proxy numbers in the 669 area code. They can
  // expire, so a lead that only has one needs a real phone/email captured.
  const PROXY_AREA_CODE = '669';
  const STORM_DAMAGE_RE = /storm|hail|wind/i;

  function isProxyPhone(lead) {
    if (!/thumbtack/i.test(String(lead.source || ''))) return false;
    const digits = String(lead.phone || '').replace(/\D/g, '').slice(-10);
    return digits.length === 10 && digits.slice(0, 3) === PROXY_AREA_CODE;
  }

  // A storm job with no date of loss can't be matched against hail/wind data
  // and stalls every insurance document. 'new' is exempt: nobody has talked
  // to the customer yet, so there's nothing to fill in.
  function missingDateOfLoss(lead, sk) {
    if (sk === 'new') return false;
    if (!STORM_DAMAGE_RE.test(String(lead.damageType || ''))) return false;
    return !String(lead.dateOfLoss || '').trim();
  }

  // The registry owns active-state now (lead-filter-registry.js). Reading it
  // through a function rather than caching a boolean is deliberate: the stale
  // copy is exactly what let this button stay lit while another filter had
  // taken the board.
  const FILTER_NAME = 'needsAttention';
  function isActive() {
    return !!(window.NBDLeadFilters && window.NBDLeadFilters.isActive(FILTER_NAME));
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  function toMillis(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function')   return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? 0 : d.getTime(); }
    return 0;
  }

  function stageKey(lead) {
    if (lead._stageKey) return lead._stageKey;
    if (typeof window.normalizeStage === 'function') return window.normalizeStage(lead.stage);
    return lead.stage || 'new';
  }

  function daysInStage(lead) {
    const ref = toMillis(lead.stageStartedAt) || toMillis(lead.updatedAt) || toMillis(lead.createdAt);
    if (!ref) return 0;
    return Math.floor((Date.now() - ref) / 86400000);
  }

  // Returns reason string if lead needs attention, else null.
  function needsAttentionReason(lead, taskCache, estimates, now) {
    if (!lead || lead.deleted) return null;
    if (lead.isProspect) return null;
    const sk = stageKey(lead);
    if (TERMINAL_STAGES.has(sk)) return null;
    // Wave 35: respect rep snooze. Snoozed leads don't generate a
    // "needs attention" signal until the snooze expires.
    if (window.LeadSnooze && window.LeadSnooze.isSnoozed(lead)) return null;

    // Wave 96: hot-but-cold. The customer is engaged (W92 tier ≥
    // Hot/Responded — viewed AND fresh share OR multi-view) but
    // the rep hasn't taken action in 24h+. Highest-priority
    // "needs attention" signal — engaged customers go cold fast
    // when the rep doesn't follow up. We check this BEFORE the
    // other reasons so the returned reason names the actual
    // root cause rather than a downstream symptom (e.g.,
    // stale-stage will eventually fire too, but "hot-but-cold"
    // is more actionable).
    if (window.CustomerEngagementScore
        && typeof window.CustomerEngagementScore.computeTier === 'function') {
      const tierInfo = window.CustomerEngagementScore.computeTier(lead, estimates);
      const tier = tierInfo ? tierInfo.tier : 0;
      // Tier 3 = Hot, Tier 4 = Responded. Both are "engaged
      // customers" — the rep should be acting on them.
      if (tier >= 3) {
        const lastTouch = toMillis(lead.updatedAt) || toMillis(lead.lastSharedAt) || toMillis(lead.createdAt);
        const sinceTouchMs = lastTouch ? (now - lastTouch) : Infinity;
        if (sinceTouchMs >= 24 * 60 * 60 * 1000) {
          return 'hot-but-cold';
        }
      }
    }

    // 0) Finished job, unpaid. Checked before the generic stale rule so the
    // reason names the real problem (money), not just "old".
    if (sk === 'final_payment') {
      if (daysInStage(lead) >= UNPAID_FINAL_DAYS) return 'unpaid-final';
    } else if (daysInStage(lead) >= STAGE_AGE_DAYS) {
      // 1) Stale stage
      return 'stale-stage';
    }

    // 2) Overdue task
    const tasks = (taskCache && taskCache[lead.id]) || [];
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    for (const t of tasks) {
      if (t.done) continue;
      if (!t.dueDate) continue;
      const due = new Date(t.dueDate + 'T23:59:59');
      if (due < startOfToday) return 'overdue-task';
    }

    // 3) Stale estimate (sent ≥3d ago, no respondedAt)
    const cutoff = now - ESTIMATE_STALE_DAYS * 86400000;
    for (const e of estimates) {
      if (!e || e.leadId !== lead.id) continue;
      const status = (e.status || '').toLowerCase();
      if (status === 'signed' || status === 'rejected' || status === 'expired') continue;
      if (e.respondedAt) continue;
      // Never-sent drafts aren't stale estimates (same test as the bell and
      // the Estimates page).
      const _wasSent = e.sentAt || e.signatureSentAt || e.viewedAt
        || (e.signatureStatus && e.signatureStatus !== 'none');
      if ((status === '' || status === 'draft') && !_wasSent) continue;
      const sent = toMillis(e.sentAt) || toMillis(e.signatureSentAt) || toMillis(e.createdAt);
      if (sent && sent < cutoff) return 'stale-estimate';
    }

    // 4) Data-quality gaps a rep can fix in one edit (2026-09-24).
    if (isProxyPhone(lead)) return 'proxy-phone';
    if (missingDateOfLoss(lead, sk)) return 'missing-date-of-loss';
    return null;
  }

  // ─── Compute the subset ─────────────────────────────────────────
  function compute() {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const taskCache = window._taskCache || {};
    const estimates = Array.isArray(window._estimates) ? window._estimates : [];
    const now = Date.now();
    return leads.filter(l => needsAttentionReason(l, taskCache, estimates, now) != null);
  }

  function count() {
    return compute().length;
  }

  // ─── Button rendering / state ───────────────────────────────────
  function updateButton() {
    const btn = document.getElementById('needsAttentionBtn');
    const badge = document.getElementById('needsAttentionCountBadge');
    if (!btn || !badge) return;
    const c = count();
    badge.textContent = c;
    badge.style.display = c > 0 ? 'inline-block' : 'none';

    if (isActive()) {
      btn.style.background = 'rgba(239,68,68,0.12)';
      btn.style.borderColor = '#ef4444';
      btn.style.color = '#ef4444';
    } else {
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
    }
    // One-row toolbar (2026-07-06): stamp .active alongside the inline
    // styles — the Filters-menu highlight CSS, the crmFiltersActiveBadge
    // sync (dashboard-ui.js), and the E2E all key on the class. None of
    // the filter modules ever set it before, which is also why the old
    // mobile tools-menu active mirrors never lit up.
    btn.classList.toggle('active', isActive());
  }

  // ─── Apply the filter ────────────────────────────────────────────
  // Board state belongs to NBDLeadFilters (lead-filter-registry.js), not to
  // this module. It used to own a private `active` flag AND write
  // window._filteredLeads directly, and its deactivate path nulled the board
  // unconditionally — so turning Stale Shares off blanked this filter's
  // subset while this button stayed lit, and the recount below silently
  // re-applied it seconds later. Two toggles, one surface, two sources of
  // truth. The registry is now the only one that decides and the only one
  // that calls renderLeads.
  function toggle() {
    if (!window.NBDLeadFilters) return; // registry missing — do nothing rather than fight over the board
    const nowActive = window.NBDLeadFilters.toggle(FILTER_NAME);
    // Friendly toast on activation if there's nothing to act on.
    if (nowActive && count() === 0 && typeof window.showToast === 'function') {
      window.showToast('Nothing needs attention right now — clean pipeline.', 'success');
    }
  }

  // Data changed underneath us. The registry re-applies ONLY if this filter
  // is the active one; otherwise this is just a button-count repaint, which
  // is the behaviour the 60s poll was always supposed to have.
  function recount() {
    if (window.NBDLeadFilters) window.NBDLeadFilters.refresh();
    updateButton();
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    // Hand compute + button-painting to the registry and keep nothing local.
    // `paint` is called for BOTH states, including when another filter takes
    // over — which is what unlights this button instead of leaving it lit
    // over a board it no longer controls.
    if (window.NBDLeadFilters) {
      window.NBDLeadFilters.register(FILTER_NAME, { compute: compute, paint: updateButton });
    }
    updateButton();
    window.addEventListener('nbd:data-refreshed', recount);
    setInterval(recount, 60_000);
  }

  // Expose API
  const NeedsAttention = {
    compute,
    count,
    isActive: isActive,
    toggle,
    recount,
    needsAttentionReason,
  };
  // _NBD_TOGGLE_FNS key 'needsAttention' — resolved registry-first by
  // dashboard-ui.js _nbdResolveMapped (Tranche 3 map-graduate, 2026-09-02).
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, { toggleNeedsAttention: toggle });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500));
  } else {
    setTimeout(init, 1500);
  }
})();
