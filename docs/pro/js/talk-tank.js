/**
 * talk-tank.js — Talk Tank inbox view.
 *
 * Unified inbox for every voice capture in the app. v1 reads from
 * `users/<uid>/captures` (the existing quick-capture surface) plus any
 * future voice-typed entries that get tagged with `source: 'voice-*'`.
 * Renders a chronological list of transcripts with: linked-lead context
 * when applicable, "Joe note" framing when not, jump-to-lead, archive,
 * and inline expand for the full transcript + summary.
 *
 * REC button on the page invokes window.NBDQuickCapture.open() — the
 * existing recorder UI — so we don't duplicate the recording flow.
 *
 * Lives under #/talk-tank. Pro-only (gated via PRO_ONLY_VIEWS).
 *
 * Exposes: window.TalkTank.{ render, refresh, archive }
 */
(function () {
  'use strict';

  // ── State ───────────────────────────────────────────────────
  const state = {
    items: [],
    filter: 'all',          // 'all' | 'linked' | 'standalone' | 'week'
    search: '',
    loading: false,
    expandedId: null,
  };

  // ── Firestore helpers ───────────────────────────────────────
  async function _ensureFb() {
    // Wait briefly for the Firebase bootstrap to publish window.db et al.
    const start = Date.now();
    while (!(window.db && window.collection && window.query && window.where && window.orderBy && window.limit && window.getDocs)) {
      if (Date.now() - start > 3000) throw new Error('Firestore not ready');
      await new Promise(r => setTimeout(r, 50));
    }
    return {
      db: window.db,
      collection: window.collection,
      query: window.query,
      where: window.where,
      orderBy: window.orderBy,
      limit: window.limit,
      getDocs: window.getDocs,
      doc: window.doc,
      updateDoc: window.updateDoc,
    };
  }

  function _uid() {
    return window._user?.uid
      || (window.auth && window.auth.currentUser && window.auth.currentUser.uid)
      || null;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _timeAgo(date) {
    if (!date) return '';
    const ms = Date.now() - date.getTime();
    const s = Math.floor(ms / 1000);
    if (s < 60) return 'just now';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function _leadName(leadId) {
    if (!leadId || !window._leads) return null;
    const l = window._leads.find(x => x.id === leadId);
    if (!l) return null;
    const name = ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
    return name || l.address || 'Unknown customer';
  }

  // ── Data fetch ──────────────────────────────────────────────
  async function fetchItems() {
    const uid = _uid();
    if (!uid) { state.items = []; return; }
    state.loading = true;
    try {
      const fb = await _ensureFb();
      const snap = await fb.getDocs(fb.query(
        fb.collection(fb.db, 'users', uid, 'captures'),
        fb.orderBy('createdAt', 'desc'),
        fb.limit(150)
      ));
      state.items = snap.docs.map(d => {
        const data = d.data() || {};
        const ts = data.createdAt && data.createdAt.toDate ? data.createdAt.toDate() : null;
        return {
          id: d.id,
          createdAt: ts,
          transcript: data.transcript || '',
          summary: data.summary || null,
          linkedLeadId: data.linkedLeadId || null,
          linkedLeadName: _leadName(data.linkedLeadId),
          tasksCommitted: data.tasksCommitted || 0,
          archived: !!data.archived,
          mode: data.mode || 'quick-capture',
        };
      });
    } catch (e) {
      console.error('[talk-tank] fetch failed:', e);
      state.items = [];
    } finally {
      state.loading = false;
    }
  }

  // ── Filtering ───────────────────────────────────────────────
  function applyFilters(items) {
    let out = items.filter(i => !i.archived);
    if (state.filter === 'linked') out = out.filter(i => !!i.linkedLeadId);
    else if (state.filter === 'standalone') out = out.filter(i => !i.linkedLeadId);
    else if (state.filter === 'week') {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      out = out.filter(i => i.createdAt && i.createdAt.getTime() > weekAgo);
    }
    const q = (state.search || '').trim().toLowerCase();
    if (q) {
      out = out.filter(i => {
        const hay = (i.transcript + ' ' + (i.summary?.overview || '') + ' ' + (i.linkedLeadName || '')).toLowerCase();
        return hay.includes(q);
      });
    }
    return out;
  }

  // ── Actions ─────────────────────────────────────────────────
  async function archive(id) {
    const uid = _uid();
    if (!uid || !id) return;
    try {
      const fb = await _ensureFb();
      await fb.updateDoc(fb.doc(fb.db, 'users', uid, 'captures', id), { archived: true });
      // Optimistic UI: remove locally so we don't refetch.
      state.items = state.items.filter(i => i.id !== id);
      render();
      if (typeof window.showToast === 'function') window.showToast('Archived', 'ok');
    } catch (e) {
      console.error('[talk-tank] archive failed:', e);
      if (typeof window.showToast === 'function') window.showToast('Archive failed', 'error');
    }
  }

  function jumpToLead(leadId) {
    if (!leadId) return;
    if (typeof window.NBDUrl?.customer === 'function') {
      window.location.href = window.NBDUrl.customer(leadId);
    } else {
      window.location.href = '/pro/customer.html?id=' + encodeURIComponent(leadId);
    }
  }

  function openRecorder() {
    if (window.NBDQuickCapture && typeof window.NBDQuickCapture.open === 'function') {
      window.NBDQuickCapture.open();
      // Refresh shortly after the modal closes so a new capture shows up.
      // (The modal saves on its own; we poll once after a reasonable delay.)
      setTimeout(() => { fetchItems().then(render); }, 1500);
    } else {
      if (typeof window.showToast === 'function') {
        window.showToast('Recorder not available — try refreshing the page', 'error');
      }
    }
  }

  function toggleExpand(id) {
    state.expandedId = (state.expandedId === id) ? null : id;
    render();
  }

  function setFilter(f) {
    state.filter = f;
    render();
  }

  function onSearch(value) {
    state.search = value || '';
    // Re-render ONLY the results list, never the whole view: a full
    // render() rebuilds the header (scroll.innerHTML) and destroys the
    // <input class="tt-search"> the user is typing in — dropping focus
    // and the caret on every keystroke. The chip counts don't depend on
    // the search term, so the header is safe to leave untouched.
    const view = document.getElementById('view-talk-tank');
    const mount = view && view.querySelector('.tt-body-mount');
    if (mount) mount.innerHTML = buildBody();
    else render();
  }

  // ── Render ──────────────────────────────────────────────────
  function render() {
    const view = document.getElementById('view-talk-tank');
    if (!view) return;
    const scroll = view.querySelector('.view-scroll') || view;

    const chip = (id, label, n) =>
      `<button class="tt-chip${state.filter === id ? ' tt-chip-active' : ''}" data-tt-action="setFilter" data-tt-id="${id}">${label}${typeof n === 'number' ? ` <span class="tt-chip-count">${n}</span>` : ''}</button>`;

    const linkedCount = state.items.filter(i => !i.archived && i.linkedLeadId).length;
    const standaloneCount = state.items.filter(i => !i.archived && !i.linkedLeadId).length;
    const weekCount = state.items.filter(i => !i.archived && i.createdAt && i.createdAt.getTime() > Date.now() - 7 * 86400000).length;

    const header = `
      <div class="tt-header">
        <div>
          <div class="tt-title">🎙️ TALK TANK</div>
          <div class="tt-tagline">Where ideas, calls, and field notes pool up</div>
        </div>
        <button class="tt-rec-btn" data-tt-action="openRecorder">
          <span class="tt-rec-dot"></span> Record
        </button>
      </div>
      <div class="tt-controls">
        <button class="tt-detail-btn" data-tt-action="openUnfiled" type="button">🎧 Unfiled visits</button>
        <input class="tt-search" type="search" aria-label="Search visits" placeholder="Search transcripts, summaries, customers…"
               data-tt-action="search" value="${_esc(state.search)}" />
        <div class="tt-chips">
          ${chip('all', 'All', state.items.filter(i => !i.archived).length)}
          ${chip('linked', '🔗 Linked', linkedCount)}
          ${chip('standalone', '💭 Joe notes', standaloneCount)}
          ${chip('week', '📅 This week', weekCount)}
        </div>
      </div>
    `;

    // Body lives in a stable mount so onSearch() can swap just the list
    // (see the focus-preservation note there).
    scroll.innerHTML = header + '<div class="tt-body-mount">' + buildBody() + '</div>';
  }

  // The results list / empty-state markup (everything below the header).
  // Extracted so onSearch() can re-render it in isolation.
  function buildBody() {
    const filtered = applyFilters(state.items);
    if (state.loading) {
      return `<div class="tt-empty"><div class="tt-empty-icon">⏳</div><div class="tt-empty-msg">Loading captures…</div></div>`;
    }
    if (filtered.length === 0) {
      const isFiltered = state.filter !== 'all' || state.search;
      return `<div class="tt-empty">
        <div class="tt-empty-icon">${isFiltered ? '🔍' : '🎙️'}</div>
        <div class="tt-empty-msg">${isFiltered ? 'Nothing matches that filter.' : 'No captures yet.'}</div>
        ${isFiltered ? '' : '<div class="tt-empty-sub">Hit <strong>Record</strong> to drop your first thought.</div>'}
      </div>`;
    }
    return '<div class="tt-list">' + filtered.map(renderRow).join('') + '</div>';
  }

  function renderRow(item) {
    const expanded = state.expandedId === item.id;
    const preview = item.summary?.overview
      || item.transcript.slice(0, 140)
      || '<em style="color:var(--m,#888);">(no transcript captured)</em>';
    const isLinked = !!item.linkedLeadId;
    const contextChip = isLinked
      ? `<span class="tt-ctx tt-ctx-linked" title="Linked to customer">🔗 ${_esc(item.linkedLeadName || 'Customer')}</span>`
      : `<span class="tt-ctx tt-ctx-standalone" title="Standalone Joe note">💭 Joe note</span>`;
    const tasksChip = item.tasksCommitted
      ? `<span class="tt-tasks">${item.tasksCommitted} task${item.tasksCommitted === 1 ? '' : 's'}</span>`
      : '';

    const detail = expanded ? `
      <div class="tt-detail">
        ${item.summary?.overview ? `<div class="tt-detail-block"><div class="tt-detail-label">Summary</div><div class="tt-detail-text">${_esc(item.summary.overview)}</div></div>` : ''}
        ${Array.isArray(item.summary?.actionItems) && item.summary.actionItems.length ? `
          <div class="tt-detail-block">
            <div class="tt-detail-label">Action items</div>
            <ul class="tt-action-list">${item.summary.actionItems.map(a => `<li>${_esc(a)}</li>`).join('')}</ul>
          </div>` : ''}
        ${item.transcript ? `<div class="tt-detail-block"><div class="tt-detail-label">Transcript</div><div class="tt-detail-transcript">${_esc(item.transcript)}</div></div>` : ''}
        <div class="tt-detail-actions">
          ${isLinked ? `<button class="tt-detail-btn" data-tt-action="jumpToLead" data-tt-id="${_esc(item.linkedLeadId)}">→ Open customer</button>` : ''}
          <button class="tt-detail-btn tt-detail-btn-danger" data-tt-action="archive" data-tt-id="${_esc(item.id)}">Archive</button>
        </div>
      </div>
    ` : '';

    return `
      <div class="tt-row${expanded ? ' tt-row-expanded' : ''}" data-tt-action="toggleExpand" data-tt-id="${_esc(item.id)}">
        <div class="tt-row-head">
          <div class="tt-row-icon">🎙️</div>
          <div class="tt-row-body">
            <div class="tt-row-meta">
              ${contextChip}
              ${tasksChip}
              <span class="tt-row-when">${_esc(_timeAgo(item.createdAt))}</span>
            </div>
            <div class="tt-row-preview">${_esc(preview)}</div>
          </div>
          <div class="tt-row-caret">${expanded ? '▾' : '▸'}</div>
        </div>
        ${detail}
      </div>
    `;
  }

  // ── CSP-safe delegated handlers ─────────────────────────────
  if (!window._NBD_TT_DELEGATE_BOUND) {
    window._NBD_TT_DELEGATE_BOUND = true;
    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-tt-action]');
      if (!t) return;
      const view = document.getElementById('view-talk-tank');
      if (!view || !view.contains(t)) return; // scope to Talk Tank only
      const action = t.dataset.ttAction;
      const id = t.dataset.ttId;
      try {
        switch (action) {
          case 'openRecorder':  openRecorder(); break;
          case 'openUnfiled':
            // In-person visit recordings still waiting for a customer (visit-recorder-launcher.js).
            if (window.NBDVisitRecorderLauncher && typeof window.NBDVisitRecorderLauncher.openUnfiled === 'function') window.NBDVisitRecorderLauncher.openUnfiled();
            else if (typeof window.showToast === 'function') window.showToast('Visit recorder is not loaded yet. Try again in a moment.', 'error');
            break;
          case 'setFilter':     setFilter(id); break;
          case 'jumpToLead':    jumpToLead(id); break;
          case 'archive':       ev.stopPropagation(); archive(id); break;
          case 'toggleExpand':  toggleExpand(id); break;
          // 'search' is wired via input event below
        }
      } catch (e) { console.error('[talk-tank] dispatch ' + action + ' failed:', e); }
    });
    // Search input fires `input`, not `click`.
    document.addEventListener('input', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-tt-action="search"]');
      if (!t) return;
      onSearch(t.value);
    });
  }

  // ── Init ────────────────────────────────────────────────────
  async function init() {
    render();          // show loading state
    await fetchItems();
    render();
  }

  async function refresh() {
    await fetchItems();
    render();
  }

  window.TalkTank = {
    init,
    refresh,
    render,
    archive,
    // Internal — useful for tests / power users
    _state: state,
  };
})();
