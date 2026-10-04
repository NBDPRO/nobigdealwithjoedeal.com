/**
 * command-palette.js — Cmd+K command palette for NBD Pro (W133)
 *
 * The keyboard-first sequel to the Whisper voice arc. Hit Cmd+K
 * (Mac) / Ctrl+K (Windows/Linux) — or `/` when no input is focused
 * — to open a fuzzy-search overlay. Type to filter across leads,
 * actions, and views. Arrow keys + Enter to execute.
 *
 * Sources (priority order):
 *   1. Recent items — last 8 selections from this device
 *   2. Built-in actions — navigation + common commands
 *   3. Leads — name + address from window._leads cache
 *
 * Public API:
 *   window.NBDCommand.open()
 *   window.NBDCommand.close()
 *   window.NBDCommand.registerAction({ id, label, icon, run, keywords, group })
 *   window.NBDCommand.unregisterAction(id)
 *
 * Other modules can drop their own commands via registerAction —
 * e.g. Whisper can register "Start dictation" as a palette entry,
 * Quick Capture can register "Open captures inbox", etc.
 */

(function () {
  'use strict';
  if (window.NBDCommand && window.NBDCommand.__sentinel === 'nbd-cmd-v1') return;

  const MODAL_ID = 'nbd-cmd-modal';
  const RECENT_KEY = 'nbd_cmd_recent_v1';
  const RECENT_MAX = 8;
  const RESULTS_LIMIT = 12;

  // ─── Built-in actions ───────────────────────────────────────────
  // Each action is { id, label, icon, group, keywords, run }.
  // The id is stable so localStorage recents survive across sessions.
  const BUILTIN_ACTIONS = [
    // Navigation — most common views first
    { id: 'go-home',       label: 'Home',                 icon: '🏠', group: 'Navigation', keywords: 'overview dashboard', run: () => _goTo('home') },
    { id: 'go-crm',        label: 'CRM Kanban',           icon: '📋', group: 'Navigation', keywords: 'leads pipeline kanban customers', run: () => _goTo('crm') },
    { id: 'go-est',        label: 'Estimates',            icon: '📄', group: 'Navigation', keywords: 'quotes proposals invoices estimate', run: () => _goTo('est') },
    { id: 'go-d2d',        label: 'D2D Tracker',          icon: '🚪', group: 'Navigation', keywords: 'door to door knock map prospects', run: () => _goTo('d2d') },
    { id: 'go-prospects',  label: 'Prospects',            icon: '🎯', group: 'Navigation', keywords: 'cold leads new', run: () => _goTo('prospects') },
    { id: 'go-map',        label: 'Map',                  icon: '🗺️',  group: 'Navigation', keywords: 'territory routing knock', run: () => _goTo('map') },
    { id: 'go-schedule',   label: 'Schedule',             icon: '📅', group: 'Navigation', keywords: 'calendar appointments inspections', run: () => _goTo('schedule') },
    { id: 'go-photos',     label: 'Photo Library',        icon: '📸', group: 'Navigation', keywords: 'images damage gallery', run: () => _goTo('photos') },
    { id: 'go-joe',        label: 'Ask Joe (AI)',         icon: '🤖', group: 'Navigation', keywords: 'ai chat assistant claude help', run: () => _goTo('joe') },
    { id: 'go-storm',      label: 'Storm Tracker',        icon: '🌩️',  group: 'Navigation', keywords: 'weather hail wind', run: () => _goTo('storm') },
    { id: 'go-closeboard', label: 'Close Board',          icon: '💰', group: 'Navigation', keywords: 'goals revenue commission close', run: () => _goTo('closeboard') },
    { id: 'go-reports',    label: 'Reports',              icon: '📊', group: 'Navigation', keywords: 'analytics metrics kpi', run: () => _goTo('reports') },
    { id: 'go-products',   label: 'Products',             icon: '🏗️',  group: 'Navigation', keywords: 'catalog pricing materials', run: () => _goTo('products') },
    { id: 'go-job-templates', label: 'Job Templates',     icon: '🧰', group: 'Navigation', keywords: 'quote job template repair estimate prebuilt library', run: () => _goTo('job-templates') },
    { id: 'go-docs',       label: 'Docs',                 icon: '📑', group: 'Navigation', keywords: 'documents contracts certificates warranties', run: () => _goTo('docs') },
    { id: 'go-academy',    label: 'Academy',              icon: '🎓', group: 'Navigation', keywords: 'training education courses', run: () => _goTo('academy') },
    { id: 'go-training',   label: 'Sales Training',       icon: '🥋', group: 'Navigation', keywords: 'sales practice scenarios', run: () => _goTo('training') },
    { id: 'go-aitree',     label: 'AI Tree',              icon: '🌳', group: 'Navigation', keywords: 'decision flowchart insurance claim', run: () => _goTo('aitree') },
    { id: 'go-settings',   label: 'Settings',             icon: '⚙️',  group: 'Navigation', keywords: 'preferences profile account', run: () => _goTo('settings') },

    // Voice / capture
    { id: 'voice-dictate', label: 'Start Dictation',      icon: '🎤', group: 'Voice', keywords: 'whisper microphone talk record', run: () => {
        if (window.NBDWhisper && window.NBDWhisper.start) window.NBDWhisper.start();
        else _toast('Whisper not loaded yet.');
      } },
    { id: 'voice-capture', label: 'Quick Capture',        icon: '🎙', group: 'Voice', keywords: 'scratchpad note brain dump record', run: () => {
        if (window.NBDQuickCapture && window.NBDQuickCapture.open) window.NBDQuickCapture.open();
        else _toast('Quick Capture not loaded yet.');
      } },
    { id: 'voice-inbox',   label: 'Capture Inbox',         icon: '📋', group: 'Voice', keywords: 'past captures history archive', run: () => {
        if (window.NBDQuickCaptureInbox && window.NBDQuickCaptureInbox.open) window.NBDQuickCaptureInbox.open();
        else _toast('Capture inbox not loaded yet.');
      } },

    // Actions
    { id: 'action-new-lead',  label: 'New Lead',          icon: '➕', group: 'Actions', keywords: 'create add prospect customer', run: () => {
        // The real global is openLeadModal (crm.js). openNewLeadModal never
        // existed, so "New Lead" only ever navigated to the board.
        if (typeof window.openLeadModal === 'function') window.openLeadModal();
        else _goTo('crm');
      } },
    { id: 'action-new-est',   label: 'New Estimate',      icon: '📝', group: 'Actions', keywords: 'create proposal quote', run: () => _goTo('est') },
    { id: 'action-refresh',   label: 'Reload App',        icon: '🔁', group: 'Actions', keywords: 'refresh reload', run: () => location.reload() },
    { id: 'action-logout',    label: 'Sign Out',          icon: '🚪', group: 'Actions', keywords: 'log out signout exit', run: () => {
        if (typeof window._signOut === 'function' && window.auth) {
          window._signOut(window.auth);
        } else if (typeof window.signOut === 'function') {
          try { window.signOut(); }
          catch (e) {
            console.error('[command-palette] signOut failed:', e);
            if (typeof window.showToast === 'function') {
              window.showToast('Sign-out failed — try refreshing the page.', 'error');
            }
          }
        } else if (window.auth) {
          // Neither sign-out global exists on this page — customer.html exposes
          // window.auth but no signOut helper, so this row used to close the
          // palette and do nothing at all. Sign-out is the one action a rep must
          // never be silently stuck on.
          //
          // Import the SDK's signOut directly (same CDN pin the rest of the app
          // uses) so this genuinely ends the session rather than just navigating
          // away and leaving the rep signed in — which is what a bare redirect
          // to /pro/login.html would do; that page has no sign-out handling.
          //
          // Queued offline texts (homeowner numbers + message text in
          // IndexedDB, sms-outbox.js — customer.html loads it) are purged
          // FIRST, like the dashboard's _signOut does: this path never reached
          // nbd-auth.js's purge, so they outlived the session. Bounded, so a
          // stuck purge cannot keep the rep signed in.
          const ob = window.NBDSmsOutbox;
          const purge = (ob && typeof ob.purgeAll === 'function')
            ? Promise.race([
              Promise.resolve().then(() => ob.purgeAll()).catch(() => false),
              new Promise((r) => setTimeout(() => r(false), 2000)),
            ])
            : Promise.resolve(false);
          purge
            .then(() => import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'))
            .then((m) => m.signOut(window.auth))
            .then(() => { window.location.href = '/pro/login.html'; })
            .catch((e) => {
              console.error('[command-palette] signOut failed:', e);
              if (typeof window.showToast === 'function') {
                window.showToast('Sign-out failed — try refreshing the page.', 'error');
              }
            });
        }
      } },
  ];

  // Custom actions registered by other modules at runtime.
  const _custom = new Map();

  // ─── State ──────────────────────────────────────────────────────
  let _selectedIndex = 0;
  let _currentResults = [];

  // ─── Utility ────────────────────────────────────────────────────
  // window.goTo is a DASHBOARD global — it switches the SPA view in place. This
  // palette is also loaded on customer.html, which defines no such function, so
  // every Navigation row there did nothing at all: the palette closed, no view
  // changed, no toast, no error. Nineteen rows plus New Lead and Sign Out, all
  // inert, on a page where the rep has no other way to reach them.
  //
  // Falling back to a real page load rather than deleting the palette from
  // customer.html: its lead search is genuinely useful there, and a hard
  // navigation is exactly what a rep pressing Enter on "Estimates" wants.
  function _goTo(name, params) {
    if (typeof window.goTo === 'function') {
      try { window.goTo(name, params || {}); return; }
      catch (e) { console.warn('[NBDCommand] goTo failed:', e); }
    }
    // Not on the dashboard — the view router does not exist here.
    try {
      window.location.href = '/pro/dashboard.html#' + encodeURIComponent(String(name || ''));
    } catch (e) {
      console.warn('[NBDCommand] navigation fallback failed:', e);
    }
  }
  function _toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'info');
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Recent-items persistence — small list of action ids.
  function _readRecents() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.slice(0, RECENT_MAX) : [];
    } catch (_) { return []; }
  }
  function _bumpRecent(id) {
    if (!id) return;
    try {
      const cur = _readRecents().filter(x => x !== id);
      cur.unshift(id);
      localStorage.setItem(RECENT_KEY, JSON.stringify(cur.slice(0, RECENT_MAX)));
    } catch (_) {}
  }

  // ─── Fuzzy match (simple) ───────────────────────────────────────
  // Score: prefix-match wins, then substring, then word-start.
  // 0 means no match. Higher = better.
  function _score(query, label, keywords) {
    if (!query) return 1; // empty query — everything passes with neutral score
    const q = query.toLowerCase().trim();
    const l = String(label || '').toLowerCase();
    const k = String(keywords || '').toLowerCase();

    if (l.startsWith(q)) return 100;
    if (l.includes(q)) return 60;
    if (k.includes(q)) return 40;

    // Token-prefix match: "ne le" → "New Lead"
    const qTokens = q.split(/\s+/).filter(Boolean);
    const targetTokens = (l + ' ' + k).split(/\s+/).filter(Boolean);
    let prefixHits = 0;
    for (const qt of qTokens) {
      if (targetTokens.some(tt => tt.startsWith(qt))) prefixHits++;
    }
    if (prefixHits === qTokens.length && qTokens.length > 0) return 25;

    return 0;
  }

  // ─── Result building ────────────────────────────────────────────
  function _allActions() {
    const arr = BUILTIN_ACTIONS.slice();
    _custom.forEach(a => arr.push(a));
    return arr;
  }

  function _buildLeadResults(query) {
    const leads = Array.isArray(window._leads) ? window._leads : [];
    if (leads.length === 0) return [];
    const q = (query || '').trim();
    // W138: when NBDLeadScore is loaded, sort the empty-query lead
    // suggestions by W135 unified score instead of just recency.
    // The rep opens Cmd+K with no query → sees the actually-hot
    // leads first (homeowner-message-fresh, recent uploads, hot
    // engagement). Falls back to recency if the engine isn't loaded.
    if (!q) {
      const useUnified = !!(window.NBDLeadScore && window.NBDLeadScore.score);
      return leads
        .slice() // shallow copy so we don't mutate the live cache
        .sort((a, b) => {
          if (useUnified) {
            const sa = window.NBDLeadScore.score(a) || 0;
            const sb = window.NBDLeadScore.score(b) || 0;
            if (sa !== sb) return sb - sa;
          }
          const ta = a.updatedAt?.toMillis?.() || a.createdAt?.toMillis?.() || 0;
          const tb = b.updatedAt?.toMillis?.() || b.createdAt?.toMillis?.() || 0;
          return tb - ta;
        })
        .slice(0, 5)
        .map(l => _leadToAction(l, 5));
    }
    // For text queries: combine fuzzy match with W135 score so a
    // partial-name match on a 🔥 Hot lead beats a partial-name match
    // on a cold one when both have similar fuzzy scores.
    const useUnified = !!(window.NBDLeadScore && window.NBDLeadScore.score);
    // Phone search: compare digits to digits so "(513) 555" matches
    // 5135550100 however either side is formatted. 3-digit minimum so a
    // single digit doesn't light up the whole cache.
    const qDigits = q.replace(/\D/g, '');
    const qLower = q.toLowerCase();
    const scored = [];
    for (const l of leads) {
      const name = ((l.firstName || '') + ' ' + (l.lastName || '')).trim();
      const addr = l.address || '';
      let fuzzy = Math.max(
        _score(q, name, addr),
        _score(q, addr, name)
      );
      // Phone + email — the dashboard help text promises "name, phone,
      // or address" but the palette never actually searched phone/email.
      if (qDigits.length >= 3) {
        const digits = String(l.phoneDigits || l.phone || '').replace(/\D/g, '');
        if (digits && digits.includes(qDigits)) fuzzy = Math.max(fuzzy, 80);
      }
      if (qLower.length >= 3) {
        const email = String(l.email || '').toLowerCase();
        if (email && email.includes(qLower)) fuzzy = Math.max(fuzzy, 70);
      }
      if (fuzzy <= 0) continue;
      // Boost: small additive nudge from the W135 score so two
      // equally-fuzzy-matching leads rank with the hotter one first.
      // Cap the boost so a hot but-irrelevant lead doesn't outrank
      // a cold but-perfect-match lead.
      const boost = useUnified ? Math.min(20, (window.NBDLeadScore.score(l) || 0) / 5) : 0;
      scored.push({ score: fuzzy + boost, lead: l });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, RESULTS_LIMIT).map(x => _leadToAction(x.lead, x.score));
  }

  // Stage-role → chip color (coarse buckets so any stage taxonomy maps).
  const _ROLE_COLORS = { won: '#10b981', job: '#3b82f6', lost: '#ef4444' };

  function _leadToAction(lead, score) {
    const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim() || '(no name)';
    const addr = lead.address || '';
    // Job-card context (RoofLink-style result rows): stage chip with a
    // color dot, jobType tag, $ value, photo thumbnail, assignee. All
    // best-effort — every source degrades to nothing when absent.
    const card = {};
    try {
      const stageKey = (typeof window.normalizeStage === 'function')
        ? window.normalizeStage(lead.stage || '') : (lead.stage || '');
      card.stage = (typeof window.stageLabel === 'function')
        ? window.stageLabel(stageKey) : (lead.stage || '');
      const role = (typeof window.stageRole === 'function') ? window.stageRole(stageKey) : '';
      card.stageColor = _ROLE_COLORS[role] || 'var(--orange, #BD5728)';
      const jtm = (window.JOB_TYPE_META && lead.jobType) ? window.JOB_TYPE_META[lead.jobType] : null;
      if (jtm) { card.jobType = jtm.label; card.jobTypeColor = jtm.color || '#888'; }
      const photos = (window._photoCache && window._photoCache[lead.id]) || [];
      const p0 = photos.find(p => /^https?:/i.test(String((p && p.url) || '')));
      if (p0) card.thumb = p0.url;
      const v = Number(lead.jobValue) || 0;
      if (v > 0) card.value = '$' + Math.round(v).toLocaleString();
      const uid = lead.userId || lead.assignedTo || null;
      const names = window._repNames || window._teamNames || null;
      if (uid && names && names[uid]) card.assignee = String(names[uid]);
    } catch (_) { /* card stays partial — row still renders */ }
    return {
      id: 'lead:' + lead.id,
      label: name,
      sublabel: addr,
      icon: '👤',
      group: 'Leads',
      card,
      score,
      run: () => {
        // window.openCardDetail has NEVER existed anywhere in this repo — the
        // real global is openCardDetailModal (dashboard-widgets.js). Both the
        // direct call and the 200ms retry below targeted the wrong name, so
        // typing a customer's name and pressing Enter landed the rep on the
        // kanban with nothing opened, and they had to hunt the card by hand —
        // which is the entire thing they used the palette to avoid.
        const _open = window.openCardDetailModal || window.openLeadDetail;
        if (typeof _open === 'function') {
          try { _open(lead.id); return; }
          catch (e) { console.warn('[command-palette] card detail failed (will fall back):', e); }
        }
        if (typeof window.goTo === 'function') {
          window.goTo('crm');
          // Try to open the lead detail modal after a beat.
          setTimeout(() => {
            const _o = window.openCardDetailModal || window.openLeadDetail;
            if (typeof _o === 'function') {
              try { _o(lead.id); }
              catch (e) { console.error('[command-palette] card detail retry also failed:', e); }
            }
          }, 200);
          return;
        }
        // Neither global exists — this page is not the dashboard (the palette
        // also loads on customer.html, where none of its navigation targets are
        // defined). Go somewhere real rather than silently doing nothing.
        window.location.href = '/pro/customer.html?id=' + encodeURIComponent(lead.id);
      },
    };
  }

  function _computeResults(query) {
    const q = (query || '').trim();
    const recents = _readRecents();
    const all = _allActions();
    const byId = new Map(all.map(a => [a.id, a]));

    // Score actions
    const scoredActions = [];
    for (const a of all) {
      const s = _score(q, a.label, a.keywords);
      if (s > 0) scoredActions.push({ ...a, score: s });
    }
    // If no query, surface recents at the top.
    if (!q) {
      const recentItems = recents
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(a => ({ ...a, group: 'Recent', score: 1000 }));
      const otherActions = scoredActions
        .filter(a => !recents.includes(a.id))
        .slice(0, 8);
      const leads = _buildLeadResults('');
      return [...recentItems, ...otherActions, ...leads];
    }

    scoredActions.sort((a, b) => b.score - a.score);
    const leads = _buildLeadResults(q);
    // Interleave: top 6 actions, then leads, capped at RESULTS_LIMIT.
    const merged = [];
    let aIdx = 0, lIdx = 0;
    while (merged.length < RESULTS_LIMIT && (aIdx < scoredActions.length || lIdx < leads.length)) {
      const a = scoredActions[aIdx];
      const l = leads[lIdx];
      // Pick whichever has the higher score next.
      if (a && (!l || a.score >= l.score)) {
        merged.push(a);
        aIdx++;
      } else if (l) {
        merged.push(l);
        lIdx++;
      } else {
        break;
      }
    }
    return merged;
  }

  // ─── Modal lifecycle ────────────────────────────────────────────
  function open() {
    if (document.getElementById(MODAL_ID)) return;
    const wrap = _buildModal();
    document.body.appendChild(wrap);
    _selectedIndex = 0;
    _renderResults('');
    const input = wrap.querySelector('#nbd-cmd-input');
    if (input) {
      // Microtask so the DOM is fully attached before focus.
      setTimeout(() => input.focus(), 0);
    }
  }

  function close() {
    const wrap = document.getElementById(MODAL_ID);
    if (wrap) wrap.remove();
    _currentResults = [];
    _selectedIndex = 0;
  }

  function _buildModal() {
    const wrap = document.createElement('div');
    wrap.id = MODAL_ID;
    // z: --z-overlay (cert-round scale — cmd palette is a full-screen
    // overlay, same layer as .modal-bg; toasts at --z-toast stay above).
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:var(--z-overlay,10000);background:rgba(0,0,0,.7);' +
      'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
      'display:flex;align-items:flex-start;justify-content:center;' +
      'padding:80px 20px 20px;overflow-y:auto;';

    wrap.innerHTML =
      '<div style="background:var(--s,#0f1729);border:1px solid var(--br,#2a3344);border-radius:12px;' +
        'width:100%;max-width:600px;color:var(--t,#e2e8f0);font:inherit;' +
        'box-shadow:0 24px 60px rgba(0,0,0,0.55);' +
        'display:flex;flex-direction:column;max-height:calc(100vh - 100px);' +
        'overflow:hidden;">' +
        '<div style="padding:14px 16px;border-bottom:1px solid var(--br,#2a3344);display:flex;align-items:center;gap:10px;">' +
          '<span style="color:var(--m,#94a3b8);font-size:14px;">⌘</span>' +
          '<input type="text" id="nbd-cmd-input" autocomplete="off" spellcheck="false" ' +
            'placeholder="Search actions, leads, or pages…" ' +
            'style="flex:1;background:transparent;border:none;outline:none;color:var(--t,#fff);font:inherit;font-size:15px;padding:4px 0;">' +
          '<kbd style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;padding:2px 5px;border:1px solid var(--br,#2a3344);border-radius:4px;color:var(--m,#94a3b8);">esc</kbd>' +
        '</div>' +
        '<div id="nbd-cmd-results" style="overflow-y:auto;padding:6px;flex:1;"></div>' +
        '<div style="padding:8px 14px;border-top:1px solid var(--br,#2a3344);font-size:11px;color:var(--m,#64748b);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;">' +
          '<span><kbd style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border:1px solid var(--br,#2a3344);border-radius:3px;">↑↓</kbd> navigate</span>' +
          '<span><kbd style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border:1px solid var(--br,#2a3344);border-radius:3px;">↵</kbd> open</span>' +
          '<span><kbd style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 5px;border:1px solid var(--br,#2a3344);border-radius:3px;">esc</kbd> close</span>' +
        '</div>' +
      '</div>';

    // Click outside the inner panel = close
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });

    const input = wrap.querySelector('#nbd-cmd-input');
    input.addEventListener('input', () => {
      _selectedIndex = 0;
      _renderResults(input.value);
    });
    input.addEventListener('keydown', _onKeydown);
    return wrap;
  }

  function _onKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _selectedIndex = Math.min(_selectedIndex + 1, _currentResults.length - 1);
      _highlightSelected();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _selectedIndex = Math.max(_selectedIndex - 1, 0);
      _highlightSelected();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = _currentResults[_selectedIndex];
      if (item) _execute(item);
    }
  }

  // ─── Render results ─────────────────────────────────────────────
  function _renderResults(query) {
    const list = document.getElementById('nbd-cmd-results');
    if (!list) return;
    _currentResults = _computeResults(query);
    if (_currentResults.length === 0) {
      list.innerHTML =
        '<div style="padding:40px 16px;text-align:center;color:var(--m,#94a3b8);font-size:13px;">' +
        'No results. Try a different search.</div>';
      return;
    }

    // Group results by their group field while preserving order.
    let lastGroup = null;
    const html = [];
    _currentResults.forEach((item, idx) => {
      if (item.group !== lastGroup) {
        html.push(
          '<div style="padding:10px 14px 4px;font-size:10px;color:var(--m,#64748b);letter-spacing:0.08em;font-weight:600;text-transform:uppercase;">' +
          escHtml(item.group || 'Other') + '</div>'
        );
        lastGroup = item.group;
      }
      html.push(_renderItem(item, idx));
    });
    list.innerHTML = html.join('');
    _highlightSelected();

    // Wire up clicks on each row.
    Array.from(list.querySelectorAll('.nbd-cmd-row')).forEach(row => {
      const idx = Number(row.dataset.idx);
      row.addEventListener('click', () => {
        const item = _currentResults[idx];
        if (item) _execute(item);
      });
      row.addEventListener('mousemove', () => {
        if (_selectedIndex !== idx) {
          _selectedIndex = idx;
          _highlightSelected();
        }
      });
    });
  }

  function _renderItem(item, idx) {
    // Lead rows render as job cards (stage dot, type tag, $, thumbnail,
    // assignee) — action/navigation rows keep the compact icon layout.
    const c = item.card;
    if (c && (c.stage || c.thumb || c.value)) {
      const left = c.thumb
        ? '<img src="' + escHtml(c.thumb) + '" loading="lazy" alt="" style="width:34px;height:34px;border-radius:6px;object-fit:cover;flex-shrink:0;border:1px solid var(--br,#2a3344);">'
        : '<span style="font-size:16px;width:34px;height:34px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--s3,rgba(255,255,255,.05));border-radius:6px;">' + escHtml(item.icon || '👤') + '</span>';
      const subBits = [];
      if (item.sublabel) subBits.push(escHtml(item.sublabel));
      if (c.assignee) subBits.push('👤 ' + escHtml(c.assignee));
      const rightBits = [];
      if (c.stage) rightBits.push(
        '<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;color:' + escHtml(c.stageColor) + ';white-space:nowrap;">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:' + escHtml(c.stageColor) + ';display:inline-block;"></span>' +
          escHtml(c.stage) + '</span>');
      const tagBits = [];
      if (c.value) tagBits.push('<span style="font-size:11px;font-weight:700;color:var(--t,#e2e8f0);font-variant-numeric:tabular-nums;">' + escHtml(c.value) + '</span>');
      if (c.jobType) tagBits.push(
        '<span style="font-size:9px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:' + escHtml(c.jobTypeColor) + ';border:1px solid ' + escHtml(c.jobTypeColor) + '55;border-radius:999px;padding:1px 7px;white-space:nowrap;">' + escHtml(c.jobType) + '</span>');
      if (tagBits.length) rightBits.push('<span style="display:inline-flex;align-items:center;gap:6px;">' + tagBits.join('') + '</span>');
      return '<div class="nbd-cmd-row" data-idx="' + idx + '" ' +
        'style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:14px;">' +
        left +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(item.label) + '</div>' +
          (subBits.length
            ? '<div style="font-size:11px;color:var(--m,#94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + subBits.join(' · ') + '</div>'
            : '') +
        '</div>' +
        '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:3px;flex-shrink:0;">' + rightBits.join('') + '</div>' +
        '</div>';
    }
    return '<div class="nbd-cmd-row" data-idx="' + idx + '" ' +
      'style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:6px;cursor:pointer;font-size:14px;">' +
      '<span style="font-size:16px;width:22px;flex-shrink:0;text-align:center;">' + escHtml(item.icon || '•') + '</span>' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(item.label) + '</div>' +
        (item.sublabel
          ? '<div style="font-size:11px;color:var(--m,#94a3b8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escHtml(item.sublabel) + '</div>'
          : '') +
      '</div>' +
      '</div>';
  }

  function _highlightSelected() {
    const list = document.getElementById('nbd-cmd-results');
    if (!list) return;
    const rows = Array.from(list.querySelectorAll('.nbd-cmd-row'));
    rows.forEach((r, i) => {
      if (i === _selectedIndex) {
        r.style.background = 'var(--og,rgba(189,87,40,.12))';
        r.style.outline = '1px solid var(--orange, #A14A22)';
        // Scroll into view if needed.
        try { r.scrollIntoView({ block: 'nearest' }); } catch (_) {}
      } else {
        r.style.background = '';
        r.style.outline = 'none';
      }
    });
  }

  // ─── Execute selected ───────────────────────────────────────────
  function _execute(item) {
    if (!item) return;
    _bumpRecent(item.id);
    close();
    // Defer execution so the modal closes cleanly (focus returns
    // before the run() handler does anything that might reopen UI).
    setTimeout(() => {
      try { item.run && item.run(); }
      catch (e) { console.warn('[NBDCommand] action failed:', e); }
    }, 0);
  }

  // ─── Public action registry ────────────────────────────────────
  function registerAction(action) {
    if (!action || typeof action.id !== 'string' || typeof action.run !== 'function') return;
    _custom.set(action.id, {
      id: action.id,
      label: String(action.label || action.id),
      icon: action.icon || '•',
      group: action.group || 'Custom',
      keywords: action.keywords || '',
      run: action.run,
    });
  }
  function unregisterAction(id) { _custom.delete(id); }

  // ─── Global hotkey ─────────────────────────────────────────────
  // Cmd+K (Mac) / Ctrl+K (Windows/Linux), or `/` when no text input
  // is focused.
  function _attachHotkey() {
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', (e) => {
      // Cmd/Ctrl + K
      if (e.key === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        const isOpen = !!document.getElementById(MODAL_ID);
        e.preventDefault();
        if (isOpen) close();
        else open();
        return;
      }
      // `/` when not in an input/textarea/contenteditable
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const t = e.target;
        if (t && t.tagName) {
          const tag = t.tagName.toUpperCase();
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
          if (t.isContentEditable) return;
        }
        e.preventDefault();
        open();
      }
    });
  }

  window.NBDCommand = {
    __sentinel: 'nbd-cmd-v1',
    open,
    close,
    registerAction,
    unregisterAction,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _attachHotkey, { once: true });
  } else {
    setTimeout(_attachHotkey, 0);
  }
})();
