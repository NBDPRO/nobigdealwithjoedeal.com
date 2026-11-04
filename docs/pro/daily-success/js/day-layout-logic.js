/**
 * Daily Success day-page layout helpers (pure, no DOM): which sections start collapsed, and the numbers for the
 * sticky "Today" bar. Loaded before app.js; tests/daily-success-day-layout-2026-10-21.test.js pins it.
 *
 * Jo (2026-10-21): the day page on a phone is a stack of collapsible sections with a sticky summary on top; Food and
 * Fitness are open by default (the Floors score is its own card, always visible), the rest start collapsed.
 */
(function (root) {
  'use strict';

  /** Sections (data-sec on the .pc cards) that start OPEN on a phone. */
  const OPEN_BY_DEFAULT = ['diet', 'fitness'];

  /**
   * Should this section start collapsed? A choice Jo already made (saved true/false) always wins, including
   * "I opened Habits" and "I closed Food". With no saved choice: collapsed on a phone unless it is in OPEN_BY_DEFAULT;
   * on a larger screen everything starts open as before.
   */
  function sectionCollapsed(saved, sec, phone) {
    if (saved && typeof saved === 'object' && Object.prototype.hasOwnProperty.call(saved, sec)) return !!saved[sec];
    return !!phone && OPEN_BY_DEFAULT.indexOf(sec) < 0;
  }

  const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : null; };
  const fmt = (n) => (n == null ? '—' : Math.round(n).toLocaleString('en-US'));

  /** Did Jo finish a Workout Coach session on this day? (sessions = nbd_ds_workouts) */
  function workoutDone(sessions, dk) {
    return (Array.isArray(sessions) ? sessions : []).some((s) => s && !s.deleted && s.finishedAt && s.date === dk);
  }

  /**
   * The sticky bar's numbers. hit/total = floors met; cal/protein come straight from the day's macro summary
   * (strings like "1,240" or an em dash); workout is a boolean. -> { floors, floorsPct, cal, protein, workout, allMet }
   */
  function todaySummary(o) {
    o = o || {};
    const total = Math.max(0, Math.round(num(o.total) || 0));
    const hit = Math.min(total, Math.max(0, Math.round(num(o.hit) || 0)));
    return {
      floors: hit + '/' + total,
      floorsPct: total ? Math.round(hit / total * 100) : 0,
      allMet: total > 0 && hit === total,
      cal: fmt(num(o.cal)),
      protein: fmt(num(o.protein)),
      workout: !!o.workout,
    };
  }

  /**
   * The Rings layout's four rings: Floors (met of total), Calories and Protein (eaten of target) and Workout (done today).
   * pct is 0-1; a ring with no target stays empty and says so. Calories has no "done" (whether eating more or less is the goal is
   * Jo's call); it only turns amber when over the target. "closed" = floors, protein (if a target is set) and workout all done.
   * o = todaySummary's inputs plus calTarget / proteinTarget. -> { rings: [{ id, label, value, sub, pct, done, over }], closed }
   */
  function ringsFor(o) {
    o = o || {};
    const s = todaySummary(o);
    const cal = num(o.cal), pro = num(o.protein);
    const calT = num(o.calTarget) > 0 ? num(o.calTarget) : null;
    const proT = num(o.proteinTarget) > 0 ? num(o.proteinTarget) : null;
    const frac = (v, t) => (t && v != null ? Math.max(0, Math.min(1, v / t)) : 0);
    const proDone = !!proT && pro != null && pro >= proT;
    const rings = [
      { id: 'floors', label: 'Floors', value: s.floors, sub: '', pct: s.floorsPct / 100, done: s.allMet, over: false },
      { id: 'cal', label: 'Calories', value: s.cal, sub: calT ? 'of ' + fmt(calT) : 'no target', pct: frac(cal, calT), done: false, over: !!calT && cal != null && cal > calT },
      { id: 'protein', label: 'Protein', value: s.protein, sub: proT ? 'of ' + fmt(proT) + ' g' : 'no target', pct: frac(pro, proT), done: proDone, over: false },
      { id: 'workout', label: 'Workout', value: s.workout ? 'Done' : '\u2014', sub: '', pct: s.workout ? 1 : 0, done: s.workout, over: false },
    ];
    return { rings, closed: s.allMet && s.workout && (!proT || proDone) };
  }

  const escH = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /** Markup for ringsFor()'s result. Drawn with SVG attributes only (no inline style), so it is CSP-safe. */
  function ringsHtml(r) {
    const rings = (r && r.rings) || [];
    const one = (g) => {
      const pct = Math.round(Math.max(0, Math.min(1, g.pct)) * 1000) / 10;
      const say = g.label + ' ' + g.value + (g.sub ? ' ' + g.sub : '');
      return '<div class="rg-r' + (g.done ? ' done' : '') + (g.over ? ' over' : '') + '" role="img" aria-label="' + escH(say) + '">'
        + '<div class="rg-c"><svg class="rg-svg" viewBox="0 0 36 36" aria-hidden="true">'
        + '<circle class="rg-t" cx="18" cy="18" r="15.9155" fill="none" stroke-width="3.2"/>'
        + (pct > 0 ? '<circle class="rg-p" cx="18" cy="18" r="15.9155" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-dasharray="' + pct + ' 100" transform="rotate(-90 18 18)"/>' : '')
        + '</svg><span class="rg-v">' + escH(g.value) + '</span></div>'
        + '<span class="rg-l">' + escH(g.label) + '</span></div>';
    };
    return '<div class="rg-wrap' + (r && r.closed ? ' closed' : '') + '">' + rings.map(one).join('') + '</div>'
      + (r && r.closed ? '<div class="rg-note">All rings closed</div>' : '');
  }

  /**
   * Door-knocking / sales stats (Activity Totals, Revenue Pace, Doors / Revenue / Closes charts, monthly sales goals) are
   * hidden for someone who has never used them. pref is Jo's explicit switch ('1' on, '0' off) and always wins; with no
   * switch they appear on their own as soon as there is anything to show: a logged door, contact, appointment, close or
   * revenue, or a monthly goal. totals = { doors, contacts, appts, closes, revenue, goals:{d,r,c} }.
   */
  function salesVisible(pref, totals) {
    if (pref === '1' || pref === 1 || pref === true) return true;
    if (pref === '0' || pref === 0 || pref === false) return false;
    const t = totals || {}, g = t.goals || {};
    return [t.doors, t.contacts, t.appts, t.closes, t.revenue, g.d, g.r, g.c].some((v) => (num(v) || 0) > 0);
  }

  const ymdOf = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

  /**
   * The "this week at a glance" strip: the seven days Monday..Sunday of the week holding todayDk, each with its page (if any), floors met,
   * a shade level (full 100%+, half 50%+, some above 0; none when there is no page or no floors) and whether a workout was finished.
   * -> [{ dk, label, day, isToday, pageIdx (-1 = no page), met, total, level, trained }]
   */
  function weekStrip(pages, floors, sessions, todayDk) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(todayDk || ''))) return [];
    const [y, m, d] = todayDk.split('-').map(Number);
    const base = new Date(y, m - 1, d);
    const monday = new Date(y, m - 1, d - ((base.getDay() + 6) % 7));
    const list = Array.isArray(pages) ? pages : [], fl = Array.isArray(floors) ? floors : [];
    const labels = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
    return labels.map((label, i) => {
      const dt = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
      const dk = ymdOf(dt);
      const pageIdx = list.findIndex((p) => p && p.dk === dk);
      const data = pageIdx >= 0 ? list[pageIdx].data || {} : {};
      const met = fl.filter((f) => data['floormet-' + f.id] === '1').length;
      const total = fl.length;
      const pct = total > 0 ? met / total : 0;   // no page means no data, so met is 0 and the level is none
      return { dk, label, day: dt.getDate(), isToday: dk === todayDk, pageIdx, met, total, level: pct >= 1 ? 'full' : pct >= 0.5 ? 'half' : pct > 0 ? 'some' : 'none', trained: workoutDone(sessions, dk) };
    });
  }

  const api = { OPEN_BY_DEFAULT, sectionCollapsed, workoutDone, weekStrip, todaySummary, ringsFor, ringsHtml, salesVisible };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDDayLayout = api;
})(typeof window !== 'undefined' ? window : null);
