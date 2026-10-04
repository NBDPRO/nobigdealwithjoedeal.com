/* ── NBD NAV CONFIG ─────────────────────────────────────────────
   Change position here or wire to a settings page later.
   Options: 'top' | 'bottom' | 'dock'
   ─────────────────────────────────────────────────────────────── */
const NBD_NAV_CONFIG = {
  position: 'top',      // 'top' | 'bottom' | 'dock'
  activeColor: '#BD5728',
  showLabels: true,
};

(function nbdNavInit() {
  // Apply position
  const nav = document.getElementById('nbd-pro-nav');
  if (NBD_NAV_CONFIG.position !== 'top') {
    nav.classList.add('pos-' + NBD_NAV_CONFIG.position);
    nav.style.position = 'fixed';
    if (NBD_NAV_CONFIG.position === 'bottom' || NBD_NAV_CONFIG.position === 'dock') {
      document.body.style.paddingBottom = '68px';
      document.body.style.paddingTop = '0';
    }
  }

  // Mark active page
  const path = window.location.pathname;
  const pageMap = {
    '/pro/': 'home',
    '/pro/dashboard.html': 'dashboard',
    '/pro/daily-success/': 'daily-success',
    '/pro/daily-success/index.html': 'daily-success',
    '/pro/ai-tree.html': 'ai-tree',
    '/pro/ai-tool-finder.html': 'codex',
    '/pro/understand.html': 'understand',
    '/pro/demo.html': 'demo',
  };
  const activePage = pageMap[path] || '';
  document.querySelectorAll('.nnav-link[data-page], .nnav-drawer-link[data-page]').forEach(el => {
    if (el.dataset.page === activePage) el.classList.add('active');
  });

  // Auth state — use modular NBDAuth (v10 SDK) instead of legacy compat API
  (async () => {
    try {
      // Wait for NBDAuth to initialize
      for (let i = 0; i < 50; i++) {
        if (window._auth || window.NBDAuth) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const { onAuthStateChanged, signOut } = await import('/assets/vendor/firebase/12.19.0/firebase-auth.js');
      const auth = window._auth;
      if (!auth) return;
      onAuthStateChanged(auth, user => {
        const btn = document.getElementById('nnav-auth-btn');
        const drawerBtn = document.getElementById('nnav-drawer-auth-btn');
        const userLabel = document.getElementById('nnav-user-label');
        const drawerUser = document.getElementById('nnav-drawer-user');
        if (user) {
          const name = user.displayName || user.email?.split('@')[0] || 'Member';
          if (userLabel) userLabel.textContent = name;
          if (drawerUser) drawerUser.textContent = '● ' + (user.email || name);
          if (btn) { btn.textContent = 'Logout'; btn.classList.add('logout'); btn.href = '#'; btn.onclick = e => { e.preventDefault(); signOut(auth); }; }
          if (drawerBtn) { drawerBtn.textContent = 'Logout'; drawerBtn.classList.add('logout'); drawerBtn.href = '#'; drawerBtn.onclick = e => { e.preventDefault(); signOut(auth); }; }
        } else {
          if (userLabel) userLabel.textContent = '';
          if (drawerUser) drawerUser.textContent = '';
        }
      });
    } catch(e) {}
  })();
})();

function nbdNavToggle() {
  const drawer = document.getElementById('nbd-nav-drawer');
  const burger = document.getElementById('nnav-burger');
  const open = drawer.classList.toggle('open');
  burger.style.opacity = open ? '0.6' : '1';
  document.body.style.overflow = open ? 'hidden' : '';
}

// Close drawer on link click
document.querySelectorAll('.nnav-drawer-link').forEach(l => {
  l.addEventListener('click', () => {
    document.getElementById('nbd-nav-drawer').classList.remove('open');
    document.body.style.overflow = '';
  });
});

// Close on outside click
document.addEventListener('click', e => {
  const drawer = document.getElementById('nbd-nav-drawer');
  const burger = document.getElementById('nnav-burger');
  const nav = document.getElementById('nbd-pro-nav');
  if (drawer.classList.contains('open') && !nav.contains(e.target) && !drawer.contains(e.target)) {
    drawer.classList.remove('open');
    document.body.style.overflow = '';
  }
});

window.nbdNavToggle = nbdNavToggle;
