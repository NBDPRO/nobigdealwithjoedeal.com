/**
 * arcade-ui.js — the Arcade layout (data-ui="arcade"): the Today bar as a scoreboard (2026-10-25).
 *
 * SCORE / 1UP / COMBO / TODAY in chunky tabular digits, a level bar, today's missions (floors are tappable through app.js's
 * toggle-floor action, the workout opens the coach) and HI-SCORES (the best lift per exercise). Sound and haptics stay off:
 * this is the look only. Pure rules: arcade-logic.js (on quest-logic / xp-logic). No inline style.
 */
(function () {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HIGH = 'nbd_ds_xp_high';
  const readHigh = () => { try { return Number(localStorage.getItem(HIGH)) || 0; } catch (_) { return 0; } };
  const writeHigh = (v) => { try { localStorage.setItem(HIGH, String(v)); } catch (_) {} };
  const pad = (n, w) => String(Math.max(0, Math.floor(n))).padStart(w, '0');

  function html(o) {
    const A = window.NBDArcade; if (!A) return '';
    const a = A.arcade(Object.assign({ highXp: readHigh(), quest: window.NBDQuest }, o || {}));
    if (a.score > readHigh()) writeHigh(a.score);
    const pct = Math.round(Math.max(0, Math.min(1, a.pct || 0)) * 20) * 5;
    const stat = (l, v, cls) => '<div class="ar-stat' + (cls ? ' ' + cls : '') + '"><span class="ar-l">' + l + '</span><b class="ar-v">' + v + '</b></div>';
    const mission = (q) => {
      const tag = q.kind === 'bonus' ? 'div' : 'button';
      const attrs = q.kind === 'floor' ? ' data-action="toggle-floor" data-floor-id="' + esc(q.floorId) + '"' : q.kind === 'workout' && !q.done ? ' data-arcade="workout"' : '';
      return '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' class="ar-m' + (q.done ? ' done' : '') + '"' + attrs + (tag === 'button' ? ' aria-pressed="' + (q.done ? 'true' : 'false') + '"' : '') + '><span class="ar-mk">' + (q.done ? '■' : '□') + '</span><span class="ar-ml">' + esc(q.label) + '</span><span class="ar-mx">+' + q.xp + '</span></' + tag + '>';
    };
    return '<div class="ar-board">' +
      '<div class="ar-row">' + stat('Score', pad(a.score, 6)) + stat('1UP', 'LV' + pad(a.level, 2)) + stat('Combo', pad(a.combo, 2) + (a.bestCombo > a.combo ? '<small>/' + pad(a.bestCombo, 2) + '</small>' : ''), a.combo ? 'hot' : '') + stat('Today', '+' + pad(a.todayXp, 3)) + '</div>' +
      '<div class="ar-bar" role="progressbar" aria-label="Progress to the next level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i class="ar-w' + pct + '"></i><span class="ar-bt">' + a.into + '/' + a.need + ' to LV' + pad(a.level + 1, 2) + '</span></div>' +
      '<div class="ar-h">Missions' + (a.cleared ? ' · <span class="ar-win">STAGE CLEAR</span>' : '') + '</div><div class="ar-list">' + a.quests.map(mission).join('') + '</div>' +
      '<div class="ar-h">Hi-scores</div>' + (a.hi.length ? '<ol class="ar-hi">' + a.hi.map((h, i) => '<li><span class="ar-rk">' + (i + 1) + '</span><span class="ar-hn">' + esc(h.name) + '</span><span class="ar-hv">' + h.weight + '×' + h.reps + '</span></li>').join('') + '</ol>' : '<div class="ar-none">No lifts logged yet. Finish a workout to post a score.</div>') +
      '</div>';
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-arcade="workout"]');
    if (!el) return;
    if (window.NBDCoachUI && typeof window.NBDCoachUI.open === 'function') window.NBDCoachUI.open();
    else { const c = document.querySelector('.wc-card'); if (c) c.scrollIntoView({ block: 'center' }); }
  });

  window.NBDArcadeUI = { html };
})();
