/**
 * lead-snooze.js — Wave 35 (Snooze a lead until a future date)
 *
 * Every rep has 5-10 leads at any time they want to push out — the
 * customer who said "call me in two weeks", the homeowner waiting on
 * adjuster paperwork, the spring-storm prospect who's not actionable
 * until storm season. Until now those leads sat on the kanban
 * cluttering the view and tripping bell + Hot Leads + Needs
 * Attention into surfacing them as stale.
 *
 * This wave introduces a tiny per-lead "snoozedUntil" field plus
 * filter integration:
 *
 *   - lead-snooze.js (this module): API + UI for set/clear/prompt
 *   - kanban-context-menu.js: adds 💤 Snooze / ⏰ Unsnooze item
 *   - hot-leads-widget.js: skips snoozed leads
 *   - needs-attention-filter.js: skips snoozed leads
 *   - notif-bell.js: skips stale-stage + overdue-task signals on
 *                    snoozed leads (estimates still show — those
 *                    aren't suppressed by the rep's deferral)
 *   - crm.js: kanban hides snoozed cards by default; "Show
 *             snoozed" header toggle to bring them back
 *   - customer.html: banner at top "Snoozed until <date>" with
 *                    a one-tap Unsnooze when the lead is
 *                    currently snoozed
 *
 * Auto-unsnooze: when `snoozedUntil < now`, every filter just
 * passes the lead through — no cron, no scheduler, just
 * inequality-on-read.
 *
 * Exposes: window.LeadSnooze
 */
(function () {
  'use strict';

  if (window.LeadSnooze && window.LeadSnooze.__sentinel === 'nbd-lead-snooze-v1') return;

  // ─── Helpers ─────────────────────────────────────────────────────
  function toMillis(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function')   return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? 0 : d.getTime(); }
    return 0;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function _toast(msg, type) {
    if (typeof window.showToast === 'function') window.showToast(msg, type || 'info');
  }

  // ─── Snooze status ──────────────────────────────────────────────
  // W74: stale-snooze threshold. 3+ deferrals on the same lead is
  // a signal of indecision/inaction — the rep keeps pushing it
  // out without making progress. Surface as a small warning pill
  // on the customer banner + cmd+K snoozed section subtitle.
  const STALE_SNOOZE_THRESHOLD = 3;
  function isStaleSnooze(lead) {
    if (!lead) return false;
    return typeof lead.snoozeCount === 'number'
      && lead.snoozeCount >= STALE_SNOOZE_THRESHOLD;
  }

  function isSnoozed(lead) {
    if (!lead) return false;
    const until = toMillis(lead.snoozedUntil);
    return until > Date.now();
  }

  function snoozedUntilDate(lead) {
    if (!lead) return null;
    const ms = toMillis(lead.snoozedUntil);
    if (ms <= 0) return null;
    return new Date(ms);
  }

  // Friendly label like "Tomorrow", "Next Monday", "Apr 23".
  function formatSnoozeLabel(date) {
    if (!date) return '';
    const now = new Date();
    const sod = new Date(now); sod.setHours(0, 0, 0, 0);
    const tgtSod = new Date(date); tgtSod.setHours(0, 0, 0, 0);
    const dayMs = 86400000;
    const days = Math.round((tgtSod - sod) / dayMs);
    if (days <= 0) return 'today';
    if (days === 1) return 'tomorrow';
    if (days < 7)  return date.toLocaleDateString('en-US', { weekday: 'long' });
    if (days < 14) return 'next ' + date.toLocaleDateString('en-US', { weekday: 'long' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ─── Firestore writes ────────────────────────────────────────────
  // Wave 73: snooze reasons. Optional categorization tag persisted
  // as `snoozedReason` alongside `snoozedUntil`.
  // Wave 74: snoozeCount — bumps each time a lead is snoozed.
  // Cumulative across unsnooze/re-snooze cycles so we can surface
  // an "indecision" indicator on leads that keep getting bumped
  // (3+ deferrals = stale-snooze). The W74 banner pill + cmd+K
  // subtitle tag tell the rep "different action needed here."
  async function snooze(leadId, untilDate, reason) {
    if (!leadId) throw new Error('leadId required');
    if (!(untilDate instanceof Date) || isNaN(untilDate)) throw new Error('untilDate required');
    if (!window.db || !window.doc || !window.updateDoc) {
      throw new Error('Firestore not loaded');
    }
    const ref = window.doc(window.db, 'leads', leadId);
    const reasonValue = (typeof reason === 'string' && reason.trim()) ? reason.trim() : null;
    // W74: compute next count from the in-memory cache. Reps don't
    // snooze concurrently from multiple devices on the same lead so
    // we don't need atomic increment — read-modify-write is fine.
    let nextCount = 1;
    if (Array.isArray(window._leads)) {
      const existing = window._leads.find(l => l && l.id === leadId);
      if (existing && typeof existing.snoozeCount === 'number') {
        nextCount = existing.snoozeCount + 1;
      }
    }
    await window.updateDoc(ref, {
      snoozedUntil: untilDate,
      snoozedReason: reasonValue,
      snoozeCount: nextCount,
      updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
    });
    // Patch in-memory cache so the kanban + filters update immediately.
    if (Array.isArray(window._leads)) {
      const i = window._leads.findIndex(l => l && l.id === leadId);
      if (i >= 0) window._leads[i] = { ...window._leads[i], snoozedUntil: untilDate, snoozedReason: reasonValue, snoozeCount: nextCount };
    }
    // Customer detail page also reads window._currentLead (set by
    // loadCustomerData). Patch that mirror so the customer-page
    // banner picks up the new state without a Firestore re-read.
    if (window._currentLead && window._currentLead.id === leadId) {
      window._currentLead = { ...window._currentLead, snoozedUntil: untilDate, snoozedReason: reasonValue, snoozeCount: nextCount };
    }
    try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'snooze' } })); } catch (_) {}
    if (typeof window.renderLeads === 'function') {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
    }
    return true;
  }

  async function unsnooze(leadId) {
    if (!leadId) throw new Error('leadId required');
    // W83: previously this guard was a no-op (just a comment about
    // deleteField), so when Firestore wasn't loaded the call to
    // window.doc(...) below would TypeError. The "Wake up now"
    // banner button would disable, error-toast, and re-enable —
    // confusing flash on a real failure mode. Match snooze()'s
    // guard shape so we throw a clean message.
    if (!window.db || !window.doc || !window.updateDoc) {
      throw new Error('Firestore not loaded');
    }
    const ref = window.doc(window.db, 'leads', leadId);
    await window.updateDoc(ref, {
      snoozedUntil: null,
      snoozedReason: null,
      updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
    });
    if (Array.isArray(window._leads)) {
      const i = window._leads.findIndex(l => l && l.id === leadId);
      if (i >= 0) window._leads[i] = { ...window._leads[i], snoozedUntil: null, snoozedReason: null };
    }
    // Same _currentLead mirror update as snooze() — keeps the
    // customer-page banner in sync without a Firestore re-read.
    if (window._currentLead && window._currentLead.id === leadId) {
      window._currentLead = { ...window._currentLead, snoozedUntil: null, snoozedReason: null };
    }
    try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'unsnooze' } })); } catch (_) {}
    if (typeof window.renderLeads === 'function') {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
    }
    return true;
  }

  // ─── Date picker modal ──────────────────────────────────────────
  // Presets cover the common asks (tomorrow morning / next Monday /
  // 1 week / 2 weeks / 1 month) plus a custom date input. Each
  // preset sets the time to 9 AM local so the lead reappears in the
  // morning, not at midnight.
  function _morningOfDay(date) {
    const d = new Date(date);
    d.setHours(9, 0, 0, 0);
    return d;
  }

  function _nextMonday() {
    const now = new Date();
    const dow = now.getDay();          // 0 Sun, 1 Mon, ..., 6 Sat
    // W83: Sunday case fix. The previous formula `(8 - 0) % 7 = 1`
    // returned tomorrow on Sundays — so a rep clicking "Next
    // Monday" on Sunday got snoozed to MONDAY MORNING, not the
    // Monday a week away. That's a real off-by-one for Sunday-
    // working reps. We now return 8 days on Sunday and 7 on
    // Monday, matching the natural-language sense of "next
    // Monday" for someone planning more than a day ahead.
    let daysUntilMon;
    if (dow === 0)      daysUntilMon = 8;            // Sun → next-next Mon
    else if (dow === 1) daysUntilMon = 7;            // Mon → 1 week
    else                daysUntilMon = (8 - dow);    // Tue=6 ... Sat=2
    const next = new Date(now);
    next.setDate(now.getDate() + daysUntilMon);
    return _morningOfDay(next);
  }

  function _addDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return _morningOfDay(d);
  }

  function buildPresets() {
    const presets = [
      { label: 'Tomorrow morning',  date: _addDays(1) },
      { label: 'Next Monday',       date: _nextMonday() },
      { label: '1 week from now',   date: _addDays(7) },
      { label: '2 weeks from now',  date: _addDays(14) },
      { label: '1 month from now',  date: _addDays(30) },
    ];
    // Wave 78: reorder so the rep's pinned default preset (if any)
    // sits at the top of the list. The default preset is saved to
    // localStorage by the ⭐ pin button in the modal — read it back
    // here so the snooze modal opens with the most-used choice
    // ready to click first.
    const def = getDefaultPresetLabel();
    if (def) {
      const idx = presets.findIndex(p => p.label === def);
      if (idx > 0) {
        const [pinned] = presets.splice(idx, 1);
        presets.unshift(pinned);
      }
    }
    return presets;
  }

  // Wave 78: default-preset persistence. localStorage-backed so
  // the rep's choice survives across sessions but isn't synced
  // across devices (per-device preference, like the W37 show-
  // snoozed toggle).
  const DEFAULT_PRESET_KEY = 'nbd_snooze_default_preset';
  function getDefaultPresetLabel() {
    try { return localStorage.getItem(DEFAULT_PRESET_KEY) || null; } catch (_) { return null; }
  }
  function setDefaultPresetLabel(label) {
    try {
      if (label) localStorage.setItem(DEFAULT_PRESET_KEY, label);
      else       localStorage.removeItem(DEFAULT_PRESET_KEY);
    } catch (_) {}
  }

  // Wave 73: snooze reason presets. Quick-pick chips so the rep
  // doesn't type. None is selected by default; reason is optional.
  // Order is by approximate frequency in the field — Insurance and
  // "Not ready" cover most cases; the others are tail.
  const SNOOZE_REASONS = [
    'Insurance',
    'Not ready',
    'Out of town',
    'Materials',
    'Other',
  ];

  function openSnoozeModal(leadId, leadNameHint, preselectedReason) {
    closeSnoozeModal();
    const overlay = document.createElement('div');
    overlay.id = 'nbd-snooze-overlay';
    // W85: accessibility — proper dialog semantics so screen readers
    // announce the modal as a dialog + describe it via the heading.
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'nbd-snooze-title');
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:var(--z-overlay,10000);
      display:flex; align-items:center; justify-content:center; padding:20px;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;`;

    const presets = buildPresets();
    overlay.innerHTML = `
      <div class="lsm-bgs-ct-bd1pxsolid">
        <div class="lsx-dflex-aicenter-gap10px">
          <span class="lsx-fs24px" aria-hidden="true">💤</span>
          <h2 id="nbd-snooze-title" class="lsx-fs17px-m0">Snooze lead</h2>
        </div>
        <p class="lsx-fs12px-cm-m0014px">
          ${leadNameHint ? escapeHtml(leadNameHint) + ' ' : ''}will hide from the kanban + Hot Leads + Needs Attention until the snooze expires.
        </p>
        <!-- W73: reason picker. Optional. Single-select chips. -->
        <div class="lsx-mb14px">
          <label class="lsx-dblock-fs11px-cm">
            Why? <span class="lsx-ttnone-w500-opa07">(optional)</span>
          </label>
          <div id="nbd-snooze-reasons" class="lsx-dflex-flewrap-gap5px">
            ${SNOOZE_REASONS.map((r) => `
              <button data-reason="${escapeHtml(r)}" type="button" class="lsm-bgs2-cm-bd1pxsolid">
                ${escapeHtml(r)}
              </button>
            `).join('')}
          </div>
        </div>
        <div id="nbd-snooze-presets" class="lsx-dflex-flecolumn-gap6px">
          ${presets.map((p, i) => {
            // W78: ⭐ pin button on each preset. Pinned preset
            // gets a subtle purple-tinted border + reorders to
            // top via buildPresets(). Click ⭐ to pin; click
            // pinned preset's ⭐ again to unpin.
            const isDefault = p.label === getDefaultPresetLabel();
            const presetBorder = isDefault ? 'var(--purple)' : 'var(--br)';
            const star = isDefault ? '⭐' : '☆';
            const starColor = isDefault ? 'var(--purple)' : 'var(--m)';
            return `
            <div class="lsx-dflex-gap6px-aistretch">
              <button data-snooze-i="${i}" type="button" style="
                flex:1; text-align:left; padding:10px 13px; border-radius:8px;
                background:var(--s2); color:var(--t);
                border:1px solid ${presetBorder};
                font: inherit; font-size:13px; font-weight:600;
                cursor:pointer; -webkit-tap-highlight-color:transparent;
                display:flex; justify-content:space-between; align-items:center;">
                <span>${escapeHtml(p.label)}</span>
                <span class="lsx-fs10px-cm-w500">
                  ${escapeHtml(p.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
                </span>
              </button>
              <button data-snooze-pin="${escapeHtml(p.label)}" type="button"
                title="${isDefault ? 'Unpin default' : 'Pin as default'}"
                aria-label="${isDefault ? `Unpin ${escapeHtml(p.label)} as default` : `Pin ${escapeHtml(p.label)} as default preset`}"
                aria-pressed="${isDefault ? 'true' : 'false'}"
                style="
                  width:36px; flex-shrink:0;
                  background:transparent; color:${starColor};
                  border:1px solid var(--br); border-radius:8px;
                  font: inherit; font-size:14px; cursor:pointer;
                  -webkit-tap-highlight-color:transparent;
                  display:flex; align-items:center; justify-content:center;
                  transition:color var(--t-fast,.12s), border-color var(--t-fast,.12s);">
                <span aria-hidden="true">${star}</span>
              </button>
            </div>`;
          }).join('')}
        </div>
        <div class="lsx-bt1pxsolid-pad12px-mb14px">
          <label class="lsx-dblock-fs11px-cm">
            Or pick a date
          </label>
          <div class="lsx-dflex-gap8px">
            <input type="date" id="nbd-snooze-custom" class="lsm-fx1-bgs2-ct">
            <button id="nbd-snooze-custom-go" type="button" class="lsm-bgorange-caccentfg-bdnone">Go</button>
          </div>
        </div>
        <div class="lsx-dflex-jcflexend">
          <button id="nbd-snooze-cancel" type="button" class="lsm-bgtranspar-cm-bd1pxsolid">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Default the custom input to one week out so power users don't
    // have to type a full date.
    const customEl = overlay.querySelector('#nbd-snooze-custom');
    if (customEl) {
      const oneWeek = _addDays(7);
      customEl.value = `${oneWeek.getFullYear()}-${String(oneWeek.getMonth() + 1).padStart(2, '0')}-${String(oneWeek.getDate()).padStart(2, '0')}`;
    }

    // W73: reason chip selection state. Single-select; clicking a
    // selected chip toggles it off so the rep can clear the reason.
    // W84: preselectedReason support — when the modal is reopened
    // by a ⭐ pin click (W78), thread the previously-selected reason
    // back in so the rep doesn't lose their categorization choice.
    let selectedReason = (typeof preselectedReason === 'string' && preselectedReason)
      ? preselectedReason
      : null;
    function refreshReasonChips() {
      overlay.querySelectorAll('[data-reason]').forEach(c => {
        const isSel = c.getAttribute('data-reason') === selectedReason;
        c.style.background = isSel ? 'color-mix(in srgb, var(--purple) 18%, transparent)' : 'var(--s2)';
        c.style.color = isSel ? 'var(--purple)' : 'var(--m)';
        c.style.borderColor = isSel ? 'var(--purple)' : 'var(--br)';
      });
    }
    // Apply initial styling so a preselected reason starts highlighted.
    if (selectedReason) refreshReasonChips();
    overlay.querySelectorAll('[data-reason]').forEach(c => {
      c.addEventListener('click', () => {
        const r = c.getAttribute('data-reason');
        selectedReason = (selectedReason === r) ? null : r;
        refreshReasonChips();
      });
    });

    overlay.querySelectorAll('[data-snooze-i]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.getAttribute('data-snooze-i'), 10);
        const p = presets[i];
        if (!p) return;
        await _doSnooze(leadId, p.date, p.label, selectedReason);
      });
      btn.addEventListener('mouseover', () => { btn.style.background = 'var(--s)'; });
      btn.addEventListener('mouseout',  () => { btn.style.background = 'var(--s2)'; });
    });
    // W78: ⭐ pin handlers. Click toggles default state + re-renders
    // the modal so the pinned preset moves to the top + visual
    // updates immediately. Re-render is cheaper than partial-DOM
    // updates and keeps the modal markup as the single source.
    overlay.querySelectorAll('[data-snooze-pin]').forEach(starBtn => {
      starBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const label = starBtn.getAttribute('data-snooze-pin');
        const cur = getDefaultPresetLabel();
        setDefaultPresetLabel(cur === label ? null : label);
        _toast(cur === label ? 'Default cleared' : `Default: ${label}`, 'info');
        // W84: re-open the modal to refresh state, threading
        // selectedReason through so the rep doesn't lose their
        // categorization choice on pin click. Previously the
        // reopen lost the selection — real friction for reps
        // who picked "Insurance", changed mind on the preset,
        // pinned, then had to re-pick "Insurance".
        closeSnoozeModal();
        openSnoozeModal(leadId, leadNameHint, selectedReason);
      });
    });
    overlay.querySelector('#nbd-snooze-custom-go').addEventListener('click', async () => {
      const v = customEl ? customEl.value : '';
      if (!v) { _toast('Pick a date first', 'error'); return; }
      const d = _morningOfDay(new Date(v + 'T00:00:00'));
      if (isNaN(d) || d.getTime() <= Date.now()) {
        _toast('Pick a future date', 'error');
        return;
      }
      await _doSnooze(leadId, d, formatSnoozeLabel(d), selectedReason);
    });
    overlay.querySelector('#nbd-snooze-cancel').addEventListener('click', closeSnoozeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSnoozeModal(); });
    // W85: keyboard accessibility — Esc closes the modal. Listener
    // attached to overlay so it auto-removes on close (no leak).
    // Initial focus on the first preset so keyboard users can hit
    // Tab to navigate or Enter on the focused element to fire it.
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeSnoozeModal();
      }
    });
    setTimeout(() => {
      const firstPreset = overlay.querySelector('[data-snooze-i]');
      if (firstPreset) firstPreset.focus();
    }, 0);
  }

  function closeSnoozeModal() {
    const el = document.getElementById('nbd-snooze-overlay');
    if (el) el.remove();
  }

  async function _doSnooze(leadId, date, label, reason) {
    closeSnoozeModal();
    try {
      await snooze(leadId, date, reason);
      // W73: include reason in toast so the rep gets confirmation
      // their categorization landed.
      const tail = (typeof reason === 'string' && reason.trim()) ? ` · ${reason}` : '';
      _toast(`Snoozed until ${label}${tail}`, 'success');
    } catch (e) {
      console.error('[snooze] failed', e);
      _toast('Snooze failed: ' + (e.message || 'unknown'), 'error');
    }
  }

  async function _doUnsnooze(leadId) {
    try {
      await unsnooze(leadId);
      _toast('Lead unsnoozed', 'success');
    } catch (e) {
      console.error('[unsnooze] failed', e);
      _toast('Unsnooze failed: ' + (e.message || 'unknown'), 'error');
    }
  }

  // ─── Bulk snooze ────────────────────────────────────────────────
  // Wave 37: lets the rep select N kanban cards via the existing
  // bulk toolbar and snooze them all to the same date in one batch
  // commit. Real "snooze all my fall leads till spring" workflow.
  function openBulkSnoozeModal(leadIds, preselectedReason) {
    closeSnoozeModal();
    if (!Array.isArray(leadIds) || leadIds.length === 0) {
      _toast('No leads selected', 'error');
      return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'nbd-snooze-overlay';
    // W85: matching dialog semantics for the bulk modal.
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'nbd-bulk-snooze-title');
    overlay.style.cssText = `
      position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:var(--z-overlay,10000);
      display:flex; align-items:center; justify-content:center; padding:20px;
      font-family:'Barlow',-apple-system,system-ui,sans-serif;`;

    const presets = buildPresets();
    overlay.innerHTML = `
      <div class="lsm-bgs-ct-bd1pxsolid">
        <div class="lsx-dflex-aicenter-gap10px">
          <span class="lsx-fs24px" aria-hidden="true">💤</span>
          <h2 id="nbd-bulk-snooze-title" class="lsx-fs17px-m0">Snooze ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'}</h2>
        </div>
        <p class="lsx-fs12px-cm-m0014px">
          All selected leads will hide from the kanban + Hot Leads + Needs Attention until the snooze date.
        </p>
        <!-- W73: reason picker for bulk snooze. Same chips as the
             single-lead modal — applies to ALL selected leads. -->
        <div class="lsx-mb14px">
          <label class="lsx-dblock-fs11px-cm">
            Why? <span class="lsx-ttnone-w500-opa07">(optional · applies to all)</span>
          </label>
          <div id="nbd-bulk-snooze-reasons" class="lsx-dflex-flewrap-gap5px">
            ${SNOOZE_REASONS.map((r) => `
              <button data-reason="${escapeHtml(r)}" type="button" class="lsm-bgs2-cm-bd1pxsolid">
                ${escapeHtml(r)}
              </button>
            `).join('')}
          </div>
        </div>
        <div id="nbd-bulk-snooze-presets" class="lsx-dflex-flecolumn-gap6px">
          ${presets.map((p, i) => {
            // W79: ⭐ pin button on each bulk preset, same shape
            // as the W78 per-lead modal. Shared DEFAULT_PRESET_KEY
            // so pinning in either modal reflects in the other.
            // Reorder to top is automatic via buildPresets().
            const isDefault = p.label === getDefaultPresetLabel();
            const presetBorder = isDefault ? 'var(--purple)' : 'var(--br)';
            const star = isDefault ? '⭐' : '☆';
            const starColor = isDefault ? 'var(--purple)' : 'var(--m)';
            return `
            <div class="lsx-dflex-gap6px-aistretch">
              <button data-bsnooze-i="${i}" type="button" style="
                flex:1; text-align:left; padding:10px 13px; border-radius:8px;
                background:var(--s2); color:var(--t);
                border:1px solid ${presetBorder};
                font: inherit; font-size:13px; font-weight:600;
                cursor:pointer; -webkit-tap-highlight-color:transparent;
                display:flex; justify-content:space-between; align-items:center;">
                <span>${escapeHtml(p.label)}</span>
                <span class="lsx-fs10px-cm-w500">
                  ${escapeHtml(p.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}
                </span>
              </button>
              <button data-bsnooze-pin="${escapeHtml(p.label)}" type="button"
                title="${isDefault ? 'Unpin default' : 'Pin as default'}"
                aria-label="${isDefault ? `Unpin ${escapeHtml(p.label)} as default` : `Pin ${escapeHtml(p.label)} as default preset`}"
                aria-pressed="${isDefault ? 'true' : 'false'}"
                style="
                  width:36px; flex-shrink:0;
                  background:transparent; color:${starColor};
                  border:1px solid var(--br); border-radius:8px;
                  font: inherit; font-size:14px; cursor:pointer;
                  -webkit-tap-highlight-color:transparent;
                  display:flex; align-items:center; justify-content:center;
                  transition:color var(--t-fast,.12s), border-color var(--t-fast,.12s);">
                <span aria-hidden="true">${star}</span>
              </button>
            </div>`;
          }).join('')}
        </div>
        <div class="lsx-bt1pxsolid-pad12px-mb14px">
          <label class="lsx-dblock-fs11px-cm">
            Or pick a date
          </label>
          <div class="lsx-dflex-gap8px">
            <input type="date" id="nbd-bulk-snooze-custom" class="lsm-fx1-bgs2-ct">
            <button id="nbd-bulk-snooze-custom-go" type="button" class="lsm-bgorange-caccentfg-bdnone">Go</button>
          </div>
        </div>
        <div class="lsx-dflex-jcflexend">
          <button id="nbd-bulk-snooze-cancel" type="button" class="lsm-bgtranspar-cm-bd1pxsolid">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const customEl = overlay.querySelector('#nbd-bulk-snooze-custom');
    if (customEl) {
      const oneWeek = _addDays(7);
      customEl.value = `${oneWeek.getFullYear()}-${String(oneWeek.getMonth() + 1).padStart(2, '0')}-${String(oneWeek.getDate()).padStart(2, '0')}`;
    }

    // W73: reason chip selection state for the bulk modal. Same
    // single-select pattern as the per-lead modal above.
    // W84: preselectedReason support for pin-click reopens.
    let bulkSelectedReason = (typeof preselectedReason === 'string' && preselectedReason)
      ? preselectedReason
      : null;
    function refreshBulkReasonChips() {
      overlay.querySelectorAll('[data-reason]').forEach(c => {
        const isSel = c.getAttribute('data-reason') === bulkSelectedReason;
        c.style.background = isSel ? 'color-mix(in srgb, var(--purple) 18%, transparent)' : 'var(--s2)';
        c.style.color = isSel ? 'var(--purple)' : 'var(--m)';
        c.style.borderColor = isSel ? 'var(--purple)' : 'var(--br)';
      });
    }
    if (bulkSelectedReason) refreshBulkReasonChips();
    overlay.querySelectorAll('[data-reason]').forEach(c => {
      c.addEventListener('click', () => {
        const r = c.getAttribute('data-reason');
        bulkSelectedReason = (bulkSelectedReason === r) ? null : r;
        refreshBulkReasonChips();
      });
    });

    overlay.querySelectorAll('[data-bsnooze-i]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const i = parseInt(btn.getAttribute('data-bsnooze-i'), 10);
        const p = presets[i];
        if (!p) return;
        await _doBulkSnooze(leadIds, p.date, p.label, bulkSelectedReason);
      });
      btn.addEventListener('mouseover', () => { btn.style.background = 'var(--s)'; });
      btn.addEventListener('mouseout',  () => { btn.style.background = 'var(--s2)'; });
    });
    // W79: ⭐ pin handlers for the bulk modal. Mirror of the W78
    // per-lead handler — shared DEFAULT_PRESET_KEY so pinning in
    // either modal updates the other on next open.
    overlay.querySelectorAll('[data-bsnooze-pin]').forEach(starBtn => {
      starBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const label = starBtn.getAttribute('data-bsnooze-pin');
        const cur = getDefaultPresetLabel();
        setDefaultPresetLabel(cur === label ? null : label);
        _toast(cur === label ? 'Default cleared' : `Default: ${label}`, 'info');
        // W84: preserve bulkSelectedReason on reopen so the rep
        // doesn't re-pick after pinning.
        closeSnoozeModal();
        openBulkSnoozeModal(leadIds, bulkSelectedReason);
      });
    });
    overlay.querySelector('#nbd-bulk-snooze-custom-go').addEventListener('click', async () => {
      const v = customEl ? customEl.value : '';
      if (!v) { _toast('Pick a date first', 'error'); return; }
      const d = _morningOfDay(new Date(v + 'T00:00:00'));
      if (isNaN(d) || d.getTime() <= Date.now()) {
        _toast('Pick a future date', 'error');
        return;
      }
      await _doBulkSnooze(leadIds, d, formatSnoozeLabel(d), bulkSelectedReason);
    });
    overlay.querySelector('#nbd-bulk-snooze-cancel').addEventListener('click', closeSnoozeModal);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeSnoozeModal(); });
    // W85: keyboard accessibility for the bulk modal — same shape
    // as the per-lead modal above.
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeSnoozeModal();
      }
    });
    setTimeout(() => {
      const firstPreset = overlay.querySelector('[data-bsnooze-i]');
      if (firstPreset) firstPreset.focus();
    }, 0);
  }

  async function _doBulkSnooze(leadIds, date, label, reason) {
    closeSnoozeModal();
    if (!window.writeBatch || !window.db || !window.doc) {
      _toast('Bulk snooze unavailable — Firestore not loaded', 'error');
      return;
    }
    try {
      // Chunk for the 500-op writeBatch limit; same shape as
      // commitBulkLeadOp in crm.js.
      // W73: persist snoozedReason alongside snoozedUntil so the
      // bulk batch matches the per-lead snooze() shape.
      const reasonValue = (typeof reason === 'string' && reason.trim()) ? reason.trim() : null;
      // W74: compute next snoozeCount per-lead from the in-memory
      // cache so the bulk path mirrors the per-lead snooze() shape.
      // Build a map keyed by leadId so we can pull each one's prior
      // count without re-iterating window._leads inside the inner
      // batch loop.
      const priorCounts = new Map();
      if (Array.isArray(window._leads)) {
        for (const l of window._leads) {
          if (!l || !l.id) continue;
          if (typeof l.snoozeCount === 'number') priorCounts.set(l.id, l.snoozeCount);
        }
      }
      const newCountFor = id => (priorCounts.get(id) || 0) + 1;

      const CHUNK = 450;
      const updatedAt = window.serverTimestamp ? window.serverTimestamp() : new Date();
      for (let i = 0; i < leadIds.length; i += CHUNK) {
        const slice = leadIds.slice(i, i + CHUNK);
        const batch = window.writeBatch(window.db);
        for (const id of slice) {
          batch.update(window.doc(window.db, 'leads', id), {
            snoozedUntil: date,
            snoozedReason: reasonValue,
            snoozeCount: newCountFor(id),
            updatedAt,
          });
        }
        await batch.commit();
      }

      // Optimistic local cache patch + render so the kanban hides
      // the freshly-snoozed cards immediately. Mirror logic from
      // single-snooze: patch _leads + _currentLead.
      const idSet = new Set(leadIds);
      if (Array.isArray(window._leads)) {
        window._leads = window._leads.map(l =>
          (l && idSet.has(l.id))
            ? { ...l, snoozedUntil: date, snoozedReason: reasonValue, snoozeCount: newCountFor(l.id) }
            : l);
      }
      if (window._currentLead && idSet.has(window._currentLead.id)) {
        window._currentLead = {
          ...window._currentLead,
          snoozedUntil: date,
          snoozedReason: reasonValue,
          snoozeCount: newCountFor(window._currentLead.id),
        };
      }
      try { window.dispatchEvent(new CustomEvent('nbd:data-refreshed', { detail: { source: 'bulk-snooze' } })); } catch (_) {}
      if (typeof window.renderLeads === 'function') {
        try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
      }
      // Best-effort exit from bulk mode now that the action's done.
      if (typeof window.clearBulkSelection === 'function') window.clearBulkSelection();
      // toggleBulkMode is registry-only (crm-portal-bridge.js, Globals Tranche 3
      // T3-C). Absent on customer.html, where _bulkMode is never set — no-op.
      const _nbdReg = window.__NBD_CALL_REGISTRY;
      if (_nbdReg && typeof _nbdReg.toggleBulkMode === 'function' && window._bulkMode) _nbdReg.toggleBulkMode();

      // W73: include reason in toast so the rep gets confirmation
      // their categorization landed.
      const tail = reasonValue ? ` · ${reasonValue}` : '';
      _toast(`Snoozed ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'} until ${label}${tail}`, 'success');
    } catch (e) {
      console.error('[bulk snooze] failed', e);
      _toast('Bulk snooze failed: ' + (e.message || 'unknown'), 'error');
    }
  }

  // ─── Show-snoozed toggle wiring ─────────────────────────────────
  // The kanban header has a Snoozed button that toggles localStorage
  // flag nbd_crm_show_snoozed. We listen for clicks via a window
  // handler + update the toggle button styling + count badge.
  function toggleShowSnoozed() {
    const cur = localStorage.getItem('nbd_crm_show_snoozed') === '1';
    const next = !cur;
    if (next) localStorage.setItem('nbd_crm_show_snoozed', '1');
    else      localStorage.removeItem('nbd_crm_show_snoozed');
    updateSnoozedToggle();
    if (typeof window.renderLeads === 'function') {
      try { window.renderLeads(window._leads, window._filteredLeads); } catch (_) {}
    }
  }

  function updateSnoozedToggle() {
    const btn   = document.getElementById('snoozedToggleBtn');
    const badge = document.getElementById('snoozedCountBadge');
    if (!btn) return;
    const showing = localStorage.getItem('nbd_crm_show_snoozed') === '1';
    const leads = Array.isArray(window._leads) ? window._leads : [];
    const count = leads.filter(l => !l.deleted && isSnoozed(l)).length;

    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
    if (showing) {
      btn.style.background  = 'color-mix(in srgb, var(--purple) 18%, transparent)';
      btn.style.borderColor = 'var(--purple)';
      btn.style.color       = 'var(--purple)';
    } else {
      btn.style.background  = '';
      btn.style.borderColor = '';
      btn.style.color       = '';
    }
    // .active stamped for the Filters-menu highlight + badge sync
    // (see needs-attention-filter.js updateButton for the full note).
    btn.classList.toggle('active', showing);
  }

  // Re-paint on data refresh + once on load.
  window.addEventListener('nbd:data-refreshed', updateSnoozedToggle);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(updateSnoozedToggle, 1500));
  } else {
    setTimeout(updateSnoozedToggle, 1500);
  }

  // ─── Public API ─────────────────────────────────────────────────
  window.LeadSnooze = {
    __sentinel: 'nbd-lead-snooze-v1',
    isSnoozed,
    isStaleSnooze,
    STALE_SNOOZE_THRESHOLD,
    snoozedUntilDate,
    formatSnoozeLabel,
    snooze,
    unsnooze,
    prompt: openSnoozeModal,
    promptUnsnooze: _doUnsnooze,
    bulkPrompt: openBulkSnoozeModal,
    // Programmatic bulk snooze — the same chunked writeBatch the bulk modal
    // commits, for a caller that already asked its own ONE confirm
    // (no-next-step.js's door-knock group, 2026-10-03).
    bulkSnooze: (leadIds, untilDate, reason) => {
      if (!Array.isArray(leadIds) || !leadIds.length) return Promise.resolve();
      if (!(untilDate instanceof Date) || isNaN(untilDate)) return Promise.reject(new Error('untilDate required'));
      return _doBulkSnooze(leadIds, untilDate, formatSnoozeLabel(untilDate), reason);
    },
    closeModal: closeSnoozeModal,
    toggleShowSnoozed,
    updateSnoozedToggle,
    // W78: default-preset accessors so other surfaces (settings
    // panel, future quick-action buttons) can read/write the
    // pinned default without re-implementing the localStorage key.
    getDefaultPresetLabel,
    setDefaultPresetLabel,
  };
  // Tranche 3 map-graduate (2026-09-02): toggleShowSnoozed is reached ONLY
  // via _NBD_TOGGLE_FNS.showSnoozed → _nbdResolveMapped (registry-first
  // since T3-M) — registry-only now; the LeadSnooze namespace member above
  // stays as the keep-as-API surface.
  window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
  Object.assign(window.__NBD_CALL_REGISTRY, { toggleShowSnoozed: toggleShowSnoozed });
})();
