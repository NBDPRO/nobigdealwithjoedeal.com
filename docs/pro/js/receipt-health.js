/**
 * receipt-health.js — "are the receipts all in?" panel on Expenses (2026-10-18).
 *
 * Read-only. It writes nothing, so it has no flag. Three things:
 *   1. UNSORTED: how many store receipts (Home Depot / Lowe's imports) have no
 *      job and were not marked overhead, with a chip on each such row. When the
 *      receipt sorter queue is on, one tap opens it.
 *   2. COSTS MISSING: finished jobs with NO direct cost logged at all. job
 *      profit reads collected minus direct costs, so such a job shows a margin
 *      of about 100% and overstates profit until its receipts are in (the
 *      2026-10-18 audit found 19 of the last 20 finished jobs like this).
 *   3. ACTIVE JOBS: a Copy PO name button per job still in progress, so the
 *      customer number goes into the Home Depot / Lowe's PO field at checkout
 *      (po-name.js builds the text: "NBD-0042 Smith").
 *
 * Pure parts are exported for tests (window.NBDReceiptHealth).
 */
(function () {
  'use strict';
  if (typeof window === 'undefined') return;
  const w = window;

  const WON = ['closed', 'install_complete', 'final_photos', 'final_payment', 'deductible_collected', 'collections', 'warranty_claim', 'Complete'];
  const ACTIVE_RE = /contract|install|material|schedul|production|permit|supplement/i;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function stageKey(l) { return (l && (l._stageKey || l.stage)) || ''; }
  // Stage role first (custom pipelines), the key list as the fallback.
  function isWon(l) {
    const k = stageKey(l);
    let r = l && l._stageRole;
    if (!r && typeof w.stageRole === 'function') { try { r = w.stageRole(k); } catch (e) { r = null; } }
    return r ? r === 'won' : WON.indexOf(k) !== -1;
  }
  function isLost(l) {
    const k = stageKey(l);
    let r = l && l._stageRole;
    if (!r && typeof w.stageRole === 'function') { try { r = w.stageRole(k); } catch (e) { r = null; } }
    return r ? r === 'lost' : /lost|dead|declin/i.test(k);
  }
  function name(l) { return ((l.firstName || '') + ' ' + (l.lastName || '')).trim() || l.name || String(l.address || '').split(',')[0] || 'Untitled'; }

  // A store receipt nobody has sorted: the queue's rule (receipt-sorter-logic.js),
  // kept here so this panel does not depend on that piece.
  function isUnsorted(e) {
    if (!e || e.deleted === true) return false;
    if (e.reviewState === 'unsorted' || e.reviewState === 'suggested') return true;
    if (e.reviewState) return false;
    return /^import_/.test(String(e.source || '')) && !e.leadId && e.costType === 'direct';
  }
  function unsortedList(expenses) { return (expenses || []).filter(isUnsorted); }

  // Finished jobs with no direct cost on the books.
  function costsMissing(leads, expenses) {
    const withCost = {};
    (expenses || []).forEach((e) => {
      if (!e || e.deleted === true || e.estimated === true || !e.leadId || e.costType !== 'direct') return; // an estimate is not a receipt
      if ((Number(e.amountCents) || 0) + (Number(e.taxCents) || 0) > 0) withCost[e.leadId] = true;
    });
    return (leads || []).filter((l) => l && l.id && !l.deleted && isWon(l) && !withCost[l.id]);
  }

  function activeJobs(leads) {
    return (leads || []).filter((l) => l && l.id && !l.deleted && l.customerId && !isWon(l) && !isLost(l) && ACTIVE_RE.test(stageKey(l)));
  }

  function panelHtml(expenses, leads) {
    const uns = unsortedList(expenses);
    const miss = costsMissing(leads, expenses);
    const act = activeJobs(leads);
    if (!uns.length && !miss.length && !act.length) return '';
    let h = '<div class="ui-card rh-panel">';
    if (uns.length) {
      const queue = w.NBDReceiptSorter && typeof w.NBDReceiptSorter.enabled === 'function' && w.NBDReceiptSorter.enabled();
      h += '<div class="rh-row"><span class="rh-chip">UNSORTED</span><span class="rh-text"><b>' + uns.length + '</b> store receipt' + (uns.length === 1 ? ' has' : 's have') + ' no job yet.</span>' +
        (queue ? '<button type="button" class="btn btn-ghost btn-sm" data-rs-action="open">Sort them</button>' : '') + '</div>';
    }
    if (miss.length) {
      h += '<div class="rh-row rh-col"><div class="rh-text"><span class="rh-chip rh-chip-warn">COSTS MISSING</span> <b>' + miss.length + '</b> finished job' + (miss.length === 1 ? ' has' : 's have') +
        ' no costs logged, so profit and margin read too high until their receipts are in.</div><ul class="rh-list">' +
        miss.slice(0, 6).map((l) => '<li>' + esc(name(l)) + (l.customerId ? ' <span class="rh-sub">' + esc(l.customerId) + '</span>' : '') + '</li>').join('') +
        (miss.length > 6 ? '<li class="rh-sub">+ ' + (miss.length - 6) + ' more</li>' : '') + '</ul></div>';
    }
    if (act.length) {
      h += '<details class="rh-act"><summary>Jobs in progress: copy the PO name for checkout (' + act.length + ')</summary><ul class="rh-list">' +
        act.slice(0, 12).map((l) => '<li><span>' + esc(name(l)) + ' <span class="rh-sub">' + esc(l.customerId) + '</span></span>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-rh-copy="' + esc(l.id) + '">Copy PO name</button></li>').join('') +
        '</ul></details>';
    }
    return h + '</div>';
  }

  if (typeof document !== 'undefined' && !w._NBD_RH_DELEGATE) {
    w._NBD_RH_DELEGATE = true;
    document.addEventListener('click', (ev) => {
      const t = ev.target && ev.target.closest && ev.target.closest('[data-rh-copy]');
      if (!t) return;
      const lead = (w._leads || []).find((l) => l && l.id === t.dataset.rhCopy);
      if (lead && w.NBDPoName && typeof w.NBDPoName.copyFor === 'function') w.NBDPoName.copyFor(lead);
    });
  }

  w.NBDReceiptHealth = { isUnsorted, unsortedList, costsMissing, activeJobs, panelHtml, isWon };
})();
