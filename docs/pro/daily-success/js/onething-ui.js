/**
 * onething-ui.js — the One Thing layout (data-ui="onething"): the Today bar becomes one big "do this next" card (2026-10-25).
 *
 * The floor card's button carries data-action="toggle-floor", so app.js's own delegation completes it and re-renders; the
 * check-in and wrap-up buttons scroll to those cards; the workout button opens the coach. "Not now" sends the thing to the
 * back of the line for this visit (in memory only). Pure rules: onething-logic.js.
 */
(function () {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let skipped = [];
  const readMap = (k) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : {}; } catch (_) { return {}; } };

  /** o = { floors, workout, dk, today } */
  function html(o) {
    const O = window.NBDOneThing; if (!O) return '';
    const opt = o || {}, hour = new Date().getHours(), isToday = opt.dk === opt.today;
    let checkin = 'hidden', eod = 'link';
    try { if (window.NBDCheckin) checkin = window.NBDCheckin.state(readMap('nbd_ds_coach_ready'), opt.dk, opt.today, hour); } catch (_) {}
    try { if (window.NBDEod) eod = window.NBDEod.state(readMap('nbd_ds_eod'), opt.dk, opt.today, hour); } catch (_) {}
    const r = O.nextThing({ isToday, checkin, floors: opt.floors || [], workout: opt.workout, eod, skipped });
    const t = r.thing;
    const btn = t.kind === 'floor' ? '<button type="button" class="ot-btn" data-action="toggle-floor" data-floor-id="' + esc(t.floorId) + '">' + esc(t.button) + '</button>'
      : t.kind === 'done' ? '' : '<button type="button" class="ot-btn" data-onething="' + esc(t.kind) + '">' + esc(t.button) + '</button>';
    return '<div class="ot-card ' + esc(t.kind) + '"><div class="ot-eyebrow">' + (t.kind === 'done' ? 'Today' : 'Do this next') + '</div><h2 class="ot-title">' + esc(t.title) + '</h2><p class="ot-sub">' + esc(t.sub) + '</p>' + btn +
      (t.kind !== 'done' && r.left > 1 ? '<button type="button" class="ot-skip" data-onething="skip" data-id="' + esc(t.id) + '">Not now</button>' : '') +
      '<div class="ot-left">' + (r.left ? r.left + ' thing' + (r.left === 1 ? '' : 's') + ' open today' : 'Nothing open') + '</div></div>';
  }

  function scrollTo(sel) { const el = document.querySelector(sel); if (el) { el.scrollIntoView({ block: 'center' }); const f = el.querySelector('button, input'); if (f) f.focus({ preventScroll: true }); } }
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-onething]');
    if (!el) return;
    const k = el.dataset.onething;
    if (k === 'skip') { skipped.push(el.dataset.id); if (typeof window.updateTodayBar === 'function') window.updateTodayBar(); }
    else if (k === 'checkin') scrollTo('.ck-card');
    else if (k === 'eod') { const open = document.querySelector('.eod-card [data-eod-action="edit"]'); if (open) open.click(); scrollTo('.eod-card'); }
    else if (k === 'workout') { if (window.NBDCoachUI && typeof window.NBDCoachUI.open === 'function') window.NBDCoachUI.open(); else scrollTo('.wc-card'); }
  });
  window.addEventListener('nbd-layout', () => { skipped = []; });

  window.NBDOneThingUI = { html, _reset: () => { skipped = []; } };
})();
