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

  // nbd:owed-rule:start — ONE "is this invoice still owed?" rule, kept
  // byte-identical in collected-revenue.js, money-dashboard.js,
  // analytics-kpi.js and invoice-pipeline.js
  // (tests/invoice-owed-rule-2026-10-03.test.js). A voided Stripe mirror is
  // written { status:'void', balanceDue:0 }; drafts were never sent. Neither
  // is owed. Amount = balanceDue when present (0 means nothing due — the old
  // `balanceDue || total` read 0 as "missing" and re-counted the full face).
  var NOT_OWED_STATUS = { paid: 1, draft: 1, cancelled: 1, canceled: 1, void: 1, voided: 1, uncollectible: 1 };
  function isOwedInvoice(inv) {
    if (!inv || inv.deleted === true) return false;
    return !NOT_OWED_STATUS[String(inv.status || '').toLowerCase()];
  }
  function owedDollarsOf(inv) {
    if (!isOwedInvoice(inv)) return 0;
    var b = inv.balanceDue;
    var v = parseFloat((b != null && b !== '') ? b : inv.total);
    return v > 0 ? v : 0;
  }
  // nbd:owed-rule:end

  // The tenant's timezone for date rules (functions/stripe.js passes
  // KyLaw.resolveTimeZone(companyProfile) server-side — same here).
  function _tenantTz() {
    const J = window.NBDJurisdiction;
    if (!J || typeof J.resolveTimeZone !== 'function') return undefined;
    try { return J.resolveTimeZone(typeof window._legal === 'function' ? window._legal() : (window._companyProfile || {})); } catch (_) { return undefined; }
  }
  // THE overdue rule (ky-insurance-law.js invoiceOverdue). Without the module
  // nothing is called overdue rather than guessing with a second rule.
  function _overdueNow(inv, now) {
    const J = window.NBDJurisdiction;
    if (!J || typeof J.invoiceOverdue !== 'function') return false;
    const lead = inv && inv.leadId ? (window._leads || []).find((l) => l && l.id === inv.leadId) || null : null;
    return J.invoiceOverdue(inv, lead, now || new Date(), _tenantTz()).overdue;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITIES
  // ═══════════════════════════════════════════════════════════════════════

  // nbd:invoice-customer-name:start — byte-identical in
  // functions/invoice-from-estimate.js (the server's draft deposit invoice,
  // 2026-10-03), pinned by tests/deposit-draft-2026-10-03.test.js.
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
  // nbd:invoice-customer-name:end
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

  // The DRAFT deposit invoice the server makes when a contract is signed
  // (functions/deposit-draft.js, Jo 2026-10-03). Nothing sends it but the
  // rep's own Send tap; this chip says so wherever the invoice is shown.
  function isDepositDraft(inv) {
    return !!(inv && inv.status === 'draft' && inv.autoDraft && inv.autoDraft.kind === 'deposit_on_sign');
  }
  function depositDraftChipHtml(inv) {
    return isDepositDraft(inv) ? '<span class="ipx-draft-chip" data-deposit-draft>Draft deposit — review &amp; send</span>' : '';
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
    // A "Less deposit paid" credit line is negative: print "-$5,000.00",
    // not "$-5,000.00".
    if (Number.isFinite(n) && n < 0) return '-' + formatCurrency(-n);
    return '$' + (Number.isFinite(n) ? n : 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /**
   * The deposit / paid / balance rows under an invoice's Total — ONE source
   * for the in-app detail view and the emailed invoice. Pure; unit-tested.
   *
   * Pre-payment convention (2026-09-14): "Balance Due" is what is owed AFTER
   * the deposit (total − deposit), so Deposit due + Balance Due = total.
   * That identity now holds after every payment too: outstanding =
   * total − amountPaid; the unpaid part of the deposit shows as "Deposit
   * due"; Balance Due is the rest. Before this, a check SMALLER than the
   * deposit changed nothing on screen (Balance Due was total − deposit until
   * depositPaid flipped) and no row showed money received — a rep recorded
   * $3,000 and the invoice looked untouched. A no-deposit invoice with a
   * partial payment rendered no balance block at all.
   *
   * While both Deposit due and Balance Due are non-zero, a bold "Total owed"
   * row (their sum = total − amountPaid) follows and is the emphasised row
   * (2026-10-02). Footing sums must skip it — it repeats the two above.
   *
   * @returns {Array<{label:string, amount:number, strong?:boolean}>}
   */
  function paymentSummaryRows(inv) {
    const i = inv || {};
    const cents = (v) => Math.round((Number(v) || 0) * 100);
    const totalC = cents(i.total);
    const depC = cents(i.depositAmount);
    const paidC = Math.max(0, cents(i.amountPaid));
    const hasDep = depC > 0 && depC < totalC;
    const depMet = !!i.depositPaid || paidC >= depC;
    if (!hasDep && paidC === 0) return [];
    const outstandingC = paidC > 0 || i.depositPaid
      ? (i.balanceDue != null && Number.isFinite(Number(i.balanceDue)) ? cents(i.balanceDue) : Math.max(0, totalC - paidC))
      : totalC;
    const depLeftC = hasDep && !depMet ? depC - paidC : 0;
    const rows = [];
    if (hasDep) {
      rows.push(depMet
        ? { label: 'Deposit (paid)', amount: depC / 100 }
        : { label: paidC > 0 ? 'Deposit due (remaining)' : 'Deposit due', amount: depLeftC / 100 });
    }
    if (paidC > 0) rows.push({ label: 'Paid to date', amount: paidC / 100 });
    // While part of the deposit is still unpaid, what is owed is split across
    // two rows (Deposit due + Balance Due), and "Balance Due" alone read as
    // the whole debt: after a $4,000 Zelle on a $9,240 job it said $4,615
    // while $5,240 was owed. Jo, 2026-10-02: add a bold Total owed line. It
    // becomes the emphasised row; Balance Due keeps its meaning (the part due
    // after the deposit) as a plain row.
    const balC = Math.max(0, outstandingC - depLeftC);
    const split = depLeftC > 0 && balC > 0;
    rows.push({ label: 'Balance Due', amount: balC / 100, strong: !split });
    if (split) rows.push({ label: 'Total owed', amount: (depLeftC + balC) / 100, strong: true });
    return rows;
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
   * "From Stripe" chip + Open in Stripe / PDF links for an invoice the Stripe
   * ledger created (source:'stripe', functions/stripe-ledger-logic.js
   * mirrorInvoice). '' for every other invoice. Escaped, http(s) links only.
   * Kept local (this file loads without the ledger's UI rules).
   */
  function stripeSourceHtml(inv) {
    if (!inv || inv.source !== 'stripe') return '';
    const safe = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '').trim()) ? String(u).trim() : null);
    const hosted = safe(inv.stripeHostedUrl), pdf = safe(inv.stripePdfUrl);
    const num = inv.nbdInvoiceNumber || inv.stripeInvoiceNumber || '';
    const a = 'color:var(--blue,#3b82f6);font-size:11px;font-weight:700;text-decoration:none;white-space:nowrap;';
    return '<span class="ipx-tags">' +
      '<span class="ipx-stripe-chip">From Stripe</span>' +
      (num ? '<span class="ipx-m11">' + escHtml(num) + '</span>' : '') +
      (hosted ? '<a href="' + escHtml(hosted) + '" target="_blank" rel="noopener noreferrer" style="' + a + '">Open in Stripe ↗</a>' : '') +
      (pdf ? '<a href="' + escHtml(pdf) + '" target="_blank" rel="noopener noreferrer" style="' + a + '">PDF ↗</a>' : '') +
      '</span>';
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

  /**
   * The pay link a HOMEOWNER may be given for this invoice (2026-10-03):
   * ky-insurance-law.js payUrlUnlessHeld — stripePaymentLink OR
   * stripeHostedUrl (a Stripe Invoice; every surface read only the first),
   * and '' while the Kentucky insurance hold (KRS 367.626) applies.
   * FAIL CLOSED: no jurisdiction module, or an invoice that names a lead we
   * cannot read → ''. deps.readLead(leadId) → lead | null (tests inject it).
   */
  async function _homeownerPayUrl(invoice, deps) {
    const J = (deps && deps.J) || (typeof window !== 'undefined' ? window.NBDJurisdiction : null);
    if (!J || typeof J.payUrlUnlessHeld !== 'function' || typeof J.payUrlOf !== 'function') return '';
    if (!invoice || !J.payUrlOf(invoice)) return '';
    let lead = null;
    if (invoice.leadId) {
      try {
        const read = (deps && deps.readLead) || _readLeadForHold;
        lead = await read(String(invoice.leadId));
      } catch (_) { lead = null; }
      if (!lead) return '';
    }
    return J.payUrlUnlessHeld(lead, invoice, (deps && deps.now) || new Date(), _tenantTz());
  }
  // The Zelle line for a homeowner message (2026-10-04): the company's Zelle
  // pair, under the SAME Kentucky hold as the pay link — Zelle is a way to
  // pay too. Fails closed ('') without the jurisdiction module or the lead.
  async function _homeownerZelle(invoice, deps) {
    const z = (deps && typeof deps.zelle === 'string') ? deps.zelle : _zelleText();
    if (!z) return '';
    const J = (deps && deps.J) || (typeof window !== 'undefined' ? window.NBDJurisdiction : null);
    if (!J || typeof J.payLinkHold !== 'function') return '';
    let lead = null;
    if (invoice && invoice.leadId) {
      try {
        const read = (deps && deps.readLead) || _readLeadForHold;
        lead = await read(String(invoice.leadId));
      } catch (_) { lead = null; }
      if (!lead) return '';
    }
    return J.payLinkHold(lead, invoice || {}, (deps && deps.now) || new Date()).held ? '' : z;
  }
  /**
   * Every invoice on a lead this user may read — the customer page's scope
   * (customer-tasks-ui.js loadInvoices, mirroring the /invoices read rule):
   * company admin / manager / viewer / owner read the tenant's, everyone
   * else their own. Two equality filters, no composite index. Throws on a
   * failed read (the caller refuses to bill blind).
   */
  async function _loadLeadInvoices(db, leadId) {
    const uid = (window._auth && window._auth.currentUser && window._auth.currentUser.uid)
      || (window.auth && window.auth.currentUser && window.auth.currentUser.uid)
      || (window._user && window._user.uid) || '';
    // Signed out there is nothing to scope a read by — and nothing to bill
    // with either: the /invoices create rule refuses an unauthenticated write.
    if (!uid) return [];
    const claims = window._userClaims || {};
    const role = claims.role || '';
    const companyId = claims.companyId || null;
    const teamScope = !!(companyId && (role === 'company_admin' || role === 'manager' || role === 'viewer' || claims.owner === true));
    const ref = window.collection(db, 'invoices');
    const q = teamScope
      ? window.query(ref, window.where('leadId', '==', leadId), window.where('companyId', '==', companyId))
      : window.query(ref, window.where('leadId', '==', leadId), window.where('createdBy', '==', uid));
    const snap = await window.getDocs(q);
    return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  }
  /**
   * The customer's jobs (leads/{id}/jobs), for soleJobOf. null when it
   * cannot be read — the caller then treats the customer as multi-job (no
   * un-stamped paid invoice is credited), never a guess.
   */
  async function _loadLeadJobs(db, leadId) {
    try {
      if (!leadId || typeof window.getDocs !== 'function') return null;
      const snap = await window.getDocs(window.collection(db, 'leads', String(leadId), 'jobs'));
      return snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    } catch (e) { return null; }
  }

  /** The payment's timeline note (nbd:payment-timeline), at its stable doc id. */
  async function _writePaymentTimeline(db, invoiceId, leadId, entry) {
    const id = paymentTimelineNoteId(invoiceId, entry);
    if (!id || typeof window.setDoc !== 'function') return false;
    const uid = _currentUid();
    if (!uid) return false;
    await window.setDoc(window.doc(db, 'notes', id), {
      leadId: String(leadId),
      userId: uid,
      text: paymentTimelineText(invoiceId, entry),
      type: 'payment',
      source: 'payment',
      invoiceId: String(invoiceId),
      paymentId: paymentIdOf(entry),
      amount: Number(entry.amount) || 0,
      method: String(entry.method || ''),
      // The timeline sorts by createdAt: the day the money arrived.
      createdAt: entry.at instanceof Date ? entry.at : new Date(),
      loggedAt: new Date(),
      createdBy: uid,
    });
    return true;
  }

  async function _readLeadForHold(leadId) {
    const cached = (Array.isArray(window._leads) ? window._leads : []).find(l => l && l.id === leadId);
    if (cached) return cached;
    if (window._currentLead && window._customerId === leadId) return window._currentLead;
    const snap = await window.getDoc(window.doc(getDb(), 'leads', leadId));
    return snap.exists() ? Object.assign({ id: leadId }, snap.data() || {}) : null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MANUAL PAYMENTS — methods, cents math, ledger entry, proof (2026-09-29)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Jo (2026-09-29): "the only other payments would be checks I can attach and
  // upload to customers to be as easy and automated as possible", and the
  // receipt "either photo or pdf ... not required but definitely recommended".
  // Everything below is pure (no DOM / Firestore) and exported for
  // tests/mark-paid-methods-2026-09-29.test.js. payments[] keeps `amount` in
  // DOLLARS — collected-revenue.js / money-dashboard.js already sum it that
  // way — but every sum and comparison here runs in integer cents.

  // Order = button order in the Record Payment sheet (checks are most common).
  const PAYMENT_METHODS = [
    { key: 'check', label: 'Check', icon: '🧾', refLabel: 'Check #' },
    { key: 'zelle', label: 'Zelle', icon: '⚡', refLabel: 'Zelle confirmation #' },
    { key: 'cash',  label: 'Cash',  icon: '💵', refLabel: 'Receipt # (optional)' },
    // Card / ACH taken OUTSIDE Stripe (a terminal, the bank) — Stripe's own
    // payments are recorded by the webhook and the ledger, never by hand.
    { key: 'card',  label: 'Card (not Stripe)', icon: '💳', refLabel: 'Approval / last 4' },
    { key: 'ach',   label: 'ACH / bank (not Stripe)', icon: '🏦', refLabel: 'Transfer / trace #' },
    { key: 'other', label: 'Other', icon: '➕', refLabel: 'Reference' },
  ];
  // Who paid (2026-10-03): the homeowner, the insurance carrier's check, or
  // the mortgage company (a carrier check endorsed through the lender).
  const PAYERS = [
    { key: 'homeowner', label: 'Homeowner' },
    { key: 'insurance', label: 'Insurance carrier' },
    { key: 'mortgage',  label: 'Mortgage company' },
  ];
  function isPayer(p) { return PAYERS.some(x => x.key === p); }
  // A stable id per payment, so the timeline entry the server writes for it
  // (functions/payment-timeline.js) is written exactly once.
  function newPaymentId(nowMs) {
    return 'mp_' + (Number(nowMs) || Date.now()).toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }
  const PROOF_MAX_BYTES = 25 * 1024 * 1024;     // storage.rules payment-proofs/ cap
  const PAYMENT_REF_MAX = 80;
  const PAYMENT_NOTE_MAX = 500;
  const PROOF_NAME_MAX = 120;
  // Same string as functions/stripe-ledger-logic.js CATCHUP_BASIS.
  const PAYMENT_BASIS_CATCHUP = 'catchup_paid_in_full';

  function isManualPaymentMethod(m) {
    return PAYMENT_METHODS.some(x => x.key === m);
  }

  function paymentMethodLabel(m) {
    if (m === 'stripe') return 'Stripe';
    if (m === 'manual' || !m) return 'Manual';
    const hit = PAYMENT_METHODS.find(x => x.key === m);
    return hit ? hit.label : String(m);
  }

  // HTML-escape every user value that reaches innerHTML (& < > " ').
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Dollars (number or "$1,234.56" string) → integer cents, rounded half-up
  // on the DECIMAL digits, not on the binary float: 1.005 * 100 is
  // 100.49999999999999 in IEEE-754, so Math.round(x * 100) loses the cent.
  // Returns NaN for anything that is not a non-negative decimal.
  function toCents(v) {
    if (typeof v === 'number' && !Number.isFinite(v)) return NaN;
    let s = String(v == null ? '' : v).trim().replace(/[$,\s]/g, '');
    if (s === '' || s === '.') return NaN;
    const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m) return NaN;
    const whole = m[1] ? parseInt(m[1], 10) : 0;
    const frac = (m[2] || '');
    const first2 = parseInt((frac + '00').slice(0, 2), 10);
    const roundUp = frac.length > 2 && parseInt(frac[2], 10) >= 5 ? 1 : 0;
    const cents = whole * 100 + first2 + roundUp;
    return Number.isSafeInteger(cents) ? cents : NaN;
  }

  function centsToDollars(c) {
    return Math.round(Number(c) || 0) / 100;
  }

  function _tsMs(v) {
    if (v == null) return NaN;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : NaN;
  }

  // <input type="date"> value for a Date, in LOCAL time (toISOString is UTC
  // and turns 9pm Eastern into tomorrow).
  function localDateInputValue(d) {
    const x = d instanceof Date ? d : new Date();
    const p = (n) => String(n).padStart(2, '0');
    return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
  }

  // The date the money was RECEIVED, from the sheet's date field. Today → the
  // current instant; an earlier day → local noon that day (noon keeps the day
  // stable across a DST shift or a UTC reading). Future or garbage → null.
  function receivedAtFromDateInput(str, now) {
    now = now instanceof Date ? now : new Date();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || '').trim());
    if (!m) return null;
    const y = +m[1], mo = +m[2], d = +m[3];
    const day = new Date(y, mo - 1, d, 12, 0, 0, 0);
    if (day.getFullYear() !== y || day.getMonth() !== mo - 1 || day.getDate() !== d) return null;
    const today = localDateInputValue(now);
    if (str.trim() === today) return new Date(now.getTime());
    if (str.trim() > today) return null;               // no future-dated receipts
    return day;
  }

  function _cleanText(v, max) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
  }

  // Storage path for a payment's proof (check photo, Zelle screenshot, PDF).
  // Owner-keyed like receipts/: payment-proofs/{uid}/{invoiceId}/{ts}_{name}.
  function paymentProofPath(uid, invoiceId, ts, name) {
    const safeName = String(name || 'proof').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'proof';
    const safeInv = String(invoiceId || 'invoice').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'invoice';
    return `payment-proofs/${uid}/${safeInv}/${Number(ts) || 0}_${safeName}`;
  }

  // Photo (any image/*) or PDF, at most 25MB. Optional — a missing file is ok.
  function proofFileCheck(file) {
    if (!file) return { ok: true, none: true };
    const t = String(file.type || '');
    if (!(/^image\//.test(t) || t === 'application/pdf')) return { ok: false, reason: 'Proof must be a photo or PDF' };
    if (!(Number(file.size) <= PROOF_MAX_BYTES)) return { ok: false, reason: 'Proof is over the 25MB limit' };
    return { ok: true };
  }

  // One payments[] entry for a manual payment. Throws on a bad method or a
  // non-positive amount; optional fields are OMITTED when empty (Firestore
  // rejects `undefined`, and an empty key is noise in the ledger).
  function buildManualPaymentEntry(input) {
    input = input || {};
    const method = input.method;
    if (!isManualPaymentMethod(method)) throw new Error('Pick a payment method');
    const cents = toCents(input.amount);
    if (!Number.isFinite(cents) || cents <= 0) throw new Error('Invalid payment amount');
    const at = input.at instanceof Date ? input.at : null;
    if (!at || !Number.isFinite(at.getTime())) throw new Error('Invalid payment date');
    const recordedAt = input.recordedAt instanceof Date ? input.recordedAt : new Date();
    const entry = {
      amount: centsToDollars(cents),
      at,
      method,
      recordedBy: String(input.recordedBy || ''),
      recordedAt,
      paymentId: (typeof input.paymentId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(input.paymentId))
        ? input.paymentId : newPaymentId(recordedAt.getTime()),
    };
    if (isPayer(input.payer)) entry.payer = input.payer;
    // "Catch up my numbers" → "Paid in full? Yes" (catchup.js): a balancing
    // entry for the whole job total, not one itemised payment. The Stripe
    // ledger replaces part of it when a real Stripe payment for the job turns
    // up later, instead of counting both (R6-2-8,
    // functions/stripe-ledger-logic.js planCatchUpAbsorb). Only this value.
    if (input.basis === PAYMENT_BASIS_CATCHUP) entry.basis = PAYMENT_BASIS_CATCHUP;
    const reference = _cleanText(input.reference, PAYMENT_REF_MAX);
    const note = _cleanText(input.note, PAYMENT_NOTE_MAX);
    if (reference) entry.reference = reference;
    if (note) entry.note = note;
    if (input.proofStoragePath) {
      entry.proofStoragePath = String(input.proofStoragePath);
      entry.proofName = _cleanText(input.proofName, PROOF_NAME_MAX) || 'proof';
    }
    // A receipt DRAFT for this payment (Jo, 2026-10-04): never emailed on its
    // own — the rep taps "Send receipt" (sendReceipt below).
    entry.receipt = { status: 'draft' };
    return entry;
  }

  // The invoice patch for one more payment. Cumulative ledger, in cents:
  // balanceDue = total − amountPaid, clamped at 0 — an overpayment is
  // RECORDED (the money came in) and simply leaves nothing due, exactly as
  // markPaid has always behaved. lastPaymentAt never moves backwards when a
  // rep logs an older check after a newer payment.
  function applyPaymentToInvoice(invoice, entry) {
    invoice = invoice || {};
    const totalC = toCents(Math.max(0, Number(invoice.total) || 0));
    const priorPaidC = toCents(Math.max(0, Number(invoice.amountPaid) || 0));
    const amtC = toCents(entry.amount);
    const newPaidC = (priorPaidC || 0) + amtC;
    const newBalanceC = Math.max(0, (totalC || 0) - newPaidC);
    const newPaid = centsToDollars(newPaidC);
    const newBalanceDue = centsToDollars(newBalanceC);
    const depositC = toCents(Math.max(0, Number(invoice.depositAmount) || 0)) || 0;
    const priorLastMs = _tsMs(invoice.lastPaymentAt);
    const paidAtNow = (Number.isFinite(priorLastMs) && priorLastMs > entry.at.getTime())
      ? invoice.lastPaymentAt : entry.at;
    const priorPayments = Array.isArray(invoice.payments) ? invoice.payments.slice() : [];
    priorPayments.push(entry);
    return {
      newBalanceDue,
      patch: {
        amountPaid: newPaid,
        depositPaid: newPaidC >= depositC,
        balanceDue: newBalanceDue,
        // A part payment makes the invoice 'partial' — the same status the
        // Stripe ledger writes (functions/stripe-ledger-logic.js). It used to
        // keep the old one, so a $4,000 check on a draft still read DRAFT.
        // Every AR reader keys on status !== 'paid', and a re-send restores
        // any non-draft status, so 'partial' stays in AR and survives a send.
        status: newBalanceC === 0 ? 'paid' : (newPaidC > 0 ? 'partial' : (invoice.status == null ? 'sent' : invoice.status)),
        paidAt: newBalanceC === 0 ? entry.at : (invoice.paidAt == null ? null : invoice.paidAt),
        lastPaymentAt: paidAtNow,
        payments: priorPayments,
      },
    };
  }

  // Which payments[] entry a rep tapped "Attach proof" on. The index is the
  // fast path, but the array can shift under us (another device logged a
  // payment), so the entry must still MATCH the key captured at render time:
  // recordedAt when present, else at + amount + method.
  function paymentKey(p) {
    p = p || {};
    return {
      recordedAtMs: _tsMs(p.recordedAt),
      atMs: _tsMs(p.at != null ? p.at : p.date),
      cents: toCents(Number(p.amount) || 0),
      method: p.method || '',
    };
  }
  function _keyMatches(p, key) {
    const k = paymentKey(p);
    if (Number.isFinite(key.recordedAtMs)) return k.recordedAtMs === key.recordedAtMs;
    return !Number.isFinite(k.recordedAtMs) && k.atMs === key.atMs && k.cents === key.cents && k.method === key.method;
  }
  function findPaymentIndex(payments, index, key) {
    if (!Array.isArray(payments) || !key) return -1;
    if (Number.isInteger(index) && index >= 0 && index < payments.length && _keyMatches(payments[index], key)) return index;
    return payments.findIndex(p => _keyMatches(p, key));
  }
  // New payments[] with the proof set on the matched entry. Refuses Stripe
  // entries (Stripe is its own receipt) and entries that already carry proof.
  function attachProofToPayments(payments, index, key, proof) {
    const i = findPaymentIndex(payments, index, key);
    if (i < 0) throw new Error('That payment changed — reopen the invoice and try again');
    const cur = payments[i] || {};
    if (cur.method === 'stripe') throw new Error('Stripe payments carry their own receipt');
    if (cur.proofStoragePath) throw new Error('That payment already has proof attached');
    if (!proof || !proof.proofStoragePath) throw new Error('No proof to attach');
    const next = payments.slice();
    next[i] = Object.assign({}, cur, {
      proofStoragePath: String(proof.proofStoragePath),
      proofName: _cleanText(proof.proofName, PROOF_NAME_MAX) || 'proof',
    });
    return next;
  }

  // Display rows for the invoice's payment history (newest first). Pure.
  function paymentHistoryRows(inv) {
    const list = (inv && Array.isArray(inv.payments)) ? inv.payments : [];
    return list.map((p, index) => {
      p = p || {};
      const k = paymentKey(p);
      const isStripe = p.method === 'stripe';
      return {
        index,
        atMs: k.atMs,
        amount: Number(p.amount) || 0,
        method: p.method || 'manual',
        methodLabel: paymentMethodLabel(p.method),
        reference: p.reference ? String(p.reference) : '',
        note: p.note ? String(p.note) : '',
        proofStoragePath: p.proofStoragePath ? String(p.proofStoragePath) : '',
        proofName: p.proofName ? String(p.proofName) : '',
        isStripe,
        canAttach: !isStripe && !p.proofStoragePath,
        keyRecordedAtMs: k.recordedAtMs,
      };
    }).filter(r => r.amount > 0)
      .sort((a, b) => (Number.isFinite(b.atMs) ? b.atMs : 0) - (Number.isFinite(a.atMs) ? a.atMs : 0));
  }

  // The payment-history block for the invoice detail view. Every user value
  // goes through escHtml; data-* carry only numbers/ids.
  function paymentHistoryHtml(invoiceId, inv) {
    const rows = paymentHistoryRows(inv);
    if (!rows.length) return '';
    const id = escHtml(invoiceId);
    const body = rows.map(r => {
      const date = Number.isFinite(r.atMs) ? new Date(r.atMs).toLocaleDateString() : '—';
      const ref = r.reference ? ` · #${escHtml(r.reference)}` : '';
      const note = r.note ? `<div class="ipx-m11 ipx-mt2">${escHtml(r.note)}</div>` : '';
      let proof = '';
      if (r.proofStoragePath) {
        proof = `<button type="button" class="btn btn-ghost ipx-btn40" data-ip-action="viewProof" data-ip-id="${id}" data-ip-idx="${r.index}" title="${escHtml(r.proofName || 'Proof')}">📎 View</button>`;
      } else if (r.canAttach) {
        proof = `<button type="button" class="btn btn-ghost ipx-btn40" data-ip-action="attachProof" data-ip-id="${id}" data-ip-idx="${r.index}"${Number.isFinite(r.keyRecordedAtMs) ? ` data-ip-rec="${r.keyRecordedAtMs}"` : ''}>📎 Attach proof</button>`;
      }
      // The receipt draft for this payment: one tap sends it (2026-10-04).
      const p = (inv.payments || [])[r.index];
      const rs = receiptStateOf(p);
      const rkey = receiptKeyOf(p, r.index);
      const receipt = rs === 'draft'
        ? `<button type="button" class="btn btn-ghost ipx-btn40" data-ip-action="sendReceipt" data-ip-id="${id}" data-ip-pay="${escHtml(rkey)}" data-send-receipt>✉️ Send receipt</button>`
        : (rs === 'sent' ? '<span class="ipx-m11" data-receipt-sent>Receipt sent ✓</span>' : '');
      return `
        <div data-ip-payment-row class="ipx-pay-row">
          <div class="ipx-minw0">
            <div><strong>${escHtml(date)}</strong> · ${escHtml(r.methodLabel)}${ref}</div>
            ${note}
          </div>
          <div class="ipx-row-fixed">
            <span class="ipx-b">${escHtml(formatCurrency(r.amount))}</span>
            ${proof}
            ${receipt}
          </div>
        </div>`;
    }).join('');
    return `
      <div data-ip-payment-history class="ipx-mb20">
        <div class="ipx-k">Payment History</div>
        ${body}
      </div>`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RECEIPTS — drafted on every payment, sent only by a tap (Jo, 2026-10-04)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Marking a payment paid NEVER emails the customer, from any caller
  // (markPaid, Record payment, the Stripe webhook). Each payment carries a
  // receipt DRAFT (payments[i].receipt.status 'draft' — entries the Stripe
  // webhook / ledger wrote have no receipt field and read as a draft too).
  // "Send receipt" on the customer page's invoice row, the payment's
  // timeline line and the invoice detail sends it once through
  // NBDComms.sendEmail with leadId + invoiceId (the #2120 recipient binding:
  // `to` must be an email on that invoice / lead), or the share sheet when
  // there is no email on file. The receipt names the NBD invoice number,
  // never the internal doc id.

  /** 'draft' | 'sent' | 'none' (no money: nothing to receipt). */
  function receiptStateOf(p) {
    if (!p || !(Number(p.amount) > 0)) return 'none';
    if (p.achStatus === 'failed' || p.reverted === true) return 'none';
    const r = (p.receipt && typeof p.receipt === 'object') ? p.receipt : null;
    return (r && r.status === 'sent') ? 'sent' : 'draft';
  }

  /** The key a button carries for a payment: its own id, else 'idx:N'. */
  function receiptKeyOf(p, index) {
    const pid = paymentIdOf(p);
    return pid || ('idx:' + index);
  }

  /** Index of the payment a receipt key names, or -1. */
  function findReceiptPayment(payments, key) {
    const list = Array.isArray(payments) ? payments : [];
    const k = String(key || '');
    if (!k) return -1;
    if (k.indexOf('idx:') === 0) {
      const i = parseInt(k.slice(4), 10);
      return (Number.isInteger(i) && i >= 0 && i < list.length && !paymentIdOf(list[i])) ? i : -1;
    }
    return list.findIndex(p => paymentIdOf(p) === k);
  }

  /**
   * The customer-facing invoice number: invoiceNumber, else the filed
   * NBD-500's number, else the Stripe invoice number. '' when there is none
   * — NEVER the Firestore doc id.
   */
  function nbdInvoiceNumberOf(inv) {
    inv = inv || {};
    const pp = (inv.paper && typeof inv.paper === 'object') ? inv.paper : {};
    const filed = pp.invoice && pp.invoice.instanceId;
    return String(inv.invoiceNumber || filed || inv.stripeInvoiceNumber || '').trim();
  }

  const RECEIPT_METHOD_LABELS = {
    check: 'Check', zelle: 'Zelle', cash: 'Cash', card: 'Card', ach: 'Bank transfer (ACH)', other: 'Other',
    stripe: 'Card (online)', us_bank_account: 'Bank transfer (ACH)', apple_pay: 'Apple Pay', google_pay: 'Google Pay',
    link: 'Link (online)', cashapp: 'Cash App', manual: 'Payment',
  };

  /**
   * Everything a receipt says about one payment. Pure.
   * → null, or { key, index, amount, method, dateText, balanceRemaining,
   *   invoiceNumber, paidInFull, pdfPath, pdfName, reference }
   * balanceRemaining is what was still owed right after THIS payment
   * (total − every payment up to and including it, in cents).
   */
  function receiptDetailsOf(inv, key) {
    inv = inv || {};
    const list = Array.isArray(inv.payments) ? inv.payments : [];
    const i = findReceiptPayment(list, key);
    if (i < 0) return null;
    const p = list[i] || {};
    if (receiptStateOf(p) === 'none') return null;
    const totalC = toCents(Math.max(0, Number(inv.total) || 0)) || 0;
    let paidC = 0;
    for (let j = 0; j <= i; j++) {
      const a = list[j];
      if (a && Number(a.amount) > 0) paidC += toCents(Number(a.amount)) || 0;
    }
    const balC = Math.max(0, totalC - paidC);
    const atMs = _tsMs(p.at != null ? p.at : p.date);
    const pp = (inv.paper && typeof inv.paper === 'object') ? inv.paper : {};
    // The filed NBD-510 (money-paper.js) is the paid-in-full receipt: it
    // belongs to the payment that closed the invoice out.
    const isLast = i === list.length - 1;
    const filed = pp.receipt && pp.receipt.state === 'filed' && pp.receipt.pdfPath ? pp.receipt : null;
    return {
      key: receiptKeyOf(p, i),
      index: i,
      amount: centsToDollars(toCents(Number(p.amount)) || 0),
      method: RECEIPT_METHOD_LABELS[p.method] || paymentMethodLabel(p.method),
      dateText: Number.isFinite(atMs)
        ? new Date(atMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : '',
      balanceRemaining: centsToDollars(balC),
      invoiceNumber: nbdInvoiceNumberOf(inv),
      paidInFull: balC === 0 && totalC > 0,
      pdfPath: (filed && isLast && balC === 0) ? String(filed.pdfPath) : '',
      pdfName: (filed && filed.instanceId) ? 'Receipt ' + filed.instanceId + '.pdf' : 'Receipt.pdf',
      reference: p.reference ? String(p.reference).slice(0, 40) : '',
    };
  }

  /** Subject + HTML + plain text for one payment's receipt. Pure; escaped. */
  function buildReceiptEmail(details, company) {
    const d = details || {};
    const co = String(company || 'NBD Roofing');
    const num = d.invoiceNumber ? 'Invoice ' + d.invoiceNumber : 'your invoice';
    const rows = [
      ['Invoice', d.invoiceNumber || '—'],
      ['Amount paid', formatCurrency(d.amount)],
      ['Method', d.method + (d.reference ? ' #' + d.reference : '')],
      ['Date', d.dateText || '—'],
      ['Balance remaining', d.paidInFull ? '$0.00 — paid in full' : formatCurrency(d.balanceRemaining)],
    ];
    const subject = 'Payment received — ' + co + (d.invoiceNumber ? ' Invoice ' + d.invoiceNumber : '');
    // A <style> block, not inline attributes (the reskin ratchet); the
    // server's sanitizer keeps <style>.
    const html = '<style>.rc{font-family:Lato,"Segoe UI",Helvetica,Arial,sans-serif;color:#333;max-width:560px}'
      + '.rc table{border-collapse:collapse;width:100%}.rc td{padding:6px 8px;border-bottom:1px solid #eee}'
      + '.rc td.k{color:#666}.rc td.v{text-align:right;font-weight:700}.rc .co{color:#999;font-size:12px}</style>'
      + '<div class="rc">'
      + '<p>Thank you — we received your payment of <strong>' + escHtml(formatCurrency(d.amount)) + '</strong> on ' + escHtml(num) + '.</p>'
      + '<table>'
      + rows.map(r => '<tr><td class="k">' + escHtml(r[0]) + '</td><td class="v">' + escHtml(r[1]) + '</td></tr>').join('')
      + '</table>'
      + '<p>Keep this email for your records. Questions? Just reply.</p>'
      + '<p class="co">' + escHtml(co) + '</p></div>';
    const text = 'Thank you — we received your payment of ' + formatCurrency(d.amount) + ' on ' + num + '.\n'
      + rows.map(r => r[0] + ': ' + r[1]).join('\n') + '\n\n' + co;
    return { subject, html, text };
  }

  /** New payments[] with this payment's receipt marked sent. Pure. */
  function markReceiptSent(payments, key, via, at) {
    const list = Array.isArray(payments) ? payments.slice() : [];
    const i = findReceiptPayment(list, key);
    if (i < 0) throw new Error('That payment changed — reopen the invoice and try again');
    list[i] = Object.assign({}, list[i], { receipt: { status: 'sent', sentAt: at instanceof Date ? at : new Date(), via: String(via || 'email') } });
    return list;
  }

  async function _receiptPdfFile(details) {
    try {
      if (!details || !details.pdfPath || !window.getDownloadURL || !window.ref || typeof fetch !== 'function') return null;
      const url = await window.getDownloadURL(window.ref(window.storage, details.pdfPath));
      const blob = await (await fetch(url)).blob();
      return (typeof File === 'function') ? new File([blob], details.pdfName, { type: 'application/pdf' }) : null;
    } catch (_) { return null; }
  }

  /**
   * Send ONE payment's receipt — the "Send receipt" tap. Email when the
   * invoice has a customer email (NBDComms.sendEmail, leadId + invoiceId,
   * kind 'receipt'); else the share sheet (with the filed NBD-510 PDF when
   * there is one and the phone can share files). Then marks it sent on the
   * payment and on its timeline line.
   * → { sent: true, via } | { sent: false, reason }
   */
  async function sendReceipt(invoiceId, key) {
    const db = getDb();
    const invRef = window.doc(db, 'invoices', invoiceId);
    const snap = await window.getDoc(invRef);
    if (!snap.exists()) throw new Error('Invoice not found');
    const inv = snap.data() || {};
    const i = findReceiptPayment(inv.payments, key);
    if (i < 0) throw new Error('That payment changed — reopen the invoice and try again');
    if (receiptStateOf(inv.payments[i]) === 'sent') return { sent: false, reason: 'already_sent' };
    const details = receiptDetailsOf(inv, key);
    if (!details) return { sent: false, reason: 'nothing_to_receipt' };
    const mail = buildReceiptEmail(details, _invoiceCompany());
    let via = '';
    if (inv.customerEmail && window.NBDComms && typeof window.NBDComms.sendEmail === 'function') {
      const r = await window.NBDComms.sendEmail({
        to: inv.customerEmail,
        subject: mail.subject,
        html: mail.html,
        leadId: inv.leadId || null,
        invoiceId: invoiceId, // #2120: `to` must be on this invoice / lead
        kind: 'receipt',      // transactional: payment confirmation
      });
      if (!r || r.success === false) return { sent: false, reason: (r && (r.error || r.message)) || 'email_failed' };
      via = r.mode === 'mailto' ? 'mailto' : 'email';
    } else if (typeof navigator !== 'undefined' && navigator && typeof navigator.share === 'function') {
      const data = { title: mail.subject, text: mail.text };
      const file = await _receiptPdfFile(details);
      if (file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) data.files = [file];
      try { await navigator.share(data); }
      catch (e) { return { sent: false, reason: (e && e.name === 'AbortError') ? 'cancelled' : 'share_failed' }; }
      via = 'share';
    } else {
      return { sent: false, reason: 'no_email' };
    }
    // Mark it sent on the payment (re-read: the array can move under us).
    try {
      const fresh = await window.getDoc(invRef);
      const next = markReceiptSent((fresh.data() || {}).payments || [], key, via, new Date());
      await window.updateDoc(invRef, { payments: next, updatedAt: new Date() });
    } catch (e) { console.warn('sendReceipt: could not mark the receipt sent', e && (e.code || e.message)); }
    const noteId = paymentTimelineNoteId(invoiceId, inv.payments[i]);
    if (noteId && typeof window.updateDoc === 'function') {
      try { await window.updateDoc(window.doc(db, 'notes', noteId), { receiptSentAt: new Date() }); }
      catch (_) { /* the timeline line may not exist (legacy payment) */ }
    }
    return { sent: true, via };
  }

  /** UI: the one-tap "Send receipt" (no confirm sheet — the tap IS the send). */
  async function sendReceiptUI(invoiceId, key) {
    try {
      const r = await sendReceipt(invoiceId, key);
      if (r.sent) {
        if (r.via === 'share') _toast('Receipt shared', 'success');
        if (document.getElementById('nbd-inv-detail-host')) renderInvoiceDetail('nbd-inv-detail-host', invoiceId);
        return true;
      }
      const why = {
        already_sent: 'That receipt was already sent.',
        nothing_to_receipt: 'Nothing to send for that payment.',
        no_email: 'No email on this invoice — add one to the customer, then tap Send receipt.',
        cancelled: 'Receipt not sent.',
      }[r.reason];
      _toast(why || ('Receipt not sent: ' + r.reason), r.reason === 'cancelled' ? 'info' : 'error');
      return false;
    } catch (e) {
      _toast('Error: ' + ((e && e.message) || 'could not send the receipt'), 'error');
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BANK PAYMENT (ACH) + ZELLE lines on the pay surfaces (2026-10-04)
  // ═══════════════════════════════════════════════════════════════════════
  const PAY_BY_BANK_LINE = 'Pay by bank (ACH) — lower fees. Choose "US bank account" on the payment page.';

  // Where a Zelle payment goes: the company's Zelle pair (company-profile.js
  // brand.contact.zellePhone / zelleEmail; NBD: "(859) 420-7382 or jd@…",
  // never the info@ documents address). '' for a tenant that set none.
  // NBD's pair needs an NBD brand AND the NBD platform tenant's companyId
  // (company-profile.js _isNbdPlatformTenant; server twin
  // functions/zelle-contact.js) — a tenant that never set legalName looks
  // like NBD by brand and must not print Jo's Zelle. `isPlatform` overrides
  // the identity check (tests / callers that already know the tenant).
  function _platformTenant() {
    try {
      return typeof window !== 'undefined' && typeof window._isNbdPlatformTenant === 'function'
        && window._isNbdPlatformTenant() === true;
    } catch (_) { return false; }
  }
  function zelleTextFor(brand, isPlatform) {
    const b = brand || null;
    const c = (b && b.contact) || {};
    const platform = (typeof isPlatform === 'boolean') ? isPlatform : _platformTenant();
    const nbdLooking = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    // An NBD-looking brand carries NBD's deep-merged defaults (company-profile
    // _resolveBrand), so from any other identity it gets no Zelle line at all.
    if (nbdLooking && !platform) return '';
    const isNbd = nbdLooking;
    const email = String(c.zelleEmail || (isNbd ? 'jd@nobigdealwithjoedeal.com' : '')).trim();
    const phone = String(c.zellePhone || (isNbd ? '(859) 420-7382' : '')).trim();
    return phone && email ? phone + ' or ' + email : (phone || email);
  }
  function _zelleText() {
    let b = null;
    try { if (typeof window._brand === 'function') b = window._brand() || null; } catch (e) { b = null; }
    return zelleTextFor(b);
  }

  /** "Bank payment processing" for an invoice with an ACH in flight, or ''. */
  function achPendingText(inv) {
    const p = inv && inv.achPending;
    if (!p || typeof p !== 'object' || !(Number(p.amountCents) > 0)) return '';
    return 'Bank payment (ACH) of ' + formatCurrency(Number(p.amountCents) / 100)
      + ' processing — not counted as paid until it clears (4–5 business days).';
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
  // nbd:invoice-from-estimate:start — how an estimate becomes invoice lines
  // and totals. Byte-identical in functions/invoice-from-estimate.js, which
  // the server's draft deposit invoice (functions/deposit-draft.js,
  // 2026-10-03) builds from, so a server draft and a rep-made invoice for the
  // same estimate carry the same lines and the same total.
  // tests/deposit-draft-2026-10-03.test.js pins the two copies.
  function numFrom(v) {
    if (typeof v === 'number') return v;
    const m = String(v == null ? '' : v).match(/-?\d[\d,]*\.?\d*/);
    return m ? parseFloat(m[0].replace(/,/g, '')) : NaN;
  }

  /**
   * The ONE rounding rule's home (2026-10-07, ho-money audit H5):
   * NBDCustomerEstimateRows.footingRows — the function the estimate link and
   * the e-sign contract print their Sales tax / Rounding rows with. The
   * browser has it on window (dashboard.html and customer.html load
   * customer-estimate-rows.js before this file); the server and the unit
   * tests require() the copy beside this file (functions/ and docs/pro/js/
   * each carry one). null only if neither loaded — then the invoice keeps
   * the subtotal-based measure it used before.
   */
  function _footingApi() {
    try {
      if (typeof window !== 'undefined' && window.NBDCustomerEstimateRows
          && typeof window.NBDCustomerEstimateRows.footingRows === 'function') return window.NBDCustomerEstimateRows;
    } catch (_) { /* fall through */ }
    try {
      if (typeof require === 'function') {
        const m = require('./customer-estimate-rows');
        if (m && typeof m.footingRows === 'function') return m;
      }
    } catch (_) { /* fall through */ }
    return null;
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
    // A non-empty rows wins (it is what the contract and estimate link
    // print); an empty rows array falls through to lineItems.
    // lineItems name their fields quantity / unitPrice / amount (a logged
    // estimate saved from doc pre-flight, legacy docs). Reading only the rows
    // names (qty / rate / total) priced every such line at $0, and the pay
    // link was refused (review R6-2-1, 2026-10-07). Sales tax / Rounding
    // footing rows are never lines here: tax and the adjustment come below.
    const useRows = !!est && Array.isArray(est.rows) && est.rows.length > 0;
    const src = useRows ? est.rows : ((est && Array.isArray(est.lineItems)) ? est.lineItems : []);
    const items = src.filter(function (row) {
      return !!row && (useRows || (row.code !== 'TAX' && row.code !== 'ADJ'));
    }).map(function (row) {
      const quantity = numFrom(row.qty != null ? row.qty : row.quantity);
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
        lineTotal = numFrom(row.total != null ? row.total : row.amount);
      }
      if (explicitRetail != null || hasSplit) {
        // Retail-priced row: derive the unit price from the retail total (the
        // saved rate string on old docs is the COST rate — never print it).
        unitPrice = (Number.isFinite(quantity) && quantity !== 0 && Number.isFinite(lineTotal))
          ? lineTotal / quantity : (Number.isFinite(lineTotal) ? lineTotal : 0);
      } else {
        unitPrice = numFrom(row.rate != null ? row.rate : row.unitPrice);
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
    }).filter(function (item) {
      // A $0 line is not a charge (2026-10-07, ho-money audit M8): a catalog
      // line left at 0 LF printed "0.00 LF $0" eleven times on one bill, and
      // a $0 line is below the pay link's $1-per-line floor (stripe.js), so
      // it also blocked the link. Not billed, not printed.
      return Math.round(item.total * 100) !== 0;
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
   * An estimate's invoice lines and totals, BEFORE supplements and the
   * deposit (createInvoiceFromEstimate folds those in after). Was inline in
   * createInvoiceFromEstimate; moved here unchanged so the server draft
   * (functions/deposit-draft.js) reuses it instead of a second copy.
   *   opts.estimateValue(est) — the two-shape total reader
   *     (NBDCustomerEstimateRows.estimateValue); absent → grandTotal/total/amount
   *   opts.tierLabel(key)     — customer-facing tier name
   *     (NBD_ESTIMATE_CONFIG.tierLabel); absent → the built-in names
   * → { items, subtotal, tax, taxRate, total }
   */
  function invoiceTotalsFromEstimate(est, opts) {
    est = est || {};
    opts = opts || {};
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
    const savedGrand = (typeof opts.estimateValue === 'function')
      ? opts.estimateValue(est)
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
      // In whole cents: subtotal + tax === total exactly, never a cent apart
      // from rounding the two halves separately.
      const _totC = Math.round(total * 100);
      const _subC = Math.round((taxRate > 0 ? (total / (1 + taxRate)) : total) * 100);
      subtotal = _subC / 100;
      tax = (_totC - _subC) / 100;
      // Customer-facing name (Economy/Standard/Preferred/Elite/Beyond) from
      // the shared config — the invoice printed the raw key ("Good tier").
      const _tierKey = String(est.selectedTier || est.tier || '');
      const tierLabel = (typeof opts.tierLabel === 'function')
        ? opts.tierLabel(_tierKey)
        : (({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' })[_tierKey]
          || _tierKey.replace(/^./, c => c.toUpperCase()));
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
        // The quote prints total − subtotal − tax as its own row: the
        // nearest-$25 rounding or the job-minimum lift (estimate-v2-ui.js /
        // estimate-finalization.js, same rule, same label). Without it the
        // lines + tax fell short of the total and createStripePaymentLink
        // refused the link ($120 material / $250 labor at 7%: $525 quoted,
        // $513.60 of lines + tax). Untaxed — tax is already the quote's.
        // adjustment:true lets the pay link take either sign (stripe.js).
        //
        // The cents come from THE rounding rule (footingRows, 2026-10-07):
        // measured from the printed lines when they sit within $1 of the
        // saved subtotal. Measuring from the subtotal (as this did) put the
        // invoice a cent off the estimate link whenever the engine's per-row
        // rounding left the lines a cent from the subtotal — KY audit shape:
        // estimate link "Rounding −$4.96", invoice "Rounding −$4.95" — and
        // the invoice's own lines + tax + rounding then missed its total by
        // that cent. The subtotal follows: lines + tax + rounding === total.
        let adjCents = Math.round(total * 100) - Math.round(subtotal * 100) - Math.round(tax * 100);
        const _F = _footingApi();
        if (_F) {
          const _foot = _F.footingRows({ grandTotal: total, subtotal: subtotal, tax: tax, taxRate: taxRate }, items);
          const _adj = _foot.filter(function (r) { return r.code === 'ADJ'; })[0];
          adjCents = _adj ? Math.round(_adj.total * 100) : 0;
          subtotal = (Math.round(total * 100) - Math.round(tax * 100) - adjCents) / 100;
        }
        if (adjCents !== 0) {
          items.push({
            description: (est.minJobApplied && adjCents > 0) ? 'Minimum job charge adjustment' : 'Rounding',
            quantity: 1,
            unitPrice: adjCents / 100,
            total: adjCents / 100,
            adjustment: true,
            taxable: false
          });
        }
      } else {
        // Whole cents (2026-10-07): an unrounded tax / total printed a
        // total a cent off subtotal + tax.
        const _subC = items.reduce((sum, item) => sum + Math.round(item.total * 100), 0);
        const _taxC = Math.round(_subC * taxRate);
        subtotal = _subC / 100;
        tax = _taxC / 100;
        total = (_subC + _taxC) / 100;
      }
    }
    return { items, subtotal, tax, taxRate, total };
  }

  /**
   * The rows a HOMEOWNER reads on an invoice — the emailed invoice
   * (buildInvoiceHtml), the in-app / printed invoice (renderInvoiceDetail)
   * and the NBD-500 PDF (functions/money-paper-logic.js invoicePayload) —
   * in order, adding up to the total shown (2026-10-07, ho-money audit H1).
   *
   * The email printed the items and then "Total", with no Sales tax row: a
   * $13,675 job's lines summed to $12,780.09 under a $13,675.00 total (the
   * $894.91 tax was never printed), and a per-SQ job read "Roofing system —
   * Elite tier $22,102.80" over $23,650.00. Now:
   *   lines (no $0 lines) → Subtotal → Sales tax (r%) → Rounding / Minimum
   *   job charge adjustment → [Job total → each "Less deposit …" credit] →
   *   Total
   * The adjustment is THE rounding rule (footingRows) over the printed
   * lines, so the invoice says the same Rounding as the estimate link; an
   * invoice saved before that rule (subtotal-based, a cent off) prints the
   * corrected cent, so its rows add up too.
   *
   * → [{ kind, label, amount, quantity?, unitPrice? }], amount in dollars
   *   (whole cents). kind: 'line' | 'subtotal' | 'tax' | 'adjustment' |
   *   'jobTotal' | 'credit' | 'total'. subtotal / jobTotal / total are
   *   running totals; Σ line + tax + adjustment + credit === total, in cents
   *   (an old invoice whose lines sit more than $1 from its saved subtotal
   *   is printed as saved — a real gap is never relabelled Rounding).
   */
  function invoiceDisplayRows(inv) {
    inv = inv || {};
    const c = function (v) { const n = Math.round(Number(v) * 100); return Number.isFinite(n) ? n : 0; };
    const items = (Array.isArray(inv.items) ? inv.items : []).filter(Boolean);
    const lines = items.filter(function (it) { return it.credit !== true && it.adjustment !== true && c(it.total) !== 0; });
    const credits = items.filter(function (it) { return it.credit === true && c(it.total) !== 0; });
    const adjItem = items.filter(function (it) { return it.adjustment === true; })[0] || null;
    const linesC = lines.reduce(function (s, it) { return s + c(it.total); }, 0);
    const creditC = credits.reduce(function (s, it) { return s + c(it.total); }, 0); // ≤ 0
    const taxC = c(inv.tax);
    const totalC = c(inv.total);
    const jobC = totalC - creditC;
    const rate = Number(inv.taxRate);
    let adjC = jobC - linesC - taxC;
    const F = _footingApi();
    if (F && inv.subtotal != null && inv.subtotal !== '' && Number.isFinite(Number(inv.subtotal)) && jobC > 0) {
      const foot = F.footingRows({ grandTotal: jobC / 100, subtotal: Number(inv.subtotal), tax: taxC / 100, taxRate: rate }, lines);
      const adj = foot.filter(function (r) { return r.code === 'ADJ'; })[0];
      adjC = adj ? c(adj.total) : 0;
    }
    const baseC = jobC - taxC - adjC;
    const rows = lines.map(function (it) {
      const q = Number(it.quantity);
      return {
        kind: 'line',
        label: String(it.description || 'Line item'),
        quantity: Number.isFinite(q) ? q : 1,
        unitPrice: c(it.unitPrice) / 100,
        amount: c(it.total) / 100
      };
    });
    rows.push({ kind: 'subtotal', label: 'Subtotal', amount: baseC / 100 });
    if (taxC !== 0) {
      const pct = (Number.isFinite(rate) && rate > 0) ? String(Math.round(rate * 100000) / 1000) + '%' : '';
      rows.push({ kind: 'tax', label: 'Sales tax' + (pct ? ' (' + pct + ')' : ''), amount: taxC / 100 });
    }
    if (adjC !== 0) {
      rows.push({ kind: 'adjustment', label: adjItem ? String(adjItem.description || 'Rounding') : 'Adjustment', amount: adjC / 100 });
    }
    if (credits.length) {
      rows.push({ kind: 'jobTotal', label: 'Job total', amount: jobC / 100 });
      credits.forEach(function (it) {
        rows.push({ kind: 'credit', label: String(it.description || 'Less deposit paid'), amount: c(it.total) / 100 });
      });
    }
    rows.push({ kind: 'total', label: 'Total', amount: totalC / 100 });
    return rows;
  }
  // nbd:invoice-from-estimate:end

  // nbd:job-billing:start — ONE live invoice per job, and a final invoice
  // that credits what the job was already billed (2026-10-03). Byte-identical
  // in functions/invoice-from-estimate.js (the server's install-day final
  // draft), pinned by tests/money-getting-paid-2026-10-03.test.js.
  //
  // createInvoiceFromEstimate billed the full estimate every time, with no
  // look at the job's other invoices — including the draft deposit invoice
  // the server makes on a signed contract — so a second tap billed the job
  // twice. Now:
  //   - a LIVE invoice (not paid / void / cancelled / deleted) that bills the
  //     whole job is opened instead of making another;
  //   - otherwise a new invoice is the FINAL one: each earlier invoice for
  //     the job (a paid deposit, or a deposit invoice already issued) is
  //     credited as its own "Less deposit …" line, so the total due is what
  //     is actually left;
  //   - nothing is made when those invoices already bill the whole job.
  // A credit line carries credit:true and a negative total; the online pay
  // link charges the balance as one line (functions/stripe.js).
  var JOB_BILLING_DEAD = { void: 1, voided: 1, cancelled: 1, canceled: 1, uncollectible: 1 };
  function _jbCents(v) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function _jbJobId(v) {
    return (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v)) ? v : null;
  }
  function _jbMs(v) {
    if (!v) return 0;
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  }
  /**
   * This job's invoices: not deleted / void / cancelled; the same job, or —
   * when either side has no job stamp — an unpaid one (a PAID invoice with
   * no job stamp is an earlier job's history). The deposit draft's filter
   * (functions/deposit-draft-logic.js). Oldest first.
   *
   * opts (2026-10-05) = { soleJob, since }: a PAID invoice with no job stamp
   * — a deposit mirrored in from the Stripe dashboard (stripe-ledger-logic.js
   * mirrorInvoice never knew the job) — IS this job's when the customer has
   * exactly ONE job (soleJob: the caller read leads/{id}/jobs, see soleJobOf)
   * AND it was made on or after this job's estimate (since = the estimate's
   * createdAt), so an earlier roof's payment never credits this one. With two
   * or more jobs, or no estimate date, it stays out as before: the final
   * invoice then shows no credit for it (visible on the paper, the rep fixes
   * it) — never a silent credit to the wrong job.
   */
  function jobInvoicesOf(invoices, jobId, opts) {
    const jid = _jbJobId(jobId);
    const o = opts || {};
    const sinceMs = _jbMs(o.since);
    const adopt = !!jid && o.soleJob === true && sinceMs > 0;
    return (Array.isArray(invoices) ? invoices : []).filter(function (inv) {
      if (!inv || inv.deleted === true || inv.deletedAt) return false;
      const st = String(inv.status || '').toLowerCase();
      if (JOB_BILLING_DEAD[st]) return false;
      const ij = _jbJobId(inv.jobId);
      if (jid && ij) return ij === jid;
      if (st !== 'paid') return true;
      return adopt && !ij && _jbMs(inv.createdAt) >= sinceMs;
    }).sort(function (a, b) { return _jbMs(a.createdAt) - _jbMs(b.createdAt); });
  }
  /**
   * soleJobOf(jobs, jobId) — true when leads/{id}/jobs (not deleted) holds
   * exactly one job and it is jobId. Unread / empty / two or more → false.
   */
  function soleJobOf(jobs, jobId) {
    const jid = _jbJobId(jobId);
    const live = (Array.isArray(jobs) ? jobs : []).filter(function (j) { return j && j.deleted !== true; });
    return !!jid && live.length === 1 && live[0].id === jid;
  }
  /** Live = still in play for its job: anything but paid (after jobInvoicesOf). */
  function isLiveInvoice(inv) {
    return !!inv && String(inv.status || '').toLowerCase() !== 'paid';
  }
  /**
   * planJobInvoice(jobTotalCents, invoices, jobId, opts) — what billing this
   * job needs now (opts: jobInvoicesOf's).
   *  → { action: 'open', invoiceId, reason: 'live_invoice' }
   *      a live invoice bills the whole job: use it (with no job total to
   *      compare, any live invoice for the job is the job's bill);
   *  | { action: 'open', invoiceId, reason: 'billed_in_full' }
   *      earlier invoices already bill the whole job;
   *  | { action: 'create', credits: [{ invoiceId, label, cents, paid }], creditCents }
   */
  function planJobInvoice(jobTotalCents, invoices, jobId, opts) {
    const mine = jobInvoicesOf(invoices, jobId, opts);
    const totalC = Math.max(0, Math.round(Number(jobTotalCents) || 0));
    const covering = mine.filter(function (inv) {
      return isLiveInvoice(inv) && (totalC === 0 || _jbCents(inv.total) >= totalC);
    });
    if (covering.length) return { action: 'open', invoiceId: covering[0].id || null, reason: 'live_invoice' };
    const credits = [];
    let creditCents = 0;
    mine.forEach(function (inv) {
      const c = _jbCents(inv.total);
      if (!(c > 0)) return;
      const paid = String(inv.status || '').toLowerCase() === 'paid' || _jbCents(inv.amountPaid) >= c;
      credits.push({ invoiceId: inv.id || null, label: paid ? 'Less deposit paid' : 'Less deposit invoiced', cents: c, paid: paid });
      creditCents += c;
    });
    if (totalC > 0 && creditCents >= totalC) {
      return { action: 'open', invoiceId: mine.length ? (mine[mine.length - 1].id || null) : null, reason: 'billed_in_full' };
    }
    return { action: 'create', credits: credits, creditCents: creditCents };
  }
  /**
   * The final invoice's lines and total: one negative "Less deposit …" line
   * per credit (credit: true), total = the job total − the credits. Subtotal
   * and tax stay the job's own, so the paper shows what the job costs and
   * what is left to pay.
   */
  function applyJobCredits(base, credits) {
    base = base || {};
    const items = (Array.isArray(base.items) ? base.items : []).slice();
    let creditC = 0;
    (Array.isArray(credits) ? credits : []).forEach(function (cr) {
      const c = Math.max(0, Math.round(Number(cr && cr.cents) || 0));
      if (!c) return;
      creditC += c;
      items.push({
        description: String(cr.label || 'Less deposit paid') + (cr.invoiceId ? ' (invoice ' + String(cr.invoiceId).slice(0, 12) + ')' : ''),
        quantity: 1,
        unitPrice: -c / 100,
        total: -c / 100,
        credit: true,
        creditInvoiceId: cr.invoiceId || null
      });
    });
    const totalC = Math.max(0, _jbCents(base.total) - creditC);
    return Object.assign({}, base, { items: items, total: totalC / 100, creditTotal: creditC / 100 });
  }
  // nbd:job-billing:end

  // nbd:payment-timeline:start — every payment gets ONE line on the
  // customer's timeline (2026-10-03). Byte-identical in
  // functions/payment-timeline.js, pinned by
  // tests/money-getting-paid-2026-10-03.test.js. The line is a /notes doc
  // (the timeline reads notes by leadId) whose id is derived from the
  // payment's own id, so whichever path writes it first — the Record Payment
  // sheet / Mark Paid in the browser, or the server's invoice trigger for a
  // Stripe webhook / ledger credit — every later write lands on the SAME doc:
  // one entry per payment, however many paths see it.
  var PAYMENT_TIMELINE_METHODS = {
    check: 'check', zelle: 'Zelle', cash: 'cash', card: 'card (not Stripe)', ach: 'ACH / bank (not Stripe)',
    other: 'other', manual: 'manual entry', stripe: 'online card (Stripe)', apple_pay: 'Apple Pay (Stripe)',
    google_pay: 'Google Pay (Stripe)', link: 'Link (Stripe)', us_bank_account: 'bank transfer (Stripe)', cashapp: 'Cash App (Stripe)'
  };
  var PAYMENT_TIMELINE_PAYERS = { homeowner: 'the homeowner', insurance: 'the insurance carrier', mortgage: 'the mortgage company' };
  function _ptlSeg(s) {
    return String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
  }
  /** The payment's own stable id, or '' (a legacy entry with none). */
  function paymentIdOf(p) {
    p = p || {};
    return String(p.paymentId || p.paymentIntentId || p.stripeRef || '');
  }
  /** The timeline note's doc id for this payment, or '' without a payment id. */
  function paymentTimelineNoteId(invoiceId, p) {
    const pid = paymentIdOf(p);
    return pid ? 'pay-' + _ptlSeg(invoiceId) + '-' + _ptlSeg(pid) : '';
  }
  function paymentTimelineText(invoiceId, p) {
    p = p || {};
    const n = Number(p.amount) || 0;
    const amt = '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const method = PAYMENT_TIMELINE_METHODS[p.method] || (p.method ? String(p.method).slice(0, 40) : 'payment');
    const ref = p.reference ? ' #' + String(p.reference).slice(0, 40) : '';
    const payer = PAYMENT_TIMELINE_PAYERS[p.payer] ? ' from ' + PAYMENT_TIMELINE_PAYERS[p.payer] : '';
    return '💵 Payment received: ' + amt + ' by ' + method + ref + payer + ' — invoice ' + String(invoiceId || '').slice(0, 12) + '.';
  }
  // nbd:payment-timeline:end

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
    const r = await createOrOpenJobInvoice(estimateId);
    return r.invoiceId;
  }

  /**
   * The job's invoice for this estimate: the live one if the job already has
   * it, else a new one — a FINAL invoice crediting the job's earlier invoices
   * when there are any (nbd:job-billing above). Never a second bill for the
   * same work.
   * @returns {Promise<{ invoiceId: string, reused: boolean, reason?: string, creditCents?: number }>}
   */
  async function createOrOpenJobInvoice(estimateId) {
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

      // Build invoice from estimate — invoiceTotalsFromEstimate (above, shared
      // with the server draft deposit invoice) holds the per-SQ / row-based
      // totals that used to be inline here, unchanged.
      const _rowsApi = window.NBDCustomerEstimateRows;
      const _icfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
      const _base = invoiceTotalsFromEstimate(est, {
        estimateValue: (_rowsApi && typeof _rowsApi.estimateValue === 'function') ? _rowsApi.estimateValue : null,
        tierLabel: (_icfg && typeof _icfg.tierLabel === 'function') ? _icfg.tierLabel : null
      });
      const taxRate = _base.taxRate;
      let items = _base.items, subtotal = _base.subtotal, tax = _base.tax, total = _base.total;

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

      // Multi-job (2026-09-30): the job this invoice bills — the estimate's
      // own job if it names one, else the job on the customer's card right
      // now. money-paper.js marks exactly this job paid in full, and a later
      // job taking over the card can never be marked paid by this invoice.
      const jobId = (est.jobId && /^[A-Za-z0-9_-]{1,40}$/.test(String(est.jobId)) ? String(est.jobId) : null)
        || (lead && typeof lead.activeJobId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(lead.activeJobId) ? lead.activeJobId : null);

      // One live invoice per job (2026-10-03, nbd:job-billing). Read the
      // customer's invoices first; a live one that bills the whole job is
      // OPENED, not duplicated, and a new one credits the earlier ones.
      // Unreadable → refuse rather than risk billing the job twice.
      let jobCredits = [];
      if (est.leadId) {
        let existing;
        try { existing = await _loadLeadInvoices(db, est.leadId); }
        catch (e) { throw new Error('Could not check the other invoices for this job — try again so it is not billed twice.'); }
        // A deposit paid through the Stripe dashboard is mirrored in with no
        // job stamp: credit it when this is the customer's only job and it
        // was paid after this estimate (nbd:job-billing jobInvoicesOf opts).
        const jobs = jobId ? await _loadLeadJobs(db, est.leadId) : null;
        const plan = planJobInvoice(Math.round(Number(total) * 100), existing, jobId,
          { soleJob: soleJobOf(jobs, jobId), since: est.createdAt });
        if (plan.action === 'open' && plan.invoiceId) return { invoiceId: plan.invoiceId, reused: true, reason: plan.reason };
        if (plan.action === 'create') jobCredits = plan.credits;
      }

      if (_depRule && !jobCredits.length) {
        depositPlan = _depRule.fromEstimate(est, { totalCents: Math.round(Number(total) * 100), lead: lead || null });
        depositAmount = depositPlan.depositCents / 100;
      }
      // A FINAL invoice: the deposit was billed on the earlier invoice(s), so
      // no deposit here — each one is a "Less deposit …" line instead.
      if (jobCredits.length) {
        const credited = applyJobCredits({ items, subtotal, tax, total }, jobCredits);
        items = credited.items;
        total = credited.total;
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
        // ONE due-date rule (deposit-rule.js INVOICE_DUE_DAYS) — the Stripe
        // invoice's days_until_due reads the same value; this said 14 days
        // while the Stripe invoice the homeowner opened said 7.
        // (The fallback is only for a bare unit-test sandbox with no
        // deposit-rule.js; tests/money-getting-paid-2026-10-03.test.js pins
        // it to INVOICE_DUE_DAYS.)
        dueDate: new Date(_depRule ? _depRule.invoiceDueDateMs(Date.now()) : Date.now() + 7 * 86400000),
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
        terms: (_depRule ? _depRule.netTermsText() : 'Net 7.') + (depositPlan && depositPlan.summary ? ' ' + depositPlan.summary : ''),
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: window._auth?.currentUser?.uid || 'system',
        // Tenant key (mirrors /expenses): lets same-company staff read team
        // invoices and is required by the hardened /invoices create rule. Solo
        // operators key by uid (companyId == uid convention).
        companyId: window._userClaims?.companyId || window._auth?.currentUser?.uid || null,
        // Multi-job (2026-09-30): the job this invoice bills — the estimate's
        // own job if it names one, else the job on the customer's card right
        // now. money-paper.js marks exactly this job paid in full, and a later
        // job taking over the card can never be marked paid by this invoice.
        jobId
      };
      if (jobCredits.length) {
        invoiceData.kind = 'final';
        invoiceData.creditTotal = jobCredits.reduce((s, c) => s + c.cents, 0) / 100;
        invoiceData.creditedInvoiceIds = jobCredits.map(c => c.invoiceId).filter(Boolean);
      }

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
      return { invoiceId: invoiceRef.id, reused: false, creditCents: jobCredits.reduce((s, c) => s + c.cents, 0) };

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

  // "Connect Stripe" prompt (2026-10-04, tenant-ready). A company whose
  // Connect account is not ready can still send an invoice — but it goes out
  // with NO "Pay online" button, and the payment-link mint refuses
  // (functions/stripe.js). Say so on the invoice screen BEFORE the send, with
  // the way to fix it. Pure: the caller passes whether the company can collect
  // online. Not shown on a paid invoice, one that already has a link, or a
  // Kentucky insurance hold (that note explains its own missing link).
  function connectStripeNoteHtml(inv, canCollect) {
    const i = inv || {};
    if (canCollect || i.status === 'paid' || i.stripePaymentLink || i.kyInsuranceHold) return '';
    return '<div data-ip-connect-note class="ipx-note">'
      + '<strong>Card payments are not set up yet.</strong> This invoice will go out without a “Pay online” button '
      + 'until you connect Stripe. Checks, cash and Zelle still work — record them with Record Payment. '
      + '<button type="button" class="btn btn-ghost" data-ip-action="connectStripe">Connect Stripe</button>'
      + '</div>';
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

  /**
   * Part paid: money in, money still owed (2026-10-03). The Stripe webhook
   * left a part-paid invoice 'sent' (only Mark Paid and the Stripe ledger
   * wrote 'partial'), and sendInvoice refuses 'sent' with "Use Resend" — a
   * button that never existed — so the balance could not be billed at all.
   */
  function isPartPaid(inv) {
    if (!inv || inv.deleted === true) return false;
    const st = String(inv.status || '').toLowerCase();
    if (st === 'paid' || st === 'draft' || st === 'void' || st === 'voided' || st === 'cancelled' || st === 'canceled') return false;
    return toCents(Math.max(0, Number(inv.amountPaid) || 0)) > 0
      && toCents(Math.max(0, Number(inv.balanceDue) || 0)) > 0;
  }
  /** "Send balance" is offered on a part-paid invoice (the same send flow, one tap). */
  function canSendBalance(inv) { return isPartPaid(inv); }

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
    // A draft's dueDate was stamped when it was DRAFTED (deposit-draft-logic,
    // createInvoice): first send restarts the 7-day clock, so a final drafted
    // at install and sent 11 days later is not "5 days past due" the next
    // morning (review round 4 R4-6-4). A Stripe invoice carries its own due
    // date (days_until_due) and is left alone.
    const _stripeInv = !!(inv && (inv.stripeInvoiceKind === 'invoice' || inv.stripeHostedUrl));
    const _dr = (typeof window !== 'undefined' && window.NBDDepositRule) || null;
    if (priorStatus === 'draft' && !(inv && inv.sentAt) && !_stripeInv) {
      const _nowMs = now instanceof Date ? now.getTime() : Number(now);
      patch.dueDate = new Date(_dr ? _dr.invoiceDueDateMs(_nowMs) : _nowMs + 7 * 86400000);
    }
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
      // A part-paid invoice is a BALANCE send — the rep's deliberate "Send
      // balance" tap — not a duplicate of the first send.
      if (invoice.status === 'sent' && !isPartPaid(invoice)) {
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
      // BOUND THE ACQUIRE. Offline a Firestore write does not reject — it
      // never settles until the server acknowledges it. (Written when the app
      // ran with no local cache; since 2026-10-04 nbd-auth.js uses a
      // persistent one, which keeps the queued write across an app kill but
      // does not change this: the promise still waits for the server.)
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

      // Balance send: a CRM pay link was minted for the FULL amount (and a
      // card deposit spends the single-use link), so re-mint it for the
      // balance first — the server deactivates the old one and re-checks the
      // Kentucky hold. A failed re-mint sends NO link rather than a stale one.
      const balanceSend = isPartPaid(invoice);
      let linkSource = invoice;
      if (balanceSend && invoice.stripePaymentLink) {
        try {
          const minted = await generateStripePaymentLink(invoiceId);
          linkSource = Object.assign({}, invoice, { stripePaymentLink: (minted && minted.url) || null });
        } catch (regenErr) {
          console.warn('sendInvoice: balance link re-mint failed — sending without a link', regenErr && regenErr.message);
          linkSource = Object.assign({}, invoice, { stripePaymentLink: null, stripeHostedUrl: null });
        }
      }
      // The homeowner's pay link: stripePaymentLink OR stripeHostedUrl, and
      // '' while the Kentucky insurance hold applies (_homeownerPayUrl).
      const payUrl = await _homeownerPayUrl(Object.assign({ id: invoiceId }, linkSource));
      const balanceText = balanceSend ? formatCurrency(invoice.balanceDue) : '';
      // Zelle: (859) 420-7382 or jd@ for NBD (never info@), held like the link.
      const zelle = await _homeownerZelle(Object.assign({ id: invoiceId }, invoice));

      if (method === 'email') {
        // Build invoice HTML
        // ACH is offered only on the NBD platform account (functions/stripe.js);
        // no other tenant's message claims a bank option.
        const invoiceHtml = buildInvoiceHtml(invoice, { payUrl, zelle, payByBank: _platformTenant(), invoiceId });

        // Send via NBDComms
        if (window.NBDComms?.sendEmail) {
          const emailResult = await window.NBDComms.sendEmail({
            to: invoice.customerEmail || '',
            subject: balanceSend
              ? `Balance due ${balanceText} — Invoice ${nbdInvoiceNumberOf(invoice) || invoiceId} from ${_invoiceCompany()}`
              : `Invoice ${nbdInvoiceNumberOf(invoice) || invoiceId} from ${_invoiceCompany()}`,
            html: invoiceHtml,
            leadId: invoice.leadId || null,
            invoiceId: invoiceId, // the server checks `to` against invoice.customerEmail
            kind: 'invoice', // transactional: never blocked by an email unsubscribe
          });
          if (!emailResult || emailResult.success === false) {
            throw new Error((emailResult && (emailResult.message || emailResult.error)) || 'Email send failed');
          }
        } else {
          throw new Error('Email service not available');
        }

      } else if (method === 'sms') {
        const link = payUrl;
        // Two fixes on one line. The company was hardcoded "NBD Roofing", so a
        // tenant's homeowner was told the invoice came from the platform owner.
        // And the link was interpolated unconditionally — with none (which is
        // now the normal case for a tenant) the customer got "Payment link: "
        // with nothing after it.
        const opener = balanceSend
          ? `Thank you for your payment — your ${_invoiceCompany()} invoice has a remaining balance of ${balanceText}.`
          : `Your ${_invoiceCompany()} invoice is ready.`;
        // Bank payment (ACH) is on the same link — lower fees (2026-10-04).
        // NBD platform tenant only: ACH is requested only on its links.
        const achBit = _platformTenant() ? ' (card or bank/ACH — bank has lower fees)' : '';
        const zelleBit = zelle ? ` Zelle: ${zelle}.` : '';
        const message = link
          ? `${opener} Payment link: ${link}${achBit}.${zelleBit}`
          : (zelle ? `${opener} Zelle: ${zelle}. Reply here with any questions.`
            : `${opener.replace(/\.$/, '')} — reply here with any questions.`);

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
   * @param {string} method - one of PAYMENT_METHODS (check | zelle | cash | ach | other)
   * @param {object} [details] - { at: Date received, reference, note,
   *   proofStoragePath, proofName } — all optional; `at` defaults to now.
   */
  async function markPaid(invoiceId, amount, method, details) {
    const db = getDb();
    details = details || {};

    if (!(toCents(amount) > 0)) {
      throw new Error('Invalid payment amount');
    }

    try {
      const invRef = window.doc(db, 'invoices', invoiceId);
      // Append-only cash ledger: each credit keeps its own date so Money +
      // Analytics can attribute multi-payment invoices by receipt period
      // (deposit in May ≠ balance payoff in July). `at` is the day the money
      // was RECEIVED (the sheet's date field — a check that came yesterday is
      // logged today); recordedAt/recordedBy say when and who typed it.
      const entry = buildManualPaymentEntry({
        amount,
        method: method || 'other',
        at: details.at instanceof Date ? details.at : new Date(),
        reference: details.reference,
        note: details.note,
        proofStoragePath: details.proofStoragePath,
        proofName: details.proofName,
        payer: details.payer,
        basis: details.basis,
        paymentId: details.paymentId,
        recordedBy: (window._auth && window._auth.currentUser && window._auth.currentUser.uid)
          || (window._user && window._user.uid) || '',
        recordedAt: new Date(),
      });
      // The entry (and its paymentId) is built ONCE, outside the write, so a
      // transaction retry re-applies the very same payment.
      //
      // Read + append + write as ONE step (2026-10-05). This was getDoc then
      // updateDoc of the whole payments[] / amountPaid / status: a card
      // payment the Stripe webhook credited between the two (its own
      // transaction, functions/stripe.js) was overwritten by this page's stale
      // copy — the card money vanished from the invoice, the webhook's retry
      // was idempotent-skipped (paidIntentIds), and the homeowner got chased
      // for money already paid. Inside runTransaction the read is re-done if
      // anything else wrote the invoice first, so both payments survive.
      // Cumulative paid ledger in cents (applyPaymentToInvoice): balanceDue =
      // total − amountPaid, so multiple partial payments accumulate correctly.
      // lastPaymentAt is stamped on EVERY payment (incl. partial deposits) so
      // the money dashboard attributes collected cash to the year it was
      // received; paidAt only fires on full payoff.
      const decide = (snap) => {
        if (!snap.exists()) throw new Error('Invoice not found');
        const cur = snap.data() || {};
        // Same paymentId already on the invoice (a retried call whose first
        // write landed): a no-op, never a second credit.
        const dup = Array.isArray(cur.payments)
          && cur.payments.some((p) => p && p.paymentId === entry.paymentId);
        if (dup) return { invoice: cur, duplicate: true };
        const applied = applyPaymentToInvoice(cur, entry);
        return { invoice: cur, patch: Object.assign({}, applied.patch, { updatedAt: entry.recordedAt }), newBalanceDue: applied.newBalanceDue };
      };
      let result;
      if (typeof window.runTransaction === 'function') {
        result = await window.runTransaction(db, async (tx) => {
          const r = decide(await tx.get(invRef));
          if (r.patch) tx.update(invRef, r.patch);
          return r;
        });
      } else {
        // A page without runTransaction (none of the CRM pages today — both
        // bootstraps expose it): the old read-then-write.
        result = decide(await window.getDoc(invRef));
        if (result.patch) await window.updateDoc(invRef, result.patch);
      }
      const invoice = result.invoice;
      if (result.duplicate) return;
      const newBalanceDue = result.newBalanceDue;

      // One timeline line per payment (nbd:payment-timeline). The server's
      // invoice trigger writes the SAME doc id for every payment path, so
      // this is just the fast copy (and the only one on a stack without the
      // functions runtime). Best-effort: the payment is already recorded.
      if (invoice.leadId) {
        try { await _writePaymentTimeline(db, invoiceId, invoice.leadId, entry); }
        catch (tlErr) { console.warn('markPaid: timeline note failed', tlErr && (tlErr.code || tlErr.message)); }
      }

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

      // No stage write here any more (job spine, 2026-10-03). This payment
      // lands on the invoice doc, and the server's invoice trigger
      // (functions/money-paper.js moneyPaperOnInvoice → job-spine.js) moves
      // the lead: paid in full → Final Payment, a deposit → Contract Signed,
      // forward only, with history, timeline note and stage-entry task. It
      // used to advance only a New/Active lead to Contract Signed from here
      // while a card payoff (stripe.js) went to Final Payment — the same
      // payoff landed the card in two places depending on how it was paid.

      // NO receipt email from here — from ANY caller (Jo, 2026-10-04:
      // "draft it, one-click send"). The ledger entry above carries a receipt
      // DRAFT (entry.receipt.status 'draft'); the customer page's invoice row,
      // the payment's timeline line and the invoice detail show "Send
      // receipt", and only that tap emails the customer (sendReceipt). The
      // old auto-send surprised customers with receipts for weeks-old checks
      // and named the invoice by its internal doc id. details.sendReceipt is
      // ignored.
      return { paymentId: entry.paymentId, receipt: 'draft', balanceDue: newBalanceDue };

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
        <div class="invoice-panel ipx-card">
          <div class="ipx-bar">
            <h3 class="ipx-h3">Invoices</h3>
            <button type="button" class="btn btn-orange btn-sm" data-ip-action="createInvoiceUI" data-ip-id="${leadId}">+ New Invoice</button>
          </div>
      `;

      if (invoices.length === 0) {
        html += `
          <div class="nbd-empty ipx-pad20-12">
            <div class="ne-icon">🧾</div>
            <div class="ne-msg">No invoices yet</div>
            <div class="ne-sub">Create one from this lead's estimate.</div>
          </div>`;
      } else {
        html += `<div class="ipx-stack8">`;
        invoices.forEach(inv => {
          const statusBg = inv.status === 'paid' ? 'var(--green)' : inv.status === 'sent' ? 'var(--blue)' : 'var(--m)';
          const _s = String(inv.status || '');
          const statusTxt = escHtml(_s.charAt(0).toUpperCase() + _s.slice(1));
          html += `
            <div style="display:flex;justify-content:space-between;align-items:center;padding:10px;background:var(--s2);border-radius:5px;border-left:3px solid ${statusBg};">
              <div class="ipx-flex1">
                <div class="ipx-b ipx-fs12">${formatCurrency(inv.total)}</div>
                <div class="ipx-m11">${statusTxt}</div>
                ${depositDraftChipHtml(inv)}
                ${stripeSourceHtml(inv)}
              </div>
              <div class="ipx-row6">
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
      container.innerHTML = `<div class="ipx-err">Failed to load invoices</div>`;
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
      // Before the send (2026-10-04): can this company take a card payment?
      const _canCollect = (inv && inv.status !== 'paid' && !inv.stripePaymentLink)
        ? await _canCollectOnline() : true;
      // Copy Payment Link copies what the homeowner will be sent — so it
      // goes through the same Kentucky hold as the SMS / email / portal.
      const _payUrl = await _homeownerPayUrl(Object.assign({ id: invoiceId }, inv));
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
        <div class="invoice-detail ipx-paper">
          <div class="ipx-head">
            <div>
              <div class="ipx-brand">${_esc(_invoiceBrandName())}</div>
              <div class="ipx-m12">Invoice ${_esc(invoiceId)}</div>
              ${depositDraftChipHtml(inv)}
              ${isDepositDraft(inv) ? '<div class="ipx-m12" data-deposit-draft-note>Made automatically when the contract was signed. Nothing has been sent — check it, then tap Send to Customer.</div>' : ''}
              ${stripeSourceHtml(inv)}
            </div>
            <div class="ipx-r">
              <div class="ipx-big">${formatCurrency(inv.total)}</div>
              <div class="ipx-caps">${_esc(inv.status)}</div>
            </div>
          </div>

          <div class="ipx-g2-wide">
            <div>
              <div class="ipx-k">Bill To</div>
              <div class="ipx-b14">${_esc(invoiceCustomerName(inv) || 'Customer')}</div>
              <div class="ipx-m12">${_esc(inv.customerEmail || '')}</div>
              ${inv.customerPhone ? `<div class="ipx-m12">${_esc(inv.customerPhone)}</div>` : ''}
            </div>
            <div>
              <div class="ipx-k">Invoice Details</div>
              <div class="ipx-stack4">
                <div><strong>Date:</strong> ${new Date(inv.createdAt?.toDate?.() || inv.createdAt).toLocaleDateString()}</div>
                <div><strong>Due Date:</strong> ${new Date(inv.dueDate?.toDate?.() || inv.dueDate).toLocaleDateString()}</div>
                <div><strong>Status:</strong> ${_esc((inv.status||'').toString().toUpperCase())}</div>
              </div>
            </div>
          </div>

          <table class="inv-lines ipx-table ipx-mb20">
            <thead>
              <tr class="ipx-head-row">
                <th class="ipx-th8 ipx-l">DESCRIPTION</th>
                <th class="ipx-th8 ipx-r">QUANTITY</th>
                <th class="ipx-th8 ipx-r">UNIT PRICE</th>
                <th class="ipx-th8 ipx-r">TOTAL</th>
              </tr>
            </thead>
            <tbody>
      `;

      // The same rows the homeowner's email prints (invoiceDisplayRows): no
      // $0 lines, then Subtotal / Sales tax / Rounding / Total that add up.
      const _dispRows = invoiceDisplayRows(inv);
      _dispRows.filter(r => r.kind === 'line').forEach(r => {
        html += `
          <tr class="ipx-row">
            <td class="ipx-td8">${_esc(r.label)}</td>
            <td class="ipx-td8 ipx-r">${_esc(r.quantity)}</td>
            <td class="ipx-td8 ipx-r">${formatCurrency(r.unitPrice)}</td>
            <td class="ipx-td8 ipx-r ipx-b">${formatCurrency(r.amount)}</td>
          </tr>
        `;
      });

      html += `
            </tbody>
          </table>

          <div class="ipx-end20">
            <div class="ipx-w300">
              ${_dispRows.filter(r => r.kind !== 'line').map(r => r.kind === 'total' ? `
              <div class="ipx-total-row">
                <span>${_esc(r.label)}:</span>
                <span>${formatCurrency(r.amount)}</span>
              </div>` : `
              <div class="ipx-sum-row">
                <span>${_esc(r.label)}:</span>
                <span>${formatCurrency(r.amount)}</span>
              </div>`).join('')}
              ${paymentSummaryRows(inv).map((r, idx) => r.strong ? `
              <div class="ipx-due-row">
                <span>${_esc(r.label)}:</span>
                <span>${formatCurrency(r.amount)}</span>
              </div>` : `
              <div style="display:flex;justify-content:space-between;padding:8px;${idx === 0 ? 'border-top:1px solid var(--br);' : ''}font-size:12px;">
                <span>${_esc(r.label)}:</span>
                <span>${formatCurrency(r.amount)}</span>
              </div>`).join('')}
              ${inv.depositRepNote ? `
              <div data-ip-deposit-note class="ipx-note-row">
                ${_esc(inv.depositRepNote)}
              </div>` : ''}
            </div>
          </div>

          ${achPendingText(inv) ? `<div data-ip-ach-pending class="ipx-note">🏦 ${_esc(achPendingText(inv))}</div>` : ''}
          ${paymentHistoryHtml(invoiceId, inv)}

          <div class="ipx-toolbar">
            <button type="button" class="btn btn-ghost" data-ip-action="print">Print Invoice</button>
            ${canSendBalance(inv)
              ? `<button type="button" class="btn btn-orange" data-ip-action="sendInvoice" data-ip-id="${_esc(invoiceId)}" data-ip-send-balance>Send balance (${_esc(formatCurrency(inv.balanceDue))})</button>`
              : `<button type="button" class="btn btn-orange" data-ip-action="sendInvoice" data-ip-id="${_escJs(invoiceId)}">Send to Customer</button>`}
            ${inv.status !== 'paid' ? `<button type="button" class="btn btn-green" data-ip-action="markPaid" data-ip-id="${_escJs(invoiceId)}">Record Payment (Check/Zelle/Cash)</button>` : ''}
            ${_payUrl ? `<button type="button" class="btn btn-ghost" data-ip-action="copyStripeLink" data-ip-id="${_esc(_payUrl)}">Copy Payment Link</button>` : ''}
            ${(!inv.stripePaymentLink && inv.status !== 'paid' && inv.kyInsuranceHold) ? `<button type="button" class="btn btn-ghost" data-ip-action="createPayLink" data-ip-id="${_escJs(invoiceId)}">Create Payment Link</button>` : ''}
            ${(!inv.stripePaymentLink && inv.status !== 'paid' && inv.kyInsuranceHold && !inv.emergencyServices) ? `<button type="button" class="btn btn-ghost" data-ip-action="markEmergency" data-ip-id="${_escJs(invoiceId)}">Emergency tarp / repair invoice</button>` : ''}
          </div>
          ${connectStripeNoteHtml(inv, _canCollect)}
          ${(_payUrl && inv.status !== 'paid' && _platformTenant()) ? `<div data-pay-by-bank class="ipx-m11 ipx-mt8">🏦 ${_esc(PAY_BY_BANK_LINE)}</div>` : ''}
          ${(inv.kyInsuranceHold && !inv.stripePaymentLink && inv.status !== 'paid') ? `
          <div data-ip-ky-hold class="ipx-note">
            ${_esc(((typeof window !== 'undefined' && window.NBDJurisdiction) ? window.NBDJurisdiction.MSG.payLinkHeld : 'Online payment link withheld: Kentucky insurance job (KRS 367.626).'))}
            ${inv.emergencyServices ? ' This invoice is marked emergency work.' : ''}
          </div>` : ''}

          <div class="ipx-box">
            <strong>Terms:</strong> ${_esc(inv.terms)}
          </div>
          ${inv.notes ? `<div class="ipx-box ipx-mt8"><strong>Notes:</strong> ${_esc(inv.notes)}</div>` : ''}
        </div>
      `;

      container.innerHTML = html;

    } catch (error) {
      console.error('renderInvoiceDetail error:', error);
      container.innerHTML = `<div class="ipx-err">Failed to load invoice</div>`;
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
        .reduce((sum, inv) => sum + owedDollarsOf(inv), 0);

      let html = `
        <div class="invoice-list ipx-pad16">
          <div class="stat-card ipx-mb16">
            <div class="stat-icon si-o">💰</div>
            <div>
              <div class="stat-val ipx-orange">${formatCurrency(totalOutstanding)}</div>
              <div class="stat-lbl">Total Outstanding</div>
            </div>
          </div>

          <div class="ipx-scroll-x">
            <table class="ipx-table">
              <thead>
                <tr class="ipx-head-row">
                  <th class="ipx-th10 ipx-l">INVOICE</th>
                  <th class="ipx-th10 ipx-l">CUSTOMER</th>
                  <th class="ipx-th10 ipx-r">AMOUNT</th>
                  <th class="ipx-th10 ipx-r">DUE DATE</th>
                  <th class="ipx-th10">STATUS</th>
                  <th class="ipx-th10">ACTION</th>
                </tr>
              </thead>
              <tbody>
      `;

      invoices.forEach(inv => {
        const dueDate = new Date(inv.dueDate?.toDate?.() || inv.dueDate);
        // Only an owed invoice can be overdue — a void/draft/cancelled row is not.
        // THE overdue rule (ky-insurance-law.js invoiceOverdue — the server's
        // task, Money and Today's plan agree): the tenant-zone day after the
        // due date, never while the Kentucky pay hold applies.
        const isOverdue = isOwedInvoice(inv) && _overdueNow(inv);
        const statusBg = inv.status === 'paid' ? 'var(--green)' : isOverdue ? 'var(--red)' : 'var(--blue)';

        html += `
          <tr class="ipx-row">
            <td class="ipx-td10 ipx-fs12 ipx-b">${escHtml(inv.id.slice(0, 8))}</td>
            <td class="ipx-td10 ipx-fs12">${escHtml(invoiceCustomerName(inv) || '—')}${isDepositDraft(inv) ? '<br>' + depositDraftChipHtml(inv) : ''}${inv.source === 'stripe' ? '<br>' + stripeSourceHtml(inv) : ''}</td>
            <td class="ipx-td10 ipx-r ipx-fs12 ipx-b">${formatCurrency(inv.total)}</td>
            <td class="ipx-td10 ipx-r ipx-fs12">${dueDate.toLocaleDateString()}</td>
            <td class="ipx-td10">
              <span style="background:${statusBg};color:#fff;padding:3px 8px;border-radius:3px;font-size:10px;font-weight:700;text-transform:uppercase;">${escHtml(inv.status)}</span>
            </td>
            <td class="ipx-td10">
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
      container.innerHTML = `<div class="ipx-err">Failed to load invoices</div>`;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UI HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build invoice HTML for email
   */
  // opts.payUrl — the Pay Online link, already through _homeownerPayUrl (the
  // Kentucky hold). Absent → no button: this builder never reads the
  // invoice's link fields itself, so no caller can skip the hold by accident.
  function buildInvoiceHtml(invoice, opts) {
    const _payUrl = (opts && opts.payUrl) || '';
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
    // Lines, then Subtotal / Sales tax / Rounding / Total — rows that add up
    // to the total printed (invoiceDisplayRows, ho-money audit H1). The
    // email used to print the items and jump to "Total" with no tax row.
    const _rows = invoiceDisplayRows(invoice);
    const items = _rows.map((r) => {
      if (r.kind === 'line') {
        return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #eee;">${_esc(r.label)}</td>
          <td style="text-align:right;padding:8px;border-bottom:1px solid #eee;">${_esc(r.quantity)}</td>
          <td style="text-align:right;padding:8px;border-bottom:1px solid #eee;">${formatCurrency(r.unitPrice)}</td>
          <td style="text-align:right;padding:8px;border-bottom:1px solid #eee;font-weight:700;">${formatCurrency(r.amount)}</td>
        </tr>`;
      }
      // Classes from the email's own <style> block (.sum / .b / .rule / .big).
      const cls = 'sum'
        + ((r.kind === 'total' || r.kind === 'subtotal' || r.kind === 'jobTotal') ? ' b' : '')
        + ((r.kind === 'subtotal' || r.kind === 'total') ? ' rule' : '')
        + (r.kind === 'total' ? ' big' : '');
      return `
        <tr class="${cls}">
          <td colspan="3">${_esc(r.label)}:</td>
          <td>${formatCurrency(r.amount)}</td>
        </tr>`;
    }).join('');
    // "Due now" (ho-money audit M6): the amount Pay Online charges — the rest
    // of the deposit while it is unmet, else the balance (the rows
    // paymentSummaryRows prints, the rule functions/invoice-charge.js
    // charges). It becomes the ONE emphasised row; "Total owed" read as the
    // ask while the link charged the deposit. Only beside a way to pay: no
    // link and no Zelle — e.g. the Kentucky insurance hold, which blanks
    // both — prints no "Due now" (nothing may be demanded inside the hold).
    const _pay = paymentSummaryRows(invoice);
    const _depDue = _pay.filter((r) => /^Deposit due/.test(r.label))[0];
    const _balRow = _pay.filter((r) => r.label === 'Balance Due')[0];
    const _dueNow = _depDue ? _depDue.amount : (_balRow ? _balRow.amount : (Number(invoice.total) || 0));
    const _showDueNow = !!(_safeUrl(_payUrl) || (opts && opts.zelle)) && _dueNow > 0;
    const _num = nbdInvoiceNumberOf(invoice) || String((opts && opts.invoiceId) || '');
    const _issuedMs = _tsMs(invoice.createdAt);
    const _issued = new Date(Number.isFinite(_issuedMs) ? _issuedMs : Date.now())
      .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const _hello = String(invoice.customerName || '').trim().split(/\s+/)[0] || '';

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
            .paynote { margin: 10px 0 0; font-size: 13px; color: #555; }
            .sum td, .duenow td { text-align: right; padding: 10px; }
            .sum.b td { font-weight: 700; }
            .sum.rule { border-top: 2px solid #BD5728; }
            .sum.big td { font-size: 16px; }
            .duenow td { font-weight: 700; font-size: 16px; color: var(--orange,#BD5728); }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="brand">${_esc(_invoiceCompany())}</div>
              <p style="margin:5px 0 0 0;color:#999;">Invoice${_num ? ' ' + _esc(_num) : ''} · ${_esc(_issued)}</p>
            </div>
            <p>Hello${_hello ? ' ' + _esc(_hello) : ''},</p>
            <p>Here is your invoice. Every line is below and adds up to the total.</p>
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
                ${_pay.map((r) => (r.strong && !_showDueNow) ? `
                <tr>
                  <td colspan="3" style="text-align: right; padding: 10px; font-weight: 700; color:var(--orange,#BD5728);">${_esc(r.label)}:</td>
                  <td style="text-align: right; padding: 10px; font-weight: 700; color:var(--orange,#BD5728);">${formatCurrency(r.amount)}</td>
                </tr>` : `
                <tr>
                  <td colspan="3" style="text-align: right; padding: 10px;">${_esc(r.label)}:</td>
                  <td style="text-align: right; padding: 10px;">${formatCurrency(r.amount)}</td>
                </tr>`).join('')}
                ${_showDueNow ? `
                <tr class="duenow" data-due-now>
                  <td colspan="3">Due now:</td>
                  <td>${formatCurrency(_dueNow)}</td>
                </tr>` : ''}
              </tbody>
            </table>
            <p><strong>Payment Terms:</strong> ${_esc(invoice.terms)}</p>
            ${_safeUrl(_payUrl) ? `<a href="${_esc(_safeUrl(_payUrl))}" class="cta">Pay Online</a>
            ${(opts && opts.payByBank === true) ? `<p class="paynote">${_esc(PAY_BY_BANK_LINE)}</p>` : ''}` : ''}
            ${(opts && opts.zelle) ? `<p class="paynote">Zelle: ${_esc(opts.zelle)}</p>` : ''}
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
      <div class="modal ipx-max420">
        <div class="ipx-title">Create Invoice from Estimate</div>
        <label class="ipx-label">Estimate</label>
        ${leadEstimates.length ? `
        <select id="nbd-inv-est-pick" class="fi ipx-mt6">
          ${estOptions}
          <option value="__manual__">Other — enter an estimate ID…</option>
        </select>` : `
        <div class="ipx-help">This customer has no estimates yet. Build one first (Template Quote or Estimates), then invoice from it — or paste an estimate ID below.</div>`}
        <input id="nbd-inv-est-id" type="text" class="fi ipx-mt6" placeholder="Enter estimate ID..."${leadEstimates.length ? ' hidden' : ''}>
        <div class="ipx-actions">
          <button id="nbd-inv-cancel" type="button" class="btn btn-ghost ipx-grow-btn">Cancel</button>
          <button id="nbd-inv-create" type="button" class="btn btn-orange ipx-grow-btn">Create Invoice</button>
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
        // One live invoice per job (nbd:job-billing): a job that already has
        // its live invoice gets THAT one opened, never a second bill.
        const made = await createOrOpenJobInvoice(estimateId);
        const invoiceId = made.invoiceId;
        if (made.reused) {
          showToast(made.reason === 'billed_in_full'
            ? 'This job is already invoiced in full — opened its invoice.'
            : 'This job already has an open invoice — opened it instead of billing twice.', 'info');
          showInvoiceDetailModal(invoiceId);
          return;
        }

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
      <div class="modal ipx-max380">
        <div class="ipx-title">Send Invoice</div>
        <div class="ipx-m12 ipx-mb16">How would you like to send this invoice?</div>
        <div class="ipx-col8">
          <button type="button" class="nbd-send-method btn btn-ghost ipx-choice" data-method="email">📧 Send via Email</button>
          <button type="button" class="nbd-send-method btn btn-ghost ipx-choice" data-method="sms">💬 Send via SMS</button>
          <button type="button" class="nbd-send-method btn btn-ghost ipx-choice" data-method="portal">🌐 Share Customer Portal Link</button>
        </div>
        <button id="nbd-send-cancel" type="button" class="btn btn-ghost ipx-btn-full">Cancel</button>
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
      <div class="ipx-max920">
        <div class="ipx-end8">
          <button id="nbd-inv-detail-close" type="button" class="btn btn-ghost">✕ Close</button>
        </div>
        <div id="nbd-inv-detail-host"></div>
      </div>
    `;
    const closeModal = openOverlay(overlay);
    overlay.querySelector('#nbd-inv-detail-close').onclick = () => closeModal();
    renderInvoiceDetail('nbd-inv-detail-host', invoiceId);
  }

  // ── Payment proof: upload / attach / view (2026-09-29) ─────────────────
  function _currentUid() {
    return (window._auth && window._auth.currentUser && window._auth.currentUser.uid)
      || (window.auth && window.auth.currentUser && window.auth.currentUser.uid)
      || (window._user && window._user.uid) || '';
  }
  function _toast(msg, kind) {
    if (typeof showToast === 'function') showToast(msg, kind);
    else if (typeof window !== 'undefined' && typeof window.showToast === 'function') window.showToast(msg, kind);
  }

  // Shrink a big phone photo before upload — same recipe as expenses.js
  // downscaleImage (max 1600px, JPEG 0.85). PDFs, HEIC, small images and any
  // failure pass the ORIGINAL file through unchanged.
  function _downscaleProofImage(file) {
    return new Promise(function (resolve) {
      try {
        const t = (file && file.type) || '';
        if (!/^image\/(jpeg|png|webp)$/.test(t) || file.size < 1200 * 1024) return resolve(file);
        const url = URL.createObjectURL(file);
        const img = new Image();
        let done = false;
        const finish = (out) => { if (done) return; done = true; try { URL.revokeObjectURL(url); } catch (e) {} resolve(out); };
        const timer = setTimeout(() => finish(file), 8000);
        img.onload = function () {
          try {
            const max = 1600, scale = Math.min(1, max / Math.max(img.width, img.height));
            if (scale >= 1) { clearTimeout(timer); return finish(file); }
            const cv = document.createElement('canvas');
            cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
            cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
            cv.toBlob((blob) => { clearTimeout(timer); finish(blob && blob.size < file.size ? blob : file); }, 'image/jpeg', 0.85);
          } catch (e) { clearTimeout(timer); finish(file); }
        };
        img.onerror = function () { clearTimeout(timer); finish(file); };
        img.src = url;
      } catch (e) { resolve(file); }
    });
  }

  // Upload one proof file to payment-proofs/{uid}/{invoiceId}/{ts}_{name}.
  // Returns { proofStoragePath, proofName }.
  async function uploadPaymentProof(invoiceId, file) {
    const chk = proofFileCheck(file);
    if (!chk.ok || chk.none) throw new Error(chk.reason || 'No file');
    const uid = _currentUid();
    if (!uid) throw new Error('Not signed in');
    if (!window.storage || !window.ref || !window.uploadBytes) throw new Error('storage unavailable');
    const body = await _downscaleProofImage(file);
    const path = paymentProofPath(uid, invoiceId, Date.now(), file.name);
    await window.uploadBytes(window.ref(window.storage, path), body,
      { contentType: (body && body.type) || file.type || 'application/octet-stream' });
    return { proofStoragePath: path, proofName: String(file.name || 'proof') };
  }

  // A hidden <input type=file>; resolves with the chosen File or null.
  function _pickProofFile(capture) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = capture ? 'image/*' : 'image/*,application/pdf';
      if (capture) inp.setAttribute('capture', 'environment');
      inp.style.display = 'none';
      inp.addEventListener('change', () => {
        const f = inp.files && inp.files[0];
        inp.remove();
        resolve(f || null);
      });
      document.body.appendChild(inp);
      inp.click();
    });
  }

  /**
   * "📎 Attach proof" on a past manual payment that has none. The payments[]
   * entry is updated IN PLACE inside a transaction (read-modify-write when the
   * page has no runTransaction), matched by index + recordedAt / at+amount,
   * so a payment another device logged meanwhile is never clobbered.
   */
  async function attachProofUI(invoiceId, index, recordedAtMs) {
    if (!invoiceId) return false;
    const db = getDb();
    const invRef = window.doc(db, 'invoices', invoiceId);
    let key;
    try {
      const snap = await window.getDoc(invRef);
      const pays = (snap.exists() && Array.isArray(snap.data().payments)) ? snap.data().payments : [];
      const p = pays[index];
      if (!p) throw new Error('That payment changed — reopen the invoice and try again');
      key = paymentKey(p);
      if (Number.isFinite(recordedAtMs) && key.recordedAtMs !== recordedAtMs) {
        throw new Error('That payment changed — reopen the invoice and try again');
      }
      if (p.method === 'stripe') throw new Error('Stripe payments carry their own receipt');
    } catch (e) { _toast(e.message || 'Could not load the invoice', 'error'); return false; }

    const file = await _pickProofFile(false);
    if (!file) return false;
    const chk = proofFileCheck(file);
    if (!chk.ok) { _toast(chk.reason, 'error'); return false; }
    try {
      _toast('Uploading proof…', 'info');
      const proof = await uploadPaymentProof(invoiceId, file);
      if (typeof window.runTransaction === 'function') {
        await window.runTransaction(db, async (tx) => {
          const s = await tx.get(invRef);
          if (!s.exists()) throw new Error('Invoice not found');
          const next = attachProofToPayments(s.data().payments || [], index, key, proof);
          tx.update(invRef, { payments: next, updatedAt: new Date() });
        });
      } else {
        const s = await window.getDoc(invRef);
        if (!s.exists()) throw new Error('Invoice not found');
        const next = attachProofToPayments(s.data().payments || [], index, key, proof);
        await window.updateDoc(invRef, { payments: next, updatedAt: new Date() });
      }
      _toast('Proof attached', 'success');
      if (document.getElementById('nbd-inv-detail-host')) renderInvoiceDetail('nbd-inv-detail-host', invoiceId);
      return true;
    } catch (e) {
      console.warn('[invoice-pipeline] attach proof failed', e && (e.code || e.message));
      _toast(/permission/i.test((e && (e.code || e.message)) || '')
        ? 'You do not have permission to attach proof here'
        : ('Could not attach the proof: ' + ((e && e.message) || 'try again')), 'error');
      return false;
    }
  }

  // "📎 View" — opens the proof through getDownloadURL (Storage rules apply:
  // the uploader and a platform admin can read it). The tab is opened
  // synchronously first so a phone's popup blocker doesn't eat it after the
  // await.
  async function viewProofUI(invoiceId, index) {
    let w = null;
    try { w = window.open('about:blank', '_blank'); if (w) w.opener = null; } catch (_) { w = null; }
    try {
      const snap = await window.getDoc(window.doc(getDb(), 'invoices', invoiceId));
      const pays = (snap.exists() && Array.isArray(snap.data().payments)) ? snap.data().payments : [];
      const path = pays[index] && pays[index].proofStoragePath;
      if (!path || !window.getDownloadURL || !window.ref) throw new Error('no proof');
      const url = await window.getDownloadURL(window.ref(window.storage, path));
      if (w) w.location.href = url; else window.open(url, '_blank', 'noopener');
    } catch (e) {
      if (w) { try { w.close(); } catch (_) {} }
      _toast('Could not open the proof', 'error');
    }
  }

  /**
   * UI: record a manual payment (check, Zelle, cash, ACH, other) with an
   * optional reference, note and proof attachment. Built for one hand on a
   * phone: big method buttons, amount pre-filled with the balance due, date
   * defaulting to today (editable — a check received yesterday is logged
   * today), and proof recommended but never required.
   */
  async function markPaidUI(invoiceId) {
    let balanceDefault = '';
    try {
      const snap = await window.getDoc(window.doc(getDb(), 'invoices', invoiceId));
      if (snap.exists()) {
        const d = snap.data();
        const bal = (d.balanceDue != null) ? d.balanceDue : d.total;
        const c = toCents(Math.max(0, Number(bal) || 0));
        if (Number.isFinite(c)) balanceDefault = (c / 100).toFixed(2);
      }
    } catch (_) { /* default to blank */ }

    const today = localDateInputValue(new Date());
    const methodBtns = PAYMENT_METHODS.map((m, i) => `
          <button type="button" class="nbd-mp-method btn btn-ghost ipx-method" data-method="${escHtml(m.key)}" aria-pressed="${i === 0 ? 'true' : 'false'}"
           >${escHtml(m.icon)} ${escHtml(m.label)}</button>`).join('');
    const lbl = 'font-size:10px;font-weight:600;color:var(--m);text-transform:uppercase;letter-spacing:.08em;';

    destroyExisting('nbd-markpaid-modal');
    const overlay = document.createElement('div');
    overlay.id = 'nbd-markpaid-modal';
    overlay.className = 'modal-bg';
    // Stacks above the (also-open) invoice detail overlay.
    overlay.style.cssText = 'z-index:var(--z-overlay-top,10001);';
    overlay.innerHTML = `
      <style>
        #nbd-markpaid-modal .nbd-mp-method[aria-pressed="true"]{border-color:var(--orange);color:var(--orange);background:rgba(232,114,12,.10);}
        #nbd-markpaid-modal .fi{font-size:16px;min-height:44px;}
      </style>
      <div class="modal ipx-max420w">
        <div class="ipx-title ipx-title-14">Record Payment</div>
        <div role="group" aria-label="Payment method" class="ipx-g2 ipx-mb14">${methodBtns}
        </div>
        <label for="nbd-mp-amount" style="${lbl}">Amount</label>
        <input id="nbd-mp-amount" type="number" inputmode="decimal" class="fi ipx-field" step="0.01" min="0" value="${escHtml(balanceDefault)}">
        <label for="nbd-mp-date" style="${lbl}">Date received</label>
        <input id="nbd-mp-date" type="date" class="fi ipx-field" value="${escHtml(today)}" max="${escHtml(today)}">
        <label for="nbd-mp-ref" id="nbd-mp-ref-label" style="${lbl}">${escHtml(PAYMENT_METHODS[0].refLabel)}</label>
        <input id="nbd-mp-ref" type="text" class="fi ipx-field" maxlength="${PAYMENT_REF_MAX}" autocomplete="off">
        <label for="nbd-mp-note" style="${lbl}">Note (optional)</label>
        <input id="nbd-mp-note" type="text" class="fi ipx-field" maxlength="${PAYMENT_NOTE_MAX}" autocomplete="off">
        <div style="${lbl}margin-bottom:6px;">Proof — photo or PDF</div>
        <div class="ipx-g2">
          <button type="button" id="nbd-mp-proof-cam" class="btn btn-ghost ipx-btn48">📷 Take photo</button>
          <button type="button" id="nbd-mp-proof-file" class="btn btn-ghost ipx-btn48">📄 Choose file</button>
        </div>
        <div id="nbd-mp-proof-status" data-ip-proof-nudge class="ipx-warn">📎 Proof recommended</div>
        <button id="nbd-mp-save" type="button" class="btn btn-green ipx-btn-save">Save payment</button>
        <button id="nbd-mp-cancel" type="button" class="btn btn-ghost ipx-btn-full44">Cancel</button>
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

      let method = PAYMENT_METHODS[0].key;
      let proofFile = null;
      const $ = (sel) => overlay.querySelector(sel);
      const status = $('#nbd-mp-proof-status');
      const paintProof = () => {
        if (proofFile) {
          status.style.color = 'var(--green,#1a7f37)';
          status.textContent = '📎 ' + (proofFile.name || 'proof') + ' attached';
        } else {
          status.style.color = 'var(--orange)';
          status.textContent = '📎 Proof recommended';
        }
      };

      overlay.querySelectorAll('.nbd-mp-method').forEach(btn => {
        btn.onclick = () => {
          method = btn.dataset.method;
          overlay.querySelectorAll('.nbd-mp-method').forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
          const m = PAYMENT_METHODS.find(x => x.key === method);
          $('#nbd-mp-ref-label').textContent = m ? m.refLabel : 'Reference';
        };
      });

      const pick = async (capture) => {
        const f = await _pickProofFile(capture);
        if (!f) return;
        const chk = proofFileCheck(f);
        if (!chk.ok) { _toast(chk.reason, 'error'); return; }
        proofFile = f;
        paintProof();
      };
      $('#nbd-mp-proof-cam').onclick = () => { pick(true); };
      $('#nbd-mp-proof-file').onclick = () => { pick(false); };

      const saveBtn = $('#nbd-mp-save');
      saveBtn.onclick = async () => {
        const amount = $('#nbd-mp-amount').value;
        if (!(toCents(amount) > 0)) {
          _toast('Enter a valid amount', 'error');
          return;                       // stay open; do NOT settle
        }
        const at = receivedAtFromDateInput($('#nbd-mp-date').value, new Date());
        if (!at) {
          _toast('Pick the date the payment was received (not a future date)', 'error');
          return;
        }
        if (!isManualPaymentMethod(method)) { _toast('Pick a payment method', 'error'); return; }
        const details = { at, reference: $('#nbd-mp-ref').value, note: $('#nbd-mp-note').value };
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        // Proof first, so the ledger entry can carry its path. An upload that
        // fails never blocks the payment — it saves without proof and the
        // rep attaches it later from Payment History.
        if (proofFile) {
          try {
            _toast('Uploading proof…', 'info');
            Object.assign(details, await uploadPaymentProof(invoiceId, proofFile));
          } catch (upErr) {
            console.warn('[invoice-pipeline] proof upload failed', upErr && (upErr.code || upErr.message));
            _toast('Proof upload failed — saving the payment without it. Attach it from Payment History.', 'warning');
          }
        }
        try {
          _toast('Recording payment...', 'info');
          await markPaid(invoiceId, amount, method, details);
          _toast('Payment recorded', 'success');
          mo.disconnect();
          closeModal();
          if (document.getElementById('nbd-inv-detail-host')) renderInvoiceDetail('nbd-inv-detail-host', invoiceId);
          settle(true);
        } catch (error) {
          // Stay open with everything the rep typed, so a retry is one tap.
          _toast(`Error: ${error.message}`, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save payment';
        }
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // RECORD PAYMENT on a job — with or without an invoice (2026-10-03)
  // ═══════════════════════════════════════════════════════════════════════
  //
  // A read-only prod audit (2026-10-03) found 30 jobs at install or later and
  // only 4 with invoices; not one check, Zelle or cash payment had ever been
  // recorded. Mark Paid needs an EXISTING invoice, and making one needs an
  // estimate — none of the 30 won leads is linked to one. So the money that
  // did come in had nowhere to go, and revenue (collected only) read $3,650.
  //
  // One sheet on the customer page: amount, method, payer, date, reference.
  // It records against the job's live invoice; with none, it makes the
  // invoice first — from the primary estimate, else from the lead's job
  // value, which the rep must CONFIRM in the sheet (never a guess, never a
  // backfill) — then records the payment through markPaid, unchanged.

  /**
   * Where a payment for this lead's job lands. Pure.
   *   { lead, invoices, estimate?, estimateId?, totalsOpts? }
   * → { kind: 'existing', invoices: [live…] }   pay the job's live invoice
   *   | { kind: 'estimate', estimateId, totalCents }   make it from the estimate
   *   | { kind: 'jobValue', suggestedCents }    the rep confirms a total
   */
  function recordPaymentTarget(ctx) {
    ctx = ctx || {};
    const lead = ctx.lead || {};
    const jobId = _jbJobId(lead.activeJobId);
    const live = jobInvoicesOf(ctx.invoices, jobId).filter(isLiveInvoice);
    if (live.length) return { kind: 'existing', invoices: live, jobId };
    const estId = (typeof ctx.estimateId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(ctx.estimateId)) ? ctx.estimateId : null;
    if (estId && ctx.estimate && ctx.estimate.deleted !== true) {
      const t = invoiceTotalsFromEstimate(ctx.estimate, ctx.totalsOpts || {});
      const c = Math.round(Number(t.total) * 100);
      if (c > 0) return { kind: 'estimate', estimateId: estId, totalCents: c, jobId };
    }
    const jv = toCents(Math.max(0, Number(lead.jobValue) || 0));
    return { kind: 'jobValue', suggestedCents: Number.isFinite(jv) && jv > 0 ? jv : 0, jobId };
  }

  /**
   * The invoice made from a CONFIRMED job total (no estimate on file). Pure.
   * One line, no tax split (a job value is the all-in price), the job's
   * earlier invoices credited (nbd:job-billing), the same fields
   * createInvoiceFromEstimate writes, and who confirmed the total.
   */
  function jobValueInvoiceDoc(o) {
    o = o || {};
    const lead = o.lead || {};
    const totalC = Math.round(Number(o.totalCents) || 0);
    if (!(totalC > 0)) throw new Error('Enter the job total');
    const now = o.now instanceof Date ? o.now : new Date();
    const dr = o.depRule || null;
    let base = { items: [{ description: 'Roofing work — job total', quantity: 1, unitPrice: totalC / 100, total: totalC / 100 }], subtotal: totalC / 100, tax: 0, total: totalC / 100 };
    const credits = Array.isArray(o.credits) ? o.credits : [];
    if (credits.length) base = applyJobCredits(base, credits);
    const J = o.J || null;
    const ky = !!(J && typeof J.classifyLead === 'function' && (J.classifyLead(lead) || {}).kyInsurance === true);
    const doc = {
      leadId: o.leadId || null,
      estimateId: null,
      customerId: lead.customerId || null,
      customerName: leadDisplayName(lead),
      customerEmail: lead.email || '',
      customerPhone: lead.phone || '',
      status: 'draft',
      items: base.items,
      subtotal: base.subtotal,
      tax: 0,
      taxRate: 0,
      total: base.total,
      supplementTotal: 0,
      depositAmount: 0,
      depositPaid: false,
      amountPaid: 0,
      balanceDue: base.total,
      stripeInvoiceId: null,
      stripePaymentLink: null,
      // (The fallback is only for a bare unit-test sandbox; pinned to
      // INVOICE_DUE_DAYS by tests/money-getting-paid-2026-10-03.test.js.)
      dueDate: new Date(dr ? dr.invoiceDueDateMs(now.getTime()) : now.getTime() + 7 * 86400000),
      sentAt: null,
      paidAt: null,
      viewedAt: null,
      notes: '',
      depositTerms: '',
      depositRepNote: '',
      kyInsuranceHold: ky,
      emergencyServices: false,
      terms: dr ? dr.netTermsText() : 'Net 7.',
      createdAt: now,
      updatedAt: now,
      createdBy: o.uid || 'system',
      companyId: o.companyId || o.uid || null,
      jobId: _jbJobId(o.jobId),
      source: 'record_payment',
      totalConfirmedBy: o.uid || null,
      totalConfirmedAt: now,
    };
    if (credits.length) {
      doc.kind = 'final';
      doc.creditTotal = base.creditTotal;
      doc.creditedInvoiceIds = credits.map(c => c.invoiceId).filter(Boolean);
    }
    return doc;
  }

  async function _readEstimate(db, id) {
    if (!id) return null;
    const cached = (window._estimates || []).find(e => e && e.id === id);
    try {
      const s = await window.getDoc(window.doc(db, 'estimates', id));
      if (s.exists()) return Object.assign({ id }, s.data());
    } catch (_) { /* fall back to the page cache */ }
    return cached || null;
  }

  function _totalsOpts() {
    const rows = window.NBDCustomerEstimateRows;
    const cfg = window.NBD_ESTIMATE_CONFIG;
    return {
      estimateValue: (rows && typeof rows.estimateValue === 'function') ? rows.estimateValue : null,
      tierLabel: (cfg && typeof cfg.tierLabel === 'function') ? cfg.tierLabel : null,
    };
  }

  /**
   * The Record Payment sheet's write, without the DOM (tests drive it):
   * resolve / make the job's invoice, then markPaid. o = { leadId, lead,
   * target (recordPaymentTarget), invoiceId (existing), totalCents
   * (jobValue), amount, method, payer, at, reference }.
   * Never emails the customer (2026-10-04): the payment gets a receipt
   * DRAFT and the rep taps "Send receipt" when ready.
   * → invoiceId
   */
  async function recordPaymentCommit(o) {
    o = o || {};
    const db = getDb();
    const target = o.target || {};
    let invoiceId;
    if (target.kind === 'existing') {
      invoiceId = o.invoiceId || (target.invoices && target.invoices[0] && target.invoices[0].id);
    } else if (target.kind === 'estimate') {
      invoiceId = (await createOrOpenJobInvoice(target.estimateId)).invoiceId;
    } else {
      // Re-read the job's invoices right before writing: another device
      // may have made one since the sheet opened.
      const fresh = await _loadLeadInvoices(db, o.leadId);
      const plan = planJobInvoice(o.totalCents, fresh, target.jobId);
      if (plan.action === 'open') {
        invoiceId = plan.invoiceId;
      } else {
        const uid = _currentUid();
        const doc = jobValueInvoiceDoc({
          lead: o.lead, leadId: o.leadId, totalCents: o.totalCents, jobId: target.jobId, credits: plan.credits, uid,
          companyId: (window._userClaims && window._userClaims.companyId) || uid,
          depRule: window.NBDDepositRule || null, J: window.NBDJurisdiction || null, now: new Date(),
        });
        invoiceId = (await window.addDoc(window.collection(db, 'invoices'), doc)).id;
      }
    }
    if (!invoiceId) throw new Error('No invoice to record the payment on');
    const cur = await window.getDoc(window.doc(db, 'invoices', invoiceId));
    if (cur.exists() && String((cur.data() || {}).status || '') === 'paid') {
      throw new Error('The invoice for this job is already paid in full — record extra money on the invoice itself.');
    }
    await markPaid(invoiceId, o.amount, o.method, {
      at: o.at, reference: o.reference, payer: o.payer, basis: o.basis,
    });
    return invoiceId;
  }

  /**
   * UI: the Record Payment sheet. Resolves true once a payment is recorded,
   * false when dismissed. Nothing is sent to the homeowner from here: the
   * payment's receipt is a draft until the rep taps Send receipt.
   */
  /**
   * Everything the Record Payment sheet reads before it opens: the lead, its
   * job's invoices, the primary estimate and where a payment would land
   * (recordPaymentTarget). Shared with the "Catch up my numbers" screen's
   * Paid-in-full shortcut (catchup.js) so both resolve the job total the
   * same way. Throws when the lead or its invoices cannot be read.
   */
  async function recordPaymentContext(leadId) {
    const db = getDb();
    const ls = await window.getDoc(window.doc(db, 'leads', leadId));
    const lead = ls.exists() ? Object.assign({ id: leadId }, ls.data()) : null;
    if (!lead) throw new Error('Customer not found');
    const invoices = await _loadLeadInvoices(db, leadId);
    const estId = lead.primaryEstimateId
      || ((window._estimates || []).find(e => e && e.leadId === leadId && e.deleted !== true) || {}).id || null;
    const estimate = estId ? await _readEstimate(db, estId) : null;
    const target = recordPaymentTarget({ lead, invoices, estimate, estimateId: estimate && estimate.id, totalsOpts: _totalsOpts() });
    return { lead, invoices, estimate, target };
  }

  /**
   * opts.noReceipt (2026-10-04, the catch-up screen) is accepted and needs
   * nothing: this sheet never emails anyone (the receipt is a draft until
   * the rep taps Send receipt), so Jo back-entering old checks from that
   * screen cannot email a customer.
   */
  async function recordPaymentUI(leadId, opts) {
    if (!leadId) return false;
    let lead = null, target = null;
    try {
      ({ lead, target } = await recordPaymentContext(leadId));
    } catch (e) {
      _toast('Could not load the invoices for this customer — try again.', 'error');
      return false;
    }

    const today = localDateInputValue(new Date());
    const fmt = (c) => formatCurrency((Number(c) || 0) / 100);
    let targetHtml = '';
    let amountDefault = '';
    if (target.kind === 'existing') {
      const opts = target.invoices.map((inv, i) => {
        const bal = (inv.balanceDue != null) ? inv.balanceDue : inv.total;
        return `<option value="${escHtml(inv.id)}"${i === 0 ? ' selected' : ''}>${escHtml(formatCurrency(bal))} owed · ${escHtml(String(inv.status || 'draft'))} · ${escHtml(String(inv.id).slice(0, 8))}</option>`;
      }).join('');
      const first = target.invoices[0];
      const firstBal = (first.balanceDue != null) ? first.balanceDue : first.total;
      const c = toCents(Math.max(0, Number(firstBal) || 0));
      if (Number.isFinite(c) && c > 0) amountDefault = (c / 100).toFixed(2);
      targetHtml = target.invoices.length > 1
        ? `<label for="nbd-rp-inv" class="ipx-label">Invoice</label>
           <select id="nbd-rp-inv" class="fi ipx-field ipx-rp-input">${opts}</select>`
        : `<div class="ipx-rp-target" data-rp-target="existing">Applies to the open invoice — ${escHtml(formatCurrency(firstBal))} owed.</div>`;
    } else if (target.kind === 'estimate') {
      targetHtml = `<div class="ipx-rp-target" data-rp-target="estimate">No invoice yet — saving makes one from the estimate (${escHtml(fmt(target.totalCents))}), then records this payment.</div>`;
    } else {
      targetHtml = `<div class="ipx-rp-target" data-rp-target="jobValue">No invoice and no estimate on file. Confirm the job total — saving makes the invoice, then records this payment.</div>
        <label for="nbd-rp-total" class="ipx-label">Job total</label>
        <input id="nbd-rp-total" type="number" inputmode="decimal" step="0.01" min="0" class="fi ipx-field ipx-rp-input" value="${target.suggestedCents ? escHtml((target.suggestedCents / 100).toFixed(2)) : ''}">
        <label class="ipx-rp-confirm"><input id="nbd-rp-confirm" type="checkbox" class="ipx-rp-check"> This is the job total</label>`;
    }

    const methodBtns = PAYMENT_METHODS.map((m, i) => `
          <button type="button" class="nbd-rp-method btn btn-ghost ipx-method ipx-rp-pick" data-method="${escHtml(m.key)}" aria-pressed="${i === 0 ? 'true' : 'false'}">${escHtml(m.icon)} ${escHtml(m.label)}</button>`).join('');
    const payerBtns = PAYERS.map((p, i) => `
          <button type="button" class="nbd-rp-payer btn btn-ghost ipx-rp-pick" data-payer="${escHtml(p.key)}" aria-pressed="${i === 0 ? 'true' : 'false'}">${escHtml(p.label)}</button>`).join('');

    destroyExisting('nbd-recordpay-modal');
    const overlay = document.createElement('div');
    overlay.id = 'nbd-recordpay-modal';
    overlay.className = 'modal-bg ipx-rp-bg';
    overlay.innerHTML = `
      <div class="modal ipx-max420w ipx-rp" role="dialog" aria-modal="true" aria-labelledby="nbd-rp-title">
        <div id="nbd-rp-title" class="ipx-title ipx-title-14">Record payment</div>
        ${targetHtml}
        <div class="ipx-label ipx-rp-k">Method</div>
        <div role="group" aria-label="Payment method" class="ipx-g2 ipx-mb14">${methodBtns}
        </div>
        <div class="ipx-label ipx-rp-k">Paid by</div>
        <div role="group" aria-label="Who paid" class="ipx-rp-payers ipx-mb14">${payerBtns}
        </div>
        <label for="nbd-rp-amount" class="ipx-label">Amount</label>
        <input id="nbd-rp-amount" type="number" inputmode="decimal" step="0.01" min="0" class="fi ipx-field ipx-rp-input" value="${escHtml(amountDefault)}">
        <label for="nbd-rp-date" class="ipx-label">Date received</label>
        <input id="nbd-rp-date" type="date" class="fi ipx-field ipx-rp-input" value="${escHtml(today)}" max="${escHtml(today)}">
        <label for="nbd-rp-ref" id="nbd-rp-ref-label" class="ipx-label">${escHtml(PAYMENT_METHODS[0].refLabel)}</label>
        <input id="nbd-rp-ref" type="text" class="fi ipx-field ipx-rp-input" maxlength="${PAYMENT_REF_MAX}" autocomplete="off">
        <div class="ipx-m11 ipx-rp-note" data-rp-receipt-note>A receipt is drafted — nothing is sent until you tap Send receipt.</div>
        <button id="nbd-rp-save" type="button" class="btn btn-green ipx-btn-save">Save payment</button>
        <button id="nbd-rp-cancel" type="button" class="btn btn-ghost ipx-btn-full44">Cancel</button>
      </div>
    `;
    const closeModal = openOverlay(overlay);

    return await new Promise((resolve) => {
      let settled = false;
      const settle = (v) => { if (!settled) { settled = true; resolve(v); } };
      const mo = new MutationObserver(() => {
        if (!document.body.contains(overlay)) { mo.disconnect(); settle(false); }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      const $ = (sel) => overlay.querySelector(sel);
      let method = PAYMENT_METHODS[0].key;
      let payer = PAYERS[0].key;
      overlay.querySelectorAll('.nbd-rp-method').forEach(btn => {
        btn.addEventListener('click', () => {
          method = btn.dataset.method;
          overlay.querySelectorAll('.nbd-rp-method').forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
          const m = PAYMENT_METHODS.find(x => x.key === method);
          $('#nbd-rp-ref-label').textContent = m ? m.refLabel : 'Reference';
        });
      });
      overlay.querySelectorAll('.nbd-rp-payer').forEach(btn => {
        btn.addEventListener('click', () => {
          payer = btn.dataset.payer;
          overlay.querySelectorAll('.nbd-rp-payer').forEach(b => b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'));
        });
      });
      const invSel = $('#nbd-rp-inv');
      if (invSel) {
        invSel.addEventListener('change', () => {
          const inv = target.invoices.find(x => x.id === invSel.value);
          if (!inv) return;
          const c = toCents(Math.max(0, Number(inv.balanceDue != null ? inv.balanceDue : inv.total) || 0));
          if (Number.isFinite(c)) $('#nbd-rp-amount').value = (c / 100).toFixed(2);
        });
      }
      $('#nbd-rp-cancel').addEventListener('click', () => { mo.disconnect(); closeModal(); settle(false); });

      const saveBtn = $('#nbd-rp-save');
      saveBtn.addEventListener('click', async () => {
        const amount = $('#nbd-rp-amount').value;
        if (!(toCents(amount) > 0)) { _toast('Enter a valid amount', 'error'); return; }
        const at = receivedAtFromDateInput($('#nbd-rp-date').value, new Date());
        if (!at) { _toast('Pick the date the payment was received (not a future date)', 'error'); return; }
        if (!isManualPaymentMethod(method)) { _toast('Pick a payment method', 'error'); return; }
        if (!isPayer(payer)) { _toast('Pick who paid', 'error'); return; }
        let totalCents = 0;
        if (target.kind === 'jobValue') {
          totalCents = toCents($('#nbd-rp-total').value);
          if (!(totalCents > 0)) { _toast('Enter the job total', 'error'); return; }
          if (!$('#nbd-rp-confirm').checked) { _toast('Confirm the job total first', 'error'); return; }
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
        try {
          await recordPaymentCommit({
            leadId, lead, target, totalCents, amount, method, payer, at,
            invoiceId: (target.kind === 'existing') ? (invSel ? invSel.value : target.invoices[0].id) : null,
            reference: $('#nbd-rp-ref').value,
          });
          _toast('Payment recorded — receipt drafted (tap Send receipt to email it)', 'success');
          mo.disconnect();
          closeModal();
          settle(true);
        } catch (error) {
          _toast('Error: ' + ((error && error.message) || 'could not record the payment'), 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save payment';
        }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXPORTS
  // ═══════════════════════════════════════════════════════════════════════

  const _api = {
    createInvoiceFromEstimate,
    // Getting paid (2026-10-03, tests/money-getting-paid-2026-10-03.test.js)
    createOrOpenJobInvoice,
    recordPaymentUI,
    recordPaymentCommit,
    // Receipts: drafted, one-tap send (2026-10-04, tests/receipts-zelle-ach-2026-10-04.test.js)
    receiptStateOf,
    receiptKeyOf,
    findReceiptPayment,
    nbdInvoiceNumberOf,
    receiptDetailsOf,
    buildReceiptEmail,
    markReceiptSent,
    sendReceipt,
    sendReceiptUI,
    // Pay by bank (ACH) + Zelle lines (2026-10-04)
    PAY_BY_BANK_LINE,
    zelleTextFor,
    achPendingText,
    recordPaymentTarget,
    recordPaymentContext,
    // The job's invoices, scoped like every other read here (catchup.js
    // snapshots them before and after a payment so Undo can reverse it).
    loadLeadInvoices: (leadId) => _loadLeadInvoices(getDb(), leadId),
    jobValueInvoiceDoc,
    PAYERS,
    isPartPaid,
    canSendBalance,
    jobInvoicesOf,
    soleJobOf,
    isLiveInvoice,
    planJobInvoice,
    applyJobCredits,
    homeownerPayUrl: _homeownerPayUrl,
    paymentIdOf,
    paymentTimelineNoteId,
    paymentTimelineText,
    generateStripePaymentLink,
    sendInvoice,
    markPaid,
    markPaidUI,
    attachProofUI,
    viewProofUI,
    uploadPaymentProof,
    // Manual-payment pure helpers (tests/mark-paid-methods-2026-09-29.test.js)
    PAYMENT_METHODS,
    PROOF_MAX_BYTES,
    isManualPaymentMethod,
    paymentMethodLabel,
    escHtml,
    toCents,
    centsToDollars,
    localDateInputValue,
    receivedAtFromDateInput,
    paymentProofPath,
    proofFileCheck,
    buildManualPaymentEntry,
    PAYMENT_BASIS_CATCHUP,
    applyPaymentToInvoice,
    paymentKey,
    findPaymentIndex,
    attachProofToPayments,
    paymentHistoryRows,
    paymentHistoryHtml,
    renderInvoicePanel,
    renderInvoiceDetail,
    renderInvoiceList,
    connectStripeNoteHtml,
    createInvoiceUI,
    sendInvoiceUI,
    showInvoiceDetailModal,
    createPayLinkUI,
    markEmergencyUI,
    // Pure helpers, exported for unit tests
    // (tests/invoice-pipeline.test.js) — no DOM/Firestore dependency.
    invoiceTotalsFromEstimate,
    invoiceDisplayRows,
    isOwedInvoice,
    owedDollarsOf,
    supplementBillableAmount,
    selectBillableSupplements,
    applySupplementsToTotals,
    buildRowItems,
    // Bill-To name resolution (estimate#9, 2026-09-25) — pure, unit-testable.
    resolveCustomerName,
    invoiceCustomerName,
    isDepositDraft,
    depositDraftChipHtml,
    // buildInvoiceHtml takes a plain invoice object and formatCurrency is a
    // local pure function — no DOM/Firestore dependency either, exported the
    // same way for the deposit/balance display regression test.
    buildInvoiceHtml,
    paymentSummaryRows
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
  // true only when the text really reached the clipboard: the async API, then
  // the legacy execCommand copy (portal-link-helpers.js copyForLead's layers).
  async function _copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fall through */ }
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) { return false; }
  }
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
        case 'attachProof': {
          const idx = parseInt(t.dataset.ipIdx, 10);
          const rec = t.dataset.ipRec != null ? Number(t.dataset.ipRec) : NaN;
          if (typeof IP.attachProofUI === 'function' && Number.isInteger(idx)) IP.attachProofUI(id, idx, rec);
          break;
        }
        case 'sendReceipt': {
          const key = t.dataset.ipPay;
          if (typeof IP.sendReceiptUI === 'function' && id && key) IP.sendReceiptUI(id, key);
          break;
        }
        case 'viewProof': {
          const idx = parseInt(t.dataset.ipIdx, 10);
          if (typeof IP.viewProofUI === 'function' && Number.isInteger(idx)) IP.viewProofUI(id, idx);
          break;
        }
        case 'createPayLink':   if (typeof IP.createPayLinkUI === 'function') IP.createPayLinkUI(id); break;
        case 'markEmergency':   if (typeof IP.markEmergencyUI === 'function') IP.markEmergencyUI(id); break;
        case 'print':           window.print(); break;
        // "Connect Stripe" on an invoice (2026-10-04): Settings → Billing,
        // where the Stripe Connect card lives.
        case 'connectStripe': {
          // customer.html lazy-loads this file but has no goTo and no Billing
          // panel (review R4-7-8): open the dashboard on Settings → Billing,
          // the same ?settings=billing link Stripe Connect returns to.
          if (typeof window.goTo !== 'function') { window.location.href = '/pro/dashboard.html?settings=billing'; break; }
          window.goTo('settings');
          // Settings hydrates late and opens on Profile: switch once the
          // Billing panel exists, a few times, so Profile cannot win the race.
          let tries = 0;
          (function attempt() {
            const p = document.getElementById('stab-panel-billing');
            if (p && typeof window.switchSettingsTab === 'function') {
              window.switchSettingsTab('billing');
              if (p.style.display === 'block' && tries > 2) return;
            }
            if (++tries < 25) setTimeout(attempt, 120);
          })();
          break;
        }
        case 'copyStripeLink':  {
          // Toast only once the copy has really happened (review R4 F6); a
          // failed copy shows the link so the rep can still send it.
          if (!id) break;
          _copyText(id).then(function (copied) {
            if (typeof showToast !== 'function') return;
            if (copied) showToast('Payment link copied!', 'success');
            else showToast('Couldn\'t copy — payment link: ' + id, 'info');
          });
          break;
        }
        default: console.warn('[invoice-pipeline] no dispatch for', action);
      }
    } catch (e) { console.error('[invoice-pipeline] dispatch ' + action + ' failed:', e); }
  });
})();
