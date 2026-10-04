/*! © 2026 No Big Deal Home Solutions — All Rights Reserved. Proprietary; no license granted — see LICENSE at the repo root. https://nobigdealwithjoedeal.com */
// ============================================================
// NBD Pro — crm.js (thin shim)
//
// As of Step 4b (2026-05-16) this file is the FIFTH and LAST
// script in the CRM load chain:
//
//   crm-leads → crm-pipeline → crm-snooze → crm-portal-bridge → crm
//
// Everything that used to live here got split into the four
// sibling modules above. What stayed:
//   - the long sweep of window.* exports that lets onclick / module
//     watchdog code reach functions defined across the split files
//     (renderLeads, moveCard, buildCard, openLeadModal, etc.)
//   - window.filterByStage inline helper (small enough to stay)
//   - the toggleEngagementSort + updateEngagementSortToggle pair +
//     their on-load styling kick
//   - the W159 eager kanban-column init IIFE (must run AFTER
//     pipeline's buildKanbanColumns is on window — that's why it
//     lives in the shim)
//
// If you're hunting for code that was here pre-split:
//   - escHtml / debounce / Firebase shim consts / openLeadModal /
//     closeLeadModal / saveLead → crm-leads.js
//   - renderLeads / _damageToChip / buildCard /
//     wireKanbanCardListeners / handleCardClick / promptLostReason /
//     moveCard / kanbanFilter (+ debounced) / clearCrmSearch /
//     tagClass / updatePipeline / lead-score last-seen cache
//     → crm-pipeline.js
//   - all notification UI + checkAndCreateFollowUpNotifications +
//     checkAndCreateNeedsFieldNotifications + comm-log delegate +
//     requestNotifPermission + waitForNotifAuth + auth/pagehide
//     teardown → crm-snooze.js
//   - Bulk Operations (toggleBulkMode / bulkMoveStage /
//     bulkDelete / bulkAssignField + wrappers / commitBulkLeadOp) +
//     editLead + delete-confirm flow + deleted-leads drawer +
//     toggleProspectsView + promoteProspect + _repBookingUrl +
//     sendBookingSMS + sendFollowUpSMS → crm-portal-bridge.js
//
// The behavioural surface area is unchanged. Smoke tests pre-split
// (`1404 passed, 0 failed`) must still pass post-split.
// ============================================================

// Expose CRM functions to window for onclick handlers
// renderLeads + updatePipeline are also called bare from the
// dashboard.html <script type="module"> watchdog; explicit
// window assignment makes the cross-context lookup unambiguous
// instead of relying on classic-script auto-attach.
window.renderLeads = renderLeads;
window.updatePipeline = updatePipeline;
window.openLeadModal = openLeadModal;
window.closeLeadModal = closeLeadModal;
window.saveLead = saveLead;
// deleteLead + editLead are re-exported by crm-portal-bridge.js itself
// now (IIFE-wrapped, Globals Tranche 2c-3) — a bare re-export here would
// ReferenceError since the names are module-scoped there.
window.moveCard = moveCard;
window.changeLeadType = changeLeadType;

// W93's original anonymous engagement-sort toggle was DELETED here
// (Tranche 3 map-graduate, 2026-09-02): it was unreachable dead code — the
// real declaration further down was synchronously re-assigned over it at
// load, before any click could occur — and its comment carried the
// window-qualified name the T1 off-window walk now forbids. The live
// implementation is the const below (:~130), registry-only.

// Restore the visual active state on page load if the flag was set
// in a previous session, so the button reflects current behavior.
try {
  if (localStorage.getItem('nbd_crm_sort_engagement') === '1') {
    document.addEventListener('DOMContentLoaded', () => {
      const btn = document.getElementById('engagementSortBtn');
      if (btn) btn.classList.add('active');
    });
  }
} catch (_) {}
// exportLeadsCSV is defined in tools.js
// scrollToFollowUps is registered in crm-portal-bridge.js's __NBD_CALL_REGISTRY
// (Globals Tranche 3 T3-C, 2026-09-18) — no longer on window.
window.kanbanFilter = kanbanFilter;
window.kanbanFilterDebounced = kanbanFilterDebounced;
window.clearCrmSearch = clearCrmSearch;
window.filterByStage = function(stageKey) {
  const _normalize = window.normalizeStage || (s => s);
  // 'tile:<key>' — a dashboard Lead Stages tile (crm-stages.js
  // dashboardTileFor): the same leads the tile counted, not one stage key.
  const tile = /^tile:/.test(String(stageKey || '')) ? String(stageKey).slice(5) : null;
  const filtered = (window._leads || []).filter(l => {
    const sk = l._stageKey || _normalize(l.stage || 'new');
    if (tile) {
      return typeof window.dashboardTileFor === 'function'
        && window.dashboardTileFor(sk, l._stageRole ? () => l._stageRole : window.stageRole) === tile;
    }
    return sk === stageKey;
  });
  renderLeads(window._leads, filtered);
  const searchInput = document.getElementById('crmSearch');
  if (searchInput) { searchInput.value = ''; }
  const countSpan = document.getElementById('crmSearchCount');
  if (countSpan) countSpan.textContent = filtered.length + ' in stage';
};
window.handleCardClick = handleCardClick;
// Deleted-drawer, delete-confirm, bulk-ops, CRM-search + follow-up-scroll
// and trash-badge helpers now live behind crm-portal-bridge.js's own
// window surface (IIFE-wrapped, Globals Tranche 2c-3). The 11 markup-only
// handlers (selectAllVisibleLeads, openDeletedDrawer, confirmDeleteLead,
// cancelDeleteConfirm, bulkSnoozeLeads, bulkMoveStage, bulkDelete,
// bulkAssignSource/JobType/Damage/Carrier) register in __NBD_CALL_REGISTRY
// there; the names with real cross-file consumers (toggleCardSelection,
// clearBulkSelection, updateBulkToolbar, restoreCrmSearch, refreshTrashBadge)
// are re-exported from that file — closeDeletedDrawer, toggleBulkMode,
// exitBulkMode and scrollToFollowUps have since moved into its registry
// (Globals Tranche 3). The
// bare re-exports that used to live here would ReferenceError now that the
// names are module-scoped.
// restoreLead and permanentlyDelete are defined in dashboard.html as _restoreLead and _permanentDeleteLead
window.restoreLead = (id) => window._restoreLead(id);
window.permanentlyDelete = (id) => window._permanentDeleteLead(id);
// Aliases for dashboard.html references
window.restoreDeletedLead = (id) => window._restoreLead(id);
window.permanentDeleteLead = (id) => window._permanentDeleteLead(id);

// Wave 93: sort kanban by engagement tier toggle. localStorage-
// backed (per-device, like the W37 show-snoozed toggle). When
// flipped on, renderLeads sorts each stage column descending by
// W91/W92 engagement tier so Hot leads bubble to the top.
const toggleEngagementSort = function () {
  const cur = localStorage.getItem('nbd_crm_sort_engagement') === '1';
  const next = !cur;
  if (next) localStorage.setItem('nbd_crm_sort_engagement', '1');
  else      localStorage.removeItem('nbd_crm_sort_engagement');
  updateEngagementSortToggle();
  if (typeof window.renderLeads === 'function') {
    try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
  }
};
function updateEngagementSortToggle() {
  const btn = document.getElementById('engagementSortBtn');
  if (!btn) return;
  const on = localStorage.getItem('nbd_crm_sort_engagement') === '1';
  if (on) {
    btn.style.background  = 'rgba(251,146,60,0.18)';
    btn.style.borderColor = '#fb923c';
    btn.style.color       = '#fb923c';
  } else {
    btn.style.background  = '';
    btn.style.borderColor = '';
    btn.style.color       = '';
  }
  // .active stamped for the Filters-menu highlight + badge sync
  // (see needs-attention-filter.js updateButton for the full note).
  btn.classList.toggle('active', on);
}
// Tranche 3 map-graduate (2026-09-02): toggleEngagementSort is a top-level
// const (a function DECLARATION in this classic non-IIFE script would be an
// auto-global — the census-invisible trap) + registry-only; its sole dispatch
// is _NBD_TOGGLE_FNS.engagementSort via _nbdResolveMapped.
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, { toggleEngagementSort: toggleEngagementSort });
window.updateEngagementSortToggle = updateEngagementSortToggle;
// Initial styling on load.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(updateEngagementSortToggle, 1500));
} else {
  setTimeout(updateEngagementSortToggle, 1500);
}

// W159 P0: belt-and-suspenders kanban-column eager init.
// onAuthStateChanged calls buildKanbanColumns deep inside an async
// chain. On slow auth, transient module-load errors, or any path
// that doesn't reach loadLeads().then(), the user sees a fully blank
// kanban — no skeleton, no columns, no error. This block runs as
// soon as crm.js loads (defer = after DOM parse), guaranteeing the
// kanban container has columns regardless of auth/leads timing.
(function _eagerKanbanInit() {
  function _go() {
    const board = document.getElementById('kanbanBoard');
    if (!board) return;
    if (board.querySelector('.kanban-col')) return;
    if (typeof window.buildKanbanColumns !== 'function') return;
    let saved = null;
    try {
      saved = (typeof localStorage !== 'undefined') ? localStorage.getItem('nbd_kanban_view') : null;
    } catch (_) { saved = null; }
    const tries = [saved, window._currentViewKey, 'insurance'].filter(Boolean);
    for (const view of tries) {
      try { window.buildKanbanColumns(view); } catch (e) {
        console.warn('[eager-kanban-init] view', view, 'threw:', e && e.message);
      }
      if (board.querySelector('.kanban-col')) return; // success
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _go, { once: true });
  } else {
    _go();
  }
  // Final retries in case window.buildKanbanColumns wasn't ready when
  // we first ran (defer order vs <script type=module> in dashboard.html).
  setTimeout(_go, 0);
  setTimeout(_go, 250);
  setTimeout(_go, 1000);
})();
