/**
 * receipt-review-ui.js — search, filter and a type-ahead job picker for the
 * Home Depot receipt import review (2026-10-19).
 *
 * hd-import.js hands this file the review state; this file draws the filter
 * bar, the receipt rows and the job picker, and writes the pick back onto the
 * row (`leadId` / `noJob`) exactly like the old <select> did. It never saves
 * anything: matching, aliases and the import itself stay in hd-import.js.
 *
 * Gated by the receiptSorterQueue flag (checked in hd-import.js). Filters are
 * remembered for the browser session only (sessionStorage), never written to
 * Firestore. Pure logic lives in receipt-filter-logic.js (unit-tested).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;
  const F = () => w.NBDReceiptFilter;
  const SS_KEY = 'nbd.receiptReview.v1';
  const POP_LIMIT = 50;

  // filters + the jobs picked most recently (newest first), session only
  const U = { filters: null, recent: [], pop: null, ctx: null, view: [] };

  function loadSession() {
    try {
      const raw = w.sessionStorage && w.sessionStorage.getItem(SS_KEY);
      const o = raw ? JSON.parse(raw) : null;
      if (o && typeof o === 'object') {
        U.filters = F().cleanFilters(o.filters);
        U.recent = Array.isArray(o.recent) ? o.recent.filter((x) => typeof x === 'string').slice(0, 12) : [];
      }
    } catch (e) { /* private window / blocked storage: just start fresh */ }
    if (!U.filters) U.filters = F().cleanFilters({});
  }
  function saveSession() {
    try { w.sessionStorage && w.sessionStorage.setItem(SS_KEY, JSON.stringify({ filters: U.filters, recent: U.recent })); } catch (e) { /* ignore */ }
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (m, k) => { if (typeof w.showToast === 'function') w.showToast(m, k || 'info'); };

  const ST_CLASS = { code: 'ok', alias: 'ok', suggested: 'warn', overhead: 'info', ambiguous: 'bad', none: 'bad' };

  function labelFor(id) {
    const l = U.ctx && U.ctx.byId[id];
    return l ? U.ctx.leadLabel(l) : '';
  }
  function computeView() {
    const rows = U.ctx.state.rows;
    const ctx = { labelFor };
    const idx = new Map(rows.map((r, i) => [r, i]));
    const vis = F().sortRows(F().filterRows(rows, U.filters, ctx), U.filters.sort, ctx);
    U.view = vis.map((r) => ({ r, i: idx.get(r) }));
    return vis;
  }

  // ── filter bar ───────────────────────────────────────────────────────
  function opt(v, label, cur) { return '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  const ASSIGN_OPTS = [['all', 'All receipts'], ['unassigned', 'No job yet'], ['assigned', 'Has a job'], ['selected', 'Selected to import'], ['unselected', 'Not selected'], ['imported', 'Already imported']];
  const SORT_OPTS = [['date-desc', 'Newest first'], ['date-asc', 'Oldest first'], ['amount-desc', 'Biggest total'], ['amount-asc', 'Smallest total'], ['job-asc', 'PO / job name A–Z'], ['store-asc', 'Store A–Z'], ['unassigned-first', 'No job first']];

  function barHtml(C) {
    const f = U.filters;
    const active = !F().isDefault(f);
    const open = active || (w.innerWidth || 0) >= 720;
    return '<div class="rv-bar" role="search">' +
      '<input class="rv-in rv-search" type="search" data-rv-f="q" value="' + esc(f.q) + '" placeholder="Search item, SKU, PO / job name, store, amount, job…" aria-label="Search receipts" autocomplete="off" enterkeyhint="search">' +
      '<details class="rv-more"' + (open ? ' open' : '') + '><summary class="rv-sum">Filters &amp; sort' + (active ? ' <span class="rv-dot" aria-label="filters on"></span>' : '') + '</summary>' +
      '<div class="rv-grid">' +
        '<label class="rv-fld"><span>Show</span><select class="rv-in" data-rv-f="assign">' + ASSIGN_OPTS.map((o) => opt(o[0], o[1], f.assign)).join('') + '</select></label>' +
        '<label class="rv-fld"><span>Store</span><select class="rv-in" data-rv-f="store"><option value="">All stores</option>' + F().storeOptions(C.state.rows).map((s) => opt(s.store, s.label, f.store)).join('') + '</select></label>' +
        '<label class="rv-fld"><span>From</span><input class="rv-in" type="date" data-rv-f="from" value="' + esc(f.from) + '"></label>' +
        '<label class="rv-fld"><span>To</span><input class="rv-in" type="date" data-rv-f="to" value="' + esc(f.to) + '"></label>' +
        '<label class="rv-fld"><span>Min $</span><input class="rv-in" type="text" inputmode="decimal" data-rv-f="min" value="' + esc(f.min) + '" placeholder="0"></label>' +
        '<label class="rv-fld"><span>Max $</span><input class="rv-in" type="text" inputmode="decimal" data-rv-f="max" value="' + esc(f.max) + '" placeholder="any"></label>' +
        '<label class="rv-fld rv-fld-wide"><span>Sort</span><select class="rv-in" data-rv-f="sort">' + SORT_OPTS.map((o) => opt(o[0], o[1], f.sort)).join('') + '</select></label>' +
      '</div></details>' +
      '<div class="rv-tools">' +
        '<button type="button" class="rv-btn" data-rv-act="clear">Clear filters</button>' +
        '<button type="button" class="rv-btn" data-rv-act="sel-visible">Select shown</button>' +
        '<button type="button" class="rv-btn" data-rv-act="desel-visible">Deselect shown</button>' +
        '<button type="button" class="rv-btn rv-btn-main" data-rv-act="bulk-open">Assign shown to a job…</button>' +
      '</div>' +
      '<div class="rv-stats" data-rv-stats role="status" aria-live="polite"></div></div>';
  }

  function statsHtml(vis) {
    const t = F().totals(U.ctx.state.rows, vis);
    const m = U.ctx.money;
    return '<b>' + t.visible + '</b> of ' + t.total + ' shown · ' + m(t.visibleCents) + ' shown' +
      ' · <b>' + t.selectedVisible + '</b> selected here (' + m(t.selectedVisibleCents) + ')' +
      (t.selectedAll !== t.selectedVisible ? ' · ' + t.selectedAll + ' selected in all (' + m(t.selectedAllCents) + ')' : '');
  }

  // ── rows ─────────────────────────────────────────────────────────────
  function rowHtml(r, i, C) {
    const bd = r.already ? { cls: 'done', label: 'Imported', why: 'already in your expenses' } : { cls: ST_CLASS[r.match.status] || 'bad', label: C.BADGE[r.match.status][0], why: r.match.reason };
    const lead = r.leadId ? C.byId[r.leadId] : null;
    const needs = !r.already && !r.leadId && !r.noJob && r.match.status !== 'overhead';
    const pickLabel = lead ? C.leadLabel(lead) : (needs ? 'Pick a job…' : 'No job (overhead / shop)');
    const items = r.items.length ? '<div class="rv-items">' + esc(r.items.map((x) => x.desc).join('; ')) + '</div>' : '';
    return '<tr class="rv-row' + (r.already ? ' is-done' : '') + '">' +
      '<td class="rv-c-inc" data-label="Import"><input class="rv-chk" type="checkbox" data-hd-inc="' + i + '"' + (r.include ? ' checked' : '') + (r.already ? ' disabled' : '') + ' aria-label="Import this receipt"></td>' +
      '<td class="rv-c-date" data-label="Date">' + esc(r.date) + '<div class="rv-sub">' + esc(r.storeName || ('#' + r.store)) + '</div></td>' +
      '<td class="rv-c-po" data-label="PO / Job name"><b>' + esc(r.jobName || '—') + '</b><div class="rv-why"><span class="rv-pill rv-st-' + bd.cls + '">' + esc(bd.label) + '</span> ' + esc(bd.why) + '</div>' + items + '</td>' +
      '<td class="rv-c-amt" data-label="Total">' + C.money(r.totalCents) + '<div class="rv-sub">tax ' + C.money(r.taxCents) + '</div></td>' +
      '<td class="rv-c-job" data-label="Job"><button type="button" class="rv-pickbtn' + (needs ? ' is-needs' : '') + '" data-rv-act="pick" data-rv-i="' + i + '" aria-haspopup="dialog"' + (r.already ? ' disabled' : '') + '><span class="rv-pick-txt">' + esc(pickLabel) + '</span><span aria-hidden="true">▾</span></button></td>' +
      '<td class="rv-c-cat" data-label="Category"><select class="rv-in" data-hd-cat="' + i + '"' + (r.already ? ' disabled' : '') + ' aria-label="Category">' + C.catOpts(r.category) + '</select></td></tr>';
  }
  function listHtml(vis) {
    const C = U.ctx;
    if (!vis.length) return '<div class="rv-empty">No receipts match these filters. <button type="button" class="rv-link" data-rv-act="clear">Clear filters</button></div>';
    return '<table class="rv-table"><thead><tr><th><span class="rv-vh">Import</span></th><th>Date</th><th>PO / Job name</th><th class="rv-r">Total</th><th>Job</th><th>Category</th></tr></thead><tbody>' +
      U.view.map((v) => rowHtml(v.r, v.i, C)).join('') + '</tbody></table>';
  }

  // The whole review body (goes inside hd-import's modal shell).
  function html(C) {
    if (!U.filters) loadSession();
    U.ctx = C; U.pop = null;
    const rows = C.state.rows;
    const vis = computeView();
    const done = rows.filter((r) => r.already).length;
    return '<div class="rv-root">' +
      '<div class="rv-note">' + rows.length + ' receipts · ' + done + ' already imported · green = matched by customer # or a name you assigned before · amber = suggested, check it · red = pick the job. Job names you assign are remembered for next time.</div>' +
      barHtml(C) +
      '<div class="rv-scroll" data-rv-scroll>' + listHtml(vis) + '</div>' +
      '<div class="rv-foot"><div data-hd-msg class="rv-foot-msg">' + rows.filter((r) => r.include && !r.already).length + ' to import · ' + C.money(F().totals(rows, rows).selectedAllCents) + '</div>' +
      '<button type="button" class="btn btn-orange rv-import" data-hd-action="import">Import selected</button></div>' +
      '<div data-rv-popwrap></div></div>';
  }
  function afterRender(scrollTop) {
    const s = document.querySelector('[data-rv-stats]');
    if (s) s.innerHTML = statsHtml(U.view.map((v) => v.r));
    const sc = document.querySelector('[data-rv-scroll]');
    if (sc && scrollTop) sc.scrollTop = scrollTop;
  }
  function mount(C) {
    const prev = document.querySelector('[data-rv-scroll]');
    const top = prev ? prev.scrollTop : 0;
    C.modalEl().innerHTML = C.shell(html(C));
    afterRender(top);
  }
  // typing in a filter redraws only the stats + list, so the field keeps focus
  function refreshList() {
    const vis = computeView();
    const sc = document.querySelector('[data-rv-scroll]');
    if (sc) sc.innerHTML = listHtml(vis);
    afterRender(0);
    saveSession();
  }

  // ── job picker (type-ahead) ──────────────────────────────────────────
  function popWrap() { return document.querySelector('[data-rv-popwrap]'); }
  function closePop(restore) {
    const p = U.pop; U.pop = null;
    const wrap = popWrap(); if (wrap) wrap.innerHTML = '';
    if (restore !== false && p && p.mode === 'row') {
      const b = document.querySelector('[data-rv-act="pick"][data-rv-i="' + p.i + '"]');
      if (b && b.focus) b.focus();
    }
  }
  function popResults() {
    const C = U.ctx, p = U.pop;
    const r = p.mode === 'row' ? C.state.rows[p.i] : null;
    const res = F().searchLeads(C.leads, p.q, { pinned: r ? (r.match.candidates || []) : [], recent: U.recent, limit: POP_LIMIT + 1 });
    const more = res.length > POP_LIMIT;
    return { res: res.slice(0, POP_LIMIT), more };
  }
  const GROUP_LABEL = { best: 'Best matches', recent: 'Recently used', all: 'All jobs' };
  function optionsHtml() {
    const C = U.ctx, p = U.pop;
    const { res, more } = popResults();
    const q = F().norm(p.q);
    let n = 0, out = '', last = '';
    const showNone = p.mode === 'row' && (!q || 'no job overhead shop none'.indexOf(q) !== -1);
    if (showNone) { out += '<li role="option" id="rvo-' + n + '" class="rv-opt rv-opt-none" data-rv-act="choose" data-rv-id="" aria-selected="false">— No job (overhead / shop) —</li>'; n++; }
    res.forEach((x) => {
      if (x.group !== last) { out += '<li role="presentation" class="rv-grp">' + GROUP_LABEL[x.group] + '</li>'; last = x.group; }
      const l = x.lead;
      const st = l.stage ? '<span class="rv-pill rv-st-info">' + esc(l.stage) + '</span>' : '';
      out += '<li role="option" id="rvo-' + n + '" class="rv-opt" data-rv-act="choose" data-rv-id="' + esc(l.id) + '" aria-selected="false"><span class="rv-opt-txt">' + esc(C.leadLabel(l)) + '</span>' + st + '</li>';
      n++;
    });
    if (!res.length) out += '<li role="presentation" class="rv-none">No jobs match "' + esc(p.q) + '". Try fewer words.</li>';
    if (more) out += '<li role="presentation" class="rv-none">Showing the first ' + POP_LIMIT + ' — keep typing to narrow it.</li>';
    return { html: out, count: n, total: res.length };
  }
  function renderOptions(resetActive) {
    const ul = document.getElementById('rvList'); if (!ul) return;
    const o = optionsHtml();
    ul.innerHTML = o.html;
    const opts = ul.querySelectorAll('[role="option"]');
    if (resetActive !== false) {
      // Enter on an untouched list picks the first real job, not "No job".
      U.pop.active = opts.length && opts[0].classList.contains('rv-opt-none') && opts.length > 1 ? 1 : 0;
    }
    setActive(U.pop.active);
    const cnt = document.getElementById('rvCount'); if (cnt) cnt.textContent = o.total + ' job' + (o.total === 1 ? '' : 's') + (o.more ? '+' : '');
  }
  function setActive(i) {
    const ul = document.getElementById('rvList'); if (!ul) return;
    const opts = ul.querySelectorAll('[role="option"]');
    if (!opts.length) return;
    const k = Math.max(0, Math.min(opts.length - 1, i));
    U.pop.active = k;
    opts.forEach((el, j) => { el.classList.toggle('is-active', j === k); el.setAttribute('aria-selected', j === k ? 'true' : 'false'); });
    const q = document.querySelector('[data-rv-q]');
    if (q) q.setAttribute('aria-activedescendant', opts[k].id);
    if (opts[k].scrollIntoView) opts[k].scrollIntoView({ block: 'nearest' });
  }
  function openPop(state) {
    U.pop = Object.assign({ q: '', active: 0 }, state);
    const C = U.ctx;
    const r = state.mode === 'row' ? C.state.rows[state.i] : null;
    const title = r ? '<div class="rv-pop-ctx">Receipt: <b>' + esc(r.jobName || '—') + '</b> · ' + esc(r.date) + ' · ' + C.money(r.totalCents) + '</div>'
      : '<div class="rv-pop-ctx">Assign <b>' + U.view.length + '</b> shown receipt' + (U.view.length === 1 ? '' : 's') + ' to one job</div>';
    popWrap().innerHTML = '<div class="rv-pop-bg" data-rv-act="pop-close"></div>' +
      '<div class="rv-pop" role="dialog" aria-modal="true" aria-label="Pick a job">' +
      '<div class="rv-pop-head"><input class="rv-in rv-q" type="search" role="combobox" aria-expanded="true" aria-controls="rvList" aria-autocomplete="list" data-rv-q placeholder="Type a name, address, NBD-#, or stage…" autocomplete="off" autocapitalize="off" enterkeyhint="go" aria-label="Search jobs">' +
      '<button type="button" class="rv-x" data-rv-act="pop-close" aria-label="Close">✕</button></div>' + title +
      '<div class="rv-pop-count" id="rvCount" aria-live="polite"></div>' +
      '<ul class="rv-opts" id="rvList" role="listbox" aria-label="Jobs"></ul></div>';
    renderOptions(true);
    const q = document.querySelector('[data-rv-q]'); if (q) q.focus();
  }

  function applyPick(id) {
    const p = U.pop; if (!p) return;
    const C = U.ctx;
    if (p.mode === 'bulk') {
      if (!id) return;
      showBulkConfirm(id);
      return;
    }
    const r = C.state.rows[p.i];
    if (r && !r.already) {
      r.leadId = id || null; r.noJob = !id;
      if (id) { U.recent = [id].concat(U.recent.filter((x) => x !== id)).slice(0, 12); saveSession(); }
    }
    const i = p.i;
    closePop(false);
    C.rerender();
    const b = document.querySelector('[data-rv-act="pick"][data-rv-i="' + i + '"]'); if (b && b.focus) b.focus();
  }

  // bulk: pick a job, then an explicit confirm that says what will change
  function showBulkConfirm(id) {
    const C = U.ctx, lead = C.byId[id]; if (!lead) return;
    const t = F().bulkTargets(U.view.map((v) => v.r), id);
    const cents = t.apply.reduce((a, r) => a + (r.totalCents || 0), 0);
    const imp = t.skipped.filter((s) => s.why === 'imported').length, mat = t.skipped.filter((s) => s.why === 'matched').length;
    U.pop.confirm = id;
    const pop = document.querySelector('.rv-pop');
    pop.innerHTML = '<div class="rv-conf"><h4 class="rv-conf-h">Assign ' + t.apply.length + ' receipt' + (t.apply.length === 1 ? '' : 's') + '?</h4>' +
      '<p class="rv-conf-p">' + C.money(cents) + ' will be assigned to <b>' + esc(C.leadLabel(lead)) + '</b>. Nothing is saved until you press Import.</p>' +
      (imp || mat ? '<p class="rv-conf-p rv-sub">Left alone: ' + [imp ? imp + ' already imported' : '', mat ? mat + ' matched to another job by customer # or a remembered name' : ''].filter(Boolean).join(' · ') + '.</p>' : '') +
      '<div class="rv-conf-act"><button type="button" class="rv-btn" data-rv-act="bulk-back">Back</button>' +
      '<button type="button" class="rv-btn rv-btn-main" data-rv-act="bulk-confirm"' + (t.apply.length ? '' : ' disabled') + '>Assign ' + t.apply.length + '</button></div></div>';
    const b = pop.querySelector('[data-rv-act="bulk-confirm"]'); if (b && !b.disabled) b.focus();
  }
  function doBulk() {
    const p = U.pop; if (!p || !p.confirm) return;
    const id = p.confirm;
    const t = F().bulkTargets(U.view.map((v) => v.r), id);
    t.apply.forEach((r) => { r.leadId = id; r.noJob = false; });
    U.recent = [id].concat(U.recent.filter((x) => x !== id)).slice(0, 12); saveSession();
    closePop(false);
    toast('Assigned ' + t.apply.length + ' receipt' + (t.apply.length === 1 ? '' : 's') + '. Review, then press Import.', 'ok');
    U.ctx.rerender();
  }

  function setVisibleSelected(on) {
    U.view.forEach((v) => { if (!v.r.already) v.r.include = on; });
    U.ctx.rerender();
  }

  // ── events (delegated, once) ─────────────────────────────────────────
  if (!w._NBD_RV_DELEGATE) {
    w._NBD_RV_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      if (!U.ctx || !ev.target || !ev.target.closest) return;
      const t = ev.target.closest('[data-rv-act]');
      if (!t || t.disabled) return;
      const a = t.dataset.rvAct;
      if (a === 'pick') openPop({ mode: 'row', i: +t.dataset.rvI });
      else if (a === 'bulk-open') { if (U.view.length) openPop({ mode: 'bulk' }); else toast('No receipts shown to assign', 'info'); }
      else if (a === 'pop-close') closePop();
      else if (a === 'choose') applyPick(t.dataset.rvId || '');
      else if (a === 'bulk-back') { const p = U.pop; closePop(false); openPop({ mode: 'bulk', q: p ? p.q : '' }); }
      else if (a === 'bulk-confirm') doBulk();
      else if (a === 'clear') { U.filters = F().cleanFilters({}); saveSession(); U.ctx.rerender(); }
      else if (a === 'sel-visible') setVisibleSelected(true);
      else if (a === 'desel-visible') setVisibleSelected(false);
    });
    const onFilter = (ev) => {
      const el = ev.target;
      if (!U.ctx || !el || !el.dataset || el.dataset.rvF == null) return;
      U.filters[el.dataset.rvF] = el.value;
      U.filters = F().cleanFilters(U.filters);
      refreshList();
    };
    document.addEventListener('input', (ev) => {
      const el = ev.target;
      if (!U.ctx || !el || !el.dataset) return;
      if (el.dataset.rvQ != null && U.pop) { U.pop.q = el.value; renderOptions(true); return; }
      if (el.dataset.rvF === 'q' || el.dataset.rvF === 'min' || el.dataset.rvF === 'max') onFilter(ev);
    });
    document.addEventListener('change', (ev) => {
      const el = ev.target;
      if (el && el.dataset && el.dataset.rvF != null && el.dataset.rvF !== 'q' && el.dataset.rvF !== 'min' && el.dataset.rvF !== 'max') onFilter(ev);
    });
    document.addEventListener('keydown', (ev) => {
      if (!U.ctx || !U.pop) return;
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); if (U.pop.confirm) { const p = U.pop; closePop(false); openPop({ mode: 'bulk', q: p.q }); } else closePop(); return; }
      if (U.pop.confirm) return;
      const inList = ev.target && ev.target.dataset && ev.target.dataset.rvQ != null;
      if (!inList) return;
      if (ev.key === 'ArrowDown') { ev.preventDefault(); setActive(U.pop.active + 1); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); setActive(U.pop.active - 1); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        const opts = document.querySelectorAll('#rvList [role="option"]');
        const el = opts[U.pop.active];
        if (el) applyPick(el.dataset.rvId || '');
      }
    }, true);
  }

  w.NBDReceiptReviewUI = { mount };
})();
