/**
 * tracker-history-ui.js — the weight card and the "bring in old workouts"
 * import (tracker revamp Phase 3 + 4). Rules: tracker-history-logic.js.
 *
 *   ⚖️ Weight — from the day pages' Body Metrics weight box (Jo weighs on a
 *   Hume scale). Shown on the Fitness section of a day page and on the
 *   program dashboard: today, the 7-day average, and how that average moved
 *   this week / this month, with a small chart.
 *
 *   📥 Bring in old workouts — previews how many days and lifts it found
 *   (and which names it could not recognize) and imports only when Jo taps
 *   Import. Re-running it imports nothing twice.
 *
 * Classic script after app.js + workout-coach(.js|-logic.js). app.js's
 * top-level `let pages` is reached by name (shared global lexical scope).
 * Delegated listeners; every value into innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDTrackerHistoryUI) return;
  /* global pages */
  const H = () => window.NBDTrackerHistory;
  const C = () => window.NBDCoach;
  const SESS = 'nbd_ds_workouts';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const allPages = () => (typeof pages !== 'undefined' && Array.isArray(pages) ? pages : []);
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));

  function delta(v, label) {
    if (v == null) return '';
    if (v === 0) return ' · <span class="wt-flat">±0 ' + label + '</span>';
    return ' · <span class="' + (v < 0 ? 'wt-down' : 'wt-up') + '">' + (v < 0 ? '▼' : '▲') + esc(Math.abs(v).toFixed(1)) + ' ' + label + '</span>';
  }

  function weightCardHtml() {
    if (!H()) return '';
    const t = H().weightTrend(H().weightSeries(allPages()), today());
    if (!t.count) {
      return '<div class="wc-card wt-card" id="wtCard"><div class="wc-card-h">⚖️ Weight</div>' +
        '<div class="wc-meta">Put your Hume reading in Body Metrics → Weight on a day page, and your trend shows up here.</div></div>';
    }
    const when = t.latestDk === today() ? 'today' : 'on ' + esc(t.latestDk);
    return '<div class="wc-card wt-card" id="wtCard"><div class="wc-card-h">⚖️ Weight</div>' +
      '<div class="wt-row"><div><div class="wt-big">' + esc(t.latest.toFixed(1)) + ' <small>lb ' + when + '</small></div>' +
      '<div class="wc-meta">7-day avg ' + (t.avg7 != null ? esc(t.avg7.toFixed(1)) : '—') + delta(t.change7, 'this week') + delta(t.change30, 'in 30 days') + '</div></div>' +
      '<div class="wt-chart">' + H().sparkline(t.points) + '</div></div></div>';
  }

  function importLinkHtml() {
    if (!H() || !C()) return '';
    const plan = H().planImport(allPages(), readJson(SESS, []), C().EXERCISES);
    if (!plan.days) return '';
    return '<button type="button" class="wt-import-link" data-th-action="import-open">📥 Bring ' + plan.days + ' days of old workouts into the coach</button>';
  }

  // ── hooks: day page Fitness section + program dashboard ────────────────
  function hook() {
    const origFit = window.buildFitnessSection;
    if (typeof origFit === 'function' && !origFit.__weight) {
      const wrapped = function () { return weightCardHtml() + importLinkHtml() + origFit.apply(this, arguments); };
      wrapped.__weight = true; wrapped.__coach = origFit.__coach;
      window.buildFitnessSection = wrapped;
    }
    const origDash = window.renderDash;
    if (typeof origDash === 'function' && !origDash.__weight) {
      const wrappedDash = function () {
        const r = origDash.apply(this, arguments);
        try {
          const main = document.getElementById('main');
          if (main && !document.getElementById('wtCard')) {
            const box = document.createElement('div');
            box.className = 'wt-dash';
            box.innerHTML = weightCardHtml();
            main.insertBefore(box, main.firstChild);
          }
        } catch (_) { /* the dashboard renders without it */ }
        return r;
      };
      wrappedDash.__weight = true;
      window.renderDash = wrappedDash;
    }
  }

  // ── the import sheet ───────────────────────────────────────────────────
  let _plan = null;
  function sheet() {
    let el = document.getElementById('thOverlay');
    if (!el) { el = document.createElement('div'); el.id = 'thOverlay'; el.className = 'wc-ov'; el.setAttribute('role', 'dialog'); document.body.appendChild(el); }
    return el;
  }
  function openImport() {
    _plan = H().planImport(allPages(), readJson(SESS, []), C().EXERCISES);
    const p = _plan;
    const un = p.unmatched.slice(0, 12).map((u) => '<li>' + esc(u.name) + (u.count > 1 ? ' <small>×' + u.count + '</small>' : '') + '</li>').join('');
    const el = sheet();
    el.innerHTML = '<div class="wc-box"><div class="wc-top"><button class="wc-x" data-th-action="import-close" aria-label="Close">✕</button>' +
      '<div class="wc-title">Old workouts</div><span></span></div>' +
      '<div class="wc-sum"><div><b>' + p.days + '</b> days</div><div><b>' + p.lifts + '</b> lifts</div><div><b>' + p.matched + '</b> recognized</div></div>' +
      '<div class="wc-hint">Recognized lifts feed the coach\'s "last time" targets and PRs. The rest are kept under their own names.</div>' +
      (un ? '<div class="wc-lbl">Not recognized</div><ul class="th-list">' + un + (p.unmatched.length > 12 ? '<li>+' + (p.unmatched.length - 12) + ' more</li>' : '') + '</ul>' : '') +
      '<div class="wc-foot"><button class="btn wc-finish" data-th-action="import-go">Import ' + p.days + ' days</button>' +
      '<button class="btn btn-ghost" data-th-action="import-close">Not now</button></div></div>';
    el.classList.add('open'); document.body.classList.add('wc-lock');
  }
  function closeImport() { const el = document.getElementById('thOverlay'); if (el) el.classList.remove('open'); document.body.classList.remove('wc-lock'); }

  async function doImport(btn) {
    if (!_plan || !_plan.sessions.length) { closeImport(); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    const merged = C().mergeSessions(readJson(SESS, []).concat(_plan.sessions), []);
    try { localStorage.setItem(SESS, JSON.stringify(merged)); } catch (_) { toast('Could not save on this device'); return; }
    let pushed = 0;
    if (window.NBDDsCloud && typeof window.NBDDsCloud.pushWorkout === 'function') {
      for (const s of _plan.sessions) { if (await window.NBDDsCloud.pushWorkout(s)) pushed++; }
    }
    const n = _plan.sessions.length;
    _plan = null;
    closeImport();
    toast('Imported ' + n + ' days of workouts' + (pushed < n ? ' (' + (n - pushed) + ' will back up on the next sync)' : ''));
    if (window.NBDCoachUI && typeof window.NBDCoachUI.refresh === 'function') window.NBDCoachUI.refresh();
    if (typeof window.renderPage === 'function' && document.getElementById('fit-pb')) { try { window.renderPage(); } catch (_) {} }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-th-action]');
    if (!t) return;
    const a = t.dataset.thAction;
    if (a === 'import-open') openImport();
    else if (a === 'import-close') closeImport();
    else if (a === 'import-go') doImport(t);
  });

  function boot() {
    if (!H()) return;
    hook();
    try {
      if (document.getElementById('fit-pb') && typeof window.renderPage === 'function') window.renderPage();
      else if (typeof window.renderDash === 'function' && document.getElementById('main') && !document.getElementById('fit-pb')) window.renderDash();
    } catch (_) { /* the page renders without the card */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDTrackerHistoryUI = { weightCardHtml, openImport };
})();
