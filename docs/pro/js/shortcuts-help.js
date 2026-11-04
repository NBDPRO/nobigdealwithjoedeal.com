/**
 * shortcuts-help.js — Wave 22 (Keyboard Shortcuts Cheat Sheet)
 *
 * The dashboard has had a #shortcutsPanel modal sitting fully
 * populated with content but completely unwired since the v5
 * refactor — onclick handlers referenced closeShortcutsPanel()
 * that never existed, and the "?" key did nothing. Same dead-UI
 * pattern as the cmd palette (Wave 18) and notification bell
 * (Wave 13).
 *
 * This module wires:
 *   1. window.openShortcutsPanel / closeShortcutsPanel so the
 *      existing HTML's onclick handlers stop being dead refs
 *   2. "?" key (Shift+/ on most layouts) → opens the panel
 *      (only when not focused inside an input/textarea)
 *   3. Esc inside the panel → closes
 *   4. The unwired shortcuts the cheat sheet ADVERTISES so the
 *      panel doesn't lie:
 *        - C / N → openLeadModal()  (already exposed)
 *        - E     → openEstimateV2Builder()  (already exposed)
 *        - 1-7   → scrollIntoView the corresponding kanban column
 *
 * Cmd+K / / / Esc / ↑↓/Enter were already wired by Wave 18; this
 * module composes alongside global-search.js without conflict.
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['shortcuts-help']) return;
  __NBD_LOADED['shortcuts-help'] = true;

  // Map key '1'-'7' to the stage key (matching the cheat sheet copy).
  // The kanban renders columns with id="kcol-${stageKey}", so we
  // scroll those into view. We try a couple of stage-key variants
  // since the codebase uses both "estimate_sent" and "estimate_submitted"
  // depending on the pipeline view.
  const KANBAN_KEY_TO_STAGES = {
    '1': ['new'],
    '2': ['contacted'],
    '3': ['estimate_submitted', 'estimate_sent_cash', 'estimate_sent'],
    '4': ['negotiating'],
    '5': ['contract_signed'],
    '6': ['closed'],
    '7': ['lost'],
  };

  // ─── Helpers ─────────────────────────────────────────────────────
  function isTypingInForm(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function isAnyModalOpen() {
    // Don't intercept keys when the user is mid-flow in another modal.
    // Cmd palette, dedup overlay, slow-load overlay, etc.
    if (document.getElementById('cmdPalette')?.style.display === 'flex') return true;
    // Any nbdModal / dialog that is showing: .modal-bg.open, <dialog open>, a visible aria-modal
    // overlay (the knock sheet, the widget picker ...). "n" / "e" used to open Add Lead / New Estimate behind them.
    if (window.nbdModal && typeof window.nbdModal.anyOpen === 'function' && window.nbdModal.anyOpen()) return true;
    if (document.getElementById('nbd-dedup-overlay')) return true;
    if (document.getElementById('slow-load-hint')) return true;
    if (document.getElementById('nbd-pwa-ios-modal')) return true;
    if (document.getElementById('nbd-pwa-and-modal')) return true;
    return false;
  }

  function panelEl() {
    return document.getElementById('shortcutsPanel');
  }

  function isPanelOpen() {
    const p = panelEl();
    return p && p.style.display !== 'none';
  }

  function openPanel() {
    const p = panelEl();
    if (!p) return;
    // Set explicit display:flex — CSS default is now `display:none` so an
    // empty inline value would leave the panel hidden.
    p.style.display = 'flex';
  }

  function closePanel() {
    const p = panelEl();
    if (!p) return;
    p.style.display = 'none';
  }

  // ─── Kanban column scroll ───────────────────────────────────────
  function scrollToStage(stageKeys) {
    if (!Array.isArray(stageKeys)) stageKeys = [stageKeys];
    for (const sk of stageKeys) {
      const col = document.getElementById('kcol-' + sk);
      if (col) {
        col.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        // Brief flash to confirm the jump.
        const prevOutline = col.style.outline;
        const prevTransition = col.style.transition;
        col.style.transition = 'outline-color .25s ease';
        col.style.outline = '2px solid var(--orange, #A14A22)';
        setTimeout(() => {
          col.style.outline = prevOutline;
          col.style.transition = prevTransition;
        }, 600);
        return true;
      }
    }
    return false;
  }

  // Make sure we're actually viewing the CRM tab before honoring
  // numeric kanban shortcuts. If we're on the dashboard home, switch
  // to CRM first, then scroll on the next tick.
  function jumpToKanbanColumn(stageKeys) {
    const onCrm = document.querySelector('#view-crm.active') !== null
                  || document.querySelector('.view.active')?.id === 'view-crm';
    if (onCrm) {
      scrollToStage(stageKeys);
    } else if (typeof window.goTo === 'function') {
      window.goTo('crm');
      setTimeout(() => scrollToStage(stageKeys), 220);
    } else {
      scrollToStage(stageKeys);
    }
  }

  // ─── Keybindings ────────────────────────────────────────────────
  function onKeydown(ev) {
    // Esc closes the panel if open (Cmd palette + slow-load + dedup
    // already handle their own Esc — we run after them).
    if (ev.key === 'Escape' && isPanelOpen()) {
      ev.preventDefault();
      closePanel();
      return;
    }
    // Skip everything else if the user is typing or another modal is up.
    if (isTypingInForm(ev.target)) return;
    if (isAnyModalOpen()) return;

    // "?" — Shift+/ on most layouts. ev.key handles both.
    if (ev.key === '?' && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      ev.preventDefault();
      if (isPanelOpen()) closePanel();
      else openPanel();
      return;
    }

    // Block numeric/letter shortcuts while the panel is open so the
    // user can read instead of triggering things.
    if (isPanelOpen()) return;

    // Single-modifier-free letter keys.
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key && ev.key.toLowerCase();

    // C / N — new lead.
    if ((k === 'c' || k === 'n') && typeof window.openLeadModal === 'function') {
      ev.preventDefault();
      try { window.openLeadModal(); } catch (e) { console.warn('[shortcuts]', e); }
      return;
    }
    // E — new estimate (V2 builder).
    if (k === 'e' && typeof window.openEstimateV2Builder === 'function') {
      ev.preventDefault();
      try { window.openEstimateV2Builder(); } catch (e) { console.warn('[shortcuts]', e); }
      return;
    }
    // 1-7 — scroll kanban column into view.
    if (Object.prototype.hasOwnProperty.call(KANBAN_KEY_TO_STAGES, ev.key)) {
      ev.preventDefault();
      jumpToKanbanColumn(KANBAN_KEY_TO_STAGES[ev.key]);
      return;
    }
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    document.addEventListener('keydown', onKeydown);
    // Also click outside the modal content closes — the existing HTML
    // has a .cmd-overlay div with onclick=closeShortcutsPanel(); we
    // expose that name now.
  }

  // Expose for the existing onclick handlers in dashboard.html
  window.openShortcutsPanel = openPanel;
  window.closeShortcutsPanel = closePanel;

  const ShortcutsHelp = {
    open: openPanel,
    close: closePanel,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
