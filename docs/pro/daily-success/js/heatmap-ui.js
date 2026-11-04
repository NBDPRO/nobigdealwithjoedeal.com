/**
 * heatmap-ui.js — the 12-month activity heatmap card, shown under the 📈 Progress card (progress-charts-ui.js appends cardHtml()).
 * Rules: heatmap-logic.js. Reads finished sessions from localStorage (nbd_ds_workouts); no new data. Every value into innerHTML is
 * escaped; the squares are SVG rects shaded by CSS classes (css/heatmap.css), so there is no inline style.
 */
(function () {
  'use strict';
  if (window.NBDHeatmapUI) return;
  const SESS = 'nbd_ds_workouts';
  const CELL = 10, GAP = 2, TOP = 16;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : new Date().toISOString().slice(0, 10));

  function cardHtml() {
    const H = window.NBDHeatmap;
    if (!H || !window.NBDCoach) return '';
    let h;
    try { h = H.heatmap(readJson(SESS, []), today(), { coach: window.NBDCoach }); } catch (_) { return ''; }
    if (!h.weeks.length) return '';
    if (!h.workouts) {
      return '<div class="wc-card hm-card" id="hmCard"><div class="wc-card-h">🗓️ Activity</div><div class="wc-meta">Your year of training shows here after your first finished workout.</div></div>';
    }
    const W = h.weeks.length * (CELL + GAP) - GAP, Ht = TOP + 7 * (CELL + GAP) - GAP;
    const rects = h.weeks.map((col, c) => col.map((cell, r) => cell
      ? '<rect class="hm-c l' + cell.level + '" x="' + c * (CELL + GAP) + '" y="' + (TOP + r * (CELL + GAP)) + '" width="' + CELL + '" height="' + CELL + '" rx="2"></rect>'
      : '').join('')).join('');
    const months = h.months.filter((m, i, a) => !a[i + 1] || a[i + 1].col - m.col >= 3)
      .map((m) => '<text class="hm-m" x="' + m.col * (CELL + GAP) + '" y="11">' + esc(m.label) + '</text>').join('');
    const label = h.workouts + ' workouts on ' + h.activeDays + ' days in the last 12 months';
    const key = [0, 1, 2, 3, 4].map((l) => '<svg viewBox="0 0 10 10" aria-hidden="true"><rect class="hm-c l' + l + '" width="10" height="10" rx="2"></rect></svg>').join('');
    return '<div class="wc-card hm-card" id="hmCard"><div class="wc-card-h">🗓️ Activity</div>' +
      '<div class="wt-big">' + esc(h.activeDays) + ' <small>training days · ' + esc(h.workouts) + ' workouts · best week ' + esc(h.bestWeek) + ' sets</small></div>' +
      '<div class="hm-scroll"><svg class="hm-svg" width="' + W + '" height="' + Ht + '" viewBox="0 0 ' + W + ' ' + Ht + '" role="img" aria-label="' + esc(label) + '">' + months + rects + '</svg></div>' +
      '<div class="hm-key"><span>Less</span>' + key + '<span>More</span></div></div>';
  }

  window.NBDHeatmapUI = { cardHtml };
})();
