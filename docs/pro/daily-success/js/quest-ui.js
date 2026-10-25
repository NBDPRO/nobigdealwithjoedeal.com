/**
 * quest-ui.js — the Quest layout (data-ui="quest"): the Today bar becomes a quest board (2026-10-25).
 *
 * Level badge and XP bar, the streak, and today's quests: each floor is a quest the user taps to complete (the row carries
 * data-action="toggle-floor", so app.js's own delegation does the toggle and re-renders), the all-floors bonus, and the
 * workout quest, which opens the coach. Pure rules: quest-logic.js. No inline style: the XP bar width is a 5%-step class.
 */
(function () {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const HIGH = 'nbd_ds_xp_high';
  const readHigh = () => { try { return Number(localStorage.getItem(HIGH)) || 0; } catch (_) { return 0; } };
  const writeHigh = (v) => { try { localStorage.setItem(HIGH, String(v)); } catch (_) { /* private window: the level still shows */ } };

  function html(o) {
    const Q = window.NBDQuest; if (!Q) return '';
    const b = Q.questBoard(Object.assign({ highXp: readHigh() }, o || {}));
    if (b.totalXp > readHigh()) writeHigh(b.totalXp);
    const pct = Math.round(Math.max(0, Math.min(1, b.level.pct || 0)) * 20) * 5;
    const row = (q) => {
      const attrs = q.kind === 'floor' ? ' data-action="toggle-floor" data-floor-id="' + esc(q.floorId) + '"' : q.kind === 'workout' && !q.done ? ' data-quest="workout"' : '';
      const tag = q.kind === 'bonus' ? 'div' : 'button';
      return '<' + tag + (tag === 'button' ? ' type="button"' : '') + ' class="qb-q' + (q.done ? ' done' : '') + ' ' + q.kind + '"' + attrs + (tag === 'button' ? ' aria-pressed="' + (q.done ? 'true' : 'false') + '"' : '') + '>' +
        '<span class="qb-chk" aria-hidden="true">' + (q.done ? '✓' : '') + '</span><span class="qb-lbl">' + esc(q.label) + '</span><span class="qb-xp">+' + q.xp + ' XP</span></' + tag + '>';
    };
    return '<div class="qb-head"><span class="qb-lv">Lv ' + b.level.level + '</span><div class="qb-bar" role="progressbar" aria-label="Progress to the next level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i class="qb-w' + pct + '"></i></div><span class="qb-xpn">' + b.level.into + ' / ' + b.level.need + ' XP</span></div>' +
      '<div class="qb-meta"><span class="qb-streak' + (b.streak.atRisk ? ' risk' : b.streak.current ? ' on' : '') + '">🔥 ' + b.streak.current + '-day streak' + (b.streak.atRisk ? ' · train today to keep it' : b.streak.best > b.streak.current ? ' · best ' + b.streak.best : '') + '</span><span class="qb-today">+' + b.todayXp + ' XP today</span></div>' +
      '<div class="qb-list">' + b.quests.map(row).join('') + '</div>' +
      (b.allDone ? '<div class="qb-done">Quest board cleared. Rest easy.</div>' : '<div class="qb-left">' + (b.quests.length - b.doneCount) + ' quest' + (b.quests.length - b.doneCount === 1 ? '' : 's') + ' left today</div>');
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-quest="workout"]');
    if (!el) return;
    if (window.NBDCoachUI && typeof window.NBDCoachUI.open === 'function') window.NBDCoachUI.open();
    else { const c = document.getElementById('coach-card') || document.querySelector('.wc-card'); if (c) c.scrollIntoView({ block: 'start' }); }
  });

  window.NBDQuestUI = { html };
})();
