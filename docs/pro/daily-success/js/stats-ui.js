/**
 * stats-ui.js — the 📊 Stats tile row, the first card of the Progress area (dashboard and the day page's Fitness section). Rules:
 * stats-logic.js. Reads finished sessions (nbd_ds_workouts), the coach's weekly target (nbd_ds_coach) and the day pages' weigh-ins; no
 * new data. Classic script loaded after progress-charts-ui.js; every value into innerHTML is escaped; no inline style or handler.
 */
(function () {
  'use strict';
  if (window.NBDStatsUI) return;
  const SESS = 'nbd_ds_workouts', COACH = 'nbd_ds_coach';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));
  const allPages = () => (typeof pages !== 'undefined' && Array.isArray(pages) ? pages : []);

  function cardHtml() {
    const S = window.NBDStats;
    if (!S) return '';
    try {
      const H = window.NBDTrackerHistory;
      const trend = H ? H.weightTrend(H.weightSeries(allPages()), today()) : null;
      const r = S.statsTiles(readJson(SESS, []), today(), { target: (readJson(COACH, {}) || {}).workoutsPerWeek, trend });
      if (!r.enough) return '';
      return '<div class="wc-card st-card" id="stCard"><div class="wc-card-h">📊 Stats</div><div class="st-grid">' +
        r.tiles.map((t) => '<div class="st-tile"><div class="st-l">' + esc(t.label) + '</div><div class="st-v">' + esc(t.value) + '</div><div class="st-s">' + esc(t.sub) + '</div></div>').join('') +
        '</div></div>';
    } catch (_) { return ''; }
  }

  function hook() {
    const origFit = window.buildFitnessSection;
    if (typeof origFit === 'function' && !origFit.__stats) {
      const wrapped = function () { return cardHtml() + origFit.apply(this, arguments); };
      Object.keys(origFit).forEach((k) => { wrapped[k] = origFit[k]; });
      wrapped.__stats = true;
      window.buildFitnessSection = wrapped;
    }
    const origDash = window.renderDash;
    if (typeof origDash === 'function' && !origDash.__stats) {
      const wrappedDash = function () {
        const r = origDash.apply(this, arguments);
        try {
          const main = document.getElementById('main');
          if (main && !document.getElementById('stCard')) {
            const html = cardHtml();
            if (html) {
              const box = document.createElement('div');
              box.className = 'st-dash';
              box.innerHTML = html;
              const pg = document.getElementById('pgCard');
              const anchor = pg && pg.parentNode && pg.parentNode.parentNode === main ? pg.parentNode : null;
              main.insertBefore(box, anchor || main.firstChild);
            }
          }
        } catch (_) { /* the dashboard renders without it */ }
        return r;
      };
      Object.keys(origDash).forEach((k) => { wrappedDash[k] = origDash[k]; });
      wrappedDash.__stats = true;
      window.renderDash = wrappedDash;
    }
  }

  function boot() {
    if (!window.NBDStats) return;
    hook();
    try {
      if (document.getElementById('fit-pb') && typeof window.renderPage === 'function') window.renderPage();
      else if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) window.renderDash();
    } catch (_) { /* the page renders without the card */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDStatsUI = { cardHtml };
})();
