/**
 * quick-capture-inbox.js — Past captures view for NBD Whisper (W132)
 *
 * Closes out the NBD Whisper arc. Surfaces a list of the rep's
 * historical voice captures (W130) in a searchable inbox so they
 * can:
 *   - Re-read past summaries
 *   - Re-link to a different lead (or unlink)
 *   - Re-commit action items as tasks
 *   - Archive captures they no longer need
 *
 * Surface: a new entry in the same Comfort/Picker bottom-right stack:
 * tap "📋" inbox button → modal opens with paginated list.
 *
 * Schema (from W130):
 *   users/{uid}/captures/{captureId}: {
 *     transcript, summary, linkedLeadId|null, mode: 'quick-capture',
 *     archived, createdAt, tasksCommitted (optional)
 *   }
 *
 * Public API:
 *   window.NBDQuickCaptureInbox.open()
 *   window.NBDQuickCaptureInbox.attachFloatingButton()
 */

(function () {
  'use strict';
  if (window.NBDQuickCaptureInbox && window.NBDQuickCaptureInbox.__sentinel === 'nbd-qci-v1') return;

  const FLOAT_BTN_ID = 'nbd-qci-fab';
  const MODAL_ID = 'nbd-qci-modal';
  const PAGE_SIZE = 25;

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }
  function fmtTime(ts) {
    if (!ts) return '';
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const opts = sameDay
      ? { hour: 'numeric', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    return d.toLocaleString(undefined, opts);
  }

  // ─── Floating "Inbox" button (sits above Quick Capture FAB) ──
  function attachFloatingButton() {
    if (document.getElementById(FLOAT_BTN_ID)) return;
    const btn = document.createElement('button');
    btn.id = FLOAT_BTN_ID;
    btn.type = 'button';
    btn.title = 'Capture inbox — past voice captures';
    btn.setAttribute('aria-label', 'Open Quick Capture inbox');
    btn.style.cssText =
      // W149: inbox FAB previously was 36x36 — below the iOS HIG
      // 44px touch-target minimum. Bumped to 44px and given the
      // safe-area-inset treatment so the entire FAB stack respects
      // device chrome on notched phones / Android gesture bars.
      'position:fixed;' +
      'bottom:calc(142px + env(safe-area-inset-bottom, 0px));' +
      'right:calc(25px + env(safe-area-inset-right, 0px));' +
      'z-index:9999;' +
      'width:44px;height:44px;border-radius:50%;border:none;' +
      'background:#0f1729;color:#94a3b8;font-size:14px;' +
      'box-shadow:0 4px 12px rgba(0,0,0,0.35);cursor:pointer;' +
      'border:1px solid #2a3344;' +
      'display:flex;align-items:center;justify-content:center;' +
      '-webkit-tap-highlight-color:transparent;transition:opacity 160ms ease;';
    btn.innerHTML = '📋';
    btn.addEventListener('click', open);
    document.body.appendChild(btn);
  }

  // ─── Modal lifecycle ────────────────────────────────────────────
  function open() {
    if (document.getElementById(MODAL_ID)) return;
    const modal = _buildModal();
    document.body.appendChild(modal);
    document.addEventListener('keydown', _escHandler);
    _loadCaptures();
  }
  function close() {
    const modal = document.getElementById(MODAL_ID);
    if (modal) modal.remove();
    document.removeEventListener('keydown', _escHandler);
    _captures = [];
  }
  function _escHandler(e) { if (e.key === 'Escape') close(); }

  function _buildModal() {
    const wrap = document.createElement('div');
    wrap.id = MODAL_ID;
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:10010;background:rgba(10,20,36,0.92);' +
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;' +
      'overflow-y:auto;';
    wrap.innerHTML =
      '<div style="background:#0f1729;border:1px solid #2a3344;border-radius:14px;' +
        'width:100%;max-width:720px;max-height:90vh;display:flex;flex-direction:column;' +
        'padding:20px;color:#e2e8f0;box-shadow:0 20px 60px rgba(0,0,0,0.6);font:inherit;">' +
        '<div class="qix-dflex-aicenter-jcspacebet">' +
          '<div>' +
            '<div class="qix-fs11px-c94a3b8-ls008em">CAPTURE INBOX</div>' +
            '<div class="qix-fs18px-w700">Past voice captures</div>' +
          '</div>' +
          '<button type="button" id="nbd-qci-close" class="qix-bgtranspar-bdnone-c94a3b8">×</button>' +
        '</div>' +
        '<input type="text" id="nbd-qci-search" placeholder="Search by overview, transcript, or category…" ' +
          'style="width:100%;padding:10px;border-radius:6px;border:1px solid #2a3344;background:#0a1424;' +
          'color:inherit;font:inherit;font-size:14px;margin-bottom:12px;box-sizing:border-box;">' +
        '<div id="nbd-qci-list" class="qix-fx1-oveauto-dflex">' +
          '<div class="qix-c94a3b8-fs13px-tacenter">Loading…</div>' +
        '</div>' +
      '</div>';
    wrap.querySelector('#nbd-qci-close').addEventListener('click', close);
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    wrap.querySelector('#nbd-qci-search').addEventListener('input', (e) => {
      _renderList(e.target.value);
    });
    return wrap;
  }

  // ─── Data ───────────────────────────────────────────────────────
  let _captures = [];

  async function _ensureFirestore() {
    if (window.db && window.collection && window.query
        && window.orderBy && window.limit && window.getDocs
        && window.doc && window.updateDoc) {
      return {
        db: window.db,
        collection: window.collection,
        query: window.query,
        orderBy: window.orderBy,
        limit: window.limit,
        getDocs: window.getDocs,
        addDoc: window.addDoc,
        doc: window.doc,
        updateDoc: window.updateDoc,
        serverTimestamp: window.serverTimestamp,
      };
    }
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    return {
      db: window.db || mod.getFirestore(),
      collection: mod.collection,
      query: mod.query,
      orderBy: mod.orderBy,
      limit: mod.limit,
      getDocs: mod.getDocs,
      addDoc: mod.addDoc,
      doc: mod.doc,
      updateDoc: mod.updateDoc,
      serverTimestamp: mod.serverTimestamp,
    };
  }

  async function _loadCaptures() {
    const uid = window._user?.uid || (window.auth && window.auth.currentUser && window.auth.currentUser.uid);
    if (!uid) {
      const list = document.getElementById('nbd-qci-list');
      if (list) list.innerHTML = '<div class="qix-cfca5a5-fs13px-tacenter">Sign in to see your captures.</div>';
      return;
    }
    try {
      const fb = await _ensureFirestore();
      const q = fb.query(
        fb.collection(fb.db, 'users', uid, 'captures'),
        fb.orderBy('createdAt', 'desc'),
        fb.limit(PAGE_SIZE)
      );
      const snap = await fb.getDocs(q);
      _captures = [];
      snap.forEach(d => _captures.push({ id: d.id, ...d.data() }));
      _renderList('');
    } catch (e) {
      console.warn('[NBDQuickCaptureInbox] load failed:', e);
      const list = document.getElementById('nbd-qci-list');
      if (list) list.innerHTML =
        '<div class="qix-cfca5a5-fs13px-tacenter">' +
        'Could not load captures: ' + escHtml(e.message || e) + '</div>';
    }
  }

  function _renderList(filterText) {
    const list = document.getElementById('nbd-qci-list');
    if (!list) return;
    const q = String(filterText || '').toLowerCase().trim();
    const filtered = q
      ? _captures.filter(c => {
          const text = ((c.summary?.overview || '') + ' ' + (c.transcript || '') + ' ' + (c.summary?.category || '')).toLowerCase();
          return text.includes(q);
        })
      : _captures;
    const visible = filtered.filter(c => !c.archived);
    if (visible.length === 0) {
      list.innerHTML =
        '<div class="qix-c94a3b8-fs13px-tacenter">' +
        (q ? 'No captures match this search.' : 'No captures yet. Tap 🎙 to record one.') +
        '</div>';
      return;
    }
    list.innerHTML = visible.map(c => _renderItem(c)).join('');
    Array.from(list.querySelectorAll('.nbd-qci-item')).forEach(item => {
      const id = item.dataset.captureId;
      const archiveBtn = item.querySelector('.nbd-qci-archive');
      const linkBtn = item.querySelector('.nbd-qci-link');
      const expandBtn = item.querySelector('.nbd-qci-expand');
      const expandPanel = item.querySelector('.nbd-qci-expand-panel');
      if (archiveBtn) archiveBtn.addEventListener('click', () => _archive(id));
      if (linkBtn) linkBtn.addEventListener('click', () => _showLeadPicker(id));
      if (expandBtn && expandPanel) {
        expandBtn.addEventListener('click', () => {
          const isOpen = expandPanel.style.display === 'block';
          expandPanel.style.display = isOpen ? 'none' : 'block';
          expandBtn.textContent = isOpen ? 'Show details' : 'Hide details';
        });
      }
    });
  }

  function _renderItem(c) {
    const summary = c.summary || {};
    const overview = summary.overview || c.transcript?.slice(0, 200) || '(no summary)';
    const category = summary.category || 'other';
    const actionItems = Array.isArray(summary.actionItems) ? summary.actionItems : [];
    const linkedLead = (window._leads || []).find(l => l.id === c.linkedLeadId);
    const linkedLabel = linkedLead
      ? ((linkedLead.firstName || '') + ' ' + (linkedLead.lastName || '')).trim() || linkedLead.address || c.linkedLeadId
      : null;

    return '<div class="nbd-qci-item" data-capture-id="' + escHtml(c.id) + '" ' +
        'style="background:#0a1424;border:1px solid #2a3344;border-radius:8px;padding:12px;">' +

      '<div class="qix-dflex-jcspacebet-aiflexstar">' +
        '<div class="qix-fx1-minw0">' +
          '<div class="qix-fs11px-c94a3b8-mb4px">' +
            '<span>' + escHtml(fmtTime(c.createdAt)) + '</span>' +
            '<span class="qix-dinlinebl-p1px7px-bgrgba1617">' + escHtml(category) + '</span>' +
            (linkedLabel
              ? '<span class="qix-dinlinebl-p1px7px-bg1a2540">→ ' + escHtml(linkedLabel) + '</span>'
              : '') +
            (c.tasksCommitted
              ? '<span class="qix-fs10px-c5eead4">' + c.tasksCommitted + ' task' + (c.tasksCommitted === 1 ? '' : 's') + ' committed</span>'
              : '') +
          '</div>' +
          '<div class="qix-fs13px-lh145">' + escHtml(overview) + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="qix-dflex-gap6px-flewrap">' +
        '<button type="button" class="nbd-qci-expand qix-p5px10px-bgtranspar-bd1pxsolid">Show details</button>' +
        (linkedLead
          ? '<button type="button" class="nbd-qci-link qix-p5px10px-bgtranspar-bd1pxsolid">Re-link</button>'
          : '<button type="button" class="nbd-qci-link qix-p5px10px-bgrgba1617-bd1pxsolid">Link to lead</button>') +
        '<button type="button" class="nbd-qci-archive qix-mlauto-p5px10px-bgtranspar">Archive</button>' +
      '</div>' +

      '<div class="nbd-qci-expand-panel" style="display:none;margin-top:10px;padding:10px;background:#0f1729;border-radius:6px;font-size:12px;line-height:1.55;">' +
        (actionItems.length
          ? '<div class="qix-w600-mb4px-fs11px">Action items</div>' +
            '<ul class="qix-m0010px-pad18px">' +
              actionItems.map(t => '<li>' + escHtml(t) + '</li>').join('') +
            '</ul>'
          : '') +
        '<div class="qix-w600-mb4px-fs11px">Transcript</div>' +
        '<div class="qix-whiprewrap-ccbd5e1">' + escHtml(c.transcript || '') + '</div>' +
      '</div>' +
    '</div>';
  }

  // ─── Actions ────────────────────────────────────────────────────
  async function _archive(captureId) {
    const uid = window._user?.uid || (window.auth && window.auth.currentUser && window.auth.currentUser.uid);
    if (!uid) return;
    try {
      const fb = await _ensureFirestore();
      const ref = fb.doc(fb.db, 'users', uid, 'captures', captureId);
      await fb.updateDoc(ref, { archived: true });
      _captures = _captures.map(c => c.id === captureId ? { ...c, archived: true } : c);
      _renderList(document.getElementById('nbd-qci-search')?.value || '');
      toast('Archived ✓', 'success');
    } catch (e) {
      toast('Archive failed: ' + (e.message || 'try again'), 'error');
    }
  }

  function _showLeadPicker(captureId) {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    if (leads.length === 0) {
      toast('Lead cache not loaded yet — wait a moment.', 'error');
      return;
    }
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(10,20,36,0.96);z-index:10020;' +
      'display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML =
      '<div class="qix-bg0f1729-bd1pxsolid-r12px">' +
        '<div class="qix-dflex-aicenter-jcspacebet-2">' +
          '<div class="qix-fs14px-w700">Pick a lead to link to</div>' +
          '<button type="button" data-act="cancel" class="qix-bgtranspar-bdnone-c94a3b8-2">×</button>' +
        '</div>' +
        '<input type="text" data-search class="qix-wd100-p8px10px-r5px" placeholder="Search…">' +
        '<div data-list class="qix-max300px-oveauto-dflex"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const searchEl = overlay.querySelector('[data-search]');
    const listEl = overlay.querySelector('[data-list]');
    function render(q) {
      const norm = String(q || '').toLowerCase().trim();
      const matched = norm
        ? leads.filter(l => {
            const n = ((l.firstName || '') + ' ' + (l.lastName || '')).trim().toLowerCase();
            const a = (l.address || '').toLowerCase();
            return n.includes(norm) || a.includes(norm);
          }).slice(0, 30)
        : leads.slice(0, 30);
      if (matched.length === 0) {
        listEl.innerHTML = '<div class="qix-c94a3b8-fs12px-p14px">No matches.</div>';
        return;
      }
      listEl.innerHTML = matched.map(l => {
        const name = ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || '(no name)';
        return '<button type="button" data-lead-id="' + escHtml(l.id) + '" ' +
          'style="padding:9px 11px;text-align:left;background:#0a1424;border:1px solid #2a3344;border-radius:5px;color:inherit;cursor:pointer;font-size:12px;">' +
          '<div class="qix-w600">' + escHtml(name) + '</div>' +
          '<div class="qix-c94a3b8-fs11px-mt2px">' + escHtml(l.address || '') + '</div>' +
          '</button>';
      }).join('');
      Array.from(listEl.querySelectorAll('button[data-lead-id]')).forEach(b => {
        b.addEventListener('click', async () => {
          const leadId = b.dataset.leadId;
          overlay.remove();
          await _linkCapture(captureId, leadId);
        });
      });
    }
    render('');
    searchEl.addEventListener('input', () => render(searchEl.value));
    setTimeout(() => searchEl.focus(), 0);
  }

  async function _linkCapture(captureId, leadId) {
    const uid = window._user?.uid || (window.auth && window.auth.currentUser && window.auth.currentUser.uid);
    if (!uid) return;
    try {
      const fb = await _ensureFirestore();
      const ref = fb.doc(fb.db, 'users', uid, 'captures', captureId);
      await fb.updateDoc(ref, { linkedLeadId: leadId });
      _captures = _captures.map(c => c.id === captureId ? { ...c, linkedLeadId: leadId } : c);
      _renderList(document.getElementById('nbd-qci-search')?.value || '');
      toast('Linked ✓', 'success');
    } catch (e) {
      toast('Link failed: ' + (e.message || 'try again'), 'error');
    }
  }

  window.NBDQuickCaptureInbox = {
    __sentinel: 'nbd-qci-v1',
    open,
    close,
    attachFloatingButton,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachFloatingButton, { once: true });
  } else {
    setTimeout(attachFloatingButton, 0);
  }
})();
