// ============================================================
// NBD Pro — Estimate Finalization / Output Formatters
//
// Takes a resolved estimate from EstimateLogic.resolveEstimate()
// and renders it in one of three formats:
//
//   1. INSURANCE SCOPE — Full Xactimate-style line-item scope
//      with OH/KY code references, reasoning text, photo flags,
//      and material/labor split. For adjuster negotiation.
//
//   2. RETAIL QUOTE — Clean per-tier summary with single grand
//      total, scope bullets, and signature block. For cash /
//      finance customers.
//
//   3. INTERNAL — All of the above plus margin calc, cost basis,
//      order quantities. Joe's eyes only.
//
// All three are self-contained HTML with inline CSS, safe to
// print, PDF-export, or embed in email.
//
// Exposes window.EstimateFinalization.
// ============================================================

(function () {
  'use strict';
  if (typeof window === 'undefined') return;

  // ═════════════════════════════════════════════════════════
  // Shared helpers
  // ═════════════════════════════════════════════════════════

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Customer-facing tier name (GBB audit, 2026-09-09). Internal good/better/
  // best keys never change — this is display-only for the retail-quote tier
  // cards a customer actually reads. Single source: estimate-config.js.
  function _tierLabel(key) {
    const cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    if (cfg && typeof cfg.tierLabel === 'function') return cfg.tierLabel(key).toUpperCase();
    return ({ economy: 'ECONOMY', good: 'STANDARD', better: 'PREFERRED', best: 'ELITE', beyond: 'BEYOND' })[key] || String(key).toUpperCase();
  }

  // Every tier, cheapest first (five since 2026-10-02). Read from the config;
  // the inline copy only serves a page that didn't load estimate-config.js.
  function _tierOrder() {
    const cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    if (cfg && Array.isArray(cfg.TIER_ORDER)) return cfg.TIER_ORDER.slice();
    return ['economy', 'good', 'better', 'best', 'beyond'];
  }

  // Tier-card subtitle: material differentiator + warranty phrase: the
  // package's WRITTEN labor years (Jo, 2026-10-06 — estimate-config
  // TIER_LABOR_YEARS; never "lifetime"); Beyond adds TAMKO's hail warranty.
  // The warranty half comes from TIER_DISPLAY when loaded.
  const _TIER_MATERIAL = {
    economy: 'Economy Architectural',
    good:    'Standard Materials',
    better:  'Upgraded Materials',
    best:    'Impact-Rated',
    beyond:  'TAMKO HailGuard'
  };
  function _tierCardSub(key) {
    const cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    const disp = cfg && cfg.TIER_DISPLAY && cfg.TIER_DISPLAY[key];
    const w = disp ? disp.warranty : ({
      economy: { workmanshipYears: 1 },
      good:    { workmanshipYears: 5 },
      better:  { workmanshipYears: 10 },
      best:    { workmanshipYears: 20 },
      beyond:  { workmanshipYears: 20, hailWarranty: true }
    })[key] || {};
    const warranty = (w.workmanshipYears ? w.workmanshipYears + '-Year Labor Warranty' : 'Labor Warranty per Package')
      + (w.hailWarranty ? ' + Hail Warranty' : '');
    return (_TIER_MATERIAL[key] || 'Custom Scope') + ' · ' + warranty;
  }

  // Job-type workmanship warranty of the estimate being formatted
  // (2026-09-25). A Job Template estimate edited in the V2 builder carries its
  // saved warrantyKind here (estimate-v2-ui.js _jobTypeFieldsOf), and its
  // warranty is its JOB TYPE's, not roofing's lifetime tier ladder. Returns the
  // plain-text sentence ('' = no workmanship warranty), or null when the
  // existing roofing wording applies: any non-template estimate, per-SQ, a
  // roofing template, or a page that did not load customer-estimate-rows.js.
  function jobWarrantyText(estimate) {
    const rows = (typeof window !== 'undefined') ? window.NBDCustomerEstimateRows : null;
    if (!rows || typeof rows.estimateWarranty !== 'function') return null;
    const w = rows.estimateWarranty(estimate);
    return (w && typeof w.text === 'string') ? w.text : null;
  }

  function fmtMoney(n, showZero) {
    const v = Number(n) || 0;
    if (v === 0 && !showZero) return '—';
    // −$51.40, never $-51.40 — the Roof Care Plan member line (2026-10-05)
    // is a negative row on the customer's paper.
    return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Whole dollars print as they always did ("$7,464"); an amount with cents
  // prints its cents ("$7,213.62"). Review of #1763 (2026-09-25): this
  // rounded to the dollar, which lost nothing while V2 totals were always
  // $25-rounded — but an upgraded Job Template estimate adds its upgrades
  // and their exact tax on top, so the Retail Quote's PROJECT TOTAL / Balance
  // printed $7,214 for a saved $7,213.62 that the proposal, contract,
  // portal and invoice all print to the cent.
  function fmtMoneyBig(n) {
    const c = Math.round((Number(n) || 0) * 100);
    const digits = (c % 100 === 0) ? 0 : 2;
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  // ── Deposit plan for a quote (Kentucky hold, 2026-10-03) ────────────────
  // The lead this quote is for: meta.lead, else the linked lead
  // (meta.leadId / meta.customer.leadId) in the loaded pipeline. Its claim
  // number / carrier / jobType make a Kentucky job priced in cash or
  // per-square mode an insurance job for deposit-rule.js — the same test that
  // puts the KRS 367.624 notices on the contract — so the quote cannot ask
  // for a deposit at signing that KRS 367.626 forbids.
  function _quoteLead(meta) {
    if (meta && meta.lead && typeof meta.lead === 'object') return meta.lead;
    const c = (meta && meta.customer) || {};
    const id = (meta && meta.leadId) || c.leadId || null;
    if (!id || typeof window === 'undefined') return null;
    try {
      const cur = window._leadDoc;
      if (cur && cur.id === id) return cur;
      return (Array.isArray(window._leads) && window._leads.find((l) => l && l.id === id)) || null;
    } catch (_) { return null; }
  }
  function _isKyPlan(p) { return !!(p && (p.kyHold === true || p.rule === 'insurance-ky')); }
  // A stamped plan (the builder's) is printed as-is UNLESS the lead makes this
  // a Kentucky insurance job the stamp did not hold — e.g. stamped before the
  // claim was entered on the lead. Then the fresh, held plan wins.
  function _quoteDepositPlan(rule, estimate, meta, total, stamped) {
    const lead = _quoteLead(meta);
    const fresh = rule ? rule.fromEstimate(estimate, { claim: meta.claim || null, total: total, lead: lead }) : null;
    if (stamped && !(lead && _isKyPlan(fresh) && !_isKyPlan(stamped))) return stamped;
    return fresh;
  }

  // A quantity label must never round a fraction to a whole number. This
  // printed 0 decimals for every unit except SQ / LF / SF, so a 1.5-hour
  // line went out to the homeowner AND the adjuster reading "2 HR — $127.50"
  // — $85/hr x 2 HR is $170, so the document contradicted its own arithmetic
  // and invited a scope challenge on a line that was priced correctly.
  //
  // SQ, LF and SF keep the two-decimal house format. Every other unit prints
  // whole when the quantity is whole, and to as many places as it takes (up
  // to two) when it is not.
  function fmtQty(qty, unit) {
    const v = Math.round((Number(qty) || 0) * 100) / 100;
    const area = (unit === 'SQ' || unit === 'LF' || unit === 'SF');
    const decimals = area ? 2 : (Number.isInteger(v) ? 0 : (Math.round(v * 10) / 10 === v ? 1 : 2));
    return v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  }

  function fmtDate(d) {
    const date = d ? new Date(d) : new Date();
    return date.toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric'
    });
  }

  // Photo Documentation block — shared by the customer-facing formats.
  // Renders the photos the rep selected onto the estimate (meta.photos,
  // [{id,url}]). Print-safe: photos keep their colors on paper and never
  // split across a page break. Empty selection → empty string (section
  // disappears entirely).
  function photoBlock(photos, accent) {
    if (!Array.isArray(photos) || !photos.length) return '';
    const acc = accent || '#BD5728';
    const cells = photos.map(p =>
      `<div style="break-inside:avoid;page-break-inside:avoid;">
        <img src="${escapeHtml(p.url)}" alt="Job site photo"
          style="width:100%;border-radius:8px;border:1px solid #d8dbe0;display:block;-webkit-print-color-adjust:exact;print-color-adjust:exact;">
      </div>`).join('');
    return `
      <div style="margin:26px 0;break-inside:avoid-page;">
        <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:800;
          text-transform:uppercase;letter-spacing:.1em;color:${escapeHtml(acc)};
          border-bottom:2px solid ${escapeHtml(acc)};padding-bottom:6px;margin-bottom:14px;">
          Photo Documentation
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">
          ${cells}
        </div>
      </div>`;
  }

  function fmtCodeRefs(refs) {
    if (!refs || !Object.keys(refs).length) return '';
    const parts = [];
    if (refs.oh)   parts.push(`OH ${refs.oh}`);
    if (refs.ky)   parts.push(`KY ${refs.ky}`);
    if (refs.irc)  parts.push(`IRC ${refs.irc}`);
    if (refs.nrca) parts.push(`NRCA`);
    if (refs.ul)   parts.push(`UL ${refs.ul}`);
    if (refs.osha) parts.push(`OSHA ${refs.osha}`);
    return parts.join(' · ');
  }

  // Group line items by category for display
  function groupByCategory(lines) {
    const groups = {};
    lines.forEach(line => {
      const cat = line.category || 'other';
      groups[cat] = groups[cat] || [];
      groups[cat].push(line);
    });
    return groups;
  }

  // Category display order + labels
  const CAT_ORDER = [
    { key: 'labor',        label: 'Labor — Removal & Installation' },
    { key: 'roofing',      label: 'Roofing Materials' },
    { key: 'gutters',      label: 'Gutters & Drainage' },
    { key: 'exterior',     label: 'Exterior — Fascia & Soffit' },
    { key: 'code-upgrade', label: 'Code Upgrades' },
    { key: 'specialty',    label: 'Specialty Items' },
    { key: 'disposal',     label: 'Disposal' },
    { key: 'permits',      label: 'Permits & Inspection' },
    { key: 'protection',   label: 'Jobsite Protection' },
    { key: 'equipment',    label: 'Equipment & Staging' },
    { key: 'emergency',    label: 'Emergency Services' },
    { key: 'interior',     label: 'Interior Repair' },
    { key: 'warranty',     label: 'Warranty & Documentation' },
    { key: 'other',        label: 'Other' }
  ];
  const CAT_KEYS = new Set(CAT_ORDER.map(c => c.key));

  // Titleize a raw category key for display: 'code-upgrade' → 'Code Upgrade'.
  function titleizeCat(key) {
    return String(key || 'other').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Ordered category sections to render: every CAT_ORDER category that has
  // lines (in canonical order), THEN any line whose category isn't in
  // CAT_ORDER — a custom or future-catalog line — under a derived label. This
  // guarantees a scope table NEVER silently drops a line that still counts
  // toward the rolled-up total, so the visible line totals always reconcile to
  // RCV. For a normal estimate (all categories in CAT_ORDER) the leftover loop
  // adds nothing, so output is byte-identical.
  function categorySections(groups) {
    const sections = [];
    CAT_ORDER.forEach(catDef => {
      const lines = groups[catDef.key];
      if (lines && lines.length) sections.push({ key: catDef.key, label: catDef.label, lines: lines });
    });
    Object.keys(groups).forEach(key => {
      if (CAT_KEYS.has(key)) return;
      const lines = groups[key];
      if (lines && lines.length) sections.push({ key: key, label: titleizeCat(key), lines: lines });
    });
    return sections;
  }

  // ── Per-line RETAIL pricing for the Xactimate scope (B-8 / V2-6, Jo-approved
  //    2026-06-08). The line-item scope must show each line at its RETAIL price
  //    so the line totals sum to the pre-O&P retail and reconcile with the
  //    Financial Summary (Line Item Total → +O&P → +Tax → RCV). Material carries
  //    the shop markup (materialMarkupPct, default 25%); labor is shown as-is —
  //    its margin comes through O&P, matching the engine's rollup
  //    (retailBeforeOHP = materialCost×(1+markup) + laborCost). Falls back to
  //    qty × per-unit when the engine didn't pre-compute the *Total fields. ──
  function lineMatTotal(l) {
    return l.materialTotal != null ? Number(l.materialTotal) : (Number(l.quantity) || 0) * (Number(l.materialCostPerUnit) || 0);
  }
  function lineLabTotal(l) {
    return l.laborTotal != null ? Number(l.laborTotal) : (Number(l.quantity) || 0) * (Number(l.laborCostPerUnit) || 0);
  }
  function lineMatRetailPerUnit(l, markup) {
    return (Number(l.materialCostPerUnit) || 0) * (1 + markup);
  }
  function lineRetailTotal(l, markup) {
    const mat = lineMatTotal(l);
    const lab = lineLabTotal(l);
    // Pass-through / pre-priced line (e.g. the $75 aerial-measurement report, an
    // e-sign or permit upcharge): no material or labor cost basis, but a flat
    // lineTotal / unitPrice was set directly. Show it at FACE — markup and O&P
    // don't apply to a pass-through fee — and keep it in the Line Item Total so
    // the scope still sums to RCV. (getCurrentEstimate adds the same face amount
    // straight onto subtotal+total, so Line Item Total + O&P still == Subtotal.)
    if (mat === 0 && lab === 0) {
      if (l.lineTotal != null) return Number(l.lineTotal) || 0;
      if (l.unitPrice != null) return (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
    }
    return mat * (1 + markup) + lab;
  }

  // ═════════════════════════════════════════════════════════
  // Per-tenant brand resolution (TenantContext — see company-profile.js)
  //
  // resolveBrand() returns { isNbd, accent, name, displayName, tagline,
  // phone, email, website, address, docPrefix, seal } for the active
  // tenant. For NBD (or no tenant loaded) every field resolves to the
  // EXACT literal this file shipped with, so NBD output stays
  // byte-identical. A non-NBD tenant gets its own brand values.
  //
  // The accent (#BD5728 for NBD) is the single color this file themes;
  // it is threaded into buildBaseCss() so the inline <style> picks up the
  // tenant's accent. NBD → '#BD5728' (byte-identical CSS text).
  // ═════════════════════════════════════════════════════════
  const NBD_ACCENT = '#BD5728';

  // Tenant doc-number prefix, from the same source the customer IDs use, so a
  // tenant's estimate numbers match their customer IDs instead of falling back
  // to 'NBD'. Returns '' if unavailable — callers must not substitute 'NBD'.
  function _tenantPrefix() {
    try {
      if (typeof window !== 'undefined' && typeof window._custIdPrefix === 'function') {
        const p = window._custIdPrefix();
        return (p && p !== 'NBD') ? p : '';
      }
    } catch (_) { /* fall through */ }
    return '';
  }

  function resolveBrand() {
    let b = {};
    try {
      b = (typeof window !== 'undefined' && window._brand) ? (window._brand() || {}) : {};
    } catch (_) { b = {}; }
    const isNbd = !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    const colors  = b.colors  || {};
    const contact = b.contact || {};
    return {
      isNbd,
      // Accent: NBD keeps its exact lowercase literal; tenant uses its accent.
      accent:      isNbd ? NBD_ACCENT : (colors.accent || NBD_ACCENT),
      // Legal / display names (callers gate the NBD-specific header literal).
      name:        isNbd ? 'No Big Deal Home Solutions' : (b.legalName),
      displayName: isNbd ? 'No Big Deal' : (b.displayName || b.legalName || 'No Big Deal'),
      tagline:     b.tagline || '',
      // Contact — only used when a caller falls back to brand contact.
      phone:       contact.phone   || '',
      email:       contact.email   || '',
      website:     contact.website || '',
      address:     contact.address || '',
      // Doc-number prefix + signature seal.
      //
      // The `|| 'NBD'` on the non-NBD arms defeated the isNbd gate immediately
      // above it: _resolveBrand() blanks an unset docPrefix/seal to '', so a
      // tenant who never reserved a prefix got 'NBD' back anyway. That is how a
      // Summit Ridge estimate ended up promising a "10-year NBD labor warranty"
      // under a header carrying Summit Ridge's own name — the document
      // contradicted itself.
      //
      // Fall back within the TENANT's own identity instead (same ladder
      // estimate-supplement.js:441 already uses), never to the platform owner's.
      // _custIdPrefix() already returns 'NBD' only for the platform tenant and
      // a derived/reserved prefix for everyone else — reuse it rather than
      // re-deriving, so document numbers match the customer IDs.
      // UNCHANGED, deliberately (2026-09-06). This is a pure function of the
      // brand it is handed, and estimate-render.test.js pins it: NBD→'NBD-',
      // Oaks→'OAK-'. A first attempt gated it on _companyProfileLoaded and
      // broke five of those assertions — the same mistake as the
      // document-generator work: the derivation is faithful, the *brand* was
      // stale. The fix lives at the async boundary instead, where
      // estimate-v2-ui.js awaits company-profile hydration before calling any
      // formatter (finalize / sendForSignature).
      docPrefix:   isNbd ? 'NBD' : (b.docPrefix || _tenantPrefix() || ''),
      seal:        isNbd ? 'NBD' : (b.seal || b.displayName || b.legalName || ''),
      // Pass the raw brand through for any caller that needs more.
      _raw: b
    };
  }

  // Render the brand header block for a CUSTOMER-FACING document.
  //
  // "PRO" is the name of the SaaS PRODUCT, not of the contracting company that
  // is quoting the work. It used to be appended here in BOTH branches — the
  // comment above this function claimed tenants dropped it, but the code never
  // did — so every tenant's estimates and insurance scopes went out reading
  // "<Their Company> PRO", putting the platform's name on their customer
  // paper. Homeowners and adjusters know the contractor, not the software.
  //
  // Now: the company's own name, and its logo when it has one. The logo is
  // optional by design — _brandLogoSrc() returns '' rather than a placeholder,
  // and a document with no logo is fine while a document wearing someone
  // else's logo is not.
  function brandHeaderHtml(brand) {
    const name = brand.isNbd
      ? 'No Big Deal Home Solutions'
      : escapeHtml(brand.displayName || brand.legalName || '');
    let logo = '';
    try {
      const src = (typeof window !== 'undefined' && window._brandLogoSrc)
        ? window._brandLogoSrc() : '';
      if (src) {
        logo = '<img class="brand-logo-img" src="' + escapeHtml(src) + '" alt="' +
               name + '"/>';
      }
    } catch (_) { /* a missing logo must never break the document */ }
    return logo + '<span class="brand-name">' + name + '</span>';
  }

  // Shared CSS for all outputs. `acc` is the brand accent color; for NBD
  // it is '#BD5728', so buildBaseCss('#BD5728') returns the EXACT string
  // this file shipped with (byte-identical). A tenant passes its accent.
  // (2026-09-25: plus the phone-preview @media block below, identical for
  // every tenant — it carries no accent.)
  function buildBaseCss(acc) {
    acc = acc || NBD_ACCENT;
    return `
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family: 'Lato','Segoe UI',Helvetica,Arial,sans-serif;
           color:#111; background:#fff; padding:36px;
           max-width:880px; margin:0 auto; line-height:1.4; }
    .hdr { display:flex; justify-content:space-between; align-items:flex-start;
           padding-bottom:22px; border-bottom:3px solid ${acc}; margin-bottom:28px; }
    .brand { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
             font-size:24px; font-weight:800; text-transform:uppercase;
             letter-spacing:.03em; display:flex; align-items:center; gap:12px; }
    .brand-logo-img { display:block; width:150px; height:auto; flex-shrink:0; }
    .brand-name { line-height:1.15; }
    .brand .pro { color:${acc}; }
    .sub { font-size:13px; color:#666; margin-top:2px; }
    .badge { display:inline-block; font-size:9px; font-weight:700;
             letter-spacing:.18em; text-transform:uppercase; color:${acc};
             border:1px solid ${acc}; padding:3px 10px; border-radius:2px;
             margin-top:6px; }
    .doc-hdr { text-align:right; }
    .doc-title { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-size:28px;
                 font-weight:800; text-transform:uppercase; letter-spacing:.06em; }
    .doc-date { font-size:12px; color:#666; }
    .doc-total-lbl { font-size:9px; font-weight:700; letter-spacing:.15em;
                     text-transform:uppercase; color:${acc}; margin-top:12px; }
    .doc-total-val { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-size:38px;
                     font-weight:800; color:${acc}; line-height:1; }
    h2 { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-size:13px;
         font-weight:700; text-transform:uppercase; letter-spacing:.18em;
         margin:26px 0 12px; padding-bottom:4px; border-bottom:2px solid ${acc}; }
    h3 { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-size:11px;
         font-weight:700; text-transform:uppercase; letter-spacing:.12em;
         color:#555; margin:18px 0 8px; }
    .field-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px;
                  margin-bottom:16px; }
    .field { font-size:12px; }
    .field label { display:block; font-size:9px; font-weight:700;
                   letter-spacing:.12em; text-transform:uppercase; color:#999; }
    .field .v { font-size:14px; font-weight:600; color:#111; }
    table { width:100%; border-collapse:collapse; margin:4px 0 14px; }
    thead tr { border-bottom:2px solid #111; background:#faf7f3; }
    th { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-size:10px;
         font-weight:700; text-transform:uppercase; letter-spacing:.08em;
         padding:8px 10px; text-align:left; color:#111; }
    td { padding:8px 10px; border-bottom:1px solid #eee; font-size:12px;
         vertical-align:top; }
    td.num { text-align:right; font-variant-numeric:tabular-nums; }
    td.code { color:${acc}; font-weight:700; font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;
              font-size:12px; }
    .reason { font-size:10px; color:#666; font-style:italic; margin-top:4px;
              padding-left:4px; border-left:2px solid ${acc}; }
    .code-refs { font-size:9px; color:#a0601f; font-weight:600; margin-top:3px;
                 letter-spacing:.04em; text-transform:uppercase; }
    .photo-req { display:inline-block; font-size:8px; font-weight:700;
                 color:#c53030; background:#fff5f5; padding:2px 6px;
                 border-radius:2px; letter-spacing:.08em; margin-left:6px; }
    .code-req { display:inline-block; font-size:8px; font-weight:700;
                color:#065f46; background:#ecfdf5; padding:2px 6px;
                border-radius:2px; letter-spacing:.08em; margin-left:6px; }
    .cat-hdr { background:#f8f4ef; padding:10px; border-left:4px solid ${acc};
               font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-weight:700;
               font-size:13px; text-transform:uppercase; letter-spacing:.1em;
               margin-top:20px; margin-bottom:0; }
    .cat-subtotal { background:#faf7f3; font-weight:700; }
    .grand-row td { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-size:16px;
                    font-weight:700; color:${acc}; border-top:3px solid #111;
                    background:#fff8f5; padding:12px 10px; }
    .footer { margin-top:40px; padding-top:16px; border-top:2px solid ${acc};
              font-size:10px; color:#555; }
    .terms { font-size:10px; color:#666; margin-top:16px; line-height:1.5; }
    .sig-block { display:grid; grid-template-columns:1fr 1fr; gap:30px;
                 margin-top:40px; page-break-inside:avoid; }
    .sig-line { border-top:1px solid #111; padding-top:6px; font-size:10px;
                color:#555; }
    /* Phone preview (phone audit 2026-09-25, estimate#7). These documents open
       in the in-app viewer's iframe, which on a phone is the phone's width —
       and nothing here was written for that: 36px body padding, fixed header
       widths (Code 100px, Line Total 90px, ...) and 6-7 columns. At 412px the
       Insurance Scope was 476px wide and the Internal view 522px, so LINE
       TOTAL / TOTAL and every category subtotal sat past the right edge, and
       panning to them hid the CODE column. Scoped three ways so the documents
       themselves are unchanged everywhere else: screen only (print and the
       server PDF render as before), <=600px only (desktop viewer as before),
       and html.nbd-est-doc only — the viewer's Download PDF copies just the
       BODY into the dashboard page for html2pdf, where this root class is
       absent, so a PDF saved from a phone keeps the letter-size layout too. */
    @media screen and (max-width:600px) {
      html.nbd-est-doc body { padding:16px 10px; }
      /* The brand block and the title/total block sit side by side; with the
         display faces missing (fallback font) that row alone ran 15-19px past
         a 360px screen. Let it wrap and scale the headline type down. */
      html.nbd-est-doc .hdr { flex-wrap:wrap; gap:10px 16px; }
      html.nbd-est-doc .brand { font-size:18px; }
      html.nbd-est-doc .brand-logo-img { width:110px; }
      html.nbd-est-doc .doc-title { font-size:20px; }
      html.nbd-est-doc .doc-total-val { font-size:28px; }
      html.nbd-est-doc th, html.nbd-est-doc td { padding:6px 3px; }
      html.nbd-est-doc th { font-size:8px; letter-spacing:.02em; width:auto !important; }
      html.nbd-est-doc td { font-size:11px; }
      /* Money cells never wrap, so the text cells must be able to: a five-
         figure line total on a 97-SQ job would otherwise push the 7-column
         Internal table past a 360px screen by a few px. Breaks mid-word only
         when the numbers leave no other way to fit. */
      html.nbd-est-doc td:not(.num) { overflow-wrap:anywhere; }
      html.nbd-est-doc td.code { font-size:10px; }
      html.nbd-est-doc .grand-row td { font-size:13px; padding:10px 4px; }
    }
    @page { margin:1.5cm; size:letter; }
    @media print { body { padding:20px; } }
  `;
  }

  // Back-compat: the public API still exposes BASE_CSS as the NBD string
  // (byte-identical to the original module const).
  const BASE_CSS = buildBaseCss(NBD_ACCENT);

  // ═════════════════════════════════════════════════════════
  // 1. INSURANCE SCOPE FORMATTER
  // ═════════════════════════════════════════════════════════

  function formatInsuranceScope(estimate, meta) {
    meta = meta || {};
    const customer = meta.customer || {};
    const claim    = meta.claim || {};
    const est      = meta.estimate || {};
    const _b   = resolveBrand();
    const _acc = _b.accent;
    const company  = meta.company || (_b.isNbd ? {
      name: 'No Big Deal Home Solutions',
      tagline: 'Roofing · Siding · Storm Restoration',
      phone: '(859) 420-7382',
      email: 'JD@nobigdealwithjoedeal.com',
      address: '', // no public street address
      license: 'OH / KY licensed'
    } : {
      name: _b.name,
      tagline: _b.tagline || 'Roofing · Siding · Storm Restoration',
      phone: _b.phone,
      email: _b.email,
      address: _b.address,
      license: 'Licensed & insured'
    });

    const groups = groupByCategory(estimate.lines || []);

    // Header block
    const header = `
      <div class="hdr">
        <div>
          <div class="brand">${brandHeaderHtml(_b)}</div>
          <div class="sub">${escapeHtml(company.tagline)}</div>
          <div class="badge">Insurance Restoration Scope</div>
        </div>
        <div class="doc-hdr">
          <div class="doc-title">Insurance Scope</div>
          <div class="doc-date">${fmtDate(est.date)}</div>
          <div class="doc-date">Estimate #${escapeHtml(est.number || (_b.docPrefix ? _b.docPrefix + '-' : '') + Date.now())}</div>
          ${est.revision ? `<div class="doc-date">Revision ${escapeHtml(est.revision)}</div>` : ''}
          <div class="doc-total-lbl">Scope Total (RCV)</div>
          <div class="doc-total-val">${fmtMoneyBig(estimate.total)}</div>
        </div>
      </div>
    `;

    // Claim & property info
    const claimBlock = `
      <h2>Claim Information</h2>
      <div class="field-grid">
        <div class="field"><label>Insured</label><div class="v">${escapeHtml(customer.name || '—')}</div></div>
        <div class="field"><label>Property Address</label><div class="v">${escapeHtml(customer.address || '—')}</div></div>
        <div class="field"><label>Carrier</label><div class="v">${escapeHtml(claim.carrier || '—')}</div></div>
        <div class="field"><label>Claim Number</label><div class="v">${escapeHtml(claim.number || '—')}</div></div>
        <div class="field"><label>Adjuster</label><div class="v">${escapeHtml(claim.adjuster || '—')}</div></div>
        <div class="field"><label>Date of Loss</label><div class="v">${escapeHtml(claim.dateOfLoss || '—')}</div></div>
        <div class="field"><label>Deductible</label><div class="v">${claim.deductible ? fmtMoneyBig(claim.deductible) : '—'}</div></div>
        <div class="field"><label>Scope Prepared By</label><div class="v">${escapeHtml(est.preparedBy || (_b.isNbd ? 'Joe Deal — NBD' : _b.seal))}</div></div>
      </div>
    `;

    // Build scope tables grouped by category. Lines are priced at RETAIL
    // (B-8): material × (1+markup), labor as-is, so category subtotals sum to
    // the pre-O&P retail (scopeGrand) shown as "Line Item Total" below — which
    // reconciles with the Financial Summary's O&P → RCV ladder.
    const markup = Number(estimate.materialMarkupPct != null ? estimate.materialMarkupPct : 0.25);
    let scopeTables = '';
    let scopeGrand = 0;
    categorySections(groups).forEach(catDef => {
      const lines = catDef.lines;

      let catSubtotal = 0;
      const rows = lines.map(line => {
        catSubtotal += lineRetailTotal(line, markup);
        const reason = line.reason
          ? `<div class="reason">${escapeHtml(line.reason)}</div>`
          : '';
        // Per-line rep note (V2 builder overrides.note → line.repNote).
        // Distinct styling from the catalog reason so the adjuster can
        // tell the field observation from the boilerplate justification.
        const repNote = line.repNote
          ? `<div style="font-size:10px;color:#92400e;background:#fffbeb;border-left:2px solid #f59e0b;padding:3px 6px;margin-top:3px;">📝 ${escapeHtml(line.repNote)}</div>`
          : '';
        const codeRefs = fmtCodeRefs(line.codeRefs);
        const codeRefsHtml = codeRefs
          ? `<div class="code-refs">${escapeHtml(codeRefs)}</div>`
          : '';
        const photoFlag = line.requiresPhoto
          ? `<span class="photo-req">PHOTO REQ</span>`
          : '';
        const codeFlag = (line.codeRefs && line.codeRefs.oh && /required/i.test(line.reason || ''))
          ? `<span class="code-req">CODE</span>`
          : '';

        return `
          <tr>
            <td class="code">${escapeHtml(line.code || '')}</td>
            <td>
              <strong>${escapeHtml(line.name || '')}</strong>${codeFlag}${photoFlag}
              ${reason}
              ${repNote}
              ${codeRefsHtml}
            </td>
            <td class="num">${fmtQty(line.quantity, line.unit)} ${escapeHtml(line.unit || '')}</td>
            <td class="num">${fmtMoney(lineMatRetailPerUnit(line, markup))}</td>
            <td class="num">${fmtMoney(line.laborCostPerUnit)}</td>
            <td class="num"><strong>${fmtMoney(lineRetailTotal(line, markup))}</strong></td>
          </tr>
        `;
      }).join('');

      scopeGrand += catSubtotal;
      scopeTables += `
        <div class="cat-hdr">${escapeHtml(catDef.label)}</div>
        <table>
          <thead>
            <tr>
              <th style="width:100px;">Code</th>
              <th>Description</th>
              <th class="num" style="width:70px;">Qty</th>
              <th class="num" style="width:75px;">Material</th>
              <th class="num" style="width:75px;">Labor</th>
              <th class="num" style="width:90px;">Line Total</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
            <tr class="cat-subtotal">
              <td></td>
              <td><strong>${escapeHtml(catDef.label)} Subtotal</strong></td>
              <td colspan="3"></td>
              <td class="num"><strong>${fmtMoney(catSubtotal)}</strong></td>
            </tr>
          </tbody>
        </table>
      `;
    });

    // Grand "Line Item Total" — the sum of every category subtotal (retail,
    // pre-O&P). This is the anchor the Financial Summary's O&P ladder builds on,
    // so the visible scope always adds up to the RCV.
    scopeTables += `
      <table>
        <tbody>
          <tr class="cat-subtotal grand-row">
            <td></td>
            <td><strong>Line Item Total (before O&amp;P)</strong></td>
            <td colspan="3"></td>
            <td class="num"><strong>${fmtMoney(scopeGrand)}</strong></td>
          </tr>
        </tbody>
      </table>
    `;

    // Financial summary
    const ohp = (estimate.overhead || 0) + (estimate.profit || 0);
    const acv = claim.acv || null;
    const rcv = estimate.total;
    const depreciation = claim.recoverableDepreciation || null;
    const deductible = claim.deductible || 0;

    // Line items are shown at RETAIL, so they sum to scopeGrand (= the engine's
    // retailBeforeOHP). The summary then layers O&P → Subtotal → Tax → RCV on
    // top, so a reader who adds the scope lines lands exactly on Line Item Total
    // and can follow the math to RCV. (B-8: replaces the old Material/Labor
    // aggregate rows, which showed retailed material yet didn't match the
    // cost-basis line totals.)
    const summaryRows = [
      ['Line Item Total (before O&P)', fmtMoney(scopeGrand)],
      ['Overhead (' + Math.round((estimate.overheadPct || 0.10) * 100) + '%)', fmtMoney(estimate.overhead)],
      ['Profit (' + Math.round((estimate.profitPct || 0.10) * 100) + '%)', fmtMoney(estimate.profit)],
      ['Subtotal', fmtMoney(estimate.subtotal)]
    ];
    if (estimate.taxRate && estimate.taxRate > 0) {
      summaryRows.push(['Sales Tax (' + (estimate.taxRate * 100).toFixed(2) + '%)', fmtMoney(estimate.tax)]);
    }
    // RCV is Subtotal + Tax rounded to the nearest $25 (either way), then
    // lifted to the shop minimum. Show that difference so Subtotal → RCV
    // reads as an honest ladder instead of an unexplained jump.
    // In cents from the printed (cent-rounded) figures, so the rows foot as shown.
    const adj = (Math.round((Number(rcv) || 0) * 100) - Math.round((Number(estimate.subtotal) || 0) * 100) - Math.round((Number(estimate.tax) || 0) * 100)) / 100;
    if (adj) {
      const label = (estimate.minJobApplied && adj > 0) ? 'Minimum Job Charge Adjustment' : 'Rounding';
      summaryRows.push([label, (adj < 0 ? '−' : '') + fmtMoney(Math.abs(adj))]);
    }
    summaryRows.push(['REPLACEMENT COST VALUE (RCV)', fmtMoneyBig(rcv), 'grand']);
    if (acv) {
      summaryRows.push(['Actual Cash Value (ACV)', fmtMoneyBig(acv)]);
      summaryRows.push(['Recoverable Depreciation', fmtMoneyBig(depreciation || (rcv - acv))]);
    }
    // A loss smaller than the deductible is not a negative claim, it is NO
    // claim. rcv - deductible printed raw put "NET CLAIM ($1,300.00)" on
    // paper going to a homeowner and an adjuster, which reads as though the
    // carrier is owed money. Floor it at zero and say plainly what happened —
    // the RCV above is still the price, the homeowner just pays all of it.
    if (deductible) {
      const netClaim = Math.max(0, rcv - deductible);
      summaryRows.push(['Less: Deductible', '(' + fmtMoneyBig(deductible) + ')']);
      summaryRows.push(['NET CLAIM', fmtMoneyBig(netClaim), 'grand']);
      if (rcv <= deductible) {
        summaryRows.push([
          'This loss falls below the ' + fmtMoney(deductible) + ' deductible, so there is no recoverable claim. ' +
          'The Replacement Cost Value above is the price of the work, payable by the homeowner.',
          '', 'note'
        ]);
      }
    }

    const summaryTable = `
      <h2>Financial Summary</h2>
      <table>
        <tbody>
          ${summaryRows.map(r => {
            if (r[2] === 'note') {
              return `<tr><td colspan="6" style="font-size:11px;line-height:1.45;color:#4C4C4D;font-style:italic;">${escapeHtml(r[0])}</td></tr>`;
            }
            const cls = r[2] === 'grand' ? 'grand-row' : '';
            return `<tr class="${cls}"><td colspan="5"><strong>${escapeHtml(r[0])}</strong></td><td class="num"><strong>${r[1]}</strong></td></tr>`;
          }).join('')}
        </tbody>
      </table>
    `;

    // Code-required items summary (if any)
    const codeRequired = (estimate.lines || []).filter(l => l.codeRefs && Object.keys(l.codeRefs).length);
    const codeSummary = codeRequired.length ? `
      <h2>Building Code Justification Summary</h2>
      <table>
        <thead><tr><th style="width:120px;">Code Ref</th><th>Item</th><th>Basis</th></tr></thead>
        <tbody>
          ${codeRequired.map(l => `
            <tr>
              <td class="code">${escapeHtml(fmtCodeRefs(l.codeRefs))}</td>
              <td>${escapeHtml(l.name || '')}</td>
              <td style="font-size:10px;color:#555;">${escapeHtml(l.reason || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    ` : '';

    // Photo documentation items
    const photoItems = (estimate.lines || []).filter(l => l.requiresPhoto);
    const photoSummary = photoItems.length ? `
      <h2>Photo Documentation Required</h2>
      <p style="font-size:11px;color:#555;margin-bottom:10px;">The following scope items require photographic documentation per code or adjuster review:</p>
      <ul style="font-size:11px;color:#555;margin-left:20px;">
        ${photoItems.map(l => `<li>${escapeHtml(l.name || '')} — ${escapeHtml(fmtCodeRefs(l.codeRefs) || 'documentation')}</li>`).join('')}
      </ul>
    ` : '';

    // Footer / signatures / terms
    const footer = `
      <h2>Signatures</h2>
      <div class="sig-block">
        <div>
          <div style="height:40px;"></div>
          <div class="sig-line">Contractor — ${escapeHtml(est.preparedBy || (_b.isNbd ? 'Joe Deal' : _b.seal))}<br>
               ${escapeHtml(company.name)}<br>
               Date: ${fmtDate(est.date)}</div>
        </div>
        <div>
          <div style="height:40px;"></div>
          <div class="sig-line">Insured / Property Owner<br>
               ${escapeHtml(customer.name || '')}<br>
               Date: ____________________</div>
        </div>
      </div>

      <div class="terms">
        <strong>Scope Terms:</strong> This scope of work is prepared based on damage
        observed on ${fmtDate(est.inspectionDate || est.date)} and is valid for 30 days.
        ${_b.isNbd
          ? `All line items reference industry-standard pricing (RSMeans / Xactimate equivalent)
        for the Cincinnati / Northern Kentucky market.
        Code-required items cite Ohio Residential Code (OBC), Kentucky Residential Code (KRC),
        and International Residential Code (IRC) where applicable.`
          : `All line items reference industry-standard pricing (RSMeans / Xactimate equivalent)
        for the local market.
        Code-required items cite applicable state and local residential codes and the
        International Residential Code (IRC) where applicable.`}
        Overhead and profit calculated at ${Math.round((estimate.overheadPct || 0.10) * 100)}% +
        ${Math.round((estimate.profitPct || 0.10) * 100)}% per industry standard.
      </div>

      <div class="footer">
        <div style="display:flex;justify-content:space-between;">
          <span>${escapeHtml(company.name)} · ${escapeHtml(company.phone)} · ${escapeHtml(company.email)}</span>
          <span>Generated by NBD Pro · ${fmtDate(est.date)}</span>
        </div>
      </div>
    `;

    const html = `<!DOCTYPE html>
<html class="nbd-est-doc"><head><meta charset="UTF-8">
<title>Insurance Scope — ${escapeHtml(customer.name || _b.seal)} — ${fmtDate(est.date)}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" rel="stylesheet">
<style>${buildBaseCss(_acc)}</style>
</head><body>
${header}
${claimBlock}
<h2>Scope of Work</h2>
${scopeTables}
${summaryTable}
${codeSummary}
${photoSummary}
${photoBlock(meta.photos, _acc)}
${footer}
</body></html>`;

    return {
      format: 'insurance-scope',
      html,
      lineCount: (estimate.lines || []).length,
      codeRefCount: codeRequired.length,
      photoReqCount: photoItems.length,
      total: estimate.total,
      rcv: estimate.total,
      acv: acv,
      deductible: deductible,
      netClaim: deductible ? Math.max(0, rcv - deductible) : rcv,
      belowDeductible: !!(deductible && rcv <= deductible)
    };
  }

  // ═════════════════════════════════════════════════════════
  // 2. RETAIL QUOTE FORMATTER
  // ═════════════════════════════════════════════════════════

  function formatRetailQuote(estimate, meta) {
    meta = meta || {};
    const customer = meta.customer || {};
    const est      = meta.estimate || {};
    const _b   = resolveBrand();
    const _acc = _b.accent;
    const company  = meta.company || (_b.isNbd ? {
      name: 'No Big Deal Home Solutions',
      tagline: 'Contractor-Built · Contractor-Priced',
      phone: '(859) 420-7382',
      email: 'JD@nobigdealwithjoedeal.com',
      address: '' // no public street address
    } : {
      name: _b.name,
      tagline: _b.tagline || 'Contractor-Built · Contractor-Priced',
      phone: _b.phone,
      email: _b.email,
      address: _b.address
    });
    const tiers = meta.tiers || null;  // Optional: { good, better, best } per-tier totals

    // Bullet-style scope summary (by category, no prices)
    const groups = groupByCategory(estimate.lines || []);
    const bullets = [];
    categorySections(groups).forEach(catDef => {
      const lines = catDef.lines;
      // Deduplicate by name
      const seen = new Set();
      lines.forEach(l => {
        if (!l.name || seen.has(l.name)) return;
        seen.add(l.name);
        bullets.push({ cat: catDef.label, name: l.name, note: l.repNote || '' });
      });
    });

    const bulletHtml = bullets.map(b =>
      `<li><span style="font-size:10px;color:#999;text-transform:uppercase;letter-spacing:.1em;">${escapeHtml(b.cat)}</span><br>
           <strong>${escapeHtml(b.name)}</strong>${b.note ? `<br><span style="font-size:10px;color:#92400e;font-style:italic;">📝 ${escapeHtml(b.note)}</span>` : ''}</li>`
    ).join('');

    // Tier card HTML (if tiers passed)
    let tierCards = '';
    if (tiers) {
      // GBB audit, 2026-09-09: "Impact + 20yr Warranty" was one of eight
      // independent warranty-duration schemes found live at once; the other
      // two subs didn't even state a duration. Each tier states its written
      // labor years (estimate-config.js TIER_DISPLAY) — the material
      // differentiator half matches TIER_RATES' own comments there.
      // Five tiers since 2026-10-02: every tier in TIER_ORDER that the data
      // carries gets a card; Economy says 1-year labor, Beyond says HailGuard.
      // The grid wraps (auto-fit) so five cards print 3 + 2 on a letter page
      // instead of squeezing five big prices into one row.
      const _tierColors = { economy: '#57534e', good: '#6b7280', better: '#3b82f6', best: _acc, beyond: '#7c3aed' };
      const tierDefs = _tierOrder().map(key => ({
        key,
        label: _tierLabel(key),
        sub: _tierCardSub(key),
        color: _tierColors[key] || '#6b7280'
      }));
      tierCards = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin:24px 0;">
          ${tierDefs.map(t => {
            const tierEst = tiers[t.key];
            if (!tierEst) return '';
            // Highlight by tier KEY when the builder marked the selected tier
            // (per-SQ estimates set tiers.recommended = the rep's chosen tier).
            // V2-2 fix: float-equality of a per-SQ tier total against the
            // line-item estimate.total could never match, so the badge never fired.
            const selected = tiers.recommended ? (t.key === tiers.recommended) : (tierEst.total === estimate.total);
            // Each card states its own deposit (deposit-rule.js, 2026-09-25):
            // the Payment Terms below are the SELECTED tier's, so without this
            // a homeowner comparing tiers read one tier's deposit under all.
            const _tr = (typeof window !== 'undefined') ? window.NBDDepositRule : null;
            const _stamped = meta.depositPlan || estimate.depositPlan || null;
            // The stamp is the plan the Payment Terms print, for the tier they are for.
            const _tierStamp = (_stamped && _stamped.totalCents === Math.round(Number(tierEst.total) * 100)) ? _stamped : null;
            const _tp = (_tierStamp || Number(tierEst.total) > 0)
              ? _quoteDepositPlan(_tr, estimate, meta, Number(tierEst.total), _tierStamp) : null;
            const tierDep = (_tp && _tp.totalCents > 0)
              ? `<div class="tier-deposit" style="font-size:11px;color:#555;margin-top:8px;">${escapeHtml(_tp.label)}: ${escapeHtml(_tp.valueText)}</div>` : '';
            return `
              <div style="border:${selected ? '3' : '1'}px solid ${t.color};
                          border-radius:8px; padding:20px; text-align:center;
                          background:${selected ? '#fff8f5' : '#fff'};
                          ${selected ? 'box-shadow:0 4px 12px color-mix(in srgb, var(--orange) 15%, transparent);' : ''}">
                <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;
                            font-weight:700;letter-spacing:.2em;color:${t.color};">
                  ${escapeHtml(t.label)}
                </div>
                <div style="font-size:11px;color:#666;margin-top:2px;">${escapeHtml(t.sub)}</div>
                <div style="font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:36px;
                            font-weight:800;color:${t.color};margin-top:12px;line-height:1;">
                  ${fmtMoneyBig(tierEst.total)}
                </div>
                ${tierDep}
                ${selected ? `<div style="font-size:9px;font-weight:700;letter-spacing:.15em;
                                          text-transform:uppercase;color:${t.color};margin-top:8px;">
                              ✓ Selected</div>` : ''}
              </div>
            `;
          }).join('')}
        </div>
      `;
    }

    // Payment terms — deposit-rule.js (2026-09-25), the one answer every quote,
    // contract, invoice and portal view prints. The V2 builder hands over the
    // plan it already stamped (estimate.depositPlan: live claim fields, the
    // all-in total); anything else is computed from the estimate + meta.claim.
    // This block used to fall back to its own 50/50 split, which is how the
    // on-screen quote and the server PDF ("25%") came to disagree.
    const _rule = (typeof window !== 'undefined') ? window.NBDDepositRule : null;
    const depositPlan = _quoteDepositPlan(_rule, estimate, meta, estimate.total,
      meta.depositPlan || estimate.depositPlan || null);
    const deposit = depositPlan ? depositPlan.depositCents / 100 : null;
    const balance = depositPlan ? depositPlan.balanceCents / 100 : null;
    const _planOk = !!(depositPlan && depositPlan.totalCents > 0);
    const depositTerms = `
      <h2>Payment Terms</h2>
      <table>
        <tbody>
          ${_planOk ? depositPlan.rows.map(r => `
          <tr>
            <td><strong>${escapeHtml(r.label)} — ${escapeHtml(r.due)}</strong></td>
            <td class="num"><strong>${r.amountCents != null ? fmtMoneyBig(r.amountCents / 100) : escapeHtml(r.amountText)}</strong></td>
          </tr>`).join('') : ''}
          <tr class="grand-row">
            <td><strong>PROJECT TOTAL</strong></td>
            <td class="num"><strong>${fmtMoneyBig(estimate.total)}</strong></td>
          </tr>
        </tbody>
      </table>
      ${_planOk && depositPlan.summary ? `<p class="deposit-terms" style="font-size:12px;color:#444;margin-top:8px;">${escapeHtml(depositPlan.summary)}</p>` : ''}
    `;

    // Warranty blurb. A Job Template estimate's workmanship warranty is set by
    // its job type (review 2026-09-25): this blurb promised a LIFETIME labor
    // warranty and "Better/Best tier upgrades" on template gutter, repair and
    // inspection quotes, and it is the only warranty text their V2 Retail /
    // Single Quote prints. Job type → its sentence, or no Workmanship line at
    // all when the job carries none; no tier sentence either way (no tier
    // applies). Roofing and every other estimate print exactly what they did.
    const _jobW = jobWarrantyText(estimate);
    const warranty = (_jobW === null) ? `
      <h2>Warranty</h2>
      <p style="font-size:12px;color:#444;">
        <strong>Materials:</strong> Manufacturer warranty per product (see scope details).<br>
        ${_b.isNbd ? `<strong>NBD Pledge:</strong> for as long as you own the home, we'll come back and make it right.<br>
        <strong>Workmanship:</strong> Written labor warranty by package — 1 to 20 years; length and transferability are listed on each option above.<br>` : `<strong>Workmanship:</strong> Workmanship warranty terms as stated in your written agreement.<br>`}
        <strong>System Warranty:</strong> Available with ${escapeHtml(((estimate.lines || []).find(l => /warranty/i.test(l.name)) || {}).name || 'Better/Best tier upgrades')}.
      </p>
    ` : `
      <h2>Warranty</h2>
      <p style="font-size:12px;color:#444;">
        <strong>Materials:</strong> Manufacturer warranty per product (see scope details).${_jobW ? `<br>
        <strong>Workmanship:</strong> ${escapeHtml(_jobW)}` : ''}
      </p>
    `;

    const header = `
      <div class="hdr">
        <div>
          <div class="brand">${brandHeaderHtml(_b)}</div>
          <div class="sub">${escapeHtml(company.tagline)}</div>
          <div class="badge">Project Estimate</div>
        </div>
        <div class="doc-hdr">
          <div class="doc-title">Estimate</div>
          <div class="doc-date">${fmtDate(est.date)}</div>
          <div class="doc-date">Estimate #${escapeHtml(est.number || (_b.docPrefix ? _b.docPrefix + '-' : '') + Date.now())}</div>
          <div class="doc-total-lbl">Your Investment</div>
          <div class="doc-total-val">${fmtMoneyBig(estimate.total)}</div>
        </div>
      </div>
    `;

    const propertyBlock = `
      <h2>Property & Customer</h2>
      <div class="field-grid">
        <div class="field"><label>Customer</label><div class="v">${escapeHtml(customer.name || '—')}</div></div>
        <div class="field"><label>Property Address</label><div class="v">${escapeHtml(customer.address || '—')}</div></div>
        <div class="field"><label>Phone</label><div class="v">${escapeHtml(customer.phone || '—')}</div></div>
        <div class="field"><label>Email</label><div class="v">${escapeHtml(customer.email || '—')}</div></div>
      </div>
    `;

    // Scope summary (bulleted, no prices shown)
    const scopeBlock = `
      <h2>Scope of Work Included</h2>
      <p style="font-size:11px;color:#666;margin-bottom:12px;">
        This estimate includes everything listed below — no hidden charges.
      </p>
      <ul style="list-style:none;padding:0;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        ${bulletHtml}
      </ul>
    `;

    const footer = `
      <h2>Acceptance</h2>
      <div class="sig-block">
        <div>
          <div style="height:40px;"></div>
          <div class="sig-line">Customer Signature<br>
               ${escapeHtml(customer.name || '')}<br>
               Date: ____________________</div>
        </div>
        <div>
          <div style="height:40px;"></div>
          <div class="sig-line">Contractor — ${escapeHtml(est.preparedBy || (_b.isNbd ? 'Joe Deal' : _b.seal))}<br>
               ${escapeHtml(company.name)}<br>
               Date: ${fmtDate(est.date)}</div>
        </div>
      </div>

      <div class="terms">
        <strong>Terms:</strong> This estimate is valid for 30 days from the date above.
        Scope is based on visible conditions; hidden damage (rot, structural issues) may
        incur additional charges with prior authorization. Permits included where required.
        Warranty effective upon final payment.
      </div>

      <div class="footer">
        <div style="display:flex;justify-content:space-between;">
          <span>${escapeHtml(company.name)} · ${escapeHtml(company.phone)}</span>
          <span>${escapeHtml(company.email)}${company.address ? ' · ' + escapeHtml(company.address) : ''}</span>
        </div>
      </div>
    `;

    const html = `<!DOCTYPE html>
<html class="nbd-est-doc"><head><meta charset="UTF-8">
<title>Estimate — ${escapeHtml(customer.name || _b.seal)} — ${fmtDate(est.date)}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" rel="stylesheet">
<style>${buildBaseCss(_acc)}</style>
</head><body>
${header}
${propertyBlock}
${tierCards}
${scopeBlock}
${photoBlock(meta.photos, _acc)}
${depositTerms}
${warranty}
${footer}
</body></html>`;

    return {
      format: 'retail-quote',
      html,
      lineCount: (estimate.lines || []).length,
      scopeItemCount: bullets.length,
      total: estimate.total,
      deposit: deposit,
      balance: balance,
      depositPlan: depositPlan
    };
  }

  // ═════════════════════════════════════════════════════════
  // 3. INTERNAL VIEW FORMATTER (Joe's eyes only)
  // ═════════════════════════════════════════════════════════

  function formatInternalView(estimate, meta) {
    meta = meta || {};
    const customer = meta.customer || {};
    const est      = meta.estimate || {};
    const _b   = resolveBrand();
    const _acc = _b.accent;

    // Order quantities (if LumaNails or other packaging)
    let orderLines = '';
    if (window.EstimateLogic && window.EstimateLogic.convertToOrderingUnit) {
      const orders = [];
      (estimate.lines || []).forEach(line => {
        // Look up original catalog item for packaging info
        const cat = window.NBD_XACT_CATALOG;
        if (!cat) return;
        const orig = cat.find(line.code);
        if (orig && orig.packaging) {
          const converted = window.EstimateLogic.convertToOrderingUnit(orig, line.quantity);
          if (converted.converted) {
            orders.push({
              line: line.name,
              sellQty: line.quantity,
              sellUnit: line.unit,
              orderQty: converted.qty,
              orderUnit: converted.unit,
              orderCost: converted.totalCost
            });
          }
        }
      });
      if (orders.length) {
        orderLines = `
          <h2>Purchase Order Quantities</h2>
          <table>
            <thead><tr><th>Item</th><th class="num">Scope Qty</th><th class="num">Order Qty</th><th class="num">Order Cost</th></tr></thead>
            <tbody>
              ${orders.map(o => `
                <tr>
                  <td>${escapeHtml(o.line)}</td>
                  <td class="num">${fmtQty(o.sellQty, o.sellUnit)} ${escapeHtml(o.sellUnit)}</td>
                  <td class="num"><strong>${o.orderQty} ${escapeHtml(o.orderUnit)}</strong></td>
                  <td class="num">${o.orderCost ? fmtMoneyBig(o.orderCost) : '—'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    }

    const html = `<!DOCTYPE html>
<html class="nbd-est-doc"><head><meta charset="UTF-8">
<title>Internal Estimate View — ${escapeHtml(customer.name || _b.seal)}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" rel="stylesheet">
<style>${buildBaseCss(_acc)}
.internal-banner { background:#c53030; color:#fff; padding:10px 16px; font-size:11px;
                    font-weight:700; letter-spacing:.15em; text-transform:uppercase;
                    text-align:center; margin-bottom:20px; border-radius:4px; }
.margin-card { background:#ecfdf5; border:2px solid #065f46; border-radius:8px;
               padding:16px; text-align:center; }
.margin-big { font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif; font-size:32px;
              font-weight:800; color:#065f46; }
.cost-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:12px 0; }
.cost-card { background:#f8f4ef; padding:12px; border-radius:4px; text-align:center; }
.cost-card .lbl { font-size:9px; color:#666; text-transform:uppercase; letter-spacing:.1em; }
.cost-card .val { font-size:18px; font-weight:700; color:#111; margin-top:4px; }
/* Phone preview (2026-09-25, estimate#7): four cost cards across overflowed a
   360px viewer; two per row fit. Same html.nbd-est-doc scoping as the base. */
@media screen and (max-width:600px) {
  html.nbd-est-doc .cost-grid { grid-template-columns:repeat(2,1fr); }
}
</style>
</head><body>
<div class="internal-banner">🔒 INTERNAL VIEW — NOT FOR CUSTOMER — ${_b.isNbd ? "Joe's Eyes Only" : 'Internal Use Only'}</div>

<div class="hdr">
  <div>
    <div class="brand">${brandHeaderHtml(_b)}</div>
    <div class="sub">Internal Cost / Margin Breakdown</div>
  </div>
  <div class="doc-hdr">
    <div class="doc-date">${fmtDate(est.date)}</div>
    <div class="doc-date">${escapeHtml(customer.name || '')}</div>
  </div>
</div>

<h2>Margin Analysis</h2>
<div class="cost-grid">
  <div class="cost-card">
    <div class="lbl">Customer Total</div>
    <div class="val">${fmtMoneyBig(estimate.total)}</div>
  </div>
  <div class="cost-card">
    <div class="lbl">Hard Cost (Material + Labor)</div>
    <div class="val">${fmtMoneyBig(estimate.hardCost)}</div>
  </div>
  <div class="cost-card">
    <div class="lbl">OH + Profit</div>
    <div class="val">${fmtMoneyBig((estimate.overhead || 0) + (estimate.profit || 0))}</div>
  </div>
  <div class="cost-card">
    <div class="lbl">Net Margin</div>
    <div class="val" style="color:#065f46;">${estimate.internal.margin == null ? '—' : fmtMoneyBig(estimate.internal.margin)}</div>
  </div>
</div>

<div class="margin-card" style="margin-top:16px;">
  <div style="font-size:10px;color:#065f46;text-transform:uppercase;letter-spacing:.15em;font-weight:700;">
    MARGIN PERCENTAGE
  </div>
  <!-- null marginPct = no tenant cost basis configured (EBv2 ships zeros;
       real costs are tenant data, set in Estimate Settings) -->
  <div class="margin-big">${estimate.internal.marginPct == null ? '— set cost basis in Settings' : estimate.internal.marginPct.toFixed(1) + '%'}</div>
</div>

<h2>Cost Breakdown</h2>
<div class="cost-grid">
  <div class="cost-card">
    <div class="lbl">Raw Material Cost</div>
    <div class="val">${fmtMoneyBig(estimate.materialCost)}</div>
  </div>
  <div class="cost-card">
    <div class="lbl">Material Retail (+markup)</div>
    <div class="val">${fmtMoneyBig(estimate.materialRetail)}</div>
  </div>
  <div class="cost-card">
    <div class="lbl">Labor Cost</div>
    <div class="val">${fmtMoneyBig(estimate.laborCost)}</div>
  </div>
  <div class="cost-card">
    <div class="lbl">Hard Cost</div>
    <div class="val">${fmtMoneyBig(estimate.hardCost)}</div>
  </div>
</div>

${orderLines}

<h2>Resolved Line Items (with sources)</h2>
<table>
  <thead>
    <tr>
      <th style="width:90px;">Code</th>
      <th>Item</th>
      <th class="num" style="width:60px;">Qty</th>
      <th class="num" style="width:70px;">Mat $/u</th>
      <th class="num" style="width:70px;">Lab $/u</th>
      <th class="num" style="width:80px;">Total</th>
      <th style="width:100px;font-size:9px;">Source</th>
    </tr>
  </thead>
  <tbody>
    ${(estimate.lines || []).map(l => `
      <tr>
        <td class="code">${escapeHtml(l.code || '')}</td>
        <td>${escapeHtml(l.name || '')}</td>
        <td class="num">${fmtQty(l.quantity, l.unit)} ${escapeHtml(l.unit || '')}</td>
        <td class="num">${fmtMoney(l.materialCostPerUnit)}</td>
        <td class="num">${fmtMoney(l.laborCostPerUnit)}</td>
        <td class="num"><strong>${fmtMoney(l.lineTotal)}</strong></td>
        <td style="font-size:8px;color:#666;">
          M: ${escapeHtml((l.matSource || 'n/a').substring(0, 20))}<br>
          L: ${escapeHtml((l.labSource || 'n/a').substring(0, 20))}
        </td>
      </tr>
    `).join('')}
  </tbody>
</table>

<div class="footer">
  <strong>Min job applied:</strong> ${estimate.minJobApplied
    ? ('YES (' + fmtMoney(estimate.minJobCharge || estimate.total) + ' floor)')
    : 'No'} ·
  <strong>Tax rate:</strong> ${((estimate.taxRate || 0) * 100).toFixed(2)}% ·
  <strong>Tier:</strong> ${escapeHtml(estimate.tier || 'n/a')} ·
  <strong>Mode:</strong> ${escapeHtml(estimate.mode || 'n/a')}
</div>
</body></html>`;

    return {
      format: 'internal-view',
      html,
      margin: estimate.internal.margin,
      marginPct: estimate.internal.marginPct,
      total: estimate.total
    };
  }

  // Single-number quote = the retail quote WITHOUT the Good/Better/Best cards.
  // formatRetailQuote renders the tier cards only when meta.tiers is present, so we
  // strip it: same layout + "Your Investment" = the selected per-SQ tier total
  // (set in getCurrentEstimate), no comparison. finalize() already omits meta.tiers
  // for single-quote, so this is belt-and-suspenders.
  function formatSingleQuote(estimate, meta) {
    const metaNoTiers = Object.assign({}, meta || {}, { tiers: null });
    const out = formatRetailQuote(estimate, metaNoTiers);
    return Object.assign({}, out, { format: 'single-quote' });
  }

  // ═════════════════════════════════════════════════════════
  // Unified dispatcher
  // ═════════════════════════════════════════════════════════

  function formatEstimate(estimate, format, meta) {
    format = format || 'retail-quote';
    switch (format) {
      case 'insurance-scope':
      case 'insurance':
        return formatInsuranceScope(estimate, meta);
      case 'retail-quote':
      case 'retail':
      case 'cash':
        return formatRetailQuote(estimate, meta);
      case 'internal-view':
      case 'internal':
        return formatInternalView(estimate, meta);
      case 'single-quote':
      case 'single':
        return formatSingleQuote(estimate, meta);
      default:
        return formatRetailQuote(estimate, meta);
    }
  }

  // Open a formatted estimate in a new window for print/PDF
  function openInNewWindow(formattedResult) {
    if (!formattedResult || !formattedResult.html) return null;
    const w = window.open('', '_blank');
    if (!w) return null;
    w.document.write(formattedResult.html);
    w.document.close();
    return w;
  }

  // ═════════════════════════════════════════════════════════
  // Public API
  // ═════════════════════════════════════════════════════════
  window.EstimateFinalization = {
    formatEstimate,
    formatInsuranceScope,
    formatRetailQuote,
    formatSingleQuote,
    formatInternalView,
    openInNewWindow,

    // Helpers (exposed for reuse)
    escapeHtml,
    fmtMoney,
    fmtMoneyBig,
    fmtQty,
    fmtDate,
    fmtCodeRefs,
    groupByCategory,
    BASE_CSS
  };

  console.log('[EstimateFinalization] 4 output formatters ready: insurance-scope, retail-quote, single-quote, internal-view');
})();
