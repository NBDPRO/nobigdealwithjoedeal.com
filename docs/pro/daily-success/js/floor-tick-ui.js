/**
 * floor-tick-ui.js - "Workout done. Tick the floor?" (flow batch 3, D3 / audit M3, the ask-first variant).
 *
 * Nothing is ticked silently. A finished thing raises a window event, nbd-ds-did { kind: 'workout' | 'protein' | 'sleep' | 'wrap', dk, value? }
 * (the coach, the check-in and the wrap-up card raise it; protein is watched here, from the Today bar numbers, and only when it CROSSES the
 * target while the page is open). This file shows one prompt with a one-tap Tick and a Not now; a tap writes the same floormet-<id> key the
 * manual tap writes (app.js setFloorByDk, by date, so it works whichever day or the Dashboard is open), then offers an Undo for 8 seconds.
 * "Not now" is remembered for that kind and day, so it never nags twice. Rules: floor-tick-logic.js.
 */
(function () {
  'use strict';
  if (window.NBDFloorTickUI) return;
  /* global pages, cur */
  const FT = () => window.NBDFloorTick;
  // Jo's decision 3: 'ask' (the default: the prompt, one tap) | 'auto' (tick at once and show the Undo chip) | 'off' (never; floors are ticked by hand).
  const FLOOR_TICK_MODE = 'ask';
  const UNDO_MS = 8000, IDLE_MS = 30000;
  let timer = null, shown = null;       // shown = { dk, id, kind, ticked }
  const declined = {};                  // 'dk|kind' -> true after Not now
  let lastUserAt = -1e9;                // performance.now() of the last meal-field input or food-log tap
  const USER_MS = 3000;
  const lastProtein = {};               // dk -> last grams seen (the baseline; a prompt needs a crossing)

  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : '');
  const pageFor = (dk) => { try { return pages.find((p) => p.dk === dk && (Number(p.suf) || 1) === 1) || pages.find((p) => p.dk === dk) || null; } catch (_) { return null; } };
  const floorsNow = () => { try { return typeof window.getFloors === 'function' ? window.getFloors() : []; } catch (_) { return []; } };

  function el() {
    let e = document.getElementById('dsTick');
    if (e) return e;
    e = document.createElement('div');
    e.id = 'dsTick'; e.className = 'ds-tick'; e.hidden = true;
    e.setAttribute('role', 'status'); e.setAttribute('aria-live', 'polite');
    let s = document.getElementById('dsToasts');
    if (!s) { s = document.createElement('div'); s.id = 'dsToasts'; s.className = 'ds-toasts'; document.body.appendChild(s); }
    s.appendChild(e);
    return e;
  }
  function mk(tag, attrs, text) {
    const n = document.createElement(tag);
    Object.keys(attrs || {}).forEach((k) => { if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function hide() { clearTimeout(timer); timer = null; shown = null; const e = document.getElementById('dsTick'); if (e) { e.hidden = true; e.textContent = ''; } }
  function arm(ms) { clearTimeout(timer); timer = setTimeout(hide, ms); }

  function ask(kind, dk, value) {
    const F = FT(); if (!F || FLOOR_TICK_MODE === 'off') return false;
    if (kind === 'sleep' && !F.sleepCounts(value)) return false;
    if (declined[dk + '|' + kind]) return false;
    const p = pageFor(dk); if (!p) return false;
    const floors = floorsNow();
    const ids = F.offer(floors, p.data || {}, kind);
    if (!ids.length) return false;
    const fl = floors.find((f) => String(f.id) === ids[0]);
    const e = el();
    e.textContent = '';
    const msg = mk('div', { class: 'ds-tick-msg' });
    msg.appendChild(mk('b', {}, F.message(kind)));
    msg.appendChild(mk('small', {}, fl ? fl.label : ''));
    e.appendChild(msg);
    e.appendChild(mk('button', { type: 'button', 'data-tick': 'yes' }, 'Tick it'));
    e.appendChild(mk('button', { type: 'button', 'data-tick': 'no' }, 'Not now'));
    e.hidden = false;
    shown = { dk, id: ids[0], kind, ticked: false, label: fl ? fl.label : '' };
    arm(IDLE_MS);
    if (FLOOR_TICK_MODE === 'auto') tick();
    return true;
  }

  function tick() {
    if (!shown || typeof window.setFloorByDk !== 'function') return;
    if (!window.setFloorByDk(shown.dk, shown.id, true)) { hide(); return; }
    shown.ticked = true;
    const e = el();
    e.textContent = '';
    const msg = mk('div', { class: 'ds-tick-msg' });
    msg.appendChild(mk('b', {}, 'Ticked'));
    msg.appendChild(mk('small', {}, shown.label));
    e.appendChild(msg);
    e.appendChild(mk('button', { type: 'button', 'data-tick': 'undo' }, 'Undo'));
    arm(UNDO_MS);
  }
  function undo() {
    if (shown && shown.ticked && typeof window.setFloorByDk === 'function') window.setFloorByDk(shown.dk, shown.id, false);
    hide();
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target && ev.target.closest ? ev.target.closest('[data-tick]') : null;
    if (!t) return;
    const a = t.dataset.tick;
    if (a === 'yes') tick();
    else if (a === 'undo') undo();
    else if (a === 'no') { if (shown) declined[shown.dk + '|' + shown.kind] = true; hide(); }
  });

  window.addEventListener('nbd-ds-did', (ev) => {
    const d = (ev && ev.detail) || {};
    ask(String(d.kind || ''), d.dk || today(), d.value);
  });

  document.addEventListener('input', (ev) => { const k = ev.target && ev.target.dataset && ev.target.dataset.k; if (k && k.indexOf('diet-m') === 0) lastUserAt = performance.now(); }, true);
  document.addEventListener('click', (ev) => { if (ev.target && ev.target.closest && ev.target.closest('#flCard')) lastUserAt = performance.now(); }, true);

  // Protein: watched from the Today bar numbers. The first number seen for a day is only the baseline; a prompt needs the total to CROSS the target.
  function watchProtein() {
    const F = FT(); if (!F) return;
    let p = null;
    try { p = pages[cur]; } catch (_) { p = null; }
    if (!p || p.dk !== today()) return;
    const node = document.getElementById('ms-p');
    if (!node) return;
    let have = parseFloat(String(node.textContent).replace(/,/g, ''));
    if (!isFinite(have)) have = 0;     // "—" (nothing logged yet) is a zero baseline
    let target = 0;
    try { target = (window.NBDFoodLogUI && window.NBDFoodLogUI.targets && window.NBDFoodLogUI.targets().protein) || 0; } catch (_) { target = 0; }
    const prev = lastProtein[p.dk];
    lastProtein[p.dk] = have;
    // A crossing is something Jo did: typing in a meal field or tapping the food log, just now. A page opening and the food log filling the
    // total in is not (that read as 0 then over target and asked the question on open).
    if (performance.now() - lastUserAt > USER_MS) return;
    if (prev == null || !(prev < target) || !F.proteinHit(have, target)) return;
    window.dispatchEvent(new CustomEvent('nbd-ds-did', { detail: { kind: 'protein', dk: p.dk, value: have } }));
  }
  function hook() {
    const orig = window.updateTodayBar;
    if (typeof orig !== 'function' || orig.__tick) return;
    const wrapped = function () { const r = orig.apply(this, arguments); try { watchProtein(); } catch (_) { /* the bar renders without it */ } return r; };
    wrapped.__tick = true;
    window.updateTodayBar = wrapped;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();

  window.NBDFloorTickUI = { ask, hide, _declined: declined };
})();
