// ═══════════════════════════════════════════════════════════════════════════
// NBD Pro — invoice-pipeline.js
// Estimate → Invoice → Payment Pipeline
// Connects estimates to Stripe for invoicing and payment collection
// ═══════════════════════════════════════════════════════════════════════════

let _NBD_IP_DELEGATE_BOUND; // module-local (globals Tranche 1 — was window.*)
(function() {
  'use strict';

  // Emulator switch (same Audit #3 rule as nbd-comms.js / esign-sign.js /
  // portal.js / sign-page.js / estimate-view.js): without this, every direct
  // Cloud Function call from here (createStripePaymentLink, etc.) targeted
  // prod even from localhost, so createStripePaymentLink CORS-failed against
  // prod's CORS_ORIGINS allowlist before ever reaching the local Stripe
  // secret (documentation/audit/STRIPE-INVOICING-STATUS-2026-09-08.md).
  // Guarded like nbd-comms.js's FUNCTIONS_BASE — this file loads via a bare
  // vm.runInNewContext() in tests/estimate-profit.test.js and
  // tests/invoice-pipeline.test.js, which has no `location` global at all.
  const CLOUD_FUNCTION_BASE = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(
    (typeof location !== 'undefined' && location.hostname) || ''
  )
    ? 'http://127.0.0.1:5001/nobigdeal-pro/us-central1'
    : 'https://us-central1-nobigdeal-pro.cloudfunctions.net';
  let _collectOnlineCache = null; // capability resolved once per page load (D7)

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════

  // ── Customer name for "Bill To" (phone audit 2026-09-25, estimate#9) ────
  // createInvoiceFromEstimate read `est.customerName || lead.name`, and
  // NEITHER field is ever written: no estimate writer stamps customerName
  // (the V2 and Classic builders both save the homeowner as `owner`), and the
  // lead writer (crm-leads.js saveLead) saves firstName/lastName, never
  // `name` — 0 of 29 leads on the rig carry it. So every invoice made from an
  // estimate stored customerName '' and printed "BILL TO: Customer" above the
  // homeowner's own email and phone. The linked lead is the customer record,
  // so its current name wins; the estimate's `owner` covers an estimate with
  // no lead. Classic saves a blank owner as '—', which is not a name.
  function _cleanName(v) {
    const s = String(v == null ? '' : v).trim();
    return /^[\s—–-]*$/.test(s) ? '' : s;
  }
  function leadDisplayName(lead) {
    if (!lead) return '';
    return _cleanName(lead.name) || _cleanName(lead.customerName)
      || _cleanName([lead.firstName, lead.lastName].filter(Boolean).join(' '));
  }
  function resolveCustomerName(est, lead) {
    est = est || {};
    return _cleanName(est.customerName) || leadDisplayName(lead) || _cleanName(est.owner);
  }
  // Render-time fallback for invoices ALREADY saved with a blank name (every
  // one made before the fix above): resolve the linked lead from the page's
  // lead cache so their Bill To and list row show the homeowner, not a
  // placeholder. Pure read — the stored doc is not rewritten.
  function invoiceCustomerName(inv) {
    if (!inv) return '';
    const stored = _cleanName(inv.customerName);
    if (stored) return stored;
    const leads = (typeof window !== 'undefined' && Array.isArray(window._leads)) ? window._leads : [];
    const lead = inv.leadId ? leads.find(l => l && l.id === inv.leadId) : null;
    return leadDisplayName(lead);
  }

  /**
   * Get Firebase ID token for Cloud Function calls
   */
  async function getAuthToken() {
    try {
      if (window._auth?.currentUser) {
        return await window._auth.currentUser.getIdToken(true);
      }
      return null;
    } catch (error) {
      console.error('Failed to get auth token:', error);
      return null;
    }
  }

  /**
   * Call Cloud Function with auth
   */
  async function callCloudFunction(endpoint, data) {
    const token = await getAuthToken();
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${CLOUD_FUNCTION_BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      const errData = await response.json();
      throw new Error(errData.error || `API ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Format currency
   */
  function formatCurrency(amount) {
    const n = parseFloat(amount);
    return '$' + (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /**
   * HTML-escape for the list/panel renderers. renderInvoiceDetail and the
   * email builder define their own local _esc; this serves the others
   * (renderInvoicePanel / renderInvoiceList) which had none in scope.
   */
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Company name on anything a HOMEOWNER receives from this module — the
   * invoice email subject, the emailed invoice header and thank-you line, the
   * payment-received receipt, and the SMS. All five were hardcoded
   * "NBD Roofing", so a tenant's customer was told the bill came from the
   * platform owner. (Missed by the brand guard only because this file was not
   * on its FILES list — it is now.)
   *
   * Same isNbd gate as email_system.js _brandFields(): NBD renders
   * byte-identical, a tenant gets their own name, and a tenant with nothing set
   * degrades to a neutral word rather than to the owner's.
   */
  function _invoiceCompany() {
    let b = null;
    try { if (typeof window._brand === 'function') b = window._brand() || null; } catch (e) { b = null; }
    const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    if (isNbd) return 'NBD Roofing';
    return b.legalName || b.displayName || 'your contractor';
  }

  /**
   * Overlay lifecycle for this pipeline's dynamically-built modals.
   * Canonical .modal-bg/.modal markup (dashboard-app.css ~:2187); open and
   * close are ONLY classList 'open' toggles — the .modal-bg is always flex
   * and visibility gates on .open (cert-round rule, never inline display).
   * Prefers the nbdModal helper (dashboard.html loads js/nbd-modal.js, which
   * owns Esc + backdrop-click for managed modals); falls back to a local
   * .open toggle + its own backdrop/Esc close on pages that don't load it
   * (none since the legacy twin retired 2026-09-02). Returns a close() function; `onClose` fires
   * exactly once however the modal is dismissed (button, backdrop, Esc).
   */
  function openOverlay(el, onClose) {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.remove();
      if (typeof onClose === 'function') onClose();
    };
    document.body.appendChild(el);
    if (window.nbdModal && typeof window.nbdModal.open === 'function') {
      window.nbdModal.open(el, { onClose: finish });
      return () => window.nbdModal.close(el);
    }
    const onBackdrop = (e) => { if (e.target === el) closeNow(); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      // Only the top-most open modal closes on Esc (mirrors nbdModal).
      const opens = document.querySelectorAll('.modal-bg.open');
      if (opens.length && opens[opens.length - 1] !== el) return;
      closeNow();
    };
    function closeNow() {
      el.classList.remove('open');
      el.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      finish();
    }
    el.classList.add('open');
    el.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
    return closeNow;
  }

  /**
   * Tear down a leftover modal instance (double-open guard). Routes through
   * nbdModal.close when available so the helper's managed-modal bookkeeping
   * (Esc stack, focus restore) stays consistent before the element goes away.
   */
  function destroyExisting(id) {
    const el = document.getElementById(id);
    if (!el) return;
    if (window.nbdModal && typeof window.nbdModal.close === 'function') {
      window.nbdModal.close(el);
    }
    el.remove();
  }

  /**
   * Get Firestore db reference (v9 modular SDK instance exposed on window._db).
   * Throws if Firestore SDK not loaded or window globals not exposed.
   */
  function getDb() {
    if (!window._db || !window.doc || !window.collection) {
      throw new Error('Firestore (v9) not initialized — window._db missing');
    }
    return window._db;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INSURANCE SUPPLEMENTS → INVOICE
  // ═══════════════════════════════════════════════════════════════════════
  //
  // An estimate can accrue insurance supplements (scope the adjuster approved
  // AFTER the original estimate was priced — see docs/pro/js/estimate-supplement.js).
  // Those approved dollars are real revenue but live in the `supplements`
  // collection, not on the estimate, so they must be folded into the invoice
  // or it undercharges. The total math below is pure (no DOM/Firestore) so it
  // is unit-tested in tests/invoice-pipeline.test.js.

  /**
   * Billable dollars for a single supplement doc.
   *   - status 'approved' → full supplementTotal
   *   - status 'partial'  → submission.approvedAmount (the dollar figure the
   *                         adjuster actually approved)
   *   - anything else (draft / submitted / denied) → 0 (not billable)
   * Field shapes per estimate-supplement.js createSupplement()/recordResponse().
   */
  function supplementBillableAmount(sup) {
    if (!sup) return 0;
    if (sup.status === 'partial') {
      return Number(sup.submission && sup.submission.approvedAmount) || 0;
    }
    if (sup.status === 'approved') {
      return Number(sup.supplementTotal) || 0;
    }
    return 0;
  }

  /**
   * Filter a list of supplement docs down to the billable ones (approved or
   * partial, with a positive amount) and attach the dollar amount + an
   * invoice-line description to each.
   */
  function selectBillableSupplements(supplements) {
    return (supplements || [])
      .map(function (sup) {
        const billable = supplementBillableAmount(sup);
        const version = sup && sup.version ? sup.version : 1;
        const reason = (sup && sup.reason ? String(sup.reason) : '').trim();
        const tag = sup && sup.status === 'partial' ? 'partial approval' : 'approved';
        let description = 'Insurance Supplement #' + version + ' (' + tag + ')';
        if (reason) description += ' — ' + reason;
        return {
          id: (sup && sup.id) || null,
          status: sup && sup.status,
          billable: billable,
          // Already folded onto an invoice — skip so a 2nd invoice for the same
          // estimate (progress billing) can't re-bill this supplement. Stamped by
          // createInvoiceFromEstimate when it folds the supplement. NOTE: a future
          // invoice-void feature MUST clear invoicedInvoiceId to allow re-billing.
          invoiced: !!(sup && sup.invoicedInvoiceId),
          description: description
        };
      })
      .filter(function (s) { return s.billable > 0 && !s.invoiced; });
  }

  /**
   * Fold billable supplements into a base set of invoice totals.
   * Insurance supplements are tax-exempt (estimate-supplement.calculateDelta
   * forces supplementTax = 0), so each amount is appended as its own line item
   * and added to subtotal + total, but tax is left untouched.
   *
   * @param {{items:Array, subtotal:number, tax:number, total:number}} base
   * @param {Array} supplements - raw supplement docs
   * @returns {{items, subtotal, tax, total, supplementTotal, supplementCount}}
   */
  function applySupplementsToTotals(base, supplements) {
    base = base || {};
    const round2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
    const supLines = selectBillableSupplements(supplements);
    const supplementTotal = supLines.reduce(function (s, l) { return s + l.billable; }, 0);
    const items = (base.items || []).concat(supLines.map(function (l) {
      const amt = round2(l.billable);
      return { description: l.description, quantity: 1, unitPrice: amt, total: amt };
    }));
    return {
      items: items,
      subtotal: round2((Number(base.subtotal) || 0) + supplementTotal),
      tax: Number(base.tax) || 0,
      total: round2((Number(base.total) || 0) + supplementTotal),
      supplementTotal: round2(supplementTotal),
      supplementCount: supLines.length,
      // Ids of the supplements folded into THIS invoice, so the caller can stamp
      // them invoiced (they won't fold again on a later invoice).
      supplementIds: supLines.map(function (l) { return l.id; }).filter(Boolean)
    };
  }

  /**
   * First numeric token out of a value. Classic-builder rows store qty/rate as
   * DISPLAY STRINGS ('20.00 SQ', '$595/SQ', '1 EA'), so a bare
   * parseFloat('$595/SQ') is NaN and dropped unit prices to $0 on the invoice.
   */
  function numFrom(v) {
    if (typeof v === 'number') return v;
    const m = String(v == null ? '' : v).match(/-?\d[\d,]*\.?\d*/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
  }

  /**
   * Map a saved estimate's rows to invoice line items — at the CUSTOMER price.
   *
   * Post-sweep V2 saves persist the retail price in rows[].retailTotal (and in
   * rate/total). OLDER V2 saves wrote the raw COST basis (material+labor, no
   * markup, no O&P) into rate/total, so invoices printed the contractor's cost
   * under a retail subtotal — the line items summed to ~55-65% of the subtotal
   * and exposed the margin to the homeowner/adjuster (money-math sweep
   * 2026-07-18). For those docs, derive retail from the persisted split:
   * materialTotal×(1+markup) + laborTotal; rows with no cost basis
   * (pass-through fees) stay at face value. Classic rows (no markup persisted)
   * are already all-in customer prices and map exactly as before.
   *
   * When the estimate carries an O&P ladder (V2 line-item / insurance),
   * Overhead & Profit is appended as its own line — the same presentation as
   * the signed scope ("Line Item Total → +O&P") — so Σ items == subtotal.
   * The invoice's charged total is NOT computed here; the locked saved
   * grandTotal/subtotal stay authoritative in createInvoiceFromEstimate.
   */
  function buildRowItems(est) {
    const markup = Number(est && est.materialMarkupPct);
    const hasV2Pricing = Number.isFinite(markup);
    // Classic docs carry their lines on `lineItems`, V2 on `rows`. Reading
    // `rows` alone silently produced an empty item list for every Classic
    // estimate — which is how a $0 invoice got written for a $14,200 job.
    const items = ((est && (est.rows || est.lineItems)) || []).map(function (row) {
      const quantity = numFrom(row.qty);
      const explicitRetail = (row.retailTotal != null && Number.isFinite(Number(row.retailTotal)))
        ? Number(row.retailTotal) : null;
      const hasSplit = hasV2Pricing && (row.materialTotal != null || row.laborTotal != null);
      let lineTotal, unitPrice;
      if (explicitRetail != null) {
        lineTotal = explicitRetail;
      } else if (hasSplit) {
        const mat = Number(row.materialTotal) || 0;
        const lab = Number(row.laborTotal) || 0;
        lineTotal = (mat === 0 && lab === 0) ? numFrom(row.total) : mat * (1 + markup) + lab;
      } else {
        lineTotal = numFrom(row.total);
      }
      if (explicitRetail != null || hasSplit) {
        // Retail-priced row: derive the unit price from the retail total (the
        // saved rate string on old docs is the COST rate — never print it).
        unitPrice = (Number.isFinite(quantity) && quantity !== 0 && Number.isFinite(lineTotal))
          ? lineTotal / quantity : (Number.isFinite(lineTotal) ? lineTotal : 0);
      } else {
        unitPrice = numFrom(row.rate);
        if (!Number.isFinite(unitPrice) || unitPrice === 0) {
          unitPrice = (Number.isFinite(quantity) && quantity !== 0 && Number.isFinite(lineTotal))
            ? lineTotal / quantity : 0;
        }
      }
      return {
        description: row.desc || row.description || '',
        quantity: Number.isFinite(quantity) ? quantity : 1,
        unitPrice: Math.round((unitPrice || 0) * 100) / 100,
        total: Number.isFinite(lineTotal) ? Math.round(lineTotal * 100) / 100 : 0
      };
    });
    const ohp = (Number(est && est.overhead) || 0) + (Number(est && est.profit) || 0);
    if (hasV2Pricing && ohp > 0 && items.length) {
      const pct = Math.round(((Number(est.overheadPct) || 0) + (Number(est.profitPct) || 0)) * 100);
      const amt = Math.round(ohp * 100) / 100;
      items.push({
        description: 'Overhead & Profit' + (pct ? ' (' + pct + '%)' : ''),
        quantity: 1,
        unitPrice: amt,
        total: amt
      });
    }
    return items;
  }

  /**
   * Load this user's supplements for a parent estimate.
   *
   * Query: where('parentEstimateId','==',id) + where('userId','==',uid) on the
   * `supplements` collection — backed by the composite index added in
   * firestore.indexes.json. Per the index-build-race runbook the index ships
   * (and finishes BUILDING) before this code relies on it; until then the query
   * can throw FAILED_PRECONDITION. So this is deliberately fail-soft: on ANY
   * error we log and return [], and the invoice is created from the base
   * estimate only (the pre-existing behavior) — invoice creation never throws
   * because of supplements. It self-heals the moment the index is live.
   *
   * We re-implement the query here rather than reuse
   * EstimateSupplement.loadForEstimate because the supplement builder module is
   * NOT loaded on dashboard.html (where invoices are created) — only on
   * customer.html / legacy — so reusing it would silently yield zero supplements.
   */
  async function loadEstimateSupplements(db, estimateId) {
    try {
      const uid = window._auth && window._auth.currentUser && window._auth.currentUser.uid;
      if (!uid || !estimateId) return [];
      if (!window.query || !window.where || !window.getDocs || !window.collection) return [];
      const q = window.query(
        window.collection(db, 'supplements'),
        window.where('parentEstimateId', '==', estimateId),
        window.where('userId', '==', uid)
      );
      const snap = await window.getDocs(q);
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (err) {
      console.warn('[invoice-pipeline] supplement load failed (index still building?); invoicing base estimate only:', err && err.message);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CORE INVOICE FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create invoice from estimate
   * @param {string} estimateId - Firestore estimate ID
   * @returns {Promise<string>} invoiceId
   */
  async function createInvoiceFromEstimate(estimateId) {
    const db = getDb();

    try {
      // Read estimate from Firestore (v9 modular)
      const estRef = window.doc(db, 'estimates', estimateId);
      const estSnap = await window.getDoc(estRef);

      if (!estSnap.exists()) {
        // Try window._estimates cache
        const cached = window._estimates?.find(e => e.id === estimateId);
        if (!cached) throw new Error('Estimate not found');
      }

      const est = estSnap.exists() ? estSnap.data() : window._estimates?.find(e => e.id === estimateId);

      // Build invoice from estimate
      // Audit #3 F-3: inherit the tax rate the estimate was priced at (insurance
      // scope skips tax → 0 honored; fall back to 7.5% only when no rate saved).
      const taxRate = (typeof est.taxRate === 'number') ? est.taxRate : 0.075;

      // Two-shape read, not grandTotal alone. Classic estimates (title /
      // amount|total / lineItems) carry no grandTotal, so this scored NaN,
      // hasLockedTotal went false, and buildRowItems — which mapped est.rows
      // only — returned []. Every downstream number then computed 0 and a
      // `total: 0` invoice was written to Firestore before Stripe rejected it,
      // leaving an orphan $0 draft in the AR rollups. The picker that chose the
      // estimate had shown the right figure all along; it uses estimateValue.
      const _rowsApi = window.NBDCustomerEstimateRows;
      const savedGrand = (_rowsApi && typeof _rowsApi.estimateValue === 'function')
        ? _rowsApi.estimateValue(est)
        : numFrom(est.grandTotal != null ? est.grandTotal
            : est.total != null ? est.total : est.amount);
      const hasLockedTotal = Number.isFinite(savedGrand) && savedGrand > 0;
      const isPerSq = (est.priceMode === 'per-sq') || (est.prices != null);

      let items, subtotal, tax, total;
      if (isPerSq && hasLockedTotal) {
        // PER-SQ V2: the customer price is the LOCKED selected-tier grandTotal,
        // not the internal cost-basis rows. Invoice it as a single summary line
        // so the invoice total == the signed quote.
        total = savedGrand;
        subtotal = taxRate > 0 ? (total / (1 + taxRate)) : total;
        tax = total - subtotal;
        subtotal = Math.round(subtotal * 100) / 100;
        tax = Math.round(tax * 100) / 100;
        const tierLabel = String(est.selectedTier || est.tier || '').replace(/^./, c => c.toUpperCase());
        items = [{
          description: 'Roofing system' + (tierLabel ? ' — ' + tierLabel + ' tier' : ''),
          quantity: 1,
          unitPrice: subtotal,
          total: subtotal
        }];
      } else {
        // Row-based (classic builder + V2 line-item/insurance). Line items map
        // at the CUSTOMER price — incl. the retail derivation for older V2 docs
        // that persisted the cost basis, and the O&P line that makes the items
        // foot to the subtotal — in buildRowItems (pure, unit-tested).
        items = buildRowItems(est);
        if (hasLockedTotal) {
          // Trust the estimate's saved locked totals — the signed quote bakes in
          // the job-minimum floor + nearest-$25 rounding that a naive row-sum
          // recompute would drop, making the invoice disagree with the quote.
          total = savedGrand;
          const savedSub = Number(est.subtotal);
          // Classic builder saves `taxAmount`; V2 (estimate-v2-ui.js) saves the
          // SAME value under `tax` instead — a field-naming mismatch, not a
          // missing value. Reading only `taxAmount` made every V2 doc read NaN
          // here and fall through to `total - subtotal`, which is real tax ONLY
          // for a non-insurance job; for insurance (taxRate 0, true tax exactly
          // $0) that fallback instead measures the nearest-$25 ROUNDING NOISE
          // baked into `total` — negative about half the time (round-down),
          // and a fabricated positive "tax" on a tax-exempt invoice the other
          // half (round-up). `??` (not `||`) so an explicit 0 is trusted, not
          // treated as missing.
          const savedTax = Number(est.taxAmount ?? est.tax);
          subtotal = Number.isFinite(savedSub) ? savedSub : (taxRate > 0 ? total / (1 + taxRate) : total);
          tax = Number.isFinite(savedTax) ? savedTax : (total - subtotal);
          subtotal = Math.round(subtotal * 100) / 100;
          tax = Math.round(tax * 100) / 100;
        } else {
          subtotal = items.reduce((sum, item) => sum + item.total, 0);
          tax = subtotal * taxRate;
          total = subtotal + tax;
        }
      }
      // ── Fold in approved/partial insurance supplements ──────────────────
      // Supplements are newly-discovered scope the adjuster approved AFTER the
      // estimate was priced. They live in their own `supplements` collection
      // and are NOT part of the estimate's saved total — so an invoice built
      // from the estimate alone undercharges by the approved supplement amount.
      // (Adversarial review 2026-06-27, confirmed HIGH; deferred from #793 for
      // the new composite index.) Insurance supplements are tax-exempt, so each
      // billable amount lands in subtotal + total as its own line, never taxed.
      // loadEstimateSupplements is fail-soft (returns [] on any error / while
      // the index is still building), so this can never break invoice create.
      const supplements = await loadEstimateSupplements(db, estimateId);
      const folded = applySupplementsToTotals({ items, subtotal, tax, total }, supplements);
      items = folded.items;
      subtotal = folded.subtotal;
      tax = folded.tax;
      total = folded.total;
      const supplementTotal = folded.supplementTotal;

      // Deposit — deposit-rule.js (2026-09-25) on the INVOICE total (which
      // folds in approved supplements): cash under $2,000 none, cash $2,000+
      // 50%, insurance the deductible + the ACV payment, a rep override
      // (classic Override %) honored. This was "the saved deposit, else 50%":
      // a Job Template estimate saves no deposit, so a $555 repair invoiced a
      // $277.50 deposit, and a doc saved under the old 50/50 / 0% logic
      // carried its stale number into the invoice. The lead's deductible
      // fills in when the estimate carries none (resolved just below).
      const _depRule = window.NBDDepositRule || null;
      let depositPlan = null;
      let depositAmount = 0;

      // Resolve the customer's identity + contact ONCE so downstream send
      // (email/SMS), the paid-receipt, and the rendered "Bill To" actually have
      // a recipient. createInvoiceFromEstimate previously never stored these, so
      // sends reached an empty address and the invoice showed placeholders.
      let lead = (est.leadId && Array.isArray(window._leads))
        ? window._leads.find(l => l && l.id === est.leadId) : null;
      if (!lead && est.leadId) {
        try {
          const leadSnap = await window.getDoc(window.doc(db, 'leads', est.leadId));
          if (leadSnap.exists()) lead = leadSnap.data();
        } catch (_) { /* lead read is best-effort */ }
      }
      const customerName  = resolveCustomerName(est, lead);
      const customerEmail = est.customerEmail || (lead && lead.email) || '';
      const customerPhone = est.customerPhone || (lead && lead.phone) || '';

      if (_depRule) {
        depositPlan = _depRule.fromEstimate(est, { totalCents: Math.round(Number(total) * 100), lead: lead || null });
        depositAmount = depositPlan.depositCents / 100;
      }

      // Create invoice doc
      const invoiceData = {
        leadId: est.leadId || null,
        estimateId: estimateId,
        customerId: est.customerId || null,
        customerName: customerName,
        customerEmail: customerEmail,
        customerPhone: customerPhone,
        status: 'draft',
        items: items,
        subtotal: subtotal,
        tax: tax,
        taxRate: taxRate,
        total: total,
        // How much of `total` came from approved/partial insurance supplements
        // (0 when none) — kept for AR auditing and so the invoice is traceable
        // back to the supplement(s) it folded in.
        supplementTotal: supplementTotal,
        depositAmount: depositAmount,
        depositPaid: false,
        amountPaid: 0,
        // balanceDue tracks GENUINELY-OWED money: the full total until real
        // payments arrive (markPaid / the Stripe webhook). It was `total -
        // depositAmount`, which booked the deposit as collected at create time —
        // so AR/outstanding under-reported by the (uncollected) deposit.
        balanceDue: total,
        stripeInvoiceId: null,
        stripePaymentLink: null,
        dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days
        sentAt: null,
        paidAt: null,
        viewedAt: null,
        notes: '',
        // The rule's own sentence, not "50% deposit due upon scheduling".
        depositTerms: depositPlan ? depositPlan.summary : '',
        // Rep-only (review fix, 2026-09-25): why this deposit is what it is
        // when the rep should know — a classic Override % honored, a deposit
        // raised to the deductible, no deductible entered (an insurance
        // invoice then shows no deposit line at all), the old $2,500
        // placeholder. Shown in the invoice detail view, never on the
        // customer's invoice (buildInvoiceHtml does not read it).
        depositRepNote: (depositPlan && depositPlan.repNote) ? depositPlan.repNote : '',
        // Kentucky insurance job (KRS 367.626; Jo, 2026-09-27): nothing may be
        // required before the insurer's written decision + the 5-business-day
        // window. The server (createStripePaymentLink) withholds the online
        // link until the rep records the decision date on the lead and the
        // window has run — or the rep marks this invoice emergency work
        // (367.626(3)). Informational here; the server re-derives it.
        kyInsuranceHold: !!(depositPlan && depositPlan.kyHold),
        emergencyServices: false,
        terms: 'Net 14.' + (depositPlan && depositPlan.summary ? ' ' + depositPlan.summary : ''),
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: window._auth?.currentUser?.uid || 'system',
        // Tenant key (mirrors /expenses): lets same-company staff read team
        // invoices and is required by the hardened /invoices create rule. Solo
        // operators key by uid (companyId == uid convention).
        companyId: window._userClaims?.companyId || window._auth?.currentUser?.uid || null
      };

      // Backstop — refuse to persist a zero invoice, whatever produced it.
      // The two-shape reads above fix the known cause, but an invoice for $0 is
      // never a thing a rep meant to create: Stripe rejects it downstream
      // ("Invoice has no line items"), so the only lasting effect is an orphan
      // draft that still counts in the AR rollups on the money dashboard and in
      // analytics. Failing here costs the rep one error toast; succeeding costs
      // them a wrong receivables number they have no obvious way to find.
      if (!(Number(invoiceData.total) > 0)) {
        throw new Error('This estimate has no dollar total — open it and set a price before invoicing.');
      }

      const invoiceRef = await window.addDoc(window.collection(db, 'invoices'), invoiceData);

      // Stamp each supplement folded into THIS invoice so it can't be re-billed on
      // a later invoice for the same estimate. Progress billing intentionally
      // allows multiple invoices per estimate (Jo's call 2026-07-08), so a
      // supplement must land on exactly ONE. Best-effort — a stamp miss risks a
      // manual double-check, never a create failure; the invoice already exists.
      const foldedIds = (folded && folded.supplementIds) || [];
      if (foldedIds.length && typeof window.updateDoc === 'function' && typeof window.doc === 'function') {
        const stampTs = (typeof window.serverTimestamp === 'function') ? window.serverTimestamp() : new Date().toISOString();
        await Promise.all(foldedIds.map(function (sid) {
          return window.updateDoc(window.doc(db, 'supplements', sid), {
            invoicedInvoiceId: invoiceRef.id,
            invoicedAt: stampTs,
          }).catch(function (e) {
            console.warn('[invoice-pipeline] supplement invoiced-stamp failed:', sid, e && e.message);
          });
        }));
      }
      return invoiceRef.id;

    } catch (error) {
      console.error('createInvoiceFromEstimate error:', error);
      throw error;
    }
  }

  /**
   * Generate Stripe Payment Link for invoice
   * @param {string} invoiceId
   * @returns {Promise<{url: string, paymentLinkId: string}>}
   */
  // Client-side MIRROR of the server gate (functions/stripe.js): the platform
  // tenant may always mint; any other tenant only when their
  // connectAccounts/{companyId} mirror satisfies mayCollectOnline()
  // (functions/stripe-connect-logic.js:149-157): acct_ id + chargesEnabled +
  // detailsSubmitted + livemode. A MIRROR, not the authority — the server
  // re-checks (plus the live-subscription gate) and refuses with 403
  // ONLINE_PAYMENTS_UNAVAILABLE. firestore.rules already allows the
  // same-tenant read of connectAccounts; the getConnectStatus callable is
  // per-uid rate-limited and NOT safe to call per render.
  // Fail CLOSED. Unresolved identity or a failed read returns false WITHOUT
  // caching (claims hydrate late — the #1139 trap); only definitive answers
  // are cached for the page's lifetime (a tenant finishing onboarding
  // mid-session reloads to pick it up).
  // Everything downstream still renders the Pay Online button, SMS link and
  // portal CTA conditionally on invoice.stripePaymentLink — no extra branching.
  async function _canCollectOnline() {
    try {
      if (_collectOnlineCache !== null) return _collectOnlineCache;
      const claims = window._userClaims || {};
      const uid = (window._user && window._user.uid) || null;
      const OWNER = window.__NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';
      if (uid === OWNER || claims.companyId === OWNER) {
        _collectOnlineCache = true;
        return true;
      }
      const companyId = claims.companyId || uid;
      if (!companyId) return false; // identity not resolved — do NOT cache
      const snap = await window.getDoc(window.doc(getDb(), 'connectAccounts', companyId));
      const s = (snap && snap.exists()) ? snap.data() : {};
      // QA/emulator only — mirrors the server's NBD_CONNECT_ALLOW_TEST_MODE.
      // Console-spoofing it buys nothing: the server refuses.
      const allowTest = window.__NBD_CONNECT_ALLOW_TEST_MODE === true;
      const ok = String(s.accountId || '').startsWith('acct_')
        && s.chargesEnabled === true
        && s.detailsSubmitted === true
        && (s.livemode === true || allowTest);
      _collectOnlineCache = ok; // definitive — cache per page load
      return ok;
    } catch (e) {
      return false; // fail CLOSED — never mint on an unresolved identity or failed read
    }
  }

  async function generateStripePaymentLink(invoiceId) {
    if (!(await _canCollectOnline())) {
      const err = new Error('Online card payment isn\'t set up for your company yet — '
        + 'connect payouts under Settings → Billing, or record check/cash under Mark Paid.');
      err.code = 'ONLINE_PAYMENTS_UNAVAILABLE';
      throw err;
    }
    try {
      const result = await callCloudFunction('createStripePaymentLink', {
        invoiceId: invoiceId
      });

      // Update invoice with stripe info (v9 modular)
      const db = getDb();
      await window.updateDoc(window.doc(db, 'invoices', invoiceId), {
        stripePaymentLink: result.url,
        stripeInvoiceId: result.paymentLinkId,
        updatedAt: new Date()
      });

      return result;

    } catch (error) {
      if (error && !error.code && /ONLINE_PAYMENTS_UNAVAILABLE/.test(String(error.message || ''))) {
        error.code = 'ONLINE_PAYMENTS_UNAVAILABLE';
      }
      if (error && !error.code && /KY_CANCELLATION_WINDOW/.test(String(error.message || ''))) {
        error.code = 'KY_CANCELLATION_WINDOW';
        const _J = (typeof window !== 'undefined') && window.NBDJurisdiction;
        error.message = (_J && _J.MSG.payLinkHeld) || 'Online payment link withheld until the Kentucky cancellation window has run.';
      }
      console.error('generateStripePaymentLink error:', error);
      throw error;
    }
  }

  // Offline SMS outbox (sms-outbox.js). An invoice text sent while offline is
  // STORED, not sent (NBDComms returns mode 'queued'), so sendInvoice leaves
  // the invoice unsent. When the outbox later sends it — in any tab, on any
  // page load, even before this lazy-loaded file is on the page — it keeps a
  // receipt with the source/sourceRef given here, and this file applies it
  // through NBDSmsOutbox.onSent() whenever it is loaded: the invoice is
  // marked sent then, and only if it is still unsent. (An in-memory window
  // event reached only listeners already loaded in the tab that flushed, so
  // an invoice whose text went out stayed 'draft' and invited a re-send.)
  const INVOICE_SMS_SOURCE = 'invoice-sms';

  // ── Money status around a send ─────────────────────────────────────────
  // "Send to Customer" is offered on every invoice, paid ones included. The
  // send lock ('sending') used to be released to 'draft' whatever the invoice
  // was before, and a completed send wrote 'sent' over it: a PAID invoice
  // re-sent by text came back draft/sent — out of leaderboard revenue, into
  // AR, with "Mark Paid" offered again (a second payments entry, amountPaid
  // double-counted). The lock now remembers the status it replaced
  // (sendingPriorStatus) and everything that ends a send restores it; only a
  // DRAFT becomes 'sent'.

  /** What the invoice was before this send — a stale lock keeps ITS prior status. */
  function _priorStatusOf(inv) {
    const s = inv && inv.status;
    if (s === 'sending') return (inv && inv.sendingPriorStatus) || 'draft';
    return s || 'draft';
  }

  /** The write for "it went out": a draft becomes sent; paid / partial / overdue / void keep their status. */
  function _sentPatch(inv, priorStatus, now) {
    const patch = {
      status: priorStatus === 'draft' ? 'sent' : priorStatus,
      lastSentAt: now,
      sendingAt: null,
      sendingPriorStatus: null,
      updatedAt: now,
    };
    if (priorStatus === 'draft' || !(inv && inv.sentAt)) patch.sentAt = now;
    return patch;
  }

  /**
   * Release the send lock back to the status it replaced — ONLY if the
   * invoice still says 'sending'. A Stripe webhook or Mark Paid that landed in
   * between wins. A transaction where the page has one (both CRM pages expose
   * window.runTransaction), so the check and the write are one step; offline
   * a transaction cannot run and nothing is written — the 2-minute stale-lock
   * rule lets the next send through and markInvoiceSentAfterQueuedSms resolves
   * a 'sending' invoice from its sendingPriorStatus.
   */
  function _releaseSendLock(db, invRef, priorStatus, extra, opt) {
    const restore = (cur) => Object.assign({
      status: (cur && cur.sendingPriorStatus) || priorStatus || 'draft',
      sendingAt: null,
      sendingPriorStatus: null,
      updatedAt: new Date(),
    }, extra || {});
    // preferLocal: skip the transaction arm. A Firestore transaction CANNOT run
    // offline (see the JSDoc above), so on a call site that only ever executes
    // while offline — the queued path — preferring it means the release never
    // happens at all. getDoc reads the in-memory cache and updateDoc is
    // latency-compensated, so both apply immediately and land on reconnect.
    //
    // This was the blocker the round-3 review found: sendingPriorStatus was
    // wired correctly at every write path, but the one restore that matters on
    // the queued path was routed through the one primitive guaranteed not to
    // work there. A PAID invoice whose queued text was later discarded stayed
    // 'sending' forever, and money-dashboard.js only skips status === 'paid' —
    // so its full face value re-entered Outstanding A/R and the Collections
    // queue, and the detail view re-offered "Mark Paid".
    if (!(opt && opt.preferLocal) && typeof window.runTransaction === 'function') {
      return Promise.resolve(window.runTransaction(db, async (tx) => {
        const snap = await tx.get(invRef);
        if (!snap.exists()) return false;
        const cur = snap.data() || {};
        if (cur.status !== 'sending') return false;
        tx.update(invRef, restore(cur));
        return true;
      }));
    }
    return (async () => {
      const snap = await window.getDoc(invRef);
      if (!snap.exists() || (snap.data() || {}).status !== 'sending') return false;
      await window.updateDoc(invRef, restore(snap.data() || {}));
      return true;
    })();
  }

  /**
   * The outbox sent (or the rep handed off from the tray) this invoice's
   * queued text. A 'sending' lock is transparent here — what matters is what
   * the invoice was: a draft becomes 'sent'; any other status is restored
   * (and stamped lastSentAt) if the lock is still on, and otherwise left
   * alone (paid, void, sent another way). Transactional where the page can,
   * for the same reason as _releaseSendLock.
   */
  async function markInvoiceSentAfterQueuedSms(invoiceId) {
    const db = getDb();
    const ref = window.doc(db, 'invoices', invoiceId);
    const decide = (cur) => {
      const now = new Date();
      const locked = cur.status === 'sending';
      const effective = locked ? (cur.sendingPriorStatus || 'draft') : cur.status;
      if (effective === 'draft') return _sentPatch(cur, 'draft', now);
      if (locked) return { status: effective, sendingAt: null, sendingPriorStatus: null, lastSentAt: now, updatedAt: now };
      return null;
    };
    if (typeof window.runTransaction === 'function') {
      return window.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) return false;
        const patch = decide(snap.data() || {});
        if (!patch) return false;
        tx.update(ref, patch);
        return patch.status === 'sent';
      });
    }
    const snap = await window.getDoc(ref);
    if (!snap.exists()) return false;
    const patch = decide(snap.data() || {});
    if (!patch) return false;
    await window.updateDoc(ref, patch);
    return patch.status === 'sent';
  }

  // Resolves → the receipt is applied (or had nothing to do) and deleted;
  // throws → kept for the next drain (e.g. Firestore globals not up yet).
  function _applyInvoiceSmsReceipt(d) {
    if (!d || typeof d.sourceRef !== 'string' || !d.sourceRef) return false;
    return markInvoiceSentAfterQueuedSms(d.sourceRef);
  }
  function _registerInvoiceSmsReceipts() {
    const ob = window.NBDSmsOutbox;
    if (!ob || typeof ob.onSent !== 'function') return false;
    ob.onSent(INVOICE_SMS_SOURCE, _applyInvoiceSmsReceipt);
    return true;
  }
  if (typeof window !== 'undefined' && !_registerInvoiceSmsReceipts()
    && typeof window.addEventListener === 'function') {
    // Loaded before sms-outbox.js: register when it announces itself.
    window.addEventListener('nbd:sms-outbox-ready', _registerInvoiceSmsReceipts, { once: true });
  }

  /**
   * Send invoice to customer
   * @param {string} invoiceId
   * @param {string} method - 'email' | 'sms' | 'portal'
   * @returns {Promise<void|{queued: true, id: string|null}>} `{queued:true}` when
   *   the SMS went to the offline outbox — the invoice is NOT marked sent.
   */
  async function sendInvoice(invoiceId, method) {
    const db = getDb();
    // What the invoice was before this send (see _priorStatusOf): restored
    // when the send ends without delivering, kept when it delivers anything
    // but a draft.
    let priorStatus = 'draft';

    try {
      const invRef = window.doc(db, 'invoices', invoiceId);
      const invSnap = await window.getDoc(invRef);

      if (!invSnap.exists()) throw new Error('Invoice not found');

      const invoice = invSnap.data();
      priorStatus = _priorStatusOf(invoice);

      // ── Idempotency guard ──────────────────────────────────
      // Refuse to re-send an invoice that's already been sent. Without
      // this, a flaky network — where the email goes out but the
      // followup `status:'sent'` write fails — left the invoice in
      // 'draft' so the next "Send" tap delivered the same invoice
      // twice to the customer. Even more important: an in-flight send
      // (status:'sending') blocks concurrent taps from doubling up.
      if (invoice.status === 'sent') {
        const sentDate = invoice.sentAt?.toDate?.() || invoice.sentAt;
        const niceDate = sentDate ? new Date(sentDate).toLocaleString() : 'previously';
        if (window.showToast) {
          window.showToast('Invoice already sent ' + niceDate + '. Use "Resend" to override.', 'info');
        }
        throw new Error('Invoice already sent');
      }
      if (invoice.status === 'sending') {
        const startedAt = invoice.sendingAt?.toDate?.() || invoice.sendingAt;
        const ageMs = startedAt ? (Date.now() - new Date(startedAt).getTime()) : 0;
        // Stale sending lock (>2 min) means the prior attempt died
        // before completing — release it. Otherwise refuse to
        // double-send.
        if (ageMs > 0 && ageMs < 120000) {
          if (window.showToast) {
            window.showToast('Already sending — wait a moment before retrying.', 'info');
          }
          throw new Error('Send already in progress');
        }
      }

      // Take the lock before any side-effect. If two tabs race here,
      // Firestore serializes the writes — both will succeed but the
      // second one's status check above will catch it on the next
      // call attempt. For tighter guarantees we'd use a transaction;
      // this lock is sufficient for the iPhone/desktop double-tap case.
      // BOUND THE ACQUIRE. This app runs Firestore with NO local persistence
      // (nbd-auth.js's initializeFirestore has no localCache), so offline a
      // write does not reject — it never settles until the connection returns.
      // An unconditional await here therefore parked the whole function before
      // it ever reached NBDComms.sendSMS, making the offline queue unreachable
      // in exactly the state it exists for: the rep saw "Sending invoice via
      // sms…", that toast self-removed at 2600ms, then nothing. Same on
      // Wi-Fi-with-no-internet, where navigator.onLine is true but nothing acks.
      //
      // Racing a timer is safe because Firestore's latency compensation applies
      // the local mutation immediately, so the in-tab double-tap guard above
      // still sees status 'sending' even when the write has not acked.
      // photo-queue-recovery.js bounds its write for the same reason.
      //
      // Overridable so a test can exercise the abandon path without a real
      // 4-second wait — the same window.__nbd* hook idiom photo-queue-recovery
      // uses.
      const lockTimeoutMs = (typeof window !== 'undefined'
        && typeof window.__nbdInvoiceLockTimeoutMs === 'number'
        && window.__nbdInvoiceLockTimeoutMs > 0) ? window.__nbdInvoiceLockTimeoutMs : 4000;
      try {
        await Promise.race([
          window.updateDoc(invRef, {
            status: 'sending',
            sendingAt: new Date(),
            // The status this lock replaces — every path that ends the send
            // puts it back (a paid invoice must not come out 'draft').
            sendingPriorStatus: priorStatus,
            updatedAt: new Date()
          }),
          new Promise((resolve) => setTimeout(resolve, lockTimeoutMs)),
        ]);
      } catch (lockErr) {
        console.warn('sendInvoice lock acquire failed, proceeding cautiously:', lockErr && lockErr.message);
      }

      if (method === 'email') {
        // Build invoice HTML
        const invoiceHtml = buildInvoiceHtml(invoice);

        // Send via NBDComms
        if (window.NBDComms?.sendEmail) {
          const emailResult = await window.NBDComms.sendEmail({
            to: invoice.customerEmail || '',
            subject: `Invoice ${invoiceId} from ${_invoiceCompany()}`,
            html: invoiceHtml,
            leadId: invoice.leadId || null,
            kind: 'invoice', // transactional: never blocked by an email unsubscribe
          });
          if (!emailResult || emailResult.success === false) {
            throw new Error((emailResult && (emailResult.message || emailResult.error)) || 'Email send failed');
          }
        } else {
          throw new Error('Email service not available');
        }

      } else if (method === 'sms') {
        const link = invoice.stripePaymentLink || '';
        // Two fixes on one line. The company was hardcoded "NBD Roofing", so a
        // tenant's homeowner was told the invoice came from the platform owner.
        // And the link was interpolated unconditionally — with none (which is
        // now the normal case for a tenant) the customer got "Payment link: "
        // with nothing after it.
        const message = link
          ? `Your ${_invoiceCompany()} invoice is ready. Payment link: ${link}`
          : `Your ${_invoiceCompany()} invoice is ready — reply here with any questions.`;

        if (window.NBDComms?.sendSMS) {
          const smsResult = await window.NBDComms.sendSMS({
            to: invoice.customerPhone || '',
            message: message,
            leadId: invoice.leadId || null,
            // Lets the listener below find this invoice when a queued copy
            // of the text is sent later by the offline outbox.
            source: INVOICE_SMS_SOURCE,
            sourceRef: invoiceId,
          });
          // A refusal (opted out / opt-out unverified) leaves the invoice
          // unsent. `message` is the sentence NBDComms showed the rep; `error`
          // is a machine code such as 'opted_out' when the server sent one.
          if (!smsResult || smsResult.success === false) {
            throw new Error((smsResult && (smsResult.message || smsResult.error)) || 'SMS send failed');
          }
          // Offline: the text is stored in the outbox, NOT sent. The invoice
          // must not say 'sent' — release the lock back to the status it
          // replaced (never 'draft' over 'paid'), only if it is still locked,
          // and let the outbox receipt (_applyInvoiceSmsReceipt, via onSent)
          // mark it sent when the text really goes. Not awaited: offline a
          // Firestore call does not resolve until the connection is back, and
          // the lock self-expires anyway.
          if (smsResult.mode === 'queued') {
            // preferLocal: this branch runs BECAUSE we are offline, and a
            // transaction cannot run offline — routing the release through one
            // meant it never happened. See _releaseSendLock.
            Promise.resolve()
              .then(() => _releaseSendLock(db, invRef, priorStatus, null, { preferLocal: true }))
              .catch((e) => console.warn('sendInvoice queued-lock release failed:', e && e.message));
            return { queued: true, id: smsResult.id || null };
          }
        } else {
          throw new Error('SMS service not available');
        }

      } else if (method === 'portal') {
        // Update lead + mark invoice sent atomically — if the lead
        // write fails the invoice should NOT show as sent. Otherwise
        // the customer record claims the invoice is delivered while
        // the invoice itself is still draft and never reached them.
        if (invoice.leadId && window.writeBatch) {
          const batch = window.writeBatch(db);
          batch.update(window.doc(db, 'leads', invoice.leadId), {
            invoices: window.arrayUnion(invoiceId),
            updatedAt: new Date()
          });
          batch.update(invRef, _sentPatch(invoice, priorStatus, new Date()));
          await batch.commit();
          return;
        }
      }

      // Email/SMS branches (and portal-without-lead): mark invoice sent
      // only after the outbound side-effect above resolved. A draft becomes
      // 'sent'; a paid (partial, overdue, void) invoice keeps its status and
      // only gets lastSentAt.
      await window.updateDoc(invRef, _sentPatch(invoice, priorStatus, new Date()));

    } catch (error) {
      console.error('sendInvoice error:', error);
      // Release the 'sending' lock on failure so the user can retry — back to
      // the status it replaced, not 'draft', and only if it is still locked.
      // Don't blindly reset 'sent' status though — the idempotency
      // check at the top owns those branches.
      try {
        const invRef2 = window.doc(db, 'invoices', invoiceId);
        // Bounded for the same reason the lock ACQUIRE is (see the Promise.race
        // above): both arms of _releaseSendLock are offline-incapable, and a
        // transaction that hangs rather than rejecting would park this catch
        // and the caller would never see the throw. The lock also self-expires
        // via the 2-minute stale rule, so abandoning the wait is safe.
        const releaseTimeoutMs = (typeof window !== 'undefined'
          && typeof window.__nbdInvoiceLockTimeoutMs === 'number'
          && window.__nbdInvoiceLockTimeoutMs > 0) ? window.__nbdInvoiceLockTimeoutMs : 4000;
        await Promise.race([
          _releaseSendLock(db, invRef2, priorStatus, {
            lastSendError: (error && error.message) ? error.message.slice(0, 200) : 'unknown',
          }),
          new Promise((resolve) => setTimeout(resolve, releaseTimeoutMs)),
        ]);
      } catch (releaseErr) {
        console.warn('sendInvoice lock release failed:', releaseErr && releaseErr.message);
      }
      throw error;
    }
  }

  /**
   * Mark invoice as paid
   * @param {string} invoiceId
   * @param {number} amount
   * @param {string} method - 'cash' | 'check' | 'stripe'
   */
  async function markPaid(invoiceId, amount, method) {
    const db = getDb();

    amount = Number(amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Invalid payment amount');
    }

    try {
      const invRef = window.doc(db, 'invoices', invoiceId);
      const invSnap = await window.getDoc(invRef);

      if (!invSnap.exists()) throw new Error('Invoice not found');

      const invoice = invSnap.data();
      // Cumulative paid ledger: balanceDue = total − amountPaid, so multiple
      // partial payments accumulate correctly. The old `balanceDue - amount`
      // plus a heuristic depositPaid (flips on ANY payment ≥ depositAmount) lost
      // track across payments and couldn't tell a deposit from a final payment.
      const total = Number(invoice.total) || 0;
      const newPaid = Math.round(((Number(invoice.amountPaid) || 0) + (Number(amount) || 0)) * 100) / 100;
      const newBalanceDue = Math.max(0, Math.round((total - newPaid) * 100) / 100);
      const paidAtNow = new Date();
      // Append-only cash ledger: each credit keeps its own date so Money +
      // Analytics can attribute multi-payment invoices by receipt period
      // (deposit in May ≠ balance payoff in July). lastPaymentAt stays as the
      // latest-receipt pointer for UI/"has any payment" checks.
      const priorPayments = Array.isArray(invoice.payments) ? invoice.payments.slice() : [];
      priorPayments.push({
        amount: Math.round(amount * 100) / 100,
        at: paidAtNow,
        method: method || 'manual',
      });

      // Update invoice
      await window.updateDoc(invRef, {
        amountPaid: newPaid,
        depositPaid: newPaid >= (Number(invoice.depositAmount) || 0),
        balanceDue: newBalanceDue,
        status: newBalanceDue === 0 ? 'paid' : invoice.status,
        paidAt: newBalanceDue === 0 ? paidAtNow : invoice.paidAt,
        // Stamped on EVERY payment (incl. partial deposits) so the money
        // dashboard attributes collected cash to the year it was received.
        // paidAt only fires on full payoff, so it alone hid deposit cash.
        lastPaymentAt: paidAtNow,
        payments: priorPayments,
        updatedAt: paidAtNow
      });

      // Regenerate the online payment link to the NEW outstanding balance.
      // The link is minted at invoice creation for the full total; once a
      // deposit is recorded here it's stale and would re-charge the full
      // amount (overcharge). Regenerating rebuilds it to (total − amountPaid)
      // and deactivates the stale one server-side. Skip when fully paid (no
      // balance to collect) or when the invoice never had a link. Non-fatal —
      // the ledger is already updated; a failed regen just leaves the rep to
      // resend.
      if (invoice.stripePaymentLink && newBalanceDue > 0) {
        try { await generateStripePaymentLink(invoiceId); }
        catch (regenErr) {
          console.warn('markPaid: payment-link regen failed', regenErr && regenErr.message);
          if (regenErr && regenErr.code === 'KY_CANCELLATION_WINDOW' && typeof showToast === 'function') {
            showToast('Payment recorded. ' + regenErr.message, 'info');
          }
          if (regenErr && regenErr.code === 'ONLINE_PAYMENTS_UNAVAILABLE') {
            // Capability lost since the original mint (deauthorized /
            // sub lapsed). The server refused BEFORE it could deactivate the
            // prior link, so the STALE link may remain payable on Stripe —
            // null the CRM fields so every CTA disappears; the single-use
            // restriction bounds residual exposure to one session. Runbook
            // documents manual deactivation in the Stripe dashboard.
            try {
              await window.updateDoc(window.doc(getDb(), 'invoices', invoiceId), {
                stripePaymentLink: null, stripeInvoiceId: null, updatedAt: new Date(),
              });
            } catch (clearErr) { console.warn('markPaid: stale-link clear failed', clearErr && clearErr.message); }
            if (typeof showToast === 'function') {
              showToast('Payment recorded, but online card payments are no longer enabled for this company — '
                + 'the old payment link was removed. Re-enable payouts under Settings → Billing.', 'warning');
            }
          }
        }
      }

      // If fully paid, advance lead stage. Post-crm-stages migration the
      // canonical key for this transition is 'contract_signed' (the legacy
      // display name 'Approved' maps to S.CONTRACT_SIGNED via LEGACY_MAP in
      // crm-stages.js). v159.4 swept most legacy writes; this one was
      // missed. Writing the canonical key keeps the Firestore doc in sync
      // with the schema instead of relying on normalizeStage() at read time.
      if (newBalanceDue === 0 && invoice.leadId) {
        await window.updateDoc(window.doc(db, 'leads', invoice.leadId), {
          stage: 'contract_signed',
          // Stamp stageRole alongside stage, same as every other stage-mutation
          // path (#981's persisted-stageRole-wins contract — the server's
          // functions/stage-roles.js roleFor() prefers this over deriving from
          // the raw key). 'contract_signed' resolves to role 'active' either
          // way, so this write is consequence-neutral TODAY — but an unstamped
          // write silently violates the invariant every other stage change
          // upholds, and would go live-wrong the moment this stage's
          // classification ever changes. window.stageRole (not a frozen ES
          // import) so a tenant-customized role map is honored.
          ...(window.stageRole ? { stageRole: window.stageRole('contract_signed') } : {}),
          updatedAt: new Date()
        });
      }

      // Send receipt
      if (window.NBDComms?.sendEmail && invoice.customerEmail) {
        await window.NBDComms.sendEmail({
          to: invoice.customerEmail,
          subject: `Payment Received - ${_invoiceCompany()} Invoice ${invoiceId}`,
          html: `<p>Thank you! We received your payment of ${formatCurrency(amount)}.</p><p>Your invoice is now ${newBalanceDue === 0 ? 'fully paid' : 'partially paid'}.</p>`,
          leadId: invoice.leadId || null,
          kind: 'receipt', // transactional: payment confirmation
        });
      }

    } catch (error) {
      console.error('markPaid error:', error);
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UI RENDERING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Render invoice panel (list of invoices for a lead)
   */
  async function renderInvoicePanel(containerId, leadId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const db = getDb();

    try {
      // Fetch invoices for lead (v9 modular; requires leadId+createdAt composite index)
      const q = window.query(
        window.collection(db, 'invoices'),
        window.where('leadId', '==', leadId),
        window.orderBy('createdAt', 'desc')
      );
      const snap = await window.getDocs(q);

      const invoices = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      let html = `
        <div class="invoice-panel" style="padding:16px;background:var(--s);border-radius:8px;border:1px solid var(--br);">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
            <h3 style="margin:0;font-size:14px;font-weight:700;">Invoices</h3>
            <button type="button" class="btn btn-orange btn-sm" data-ip-action="createInvoiceUI" data-ip-id="${leadId}">+ New Invoice</button>
          </div>
      `;

      if (invoices.length === 0) {
        html += `
          <div class="nbd-empty" style="padding:20px 12px;">
            <div class="ne-icon">🧾</div>
            <div class="ne-msg">No invoices yet</div>
            <div class="ne-sub">Create one from this lead's estimate.</div>
          </div>`;
      } else {
        html += `<div style="display:grid;gap:8px;">`;
        invoices.forEach(inv => {
          const statusBg = inv.status === 'paid' ? 'var(--green)' : inv.status === 'sent' ? 'var(--blue)' : 'var(--m)';
          const _s = String(inv.status || '');
          const statusTxt = escHtml(_s.charAt(0).toUpperCase() + _s.slice(1));
          html += `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--s2);border-radius:5px;border-left:3px solid ${statusBg};">
              <div style="flex:1;">
                <div style="font-weight:700;font-size:12px;">${formatCurrency(inv.total)}</div>
                <div style="font-size:11px;color:var(--m);">${statusTxt}</div>
              </div>
              <div style="display:flex;gap:6px;">
                <button type="button" class="btn btn-ghost btn-sm" data-ip-action="renderDetail" data-ip-id="${inv.id}" data-ip-target="inv-detail">View</button>
                <button type="button" class="btn btn-orange btn-sm" data-ip-action="sendInvoice" data-ip-id="${inv.id}">Send</button>
              </div>
            </div>
          `;
        });
        html += `</div>`;
      }

      html += `</div>`;
      container.innerHTML = html;

    } catch (error) {
      console.error('renderInvoicePanel error:', error);
      container.innerHTML = `<div style="color:var(--red);padding:12px;">Failed to load invoices</div>`;
    }
  }

  /**
   * Render full invoice detail view
   */
  // Phone fit for the invoice detail (phone audit 2026-09-25, seen while
  // verifying estimate#9): at 360px the line-item table (4 columns, 8px cell
  // padding, inside 24px modal + 20px card padding) was 393px wide, so the
  // TOTAL column — the money — sat past the screen edge; at 412 it ran past
  // the card. Every style below is inline, so the narrow-screen rules need
  // !important; the media query leaves tablet/desktop exactly as they were.
  // Injected once, like estimate-preview.js — style-src allows it.
  function _ensureInvoiceDetailStyles() {
    if (typeof document === 'undefined' || document.getElementById('nbd-inv-detail-css')) return;
    const st = document.createElement('style');
    st.id = 'nbd-inv-detail-css';
    st.textContent = '@media (max-width:480px){'
      + '#nbd-invoice-detail-modal{padding:12px !important;}'
      + '.invoice-detail{padding:14px 12px !important;}'
      + '.invoice-detail .inv-lines th,.invoice-detail .inv-lines td{padding:6px 4px !important;}'
      + '.invoice-detail .inv-lines th{font-size:10px !important;}'
      + '.invoice-detail .inv-lines td{font-size:13px;}'
      // Only DESCRIPTION (cell and header) may break anywhere, so a wider
      // fallback font can't push TOTAL off-screen. Quantity and money cells
      // never wrap, and the other headers wrap at a space only (UNIT/PRICE):
      // breaking them anywhere split the QUANTITY header into QUANTI/TY.
      + '.invoice-detail .inv-lines :is(th,td):first-child{overflow-wrap:anywhere;}'
      + '.invoice-detail .inv-lines td:nth-child(n+2){white-space:nowrap;}'
      + '}';
    document.head.appendChild(st);
  }

  async function renderInvoiceDetail(containerId, invoiceId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    _ensureInvoiceDetailStyles();

    const db = getDb();

    try {
      const snap = await window.getDoc(window.doc(db, 'invoices', invoiceId));
      if (!snap.exists()) throw new Error('Invoice not found');

      const inv = snap.data();
      const _esc = (s) => String(s == null ? '' : s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
      const _escJs = (s) => String(s == null ? '' : s)
        .replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"')
        .replace(/</g,'\\x3c').replace(/>/g,'\\x3e').replace(/\n/g,'\\n');

      // The invoice header used to read a hardcoded "NBD ROOFING" — a company
      // name that is not even Joe's (No Big Deal Home Solutions), and flatly
      // wrong for any other tenant, on a document about money owed. Resolve it
      // from the brand like everything else, and fall back to the real legal
      // name rather than to a guess.
      const _invoiceBrandName = () => {
        try {
          const b = (typeof window !== 'undefined' && window._brand) ? (window._brand() || {}) : {};
          return b.displayName || b.legalName || 'No Big Deal Home Solutions';
        } catch (_) { return 'No Big Deal Home Solutions'; }
      };

      let html = `
        <div class="invoice-detail" style="padding:20px;background:var(--paper,#fff);color:var(--ink,#1a1612);border-radius:8px;max-width:900px;margin:0 auto;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;">
            <div>
              <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:24px;font-weight:700;color:var(--orange);">${_esc(_invoiceBrandName())}</div>
              <div style="font-size:12px;color:var(--m);">Invoice ${_esc(invoiceId)}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-size:32px;font-weight:700;color:var(--orange);">${formatCurrency(inv.total)}</div>
              <div style="font-size:11px;color:var(--m);text-transform:uppercase;letter-spacing:.05em;font-weight:700;">${_esc(inv.status)}</div>
            </div>
          </div>

          <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px;">
            <div>
              <div style="font-size:10px;color:var(--m);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Bill To</div>
              <div style="font-size:14px;font-weight:700;">${_esc(invoiceCustomerName(inv) || 'Customer')}</div>
              <div style="font-size:12px;color:var(--m);">${_esc(inv.customerEmail || '')}</div>
              ${inv.customerPhone ? `<div style="font-size:12px;color:var(--m);">${_esc(inv.customerPhone)}</div>` : ''}
            </div>
            <div>
              <div style="font-size:10px;color:var(--m);text-transform:uppercase;font-weight:700;margin-bottom:4px;">Invoice Details</div>
              <div style="display:grid;gap:4px;font-size:12px;">
                <div><strong>Date:</strong> ${new Date(inv.createdAt?.toDate?.() || inv.createdAt).toLocaleDateString()}</div>
                <div><strong>Due Date:</strong> ${new Date(inv.dueDate?.toDate?.() || inv.dueDate).toLocaleDateString()}</div>
                <div><strong>Status:</strong> ${_esc((inv.status||'').toString().toUpperCase())}</div>
              </div>
            </div>
          </div>

          <table class="inv-lines" style="width:100%;border-collapse:collapse;margin-bottom:20px;">
            <thead>
              <tr style="border-bottom:2px solid var(--br);">
                <th style="text-align:left;padding:8px;font-weight:700;font-size:11px;">DESCRIPTION</th>
                <th style="text-align:right;padding:8px;font-weight:700;font-size:11px;">QUANTITY</th>
                <th style="text-align:right;padding:8px;font-weight:700;font-size:11px;">UNIT PRICE</th>
                <th style="text-align:right;padding:8px;font-weight:700;font-size:11px;">TOTAL</th>
              </tr>
            </thead>
            <tbody>
      `;

      inv.items?.forEach(item => {
        html += `
          <tr style="border-bottom:1px solid var(--br);">
            <td style="padding:8px;">${_esc(item.description)}</td>
            <td style="text-align:right;padding:8px;">${_esc(item.quantity)}</td>
            <td style="text-align:right;padding:8px;">${formatCurrency(item.unitPrice)}</td>
            <td style="text-align:right;padding:8px;font-weight:700;">${formatCurrency(item.total)}</td>
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>

          <div style="display:flex;justify-content:flex-end;margin-bottom:20px;">
            <div style="width:300px;">
              <div style="display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid var(--br);font-size:12px;">
                <span>Subtotal:</span>
                <span>${formatCurrency(inv.subtotal)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px;border-bottom:1px solid var(--br);font-size:12px;">
                <span>Tax (${((Number(inv.taxRate) || 0) * 100).toFixed(1)}%):</span>
                <span>${formatCurrency(inv.tax)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px;font-size:14px;font-weight:700;">
                <span>Total:</span>
                <span>${formatCurrency(inv.total)}</span>
              </div>
              ${(Number(inv.depositAmount) > 0 && Number(inv.depositAmount) < Number(inv.total)) ? `
              <div style="display:flex;justify-content:space-between;padding:8px;border-top:1px solid var(--br);font-size:12px;">
                <span>Deposit ${inv.depositPaid ? '(paid)' : 'due'}:</span>
                <span>${formatCurrency(inv.depositAmount)}</span>
              </div>
              <div style="display:flex;justify-content:space-between;padding:8px;font-size:13px;font-weight:700;color:var(--orange);">
                <span>Balance Due:</span>
                <span>${formatCurrency(inv.depositPaid ? inv.balanceDue : (Number(inv.total) - Number(inv.depositAmount)))}</span>
              </div>
              ` : ''}
              ${inv.depositRepNote ? `
              <div data-ip-deposit-note style="padding:8px;border-top:1px solid var(--br);font-size:11px;line-height:1.4;color:var(--orange);font-weight:600;">
                ${_esc(inv.depositRepNote)}
              </div>` : ''}
            </div>
          </div>

          <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;">
            <button type="button" class="btn btn-ghost" data-ip-action="print">Print Invoice</button>
            <button type="button" class="btn btn-orange" data-ip-action="sendInvoice" data-ip-id="${_escJs(invoiceId)}">Send to Customer</button>
            ${inv.status !== 'paid' ? `<button type="button" class="btn btn-green" data-ip-action="markPaid" data-ip-id="${_escJs(invoiceId)}">Mark Paid (Cash/Check)</button>` : ''}
            ${inv.stripePaymentLink ? `<button type="button" class="btn btn-ghost" data-ip-action="copyStripeLink" data-ip-id="${_escJs(inv.stripePaymentLink)}">Copy Payment Link</button>` : ''}
            ${(!inv.stripePaymentLink && inv.status !== 'paid' && inv.kyInsuranceHold) ? `<button type="button" class="btn btn-ghost" data-ip-action="createPayLink" data-ip-id="${_escJs(invoiceId)}">Create Payment Link</button>` : ''}
            ${(!inv.stripePaymentLink && inv.status !== 'paid' && inv.kyInsuranceHold && !inv.emergencyServices) ? `<button type="button" class="btn btn-ghost" data-ip-action="markEmergency" data-ip-id="${_escJs(invoiceId)}">Emergency tarp / repair invoice</button>` : ''}
          </div>
          ${(inv.kyInsuranceHold && !inv.stripePaymentLink && inv.status !== 'paid') ? `
          <div data-ip-ky-hold style="margin:-12px 0 20px;padding:8px;font-size:11px;line-height:1.4;color:var(--orange);font-weight:600;border:1px solid var(--br);border-radius:6px;">
            ${_esc(((typeof window !== 'undefined' && window.NBDJurisdiction) ? window.NBDJurisdiction.MSG.payLinkHeld : 'Online payment link withheld: Kentucky insurance job (KRS 367.626).'))}
            ${inv.emergencyServices ? ' This invoice is marked emergency work.' : ''}
          </div>` : ''}

          <div style="background:var(--s2);padding:12px;border-radius:5px;font-size:11px;color:var(--m);">
            <strong>Terms:</strong> ${_esc(inv.terms)}
          </div>
          ${inv.notes ? `<div style="background:var(--s2);padding:12px;border-radius:5px;font-size:11px;color:var(--m);margin-top:8px;"><strong>Notes:</strong> ${_esc(inv.notes)}</div>` : ''}
        </div>
      `;

      container.innerHTML = html;

    } catch (error) {
      console.error('renderInvoiceDetail error:', error);
      container.innerHTML = `<div style="color:var(--red);padding:12px;">Failed to load invoice</div>`;
    }
  }

  /**
   * Render invoice list (all invoices)
   */
  async function renderInvoiceList(containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const db = getDb();

    try {
      // v9 modular; requires createdBy+createdAt composite index
      const q = window.query(
        window.collection(db, 'invoices'),
        window.where('createdBy', '==', window._auth?.currentUser?.uid || 'system'),
        window.orderBy('createdAt', 'desc'),
        window.limit(50)
      );
      const snap = await window.getDocs(q);

      const invoices = snap.docs.map(d => ({ id: d.id, ...d.data() }));

      // Calculate total outstanding
      const totalOutstanding = invoices
        .filter(inv => inv.status !== 'paid')
        .reduce((sum, inv) => sum + (inv.balanceDue || 0), 0);

      let html = `
        <div class="invoice-list" style="padding:16px;">
          <div class="stat-card" style="margin-bottom:16px;">
            <div class="stat-icon si-o">💰</div>
            <div>
              <div class="stat-val" style="color:var(--orange);">${formatCurrency(totalOutstanding)}</div>
              <div class="stat-lbl">Total Outstanding</div>
            </div>
          </div>

          <div style="overflow-x:auto;">
            <table style="width:100%;border-collapse:collapse;">
              <thead>
                <tr style="border-bottom:2px solid var(--br);">
                  <th style="text-align:left;padding:10px;font-weight:700;font-size:11px;">INVOICE</th>
                  <th style="text-align:left;padding:10px;font-weight:700;font-size:11px;">CUSTOMER</th>
                  <th style="text-align:right;padding:10px;font-weight:700;font-size:11px;">AMOUNT</th>
                  <th style="text-align:right;padding:10px;font-weight:700;font-size:11px;">DUE DATE</th>
                  <th style="padding:10px;font-weight:700;font-size:11px;">STATUS</th>
                  <th style="padding:10px;font-weight:700;font-size:11px;">ACTION</th>
                </tr>
              </thead>
              <tbody>
      `;

      invoices.forEach(inv => {
        const dueDate = new Date(inv.dueDate?.toDate?.() || inv.dueDate);
        const isOverdue = dueDate < new Date() && inv.status !== 'paid';
        const statusBg = inv.status === 'paid' ? 'var(--green)' : isOverdue ? 'var(--red)' : 'var(--blue)';

        html += `
          <tr style="border-bottom:1px solid var(--br);">
            <td style="padding:10px;font-weight:700;font-size:12px;">${escHtml(inv.id.slice(0, 8))}</td>
            <td style="padding:10px;font-size:12px;">${escHtml(invoiceCustomerName(inv) || '—')}</td>
            <td style="text-align:right;padding:10px;font-size:12px;font-weight:700;">${formatCurrency(inv.total)}</td>
            <td style="text-align:right;padding:10px;font-size:12px;">${dueDate.toLocaleDateString()}</td>
            <td style="padding:10px;">
              <span style="background:${statusBg};color:#fff;padding:3px 8px;border-radius:3px;font-size:10px;font-weight:700;text-transform:uppercase;">${escHtml(inv.status)}</span>
            </td>
            <td style="padding:10px;">
              <button type="button" class="btn btn-ghost btn-sm" data-ip-action="renderDetail" data-ip-id="${inv.id}" data-ip-target="inv-detail-modal">View</button>
            </td>
          </tr>
        `;
      });

      html += `
              </tbody>
            </table>
          </div>
        </div>
      `;

      container.innerHTML = html;

    } catch (error) {
      console.error('renderInvoiceList error:', error);
      container.innerHTML = `<div style="color:var(--red);padding:12px;">Failed to load invoices</div>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UI HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build invoice HTML for email
   */
  function buildInvoiceHtml(invoice) {
    // Escape every interpolated user-controlled field — this builder
    // composes the EMAIL BODY sent to homeowners. PR #28 fixed
    // renderInvoiceDetail (the in-app preview) but missed this
    // builder, leaving an XSS sink that lands in the customer's
    // mail client where our CSP doesn't apply.
    const _esc = (s) => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    // For URL-bearing attributes (the Stripe link) reject anything
    // that doesn't look like an http(s) URL. javascript:/data: URIs
    // would otherwise execute when the customer clicks "Pay Online".
    const _safeUrl = (u) => {
      const s = String(u || '');
      return /^https?:\/\//i.test(s) ? s : '';
    };
    const items = (invoice.items || [])
      .map(item => `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee;">${_esc(item.description)}</td>
          <td style="text-align:right;padding:8px;border-bottom:1px solid #eee;">${_esc(item.quantity)}</td>
          <td style="text-align:right;padding:8px;border-bottom:1px solid #eee;">${formatCurrency(item.unitPrice)}</td>
          <td style="text-align:right;padding:8px;border-bottom:1px solid #eee;font-weight:700;">${formatCurrency(item.total)}</td>
        </tr>
      `)
      .join('');

    return `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8">
          <style>
            body { font-family: 'Lato','Segoe UI',Helvetica,Arial,sans-serif; color: #333; }
            .container { max-width: 600px; margin: 0 auto; padding: 20px; }
            .header { border-bottom: 3px solid #BD5728; padding-bottom: 15px; margin-bottom: 20px; }
            .brand { font-size: 20px; font-weight: 700; text-transform: uppercase; color: var(--orange,#BD5728); }
            table { width: 100%; border-collapse: collapse; margin: 20px 0; }
            .total { text-align: right; font-weight: 700; }
            .cta { background: var(--orange,#BD5728); color: #fff; padding: 12px 24px; border-radius: 5px; text-decoration: none; display: inline-block; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="brand">${_esc(_invoiceCompany())}</div>
              <p style="margin:5px 0 0 0;color:#999;">Your Invoice is Ready</p>
            </div>
            <p>Hello,</p>
            <p>Your roofing estimate has been converted to an invoice. Please review the details below.</p>
            <table>
              <thead>
                <tr style="border-bottom: 2px solid #BD5728;">
                  <th style="text-align: left; padding: 10px;">DESCRIPTION</th>
                  <th style="text-align: right; padding: 10px;">QTY</th>
                  <th style="text-align: right; padding: 10px;">PRICE</th>
                  <th style="text-align: right; padding: 10px;">TOTAL</th>
                </tr>
              </thead>
              <tbody>
                ${items}
                <tr style="border-top: 2px solid #BD5728;">
                  <td colspan="3" style="text-align: right; padding: 10px; font-weight: 700;">Total:</td>
                  <td style="text-align: right; padding: 10px; font-weight: 700; font-size: 16px;">${formatCurrency(invoice.total)}</td>
                </tr>
                <!-- Display-only fix, 2026-09-14: invoice.balanceDue is stored
                     as the full total until a REAL payment lands
                     (createInvoiceFromEstimate books it that way on purpose,
                     for correct AR -- see that function's comment). Before any
                     payment, balanceDue is never null, so this row used to
                     always print the raw stored balanceDue (equal to total)
                     directly under "Deposit due", reading as deposit + full
                     total owed. Once the deposit is actually paid, the stored
                     balanceDue correctly reflects total minus amountPaid and
                     is safe to show as-is. Stored AR semantics are unchanged;
                     only what's displayed here. -->
                ${(Number(invoice.depositAmount) > 0 && Number(invoice.depositAmount) < Number(invoice.total)) ? `
                <tr>
                  <td colspan="3" style="text-align: right; padding: 10px;">Deposit ${invoice.depositPaid ? '(paid)' : 'due'}:</td>
                  <td style="text-align: right; padding: 10px;">${formatCurrency(invoice.depositAmount)}</td>
                </tr>
                <tr>
                  <td colspan="3" style="text-align: right; padding: 10px; font-weight: 700; color:var(--orange,#BD5728);">Balance Due:</td>
                  <td style="text-align: right; padding: 10px; font-weight: 700; color:var(--orange,#BD5728);">${formatCurrency(invoice.depositPaid ? invoice.balanceDue : (Number(invoice.total) - Number(invoice.depositAmount)))}</td>
                </tr>
                ` : ''}
              </tbody>
            </table>
            <p><strong>Payment Terms:</strong> ${_esc(invoice.terms)}</p>
            ${_safeUrl(invoice.stripePaymentLink) ? `<a href="${_esc(_safeUrl(invoice.stripePaymentLink))}" class="cta">Pay Online</a>` : ''}
            <p style="margin-top: 30px; font-size: 12px; color: #999;">Thank you for choosing ${_esc(_invoiceCompany())}!</p>
          </div>
        </body>
      </html>
    `;
  }

  /**
   * UI: Create invoice from estimate dialog (modal instead of prompt for Safari compat)
   */
  async function createInvoiceUI(leadId) {
    // Build inline modal instead of using prompt()
    destroyExisting('nbd-invoice-modal');

    // Estimate source. This used to be a free-text "Estimate ID" box prefilled
    // from lead.estimateId — a key NO writer in this codebase ever stamps — so
    // it was always blank and the rep was expected to type a Firestore document
    // id from memory. Offer the lead's own estimates instead: leadId match, plus
    // a stamped primary that predates the leadId-attach fix (#1036).
    // customer-estimate-rows.js is loaded on customer.html but not everywhere
    // this pipeline runs, hence the guarded helper fallbacks — the two estimate
    // shapes (V2 name/grandTotal, Classic title/amount|total) must both read.
    const lead = (leadId && Array.isArray(window._leads))
      ? window._leads.find(l => l.id === leadId) : null;
    const estName = (window.NBDCustomerEstimateRows && window.NBDCustomerEstimateRows.estimateName)
      || (e => (e && (e.title || e.name || e.addr)) || 'Estimate');
    const estValue = (window.NBDCustomerEstimateRows && window.NBDCustomerEstimateRows.estimateValue)
      || (e => Number(e && (e.grandTotal != null ? e.grandTotal : e.total != null ? e.total : e.amount)) || 0);
    const leadEstimates = lead
      ? (window._estimates || []).filter(e => e && (e.leadId === lead.id || e.id === lead.primaryEstimateId))
      : [];
    // Estimate names come from lead-derived (public-intake) text — escape both
    // the option label and the value.
    const estOptions = leadEstimates.map(e => {
      const v = estValue(e);
      const label = estName(e) + (v ? ' — ' + formatCurrency(v) : '');
      const sel = (lead && lead.primaryEstimateId === e.id) ? ' selected' : '';
      return `<option value="${escHtml(e.id)}"${sel}>${escHtml(label)}</option>`;
    }).join('');

    const overlay = document.createElement('div');
    overlay.id = 'nbd-invoice-modal';
    overlay.className = 'modal-bg';
    overlay.innerHTML = `
      <div class="modal" style="max-width:420px;">
        <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;margin-bottom:16px;">Create Invoice from Estimate</div>
        <label style="font-size:10px;font-weight:600;color:var(--m);text-transform:uppercase;letter-spacing:.08em;">Estimate</label>
        ${leadEstimates.length ? `
        <select id="nbd-inv-est-pick" class="fi" style="margin-top:6px;">
          ${estOptions}
          <option value="__manual__">Other — enter an estimate ID…</option>
        </select>` : `
        <div style="font-size:12px;color:var(--m);margin-top:6px;line-height:1.45;">This customer has no estimates yet. Build one first (Template Quote or Estimates), then invoice from it — or paste an estimate ID below.</div>`}
        <input id="nbd-inv-est-id" type="text" class="fi" placeholder="Enter estimate ID..." style="margin-top:6px;"${leadEstimates.length ? ' hidden' : ''}>
        <div style="display:flex;gap:8px;margin-top:20px;">
          <button id="nbd-inv-cancel" type="button" class="btn btn-ghost" style="flex:1;justify-content:center;">Cancel</button>
          <button id="nbd-inv-create" type="button" class="btn btn-orange" style="flex:1;justify-content:center;">Create Invoice</button>
        </div>
      </div>
    `;

    let resolveP;
    const done = new Promise((resolve) => { resolveP = resolve; });
    const closeModal = openOverlay(overlay, () => resolveP());

    const input = overlay.querySelector('#nbd-inv-est-id');
    const picker = overlay.querySelector('#nbd-inv-est-pick');
    // Manual entry stays reachable even when the lead has estimates — an
    // estimate created in another tab won't be in the in-memory cache yet.
    if (picker) {
      picker.addEventListener('change', () => {
        const manual = picker.value === '__manual__';
        input.hidden = !manual;
        if (manual) input.focus();
      });
    }
    // The canonical .modal-bg fades in via a visibility transition, so a
    // synchronous focus() no-ops — retry after the first transition frame
    // (covers the legacy-page fallback; nbdModal does its own retry).
    const focusTarget = picker || input;
    setTimeout(() => { if (document.contains(focusTarget)) focusTarget.focus(); }, 80);

    overlay.querySelector('#nbd-inv-cancel').onclick = () => closeModal();
    overlay.querySelector('#nbd-inv-create').onclick = async () => {
      const picked = (picker && picker.value !== '__manual__') ? picker.value : '';
      const estimateId = picked || input.value.trim();
      if (!estimateId) { if (typeof showToast === 'function') showToast('Pick an estimate or enter an estimate ID', 'error'); return; }
      closeModal();
      try {
        showToast('Creating invoice...', 'info');
        const invoiceId = await createInvoiceFromEstimate(estimateId);

        // The invoice EXISTS from here on. Minting the payment link used to sit
        // inside this same try, so any link failure — a Stripe hiccup, a $0 line
        // item, the totals-reconcile guard, and now the platform-only refusal —
        // skipped both the success toast and the detail modal. The rep saw only
        // a red error over an invoice that had in fact been written, so he
        // clicked Create again and ended up with two invoices for one job.
        //
        // Report creation first, then attempt the link separately.
        showToast('Invoice created successfully', 'success');
        showInvoiceDetailModal(invoiceId);

        try {
          await generateStripePaymentLink(invoiceId);
        } catch (linkErr) {
          // Not a failure of the invoice. This is the expected path for a
          // tenant whose payouts aren't connected yet, so say what to do
          // instead of erroring.
          if (linkErr && linkErr.code === 'ONLINE_PAYMENTS_UNAVAILABLE') {
            showToast('Invoice ready — record check or cash under Mark Paid. '
              + 'To take card payments online, set up payouts under Settings → Billing.', 'info');
          } else if (linkErr && linkErr.code === 'KY_CANCELLATION_WINDOW') {
            showToast('Invoice ready. ' + linkErr.message, 'info');
          } else {
            console.warn('payment link failed:', linkErr && linkErr.message);
            showToast('Invoice created, but the online payment link could not be '
              + 'generated — you can still send it and use Mark Paid.', 'warning');
          }
        }
      } catch (error) {
        showToast(`Error: ${error.message}`, 'error');
      }
    };
    return done;
  }

  /**
   * Kentucky insurance invoices (2026-09-27): retry the online link (the
   * server decides whether the cancellation window has run), and mark an
   * invoice as emergency tarp / repair work, which KRS 367.626(3) leaves
   * billable before the window ends. The rep's attestation, recorded.
   */
  async function createPayLinkUI(invoiceId) {
    try {
      await generateStripePaymentLink(invoiceId);
      if (typeof showToast === 'function') showToast('Payment link created', 'success');
    } catch (e) {
      if (typeof showToast === 'function') showToast(String((e && e.message) || 'Payment link could not be created'), e && e.code === 'KY_CANCELLATION_WINDOW' ? 'info' : 'error');
    }
    try { showInvoiceDetailModal(invoiceId); } catch (_) { /* modal refresh is best-effort */ }
  }
  async function markEmergencyUI(invoiceId) {
    // nbdConfirm: a real modal in the installed PWA, where the native
    // confirm() is patched to answer YES (standalone-compat.js).
    const _ask = window.nbdConfirm
      || ((m) => Promise.resolve(typeof window.confirm === 'function' ? window.confirm(m) : false));
    const ok = await _ask('Mark this invoice as EMERGENCY tarp or repair work? Kentucky law (KRS 367.626(3)) allows billing emergency work at a reasonable charge before the cancellation window ends. Only do this if the whole invoice is emergency work.');
    if (!ok) return;
    await window.updateDoc(window.doc(getDb(), 'invoices', invoiceId), {
      emergencyServices: true, emergencyMarkedAt: new Date(), updatedAt: new Date()
    });
    await createPayLinkUI(invoiceId);
  }

  /**
   * UI: Send invoice dialog (modal instead of prompt for Safari compat)
   */
  async function sendInvoiceUI(invoiceId) {
    destroyExisting('nbd-send-invoice-modal');

    const overlay = document.createElement('div');
    overlay.id = 'nbd-send-invoice-modal';
    overlay.className = 'modal-bg';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px;">
        <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;margin-bottom:16px;">Send Invoice</div>
        <div style="font-size:12px;color:var(--m);margin-bottom:16px;">How would you like to send this invoice?</div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button type="button" class="nbd-send-method btn btn-ghost" data-method="email" style="width:100%;justify-content:flex-start;padding:14px;">📧 Send via Email</button>
          <button type="button" class="nbd-send-method btn btn-ghost" data-method="sms" style="width:100%;justify-content:flex-start;padding:14px;">💬 Send via SMS</button>
          <button type="button" class="nbd-send-method btn btn-ghost" data-method="portal" style="width:100%;justify-content:flex-start;padding:14px;">🌐 Share Customer Portal Link</button>
        </div>
        <button id="nbd-send-cancel" type="button" class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:12px;">Cancel</button>
      </div>
    `;

    let resolveP;
    const done = new Promise((resolve) => { resolveP = resolve; });
    const closeModal = openOverlay(overlay, () => resolveP());

    overlay.querySelector('#nbd-send-cancel').onclick = () => closeModal();
    overlay.querySelectorAll('.nbd-send-method').forEach(btn => {
      btn.onclick = async () => {
        const method = btn.dataset.method;
        closeModal();
        try {
          showToast(`Sending invoice via ${method}...`, 'info');
          const sent = await sendInvoice(invoiceId, method);
          if (sent && sent.queued) {
            // Stored in the offline outbox — nothing has reached the customer.
            showToast('You\'re offline — the invoice text is queued (see Pending texts). The invoice stays unsent until the text goes.', 'info');
          } else {
            showToast('Invoice sent successfully', 'success');
          }
        } catch (error) {
          showToast(`Error: ${error.message}`, 'error');
        }
      };
    });
    return done;
  }

  /**
   * Show a just-created (or selected) invoice in a reachable modal. The prior
   * post-create path rendered into '#invoice-panel', an element that doesn't
   * exist anywhere — so the created invoice and its Send / Copy-Link / Mark-Paid
   * buttons were unreachable from the dashboard. This mounts the detail view
   * (which carries those buttons) into a real overlay.
   */
  function showInvoiceDetailModal(invoiceId) {
    destroyExisting('nbd-invoice-detail-modal');
    const overlay = document.createElement('div');
    overlay.id = 'nbd-invoice-detail-modal';
    overlay.className = 'modal-bg';
    // Wide document view: top-aligned + scrollable, unlike the centered
    // default. Layout-only overrides — chrome/z-index come from .modal-bg.
    overlay.style.cssText = 'align-items:flex-start;overflow:auto;padding:24px;';
    overlay.innerHTML = `
      <div style="max-width:920px;width:100%;">
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px;">
          <button id="nbd-inv-detail-close" type="button" class="btn btn-ghost">✕ Close</button>
        </div>
        <div id="nbd-inv-detail-host"></div>
      </div>
    `;
    const closeModal = openOverlay(overlay);
    overlay.querySelector('#nbd-inv-detail-close').onclick = () => closeModal();
    renderInvoiceDetail('nbd-inv-detail-host', invoiceId);
  }

  /**
   * UI: record a manual (cash/check) payment. Wires the previously-dead
   * markPaid() to a modal so reps can record off-Stripe payments.
   */
  async function markPaidUI(invoiceId) {
    let balanceDefault = '';
    try {
      const snap = await window.getDoc(window.doc(getDb(), 'invoices', invoiceId));
      if (snap.exists()) {
        const d = snap.data();
        const bal = (d.balanceDue != null) ? d.balanceDue : d.total;
        if (Number.isFinite(Number(bal))) balanceDefault = String(Number(bal).toFixed(2));
      }
    } catch (_) { /* default to blank */ }

    destroyExisting('nbd-markpaid-modal');
    const overlay = document.createElement('div');
    overlay.id = 'nbd-markpaid-modal';
    overlay.className = 'modal-bg';
    // Stacks above the (also-open) invoice detail overlay.
    overlay.style.cssText = 'z-index:var(--z-overlay-top,10001);';
    overlay.innerHTML = `
      <div class="modal" style="max-width:380px;">
        <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:700;margin-bottom:16px;">Record Payment</div>
        <label style="font-size:10px;font-weight:600;color:var(--m);text-transform:uppercase;letter-spacing:.08em;">Amount</label>
        <input id="nbd-mp-amount" type="number" class="fi" autofocus step="0.01" min="0" value="${balanceDefault}" style="margin:6px 0 14px;">
        <div style="display:flex;gap:8px;">
          <button type="button" class="nbd-mp-method btn btn-ghost" data-method="cash" style="flex:1;justify-content:center;">💵 Cash</button>
          <button type="button" class="nbd-mp-method btn btn-ghost" data-method="check" style="flex:1;justify-content:center;">🧾 Check</button>
        </div>
        <button id="nbd-mp-cancel" type="button" class="btn btn-ghost" style="width:100%;justify-content:center;margin-top:12px;">Cancel</button>
      </div>
    `;
    const closeModal = openOverlay(overlay);

    // RESOLVE WHEN THE PAYMENT SETTLES, NOT WHEN THE MODAL OPENS.
    //
    // This used to return as soon as the overlay was in the DOM: the real
    // `await markPaid(...)` happens inside the button handler below, long
    // after. Every caller that did `await markPaidUI(id)` and then refreshed
    // was therefore refreshing against the UNPAID invoice, while the rep was
    // still typing the amount — and nothing refreshed afterwards, because the
    // only post-write repaint targets #nbd-inv-detail-host, which exists on
    // the dashboard and NOT on customer.html. The check landed in Firestore
    // and the row kept saying unpaid until a manual reload.
    //
    // Now the promise settles once, on whichever happens first:
    //   paid    → true   (after markPaid resolved — safe to repaint)
    //   cancel  → false  (dismissed, nothing written)
    // Fixed at this end rather than in each caller so both call sites — and
    // the dashboard's fire-and-forget dispatch, which simply ignores the
    // return — inherit the correct timing.
    return await new Promise((resolve) => {
      let settled = false;
      const settle = (paid) => { if (!settled) { settled = true; resolve(paid); } };

      overlay.querySelector('#nbd-mp-cancel').onclick = () => { closeModal(); settle(false); };
      // Dismissing by backdrop/Esc goes through openOverlay's own teardown, so
      // watch for removal too — otherwise an awaiting caller hangs forever.
      const mo = new MutationObserver(() => {
        if (!document.body.contains(overlay)) { mo.disconnect(); settle(false); }
      });
      mo.observe(document.body, { childList: true, subtree: true });

      overlay.querySelectorAll('.nbd-mp-method').forEach(btn => {
        btn.onclick = async () => {
          const amount = parseFloat(overlay.querySelector('#nbd-mp-amount').value);
          if (!Number.isFinite(amount) || amount <= 0) {
            if (typeof showToast === 'function') showToast('Enter a valid amount', 'error');
            return;                     // stay open; do NOT settle
          }
          const method = btn.dataset.method;
          closeModal();
          try {
            if (typeof showToast === 'function') showToast('Recording payment...', 'info');
            await markPaid(invoiceId, amount, method);
            if (typeof showToast === 'function') showToast('Payment recorded', 'success');
            if (document.getElementById('nbd-inv-detail-host')) renderInvoiceDetail('nbd-inv-detail-host', invoiceId);
            mo.disconnect();
            settle(true);
          } catch (error) {
            if (typeof showToast === 'function') showToast(`Error: ${error.message}`, 'error');
            mo.disconnect();
            settle(false);              // write failed — caller must not claim success
          }
        };
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPORTS
  // ═══════════════════════════════════════════════════════════════════════

  const _api = {
    createInvoiceFromEstimate,
    generateStripePaymentLink,
    sendInvoice,
    markPaid,
    markPaidUI,
    renderInvoicePanel,
    renderInvoiceDetail,
    renderInvoiceList,
    createInvoiceUI,
    sendInvoiceUI,
    showInvoiceDetailModal,
    createPayLinkUI,
    markEmergencyUI,
    // Pure helpers, exported for unit tests
    // (tests/invoice-pipeline.test.js) — no DOM/Firestore dependency.
    supplementBillableAmount,
    selectBillableSupplements,
    applySupplementsToTotals,
    buildRowItems,
    // Bill-To name resolution (estimate#9, 2026-09-25) — pure, unit-testable.
    resolveCustomerName,
    invoiceCustomerName,
    // buildInvoiceHtml takes a plain invoice object and formatCurrency is a
    // local pure function — no DOM/Firestore dependency either, exported the
    // same way for the deposit/balance display regression test.
    buildInvoiceHtml
  };

  if (typeof window !== 'undefined') {
    window.InvoicePipeline = _api;
  }
  // Node (unit tests) require() this file; expose the same API via CommonJS.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
  }

})();


// CSP-safe delegation for 7 data-ip-action attrs (invoice pipeline).
// Guarded for Node: unit tests require() this file where there is no DOM.
(function () {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  if (_NBD_IP_DELEGATE_BOUND) return;
  _NBD_IP_DELEGATE_BOUND = true;
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-ip-action]');
    if (!t) return;
    const action = t.dataset.ipAction;
    const id = t.dataset.ipId;
    const target = t.dataset.ipTarget;
    const IP = window.InvoicePipeline || {};
    try {
      switch (action) {
        case 'createInvoiceUI': if (typeof IP.createInvoiceUI === 'function') IP.createInvoiceUI(id); break;
        case 'renderDetail':    if (typeof IP.renderInvoiceDetail === 'function') IP.renderInvoiceDetail(target, id); break;
        case 'sendInvoice':     if (typeof IP.sendInvoiceUI === 'function') IP.sendInvoiceUI(id); break;
        case 'markPaid':        if (typeof IP.markPaidUI === 'function') IP.markPaidUI(id); break;
        case 'createPayLink':   if (typeof IP.createPayLinkUI === 'function') IP.createPayLinkUI(id); break;
        case 'markEmergency':   if (typeof IP.markEmergencyUI === 'function') IP.markEmergencyUI(id); break;
        case 'print':           window.print(); break;
        case 'copyStripeLink':  {
          if (id) navigator.clipboard.writeText(id);
          if (typeof showToast === 'function') showToast('Payment link copied!', 'ok');
          break;
        }
        default: console.warn('[invoice-pipeline] no dispatch for', action);
      }
    } catch (e) { console.error('[invoice-pipeline] dispatch ' + action + ' failed:', e); }
  });
})();
