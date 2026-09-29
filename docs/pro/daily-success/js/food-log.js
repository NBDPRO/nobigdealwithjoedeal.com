/**
 * food-log.js — the Food card on top of a day page's Diet section (tracker
 * revamp Phase 2). Rules: food-log-logic.js (window.NBDFoodLog).
 *
 *   - Protein (and, if Jo sets one, calorie) progress for the day. Protein
 *     defaults to 1 g per lb of the 7-day average weight (tracker-history).
 *   - Favorites: one tap adds a saved meal's macros into a meal row (the row
 *     for this time of day unless Jo picks another). "Save as favorite" takes
 *     a row Jo already typed.
 *   - "Same as yesterday" fills today's EMPTY meal rows from the day before.
 *
 * Meals stay in the day page's own meal inputs (data['diet-m*']), so saving
 * and cloud sync are the tracker's own. Favorites + targets live in
 * localStorage 'nbd_ds_food' and ride the userSettings sync (dsFood) —
 * nbd_ localStorage is wiped on sign-out, the cloud copy restores it.
 *
 * Classic script after app.js; reaches app.js's top-level `pages` / `cur`
 * by name. Delegated listeners; every value into innerHTML is escaped.
 */
(function () {
  'use strict';
  if (window.NBDFoodLogUI) return;
  /* global pages, cur */
  const F = () => window.NBDFoodLog;
  const KEY = 'nbd_ds_food';
  const MEAL_NAMES = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };
  let _meal = null;           // the meal row a quick-add goes into (null = by the clock)
  let _panel = null;          // 'save' | 'targets' | null

  function cfg() {
    try { const v = JSON.parse(localStorage.getItem(KEY)); return v && typeof v === 'object' ? { favorites: Array.isArray(v.favorites) ? v.favorites : [], targets: v.targets || {} } : { favorites: [], targets: {} }; }
    catch (_) { return { favorites: [], targets: {} }; }
  }
  function saveCfg(c) {
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (_) { toast('Could not save on this device'); return; }
    if (typeof window.dsSettingsChanged === 'function') window.dsSettingsChanged(KEY);
  }

  const curPage = () => (typeof pages !== 'undefined' && typeof cur !== 'undefined' && cur >= 0 ? pages[cur] : null);
  // What the meal inputs hold right now (newer than page.data until a save).
  function liveData() {
    const d = {};
    document.querySelectorAll('[data-k^="diet-m"]').forEach((el) => { d[el.dataset.k] = el.value || ''; });
    return d;
  }
  function weight() {
    const H = window.NBDTrackerHistory;
    if (!H || typeof pages === 'undefined') return null;
    const t = H.weightTrend(H.weightSeries(pages), typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));
    return t.avg7 != null ? t.avg7 : t.latest;
  }
  function mealIndex() { return _meal != null ? _meal : F().mealForHour(new Date().getHours()); }

  function bar(label, have, target, unit) {
    const pr = F().progress(have, target);
    if (!pr) return '';
    const note = pr.over ? 'over by ' + esc((have - target).toFixed(0)) + unit : esc(pr.left.toFixed(0)) + unit + ' to go';
    return '<div class="fl-bar"><div class="fl-bar-h"><span>' + label + '</span><span><b>' + esc(have.toFixed(0)) + '</b> / ' + esc(target) + unit + ' · ' + note + '</span></div>' +
      '<div class="fl-track"><div class="fl-fill' + (pr.over ? ' fl-over' : '') + '" style="width:' + (pr.pct * 100).toFixed(1) + '%"></div></div></div>';
  }
  function barsHtml() {
    const c = cfg();
    const t = F().totals(liveData());
    const tg = F().targetsFor(weight(), c.targets);
    const bars = bar('Protein', t.p, tg.protein, ' g') + bar('Calories', t.cal, tg.calories, '');
    if (bars) return bars + (tg.proteinFrom === 'weight' ? '<div class="fl-note">Protein target = 1 g per lb of your 7-day average weight. Change it under Targets.</div>' : '');
    return '<div class="fl-note">Set a protein target under Targets, or put your weight in Body Metrics and it sets itself.</div>';
  }

  function panelHtml(c) {
    if (_panel === 'save') {
      const opts = MEAL_NAMES.map((n, i) => '<option value="' + i + '">' + n + '</option>').join('');
      return '<div class="fl-panel"><div class="fl-lbl">Save a meal you typed as a favorite</div><div class="fl-row">' +
        '<select id="flSaveMeal" class="fl-in">' + opts + '</select>' +
        '<button type="button" class="fl-btn fl-primary" data-fl-action="save-go">Save</button>' +
        '<button type="button" class="fl-btn" data-fl-action="panel-close">Cancel</button></div>' +
        '<div class="fl-note">It keeps the row\'s name and macros exactly as typed.</div></div>';
    }
    if (_panel === 'targets') {
      const favs = c.favorites.map((f, i) => '<li>' + esc(f.name) + ' <small>' + esc(f.p) + 'p · ' + esc(f.cal || 0) + ' cal</small> <button type="button" class="fl-x" data-fl-action="fav-del" data-i="' + i + '" aria-label="Remove ' + esc(f.name) + '">✕</button></li>').join('');
      return '<div class="fl-panel"><div class="fl-lbl">Daily targets (blank = automatic / none)</div><div class="fl-row">' +
        '<label class="fl-field">Protein g<input id="flTgtP" class="fl-in" inputmode="numeric" value="' + esc(c.targets.protein || '') + '"></label>' +
        '<label class="fl-field">Calories<input id="flTgtCal" class="fl-in" inputmode="numeric" value="' + esc(c.targets.calories || '') + '"></label>' +
        '<button type="button" class="fl-btn fl-primary" data-fl-action="targets-go">Save</button>' +
        '<button type="button" class="fl-btn" data-fl-action="panel-close">Close</button></div>' +
        (favs ? '<div class="fl-lbl">Favorites</div><ul class="fl-favlist">' + favs + '</ul>' : '') + '</div>';
    }
    return '';
  }

  function cardHtml() {
    if (!F()) return '';
    const c = cfg();
    const mi = mealIndex();
    const p = curPage();
    const prev = p ? F().previousDay(pages, p.dk) : null;
    const canCopy = prev && Object.keys(F().copyDay(prev.data, p && p.data)).length > 0;
    const mealBtns = MEAL_NAMES.map((n, i) => '<button type="button" class="fl-meal' + (i === mi ? ' on' : '') + '" data-fl-action="meal" data-i="' + i + '">' + n + '</button>').join('');
    const chips = c.favorites.length
      ? c.favorites.map((f, i) => '<button type="button" class="fl-chip" data-fl-action="add" data-i="' + i + '">＋ ' + esc(f.name) + ' <small>' + esc(f.p) + 'p</small></button>').join('')
      : '<span class="fl-note">No favorites yet — type a meal below, then "Save as favorite".</span>';
    return '<div class="wc-card fl-card" id="flCard"><div class="wc-card-h">🍽 Food</div>' +
      '<div id="flBars">' + barsHtml() + '</div>' +
      '<div class="fl-lbl">Quick add to</div><div class="fl-meals">' + mealBtns + '</div>' +
      '<div class="fl-chips">' + chips + '</div>' +
      '<div class="fl-row fl-actions">' +
        (canCopy ? '<button type="button" class="fl-btn" data-fl-action="copy">↺ Same as yesterday</button>' : '') +
        '<button type="button" class="fl-btn" data-fl-action="panel" data-p="save">⭐ Save as favorite</button>' +
        '<button type="button" class="fl-btn" data-fl-action="panel" data-p="targets">Targets</button></div>' +
      panelHtml(c) + '</div>';
  }
  function refresh() { const el = document.getElementById('flCard'); if (el) el.outerHTML = cardHtml(); }
  function refreshBars() { const el = document.getElementById('flBars'); if (el) el.innerHTML = barsHtml(); }

  // Write row values into the meal inputs, then let the tracker save them.
  function fillRow(i, row) {
    ['name'].concat(F().FIELDS).forEach((k) => {
      const el = document.querySelector('[data-k="diet-m' + i + '-' + k + '"]');
      if (el) el.value = row[k] == null ? '' : row[k];
    });
  }
  function commit() {
    if (typeof window.calcMacros === 'function') window.calcMacros();
    if (typeof window.markDirty === 'function') window.markDirty();
    // Not silent: the save is real, so the header should read saved too.
    if (typeof window.collectPage === 'function') window.collectPage(false);
    refresh();
  }

  function onAction(t) {
    const a = t.dataset.flAction;
    const c = cfg();
    if (a === 'meal') { _meal = +t.dataset.i; refresh(); }
    else if (a === 'add') {
      const fav = c.favorites[+t.dataset.i];
      const i = mealIndex();
      const row = F().addToMeal(F().mealOf(liveData(), i), fav);
      if (!row) return;
      fillRow(i, row); commit();
      toast('Added ' + fav.name + ' to ' + MEAL_NAMES[i]);
    } else if (a === 'copy') {
      const p = curPage();
      const prev = p && F().previousDay(pages, p.dk);
      if (!prev) return;
      const patch = F().copyDay(prev.data, liveData());
      const n = Object.keys(patch).length;
      Object.keys(patch).forEach((i) => fillRow(+i, patch[i]));
      commit();
      toast(n ? 'Copied ' + n + ' meal' + (n === 1 ? '' : 's') + ' from ' + prev.dk : 'Nothing to copy');
    } else if (a === 'panel') { _panel = t.dataset.p; refresh(); }
    else if (a === 'panel-close') { _panel = null; refresh(); }
    else if (a === 'save-go') {
      const i = +((document.getElementById('flSaveMeal') || {}).value || 0);
      const m = F().mealOf(liveData(), i);
      const fav = F().normalizeFav(m);
      if (!fav) { toast('Type a name and at least one number in ' + MEAL_NAMES[i] + ' first'); return; }
      c.favorites = F().upsertFav(c.favorites, fav);
      saveCfg(c); _panel = null; refresh();
      toast('Saved ' + fav.name);
    } else if (a === 'targets-go') {
      const p = parseFloat((document.getElementById('flTgtP') || {}).value);
      const cal = parseFloat((document.getElementById('flTgtCal') || {}).value);
      c.targets = { protein: p > 0 ? Math.round(p) : null, calories: cal > 0 ? Math.round(cal) : null };
      saveCfg(c); _panel = null; refresh();
      toast('Targets saved');
    } else if (a === 'fav-del') {
      const f = c.favorites[+t.dataset.i];
      if (!f) return;
      c.favorites = F().removeFav(c.favorites, f.name);
      saveCfg(c); refresh();
    }
  }

  document.addEventListener('click', (ev) => {
    const t = ev.target.closest && ev.target.closest('[data-fl-action]');
    if (t) onAction(t);
  });
  document.addEventListener('input', (ev) => {
    const k = ev.target && ev.target.dataset && ev.target.dataset.k;
    if (k && k.indexOf('diet-m') === 0) refreshBars();
  });

  function hook() {
    const orig = window.buildDietSection;
    if (typeof orig !== 'function' || orig.__food) return;
    const wrapped = function () { _panel = null; return cardHtml() + orig.apply(this, arguments); };
    wrapped.__food = true;
    window.buildDietSection = wrapped;
  }
  function boot() {
    if (!F()) return;
    hook();
    try { if (document.getElementById('diet-pb') && typeof window.renderPage === 'function') window.renderPage(); } catch (_) { /* renders without the card */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDFoodLogUI = { refresh, cardHtml };
})();
