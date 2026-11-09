        // ── Sidebar Customizer ──
        // Toggle nav items on/off. Persisted to localStorage.
        // The sidebar re-renders on boot from the saved state.
        var SIDEBAR_ITEMS = [
          { id:'nav-dash', label:'Dashboard', icon:'📊', alwaysOn:true },
          { id:'nav-crm', label:'Pipeline', icon:'👥', alwaysOn:true },
          { id:'nav-prospects', label:'Prospects', icon:'👀' },
          { id:'nav-est', label:'Estimates', icon:'📋' },
          { id:'nav-d2d', label:'Door-to-Door', icon:'🚪' },
          { id:'nav-photos', label:'Photos', icon:'📸' },
          { id:'nav-docs', label:'Templates', icon:'📁' },
          { id:'nav-products', label:'Products', icon:'📦' },
          { id:'nav-draw', label:'Drawing', icon:'✏️' },
          { id:'nav-training', label:'Sales Training', icon:'🎯' },
          { id:'nav-academy', label:'Academy', icon:'🎓' },
          { id:'nav-board', label:'Leaderboard', icon:'🏆' },
          { id:'nav-reports', label:'Reports', icon:'📈' },
          { id:'nav-storm', label:'Storm Watch', icon:'⛈️' },
          { id:'nav-closeboard', label:'Close Board', icon:'📋' },
          { id:'nav-repos', label:'Rep OS', icon:'🧠' },
          { id:'nav-joe', label:'Ask Joe AI', icon:'🤖', alwaysOn:true },
          { id:'nav-aitree', label:'Decision Engine', icon:'⚡' },
          { id:'nav-understand', label:'Deep Dive', icon:'🔬' },
          { id:'nav-projectcodex', label:'Project Intel', icon:'📋' },
          { id:'nav-aiusage', label:'AI Usage', icon:'📊' },
          { id:'nav-settings', label:'Settings', icon:'⚙️', alwaysOn:true }
        ];

        function getSidebarHidden() {
          try { return JSON.parse(localStorage.getItem('nbd_sidebar_hidden') || '[]'); } catch(e) { return []; }
        }

        // Hardening 2026-06-09: the checkbox row used an inline onchange
        // attribute, but the /pro/ CSP ships script-src-attr 'none' — the
        // browser silently drops inline handler attributes, so every
        // checkbox in this grid was a dead control from the moment PR #597
        // made the renderer live. Migrated to the data-on-change delegate
        // (dashboard-ui.js), same shape as dashboard-hotkey-toggles.js.
        // The delegate passes (checked, navId); checked means "item
        // visible". Set-state rather than blind-flip so the stored pref
        // always agrees with the checkbox the user actually clicked.
        // Name must stay on _NBD_CALL_ALLOWLIST (dashboard-state.js).
        function toggleSidebarItem(on, navId) {
          var hidden = getSidebarHidden();
          var idx = hidden.indexOf(navId);
          if (on && idx >= 0) hidden.splice(idx, 1);
          else if (!on && idx < 0) hidden.push(navId);
          localStorage.setItem('nbd_sidebar_hidden', JSON.stringify(hidden));
          applySidebarCustomizer();
          renderSidebarCustomizerGrid();
        }

        function applySidebarCustomizer() {
          var hidden = getSidebarHidden();
          SIDEBAR_ITEMS.forEach(function(item) {
            var el = document.getElementById(item.id);
            if (el) el.style.display = hidden.includes(item.id) ? 'none' : '';
          });
        }

        function renderSidebarCustomizerGrid() {
          var grid = document.getElementById('sidebarCustomizerGrid');
          if (!grid) return;
          var hidden = getSidebarHidden();
          grid.innerHTML = SIDEBAR_ITEMS.map(function(item) {
            var isHidden = hidden.includes(item.id);
            var isLocked = item.alwaysOn;
            return '<label style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--s2);border:1px solid ' + (isHidden ? 'var(--br)' : 'var(--orange)') + ';border-radius:6px;cursor:' + (isLocked ? 'not-allowed' : 'pointer') + ';opacity:' + (isHidden ? '.5' : '1') + ';transition:all .15s;">'
              + '<input type="checkbox" ' + (isHidden ? '' : 'checked') + ' ' + (isLocked ? 'disabled' : '') + ' data-on-change="toggleSidebarItem" data-on-pass="checked" data-on-arg="' + item.id + '" style="accent-color:var(--orange);width:16px;height:16px;">'
              + '<span class="fs-14">' + item.icon + '</span>'
              + '<span style="font-size:12px;color:var(--t);font-weight:600;">' + item.label + '</span>'
              + (isLocked ? '<span style="font-size:9px;color:var(--m);margin-left:auto;">Required</span>' : '')
              + '</label>';
          }).join('');
        }

        function resetSidebarCustomizer() {
          localStorage.removeItem('nbd_sidebar_hidden');
          applySidebarCustomizer();
          renderSidebarCustomizerGrid();
          if (typeof showToast === 'function') showToast('Sidebar reset to default', 'info');
        }

        // Apply on boot + render when settings opens.
        // readyState guard (hardening 2026-06-09): this script ships inside
        // the lazily-hydrated tpl-view-settings template and executes at
        // hydration, AFTER DOMContentLoaded has fired — the previous bare
        // listener never ran, so saved hidden-item prefs were not applied
        // until the first checkbox click. Same trap/idiom as the hook below.
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', applySidebarCustomizer);
        } else {
          applySidebarCustomizer();
        }
        // Hook into settings tab switch. The base switchSettingsTab is
        // defined in deferred js/ui.js, which loads AFTER this inline
        // script. Wait for DOMContentLoaded (fires after all defer
        // scripts execute per HTML spec) so the wrapper installs over
        // a real base, not undefined. Without this, the guard below
        // silently skipped the wrapper and the sidebar-customizer grid
        // never re-rendered when reopening Appearance.
        // readyState guard: this script ships inside the lazily-hydrated
        // tpl-view-settings template and is re-executed at hydration, AFTER
        // DOMContentLoaded has fired — a bare listener never installs the
        // wrapper (same trap as dashboard-team-tab.js / dashboard-billing-tab.js).
        function _nbdInstallSidebarHook() {
          var _prev3 = window.switchSettingsTab;
          if (typeof _prev3 !== 'function') return;
          window.switchSettingsTab = function(tab) {
            _prev3(tab);
            if (tab === 'appearance') renderSidebarCustomizerGrid();
          };
          // Deep link (#/settings/appearance) opened the tab before this
          // script loaded: render now (same race as dashboard-team-tab.js).
          var _on = document.getElementById('stab-appearance');
          if (_on && _on.classList.contains('stab-active')) renderSidebarCustomizerGrid();
        }
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', _nbdInstallSidebarHook);
        } else {
          _nbdInstallSidebarHook();
        }
