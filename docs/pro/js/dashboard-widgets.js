/**
 * dashboard-widgets.js — render-heavy widgets: estimates list, photo
 * gallery, storm map init, property-intel card, kanban card-detail
 * modal, mobile job-detail screen.
 *
 * Extracted from dashboard-main.js (Step 4a — 2026-05-16). Third in
 * the state→api→widgets→ui→actions→main load chain.
 *
 * Widgets here read from the live data caches (window._leads,
 * window._estimates, window._photoCache, window._user) and render
 * into known DOM containers. They use api functions defined in
 * dashboard-api.js (loadPhotoCounts, renderRecentPhotoFeed via
 * window indirection) and forward most user actions to handlers in
 * dashboard-actions.js (via window.* lookups so load order is safe).
 */

// ══════════════════════════════════════════════
// ESTIMATES LIST + builder open
// ══════════════════════════════════════════════

// Two-shape estimate money read. V2 stores grandTotal; Classic stores
// total|amount — and Classic is what the customer page's own Log Estimate
// flow writes, plus what the demo seed uses. Reading grandTotal alone
// rendered "$0" on estimate cards sitting next to a lead whose Job Value
// showed the real figure, so the same screen contradicted itself.
//
// #1110 corrected the job-detail activity row further down this file but
// missed these two card renderers; this is that fix finished. Defers to the
// canonical reader (customer-estimate-rows.js, loaded on this page) with a
// fallback that mirrors its numFrom so a missing script degrades to the same
// answer rather than to zero.
function _estVal(e) {
  const api = window.NBDCustomerEstimateRows;
  if (api && typeof api.estimateValue === 'function') return api.estimateValue(e);
  if (!e) return 0;
  const v = e.grandTotal != null ? e.grandTotal
    : e.total != null ? e.total
    : e.amount != null ? e.amount : 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const m = String(v == null ? '' : v).match(/-?\d[\d,]*\.?\d*/);
  const n = m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
  return isFinite(n) ? n : 0;
}

// A "logged" estimate is the amount-only record customer.html's Log Estimate
// modal writes (customer-photo-report-generator.js saveEstimate): type, amount,
// grandTotal (= amount), title, notes. It has no builder stamp and none of the
// inputs either builder prices from — no rows, no measurements. That shape is
// what separates it from a genuine pre-2026-04 Classic doc (also unstamped,
// but it carries raw/sq/rows the Classic engine can rebuild from).
function _isLoggedEstimate(e) {
  if (!e || e.builder || e.estimateVersion === 'v2') return false;
  if (Array.isArray(e.rows) && e.rows.length) return false;
  if (Number(e.raw) > 0 || Number(e.sq) > 0) return false;
  return Number(e.amount) > 0;
}

// Dashboard "Latest Estimates" panel (#recentEsts, lives in view-dash).
function _renderRecentEstimates(ests, esc) {
  const rc = document.getElementById('recentEsts');
  if (!rc) return;
  if (!ests || !ests.length) {
    // Deleting the last estimate must clear the old cards, not leave them up.
    rc.innerHTML = '<div class="empty">No estimates yet.</div>';
    return;
  }
  // Each card opens that specific estimate.
  rc.innerHTML=ests.slice(0,4).map(e=>`
    <div class="est-card nbd-recent-est dwx-mb8px-curpointer" data-id="${esc(e.id)}">
      <div class="dwx-fs18px">📋</div>
      <div><div class="est-addr dwx-fs12px">${esc(e.addr||e.name||e.title||'No address')}</div>
      <div class="est-meta">${esc(e.tierName||e.type||'')}</div></div>
      <div class="est-total dwx-fs16px">$${_estVal(e).toLocaleString('en-US',{maximumFractionDigits:0})}</div>
    </div>`).join('');
  rc.querySelectorAll('.nbd-recent-est').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      goTo('est');
      setTimeout(() => viewEstimate(id), 200);
    });
  });
}

let _NBD_DW_DELEGATE; // module-local (globals Tranche 1 — was window.*)
function renderEstimatesList(ests) {
  // Null-guard the analytics stat tiles AND the list wrapper. After the
  // Step 4a split (PR #400), this function gets called on every dashboard
  // load to populate the estimates analytics — but on routes like #/crm
  // the statEsts/statVal/estListWrap elements don't exist in the DOM at
  // all. The previous version (assuming those elements were always
  // present) threw "Cannot set properties of null (setting 'textContent')"
  // which cascaded through bootstrap into a 30-second retry loop that
  // never recovered → skeleton-only page. Guard each touch; if the list
  // wrapper isn't here either, this whole page doesn't show estimates,
  // so we can return early after the stat update attempt.
  const statEsts = document.getElementById('statEsts');
  if (statEsts) statEsts.textContent = ests?.length || 0;
  // The embedded per-customer estimate hub reads window._estimates, so every
  // path that repaints this list (one-shot load AND the live snapshot rebuild)
  // must repaint the hub too — otherwise a signature webhook or a save from the
  // builder lands in the list while the customer's own panel shows stale money.
  // Hooked HERE, above the estListWrap early-return, because the hub is open on
  // routes (CRM) where that wrapper doesn't exist.
  if (window.CustomerEstimateHub && window.CustomerEstimateHub.isMounted()) {
    try { window.CustomerEstimateHub.refresh(); } catch (e) { console.warn('[ceh] refresh failed:', e && e.message); }
  }
  // Metrics audit F1: this function must NOT write #statVal. That tile is
  // labeled "Pipeline Value" and belongs to renderLeads (lead jobValue math).
  // The old estimate-sum write here (every revision + unattached + dead-deal
  // quote summed together) was only ever masked by a boot-ordering dance —
  // and the live estimates snapshot re-ran this alone, silently flipping the
  // tile to the inflated estimates-sum until the next full leads render.

  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  // Phone audit 2026-09-25 (estimate#0 sibling): the dashboard's "Latest
  // Estimates" panel (#recentEsts, view-dash) used to render at the BOTTOM of
  // this function — below the estListWrap early-return. #estListWrap only
  // exists once view-est has been hydrated, so until the rep had opened the
  // Estimates view at least once the panel read "No estimates yet." while the
  // Estimates tile beside it counted them. It renders here, above the bail.
  _renderRecentEstimates(ests, esc);
  const wrap=document.getElementById('estListWrap');
  if (!wrap) return; // Page has no estimates list — analytics-only call.
  if(!ests||!ests.length){
    // Empty state — canonical .nbd-empty pattern (batch-2 consolidation).
    // The builder button is already visible above this wrap in the page
    // header, so we just invite the user to start one.
    wrap.innerHTML='<div class="nbd-empty"><div class="ne-icon">📋</div>'
      + '<div class="ne-msg">No estimates yet</div>'
      + '<div class="ne-sub">Click <strong>＋ New Estimate</strong> above to create your first one.</div></div>';
    return;
  }

  // Helper: find the linked customer (lead) for this estimate
  // and render a short tag. Unassigned estimates get a neutral
  // "Unassigned" chip that's click-to-assign.
  const findLead = (leadId) => (window._leads || []).find(l => l.id === leadId);
  const formatDate = (ts) => {
    try {
      const d = ts?.toDate ? ts.toDate() : (ts ? new Date(ts) : null);
      if (!d || isNaN(d.getTime())) return '—';
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
    } catch (e) { return '—'; }
  };
  const displayName = (e) => {
    if (e.name && e.name.trim()) return e.name.trim();
    // Log Estimate docs carry only `title` ("Good Estimate") — no name/addr/
    // owner — so they listed as "Untitled estimate" (2026-09-25). The canonical
    // estimateName (customer-estimate-rows.js) reads title too; name stays
    // first here because Rename writes `name`.
    if (typeof e.title === 'string' && e.title.trim()) return e.title.trim();
    if (e.addr && e.addr.trim()) return e.addr.trim();
    if (e.owner && e.owner.trim()) return e.owner.trim() + ' estimate';
    return 'Untitled estimate';
  };

  wrap.innerHTML = ests.map(e => {
    const lead = e.leadId ? findLead(e.leadId) : null;
    const leadTag = lead
      ? '<span class="est-lead-chip assigned" data-act="open-lead" data-lead="' + esc(lead.id) + '">'
          + '👤 ' + esc((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()
          + (lead.firstName || lead.lastName ? '' : esc(lead.address || 'Customer'))
        + '</span>'
      : '<span class="est-lead-chip unassigned" data-act="assign">➕ Unassigned</span>';
    // The chip names the editor ✎ Edit actually opens (viewEstimate's routing),
    // 2026-09-25: a Job Templates doc (builder 'template', estimateVersion
    // 'v2') opens in V2 but was chipped CLASSIC, and a Log Estimate record —
    // which opens the amount editor, not a builder — was chipped CLASSIC too.
    const builderTag = (e.builder === 'v2' || e.estimateVersion === 'v2')
      ? '<span class="est-src-chip v2">V2</span>'
      : _isLoggedEstimate(e)
        ? '<span class="est-src-chip classic logged">LOGGED</span>'
        : '<span class="est-src-chip classic">CLASSIC</span>';
    // Signature status — mirrored from the e-sign envelope (BoldSign's
    // webhook wrote it until 2026-10-04; old estimates keep it). Distinct colors
    // so reps can eyeball the pipeline without clicking into each.
    let sigTag = '';
    if (e.signatureStatus === 'signed') {
      sigTag = '<span class="est-src-chip dwx-bgcolormix-cgreen-borgreen">✓ SIGNED</span>';
    } else if (e.signatureStatus === 'sent' || e.signatureStatus === 'viewed') {
      sigTag = '<span class="est-src-chip dwx-bgcolormix-corange-bororange">✍ AWAITING</span>';
    } else if (e.signatureStatus === 'declined') {
      sigTag = '<span class="est-src-chip dwx-bgcolormix-cred-borred">✗ DECLINED</span>';
    } else if (e.signatureStatus === 'expired') {
      sigTag = '<span class="est-src-chip dwx-opa6">⧗ EXPIRED</span>';
    }
    return ''
      + '<div class="est-card nbd-est-card" data-id="' + esc(e.id) + '">'
        // Phase 1a (RoofLink rebuild): tapping the card body opens the
        // mobile-friendly preview sheet, not the full editor. The ✎ Edit
        // action button below keeps the direct data-act="open" path.
        + '<div class="est-card-main" data-act="preview">'
          + '<div class="est-card-icon">📋</div>'
          + '<div class="est-card-body">'
            + '<div class="est-card-name">' + esc(displayName(e)) + '</div>'
            + '<div class="est-card-meta">'
              + esc(e.addr || 'No address') + ' · '
              + esc(e.roofType || '—') + ' · '
              + esc((e.sq != null ? Number(e.sq).toFixed(2) : '—')) + ' SQ · '
              + esc(e.tierName || '—')
            + '</div>'
            + '<div class="est-card-chips">'
              + leadTag + builderTag + sigTag
              + '<span class="est-date">' + esc(formatDate(e.createdAt || e.updatedAt)) + '</span>'
            + '</div>'
          + '</div>'
          + '<div class="est-card-total">$' + _estVal(e).toLocaleString('en-US', { maximumFractionDigits: 0 }) + '</div>'
        + '</div>'
        + '<div class="est-card-actions">'
          + '<button class="est-act-btn" data-act="open" title="Open & edit">✎ Edit</button>'
          + '<button class="est-act-btn" data-act="duplicate" title="Duplicate this estimate">⎘ Duplicate</button>'
          + '<button class="est-act-btn" data-act="rename" title="Rename estimate">✏ Rename</button>'
          + '<button class="est-act-btn" data-act="assign" title="Assign to customer">👤 Assign</button>'
          + '<button class="est-act-btn danger" data-act="delete" title="Archive estimate" aria-label="Archive estimate">🗄</button>'
        + '</div>'
      + '</div>';
  }).join('');

  // Single delegated handler for every action button on every
  // card. Walks up to .nbd-est-card to get the id, then dispatches
  // on data-act. CSP-clean (no inline onclicks, works under the
  // Report-Only script-src-attr 'none' policy).
  wrap.querySelectorAll('.nbd-est-card').forEach(card => {
    card.addEventListener('click', (ev) => {
      const target = ev.target.closest('[data-act]');
      if (!target) return;
      const act = target.dataset.act;
      const id = card.dataset.id;
      if (!id) return;
      ev.stopPropagation();
      switch (act) {
        case 'preview': {
          // Preview sheet with the full action set; falls back to the
          // old straight-to-editor behavior if the module isn't loaded.
          const est = (window._estimates || []).find(x => x.id === id);
          if (window.EstimatePreview && est) {
            window.EstimatePreview.open(est, {
              onEdit:      () => { if (typeof viewEstimate === 'function') viewEstimate(id); },
              onAssign:    () => { if (typeof assignEstimateAction === 'function') assignEstimateAction(id); },
              onDuplicate: () => { if (typeof duplicateEstimateAction === 'function') duplicateEstimateAction(id); }
            });
          } else if (typeof viewEstimate === 'function') viewEstimate(id);
          break;
        }
        case 'open':       if (typeof viewEstimate === 'function') viewEstimate(id); break;
        case 'duplicate':  if (typeof duplicateEstimateAction === 'function') duplicateEstimateAction(id); break;
        case 'rename':     if (typeof renameEstimateAction === 'function') renameEstimateAction(id); break;
        case 'assign':     if (typeof assignEstimateAction === 'function') assignEstimateAction(id); break;
        case 'delete':     if (typeof deleteEstimateAction === 'function') deleteEstimateAction(id); break;
        case 'open-lead': {
          const leadId = target.dataset.lead;
          if (leadId) window.location.href = '/pro/customer.html?id=' + encodeURIComponent(leadId);
          break;
        }
      }
    });
  });

  // Update weekly stats
  if (typeof calculateWeeklyStats === 'function') calculateWeeklyStats();
}

// Phone audit 2026-09-25 (estimate#0 sibling): the list's customer chips are
// resolved against window._leads at render time. When the list renders before
// the leads load (a cold load straight to #/est, where the view hydrates at
// boot), every linked estimate showed "➕ Unassigned" — whose tap is the
// Assign picker — and nothing re-rendered once the leads arrived. Repaint on
// the leads refresh, but only while the Estimates view is on screen; any
// later entry repaints via goTo('est').
window.addEventListener('nbd:data-refreshed', (ev) => {
  if (!ev || !ev.detail || ev.detail.source !== 'leads') return;
  const view = document.getElementById('view-est');
  if (!view || !view.classList.contains('active')) return;
  if (!document.getElementById('estListWrap') || !Array.isArray(window._estimates)) return;
  try { renderEstimatesList(window._estimates); } catch (e) { console.warn('est list leads-repaint failed:', e && e.message); }
});

// Edit sheet for a logged (amount-only) estimate — see _isLoggedEstimate.
// Phone audit 2026-09-25 (estimate#11, a money bug): ✎ Edit on one of these
// fell through viewEstimate into the Classic builder, which had no inputs to
// price from and recomputed the $2,500 job minimum. The legacy-drift toast
// warned ("recomputed from $12,451 to $2,500") but Save went ahead and wrote
// grandTotal 2500 over the rep's logged $12,450.75, and the card then showed
// $2,500. Classic has no amount field, so there was no way to keep the price
// from that screen. The record is edited as what it is: an amount, a package,
// notes. The amount is parsed to whole cents and stored back in the same
// dollars shape the Log Estimate writer uses (amount + grandTotal mirrored).
// PURE. The jobValue a lead should carry after its estimate `estAfter` was
// re-priced, or null to leave the lead alone. Same rules as
// window._saveEstimate's edit branch (R2-2-3) and the pre-flight Save
// (R6-2-7): only the lead's PRIMARY estimate moves it, never to $0, only
// when it changed. Signed price wins (Jo, 2026-10-07): an estimate with a
// signed price books what the homeowner signed, not an unsigned re-price.
function _loggedJobValueAfterEdit(lead, estAfter) {
  if (!lead || !estAfter || !estAfter.id || String(lead.primaryEstimateId || '') !== String(estAfter.id)) return null;
  const R = window.NBDCustomerEstimateRows;
  const signedC = R && typeof R.signedTotalCents === 'function' ? R.signedTotalCents(estAfter) : null;
  const val = signedC != null ? signedC / 100
    : (R && typeof R.estimateValue === 'function' ? R.estimateValue(estAfter) : Number(estAfter.grandTotal));
  if (!(Number.isFinite(val) && val > 0) || val === Number(lead.jobValue)) return null;
  return val;
}
// Write that jobValue (best-effort: the estimate is already saved, so a
// lead-write failure warns instead of failing the Save). The lead is read
// fresh when getDoc is available, else from the loaded leads.
async function _restampLoggedJobValue(est, patch) {
  const leadId = est && est.leadId;
  if (!leadId) return;
  try {
    let lead = null;
    if (typeof window.getDoc === 'function') {
      const snap = await window.getDoc(window.doc(window.db, 'leads', leadId));
      lead = snap && snap.exists() ? snap.data() : null;
    } else {
      lead = (window._leads || []).find((l) => l && l.id === leadId) || null;
    }
    const val = _loggedJobValueAfterEdit(lead, Object.assign({}, est, patch));
    if (val == null) return;
    await window.updateDoc(window.doc(window.db, 'leads', leadId), {
      jobValue: val,
      lastEstimateAt: (typeof window.serverTimestamp === 'function') ? window.serverTimestamp() : new Date(),
    });
  } catch (err) {
    console.warn('[logged estimate] lead jobValue re-stamp failed:', err);
  }
}

function _openLoggedEstimateEditor(est) {
  const prev = document.getElementById('logged-est-editor');
  if (prev) prev.remove();

  const overlay = document.createElement('div');
  overlay.id = 'logged-est-editor';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'logged-est-title');
  // Phones: pin the sheet near the top so Save/Cancel stay above the on-screen
  // keyboard (the amount field takes focus) and clear of the toast stack that
  // grows up from the bottom nav. Wider screens center it.
  const narrow = !!(window.matchMedia && window.matchMedia('(max-width: 600px)').matches);
  overlay.style.cssText = 'position:fixed;inset:0;z-index:var(--z-overlay);'
    + 'background:rgba(0,0,0,.72);display:flex;align-items:' + (narrow ? 'flex-start' : 'center') + ';'
    + 'justify-content:center;padding:' + (narrow ? '24px 16px 16px' : '16px') + ';';

  const sheet = document.createElement('div');
  sheet.style.cssText = 'background:var(--s, #1a1d23);border:1px solid var(--br, #2a2d35);'
    + 'border-radius:12px;padding:20px;max-width:440px;width:100%;'
    + 'max-height:calc(100% - 8px);overflow-y:auto;box-sizing:border-box;'
    + 'box-shadow:0 20px 60px rgba(0,0,0,.5);';

  const title = document.createElement('div');
  title.id = 'logged-est-title';
  title.style.cssText = "font-family:'Barlow Condensed',sans-serif;font-size:18px;"
    + 'font-weight:800;color:var(--t, #fff);text-transform:uppercase;letter-spacing:.04em;';
  title.textContent = 'Edit Logged Estimate';
  const sub = document.createElement('div');
  sub.style.cssText = 'font-size:12px;color:var(--m, #888);margin:6px 0 14px;line-height:1.45;';
  sub.textContent = 'Logged from the customer page as a flat amount — there are no line items'
    + ' for a builder to rebuild, so it edits here. To itemize it, start a New Estimate.';
  sheet.appendChild(title);
  sheet.appendChild(sub);

  const field = (labelText, control) => {
    const wrapEl = document.createElement('label');
    wrapEl.style.cssText = 'display:block;margin-bottom:12px;';
    const lbl = document.createElement('span');
    lbl.style.cssText = 'display:block;font-size:10px;font-weight:700;letter-spacing:.1em;'
      + 'text-transform:uppercase;color:var(--m, #888);margin-bottom:5px;';
    lbl.textContent = labelText;
    control.style.cssText = 'display:block;width:100%;box-sizing:border-box;background:var(--s2);'
      + 'border:1px solid var(--br);border-radius:7px;padding:10px 12px;font-size:16px;'
      + 'color:var(--t);font-family:inherit;min-height:44px;';
    wrapEl.appendChild(lbl);
    wrapEl.appendChild(control);
    sheet.appendChild(wrapEl);
    return control;
  };

  const amountIn = document.createElement('input');
  amountIn.type = 'text';
  amountIn.id = 'logged-est-amount';
  amountIn.setAttribute('inputmode', 'decimal');
  amountIn.setAttribute('autocomplete', 'off');
  const curCents = Math.round((Number(est.amount) || 0) * 100);
  amountIn.value = (curCents / 100).toFixed(2);
  field('Amount ($)', amountIn);

  const typeSel = document.createElement('select');
  typeSel.id = 'logged-est-type';
  ['Good', 'Better', 'Best'].forEach((t) => {
    const o = document.createElement('option');
    o.value = t; o.textContent = t;
    typeSel.appendChild(o);
  });
  if (est.type && !['Good', 'Better', 'Best'].includes(est.type)) {
    const o = document.createElement('option');
    o.value = est.type; o.textContent = est.type;
    typeSel.appendChild(o);
  }
  typeSel.value = est.type || 'Good';
  field('Package', typeSel);

  const notesIn = document.createElement('textarea');
  notesIn.id = 'logged-est-notes';
  notesIn.rows = 3;
  notesIn.value = est.notes || '';
  field('Notes', notesIn);
  notesIn.style.minHeight = '80px';
  notesIn.style.resize = 'vertical';

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;gap:8px;margin-top:4px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'btn btn-ghost';
  cancelBtn.id = 'logged-est-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.style.cssText = 'flex:1;min-height:44px;';
  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn-orange';
  saveBtn.id = 'logged-est-save';
  saveBtn.textContent = 'Save';
  saveBtn.style.cssText = 'flex:1;min-height:44px;';
  row.appendChild(cancelBtn);
  row.appendChild(saveBtn);
  sheet.appendChild(row);
  overlay.appendChild(sheet);

  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  function close() {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  }
  document.addEventListener('keydown', onKey);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });

  saveBtn.addEventListener('click', async () => {
    const raw = String(amountIn.value || '').replace(/[$,\s]/g, '');
    const cents = /^\d+(\.\d{0,2})?$/.test(raw) ? Math.round(parseFloat(raw) * 100) : NaN;
    if (!(cents > 0)) {
      showToast('Enter a valid estimate amount', 'warning');
      amountIn.focus();
      return;
    }
    if (typeof window.updateDoc !== 'function' || typeof window.doc !== 'function' || !window.db) {
      showToast('Estimate not saved — reload the page and try again', 'error');
      return;
    }
    const dollars = cents / 100;
    const type = typeSel.value || est.type || 'Good';
    const patch = { amount: dollars, grandTotal: dollars, type: type, notes: notesIn.value.trim() };
    // Keep the auto label in step with the package; a title the rep renamed stays.
    const autoTitle = (t) => (t ? t + ' Estimate' : 'Estimate');
    if (!est.title || est.title === autoTitle(est.type)) patch.title = autoTitle(type);
    patch.updatedAt = (typeof window.serverTimestamp === 'function') ? window.serverTimestamp() : new Date();
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      await window.updateDoc(window.doc(window.db, 'estimates', est.id), patch);
      // The lead's PRIMARY estimate re-priced here moves lead.jobValue — the
      // kanban, Home, Numbers and crm_summary read jobValue, not the estimate
      // (review R6-2-7; same rules as window._saveEstimate's edit branch).
      await _restampLoggedJobValue(est, patch);
      close();
      showToast('✓ Estimate updated', 'success');
      if (typeof window.loadEstimates === 'function') {
        try { await window.loadEstimates(); } catch (e) { /* the live listener repaints too */ }
      }
    } catch (e) {
      console.error('logged estimate save failed:', e);
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
      showToast('Estimate not saved: ' + ((e && e.message) || 'unknown error'), 'error');
    }
  });

  document.body.appendChild(overlay);
}

function viewEstimate(id) {
  const est = (window._estimates || []).find(e => e.id === id);
  if (!est) { showToast('Estimate not found — it may still be loading', 'error'); console.error('viewEstimate: not found in _estimates, id=', id, 'available:', (window._estimates||[]).map(e=>e.id)); return; }

  // 3B: V2 estimates reopen into the V2 builder (their own engine + the B-8
  // retail/Xactimate doc formats), not the Classic builder. The Classic path
  // below would recompute a V2 estimate with the wrong engine and can't reach
  // formatInsuranceScope. A known-V2 doc must NEVER fall through to Classic —
  // Classic would stamp builder:'classic' onto the V2 id on Save and
  // permanently mis-convert it (the estimates-corruption class, PR #507). If
  // the V2 builder isn't loaded yet (SW cache miss mid-deploy), bail with a
  // toast instead of corrupting the doc.
  if (est.builder === 'v2' || est.estimateVersion === 'v2') {
    if (typeof window.openEstimateV2Builder === 'function') {
      window.openEstimateV2Builder({ estimateId: id });
      return;
    }
    showToast('Estimate builder still loading — try again in a moment', 'error');
    return;
  }

  // A logged (amount-only) estimate must NEVER fall through to Classic either:
  // Classic has nothing to price it from, recomputes the job minimum, and its
  // Save overwrites the logged amount (estimate#11, 2026-09-25). Every Edit
  // entry point lands here — list ✎ Edit, the preview sheet, the dashboard's
  // Latest Estimates, the customer page's preview (?edit=&est= deep link),
  // the embedded estimate hub and the mobile job-detail Activity row — so the
  // guard lives here, not at each caller.
  if (_isLoggedEstimate(est)) {
    _openLoggedEstimateEditor(est);
    return;
  }

  // Show builder, hide list
  const listEl = document.getElementById('est-list');
  const builderEl = document.getElementById('est-builder');
  if (listEl) listEl.style.display = 'none';
  if (builderEl) { builderEl.style.display = 'flex'; builderEl.style.flexDirection = 'column'; }
  const noteEl = document.getElementById('drawImportNote');
  if (noteEl) noteEl.style.display = 'none';

  // Update title to reflect editing
  const titleEl = document.getElementById('estBuilderTitle');
  if (titleEl) titleEl.textContent = 'Edit Estimate';

  // ── Reset Step 2 form to neutral defaults BEFORE restoring. Without
  // this, leftover state from a previous builder session (presets,
  // half-finished estimates) bleeds into the recomputed numbers and
  // silently corrupts the saved doc on Save. Audit 2026-05-19.
  const _setSel  = (elId, val)  => { const el = document.getElementById(elId); if (el) el.value = val; };
  const _setChk  = (elId, val)  => { const el = document.getElementById(elId); if (el) el.checked = !!val; };
  _setSel('estMode', 'cash');
  _setSel('estCounty', '');
  _setSel('estCity', '');
  _setSel('estTearOff', '1');
  _setChk('estCutUp', false);
  _setChk('estValley', false);
  _setChk('estChimney', false);
  _setChk('estSkylight', false);
  _setSel('estGutterLF', '');
  ['insCarrier','insClaim','insDeductible','insDOL','insAdjuster','insPolicy',
   'insRCV','insACV','insOP','insDep','insRecDep'].forEach(i => _setSel(i, ''));

  // Populate Step 1 — Measurements (handle null/0 gracefully)
  const setVal = (elId, val) => { const el = document.getElementById(elId); if (el) el.value = (val != null && val !== '') ? val : ''; };
  setVal('estAddr', est.addr);
  setVal('estOwner', est.owner);
  setVal('estParcel', est.parcel);
  setVal('estYear', est.yr);
  setVal('estRawSqft', est.raw);
  setVal('estRidge', est.ridge != null ? est.ridge : '');
  setVal('estEave', est.eave != null ? est.eave : '');
  setVal('estHip', est.hip != null ? est.hip : '');
  setVal('estPipes', est.pipes || 4);

  // Populate Step 2 — Roof Type, Pitch, Waste
  setVal('estRoofType', est.roofType);

  // Match pitch to dropdown option value (format: "factor|label" like "1.202|8/12")
  const pitchSel = document.getElementById('estPitch');
  if (pitchSel && est.pitch) {
    const pitchLabel = est.pitch; // e.g. "8/12"
    let matched = false;
    for (let i = 0; i < pitchSel.options.length; i++) {
      // Exact match on the label portion after the pipe
      const parts = pitchSel.options[i].value.split('|');
      if (parts[1] === pitchLabel || pitchSel.options[i].value === pitchLabel) {
        pitchSel.selectedIndex = i;
        matched = true;
        break;
      }
    }
    // Fallback: try includes match (handles edge cases)
    if (!matched) {
      for (let i = 0; i < pitchSel.options.length; i++) {
        if (pitchSel.options[i].value.includes('|' + pitchLabel)) {
          pitchSel.selectedIndex = i;
          break;
        }
      }
    }
  }

  // Restore waste factor if saved
  if (est.wf) {
    const wasteSel = document.getElementById('estWaste');
    if (wasteSel) {
      for (let i = 0; i < wasteSel.options.length; i++) {
        if (Math.abs(parseFloat(wasteSel.options[i].value) - parseFloat(est.wf)) < 0.001) {
          wasteSel.selectedIndex = i;
          break;
        }
      }
    }
  }

  // The wizard re-derives squares from estRawSqft (sq = raw*pf*wf/100) and
  // never reads est.sq. An unstamped doc with sq but no raw (very old saves,
  // imports) therefore reopened at 0 SQ and repriced to the job minimum —
  // one Save from overwriting the real total. Back-derive raw from sq.
  if ((est.raw == null || est.raw === '' || Number(est.raw) === 0) && Number(est.sq) > 0) {
    const _pf = parseFloat(String((document.getElementById('estPitch') || {}).value || '').split('|')[0]) || 1;
    const _wf = parseFloat((document.getElementById('estWaste') || {}).value) || parseFloat(est.wf) || 1;
    setVal('estRawSqft', Math.round(Number(est.sq) * 100 / (_pf * _wf)));
  }

  // ── Restore Step 2 EBv2 fields from the saved doc. These were added
  // to the persistence layer 2026-05-19 — older docs won't have them,
  // which is fine: they just stay at the neutral defaults set above.
  if (est.mode)            _setSel('estMode', est.mode);
  if (est.county)          _setSel('estCounty', est.county);
  if (est.city)            _setSel('estCity', est.city);
  if (est.tearOffLayers)   _setSel('estTearOff', String(est.tearOffLayers));
  if (est.cutUp != null)   _setChk('estCutUp', est.cutUp);
  if (est.hasValley != null)   _setChk('estValley', est.hasValley);
  if (est.hasChimney != null)  _setChk('estChimney', est.hasChimney);
  if (est.hasSkylight != null) _setChk('estSkylight', est.hasSkylight);
  if (est.gutterLF != null && est.gutterLF !== '') _setSel('estGutterLF', est.gutterLF);

  // Insurance overlay fields
  if (est.insurance && typeof est.insurance === 'object') {
    const ins = est.insurance;
    _setSel('insCarrier',     ins.carrier      || '');
    _setSel('insClaim',       ins.claimNumber  || '');
    _setSel('insDeductible',  ins.deductible != null ? ins.deductible : '');
    _setSel('insDOL',         ins.dateOfLoss   || '');
    _setSel('insAdjuster',    ins.adjuster     || '');
    _setSel('insPolicy',      ins.policyNumber || '');
    _setSel('insRCV',         ins.rcv != null ? ins.rcv : '');
    _setSel('insACV',         ins.acv != null ? ins.acv : '');
    _setSel('insOP',          ins.op  != null ? ins.op  : '');
    _setSel('insDep',         ins.depreciation    != null ? ins.depreciation    : '');
    _setSel('insRecDep',      ins.recoverableDep  != null ? ins.recoverableDep  : '');
  }

  // Toggle insurance overlay block based on mode. toggleInsuranceOverlay
  // lives in __NBD_CALL_REGISTRY (dashboard-insurance-overlay-toggle.js),
  // not on window — Globals Tranche 3 T3-C, 2026-09-18.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (_nbdReg && typeof _nbdReg.toggleInsuranceOverlay === 'function') {
    _nbdReg.toggleInsuranceOverlay();
  }

  // Restore linked lead
  window._estLinkedLeadId = est.leadId || null;

  // Store the Firestore doc ID so we can update instead of creating new
  window._editingEstimateId = est.id;

  // Set tier BEFORE calculating so syncRatesFromProductLibrary uses the right tier
  selectedTier = est.tier || 'good';

  // Reset estData and run calculations (order matters: updateEstCalc reads DOM, calcTierPrices needs estData)
  estData = {};
  // Restore deposit override + revision version onto estData before
  // buildReview so the deposit math + version label honor the saved doc.
  if (est.depositPctOverride != null) estData.depositPctOverride = est.depositPctOverride;
  if (est.version != null) estData.version = est.version;
  if (est.revisedFrom) estData.revisedFrom = est.revisedFrom;
  updateEstCalc();
  calcTierPrices();

  // Select saved tier in the UI. The old `.tier-card[onclick*=tier]`
  // selector matched zero cards after the CSP onclick sweep removed
  // inline handlers — now we key off the data-fn / data-arg attributes
  // the tier cards actually carry.
  document.querySelectorAll('.tier-card').forEach(c => c.classList.remove('selected'));
  const tierCard = document.querySelector(
    '.tier-card[data-fn="selectTier"][data-arg="' + selectedTier + '"]'
  );
  if (tierCard) tierCard.classList.add('selected');

  // Enable the step 3 next button (since tier is pre-selected)
  const step3Btn = document.getElementById('estStep3Next');
  if (step3Btn) { step3Btn.disabled = false; step3Btn.style.opacity = '1'; }

  // Legacy banner — older Classic docs (saved before 2026-05-19) lack
  // the mode/county/add-on fields, so the recomputed grand total may
  // differ from the saved value. Surface this clearly so the rep can
  // decide whether to resave with the new fuller state.
  const isLegacyClassic = (est.builder !== 'v2') && (est.mode == null);
  const savedGrandTotal = Number(est.grandTotal || 0);

  // Build review and jump to Step 4 (use requestAnimationFrame to ensure DOM is painted)
  requestAnimationFrame(() => {
    buildReview();
    showEstStep(4);
    if (isLegacyClassic && savedGrandTotal > 0) {
      // estData.grandTotal is the recomputed value; if it shifted, warn.
      const recomputed = Number(estData.grandTotal || 0);
      const drift = Math.abs(recomputed - savedGrandTotal);
      if (drift >= 1) {
        showToast(
          'Loaded older estimate — total recomputed from $'
          + Math.round(savedGrandTotal).toLocaleString()
          + ' to $' + Math.round(recomputed).toLocaleString()
          + '. Review before saving.',
          'warning'
        );
      } else {
        showToast('Estimate loaded — review and save or edit any step', 'info');
      }
    } else {
      showToast('Estimate loaded — review and save or edit any step', 'info');
    }
  });
}
window.viewEstimate = viewEstimate;
// The embedded estimate hub (customer-estimate-hub.js) asks this before
// deciding whether ✎ Edit has to leave the customer overlay.
window._isLoggedEstimate = _isLoggedEstimate;

// ══════════════════════════════════════════════
// PHOTO LEADS LIST + PHOTO MODAL
// ══════════════════════════════════════════════
async function renderPhotoLeads(){
  // photoLeadsList only mounts on the Photos Near Me view. If a
  // bootstrap path calls us on another route, bail rather than crash.
  const wrap=document.getElementById('photoLeadsList');
  if (!wrap) return;

  // Ensure photo counts are loaded before we render so the sort
  // can put photos-first. First open shows a loading state; later
  // opens are instant because the counts cache hits.
  if (!window._photoCountsLoaded) {
    wrap.innerHTML='<div class="nbd-empty"><div class="ne-icon">📸</div><div class="ne-msg">Loading photo counts...</div></div>';
    await loadPhotoCounts();
  }

  const allLeads = window._leads || [];
  // Exclude prospects (hidden from kanban, should also be hidden
  // from the Photos Near Me picker — they're not real customers).
  const counts = window._photoCountByLead || {};
  let realLeads = allLeads.filter(l => !l.isProspect);
  // Apply search filter if the user typed in the photo search bar
  const _pq = window._photoSearchQuery || '';
  if (_pq) {
    realLeads = realLeads.filter(l => {
      const text = [l.firstName, l.lastName, l.address, l.phone, l.name].filter(Boolean).join(' ').toLowerCase();
      return text.includes(_pq);
    });
  }
  // "Only with photos" toggle — hides jobs that have zero photos
  if (window._photosOnlyWithPhotos) {
    realLeads = realLeads.filter(l => (counts[l.id] || 0) > 0);
  }

  if(!realLeads.length){
    wrap.innerHTML='<div class="nbd-empty"><div class="ne-icon">📸</div><div class="ne-msg">No customers yet</div><div class="ne-sub">Add a lead or promote a prospect to attach photos.</div></div>';
    return;
  }

  // Smart rank: photos-first, then alphabetical by name
  const ranked = realLeads.slice().sort((a, b) => {
    const cntA = counts[a.id] || 0;
    const cntB = counts[b.id] || 0;
    if (cntA !== cntB) return cntB - cntA; // most photos first
    const nameA = ((a.firstName||'') + ' ' + (a.lastName||'')).trim() || a.address || '';
    const nameB = ((b.firstName||'') + ' ' + (b.lastName||'')).trim() || b.address || '';
    return nameA.localeCompare(nameB);
  });

  // Split into two sections: 'Jobs with photos' and 'Jobs without'
  const withPhotos = ranked.filter(l => (counts[l.id] || 0) > 0);
  const withoutPhotos = ranked.filter(l => !counts[l.id]);

  // Escape-everything: the local fallback MUST escape (identity fallback = stored-XSS
  // footgun if dom-safe.js ever fails to define window.nbdEsc before this runs).
  const e = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const cardHTML = (l) => {
    const name = ((l.firstName||'')+ ' ' + (l.lastName||'')).trim() || l.name || 'Unknown';
    const addr = l.address || 'No address';
    const stage = l.stage || 'new';
    // Canonical label (crm-stages.js via window.stageLabel, 2026-10-03).
    const stageLabel = (typeof window.stageLabel === 'function' && window.stageLabel(stage))
      || {'new':'New Lead','contacted':'Contacted','inspected':'Inspected','claim_filed':'Claim Filed','contract_signed':'Contract Signed','closed':'Closed'}[stage] || stage.replace(/_/g,' ');
    const count = counts[l.id] || 0;
    const badgeBg = count > 0 ? 'var(--green)' : 'var(--s3)';
    const badgeColor = count > 0 ? '#fff' : 'var(--m)'; // #fff intentional: on-green badge text
    return `
    <div class="panel dwx-m0">
      <div class="panel-hdr nbd-photo-lead dwx-curpointer" data-lead-id="${e(l.id)}" data-addr="${e(addr)}">
        <div>
          <div class="panel-label dwx-dflex-aicenter-gap6px">
            📸 Photos
            <span style="background:${badgeBg};color:${badgeColor};font-size:9px;padding:1px 6px;border-radius:4px;font-weight:700;">${count} photo${count === 1 ? '' : 's'}</span>
            <span class="dwx-bgs3-corange-fs9px">${e(stageLabel)}</span>
          </div>
          <div class="panel-title dwx-fs14px">${e(name)}</div>
          <div class="dwx-fs11px-cm-mt2px">📍 ${e(addr)}</div>
        </div>
        <button class="btn btn-orange btn-sm">${count > 0 ? '📷 View / Add' : '📷 Upload'}</button>
      </div>
    </div>`;
  };

  let html = '<div class="dwx-dflex-flecolumn-gap10px">';
  if (withPhotos.length) {
    html += '<div class="dwx-fs10px-w700-ls12em">📸 Jobs with Photos (' + withPhotos.length + ')</div>';
    html += withPhotos.map(cardHTML).join('');
  }
  if (withoutPhotos.length) {
    html += '<div class="dwx-fs10px-w700-ls12em-2">Customers Without Photos (' + withoutPhotos.length + ')</div>';
    html += withoutPhotos.map(cardHTML).join('');
  }
  html += '</div>';
  wrap.innerHTML = html;

  wrap.querySelectorAll('.nbd-photo-lead').forEach(el => {
    el.addEventListener('click', () => {
      openPhotoFor(el.dataset.leadId, el.dataset.addr);
    });
  });
}

async function openPhotoFor(leadId, addr){
  // photoModal + its title/addr/grid children mount together in the
  // dashboard template. If the modal root isn't on this route, bail —
  // the sub-element accesses below would otherwise null-deref.
  const modal = document.getElementById('photoModal');
  if (!modal) return;
  currentPhotoLeadId=leadId; currentPhotoAddr=addr;
  document.getElementById('photoModalTitle').textContent='Damage Photos';
  document.getElementById('photoModalAddr').textContent=addr;
  document.getElementById('photoGridModal').innerHTML='<div class="dwx-fs12px-cm-p10px">Loading...</div>';
  modal.classList.add('open');
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not a bare window global.
  const photos=await window.__NBD_CALL_REGISTRY._getPhotos(leadId);
  renderPhotoGrid(photos);
}

function renderPhotoGrid(photos){
  // photoGridModal is a child of photoModal; both mount together.
  const grid=document.getElementById('photoGridModal');
  if (!grid) return;
  if(!photos.length){grid.innerHTML='<p class="dwx-fs11px-cm-tacenter">No photos yet. Upload above.</p>';return;}
  // Build via DOM so user-controlled `p.url` and `p.name` cannot inject markup.
  grid.textContent='';
  // Escape-everything: the local fallback MUST escape (identity fallback = stored-XSS
  // footgun if dom-safe.js ever fails to define window.nbdEsc before this runs).
  const e = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  photos.forEach(p => {
    const wrap = document.createElement('div');
    wrap.className = 'photo-thumb';
    const img = document.createElement('img');
    // Grid tiles render at thumbnail size — prefer the pipeline's 200px
    // WebP variant over the multi-MB original; fall back for docs the
    // pipeline hasn't stamped (legacy / variants still generating).
    img.src = (p.urls && p.urls.thumb) || p.url;
    img.alt = p.name || '';
    img.addEventListener('click', () => {
      // Validate url before opening to avoid javascript: schemes.
      const safe = /^https?:/i.test(p.url) ? p.url : '#';
      window.open(safe, '_blank', 'noopener,noreferrer');
    });
    wrap.appendChild(img);
    grid.appendChild(wrap);
    void e; // keep helper referenced
  });
}

async function uploadPhotos(input){
  let files=Array.from(input.files);
  if(!files.length||!currentPhotoLeadId) return;

  // Batch cap — iPhone 'Select All' can grab 200+ photos. Cap at 25
  // to keep the browser responsive and avoid runaway Storage bills.
  if(files.length > PHOTO_MAX_BATCH){
    const dropped = files.length - PHOTO_MAX_BATCH;
    files = files.slice(0, PHOTO_MAX_BATCH);
    showToast(`Only the first ${PHOTO_MAX_BATCH} photos will upload. ${dropped} skipped — add them in the next batch.`, 'warning');
  }

  // Validate each file before uploading
  const valid = [];
  for(const f of files){
    if(!PHOTO_ALLOWED_TYPES.includes(f.type) && !f.name.match(/\.(jpe?g|png|webp|gif|heic|heif|avif)$/i)){
      showToast(`"${f.name}" is not a supported image type`,'error'); continue;
    }
    if(f.size > PHOTO_MAX_SIZE){
      showToast(`"${f.name}" exceeds 15 MB limit (${(f.size/1024/1024).toFixed(1)} MB)`,'error'); continue;
    }
    valid.push(f);
  }
  if(!valid.length){ input.value=''; return; }

  showToast('Uploading '+valid.length+' photo(s)...');
  let uploaded = 0;
  // Registry-only (Globals Tranche 3 T3-C, 2026-09-18), not bare window globals.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  for(const f of valid){
    const url = await _nbdReg._uploadPhoto(currentPhotoLeadId,f);
    if(url) uploaded++;
  }
  const photos=await _nbdReg._getPhotos(currentPhotoLeadId);
  renderPhotoGrid(photos);
  // Invalidate the photo-count cache so the Photos Near Me list
  // re-sorts this lead to the top (it just gained photos).
  if (window._photoCountByLead) {
    window._photoCountByLead[currentPhotoLeadId] =
      (window._photoCountByLead[currentPhotoLeadId] || 0) + uploaded;
  }
  showToast(uploaded === valid.length ? 'Photos uploaded!' : `${uploaded}/${valid.length} uploaded — some failed`);
  input.value='';
}

// ══════════════════════════════════════════════════════════════════════
// Phase D.2 — Cross-lead Recent Photo Feed
//
// CompanyCam-style chronological feed: every photo the rep owns,
// grouped by date, ordered newest-first. Triggered by the "Recent"
// tab in the Photo Library; "By Property" stays the default (existing
// renderPhotoLeads + per-lead gallery).
//
// Query: photos collection, where userId == current uid, ordered by
// the canonical `createdAt` desc, limit 200. Every photos write path
// stamps createdAt with serverTimestamp(); ordering by it (not the
// photo-engine-only `uploadedAt`) means quick-upload and annotation
// photos are no longer silently excluded from this feed. Reuses the
// existing composite index photos [userId, createdAt DESC]. The photos
// rules at firestore.rules already allow .read for the owner, so no
// rules update is needed.
// ══════════════════════════════════════════════════════════════════════
async function renderRecentPhotoFeed() {
  const container = document.getElementById('photoRecentFeed');
  if (!container) return;
  const uid = window._user && window._user.uid;
  if (!uid) {
    container.innerHTML = '<div class="nbd-empty"><div class="ne-icon">🔒</div><div class="ne-msg">Sign in to see your photos.</div></div>';
    return;
  }
  if (!window.db || typeof window.collection !== 'function') {
    container.innerHTML = '<div class="nbd-empty"><div class="ne-icon">⚠️</div><div class="ne-msg">Photo library still loading</div><div class="ne-sub">Try again in a moment.</div></div>';
    return;
  }
  container.innerHTML = '<div class="nbd-empty"><div class="ne-icon">📷</div><div class="ne-msg">Loading recent photos…</div></div>';

  let docs;
  try {
    const q = window.query(
      window.collection(window.db, 'photos'),
      window.where('userId', '==', uid),
      window.orderBy('createdAt', 'desc'),
      window.limit(200)
    );
    const snap = await window.getDocs(q);
    docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('[D.2] recent feed query failed:', e && e.message);
    container.innerHTML = '<div class="nbd-empty"><div class="ne-icon">⚠️</div><div class="ne-msg">Could not load recent photos</div><div class="ne-sub">Refresh to retry.</div></div>';
    return;
  }

  if (!docs.length) {
    container.innerHTML = '<div class="nbd-empty"><div class="ne-icon">📷</div><div class="ne-msg">No photos yet</div><div class="ne-sub">Capture one from any property to populate this feed.</div></div>';
    return;
  }

  // Lead-name lookup off the existing window._leads cache so we can
  // tag each tile with which property it came from.
  const leads = window._leads || [];
  const leadName = id => {
    const l = leads.find(x => x.id === id);
    if (!l) return '';
    return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || '';
  };

  // Group by display date — Today / Yesterday / Mon DD / Mon DD YYYY.
  const groups = new Map();
  const today = new Date(); today.setHours(0,0,0,0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  const dateKey = ts => {
    if (!ts) return 'Older';
    const d = ts.toDate ? ts.toDate() : (ts instanceof Date ? ts : new Date(ts));
    if (!d || isNaN(d)) return 'Older';
    const dd = new Date(d); dd.setHours(0,0,0,0);
    if (dd.getTime() === today.getTime()) return 'Today';
    if (dd.getTime() === yest.getTime()) return 'Yesterday';
    const sameYear = dd.getFullYear() === today.getFullYear();
    return d.toLocaleDateString(undefined, sameYear
      ? { month:'short', day:'numeric' }
      : { month:'short', day:'numeric', year:'numeric' });
  };
  for (const photo of docs) {
    const k = dateKey(photo.createdAt || photo.uploadedAt || photo.takenAt);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(photo);
  }

  const escText = s => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const escAttr = escText;

  let html = '';
  for (const [date, photos] of groups) {
    html += '<div class="ph-recent-group">';
    html += '<div class="ph-recent-date">' + escText(date) + '  ·  ' + photos.length + ' photo' + (photos.length === 1 ? '' : 's') + '</div>';
    html += '<div class="ph-recent-grid">';
    for (const p of photos) {
      const url = p.thumbUrl || p.url || p.downloadUrl || p.src || '';
      if (!url) continue;
      const name = leadName(p.leadId);
      html += '<div class="ph-recent-tile" data-dw-action="openPhotoTile" data-dw-id="' + escAttr(p.leadId) + '">' +
                '<img loading="lazy" src="' + escAttr(url) + '" alt="">' +
                (name ? '<div class="ph-recent-tile-label">' + escText(name) + '</div>' : '') +
              '</div>';
    }
    html += '</div></div>';
  }
  container.innerHTML = html;
}
window.renderRecentPhotoFeed = renderRecentPhotoFeed;

// ══════════════════════════════════════════════
// PROPERTY INTEL — card render + modal pull
// ══════════════════════════════════════════════
function renderIntelCard(targetElId, intel, county, address) {
  const targetEl = document.getElementById(targetElId);
  if(!targetEl) return;

  // Store intel globally for pre-fill
  window._lastIntel = intel;

  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  const yr = intel.yearBuilt ? parseInt(intel.yearBuilt) : null;
  const age = yr ? (new Date().getFullYear() - yr) : null;
  const roofAge = intel.roofAge || age;

  let roofBadgeClass = 'pi-roof-mid';
  let roofLabel = '';
  if(roofAge !== null) {
    const rn = Number(roofAge);
    if(rn < 10)      { roofBadgeClass='pi-roof-new';     roofLabel=`${rn} yrs — Likely good`; }
    else if(rn < 20) { roofBadgeClass='pi-roof-mid';     roofLabel=`${rn} yrs — Watch it`; }
    else if(rn < 30) { roofBadgeClass='pi-roof-old';     roofLabel=`${rn} yrs — Needs attention`; }
    else             { roofBadgeClass='pi-roof-ancient'; roofLabel=`${rn} yrs — Due for replacement`; }
  }

  const ownerName  = intel.ownerName || 'Owner Unknown';
  const isLLC     = intel.isLLC || /LLC|INC|CORP|TRUST|PROPERTIES|HOLDINGS|INVESTMENTS/i.test(ownerName);
  const lastSale  = intel.lastSaleAmount ? '$'+parseInt(intel.lastSaleAmount).toLocaleString() : null;
  const mktVal    = intel.marketValue ? '$'+parseInt(intel.marketValue).toLocaleString() : null;
  const dataNote  = intel.dataSource === 'estimated' ? ' (est.)' : '';
  const safeAuditor = /^https?:/i.test(intel.auditorUrl || '') ? intel.auditorUrl : null;

  const card = `<div class="pi-card">
    <div class="pi-header">
      <span class="pi-title">🏠 Property Intel${esc(dataNote)}</span>
      <span class="pi-county">${esc(county || 'OH')} County</span>
    </div>
    <div class="pi-body">
      <div class="dwx-dflex-aicenter-flewrap">
        <span class="pi-owner">${esc(ownerName)}</span>
        ${isLLC ? '<span class="pi-llc-flag">🏢 LLC/Corp</span>' : ''}
      </div>
      <div class="pi-addr-line">${esc(address)}</div>
      ${roofAge !== null ? `<div class="pi-roof-badge ${esc(roofBadgeClass)}">🏠 ${esc(roofLabel)}</div>` : ''}
      <div class="pi-grid">
        ${yr ? `<div class="pi-stat"><span class="pi-stat-val">${Number(yr)}</span><span class="pi-stat-key">Year Built</span></div>` : ''}
        ${intel.propertyType ? `<div class="pi-stat"><span class="pi-stat-val">${esc(intel.propertyType)}</span><span class="pi-stat-key">Type</span></div>` : ''}
        ${mktVal ? `<div class="pi-stat"><span class="pi-stat-val">${esc(mktVal)}</span><span class="pi-stat-key">Market Value</span></div>` : ''}
        ${lastSale ? `<div class="pi-stat"><span class="pi-stat-val">${esc(lastSale)}</span><span class="pi-stat-key">Last Sale</span></div>` : ''}
        ${intel.lastSaleDate ? `<div class="pi-stat"><span class="pi-stat-val">${esc(intel.lastSaleDate)}</span><span class="pi-stat-key">Sale Date</span></div>` : ''}
        ${intel.bedrooms ? `<div class="pi-stat"><span class="pi-stat-val">${esc(intel.bedrooms)} bed</span><span class="pi-stat-key">Bedrooms</span></div>` : ''}
        ${intel.sqft ? `<div class="pi-stat"><span class="pi-stat-val">${parseInt(intel.sqft).toLocaleString()} sf</span><span class="pi-stat-key">Living Area</span></div>` : ''}
        ${intel.acreage ? `<div class="pi-stat"><span class="pi-stat-val">${parseFloat(intel.acreage).toFixed(3)} ac</span><span class="pi-stat-key">Acreage</span></div>` : ''}
        ${intel.homestead ? `<div class="pi-stat"><span class="pi-stat-val dwx-cgreen">Yes</span><span class="pi-stat-key">Homestead</span></div>` : ''}
        ${intel.parcelId ? `<div class="pi-stat"><span class="pi-stat-val dwx-fs10px">${esc(intel.parcelId)}</span><span class="pi-stat-key">Parcel ID</span></div>` : ''}
      </div>
      ${safeAuditor ? `<a class="pi-link" href="${esc(safeAuditor)}" target="_blank" rel="noopener noreferrer">↗ View Full County Record</a>` : ''}
    </div>
  </div>`;

  // Replace loading card, keep Make This a Lead button
  const existingCard = targetEl.querySelector('.pi-card');
  if(existingCard) {
    existingCard.outerHTML = card;
  } else {
    targetEl.innerHTML = card + '<button class="make-lead-btn" data-dw-action="makeLeadFromSearch">＋ Make This a Lead</button>';
  }
}

async function fetchPropertyIntelModal(geo, addr) {
  // modalIntelResult only renders inside the Property Intel modal,
  // which only mounts on certain dashboard routes. Bail if absent.
  const resultEl = document.getElementById('modalIntelResult');
  if (!resultEl) return;
  const gAddr = geo.address || {};
  const county = (gAddr.county||'').replace(' County','').trim();

  // Run same engine but capture result for modal
  const cacheKey = addr.toLowerCase().replace(/\s/g,'');
  let intel = _piCache[cacheKey] || null;

  if(!intel) {
    // Temporarily show result container
    resultEl.innerHTML = '<div class="dwx-cm-fs11px">Estimating property profile...</div>';
    resultEl.classList.add('visible');
    // Fire the intel engine with a temp container
    const tempId = 'pi-temp-' + Date.now();
    const tempDiv = document.createElement('div');
    tempDiv.id = tempId;
    tempDiv.style.display = 'none';
    document.body.appendChild(tempDiv);
    await fetchPropertyIntel(geo, tempId);
    intel = window._lastIntel || null;
    document.body.removeChild(tempDiv);
  }

  if(!intel) {
    resultEl.innerHTML = '<div class="dwx-cred-fs11px">Could not retrieve property data. Check your API key in Settings.</div>';
    resultEl.classList.add('visible');
    return;
  }

  // Pre-fill lead modal fields
  if(intel.ownerName && intel.ownerName !== 'Owner Unknown') {
    const parts = intel.ownerName.trim().split(/\s+/);
    const fname = document.getElementById('lFname');
    const lname = document.getElementById('lLname');
    if(fname && !fname.value) {
      if(parts.length >= 2) {
        fname.value = parts[0];
        lname.value = parts.slice(1).join(' ');
      } else {
        fname.value = intel.ownerName;
      }
    }
  }

  // Build notes pre-fill
  const notesEl = document.getElementById('lNotes');
  if(notesEl && !notesEl.value) {
    const yr = intel.yearBuilt;
    const age = yr ? (new Date().getFullYear() - parseInt(yr)) : null;
    const lines = [];
    if(yr) lines.push(`Year Built: ${yr} (${age} yr old roof)`);
    if(intel.ownerName) lines.push(`Owner of Record: ${intel.ownerName}`);
    if(intel.propertyType) lines.push(`Property: ${intel.propertyType}`);
    if(intel.marketValue) lines.push(`Market Value: $${parseInt(intel.marketValue).toLocaleString()}`);
    if(intel.lastSaleDate && intel.lastSaleAmount) lines.push(`Last Sale: $${parseInt(intel.lastSaleAmount).toLocaleString()} on ${intel.lastSaleDate}`);
    if(intel.isLLC) lines.push('Owner is LLC/Corporate entity');
    notesEl.value = lines.join('\n');
  }

  // Store yearBuilt for Firestore save
  window._modalIntel = intel;

  // Show compact result card
  const yr = intel.yearBuilt;
  const age = yr ? (new Date().getFullYear() - parseInt(yr)) : null;
  const roofAge = intel.roofAge || age;
  let roofColor = 'var(--gold)';
  if(roofAge !== null) {
    if(roofAge < 10) roofColor = 'var(--green)';
    else if(roofAge < 20) roofColor = 'var(--gold)';
    else if(roofAge < 30) roofColor = 'var(--red)';
    else roofColor = 'var(--purple)';
  }

  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  resultEl.innerHTML = `
    <div class="mir-owner">${esc(intel.ownerName||'Unknown Owner')}${intel.isLLC?'&nbsp;<span class="dwx-fs9px-cblue-w700">LLC</span>':''}</div>
    <div class="mir-grid">
      ${yr ? `<div class="mir-item">Built <span>${esc(yr)}</span></div>` : ''}
      ${roofAge !== null ? `<div class="mir-item">Roof <span style="color:${esc(roofColor)};">${Number(roofAge)} yrs</span></div>` : ''}
      ${intel.marketValue ? `<div class="mir-item">Value <span>$${parseInt(intel.marketValue).toLocaleString()}</span></div>` : ''}
      ${intel.propertyType ? `<div class="mir-item">Type <span>${esc(intel.propertyType)}</span></div>` : ''}
      ${intel.bedrooms ? `<div class="mir-item">Beds <span>${esc(intel.bedrooms)}</span></div>` : ''}
      ${intel.homestead ? `<div class="mir-item">Homestead <span class="dwx-cgreen">Yes</span></div>` : ''}
    </div>
    <div class="dwx-fs10px-cm-mt5px">✓ Owner name and notes pre-filled below</div>`;
  resultEl.classList.add('visible');
}

// ══════════════════════════════════════════════
// ZONE LIST — Territory zones render
// ══════════════════════════════════════════════
function renderZoneList() {
  const el = document.getElementById('zoneList');
  if(!el) return;
  if(!zones.length) { el.innerHTML=''; return; }
  const esc = window.nbdEsc || (s => String(s == null ? '' : s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])));
  // Only accept hex colors; reject anything else to block style-attr injection.
  const safeColor = c => /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : 'var(--blue)';
  el.innerHTML = zones.map(z => `
    <div class="zone-item">
      <div class="zone-dot" style="background:${safeColor(z.color)};"></div>
      <span>${esc(z.name)}${z.repLabel ? ` · <span class="dwx-cm-fs11px">${esc(z.repLabel)}</span>` : ''}</span>
      <button class="zone-del nbd-zone-del" data-zone-id="${esc(z.id)}" data-action="call" data-fn="deleteZone" data-arg="${esc(z.id)}">✕</button>
    </div>`).join('');
  // Globals Tranche 3 T3-0 (2026-08-31): this used to re-bind a click listener
  // per row that called deleteZone as a bare cross-file identifier. deleteZone
  // is module-scoped in dashboard-actions.js now, so the row delegates through
  // the document-level `call` action instead (the H-1 pattern: migrate the
  // generated handler to data-action, THEN scope the global). Zone ids are
  // Firestore doc strings (or a 'd-' local fallback) — data-arg carries the raw
  // string and deleteZone String()-compares both sides. data-zone-id stays for
  // the CSS/selector identity.
}

// ══════════════════════════════════════════════
// PIN STATS OVERLAY
// ══════════════════════════════════════════════
function updatePinStats() {
  const el = document.getElementById('pinStatsOverlay');
  if(!el || !window._pins) return;
  const pins = window._pins;
  if(!pins.length) { el.innerHTML=''; return; }
  const counts = {};
  pins.forEach(p => { counts[p.status] = (counts[p.status]||0) + 1; });
  const total = pins.length;
  const signed = counts['signed']||0;
  const interested = counts['interested']||0;
  const notHome = counts['not-home']||0;

  el.innerHTML = `
    <div class="pin-stat-pill">
      <span class="dwx-w700-ct">${total}</span>
      <span class="dwx-fs9px-cm-ttuppercas">Doors</span>
    </div>
    ${signed ? `<div class="pin-stat-pill"><div class="pin-stat-dot dwx-bggold"></div><span class="dwx-cgold-w700">${signed} Signed</span></div>` : ''}
    ${interested ? `<div class="pin-stat-pill"><div class="pin-stat-dot dwx-bggreen"></div><span class="dwx-cgreen-w700">${interested} Interested</span></div>` : ''}
    ${notHome ? `<div class="pin-stat-pill"><div class="pin-stat-dot dwx-bg9ca3af"></div><span class="dwx-cm">${notHome} Not Home</span></div>` : ''}`;
}

// ══════════════════════════════════════════════════════════════════════
// KANBAN CARD DETAIL MODAL
// ══════════════════════════════════════════════════════════════════════
// Text colour for a stage / job-type chip (2026-09-25 phone audit). The
// chips used the raw stage colour as their text on a 14% tint of itself,
// and those colours are picked for column headers, not for text on the
// theme's own surface: New Lead's #374151 on the default navy top bar
// measured 1.25:1 (1.37:1 on the desktop card-detail chip) — the phone
// chip read as a blank pill, on the most common stage there is, and the
// one unknown stages fall back to. Insurance purple was 2.1:1. Mixing the
// hue with the theme's own text colour keeps the stage's colour identity
// and lands >= 4.5:1 for every built-in stage and type colour, on dark
// and light themes alike (--t is light on dark themes, dark on light
// ones). Border and tint keep the raw colour.
function _nbdChipInk(color) {
  return 'color-mix(in srgb, ' + color + ' 40%, var(--t))';
}

function openCardDetailModal(leadId) {
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) return;

  // cardDetailModal and all its cardDetail* children are mounted as
  // one block in the CRM/kanban template. Bail if the root isn't on
  // this route — sub-element accesses below assume it's present.
  const modal = document.getElementById('cardDetailModal');
  if (!modal) return;

  window._cardDetailLeadId = leadId;
  // The Storm Proof "Wind measured nearby" note belongs to the lead it was
  // fetched for (storm-integration.js) — drop it when a different card opens.
  const _stormWind = document.getElementById('cdStormWind');
  if (_stormWind && _stormWind.getAttribute('data-lead-id') !== leadId) _stormWind.remove();

  // Populate modal
  document.getElementById('cardDetailName').textContent =
    `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Lead';
  // Stage chip — use stageLabel() to convert raw keys ("claim_filed")
  // to display labels ("Claim Filed"), and stageColor() to tint the
  // chip so it matches the kanban column it came from.
  const stageEl = document.getElementById('cardDetailStage');
  if (stageEl) {
    const rawStage = lead._stageKey || lead.stage || 'new';
    const label = (typeof window.stageLabel === 'function')
      ? window.stageLabel(rawStage)
      : String(rawStage).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const color = (typeof window.stageColor === 'function')
      ? window.stageColor(rawStage)
      : 'var(--m)';
    stageEl.textContent = label;
    stageEl.style.color = _nbdChipInk(color);
    stageEl.style.borderColor = `color-mix(in srgb, ${color} 50%, var(--br))`;
    stageEl.style.background = `color-mix(in srgb, ${color} 14%, var(--s2))`;
  }
  // Wave 28: jobType chip. Sits beside the stage chip in the header bar
  // and shares the same pill styling. Tinted with the type's brand color
  // from JOB_TYPE_META so reps recognize Insurance vs Cash vs Finance at
  // a glance. Reads lead.jobType; falls back to inferJobType() when
  // unset (older records that predate the field).
  const typeEl = document.getElementById('cardDetailJobType');
  if (typeEl) {
    const jt = lead.jobType ||
      (typeof window.inferJobType === 'function' ? window.inferJobType(lead) : null);
    const meta = (window.JOB_TYPE_META && jt) ? window.JOB_TYPE_META[jt] : null;
    const labelTxt = meta ? `${meta.icon || ''} ${meta.label}`.trim() : 'Set type';
    const tColor = meta?.color || 'var(--m)';
    typeEl.textContent = labelTxt;
    typeEl.style.color = _nbdChipInk(tColor);
    typeEl.style.borderColor = `color-mix(in srgb, ${tColor} 50%, var(--br))`;
    typeEl.style.background = `color-mix(in srgb, ${tColor} 14%, var(--s2))`;
  }
  document.getElementById('cardDetailAddress').textContent = lead.address || '—';
  document.getElementById('cardDetailPhone').textContent = lead.phone || '—';
  document.getElementById('cardDetailDamage').textContent = lead.damageType || '—';
  document.getElementById('cardDetailValue').textContent =
    lead.jobValue ? `$${parseFloat(lead.jobValue).toLocaleString()}` : '—';

  // ─── Prospect promote button + quick actions ───
  // Show a "Promote to Customer" CTA + a row of quick actions
  // (Call/Text/Email/Re-knock/Map/Hide/Delete) at the top of the detail
  // modal when this lead is still a prospect. The actions row is built
  // each time so it reflects the current lead's data (phone, email, lat/lng).
  const promoteBanner = document.getElementById('cardDetailPromoteBanner');
  if (promoteBanner) {
    if (lead.isProspect) {
      promoteBanner.style.display = 'flex';
      populateProspectQuickActions(lead);
    } else {
      promoteBanner.style.display = 'none';
    }
  }
  // Sync the kind label so we don't show "CUSTOMER" on a prospect
  // (and vice versa). Belt-and-suspenders alongside the banner above.
  const kindLabel = document.getElementById('cardDetailKindLabel');
  if (kindLabel) kindLabel.textContent = lead.isProspect ? 'PROSPECT' : 'CUSTOMER';

  // Show modal — use the cached `modal` ref from the entry-guard above.
  // nbdModal owns Esc/backdrop/focus on dashboard.html; classList fallback on
  // pages without nbd-modal.js (none since the legacy twin retired 2026-09-02). onClose clears the working lead id on every dismiss.
  if (window.nbdModal) { window.nbdModal.open('cardDetailModal', { onClose: _cardDetailReset }); }
  else { modal.classList.add('open'); }
}
window.openCardDetailModal = openCardDetailModal;

// Wave 28: targeted chip-only refresh. Called from moveCard / changeLeadType
// so the open detail modal's stage + classification chips reflect the new
// state immediately — no need to re-run the full openCardDetailModal()
// populate (which would also re-build prospect actions, etc.). No-op if
// the modal isn't open on this lead.
function refreshCardDetailChips(leadId) {
  if (!leadId || window._cardDetailLeadId !== leadId) return;
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) return;
  const rawStage = lead._stageKey || lead.stage || 'new';
  const stageLabel = (typeof window.stageLabel === 'function')
    ? window.stageLabel(rawStage)
    : String(rawStage).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const stageColor = (typeof window.stageColor === 'function')
    ? window.stageColor(rawStage) : 'var(--m)';
  const jt = lead.jobType ||
    (typeof window.inferJobType === 'function' ? window.inferJobType(lead) : null);
  const meta = (window.JOB_TYPE_META && jt) ? window.JOB_TYPE_META[jt] : null;
  const typeLabel = meta ? `${meta.icon || ''} ${meta.label}`.trim() : 'Set type';
  const tColor = meta?.color || 'var(--m)';

  // Desktop / tablet — cardDetailModal chips.
  const desktopStage = document.getElementById('cardDetailStage');
  if (desktopStage) {
    desktopStage.textContent = stageLabel;
    desktopStage.style.color = _nbdChipInk(stageColor);
    desktopStage.style.borderColor = `color-mix(in srgb, ${stageColor} 50%, var(--br))`;
    desktopStage.style.background = `color-mix(in srgb, ${stageColor} 14%, var(--s2))`;
  }
  const desktopType = document.getElementById('cardDetailJobType');
  if (desktopType) {
    desktopType.textContent = typeLabel;
    desktopType.style.color = _nbdChipInk(tColor);
    desktopType.style.borderColor = `color-mix(in srgb, ${tColor} 50%, var(--br))`;
    desktopType.style.background = `color-mix(in srgb, ${tColor} 14%, var(--s2))`;
  }
  // Mobile — m-jobdetail chips (different style: lighter background tint
  // for the frosted top-bar context, but same coloring source).
  const mobileStage = document.getElementById('mJdStatus');
  if (mobileStage) {
    mobileStage.textContent = stageLabel;
    mobileStage.style.color = _nbdChipInk(stageColor);
    mobileStage.style.background = `color-mix(in srgb, ${stageColor} 14%, transparent)`;
    mobileStage.style.borderColor = `color-mix(in srgb, ${stageColor} 30%, transparent)`;
  }
  const mobileType = document.getElementById('mJdJobType');
  if (mobileType) {
    mobileType.textContent = typeLabel;
    mobileType.style.color = _nbdChipInk(tColor);
    mobileType.style.background = `color-mix(in srgb, ${tColor} 14%, transparent)`;
    mobileType.style.borderColor = `color-mix(in srgb, ${tColor} 30%, transparent)`;
  }
}
window.refreshCardDetailChips = refreshCardDetailChips;

// Close-side cleanup, run on every dismiss (button/backdrop/Esc) via nbdModal's
// onClose on dashboard.html, and directly on the legacy classList path.
function _cardDetailReset() {
  window._cardDetailLeadId = null;
}
function closeCardDetailModal() {
  if (window.nbdModal) { window.nbdModal.close('cardDetailModal'); }
  else { const modal = document.getElementById('cardDetailModal'); if (modal) modal.classList.remove('open'); _cardDetailReset(); }
}
window.closeCardDetailModal = closeCardDetailModal;

// ── "Template Quote" card-detail action (Job Templates lead-context entry) ──
// The templates engine/UI ride the LAZY 'estimates' bundle (script-loader.js),
// so this action can fire before the bundle exists. Same load-then-run shape
// as the startNewEstimate / openEstimateV2Builder stubs in
// dashboard-actions.js: load the bundle, then run the real entry, else toast.
// Passes { leadId } so JobTemplatesUI.openPicker pre-selects the lead in the
// create step. leadId falls back to the open card-detail's lead.
function openJobTemplatesForLead(leadId) {
  const id = (typeof leadId === 'string' && leadId)
    ? leadId
    : (window._cardDetailLeadId || null);
  const run = () => {
    if (window.JobTemplatesUI && typeof window.JobTemplatesUI.openPicker === 'function') {
      window.JobTemplatesUI.openPicker(id ? { leadId: id } : {});
    } else if (typeof showToast === 'function') {
      showToast('Templates are still loading — try again in a moment', 'warning');
    }
  };
  if (window.JobTemplatesUI && typeof window.JobTemplatesUI.openPicker === 'function') {
    run();
    return;
  }
  if (window.ScriptLoader && typeof window.ScriptLoader.loadBundle === 'function') {
    window.ScriptLoader.loadBundle('estimates').then(run);
  } else {
    run(); // no loader yet → degrades to the still-loading toast
  }
}
// Markup-only entry → registry, off window (Tranche 2c pattern; the
// Object.assign block shape is what the smoke wiring audit recognizes).
window.__NBD_CALL_REGISTRY = window.__NBD_CALL_REGISTRY || Object.create(null);
Object.assign(window.__NBD_CALL_REGISTRY, {
  openJobTemplatesForLead: openJobTemplatesForLead
});

// ══════════════════════════════════════════════════════════════════════
// Wave 2B — Mobile job-detail screen
//
// Phones get a full-screen overlay instead of the shrunken
// cardDetailModal. Same data flow (window._leads + window._photoCache),
// fundamentally different layout: hero photo banner, big action ring,
// 3 tabs (Activity / Photos / Details). Routing decision lives in
// openLeadDetail() below — that's what card clicks now call.
//
// On a tablet/desktop session the .m-jobdetail selector is force-hidden
// via the @media (min-width:769px) rule in dashboard.html, so this code
// is mobile-only by construction even if a wrong path opens it.
// ══════════════════════════════════════════════════════════════════════
function openMobileJobDetail(leadId) {
  const lead = (window._leads || []).find(l => l.id === leadId);
  if (!lead) return;

  const $ = (id) => document.getElementById(id);

  // mJobDetail and all its m-jd-* children mount together as the mobile
  // job-detail overlay. If the root isn't on this route, bail — every
  // $('mJd…') access below assumes the overlay block is present.
  const root = $('mJobDetail');
  if (!root) return;

  window._cardDetailLeadId = leadId;

  // Stage window._leadDoc/_customerId/_customerEstimates/_allPhotos up
  // front — previously only done lazily inside _mountDocumentsHub on the
  // Documents tab's first visit, so a rep who tapped a Job Checklist
  // checkbox (below) without ever opening Documents would write with a
  // stale/unset window._customerId. Pure in-memory lookups (no Firestore
  // read), safe to call unconditionally on every open; _mountDocumentsHub's
  // own call to this is now a cheap, idempotent no-op.
  if (typeof window._stageWindowStateForLead === 'function') window._stageWindowStateForLead(leadId);

  // Tear down Messages/Voice Intel's live Firestore listener if it's still
  // mounted for a DIFFERENT lead — see dashboard-actions.js's
  // _mJdTeardownRealtimeTabs comment for why this can't wait for the rep to
  // revisit those tabs. Registry-only (Globals Tranche 3 T3-C, 2026-09-18),
  // not a bare window global.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  if (_nbdReg && typeof _nbdReg._mJdTeardownRealtimeTabs === 'function') _nbdReg._mJdTeardownRealtimeTabs(leadId);

  // ── Status pill (uses the same stageLabel/stageColor as the desktop modal) ──
  const rawStage = lead._stageKey || lead.stage || 'new';
  const stageEl = $('mJdStatus');
  if (stageEl) {
    const label = (typeof window.stageLabel === 'function')
      ? window.stageLabel(rawStage)
      : String(rawStage).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const color = (typeof window.stageColor === 'function')
      ? window.stageColor(rawStage) : 'var(--orange)';
    stageEl.textContent = label;
    stageEl.style.color = _nbdChipInk(color);
    stageEl.style.background = 'color-mix(in srgb, ' + color + ' 14%, transparent)';
    stageEl.style.borderColor = 'color-mix(in srgb, ' + color + ' 30%, transparent)';
  }
  // ── Wave 28: classification chip (mobile parity with cardDetailModal) ──
  const typeEl = $('mJdJobType');
  if (typeEl) {
    const jt = lead.jobType ||
      (typeof window.inferJobType === 'function' ? window.inferJobType(lead) : null);
    const meta = (window.JOB_TYPE_META && jt) ? window.JOB_TYPE_META[jt] : null;
    typeEl.textContent = meta ? `${meta.icon || ''} ${meta.label}`.trim() : 'Set type';
    const tColor = meta?.color || 'var(--m)';
    typeEl.style.color = _nbdChipInk(tColor);
    typeEl.style.background = 'color-mix(in srgb, ' + tColor + ' 14%, transparent)';
    typeEl.style.borderColor = 'color-mix(in srgb, ' + tColor + ' 30%, transparent)';
  }

  // ── Title block ──
  const name = ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim()
    || lead.name || 'Lead';
  $('mJdName').textContent = name;
  $('mJdAddr').textContent = lead.address || '—';
  const valEl = $('mJdValue');
  if (lead.jobValue) {
    valEl.textContent = '$' + parseFloat(lead.jobValue).toLocaleString();
    valEl.hidden = false;
  } else {
    valEl.hidden = true;
  }

  // ── Hero photo ──
  // The rep-chosen cover (lead.coverPhotoUrl, RoofLink "Set Cover") wins;
  // fall back to the first cached photo like before.
  const photos = (window._photoCache && window._photoCache[lead.id]) || [];
  const heroEl = $('mJdHero');
  const firstPhotoUrl = (lead.coverPhotoUrl && /^https?:/i.test(String(lead.coverPhotoUrl)) ? lead.coverPhotoUrl : null)
    || (photos[0] && (photos[0].url || photos[0].downloadUrl || photos[0].src));
  if (firstPhotoUrl) {
    heroEl.style.backgroundImage = 'url("' + String(firstPhotoUrl).replace(/"/g, '%22') + '")';
    heroEl.classList.add('has-photo');
  } else {
    heroEl.style.backgroundImage = '';
    heroEl.classList.remove('has-photo');
  }

  // ── Storm chip — NBD differentiator ──
  const stormEl = $('mJdStorm');
  if (lead.hailHit && lead.hailHit.sizeInches) {
    const inches = Number(lead.hailHit.sizeInches).toFixed(1);
    let when = '';
    const hitAt = lead.hailHit.date || lead.hailHit.observedAt;
    if (hitAt) {
      const d = (hitAt && hitAt.toDate) ? hitAt.toDate()
              : (hitAt instanceof Date) ? hitAt
              : new Date(hitAt);
      if (d && !isNaN(d)) {
        const days = Math.floor((Date.now() - d.getTime()) / 86400000);
        when = days <= 0 ? ' · today'
             : days === 1 ? ' · yesterday'
             : days < 30 ? ' · ' + days + 'd ago'
             : '';
      }
    }
    stormEl.textContent = inches + '" hail' + when;
    stormEl.hidden = false;
  } else {
    stormEl.hidden = true;
  }

  // ── Action button enablement ──
  const setEnabled = (id, on) => {
    const b = $(id);
    if (b) b.disabled = !on;
  };
  setEnabled('mJdCall',  !!lead.phone);
  setEnabled('mJdText',  !!lead.phone);
  setEnabled('mJdEmail', !!lead.email);
  setEnabled('mJdPhotos', true);
  setEnabled('mJdEstimate', true);

  // ── Details tab ──
  // window._currentLead — a page-scoped global customer.html already sets
  // (and customer-checklist.js's toggleJobChecklistItem() reads directly,
  // not as a passed argument) for the checklist panel below. Not previously
  // set anywhere on dashboard.html; safe to introduce, matches the same
  // "current lead in a detail context" meaning customer.html uses it for.
  window._currentLead = lead;
  // Job Checklist — reuses window.JobChecklist.render(lead) UNMODIFIED.
  // Unconditional on every open, same as the six rows below (render() flips
  // #checklistPanel's own display:none → block; nothing to gate here).
  if (window.JobChecklist && typeof window.JobChecklist.render === 'function') {
    window.JobChecklist.render(lead);
  }
  $('mJdDmg').textContent     = lead.damageType || '—';
  $('mJdPhone').textContent   = lead.phone || '—';
  $('mJdEmailV').textContent  = lead.email || '—';
  $('mJdSource').textContent  = lead.source || lead.leadSource || '—';
  // Carrier precedence mirrors claim-core.js normalizeClaim (:92): insCarrier is
  // what the canonical lead writer (crm-leads.js #lInsCarrier) stamps, so it must
  // win. Reading .carrier first meant this row showed '—' for every lead that
  // actually had a carrier.
  $('mJdCarrier').textContent = lead.insCarrier || lead.insuranceCarrier || lead.carrier || '—';
  $('mJdClaim').textContent   = lead.claimNumber || lead.claim || '—';
  // Warranty Claim panel — reuses window.WarrantyClaim.renderPanel(elId, lead)
  // UNMODIFIED (same function customer.html calls). Self-clears to '' when
  // lead.openWarrantyClaimId is falsy, so calling it unconditionally on every
  // open (same as the 6 rows above, not the lazy _mount*() pattern the
  // Firestore-backed tabs use) is safe and always reflects the current lead.
  if (window.WarrantyClaim && typeof window.WarrantyClaim.renderPanel === 'function') {
    window.WarrantyClaim.renderPanel('mJdWarrantyClaimPanel', lead);
  }
  // Insurance Details panel — reuses window.ClaimPanel.render(containerId, lead)
  // UNMODIFIED from claim-core.js. normalizeClaim() reads flat fields straight
  // off the in-memory lead object (no Firestore call), so — like the panel
  // above — this runs synchronously on every open, not through the lazy
  // _mount*() pattern. Same gate customer-bootstrap.module.js uses for
  // #insurancePanel's own display:block toggle.
  {
    const insPanel = $('mJdInsurancePanel');
    const isInsurance = lead.jobType === 'insurance' || lead.insCarrier || lead.insuranceCarrier
      || lead.claimNumber || (lead.claimStatus && lead.claimStatus !== 'No Claim');
    if (insPanel) {
      if (isInsurance && window.ClaimPanel && typeof window.ClaimPanel.render === 'function') {
        insPanel.style.display = 'block';
        window.ClaimPanel.render('mJdInsurancePanel', lead);
      } else {
        insPanel.style.display = 'none';
      }
    }
  }
  // Communication Log — same "clear cache flag on every open" contract as
  // Documents/the activity feed above; _mountCommsLog (dashboard-actions.js)
  // re-fetches on the next switch to Details.
  const commsBody = $('mJdCommsLog');
  if (commsBody) {
    delete commsBody.dataset.loadedFor;
    commsBody.innerHTML = '<div class="m-jd-empty">Loading…</div>';
  }
  // Notes — same "clear cache flag on every open" contract as Comms Log
  // above; _mountNotesTab (dashboard-actions.js) re-fetches on the next
  // switch to Details.
  const notesBody = $('mJdNotesList');
  if (notesBody) {
    delete notesBody.dataset.loadedFor;
    notesBody.innerHTML = '<div class="m-jd-empty">Loading…</div>';
  }

  // ── Photos tab — cleared, not built. CustomerPhotoHub owns this tab and
  // mounts on the first switch to it (_mJdSwitchTab), same lazy contract as
  // the Estimates tab. This used to paint a read-only date-grouped `<img>`
  // grid with NO click handler — the rep could look at thumbnails and do
  // nothing with them, and the PHOTOS action navigated away instead. The hub
  // renders the same date groups plus capture/upload/tag/cover/delete.
  const photoBody = $('mJdTabPhotos');
  if (photoBody) {
    if (window.CustomerPhotoHub && window.CustomerPhotoHub.leadId() !== leadId) {
      window.CustomerPhotoHub.unmount();
    }
    photoBody.innerHTML = '<div class="m-jd-empty">Loading photos…</div>';
  }

  // ── Documents tab — cleared, not built. _mountDocumentsHub owns this tab
  // and mounts on the first switch to it (_mJdSwitchTab), same lazy contract
  // as Estimates/Photos. Clearing the cache flag forces a re-fetch for
  // whichever lead this overlay is opening for now, not the previous one.
  const docBody = $('mJdTabDocuments');
  if (docBody) {
    delete docBody.dataset.loadedFor;
    docBody.innerHTML = '<div class="m-jd-empty">Loading documents…</div>';
  }

  // ── Homeowner portal activity feed — same "clear cache flag on every
  // open" contract as Documents above; _mountCustomerActivityFeed
  // (dashboard-actions.js) re-fetches on the next switch to Activity.
  const actFeedBody = $('mJdCustomerActivityFeed');
  if (actFeedBody) {
    delete actFeedBody.dataset.loadedFor;
    actFeedBody.innerHTML = '<div class="m-jd-empty">Loading…</div>';
  }

  // ── Activity tab — the lead's estimates + stage history ──
  // Was a static stub that always read "No activity yet for this lead" (the
  // tab was never populated). Surface what we already hold in memory (no extra
  // Firestore reads): the lead's estimates (tappable → open the estimate) and
  // its stage-change history. Preserves the static "Start Inspection" CTA and
  // toggles the empty-state message.
  const actBody = $('mJdTabActivity');
  if (actBody) {
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    const ms = (v) => (v && v.toDate ? v.toDate().getTime() : (v ? new Date(v).getTime() : 0)) || 0;
    const fmtWhen = (v) => {
      const t = ms(v); if (!t) return '';
      const days = Math.floor((Date.now() - t) / 86400000);
      return days <= 0 ? 'today' : days === 1 ? 'yesterday'
        : days < 30 ? days + 'd ago' : new Date(t).toLocaleDateString();
    };
    const items = [];
    // Estimates: leadId match, plus a stamped primary that may predate the
    // leadId-attach fix. Tappable → _mJdOpenEstimate opens it.
    (window._estimates || []).forEach(e => {
      if (!e || (e.leadId !== lead.id && e.id !== lead.primaryEstimateId)) return;
      // Classic estimates carry their value on `amount` (the shape the
      // customer page's own Log Estimate flow writes, and what its timeline
      // reads back via est.amount). This ladder stopped at grandTotal|total,
      // so every Classic doc scored 0 and the row rendered a bare "Estimate"
      // with the "· $X" suffix silently dropped. Same two-shape reader as the
      // rest of the money surfaces.
      const _rowsApi = window.NBDCustomerEstimateRows;
      const amt = (_rowsApi && typeof _rowsApi.estimateValue === 'function')
        ? _rowsApi.estimateValue(e)
        : Number(e.grandTotal != null ? e.grandTotal
            : e.total != null ? e.total
            : e.amount) || 0;
      const sub = [e.name && esc(e.name), fmtWhen(e.createdAt)].filter(Boolean).join(' · ');
      items.push({ t: ms(e.createdAt), html:
        '<button type="button" class="m-jd-act-item" data-action="call" data-fn="_mJdOpenEstimate" data-arg="' + esc(e.id) + '">'
        + '<span class="m-jd-act-item-ico">📄</span>'
        + '<span class="m-jd-act-item-body">'
        +   '<span class="m-jd-act-item-t">Estimate' + (amt ? ' · $' + amt.toLocaleString() : '') + '</span>'
        + (sub ? '<span class="m-jd-act-item-s">' + sub + '</span>' : '')
        + '</span><span class="m-jd-act-item-chev">›</span></button>' });
    });
    // Stage-change history (from the lead doc — no query).
    (lead.stageHistory || []).forEach(h => {
      if (!h || !h.to) return;
      const label = (typeof window.stageLabel === 'function')
        ? window.stageLabel(h.to) : String(h.to).replace(/_/g, ' ');
      items.push({ t: ms(h.timestamp), html:
        '<div class="m-jd-act-item m-jd-act-item--static">'
        + '<span class="m-jd-act-item-ico">🔁</span>'
        + '<span class="m-jd-act-item-body">'
        +   '<span class="m-jd-act-item-t">Stage → ' + esc(label) + '</span>'
        +   '<span class="m-jd-act-item-s">' + fmtWhen(h.timestamp) + '</span>'
        + '</span></div>' });
    });
    items.sort((a, b) => b.t - a.t);
    const emptyEl = actBody.querySelector('.m-jd-empty');
    let listEl = actBody.querySelector('.m-jd-act-list');
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.className = 'm-jd-act-list';
      if (emptyEl) actBody.insertBefore(listEl, emptyEl); else actBody.appendChild(listEl);
    }
    listEl.innerHTML = items.map(i => i.html).join('');
    if (emptyEl) emptyEl.hidden = items.length > 0;
  }

  // ── Estimates tab — cleared, not built. CustomerEstimateHub mounts on the
  // first switch to the tab (_mJdSwitchTab). Clearing here means the previous
  // customer's estimates can never flash in the panel for this one.
  const estBody = $('mJdTabEstimates');
  if (estBody) {
    if (window.CustomerEstimateHub && window.CustomerEstimateHub.leadId() !== leadId) {
      window.CustomerEstimateHub.unmount();
    }
    estBody.innerHTML = '<div class="m-jd-empty">Loading estimates…</div>';
  }

  // ── Reset to Activity tab on every open ──
  _mJdSwitchTab('activity');

  // Show — reuse the cached `root` ref from the entry-guard above.
  root.hidden = false;
  root.classList.add('open');
  document.body.style.overflow = 'hidden';
}
window.openMobileJobDetail = openMobileJobDetail;

function closeMobileJobDetail() {
  const root = document.getElementById('mJobDetail');
  if (!root) return;
  root.classList.remove('open');
  root.hidden = true;
  document.body.style.overflow = '';
}
window.closeMobileJobDetail = closeMobileJobDetail;

// Populate the row of quick actions inside the prospect banner. Disabled
// states render for actions whose underlying data isn't on the lead
// (e.g. no phone → Call/Text disabled). Uses programmatic event listeners
// instead of inline onclick attributes so addresses with special chars
// (double-quotes, ampersands, etc.) can't break the HTML.
function populateProspectQuickActions(lead) {
  const wrap = document.getElementById('prospectQuickActions');
  if (!wrap) return;
  const phone = (lead.phone || '').replace(/\D/g, '');
  const email = (lead.email || '').trim();
  const hasGeo = (lead.lat != null && lead.lng != null);
  const isHidden = !!lead.prospectHidden;

  // Build buttons with createElement so user-controlled strings (address,
  // email) never enter the HTML attribute parser.
  wrap.innerHTML = '';
  const make = (icon, label, opts) => {
    // Batch-2 consolidation: canonical .btn chrome instead of hand-rolled
    // inline button styles. Only non-chrome layout tweaks stay inline.
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-sm ' + (opts.danger ? 'btn-red' : 'btn-ghost');
    b.textContent = `${icon} ${label}`;
    b.disabled = !!opts.disabled;
    if (opts.disabled) {
      b.style.cssText = 'opacity:.45;cursor:not-allowed;color:var(--m);';
    }
    if (!opts.disabled && typeof opts.onClick === 'function') {
      b.addEventListener('click', opts.onClick);
    }
    return b;
  };

  wrap.appendChild(make('📞', 'Call',  { disabled: !phone, onClick: () => { window.location.href = 'tel:' + phone; } }));
  wrap.appendChild(make('💬', 'Text',  { disabled: !phone, onClick: () => { window.location.href = 'sms:' + phone; } }));
  wrap.appendChild(make('✉️', 'Email', { disabled: !email, onClick: () => { window.location.href = 'mailto:' + email; } }));
  wrap.appendChild(make('🚪', 'Re-knock', { onClick: () => {
    closeCardDetailModal();
    if (window.D2D) {
      window.D2D.openQuickKnock({ address: lead.address || '', lat: lead.lat || null, lng: lead.lng || null });
    } else {
      goTo('d2d');
    }
  }}));
  // Registry-only (Globals Tranche 3 T3-A, 2026-09-18), not bare window globals.
  var _nbdReg = window.__NBD_CALL_REGISTRY;
  wrap.appendChild(make('🗺️', 'See on Map', {
    disabled: !hasGeo,
    onClick: () => { closeCardDetailModal(); _nbdReg && _nbdReg.viewProspectOnMap(lead.id); }
  }));
  wrap.appendChild(make(isHidden ? '👁️' : '🗄️', isHidden ? 'Unhide' : 'Hide', {
    onClick: () => { _nbdReg && _nbdReg.toggleProspectHidden(lead.id); }
  }));
  wrap.appendChild(make('🗑️', 'Delete', {
    danger: true, onClick: () => { _nbdReg && _nbdReg.absoluteDeleteProspect(lead.id); }
  }));
}


// CSP-safe delegation (2 inline onclicks).
(function(){if(_NBD_DW_DELEGATE)return;_NBD_DW_DELEGATE=true;
document.addEventListener('click',function(ev){
  var t=ev.target.closest&&ev.target.closest('[data-dw-action]');
  if(!t)return;
  var a=t.dataset.dwAction;var id=t.dataset.dwId;
  try{
    if(a==='openPhotoTile'){window._currentPhotoLeadId=id;if(window.PhotoEngine&&typeof window.PhotoEngine.openGallery==='function')window.PhotoEngine.openGallery('photoGalleryContainer',id);if(typeof setPhotoMode==='function')setPhotoMode('by-property');}
    else if(a==='makeLeadFromSearch'&&typeof makeLeadFromSearch==='function')makeLeadFromSearch();
  }catch(e){console.error('[dashboard-widgets]',e);}
});})();
