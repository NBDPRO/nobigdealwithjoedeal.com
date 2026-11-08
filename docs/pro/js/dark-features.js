/**
 * dark-features.js — loads the flag-gated toolbar features only when their
 * flag is on (boot-weight lane, 2026-11-08).
 *
 * Six features ship dark behind a feature flag (feature_flags/_default or
 * feature_flags/{uid}): each used to be its own deferred <script> on every
 * dashboard boot, about 117 KB of shipped code that mostly did nothing but
 * poll its flag every minute. This file registers them as ScriptLoader
 * bundles (at runtime, like today-home.js's `promise` bundle, so the blocking
 * script-loader.js does not grow) and fetches a bundle the first time
 * NBDFlags reports its flag on:
 *
 *   bulkCloseStaleLeads → staleleads          (js/stale-leads-cleanup.js)
 *   leadSourceFixer     → leadsourcefixer     (js/lead-source-fixer.js)
 *   speedToLead         → speedtolead         (js/speed-to-lead.js)
 *   reputationLoop      → reputation          (js/reputation.js)
 *   estimateFollowBoard → estimatefollowboard (js/estimate-follow-board.js)
 *   followUpBoard       → followupboard       (estimate board, logic, screen,
 *                                              Thumbtack opportunities cards)
 *
 * Each feature keeps its own flag check, role check and button sync, so with
 * the flag off nothing changes: the toolbar button stays hidden and no code
 * for it is fetched. NBDFlags fires `nbd:flags-loaded` on every load, so a
 * flag turned on later (per-uid override, the prod flags panel) loads its
 * bundle on the next flags read without a reload. ScriptLoader dedupes, so a
 * bundle is never fetched twice and its files run in bundle order.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  if (window.NBDDarkFeatures && window.NBDDarkFeatures.__sentinel === 'nbd-dark-features-v1') return;

  // Order inside followupboard is load-bearing: the Follow-ups screen reads
  // NBDEstimateFollowBoard._pure and NBDFollowUpLogic, and the Thumbtack
  // opportunities cards extend it. estimate-followups.js (the Home card both
  // boards read) stays an eager tag in dashboard.html.
  var BUNDLES = {
    staleleads: ['js/stale-leads-cleanup.js?v=1'],
    leadsourcefixer: ['js/lead-source-fixer.js?v=1'],
    speedtolead: ['js/speed-to-lead.js?v=1'],
    reputation: ['js/reputation.js?v=1'],
    estimatefollowboard: ['js/estimate-follow-board.js?v=1'],
    followupboard: [
      'js/estimate-follow-board.js?v=1',
      'js/follow-up-board-logic.js?v=1',
      'js/follow-up-board.js?v=2',
      'js/opp-approval-logic.js?v=1',
      'js/opp-approval.js?v=1'
    ]
  };
  var FLAG_BUNDLES = {
    bulkCloseStaleLeads: 'staleleads',
    leadSourceFixer: 'leadsourcefixer',
    speedToLead: 'speedtolead',
    reputationLoop: 'reputation',
    estimateFollowBoard: 'estimatefollowboard',
    followUpBoard: 'followupboard'
  };
  var requested = {};

  function loader() {
    var sl = window.ScriptLoader;
    if (!sl || typeof sl.loadBundle !== 'function') return null;
    if (sl.bundles) {
      Object.keys(BUNDLES).forEach(function (name) { if (!sl.bundles[name]) sl.bundles[name] = BUNDLES[name]; });
    }
    return sl;
  }
  function flagOn(name) {
    var f = window.NBDFlags;
    return !!(f && typeof f.enabled === 'function' && f.enabled(name));
  }

  /** Load every enabled flag's bundle that has not been requested yet. Returns the flag names loaded this call. */
  function sync() {
    var sl = loader();
    var started = [];
    if (!sl) return started;
    Object.keys(FLAG_BUNDLES).forEach(function (flag) {
      if (requested[flag] || !flagOn(flag)) return;
      requested[flag] = true;
      started.push(flag);
      try { sl.loadBundle(FLAG_BUNDLES[flag]); } catch (e) { requested[flag] = false; }
    });
    return started;
  }

  loader();
  window.addEventListener('nbd:flags-loaded', sync);
  if (window.NBDFlags && typeof window.NBDFlags.isLoaded === 'function' && window.NBDFlags.isLoaded()) sync();

  window.NBDDarkFeatures = { __sentinel: 'nbd-dark-features-v1', sync: sync, flags: FLAG_BUNDLES, bundles: BUNDLES };
})();
