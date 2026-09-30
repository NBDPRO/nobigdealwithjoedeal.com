/**
 * lead-dedup.js — Wave 15 (Lead deduplication on create)
 *
 * Reps adding leads from the manual form, D2D conversion, or pin
 * drop occasionally re-create a lead that already exists in the
 * CRM (especially when the same homeowner is hit twice on a route,
 * or when a paper note gets typed in days after a digital knock).
 * Once dupes land in Firestore the kanban gets noisy, the same
 * customer can be split across two reps' pipelines, and analytics
 * double-count the address.
 *
 * This module exposes a small helper that — given the in-memory
 * window._leads array and a candidate lead payload — surfaces
 * possible duplicates before the save call. The dashboard's
 * _saveLead consults it on the new-lead path and, if matches are
 * found, opens a modal letting the rep:
 *   - Open the existing lead (skips the save)
 *   - Create anyway (proceeds, stamps duplicateOf for audit)
 *   - Cancel
 *
 * Match strategy (heuristic, not strict):
 *   - HIGH:   identical normalized phone (last 10 digits) OR
 *             identical normalized address
 *   - MEDIUM: identical first+last name AND same street name prefix
 *
 * The dedup is purely client-side and works only against leads
 * already in window._leads, which is fine for the practical case
 * (a rep typing into the same browser/session). A scheduled
 * server-side dedup pass is a possible follow-up but out of scope.
 *
 * Exposes: window.LeadDedup
 */
(function () {
  'use strict';

  if (window.LeadDedup && window.LeadDedup.__sentinel === 'nbd-lead-dedup-v1') return;

  // ─── Normalization ───────────────────────────────────────────────
  function normPhone(p) {
    if (!p) return '';
    const digits = String(p).replace(/\D+/g, '');
    if (digits.length < 10) return '';
    return digits.slice(-10); // last 10 → strips +1 / 1 prefix
  }

  function normAddress(a) {
    if (!a) return '';
    let s = String(a).toLowerCase().trim();
    // Strip city/state/zip after the first comma so "123 Main St,
    // Cincinnati, OH 45202" matches "123 Main St" entered without
    // the city.
    //
    // ONLY when the leading segment actually looks like a street — it needs a
    // house number AND a street name (both a digit and a letter).
    //
    // Marketplace leads frequently carry NO street at all: Thumbtack hands over
    // city + zip when the homeowner didn't give one, and the thumbtackWebhook
    // bridge writes exactly that. Under the old unconditional slice,
    // "Cincinnati, OH 45211" normalized to "cincinnati", so EVERY lead in the
    // same city collapsed to one key and matched at HIGH confidence as "Same
    // address" — a CSV import of 37 Cincinnati leads imported 1 and silently
    // skipped 36 as duplicates.
    //
    // A city + zip is a SERVICE AREA, not a physical address: two different
    // homeowners in 45211 are not the same person. So a street-less address is
    // treated as non-identifying ('') and simply never produces an address
    // match — dedup still catches those leads by phone or by name.
    const head = (s.split(',')[0] || '').trim();
    const looksLikeStreet = /\d/.test(head) && /[a-z]/.test(head);
    if (!looksLikeStreet) return '';
    if (s.indexOf(',') > -1) s = head;
    // Strip apt/unit/# suffixes — same physical residence.
    s = s.replace(/\s+(apt|apartment|unit|suite|ste|#)\.?\s*[\w-]+$/i, '');
    // Common street-type abbreviations → canonical form so
    // "St" === "Street", "Rd" === "Road", etc.
    const streetMap = {
      'st': 'street', 'rd': 'road', 'ave': 'avenue', 'av': 'avenue',
      'blvd': 'boulevard', 'dr': 'drive', 'ln': 'lane', 'ct': 'court',
      'cir': 'circle', 'pl': 'place', 'pkwy': 'parkway', 'hwy': 'highway',
      'ter': 'terrace', 'sq': 'square', 'tr': 'trail', 'trl': 'trail'
    };
    s = s.split(/\s+/).map(w => {
      const stripped = w.replace(/\.+$/, '');
      return streetMap[stripped] || stripped;
    }).join(' ').trim();
    return s.replace(/\s+/g, ' ');
  }

  function normName(n) {
    if (!n) return '';
    return String(n).toLowerCase().replace(/[^a-z]/g, '').trim();
  }

  function streetPrefix(addr) {
    const norm = normAddress(addr);
    // First two tokens — number + street name root.
    return norm.split(' ').slice(0, 2).join(' ');
  }

  // Last 5-digit ZIP in the address ('' if none).
  function zipOf(addr) {
    const m = String(addr || '').match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/);
    return m ? m[1] : '';
  }

  // ─── Match scoring ──────────────────────────────────────────────
  // Returns an array of { lead, confidence: 'high'|'medium', reason }
  // entries, sorted highest-confidence first.
  function findDuplicates(candidate, existingLeads) {
    if (!candidate || !Array.isArray(existingLeads)) return [];

    const cPhone   = normPhone(candidate.phone);
    const cAddr    = normAddress(candidate.address);
    const cFirst   = normName(candidate.firstName);
    const cLast    = normName(candidate.lastName);
    const cPrefix  = streetPrefix(candidate.address);

    const matches = [];
    for (const lead of existingLeads) {
      if (!lead || lead.deleted) continue;
      // Skip the lead being edited (caller-supplied id).
      if (candidate.id && lead.id === candidate.id) continue;

      const lPhone   = normPhone(lead.phone);
      const lAddr    = normAddress(lead.address);
      const lFirst   = normName(lead.firstName);
      const lLast    = normName(lead.lastName);
      const lPrefix  = streetPrefix(lead.address);

      if (cPhone && cPhone === lPhone) {
        matches.push({ lead, confidence: 'high', reason: 'Same phone number' });
        continue;
      }
      if (cAddr && cAddr === lAddr) {
        matches.push({ lead, confidence: 'high', reason: 'Same address' });
        continue;
      }
      if (cFirst && cLast && cFirst === lFirst && cLast === lLast) {
        if (cPrefix && cPrefix === lPrefix) {
          matches.push({ lead, confidence: 'medium', reason: 'Same name on the same street' });
        } else if (!cAddr || !lAddr) {
          // 2026-09-30 (Rose Mitchell): a Thumbtack card carries only
          // "Mason, OH 45040" and a proxy phone, so neither the address nor
          // the phone could ever match, and the same homeowner was added a
          // second time. Same full name where either side has NO street is
          // treated as a likely duplicate (Jo: no duplicate customers).
          matches.push({ lead, confidence: 'medium', reason: 'Same name — one of them has no street address' });
        } else if (zipOf(candidate.address) && zipOf(candidate.address) === zipOf(lead.address)) {
          // Same name in the same ZIP, different street: often the same
          // customer at a second property (Brian McGlynn, Larry Cunningham).
          matches.push({ lead, confidence: 'medium', reason: 'Same name in the same ZIP' });
        }
      }
    }
    matches.sort((a, b) => (a.confidence === 'high' ? -1 : 1) - (b.confidence === 'high' ? -1 : 1));
    return matches;
  }

  // ─── Modal ──────────────────────────────────────────────────────
  // Shows a blocking modal with the matched leads and three actions.
  // Resolves with one of:
  //   { action: 'open',        leadId }   — caller should navigate
  //   { action: 'create',      duplicateOf } — caller should save with audit stamp
  //   { action: 'cancel' }
  function promptUser(matches, candidate) {
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.id = 'nbd-dedup-overlay';
      overlay.style.cssText = `
        position:fixed; inset:0; background:rgba(0,0,0,0.55); z-index:99996;
        display:flex; align-items:center; justify-content:center; padding:20px;
        font-family:'Barlow',-apple-system,system-ui,sans-serif;`;
      overlay.innerHTML = `
        <div style="
          background:var(--s,#1a1f2a); border:1px solid var(--br,#2a3344);
          border-radius:12px; padding:22px; max-width:480px; width:100%;
          max-height:80vh; overflow:auto; box-shadow:0 8px 32px rgba(0,0,0,0.5);
          color:var(--t,#e8eaf0);">
          <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
            <span style="font-size:22px;">⚠️</span>
            <h2 style="font-size:17px; margin:0; color:var(--t,#e8eaf0);">Possible duplicate</h2>
          </div>
          <p style="font-size:13px; color:var(--m,#9aa3b2); margin:0 0 16px; line-height:1.5;">
            We found ${matches.length} ${matches.length === 1 ? 'lead' : 'leads'} that look like the same customer. Open the existing one, or save anyway if this is a separate household.
          </p>
          <div id="nbd-dedup-matches" style="display:flex; flex-direction:column; gap:8px; margin-bottom:18px;">
            ${matches.slice(0, 3).map(({ lead, confidence, reason }) => {
              const name = `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || lead.address || 'Unnamed lead';
              const sub  = [lead.address, lead.phone].filter(Boolean).join(' · ');
              const tag  = confidence === 'high'
                ? '<span style="background:#fee2e2; color:#991b1b; font-size:10px; font-weight:700; padding:2px 7px; border-radius:999px; text-transform:uppercase; letter-spacing:0.4px;">High match</span>'
                : '<span style="background:#fef3c7; color:#854d0e; font-size:10px; font-weight:700; padding:2px 7px; border-radius:999px; text-transform:uppercase; letter-spacing:0.4px;">Possible</span>';
              return `
                <button class="nbd-dedup-match-btn" data-lead-id="${escapeAttr(lead.id)}"
                  style="
                    text-align:left; padding:11px 13px; border-radius:8px;
                    border:1px solid var(--br,#2a3344); background:var(--s2,#0f1419);
                    color:var(--t,#e8eaf0); cursor:pointer; transition:background .15s;
                    -webkit-tap-highlight-color:transparent;">
                  <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:3px;">
                    <strong style="font-size:14px;">${escapeText(name)}</strong>
                    ${tag}
                  </div>
                  <div style="font-size:11px; color:var(--m,#9aa3b2); margin-bottom:4px;">${escapeText(sub) || '—'}</div>
                  <div style="font-size:10px; color:var(--orange,#A14A22);">${escapeText(reason)} · Click to open</div>
                </button>`;
            }).join('')}
          </div>
          <div style="display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap;">
            <button id="nbd-dedup-cancel" style="
              background:transparent; color:var(--m,#9aa3b2);
              border:1px solid var(--br,#2a3344); padding:9px 16px;
              border-radius:8px; font-size:13px; font-weight:600; cursor:pointer;
              -webkit-tap-highlight-color:transparent;">Cancel</button>
            <button id="nbd-dedup-create" style="
              background:linear-gradient(135deg,#BD5728 0%,#A14A22 100%);
              color:#fff; border:none; padding:9px 18px; border-radius:8px;
              font-size:13px; font-weight:600; cursor:pointer;
              -webkit-tap-highlight-color:transparent;">Create anyway</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      function close() { overlay.remove(); }

      overlay.querySelectorAll('.nbd-dedup-match-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const leadId = btn.getAttribute('data-lead-id');
          close();
          resolve({ action: 'open', leadId });
        });
        btn.addEventListener('mouseover', () => { btn.style.background = 'var(--s,#1a1f2a)'; });
        btn.addEventListener('mouseout',  () => { btn.style.background = 'var(--s2,#0f1419)'; });
      });
      overlay.querySelector('#nbd-dedup-cancel').addEventListener('click', () => {
        close();
        resolve({ action: 'cancel' });
      });
      overlay.querySelector('#nbd-dedup-create').addEventListener('click', () => {
        close();
        resolve({ action: 'create', duplicateOf: matches[0].lead.id });
      });
      overlay.addEventListener('click', e => {
        if (e.target === overlay) {
          close();
          resolve({ action: 'cancel' });
        }
      });
    });
  }

  function escapeText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function escapeAttr(s) { return escapeText(s); }

  // ─── Main entry point ───────────────────────────────────────────
  // Returns a Promise that resolves with one of:
  //   { proceed: true }                            — no dupes, safe to save
  //   { proceed: true,  duplicateOf: <leadId> }    — user said "Create anyway"
  //   { proceed: false, openLeadId: <leadId> }     — user picked an existing lead
  //   { proceed: false }                           — user cancelled
  async function checkAndPrompt(candidate, existingLeads) {
    const matches = findDuplicates(candidate, existingLeads || window._leads || []);
    if (matches.length === 0) return { proceed: true };
    const result = await promptUser(matches, candidate);
    if (result.action === 'open')   return { proceed: false, openLeadId: result.leadId };
    if (result.action === 'create') return { proceed: true,  duplicateOf: result.duplicateOf };
    return { proceed: false }; // cancel
  }

  window.LeadDedup = {
    __sentinel: 'nbd-lead-dedup-v1',
    findDuplicates,
    checkAndPrompt,
    // Exposed for tests:
    _normPhone: normPhone,
    _normAddress: normAddress,
    _normName: normName,
  };
})();
