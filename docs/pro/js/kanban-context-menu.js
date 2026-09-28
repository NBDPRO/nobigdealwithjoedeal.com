/**
 * kanban-context-menu.js — Wave 26 (Kanban card context menu)
 *
 * Reps do the same handful of actions on kanban cards dozens of
 * times a day: open the detail modal, edit fields, add a task,
 * call the customer, copy their address into Maps, delete a dud.
 * Until now each one needed either drag-clicking the right tiny
 * footer icon or opening the detail modal first. This wave gives
 * a context menu that floats next to whichever card the rep
 * right-clicked or long-pressed — desktop AND mobile both get
 * the same vocabulary.
 *
 * Triggers:
 *   - Right-click on .k-card (contextmenu event)
 *   - Long-press (500ms touchstart with no touchmove) on .k-card
 *
 * Menu items (each gracefully no-ops if the underlying handler
 * isn't loaded — the module never fails closed):
 *   - View details          → openCardDetailModal
 *   - Edit                  → editLead
 *   - Add task              → openTaskModal
 *   - Call (when phone set) → tel: link
 *   - Copy phone            → clipboard
 *   - Copy address          → clipboard
 *   - Open in Maps          → maps.apple.com / google.com/maps
 *   - Delete                → deleteLead (which already confirms)
 *
 * Dismissed on: outside click, Esc, scroll (card menus only — not the
 * chip pickers, whose anchor sits in a fixed overlay), second
 * contextmenu elsewhere. Auto-positions to stay inside viewport.
 *
 * Exposes: window.KanbanContextMenu.{open, close}
 */
(function () {
  'use strict';

  if (window.KanbanContextMenu && window.KanbanContextMenu.__sentinel === 'nbd-kanban-ctx-v1') return;

  const LONG_PRESS_MS = 500;
  let menuEl = null;
  let submenuEl = null;
  let touchTimer = null;
  let touchStart = null;

  // ─── Helpers ─────────────────────────────────────────────────────
  function findLead(leadId) {
    if (!Array.isArray(window._leads)) return null;
    return window._leads.find(l => l && l.id === leadId) || null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function copyToClipboard(text) {
    if (!text) return Promise.resolve(false);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
    }
    // Legacy fallback for environments without async clipboard.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return Promise.resolve(ok);
    } catch (e) { return Promise.resolve(false); }
  }

  function _toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }

  function isApplePlatform() {
    const ua = navigator.userAgent || '';
    return /iP(ad|hone|od)|Macintosh/.test(ua);
  }

  function mapsUrl(addr) {
    const q = encodeURIComponent(addr);
    return isApplePlatform()
      ? `https://maps.apple.com/?q=${q}`
      : `https://www.google.com/maps/search/?api=1&query=${q}`;
  }

  // ─── Submenu builders ───────────────────────────────────────────
  // Stage list, scoped to the lead's current jobType track. The current
  // stage gets a ✓ marker so the rep can see where the card is now.
  function buildStageSubmenuItems(lead) {
    const jobType = lead.jobType ||
      (typeof window.inferJobType === 'function' ? window.inferJobType(lead) : null) ||
      'insurance';
    let options = [];
    if (typeof window.stageOptionsForType === 'function') {
      try { options = window.stageOptionsForType(jobType) || []; } catch (_) {}
    }
    const curKey = lead._stageKey ||
      (typeof window.normalizeStage === 'function' ? window.normalizeStage(lead.stage || 'new') : lead.stage);
    const items = options.map(opt => {
      const isCurrent = opt.value === curKey;
      const meta = window.STAGE_META?.[opt.value] || {};
      return {
        icon: isCurrent ? '✓' : (meta.icon || '•'),
        label: opt.label + (isCurrent ? '  (current)' : ''),
        disabled: isCurrent,
        onSelect: isCurrent ? null : () => window.moveCard && window.moveCard(lead.id, opt.value),
      };
    });
    return items;
  }

  // Classification list — Insurance / Cash / Finance / Warranty / Service.
  // Current classification is marked with ✓.
  function buildTypeSubmenuItems(lead) {
    const meta = window.JOB_TYPE_META || {};
    const curType = lead.jobType ||
      (typeof window.inferJobType === 'function' ? window.inferJobType(lead) : null);
    const types = Object.keys(meta);
    return types.map(t => {
      const isCurrent = t === curType;
      return {
        icon: isCurrent ? '✓' : (meta[t]?.icon || '•'),
        label: (meta[t]?.label || t) + (isCurrent ? '  (current)' : ''),
        disabled: isCurrent,
        onSelect: isCurrent ? null : () => window.changeLeadType && window.changeLeadType(lead.id, t),
      };
    });
  }

  // ─── Menu rendering ─────────────────────────────────────────────
  function buildMenu(lead, x, y) {
    const items = [];
    items.push({
      icon: '👁',
      label: 'View details',
      onSelect: () => window.openCardDetailModal && window.openCardDetailModal(lead.id),
    });
    items.push({
      icon: '✏️',
      label: 'Edit lead',
      onSelect: () => window.editLead && window.editLead(lead.id),
    });
    items.push({
      icon: '✓',
      label: 'Add task',
      onSelect: () => window.openTaskModal && window.openTaskModal(lead.id, null),
    });
    // Quick stage + classification changers. Each opens a second floating
    // menu next to the parent so the rep never has to open the full edit
    // form just to move a card or relabel its track.
    items.push({ divider: true });
    items.push({
      icon: '🔀',
      label: 'Move to stage…',
      chevron: true,
      onSelect: (anchor) => openSubmenu(buildStageSubmenuItems(lead), anchor, 'Move to stage'),
    });
    items.push({
      icon: '🏷',
      label: 'Change classification…',
      chevron: true,
      onSelect: (anchor) => openSubmenu(buildTypeSubmenuItems(lead), anchor, 'Change classification'),
    });
    if (lead.phone) {
      const phoneDigits = String(lead.phone).replace(/\D+/g, '');
      items.push({ divider: true });
      items.push({
        icon: '📞',
        label: `Call ${lead.phone}`,
        onSelect: () => { window.location.href = 'tel:' + phoneDigits; },
      });
      items.push({
        icon: '📋',
        label: 'Copy phone',
        onSelect: async () => {
          const ok = await copyToClipboard(lead.phone);
          _toast(ok ? 'Phone copied' : 'Couldn\'t copy phone', ok ? 'success' : 'error');
        },
      });
    }
    if (lead.address) {
      if (!lead.phone) items.push({ divider: true });
      items.push({
        icon: '📋',
        label: 'Copy address',
        onSelect: async () => {
          const ok = await copyToClipboard(lead.address);
          _toast(ok ? 'Address copied' : 'Couldn\'t copy address', ok ? 'success' : 'error');
        },
      });
      items.push({
        icon: '🗺',
        label: 'Open in Maps',
        onSelect: () => window.open(mapsUrl(lead.address), '_blank', 'noopener'),
      });
    }
    // Wave 42: portal link actions. Reuses the W40 + W41 logic
    // via PortalLinkHelpers so the right-click flow gets the
    // same Firestore-first / generate-on-demand resolution +
    // clipboard fallbacks + SMS body template as the buttons on
    // customer.html. Available whenever the helpers module is
    // loaded (which is always, on the dashboard).
    if (window.PortalLinkHelpers) {
      items.push({ divider: true });
      items.push({
        icon: '🔗',
        label: 'Copy portal link',
        onSelect: () => window.PortalLinkHelpers.copyForLead(lead),
      });
      if (lead.phone) {
        items.push({
          icon: '💬',
          label: 'Text portal link',
          onSelect: () => window.PortalLinkHelpers.smsForLead(lead),
        });
      }
      // Wave 43: email variant. Only renders when the lead has an
      // email on file — same dead-option-prevention rule the SMS
      // variant uses for phones.
      if (lead.email) {
        items.push({
          icon: '📧',
          label: 'Email portal link',
          onSelect: () => window.PortalLinkHelpers.emailForLead(lead),
        });
      }
      // Wave 56: portal preview. Always available — every lead can
      // be previewed regardless of contact info.
      if (typeof window.PortalLinkHelpers.previewForLead === 'function') {
        items.push({
          icon: '🔍',
          label: 'Preview portal',
          onSelect: () => window.PortalLinkHelpers.previewForLead(lead),
        });
      }
    }
    // Wave 35: Snooze. Available when LeadSnooze module is loaded.
    // Toggles between "Snooze" (when not snoozed) and "Unsnooze"
    // (when currently snoozed) so the menu reflects state.
    if (window.LeadSnooze) {
      items.push({ divider: true });
      if (window.LeadSnooze.isSnoozed(lead)) {
        const until = window.LeadSnooze.snoozedUntilDate(lead);
        const label = until
          ? `Unsnooze (was until ${window.LeadSnooze.formatSnoozeLabel(until)})`
          : 'Unsnooze';
        items.push({
          icon: '⏰',
          label,
          onSelect: () => window.LeadSnooze.promptUnsnooze(lead.id),
        });
      } else {
        items.push({
          icon: '💤',
          label: 'Snooze lead…',
          onSelect: () => {
            const name = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
            window.LeadSnooze.prompt(lead.id, name);
          },
        });
      }
    }
    items.push({ divider: true });
    items.push({
      icon: '🗑',
      label: 'Delete lead',
      danger: true,
      onSelect: () => window.deleteLead && window.deleteLead(lead.id),
    });
    // A viewer is read-only (role-gate.js). Every write below was refused on
    // click — Delete even opened a dialog with only Cancel — so offer just the
    // read actions. Portal links mint tokens, which is a write.
    if (window.NBDRole && typeof window.NBDRole.isViewer === 'function' && window.NBDRole.isViewer()) {
      const READ_ONLY = /^(View details|Call |Copy phone|Copy address|Open in Maps)/;
      // Keep read items; drop leading, doubled and trailing dividers.
      const clean = [];
      for (const it of items) {
        if (it.divider) { if (clean.length && !clean[clean.length - 1].divider) clean.push(it); }
        else if (READ_ONLY.test(it.label || '')) clean.push(it);
      }
      while (clean.length && clean[clean.length - 1].divider) clean.pop();
      return renderMenu(clean, x, y);
    }
    return renderMenu(items, x, y);
  }

  function renderMenu(items, x, y, opts) {
    const isSubmenu = !!(opts && opts.isSubmenu);
    // Primary menu replaces any existing menu; submenu sits ON TOP of its
    // parent and only replaces an existing submenu (so the parent stays
    // visible while the rep scans the stage list).
    if (isSubmenu) closeSubmenu();
    else closeMenu();
    const menu = document.createElement('div');
    menu.id = isSubmenu ? 'nbd-kanban-ctx-submenu' : 'nbd-kanban-ctx-menu';
    menu.setAttribute('role', 'menu');
    if (opts && opts.title) menu.setAttribute('aria-label', opts.title);
    // Every menu is capped to the screen, not just submenus (2026-09-25
    // phone audit). openPicker renders the job-detail stage chip's 25-stage
    // list as a PRIMARY menu, which had max-height:none: 867px tall, so its
    // overflow-y:auto never engaged and the top clamp below pinned it at 8px
    // with Closed, Warranty Claim and Lost below the bottom of a 760px
    // screen (Deductible onward at 360x680) — unreachable, since the page
    // behind doesn't scroll either. innerHeight, not vh: a phone's 100vh
    // includes the browser's collapsible toolbar.
    const vhPx = window.innerHeight;
    const maxH = isSubmenu ? Math.min(Math.round(vhPx * 0.7), vhPx - 16) : vhPx - 16;
    menu.style.cssText = `
      position:fixed; z-index:${isSubmenu ? 99998 : 99997};
      background:var(--s,#1a1f2a); color:var(--t,#e8eaf0);
      border:1px solid var(--br,#2a3344); border-radius:8px;
      box-shadow:0 8px 24px rgba(0,0,0,0.4);
      padding:6px 0; min-width:${isSubmenu ? 220 : 200}px;
      max-height:${Math.max(120, maxH)}px; overflow-y:auto; overscroll-behavior:contain;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;
      font-size:13px; line-height:1.4;
      animation:nbd-ctx-fade .12s ease-out;`;
    const header = (isSubmenu && opts.title)
      ? `<div style="padding:6px 14px 8px;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--m,#9aa3b2);border-bottom:1px solid var(--br,#2a3344);margin-bottom:4px;">${escapeHtml(opts.title)}</div>`
      : '';
    menu.innerHTML = header + items.map((it, i) => {
      if (it.divider) return `<div style="height:1px; background:var(--br,#2a3344); margin:4px 0;"></div>`;
      const danger = it.danger ? 'color:#ef4444;' : '';
      const dis = it.disabled ? 'opacity:.55;cursor:default;' : '';
      const chev = it.chevron ? '<span style="margin-left:auto;opacity:.55;">▸</span>' : '';
      return `
        <button class="nbd-ctx-item" data-idx="${i}" type="button"
          ${it.disabled ? 'aria-disabled="true"' : ''}
          style="
            display:flex; align-items:center; gap:10px;
            width:100%; padding:8px 14px; border:none; background:transparent;
            color:inherit; ${danger}${dis}
            text-align:left; font: inherit; cursor:pointer;
            -webkit-tap-highlight-color:transparent;">
          <span style="width:18px; text-align:center;">${escapeHtml(it.icon || '')}</span>
          <span style="flex:1;min-width:0;">${escapeHtml(it.label)}</span>
          ${chev}
        </button>`;
    }).join('');

    // Inject the keyframes once.
    if (!document.getElementById('nbd-ctx-style')) {
      const style = document.createElement('style');
      style.id = 'nbd-ctx-style';
      style.textContent = `
        @keyframes nbd-ctx-fade { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
        .nbd-ctx-item:hover, .nbd-ctx-item:focus { background:var(--s2,#0f1419); outline:none; }
        .nbd-ctx-item[aria-disabled="true"]:hover { background:transparent !important; }`;
      document.head.appendChild(style);
    }

    document.body.appendChild(menu);

    // Position: clamp inside viewport, prefer below+right of cursor.
    const rect = menu.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = x, top = y;
    if (left + rect.width > vw - 8)  left = Math.max(8, vw - rect.width - 8);
    if (top  + rect.height > vh - 8) top  = Math.max(8, vh - rect.height - 8);
    menu.style.left = left + 'px';
    menu.style.top  = top + 'px';

    // Wire item clicks.
    menu.querySelectorAll('.nbd-ctx-item').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        const i = parseInt(btn.getAttribute('data-idx'), 10);
        const it = items[i];
        if (!it || it.disabled || typeof it.onSelect !== 'function') return;
        // Submenu items: pass the button's rect as anchor so the next menu
        // opens flush to the right. We DON'T close the parent until the
        // user actually picks a leaf option.
        if (it.chevron) {
          const r = btn.getBoundingClientRect();
          try { it.onSelect({ x: r.right + 2, y: r.top, parent: menu }); }
          catch (e) { console.warn('[ctx-menu]', e); }
          return;
        }
        closeMenu();
        try { it.onSelect(); } catch (e) { console.warn('[ctx-menu]', e); }
      });
    });

    if (isSubmenu) {
      submenuEl = menu;
      return menu;
    }
    menuEl = menu;
    setTimeout(() => {
      if (menuEl !== menu) return; // replaced or closed before the listeners armed
      document.addEventListener('mousedown', _outsideClick, { once: true, capture: true });
      document.addEventListener('keydown', _onEsc, { once: true });
      // Close-on-scroll is for a menu floated next to a board card, which
      // moves when the page scrolls. A picker (openPicker) hangs off a chip
      // in a fixed overlay — the job detail, the card-detail modal — that
      // doesn't move, and a live data refresh re-rendering the board behind
      // that overlay shrinks the page for a frame, clamps scrollY and fires
      // this. It dismissed the stage picker mid-choice (2026-09-25 phone
      // audit: document height 1049→849, scrollY 369→169, menu gone the
      // same millisecond).
      if (!(opts && opts.keepOnScroll)) window.addEventListener('scroll', closeMenu, { once: true, passive: true });
      // Close on the next contextmenu so a second right-click on a
      // different card opens its menu.
      document.addEventListener('contextmenu', _onSecondContext, { once: true, capture: true });
    }, 0);

    return menu;
  }

  function closeSubmenu() {
    if (submenuEl && submenuEl.parentNode) submenuEl.parentNode.removeChild(submenuEl);
    submenuEl = null;
  }

  function closeMenu() {
    closeSubmenu();
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    // Disarm this menu's dismiss listeners. They are `once`, so any that
    // didn't fire stayed armed after an item pick or Esc — and the next
    // menu opened (e.g. a picker, which doesn't arm close-on-scroll) was
    // closed by the previous menu's leftover listener.
    document.removeEventListener('mousedown', _outsideClick, true);
    document.removeEventListener('keydown', _onEsc);
    window.removeEventListener('scroll', closeMenu);
    document.removeEventListener('contextmenu', _onSecondContext, true);
  }

  function openSubmenu(items, anchor, title) {
    const x = anchor && typeof anchor.x === 'number' ? anchor.x : 100;
    const y = anchor && typeof anchor.y === 'number' ? anchor.y : 100;
    return renderMenu(items, x, y, { isSubmenu: true, title: title || '' });
  }

  function _outsideClick(ev) {
    // Click inside either menu? Keep them both open (item handlers will
    // close us if they need to) — but re-arm the listener so the NEXT
    // outside click still dismisses. The base listener is `once:true` so
    // without this re-arm a single click anywhere consumes the guard.
    if ((submenuEl && submenuEl.contains(ev.target)) ||
        (menuEl && menuEl.contains(ev.target))) {
      document.addEventListener('mousedown', _outsideClick, { once: true, capture: true });
      return;
    }
    closeMenu();
  }
  function _onEsc(ev) {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMenu();
    } else {
      // Re-arm the listener so we don't lose the close-on-Esc.
      document.addEventListener('keydown', _onEsc, { once: true });
    }
  }
  function _onSecondContext(ev) {
    // Don't close if the new contextmenu is on a different card —
    // we'll let the contextmenu handler open the new menu instead.
    closeMenu();
  }

  // ─── Triggers ───────────────────────────────────────────────────
  function findCardEl(target) {
    if (!target) return null;
    return target.closest ? target.closest('.k-card') : null;
  }

  function onContextMenu(ev) {
    const card = findCardEl(ev.target);
    if (!card) return;
    const id = card.getAttribute('data-id');
    if (!id) return;
    const lead = findLead(id);
    if (!lead) return;
    ev.preventDefault();
    buildMenu(lead, ev.clientX, ev.clientY);
  }

  function onTouchStart(ev) {
    const card = findCardEl(ev.target);
    if (!card) return;
    const id = card.getAttribute('data-id');
    if (!id) return;
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    touchStart = { x: t.clientX, y: t.clientY };
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = setTimeout(() => {
      const lead = findLead(id);
      if (!lead) return;
      // Suppress the click that would normally fire after the
      // touchend so the long-press doesn't ALSO open the card.
      const suppressClick = (e) => { e.preventDefault(); e.stopPropagation(); };
      card.addEventListener('click', suppressClick, { once: true, capture: true });
      // Light haptic if supported.
      if (navigator.vibrate) try { navigator.vibrate(15); } catch (e) {}
      buildMenu(lead, touchStart.x, touchStart.y);
      touchTimer = null;
    }, LONG_PRESS_MS);
  }

  function onTouchMove(ev) {
    if (!touchTimer || !touchStart) return;
    const t = ev.touches && ev.touches[0];
    if (!t) return;
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (dx * dx + dy * dy > 100) {  // ~10px slop
      clearTimeout(touchTimer);
      touchTimer = null;
      touchStart = null;
    }
  }

  function onTouchEnd() {
    if (touchTimer) clearTimeout(touchTimer);
    touchTimer = null;
    touchStart = null;
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove',  onTouchMove,  { passive: true });
    document.addEventListener('touchend',   onTouchEnd,   { passive: true });
    document.addEventListener('touchcancel', onTouchEnd,  { passive: true });
  }

  // Reusable picker — opens a single floating menu (no parent) at an
  // anchor. Used by the card-detail modal's clickable stage / type chips,
  // and any other surface that wants the same stage/classification UX
  // without going through the right-click flow.
  function openPicker(items, anchor, title) {
    if (!items || !items.length) return;
    closeMenu();
    const x = anchor && typeof anchor.x === 'number' ? anchor.x : 100;
    const y = anchor && typeof anchor.y === 'number' ? anchor.y : 100;
    return renderMenu(items, x, y, { title: title || '', keepOnScroll: true });
  }

  window.KanbanContextMenu = {
    __sentinel: 'nbd-kanban-ctx-v1',
    open: (leadId, x, y) => {
      const lead = findLead(leadId);
      if (!lead) return;
      buildMenu(lead, x || 100, y || 100);
    },
    openStagePicker: (leadId, anchor) => {
      const lead = findLead(leadId);
      if (!lead) return;
      openPicker(buildStageSubmenuItems(lead), anchor, 'Move to stage');
    },
    openTypePicker: (leadId, anchor) => {
      const lead = findLead(leadId);
      if (!lead) return;
      openPicker(buildTypeSubmenuItems(lead), anchor, 'Change classification');
    },
    close: closeMenu,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
