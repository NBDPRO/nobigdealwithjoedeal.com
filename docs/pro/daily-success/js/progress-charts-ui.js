/**
 * progress-charts-ui.js — the 📈 Progress card: pick a lift, see its estimated
 * 1RM over time (PR days dotted) and the last 12 weeks of volume. Rules:
 * progress-charts-logic.js. Reads the coach's finished sessions from
 * localStorage (nbd_ds_workouts), so it works offline and needs no new data.
 *
 * Sits under the Weight card on the program dashboard and on a day page's
 * Fitness section. Classic script, loaded after tracker-history-ui.js.
 * Delegated listeners only; every value into innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDProgressUI) return;
  const P = () => window.NBDProgress;
  const SESS = 'nbd_ds_workouts';
  const WINDOW_DAYS = 180;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));
  const daysAgo = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); const t = new Date(y, m - 1, d - n); return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0'); };

  let selected = null;   // exId; null = the most-done lift

  function cardHtml() {
    if (!P()) return '';
    const sessions = readJson(SESS, []);
    const t = today();
    const lifts = P().topLifts(sessions, t, 6, WINDOW_DAYS);
    if (!lifts.length) {
      return '<div class="wc-card pg-card" id="pgCard"><div class="wc-card-h">📈 Progress</div>' +
        '<div class="wc-meta">Finish a few workouts in the coach and your lifts chart here.</div></div>';
    }
    const cur = lifts.find((l) => l.exId === selected) || lifts[0];
    const series = P().liftSeries(cur.exId, sessions, { sinceYmd: daysAgo(t, WINDOW_DAYS) });
    const sum = P().liftSummary(series);
    const chips = lifts.map((l) => '<button type="button" class="pg-chip' + (l.exId === cur.exId ? ' on' : '') + '" data-pg-action="pick" data-ex="' + esc(l.exId) + '">' + esc(l.name) + '</button>').join('');
    let delta = '';
    if (sum.change != null) {
      delta = ' · <span class="' + (sum.change >= 0 ? 'wt-down' : 'wt-up') + '">' + (sum.change > 0 ? '▲' : sum.change < 0 ? '▼' : '±') + esc(Math.abs(sum.change).toFixed(1)) + ' lb since ' + esc(series[0].date) + '</span>';
    }
    const line = P().lineChart(series, 'Estimated 1RM for ' + cur.name + ' over time');
    const vol = P().barChart(P().weeklyVolume(sessions, t, 12), 'Weekly volume, last 12 weeks');
    return '<div class="wc-card pg-card" id="pgCard"><div class="wc-card-h">📈 Progress</div>' +
      '<div class="pg-chips">' + chips + '</div>' +
      '<div class="wt-big">' + esc(Math.round(sum.latest)) + ' <small>lb est. 1RM · best ' + esc(Math.round(sum.best)) + '</small></div>' +
      '<div class="wc-meta">' + esc(sum.count) + ' session' + (sum.count === 1 ? '' : 's') + ' in 6 months' + delta + '</div>' +
      (line ? '<div class="pg-chart">' + line + '</div>' : '<div class="wc-meta">Do it once more to see a line.</div>') +
      '<div class="wc-lbl">Weekly volume (lb lifted)</div>' +
      (vol ? '<div class="pg-chart pg-vol">' + vol + '</div>' : '') +
      '<div class="pg-note">Estimated 1RM ignores sets over 12 reps. Dots are new bests.</div></div>';
  }

  function refresh() { const el = document.getElementById('pgCard'); if (el) el.outerHTML = cardHtml(); }

  function hook() {
    const origFit = window.buildFitnessSection;
    if (typeof origFit === 'function' && !origFit.__progress) {
      const wrapped = function () { return cardHtml() + origFit.apply(this, arguments); };
      Object.keys(origFit).forEach((k) => { wrapped[k] = origFit[k]; });
      wrapped.__progress = true;
      window.buildFitnessSection = wrapped;
    }
    const origDash = window.renderDash;
    if (typeof origDash === 'function' && !origDash.__progress) {
      const wrappedDash = function () {
        const r = origDash.apply(this, arguments);
        try {
          const main = document.getElementById('main');
          if (main && !document.getElementById('pgCard')) {
            const box = document.createElement('div');
            box.className = 'pg-dash';
            box.innerHTML = cardHtml();
            const weight = document.getElementById('wtCard');
            const anchor = weight && weight.parentNode && weight.parentNode.parentNode === main ? weight.parentNode : null;
            main.insertBefore(box, anchor ? anchor.nextSibling : main.firstChild);
          }
        } catch (_) { /* the dashboard renders without it */ }
        return r;
      };
      Object.keys(origDash).forEach((k) => { wrappedDash[k] = origDash[k]; });
      wrappedDash.__progress = true;
      window.renderDash = wrappedDash;
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-pg-action]');
    if (!t || t.dataset.pgAction !== 'pick') return;
    selected = t.dataset.ex || null;
    refresh();
  });

  function boot() {
    if (!P()) return;
    hook();
    try {
      if (document.getElementById('fit-pb') && typeof window.renderPage === 'function') window.renderPage();
      else if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) window.renderDash();
    } catch (_) { /* the page renders without the card */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDProgressUI = { cardHtml, refresh };
})();
