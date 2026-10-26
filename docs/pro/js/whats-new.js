/**
 * whats-new.js — Wave 157 (Onboarding + Discoverability)
 *
 * Most new tools NBD Pro ships are silently available — they live
 * behind keyboard shortcuts, FAB stacks, or score badges that a
 * day-1 user has zero way to discover. This module is the
 * "where's the new stuff" surface:
 *
 *   1. A small bell icon next to the user avatar that pulses when
 *      there's an unread "what's new" item
 *   2. Click → opens a panel listing recently-shipped features
 *      with one-line descriptions, screenshots if applicable, and
 *      "Try it" buttons that actually invoke the feature
 *   3. Each item tracks a per-user seen-flag (localStorage) so the
 *      bell stops pulsing after they've reviewed it
 *
 * The features list is curated client-side here — every wave that
 * adds a user-visible surface should add an entry. The list stays
 * small and rotates: items older than 30 days drop off.
 *
 * Usage:
 *   NBDWhatsNew.open()      — open the panel manually
 *   NBDWhatsNew.markAllSeen() — clear the bell
 */
(function () {
  'use strict';
  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['whats-new']) return;
  __NBD_LOADED['whats-new'] = true;

  const STORAGE_KEY = 'nbd_whats_new_seen_v1';
  const PANEL_ID = 'nbd-whats-new-panel';

  // Curated list of recently-shipped, user-facing features. Each
  // item includes a stable id (used for seen-flag persistence), a
  // human title, a 1-line body, an emoji icon, the wave number for
  // the audit trail, an optional `try` callback, and the date it
  // shipped (for the 30-day rotation).
  const ITEMS = [
    {
      id: 'lead-intel-2026-05',
      icon: '🔥',
      title: 'Lead Intelligence score',
      body: 'Every lead now has a 0-100 priority score combining engagement, stage, recency, and customer signals. Look for the colored dot on each kanban card — click for the full breakdown on the customer page.',
      wave: 'W135-W139',
      shippedAt: '2026-05-06',
      tryLabel: 'Open CRM',
      tryHandler: () => { if (typeof window.goTo === 'function') window.goTo('crm'); },
    },
    {
      id: 'voice-whisper-2026-05',
      icon: '🎤',
      title: 'Voice dictation everywhere',
      body: 'Hold F2 (configurable in Comfort tab) anywhere on the page and talk. AI cleans up filler words and drops polished text into whatever input is focused.',
      wave: 'W128-W131',
      shippedAt: '2026-05-06',
      tryLabel: 'Try dictating',
      tryHandler: () => {
        if (window.NBDWhisper && window.NBDWhisper.start) window.NBDWhisper.start();
      },
    },
    {
      id: 'quick-capture-2026-05',
      icon: '🎙',
      title: 'Quick Capture scratchpad',
      body: 'Tap the 🎙 button bottom-right, talk for up to 5 minutes between knocks, get back a structured AI summary with action items + entity chips. Save to a lead, commit as tasks, or just file it.',
      wave: 'W130',
      shippedAt: '2026-05-06',
      tryLabel: 'Open Quick Capture',
      tryHandler: () => {
        if (window.NBDQuickCapture && window.NBDQuickCapture.open) window.NBDQuickCapture.open();
      },
    },
    {
      id: 'cmd-palette-2026-05',
      icon: '⌘K',
      title: 'Command palette — jump anywhere',
      body: 'Press Cmd+K (Mac) or Ctrl+K (Windows/Linux) — or "/" when no input is focused — to fuzzy-search across leads, actions, and views. Two keystrokes from anywhere to anywhere.',
      wave: 'W133',
      shippedAt: '2026-05-06',
      tryLabel: 'Open palette',
      tryHandler: () => {
        if (window.NBDCommand && window.NBDCommand.open) window.NBDCommand.open();
      },
    },
    {
      id: 'portal-v2-2026-05',
      icon: '📲',
      title: 'Customer portal v2',
      body: 'Customers can now upload damage photos, request callbacks at specific times, message you, and rate the job — all from a single share link. Every action lands as a real artifact on the lead.',
      wave: 'W118-W125',
      shippedAt: '2026-05-06',
    },
    {
      id: 'estimate-v2-2026-05',
      icon: '📄',
      title: 'Estimate Builder is now V2',
      body: 'V2 is the default builder. Includes Customer/Claim/Tier/County inputs, per-SQ add-ons, supplements, share-view links (homeowner can preview without signing), and a brand-new analytics dashboard on the Reports view.',
      wave: 'W142-W147',
      shippedAt: '2026-05-06',
      tryLabel: 'Open Estimates',
      tryHandler: () => { if (typeof window.goTo === 'function') window.goTo('est'); },
    },
    {
      id: 'reports-dashboard-2026-05',
      icon: '📊',
      title: 'Reports dashboard rebuild',
      body: 'KPI tiles with period-over-period deltas, conversion funnel, revenue trend sparkline, and top performers leaderboards. All on the Reports view.',
      wave: 'W153-W155',
      shippedAt: '2026-05-06',
      tryLabel: 'Open Reports',
      tryHandler: () => { if (typeof window.goTo === 'function') window.goTo('reports'); },
    },
    {
      id: 'pwa-install-2026-05',
      icon: '📱',
      title: 'Install as an app',
      body: 'Install NBD Pro to your home screen for full-screen mode, push notifications, and faster launches. Look for the install banner the next time it appears, or use Add to Home Screen on iOS.',
      wave: 'W150',
      shippedAt: '2026-05-06',
    },
  ];

  // ─── State ──────────────────────────────────────────────────
  function _readSeen() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch (_) { return {}; }
  }
  function _writeSeen(map) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(map)); } catch (_) {}
  }

  function _isStale(shippedAt) {
    if (!shippedAt) return false;
    const ageDays = (Date.now() - Date.parse(shippedAt)) / 86_400_000;
    return ageDays > 30;
  }
  function _activeItems() {
    return ITEMS.filter(it => !_isStale(it.shippedAt));
  }
  function _unseenCount() {
    const seen = _readSeen();
    return _activeItems().filter(it => !seen[it.id]).length;
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // ─── Bell button ────────────────────────────────────────────
  function _attachBell() {
    if (document.getElementById('nbd-whats-new-bell')) return;
    // Inject next to the user avatar/header. Try the most common ID
    // (#userName / #userAvatar in the topbar). Fallback: top-right
    // floating placement.
    const anchor = document.getElementById('userAvatar') || document.getElementById('userName');
    const bell = document.createElement('button');
    bell.id = 'nbd-whats-new-bell';
    bell.type = 'button';
    bell.setAttribute('aria-label', 'See what\'s new');
    bell.title = 'What\'s new in NBD Pro';
    if (anchor && anchor.parentNode) {
      bell.style.cssText =
        'background:transparent;border:none;color:var(--m, #888);font-size:18px;' +
        'cursor:pointer;padding:6px 8px;position:relative;' +
        '-webkit-tap-highlight-color:transparent;';
      bell.innerHTML = '🎁<span id="nbd-whats-new-dot" style="display:none;position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:var(--orange, #A14A22);box-shadow:0 0 0 2px var(--bg, #0a0c0f);animation:nbd-pulse 1.5s ease-in-out infinite;"></span>';
      // Park the bell BESIDE whatever clickable container holds the avatar,
      // never inside it. On the dashboard the avatar sits in .upill, which is
      // itself a data-action="goTo" → settings link, and a bell nested there
      // inherited that click: every tap opened What's New AND navigated to
      // Settings behind it, so closing the panel left the rep on Settings
      // instead of where they were (phone audit 2026-09-25, views#10). A
      // stopPropagation would also hide the tap from every other document
      // delegate (menu outside-click closers), and a button inside a clickable
      // pill is a nested-interactive control either way — so move it out.
      const host = (anchor.closest && anchor.closest('[data-action]')) || anchor;
      // Outside the pill the bell sits in .hright's 10px gap instead of the
      // pill's 7px one; pull it back 3px so the header is exactly as wide as
      // before — at 360px the logo lockup is already clipped.
      if (host !== anchor) bell.style.marginRight = '-3px';
      host.parentNode.insertBefore(bell, host);
      // Pulse keyframes
      if (!document.getElementById('nbd-whats-new-css')) {
        const css = document.createElement('style');
        css.id = 'nbd-whats-new-css';
        css.textContent =
          '@keyframes nbd-pulse {' +
            '0%,100% { opacity:1; transform:scale(1); }' +
            '50% { opacity:0.6; transform:scale(1.4); }' +
          '}';
        document.head.appendChild(css);
      }
    } else {
      // Fallback: floating top-right pill
      bell.style.cssText =
        'position:fixed;top:calc(14px + env(safe-area-inset-top, 0px));' +
        'right:calc(80px + env(safe-area-inset-right, 0px));z-index:9998;' +
        'background:var(--s, #13171d);border:1px solid var(--br, #2a3344);' +
        'color:var(--t, #e8eaf0);font-size:14px;padding:6px 10px;border-radius:18px;' +
        'cursor:pointer;-webkit-tap-highlight-color:transparent;';
      bell.innerHTML = '🎁 What\'s new';
      document.body.appendChild(bell);
    }
    bell.addEventListener('click', open);
    _updateDot();
  }
  function _updateDot() {
    const dot = document.getElementById('nbd-whats-new-dot');
    const bell = document.getElementById('nbd-whats-new-bell');
    if (!bell) return;
    const unread = _unseenCount();
    if (dot) dot.style.display = unread > 0 ? 'block' : 'none';
    if (unread > 0) bell.title = unread + ' new feature' + (unread === 1 ? '' : 's') + ' to discover';
  }

  // ─── Panel ──────────────────────────────────────────────────
  function open() {
    if (document.getElementById(PANEL_ID)) return;
    const items = _activeItems();
    const seen = _readSeen();
    const wrap = document.createElement('div');
    wrap.id = PANEL_ID;
    // Theme-tokenized (batch-4): hex fallbacks preserve the original dark look
    // on any page missing the token set, but the modal now adapts to light
    // themes. z-index moves onto the --z-* scale (modal tier).
    wrap.style.cssText =
      'position:fixed;inset:0;z-index:var(--z-overlay,10012);background:rgba(0,0,0,0.7);' +
      'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
      'display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;';
    wrap.innerHTML =
      '<div style="background:var(--s,#0f1729);border:1px solid var(--br,#2a3344);border-radius:14px;' +
        'width:100%;max-width:600px;max-height:90vh;overflow-y:auto;' +
        'padding:22px;color:var(--t,#e2e8f0);font:inherit;' +
        'box-shadow:0 24px 60px rgba(0,0,0,0.6);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
          '<div>' +
            '<div style="font-size:11px;color:var(--m,#94a3b8);letter-spacing:0.08em;font-weight:600;text-transform:uppercase;margin-bottom:3px;">What\'s new</div>' +
            '<div style="font-size:18px;font-weight:700;">Recently shipped in NBD Pro</div>' +
          '</div>' +
          '<button type="button" id="nbd-wn-close" style="background:transparent;border:none;color:var(--m,#94a3b8);font-size:22px;cursor:pointer;padding:4px 10px;line-height:1;">×</button>' +
        '</div>' +
        items.map(it => {
          const isUnseen = !seen[it.id];
          return (
            '<div style="background:' + (isUnseen ? 'color-mix(in srgb, var(--orange,#A14A22) 8%, transparent)' : 'var(--s2,#0a1424)') + ';' +
              'border:1px solid ' + (isUnseen ? 'var(--orange, #A14A22)' : 'var(--br,#2a3344)') + ';' +
              'border-radius:8px;padding:12px 14px;margin-bottom:8px;' +
              'display:flex;gap:12px;align-items:flex-start;" data-item-id="' + _esc(it.id) + '">' +
              '<div style="font-size:24px;line-height:1;flex-shrink:0;">' + _esc(it.icon) + '</div>' +
              '<div style="flex:1;min-width:0;">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">' +
                  '<div style="font-size:14px;font-weight:700;">' + _esc(it.title) + '</div>' +
                  (isUnseen ? '<span style="font-size:9px;color:var(--orange, #A14A22);background:color-mix(in srgb, var(--orange,#A14A22) 15%, transparent);border:1px solid var(--orange, #A14A22);padding:1px 6px;border-radius:99px;letter-spacing:0.08em;text-transform:uppercase;font-weight:700;">New</span>' : '') +
                '</div>' +
                '<div style="font-size:13px;color:var(--m,#cbd5e1);line-height:1.45;margin-bottom:8px;">' + _esc(it.body) + '</div>' +
                (it.tryLabel ? (
                  '<button type="button" class="nbd-wn-try" data-item-id="' + _esc(it.id) + '" ' +
                    'style="padding:5px 10px;background:var(--orange, #A14A22);color:var(--accent-fg,#fff);border:none;border-radius:5px;font:inherit;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;cursor:pointer;">' +
                    _esc(it.tryLabel) +
                  '</button>'
                ) : '') +
              '</div>' +
            '</div>'
          );
        }).join('') +
        '<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--br,#2a3344);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
          '<button type="button" id="nbd-wn-mark-all" style="background:transparent;color:var(--m,#94a3b8);border:none;font:inherit;font-size:11px;cursor:pointer;text-decoration:underline;">Mark all as seen</button>' +
          '<div style="font-size:11px;color:var(--m,#64748b);">' + items.length + ' item' + (items.length === 1 ? '' : 's') + ' (last 30 days)</div>' +
        '</div>' +
      '</div>';
    wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
    document.body.appendChild(wrap);
    // Keyboard contract (js/overlay-a11y.js): Escape closes, focus moves in and comes back.
    if (window.nbdOverlay) window.nbdOverlay.attach(wrap, { label: "What's new", close });

    wrap.querySelector('#nbd-wn-close').addEventListener('click', close);
    wrap.querySelector('#nbd-wn-mark-all').addEventListener('click', () => {
      markAllSeen();
      close();
    });
    Array.from(wrap.querySelectorAll('.nbd-wn-try')).forEach(b => {
      b.addEventListener('click', () => {
        const id = b.dataset.itemId;
        const item = ITEMS.find(it => it.id === id);
        if (item) {
          // Mark seen + close, then fire the handler. Defer the
          // handler to next tick so the close animation runs cleanly.
          const seen = _readSeen();
          seen[item.id] = Date.now();
          _writeSeen(seen);
          close();
          if (typeof item.tryHandler === 'function') {
            setTimeout(() => { try { item.tryHandler(); } catch (e) { console.warn(e); } }, 50);
          }
        }
      });
    });

    // Mark all visible items as seen 4s after the panel opens (gives
    // the rep time to actually look at them). Avoids the case where
    // they accidentally miss the dot pulse by closing immediately.
    setTimeout(() => {
      if (!document.getElementById(PANEL_ID)) return; // already closed
      const cur = _readSeen();
      items.forEach(it => { if (!cur[it.id]) cur[it.id] = Date.now(); });
      _writeSeen(cur);
      _updateDot();
    }, 4000);
  }

  function close() {
    const p = document.getElementById(PANEL_ID);
    if (p) p.remove();
  }

  function markAllSeen() {
    const cur = _readSeen();
    _activeItems().forEach(it => { cur[it.id] = Date.now(); });
    _writeSeen(cur);
    _updateDot();
  }

  function _bootstrap() {
    // Wait for the user header to render before attaching.
    let tries = 0;
    const probe = setInterval(() => {
      tries++;
      const anchor = document.getElementById('userAvatar') || document.getElementById('userName');
      if (anchor) { clearInterval(probe); _attachBell(); }
      if (tries > 60) { clearInterval(probe); _attachBell(); /* fallback floating */ }
    }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bootstrap, { once: true });
  } else {
    setTimeout(_bootstrap, 0);
  }

  const NBDWhatsNew = {
    open,
    markAllSeen,
    unseenCount: _unseenCount,
  };
})();
