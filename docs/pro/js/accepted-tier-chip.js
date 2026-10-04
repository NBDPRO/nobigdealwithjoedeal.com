/**
 * accepted-tier-chip.js — "Homeowner picked Elite — use it?" on the customer page.
 *
 * 2026-10-03 (stage-flow lane). When a homeowner accepts a Close Board deal
 * on a tier other than the one the rep already had on the estimate, the
 * server records the pick beside it (functions/deal-accepted-tier.js:
 * estimate.acceptedTier / acceptedPrice) and never overwrites the rep's
 * choice. This chip, above the Estimates list, makes adopting it one tap:
 *   Use it → the estimate's tier + total become the accepted ones, and the
 *            lead's job value follows when it is the primary estimate.
 *   Keep   → dismissed (acceptedTierDismissed), the rep's tier stands.
 * Re-renders on nbd:data-refreshed {source:'estimates'} (loadEstimates).
 *
 * Pure rules (pendingPick / usePatch) are exported for tests. CSP-safe: one
 * delegated listener, classes only (css/customer-tasks.css).
 */
(function (root) {
  'use strict';

  const TIER_LABELS = { economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' };
  const tierLabel = (t) => TIER_LABELS[String(t || '').toLowerCase()] || String(t || '');
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** The estimate with an un-adopted homeowner pick (primary first), or null. */
  function pendingPick(lead, estimates) {
    const l = lead || {};
    const list = (estimates || []).filter((e) => e && !e.deleted && e.acceptedTier
      && !e.acceptedTierApplied && !e.acceptedTierDismissed
      && String(e.acceptedTier).toLowerCase() !== String(e.selectedTier || e.tier || '').toLowerCase());
    if (!list.length) return null;
    const est = list.find((e) => l.primaryEstimateId && e.id === l.primaryEstimateId) || list[0];
    const tier = String(est.acceptedTier).toLowerCase();
    const fromMap = est.prices && Number(est.prices[tier]);
    const price = fromMap > 0 ? fromMap : Number(est.acceptedPrice) || 0;
    return { est, tier, price, current: String(est.selectedTier || est.tier || '').toLowerCase() };
  }

  /** The writes for "Use it". */
  function usePatch(lead, pick) {
    const l = lead || {};
    const p = Math.round(Number(pick.price) * 100) / 100;
    const estimate = { tier: pick.tier, selectedTier: pick.tier, acceptedTierApplied: true };
    if (p > 0) estimate.grandTotal = p;
    const isPrimary = !l.primaryEstimateId || l.primaryEstimateId === pick.est.id;
    const leadUpd = (isPrimary && p > 0) ? { jobValue: p } : null;
    return { estimate, lead: leadUpd };
  }

  function _lead() { return root._currentLead || root._leadDoc || {}; }

  function render() {
    if (typeof document === 'undefined') return;
    const list = document.getElementById('estimateList');
    if (!list || !list.parentNode) return;
    let host = document.getElementById('acceptedTierChip');
    const pick = pendingPick(_lead(), root._customerEstimates || []);
    if (!pick) { if (host) host.remove(); return; }
    if (!host) {
      host = document.createElement('div');
      host.id = 'acceptedTierChip';
      host.className = 'atc-chip';
      host.setAttribute('role', 'status');
      list.parentNode.insertBefore(host, list);
    }
    host.dataset.estId = pick.est.id;
    host.innerHTML =
      '<div class="atc-text">🤝 Homeowner picked <strong>' + esc(tierLabel(pick.tier)) + '</strong>' +
        (pick.price > 0 ? ' (' + esc(money(pick.price)) + ')' : '') + ' in the deal room — use it?' +
        (pick.current ? ' <span class="atc-sub">The estimate says ' + esc(tierLabel(pick.current)) + '.</span>' : '') + '</div>' +
      '<div class="atc-actions">' +
        '<button type="button" class="atc-btn atc-use" data-atc="use">Use ' + esc(tierLabel(pick.tier)) + '</button>' +
        '<button type="button" class="atc-btn atc-keep" data-atc="keep">Keep ' + esc(tierLabel(pick.current) || 'mine') + '</button>' +
      '</div>';
  }

  let _busy = false;
  async function act(kind) {
    if (_busy) return;
    if (root.NBDRole && !root.NBDRole.guard()) return;
    const lead = _lead();
    const pick = pendingPick(lead, root._customerEstimates || []);
    if (!pick || !(root.updateDoc && root.doc && root.db)) return;
    _busy = true;
    try {
      if (kind === 'use') {
        const w = usePatch(lead, pick);
        await root.updateDoc(root.doc(root.db, 'estimates', pick.est.id), w.estimate);
        Object.assign(pick.est, w.estimate);
        if (w.lead && root._customerId) {
          await root.updateDoc(root.doc(root.db, 'leads', root._customerId), w.lead);
          [root._currentLead, root._leadDoc].forEach((o) => { if (o) Object.assign(o, w.lead); });
          const jv = document.getElementById('infoJobValue');
          if (jv) jv.textContent = money(w.lead.jobValue);
        }
        if (typeof root.showToast === 'function') root.showToast('Estimate set to ' + tierLabel(pick.tier) + ' ✓', 'success');
      } else {
        await root.updateDoc(root.doc(root.db, 'estimates', pick.est.id), { acceptedTierDismissed: true });
        pick.est.acceptedTierDismissed = true;
      }
    } catch (e) {
      if (typeof root.showToast === 'function') root.showToast('Could not update the estimate: ' + ((e && (e.code || e.message)) || 'unknown'), 'error');
    } finally {
      _busy = false;
      render();
    }
  }

  if (root && typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('#acceptedTierChip [data-atc]') : null;
      if (b) act(b.dataset.atc);
    });
    root.addEventListener('nbd:data-refreshed', (e) => {
      const src = e && e.detail && e.detail.source;
      if (!src || src === 'estimates') render();
    });
  }

  const api = { pendingPick, usePatch, render, tierLabel };
  if (root) root.NBDAcceptedTier = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
