/**
 * cockpit-ui.js — the Cockpit layout (data-ui="cockpit"): one dense HUD in place of the Today bar (2026-10-25).
 *
 * Eight tiles: today's floors, calories, protein and workout (the same numbers the bar and the Rings layout show, from
 * day-layout-logic.js's summary), then the training week from cockpit-logic.js (workouts, hard sets vs last week, training
 * streak, level), and a line naming the muscles that are behind this week. Markup only (no inline style); app.js's
 * updateTodayBar() calls html() when the Cockpit layout is active. Pure rules: cockpit-logic.js (NBDCockpit).
 */
(function () {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const tile = (t, cls) => '<div class="ck-t' + (cls ? ' ' + cls : '') + '"><span class="ck-l">' + esc(t.label) + '</span><b class="ck-v">' + esc(t.value) + '</b><small class="ck-s">' + esc(t.sub || '') + '</small></div>';

  /**
   * o = { summary (todaySummary), targets {calories, protein}, sessions, today (YYYY-MM-DD), coach, xp, equip, avoid }
   * -> markup for the Today bar in the Cockpit layout.
   */
  function html(o) {
    const s = (o && o.summary) || {}, tg = (o && o.targets) || {};
    const day = [
      { label: 'Floors', value: s.floors || '0/0', sub: s.allMet ? 'all met' : 'today', cls: s.allMet ? 'ok' : '' },
      { label: 'Calories', value: s.cal || '—', sub: tg.calories > 0 ? 'of ' + Number(tg.calories).toLocaleString('en-US') : 'no target' },
      { label: 'Protein', value: (s.protein || '—') + (s.protein && s.protein !== '—' ? ' g' : ''), sub: tg.protein > 0 ? 'of ' + Number(tg.protein) + ' g' : 'no target' },
      { label: 'Workout', value: s.workout ? 'Done' : '—', sub: s.workout ? 'today' : 'not yet', cls: s.workout ? 'ok' : '' },
    ];
    let week = { tiles: [], behind: [], enough: false };
    try { if (window.NBDCockpit && o && o.coach && o.xp) week = window.NBDCockpit.cockpit(o.sessions || [], o.today, { coach: o.coach, xp: o.xp, equip: o.equip, avoid: o.avoid }); } catch (_) { /* a bad session record never blanks the HUD */ }
    const labels = (o && o.coach && o.coach.MUSCLE_LABELS) || {};
    const behind = (week.behind || []).map((m) => labels[m] || m);
    return '<div class="ck-grid">' + day.map((t) => tile(t, t.cls)).join('') + week.tiles.map((t) => tile(Object.assign({}, t, { label: t.id === 'streak' ? 'Streak' : t.label, sub: String(t.sub || '').replace(' vs last week', ' vs last wk') }), t.id === 'streak' && Number(t.value) > 0 ? 'ok' : '')).join('') + '</div>' +
      (behind.length ? '<div class="ck-behind">Behind this week: ' + esc(behind.join(', ')) + '</div>' : week.enough ? '<div class="ck-behind ok">Every muscle is getting work this week</div>' : '');
  }

  window.NBDCockpitUI = { html };
})();
