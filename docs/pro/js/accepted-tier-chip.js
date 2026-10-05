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

  // ── retier block: byte-identical in functions/deal-accepted-tier.js and
  //    docs/pro/js/accepted-tier-chip.js (tests/deal-accepted-tier-2026-10-03 holds them equal) ──
  /**
   * The homeowner's tier price → every money number on the estimate (Jo,
   * 2026-10-05, bug #10): grandTotal, subtotal + tax, and the deposit.
   *   Tax: a saved estimate stores subtotal / tax for its SELECTED tier only
   *   (prices{} holds each tier's TOTAL), so the picked tier's tax is backed out
   *   of its total at the estimate's own taxRate (else its tax / subtotal, else
   *   0): tax = total x r / (1 + r), subtotal = total - tax. Insurance estimates
   *   carry taxRate 0, so no tax.
   *   Deposit: deposit-rule.js fromEstimate on the new total with the estimate's
   *   own inputs (mode, claim deductible / ACV, address, a stored rep override)
   *   and the lead (its deductible, claim signals, Kentucky address), so a
   *   Kentucky insurance job stays $0 at signing.
   *   Money already collected (opts.depositCollected) or no rule loaded: the
   *   deposit and its plan stay as they were and acceptedTierDepositKept flags
   *   it for the rep. A paid deposit is never silently rewritten.
   * Cents inside; dollar fields out (the estimate's own units).
   */
  function retierFields(est, price, opts) {
    var e = est || {};
    var o = opts || {};
    var totalCents = Math.round(Number(price) * 100);
    var rate = Number(e.taxRate);
    if (e.taxRate == null || e.taxRate === '' || !isFinite(rate) || rate < 0) {
      var st = Number(e.subtotal);
      var tx = Number(e.tax != null ? e.tax : e.taxAmount);
      rate = (st > 0 && isFinite(tx) && tx >= 0) ? tx / st : 0;
    }
    var taxCents = Math.round(totalCents * rate / (1 + rate));
    var out = { grandTotal: totalCents / 100, subtotal: (totalCents - taxCents) / 100, tax: taxCents / 100 };
    if (e.taxAmount != null) out.taxAmount = out.tax;
    if (e.total != null) out.total = out.grandTotal;
    var R = o.depositRule;
    if (o.depositCollected || !R) {
      out.acceptedTierDepositKept = true;
    } else {
      var plan = R.fromEstimate(e, { totalCents: totalCents, lead: o.lead || null });
      out.deposit = plan.depositCents / 100;
      out.depositPlan = R.toStored(plan);
      out.acceptedTierDepositKept = false;
    }
    return out;
  }

  /** Has money been collected on this estimate? (the lead's invoices) */
  function depositCollected(invoices, estimateId) {
    return (invoices || []).some(function (inv) {
      if (!inv || inv.deleted === true) return false;
      if (inv.estimateId && inv.estimateId !== estimateId) return false;
      var st = String(inv.status || '').toLowerCase();
      if (st === 'void' || st === 'voided' || st === 'cancelled' || st === 'canceled') return false;
      return Number(inv.amountPaid) > 0 || inv.depositPaid === true || st === 'paid' || st === 'partial';
    });
  }
  // ── end retier block ──

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

  /**
   * The writes for "Use it". The estimate's subtotal, tax and deposit follow
   * the picked tier's total, exactly as the server does (retierFields, bug
   * #10). opts.depositCollected keeps a deposit money was already taken on;
   * opts.depositRule overrides window.NBDDepositRule (tests).
   */
  function usePatch(lead, pick, opts) {
    const o = opts || {};
    const l = lead || {};
    const p = Math.round(Number(pick.price) * 100) / 100;
    const estimate = { tier: pick.tier, selectedTier: pick.tier, acceptedTierApplied: true };
    if (p > 0) {
      Object.assign(estimate, retierFields(pick.est, p, {
        lead: l, depositRule: o.depositRule || (root && root.NBDDepositRule) || null,
        depositCollected: o.depositCollected === true
      }));
    }
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

  // Has money been taken on this estimate? The customer page's own invoice
  // query (customer-tasks-ui.js loadInvoices: team scope or own). Can't tell
  // → true, so the deposit is kept and flagged rather than rewritten.
  async function _collected(estId) {
    try {
      const a = root.auth || root._auth;
      const uid = (a && a.currentUser && a.currentUser.uid) || (root._user && root._user.uid);
      if (!uid || !root._customerId || !(root.getDocs && root.query && root.where && root.collection)) return true;
      const claims = root._userClaims || {};
      const companyId = claims.companyId || null;
      const team = !!(companyId && (['company_admin', 'manager', 'viewer'].indexOf(claims.role || '') !== -1 || claims.owner === true));
      const ref = root.collection(root.db, 'invoices');
      const q = team
        ? root.query(ref, root.where('leadId', '==', root._customerId), root.where('companyId', '==', companyId))
        : root.query(ref, root.where('leadId', '==', root._customerId), root.where('createdBy', '==', uid));
      const snap = await root.getDocs(q);
      return depositCollected(snap.docs.map((d) => d.data()), estId);
    } catch (_) { return true; }
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
        const w = usePatch(lead, pick, { depositCollected: await _collected(pick.est.id) });
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

  const api = { pendingPick, usePatch, retierFields, depositCollected, render, tierLabel };
  if (root) root.NBDAcceptedTier = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
