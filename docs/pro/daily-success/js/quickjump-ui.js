/**
 * quickjump-ui.js - "jump anywhere" (flow batch 3, D4 / audit M6 + M7, and the ?go= links of D1).
 *
 *   - A Go button in the thumb zone (bottom right) and the header search icon open ONE sheet: Next up, Quick add, Go to (the registry in
 *     quickjump-logic.js), and, as you type, Days (date words like "yesterday", "nov 7", "fri") and Notes (text hits, newest day first, each
 *     with its field label; choosing one lands on the field, flashed). Ctrl/Cmd+K opens it; Ctrl/Cmd+F is the browser's again.
 *   - A chip row under the Today bar (Floors, Food, Train, Body, Wins, Wrap-up, Habits) jumps to a section and marks the one on screen.
 *   - ?go=today|floors|food|workout|wrap|review|money|dash (or #go=...) runs once at load, then the link is taken out of the address bar.
 *     The NBD OS widget and Coach link here. An unknown target does nothing.
 * The sheet is a dialog with a combobox/listbox (arrow keys + Enter) and pushes a history entry, so the back swipe closes it. Classic script,
 * loaded last; delegated listeners; every dynamic string is escaped.
 */
(function () {
  'use strict';
  if (window.NBDQuickJumpUI) return;
  /* global pages, cur */
  const Q = () => window.NBDQuickJump;
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const readJson = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (_) { return d; } };
  const today = () => (typeof window.todayKey === 'function' ? window.todayKey() : '');
  const allPages = () => { try { return Array.isArray(pages) ? pages : []; } catch (_) { return []; } };
  const curIdx = () => { try { return cur; } catch (_) { return -1; } };

  // Jo's decision 4: both the Go button and the header search icon open the sheet. Set false for "the header icon only"
  // (the button goes); to get "the button only", remove the data-action="qj-open" icon button from the .topbar in index.html.
  const GO_BUTTON = true;

  // Captured at once, before nav-router rewrites the hash on load.
  const GO0 = (function () { try { return Q() ? Q().parseGo(location.search, location.hash) : ''; } catch (_) { return ''; } })();

  // ── opening places ────────────────────────────────────────────────────────────────────────
  const NU = () => window.NBDNextUp;
  function ensureToday() { return NU() && NU().ensureToday ? NU().ensureToday() : false; }
  const scrollTo = (el) => { if (el && typeof window.scrollToEl === 'function') window.scrollToEl(el); };
  function openCard(sel) { const c = document.querySelector(sel); if (c && typeof window.openSection === 'function') window.openSection(c); return c; }

  function openDest(id) {
    switch (id) {
      case 'today': ensureToday(); return;
      case 'floors': ensureToday(); scrollTo(document.getElementById('day-score-wrap')); return;
      case 'food': ensureToday(); if (typeof window.tbGo === 'function') window.tbGo('cal'); return;
      case 'workout': ensureToday(); if (window.NBDCoachUI && window.NBDCoachUI.open) window.NBDCoachUI.open(); return;
      case 'weigh': ensureToday(); { openCard('.pc[data-sec="pr"]'); const i = document.querySelector('[data-k="bm-wt"]'); if (i) { scrollTo(i); i.focus({ preventScroll: true }); } } return;
      case 'wrap': {
        ensureToday();
        const b = document.querySelector('.eod-card [data-eod-action="edit"]'); if (b) b.click();
        const c = document.querySelector('.eod-card'); scrollTo(c);
        const i = document.getElementById('eodWin'); if (i) i.focus({ preventScroll: true });
        return;
      }
      case 'review': if (window.NBDReviewUI && window.NBDReviewUI.open) window.NBDReviewUI.open(); return;
      case 'money': if (window.NBDMoneyUI && window.NBDMoneyUI.open) window.NBDMoneyUI.open(); return;
      case 'measure': if (curIdx() !== -1) window.switchTo(-1); setTimeout(() => scrollTo(document.getElementById('msCard') || document.getElementById('phCard')), 120); return;
      case 'notebook': if (window.NBDNotebookUI && window.NBDNotebookUI.open) window.NBDNotebookUI.open(); return;
      case 'data': if (window.NBDExportUI && window.NBDExportUI.open) window.NBDExportUI.open(); return;
      case 'appearance': if (typeof window.nbdPickerOpen === 'function') window.nbdPickerOpen(); return;
      case 'customize': if (typeof window.openOnboard === 'function') window.openOnboard(); return;
      case 'dash': if (curIdx() !== -1) window.switchTo(-1); return;
      case 'crm': location.href = '/pro/dashboard.html'; return;
      default:
    }
  }

  // ── the sheet ─────────────────────────────────────────────────────────────────────────────
  let root = null, lastFocus = null, showAll = false, activeIdx = -1;
  function ensure() {
    if (root) return root;
    root = document.createElement('div');
    root.id = 'qjSheet'; root.className = 'qj'; root.hidden = true;
    root.innerHTML =
      '<div class="qj-bg" data-qj-close="1"></div>' +
      '<div class="qj-sheet" role="dialog" aria-modal="true" aria-label="Jump anywhere">' +
        '<div class="qj-head">' +
          '<input id="qjInput" class="qj-input" type="search" role="combobox" aria-expanded="true" aria-controls="qjList" aria-autocomplete="list" autocomplete="off" placeholder="Go to, add, or search your notes" aria-label="Go to, add, or search your notes">' +
          '<button type="button" class="qj-x" data-qj-close="1" aria-label="Close">×</button>' +
        '</div>' +
        '<div class="qj-body" id="qjList" role="listbox" aria-label="Results"></div>' +
      '</div>';
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('input', (ev) => { if (ev.target && ev.target.id === 'qjInput') { showAll = false; render(); } });
    root.addEventListener('keydown', onKey);
    return root;
  }
  const rows = () => [...root.querySelectorAll('.qj-row, .qj-chip2')];

  function row(attrs, label, tag, sub) {
    return '<button type="button" class="qj-row" role="option" tabindex="-1" ' + attrs + '><span class="qj-lbl">' + label + (sub ? '<small>' + sub + '</small>' : '') + '</span>' + (tag ? '<span class="qj-tag">' + esc(tag) + '</span>' : '') + '</button>';
  }
  function dayLabel(dk) { return NU() && NU().dayLabel ? NU().dayLabel(dk) : dk; }

  function render() {
    const input = document.getElementById('qjInput'), list = document.getElementById('qjList');
    if (!list || !Q()) return;
    const q = String(input.value || '').trim();
    const tk = today(), P = allPages();
    let html = '';
    if (!q) {
      const nx = NU() && NU().current ? NU().current() : null;
      html += '<div data-qj-sec="next"><div class="qj-h">Next up</div>' + (nx ? row('data-nextup="' + esc(nx.kind) + '"' + (nx.floorId != null ? ' data-floor-id="' + esc(nx.floorId) + '"' : ''), '<b>' + esc(nx.title) + '</b>', nx.button, nx.left + ' left') : '<div class="qj-empty">Nothing left for now.</div>') + '</div>';
      const favs = (readJson('nbd_ds_food', {}).favorites || []).slice(0, 3);
      html += '<div data-qj-sec="quick"><div class="qj-h">Quick add</div><div class="qj-quick">' +
        favs.map((f, i) => '<button type="button" class="qj-chip2" data-qj-fav="' + i + '">＋ ' + esc(f.name) + '</button>').join('') +
        '<button type="button" class="qj-chip2" data-qj="workout">Start workout</button>' +
        '<button type="button" class="qj-chip2" data-qj="floors">Tick a floor</button>' +
        '<button type="button" class="qj-chip2" data-qj="weigh">Weigh-in</button>' +
        '<button type="button" class="qj-chip2" data-qj="wrap">Wrap up</button></div></div>';
    }
    const dests = Q().filterDests(q);
    if (dests.length) html += '<div data-qj-sec="goto"><div class="qj-h">Go to</div>' + dests.map((d) => row('data-qj="' + esc(d.id) + '"', esc(d.label))).join('') + '</div>';
    if (q) {
      // Days: a date word, or a month / weekday / name matching a filed page
      const dk = Q().dateWord(q, tk);
      let days = [];
      if (dk) days = P.map((p, i) => ({ p, i })).filter((x) => x.p.dk === dk);
      else if (window.NBDNotebook && q.length >= 3) {
        const secs = window.NBDNotebook.filterEntries(window.NBDNotebook.groupByMonth(P, tk), q, (e) => (typeof window.tlbl === 'function' ? window.tlbl({ name: e.name, dk: e.dk, suf: e.suf }) : e.dk));
        secs.forEach((s) => s.entries.forEach((e) => { if (days.length < 6) days.push({ p: P[e.idx], i: e.idx }); }));
      }
      if (days.length) html += '<div data-qj-sec="days"><div class="qj-h">Days</div>' + days.map((x) => row('data-qj-day="' + esc(x.p.dk) + '" data-qj-idx="' + x.i + '"', esc(typeof window.tlbl === 'function' ? window.tlbl(x.p) : x.p.dk), x.p.dk === tk ? 'Today' : '', esc(dayLabel(x.p.dk)))).join('') + '</div>';
      else if (dk) html += '<div data-qj-sec="days"><div class="qj-h">Days</div><div class="qj-empty">No page for ' + esc(dayLabel(dk)) + '.</div></div>';
      const r = Q().searchNotes(P, q, { cap: showAll ? 200 : 20, label: (p) => (typeof window.tlbl === 'function' ? window.tlbl(p) : p.dk) });
      if (r.hits.length) {
        html += '<div data-qj-sec="notes"><div class="qj-h">Notes (' + r.total + ')</div>' + r.hits.map((h) =>
          row('data-qj-hit="' + esc(h.key) + '" data-qj-idx="' + h.pi + '" data-qj-dk="' + esc(h.dk) + '"', '<b>' + esc(h.label) + ':</b> ' + esc(h.text), '', esc(dayLabel(h.dk))).replace('<small>', '<small class="qj-note-day">')).join('') +
          (r.total > r.hits.length ? '<button type="button" class="qj-chip2 qj-more" data-qj="more">Show all ' + r.total + '</button>' : '') + '</div>';
      }
      if (!dests.length && !r.hits.length && !html.includes('data-qj-sec="days"')) html = '<div class="qj-empty">Nothing matches “' + esc(q) + '”.</div>';
    }
    list.innerHTML = html;
    rows().forEach((n, i) => { n.id = 'qjo' + i; });
    activeIdx = -1;
    input.removeAttribute('aria-activedescendant');
  }
  function setActive(i) {
    const rs = rows(); if (!rs.length) return;
    activeIdx = (i + rs.length) % rs.length;
    rs.forEach((n, k) => n.classList.toggle('cur', k === activeIdx));
    const a = rs[activeIdx];
    document.getElementById('qjInput').setAttribute('aria-activedescendant', a.id);
    a.scrollIntoView({ block: 'nearest' });
  }

  function open(opener) {
    ensure();
    if (!root.hidden) return;
    lastFocus = opener || document.activeElement;
    showAll = false;
    document.getElementById('qjInput').value = '';
    render();
    root.hidden = false;
    document.getElementById('qjInput').focus();
    if (window.NBDNav) window.NBDNav.opened('jump', () => hide());
  }
  function hide() {
    if (!root || root.hidden) return;
    root.hidden = true;
    if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) { try { lastFocus.focus({ preventScroll: true }); } catch (_) { /* optional */ } }
    lastFocus = null;
  }
  function close() {
    if (!root || root.hidden) return;
    hide();
    if (window.NBDNav) window.NBDNav.closed('jump');
  }

  function activate(el) {
    if (!el) return;
    const d = el.dataset;
    if (d.qjClose) { close(); return; }
    if (d.qj === 'more') { showAll = true; render(); return; }
    if (d.qjHit != null) {
      const idx = +d.qjIdx, key = d.qjHit; close();
      if (idx >= 0 && idx < allPages().length) { window.switchTo(idx); setTimeout(() => { if (typeof window.jumpToField === 'function') window.jumpToField(key); }, 30); }
      return;
    }
    if (d.qjDay != null) { const idx = +d.qjIdx; close(); if (idx >= 0) window.switchTo(idx); return; }
    if (d.qjFav != null) {
      close(); ensureToday();
      setTimeout(() => { const b = document.querySelector('[data-fl-action="add"][data-i="' + (+d.qjFav) + '"]'); if (b) b.click(); }, 80);
      return;
    }
    if (d.nextup) { close(); setTimeout(() => { if (NU()) NU().go(d.nextup, d.floorId); }, 60); return; }
    if (d.qj) { const id = d.qj; close(); setTimeout(() => openDest(id), 60); }
  }
  function onClick(ev) {
    const el = ev.target.closest('[data-qj-close], [data-qj], [data-qj-hit], [data-qj-day], [data-qj-fav], [data-nextup]');
    if (el) { ev.stopPropagation(); activate(el); }
  }
  function onKey(ev) {
    if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(activeIdx + 1); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(activeIdx - 1); return; }
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'qjInput') {
      ev.preventDefault();
      const rs = rows(); const pick = rs[activeIdx >= 0 ? activeIdx : 0];
      if (pick) activate(pick);
      return;
    }
    if (ev.key !== 'Tab') return;
    const f = [...root.querySelectorAll('button, input')].filter((n) => !n.hidden && n.offsetParent !== null && n.tabIndex !== -1);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target && ev.target.closest ? ev.target.closest('[data-action="qj-open"]') : null;
    if (el) open(el);
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && String(ev.key).toLowerCase() === 'k') { ev.preventDefault(); if (root && !root.hidden) close(); else open(); return; }
    if (ev.key === 'Escape' && root && !root.hidden && !root.contains(ev.target)) { ev.preventDefault(); close(); }
  });

  // ── the Go button ────────────────────────────────────────────────────────────────────────
  function mountGo() {
    if (document.querySelector('.qj-go')) return;
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'qj-go'; b.dataset.action = 'qj-open';
    b.setAttribute('aria-label', 'Jump anywhere: go to, add, or search'); b.textContent = 'Go';
    document.body.appendChild(b);
  }

  // ── the chip row under the Today bar ─────────────────────────────────────────────────────
  function chipsEl() {
    let c = document.querySelector('.qj-chips');
    if (!c) {
      c = document.createElement('div'); c.className = 'qj-chips'; c.setAttribute('role', 'navigation'); c.setAttribute('aria-label', 'Sections of the day');
      c.innerHTML = Q().CHIPS.map((x) => '<button type="button" class="qj-chip" data-qj-chip="' + esc(x.id) + '">' + esc(x.label) + '</button>').join('');
    }
    return c;
  }
  function placeChips() {
    const bar = document.getElementById('today-bar');
    let c = document.querySelector('.qj-chips');
    if (!bar || curIdx() < 0 || !Q()) { if (c) c.remove(); return; }
    c = chipsEl();
    const anchor = document.getElementById('nextup') || bar;
    if (anchor.nextElementSibling !== c) anchor.after(c);
  }
  function chipTarget(id) { const x = Q().CHIPS.find((c) => c.id === id); return x ? document.querySelector(x.sel) : null; }
  function markCurrent(id) {
    document.querySelectorAll('.qj-chip').forEach((b) => { const on = b.dataset.qjChip === id; b.classList.toggle('on', on); if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  }
  function spy() {
    if (!document.querySelector('.qj-chips')) return;
    const line = window.innerHeight * 0.45;
    let best = null;
    Q().CHIPS.forEach((x) => { const n = document.querySelector(x.sel); if (!n) return; const r = n.getBoundingClientRect(); if (r.height > 0 && r.top <= line && r.bottom > 80) best = x.id; });
    markCurrent(best);
  }
  let spyQueued = false;
  window.addEventListener('scroll', () => { if (spyQueued) return; spyQueued = true; requestAnimationFrame(() => { spyQueued = false; try { spy(); } catch (_) { /* optional */ } }); }, { passive: true });

  document.addEventListener('click', (ev) => {
    const b = ev.target && ev.target.closest ? ev.target.closest('[data-qj-chip]') : null;
    if (!b) return;
    const id = b.dataset.qjChip, n = chipTarget(id);
    if (!n) return;
    if (n.classList.contains('pc') && typeof window.openSection === 'function') window.openSection(n);
    scrollTo(n);
    markCurrent(id);
  });

  // ── ?go= links ──────────────────────────────────────────────────────────────────────────
  function runGo() {
    if (!GO0) return;
    try { const u = new URL(location.href); u.searchParams.delete('go'); if (/go=/.test(u.hash)) u.hash = ''; history.replaceState(history.state, '', u.pathname + (u.search || '') + (u.hash || '')); } catch (_) { /* the link just stays */ }
    setTimeout(() => { try { openDest(GO0); } catch (_) { /* a missing module leaves the Dashboard */ } }, 0);
  }
  if (document.readyState === 'complete') runGo(); else window.addEventListener('load', runGo);

  function wrap(name, after) {
    const orig = window[name];
    if (typeof orig !== 'function' || orig['__qj_' + name]) return;
    const w = function () { const r = orig.apply(this, arguments); try { after(); } catch (_) { /* the page renders without it */ } return r; };
    Object.keys(orig).forEach((k) => { w[k] = orig[k]; });
    w['__qj_' + name] = true;
    window[name] = w;
  }
  function boot() {
    if (GO_BUTTON) mountGo();
    wrap('renderPage', () => { placeChips(); spy(); });
    wrap('renderDash', () => { const c = document.querySelector('.qj-chips'); if (c) c.remove(); });
    try { placeChips(); } catch (_) { /* optional */ }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.NBDQuickJumpUI = { open, close, openDest, placeChips, render };
})();
