/**
 * nextup-ui.js - Next-Up (flow batch 3, audit M1 / M2 / D5, 2026-11-09).
 *
 *   - The Next-Up strip (#nextup) sits under the Today bar on every day page, in every layout: "Next: Train - Push day [Go]  3 left". The
 *     brain is onething-logic.js (nextUp + dayPhase, pure and unit tested); this file gathers what the tracker already knows and draws it.
 *     On a past day the strip says "Viewing Tue Nov 3" and offers "Back to today".
 *   - The Dash gets a Today card at the very top: floors (tap one to tick it on today's page), the same Next-Up line, and "Open today".
 *   - buttonHtml(): the primary "Next: ..." button the finish surfaces end with (coach summary, check-in, wrap-up). Close stays secondary.
 *   - place(): keeps the order under the Today bar: strip, chips, then whatever other cards mounted (check-in, wrap-up).
 * Classic script, loaded last; delegated listeners; every value that reaches innerHTML goes through esc().
 */
(function () {
  'use strict';
  if (window.NBDNextUp) return;
  /* global pages, cur */
  const O = () => window.NBDOneThing;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : '');
  const allPages = () => { try { return Array.isArray(pages) ? pages : []; } catch (_) { return []; } };
  const curIdx = () => { try { return cur; } catch (_) { return -1; } };
  const pageFor = (dk) => allPages().find((p) => p.dk === dk && (Number(p.suf) || 1) === 1) || allPages().find((p) => p.dk === dk) || null;
  const floorsNow = () => { try { return typeof window.getFloors === 'function' ? window.getFloors() : []; } catch (_) { return []; } };
  // Jo's decision 5: the Dash keeps its layout and gets the Today card on top. Set false to leave the Dash exactly as it was.
  const DASH_TODAY_CARD = true;
  const WORKOUT_FLOOR = /work\s*-?out|train|lift|gym|exercise/i;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(dk) { const [y, m, d] = String(dk).split('-').map(Number); const t = new Date(y, m - 1, d); return isNaN(t) ? String(dk) : DOW[t.getDay()] + ' ' + MON[t.getMonth()] + ' ' + d; }

  // Everything Next-Up needs for one date, read from what the tracker already keeps.
  function context(dk) {
    const tk = today(), p = pageFor(dk), isToday = dk === tk, hour = new Date().getHours();
    const d = (p && p.data) || {};
    const floors = floorsNow().map((f) => ({ id: f.id, label: f.label, met: d['floormet-' + f.id] === '1' }));
    let sessions = []; try { sessions = readJson('nbd_ds_workouts', []); } catch (_) { sessions = []; }
    const workout = window.NBDDayLayout ? window.NBDDayLayout.workoutDone(sessions, dk) : false;
    let checkin = 'hidden', eod = 'link';
    try { if (window.NBDCheckin) checkin = window.NBDCheckin.state(readJson('nbd_ds_coach_ready', {}), dk, tk, hour); } catch (_) { /* optional */ }
    try { if (window.NBDEod) eod = window.NBDEod.state(readJson('nbd_ds_eod', {}), dk, tk, hour); } catch (_) { /* optional */ }
    const o = { isToday, hour, checkin, eod, floors, workout, skipped: [] };
    // protein: only while the page for that date is on screen (its totals live in the DOM)
    try {
      const open = allPages()[curIdx()];
      const node = document.getElementById('ms-p');
      if (isToday && open && open.dk === dk && node && window.NBDFoodLogUI && window.NBDFoodLogUI.targets) {
        const have = parseFloat(String(node.textContent).replace(/,/g, '')), target = window.NBDFoodLogUI.targets().protein;
        o.protein = { have: isFinite(have) ? have : 0, target: Number(target) || 0 };
      }
    } catch (_) { /* optional */ }
    try { if (isToday && p && window.NBDTrackerHistory) o.weighed = window.NBDTrackerHistory.weightSeries(allPages()).some((r) => r.dk === dk); } catch (_) { /* optional */ }
    try {
      const live = document.querySelector('[data-k="ms-nonneg"]');
      const blank = live ? !String(live.value || '').trim() : !String(d['ms-nonneg'] || '').trim();
      if (isToday && p && blank && window.NBDEod && window.NBDEod.carryForward) o.carry = window.NBDEod.carryForward(readJson('nbd_ds_eod', {}), tk);
    } catch (_) { /* optional */ }
    try { if (isToday && window.NBDReview) { const rv = readJson('nbd_ds_reviews', {}); o.reviewDue = window.NBDReview.reviewDue(tk, (rv && rv.weeks) || {}).due; } } catch (_) { /* optional */ }
    return o;
  }
  function compute(dk, exclude) {
    if (!O() || !O().nextUp) return null;
    const o = context(dk);
    const r = O().nextUp(o);
    const ex = (exclude || []).map(String);
    if (ex.length) {
      // a finished workout also takes the workout-type floor off the list (the ask-first prompt owns that tick)
      const items = r.items.filter((t) => ex.indexOf(t.kind) < 0 && !(ex.indexOf('workout') >= 0 && t.kind === 'floor' && WORKOUT_FLOOR.test(String(t.title || ''))));
      const thing = items[0] || { id: 'done', kind: 'done', title: 'That\'s everything for now.', sub: '', button: '' };
      return Object.assign({}, r, { thing, items, left: items.length, queue: items.map((t) => t.id), ctx: o });
    }
    return Object.assign({}, r, { ctx: o });
  }

  // What the Go button says and does for a thing. A workout-type floor starts the coach (the floor itself is ticked by the ask-first prompt).
  function label(t, o) {
    if (t.kind === 'floor') {
      const f = (o && o.floors || []).find((x) => String(x.id) === String(t.floorId));
      if (f && WORKOUT_FLOOR.test(String(f.label || '')) && !(o && o.workout)) return 'Start';
      return 'Done';
    }
    return t.button || 'Go';
  }
  function lineHtml(r, ctx) {
    const t = r.thing;
    if (t.kind === 'done') return '<div class="nu-line"><b>Nothing left for now.</b> Rest is part of the plan.</div>';
    const attrs = ' data-nextup="' + esc(t.kind) + '"' + (t.floorId != null ? ' data-floor-id="' + esc(t.floorId) + '"' : '');
    return '<div class="nu-line">Next: <b>' + esc(t.title) + '</b> <span class="nu-left">' + esc(r.left) + ' left</span></div><button type="button" class="nu-btn"' + attrs + '>' + esc(label(t, ctx)) + ' →</button>';
  }

  // ── the strip on a day page ──
  function stripHtml() {
    const p = allPages()[curIdx()];
    if (!p) return '';
    if (p.dk !== today()) return '<div class="nu-line">Viewing <b>' + esc(dayLabel(p.dk)) + '</b></div><button type="button" class="nu-btn" data-nextup="today">Back to today →</button>';
    const r = compute(p.dk);
    return r ? lineHtml(r, r.ctx) : '';
  }
  function renderStrip() {
    const bar = document.getElementById('today-bar');
    let s = document.getElementById('nextup');
    if (!bar || curIdx() < 0) { if (s) s.remove(); return; }
    if (!s) { s = document.createElement('div'); s.id = 'nextup'; s.className = 'nu-strip'; s.setAttribute('aria-live', 'polite'); }
    const html = stripHtml();
    if (s.dataset.sig !== html) { s.innerHTML = html; s.dataset.sig = html; }
    if (s.previousElementSibling !== bar) bar.after(s);
  }
  function place() {
    const bar = document.getElementById('today-bar'), s = document.getElementById('nextup');
    if (bar && s && s.previousElementSibling !== bar) bar.after(s);
    if (window.NBDQuickJumpUI && window.NBDQuickJumpUI.placeChips) window.NBDQuickJumpUI.placeChips();
  }

  // ── the Today card on the Dash ──
  function dashCard() {
    const tk = today(), p = pageFor(tk);
    const card = document.createElement('div');
    card.className = 'nu-today';
    let html = '<div class="nu-title">Today <small>' + esc(dayLabel(tk)) + '</small></div>';
    if (!p) {
      html += '<div class="nu-line">No page for today yet. Opening one is a tap.</div>';
    } else {
      const d = p.data || {}, fl = floorsNow();
      const met = fl.filter((f) => d['floormet-' + f.id] === '1').length;
      html += '<div class="nu-floors">' + met + ' / ' + fl.length + ' floors met</div><div class="nu-flrow">' +
        fl.map((f) => '<button type="button" class="nu-fl' + (d['floormet-' + f.id] === '1' ? ' hit' : '') + '" data-nu-floor="' + esc(f.id) + '" aria-pressed="' + (d['floormet-' + f.id] === '1') + '">' + esc(f.label) + '</button>').join('') + '</div>';
      const r = compute(tk);
      if (r) html += '<div class="nu-strip" style="border:0;padding:0;background:transparent;border-radius:0;">' + lineHtml(r, r.ctx) + '</div>';
    }
    html += '<button type="button" class="nu-btn nu-open" data-nu="open-today">Open today →</button>';
    card.innerHTML = html;
    return card;
  }
  function mountDash() {
    if (!DASH_TODAY_CARD || curIdx() !== -1) return;
    // a direct child of #main, first in the DOM and first by `order` (css), because the other Dash cards (streak, money, weight, data) mount
    // themselves into #main too, some a beat later: the Today card stays above all of them.
    const main = document.getElementById('main');
    if (!main) return;
    main.querySelectorAll(':scope > .nu-today').forEach((n) => n.remove());
    main.insertBefore(dashCard(), main.firstChild);
  }

  // ── going somewhere ──
  function ensureToday() {
    const tk = today();
    const idx = allPages().findIndex((p) => p.dk === tk && (Number(p.suf) || 1) === 1);
    if (idx >= 0) { if (curIdx() !== idx) window.switchTo(idx); return true; }
    if (typeof window.smartNewPage === 'function') { window.smartNewPage(); return true; }
    return false;
  }
  function scrollSel(sel) { const n = document.querySelector(sel); if (n && typeof window.scrollToEl === 'function') window.scrollToEl(n); return n; }
  function run(kind, floorId) {
    if (kind === 'today') { ensureToday(); return; }
    if (kind === 'checkin') { scrollSel('.ck-card'); return; }
    if (kind === 'floor') {
      const o = context(today()), f = o.floors.find((x) => String(x.id) === String(floorId));
      if (f && WORKOUT_FLOOR.test(String(f.label || '')) && !o.workout && window.NBDCoachUI && window.NBDCoachUI.open) { window.NBDCoachUI.open(); return; }
      if (typeof window.setFloorByDk === 'function' && f) window.setFloorByDk(today(), floorId, true);
      return;
    }
    if (kind === 'workout') { if (window.NBDCoachUI && window.NBDCoachUI.open) window.NBDCoachUI.open(); return; }
    if (kind === 'food') { if (typeof window.tbGo === 'function') window.tbGo('cal'); return; }
    if (kind === 'weigh') { const c = document.querySelector('.pc[data-sec="pr"]'); if (c && typeof window.openSection === 'function') window.openSection(c); const i = document.querySelector('[data-k="bm-wt"]'); if (i) { window.scrollToEl(i); i.focus({ preventScroll: true }); } return; }
    if (kind === 'carry') { const b = document.querySelector('.eod-carry [data-carry="use"]'); if (b) b.click(); else scrollSel('[data-k="ms-nonneg"]'); return; }
    if (kind === 'eod') { const b = document.querySelector('.eod-card [data-eod-action="edit"]'); if (b) b.click(); const c = scrollSel('.eod-card'); const i = document.getElementById('eodWin'); if (c && i) i.focus({ preventScroll: true }); return; }
    if (kind === 'review') { if (window.NBDReviewUI && window.NBDReviewUI.open) window.NBDReviewUI.open(); return; }
  }
  function go(kind, floorId) {
    // a hand-off from inside the coach: close it first, then go
    const ov = document.querySelector('#wcOverlay.open');
    if (ov && window.NBDCoachUI && window.NBDCoachUI.close) { window.NBDCoachUI.close(); setTimeout(() => run(kind, floorId), 320); return; }
    if (kind !== 'today' && kind !== 'review' && kind !== 'workout' && curIdx() < 0) { ensureToday(); setTimeout(() => run(kind, floorId), 60); return; }
    run(kind, floorId);
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-nextup], [data-nu], [data-nu-floor]') : null;
    if (!t) return;
    if (t.dataset.nextup) go(t.dataset.nextup, t.dataset.floorId);
    else if (t.dataset.nu === 'open-today') ensureToday();
    else if (t.dataset.nuFloor != null) {
      const tk = today(), p = pageFor(tk); if (!p || typeof window.setFloorByDk !== 'function') return;
      window.setFloorByDk(tk, t.dataset.nuFloor, (p.data || {})['floormet-' + t.dataset.nuFloor] !== '1');
    }
  });

  /** The primary hand-off button a finish surface ends with ('' when nothing is left). exclude: kinds to skip (the surface just finished one). */
  function buttonHtml(opt) {
    const o = opt || {};
    const r = compute(today(), o.exclude || []);
    if (!r || r.thing.kind === 'done') return '';
    const t = r.thing, ctx = r.ctx || context(today());
    return '<button type="button" class="nu-next nu-primary" data-nextup="' + esc(t.kind) + '"' + (t.floorId != null ? ' data-floor-id="' + esc(t.floorId) + '"' : '') + '>Next: ' + esc(t.title) + ' →</button>';
  }
  function current() { const r = compute(today()); return r && r.thing.kind !== 'done' ? { kind: r.thing.kind, title: r.thing.title, button: label(r.thing, r.ctx), floorId: r.thing.floorId, left: r.left } : null; }

  function wrap(name, after) {
    const orig = window[name];
    if (typeof orig !== 'function' || orig['__nu_' + name]) return;
    const w = function () { const r = orig.apply(this, arguments); try { after(); } catch (_) { /* the page renders without it */ } return r; };
    Object.keys(orig).forEach((k) => { w[k] = orig[k]; });
    w['__nu_' + name] = true;
    window[name] = w;
  }
  function boot() {
    wrap('renderPage', () => { renderStrip(); place(); });
    wrap('updateTodayBar', renderStrip);
    wrap('renderDash', mountDash);
    window.addEventListener('nbd-floors-changed', () => { renderStrip(); mountDash(); });
    window.addEventListener('nbd-layout', renderStrip);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { renderStrip(); mountDash(); } });
    try { if (curIdx() === -1) mountDash(); else renderStrip(); } catch (_) { /* optional */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDNextUp = { buttonHtml, current, place, renderStrip, mountDash, go, ensureToday, dayLabel, _compute: compute };
})();
