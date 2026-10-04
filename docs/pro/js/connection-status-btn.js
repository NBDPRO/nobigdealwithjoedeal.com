// ══════════════════════════════════════════════════════════════
// NBD PRO — CONNECTION STATUS BUTTON
// Subtle status indicator in header icon row
// Green = online + connected, Yellow = loading, Red = offline/error
// Tap to refresh CRM data
// ══════════════════════════════════════════════════════════════

(function() {
'use strict';

// ── CSS ──────────────────────────────────────────────────────
function injectCSS() {
  if (document.getElementById('nbd-conn-btn-css')) return;
  const style = document.createElement('style');
  style.id = 'nbd-conn-btn-css';
  style.textContent = `

#nbd-conn-btn {
  background:transparent;
  border:none;
  /* A <button> with no color of its own paints the UA's buttontext — black —
     so the ↻ beside the status dot was invisible on the always-dark header
     in BOTH modes (1.08:1 dark, 1.13:1 light; phone audit views#11,
     2026-09-25). The bar is a fixed near-black (dashboard-app.css header),
     so the glyph gets the same fixed light ink the rest of the chrome uses;
     its own opacity:.5 keeps it the quiet secondary cue it was drawn as. */
  color:#e8eaf0;
  cursor:pointer;
  font-size:15px;
  padding:4px 6px;
  transition:color .15s, transform .15s;
  line-height:1;
  position:relative;
  -webkit-tap-highlight-color:transparent;
  display:flex;
  align-items:center;
  justify-content:center;
}
#nbd-conn-btn:active {
  transform:scale(.88);
}
/* Phones (2026-10-03): the button measured 31x19 — a dot and a 11px ↻ —
   in a header where every neighbour is 40-44px. 44x44 like them; the
   glyphs stay centred and the same size. */
@media (max-width:768px), (pointer:coarse) {
  #nbd-conn-btn { min-width:44px; min-height:44px; padding:0 4px; }
}

/* The dot indicator */
.conn-dot {
  width:8px;
  height:8px;
  border-radius:50%;
  transition:background .3s, box-shadow .3s;
}

/* States */
.conn-dot.online {
  background:var(--green);
  box-shadow:0 0 6px rgba(16,185,129,.5);
}
.conn-dot.loading {
  background:var(--gold);
  box-shadow:0 0 6px rgba(251,191,36,.4);
  animation:conn-pulse 1.4s ease-in-out infinite;
}
.conn-dot.offline {
  background:var(--red);
  box-shadow:0 0 6px rgba(239,68,68,.4);
  animation:conn-pulse 1.4s ease-in-out infinite;
}

@keyframes conn-pulse {
  0%,100% { opacity:1; transform:scale(1); }
  50%     { opacity:.5; transform:scale(.85); }
}

/* Spin animation on refresh tap */
#nbd-conn-btn.refreshing .conn-dot {
  animation:conn-spin .6s ease;
}
@keyframes conn-spin {
  from { transform:rotate(0deg); }
  to   { transform:rotate(360deg); }
}

/* Tooltip on hover (desktop) */
#nbd-conn-btn::after {
  content:attr(data-tooltip);
  position:absolute;
  top:calc(100% + 6px);
  left:50%;
  transform:translateX(-50%);
  background:var(--s, #111318);
  border:1px solid var(--br, #1e2530);
  color:var(--t, #e8eaf0);
  font-family:'Barlow Condensed',sans-serif;
  font-size:10px;
  font-weight:600;
  letter-spacing:.04em;
  white-space:nowrap;
  padding:4px 10px;
  border-radius:6px;
  pointer-events:none;
  opacity:0;
  transition:opacity .15s;
  z-index:var(--z-overlay-top);
}
#nbd-conn-btn:hover::after {
  opacity:1;
}
@media (max-width:768px) {
  #nbd-conn-btn::after { display:none; }
}

  `;
  document.head.appendChild(style);
}


// ── STATE ────────────────────────────────────────────────────
let _status = 'loading'; // 'online' | 'loading' | 'offline'
let _refreshing = false;


// ── CREATE & INSERT BUTTON ───────────────────────────────────
function createButton() {
  if (document.getElementById('nbd-conn-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'nbd-conn-btn';
  btn.setAttribute('data-tooltip', 'Checking connection…');
  btn.title = 'Tap to refresh / sync data';
  btn.innerHTML = '<span class="conn-dot loading"></span><span style="font-size:11px;margin-left:2px;opacity:.5;transition:opacity .15s;">↻</span>';
  btn.onmouseenter = function() { btn.querySelector('span:last-child').style.opacity = '1'; };
  btn.onmouseleave = function() { btn.querySelector('span:last-child').style.opacity = '.5'; };
  btn.onclick = handleTap;

  // Find the header icon row — it's the div with gap:4px inside .hright
  const iconRow = document.querySelector('.hright > div');
  if (iconRow) {
    // Insert as the first button in the row (before 🕒)
    const firstBtn = iconRow.querySelector('div, button');
    if (firstBtn) {
      iconRow.insertBefore(btn, firstBtn);
    } else {
      iconRow.appendChild(btn);
    }
  }
}


// ── UPDATE STATUS ────────────────────────────────────────────
function updateStatus(newStatus, tooltip) {
  _status = newStatus;
  const btn = document.getElementById('nbd-conn-btn');
  if (!btn) return;

  const dot = btn.querySelector('.conn-dot');
  if (dot) {
    dot.className = 'conn-dot ' + newStatus;
  }
  if (tooltip) {
    btn.setAttribute('data-tooltip', tooltip);
  }
}


// ── DETERMINE STATUS ─────────────────────────────────────────
// Watchdog: when we see `loading` for the first time, stamp the
// timestamp. If we keep seeing it past STUCK_LOADING_MS without
// transitioning to healthy/error, force the status to 'offline' so
// the user gets a tappable retry instead of an indefinite yellow dot.
let _loadingSince = 0;
const STUCK_LOADING_MS = 30_000; // 10s timeout + retry + buffer

function checkStatus() {
  // Check browser online status first
  if (!navigator.onLine) {
    _loadingSince = 0;
    updateStatus('offline', 'Offline — tap to retry');
    return;
  }

  // Check CRM health badge if it exists
  const healthBadge = document.getElementById('crmHealthBadge');
  if (healthBadge) {
    if (healthBadge.classList.contains('healthy')) {
      _loadingSince = 0;
      const leadCount = window._leads?.length || 0;
      updateStatus('online', `Connected · ${leadCount} leads`);
    } else if (healthBadge.classList.contains('loading')) {
      // Watchdog: if we've been "loading" longer than the timeout,
      // assume the load silently hung and surface a retry affordance.
      if (!_loadingSince) _loadingSince = Date.now();
      const stuckFor = Date.now() - _loadingSince;
      if (stuckFor > STUCK_LOADING_MS) {
        updateStatus('offline', 'Connection stuck — tap to retry');
      } else {
        updateStatus('loading', 'Syncing data…');
      }
    } else if (healthBadge.classList.contains('error')) {
      _loadingSince = 0;
      updateStatus('offline', 'Connection error — tap to retry');
    } else {
      // Default: check if we have auth
      _loadingSince = 0;
      if (window.auth?.currentUser) {
        updateStatus('online', 'Connected');
      } else {
        updateStatus('loading', 'Authenticating…');
      }
    }
  } else {
    // No health badge — just use navigator.onLine + auth
    if (window.auth?.currentUser) {
      _loadingSince = 0;
      updateStatus('online', 'Connected');
    } else {
      updateStatus('loading', 'Connecting…');
    }
  }
}


// ── TAP TO REFRESH ───────────────────────────────────────────
async function handleTap() {
  if (_refreshing) return;
  _refreshing = true;

  const btn = document.getElementById('nbd-conn-btn');
  if (btn) btn.classList.add('refreshing');

  // Reset the stuck-loading watchdog clock — the user is explicitly
  // asking for a fresh attempt; give the new load a clean window
  // before we start counting against the stuck-loading threshold.
  _loadingSince = Date.now();
  updateStatus('loading', 'Refreshing…');

  try {
    // Try to call loadLeads if exposed (it's inside the module scope,
    // so we trigger it by re-dispatching the auth state).
    //
    // Bug fix 2026-05-05: dashboard.html exposes these as `window._loadLeads`
    // and `window._loadEstimates` (with the underscore prefix used elsewhere
    // in the codebase). The previous version of this handler checked for
    // the non-underscore names which never existed — so tapping the refresh
    // dot did nothing, and a stuck loading badge stayed yellow forever.
    // We try the underscore-prefixed names first (current convention),
    // then fall through to the non-underscore names for forward-compat.
    const loadLeadsFn = (typeof window._loadLeads === 'function')
      ? window._loadLeads
      : (typeof window.loadLeads === 'function' ? window.loadLeads : null);
    const loadEstFn = (typeof window._loadEstimates === 'function')
      ? window._loadEstimates
      : (typeof window.loadEstimates === 'function' ? window.loadEstimates : null);

    if (window.auth?.currentUser && window.db) {
      // Method 1: Direct reload via exposed functions
      if (loadLeadsFn) {
        await loadLeadsFn();
      }
      if (loadEstFn) {
        await loadEstFn();
      }

      // Method 2: If neither loader is exposed, do a quick Firestore ping
      // to verify connectivity + nudge the health badge.
      if (!loadLeadsFn && window.getDoc && window.doc) {
        try {
          await window.getDoc(window.doc(window.db, 'users', window.auth.currentUser.uid));
        } catch(e) {}
      }
    }

    // Brief delay then recheck
    await new Promise(r => setTimeout(r, 500));
    checkStatus();

  } catch(e) {
    updateStatus('offline', 'Refresh failed — tap to retry');
  }

  if (btn) btn.classList.remove('refreshing');
  _refreshing = false;
}


// ── OBSERVE HEALTH BADGE CHANGES ─────────────────────────────
function watchHealthBadge() {
  const healthBadge = document.getElementById('crmHealthBadge');
  if (!healthBadge) return;

  const observer = new MutationObserver(() => checkStatus());
  observer.observe(healthBadge, { attributes: true, attributeFilter: ['class'] });
}


// ── INIT ─────────────────────────────────────────────────────
function init() {
  injectCSS();
  createButton();

  // Listen for online/offline events
  window.addEventListener('online', () => {
    checkStatus();
    // Auto-refresh on reconnect
    setTimeout(() => handleTap(), 300);
  });
  window.addEventListener('offline', () => {
    updateStatus('offline', 'Offline — tap to retry');
  });

  // Initial status check
  checkStatus();

  // Watch the CRM health badge for class changes
  watchHealthBadge();

  // Poll periodically in case health badge updates outside MutationObserver
  setInterval(checkStatus, 10000);

  // Also check once auth settles
  if (window.auth && window._onAuthStateChanged) {
    window._onAuthStateChanged(window.auth, user => {
      setTimeout(checkStatus, 1000);
    });
  } else {
    // Fallback poll for auth
    const poll = setInterval(() => {
      if (window.auth?.currentUser) {
        clearInterval(poll);
        checkStatus();
        watchHealthBadge();
      }
    }, 1000);
    setTimeout(() => clearInterval(poll), 15000);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
