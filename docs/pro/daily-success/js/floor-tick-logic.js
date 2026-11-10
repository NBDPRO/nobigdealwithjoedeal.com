/**
 * floor-tick-logic.js — which floor a finished thing may tick (audit M3, the "ask first" variant Jo's decision 3 resolves to).
 *
 * Nothing here ticks anything. When the coach finishes, protein reaches its target, a good night's sleep is logged or the wrap-up is
 * saved, floor-tick-ui.js asks "Workout done. Tick the floor?" and only a tap writes floormet-<id>. This module finds the floors worth
 * asking about (by the words in their labels, so a custom "Lift weights" still matches) and words the question. Pure, no DOM.
 */
(function (root) {
  'use strict';
  const RULES = {
    workout: { re: /work\s*-?out|train|lift|gym|exercise/i, msg: 'Workout done. Tick the floor?' },
    protein: { re: /protein/i, msg: 'Protein target hit. Tick the floor?' },
    sleep: { re: /sleep/i, msg: 'Sleep logged. Tick the floor?' },
    wrap: { re: /journal|wrap|reflect/i, msg: 'Wrap-up saved. Tick the floor?' },
  };

  /** Ids of the unmet floors a `kind` event could tick. `data` is the page's data (floormet-<id> = '1' when met). */
  function offer(floors, data, kind) {
    const rule = RULES[kind];
    if (!rule || !Array.isArray(floors)) return [];
    const d = data || {};
    return floors.filter((f) => f && f.id != null && rule.re.test(String(f.label || '')) && d['floormet-' + f.id] !== '1').map((f) => String(f.id));
  }
  function message(kind) { return RULES[kind] ? RULES[kind].msg : ''; }
  /** Sleep is 1 rough, 2 OK, 3 good (checkin-logic.js): a rough night does not offer a "7+ hrs" floor. */
  function sleepCounts(v) { return Number(v) >= 2; }
  function proteinHit(have, target) { const h = Number(have), t = Number(target); return isFinite(h) && isFinite(t) && t > 0 && h >= t; }

  const api = { RULES, offer, message, sleepCounts, proteinHit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDFloorTick = api;
})(typeof window !== 'undefined' ? window : null);
