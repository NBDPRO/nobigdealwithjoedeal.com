/**
 * notebook-ui.js — the Daily Success notebook drawer (2026-10-25). Filing rules live in notebook-logic.js.
 *
 * Opened from the Notebook tab. A side sheet lists every page filed by month (native <details>, current month open), each row a
 * button that switches to that page, with its delete beside it. A filter box narrows the list. It is a dialog: focus moves in,
 * Escape and the backdrop close it, focus returns to the tab that opened it. Reads app.js's globals (pages, cur, tlbl, switchTo,
 * triggerDel, todayKey) — same page, loaded after app.js.
 */
(function () {
  'use strict';
  const N = window.NBDNotebook;
  if (!N || typeof document === 'undefined') return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let root = null, lastFocus = null, query = '';
  // app.js declares pages/cur with top-level let: global lexical scope, not window properties, so read them by name
  /* global pages, cur */
  const P = () => (typeof pages !== 'undefined' && Array.isArray(pages) ? pages : []);
  const C = () => (typeof cur !== 'undefined' ? cur : -1);

  function ensure() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'nbd-notebook';
    root.className = 'nbk';
    root.hidden = true;
    root.innerHTML =
      '<div class="nbk-bg" data-nbk="close"></div>' +
      '<div class="nbk-sheet" role="dialog" aria-modal="true" aria-labelledby="nbk-title">' +
        '<div class="nbk-head">' +
          '<h2 class="nbk-title" id="nbk-title">Notebook</h2>' +
          '<button type="button" class="nbk-x" data-nbk="close" aria-label="Close the notebook">×</button>' +
        '</div>' +
        '<div class="nbk-tools">' +
          '<input type="search" class="nbk-filter" id="nbk-filter" placeholder="Find a day, a name, a month…" aria-label="Filter pages">' +
          '<button type="button" class="nbk-new" data-nbk="new">+ Today</button>' +
        '</div>' +
        '<div class="nbk-list" id="nbk-list"></div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', (ev) => { if (ev.target && ev.target.id === 'nbk-filter') { query = ev.target.value; renderList(); } });
    root.addEventListener('keydown', onKey);
    return root;
  }

  const pageLike = (e) => ({ name: e.name, dk: e.dk, suf: e.suf });
  const label = (e) => (typeof window.tlbl === 'function' ? window.tlbl(pageLike(e)) : (e.name || e.dk));

  function row(e) {
    const kpi = (P()[e.idx] && P()[e.idx].kpi) || null;
    const meta = [e.weekday, e.dk, e.dayCount > 1 ? 'entry ' + e.nth + ' of ' + e.dayCount : ''].filter(Boolean).join(' · ');
    const stat = kpi && (kpi.doors || kpi.closes) ? ' · ' + (kpi.doors || 0) + ' doors, ' + (kpi.closes || 0) + ' closes' : '';
    const current = C() === e.idx;
    return '<li class="nbk-row' + (current ? ' is-current' : '') + (e.isToday ? ' is-today' : '') + '">' +
      '<button type="button" class="nbk-go" data-nbk="go" data-idx="' + e.idx + '"' + (current ? ' aria-current="page"' : '') + '>' +
        '<span class="nbk-lbl">' + esc(label(e)) + (e.isToday ? ' <span class="nbk-today">Today</span>' : '') + '</span>' +
        '<span class="nbk-meta">' + esc(meta + stat) + '</span>' +
      '</button>' +
      '<button type="button" class="nbk-del" data-nbk="del" data-idx="' + e.idx + '" aria-label="Delete page ' + esc(label(e)) + '">×</button>' +
    '</li>';
  }

  function renderList() {
    const list = document.getElementById('nbk-list');
    if (!list) return;
    const today = typeof window.todayKey === 'function' ? window.todayKey() : '';
    const sections = N.filterEntries(N.groupByMonth(P(), today), query, label);
    if (!sections.length) { list.innerHTML = '<p class="nbk-empty">' + (query.trim() ? 'Nothing matches “' + esc(query.trim()) + '”.' : 'No pages yet. Tap + Today to start one.') + '</p>'; return; }
    list.innerHTML = sections.map((s) =>
      '<details class="nbk-month"' + (s.open ? ' open' : '') + '>' +
        '<summary class="nbk-sum"><span>' + esc(s.label) + '</span><span class="nbk-count">' + s.count + (s.count === 1 ? ' page' : ' pages') + '</span></summary>' +
        '<ul class="nbk-rows">' + s.entries.map(row).join('') + '</ul>' +
      '</details>').join('');
  }

  function open(opener) {
    ensure();
    lastFocus = opener || document.activeElement;
    query = '';
    const f = document.getElementById('nbk-filter');
    if (f) f.value = '';
    renderList();
    root.hidden = false;
    document.body.classList.add('nbk-open');
    // the open page may be filed in a folded month: unfold it so its row can take focus
    const curRow = root.querySelector('.nbk-go[aria-current]');
    const det = curRow && curRow.closest('details');
    if (det) det.open = true;
    (curRow || f).focus();
  }

  function close() {
    if (!root || root.hidden) return;
    root.hidden = true;
    document.body.classList.remove('nbk-open');
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) lastFocus.focus();
    lastFocus = null;
  }

  function onClick(ev) {
    const el = ev.target.closest('[data-nbk]');
    if (!el) return;
    const act = el.dataset.nbk;
    if (act === 'close') close();
    else if (act === 'new') { close(); if (typeof window.smartNewPage === 'function') window.smartNewPage(); }
    else if (act === 'go') { const i = +el.dataset.idx; close(); if (typeof window.switchTo === 'function') window.switchTo(i); }
    else if (act === 'del') { const i = +el.dataset.idx; lastFocus = null; close(); if (typeof window.triggerDel === 'function') window.triggerDel(i); }
  }

  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key !== 'Tab') return;
    // keep Tab inside the sheet
    const focusable = [...root.querySelectorAll('button, input, summary, [tabindex]:not([tabindex="-1"])')].filter((n) => !n.hidden && n.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  // the Notebook tab in #tabrow (rendered by app.js) and the dashboard's "All pages" title both open it
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-action="notebook-open"]');
    if (el) open(el);
  });
  // Escape closes from anywhere while the drawer is open (focus can sit on the opener or the backdrop)
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && root && !root.hidden && !root.contains(ev.target)) { ev.preventDefault(); close(); } });
  // a page change while the drawer is open (cloud merge, delete) re-files the list
  window.addEventListener('nbd-pages-changed', () => { if (root && !root.hidden) renderList(); });

  window.NBDNotebookUI = { open, close, renderList };
})();
