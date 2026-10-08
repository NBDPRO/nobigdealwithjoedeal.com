/**
 * accepted-tier-chip.js — "Homeowner picked Elite — apply it" on the customer page.
 *
 * 2026-10-03 (stage-flow lane). When a homeowner accepts a Close Board deal
 * on a tier other than the one the rep already had on the estimate, the
 * server records the pick beside it (functions/deal-accepted-tier.js:
 * estimate.acceptedTier / acceptedPrice) and never overwrites the rep's
 * choice. This chip, above the Estimates list, makes adopting it one tap:
 *   Use it → the SERVER applies it (deal-acceptance.js useAcceptedTier →
 *            deal-accepted-tier.js applyHomeownerPick): the estimate is
 *            rebuilt at the picked tier, the lead's job value follows when it
 *            is the primary estimate, then the signed price is stamped and
 *            the deposit draft is made on the new price.
 *   Keep   → dismissed (acceptedTierDismissed), the rep's tier stands.
 *
 * 2026-10-07 (review R6-2-3 / R6-2-4, Jo): a LINE-ITEM estimate's rows are
 * priced at the rep's tier, so "Use it" used to swap the totals and leave the
 * rows behind (the contract and invoice no longer added up). It now rebuilds
 * from the per-tier rows the V2 builder stored (tier-build block below); with
 * none stored the chip offers no "Use" button and points the rep at the
 * builder. While a pick waits, no deposit draft is made (deposit-draft-logic
 * accepted_tier_pending) and a "Homeowner picked X — apply it" task sits on
 * the customer and Home.
 * Re-renders on nbd:data-refreshed {source:'estimates'} (loadEstimates).
 *
 * Pure rules (pendingPick, the tier-build block) are exported for tests. CSP-safe: one
 * delegated listener, classes only (css/customer-tasks.css).
 */
(function (root) {
  'use strict';

  const TIER_LABELS = { economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' };
  const tierLabel = (t) => TIER_LABELS[String(t || '').toLowerCase()] || String(t || '');
  const money = (n) => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ── tier-build block: byte-identical in functions/deal-accepted-tier.js and
  //    docs/pro/js/accepted-tier-chip.js (tests/line-item-tiers-r6-2026-10-07 holds them equal) ──
  /**
   * A LINE-ITEM estimate's other tiers (review R6-2-3 / R6-2-4, Jo 2026-10-07).
   * Its saved rows are priced at the rep's tier, so another tier's price can't
   * be dropped onto it: the rows, tax and rounding would no longer add up. The
   * V2 builder therefore stores, at save, each other tier it could offer, built
   * by the same engine (estimate-v2-ui.js _tierBuildsFor):
   *   est.tierRows = { v: 1,
   *     basis: { tier, totalCents, rowsKey },   // the estimate they were built beside
   *     tiers: { <tier>: { rows, grandTotal, subtotal, tax, taxRate, ... } } }
   * A build counts only while the estimate is still the one it was built beside
   * (same tier, same total, same rows): any later edit (the invoice pre-flight's
   * Save to estimate, a re-tier) leaves the builds stale and unusable. The deal
   * room offers only the estimate's own tier plus its usable builds, and "Use
   * it" rebuilds from a build or refuses.
   */
  function isTierPriced(est) {
    return !!est && (est.priceMode === 'per-sq' || (est.prices != null && typeof est.prices === 'object'));
  }

  /** The rows' identity for a build's basis: code + retail cents, in order. */
  function rowsKey(rows) {
    return (Array.isArray(rows) ? rows : []).map(function (r) {
      var v = r && (r.retailTotal != null ? r.retailTotal : r.total);
      return String((r && r.code) || '') + ':' + Math.round(Number(v || 0) * 100);
    }).join('|');
  }

  /** The stored build for `tier`, or null (not line-item, none stored, stale, or the current tier). */
  function tierBuild(est, tier) {
    if (!est || isTierPriced(est)) return null;
    var tr = est.tierRows;
    if (!tr || typeof tr !== 'object' || tr.v !== 1 || !tr.basis || !tr.tiers || typeof tr.tiers !== 'object') return null;
    var chosen = String(est.selectedTier || est.tier || '').toLowerCase();
    var b = tr.basis;
    if (!chosen || String(b.tier || '').toLowerCase() !== chosen) return null;
    if (Math.round(Number(est.grandTotal) * 100) !== Number(b.totalCents)) return null;
    if (rowsKey(est.rows) !== String(b.rowsKey || '')) return null;
    var t = String(tier || '').toLowerCase();
    if (!t || t === chosen || !Object.prototype.hasOwnProperty.call(tr.tiers, t)) return null;
    var build = tr.tiers[t];
    if (!build || typeof build !== 'object' || !Array.isArray(build.rows) || !build.rows.length) return null;
    if (!(Number(build.grandTotal) > 0)) return null;
    return build;
  }

  /**
   * The packages a homeowner may accept on this estimate → { tier: dollars },
   * or null when this estimate doesn't restrict them (tier-priced: every tier
   * in prices{} is priced; no tier chosen: nothing to rebuild beside).
   * Line-item: the estimate's own tier at its total, plus each usable build.
   */
  function offerableTierPrices(est) {
    if (!est || isTierPriced(est)) return null;
    var chosen = String(est.selectedTier || est.tier || '').toLowerCase();
    var total = Number(est.grandTotal);
    if (!chosen || !(total > 0)) return null;
    var out = {};
    var order = ['economy', 'good', 'better', 'best', 'beyond'];
    order.forEach(function (t) {
      if (t === chosen) { out[t] = Math.round(total * 100) / 100; return; }
      var b = tierBuild(est, t);
      if (b) out[t] = Math.round(Number(b.grandTotal) * 100) / 100;
    });
    return out;
  }
  // ── end tier-build block ──

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
    // Can "Use it" rebuild it? A tier-priced estimate re-tiers its totals; a
    // line-item one needs a usable stored build for the picked tier.
    const rebuildable = isTierPriced(est) || !!tierBuild(est, tier);
    return { est, tier, price, current: String(est.selectedTier || est.tier || '').toLowerCase(), rebuildable };
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
    const label = esc(tierLabel(pick.tier));
    host.innerHTML =
      '<div class="atc-text">🤝 Homeowner picked <strong>' + label + '</strong>' +
        (pick.price > 0 ? ' (' + esc(money(pick.price)) + ')' : '') + ' in the deal room — apply it.' +
        (pick.current ? ' <span class="atc-sub">The estimate says ' + esc(tierLabel(pick.current)) + '. No deposit invoice is drafted until it is applied.</span>' : '') +
        (pick.rebuildable ? '' : ' <span class="atc-sub">This estimate has no ' + label + ' line prices saved. Open it in the estimate builder, switch to ' + label + ' and save, then send a new deal page.</span>') +
      '</div>' +
      '<div class="atc-actions">' +
        (pick.rebuildable ? '<button type="button" class="atc-btn atc-use" data-atc="use">Use ' + label + '</button>' : '') +
        '<button type="button" class="atc-btn atc-keep" data-atc="keep">Keep ' + esc(tierLabel(pick.current) || 'mine') + '</button>' +
      '</div>';
  }

  // The server does "Use it" (deal-acceptance.js useAcceptedTier): it re-reads
  // the estimate, rebuilds it, and runs the signature's billing (signed price
  // + deposit draft) — nothing the browser could be trusted to do alone.
  const FUNCTIONS_SDK = '/assets/vendor/firebase/10.12.2/firebase-functions.js';
  async function _callable(name, data) {
    if (!root._functions || !root._httpsCallable) {
      const mod = await import(FUNCTIONS_SDK);
      root._functions = root._functions || mod.getFunctions();
      root._httpsCallable = root._httpsCallable || mod.httpsCallable;
    }
    const res = await root._httpsCallable(root._functions, name)(data || {});
    return (res && res.data) || {};
  }
  const USE_REFUSED = {
    'needs-builder': 'This estimate has no line prices saved for that package. Open it in the builder, switch packages and save.',
    'price-moved': 'The estimate changed since the homeowner accepted. Open it in the builder and send a new deal page.',
    'nothing-pending': 'Nothing to apply — the estimate already matches.',
    'not-allowed': 'You don’t have permission to change this estimate.',
  };

  let _busy = false;
  async function act(kind) {
    if (_busy) return;
    if (root.NBDRole && !root.NBDRole.guard()) return;
    const lead = _lead();
    const pick = pendingPick(lead, root._customerEstimates || []);
    if (!pick || (kind !== 'use' && !(root.updateDoc && root.doc && root.db))) return;
    _busy = true;
    try {
      if (kind === 'use') {
        if (!pick.rebuildable) return;
        const r = await _callable('useAcceptedTier', { estimateId: pick.est.id });
        if (!r.ok) {
          if (typeof root.showToast === 'function') root.showToast(USE_REFUSED[r.reason] || ('Could not apply it: ' + (r.reason || 'unknown')), 'error');
          return;
        }
        // The server rebuilt the estimate; reload it so every number on the
        // page (rows, totals, deposit) is the server's.
        Object.assign(pick.est, { tier: pick.tier, selectedTier: pick.tier, acceptedTierApplied: true });
        const p = Number(r.price);
        const isPrimary = !lead.primaryEstimateId || lead.primaryEstimateId === pick.est.id;
        if (isPrimary && p > 0) {
          [root._currentLead, root._leadDoc].forEach((o) => { if (o) o.jobValue = p; });
          const jv = document.getElementById('infoJobValue');
          if (jv) jv.textContent = money(p);
        }
        if (typeof root.loadEstimates === 'function') { try { await root.loadEstimates(root._customerId); } catch (_) { /* the chip state above stands */ } }
        if (typeof root.showToast === 'function') root.showToast('Estimate set to ' + tierLabel(pick.tier) + (p > 0 ? ' (' + money(p) + ')' : '') + ' ✓', 'success');
      } else {
        await root.updateDoc(root.doc(root.db, 'estimates', pick.est.id), { acceptedTierDismissed: true });
        pick.est.acceptedTierDismissed = true;
        // The rep decided: the "Homeowner picked X — apply it" task the
        // deposit draft filed (deposit-draft-logic applyTierTask) is done.
        if (root._customerId) {
          try {
            await root.updateDoc(root.doc(root.db, 'leads', root._customerId, 'tasks', 'apply-accepted-tier-' + String(pick.est.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)), { done: true });
          } catch (_) { /* no task filed (the pick predates it) — nothing to close */ }
        }
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

  const api = { pendingPick, isTierPriced, rowsKey, tierBuild, offerableTierPrices, render, tierLabel };
  if (root) root.NBDAcceptedTier = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
