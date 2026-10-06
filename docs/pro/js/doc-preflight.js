/**
 * NBD Pro — Document Pre-Flight Modal
 * ------------------------------------------------------------------
 * A schema-driven review/edit modal that runs BEFORE the document
 * generator fires. The user confirms or edits every field the
 * template will use, decides whether changes persist to the
 * customer record or only to this one document, then submits.
 *
 * Exposes: window.DocPreflight
 *
 * Architecture:
 *   DOC_SCHEMAS[type]  -> sections -> fields (with key, type, source,
 *                                             persist, required, ...)
 *   open(type, customerId)
 *     1. Load lead + estimate + photos via getCustomerDocData()
 *     2. Load any saved per-doc overrides from lead.docOverrides[type]
 *     3. Resolve each field to an initial value via its source
 *     4. Render modal with Hybrid mode (required on top, optional
 *        collapsed)
 *     5. On submit -> validate -> split edits into leadUpdates +
 *        docOverrides -> persist via applyDocEdits() -> call
 *        window.NBDDocGen.generate(type, mergedData)
 *
 * Dependencies (all global):
 *   window.NBDDocGen              — document generator
 *   window.getCustomerDocData()   — data bridge (customer.html)
 *   window.checkPrerequisites()   — prerequisite gate (customer.html)
 *   window._leadDoc               — current lead Firestore doc
 *   window._customerEstimates     — loaded estimates
 *   window._allPhotos             — loaded photos
 *   window.db, doc, updateDoc,
 *     serverTimestamp             — Firestore helpers
 *   window.showToast (optional)
 */

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  // SECTION 1: CONSTANTS & HELPERS
  // ═══════════════════════════════════════════════════════════════

  var MODAL_ID = 'docPreflightModal';
  var MODAL_STYLE_ID = 'docPreflightStyles';

  /**
   * Persist destinations:
   *   'lead'      — updates leads/{id}.<fieldKey> (customer record)
   *   'document'  — updates leads/{id}.docOverrides.<type>.<fieldKey>
   *                 (only used for this doc type going forward)
   *   'ephemeral' — not saved; passed into generate() and forgotten
   */
  var PERSIST = { LEAD: 'lead', DOCUMENT: 'document', EPHEMERAL: 'ephemeral' };

  /**
   * Role options shown in the "Add signer" dropdown. The first three
   * use canonical roles so saved-signature lookup (PR 3) can share
   * data across docs (e.g. homeowner signs contract, sig auto-fills
   * on the next change order). 'other' triggers a label prompt.
   */
  var SIGNER_ROLE_OPTIONS = [
    { role: 'homeowner', label: 'Homeowner' },
    { role: 'rep',       label: 'Rep' },
    { role: 'witness',   label: 'Witness' },
    { role: 'other',     label: 'Other' },
  ];

  /** Tiny utility: escape HTML so user text can't break the modal. */
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Show toast if available, otherwise console. */
  function toast(msg, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type || 'info');
    } else {
      console.log('[DocPreflight]', type || 'info', msg);
    }
  }

  /** Safe get of nested path like "lead.firstName". */
  function getPath(obj, path) {
    if (!obj || !path) return undefined;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  /** Convert date-ish value to yyyy-mm-dd for <input type="date">. */
  function toDateInput(v) {
    if (!v) return '';
    try {
      var d = (v && v.toDate) ? v.toDate() : new Date(v);
      if (isNaN(d.getTime())) return '';
      var y = d.getFullYear();
      var m = String(d.getMonth() + 1).padStart(2, '0');
      var day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    } catch (e) { return ''; }
  }

  /** Format currency for display. */
  function fmtCurrency(v) {
    var n = parseFloat(v);
    if (isNaN(n)) return '';
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 2: FIELD SOURCE RESOLVERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Resolve a field's initial value from its `source` descriptor.
   *
   * Source formats:
   *   "lead.firstName"          — pull from window._leadDoc
   *   "estimate.grandTotal"     — pull from first estimate
   *   "estimate.lineItems"      — map estimate.lineItems to doc line-items
   *   "photos"                  — all photos
   *   "photos.before"           — photos with phase=='before'
   *   "photos.after"            — photos with phase=='after'
   *   "computed.<name>"         — named computed (see computeValue)
   *   "literal:<value>"         — literal default string
   *   any other string          — treated as literal
   *
   * Priority order when hydrating:
   *   1. docOverrides[type][key]  (saved per-doc edits)
   *   2. lead[key]                (if key exists on lead)
   *   3. source resolver
   */
  // Deposit defaults retired by the deposit rule (2026-09-25). A contract
  // generated before the rule persisted its PREFILLS as per-doc overrides —
  // the 50% literal below and jobValue × 0.5. Those were never a rep's
  // choice, so resolveDepositField drops them without the "not carried
  // over" note it shows for a figure a rep did type.
  var RETIRED_SCHEDULE_LITERAL = '50% due upon contract execution; remaining balance due upon substantial completion.';
  function isRetiredDepositDefault(key, v, ctx) {
    if (key === 'paymentSchedule') return String(v == null ? '' : v).trim() === RETIRED_SCHEDULE_LITERAL;
    if (key === 'depositAmount' || key === 'payment1Amount') {
      var lead = (ctx && ctx.lead) || {};
      var est = (ctx && ctx.estimate) || {};
      var jv = parseFloat(lead.jobValue || est.grandTotal || 0);
      return !!jv && String(v) === (jv * 0.5).toFixed(2);
    }
    return false;
  }

  // ── Deposit-rule fields (review of PR #1765, 2026-09-25) ──────────
  // Deposit Amount, the contract's Payment Schedule / Terms sentence and the
  // Payment Agreement's Payment 1 / Payment 2 are DERIVED from deposit-rule.js
  // on the price the form shows. They used to resolve like every other field:
  // prefilled once at open() from lead.jobValue, then saved as a per-doc
  // override on every submit whether or not the rep touched them. So
  //   (a) editing the Contract Price left the old deposit in place, and the
  //       contract printed it as an unlabelled "rep override";
  //   (b) the NEXT contract for the lead reloaded the last contract's dollar
  //       deposit and dollar sentence as if a rep had typed them — after the
  //       price, the job type or the claim had moved — so one binding
  //       contract printed a terms paragraph contradicting its own table.
  // Now a deposit field follows the price until the rep edits it; it is
  // saved only when the rep changed it from the rule's figure, stamped with
  // the basis it was set against (price, mode, deductible, ACV); and a saved
  // one reloads only while that basis still holds. Anything dropped is named
  // in the pre-flight's deposit note, so nothing changes silently.
  var DEPOSIT_SOURCES = {
    'computed.depositAmount': true,   // contract: the deposit at signing
    'computed.depositTerms': true,    // contract: the Payment Schedule / Terms sentence
    'computed.depositPayment1': true, // payment agreement: due at signing
    'computed.depositPayment2': true  // payment agreement: the insurance ACV check
  };
  function isDepositField(field) {
    return !!(field && typeof field.source === 'string' && DEPOSIT_SOURCES[field.source]);
  }

  // Dollars (number or "$1,234.50") → integer cents; blank → null.
  function _depCents(v) {
    if (v == null || v === '') return null;
    var n = (typeof v === 'string') ? Number(v.replace(/[$,\s]/g, '')) : Number(v);
    return isFinite(n) ? Math.round(n * 100) : null;
  }

  // Is this the same value the rule would put there? Money compares by cents
  // (the input hands back a number, the prefill a "4500.00" string); the
  // sentence by its trimmed text.
  function sameDepositValue(key, a, b) {
    if (key === 'paymentSchedule') {
      return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
    }
    return _depCents(a) === _depCents(b);
  }

  // What the rule puts in a deposit field, from a plan (no rep override).
  function depositFieldDefault(source, plan) {
    if (!plan || !(plan.totalCents > 0)) return '';
    var dollars = function (c) { return (c / 100).toFixed(2); };
    switch (source) {
      case 'computed.depositAmount':
        return dollars(plan.depositCents);
      case 'computed.depositTerms':
        return plan.summary || '';
      case 'computed.depositPayment1':
        // Due at signing. On a claim that is the deductible — the ACV check
        // is Payment 2, due when the carrier releases it, not "today" — and
        // blank when nobody has entered the deductible, so the rep must.
        if (plan.mode === 'insurance') {
          return plan.deductibleCents != null ? dollars(Math.min(plan.deductibleCents, plan.totalCents)) : '';
        }
        return dollars(plan.depositCents);
      case 'computed.depositPayment2':
        var acv = (plan.rows || []).filter(function (r) { return r && r.key === 'acv' && r.amountCents != null; })[0];
        return acv ? dollars(acv.amountCents) : '';
    }
    return '';
  }

  // What a saved deposit override was set against. It reloads only while
  // all four still hold.
  function depositBasisOf(plan) {
    if (!plan || !(plan.totalCents > 0)) return null;
    return {
      totalCents: plan.totalCents,
      mode: plan.mode || 'cash',
      deductibleCents: plan.deductibleCents == null ? null : plan.deductibleCents,
      acvCents: plan.acvValueCents == null ? null : plan.acvValueCents
    };
  }
  function sameDepositBasis(saved, now) {
    if (!saved || typeof saved !== 'object' || !now) return false;
    var n = function (v) { return (v == null || v === '') ? null : Number(v); };
    return n(saved.totalCents) === now.totalCents && String(saved.mode) === now.mode
      && n(saved.deductibleCents) === now.deductibleCents && n(saved.acvCents) === now.acvCents;
  }

  function resolveDepositField(field, ctx) {
    var plan = depositPlanFor(ctx, ('depositTotal' in ctx) ? { total: ctx.depositTotal } : {});
    var def = depositFieldDefault(field.source, plan);
    var ov = ctx.overrides;
    if (ov && Object.prototype.hasOwnProperty.call(ov, field.key)) {
      var saved = ov[field.key];
      // A rep's own figure, saved against this same price / mode / claim.
      if (sameDepositBasis(ov.depositBasis, depositBasisOf(plan))) return saved;
      // Anything else — a prefill saved before this fix, a figure set for a
      // different price or claim — gives way to the rule, and the note says so.
      if (Array.isArray(ctx.depositDropped) && !isEmpty(saved)
          && !isRetiredDepositDefault(field.key, saved, ctx)
          && !sameDepositValue(field.key, saved, def)) {
        ctx.depositDropped.push({ key: field.key, label: field.label || field.key, value: saved });
      }
    }
    return def;
  }

  function resolveFieldValue(field, ctx) {
    // 0. Deposit-rule fields have their own override rules (above).
    if (isDepositField(field)) return resolveDepositField(field, ctx);

    // 1. Per-doc override wins
    if (ctx.overrides && Object.prototype.hasOwnProperty.call(ctx.overrides, field.key)) {
      return ctx.overrides[field.key];
    }

    // 2. Direct lead field wins next (only for lead-persist fields)
    if (field.persist === PERSIST.LEAD && ctx.lead && Object.prototype.hasOwnProperty.call(ctx.lead, field.key)) {
      var v = ctx.lead[field.key];
      if (v !== undefined && v !== null && v !== '') return v;
    }

    // 3. Source resolver
    var src = field.source;
    if (!src) return field.default !== undefined ? field.default : '';

    if (typeof src === 'string' && src.indexOf('literal:') === 0) {
      return src.slice('literal:'.length);
    }

    if (src === 'photos') return ctx.photos || [];
    if (src === 'photos.before') return (ctx.photos || []).filter(function (p) { return (p.phase || '').toLowerCase() === 'before'; });
    if (src === 'photos.after') return (ctx.photos || []).filter(function (p) { return (p.phase || '').toLowerCase() === 'after'; });
    if (src === 'photos.during') return (ctx.photos || []).filter(function (p) { return (p.phase || '').toLowerCase() === 'during'; });

    if (typeof src === 'string' && src.indexOf('computed.') === 0) {
      return computeValue(src.slice('computed.'.length), ctx, field);
    }

    if (typeof src === 'string' && src.indexOf('lead.') === 0) {
      return getPath(ctx.lead, src.slice('lead.'.length)) || '';
    }

    if (typeof src === 'string' && src.indexOf('estimate.') === 0) {
      var key = src.slice('estimate.'.length);
      if (key === 'lineItems') return mapEstimateLineItems(ctx.estimate);
      // A Job Template estimate saves no tier (2026-09-25). Its warranty
      // wording tier comes from its job type: 'better' for roofing (the value
      // that flow always saved, so roofing paperwork is unchanged) and '' for
      // every other job type, whose sentence prints instead.
      if (key === 'tier' && ctx.jobWarranty) return ctx.jobWarranty.wordingTier || '';
      return getPath(ctx.estimate, key) || '';
    }

    // Plain literal fallback
    return src;
  }

  /**
   * Map a saved estimate into the doc line-items shape.
   *
   * Delegates to NBDCustomerEstimateRows.buildDocLineItems, which understands
   * BOTH estimate shapes. This function used to bail unless `est.lineItems`
   * was an array — but V2, the builder every estimate goes through now, writes
   * `est.rows` and never `lineItems`. So the scope came back empty for every
   * V2 estimate, and `lineItems` is required:true on proposal, contract,
   * supplement_request and invoice: every one of those documents opened with
   * an empty REQUIRED field that had to be typed by hand.
   *
   * The delegate — not a local rows[] reader — because deriving the customer
   * price from saved rows is the retail ladder, and a private copy of that
   * math is what printed the contractor's cost basis to homeowners in 2026-07.
   * customer-estimate-rows.js is loaded on both dashboard.html and
   * customer.html; the local fallback below only runs if that ever stops being
   * true, and handles the classic shape exactly as before.
   */
  function mapEstimateLineItems(est) {
    if (!est) return [];
    var api = (typeof window !== 'undefined') && window.NBDCustomerEstimateRows;
    if (api && typeof api.buildDocLineItems === 'function') {
      try { return api.buildDocLineItems(est); } catch (e) { /* fall through */ }
    }
    if (!Array.isArray(est.lineItems)) return [];
    return est.lineItems.map(function (it) {
      var qty = parseFloat(it.quantity || it.qty || 1) || 1;
      var rate = parseFloat(it.unitPrice || it.rate || 0);
      var amt = parseFloat(it.amount || it.total || 0);
      if (!rate && qty && amt) rate = amt / qty;
      var total = amt || (qty * rate);
      return {
        description: it.description || it.name || 'Line item',
        qty: qty,
        unit: it.unit || 'ea',
        rate: rate || 0,
        total: total || 0
      };
    });
  }

  /**
   * The estimate's items as identity only — { code, name }, no prices — for
   * NBDDocGen.resolveDocManufacturer. Reads BOTH shapes (V2 `rows`, classic
   * `lineItems`); a per-SQ estimate's customer line items are one "Roofing
   * system" line, which names no shingle at all.
   */
  function manufacturerItems(est) {
    if (!est) return [];
    var src = [].concat(Array.isArray(est.rows) ? est.rows : [], Array.isArray(est.lineItems) ? est.lineItems : []);
    return src.map(function (r) {
      return { code: String((r && r.code) || ''), name: String((r && (r.name || r.description)) || '') };
    }).filter(function (r) { return r.code || r.name; });
  }

  /**
   * The job's deposit plan from deposit-rule.js (2026-09-25): the contract
   * price the pre-flight prefills (computed.jobValue's own priority), the
   * estimate's mode + claim, the lead's deductible as fallback.
   * extra.total / extra.overrideAmount carry the form's Contract Price and a
   * rep-edited Deposit Amount. An extra.total that is PRESENT but blank (the
   * rep cleared the price) means no price — never a silent fall back to
   * lead.jobValue (review fix, 2026-09-25).
   */
  function depositPlanFor(ctx, extra) {
    var R = (typeof window !== 'undefined') && window.NBDDepositRule;
    if (!R) return null;
    ctx = ctx || {};
    extra = extra || {};
    var lead = ctx.lead || {};
    var est = ctx.estimate || {};
    var total = Object.prototype.hasOwnProperty.call(extra, 'total') && extra.total !== undefined
      ? extra.total
      : (lead.jobValue || est.grandTotal || est.total || est.amount || 0);
    // Cents here, so a "$9,000.00"-style value can't be read as no price.
    var opts = { totalCents: Math.max(0, _depCents(total) || 0), lead: lead };
    // The address as the form shows it now (Kentucky hold, 2026-09-27).
    if (state && state.values && state.values.address) opts.address = state.values.address;
    if (extra.overrideAmount != null && extra.overrideAmount !== '') opts.overrideAmount = extra.overrideAmount;
    return R.fromEstimate(est, opts);
  }

  /** Named computed values. */
  function computeValue(name, ctx, field) {
    var lead = ctx.lead || {};
    var est = ctx.estimate || {};
    switch (name) {
      case 'homeownerName':
        return ((lead.firstName || '') + ' ' + (lead.lastName || '')).trim();
      case 'today':
        return new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      case 'todayISO':
        return toDateInput(new Date());
      case 'jobValue': {
        // The estimate being documented wins over lead.jobValue (review
        // R2-2-4, 2026-10-06): a revised estimate's contract prefilled the
        // lead's older number. lead.jobValue only when no estimate is selected
        // or it carries no price.
        var estPrice = Number(est.grandTotal || est.total || est.amount) || 0;
        return estPrice > 0 ? estPrice : (lead.jobValue || 0);
      }
      case 'invoiceNumber':
        return 'INV-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-5);
      case 'receiptNumber':
        return 'RCT-' + new Date().getFullYear() + '-' + String(Date.now()).slice(-5);
      case 'depositAmount':
      case 'depositTerms':
      case 'depositPayment1':
      case 'depositPayment2':
        // deposit-rule.js (2026-09-25) — depositAmount was a flat
        // jobValue × 0.5, so a $555 repair's contract asked $277.50 and an
        // insurance job's asked half the claim instead of the deductible +
        // ACV payment. resolveDepositField normally answers these (it also
        // decides whether a saved figure still applies); this is the bare
        // rule for any other caller.
        return depositFieldDefault('computed.' + name,
          depositPlanFor(ctx, ('depositTotal' in ctx) ? { total: ctx.depositTotal } : {}));
      // Template library (2026-10-04) — each prefills from what the CRM
      // already knows, so nothing is retyped.
      case 'propertyState':
        // OH / KY from the same classifier the contract uses; '' otherwise.
        try {
          var _jx = window.NBDJurisdiction;
          var _st = _jx ? _jx.classify({ address: lead.address || '', zip: lead.zip || '', state: lead.state || '' }).state : '';
          return (_st === 'OH' || _st === 'KY') ? _st : '';
        } catch (e) { return ''; }
      case 'contractDate':
        // The signed contract's date when the CRM has one, else today.
        return toDateInput(lead.contractSignedAt || lead.contractFiledAt) || toDateInput(new Date());
      case 'signedContractDate':
        // The change order's "Original Contract Date": only a date the CRM
        // actually holds — never today, which would misstate the contract.
        return toDateInput(lead.contractSignedAt || lead.contractFiledAt);
      case 'payerType':
        return (lead.insCarrier || lead.claimNumber) ? 'insurance' : 'homeowner';
      case 'shingleLine':
        // The shingle actually on the estimate; never the resolver's
        // no-estimate default.
        try {
          var _m = window.NBDDocGen && window.NBDDocGen.resolveDocManufacturer
            ? window.NBDDocGen.resolveDocManufacturer(manufacturerItems(est)) : null;
          return (_m && _m.manufacturerName && _m.manufacturerName !== _m.manufacturer + ' shingles') ? _m.manufacturerName : '';
        } catch (e) { return ''; }
      case 'dueDate':
        // The ONE invoice due-date rule (deposit-rule.js INVOICE_DUE_DAYS —
        // Jo 2026-10-05: 7 days everywhere). This said +30, so a generated
        // invoice disagreed with the CRM invoice and the Stripe invoice.
        var _drDue = window.NBDDepositRule;
        return toDateInput(new Date(_drDue ? _drDue.invoiceDueDateMs(Date.now()) : Date.now() + 7 * 86400000));
      case 'invoiceTerms':
        var _drTerms = window.NBDDepositRule;
        return (_drTerms ? _drTerms.netTermsText() : 'Net 7.') + ' Check, ACH, or credit card accepted.';
      case 'scopeItems':
        // Prefer lead.scopeOfWork as newline list, else estimate description
        var raw = lead.scopeOfWork || est.description || '';
        if (!raw) {
          return [
            'Remove existing roofing materials',
            'Install new architectural asphalt shingles',
            'Install premium underlayment & ice/water shield',
            'Install flashing & ridge vents',
            'Final cleanup & debris removal'
          ];
        }
        return raw.split(/\r?\n|•|;/).map(function (s) { return s.trim(); }).filter(Boolean);
      default:
        return field.default !== undefined ? field.default : '';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 3: DOC SCHEMAS
  // ═══════════════════════════════════════════════════════════════
  //
  // Each schema describes the pre-flight form for one doc type.
  // Sections are rendered top-to-bottom. Fields inside sections are
  // rendered in order. Required fields float to the top automatically
  // in Hybrid mode.
  //
  // Schema shape:
  // {
  //   title:   'Proposal',
  //   subtitle:'Review before generating',
  //   sections: [
  //     { id, title, collapsed, fields: [
  //       { key, label, type, source, persist, required?, placeholder?,
  //         help?, options?, rows?, default? }
  //     ]}
  //   ]
  // }

  var CUSTOMER_SECTION = {
    id: 'customer',
    title: 'Customer',
    collapsed: false,
    fields: [
      { key: 'firstName',     label: 'First Name',     type: 'text',  source: 'lead.firstName',  persist: PERSIST.LEAD, required: true },
      { key: 'lastName',      label: 'Last Name',      type: 'text',  source: 'lead.lastName',   persist: PERSIST.LEAD, required: true },
      { key: 'address',       label: 'Property Address', type: 'text', source: 'lead.address',  persist: PERSIST.LEAD, required: true, placeholder: '123 Main St, Cincinnati, OH' },
      { key: 'phone',         label: 'Phone',          type: 'tel',   source: 'lead.phone',      persist: PERSIST.LEAD },
      { key: 'email',         label: 'Email',          type: 'email', source: 'lead.email',      persist: PERSIST.LEAD }
    ]
  };

  var COMPANY_SECTION_FIELDS = [
    { key: 'companyName',    label: 'Company Name',  type: 'text',  source: 'literal:No Big Deal Home Solutions', persist: PERSIST.DOCUMENT },
    { key: 'companyPhone',   label: 'Company Phone', type: 'tel',   source: 'literal:(859) 420-7382',            persist: PERSIST.DOCUMENT },
    { key: 'companyEmail',   label: 'Company Email', type: 'email', source: 'literal:info@nobigdealwithjoedeal.com', persist: PERSIST.DOCUMENT }
  ];

  // GBB audit, 2026-09-09: was 5yr/10yr/20yr — the generator this feeds
  // (document-generator.js renderWarrantyBadge) now prints Lifetime
  // workmanship for every tier (estimate-config.js TIER_DISPLAY); only
  // transferability/inspection and manufacturer coverage vary by tier.
  // Five tiers (Jo, 2026-10-02): Economy is a 1-YEAR labor warranty + the
  // shingle maker's standard limited warranty, NO system warranty; Beyond is
  // Best's terms + TAMKO's HailGuard hail warranty.
  var WARRANTY_TIER_OPTIONS = [
    { value: 'economy', label: 'Economy — 1-Year Labor + Mfr Standard Limited (no system warranty)' },
    { value: 'good',   label: 'Good — Lifetime Workmanship + Standard Mfr' },
    { value: 'better', label: 'Better — Lifetime Workmanship + Enhanced Mfr (transferable)' },
    { value: 'best',   label: 'Best — Lifetime Workmanship + Premium Mfr (fully transferable + inspection)' },
    { value: 'beyond', label: 'Beyond — Lifetime Workmanship + TAMKO HailGuard hail warranty (fully transferable + inspection)' }
  ];

  // The tier's workmanship sentence: estimate-config.js tierWarrantyText when
  // loaded (it isn't on customer.html), else this copy of it. An unknown tier
  // gets the plain lifetime sentence with no transfer/inspection perks.
  function tierWarrantySentence(tier) {
    var cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    if (cfg && typeof cfg.tierWarrantyText === 'function') return cfg.tierWarrantyText(tier);
    return ({
      economy: '1-year workmanship (labor) warranty; the shingle manufacturer\'s standard limited warranty applies. No system warranty.',
      good:    'Lifetime workmanship warranty; does not transfer on sale of property; GAF System Plus warranty included — GAF\'s manufacturer warranty on the GAF shingles and qualifying GAF accessories (GAF terms apply).',
      better:  'Lifetime workmanship warranty; transferable to one subsequent owner within 30 days of sale; GAF System Plus warranty included — GAF\'s manufacturer warranty on the GAF shingles and qualifying GAF accessories (GAF terms apply).',
      best:    'Lifetime workmanship warranty; fully transferable — follows the property through all subsequent owners; annual courtesy inspection included; GAF System Plus warranty included — GAF\'s manufacturer warranty on the GAF shingles and qualifying GAF accessories (GAF terms apply).',
      beyond:  'Lifetime workmanship warranty; fully transferable — follows the property through all subsequent owners; annual courtesy inspection included; plus TAMKO\'s HailGuard hail warranty on the shingles (manufacturer terms apply).'
    })[tier] || 'Lifetime workmanship warranty.';
  }

  var DOC_SCHEMAS = {

    // ── 1. PROPOSAL ─────────────────────────────────────────────
    proposal: {
      title: 'Proposal / Estimate',
      subtitle: 'Confirm the details before generating the proposal PDF.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'project', title: 'Project', collapsed: false,
          fields: [
            { key: 'date', label: 'Proposal Date', type: 'date', source: 'computed.todayISO', persist: PERSIST.DOCUMENT, required: true },
            { key: 'projectDescription', label: 'Project Description', type: 'textarea', rows: 3, required: true,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD,
              placeholder: 'Complete roof replacement including removal of existing materials, installation of new architectural shingles, flashing, underlayment, and cleanup.' },
            { key: 'scopeItems', label: 'Scope of Work (bullet list)', type: 'scope-list',
              source: 'computed.scopeItems', persist: PERSIST.DOCUMENT,
              help: 'Bullet points that appear under "Scope of Work" in the proposal.' }
          ]
        },
        {
          id: 'pricing', title: 'Pricing & Line Items', collapsed: false,
          fields: [
            { key: 'lineItems', label: 'Line Items', type: 'line-items',
              source: 'estimate.lineItems', persist: PERSIST.DOCUMENT, required: true,
              help: 'Pulled from the current estimate. Override to edit just this proposal, or Save to estimate to update the source.' },
            { key: 'totalPrice', label: 'Total Price', type: 'currency',
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT, required: true }
          ]
        },
        {
          id: 'warranty', title: 'Warranty', collapsed: true,
          fields: [
            { key: 'warrantyTier', label: 'Warranty Tier', type: 'warranty-tier',
              // 2026-09-17: was source:'lead.warrantyTier' — a field nothing
              // in this codebase ever writes (repo-wide grep for
              // `warrantyTier =` returns zero hits), so it silently fell
              // through to the 'better' literal below on every document,
              // regardless of the tier the estimate was actually priced and
              // sold at. estimate.tier is the real, rep-chosen field the
              // estimate builder maintains (estimate-v2-ui.js) — read that
              // instead, same as every other estimate-derived field on this
              // schema (see PERSIST.DOCUMENT below: a value read from the
              // estimate has no "customer record" to update back).
              source: 'estimate.tier', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'photos', title: 'Site Photos', collapsed: true,
          fields: [
            { key: 'photos', label: 'Photos to include', type: 'photo-selector',
              source: 'photos', persist: PERSIST.DOCUMENT,
              help: 'Select which photos appear in the proposal. At least 2 recommended.' }
          ]
        },
        {
          id: 'terms', title: 'Terms & Notes', collapsed: true,
          fields: [
            { key: 'termsNote', label: 'Custom note to homeowner', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'Optional note that appears above standard terms.' }
          ]
        }
      ]
    },

    // ── 2. CONTRACT ─────────────────────────────────────────────
    contract: {
      title: 'Roofing Contract',
      subtitle: 'Final review before the contract is generated.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'project', title: 'Project', collapsed: false,
          fields: [
            { key: 'projectDescription', label: 'Description of Work', type: 'textarea', rows: 3, required: true,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'lineItems', label: 'Line Items', type: 'line-items',
              source: 'estimate.lineItems', persist: PERSIST.DOCUMENT, required: true },
            { key: 'totalPrice', label: 'Contract Price', type: 'currency',
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT, required: true }
          ]
        },
        {
          id: 'warranty', title: 'Warranty', collapsed: false,
          fields: [
            { key: 'warrantyTier', label: 'Warranty Tier', type: 'warranty-tier',
              // 2026-09-17: see the proposal schema's identical comment above
              // — was sourced from a lead field nothing ever writes.
              source: 'estimate.tier', persist: PERSIST.DOCUMENT, required: true }
          ]
        },
        {
          id: 'payment', title: 'Payment & Schedule', collapsed: false,
          fields: [
            // Deposit rule (2026-09-25): both prefill from deposit-rule.js —
            // cash under $2,000 no deposit, $2,000+ 50%, insurance the
            // deductible + the ACV payment. A Deposit Amount the rep edits is
            // a rep override: the contract's schedule honors it (never below
            // an insurance deductible). Were "Typically 50%" + a 50% literal.
            // Both follow the Contract Price until edited, and save only when
            // edited (resolveDepositField, review fix 2026-09-25).
            { key: 'depositAmount', label: 'Deposit Amount', type: 'currency',
              source: 'computed.depositAmount', persist: PERSIST.DOCUMENT, required: true,
              help: 'Set by the deposit rule and follows the Contract Price. Edit it to override — an override is labelled below and kept only for this price and claim.' },
            { key: 'paymentSchedule', label: 'Payment Schedule / Terms', type: 'textarea', rows: 2,
              source: 'computed.depositTerms',
              persist: PERSIST.DOCUMENT },
            { key: 'startDate', label: 'Start Date', type: 'date',
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT, required: true },
            { key: 'estimatedCompletion', label: 'Estimated Completion', type: 'text',
              source: 'literal:5-7 business days', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'signatures', title: 'Signatures & Authorization', collapsed: true,
          fields: [
            { key: 'authorizedBy', label: 'Authorized by (contractor rep)', type: 'text',
              source: 'literal:Joe Deal', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 3. WORK AUTHORIZATION ───────────────────────────────────
    work_authorization: {
      title: 'Work Authorization',
      subtitle: 'Authorization form for starting work on-site.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'scope', title: 'Scope', collapsed: false,
          fields: [
            { key: 'projectAddress', label: 'Project Address', type: 'text',
              source: 'lead.address', persist: PERSIST.LEAD, required: true },
            { key: 'scopeOfWork', label: 'Scope of Work', type: 'textarea', rows: 4, required: true,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'authorizedBy', label: 'Authorized By', type: 'text', required: true,
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'Homeowner name' },
            { key: 'authDate', label: 'Authorization Date', type: 'date',
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT, required: true },
            { key: 'startDate', label: 'Authorized Start Date', type: 'date',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'emergencyContact', label: 'Emergency Contact', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'Name & phone' },
            { key: 'accessInstructions', label: 'Property Access Instructions', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'Gate code, dogs, parking, etc.' }
          ]
        }
      ]
    },

    // ── 4. SCOPE OF WORK ────────────────────────────────────────
    scope_of_work: {
      title: 'Scope of Work',
      subtitle: 'Detailed scope document.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'scope', title: 'Scope', collapsed: false,
          fields: [
            { key: 'projectScope', label: 'Project Scope Summary', type: 'textarea', rows: 3, required: true,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'scopeItems', label: 'Scope Bullets', type: 'scope-list',
              source: 'computed.scopeItems', persist: PERSIST.DOCUMENT },
            { key: 'materials', label: 'Materials', type: 'textarea', rows: 3,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'e.g., GAF Timberline HDZ architectural shingles, ice & water shield, synthetic underlayment' },
            { key: 'labor', label: 'Labor Notes', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'Crew size, safety protocols, supervisor' },
            { key: 'timeline', label: 'Timeline', type: 'text',
              source: 'literal:5-7 business days', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 5. INSPECTION REPORT (HOMEOWNER) ────────────────────────
    inspectionHomeowner: {
      title: 'Homeowner Inspection Report',
      subtitle: 'Condition report for the homeowner.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'property', title: 'Property Details', collapsed: false,
          fields: [
            { key: 'inspectionDate', label: 'Inspection Date', type: 'date',
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT, required: true },
            { key: 'inspectorName', label: 'Inspector Name', type: 'text',
              source: 'literal:NBD Inspector', persist: PERSIST.DOCUMENT, required: true },
            { key: 'roofAge', label: 'Roof Age (years)', type: 'number',
              source: 'lead.roofAge', persist: PERSIST.LEAD },
            { key: 'roofType', label: 'Roof Type', type: 'text',
              source: 'lead.roofType', persist: PERSIST.LEAD, placeholder: 'e.g., 3-tab, architectural' },
            { key: 'squareFootage', label: 'Square Footage', type: 'number',
              source: 'lead.squareFootage', persist: PERSIST.LEAD }
          ]
        },
        {
          id: 'condition', title: 'Roof Condition Notes', collapsed: false,
          fields: [
            { key: 'overallDescription', label: 'Overall Assessment', type: 'textarea', rows: 3, required: true,
              source: 'literal:The roof shows signs of wear consistent with age. Several areas require attention to prevent further damage.',
              persist: PERSIST.DOCUMENT },
            { key: 'roofCondition', label: 'Roof Notes', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'gutterCondition', label: 'Gutter Notes', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'photos', title: 'Inspection Photos', collapsed: false,
          fields: [
            { key: 'photos', label: 'Photos to include', type: 'photo-selector',
              source: 'photos', persist: PERSIST.DOCUMENT, required: true }
          ]
        },
        {
          id: 'recommendations', title: 'Recommendations', collapsed: true,
          fields: [
            { key: 'recommendationsNote', label: 'Recommendations Summary', type: 'textarea', rows: 3,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'Summary of recommended repairs or replacement.' }
          ]
        }
      ]
    },

    // ── 6. INSPECTION REPORT (INSURANCE) ────────────────────────
    inspectionInsurance: {
      title: 'Insurance Damage Report',
      subtitle: 'Report for insurance adjuster.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'claim', title: 'Claim Info', collapsed: false,
          fields: [
            { key: 'insCarrier', label: 'Insurance Carrier', type: 'text', required: true,
              source: 'lead.insCarrier', persist: PERSIST.LEAD, placeholder: 'e.g., State Farm' },
            { key: 'claimNumber', label: 'Claim Number', type: 'text', required: true,
              source: 'lead.claimNumber', persist: PERSIST.LEAD },
            { key: 'policyNumber', label: 'Policy Number', type: 'text',
              source: 'lead.policyNumber', persist: PERSIST.LEAD },
            { key: 'dateOfLoss', label: 'Date of Loss', type: 'date', required: true,
              source: 'lead.dateOfLoss', persist: PERSIST.LEAD },
            { key: 'damageType', label: 'Damage Type', type: 'select', required: true,
              source: 'lead.damageType', persist: PERSIST.LEAD,
              options: [
                { value: 'Wind', label: 'Wind' },
                { value: 'Hail', label: 'Hail' },
                { value: 'Wind & Hail', label: 'Wind & Hail' },
                { value: 'Fallen Tree', label: 'Fallen Tree' },
                { value: 'Ice Dam', label: 'Ice Dam' },
                { value: 'Other', label: 'Other' }
              ] }
          ]
        },
        {
          id: 'property', title: 'Property & Inspection', collapsed: false,
          fields: [
            { key: 'inspectionDate', label: 'Inspection Date', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'inspectorName', label: 'Damage Assessor', type: 'text', required: true,
              source: 'literal:NBD Damage Assessor', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'damage', title: 'Damage & Scope', collapsed: false,
          fields: [
            { key: 'damageNotes', label: 'Damage Description', type: 'textarea', rows: 3, required: true,
              source: 'literal:Evidence of wind/impact damage to shingles including lifted edges, puncture marks, and missing shingles.',
              persist: PERSIST.DOCUMENT },
            { key: 'scopeItems', label: 'Scope of Restoration', type: 'scope-list',
              source: 'computed.scopeItems', persist: PERSIST.DOCUMENT },
            { key: 'estimatedRepairCost', label: 'Estimated Repair Cost', type: 'currency', required: true,
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'photos', title: 'Photo Evidence', collapsed: false,
          fields: [
            { key: 'photos', label: 'Photos to include', type: 'photo-selector',
              source: 'photos', persist: PERSIST.DOCUMENT, required: true,
              help: 'Select damage photos for the adjuster.' }
          ]
        }
      ]
    },

    // ── 7. SUPPLEMENT REQUEST ───────────────────────────────────
    supplement_request: {
      title: 'Supplement Request',
      subtitle: 'Additional scope items for the insurance carrier.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'claim', title: 'Claim Info', collapsed: false,
          fields: [
            { key: 'insCarrier', label: 'Carrier', type: 'text', required: true,
              source: 'lead.insCarrier', persist: PERSIST.LEAD },
            { key: 'claimNumber', label: 'Claim Number', type: 'text', required: true,
              source: 'lead.claimNumber', persist: PERSIST.LEAD },
            { key: 'policyNumber', label: 'Policy Number', type: 'text',
              source: 'lead.policyNumber', persist: PERSIST.LEAD },
            { key: 'dateOfLoss', label: 'Date of Loss', type: 'date',
              source: 'lead.dateOfLoss', persist: PERSIST.LEAD }
          ]
        },
        {
          id: 'scope', title: 'Supplement Scope', collapsed: false,
          fields: [
            { key: 'originalApproved', label: 'Original Approved Amount', type: 'currency',
              source: 'literal:', persist: PERSIST.DOCUMENT,
              help: 'The carrier-approved amount before this supplement (drives the New Project Total).' },
            { key: 'originalScope', label: 'Original Approved Scope', type: 'textarea', rows: 3,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'supplementItems', label: 'Supplement Line Items', type: 'line-items',
              source: 'estimate.lineItems', persist: PERSIST.DOCUMENT, required: true,
              help: 'Items being added to the claim.' },
            { key: 'justification', label: 'Justification', type: 'textarea', rows: 4, required: true,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'Why are these items needed? Reference code, manufacturer spec, photos, etc.' }
          ]
        }
      ]
    },

    // ── 8. WARRANTY CERTIFICATE ─────────────────────────────────
    warranty_certificate: {
      title: 'Warranty Certificate',
      subtitle: 'Official warranty document for completed work.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'warranty', title: 'Warranty Details', collapsed: false,
          fields: [
            { key: 'installDate', label: 'Install Completion Date', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'warrantyTier', label: 'Warranty Tier', type: 'warranty-tier', required: true,
              // 2026-09-17: see the proposal schema's identical comment
              // (§ warranty section above) — was sourced from a lead field
              // nothing ever writes.
              source: 'estimate.tier', persist: PERSIST.DOCUMENT },
            { key: 'coverageDetails', label: 'Coverage Details', type: 'textarea', rows: 3,
              source: 'literal:Workmanship warranty as shown above. Manufacturer warranties per shingle product datasheet.',
              persist: PERSIST.DOCUMENT },
            { key: 'transferable', label: 'Transferable to next owner?', type: 'checkbox',
              source: 'literal:false', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 9. CERTIFICATE OF COMPLETION ────────────────────────────
    certificate_of_completion: {
      title: 'Certificate of Completion',
      subtitle: 'Proof that the job is complete and signed off.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'completion', title: 'Completion Details', collapsed: false,
          fields: [
            { key: 'completionDate', label: 'Completion Date', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'scopeCompleted', label: 'Scope Completed', type: 'textarea', rows: 3, required: true,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'qualitySignoff', label: 'Quality Sign-off Note', type: 'textarea', rows: 2,
              source: 'literal:Work completed to specification. Final walkthrough passed.',
              persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'photos', title: 'Before & After Photos', collapsed: false,
          fields: [
            { key: 'beforePhotos', label: 'Before Photos', type: 'photo-selector',
              source: 'photos.before', persist: PERSIST.DOCUMENT, required: true },
            { key: 'afterPhotos', label: 'After Photos', type: 'photo-selector',
              source: 'photos.after', persist: PERSIST.DOCUMENT, required: true }
          ]
        }
      ]
    },

    // ── 10. INVOICE ─────────────────────────────────────────────
    invoice: {
      title: 'Invoice',
      subtitle: 'Review invoice line items and totals.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'invoice', title: 'Invoice Info', collapsed: false,
          fields: [
            { key: 'invoiceNumber', label: 'Invoice Number', type: 'text', required: true,
              source: 'computed.invoiceNumber', persist: PERSIST.DOCUMENT },
            { key: 'invoiceDate', label: 'Invoice Date', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'dueDate', label: 'Due Date', type: 'date', required: true,
              source: 'computed.dueDate', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'items', title: 'Line Items & Totals', collapsed: false,
          fields: [
            { key: 'lineItems', label: 'Line Items', type: 'line-items', required: true,
              source: 'estimate.lineItems', persist: PERSIST.DOCUMENT },
            { key: 'subtotal', label: 'Subtotal', type: 'currency', required: true,
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT },
            { key: 'taxRate', label: 'Tax Rate (%)', type: 'number',
              source: 'literal:0', persist: PERSIST.DOCUMENT },
            { key: 'totalPrice', label: 'Total Due', type: 'currency', required: true,
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'terms', title: 'Payment Terms', collapsed: true,
          fields: [
            { key: 'paymentTerms', label: 'Payment Terms', type: 'textarea', rows: 2,
              source: 'computed.invoiceTerms',
              persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 10b. RECEIPT ────────────────────────────────────────────
    //
    // The closing document for a job that has been paid. Kept separate from
    // the invoice on purpose: handing someone who has already paid a document
    // headed INVOICE, with payment terms and a late-fee clause, reads as
    // another bill.
    //
    // `paidInFull` is an explicit checkbox rather than something inferred.
    // Contract Total is optional — when it is left blank the receipt states
    // only what was received and shows no balance line, because a balance we
    // were not told is a balance we must not assert.
    receipt: {
      title: 'Receipt',
      subtitle: 'Proof of payment for a job that has been paid.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'payment', title: 'Payment', collapsed: false,
          fields: [
            { key: 'receiptNumber', label: 'Receipt Number', type: 'text', required: true,
              source: 'computed.receiptNumber', persist: PERSIST.DOCUMENT },
            { key: 'paymentDate', label: 'Date Paid', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'amountPaid', label: 'Amount Received', type: 'currency', required: true,
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT },
            { key: 'paymentMethod', label: 'Payment Method', type: 'select', required: true,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              options: [
                { value: '', label: 'Select…' },
                { value: 'PayPal', label: 'PayPal' },
                { value: 'Venmo', label: 'Venmo' },
                { value: 'Zelle', label: 'Zelle' },
                { value: 'Check', label: 'Check' },
                { value: 'Cash', label: 'Cash' },
                { value: 'Credit Card', label: 'Credit Card' },
                { value: 'Bank Transfer / ACH', label: 'Bank Transfer / ACH' },
                { value: 'Financing', label: 'Financing' }
              ] },
            { key: 'paymentReference', label: 'Reference (check no. / transaction ID)', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'optional' },
            { key: 'paidInFull', label: 'This settles the job in full', type: 'checkbox',
              source: 'literal:', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'work', title: 'What This Covers', collapsed: false,
          fields: [
            { key: 'workPerformed', label: 'Work Performed', type: 'textarea', rows: 3, required: true,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'What the customer paid for, in their words as much as yours.' },
            { key: 'lineItems', label: 'Line Items (optional)', type: 'line-items',
              source: 'estimate.lineItems', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'balance', title: 'Balance (optional)', collapsed: true,
          fields: [
            // GBB audit follow-up, 2026-09-09: was 'literal:' (always blank),
            // so a receipt's own balance math started from a number the rep
            // had to remember and retype rather than the same contract/
            // estimate total already on file — the one figure most likely to
            // silently drift from what the customer actually signed for.
            // Pre-fill from the same computed.jobValue every other doc type
            // reads (proposal/contract/invoice above); still editable/
            // clearable — clearing it back out still omits the section.
            { key: 'contractTotal', label: 'Contract Total', type: 'currency',
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT,
              placeholder: 'leave blank to omit the balance section entirely' },
            { key: 'priorPayments', label: 'Previous Payments', type: 'currency',
              source: 'literal:', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 11. CHANGE ORDER ────────────────────────────────────────
    change_order: {
      title: 'Change Order',
      subtitle: 'Modification to an existing contract.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'original', title: 'Original Contract', collapsed: false,
          fields: [
            { key: 'originalContractNumber', label: 'Original Contract #', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'e.g., CON-2026-001' },
            { key: 'originalContractDate', label: 'Original Contract Date', type: 'date',
              source: 'computed.signedContractDate', persist: PERSIST.DOCUMENT },
            { key: 'changeOrderNumber', label: 'Change Order #', type: 'text',
              source: 'literal:CO-001', persist: PERSIST.DOCUMENT },
            { key: 'originalTotal', label: 'Original Total', type: 'currency',
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'changes', title: 'Changes', collapsed: false,
          fields: [
            { key: 'changeDescription', label: 'Description of Changes', type: 'textarea', rows: 4, required: true,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'What is being added, removed, or changed and why.' },
            { key: 'changeAmount', label: 'Change Amount (+/-)', type: 'currency', required: true,
              source: 'literal:0', persist: PERSIST.DOCUMENT,
              help: 'Positive for additions, negative for credits.' },
            // 2026-10-04: was required with a literal 0 default, and the
            // renderer trusted it — a rep who filled in only the change
            // amount printed "New Total $0.00" on a signed change order.
            { key: 'newTotal', label: 'New Contract Total', type: 'currency',
              source: 'literal:', persist: PERSIST.EPHEMERAL,
              help: 'Leave blank to compute it: original total + change amount.' }
          ]
        },
        {
          id: 'schedule', title: 'Effect on Schedule', collapsed: false,
          fields: [
            { key: 'scheduleDays', label: 'Working days added (+) or saved (−)', type: 'number',
              source: 'literal:', persist: PERSIST.EPHEMERAL, placeholder: '0' },
            { key: 'newCompletionDate', label: 'New estimated completion', type: 'date',
              source: 'literal:', persist: PERSIST.EPHEMERAL },
            { key: 'scheduleImpact', label: 'Schedule note', type: 'textarea', rows: 2,
              source: 'literal:No change to estimated completion date.', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 11b. LIEN WAIVER (template library, 2026-10-04) ─────────
    // One document, four kinds x two states. The waiver is the contractor's,
    // so the contractor signs; a mortgage company usually wants it before it
    // endorses an insurance check.
    lien_waiver: {
      title: 'Lien Waiver',
      subtitle: 'Gives up the contractor’s lien rights for one payment.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'waiver', title: 'Waiver', collapsed: false,
          fields: [
            { key: 'waiverKind', label: 'Kind of waiver', type: 'select', required: true,
              source: 'literal:conditional_progress', persist: PERSIST.EPHEMERAL,
              options: [
                { value: 'conditional_progress',   label: 'Conditional — progress payment (before the check clears)' },
                { value: 'unconditional_progress', label: 'Unconditional — progress payment (money received)' },
                { value: 'conditional_final',      label: 'Conditional — final payment (before the check clears)' },
                { value: 'unconditional_final',    label: 'Unconditional — final payment (money received)' }
              ],
              help: 'Conditional until the money has cleared. Unconditional only after it has.' },
            { key: 'waiverState', label: 'Property state', type: 'select', required: true,
              source: 'computed.propertyState', persist: PERSIST.EPHEMERAL,
              options: [{ value: 'OH', label: 'Ohio' }, { value: 'KY', label: 'Kentucky' }] },
            { key: 'amount', label: 'Payment amount', type: 'currency', required: true,
              source: 'literal:', persist: PERSIST.EPHEMERAL },
            { key: 'throughDate', label: 'Work covered through (progress waivers)', type: 'date',
              source: 'computed.todayISO', persist: PERSIST.EPHEMERAL },
            { key: 'checkNumber', label: 'Check / payment reference no.', type: 'text',
              source: 'literal:', persist: PERSIST.EPHEMERAL }
          ]
        },
        {
          id: 'payer', title: 'Who Is Paying', collapsed: false,
          fields: [
            { key: 'payerType', label: 'Paid by', type: 'select', required: true,
              source: 'computed.payerType', persist: PERSIST.EPHEMERAL,
              options: [
                { value: 'homeowner', label: 'Homeowner' },
                { value: 'insurance', label: 'Insurance company (check to the owner)' },
                { value: 'mortgage',  label: 'Mortgage company' }
              ] },
            { key: 'insCarrier', label: 'Insurance company', type: 'text',
              source: 'lead.insCarrier', persist: PERSIST.LEAD },
            { key: 'claimNumber', label: 'Owner’s claim number', type: 'text',
              source: 'lead.claimNumber', persist: PERSIST.LEAD },
            { key: 'mortgageCompany', label: 'Mortgage company', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'loanNumber', label: 'Mortgage loan no.', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'extra', title: 'Exceptions & Notary', collapsed: true,
          fields: [
            { key: 'exceptions', label: 'Amounts NOT waived', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.EPHEMERAL, placeholder: 'Leave blank for none.' },
            { key: 'includeNotary', label: 'Add a notary block', type: 'checkbox',
              source: 'literal:false', persist: PERSIST.DOCUMENT,
              help: 'Some mortgage companies ask for a notarized waiver.' }
          ]
        }
      ]
    },

    // ── 11c. RIGHT TO CANCEL (template library, 2026-10-04) ─────
    right_to_cancel: {
      title: 'Notice of Right to Cancel',
      subtitle: 'The 3-business-day cancellation notice for a contract signed at the home.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'contract', title: 'Contract', collapsed: false,
          fields: [
            { key: 'contractDate', label: 'Contract date', type: 'date', required: true,
              source: 'computed.contractDate', persist: PERSIST.EPHEMERAL,
              help: 'The day the homeowner signed. The cancel deadline is counted from it.' }
          ]
        }
      ]
    },

    // ── 11d. MATERIAL & COLOR SELECTION (template library) ──────
    material_selection: {
      title: 'Material & Color Selection',
      subtitle: 'Homeowner signs off on materials and colors before ordering.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'roof', title: 'Roof', collapsed: false,
          fields: [
            { key: 'shingleLine', label: 'Shingle line', type: 'text',
              source: 'computed.shingleLine', persist: PERSIST.DOCUMENT, placeholder: 'e.g., TAMKO Titan XT' },
            { key: 'shingleColor', label: 'Shingle color', type: 'text', required: true,
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'underlayment', label: 'Underlayment', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'dripEdge', label: 'Drip edge (style / color)', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'ventilation', label: 'Roof vents', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'e.g., ridge vent' }
          ]
        },
        {
          id: 'gutters', title: 'Gutters', collapsed: false,
          fields: [
            { key: 'gutters', label: 'Gutters (size / style)', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'e.g., 6" K-style seamless' },
            { key: 'gutterColor', label: 'Gutter color', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'gutterGuards', label: 'Gutter guards', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT }
          ]
        },
        {
          id: 'other', title: 'Other', collapsed: true,
          fields: [
            { key: 'otherSelections', label: 'Other selections', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'selectionNotes', label: 'Notes', type: 'textarea', rows: 2,
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'warrantyTier', label: 'Package', type: 'warranty-tier',
              source: 'estimate.tier', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 11e. GOOD-BETTER-BEST OPTIONS (template library) ────────
    // The per-tier prices come from the estimate itself (hydrateDerivedFields),
    // never from a field the rep retypes.
    proposal_options: {
      title: 'Good-Better-Best Options',
      subtitle: 'One page comparing every priced package on the estimate.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'options', title: 'Options', collapsed: false,
          fields: [
            { key: 'date', label: 'Date', type: 'date', source: 'computed.todayISO', persist: PERSIST.EPHEMERAL },
            { key: 'projectDescription', label: 'Scope (same for every option)', type: 'textarea', rows: 3,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD }
          ]
        }
      ]
    },

    // ── 11f. INSURANCE JOB: SCOPE & NEXT STEPS (template library) ─
    insurance_next_steps: {
      title: 'Insurance Job: Scope & Next Steps',
      subtitle: 'Homeowner letter: who does what on an insurance job.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'scope', title: 'Scope', collapsed: false,
          fields: [
            { key: 'scopeOfWork', label: 'What we found and recommend', type: 'textarea', rows: 4,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'insCarrier', label: 'Homeowner’s insurance company', type: 'text',
              source: 'lead.insCarrier', persist: PERSIST.LEAD },
            { key: 'claimNumber', label: 'Homeowner’s claim number', type: 'text',
              source: 'lead.claimNumber', persist: PERSIST.LEAD },
            { key: 'dateOfLoss', label: 'Date of loss', type: 'date',
              source: 'lead.dateOfLoss', persist: PERSIST.LEAD }
          ]
        }
      ]
    },

    // ── 12. BEFORE & AFTER REPORT ───────────────────────────────
    before_after_report: {
      title: 'Before & After Report',
      subtitle: 'Visual comparison of the project.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'project', title: 'Project', collapsed: false,
          fields: [
            { key: 'projectType', label: 'Project Type', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'e.g. Roof Replacement, Siding, Gutters' },
            { key: 'projectDescription', label: 'Project Description', type: 'textarea', rows: 2, required: true,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'duration', label: 'Project Duration', type: 'text',
              source: 'literal:5 business days', persist: PERSIST.DOCUMENT },
            { key: 'highlights', label: 'Project Highlights', type: 'textarea', rows: 4,
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'One highlight per line (leave blank to omit the section)' }
          ]
        },
        {
          id: 'photos', title: 'Photo Selection', collapsed: false,
          fields: [
            { key: 'beforePhotos', label: 'Before Photos', type: 'photo-selector', required: true,
              source: 'photos.before', persist: PERSIST.DOCUMENT },
            { key: 'afterPhotos', label: 'After Photos', type: 'photo-selector', required: true,
              source: 'photos.after', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 13. FINANCING OPTIONS ───────────────────────────────────
    financing_options: {
      title: 'Financing Options',
      subtitle: 'Payment plan options for the customer.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'financing', title: 'Financing', collapsed: false,
          fields: [
            { key: 'jobTotal', label: 'Job Total', type: 'currency', required: true,
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT },
            { key: 'term12', label: '12-month payment', type: 'currency',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'Monthly payment' },
            { key: 'term24', label: '24-month payment', type: 'currency',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'term60', label: '60-month payment', type: 'currency',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'interestRate', label: 'Interest Rate', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'Varies by credit (Acorn Finance)' },
            { key: 'applicationLink', label: 'Application Link', type: 'text',
              source: 'literal:nobigdealwithjoedeal.com/financing', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 14. COMPANY INTRO ───────────────────────────────────────
    company_intro: {
      title: 'Company Introduction',
      subtitle: 'About-us handout for new leads.',
      sections: [
        {
          id: 'company', title: 'Company Info', collapsed: false,
          fields: COMPANY_SECTION_FIELDS.concat([
            { key: 'serviceArea', label: 'Service Area', type: 'text',
              source: 'literal:Greater Cincinnati & Northern Kentucky', persist: PERSIST.DOCUMENT },
            { key: 'services', label: 'Services Offered', type: 'textarea', rows: 2,
              source: 'literal:Roofing, Siding, Gutters, Windows, Insurance Claim Assistance', persist: PERSIST.DOCUMENT }
          ])
        },
        {
          id: 'social', title: 'Social Proof', collapsed: true,
          fields: [
            { key: 'testimonialsNote', label: 'Featured Testimonial', type: 'textarea', rows: 3,
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'Optional featured testimonial to include.' }
          ]
        }
      ]
    },

    // ── 15. REFERRAL CARD ───────────────────────────────────────
    referral_card: {
      title: 'Referral Card',
      subtitle: 'Give the homeowner a card to share.',
      sections: [
        {
          id: 'customer', title: 'Customer', collapsed: false,
          fields: [
            { key: 'firstName', label: 'First Name', type: 'text', required: true,
              source: 'lead.firstName', persist: PERSIST.LEAD },
            { key: 'lastName',  label: 'Last Name',  type: 'text', required: true,
              source: 'lead.lastName',  persist: PERSIST.LEAD }
          ]
        },
        {
          id: 'referral', title: 'Referral Details', collapsed: false,
          fields: [
            { key: 'referralCode', label: 'Referral Code', type: 'text', required: true,
              source: 'lead.referralCode', persist: PERSIST.LEAD, placeholder: 'Auto-generated or custom' },
            { key: 'bonusAmount', label: 'Referral Bonus', type: 'currency', required: true,
              source: 'literal:250', persist: PERSIST.DOCUMENT },
            { key: 'terms', label: 'Terms', type: 'textarea', rows: 2,
              source: 'literal:Bonus paid upon completion of referred job. One bonus per referred customer.',
              persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 16. STORM CHECKLIST ─────────────────────────────────────
    storm_checklist: {
      title: 'Storm Checklist',
      subtitle: 'Post-storm homeowner checklist.',
      sections: [
        {
          id: 'storm', title: 'Storm Event', collapsed: false,
          fields: [
            { key: 'stormDate', label: 'Storm Event Date', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'stormType', label: 'Storm Type', type: 'select',
              source: 'literal:Hail', persist: PERSIST.DOCUMENT,
              options: [
                { value: 'Hail', label: 'Hail' },
                { value: 'Wind', label: 'Wind' },
                { value: 'Tornado', label: 'Tornado' },
                { value: 'Ice', label: 'Ice' },
                { value: 'Other', label: 'Other' }
              ] },
            { key: 'checklistNotes', label: 'Additional Notes', type: 'textarea', rows: 3,
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'emergencyPhone', label: 'Emergency Contact Phone', type: 'tel',
              source: 'literal:(859) 420-7382', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 17. CLAIM GUIDE ─────────────────────────────────────────
    claim_guide: {
      title: 'Insurance Claim Guide',
      subtitle: 'Carrier-specific instructions.',
      sections: [
        {
          id: 'carrier', title: 'Carrier', collapsed: false,
          fields: [
            { key: 'insCarrier', label: 'Carrier', type: 'select',
              source: 'lead.insCarrier', persist: PERSIST.LEAD,
              options: [
                { value: 'State Farm', label: 'State Farm' },
                { value: 'Allstate', label: 'Allstate' },
                { value: 'Liberty Mutual', label: 'Liberty Mutual' },
                { value: 'USAA', label: 'USAA' },
                { value: 'Nationwide', label: 'Nationwide' },
                { value: 'Farmers', label: 'Farmers' },
                { value: 'Other', label: 'Other' }
              ] },
            { key: 'timeline', label: 'Expected Timeline', type: 'text',
              source: 'literal:30-60 days from claim filing', persist: PERSIST.DOCUMENT },
            { key: 'guideNotes', label: 'What to Expect', type: 'textarea', rows: 4,
              source: 'literal:Adjuster will contact you within 48-72 hours of filing. We will meet the adjuster on-site to review damage together.',
              persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 18. DOOR HANGER ─────────────────────────────────────────
    door_hanger: {
      title: 'Door Hanger',
      subtitle: 'Canvassing door hanger.',
      sections: [
        {
          id: 'company', title: 'Company Info', collapsed: false,
          fields: COMPANY_SECTION_FIELDS.concat([
            { key: 'headline', label: 'Headline', type: 'text',
              source: 'literal:Free Roof Inspection — No Obligation', persist: PERSIST.DOCUMENT },
            { key: 'services', label: 'Services', type: 'textarea', rows: 2,
              source: 'literal:Storm damage repair • Insurance claims • Roof replacement • Gutters',
              persist: PERSIST.DOCUMENT }
          ])
        }
      ]
    },

    // ── 19. NEIGHBORHOOD MAILER ─────────────────────────────────
    neighborhood_mailer: {
      title: 'Neighborhood Mailer',
      subtitle: 'Storm-event neighborhood mail piece.',
      sections: [
        {
          id: 'event', title: 'Storm Event', collapsed: false,
          fields: [
            { key: 'stormDate', label: 'Storm Event Date', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'affectedArea', label: 'Affected Area', type: 'text', required: true,
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'e.g., West Chester, OH' },
            { key: 'neighborhoodName', label: 'Neighborhood Name', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'Defaults to Affected Area' },
            { key: 'projectAddress', label: 'Nearby Project Address', type: 'text',
              source: 'lead.address', persist: PERSIST.DOCUMENT, placeholder: 'e.g., 123 Maple St' },
            { key: 'ctaText', label: 'Call to Action', type: 'text',
              source: 'literal:Schedule your free storm damage inspection today', persist: PERSIST.DOCUMENT }
          ]
        },
        { id: 'company', title: 'Company Info', collapsed: true, fields: COMPANY_SECTION_FIELDS }
      ]
    },

    // ── 20. TESTIMONIAL SHEET ───────────────────────────────────
    testimonial_sheet: {
      title: 'Testimonial Sheet',
      subtitle: 'Customer testimonials handout.',
      sections: [
        {
          id: 'testimonials', title: 'Testimonials', collapsed: false,
          fields: [
            { key: 'testimonial1', label: 'Testimonial #1', type: 'textarea', rows: 3,
              source: 'literal:', persist: PERSIST.DOCUMENT, placeholder: 'Customer quote + name' },
            { key: 'rating1', label: 'Rating #1', type: 'select',
              source: 'literal:5', persist: PERSIST.DOCUMENT,
              options: [
                { value: '5', label: '5 stars' },
                { value: '4', label: '4 stars' },
                { value: '3', label: '3 stars' }
              ] },
            { key: 'testimonial2', label: 'Testimonial #2', type: 'textarea', rows: 3,
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'rating2', label: 'Rating #2', type: 'select',
              source: 'literal:5', persist: PERSIST.DOCUMENT,
              options: [
                { value: '5', label: '5 stars' },
                { value: '4', label: '4 stars' },
                { value: '3', label: '3 stars' }
              ] },
            { key: 'testimonial3', label: 'Testimonial #3', type: 'textarea', rows: 3,
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'rating3', label: 'Rating #3', type: 'select',
              source: 'literal:5', persist: PERSIST.DOCUMENT,
              options: [
                { value: '5', label: '5 stars' },
                { value: '4', label: '4 stars' },
                { value: '3', label: '3 stars' }
              ] }
          ]
        }
      ]
    },

    // ── 21. THANK YOU ───────────────────────────────────────────
    thank_you: {
      title: 'Thank You Letter',
      subtitle: 'Post-job thank-you for the customer.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'thankyou', title: 'Thank You Details', collapsed: false,
          fields: [
            { key: 'projectType', label: 'Project Type', type: 'text',
              source: 'literal:', persist: PERSIST.DOCUMENT,
              placeholder: 'e.g. roof replacement, siding install, gutter repair' },
            { key: 'completionDate', label: 'Completion Date', type: 'date',
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'projectSummary', label: 'Project Summary', type: 'textarea', rows: 3, required: true,
              source: 'lead.scopeOfWork', persist: PERSIST.LEAD },
            { key: 'personalNote', label: 'Personal Note', type: 'textarea', rows: 3,
              source: 'literal:It was a pleasure working with you. Thank you for choosing No Big Deal Home Solutions.',
              persist: PERSIST.DOCUMENT },
            { key: 'reviewLink', label: 'Google Review Link', type: 'text',
              source: 'literal:https://g.page/r/nobigdeal/review', persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    },

    // ── 22. PAYMENT AGREEMENT ───────────────────────────────────
    payment_agreement: {
      title: 'Payment Agreement',
      subtitle: 'Payment schedule agreement.',
      sections: [
        CUSTOMER_SECTION,
        {
          id: 'agreement', title: 'Agreement', collapsed: false,
          fields: [
            { key: 'totalPrice', label: 'Total Amount', type: 'currency', required: true,
              source: 'computed.jobValue', persist: PERSIST.DOCUMENT },
            // Deposit rule (review fix, 2026-09-25): Payment 1 is what is due
            // at signing — the deductible on a claim, the cash deposit
            // otherwise — and Payment 2 is a claim's ACV check, due when the
            // carrier releases it. Payment 1 used to be the WHOLE up-front
            // amount (deductible + ACV) dated today, and a sub-$2,000 cash
            // job printed "1. Deposit $0.00 Pending". submit() adds the
            // balance as the final payment so the schedule foots.
            { key: 'payment1Amount', label: 'Payment 1 Amount', type: 'currency', required: true,
              source: 'computed.depositPayment1', persist: PERSIST.DOCUMENT,
              help: 'Due at signing, from the deposit rule: the deductible on an insurance job, the deposit on a cash job.' },
            { key: 'payment1Date', label: 'Payment 1 Date', type: 'date', required: true,
              source: 'computed.todayISO', persist: PERSIST.DOCUMENT },
            { key: 'payment2Amount', label: 'Payment 2 Amount', type: 'currency',
              source: 'computed.depositPayment2', persist: PERSIST.DOCUMENT,
              help: 'Insurance: the ACV check, due when the carrier releases it (leave the date blank). The balance prints as the final payment.' },
            { key: 'payment2Date', label: 'Payment 2 Date', type: 'date',
              source: 'literal:', persist: PERSIST.DOCUMENT },
            { key: 'paymentTerms', label: 'Terms', type: 'textarea', rows: 2,
              source: 'literal:Payments are non-refundable once work has begun. Late payments subject to 1.5% monthly finance charge.',
              persist: PERSIST.DOCUMENT }
          ]
        }
      ]
    }
  };

  // ═══════════════════════════════════════════════════════════════
  // SECTION 4: STATE
  // ═══════════════════════════════════════════════════════════════

  var state = {
    open: false,
    type: null,
    customerId: null,
    schema: null,
    values: {},        // { fieldKey: currentValue }
    fieldIndex: {},    // { fieldKey: fieldDefinition }
    showAll: false,
    lineItemsMode: {}, // { fieldKey: 'locked' | 'override' }
    signers: [],       // [{ role, label, required, enabled, removable }]
    softAck: false,    // address-completeness warning acknowledged this open()
    softIssues: [],    // [{ label, message }] from FIELD_VALIDATORS
    // Kentucky SB 153 (2026-09-27): rep-facing legal notes for a contract /
    // proposal on a Kentucky insurance job — [{ level: 'block'|'warn', message }].
    legalNotes: [],
    estimate: null,    // the estimate this open() resolved (jurisdiction facts)
    // NBDCustomerEstimateRows.estimateWarranty(estimate) for this open():
    // non-null with a string `text` when the estimate is a Job Template one
    // whose warranty comes from its JOB TYPE, not a tier (2026-09-25).
    jobWarranty: null,
    // Deposit rule (review fix, 2026-09-25), set by open() for documents
    // that state payment terms:
    //   { ctx: {lead, estimate},
    //     defaults: { fieldKey: what the rule puts there at the form's
    //                 current price } — a field still equal to its default
    //                 is untouched, so it follows the price,
    //     dropped:  [{key,label,value}] saved figures that no longer apply }
    deposit: null
  };

  // True when this document's warranty is decided by the estimate's job type,
  // so the Good/Better/Best warranty cards must not be offered: picking
  // "Better" there is how a gutter contract used to promise a lifetime
  // workmanship warranty. Roofing (text === null) keeps the cards.
  function jobWarrantyGoverns() {
    return !!(state.jobWarranty && typeof state.jobWarranty.text === 'string');
  }

  // `required` as this open() enforces it. The warranty-tier field is
  // satisfied by the estimate itself when the job type governs the warranty
  // (an empty tier is then correct, not missing).
  function fieldRequired(f) {
    if (!f || !f.required) return false;
    return !(f.type === 'warranty-tier' && jobWarrantyGoverns());
  }

  // ── Deposit state helpers (review fix, 2026-09-25) ──────────────────
  // A deposit field the rep has not changed from the rule's figure.
  function depositTouched(key) {
    var d = state.deposit;
    if (!d || !Object.prototype.hasOwnProperty.call(d.defaults, key)) return false;
    return !sameDepositValue(key, state.values[key], d.defaults[key]);
  }

  // Re-ask the rule at the form's current price. Every field still showing
  // its old default follows the new one (in the DOM too when the modal is
  // up); an edited field is left alone — it is the rep's override. The terms
  // sentence follows the plan INCLUDING an edited Deposit Amount, so the
  // form never shows a sentence that disagrees with the deposit above it.
  function refreshDepositDefaults(modal) {
    var d = state.deposit;
    if (!d) return;
    var rulePlan = depositPlanFor(d.ctx, { total: state.values.totalPrice });
    var termsPlan = currentDepositPlan() || rulePlan;
    Object.keys(d.defaults).forEach(function (k) {
      var f = state.fieldIndex[k];
      var src = f && f.source;
      var next = depositFieldDefault(src, src === 'computed.depositTerms' ? termsPlan : rulePlan);
      if (sameDepositValue(k, state.values[k], d.defaults[k]) && !sameDepositValue(k, state.values[k], next)) {
        state.values[k] = next;
        if (modal && modal.querySelector) {
          var el = modal.querySelector('[data-field="' + CSS.escape(k) + '"]');
          if (el) el.value = next;
          updateFieldMissingState(k);
        }
      }
      d.defaults[k] = next;
    });
  }

  // The plan this document will print right now: the rule at the form's
  // price, with an edited contract Deposit Amount as the rep override.
  function currentDepositPlan() {
    var d = state.deposit;
    if (!d) return null;
    var extra = { total: state.values.totalPrice };
    if (state.fieldIndex.depositAmount && depositTouched('depositAmount')) {
      extra.overrideAmount = state.values.depositAmount;
    }
    return depositPlanFor(d.ctx, extra);
  }

  // Rep-facing note under the payment fields: what prints, and anything the
  // rep must know — an override (with the rule's own figure), a claim with no
  // deductible, the old $2,500 placeholder, a saved figure that was dropped.
  // Rep-only: none of this reaches the document.
  function depositNoteHTML() {
    var d = state.deposit;
    if (!d || !Object.keys(d.defaults).length) return '';
    var plan = currentDepositPlan();
    var out = [];
    if (plan && plan.totalCents > 0) {
      out.push('<div><strong>' + esc(plan.label) + ': ' + esc(plan.valueText) + '</strong> — ' + esc(plan.summary) + '</div>');
      if (plan.repNote) out.push('<div class="dpf-deposit-warn">' + esc(plan.repNote) + '</div>');
    } else {
      out.push('<div>Enter the price to set the deposit.</div>');
    }
    if (state.fieldIndex.paymentSchedule && depositTouched('paymentSchedule')) {
      out.push('<div class="dpf-deposit-warn">Payment Schedule / Terms is your own wording and prints as written — check it agrees with the deposit above.</div>');
    }
    (d.dropped || []).forEach(function (x) {
      out.push('<div class="dpf-deposit-warn">Not carried over from the last one: ' + esc(x.label) + ' “' + esc(x.value) +
        '” — it was set for a different price or claim, or before the deposit rule. The rule’s figure is shown; edit the field to override it again.</div>');
    });
    return out.join('');
  }

  function updateDepositNote(modal) {
    var root = modal || document.getElementById(MODAL_ID);
    var el = root && root.querySelector ? root.querySelector('[data-dpf-deposit-note]') : null;
    if (el) el.innerHTML = depositNoteHTML();
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 5: STYLES (injected once)
  // ═══════════════════════════════════════════════════════════════

  function injectStyles() {
    if (document.getElementById(MODAL_STYLE_ID)) return;
    var css = [
      '.dpf-overlay{position:fixed;inset:0;z-index:var(--z-overlay,10000);background:rgba(0,0,0,.82);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;animation:dpf-fade .18s ease-out;}',
      '@keyframes dpf-fade{from{opacity:0}to{opacity:1}}',
      '@keyframes dpf-slide{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}',
      '.dpf-card{width:100%;max-width:720px;max-height:90vh;background:var(--s,#111418);border:1px solid var(--br,rgba(255,255,255,.09));border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 30px 60px rgba(0,0,0,.6);animation:dpf-slide .22s ease-out;}',
      '.dpf-header{padding:18px 22px 14px;border-bottom:1px solid var(--br,rgba(255,255,255,.09));display:flex;align-items:flex-start;justify-content:space-between;gap:12px;background:linear-gradient(180deg,var(--s2,#181C22) 0%,var(--s,#111418) 100%);}',
      '.dpf-title{font-family:"Barlow Condensed",sans-serif;font-size:22px;font-weight:700;color:var(--t,#E8EAF0);text-transform:uppercase;letter-spacing:.04em;line-height:1.1;margin:0;}',
      '.dpf-subtitle{font-size:12px;color:var(--m,#6B7280);margin-top:4px;}',
      '.dpf-actions{display:flex;gap:8px;align-items:center;flex-shrink:0;}',
      '.dpf-icon-btn{background:var(--s3,#1E2229);border:1px solid var(--br,rgba(255,255,255,.09));color:var(--t,#E8EAF0);width:32px;height:32px;border-radius:8px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .15s;}',
      '.dpf-icon-btn:hover{background:var(--s2,#181C22);border-color:var(--orange,#BD5728);}',
      '.dpf-showall{background:var(--s3,#1E2229);border:1px solid var(--br,rgba(255,255,255,.09));color:var(--m,#6B7280);padding:6px 12px;border-radius:8px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;cursor:pointer;transition:all .15s;}',
      '.dpf-showall:hover{color:var(--t,#E8EAF0);border-color:var(--orange,#BD5728);}',
      '.dpf-showall.active{color:var(--orange,#BD5728);border-color:var(--orange,#BD5728);background:color-mix(in srgb, var(--orange) 8%, transparent);}',
      '.dpf-body{flex:1;overflow-y:auto;padding:20px 22px;scroll-behavior:smooth;}',
      '.dpf-body::-webkit-scrollbar{width:10px;}',
      '.dpf-body::-webkit-scrollbar-track{background:var(--s,#111418);}',
      '.dpf-body::-webkit-scrollbar-thumb{background:var(--s3,#1E2229);border-radius:5px;}',
      '.dpf-required-banner{background:color-mix(in srgb, var(--orange) 8%, transparent);border:1px solid color-mix(in srgb, var(--orange) 25%, transparent);border-radius:10px;padding:12px 14px;margin-bottom:18px;font-size:12px;color:var(--orange,#BD5728);display:flex;align-items:center;gap:10px;}',
      '.dpf-required-banner.hidden{display:none;}',
      '.dpf-section{margin-bottom:16px;border:1px solid var(--br,rgba(255,255,255,.09));border-radius:10px;background:var(--s2,#181C22);overflow:hidden;}',
      '.dpf-section-head{padding:12px 16px;display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none;transition:background .15s;}',
      '.dpf-section-head:hover{background:var(--s3,#1E2229);}',
      '.dpf-section-title{font-family:"Barlow Condensed",sans-serif;font-size:14px;font-weight:700;color:var(--t,#E8EAF0);text-transform:uppercase;letter-spacing:.06em;margin:0;border-bottom:2px solid var(--orange,#BD5728);padding-bottom:3px;display:inline-block;}',
      '.dpf-section-chevron{font-size:16px;color:var(--m,#6B7280);transition:transform .2s;}',
      '.dpf-section.collapsed .dpf-section-chevron{transform:rotate(-90deg);}',
      '.dpf-section-body{padding:4px 16px 16px;}',
      '.dpf-section.collapsed .dpf-section-body{display:none;}',
      '.dpf-field{margin:12px 0;}',
      '.dpf-field-label{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:var(--t,#E8EAF0);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}',
      '.dpf-required-dot{width:6px;height:6px;border-radius:50%;background:var(--red,#E05252);display:inline-block;}',
      '.dpf-persist-badge{margin-left:auto;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;padding:2px 6px;border-radius:3px;}',
      '.dpf-persist-badge.lead{background:rgba(46,204,138,.12);color:var(--green,#2ECC8A);border:1px solid rgba(46,204,138,.3);}',
      '.dpf-persist-badge.document{background:rgba(155,109,255,.12);color:var(--purple,#9B6DFF);border:1px solid rgba(155,109,255,.3);}',
      '.dpf-persist-badge.ephemeral{background:var(--s3,#1E2229);color:var(--m,#6B7280);border:1px solid var(--br,rgba(255,255,255,.09));}',
      '.dpf-input,.dpf-textarea,.dpf-select{width:100%;background:var(--s,#111418);border:1px solid var(--br,rgba(255,255,255,.09));color:var(--t,#E8EAF0);padding:10px 12px;border-radius:8px;font-size:13px;font-family:inherit;box-sizing:border-box;transition:border-color .15s;}',
      '.dpf-input:focus,.dpf-textarea:focus,.dpf-select:focus{outline:none;border-color:var(--orange,#BD5728);box-shadow:0 0 0 2px color-mix(in srgb, var(--orange) 15%, transparent);}',
      '.dpf-textarea{resize:vertical;min-height:60px;font-family:inherit;line-height:1.45;}',
      '.dpf-field.missing .dpf-input,.dpf-field.missing .dpf-textarea,.dpf-field.missing .dpf-select{border-color:var(--red,#E05252);}',
      '.dpf-field-help{font-size:11px;color:var(--m,#6B7280);margin-top:5px;line-height:1.4;}',
      // Deposit note (2026-09-25): the plan the document will print, and
      // any rep override / missing deductible / dropped saved figure.
      '.dpf-deposit-note{font-size:12px;line-height:1.45;color:var(--t,#E8EAF0);background:var(--s2,#181C22);border:1px solid var(--br,rgba(255,255,255,.09));border-radius:8px;padding:10px 12px;margin:4px 0 12px;overflow-wrap:anywhere;}',
      '.dpf-deposit-note:empty{display:none;}',
      '.dpf-deposit-warn{margin-top:6px;color:var(--orange,#BD5728);font-weight:600;}',
      '.dpf-field-error{font-size:11px;color:var(--red,#E05252);margin-top:5px;display:none;}',
      '.dpf-field.missing .dpf-field-error{display:block;}',
      '.dpf-currency-wrap{position:relative;}',
      '.dpf-currency-wrap::before{content:"$";position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--m,#6B7280);font-size:13px;pointer-events:none;}',
      '.dpf-currency-wrap .dpf-input{padding-left:24px;}',
      '.dpf-checkbox-wrap{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--s,#111418);border:1px solid var(--br,rgba(255,255,255,.09));border-radius:8px;cursor:pointer;}',
      '.dpf-checkbox-wrap input{width:18px;height:18px;accent-color:var(--orange,#BD5728);cursor:pointer;}',
      '.dpf-checkbox-wrap span{font-size:13px;color:var(--t,#E8EAF0);}',
      '.dpf-line-items{border:1px solid var(--br,rgba(255,255,255,.09));border-radius:8px;background:var(--s,#111418);overflow:hidden;}',
      '.dpf-line-items-head{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;background:var(--s3,#1E2229);border-bottom:1px solid var(--br,rgba(255,255,255,.09));gap:8px;flex-wrap:wrap;}',
      '.dpf-line-items-badge{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--green,#2ECC8A);padding:3px 8px;background:rgba(46,204,138,.1);border:1px solid rgba(46,204,138,.3);border-radius:3px;}',
      '.dpf-line-items-badge.override{color:var(--purple,#9B6DFF);background:rgba(155,109,255,.1);border-color:rgba(155,109,255,.3);}',
      '.dpf-line-items-btns{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap;}',
      '.dpf-mini-btn{background:var(--s2,#181C22);border:1px solid var(--br,rgba(255,255,255,.09));color:var(--t,#E8EAF0);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:5px 9px;border-radius:5px;cursor:pointer;transition:all .15s;}',
      '.dpf-mini-btn:hover{border-color:var(--orange,#BD5728);color:var(--orange,#BD5728);}',
      '.dpf-mini-btn.danger:hover{border-color:var(--red,#E05252);color:var(--red,#E05252);}',
      '.dpf-li-table{width:100%;border-collapse:collapse;font-size:12px;}',
      '.dpf-li-table th{padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--m,#6B7280);border-bottom:1px solid var(--br,rgba(255,255,255,.09));font-weight:600;}',
      '.dpf-li-table td{padding:6px 8px;border-bottom:1px solid var(--br,rgba(255,255,255,.09));}',
      '.dpf-li-table tr:last-child td{border-bottom:none;}',
      '.dpf-li-table input{width:100%;background:transparent;border:1px solid transparent;color:var(--t,#E8EAF0);padding:6px 8px;font-size:12px;border-radius:4px;font-family:inherit;box-sizing:border-box;}',
      '.dpf-li-table input:focus{outline:none;border-color:var(--orange,#BD5728);background:var(--s2,#181C22);}',
      '.dpf-li-table input[readonly]{opacity:.75;cursor:default;}',
      '.dpf-li-table .dpf-li-qty,.dpf-li-table .dpf-li-rate,.dpf-li-table .dpf-li-total{text-align:right;}',
      '.dpf-li-table .col-desc{width:44%;}',
      '.dpf-li-table .col-qty{width:10%;}',
      '.dpf-li-table .col-unit{width:10%;}',
      '.dpf-li-table .col-rate{width:14%;}',
      '.dpf-li-table .col-total{width:16%;}',
      '.dpf-li-table .col-x{width:6%;}',
      '.dpf-li-x{background:transparent;border:none;color:var(--m,#6B7280);font-size:14px;cursor:pointer;padding:4px;}',
      '.dpf-li-x:hover{color:var(--red,#E05252);}',
      '.dpf-li-footer{padding:10px 12px;background:var(--s3,#1E2229);border-top:1px solid var(--br,rgba(255,255,255,.09));display:flex;align-items:center;justify-content:space-between;}',
      '.dpf-li-total-final{font-size:14px;font-weight:700;color:var(--orange,#BD5728);font-family:"Barlow Condensed",sans-serif;}',
      '.dpf-scope-list{display:flex;flex-direction:column;gap:6px;}',
      '.dpf-scope-row{display:flex;align-items:center;gap:6px;}',
      '.dpf-scope-row .dpf-input{flex:1;}',
      '.dpf-photo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;padding:4px 0;}',
      '.dpf-photo-cell{position:relative;aspect-ratio:1;border-radius:6px;overflow:hidden;border:2px solid var(--br,rgba(255,255,255,.09));cursor:pointer;transition:all .15s;}',
      '.dpf-photo-cell img{width:100%;height:100%;object-fit:cover;display:block;}',
      '.dpf-photo-cell.selected{border-color:var(--orange,#BD5728);box-shadow:0 0 0 2px color-mix(in srgb, var(--orange) 25%, transparent);}',
      '.dpf-photo-check{position:absolute;top:4px;right:4px;width:20px;height:20px;background:rgba(0,0,0,.7);border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;}',
      '.dpf-photo-cell.selected .dpf-photo-check{background:var(--orange,#BD5728);}',
      '.dpf-photo-phase{position:absolute;bottom:4px;left:4px;right:4px;background:rgba(0,0,0,.75);color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:.06em;padding:2px 5px;border-radius:3px;text-align:center;}',
      '.dpf-photo-empty{grid-column:1/-1;padding:20px;text-align:center;color:var(--m,#6B7280);font-size:12px;border:1px dashed var(--br,rgba(255,255,255,.09));border-radius:6px;}',
      '.dpf-warranty-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;}',
      '.dpf-warranty-card{padding:14px 12px;border:2px solid var(--br,rgba(255,255,255,.09));border-radius:10px;background:var(--s,#111418);cursor:pointer;transition:all .15s;text-align:center;}',
      '.dpf-warranty-card:hover{border-color:var(--orange,#BD5728);}',
      '.dpf-warranty-card.selected{border-color:var(--orange,#BD5728);background:color-mix(in srgb, var(--orange) 6%, transparent);}',
      '.dpf-warranty-name{font-family:"Barlow Condensed",sans-serif;font-size:18px;font-weight:700;text-transform:uppercase;color:var(--t,#E8EAF0);letter-spacing:.04em;}',
      '.dpf-warranty-tag{font-size:11px;color:var(--orange,#BD5728);margin-top:2px;font-weight:600;}',
      '.dpf-warranty-desc{font-size:10px;color:var(--m,#6B7280);margin-top:6px;line-height:1.4;}',
      '.dpf-footer{padding:14px 22px;border-top:1px solid var(--br,rgba(255,255,255,.09));background:var(--s2,#181C22);display:flex;gap:10px;align-items:center;}',
      '.dpf-btn-cancel{background:transparent;border:1px solid var(--br,rgba(255,255,255,.09));color:var(--m,#6B7280);padding:12px 20px;border-radius:8px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;transition:all .15s;font-family:inherit;}',
      '.dpf-btn-cancel:hover{color:var(--t,#E8EAF0);border-color:var(--t,#E8EAF0);}',
      '.dpf-btn-submit{background:var(--orange,#BD5728);border:none;color:#fff;padding:12px 22px;border-radius:8px;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;transition:all .15s;flex:1;font-family:inherit;box-shadow:0 4px 12px color-mix(in srgb, var(--orange) 25%, transparent);}',
      '.dpf-btn-submit:hover{background:var(--ob,#dd875f);transform:translateY(-1px);box-shadow:0 6px 16px color-mix(in srgb, var(--orange) 35%, transparent);}',
      '.dpf-btn-submit:disabled{opacity:.5;cursor:not-allowed;transform:none;box-shadow:none;}',
      // Signers section
      '.dpf-signers{margin-bottom:16px;border:1px solid var(--br,rgba(255,255,255,.09));border-radius:10px;background:var(--s2,#181C22);overflow:hidden;}',
      '.dpf-signers-head{padding:12px 16px;border-bottom:1px solid var(--br,rgba(255,255,255,.09));background:var(--s3,#1E2229);}',
      '.dpf-signers-title{font-family:"Barlow Condensed",sans-serif;font-size:14px;font-weight:700;color:var(--t,#E8EAF0);text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid var(--orange,#BD5728);padding-bottom:3px;display:inline-block;margin:0;}',
      '.dpf-signers-help{font-size:11px;color:var(--m,#6B7280);margin-top:6px;line-height:1.4;}',
      '.dpf-signers-body{padding:6px 16px 12px;}',
      '.dpf-signer-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--br,rgba(255,255,255,.06));}',
      '.dpf-signer-row:last-child{border-bottom:none;}',
      '.dpf-signer-row input[type="checkbox"]{width:18px;height:18px;accent-color:var(--orange,#BD5728);cursor:pointer;flex-shrink:0;}',
      '.dpf-signer-label-input{flex:1;background:transparent;border:1px solid transparent;color:var(--t,#E8EAF0);padding:6px 8px;font-size:13px;border-radius:6px;font-family:inherit;min-width:0;}',
      '.dpf-signer-label-input:focus{outline:none;border-color:var(--orange,#BD5728);background:var(--s,#111418);}',
      '.dpf-signer-required-tag{font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 6px;border-radius:3px;background:rgba(224,82,82,.12);color:var(--red,#E05252);border:1px solid rgba(224,82,82,.3);flex-shrink:0;}',
      '.dpf-signer-remove{background:transparent;border:none;color:var(--m,#6B7280);font-size:18px;cursor:pointer;padding:4px 8px;line-height:1;flex-shrink:0;}',
      '.dpf-signer-remove:hover{color:var(--red,#E05252);}',
      '.dpf-signer-add{display:flex;gap:8px;align-items:center;margin-top:10px;padding-top:10px;border-top:1px dashed var(--br,rgba(255,255,255,.09));}',
      '.dpf-signer-add label{font-size:11px;color:var(--m,#6B7280);text-transform:uppercase;letter-spacing:.05em;font-weight:600;}',
      '.dpf-signer-add select{background:var(--s,#111418);border:1px solid var(--br,rgba(255,255,255,.09));color:var(--t,#E8EAF0);padding:6px 10px;border-radius:6px;font-size:12px;font-family:inherit;cursor:pointer;}',
      '.dpf-signer-add select:focus{outline:none;border-color:var(--orange,#BD5728);}',
      '.dpf-signers-empty{font-size:12px;color:var(--m,#6B7280);font-style:italic;padding:8px 0;}',
      '@media (max-width:640px){',
      '  .dpf-overlay{padding:0;}',
      '  .dpf-card{max-width:100vw;max-height:100vh;border-radius:0;}',
      '  .dpf-warranty-grid{grid-template-columns:1fr;}',
      '  .dpf-li-table .col-desc{width:38%;}',
      '  .dpf-header{padding:14px 16px 10px;}',
      '  .dpf-body{padding:14px 16px;}',
      '  .dpf-footer{padding:12px 16px;flex-direction:column-reverse;}',
      '  .dpf-btn-cancel,.dpf-btn-submit{width:100%;}',
      '}'
    ].join('\n');
    var style = document.createElement('style');
    style.id = MODAL_STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 6: FIELD RENDERERS
  // ═══════════════════════════════════════════════════════════════

  function renderField(field, value) {
    var helpHTML = field.help ? '<div class="dpf-field-help">' + esc(field.help) + '</div>' : '';
    var errorHTML = '<div class="dpf-field-error">This field is required.</div>';
    var labelHTML = renderLabel(field);
    var bodyHTML = '';

    switch (field.type) {
      case 'text':
      case 'email':
      case 'tel':
        bodyHTML = '<input class="dpf-input" type="' + field.type + '" data-field="' + esc(field.key) + '" value="' + esc(value || '') + '" placeholder="' + esc(field.placeholder || '') + '">';
        break;
      case 'number':
        bodyHTML = '<input class="dpf-input" type="number" step="any" data-field="' + esc(field.key) + '" value="' + esc(value === 0 ? '0' : (value || '')) + '" placeholder="' + esc(field.placeholder || '') + '">';
        break;
      case 'date':
        bodyHTML = '<input class="dpf-input" type="date" data-field="' + esc(field.key) + '" value="' + esc(toDateInput(value) || value || '') + '">';
        break;
      case 'currency':
        bodyHTML = '<div class="dpf-currency-wrap"><input class="dpf-input" type="number" step="0.01" data-field="' + esc(field.key) + '" value="' + esc(value === 0 ? '0' : (value || '')) + '" placeholder="0.00"></div>';
        break;
      case 'textarea':
        bodyHTML = '<textarea class="dpf-textarea" rows="' + (field.rows || 3) + '" data-field="' + esc(field.key) + '" placeholder="' + esc(field.placeholder || '') + '">' + esc(value || '') + '</textarea>';
        break;
      case 'select':
        var optsHTML = (field.options || []).map(function (o) {
          var sel = String(o.value) === String(value) ? ' selected' : '';
          return '<option value="' + esc(o.value) + '"' + sel + '>' + esc(o.label) + '</option>';
        }).join('');
        bodyHTML = '<select class="dpf-select" data-field="' + esc(field.key) + '">' + (value ? '' : '<option value="">Select...</option>') + optsHTML + '</select>';
        break;
      case 'checkbox':
        var checked = (value === true || value === 'true' || value === 1 || value === '1') ? ' checked' : '';
        bodyHTML = '<label class="dpf-checkbox-wrap"><input type="checkbox" data-field="' + esc(field.key) + '"' + checked + '><span>' + esc(field.checkboxLabel || 'Yes') + '</span></label>';
        break;
      case 'line-items':
        bodyHTML = renderLineItems(field, value);
        break;
      case 'scope-list':
        bodyHTML = renderScopeList(field, value);
        break;
      case 'photo-selector':
        bodyHTML = renderPhotoSelector(field, value);
        break;
      case 'warranty-tier':
        bodyHTML = renderWarrantyTier(field, value);
        break;
      default:
        bodyHTML = '<input class="dpf-input" type="text" data-field="' + esc(field.key) + '" value="' + esc(value || '') + '">';
    }

    var missingCls = fieldRequired(field) && isEmpty(value) ? ' missing' : '';
    return '<div class="dpf-field' + missingCls + '" data-field-wrap="' + esc(field.key) + '">' +
      labelHTML + bodyHTML + helpHTML + errorHTML +
      '</div>';
  }

  function renderLabel(field) {
    var dot = fieldRequired(field) ? '<span class="dpf-required-dot" title="Required"></span>' : '';
    var badge = '<span class="dpf-persist-badge ' + field.persist + '" title="' + persistTooltip(field.persist) + '">' + persistLabel(field.persist) + '</span>';
    return '<div class="dpf-field-label">' + dot + esc(field.label) + badge + '</div>';
  }

  function persistLabel(p) {
    if (p === PERSIST.LEAD) return 'Updates customer';
    if (p === PERSIST.DOCUMENT) return 'This doc only';
    return 'Ephemeral';
  }

  function persistTooltip(p) {
    if (p === PERSIST.LEAD) return 'Edits saved to the customer record.';
    if (p === PERSIST.DOCUMENT) return 'Edits saved as an override for this document type only.';
    return 'Edits used once and discarded.';
  }

  function isEmpty(v) {
    if (v === null || v === undefined || v === '') return true;
    if (Array.isArray(v) && v.length === 0) return true;
    return false;
  }

  // ── ADDRESS COMPLETENESS ────────────────────────────────────────
  // `required` only asserts non-empty, so "Fairfield, OH 45014" — a
  // Thumbtack lead that never shared its street — passed the gate and
  // five invoices generated on 2026-08-18 carrying no street address.
  // These check the address is actually deliverable. See
  // documentation/audit/CRM-ADDRESS-INTEGRITY-2026-08-18.md.
  var ADDR_HOUSE_NUMBER = /^\s*\d+[a-zA-Z]?\s+\S/;   // "1944 Kentucky Ave"
  var ADDR_LEGACY_MANGLED = /^\s*\d+[a-zA-Z]?\s*,/;   // "7003, Greenstone Trace, ..."
  var ADDR_ZIP = /\b\d{5}(-\d{4})?\b/;
  var ADDR_STATE = /\b(OH|KY|IN)\b/i;

  function validateAddressCompleteness(v) {
    var t = String(v == null ? '' : v).trim();
    if (!t) return null;  // `required` already covers empty
    if (ADDR_LEGACY_MANGLED.test(t)) {
      return 'looks mangled (comma straight after the house number) — check it against the customer folder';
    }
    var gaps = [];
    if (!ADDR_HOUSE_NUMBER.test(t)) gaps.push('street number');
    if (!ADDR_STATE.test(t)) gaps.push('state');
    if (!ADDR_ZIP.test(t)) gaps.push('ZIP');
    if (!gaps.length) return null;
    return 'missing ' + gaps.join(' + ');
  }

  // ── KENTUCKY SB 153 (2026-09-27) ────────────────────────────────
  // ky-insurance-law.js decides; these gather the facts (the address the
  // form shows NOW, the lead's job type / claim / carrier, the estimate's
  // mode). A Kentucky insurance contract or proposal:
  //   - is BLOCKED without the contractor's business address on the Company
  //     Profile (KRS 367.624(1) mailing address; (4) the cancellation form's
  //     physical address) — never invented, never NBD's;
  //   - shows (non-blocking) that nothing is due at signing: deposit-rule.js
  //     holds the deductible + ACV payment until after the insurer's written
  //     decision and the 5-business-day window (KRS 367.626; Jo, 2026-09-27).
  function legalJurisdiction() {
    var J = window.NBDJurisdiction;
    if (!J) return null;
    var lead = window._leadDoc || {};
    var est = state.estimate || {};
    return J.classify({
      address: state.values.address || state.values.homeownerAddress || lead.address || '',
      zip: lead.zip || '',
      state: lead.state || '',
      jobType: lead.jobType || '',
      mode: est.mode || est.jobMode || '',
      claimNumber: state.values.claimNumber || lead.claimNumber || '',
      insuranceCarrier: lead.insuranceCarrier || '',
      insCarrier: lead.insCarrier || '',
      insurance: est.insurance === true ? true : undefined
    });
  }

  // brand.contact.mailingAddress ("Mailing Address (one line)") — the same
  // source the contract prints; never businessAddress (Jo, 2026-09-27).
  function contractorBusinessAddress() {
    var DG = window.NBDDocGen;
    if (DG && typeof DG._contractorPhysicalAddress === 'function') return DG._contractorPhysicalAddress();
    var J = window.NBDJurisdiction;
    var cp = (window._legal ? window._legal() : window._companyProfile) || {};
    return J ? J.contractorMailingAddress(cp) : '';
  }

  function collectLegalNotes() {
    var J = window.NBDJurisdiction;
    if (!J || (state.type !== 'contract' && state.type !== 'proposal')) return [];
    var j = legalJurisdiction();
    if (!j || !j.kyInsurance) return [];
    var out = [];
    if (!contractorBusinessAddress()) out.push({ level: 'block', message: J.MSG.addressRequired });
    // The deposit is no longer a warning: deposit-rule.js itself puts $0 at
    // signing on a Kentucky insurance job (Jo, 2026-09-27). Say so.
    out.push({ level: 'warn', message: J.MSG.depositHold });
    if (!j.stateKnown) out.push({ level: 'warn', message: J.MSG.stateUnknown });
    return out;
  }

  // Field-key → validator. Runs on submit, after the required check.
  var FIELD_VALIDATORS = {
    address: validateAddressCompleteness,
    projectAddress: validateAddressCompleteness,
    homeownerAddress: validateAddressCompleteness,
    propertyAddress: validateAddressCompleteness
  };

  function collectSoftIssues() {
    var out = [];
    Object.keys(state.fieldIndex).forEach(function (k) {
      var fn = FIELD_VALIDATORS[k];
      if (typeof fn !== 'function') return;
      var msg = fn(state.values[k]);
      if (msg) out.push({ label: state.fieldIndex[k].label || k, message: msg });
    });
    return out;
  }

  // ── LINE ITEMS RENDERER ─────────────────────────────────────
  function renderLineItems(field, value) {
    var items = Array.isArray(value) ? value : [];
    var mode = state.lineItemsMode[field.key] || 'locked';
    var readonly = mode === 'locked';
    var badgeCls = readonly ? '' : ' override';
    var badgeText = readonly ? 'From estimate' : 'Override mode';

    var overrideBtn = readonly
      ? '<button type="button" class="dpf-mini-btn" data-li-override="' + esc(field.key) + '">Override</button>'
      : '<button type="button" class="dpf-mini-btn danger" data-li-revert="' + esc(field.key) + '">Revert to estimate</button>';

    var addBtn = readonly ? '' : '<button type="button" class="dpf-mini-btn" data-li-add="' + esc(field.key) + '">+ Add item</button>';
    var saveBtn = readonly ? '' : '<button type="button" class="dpf-mini-btn" data-li-save-est="' + esc(field.key) + '">Save to estimate</button>';

    var rowsHTML = items.map(function (it, idx) {
      var qty = parseFloat(it.qty || 0);
      var rate = parseFloat(it.rate || 0);
      var total = (it.total !== undefined && it.total !== null && !isNaN(parseFloat(it.total))) ? parseFloat(it.total) : (qty * rate);
      var ro = readonly ? ' readonly' : '';
      var xBtn = readonly ? '' : '<button type="button" class="dpf-li-x" data-li-remove="' + esc(field.key) + '" data-idx="' + idx + '" title="Remove">&times;</button>';
      return '<tr>' +
        '<td class="col-desc"><input type="text" data-li-field="' + esc(field.key) + '" data-li-prop="description" data-idx="' + idx + '" value="' + esc(it.description || '') + '"' + ro + '></td>' +
        '<td class="col-qty dpf-li-qty"><input type="number" step="any" data-li-field="' + esc(field.key) + '" data-li-prop="qty" data-idx="' + idx + '" value="' + esc(qty) + '"' + ro + '></td>' +
        '<td class="col-unit"><input type="text" data-li-field="' + esc(field.key) + '" data-li-prop="unit" data-idx="' + idx + '" value="' + esc(it.unit || 'ea') + '"' + ro + '></td>' +
        '<td class="col-rate dpf-li-rate"><input type="number" step="any" data-li-field="' + esc(field.key) + '" data-li-prop="rate" data-idx="' + idx + '" value="' + esc(rate) + '"' + ro + '></td>' +
        '<td class="col-total dpf-li-total"><input type="number" step="any" data-li-field="' + esc(field.key) + '" data-li-prop="total" data-idx="' + idx + '" value="' + esc(total.toFixed(2)) + '"' + ro + '></td>' +
        (readonly ? '' : '<td class="col-x">' + xBtn + '</td>') +
      '</tr>';
    }).join('');

    if (!rowsHTML) {
      var colspan = readonly ? 5 : 6;
      rowsHTML = '<tr><td colspan="' + colspan + '" style="text-align:center;color:var(--m,#6B7280);padding:16px;font-size:11px;">No line items yet. Click Override to start adding.</td></tr>';
    }

    var grandTotal = items.reduce(function (sum, it) {
      var t = parseFloat(it.total);
      if (isNaN(t)) t = (parseFloat(it.qty) || 0) * (parseFloat(it.rate) || 0);
      return sum + t;
    }, 0);

    return '<div class="dpf-line-items">' +
      '<div class="dpf-line-items-head">' +
        '<span class="dpf-line-items-badge' + badgeCls + '">' + badgeText + '</span>' +
        '<div class="dpf-line-items-btns">' + overrideBtn + addBtn + saveBtn + '</div>' +
      '</div>' +
      '<table class="dpf-li-table"><thead><tr>' +
        '<th class="col-desc">Description</th>' +
        '<th class="col-qty dpf-li-qty">Qty</th>' +
        '<th class="col-unit">Unit</th>' +
        '<th class="col-rate dpf-li-rate">Rate</th>' +
        '<th class="col-total dpf-li-total">Total</th>' +
        (readonly ? '' : '<th class="col-x"></th>') +
      '</tr></thead><tbody>' + rowsHTML + '</tbody></table>' +
      '<div class="dpf-li-footer"><span style="font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--m,#6B7280);">Grand Total</span><span class="dpf-li-total-final">' + fmtCurrency(grandTotal) + '</span></div>' +
    '</div>';
  }

  // ── SCOPE LIST RENDERER ─────────────────────────────────────
  function renderScopeList(field, value) {
    var items = Array.isArray(value) ? value : (value ? [value] : []);
    if (items.length === 0) items = [''];
    var rows = items.map(function (it, idx) {
      return '<div class="dpf-scope-row">' +
        '<span style="color:var(--orange,#BD5728);font-weight:700;">&bull;</span>' +
        '<input class="dpf-input" type="text" data-scope-field="' + esc(field.key) + '" data-idx="' + idx + '" value="' + esc(it) + '" placeholder="Scope item">' +
        '<button type="button" class="dpf-li-x" data-scope-remove="' + esc(field.key) + '" data-idx="' + idx + '" title="Remove">&times;</button>' +
      '</div>';
    }).join('');
    return '<div class="dpf-scope-list">' + rows + '</div>' +
      '<button type="button" class="dpf-mini-btn" style="margin-top:8px;" data-scope-add="' + esc(field.key) + '">+ Add scope item</button>';
  }

  // ── PHOTO SELECTOR RENDERER ─────────────────────────────────
  function renderPhotoSelector(field, value) {
    var allPool;
    if (field.source === 'photos.before') allPool = (window._allPhotos || []).filter(function (p) { return (p.phase || '').toLowerCase() === 'before'; });
    else if (field.source === 'photos.after') allPool = (window._allPhotos || []).filter(function (p) { return (p.phase || '').toLowerCase() === 'after'; });
    else if (field.source === 'photos.during') allPool = (window._allPhotos || []).filter(function (p) { return (p.phase || '').toLowerCase() === 'during'; });
    else allPool = window._allPhotos || [];

    if (!allPool.length) {
      return '<div class="dpf-photo-empty">No photos available for this customer.</div>';
    }

    var selectedIds = Array.isArray(value) ? value.map(function (p) { return typeof p === 'string' ? p : p.id; }).filter(Boolean) : [];

    var cells = allPool.map(function (p) {
      var isSel = selectedIds.indexOf(p.id) !== -1;
      var cls = isSel ? ' selected' : '';
      var phaseLabel = p.phase ? '<div class="dpf-photo-phase">' + esc(p.phase) + '</div>' : '';
      return '<div class="dpf-photo-cell' + cls + '" data-photo-field="' + esc(field.key) + '" data-photo-id="' + esc(p.id) + '">' +
        '<img src="' + esc(p.url) + '" alt="" loading="lazy">' +
        '<div class="dpf-photo-check">' + (isSel ? '&#10003;' : '') + '</div>' +
        phaseLabel +
      '</div>';
    }).join('');

    return '<div class="dpf-photo-grid">' + cells + '</div>';
  }

  // ── WARRANTY TIER RENDERER ──────────────────────────────────
  function renderWarrantyTier(field, value) {
    // Job-type warranty (2026-09-25): the estimate already decides it, so show
    // what will print instead of offering tier cards that would override it.
    if (jobWarrantyGoverns()) {
      var jt = state.jobWarranty.text;
      return '<div class="dpf-warranty-grid"><div class="dpf-warranty-card selected" data-job-warranty="1">' +
        '<div class="dpf-warranty-name">From the estimate</div>' +
        '<div class="dpf-warranty-desc">' + (jt
          ? esc(jt)
          // An estimate saved before job-type warranties never had the repair
          // box, so "quoted without one" would be false for it (review
          // 2026-09-25) — tell the rep how to attach one instead.
          : state.jobWarranty.legacy
            ? 'No workmanship warranty — this estimate predates job-type warranties; re-create it from Job Templates to attach one.'
            : 'No workmanship warranty — this job type carries none, or the repair was quoted without one.') +
        '</div></div></div>';
    }
    // GBB audit, 2026-09-09: was 5/10/20-year — see WARRANTY_TIER_OPTIONS above.
    // Five tiers since 2026-10-02 — Economy is 1-year labor, never lifetime.
    var tiers = [
      { id: 'economy', name: 'Economy', tag: '1-Year Labor',              desc: '1-year workmanship (labor) warranty. Shingle manufacturer\'s standard limited warranty; no system warranty.' },
      { id: 'good',   name: 'Good',   tag: 'Lifetime Workmanship',        desc: 'Lifetime workmanship warranty, non-transferable. Standard manufacturer coverage.' },
      { id: 'better', name: 'Better', tag: 'Lifetime + Enhanced Mfr',     desc: 'Lifetime workmanship, transferable to 1 subsequent owner. Enhanced manufacturer coverage.' },
      { id: 'best',   name: 'Best',   tag: 'Lifetime + Premium Mfr',      desc: 'Lifetime workmanship, fully transferable + annual inspection. Premium manufacturer coverage.' },
      { id: 'beyond', name: 'Beyond', tag: 'Lifetime + HailGuard Hail',   desc: 'Lifetime workmanship, fully transferable + annual inspection. TAMKO HailGuard shingles with TAMKO\'s hail warranty.' }
    ];
    var cur = (value || 'better').toLowerCase();
    var cards = tiers.map(function (t) {
      var sel = t.id === cur ? ' selected' : '';
      return '<div class="dpf-warranty-card' + sel + '" data-warranty-field="' + esc(field.key) + '" data-warranty-tier="' + t.id + '">' +
        '<div class="dpf-warranty-name">' + t.name + '</div>' +
        '<div class="dpf-warranty-tag">' + t.tag + '</div>' +
        '<div class="dpf-warranty-desc">' + t.desc + '</div>' +
      '</div>';
    }).join('');
    return '<div class="dpf-warranty-grid">' + cards + '</div>';
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 7: MODAL ASSEMBLY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Render the Signers section: one checkbox row per signer in
   * state.signers (template defaults + any ad-hoc additions) plus an
   * "Add signer" dropdown. The selected signers flow into
   * mergedData.signers at submit() and become canvas blocks in the
   * generated doc. Returns '' if no signers (UI hidden entirely).
   */
  function renderSignersSection() {
    if (!Array.isArray(state.signers)) return '';
    var rowsHTML;
    if (state.signers.length === 0) {
      rowsHTML = '<div class="dpf-signers-empty">No signers configured. Use the picker below to add one if this document needs a signature.</div>';
    } else {
      rowsHTML = state.signers.map(function (s, idx) {
        var safeLabel = esc(s.label);
        var requiredTag = s.required ? '<span class="dpf-signer-required-tag">Required</span>' : '';
        var removeBtn = s.removable
          ? '<button type="button" class="dpf-signer-remove" data-dpf-signer-remove="' + idx + '" title="Remove signer">&times;</button>'
          : '<span style="display:inline-block;width:28px;flex-shrink:0;"></span>';
        return '<div class="dpf-signer-row" data-signer-idx="' + idx + '">' +
          '<input type="checkbox" data-dpf-signer-toggle="' + idx + '"' + (s.enabled ? ' checked' : '') + ' />' +
          '<input type="text" class="dpf-signer-label-input" data-dpf-signer-label="' + idx + '" value="' + safeLabel + '" />' +
          requiredTag +
          removeBtn +
        '</div>';
      }).join('');
    }

    var addOptionsHTML = SIGNER_ROLE_OPTIONS.map(function (o) {
      return '<option value="' + esc(o.role) + '">' + esc(o.label) + '</option>';
    }).join('');

    return '<div class="dpf-signers">' +
      '<div class="dpf-signers-head">' +
        '<h3 class="dpf-signers-title">Signers</h3>' +
        '<div class="dpf-signers-help">Each enabled signer becomes a sign-here box in the generated document. Uncheck to skip, edit labels inline, or add another with the picker below.</div>' +
      '</div>' +
      '<div class="dpf-signers-body">' +
        rowsHTML +
        '<div class="dpf-signer-add">' +
          '<label for="dpf-add-signer">Add signer:</label>' +
          '<select id="dpf-add-signer" data-dpf-signer-add>' +
            '<option value="">&mdash; pick role &mdash;</option>' +
            addOptionsHTML +
          '</select>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function renderModal() {
    var schema = state.schema;
    var sectionsHTML = schema.sections.map(function (sec) {
      var collapsed = (sec.collapsed && !state.showAll) ? ' collapsed' : '';
      // The deposit note sits right under the last deposit field (2026-09-25).
      var lastDep = -1;
      if (state.deposit) sec.fields.forEach(function (f, i) { if (isDepositField(f)) lastDep = i; });
      var fieldsHTML = sec.fields.map(function (f, i) {
        return renderField(f, state.values[f.key]) +
          (i === lastDep ? '<div class="dpf-deposit-note" data-dpf-deposit-note>' + depositNoteHTML() + '</div>' : '');
      }).join('');
      return '<div class="dpf-section' + collapsed + '" data-section="' + esc(sec.id) + '">' +
        '<div class="dpf-section-head" data-section-toggle="' + esc(sec.id) + '">' +
          '<h3 class="dpf-section-title">' + esc(sec.title) + '</h3>' +
          '<span class="dpf-section-chevron">&#9660;</span>' +
        '</div>' +
        '<div class="dpf-section-body">' + fieldsHTML + '</div>' +
      '</div>';
    }).join('');

    var missingCount = countMissingRequired();
    var bannerHTML = missingCount > 0
      ? '<div class="dpf-required-banner"><span style="font-size:14px;">&#9888;</span><span><strong>' + missingCount + ' required field' + (missingCount > 1 ? 's' : '') + '</strong> need attention before generating.</span></div>'
      : '<div class="dpf-required-banner hidden"></div>';

    // Address-completeness warning. Soft-blocks the first submit; the
    // button becomes GENERATE ANYWAY so a thin address can never leave
    // silently, but a genuinely street-less Thumbtack lead is not a
    // dead end.
    var softHTML = state.softIssues.length
      ? '<div class="dpf-required-banner" style="border-color:color-mix(in srgb, var(--red,#E05252) 35%, transparent);color:var(--red,#E05252);">' +
          '<span style="font-size:14px;">&#9888;</span><span><strong>Check the address before this goes out.</strong> ' +
          state.softIssues.map(function (i) { return esc(i.label) + ' ' + esc(i.message); }).join('; ') +
          '.</span></div>'
      : '';

    // Kentucky insurance job: the blocking address note in red, the deposit
    // warning in amber (2026-09-27).
    var legalHTML = (state.legalNotes || []).map(function (n) {
      var red = n.level === 'block';
      return '<div class="dpf-required-banner" data-dpf-legal="' + (red ? 'block' : 'warn') + '" style="border-color:color-mix(in srgb, ' +
        (red ? 'var(--red,#E05252)' : 'var(--orange,#BD5728)') + ' 35%, transparent);color:' +
        (red ? 'var(--red,#E05252)' : 'var(--orange,#BD5728)') + ';">' +
        '<span style="font-size:14px;">&#9888;</span><span>' + (red ? '<strong>Cannot send yet.</strong> ' : '<strong>Kentucky insurance job.</strong> ') +
        esc(n.message) + '</span></div>';
    }).join('');

    var html =
      '<div class="dpf-overlay" id="' + MODAL_ID + '" data-dpf-overlay>' +
        '<div class="dpf-card" role="dialog" aria-labelledby="dpf-title">' +
          '<div class="dpf-header">' +
            '<div>' +
              '<h2 class="dpf-title" id="dpf-title">' + esc(schema.title) + '</h2>' +
              '<div class="dpf-subtitle">' + esc(schema.subtitle || 'Review before generating.') + '</div>' +
            '</div>' +
            '<div class="dpf-actions">' +
              '<button type="button" class="dpf-showall' + (state.showAll ? ' active' : '') + '" data-dpf-showall>' + (state.showAll ? 'Collapse' : 'Show all fields') + '</button>' +
              '<button type="button" class="dpf-icon-btn" data-dpf-close title="Close">&times;</button>' +
            '</div>' +
          '</div>' +
          '<div class="dpf-body">' +
            bannerHTML +
            legalHTML +
            softHTML +
            sectionsHTML +
            renderSignersSection() +
          '</div>' +
          '<div class="dpf-footer">' +
            '<button type="button" class="dpf-btn-cancel" data-dpf-close>Cancel</button>' +
            '<button type="button" class="dpf-btn-submit" data-dpf-submit>' + (state.softIssues.length ? 'Generate Anyway &rarr;' : 'Generate Document &rarr;') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Remove any prior modal before re-inserting
    var prior = document.getElementById(MODAL_ID);
    if (prior) prior.remove();

    var wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstChild);
    bindModalEvents();
  }

  function countMissingRequired() {
    var n = 0;
    Object.keys(state.fieldIndex).forEach(function (k) {
      var f = state.fieldIndex[k];
      if (fieldRequired(f) && isEmpty(state.values[k])) n++;
    });
    return n;
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 8: EVENT BINDING
  // ═══════════════════════════════════════════════════════════════

  /**
   * Bind events once using delegation at the modal root. Because all
   * handlers live on the root, a partial re-render via redrawField()
   * does not require rebinding — the fresh child elements are picked
   * up automatically by event bubbling.
   */
  function bindModalEvents() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;

    // Remove any prior keydown handler (safe no-op if not attached)
    // then attach a fresh one so Esc only closes the current modal.
    document.removeEventListener('keydown', escHandler);
    document.addEventListener('keydown', escHandler);

    // Click delegation (handles overlay close, buttons, photo/warranty cards)
    modal.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      // Overlay backdrop click closes (only if clicking exactly the overlay)
      if (t.hasAttribute && t.hasAttribute('data-dpf-overlay')) { close(); return; }

      var closeBtn = t.closest ? t.closest('[data-dpf-close]') : null;
      if (closeBtn) { close(); return; }

      var showAllBtn = t.closest ? t.closest('[data-dpf-showall]') : null;
      if (showAllBtn) {
        state.showAll = !state.showAll;
        renderModal();
        return;
      }

      var secHead = t.closest ? t.closest('[data-section-toggle]') : null;
      if (secHead) {
        var sec = secHead.closest('.dpf-section');
        if (sec) sec.classList.toggle('collapsed');
        return;
      }

      // Signer remove
      var sigRemove = t.closest ? t.closest('[data-dpf-signer-remove]') : null;
      if (sigRemove) {
        var rmIdx = parseInt(sigRemove.getAttribute('data-dpf-signer-remove'), 10);
        if (!isNaN(rmIdx) && state.signers[rmIdx] && state.signers[rmIdx].removable) {
          state.signers.splice(rmIdx, 1);
          renderModal();
        }
        return;
      }

      // Line item buttons
      var overrideBtn = t.closest ? t.closest('[data-li-override]') : null;
      if (overrideBtn) {
        var k1 = overrideBtn.getAttribute('data-li-override');
        state.lineItemsMode[k1] = 'override';
        redrawField(k1);
        return;
      }
      var revertBtn = t.closest ? t.closest('[data-li-revert]') : null;
      if (revertBtn) {
        var k2 = revertBtn.getAttribute('data-li-revert');
        var est = pickPreflightEstimate();
        state.values[k2] = mapEstimateLineItems(est);
        state.lineItemsMode[k2] = 'locked';
        redrawField(k2);
        return;
      }
      var addBtn = t.closest ? t.closest('[data-li-add]') : null;
      if (addBtn) {
        var k3 = addBtn.getAttribute('data-li-add');
        var arr3 = Array.isArray(state.values[k3]) ? state.values[k3].slice() : [];
        arr3.push({ description: '', qty: 1, unit: 'ea', rate: 0, total: 0 });
        state.values[k3] = arr3;
        redrawField(k3);
        return;
      }
      var removeBtn = t.closest ? t.closest('[data-li-remove]') : null;
      if (removeBtn) {
        var k4 = removeBtn.getAttribute('data-li-remove');
        var idx4 = parseInt(removeBtn.getAttribute('data-idx'), 10);
        var arr4 = Array.isArray(state.values[k4]) ? state.values[k4].slice() : [];
        arr4.splice(idx4, 1);
        state.values[k4] = arr4;
        redrawField(k4);
        return;
      }
      var saveEstBtn = t.closest ? t.closest('[data-li-save-est]') : null;
      if (saveEstBtn) {
        var k5 = saveEstBtn.getAttribute('data-li-save-est');
        saveLineItemsToEstimate(k5);
        return;
      }

      // Scope list
      var scopeAdd = t.closest ? t.closest('[data-scope-add]') : null;
      if (scopeAdd) {
        var k6 = scopeAdd.getAttribute('data-scope-add');
        var arr6 = Array.isArray(state.values[k6]) ? state.values[k6].slice() : [];
        arr6.push('');
        state.values[k6] = arr6;
        redrawField(k6);
        return;
      }
      var scopeRem = t.closest ? t.closest('[data-scope-remove]') : null;
      if (scopeRem) {
        var k7 = scopeRem.getAttribute('data-scope-remove');
        var idx7 = parseInt(scopeRem.getAttribute('data-idx'), 10);
        var arr7 = Array.isArray(state.values[k7]) ? state.values[k7].slice() : [];
        arr7.splice(idx7, 1);
        if (arr7.length === 0) arr7.push('');
        state.values[k7] = arr7;
        redrawField(k7);
        return;
      }

      // Photo selector
      var photoCell = t.closest ? t.closest('[data-photo-field]') : null;
      if (photoCell) {
        var k8 = photoCell.getAttribute('data-photo-field');
        var id8 = photoCell.getAttribute('data-photo-id');
        var current = Array.isArray(state.values[k8]) ? state.values[k8].slice() : [];
        var ids = current.map(function (p) { return typeof p === 'string' ? p : (p && p.id); });
        var pos = ids.indexOf(id8);
        if (pos === -1) {
          var photo = (window._allPhotos || []).find(function (p) { return p.id === id8; });
          if (photo) current.push(photo);
        } else {
          current.splice(pos, 1);
        }
        state.values[k8] = current;
        redrawField(k8);
        return;
      }

      // Warranty tier card
      var warrantyCard = t.closest ? t.closest('[data-warranty-field]') : null;
      if (warrantyCard) {
        var k9 = warrantyCard.getAttribute('data-warranty-field');
        var tier = warrantyCard.getAttribute('data-warranty-tier');
        state.values[k9] = tier;
        redrawField(k9);
        return;
      }

      // Submit
      var submitBtn = t.closest ? t.closest('[data-dpf-submit]') : null;
      if (submitBtn) {
        submit();
        return;
      }
    });

    // Input delegation — handles all simple fields (text/textarea/select/etc)
    // plus line-items and scope-list inputs
    var inputHandler = function (e) {
      var el = e.target;
      if (!el) return;

      // Signer checkbox toggle
      if (el.hasAttribute && el.hasAttribute('data-dpf-signer-toggle')) {
        var sIdx = parseInt(el.getAttribute('data-dpf-signer-toggle'), 10);
        if (!isNaN(sIdx) && state.signers[sIdx]) state.signers[sIdx].enabled = !!el.checked;
        return;
      }

      // Signer label text change
      if (el.hasAttribute && el.hasAttribute('data-dpf-signer-label')) {
        var lIdx = parseInt(el.getAttribute('data-dpf-signer-label'), 10);
        if (!isNaN(lIdx) && state.signers[lIdx]) state.signers[lIdx].label = el.value;
        return;
      }

      // Add signer dropdown
      if (el.hasAttribute && el.hasAttribute('data-dpf-signer-add')) {
        var role = el.value;
        if (!role) return;
        el.value = ''; // reset so the same role can be added again
        var defaultLabel = (SIGNER_ROLE_OPTIONS.find(function (o) { return o.role === role; }) || {}).label || role;
        if (role === 'other') {
          var custom = window.prompt('Label for this signer (e.g. "Project Manager"):', '');
          if (custom === null) return; // cancelled
          defaultLabel = custom.trim() || 'Signer';
        }
        state.signers.push({
          role: role,
          label: defaultLabel,
          required: false,
          enabled: true,
          removable: true,
        });
        renderModal();
        return;
      }

      // Simple field
      if (el.hasAttribute && el.hasAttribute('data-field')) {
        var key = el.getAttribute('data-field');
        var v;
        if (el.type === 'checkbox') v = el.checked;
        else if (el.type === 'number') v = el.value === '' ? '' : parseFloat(el.value);
        else v = el.value;
        state.values[key] = v;
        updateFieldMissingState(key);
        // Deposit rule (2026-09-25): an untouched deposit follows the price;
        // the note re-states the plan on every price or deposit edit.
        if (state.deposit && (key === 'totalPrice' || Object.prototype.hasOwnProperty.call(state.deposit.defaults, key))) {
          refreshDepositDefaults(modal);
          updateDepositNote(modal);
        }
        return;
      }

      // Line item cell
      if (el.hasAttribute && el.hasAttribute('data-li-field')) {
        var key2 = el.getAttribute('data-li-field');
        var prop = el.getAttribute('data-li-prop');
        var idx = parseInt(el.getAttribute('data-idx'), 10);
        var arr = Array.isArray(state.values[key2]) ? state.values[key2] : [];
        if (!arr[idx]) arr[idx] = {};
        var v2 = el.value;
        if (prop === 'qty' || prop === 'rate' || prop === 'total') {
          v2 = v2 === '' ? '' : parseFloat(v2);
        }
        arr[idx][prop] = v2;
        if (prop === 'qty' || prop === 'rate') {
          var qty = parseFloat(arr[idx].qty) || 0;
          var rate = parseFloat(arr[idx].rate) || 0;
          arr[idx].total = qty * rate;
          var totalEl = modal.querySelector('[data-li-field="' + CSS.escape(key2) + '"][data-li-prop="total"][data-idx="' + idx + '"]');
          if (totalEl) totalEl.value = (qty * rate).toFixed(2);
        }
        state.values[key2] = arr;
        updateLineItemsGrandTotal(key2);
        return;
      }

      // Scope list item
      if (el.hasAttribute && el.hasAttribute('data-scope-field')) {
        var key3 = el.getAttribute('data-scope-field');
        var idx3 = parseInt(el.getAttribute('data-idx'), 10);
        var arr3 = Array.isArray(state.values[key3]) ? state.values[key3].slice() : [];
        arr3[idx3] = el.value;
        state.values[key3] = arr3;
        return;
      }
    };
    modal.addEventListener('input', inputHandler);
    modal.addEventListener('change', inputHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape' && state.open) close();
  }

  function updateFieldMissingState(key) {
    var wrap = document.querySelector('[data-field-wrap="' + CSS.escape(key) + '"]');
    if (!wrap) return;
    var f = state.fieldIndex[key];
    if (!f) return;
    if (fieldRequired(f) && isEmpty(state.values[key])) wrap.classList.add('missing');
    else wrap.classList.remove('missing');
    // Update banner count
    var banner = document.querySelector('#' + MODAL_ID + ' .dpf-required-banner');
    if (banner) {
      var n = countMissingRequired();
      if (n > 0) {
        banner.classList.remove('hidden');
        banner.innerHTML = '<span style="font-size:14px;">&#9888;</span><span><strong>' + n + ' required field' + (n > 1 ? 's' : '') + '</strong> need attention before generating.</span>';
      } else {
        banner.classList.add('hidden');
      }
    }
  }

  function updateLineItemsGrandTotal(key) {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return;
    var arr = state.values[key] || [];
    var total = arr.reduce(function (sum, it) {
      var t = parseFloat(it.total);
      if (isNaN(t)) t = (parseFloat(it.qty) || 0) * (parseFloat(it.rate) || 0);
      return sum + t;
    }, 0);
    var wrap = modal.querySelector('[data-field-wrap="' + CSS.escape(key) + '"]');
    if (!wrap) return;
    var el = wrap.querySelector('.dpf-li-total-final');
    if (el) el.textContent = fmtCurrency(total);
  }

  /**
   * Re-render a single field in place (for structural changes like
   * adding/removing rows). Event listeners live on the modal root via
   * delegation, so no rebinding is needed after replacing children.
   */
  function redrawField(key) {
    var wrap = document.querySelector('[data-field-wrap="' + CSS.escape(key) + '"]');
    if (!wrap) return;
    var f = state.fieldIndex[key];
    if (!f) return;
    var fragment = document.createElement('div');
    fragment.innerHTML = renderField(f, state.values[key]);
    var newEl = fragment.firstChild;
    wrap.parentNode.replaceChild(newEl, wrap);
    updateLineItemsGrandTotal(key);
    updateFieldMissingState(key);
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 9: PERSISTENCE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Split current values into leadUpdates vs docOverrides and persist.
   * @param {string} customerId
   * @param {object} leadUpdates
   * @param {string} docType
   * @param {object} docOverrides
   */
  async function applyDocEdits(customerId, leadUpdates, docType, docOverrides) {
    if (!customerId) return;
    if (!window.db || !window.doc || !window.updateDoc || !window.serverTimestamp) {
      console.warn('[DocPreflight] Firestore helpers missing; skipping persistence.');
      return;
    }
    // Firestore rejects `undefined` field values outright. A single undefined
    // edit (e.g. an emptied/optional inspection-report input) previously failed
    // the ENTIRE save with "Unsupported field value: undefined". Strip undefined
    // recursively so the valid edits still persist. (QA 2026-06-07, finding M-4.)
    function _stripUndefined(v) {
      if (Array.isArray(v)) return v.map(_stripUndefined);
      if (v && typeof v === 'object' && v.constructor === Object) {
        var o = {};
        Object.keys(v).forEach(function (k) { if (v[k] !== undefined) o[k] = _stripUndefined(v[k]); });
        return o;
      }
      return v;
    }
    var updates = {};
    Object.keys(leadUpdates || {}).forEach(function (k) {
      if (leadUpdates[k] !== undefined) updates[k] = _stripUndefined(leadUpdates[k]);
    });
    if (docOverrides && Object.keys(docOverrides).length) {
      updates['docOverrides.' + docType] = _stripUndefined(docOverrides);
    }
    // A preflight that persists `phone` back to the lead must refresh the
    // normalized inbound-SMS match key with it — incomingSMS queries leads
    // by phoneDigits and a bare phone write leaves a stale key. Canonical
    // transform — keep identical to functions/phone-utils.js.
    if (Object.prototype.hasOwnProperty.call(updates, 'phone')) {
      updates.phoneDigits = String(updates.phone || '').replace(/\D/g, '').replace(/^1/, '').slice(-10);
    }
    if (!Object.keys(updates).length) return;
    updates.updatedAt = window.serverTimestamp();
    try {
      await window.updateDoc(window.doc(window.db, 'leads', customerId), updates);
    } catch (err) {
      console.error('[DocPreflight] Persist failed', err);
      toast('Failed to save edits: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      throw err;
    }
  }

  /**
   * Which estimate feeds document generation (audit 2026-08-02 + Jo
   * 2026-08-05): the lead's ★ Primary estimate (#1036/#1037) when it's set
   * and present, else [0] of _customerEstimates — which loadEstimates now
   * sorts createdAt DESC, so the fallback is deterministically the newest.
   * Declared once and used by ALL doc-preflight readers (revert, save-back,
   * hydrate) so a revert can never target a different doc than the save.
   */
  function pickPreflightEstimate() {
    var ests = window._customerEstimates || [];
    var primaryId = ((window._currentLead || window._leadDoc || {}).primaryEstimateId) || null;
    if (primaryId) {
      for (var i = 0; i < ests.length; i++) {
        if (String(ests[i].id) === String(primaryId)) return ests[i];
      }
    }
    return ests[0];
  }

  /**
   * Save the current line-items state back onto the underlying estimate document.
   */
  async function saveLineItemsToEstimate(fieldKey) {
    var est = pickPreflightEstimate();
    if (!est || !est.id) {
      toast('No estimate found to update.', 'error');
      return;
    }
    if (!window.db || !window.doc || !window.updateDoc) {
      toast('Firestore not available.', 'error');
      return;
    }
    var items = state.values[fieldKey] || [];
    var mapped = items.map(function (it) {
      var qty = parseFloat(it.qty) || 0;
      var rate = parseFloat(it.rate) || 0;
      var amount = parseFloat(it.total);
      if (isNaN(amount)) amount = qty * rate;
      return {
        description: it.description || '',
        quantity: qty,
        unit: it.unit || 'ea',
        unitPrice: rate,
        amount: amount
      };
    });
    var lineItemsTotal = mapped.reduce(function (s, i) { return s + (parseFloat(i.amount) || 0); }, 0);
    // V2-pkb (estimate-qa-2026-06-08): for PER-SQ estimates the grandTotal is
    // locked to the selected tier price — editing the internal line items here
    // must NOT overwrite it. Only line-item / legacy estimates derive grandTotal
    // from the line-item sum. (Detected via the saved priceMode/prices fields.)
    var perSqLocked = (est.priceMode === 'per-sq') || (est.prices != null);
    var estUpdate = {
      lineItems: mapped,
      lineItemsTotal: lineItemsTotal,
      updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date()
    };
    if (!perSqLocked) { estUpdate.grandTotal = lineItemsTotal; }
    try {
      await window.updateDoc(window.doc(window.db, 'estimates', est.id), estUpdate);
      // Mutate cached copy so subsequent fields see it
      est.lineItems = mapped;
      est.lineItemsTotal = lineItemsTotal;
      if (!perSqLocked) { est.grandTotal = lineItemsTotal; }
      toast('Line items saved to estimate.', 'success');
    } catch (err) {
      console.error('[DocPreflight] Save to estimate failed', err);
      toast('Failed to save to estimate: ' + (err && err.message ? err.message : 'unknown error'), 'error');
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 10: OPEN / CLOSE / SUBMIT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Open the pre-flight modal for a doc type.
   * @param {string} type      — doc type key
   * @param {string} customerId — current lead id
   */
  function open(type, customerId) {
    if (!DOC_SCHEMAS[type]) {
      console.warn('[DocPreflight] No schema for type:', type, '— falling back to direct generate.');
      if (window.NBDDocGen && typeof window.NBDDocGen.generate === 'function') {
        var fallbackData = typeof window.getCustomerDocData === 'function' ? window.getCustomerDocData() : {};
        window.NBDDocGen.generate(type, fallbackData);
      }
      return;
    }

    injectStyles();

    // Hydrate context
    var lead = window._leadDoc || {};
    var estimate = pickPreflightEstimate() || null;
    var photos = window._allPhotos || [];
    var overrides = (lead.docOverrides && lead.docOverrides[type]) || {};

    // Job-type workmanship warranty (2026-09-25): null for anything that is
    // not a Job Template estimate, so every other document is untouched.
    var _rowsApi = window.NBDCustomerEstimateRows;
    var jobWarranty = (_rowsApi && typeof _rowsApi.estimateWarranty === 'function')
      ? _rowsApi.estimateWarranty(estimate) : null;
    // A warranty certificate for a job that carries no workmanship warranty
    // would certify a promise nobody made. Say so instead of opening.
    if (type === 'warranty_certificate' && jobWarranty && jobWarranty.text === '') {
      toast('This estimate carries no workmanship warranty, so there is no warranty to certify.', 'error');
      return;
    }

    var ctx = { lead: lead, estimate: estimate, photos: photos, overrides: overrides, jobWarranty: jobWarranty, depositDropped: [] };
    var schema = DOC_SCHEMAS[type];
    var values = {};
    var fieldIndex = {};
    var lineItemsMode = {};
    state.jobWarranty = jobWarranty;
    var jobGoverns = jobWarrantyGoverns();

    var depositFields = [];
    schema.sections.forEach(function (sec) {
      sec.fields.forEach(function (field) {
        fieldIndex[field.key] = field;
        if (field.type === 'line-items') lineItemsMode[field.key] = 'locked';
        // Deposit fields resolve below, once the price they follow is known.
        if (isDepositField(field)) { depositFields.push(field); return; }
        values[field.key] = resolveFieldValue(field, ctx);
        // The job type decides this warranty: no tier, and a tier saved on an
        // earlier document for this lead (docOverrides) must not come back.
        if (jobGoverns && field.type === 'warranty-tier') values[field.key] = '';
      });
    });

    // Deposit rule (review fix, 2026-09-25). The deposit fields derive from
    // the price THIS form shows — a saved Contract Price included — not from
    // lead.jobValue, so the prefill and the price never start out apart.
    // submit() re-asks the rule at the final price; the contract and the
    // proposal print its plan even though the proposal has no deposit field.
    state.deposit = null;
    if (depositFields.length || type === 'contract' || type === 'proposal') {
      if (Object.prototype.hasOwnProperty.call(values, 'totalPrice')) ctx.depositTotal = values.totalPrice;
      var depDefaults = {};
      var depPlan = depositPlanFor(ctx, ('depositTotal' in ctx) ? { total: ctx.depositTotal } : {});
      depositFields.forEach(function (field) {
        values[field.key] = resolveFieldValue(field, ctx);
        depDefaults[field.key] = depositFieldDefault(field.source, depPlan);
      });
      state.deposit = { ctx: { lead: lead, estimate: estimate }, defaults: depDefaults, dropped: ctx.depositDropped };
    }

    state.open = true;
    state.type = type;
    state.customerId = customerId || window._customerId || null;
    state.schema = schema;
    state.values = values;
    state.fieldIndex = fieldIndex;
    // A reloaded Deposit Amount override restates the untouched terms
    // sentence before the form first shows it (2026-09-25).
    if (state.deposit) refreshDepositDefaults(null);
    state.lineItemsMode = lineItemsMode;
    state.showAll = false;
    // Per-open reset: an address warning acknowledged on the last document
    // must never carry into this one.
    state.softAck = false;
    state.softIssues = [];
    state.estimate = estimate;
    state.legalNotes = collectLegalNotes();

    // Seed signers from the template's defaultSigners (declared on the
    // NBDDocGen.DOCUMENT_TYPES entry). Each becomes a toggleable row;
    // the rep can uncheck, rename inline, or add ad-hoc signers.
    var docTypeEntry = (window.NBDDocGen && window.NBDDocGen.DOCUMENT_TYPES && window.NBDDocGen.DOCUMENT_TYPES[type]) || {};
    var defaults = Array.isArray(docTypeEntry.defaultSigners) ? docTypeEntry.defaultSigners : [];
    // De-brand the seeded labels. DOCUMENT_TYPES.defaultSigners carries NBD
    // defaults like "Authorized NBD Representative" and "NBD Inspector"; the
    // EMITTED pdf is already corrected, because renderSignatureBlock runs every
    // label through NBDDocGen._deBrandSignerLabel. This modal was the one place
    // that copied them raw, so a tenant saw the platform owner's name pre-filled
    // in his own signer box across 7 doc types. The chokepoint already exists —
    // it just was never called from here.
    var _deBrand = (window.NBDDocGen && typeof window.NBDDocGen._deBrandSignerLabel === 'function')
      ? window.NBDDocGen._deBrandSignerLabel.bind(window.NBDDocGen)
      : function (x) { return x; };
    state.signers = defaults.map(function (s) {
      return {
        role: s.role || 'signer',
        label: _deBrand(s.label || s.role || 'Signer'),
        required: s.required !== false,
        enabled: true,
        removable: false,
      };
    });

    renderModal();
  }

  function close() {
    var m = document.getElementById(MODAL_ID);
    if (m) m.remove();
    document.removeEventListener('keydown', escHandler);
    state.open = false;
    state.type = null;
    state.schema = null;
    state.values = {};
    state.fieldIndex = {};
    state.jobWarranty = null;
    state.deposit = null;
    state.legalNotes = [];
    state.estimate = null;
  }

  /**
   * Validate, persist, and fire the document generator.
   */
  async function submit() {
    // Validate required fields
    var missing = [];
    Object.keys(state.fieldIndex).forEach(function (k) {
      var f = state.fieldIndex[k];
      if (fieldRequired(f) && isEmpty(state.values[k])) missing.push(f.label);
    });
    if (missing.length) {
      toast('Missing required fields: ' + missing.join(', '), 'error');
      // Re-run render to highlight missing and expand their sections
      state.showAll = true;
      renderModal();
      return;
    }

    // Kentucky insurance contract / proposal (2026-09-27): re-read against
    // the address as typed now. No business address → blocked (KRS 367.624);
    // the deposit warning stays on screen but never blocks.
    state.legalNotes = collectLegalNotes();
    var legalBlock = state.legalNotes.filter(function (n) { return n.level === 'block'; })[0];
    if (legalBlock) {
      toast(legalBlock.message, 'error');
      renderModal();
      return;
    }

    // Address completeness. Present but undeliverable addresses used to
    // sail through because `required` only tests non-empty. First submit
    // surfaces the problem and re-renders; a second, deliberate click
    // proceeds. Acknowledgement is per-open(), so it cannot carry over.
    var soft = collectSoftIssues();
    if (soft.length && !state.softAck) {
      state.softIssues = soft;
      state.softAck = true;
      state.showAll = true;
      toast('Address looks incomplete — review, then click again to generate anyway', 'error');
      renderModal();
      return;
    }

    // Split updates by persist destination
    var leadUpdates = {};
    var docOverrides = {};
    var mergedData = {};
    Object.keys(state.fieldIndex).forEach(function (k) {
      var f = state.fieldIndex[k];
      var v = state.values[k];
      mergedData[k] = v;
      if (f.persist === PERSIST.LEAD) {
        leadUpdates[k] = v;
      } else if (f.persist === PERSIST.DOCUMENT) {
        docOverrides[k] = v;
      }
    });

    // Job-type warranty: the renderers print this sentence ('' = none) in
    // place of a tier's lifetime wording (document-generator.js
    // renderWarrantyFor, the warranty certificate, the server contract).
    if (jobWarrantyGoverns()) {
      mergedData.warrantyTier = '';
      mergedData.workmanshipWarranty = state.jobWarranty.text;
      mergedData.workmanshipWarrantyYears = state.jobWarranty.years;
      mergedData.warrantyKind = state.jobWarranty.kind;
    }

    // Deposit plan (2026-09-25; review fixes the same day) for the documents
    // that state payment terms: deposit-rule.js at the FINAL price, with a
    // Deposit Amount the rep actually edited as the rep override (never below
    // an insurance deductible). The server contract turns it into its
    // Payment Schedule table; the proposal prints its sentence.
    if (state.deposit) {
      // Catch the price up first: a field still at its default follows it,
      // even when the price changed without an input event.
      refreshDepositDefaults(null);
      var _dpKeys = Object.keys(state.deposit.defaults);
      var _dpTouched = {};
      _dpKeys.forEach(function (k) {
        _dpTouched[k] = depositTouched(k);
        mergedData[k] = state.values[k];
      });
      var _dpRule = depositPlanFor(state.deposit.ctx, { total: mergedData.totalPrice });
      var _dpPlan = currentDepositPlan();
      _dpKeys.forEach(function (k) {
        // Untouched: not a per-doc override. It is re-derived next time, so
        // it can never come back after the price, job type or claim moves.
        if (!_dpTouched[k]) delete docOverrides[k];
      });
      // Edited: saved with the basis it was set against, and reloaded only
      // while that basis still holds (resolveDepositField).
      if (_dpKeys.some(function (k) { return _dpTouched[k]; }) && depositBasisOf(_dpRule)) {
        docOverrides.depositBasis = depositBasisOf(_dpRule);
      }

      if ((state.type === 'contract' || state.type === 'proposal')
          && _dpPlan && _dpPlan.totalCents > 0 && window.NBDDepositRule) {
        mergedData.depositPlan = window.NBDDepositRule.toStored(_dpPlan);
        // The figure the plan settled on (an override below a deductible is
        // raised to it), so nothing downstream reads a different number.
        if (state.fieldIndex.depositAmount) mergedData.depositAmount = (_dpPlan.depositCents / 100).toFixed(2);
        // An untouched terms paragraph states the FINAL plan (an edited
        // Deposit Amount included), never an earlier default.
        if (state.fieldIndex.paymentSchedule && !_dpTouched.paymentSchedule) mergedData.paymentSchedule = _dpPlan.summary;
      }

      if (state.type === 'payment_agreement' && _dpRule && _dpRule.totalCents > 0) {
        applyPaymentAgreementPlan(mergedData, _dpRule, _dpTouched);
      }
    }

    // Derive extra fields the templates expect
    hydrateDerivedFields(mergedData);

    // Which law the document is written under (ky-insurance-law.js). The
    // generator re-derives it too and only ever ADDS a Kentucky signal.
    var _jur = legalJurisdiction();
    if (_jur) mergedData.jurisdiction = _jur;

    // Attach signers chosen in the modal. The document generator
    // checks for data.signers and emits interactive canvas blocks
    // when present (bypassing the server-render path so the canvases
    // make it into the rendered HTML).
    if (Array.isArray(state.signers) && state.signers.length) {
      var activeSigners = state.signers
        .filter(function (s) { return s.enabled !== false; })
        .map(function (s) {
          return {
            role: s.role,
            label: (s.label || '').trim() || s.role,
            required: !!s.required,
          };
        });
      if (activeSigners.length) mergedData.signers = activeSigners;
    }

    // Persist
    var submitBtn = document.querySelector('[data-dpf-submit]');
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Saving...'; }

    try {
      if (state.customerId) {
        await applyDocEdits(state.customerId, leadUpdates, state.type, docOverrides);
      }
    } catch (err) {
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Generate Document →'; }
      return;
    }

    // Fire generator
    if (window.NBDDocGen && typeof window.NBDDocGen.generate === 'function') {
      try {
        window.NBDDocGen.generate(state.type, mergedData);
      } catch (err) {
        console.error('[DocPreflight] Generator threw', err);
        toast('Generator failed: ' + (err && err.message ? err.message : 'unknown error'), 'error');
      }
    } else {
      toast('Document generator not loaded.', 'error');
    }

    // Log the generated doc in the history list if helper exists
    // (customer-tasks-ui.js — customer.html only, registry-only since Globals
    // Tranche 3 T3-C, 2026-09-18; absent on dashboard.html → no-op, as before).
    var _logDocReg = window.__NBD_CALL_REGISTRY;
    if (_logDocReg && typeof _logDocReg.logGeneratedDoc === 'function') {
      try { _logDocReg.logGeneratedDoc(state.type, mergedData); } catch (e) { /* ignore */ }
    }

    close();
  }

  /**
   * Payment Agreement rows from the deposit rule (review fix, 2026-09-25).
   * Payment 1 is named for what it is (the deductible on a claim, else the
   * deposit); an untouched Payment 2 on a claim is the ACV check, due when
   * the carrier releases it; and the balance becomes the final payment, so
   * the schedule foots to the total. The schema never collected a final
   * payment, so every agreement printed a "does not match" warning under a
   * schedule that stopped at the deposit. Additive only: a value the data
   * already carries is kept.
   */
  function applyPaymentAgreementPlan(data, plan, touched) {
    var ins = plan.mode === 'insurance';
    if (data.depositLabel == null) data.depositLabel = ins ? 'Your deductible' : 'Deposit';
    if (ins && !(touched && touched.payment2Amount) && !isEmpty(data.payment2Amount)) {
      if (data.progressLabel == null) data.progressLabel = 'Insurance ACV payment (your carrier’s first check)';
      if (data.progressDue == null && !data.payment2Date) data.progressDue = 'When your carrier releases it';
    }
    var total = _depCents(data.totalPrice);
    var rest = (total == null) ? 0 : total - (_depCents(data.payment1Amount) || 0) - (_depCents(data.payment2Amount) || 0);
    if (data.finalAmount == null && rest > 0) {
      data.finalAmount = (rest / 100).toFixed(2);
      if (data.finalLabel == null) data.finalLabel = 'Balance';
      if (data.finalDue == null) {
        // ACV not known yet and no Payment 2: the balance still carries the
        // ACV check, so it says so (the rule's own wording).
        var bal = (plan.rows || []).filter(function (r) { return r && r.key === 'balance'; })[0];
        data.finalDue = (ins && !plan.acvKnown && isEmpty(data.payment2Amount) && bal && bal.due && bal.due !== 'On completion')
          ? bal.due : 'Upon project completion';
      }
    }
  }

  /**
   * Add template-convenience fields that the NBDDocGen templates expect
   * but that we don't expose directly in the schema.
   */
  function hydrateDerivedFields(data) {
    // Names
    if (!data.homeownerName) {
      data.homeownerName = ((data.firstName || '') + ' ' + (data.lastName || '')).trim();
    }
    data.customerName = data.homeownerName;
    data.claimantName = data.homeownerName;

    // Address aliases
    data.homeownerAddress = data.address || data.homeownerAddress || '';
    data.propertyAddress = data.address || '';

    // Extra properties worked under one job (Anthony Scandariato: 1944 AND
    // 1942 Kentucky Ave on invoice NBD-2026-0810-RK). Sourced from the lead
    // — the rep maintains them on the customer record, documents just
    // reflect them — so there is no per-document copy to drift. Always an
    // array; renderers omit the SERVICE LOCATIONS block when it is empty.
    if (!Array.isArray(data.serviceAddresses)) {
      var _lead = window._leadDoc || {};
      data.serviceAddresses = Array.isArray(_lead.serviceAddresses) ? _lead.serviceAddresses : [];
    }
    data.serviceAddresses = data.serviceAddresses
      .map(function (a) { return String(a == null ? '' : a).trim(); })
      .filter(Boolean);

    // Date fallback
    if (!data.date) {
      data.date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    }

    // ─── DocPreflight → renderer key bridges (contract audit 2026-06-25) ───
    // The preflight modal and several renderers grew divergent key vocabularies;
    // the only prior bridge was the name/address/totalPrice aliases below. Bridge
    // the rest here so rep-entered values actually reach the rendered document.
    // ADDITIVE ONLY — never clobber a value the doc already supplies, so a key
    // shared across doc types can't cross-contaminate (each fires only when its
    // source key is present, which is doc-type-specific). NUMERIC targets are
    // aliased HERE, before totalPrice is formatted to a "$..." string below,
    // because their renderers parseFloat() the raw value.
    if (data.totalAmount == null && data.totalPrice) data.totalAmount = data.totalPrice;            // payment_agreement reads d.totalAmount
    if (data.depositAmount == null && data.payment1Amount) data.depositAmount = data.payment1Amount; // payment_agreement
    if (data.progressAmount == null && data.payment2Amount) data.progressAmount = data.payment2Amount; // payment_agreement
    if (data.depositDue == null && data.payment1Date) data.depositDue = data.payment1Date;          // payment_agreement
    if (data.progressDue == null && data.payment2Date) data.progressDue = data.payment2Date;        // payment_agreement
    if (data.totalPrice == null && data.jobTotal) data.totalPrice = data.jobTotal;                  // financing_options reads d.totalPrice
    // Pure key renames (string/date display — no formatting dependency):
    if (data.projectDescription == null && data.projectScope) data.projectDescription = data.projectScope;             // scope_of_work
    if (data.workDescription == null && data.projectDescription) data.workDescription = data.projectDescription;        // before_after_report
    if (data.estimatedTimeline == null && data.timeline) data.estimatedTimeline = data.timeline;                       // scope_of_work
    if (data.changesDescription == null && data.changeDescription) data.changesDescription = data.changeDescription;    // change_order
    if (data.insuranceCompany == null && data.insCarrier) data.insuranceCompany = data.insCarrier;                     // supplement_request
    if (data.issueDate == null && data.installDate) data.issueDate = data.installDate;                                 // warranty_certificate
    // Job-type warranty (2026-09-25) wins over the tier bridges below: its
    // sentence, or null for none so contract.hbs drops the section instead of
    // printing a promise. warrantyTier is '' here, so neither bridge fires.
    if (data.warranty == null && typeof data.workmanshipWarranty === 'string') data.warranty = data.workmanshipWarranty || null;
    if (data.warranty == null && data.warrantyTier) {                                                                // contract (renderer's "5 · Warranty"
      // section is dropped entirely when warranty is null/empty). Mirrors
      // renderWarrantyBadge's composition. Five tiers since 2026-10-02.
      var _wTxt = tierWarrantySentence(data.warrantyTier);
      var _wMfg = window.NBDDocGen && window.NBDDocGen.MANUFACTURER_COVERAGE && window.NBDDocGen.MANUFACTURER_COVERAGE[data.warrantyTier]; // (2026-09-09 GBB
      data.warranty = _wMfg ? (_wTxt + ' ' + _wMfg.level + ' manufacturer coverage — ' + _wMfg.note) : _wTxt;          // tier consolidation, #1529)
    }
    if (data.scopeSummary == null && data.scopeCompleted) data.scopeSummary = data.scopeCompleted;                     // certificate_of_completion

    // Template library (2026-10-04). What the shingle on the estimate IS —
    // code + name only, never a price — for the manufacturer resolver
    // (warranty certificate, material selection). The pre-flight never passed
    // it, so every certificate generated through this modal fell back to the
    // resolver's GAF default and named GAF's warranty on TAMKO roofs.
    // Scoped to the documents that read each field, so every other
    // document's merge data stays exactly what it was.
    var _est = state.estimate || null;
    if ((state.type === 'warranty_certificate' || state.type === 'material_selection') && data.estimateLineItems == null) {
      data.estimateLineItems = manufacturerItems(_est);
    }
    // Good-Better-Best options: every tier price the estimate saved (dollars,
    // estimate-v2-ui.js `prices`) and the tier it was quoted at.
    if (state.type === 'proposal_options') {
      if (data.tierPrices == null && _est && _est.prices && typeof _est.prices === 'object') data.tierPrices = _est.prices;
      if (data.selectedTier == null && _est) data.selectedTier = _est.selectedTier || _est.tier || '';
      if (data.deductible == null) {
        var _ld = window._leadDoc || {};
        data.deductible = _ld.deductibleOrOwedByHO || _ld.deductible || '';
      }
    }
    if (!data.neighborhoodName && data.affectedArea) data.neighborhoodName = data.affectedArea;                       // neighborhood_mailer (required Affected Area → neighborhood label)

    // Contract warranty-bridge gap (GBB audit §9, 2026-09-09). The `contract`
    // schema above collects warrantyTier ('good'/'better'/'best') but never a
    // free-text `warranty` field — and functions/print/templates/contract.hbs
    // ({{#if warranty}}) silently drops its entire "5 · Warranty" section
    // when that field is null. The client-side fallback renderer
    // (document-generator.js renderContract) reads warrantyTier directly via
    // renderWarrantyBadge() and was never affected — this bridge is purely so
    // the SERVER-rendered contract PDF states a warranty too, once it
    // actually reaches this template (today it's masked by an unrelated
    // paymentSchedule.map crash in _buildServerPayload that falls back to the
    // client renderer first — see the audit's "fix both together" note).
    // Same lifetime+transferability model every other generator reads;
    // window.NBD_ESTIMATE_CONFIG isn't loaded on customer.html (only
    // dashboard.html), so this needs the same local fallback pattern used
    // elsewhere (_v2TierLabel() etc.) rather than assuming the config global.
    if (data.warranty == null && data.warrantyTier) {
      data.warranty = tierWarrantySentence(data.warrantyTier);
    }

    // Currency display version of totalPrice when supplied as number
    if (data.totalPrice !== undefined && data.totalPrice !== null && data.totalPrice !== '') {
      var tp = parseFloat(data.totalPrice);
      if (!isNaN(tp)) {
        data.totalPrice = '$' + tp.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
    }
    if (data.contractPrice === undefined && data.totalPrice) data.contractPrice = data.totalPrice;
    if (data.estimateAmount === undefined && data.totalPrice) data.estimateAmount = data.totalPrice;
    if (data.estimatedRepairCost !== undefined && data.estimatedRepairCost !== null && data.estimatedRepairCost !== '') {
      var rc = parseFloat(data.estimatedRepairCost);
      if (!isNaN(rc)) {
        data.estimatedRepairCost = '$' + rc.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
    }
    // inspectionInsurance renders {{totalPrice}}, but the modal collects the
    // figure as estimatedRepairCost — bridge it AFTER both are $-formatted so
    // the certificate shows the rep's repair cost instead of the $0.00 default.
    if (data.totalPrice == null && data.estimatedRepairCost) data.totalPrice = data.estimatedRepairCost;

    // Line items: templates expect qty/unitPrice/total on each row
    if (Array.isArray(data.lineItems)) {
      data.lineItems = data.lineItems.map(function (it) {
        var qty = parseFloat(it.qty || it.quantity || 1) || 1;
        var unitPrice = parseFloat(it.rate || it.unitPrice || 0) || 0;
        var total = parseFloat(it.total || it.amount);
        if (isNaN(total)) total = qty * unitPrice;
        return {
          description: it.description || '',
          qty: qty,
          unit: it.unit || 'ea',
          unitPrice: unitPrice,
          total: total
        };
      });
    }

    // Photos array: flatten to url list for templates that expect urls
    if (Array.isArray(data.photos)) {
      data.photoUrls = data.photos.map(function (p) { return typeof p === 'string' ? p : p.url; }).filter(Boolean);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SECTION 11: PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  window.DocPreflight = {
    open: open,
    close: close,
    submit: submit,
    DOC_SCHEMAS: DOC_SCHEMAS,
    // Internal helpers exposed for debugging / testing only:
    _state: state,
    _resolveFieldValue: resolveFieldValue,
    _applyDocEdits: applyDocEdits,
    _hydrateDerivedFields: hydrateDerivedFields
  };

})();
