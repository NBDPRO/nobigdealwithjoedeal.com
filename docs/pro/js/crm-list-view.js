/**
 * crm-list-view.js — Lean triage list for the pipeline (2026-07-06).
 *
 * Jo's call (option: "lean triage list"): a Board/List toggle on the
 * pipeline, where List is a deliberately LEAN sortable table — the
 * kanban answers "what stage is everything in"; the list answers
 * "what's my biggest deal" and "what haven't I touched longest".
 * Modeled on the Prospects page's kanban/list toggle (prospects.js),
 * the in-product precedent for this exact pattern.
 *
 * Scope contract (v1, deliberate exclusions — see PR discussion):
 *   - NO bulk mode, photo thumbnails, engagement badges, or drag —
 *     those stay kanban-only so the list never becomes a second
 *     feature-parity surface to maintain.
 *   - Stage changes go through the SAME window.moveCard the kanban
 *     drop handler uses, so stage history, gating prompts, and the
 *     lost-reason flow all still fire.
 *   - The list renders the SAME `list` renderLeads narrowed (search,
 *     type filter, job-type view, prospects/snoozed toggles, rep
 *     scoping) — zero filter logic of its own. crm-pipeline.js calls
 *     CrmListView.render(list) at the column-build point when the
 *     mode is active.
 *
 * Mode persists per device in localStorage ('nbd-crm-view-mode');
 * body.crm-list-mode gates visibility CSS-side (kanban stays rendered
 * underneath so toggling back is instant and every renderLeads side
 * effect — stats, counts, badges — keeps running unchanged).
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['crm-list-view']) return;
  __NBD_LOADED['crm-list-view'] = true;

  const LS_KEY = 'nbd-crm-view-mode'; // 'board' (default) | 'list'
  let _sortKey = 'activity';          // name | stage | value | age | activity
  let _sortDir = 1;                   // 1 asc, -1 desc
  let _lastList = [];                 // cache for header-click re-sorts

  // No saved choice → List on a phone, Board elsewhere. The board shows
  // one-and-a-half columns at 412px and has to be scrolled sideways, so it
  // was the wrong default for a rep on a job site (2026-09-24 phone pass).
  // An explicit Board/List click is saved and always wins.
  function _isPhone() {
    try { return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches); } catch (_) { return false; }
  }
  function isActive() {
    try {
      const v = localStorage.getItem(LS_KEY);
      if (v === 'list') return true;
      if (v === 'board') return false;
      return _isPhone();
    } catch (_) { return false; }
  }

  function _applyMode() {
    const active = isActive();
    document.body.classList.toggle('crm-list-mode', active);
    const b = document.getElementById('crmViewBoardBtn');
    const l = document.getElementById('crmViewListBtn');
    if (b) b.classList.toggle('active', !active);
    if (l) l.classList.toggle('active', active);
    // Settings > Pipeline Preferences > Default Pipeline View: light the
    // saved choice, or Auto when nothing is saved.
    let saved = null;
    try { saved = localStorage.getItem(LS_KEY); } catch (_) {}
    const pref = saved === 'list' || saved === 'board' ? saved : 'auto';
    // Same inline active styling as the Card Density picker beside it
    // (dashboard-ui.js setKanbanDensity).
    document.querySelectorAll('.cview-default-btn').forEach((btn) => {
      const on = btn.getAttribute('data-view-default') === pref;
      btn.style.background = on ? 'var(--orange)' : 'var(--s)';
      btn.style.color = on ? 'var(--accent-fg,#fff)' : 'var(--m)';
      btn.style.borderColor = on ? 'var(--orange)' : 'var(--br)';
    });
  }

  function _setMode(mode) {
    try {
      // null = Auto: forget the saved choice so the device decides
      // (List on a phone, Board elsewhere).
      if (mode == null) localStorage.removeItem(LS_KEY);
      else localStorage.setItem(LS_KEY, mode);
    } catch (_) {}
    _applyMode();
    // Re-render so the newly-visible surface is fresh. renderLeads
    // re-runs the whole narrowing pipeline and calls back into
    // render() below when list mode is on.
    if (typeof window.renderLeads === 'function') {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
    }
  }

  // data-action="call" entry points (allowlisted in dashboard-state.js)
  window.crmViewBoard = function () { _setMode('board'); };
  window.crmViewList  = function () { _setMode('list'); };
  window.crmViewAuto  = function () { _setMode(null); };

  // ── Row data helpers ─────────────────────────────────────
  function _toDate(v) {
    if (!v) return null;
    if (v.toDate) { try { return v.toDate(); } catch (_) { return null; } }
    if (v instanceof Date) return v;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function _created(l)  { return _toDate(l.createdAt); }
  function _activity(l) { return _toDate(l.updatedAt) || _toDate(l.createdAt); }
  function _ageDays(d)  { return d ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000)) : null; }
  function _name(l) {
    const n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
    return n || l.name || '(no name)';
  }
  function _stageKeyOf(l) {
    const norm = window.normalizeStage;
    return l._stageKey || (norm ? norm(l.stage) : (l.stage || 'new'));
  }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // One lead's stage list: its own job-type track in pipeline order, the
  // same list the board's ⋮ "Move to stage…" submenu and the job-detail
  // stage chip offer (window.stageOptionsForType — tenant-aware, hidden
  // stages dropped). It used to be the CURRENT VIEW's columns
  // (window._stageKeys), and a view only holds the pre-contract columns:
  // the Ins tab has no Installing or Closed. A select with no option for
  // the lead's stage silently shows its first option, so on the phone
  // list (default view: Ins) a $41,200 job being installed and two
  // finished jobs all read "New Lead", and swiping one said "Already at
  // the last stage" (2026-09-25 phone audit). View columns stay the
  // fallback when the stage module hasn't loaded.
  function _trackStages(l, viewKeys, labelFor) {
    let opts = null;
    if (typeof window.stageOptionsForType === 'function') {
      const jt = l.jobType
        || (typeof window.inferJobType === 'function' ? window.inferJobType(l) : null)
        || 'insurance';
      try { opts = window.stageOptionsForType(jt); } catch (_) { opts = null; }
    }
    if (!Array.isArray(opts) || !opts.length) {
      opts = (viewKeys || []).map((k) => ({ value: k, label: labelFor(k) }));
    }
    return opts;
  }
  // <option>s for the stage select. A stage outside the track (a custom or
  // hidden stage, or a lead parked on another track's stage) still gets a
  // selected option of its own, so the select never claims a stage the
  // lead isn't in.
  function _stageOptionsHtml(opts, sk, labelFor) {
    const list = opts.some((o) => o.value === sk) ? opts : [{ value: sk, label: labelFor(sk) }].concat(opts);
    return list.map((o) =>
      '<option value="' + _esc(o.value) + '"' + (o.value === sk ? ' selected' : '') + '>'
      + _esc(o.label || labelFor(o.value)) + '</option>').join('');
  }

  const _SORTS = {
    name:     (l) => _name(l).toLowerCase(),
    stage:    (l) => {
      const keys = window._stageKeys || [];
      const i = keys.indexOf(_stageKeyOf(l));
      return i === -1 ? keys.length : i;   // pipeline order, unknowns last
    },
    value:    (l) => Number(l.jobValue) || 0,
    age:      (l) => { const d = _created(l);  return d ? d.getTime() : 0; },
    activity: (l) => { const d = _activity(l); return d ? d.getTime() : 0; },
  };

  function _sorted(list) {
    const key = _SORTS[_sortKey] ? _sortKey : 'activity';
    const dec = list.map((l, i) => ({ l, i, k: _SORTS[key](l) }));
    dec.sort((a, b) => {
      if (a.k < b.k) return -1 * _sortDir;
      if (a.k > b.k) return  1 * _sortDir;
      return a.i - b.i; // stable
    });
    return dec.map(d => d.l);
  }

  function _sortBy(key) {
    if (_sortKey === key) _sortDir = -_sortDir;
    else { _sortKey = key; _sortDir = (key === 'value' || key === 'activity' || key === 'age') ? -1 : 1; }
    render(_lastList);
  }

  // ── Render ───────────────────────────────────────────────
  function clear() {
    const wrap = document.getElementById('crmListWrap');
    if (wrap && wrap.childNodes.length) wrap.textContent = '';
  }

  function render(list) {
    const wrap = document.getElementById('crmListWrap');
    if (!wrap) return;
    _lastList = Array.isArray(list) ? list : [];
    const stageKeys = window._stageKeys || [];
    const labelFor = (k) => (typeof window.stageLabel === 'function' ? window.stageLabel(k) : k);

    if (!_lastList.length) {
      wrap.innerHTML = '<div class="crm-list-empty nbd-empty"><div class="ne-icon">🔍</div><div class="ne-msg">No leads match</div><div class="ne-sub">Adjust the view or filters above, or add a lead with + ADD LEAD.</div></div>';
      return;
    }

    if (_isPhone()) { _renderFieldCards(wrap, stageKeys, labelFor); return; }

    const arrow = (key) => _sortKey === key ? (_sortDir === 1 ? ' ▲' : ' ▼') : '';
    const rows = _sorted(_lastList).map((l) => {
      const sk = _stageKeyOf(l);
      const val = Number(l.jobValue) || 0;
      const created = _created(l);
      const act = _activity(l);
      const ageD = _ageDays(created);
      const actD = _ageDays(act);
      const phone = (l.phone || '').trim();
      const opts = _stageOptionsHtml(_trackStages(l, stageKeys, labelFor), sk, labelFor);
      return '<tr class="crm-list-row" data-id="' + _esc(l.id) + '">'
        + '<td class="cl-name"><a href="/pro/customer?id=' + encodeURIComponent(l.id) + '">' + _esc(_name(l)) + '</a>'
        +   '<div class="cl-addr">' + _esc(l.address || '') + '</div></td>'
        + '<td class="cl-stage"><select class="cl-stage-select" data-id="' + _esc(l.id) + '"' + (l._jobId ? ' data-job-id="' + _esc(l._jobId) + '"' : '') + ' aria-label="Stage">' + opts + '</select></td>'
        + '<td class="cl-value">' + (val > 0 ? '$' + val.toLocaleString() : '—') + '</td>'
        + '<td class="cl-age">' + (ageD == null ? '—' : ageD + 'd') + '</td>'
        + '<td class="cl-activity">' + (actD == null ? '—' : (actD === 0 ? 'today' : actD + 'd ago')) + '</td>'
        + '<td class="cl-actions">'
        +   (phone ? '<a class="cl-call" href="tel:' + _esc(phone.replace(/[^\d+]/g, '')) + '" title="Call ' + _esc(phone) + '">📞</a>' : '')
        +   '<a class="cl-open" href="/pro/customer?id=' + encodeURIComponent(l.id) + '" title="Open customer">Open →</a>'
        + '</td>'
        + '</tr>';
    }).join('');

    wrap.innerHTML =
      '<table class="crm-list-table">'
      + '<thead><tr>'
      +   '<th data-sort="name">Customer' + arrow('name') + '</th>'
      +   '<th data-sort="stage">Stage' + arrow('stage') + '</th>'
      +   '<th data-sort="value">Value' + arrow('value') + '</th>'
      +   '<th data-sort="age">Age' + arrow('age') + '</th>'
      +   '<th data-sort="activity">Last activity' + arrow('activity') + '</th>'
      +   '<th></th>'
      + '</tr></thead>'
      + '<tbody>' + rows + '</tbody></table>';

    // Header sorts
    wrap.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => _sortBy(th.dataset.sort));
    });
    // Stage changes ride the SAME moveCard path as a kanban drop —
    // history entry, stage-gate prompts, and lost-reason flow intact.
    // moveCard re-renders (renderLeads) which calls back into render(),
    // so a gated/cancelled move snaps the select back to truth.
    wrap.querySelectorAll('.cl-stage-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        if (typeof window.moveCard === 'function') window.moveCard(sel.dataset.id, sel.value, sel.dataset.jobId ? { jobId: sel.dataset.jobId } : undefined);
      });
    });
  }

  // ── Phone field cards (2026-09-24) ─────────────────────────────
  // On a phone the list IS the pipeline (it opens by default there), so it
  // renders as one card per lead built for a job site: name + value, the
  // address, stage + days since the last touch, and big Call / Text / Map /
  // Open buttons. Swipe right calls, swipe left moves to the next stage.
  // The desktop keeps the sortable table above.
  const SWIPE_PX = 90;           // horizontal travel before a swipe counts
  const NO_ADVANCE = new Set(['closed', 'lost']);

  function _digits(p) { return String(p || '').replace(/[^\d+]/g, ''); }
  function _mapsHref(addr) {
    const q = encodeURIComponent(addr);
    return /iP(ad|hone|od)|Macintosh/.test(navigator.userAgent || '')
      ? 'https://maps.apple.com/?q=' + q
      : 'https://www.google.com/maps/search/?api=1&query=' + q;
  }
  // What a swipe-left does for this lead, in its own track's order (the
  // same keys as its stage select — _trackStages). A swipe never lands on a
  // dead end by accident (Lost needs its reason flow, Closed is final); it
  // now STOPS in front of one rather than skipping past it, which on the job
  // track used to jump Collections straight to Warranty Claim (a claim comes
  // after Closed). Returns the next key, or null plus the toast to show.
  function _swipeNext(sk, keys, labelFor) {
    if (NO_ADVANCE.has(sk)) return { next: null, msg: 'Already at the last stage' };
    const i = keys.indexOf(sk);
    if (i === -1) return { next: null, msg: 'Pick the next stage from the stage list' };
    const k = keys[i + 1];
    if (!k) return { next: null, msg: 'Already at the last stage' };
    if (NO_ADVANCE.has(k)) return { next: null, msg: 'Next is ' + labelFor(k) + ' — pick it from the stage list' };
    return { next: k, msg: '' };
  }

  function _renderFieldCards(wrap, stageKeys, labelFor) {
    const sortOpts = [['activity', 'Last touch'], ['value', 'Value'], ['name', 'Name'], ['stage', 'Stage'], ['age', 'Age']]
      .map(([k, lbl]) => '<option value="' + k + '"' + (k === _sortKey ? ' selected' : '') + '>' + lbl + '</option>').join('');
    const cards = _sorted(_lastList).map((l) => {
      const sk = _stageKeyOf(l);
      const val = Number(l.jobValue) || 0;
      const actD = _ageDays(_activity(l));
      const phone = _digits(l.phone);
      const addr = (l.address || '').trim();
      const open = '/pro/customer?id=' + encodeURIComponent(l.id);
      const track = _trackStages(l, stageKeys, labelFor);
      const opts = _stageOptionsHtml(track, sk, labelFor);
      const swipe = _swipeNext(sk, track.map((o) => o.value), labelFor);
      const touch = actD == null ? '' : (actD === 0 ? 'touched today' : actD + 'd since last touch');
      const stale = actD != null && actD >= 7 ? ' cl-card-stale' : '';
      const btn = (cls, href, icon, label, extra) =>
        '<a class="cl-card-btn ' + cls + '" href="' + _esc(href) + '"' + (extra || '') + '>' + icon + '<span>' + label + '</span></a>';
      return '<div class="cl-card" data-id="' + _esc(l.id) + '"' + (l._jobId ? ' data-job-id="' + _esc(l._jobId) + '"' : '') + ' data-phone="' + _esc(phone) + '" data-stage="' + _esc(sk) + '"'
        + ' data-next="' + _esc(swipe.next || '') + '" data-next-msg="' + _esc(swipe.msg) + '">'
        + '<div class="cl-card-top"><a class="cl-card-name" href="' + open + '">' + _esc(_name(l)) + '</a>'
        +   (val > 0 ? '<span class="cl-card-val">$' + val.toLocaleString() + '</span>' : '') + '</div>'
        + (addr ? '<div class="cl-card-addr">' + _esc(addr) + '</div>' : '')
        + '<div class="cl-card-meta"><select class="cl-stage-select" data-id="' + _esc(l.id) + '"' + (l._jobId ? ' data-job-id="' + _esc(l._jobId) + '"' : '') + ' aria-label="Stage">' + opts + '</select>'
        +   (touch ? '<span class="cl-card-touch' + stale + '">' + touch + '</span>' : '') + '</div>'
        + '<div class="cl-card-actions">'
        +   (phone ? btn('cl-call', 'tel:' + phone, '📞', 'Call') + btn('cl-text', 'sms:' + phone, '💬', 'Text') : '')
        +   (addr ? btn('cl-map', _mapsHref(addr), '📍', 'Map', ' target="_blank" rel="noopener"') : '')
        +   btn('cl-open', open, '→', 'Open')
        + '</div></div>';
    }).join('');

    wrap.innerHTML =
      '<div class="cl-cards-bar"><label>Sort <select class="cl-sort-select" aria-label="Sort leads">' + sortOpts + '</select></label>'
      + '<span class="cl-cards-hint">Swipe right to call · left for next stage</span></div>'
      + '<div class="cl-cards">' + cards + '</div>';

    const sortSel = wrap.querySelector('.cl-sort-select');
    if (sortSel) sortSel.addEventListener('change', () => {
      _sortKey = sortSel.value;
      _sortDir = (_sortKey === 'value' || _sortKey === 'activity' || _sortKey === 'age') ? -1 : 1;
      render(_lastList);
    });
    wrap.querySelectorAll('.cl-stage-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        if (typeof window.moveCard === 'function') window.moveCard(sel.dataset.id, sel.value, sel.dataset.jobId ? { jobId: sel.dataset.jobId } : undefined);
      });
    });
    wrap.querySelectorAll('.cl-card').forEach((card) => _wireSwipe(card, labelFor));
  }

  // Touch-only swipe. Vertical movement wins (the page must still scroll),
  // and a swipe that starts on a control (select, button) is ignored.
  function _wireSwipe(card, labelFor) {
    let x0 = null, y0 = null, dx = 0, horiz = false;
    // Put the card back without acting. touchend runs it before deciding;
    // touchcancel runs ONLY it: the OS takes a gesture over mid-swipe (the
    // notification shade, an incoming call, the back gesture) and no
    // touchend ever arrives. Without this the card stayed 120px sideways in
    // the green "call" state with Open pushed off-screen (2026-09-25 phone
    // audit).
    const reset = () => {
      x0 = null;
      card.style.transform = '';
      card.classList.remove('cl-card-swipe-call', 'cl-card-swipe-next');
    };
    card.addEventListener('touchstart', (e) => {
      if (e.target.closest && e.target.closest('select, a, button')) { x0 = null; return; }
      const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; dx = 0; horiz = false;
    }, { passive: true });
    card.addEventListener('touchmove', (e) => {
      if (x0 == null) return;
      const t = e.touches[0]; dx = t.clientX - x0; const dy = t.clientY - y0;
      if (!horiz && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) horiz = true;
      if (horiz) {
        card.style.transform = 'translateX(' + Math.max(-140, Math.min(140, dx)) + 'px)';
        card.classList.toggle('cl-card-swipe-call', dx > SWIPE_PX);
        card.classList.toggle('cl-card-swipe-next', dx < -SWIPE_PX);
      }
    }, { passive: true });
    card.addEventListener('touchcancel', reset, { passive: true });
    card.addEventListener('touchend', () => {
      if (x0 == null) return;
      const moved = dx;
      reset();
      if (!horiz) return;
      if (moved > SWIPE_PX) {
        const phone = card.getAttribute('data-phone');
        if (phone) window.location.href = 'tel:' + phone;
        else if (typeof window.showToast === 'function') window.showToast('No phone number on this lead', 'info');
      } else if (moved < -SWIPE_PX) {
        const next = card.getAttribute('data-next');
        if (!next) {
          if (typeof window.showToast === 'function') window.showToast(card.getAttribute('data-next-msg') || 'Already at the last stage', 'info');
          return;
        }
        if (typeof window.moveCard === 'function') {
          const id = card.getAttribute('data-id');
          const jobId = card.getAttribute('data-job-id');
          // Another of the customer's jobs: moveCard moves that job and posts
          // its own toast; the lead-stage confirmation below does not apply.
          if (jobId) { window.moveCard(id, next, { jobId }); return; }
          // moveCard returns nothing and a stage gate can cancel it, so only
          // confirm once the lead actually reads the new stage.
          Promise.resolve(window.moveCard(id, next)).then(() => {
            const lead = (window._leads || []).find((x) => x && x.id === id);
            if (lead && _stageKeyOf(Object.assign({}, lead, { _stageKey: null })) === next
                && typeof window.showToast === 'function') {
              window.showToast('Moved to ' + labelFor(next), 'success');
            }
          }).catch(() => {});
        }
      }
    });
  }

  window.CrmListView = { isActive, render, clear };

  // Rotate (2026-09-25 phone nav polish). Two choices here are made against
  // the phone query at render time: Auto's List-or-Board (isActive) and
  // cards-or-table (render). Nothing re-made them when the query flipped, so
  // a phone that rotated and got a live refresh while sideways (860px wide:
  // Auto says Board, so the refresh cleared the list) came back upright to
  // body.crm-list-mode over an empty list: a blank pipeline until the next
  // refresh. On a flip, re-apply the mode and, if the list is showing on
  // either side of it, re-render through renderLeads (the list renders the
  // narrowed set renderLeads builds, never a list of its own). Only once the
  // CRM view is mounted: before its template hydrates there is no list to
  // redo, and the first render does it. A saved Board choice is left alone
  // (its follow-up rows re-fit in crm-pipeline.js), and so is a desktop
  // that never crosses 768px.
  function _onPhoneQueryFlip() {
    const was = document.body.classList.contains('crm-list-mode');
    _applyMode();
    if (!was && !isActive()) return;
    if (!document.getElementById('crmListWrap')) return;
    if (typeof window.renderLeads !== 'function' || !Array.isArray(window._leads)) return;
    try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
  }
  try {
    const mq = window.matchMedia && window.matchMedia('(max-width: 768px)');
    if (mq && mq.addEventListener) mq.addEventListener('change', _onPhoneQueryFlip);
    else if (mq && mq.addListener) mq.addListener(_onPhoneQueryFlip);
  } catch (_) {}

  // Apply the persisted mode on boot — the toggle buttons live in the
  // lazily-hydrated CRM view template, so re-apply when they appear.
  _applyMode();
  document.addEventListener('DOMContentLoaded', _applyMode);
  const _t = setInterval(() => {
    if (document.getElementById('crmViewBoardBtn')) { _applyMode(); clearInterval(_t); }
  }, 500);
  setTimeout(() => clearInterval(_t), 30000);
  // The Settings panel hydrates lazily too: light the Default Pipeline View
  // choice the first time its buttons exist (checked on any click, cheap).
  document.addEventListener('click', () => {
    if (document.querySelector('.cview-default-btn')) setTimeout(_applyMode, 50);
  }, true);
})();
