/**
 * weekstrip-ui.js — the "This week at a glance" strip (seven day circles with a workout dot under each) on the Daily Success dashboard.
 * The day page already shows it on its cover; this puts the same strip, drawn by app.js's buildWeekGlance() from the pure weekStrip()
 * in day-layout-logic.js, at the top of the dashboard. Classic script loaded after app.js and progress-charts-ui.js. No new data and
 * no inline style or handler here; tapping a day still goes through app.js's delegated switch-to action.
 */
(function () {
  'use strict';
  if (window.NBDWeekStripUI) return;

  function stripHtml() {
    if (typeof window.buildWeekGlance !== 'function') return '';
    return window.buildWeekGlance() || '';
  }

  function hook() {
    const origDash = window.renderDash;
    if (typeof origDash !== 'function' || origDash.__weekstrip) return;
    const wrapped = function () {
      const r = origDash.apply(this, arguments);
      try {
        const main = document.getElementById('main');
        if (main && !document.getElementById('wsDash')) {
          const html = stripHtml();
          if (html) {
            const box = document.createElement('div');
            box.className = 'ws-dash';
            box.id = 'wsDash';
            box.innerHTML = '<div class="ws-panel"><div class="ws-h">This week at a glance</div>' + html + '</div>';
            main.insertBefore(box, main.firstChild);
          }
        }
      } catch (_) { /* the dashboard renders without it */ }
      return r;
    };
    Object.keys(origDash).forEach((k) => { wrapped[k] = origDash[k]; });
    wrapped.__weekstrip = true;
    window.renderDash = wrapped;
  }

  function boot() {
    hook();
    try {
      if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) window.renderDash();
    } catch (_) { /* the page renders without the strip */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDWeekStripUI = { stripHtml };
})();
