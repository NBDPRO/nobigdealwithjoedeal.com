/**
 * global-search.js — Wave 18 (Cmd+K Global Search)
 *
 * Same pattern as the notification bell (Wave 13): the dashboard
 * already had a #cmdPalette modal sitting in the DOM with onclick
 * handlers (closeCmdPalette) referencing functions that never
 * existed. This module wires the palette into a real Cmd+K /
 * Ctrl+K / "/" search across the in-memory leads + estimates
 * caches so reps can jump to anything in two keystrokes.
 *
 * Sources of truth:
 *   - Leads      — window._leads (firstName, lastName, address,
 *                  phone, customerId)
 *   - Estimates  — window._estimates (joined to lead by leadId)
 *
 * Keybindings:
 *   - Cmd+K  / Ctrl+K  — toggle palette
 *   - "/" key          — open palette (only when not already
 *                         typing in another input/textarea)
 *   - Esc              — close palette
 *   - ↑/↓              — move selection
 *   - Enter            — navigate to selected
 *
 * Exposes: window.openCmdPalette, window.closeCmdPalette,
 *          GlobalSearch.{search, focus}
 */
(function () {
  'use strict';

  const __NBD_LOADED = window.__NBD_LOADED = window.__NBD_LOADED || {};
  if (__NBD_LOADED['global-search']) return;
  __NBD_LOADED['global-search'] = true;

  const MAX_RESULTS_PER_GROUP = 8;
  const MIN_QUERY = 1;

  let selectedIndex = 0;
  let lastResults = []; // flat list, in render order
  let inputDebounceTimer = null;

  // Wave 77: snoozed-section reason filter. Persists across the
  // empty-cmd+K renders within one session so the rep can chip
  // through their snooze backlog without re-clicking each time.
  // Cleared when the palette closes (see closePalette).
  // Values: null = "All", a reason string ("Insurance" etc.), or
  // the sentinel '__stale__' for "Stale only".
  let snoozeFilter = null;

  // ─── Helpers ─────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function normalize(s) {
    return String(s || '').toLowerCase().trim();
  }

  function leadName(l) {
    const n = `${l.firstName || ''} ${l.lastName || ''}`.trim();
    return n || l.address || 'Unnamed lead';
  }

  function highlight(text, query) {
    if (!text || !query) return escapeHtml(text);
    const safe = escapeHtml(text);
    if (query.length < 1) return safe;
    // Escape regex special chars in the query.
    const re = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig');
    return safe.replace(re, '<mark style="background:var(--orange,#A14A22);color:var(--accent-fg);padding:0 2px;border-radius:2px;font-weight:600;">$1</mark>');
  }

  // ─── Search ──────────────────────────────────────────────────────
  function searchLeads(query, leads) {
    const q = normalize(query);
    if (!q) return [];
    // Only a PHONE-SHAPED query searches phones, and only from 3 digits.
    // Stripping every non-digit from any query turned "zzqa-imp1" (an email)
    // into "1" and "12 oak" into "12" — every lead with that digit anywhere in
    // its phone matched at phone strength (70), outranking the real email /
    // address hit (CRM sweep R13, 2026-09-28). Same 3-digit floor as the
    // Cmd+K palette (command-palette.js).
    const phoneDigits = (/^[\d\s().+\-]+$/.test(q) && q.replace(/\D+/g, '').length >= 3)
      ? q.replace(/\D+/g, '') : '';
    const results = [];
    for (const l of leads) {
      if (!l || l.deleted) continue;
      const name   = normalize(`${l.firstName || ''} ${l.lastName || ''}`);
      const addr   = normalize(l.address);
      const phone  = (l.phone || '').replace(/\D+/g, '');
      const custId = normalize(l.customerId);
      const email  = normalize(l.email);
      let score = 0;
      let reason = '';

      // Customer ID — highest specificity, often used as a quick lookup
      if (custId && custId.includes(q))   { score += 100; reason = `Customer ID: ${l.customerId}`; }
      // Name match
      else if (name && name.includes(q))  { score += 80;  reason = ''; }
      // Phone digits match
      else if (phoneDigits && phone && phone.includes(phoneDigits)) {
        score += 70; reason = `Phone: ${l.phone}`;
      }
      // Address match
      else if (addr && addr.includes(q))  { score += 50; reason = `Address: ${l.address}`; }
      // Email match
      else if (email && email.includes(q)){ score += 40; reason = `Email: ${l.email}`; }

      if (score > 0) results.push({ type: 'lead', lead: l, score, reason });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS_PER_GROUP);
  }

  function searchEstimates(query, estimates, leads) {
    const q = normalize(query);
    if (!q) return [];
    const leadById = {};
    for (const l of leads) leadById[l.id] = l;
    const results = [];
    for (const e of estimates) {
      if (!e) continue;
      const lead = leadById[e.leadId] || null;
      const leadStr = lead ? normalize(leadName(lead)) : '';
      const total = String(Math.round(Number(e.total || e.amount || 0)));
      const estNum = normalize(e.estimateNumber || e.number || '');
      let score = 0;
      let reason = '';
      if (estNum && estNum.includes(q))             { score += 90; reason = `Estimate #${e.estimateNumber || e.number}`; }
      else if (leadStr && leadStr.includes(q))      { score += 70; }
      else if (total && total.includes(q.replace(/\D+/g, ''))) { score += 40; reason = `$${Number(total).toLocaleString()}`; }
      if (score > 0) results.push({ type: 'estimate', estimate: e, lead, score, reason });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, MAX_RESULTS_PER_GROUP);
  }

  // ─── Render ──────────────────────────────────────────────────────
  // Wave 77: chip click wiring. Toggles snoozeFilter and re-renders.
  // Clicking the active chip clears the filter (back to "All").
  function _wireSnoozeFilterChips(container) {
    container.querySelectorAll('[data-snooze-filter]').forEach(chip => {
      chip.addEventListener('click', () => {
        const raw = chip.getAttribute('data-snooze-filter');
        const next = raw === '__all__' ? null : raw;
        // Toggle off if clicking the active chip — same UX as the
        // W73 reason chips in the snooze modal.
        snoozeFilter = (snoozeFilter === next) ? null : next;
        const inputEl = document.getElementById('cmdInput');
        renderResults(inputEl ? (inputEl.value || '') : '');
      });
    });
  }

  function renderResults(query) {
    const container = document.getElementById('cmdResults');
    if (!container) return;
    selectedIndex = 0;
    lastResults = [];

    const leads = Array.isArray(window._leads) ? window._leads : [];
    const estimates = Array.isArray(window._estimates) ? window._estimates : [];

    let leadHits, estHits, leadSectionLabel = 'Leads', preHTML = '';

    if (!query || query.length < MIN_QUERY) {
      // Wave 71: empty-cmd+K Snoozed section. When the rep opens
      // cmd+K with no query, the hero text still appears AND the
      // currently-snoozed leads surface as a "Snoozed (N)" section
      // sorted by snoozed-until ascending (returning-soonest first).
      // Lets reps recover/triage their snooze backlog via search
      // without flipping the W37 "show snoozed" kanban toggle.
      //
      // Compounds W18 (cmd+K) + W35 (snooze) + W61 (cmd+K snooze
      // button). Once you can snooze a lead from cmd+K, you should
      // also be able to find them again from cmd+K.
      preHTML = `
        <div class="cmd-empty">
          <div style="font-size:32px;margin-bottom:8px;opacity:0.4;">🔍</div>
          <div style="margin-bottom:6px;color:var(--t,#e8eaf0);font-weight:600;">Find anything in your CRM</div>
          <div style="font-size:11px;line-height:1.6;">
            Type a name, address, phone, customer ID, or estimate amount.<br>
            Use <span class="cmd-kbd">↑</span> <span class="cmd-kbd">↓</span> to navigate, <span class="cmd-kbd">↵</span> to open.
          </div>
        </div>`;

      const snoozedHits = [];
      // W77: reason-filter chip set built BEFORE slicing so chips
      // reflect the full backlog count, not the post-slice top-10.
      const filterChips = []; // [{key, label, count}]
      if (window.LeadSnooze && typeof window.LeadSnooze.isSnoozed === 'function') {
        const allSnoozed = leads
          .filter(l => l && !l.deleted && window.LeadSnooze.isSnoozed(l));

        // Build chip counts from the full set (pre-filter).
        const reasonCounts = new Map();
        let staleCount = 0;
        for (const l of allSnoozed) {
          const r = (typeof l.snoozedReason === 'string' && l.snoozedReason.trim())
            ? l.snoozedReason.trim()
            : '';
          if (r) reasonCounts.set(r, (reasonCounts.get(r) || 0) + 1);
          if (typeof window.LeadSnooze.isStaleSnooze === 'function'
              && window.LeadSnooze.isStaleSnooze(l)) {
            staleCount++;
          }
        }
        if (allSnoozed.length > 0) {
          filterChips.push({ key: null, label: 'All', count: allSnoozed.length });
          if (staleCount > 0) {
            filterChips.push({ key: '__stale__', label: '⚠️ Stale', count: staleCount });
          }
          for (const [reason, count] of reasonCounts.entries()) {
            filterChips.push({ key: reason, label: reason, count });
          }
        }

        // Apply active filter before sort + slice.
        let filtered = allSnoozed;
        if (snoozeFilter === '__stale__') {
          filtered = allSnoozed.filter(l =>
            typeof window.LeadSnooze.isStaleSnooze === 'function'
            && window.LeadSnooze.isStaleSnooze(l));
        } else if (typeof snoozeFilter === 'string' && snoozeFilter) {
          filtered = allSnoozed.filter(l =>
            typeof l.snoozedReason === 'string'
            && l.snoozedReason.trim() === snoozeFilter);
        }

        const snoozed = filtered
          .map(l => {
            const d = window.LeadSnooze.snoozedUntilDate(l);
            return { lead: l, untilMs: d ? d.getTime() : Number.MAX_SAFE_INTEGER };
          })
          .sort((a, b) => a.untilMs - b.untilMs)
          .slice(0, 10);
        for (const s of snoozed) {
          // W73: append snooze reason if the rep tagged one.
          // W74: prepend a stale-snooze warning if this lead has
          // been snoozed 3+ times. Reads as
          //   "⚠️ 3× · ⏰ Until Tue Sep 9 · Insurance"
          // so the rep can spot the indecision pattern at a glance
          // in the same scan they use to find returning leads.
          const tag = (s.lead && typeof s.lead.snoozedReason === 'string' && s.lead.snoozedReason.trim())
            ? ` · ${s.lead.snoozedReason.trim()}`
            : '';
          const staleTag = (window.LeadSnooze && typeof window.LeadSnooze.isStaleSnooze === 'function'
                            && window.LeadSnooze.isStaleSnooze(s.lead))
            ? `⚠️ ${s.lead.snoozeCount}× · `
            : '';
          snoozedHits.push({
            type: 'lead',
            lead: s.lead,
            reason: `${staleTag}⏰ Until ${window.LeadSnooze.formatSnoozeLabel(new Date(s.untilMs))}${tag}`,
            icon: '💤',
          });
        }
      }
      leadHits = snoozedHits;
      estHits = [];
      // W77: section label reflects the filter — "Snoozed · Insurance (3)"
      // or "Snoozed · ⚠️ Stale (2)" or just "Snoozed (5)" when All.
      if (snoozedHits.length > 0) {
        let activeLabel = '';
        if (snoozeFilter === '__stale__') activeLabel = ' · ⚠️ Stale';
        else if (typeof snoozeFilter === 'string' && snoozeFilter) activeLabel = ` · ${snoozeFilter}`;
        leadSectionLabel = `Snoozed${activeLabel} (${snoozedHits.length})`;
      } else {
        leadSectionLabel = 'Leads';
      }

      // W77: render filter chip row above the section if there's
      // any snoozed lead at all (even if filter narrows it to 0,
      // the chips need to stay visible so the rep can switch back).
      if (filterChips.length > 0) {
        preHTML += `
          <div id="cmd-snooze-filter" style="display:flex; flex-wrap:wrap; gap:5px; padding:4px 12px 8px; border-bottom:1px solid var(--br,#1e2530);">
            ${filterChips.map(c => {
              const isActive = c.key === snoozeFilter;
              const bg = isActive ? 'rgba(155,109,255,0.18)' : 'var(--s2,#0f1419)';
              const color = isActive ? '#cab8ff' : 'var(--m,#9aa3b2)';
              const border = isActive ? '#9b6dff' : 'var(--br,#2a3344)';
              const keyAttr = c.key === null ? '__all__' : escapeHtml(c.key);
              return `<button data-snooze-filter="${keyAttr}" type="button" style="
                background:${bg}; color:${color};
                border:1px solid ${border}; border-radius:14px;
                padding:3px 10px; font: inherit; font-size:11px; font-weight:600;
                cursor:pointer; -webkit-tap-highlight-color:transparent;
                transition:background .12s, color .12s, border-color .12s;">
                ${escapeHtml(c.label)} <span style="opacity:0.6; margin-left:2px;">${escapeHtml(String(c.count))}</span>
              </button>`;
            }).join('')}
          </div>`;
      }

      // No snoozed leads (after applying filter) → still show hero
      // + chip row so the rep can clear the filter to see the rest.
      if (snoozedHits.length === 0) {
        container.innerHTML = preHTML;
        // Wire chip handlers even though there are no rows.
        _wireSnoozeFilterChips(container);
        return;
      }
    } else {
      leadHits = searchLeads(query, leads);
      estHits  = searchEstimates(query, estimates, leads);

      if (leadHits.length === 0 && estHits.length === 0) {
        container.innerHTML = `
          <div class="cmd-empty">
            <div style="font-size:24px;margin-bottom:8px;opacity:0.4;">🔍</div>
            <div>No matches for "${escapeHtml(query)}".</div>
            <div style="font-size:11px;margin-top:6px;opacity:0.7;">Try a name, partial phone, or street.</div>
          </div>`;
        return;
      }
    }
    lastResults = [...leadHits, ...estHits];

    // Wave 51: inline reshare buttons on lead search results.
    // Same color-coded 📞/💬/📧 trio used by Hot Leads (W47),
    // Almost There (W46), bell rows (W48), and the activity feed
    // (W49). Cmd+K is the fifth and final priority surface — once
    // this lands the share trio is universal across every place
    // a rep can encounter a lead in the app.
    const renderLeadActions = (l) => {
      const phoneDigits = String(l.phone || '').replace(/\D+/g, '');
      const email = String(l.email || '').trim();
      const buttons = [];
      if (phoneDigits) {
        buttons.push(`
          <a class="cmd-action" href="tel:${escapeHtml(phoneDigits)}"
            title="Call ${escapeHtml(l.phone)}"
            style="
              display:flex; align-items:center; justify-content:center;
              width:24px; height:24px; border-radius:5px;
              background:rgba(16,185,129,0.14); color:#10b981;
              text-decoration:none; font-size:11px;
              -webkit-tap-highlight-color:transparent;
              transition:transform .12s;"
            data-gs-stop-self="1"
          >📞</a>`);
        buttons.push(`
          <button class="cmd-action" type="button"
            data-action="sms" data-lead-id="${escapeHtml(l.id)}"
            title="Text portal link to ${escapeHtml(l.phone)}"
            style="
              display:flex; align-items:center; justify-content:center;
              width:24px; height:24px; border-radius:5px;
              background:rgba(59,130,246,0.14); color:#3b82f6;
              border:none; font-size:11px; cursor:pointer;
              -webkit-tap-highlight-color:transparent;
              transition:transform .12s;"
          >💬</button>`);
      }
      if (email) {
        buttons.push(`
          <button class="cmd-action" type="button"
            data-action="email" data-lead-id="${escapeHtml(l.id)}"
            title="Email portal link to ${escapeHtml(email)}"
            style="
              display:flex; align-items:center; justify-content:center;
              width:24px; height:24px; border-radius:5px;
              background:rgba(139,92,246,0.14); color:#8b5cf6;
              border:none; font-size:11px; cursor:pointer;
              -webkit-tap-highlight-color:transparent;
              transition:transform .12s;"
          >📧</button>`);
      }
      // Wave 63: portal preview action. Sits between the share
      // trio and the snooze button so the visual rhythm reads as
      // "talk to them / look at what they see / set them aside."
      // Always available — every lead can be previewed regardless
      // of contact info. Mirrors W56 kanban-context-menu and
      // customer.html "🔍 Preview Portal" button.
      //
      // Preview opens an iframe modal at z-index 99997, which
      // overlays the palette (z-index 10000) — palette stays open
      // underneath so when the rep dismisses the preview they
      // pick up where they left off in their search.
      if (window.PortalLinkHelpers
          && typeof window.PortalLinkHelpers.previewForLead === 'function') {
        buttons.push(`
          <button class="cmd-action" type="button"
            data-action="preview" data-lead-id="${escapeHtml(l.id)}"
            title="Preview the portal — see what the customer will see"
            style="
              display:flex; align-items:center; justify-content:center;
              width:24px; height:24px; border-radius:5px;
              background:rgba(245,158,11,0.14); color:#f59e0b;
              border:none; font-size:11px; cursor:pointer;
              -webkit-tap-highlight-color:transparent;
              transition:transform .12s;"
          >🔍</button>`);
      }
      // Wave 61: Cmd+K direct snooze action. Sits next to the
      // share trio. State-aware label like the W26 kanban context
      // menu — snoozed leads get an "Unsnooze" affordance, fresh
      // leads get the snooze prompt. Available even when the
      // lead has no contact info (snoozing doesn't need it).
      if (window.LeadSnooze) {
        const isSnoozed = window.LeadSnooze.isSnoozed(l);
        if (isSnoozed) {
          buttons.push(`
            <button class="cmd-action" type="button"
              data-action="unsnooze" data-lead-id="${escapeHtml(l.id)}"
              title="Unsnooze (was until ${escapeHtml(window.LeadSnooze.formatSnoozeLabel(window.LeadSnooze.snoozedUntilDate(l)))})"
              style="
                display:flex; align-items:center; justify-content:center;
                width:24px; height:24px; border-radius:5px;
                background:rgba(155,109,255,0.14); color:#cab8ff;
                border:none; font-size:11px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                transition:transform .12s;"
            >⏰</button>`);
        } else {
          buttons.push(`
            <button class="cmd-action" type="button"
              data-action="snooze" data-lead-id="${escapeHtml(l.id)}"
              title="Snooze this lead"
              style="
                display:flex; align-items:center; justify-content:center;
                width:24px; height:24px; border-radius:5px;
                background:rgba(155,109,255,0.10); color:#a890e8;
                border:none; font-size:11px; cursor:pointer;
                -webkit-tap-highlight-color:transparent;
                transition:transform .12s;"
            >💤</button>`);
        }
      }
      if (buttons.length === 0) return '';
      return `<div style="display:flex; gap:3px; flex-shrink:0; align-items:center; margin-right:6px;">${buttons.join('')}</div>`;
    };

    const renderLeadRow = (hit, idx) => {
      const l = hit.lead;
      const name = leadName(l);
      const sub = hit.reason || [l.address, l.phone].filter(Boolean).join(' · ');
      // W71: hit.icon lets the empty-query "Snoozed" section use 💤
      // for its rows. Search hits keep the default 👤.
      const icon = hit.icon || '👤';
      return `
        <div class="cmd-item ${idx === selectedIndex ? 'selected' : ''}" data-cmd-index="${idx}">
          <div class="cmd-icon">${icon}</div>
          <div class="cmd-content">
            <div class="cmd-title">${highlight(name, query)}</div>
            <div class="cmd-subtitle">${highlight(sub || '', query)}</div>
          </div>
          ${renderLeadActions(l)}
          ${l.customerId ? `<span class="cmd-badge recent">${escapeHtml(l.customerId)}</span>` : ''}
        </div>`;
    };

    const renderEstRow = (hit, idx) => {
      const e = hit.estimate;
      const lead = hit.lead;
      const title = `${lead ? leadName(lead) : 'Estimate'} · $${Number(e.total || e.amount || 0).toLocaleString()}`;
      const sub = e.estimateNumber ? `#${e.estimateNumber}` : (e.status || 'estimate');
      return `
        <div class="cmd-item ${idx === selectedIndex ? 'selected' : ''}" data-cmd-index="${idx}">
          <div class="cmd-icon">📄</div>
          <div class="cmd-content">
            <div class="cmd-title">${highlight(title, query)}</div>
            <div class="cmd-subtitle">${escapeHtml(sub)}</div>
          </div>
          <span class="cmd-badge new">Estimate</span>
        </div>`;
    };

    // W71: preHTML carries the empty-state hero when query is
    // empty + there are snoozed leads. Otherwise empty.
    let html = preHTML;
    let runningIdx = 0;
    if (leadHits.length > 0) {
      html += `<div class="cmd-section"><div class="cmd-section-label">${escapeHtml(leadSectionLabel)}</div>`;
      for (const hit of leadHits) html += renderLeadRow(hit, runningIdx++);
      html += '</div>';
    }
    if (estHits.length > 0) {
      html += '<div class="cmd-section"><div class="cmd-section-label">Estimates</div>';
      for (const hit of estHits) html += renderEstRow(hit, runningIdx++);
      html += '</div>';
    }
    container.innerHTML = html;

    // W77: wire the snooze-filter chip handlers if the chip row
    // was rendered. No-op when no chips are present (search-result
    // path renders no chips).
    _wireSnoozeFilterChips(container);

    // Wave 51: inline action button handlers. Wired BEFORE the row
    // click handlers so stopPropagation on the buttons takes effect
    // before the parent .cmd-item click would otherwise activate
    // the selection. SMS + Email delegate to PortalLinkHelpers
    // (W42) which fires the W44 lastSharedAt tracking on success.
    container.querySelectorAll('.cmd-action[data-action]').forEach(btn => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const action = btn.getAttribute('data-action');
        const id = btn.getAttribute('data-lead-id');
        if (!id) return;
        const lead = (Array.isArray(window._leads) ? window._leads : [])
          .find(l => l && l.id === id);
        if (!lead) return;
        if (action === 'sms' && window.PortalLinkHelpers) {
          window.PortalLinkHelpers.smsForLead(lead);
          closePalette();
        } else if (action === 'email' && window.PortalLinkHelpers) {
          window.PortalLinkHelpers.emailForLead(lead);
          closePalette();
        } else if (action === 'preview' && window.PortalLinkHelpers) {
          // Wave 63: preview opens iframe modal on top of the
          // palette (modal z-index 99997 > palette 10000). Don't
          // close the palette — when the rep dismisses the
          // preview they keep their search context for chaining
          // multiple previews.
          window.PortalLinkHelpers.previewForLead(lead);
        } else if (action === 'snooze' && window.LeadSnooze) {
          // Wave 61: snooze action opens the existing W35 preset
          // modal on top of the palette (modal z-index > palette
          // z-index). Leave the palette open underneath so when
          // the rep dismisses the snooze modal they can keep
          // searching where they left off.
          const fullName = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
          window.LeadSnooze.prompt(lead.id, fullName);
        } else if (action === 'unsnooze' && window.LeadSnooze) {
          // Wave 61: unsnooze fires immediately + re-renders the
          // palette so the button flips back to 💤 in place. No
          // need to close the palette — rep can verify the
          // unsnooze + keep working.
          window.LeadSnooze.promptUnsnooze(lead.id).then(() => {
            // Re-render so the button toggles state.
            const inputEl = document.getElementById('cmdInput');
            if (inputEl) renderResults(inputEl.value || '');
          });
        }
        // For 'call' (native tel: anchor) the click handler isn't
        // hit since the <a> handles default. closePalette is
        // suppressed for snooze/unsnooze paths above so we don't
        // disrupt the rep's flow with a snooze modal sitting on
        // top of a closing palette.
      });
    });

    // Wire click handlers (delegation would also work).
    container.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', (ev) => {
        // If the click originated on an action button, it already
        // stopped propagation — but defensive check in case a child
        // element of the button slipped through.
        if (ev.target && ev.target.closest && ev.target.closest('.cmd-action')) return;
        const i = parseInt(el.getAttribute('data-cmd-index'), 10);
        activate(i);
      });
      el.addEventListener('mouseenter', () => {
        const i = parseInt(el.getAttribute('data-cmd-index'), 10);
        if (!isNaN(i)) {
          selectedIndex = i;
          updateSelection();
        }
      });
    });
  }

  function updateSelection() {
    const container = document.getElementById('cmdResults');
    if (!container) return;
    container.querySelectorAll('.cmd-item').forEach((el, i) => {
      el.classList.toggle('selected', i === selectedIndex);
    });
    // Scroll selected into view.
    const sel = container.querySelector('.cmd-item.selected');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }

  function activate(index) {
    const hit = lastResults[index];
    if (!hit) return;
    closePalette();
    if (hit.type === 'lead') {
      // Stash for instant render on customer.html (Wave 11).
      try {
        if (typeof window._stashLeadForCustomerPage === 'function') {
          window._stashLeadForCustomerPage(hit.lead.id);
        }
      } catch (e) {}
      window.location.href = `/pro/customer.html?id=${encodeURIComponent(hit.lead.id)}`;
    } else if (hit.type === 'estimate') {
      window.location.href = `/pro/dashboard.html?tab=estimates&est=${encodeURIComponent(hit.estimate.id)}`;
    }
  }

  // ─── Open / close ────────────────────────────────────────────────
  function openPalette() {
    const palette = document.getElementById('cmdPalette');
    const input = document.getElementById('cmdInput');
    if (!palette || !input) return;
    palette.style.display = 'flex';
    input.value = '';
    selectedIndex = 0;
    lastResults = [];
    renderResults('');
    // Defer focus so iOS Safari actually shows the keyboard reliably.
    setTimeout(() => input.focus(), 30);
  }

  function closePalette() {
    const palette = document.getElementById('cmdPalette');
    if (!palette) return;
    palette.style.display = 'none';
    if (inputDebounceTimer) {
      clearTimeout(inputDebounceTimer);
      inputDebounceTimer = null;
    }
    // W77: reset snooze filter on close so the next palette open
    // starts fresh on "All". Filter is a per-session triage tool,
    // not a persisted preference.
    snoozeFilter = null;
  }

  function isPaletteOpen() {
    const palette = document.getElementById('cmdPalette');
    return palette && palette.style.display !== 'none';
  }

  // ─── Keybindings ─────────────────────────────────────────────────
  function isTypingInForm(target) {
    if (!target) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (target.isContentEditable) return true;
    return false;
  }

  function onGlobalKeydown(ev) {
    // DUP-1 fix: command-palette.js (W133, window.NBDCommand) is the canonical
    // Cmd+K / "/" palette. This legacy Wave-18 palette must NOT also fire on those
    // shortcuts, or BOTH open stacked (one renders over the other). Defer the
    // shortcut to NBDCommand whenever it's loaded; if it's somehow absent, this
    // palette still works as a fallback. Checked per-event so load order is moot.
    const deferToCanonical = !!window.NBDCommand;
    // Cmd+K / Ctrl+K — toggle from anywhere.
    const k = ev.key && ev.key.toLowerCase();
    if (k === 'k' && (ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey) {
      if (deferToCanonical) return;
      ev.preventDefault();
      if (isPaletteOpen()) closePalette();
      else openPalette();
      return;
    }
    // "/" — open only when not focused on an input.
    if (ev.key === '/' && !ev.metaKey && !ev.ctrlKey && !ev.altKey
        && !isTypingInForm(ev.target) && !isPaletteOpen()) {
      if (deferToCanonical) return;
      ev.preventDefault();
      openPalette();
      return;
    }
    // Within the palette: Esc / arrows / Enter.
    if (!isPaletteOpen()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closePalette();
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (lastResults.length === 0) return;
      selectedIndex = Math.min(lastResults.length - 1, selectedIndex + 1);
      updateSelection();
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (lastResults.length === 0) return;
      selectedIndex = Math.max(0, selectedIndex - 1);
      updateSelection();
      return;
    }
    if (ev.key === 'Enter') {
      ev.preventDefault();
      activate(selectedIndex);
      return;
    }
  }

  function onInputChange() {
    const input = document.getElementById('cmdInput');
    if (!input) return;
    const q = input.value || '';
    if (inputDebounceTimer) clearTimeout(inputDebounceTimer);
    inputDebounceTimer = setTimeout(() => {
      renderResults(q);
    }, 80);
  }

  // ─── Init ────────────────────────────────────────────────────────
  function init() {
    const input = document.getElementById('cmdInput');
    if (input) input.addEventListener('input', onInputChange);
    document.addEventListener('keydown', onGlobalKeydown);
  }

  // Wire legacy onclick handlers expected by dashboard.html
  window.openCmdPalette = openPalette;
  window.closeCmdPalette = closePalette;

  const GlobalSearch = {
    open: openPalette,
    close: closePalette,
    search: (q) => {
      const leads = Array.isArray(window._leads) ? window._leads : [];
      const ests  = Array.isArray(window._estimates) ? window._estimates : [];
      return [...searchLeads(q, leads), ...searchEstimates(q, ests, leads)];
    },
    // Leads-only, exposed for reuse outside the Cmd+K palette (e.g. Job
    // Templates' lead picker) — same scoring logic, no duplicated matching.
    searchLeads: (q) => searchLeads(q, Array.isArray(window._leads) ? window._leads : []),
  };
  // Deliberately not the bare "GlobalSearch" name — that's on the smoke
  // test's off-window list (a prior tranche removed it as unused window
  // surface). This is a genuine new cross-file consumer (entity-resolver.js),
  // so it gets its own distinct name instead of relitigating that cleanup.
  window.NbdGlobalSearch = GlobalSearch;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();


(function(){if(window._NBD_GS_STOP_DELEGATE)return;window._NBD_GS_STOP_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-gs-stop-self="1"]');if(t&&ev.target===t)ev.stopPropagation();});})();
