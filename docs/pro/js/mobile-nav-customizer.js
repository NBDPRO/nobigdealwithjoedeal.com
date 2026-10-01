// ══════════════════════════════════════════════════════════════
// NBD PRO — CUSTOMIZABLE MOBILE BOTTOM NAV
// Drop-in: replaces hardcoded #mobile-nav with user-configurable tabs
// localStorage for instant load, Firestore for cross-device sync
// ══════════════════════════════════════════════════════════════

(function() {
'use strict';
let _delegateBound = false; // click-delegate bind-once (formerly a window-level _NBD_MNC flag)

// ── MASTER TAB REGISTRY ──────────────────────────────────────
const TAB_REGISTRY = [
  { id: 'dash',       icon: '📊', label: 'Home',        action: 'dash',       category: 'Core' },
  { id: 'home',       icon: '🏠', label: 'Widgets',     action: 'home',       category: 'Core' },
  { id: 'crm',        icon: '👥', label: 'CRM',         action: 'crm',        category: 'Core',  badge: true },
  { id: 'create',     icon: '➕', label: 'New',         action: 'create',     category: 'Core' },
  { id: 'est',        icon: '📋', label: 'Estimates',   action: 'est',        category: 'Core' },
  { id: 'map',        icon: '🗺️', label: 'Map',         action: 'map',        category: 'Tools' },
  { id: 'd2d',        icon: '🚪', label: 'D2D',         action: 'd2d',        category: 'Tools' },
  { id: 'photos',     icon: '📸', label: 'Photos',      action: 'photos',     category: 'Tools' },
  { id: 'docs',       icon: '📁', label: 'Templates',   action: 'docs',       category: 'Tools' },
  { id: 'products',   icon: '📦', label: 'Products',    action: 'products',   category: 'Tools' },
  { id: 'job-templates', icon: '🧰', label: 'Job Templates', action: 'job-templates', category: 'Tools' },
  { id: 'draw',       icon: '✏️', label: 'Draw',         action: 'draw',       category: 'Tools' },
  { id: 'signs',      icon: '🪧', label: 'Yard Signs',  action: 'signs',      category: 'Tools' },
  { id: 'winback',    icon: '🤝', label: 'Past Customers', action: 'winback', category: 'Tools' },
  { id: 'schedule',   icon: '🗓️', label: 'Schedule',    action: 'schedule',   category: 'Tools' },
  { id: 'training',   icon: '🎯', label: 'Training',    action: 'training',   category: 'Tools' },
  { id: 'academy',    icon: '🎓', label: 'Academy',     action: 'academy',    category: 'Tools' },
  { id: 'storm',      icon: '⛈️', label: 'Storm',        action: 'storm',      category: 'Insights' },
  { id: 'closeboard', icon: '📋', label: 'Close Board', action: 'closeboard', category: 'Insights' },
  { id: 'repos',      icon: '🧠', label: 'Rep OS',      action: 'repos',      category: 'Insights' },
  { id: 'board',      icon: '🏆', label: 'Leaderboard', action: 'board',      category: 'Insights' },
  // Sidebar-only until the 2026-09-25 phone audit (views#1) — no way in on a phone.
  { id: 'reports',    icon: '📈', label: 'Reports',     action: 'reports',    category: 'Insights' },
  { id: 'talk-tank',  icon: '🎙️', label: 'Talk Tank',   action: 'talk-tank',  category: 'Insights' },
  { id: 'refrewards', icon: '🎁', label: 'Referrals',   action: 'refrewards', category: 'Insights' },
  { id: 'joe',        icon: '🤖', label: 'Ask Joe',     action: 'joe',        category: 'System' },
  { id: 'settings',   icon: '⚙️', label: 'Settings',    action: 'settings',   category: 'System' },
];

// Matches the original static #mobile-nav (Home, Pipeline, +, Ask Joe, More):
// the create FAB is a default so a first-run phone user always has an
// add-lead control on the home view (first-run punch list follow-up 2026-07-29).
// Map stays available in the picker.
const DEFAULT_TABS = ['dash', 'crm', 'create', 'joe'];
const STORAGE_KEY  = 'nbd_mobile_tabs';
const MAX_TABS     = 4;

// Firestore path: users/{uid}/preferences/mobileNav
// Document shape: { tabs: ['dash','map','crm','joe'], updatedAt: serverTimestamp() }


// ══════════════════════════════════════════════════════════════
//  STORAGE LAYER — localStorage + Firestore
// ══════════════════════════════════════════════════════════════

function loadTabsLocal() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const valid = parsed.filter(id => TAB_REGISTRY.find(t => t.id === id));
      if (valid.length > 0 && valid.length <= MAX_TABS) return valid;
    }
  } catch(e) {}
  return [...DEFAULT_TABS];
}

function saveTabsLocal(tabIds) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tabIds)); } catch(e) {}
}

function _getUid() {
  try { return window.auth?.currentUser?.uid || null; } catch(e) { return null; }
}

function _firestoreReady() {
  return !!(window.db && window.doc && window.getDoc && window.setDoc && _getUid());
}

async function loadTabsFirestore() {
  if (!_firestoreReady()) return null;
  try {
    const uid = _getUid();
    const snap = await window.getDoc(window.doc(window.db, 'users', uid, 'preferences', 'mobileNav'));
    if (snap.exists()) {
      const data = snap.data();
      if (Array.isArray(data.tabs)) {
        const valid = data.tabs.filter(id => TAB_REGISTRY.find(t => t.id === id));
        if (valid.length > 0 && valid.length <= MAX_TABS) return valid;
      }
    }
  } catch(e) {
    console.warn('[NavCustomizer] Firestore read failed:', e.message);
  }
  return null;
}

async function saveTabsFirestore(tabIds) {
  if (!_firestoreReady()) return false;
  try {
    const uid = _getUid();
    const docRef = window.doc(window.db, 'users', uid, 'preferences', 'mobileNav');
    const payload = { tabs: tabIds, updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date().toISOString() };
    await window.setDoc(docRef, payload, { merge: true });
    console.log('[NavCustomizer] ✓ Saved to Firestore');
    return true;
  } catch(e) {
    console.warn('[NavCustomizer] Firestore write failed:', e.message);
    return false;
  }
}

function loadTabs() {
  return loadTabsLocal();
}

async function saveTabs(tabIds) {
  saveTabsLocal(tabIds);
  saveTabsFirestore(tabIds);
}

async function syncFromFirestore() {
  const remote = await loadTabsFirestore();
  if (remote) {
    const local = loadTabsLocal();
    if (JSON.stringify(remote) !== JSON.stringify(local)) {
      saveTabsLocal(remote);
      renderBottomNav();
      console.log('[NavCustomizer] ✓ Synced from Firestore:', remote);
    }
  }
}


// ══════════════════════════════════════════════════════════════
//  CSS INJECTION
// ══════════════════════════════════════════════════════════════

function injectCSS() {
  if (document.getElementById('nbd-nav-customizer-css')) return;
  const style = document.createElement('style');
  style.id = 'nbd-nav-customizer-css';
  style.textContent = `

/* .modal-bg convention (dashboard-app.css ~:2181/:4617): the shared class
   already supplies display:flex + opacity/visibility/pointer-events gating
   on .open + z-index:var(--z-overlay), so this ID rule only carries the
   layout/backdrop specifics that differ from the canonical modal. */
#navCustomizeModal {
  position:fixed; top:0; left:0; right:0; bottom:0;
  background:rgba(0,0,0,.85);
  -webkit-backdrop-filter:blur(20px); backdrop-filter:blur(20px);
  align-items:flex-end; justify-content:center;
}

.ncm-sheet {
  width:100%; max-width:500px; max-height:88vh;
  background:var(--s, #111318); border-radius:20px 20px 0 0;
  display:flex; flex-direction:column; overflow:hidden;
  border:1px solid var(--br, #1e2530); border-bottom:none;
  animation: ncm-slide-up .3s cubic-bezier(.32,.72,0,1);
}
@keyframes ncm-slide-up {
  from { transform:translateY(100%); opacity:0; }
  to   { transform:translateY(0); opacity:1; }
}

.ncm-handle { display:flex; justify-content:center; padding:12px 0 4px; }
.ncm-handle::after {
  content:''; width:40px; height:4px; border-radius:3px;
  background:var(--br, #2a3040);
}

.ncm-head {
  display:flex; align-items:center; justify-content:space-between;
  padding:8px 20px 14px;
}
.ncm-title {
  font-family:'Barlow Condensed',sans-serif; font-size:20px;
  font-weight:800; color:var(--t, #e8eaf0); letter-spacing:.03em;
}
.ncm-subtitle {
  font-size:11px; color:var(--m, #8a8f9e); margin-top:2px;
  font-family:'Barlow Condensed',sans-serif; letter-spacing:.02em;
}
.ncm-close {
  background:none; border:1px solid var(--br, #2a3040);
  border-radius:10px; color:var(--m, #8a8f9e); font-size:18px;
  width:38px; height:38px; display:flex; align-items:center;
  justify-content:center; cursor:pointer;
  -webkit-tap-highlight-color:transparent;
}
.ncm-close:active { background:rgba(255,255,255,.05); }

.ncm-current { padding:0 16px 12px; display:flex; gap:8px; }
.ncm-current-label {
  padding:0 20px 8px; font-size:10px;
  font-family:'Barlow Condensed',sans-serif;
  text-transform:uppercase; letter-spacing:.12em;
  color:var(--m, #8a8f9e); font-weight:700;
}
.ncm-slot {
  flex:1; display:flex; flex-direction:column; align-items:center;
  gap:4px; padding:12px 4px; border-radius:14px;
  background:var(--s2, rgba(255,255,255,.04));
  border:2px solid var(--br, #1e2530);
  position:relative; cursor:grab; min-width:0;
  transition:border-color .15s, background .15s, transform .15s;
  -webkit-tap-highlight-color:transparent;
}
.ncm-slot.dragging { opacity:.5; transform:scale(.92); border-color:var(--orange, #BD5728); }
.ncm-slot.drag-over { border-color:var(--orange, #BD5728); background:color-mix(in srgb, var(--orange) 10%, transparent); transform:scale(1.04); }
.ncm-slot-icon { font-size:22px; line-height:1; }
.ncm-slot-label {
  font-size:9px; font-family:'Barlow Condensed',sans-serif;
  text-transform:uppercase; letter-spacing:.06em;
  color:var(--t, #e8eaf0); font-weight:600;
  text-align:center; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; max-width:100%;
}
.ncm-slot-num {
  position:absolute; top:4px; left:6px; font-size:8px;
  font-weight:800; color:var(--orange, #BD5728);
  font-family:'Barlow Condensed',sans-serif;
}
.ncm-slot-remove {
  position:absolute; top:2px; right:4px; font-size:12px;
  background:none; border:none; color:var(--m, #8a8f9e);
  cursor:pointer; padding:2px 4px; border-radius:6px;
  line-height:1; -webkit-tap-highlight-color:transparent;
}
.ncm-slot-remove:active { color:var(--red, #e85454); }

.ncm-pool { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; padding:0 16px 24px; }
.ncm-pool-label {
  padding:12px 4px 6px; font-size:9px;
  font-family:'Barlow Condensed',sans-serif;
  text-transform:uppercase; letter-spacing:.12em;
  color:var(--m, #8a8f9e); font-weight:700;
}
.ncm-pool-grid { display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; }
.ncm-pool-item {
  display:flex; flex-direction:column; align-items:center;
  gap:4px; padding:12px 4px; border-radius:12px;
  background:var(--s2, rgba(255,255,255,.04));
  border:1px solid var(--br, #1e2530);
  cursor:pointer; transition:all .15s;
  -webkit-tap-highlight-color:transparent;
}
.ncm-pool-item:active { background:color-mix(in srgb, var(--orange) 12%, transparent); border-color:var(--orange, #BD5728); transform:scale(.95); }
.ncm-pool-item.in-bar { opacity:.35; pointer-events:none; border-style:dashed; }
.ncm-pool-icon { font-size:20px; line-height:1; }
.ncm-pool-name {
  font-size:9px; font-family:'Barlow Condensed',sans-serif;
  text-transform:uppercase; letter-spacing:.04em;
  color:var(--t, #e8eaf0); font-weight:600;
  text-align:center; white-space:nowrap; overflow:hidden;
  text-overflow:ellipsis; max-width:100%;
}

.ncm-sync {
  display:flex; align-items:center; gap:6px;
  padding:0 20px 8px; font-size:10px;
  color:var(--m, #8a8f9e);
  font-family:'Barlow Condensed',sans-serif; letter-spacing:.04em;
}
.ncm-sync-dot { width:6px; height:6px; border-radius:50%; background:var(--green, #4ade80); flex-shrink:0; }
.ncm-sync-dot.offline { background:var(--yellow, #facc15); }
.ncm-sync-dot.error   { background:var(--red, #e85454); }

.ncm-actions {
  display:flex; gap:10px; padding:12px 16px;
  border-top:1px solid var(--br, #1e2530);
  padding-bottom:calc(16px + env(safe-area-inset-bottom, 0px));
}
.ncm-btn {
  flex:1; padding:14px; border-radius:12px; font-size:14px;
  font-family:'Barlow Condensed',sans-serif; font-weight:700;
  letter-spacing:.06em; text-transform:uppercase;
  cursor:pointer; border:none; text-align:center;
  -webkit-tap-highlight-color:transparent;
  transition:background .15s, transform .1s;
}
.ncm-btn:active { transform:scale(.97); }
.ncm-btn-reset {
  background:var(--s2, rgba(255,255,255,.06));
  color:var(--m, #8a8f9e); border:1px solid var(--br, #1e2530);
}
.ncm-btn-save { background:var(--orange, #BD5728); color:#fff; }
.ncm-btn-save.saving { opacity:.6; pointer-events:none; }

.mm-item-customize {
  border-top:1px solid var(--br, #1e2530);
  margin-top:8px; padding-top:14px;
  color:var(--orange, #BD5728) !important;
}
.mm-item-customize:hover,
.mm-item-customize:active { background:color-mix(in srgb, var(--orange) 10%, transparent) !important; }

  `;
  document.head.appendChild(style);
}


// ══════════════════════════════════════════════════════════════
//  RENDER BOTTOM NAV
// ══════════════════════════════════════════════════════════════

function renderBottomNav() {
  const nav = document.getElementById('mobile-nav');
  if (!nav) return;

  const tabIds = loadTabs();
  let html = '';

  tabIds.forEach(id => {
    const tab = TAB_REGISTRY.find(t => t.id === id);
    if (!tab) return;
    if (tab.action === 'create') {
      // The orange "+" FAB is not a view — it opens the create popover via
      // the same registry-dispatched handler the static markup used
      // (mCreateFabRoute). Keep the static markup's class/id/aria so the
      // .mn-fab CSS treatment and the onboarding-tour anchor keep working.
      html += `<div class="mn-item mn-fab" id="mni-create" data-mnc-action="create" role="button" aria-label="Create new">
        <span class="mn-icon">${tab.icon}</span>
        <span class="mn-lbl">${tab.label}</span>
      </div>`;
      return;
    }
    html += `<div class="mn-item" id="mni-${tab.id}" data-mnc-action="mobileNav" data-mnc-id="${tab.action}">
      <span class="mn-icon">${tab.icon}</span>
      <span class="mn-lbl">${tab.label}</span>
      ${tab.badge ? '<span class="mn-badge" id="mni-crm-badge" style="display:none;"></span>' : ''}
    </div>`;
  });

  html += `<div class="mn-item" id="mni-more" data-mnc-action="toggleMore">
    <span class="mn-icon">⋯</span>
    <span class="mn-lbl">More</span>
  </div>`;

  nav.innerHTML = html;

  if (typeof window.MOBILE_NAV_TABS !== 'undefined') {
    window.MOBILE_NAV_TABS.length = 0;
    tabIds.forEach(id => window.MOBILE_NAV_TABS.push(id));
  }

  // Override mobileNav() so active-state logic uses the custom tab list
  // (the original uses const MOBILE_NAV_TABS which we can't modify).
  // The lit tab is the view the rep is ON after goTo, read from the hash
  // goTo writes (setActiveTab), not the tab that was tapped (2026-09-25
  // phone nav polish). goTo can decline to leave: Settings → Pipelines with
  // unsaved edits asks first, and on Cancel the rep stays in Settings — but
  // this lit the tapped Home or CRM tab anyway. The Lite plan gate declines
  // the same way. When the leave does go ahead later (OK on the prompt), goTo
  // writes the hash then and the hashchange listener below lights the tab.
  window.mobileNav = function(view) {
    if (typeof window.goTo === 'function') window.goTo(view);
    setActiveTab();
    // Deactivate MORE button unless it was tapped
    const moreBtn = document.getElementById('mni-more');
    if (moreBtn) moreBtn.classList.remove('active');
    // Close any open map sidebars
    document.querySelectorAll('.map-sidebar.open').forEach(s => s.classList.remove('open'));
  };

  setActiveTab();
}

function setActiveTab() {
  // goTo() writes '#/crm', so replacing only the '#' yielded '/crm' — which
  // never equalled the tab id 'crm', so after ANY navigation the bar lit
  // nothing. (The `hash === ''` sub-branch below was dead too: the old
  // `|| 'dash'` default meant hash could never be ''. On a cold load with no
  // hash it therefore lit 'dash' while the Home/Widgets view was on screen.)
  // routeFromHash (dashboard-state.js) is the one parser for this.
  const route = (typeof routeFromHash === 'function')
    ? routeFromHash().name
    : (window.location.hash || '').replace(/^#\/?/, '').split('/')[0] || 'home';
  const tabIds = loadTabs();
  tabIds.forEach(id => {
    const el = document.getElementById('mni-' + id);
    // A route with no tab of its own (Home, Settings, Expenses…) lights
    // nothing. That is honest: highlighting a tab the user is not on is what
    // made the bar untrustworthy in the first place.
    if (el) el.classList.toggle('active', id === route);
  });
}

// The bar has to re-sync on every navigation, not just when it is rendered.
// setActiveTab used to run only from renderBottomNav(), so a deep link, a
// refresh, a Back press or a tap through the More sheet all left the previous
// highlight in place.
if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', setActiveTab);
  // A cancelled Back (2026-09-25 phone nav polish). Back moves the hash first,
  // so the hashchange above lights the tab being left for; then the Pipelines
  // leave guard asks, and in the installed app (nbdConfirm, an async modal)
  // the answer comes later. On Cancel the guard puts the hash back with
  // replaceState, which fires no hashchange, and the Back target stayed lit
  // over Settings. The guard announces the restore with this event.
  window.addEventListener('nbd:route-restored', setActiveTab);
}


// ══════════════════════════════════════════════════════════════
//  CUSTOMIZE MODAL
// ══════════════════════════════════════════════════════════════

let _pendingTabs = [];
let _syncStatus = 'unknown';

function openCustomizeModal() {
  if (typeof closeMobileMore === 'function') closeMobileMore();

  let modal = document.getElementById('navCustomizeModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'navCustomizeModal';
    modal.className = 'modal-bg'; // required for nbdModal.open/close to resolve() it
    document.body.appendChild(modal);
  }

  _pendingTabs = loadTabs();
  _syncStatus = _firestoreReady() ? 'synced' : 'offline';
  renderModal(modal);
  document.body.style.overflow = 'hidden';

  // Prefers nbdModal (open/close + focus-lite/Esc/backdrop — dashboard.html
  // loads js/nbd-modal.js eagerly before this file). Falls back to a local
  // .open toggle + its own Esc close on pages that don't load nbd-modal.js
  // (none since the legacy twin retired 2026-09-02) — mirrors invoice-pipeline.js's openOverlay().
  if (window.nbdModal && typeof window.nbdModal.open === 'function') {
    window.nbdModal.open(modal, { onClose: function () { document.body.style.overflow = ''; } });
  } else {
    document.removeEventListener('keydown', _ncmEscFallback); // avoid double-bind on repeat opens
    document.addEventListener('keydown', _ncmEscFallback);
    modal.classList.add('open');
  }
}

function closeCustomizeModal() {
  const modal = document.getElementById('navCustomizeModal');
  if (!modal) return;
  if (window.nbdModal && typeof window.nbdModal.close === 'function') {
    window.nbdModal.close(modal);
  } else {
    modal.classList.remove('open');
    document.removeEventListener('keydown', _ncmEscFallback);
    document.body.style.overflow = '';
  }
}

// Fallback-path Esc handling (no nbdModal on this page). Mirrors
// invoice-pipeline.js's onKey: only the top-most open .modal-bg closes.
function _ncmEscFallback(e) {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('navCustomizeModal');
  if (!modal || !modal.classList.contains('open')) return;
  const opens = document.querySelectorAll('.modal-bg.open');
  if (opens.length && opens[opens.length - 1] !== modal) return;
  closeCustomizeModal();
}

function renderModal(modal) {
  const categories = {};
  TAB_REGISTRY.forEach(t => {
    if (!categories[t.category]) categories[t.category] = [];
    categories[t.category].push(t);
  });

  let poolHTML = '';
  Object.keys(categories).forEach(cat => {
    poolHTML += `<div class="ncm-pool-label">${cat}</div><div class="ncm-pool-grid">`;
    categories[cat].forEach(t => {
      const inBar = _pendingTabs.includes(t.id);
      poolHTML += `<div class="ncm-pool-item ${inBar ? 'in-bar' : ''}"
        data-tab-id="${t.id}" data-mnc-action="addTab" data-mnc-id="${t.id}">
        <span class="ncm-pool-icon">${t.icon}</span>
        <span class="ncm-pool-name">${t.label}</span>
      </div>`;
    });
    poolHTML += '</div>';
  });

  let slotsHTML = '';
  _pendingTabs.forEach((id, i) => {
    const tab = TAB_REGISTRY.find(t => t.id === id);
    if (!tab) return;
    slotsHTML += `<div class="ncm-slot" draggable="true" data-slot="${i}" data-tab-id="${id}">
      <span class="ncm-slot-num">${i+1}</span>
      <span class="ncm-slot-remove" data-mnc-action="removeTab" data-mnc-id="${i}" data-mnc-stop="1">✕</span>
      <span class="ncm-slot-icon">${tab.icon}</span>
      <span class="ncm-slot-label">${tab.label}</span>
    </div>`;
  });

  for (let i = _pendingTabs.length; i < MAX_TABS; i++) {
    slotsHTML += `<div class="ncm-slot" data-slot="${i}" style="border-style:dashed;opacity:.4;">
      <span class="ncm-slot-num">${i+1}</span>
      <span class="ncm-slot-icon" style="opacity:.3;">+</span>
      <span class="ncm-slot-label" style="opacity:.3;">Tap below</span>
    </div>`;
  }

  const syncDotClass = _syncStatus === 'synced' ? '' : _syncStatus === 'offline' ? 'offline' : 'error';
  const syncLabel = _syncStatus === 'synced' ? 'Syncs across devices'
    : _syncStatus === 'offline' ? 'Local only (not signed in)' : 'Sync error — saving locally';

  modal.innerHTML = `
    <div class="ncm-sheet" data-mnc-stop-self="1">
      <div class="ncm-handle"></div>
      <div class="ncm-head">
        <div>
          <div class="ncm-title">⚡ Customize Tab Bar</div>
          <div class="ncm-subtitle">Pick 4 tabs · drag to reorder</div>
        </div>
        <button class="ncm-close" data-mnc-action="close">✕</button>
      </div>
      <div class="ncm-sync">
        <span class="ncm-sync-dot ${syncDotClass}"></span>
        ${syncLabel}
      </div>
      <div class="ncm-current-label">YOUR TABS</div>
      <div class="ncm-current" id="ncm-slots">${slotsHTML}</div>
      <div class="ncm-pool" id="ncm-pool">${poolHTML}</div>
      <div class="ncm-actions">
        <button class="ncm-btn ncm-btn-reset" data-mnc-action="reset">Reset</button>
        <button class="ncm-btn ncm-btn-save" id="ncm-save-btn" data-mnc-action="save">Save</button>
      </div>
    </div>
  `;

  modal.onclick = function(e) { if (e.target === modal) closeCustomizeModal(); };

  // Drag/touch wiring is DELEGATED on the modal element (not inline
  // attributes — script-src-attr 'none' blocks those in prod, which is
  // why reorder was silently dead until this rewrite). The modal node
  // survives renderModal's innerHTML replacement, so bind exactly once.
  if (!modal.dataset.ncmDndBound) {
    modal.dataset.ncmDndBound = '1';
    _bindDnd(modal);
  }
}

// Resolve the .ncm-slot index for a delegated drag/touch event.
// realOnly: restrict to filled slots (data-tab-id) — placeholders only
// participate as dragover/drop targets, matching the old per-slot wiring.
function _slotIdx(ev, realOnly) {
  const slot = ev.target.closest && ev.target.closest('.ncm-slot');
  if (!slot || slot.dataset.slot === undefined) return null;
  if (realOnly && !slot.dataset.tabId) return null;
  return parseInt(slot.dataset.slot, 10);
}

function _bindDnd(modal) {
  modal.addEventListener('dragstart', function (e) {
    const i = _slotIdx(e, true); if (i !== null) _ncmDragStart(e, i);
  });
  modal.addEventListener('dragover', function (e) {
    const i = _slotIdx(e); if (i !== null) _ncmDragOver(e, i);
  });
  modal.addEventListener('drop', function (e) {
    const i = _slotIdx(e); if (i !== null) _ncmDrop(e, i);
  });
  modal.addEventListener('dragend', function (e) { _ncmDragEnd(e); });
  modal.addEventListener('touchstart', function (e) {
    const i = _slotIdx(e, true); if (i !== null) _ncmTouchStart(e, i);
  }, { passive: true });
  // touchmove preventDefaults while reordering — must be non-passive.
  modal.addEventListener('touchmove', function (e) { _ncmTouchMove(e); }, { passive: false });
  modal.addEventListener('touchend', function (e) { _ncmTouchEnd(e); });
}

function _syncPending() {
  const modal = document.getElementById('navCustomizeModal');
  if (modal) renderModal(modal);
}


// ══════════════════════════════════════════════════════════════
//  DRAG & DROP (desktop)
// ══════════════════════════════════════════════════════════════

let _dragIdx = null;

function _ncmDragStart(e, idx) {
  _dragIdx = idx;
  e.target.closest('.ncm-slot').classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}
function _ncmDragOver(e, idx) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.ncm-slot').forEach(s => s.classList.remove('drag-over'));
  e.target.closest('.ncm-slot')?.classList.add('drag-over');
}
function _ncmDrop(e, targetIdx) {
  e.preventDefault();
  if (_dragIdx === null || _dragIdx === targetIdx) return;
  if (_dragIdx < _pendingTabs.length && targetIdx < _pendingTabs.length) {
    const temp = _pendingTabs[_dragIdx];
    _pendingTabs[_dragIdx] = _pendingTabs[targetIdx];
    _pendingTabs[targetIdx] = temp;
    _syncPending();
  }
  _dragIdx = null;
}
function _ncmDragEnd(e) {
  document.querySelectorAll('.ncm-slot').forEach(s => s.classList.remove('dragging','drag-over'));
  _dragIdx = null;
}


// ══════════════════════════════════════════════════════════════
//  TOUCH REORDER (mobile)
// ══════════════════════════════════════════════════════════════

let _touchIdx = null;
let _touchStartX = 0;

function _ncmTouchStart(e, idx) {
  _touchIdx = idx;
  _touchStartX = e.touches[0].clientX;
  e.target.closest('.ncm-slot')?.classList.add('dragging');
}
function _ncmTouchMove(e) {
  if (_touchIdx !== null) e.preventDefault();
}
function _ncmTouchEnd(e) {
  if (_touchIdx === null) return;
  const endX = e.changedTouches[0].clientX;
  const diff = endX - _touchStartX;
  const slots = document.querySelectorAll('#ncm-slots .ncm-slot');
  const slotWidth = slots[0]?.offsetWidth || 80;

  if (Math.abs(diff) > slotWidth * 0.4) {
    const dir = diff > 0 ? 1 : -1;
    const targetIdx = _touchIdx + dir;
    if (targetIdx >= 0 && targetIdx < _pendingTabs.length) {
      const temp = _pendingTabs[_touchIdx];
      _pendingTabs[_touchIdx] = _pendingTabs[targetIdx];
      _pendingTabs[targetIdx] = temp;
      _syncPending();
    }
  }

  document.querySelectorAll('.ncm-slot').forEach(s => s.classList.remove('dragging'));
  _touchIdx = null;
}


// ══════════════════════════════════════════════════════════════
//  ADD / REMOVE / SAVE / RESET
// ══════════════════════════════════════════════════════════════

function _ncmAddTab(tabId) {
  if (_pendingTabs.includes(tabId)) return;
  if (_pendingTabs.length >= MAX_TABS) {
    _pendingTabs[MAX_TABS - 1] = tabId;
  } else {
    _pendingTabs.push(tabId);
  }
  _syncPending();
}

function _ncmRemoveTab(idx) {
  if (_pendingTabs.length <= 1) return;
  _pendingTabs.splice(idx, 1);
  _syncPending();
}

async function _ncmSave() {
  const btn = document.getElementById('ncm-save-btn');
  if (btn) { btn.classList.add('saving'); btn.textContent = 'Saving…'; }

  saveTabsLocal(_pendingTabs);
  renderBottomNav();

  const ok = await saveTabsFirestore(_pendingTabs);
  _syncStatus = ok ? 'synced' : (_firestoreReady() ? 'error' : 'offline');

  closeCustomizeModal();

  if (typeof showToast === 'function') {
    showToast(ok ? 'Tab bar saved & synced!' : 'Tab bar saved locally!', ok ? 'success' : 'info');
  }
}

function _ncmReset() {
  _pendingTabs = [...DEFAULT_TABS];
  _syncPending();
}



// ══════════════════════════════════════════════════════════════
//  INJECT "CUSTOMIZE TABS" INTO MORE MENU
// ══════════════════════════════════════════════════════════════

function addCustomizeToMoreMenu() {
  const moreMenu = document.getElementById('mobile-more-menu');
  if (!moreMenu || moreMenu.querySelector('.mm-item-customize')) return;

  const item = document.createElement('div');
  item.className = 'mm-item mm-item-customize';
  item.onclick = function() { openCustomizeModal(); };
  item.innerHTML = '<span class="mm-item-icon">⚡</span>Customize Tab Bar';
  moreMenu.appendChild(item);
}

function addCustomizeToSettings() {
  const panel = document.getElementById('stab-panel-appearance');
  if (!panel || panel.querySelector('#ncm-settings-panel')) return;

  const currentTabs = loadTabs();
  const tabLabels = currentTabs.map(id => {
    const t = TAB_REGISTRY.find(r => r.id === id);
    return t ? t.icon + ' ' + t.label : id;
  }).join('  →  ');

  const section = document.createElement('div');
  section.id = 'ncm-settings-panel';
  section.className = 'panel';
  section.style.marginBottom = '16px';
  section.innerHTML = `
    <div class="panel-hdr"><div><div class="panel-label">Navigation</div><div class="panel-title">Mobile Tab Bar</div></div></div>
    <div class="panel-body">
      <p style="font-size:12px;color:var(--m);margin-bottom:12px;">Choose which 4 tabs appear in your bottom navigation bar.</p>
      <div style="font-size:12px;color:var(--t);margin-bottom:14px;padding:10px 12px;background:var(--s2);border-radius:8px;border:1px solid var(--br);">
        <div style="font-size:9px;text-transform:uppercase;letter-spacing:.1em;color:var(--m);font-weight:700;margin-bottom:6px;font-family:'Barlow Condensed',sans-serif;">Current Layout</div>
        ${tabLabels}
      </div>
      <button class="btn btn-ghost" style="width:100%;justify-content:center;font-size:12px;padding:10px 14px;" data-mnc-action="openCustomizer">
        ⚡ Customize Tab Bar
      </button>
    </div>
  `;

  // Insert at the top of the appearance panel
  panel.insertBefore(section, panel.firstChild);
}


// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

function init() {
  injectCSS();
  renderBottomNav();
  addCustomizeToMoreMenu();
  addCustomizeToSettings();

  // Background Firestore sync once auth is ready
  if (window.auth && window._onAuthStateChanged) {
    window._onAuthStateChanged(window.auth, user => {
      if (user) setTimeout(() => syncFromFirestore(), 800);
    });
  } else {
    const poll = setInterval(() => {
      if (window.auth?.currentUser && _firestoreReady()) {
        clearInterval(poll);
        syncFromFirestore();
      }
    }, 1000);
    setTimeout(() => clearInterval(poll), 10000);
  }

}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// The Appearance panel (#stab-panel-appearance) lives in the lazily-hydrated
// <template id="tpl-view-settings">, so addCustomizeToSettings() at init() (DCL)
// finds nothing and the "Mobile Tab Bar" section never appears. Wrap
// switchSettingsTab (same idiom as dashboard-team-tab.js) to (re)inject the
// panel the first time Settings → Appearance opens, after the template hydrates.
function _installAppearanceTabHook() {
  var _prev = window.switchSettingsTab;
  if (typeof _prev !== 'function' || _prev._ncmWrapped) return;
  var wrapped = function (tab) {
    var r = _prev.apply(this, arguments);
    if (tab === 'appearance') { try { addCustomizeToSettings(); } catch (e) { /* panel not ready */ } }
    return r;
  };
  wrapped._ncmWrapped = true;
  window.switchSettingsTab = wrapped;
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _installAppearanceTabHook);
} else {
  _installAppearanceTabHook();
}


// ── CSP-safe delegation for the data-mnc-action attrs. Lives INSIDE the
// module IIFE since the Tranche 2a rewrite: the handlers are module-local
// now (no window.* hop), which is the whole reason they used to be
// exported. mobileNav/toggleMobileMore stay bare cross-file lookups.
if (!_delegateBound) {
  _delegateBound = true;
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-mnc-action]');
    if (!t) return;
    if (t.dataset.mncStop === '1') ev.stopPropagation();
    const action = t.dataset.mncAction;
    const id = t.dataset.mncId;
    try {
      switch (action) {
        case 'mobileNav':     if (typeof mobileNav === 'function') mobileNav(id); break;
        case 'create': {
          // mCreateFabRoute was consolidated OFF window into
          // __NBD_CALL_REGISTRY (Tranche 2c-4c) — registry is the ONLY
          // resolution path (window.<name> is denylisted by the tranche-0
          // smoke pin).
          const reg = window.__NBD_CALL_REGISTRY;
          const fn = reg && reg.mCreateFabRoute;
          if (typeof fn === 'function') fn();
          break;
        }
        case 'toggleMore':    if (typeof toggleMobileMore === 'function') toggleMobileMore(); break;
        case 'addTab':        _ncmAddTab(id); break;
        case 'removeTab':     _ncmRemoveTab(parseInt(id, 10)); break;
        case 'close':         closeCustomizeModal(); break;
        case 'reset':         _ncmReset(); break;
        case 'save':          _ncmSave(); break;
        case 'openCustomizer': openCustomizeModal(); break;
        default: console.warn('[mobile-nav-customizer] no dispatch for', action);
      }
    } catch (e) { console.error('[mobile-nav-customizer] dispatch ' + action + ' failed:', e); }
  });
}

})();
