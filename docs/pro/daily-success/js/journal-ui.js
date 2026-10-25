/**
 * journal-ui.js — the Journal layout (data-ui="journal"): the Today bar as a calm paper page (2026-10-25).
 *
 * Today as a page: the date written out, an intention line, a short status line (floors, workout), and a note. The intention
 * and the note are page fields (data-k, like every other field on the day page), so collectPage() saves them with the page
 * and they sync with it; typing marks the page dirty through the existing mark-dirty input action. app.js re-renders the bar
 * on every floor toggle, so it reads the live values back first (never wipes what was typed). Markup only, no inline style.
 */
(function (root) {
  'use strict';
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MAX_INTENTION = 120, MAX_NOTE = 2000;

  /** 'YYYY-MM-DD' -> 'Saturday, October 25, 2026' (local date, no timezone shift). */
  function dateLong(dk) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dk || ''));
    if (!m) return '';
    return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }
  /** The one status line under the date. */
  function statusLine(o) {
    const parts = [];
    if (o && o.floorsTotal > 0) parts.push(o.floorsMet === o.floorsTotal ? 'every floor met' : o.floorsMet + ' of ' + o.floorsTotal + ' floors');
    parts.push(o && o.workout ? 'trained' : 'no workout yet');
    return parts.join(' · ');
  }

  /** o = { dk, isToday, intention, note, floorsMet, floorsTotal, workout } */
  function html(o) {
    const opt = o || {};
    return '<div class="jn-page">' +
      '<div class="jn-date">' + esc(dateLong(opt.dk) || 'Today') + (opt.isToday ? '<span class="jn-today">today</span>' : '') + '</div>' +
      '<label class="jn-field"><span class="jn-l">Intention</span><input class="jn-in" data-k="journal-intention" data-input-action="mark-dirty" maxlength="' + MAX_INTENTION + '" placeholder="One line. What would make today a good day?" value="' + esc(opt.intention) + '"></label>' +
      '<div class="jn-status' + (opt.workout ? ' trained' : '') + '">' + esc(statusLine(opt)) + (opt.workout ? '' : ' <button type="button" class="jn-link" data-journal="workout">open the coach</button>') + '</div>' +
      '<label class="jn-field"><span class="jn-l">Note</span><textarea class="jn-note" data-k="journal-note" data-input-action="mark-dirty" maxlength="' + MAX_NOTE + '" rows="4" placeholder="How did it go? What did you notice?">' + esc(opt.note) + '</textarea></label>' +
      '</div>';
  }

  const api = { MAX_INTENTION, MAX_NOTE, dateLong, statusLine, html };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.NBDJournalUI = api;
    if (typeof document !== 'undefined') document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-journal="workout"]');
      if (!el) return;
      if (root.NBDCoachUI && typeof root.NBDCoachUI.open === 'function') root.NBDCoachUI.open();
      else { const c = document.querySelector('.wc-card'); if (c) c.scrollIntoView({ block: 'center' }); }
    });
  }
})(typeof window !== 'undefined' ? window : null);
