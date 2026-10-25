/**
 * notebook-logic.js — the pure half of the Daily Success notebook (2026-10-25).
 *
 * Jo: the pages should file like a notebook, not stretch a horizontal tab strip forever. This module decides what the compact
 * tab row shows (Dash, Today, the open page, the Notebook button, +) and how the notebook files every page: by month, newest
 * first, with the current month open and older months folded. No DOM here: notebook-ui.js renders the drawer and app.js's
 * renderTabs() reads tabSet(); tests/daily-success-notebook-2026-10-25.test.js drives this.
 *
 * `pages` is app.js's array as stored (insertion order, `dk` = YYYY-MM-DD, `suf` = nth entry that day, optional `name`).
 * Every entry keeps `idx`, its index into that array, because switchTo(idx) and the delete flow are index-based.
 */
(function (root) {
  'use strict';

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const isDk = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

  function weekday(dk) {
    if (!isDk(dk)) return '';
    const [y, m, d] = dk.split('-').map(Number);
    return DAYS[new Date(y, m - 1, d).getDay()] || '';
  }

  function monthLabel(key) {
    const m = Number(key.slice(5, 7));
    return (MONTHS[m - 1] || key) + ' ' + key.slice(0, 4);
  }

  /** Newest first: later day, then later entry on the same day. A page with no usable date files last. */
  function newerFirst(a, b) {
    const ad = isDk(a.dk) ? a.dk : '', bd = isDk(b.dk) ? b.dk : '';
    if (ad !== bd) return ad < bd ? 1 : -1;
    return (Number(b.suf) || 1) - (Number(a.suf) || 1);
  }

  /**
   * Files the pages by month. Returns [{ key:'2026-10', label:'October 2026', open, count, entries:[{ idx, dk, suf, name, weekday, isToday }] }]
   * newest month first. The month holding `today` (or the newest month when there is no page for today) is open; the rest fold.
   */
  function groupByMonth(pages, today) {
    const byKey = new Map();
    (pages || []).forEach((p, idx) => {
      if (!p) return;
      const dk = isDk(p.dk) ? p.dk : '';
      const key = dk ? dk.slice(0, 7) : 'undated';
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ idx, dk, suf: Number(p.suf) || 1, name: p.name || '', weekday: weekday(dk), isToday: !!dk && dk === today });
    });
    const keys = [...byKey.keys()].sort((a, b) => (a === 'undated' ? 1 : b === 'undated' ? -1 : a < b ? 1 : -1));
    const openKey = typeof today === 'string' && byKey.has(today.slice(0, 7)) ? today.slice(0, 7) : keys[0];
    return keys.map((key) => {
      const entries = byKey.get(key).sort(newerFirst);
      return { key, label: key === 'undated' ? 'Undated' : monthLabel(key), open: key === openKey, count: entries.length, entries };
    });
  }

  /**
   * The compact tab row. At most five tabs whatever the page count:
   *   dash · today (the first page dated today, if one exists) · page (the open page, when it is not that Today page) · notebook · new
   * `cur` is app.js's index (-1 = dashboard). Each tab: { kind, idx?, active, count? }.
   */
  function tabSet(pages, cur, today) {
    const list = pages || [];
    const todayIdx = list.findIndex((p) => p && p.dk === today && (Number(p.suf) || 1) === 1);
    const tabs = [{ kind: 'dash', idx: -1, active: cur === -1 }];
    if (todayIdx >= 0) tabs.push({ kind: 'today', idx: todayIdx, active: cur === todayIdx });
    if (cur >= 0 && cur < list.length && cur !== todayIdx) tabs.push({ kind: 'page', idx: cur, active: true });
    tabs.push({ kind: 'notebook', count: list.length, active: false });
    tabs.push({ kind: 'new', active: false });
    return tabs;
  }

  /**
   * Narrows the filed sections to the entries matching `q` (name or label, date digits, weekday, month label). `labelOf(page-like)`
   * is app.js's tlbl so the filter sees the same label the row shows. A matched section comes back open. Empty query: untouched.
   */
  function filterEntries(sections, q, labelOf) {
    const needle = String(q || '').trim().toLowerCase();
    if (!needle) return sections;
    const lbl = typeof labelOf === 'function' ? labelOf : (e) => e.name || e.dk;
    return sections.map((s) => {
      const monthHit = s.label.toLowerCase().includes(needle);
      const entries = s.entries.filter((e) => monthHit || (String(lbl(e)) + ' ' + e.dk + ' ' + e.weekday + ' ' + e.name).toLowerCase().includes(needle));
      return entries.length ? Object.assign({}, s, { entries, count: entries.length, open: true }) : null;
    }).filter(Boolean);
  }

  const api = { groupByMonth, tabSet, filterEntries, weekday, monthLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.NBDNotebook = Object.assign(root.NBDNotebook || {}, api);
})(typeof window !== 'undefined' ? window : null);
