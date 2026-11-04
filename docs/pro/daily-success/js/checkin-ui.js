/**
 * checkin-ui.js — the morning readiness check-in card under the Today bar
 * (rules: checkin-logic.js; scoring: workout-coach-logic.js readiness).
 * Three taps, skippable, once a day, nothing blocks. Writes the coach's own
 * store so the workout picks it up. Classic script after app.js; delegated
 * listeners; every value that reaches innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDCheckinUI) return;
  /* global pages, cur */
  const K = () => window.NBDCheckin;
  const KEY = 'nbd_ds_coach_ready';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));

  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY)); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
  }
  function store(map) {
    try { localStorage.setItem(KEY, JSON.stringify(map)); return true; } catch (_) { toast('Could not save on this device'); return false; }
  }
  function pageDk() {
    try { const p = typeof pages !== 'undefined' && typeof cur === 'number' ? pages[cur] : null; return p && p.dk ? p.dk : null; } catch (_) { return null; }
  }

  function cardHtml(dk) {
    const map = load();
    const st = K().state(map, dk, today(), new Date().getHours());
    if (st === 'hidden' || st === 'skipped') return '';
    const rec = map[dk] || {};
    if (st === 'done') {
      const q = window.NBDCoach && window.NBDCoach.readiness ? window.NBDCoach.readiness(rec) : null;
      return '<div class="wc-card ck-card ck-done"><div class="ck-msg">☀️ ' + esc(K().message(q) || 'Check-in saved.') + '</div>' +
        '<button type="button" class="wc-link ck-change" data-ck-action="reset">Change</button></div>';
    }
    const rows = K().ROWS.map((row) => '<div class="ck-row" role="group" aria-label="' + esc(row.label) + '"><span class="ck-l">' + esc(row.label) + '</span>' +
      row.opts.map((o, n) => '<button type="button" class="wc-chip ck-chip' + (rec[row.k] === n + 1 ? ' on' : '') + '" data-ck-action="tap" data-k="' + esc(row.k) + '" data-v="' + (n + 1) + '" aria-pressed="' + (rec[row.k] === n + 1) + '">' + esc(o) + '</button>').join('') + '</div>').join('');
    return '<div class="wc-card ck-card"><div class="wc-card-h">☀️ Morning check-in <small>10 seconds, optional</small></div>' + rows +
      '<div class="ck-foot"><button type="button" class="wc-link ck-skip" data-ck-action="skip">Not today</button></div></div>';
  }
  function mount() {
    const dk = pageDk();
    document.querySelectorAll('.ck-wrap').forEach((n) => n.remove());
    const bar = document.getElementById('today-bar');
    if (!dk || !bar || !K()) return;
    const html = cardHtml(dk);
    if (!html) return;
    const box = document.createElement('div');
    box.className = 'ck-wrap';
    box.innerHTML = html;
    bar.parentNode.insertBefore(box, bar.nextSibling);
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-ck-action]');
    if (!t || !K()) return;
    const dk = pageDk();
    if (!dk) return;
    const a = t.dataset.ckAction;
    let ok = false;
    if (a === 'tap') ok = store(K().tap(load(), dk, t.dataset.k, Number(t.dataset.v)));
    else if (a === 'skip') ok = store(K().skip(load(), dk));
    else if (a === 'reset') ok = store(K().reset(load(), dk));
    if (ok) mount();
  });

  function hook() {
    const orig = window.renderPage;
    if (typeof orig !== 'function' || orig.__ck) return;
    const wrapped = function () { const r = orig.apply(this, arguments); try { mount(); } catch (_) { /* the day page renders without it */ } return r; };
    Object.keys(orig).forEach((k) => { wrapped[k] = orig[k]; });
    wrapped.__ck = true;
    window.renderPage = wrapped;
  }
  function boot() {
    if (!K()) return;
    hook();
    try { if (document.getElementById('today-bar')) mount(); } catch (_) { /* optional */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDCheckinUI = { cardHtml, mount, load };
})();
