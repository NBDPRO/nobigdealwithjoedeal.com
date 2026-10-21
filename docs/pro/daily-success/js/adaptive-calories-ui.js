/**
 * adaptive-calories-ui.js — the "Your real maintenance" card on a day page's
 * Diet section (tracker idea #7). Rules: adaptive-calories-logic.js
 * (window.NBDAdaptiveCalories).
 *
 *   Shows an estimate ONLY when there is enough food and weight data, and
 *   otherwise says what is missing - never a guessed number. A how-it-is-
 *   worked-out note is one tap away. If Jo has no calorie target, a button
 *   offers to use the maintenance as the target; it writes only on that tap.
 *
 * Classic script after food-log.js (deferred); reaches app.js's top-level
 * `pages` by name. Delegated listeners; every value into innerHTML is
 * escaped. Reuses the Food card's styles.
 */
(function () {
  'use strict';
  if (window.NBDAdaptiveCaloriesUI) return;
  /* global pages */
  const A = () => window.NBDAdaptiveCalories;
  const F = () => window.NBDFoodLog;
  const H = () => window.NBDTrackerHistory;
  const KEY = 'nbd_ds_food';          // food-log.js's settings (favorites + targets)
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const today = () => {
    if (typeof window.todayKey === 'function') return window.todayKey();
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  function foodCfg() {
    try { const v = JSON.parse(localStorage.getItem(KEY)); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; }
  }
  function result() {
    const all = typeof pages !== 'undefined' && Array.isArray(pages) ? pages : [];
    return A().estimate(A().intakeSeries(all, F().totals), H() ? H().weightSeries(all) : [], today());
  }

  function howHtml(r) {
    const win = r && r.windowStart ? ' (' + esc(r.windowStart) + ' to ' + esc(r.windowEnd) + ')' : '';
    return '<details class="fl-how"><summary>How is this worked out?</summary>' +
      '<div class="fl-note">Maintenance = average calories you ate &minus; (weight change per day &times; 3,500). ' +
      'About 3,500 calories is one pound.<br>' +
      'It looks at the last 21 days' + win + ', not counting today. Only days with calories typed in count (a day under 800 calories ' +
      'is treated as only some meals typed, so it is left out). Your weight is the average of the weigh-ins in the first 7 days ' +
      'compared with the average in the last 7, so one salty day does not swing it.<br>' +
      'Example: eat 2,000 a day and lose a pound a week (500 a day) and your maintenance is about 2,500.<br>' +
      'This is self-tracking arithmetic from your own numbers, not medical advice.</div></details>';
  }

  function cardHtml() {
    if (!A() || !F()) return '';
    let r;
    try { r = result(); } catch (_) { return ''; }
    let body;
    if (r.ok) {
      const rec = r.recent;
      const hasTarget = Number(((foodCfg().targets || {}).calories)) > 0;
      body = '<div class="wc-meta"><b>Your real maintenance is about ' + esc(fmt(r.maintenance)) + ' cal/day</b> ' +
        '(based on ' + esc(r.foodDays) + ' days of food and weigh-ins spanning ' + esc(r.spanDays + 1) + ' days)</div>' +
        '<div class="fl-note">You averaged ' + esc(fmt(r.avgIntake)) + ' cal/day on the days you logged, and your 7-day average weight moved ' +
        esc(r.ratePerWeek > 0 ? '+' : '') + esc(r.ratePerWeek.toFixed(1)) + ' lb/week.' +
        (r.partialDays ? ' ' + esc(r.partialDays) + ' day' + (r.partialDays === 1 ? '' : 's') + ' under 800 cal left out.' : '') + '</div>' +
        (rec ? '<div class="fl-note">Your last ' + esc(rec.days) + ' logged days averaged ' + esc(fmt(rec.avgIntake)) + ' cal, which is ' +
          esc(A().paceWords(rec.lbPerWeek)) + ' at this maintenance.</div>' : '') +
        (!hasTarget ? '<div class="fl-row fl-actions"><button type="button" class="fl-btn" data-ac-action="use-target" data-cal="' + esc(r.maintenance) + '">Use my maintenance as the calorie target</button></div>' : '');
    } else {
      body = '<div class="wc-meta">' + esc(r.message) + '</div>';
    }
    return '<div class="wc-card fl-card" id="acCard"><div class="wc-card-h">🔥 Your real maintenance</div>' + body + howHtml(r.ok ? r : null) + '</div>';
  }

  function refresh() { const el = document.getElementById('acCard'); if (el) el.outerHTML = cardHtml(); }

  function useTarget(cal) {
    if (!(cal > 0)) return;
    const c = foodCfg();
    c.favorites = Array.isArray(c.favorites) ? c.favorites : [];
    c.targets = Object.assign({}, c.targets, { calories: Math.round(cal) });
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (_) { toast('Could not save on this device'); return; }
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(KEY);
    toast('Calorie target set to ' + fmt(Math.round(cal)));
    refresh();
    if (window.NBDFoodLogUI && typeof window.NBDFoodLogUI.refresh === 'function') window.NBDFoodLogUI.refresh();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ac-action]');
    if (t && t.dataset.acAction === 'use-target') useTarget(parseInt(t.dataset.cal, 10));
  });

  function hook() {
    const orig = window.buildDietSection;
    if (typeof orig !== 'function' || orig.__adaptive) return;
    const wrapped = function () { return cardHtml() + orig.apply(this, arguments); };
    Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
    wrapped.__adaptive = true;
    window.buildDietSection = wrapped;
  }
  function boot() {
    if (!A() || !F()) return;
    hook();
    try { if (document.getElementById('diet-pb') && typeof window.renderPage === 'function') window.renderPage(); } catch (_) { /* renders without the card */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDAdaptiveCaloriesUI = { cardHtml, refresh };
})();
