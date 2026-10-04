/**
 * NBD Home Solutions - Document Generation Engine
 *
 * Professional document generator for roofing/exterior contracting CRM.
 * Generates magazine-quality branded documents as HTML that can be printed to PDF.
 *
 * Exposes: window.NBDDocGen
 */

/**
 * Core NBD Document Generator
 * @namespace window.NBDDocGen
 */
let _NBD_DG_DELEGATE_BOUND; // module-local (globals Tranche 1 — was window.*)
window.NBDDocGen = {
  // ============================================================================
  // SECTION 1: CONSTANTS & CONFIGURATION
  // ============================================================================

  /**
   * Company branding and contact information
   */
  COMPANY: {
    name: 'No Big Deal Home Solutions',
    phone: '(859) 420-7382',
    email: 'info@nobigdealwithjoedeal.com',
    website: 'nobigdealwithjoedeal.com',
    tagline: 'No Big Deal — We\'ve Got You Covered',
    address: '', // Optional
    colors: {
      // NBD DOCUMENT STANDARD, locked 2026-09-07 — measured off the master logo
      // artwork. Keep in step with company-profile.js brand.colors; this object
      // is only the fallback for when the profile has not resolved yet.
      primary: '#1A3057',    // Navy — logo wordmark and roof
      secondary: '#12223D',  // Navy-deep — gradients, dark bars
      accent: '#BD5728',     // Orange — the logo's rust, clears WCAG AA
      lightGray: '#f5f5f5',
      borderGray: '#ddd',
      grey: '#4C4C4D',       // Captions, labels
      rule: '#DFE2E7',       // Hairlines, table borders
      wash: '#F6F7F8'        // Zebra rows, panel fills
    }
  },

  /**
   * Resolve the active tenant's branding into the COMPANY shape this
   * generator renders from (Phase B — TenantContext). EVERY tenant, NBD
   * included, now renders from companyProfile.brand via window._brand()
   * (docs/pro/js/company-profile.js) — the profile is the single source of
   * truth, so editing it changes documents. Falls back to the NBD base
   * whenever the resolver isn't loaded or errors.
   *
   * The fallback differs by tenant, and that difference is the security
   * property (review M1):
   *   NBD      → falls back to base.*  (it IS NBD; inheriting its own values
   *              cannot be a cross-tenant leak)
   *   non-NBD  → falls back to BLANK, never base.*  — a partially-configured
   *              tenant must not inherit NBD's phone/email/website/logo/
   *              tagline onto its documents.
   * colors are cosmetic and may inherit either way.
   *
   * NBD renders byte-identically because the brand defaults carry exactly the
   * base values (email info@, the document tagline, no address).
   */
  _resolveCompany() {
    const base = this.COMPANY;
    try {
      const b = (typeof window !== 'undefined' && window._brand) ? window._brand() : null;
      if (b && b.legalName) {
        const isNbd = b.legalName === base.name;
        const c = b.colors || {};
        const contact = b.contact || {};
        const fb = isNbd
          ? base
          : { phone: '', email: '', website: '', tagline: '', address: '' };
        return {
          name:    b.legalName,
          phone:   contact.phone   || fb.phone,
          email:   contact.email   || fb.email,
          website: contact.website || fb.website,
          tagline: b.tagline       || fb.tagline,
          address: contact.address || fb.address,
          // NBD keeps logoUrl null so _logoSrc serves the INLINE data URI it
          // always has. brand.logoUrl is a remote URL, and a remote fetch is
          // exactly what can fail mid-PDF-render. A tenant uses its own or none.
          logoUrl: isNbd ? null : (b.logoUrl || null),
          colors: {
            primary:    c.primary    || base.colors.primary,
            secondary:  c.secondary  || base.colors.secondary,
            accent:     c.accent     || base.colors.accent,
            lightGray:  base.colors.lightGray,
            borderGray: base.colors.borderGray
          }
        };
      }
    } catch (_) { /* fall back to NBD base */ }
    return base;
  },

  /**
   * Which law this document is written under (2026-09-27, KY SB 153).
   * ky-insurance-law.js (window.NBDJurisdiction) decides; this only gathers
   * the job facts from the document data and the lead it belongs to. A
   * classification doc pre-flight already stamped on `data.jurisdiction` is
   * OR-ed in — never trusted to turn a Kentucky signal off (fail closed).
   * Returns null only when the module did not load.
   */
  _jurisdiction(data) {
    const J = (typeof window !== 'undefined') && window.NBDJurisdiction;
    if (!J) return null;
    const d = data || {};
    let lead = {};
    try {
      const leadId = d.leadId || (d.customer && d.customer.id) || null;
      const cur = window._leadDoc || null;
      if (cur && (!leadId || cur.id === leadId || !cur.id)) lead = cur;
      else if (leadId && Array.isArray(window._leads)) lead = window._leads.find(l => l && l.id === leadId) || {};
    } catch (_) { lead = {}; }
    const j = J.classify({
      address: d.address || d.homeownerAddress || d.propertyAddress || d.projectAddress || lead.address || '',
      zip: d.zip || lead.zip || '',
      state: d.state || lead.state || '',
      jobType: d.jobType || lead.jobType || '',
      mode: d.mode || d.jobMode || '',
      claimNumber: d.claimNumber || lead.claimNumber || '',
      insuranceCarrier: d.insuranceCompany || d.insuranceCarrier || lead.insuranceCarrier || '',
      insCarrier: d.insCarrier || lead.insCarrier || '',
      isInsuranceJob: d.isInsuranceJob === true,
      isInsurance: d.isInsurance === true
    });
    const s = (d.jurisdiction && typeof d.jurisdiction === 'object') ? d.jurisdiction : null;
    if (s) {
      j.kentucky = j.kentucky || s.kentucky === true;
      j.insurance = j.insurance || s.insurance === true;
      j.kyInsurance = j.kyInsurance || s.kyInsurance === true || (j.insurance && j.kentucky);
      j.aobBarred = j.aobBarred || s.aobBarred === true || j.kentucky || j.kyInsurance;
      if (j.kentucky) j.state = 'KY';
    }
    return j;
  },

  /**
   * The contractor address a KY insurance contract / cancellation form must
   * print: brand.contact.mailingAddress ("Mailing Address (one line)"), the
   * tenant's own (window._brand() never inherits another tenant's). Never
   * businessAddress — that is the letterhead/microsite field, and Jo's rule
   * (2026-09-27) is that the address prints only where the law requires it.
   */
  _contractorPhysicalAddress(cp) {
    const J = (typeof window !== 'undefined') && window.NBDJurisdiction;
    if (!J) return '';
    let fromBrand = '';
    try { fromBrand = J.contractorMailingAddress(window._brand ? window._brand() : null); } catch (_) { fromBrand = ''; }
    const p = cp || (window._legal ? window._legal() : (window._companyProfile || {}));
    return fromBrand || J.contractorMailingAddress(p);
  },

  /**
   * Statutory blocks for a contract-class document (contract, signable
   * proposal). Every string is '' when the job is not a Kentucky insurance job.
   */
  _statutoryBlocks(data, cp) {
    const J = (typeof window !== 'undefined') && window.NBDJurisdiction;
    const j = this._jurisdiction(data);
    // The plain Payment clause prints on EVERY contract (Jo, 2026-09-27: no
    // AOB, no direction to pay, no co-payee instrument, any state).
    const out = { j, css: '', notices: '', forms: '', lien: '', partiesExtra: '',
      paymentClause: J ? J.PAYMENT_CLAUSE : '' };
    if (!J || !j || !j.kyInsurance) return out;
    const co = this._resolveCompany();
    const addr = this._contractorPhysicalAddress(cp);
    const fax = String((cp && cp.businessFax) || '').trim();
    out.css = J.STATUTORY_CSS;
    out.notices = J.kyNoticesHtml();
    out.lien = J.KY_LIEN_CLAUSE;
    // The signing date in the tenant's timezone (default America/New_York) —
    // "now" read there, never the UTC date or the rep's browser clock.
    out.forms = J.kyCancellationFormsHtml({
      transactionDate: data.contractDate || new Date(),
      timeZone: J.resolveTimeZone(cp),
      physicalAddress: addr,
      email: co.email || '',
      fax: fax
    });
    out.partiesExtra =
      '<strong>Mailing Address:</strong> ' + (addr ? this._escHtml(addr) : '<em>(not set — add it in Company Profile)</em>') + '<br/>' +
      (fax ? '<strong>Fax:</strong> ' + this._escHtml(fax) + '<br/>' : '');
    return out;
  },

  /**
   * Logo src for the active tenant — their brand.logoUrl when set, otherwise
   * the NBD inline data URI / asset path (byte-identical for NBD). Phase B-2.
   */
  _logoSrc() {
    const c = this._resolveCompany();
    if (c.logoUrl) return c.logoUrl;
    // A non-NBD tenant with no logo of its own gets NO logo — never NBD's
    // (cross-tenant leak, M1). Gate on the brand, NOT on object identity:
    // _resolveCompany now BUILDS an object for NBD too, so the old
    // `c !== this.COMPANY` test would have been true for NBD and silently
    // dropped its logo.
    if (!this._nbdGate().isNbd) return '';
    return (typeof window !== 'undefined' && window.NBD_LOGO_DATA_URI)
      ? window.NBD_LOGO_DATA_URI
      // Navy-on-white (2026-09-30): nbd-logo.png is the SITE lockup, recoloured
      // white for dark headers (#1572) — on paper "NO BIG" vanishes. Same choice
      // portal.html made; the inline data URI is the navy print master already.
      : this._assetOrigin() + '/assets/images/nbd-logo-light-bg.png';
  },

  /**
   * rgba() string from a hex color with the alpha written exactly as it should
   * appear in CSS (e.g. '.04', '0'). Lets section-tint gradients track the
   * active tenant's accent instead of a hardcoded NBD orange (review L4).
   * For NBD's #bd5728 this returns 'rgba(189,87,40,<alpha>)' — byte-identical
   * to the literal it replaced. Handles 3- and 6-digit hex; unparseable input
   * falls back to NBD orange's channels.
   */
  _rgba(hex, alpha) {
    const s = String(hex || '');
    let m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(s);
    let r = 232, g = 114, b = 12;
    if (m) {
      r = parseInt(m[1], 16); g = parseInt(m[2], 16); b = parseInt(m[3], 16);
    } else if ((m = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(s))) {
      r = parseInt(m[1] + m[1], 16); g = parseInt(m[2] + m[2], 16); b = parseInt(m[3] + m[3], 16);
    }
    return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
  },

  /**
   * Doc-number / filename prefix for the active tenant (brand.docPrefix).
   * 'NBD' for NBD — byte-identical. Phase B-2.
   */
  _docPrefix() {
    try {
      const b = (typeof window !== 'undefined' && window._brand) ? window._brand() : null;
      if (b && b.docPrefix) return b.docPrefix;
      // A non-NBD tenant that didn't set a docPrefix gets a DERIVED prefix —
      // never 'NBD' on another company's doc numbers (M1), and never '' (an
      // empty prefix yielded orphan '-0001' doc numbers / '-Contract-….pdf'
      // filenames). Derivation MUST stay byte-identical to company-profile.js
      // _deriveCustPrefix / onboarding.js deriveSeal / functions/customer-id.js
      // deriveCustPrefix (same pattern as _custIdSalt), so a later
      // reserveCompanyPrefix stamps the SAME prefix — no doc renumbering.
      if (b && b.legalName && b.legalName !== this.COMPANY.name) {
        const words = String(b.legalName).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
        let seal = words.map(function (w) { return w[0]; }).join('').slice(0, 4);
        if (seal.length < 2 && words[0]) seal = words[0].slice(0, 3);
        if (!seal || seal === 'NBD') seal = 'CUS';
        return seal;
      }
    } catch (_) { /* ignore */ }
    return 'NBD';
  },

  /**
   * NBD identity gate for the active tenant (Batch 3 de-branding). Resolves the
   * brand the same way _resolveCompany / window._brand() do. `isNbd` is true for
   * NBD AND any unconfigured tenant whose brand still resolves to the NBD
   * default — those must render byte-identical. Every signer-label helper below
   * funnels through this so the NBD branch is never rewritten.
   */
  _nbdGate() {
    let b = null;
    try { b = (typeof window !== 'undefined' && window._brand) ? window._brand() : null; }
    catch (_) { b = null; }
    const isNbd = !b || !b.legalName || b.legalName === 'No Big Deal Home Solutions';
    return { isNbd, brand: b };
  },

  /**
   * Tenant-aware "Authorized <X> Representative" signer label. NBD →
   * 'Authorized NBD Representative' (byte-identical). A non-NBD tenant → their
   * seal, falling back to legalName when the seal is unset ('' guarded).
   */
  _repSignerLabel() {
    const g = this._nbdGate();
    if (g.isNbd) return 'Authorized NBD Representative';
    const who = (g.brand && (g.brand.seal || g.brand.legalName)) || '';
    return 'Authorized ' + who + ' Representative';
  },

  /**
   * Tenant-aware "Contractor - <X>" signer label for the contract execution
   * block. NBD → 'Contractor - NBD Home Solutions' (byte-identical). A non-NBD
   * tenant → their legalName.
   */
  _contractorSignerLabel() {
    const g = this._nbdGate();
    if (g.isNbd) return 'Contractor - NBD Home Solutions';
    return 'Contractor - ' + ((g.brand && g.brand.legalName) || '');
  },

  /**
   * De-brand an NBD-default signer label for a non-NBD tenant. Single chokepoint:
   * renderSignatureBlock runs EVERY signer label through here — hardcoded arrays,
   * the contract fallback, AND the DOCUMENT_TYPES.defaultSigners labels that
   * doc-preflight.js seeds into data.signers (and labels emitted by the sibling
   * templates file), neither of which this generator can edit. NBD (and any
   * NBD-brand tenant) gets the label back byte-identical via the early return;
   * only a non-NBD tenant sees the known NBD-branded labels swapped for their
   * identity.
   */
  _deBrandSignerLabel(label) {
    const s = String(label == null ? '' : label);
    const g = this._nbdGate();
    if (g.isNbd) return s;
    if (s === 'Authorized NBD Representative') return this._repSignerLabel();
    if (s === 'Contractor - NBD Home Solutions') return this._contractorSignerLabel();
    // Inspection-doc signer labels that embed the literal 'NBD' as the company
    // (DOCUMENT_TYPES.inspectionHomeowner config + the two inspection templates'
    // hardcoded renderSignatureBlock calls). All funnel through this chokepoint,
    // so a non-NBD tenant's inspection paper carries THEIR name, not 'NBD'.
    const who = (g.brand && (g.brand.seal || g.brand.legalName)) || '';
    if (s === 'NBD Inspector') return (who + ' Inspector').trim();
    if (s === 'Certified NBD Inspector') return ('Certified ' + who + ' Inspector').replace(/\s+/g, ' ').trim();
    if (s === 'Certified NBD Damage Assessor') return ('Certified ' + who + ' Damage Assessor').replace(/\s+/g, ' ').trim();
    return s;
  },

  /**
   * Tenant-aware company segment for a document <title>. NBD keeps the exact
   * legacy 'NBD Home Solutions' literal (byte-identical — note this differs from
   * _resolveCompany().name 'No Big Deal Home Solutions', so DON'T use that for
   * NBD). A non-NBD tenant gets their escaped company name. The <title> is the
   * browser tab title, the print-page header, and the default Save-as-PDF
   * filename, so a bare 'NBD Home Solutions' there leaks onto a stranger's doc.
   */
  _docTitleCompany() {
    return this._nbdGate().isNbd ? 'NBD Home Solutions' : this._escHtml(this._resolveCompany().name || '');
  },

  /**
   * Manufacturer coverage tier — a DIFFERENT axis from workmanship duration
   * (which used to live here as 5/10/20-Year and is now the lifetime model
   * in estimate-config.js's TIER_DISPLAY, per the 2026-09-09 GBB audit).
   * Manufacturer warranty language was deliberately left untouched by the
   * 2026-09-08 claims-audit session and stays that way here.
   */
  // Five tiers (Jo, 2026-10-02): Economy = the shingle maker's standard
  // limited warranty, NO system warranty; Beyond = TAMKO HailGuard, whose
  // hail warranty is TAMKO's (manufacturer terms apply).
  MANUFACTURER_COVERAGE: {
    economy: { level: 'Standard Limited', note: 'The shingle manufacturer\'s standard limited warranty applies; no system warranty is included.' },
    good: { level: 'Standard', note: 'Manufacturer warranties vary by material.' },
    better: { level: 'Enhanced', note: 'Enhanced manufacturer coverage on select products.' },
    best: { level: 'Premium', note: 'Maximum manufacturer coverage on premium materials.' },
    beyond: { level: 'Premium + Hail', note: 'TAMKO HailGuard shingles carry TAMKO\'s HailGuard hail warranty (manufacturer terms apply).' }
  },

  /**
   * Registry of available document types
   */
  DOCUMENT_TYPES: {
    // Default signer set for contract-class docs. Homeowner is always
    // required; NBD rep prechecked-required but can be unchecked per-
    // gen via the modal's Signers section (PR #511 design). Per
    // [[signature-integration-v1]] PR 2 = roll this set out to the 8
    // other templates that the locked design lists as opt-in.
    proposal:              { name: 'Proposal / Estimate',             template: 'renderProposal',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'Authorized NBD Representative',   required: true },
                             ] },
    contract:              { name: 'Roofing Contract',                template: 'renderContract',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'Authorized NBD Representative',   required: true },
                             ] },
    inspectionHomeowner:   { name: 'Inspection Report (Homeowner)',   template: 'renderInspectionHomeowner',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'NBD Inspector',                   required: true },
                             ] },
    inspectionInsurance:   { name: 'Inspection Report (Insurance)',   template: 'renderInspectionInsurance' },
    // 20 document types with dedicated render functions in
    // document-generator-templates.js. Each produces a fully branded,
    // professional document specific to its purpose. Falls back to
    // renderGenericDoc if the template file isn't loaded yet.
    invoice:               { name: 'Invoice',                         template: 'renderInvoice' },
    customer_report:       { name: 'Customer Report',                 template: 'renderCustomerReport' },
    warranty_certificate:  { name: 'Warranty Certificate',            template: 'renderWarrantyCertificate' },
    certificate_of_completion: { name: 'Certificate of Completion',   template: 'renderCertificateOfCompletion',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'Authorized NBD Representative',   required: true },
                             ] },
    // 2026-09-15 (Paperwork Filing) — a permit is filed with a jurisdiction,
    // not signed by the homeowner in-app, so deliberately no defaultSigners.
    permit:                { name: 'Permit Application',              template: 'renderPermitApplication' },
    supplement_request:    { name: 'Supplement Request',              template: 'renderSupplementRequest' },
    scope_of_work:         { name: 'Scope of Work',                   template: 'renderScopeOfWork',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'Authorized NBD Representative',   required: true },
                             ] },
    change_order:          { name: 'Change Order',                    template: 'renderChangeOrder',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'Authorized NBD Representative',   required: true },
                             ] },
    work_authorization:    { name: 'Work Authorization',              template: 'renderWorkAuthorization',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'Authorized NBD Representative',   required: true },
                             ] },
    payment_agreement:     { name: 'Payment Agreement',               template: 'renderPaymentAgreement',
                             defaultSigners: [
                               { role: 'homeowner', label: 'Homeowner',                       required: true },
                               { role: 'rep',       label: 'Authorized NBD Representative',   required: true },
                             ] },
    material_delivery:     { name: 'Material Delivery Receipt',       template: 'renderMaterialDelivery' },
    thank_you:             { name: 'Thank You Letter',                template: 'renderThankYou' },
    company_intro:         { name: 'Company Introduction',            template: 'renderCompanyIntro' },
    financing_options:     { name: 'Financing Options',               template: 'renderFinancingOptions' },
    storm_checklist:       { name: 'Storm Damage Checklist',          template: 'renderStormChecklist' },
    claim_guide:           { name: 'Insurance Claim Guide',           template: 'renderClaimGuide' },
    referral_card:         { name: 'Referral Card',                   template: 'renderReferralCard' },
    before_after_report:   { name: 'Before & After Report',           template: 'renderBeforeAfterReport' },
    door_hanger:           { name: 'Door Hanger',                     template: 'renderDoorHanger' },
    neighborhood_mailer:   { name: 'Neighborhood Mailer',             template: 'renderNeighborhoodMailer' },
    testimonial_sheet:     { name: 'Testimonial Sheet',               template: 'renderTestimonialSheet' }
  },

  // 2026-09-15 (Paperwork Filing) — auto-derives a lead's *FiledAt gate field
  // (crm-stages.js's REQUIRED_FIELDS_BY_TYPE) the moment its document is
  // signed, so a rep who already e-signed a contract/AOB/COC never has to
  // separately tick a "filed" checkbox for the same fact. Read by
  // onPersistFinalized below. Permit has no entry here — no in-app signer to
  // hook, filed via the manual "Mark Permit Filed" action instead
  // (paperwork-write.js). warrantyCertFiledAt isn't here either —
  // warranty-cert.js's own _persistWarrantyToLead stamps it directly,
  // alongside the `warranty:{...}` object it already writes.
  FILED_FIELD_BY_DOC_TYPE: {
    contract:                  'contractFiledAt',
    certificate_of_completion: 'cocFiledAt',
  },

  // ============================================================================
  // SECTION 2: CORE ENGINE METHODS
  // ============================================================================

  /**
   * Generate document and open in new window with print button
   * @param {string} type - Document type (proposal, contract, inspectionHomeowner, inspectionInsurance)
   * @param {object} data - Merge field data
   */
  async generate(type, data = {}) {
    // ── HYDRATION GATE (2026-09-06) ────────────────────────────────────────
    // Every brand/prefix read below — window._legal(), window._brand(),
    // this._docPrefix(), and the '-WC' certificate prefix in
    // document-generator-templates.js:278 — is a SYNCHRONOUS function of the
    // company-profile brand doc, which company-profile.js:276 seeds with the
    // NBD DEFAULTS at parse time. Rendering before _loadCompanyProfile()
    // resolves therefore stamps the platform's identity onto another tenant's
    // document.
    //
    // The sync derivations themselves are NOT the bug and must not change:
    // docgen-brand.test.js pins five of them (NBD→NBD, OAK→OAK, unreserved→ORC,
    // degenerate→CUS, NBD-collision→CUS) and docgen-render.test.js pins the
    // matching cert numbers. They are faithful to the brand they are handed —
    // what was wrong was the brand. So gate ONCE here, at the async entry
    // point, instead of making the whole template layer async.
    //
    // Never blocks the rep: a hydration failure falls through and renders with
    // whatever brand is available, exactly as before.
    try {
      if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
        await window._loadCompanyProfile();
      }
    } catch (_) { /* render with what we have rather than blocking the rep */ }

    // Pass the document type through data so renderGenericDoc can
    // use it for the title (the generic template handles 20+ types).
    data._documentType = type;

    // Attach the merged shop-wide profile so every render function reads
    // editable legal text / financing / marketing from one place. Lead-
    // level overrides on `data` still win — render functions should look
    // up `data.foo ?? data.companyProfile.foo`.
    // Prefer window._legal() so the neutralized/party-substituted legal fields
    // (state-neutral jurisdiction, tenant legalName in place of literal "NBD")
    // flow into every render function via data.companyProfile. window._legal()
    // returns the profile byte-identical for NBD, so NBD output is unchanged.
    const _profileSrc = (window._legal ? window._legal() : window._companyProfile);
    data.companyProfile = (_profileSrc && typeof _profileSrc === 'object')
      ? _profileSrc
      : (window.NBD_COMPANY_PROFILE_DEFAULTS || {});

    // ─── Retired: Assignment of Benefits AND Direction to Pay (2026-09-27) ───
    // An AOB is void in Kentucky (KRS 304.20-105); Jo retired it and every
    // co-payee / direction-to-pay instrument in both states. A stale caller
    // (an old bookmark, a cached chip) gets the reason instead of a document.
    const _say = (m) => { if (typeof showToast === 'function') showToast(m, 'error'); else console.error(m); };
    if (type === 'assignment_of_benefits' || type === 'direction_to_pay') {
      const _Jr = window.NBDJurisdiction;
      _say((_Jr && _Jr.MSG.aobRetired) || 'The Assignment of Benefits has been retired. Contracts carry a plain payment clause.');
      return;
    }

    // ─── Kentucky SB 153 gates (2026-09-27) ───
    // A Kentucky insurance contract must print the contractor's mailing +
    // physical address (KRS 367.624(1), (4)); without one on the Company
    // Profile it is refused here as well as in pre-flight, since some
    // surfaces call generate() directly.
    const _J = window.NBDJurisdiction;
    const _jur = this._jurisdiction(data);
    if (_J && _jur) {
      data.jurisdiction = _jur;
      if ((type === 'contract' || type === 'proposal') && _jur.kyInsurance && !data._isBlankPreview
          && !this._contractorPhysicalAddress(data.companyProfile)) {
        _say(_J.MSG.addressRequired);
        return;
      }
    }

    // ─── QA fix: reconcile single-total docs against their rendered lines ───
    // The invoice + proposal fill-forms collect ONE rep-entered total
    // (totalAmount / totalPrice, both required) but no line items, while the
    // renderers default to hardcoded placeholder line items. Result: the
    // server invoice path summed empty lines → $0; the client invoice/proposal
    // paths rendered fixed placeholder figures that contradict the real total.
    // Synthesize one summary line from the entered total so EVERY render path
    // (_buildServerPayload, renderInvoice, renderProposal) reflects the real
    // figure. Only when the caller supplied no explicit line items — an
    // estimate→doc flow that passes real lines is respected untouched.
    if ((type === 'invoice' || type === 'proposal') &&
        (!Array.isArray(data.lineItems) || data.lineItems.length === 0)) {
      const _rawTotal = (type === 'invoice') ? data.totalAmount : data.totalPrice;
      const _amt = Number(String(_rawTotal == null ? '' : _rawTotal).replace(/[^0-9.\-]/g, '')) || 0;
      if (_amt > 0) {
        const _desc = data.projectDescription || data.projectType ||
          (type === 'invoice' ? 'Roofing Services — Complete Project' : 'Complete Roofing Project');
        // Carry every field name the three consumers read (rate / unitPrice /
        // lineTotal / total) so no path falls back to a placeholder.
        data.lineItems = [{ description: _desc, qty: 1, unit: 'JOB',
          rate: _amt, unitPrice: _amt, lineTotal: _amt, total: _amt }];
      }
    }

    // ─── Storm History Report: fetch live NOAA data before rendering ───
    // The one document type whose content isn't derivable from the lead
    // record alone — it needs the free 5-year NWS Local Storm Reports feed
    // the public /storm-report tool already uses (same relative /api/
    // storm-report endpoint, same origin as this page, no auth, no
    // secrets). Best-effort: a bad address or a down IEM proxy renders the
    // graceful "unavailable" branch in renderStormHistoryReport rather than
    // blocking the rep.
    if (type === 'storm_history_report') {
      try { await this._attachStormHistory(data); }
      catch (e) { console.warn('[NBDDocGen] storm history fetch failed:', e && e.message); }
    }

    // ─── D-5: try server-side Puppeteer render first ───
    // Supported types: contract / invoice / change_order. Receipt is
    // a future call site (no client surface yet). Falls through to
    // the legacy renderer on any error so reps are never blocked.
    const SERVER_TYPE_MAP = {
      contract:     'contract',
      invoice:      'invoice',
      change_order: 'changeOrder',
      receipt:      'receipt',
    };
    // Server-render bypass when signers are configured. The Puppeteer
    // templates don't know about signers yet, so server-rendered docs
    // would skip the interactive canvas blocks entirely. Force client
    // render so renderSignatureBlock can emit them and
    // _injectSignatureAssets can wire the widget.
    const hasSigners = Array.isArray(data.signers) && data.signers.length > 0;
    if (SERVER_TYPE_MAP[type] && !hasSigners) {
      try {
        const ok = await this._tryServerRender(SERVER_TYPE_MAP[type], type, data);
        if (ok) return;
      } catch (e) {
        console.warn('[NBDDocGen] server render failed, falling back:', e && e.message || e);
      }
    }

    let html = this.getHTML(type, data);
    if (html && hasSigners) {
      html = this._injectSignatureAssets(html);
    }
    if (!html) {
      if(typeof showToast==='function') showToast('Document type not found','error'); else console.error('Document type not found:', type);
      return;
    }
    // Blank-preview watermark. Set by _blankifyDocData() on
    // customer.html when the rep uses the "Preview blank template"
    // escape hatch (either from the doc-template ⓘ icon or the
    // Can't-Generate prereq modal). Stamped here, in one place, so
    // every template type picks it up without per-template work.
    if (data && data._isBlankPreview && /<\/body>/i.test(html)) {
      const wm = '<div data-nbd-watermark="blank-preview" style="position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#fef9c3;color:#92400e;border:1px solid #f59e0b;border-radius:8px;padding:6px 14px;font:700 11px/1 Barlow,sans-serif;letter-spacing:.12em;text-transform:uppercase;z-index:9999;box-shadow:0 2px 8px rgba(0,0,0,.15);pointer-events:none;white-space:nowrap;">&#9888;&#65039; Blank Preview &middot; Not for Delivery</div>';
      html = html.replace(/<\/body>/i, wm + '</body>');
    }
    const typeName = this.DOCUMENT_TYPES[type]?.name || type;
    // Route through the Universal Document Viewer so the user
    // can Save / Email / Print / PDF / Close without being dumped
    // into a blank popup with no way to persist the doc.
    if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
      const customerName = (data.customer && (data.customer.name || data.customer.firstName)) || '';
      const slug = (customerName || typeName).replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);

      // Persist on generate — not on Save. The previous flow only ran
      // the persist callback when the user explicitly tapped "Save"
      // inside the doc viewer; closing the viewer (or downloading a
      // PDF) without saving meant nothing was recorded. Now we kick
      // off the persistence in the background as soon as generate()
      // is called and use the doc id later in the onSave hook for
      // any post-processing. The HTML body is also uploaded to
      // Storage so the customer page can re-open the rendered
      // document later — previously only PDF + memory existed.
      const _leadIdEarly = data.leadId || (data.customer && data.customer.id) || window._customerId || null;
      // Tenant-resolved. _docPrefix() reads the brand doc, which answers 'NBD'
      // for every tenant until company-profile hydration completes — and this
      // filename is PERSISTED to leads/{id}/documents (:489) and rendered by
      // customer-documents.js, so a wrong brand sticks. _docPrefix() itself
      // stays synchronous for the template layer; only the filename moves.
      const _fnBase = slug + '-' + new Date().toISOString().split('T')[0] + '.pdf';
      const _filename = window._tenantFileName ? await window._tenantFileName(_fnBase) : _fnBase;
      // Hoisted so onPersistFinalized (called after the user signs in
      // the viewer) can re-upload to the same Storage path and update
      // the same Firestore doc with a signedAt stamp.
      let _htmlPath = null;
      let _docMetaRef = null;
      let _persistPromise = null;
      // A blank preview (the doc-template ⓘ icon, or the Can't-Generate
      // modal's "Preview blank template" escape hatch) must never persist:
      // it's a look-before-you-generate, not a real document. Without this
      // gate every preview click silently uploaded the rendered HTML to
      // Storage and wrote a 'draft' row under leads/{id}/documents — a rep
      // spot-checking a template layout was leaving real, unwanted document
      // records behind every time.
      if (_leadIdEarly && window.db && window.addDoc && window.collection && !data._isBlankPreview) {
        _persistPromise = (async () => {
          // Upload the rendered HTML to Storage so we can re-open it
          // from the documents tab later. Best-effort — if Storage
          // isn't wired on this page we still record metadata.
          //
          // Deliberately NO getDownloadURL here. That call stamps a
          // firebaseStorageDownloadTokens value on the object and returns a
          // URL that bypasses Storage rules, never expires and cannot be
          // revoked — for a document carrying the homeowner's name, address,
          // price and signature. The old code persisted that URL as
          // `htmlUrl`, so it also leaked into every export and backup of the
          // lead. Re-opening now goes through the authed getDocumentHtml
          // callable (functions/document-view.js), which reads the object
          // over the admin SDK after checking the caller owns the lead.
          try {
            if (window.storage && window.ref && window.uploadBytes && window._user?.uid) {
              const docId = 'd-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              _htmlPath = `documents/${window._user.uid}/${_leadIdEarly}/${docId}.html`;
              const sRef = window.ref(window.storage, _htmlPath);
              const blob = new Blob([html], { type: 'text/html' });
              await window.uploadBytes(sRef, blob, { contentType: 'text/html' });
            }
          } catch (e) {
            console.warn('Document HTML upload failed:', e && e.message);
          }
          try {
            _docMetaRef = await window.addDoc(
              window.collection(window.db, 'leads', _leadIdEarly, 'documents'),
              {
                type: type,
                typeName: typeName,
                customerName: customerName || null,
                filename: _filename,
                htmlPath: _htmlPath,
                // Lifecycle: draft -> sent (createSignRequest) -> signed
                // (submitSignature, or onPersistFinalized for in-person
                // signing below). customer-documents.js's normalize() falls
                // back to inferring signed/generated for pre-existing rows
                // that predate this field, so no backfill is needed.
                status: 'draft',
                createdAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
                createdBy: window.auth?.currentUser?.email || window._user?.email || 'unknown',
                userId: window.auth?.currentUser?.uid || window._user?.uid || null,
                signers: Array.isArray(data.signers)
                  ? data.signers.map(s => ({ role: s.role, label: s.label, required: !!s.required }))
                  : null,
                snapshot: {
                  total: (data.estimate && data.estimate.grandTotal) || data.total || null,
                  address: (data.customer && data.customer.address) || null
                }
              }
            );
          } catch (e) {
            console.warn('Document metadata persist failed:', e && e.message);
          }
          // The write has landed (or definitively failed) — repaint the
          // documents surfaces from the store rather than leaving the page
          // showing a stale list until the next full load.
          if (_docMetaRef && window.NBDCustomerDocs) {
            try { await window.NBDCustomerDocs.refresh(); }
            catch (e) { console.warn('Documents refresh failed:', e && e.message); }
          }
        })();
      }
      // PR3b: load this lead's saved signatures (if any) so the viewer
      // can hand them to the widget for one-tap "Use saved" reuse. Only
      // fetched when the doc actually has signers — zero cost otherwise.
      const _savedSigs = hasSigners ? await this._fetchSavedSignatures(_leadIdEarly) : null;
      window.NBDDocViewer.open({
        html: html,
        title: typeName + (customerName ? ' — ' + customerName : ''),
        filename: _filename,
        savedSigs: _savedSigs,
        // Signatures PR4: remote signing. Only for signable docs tied to a
        // lead. Awaits the doc's persist (so it has a real docId/htmlPath),
        // then mints + emails a doc_sign_tokens link via createSignRequest.
        onSendForSignature: (hasSigners && _leadIdEarly) ? (async (signerEmail) => {
          if (_persistPromise) { try { await _persistPromise; } catch (_) {} }
          const docId = _docMetaRef && _docMetaRef.id;
          if (!docId) throw new Error('Document is still saving — try again in a moment.');
          if (!window._functions || !window._httpsCallable) {
            const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
            window._functions = window._functions || mod.getFunctions();
            window._httpsCallable = window._httpsCallable || mod.httpsCallable;
          }
          const fn = window._httpsCallable(window._functions, 'createSignRequest');
          const res = await fn({ leadId: _leadIdEarly, docId, signerEmail, signerName: (data.customer && data.customer.name) || '' });
          return res && res.data;
        }) : null,
        signerEmailDefault: (data.customer && data.customer.email) || '',
        onSave: async () => {
          // Persistence already kicked off in the background via
          // _persistPromise above \u2014 wait for it (no-op if already
          // settled) so the success toast reflects the real state.
          if (_persistPromise) { try { await _persistPromise; } catch (_) {} }
          // Honest state: _persistPromise swallows the metadata addDoc failure
          // (only console.warn), leaving _docMetaRef null. If persistence was
          // ATTEMPTED for a real lead (_persistPromise set) but the doc never
          // landed (_docMetaRef null), it is NOT attached to the customer's
          // Documents tab \u2014 say so instead of a false success. The rendered doc
          // is still open in the viewer to Print / Download PDF.
          const attemptedPersist = !!_persistPromise;
          const attachedToLead = !!_docMetaRef;
          if (typeof showToast === 'function') {
            if (attemptedPersist && !attachedToLead) {
              showToast('\u26a0 Document generated but NOT saved to the customer \u2014 Print or Download PDF to keep a copy, then try again', 'error');
            } else {
              showToast('\u2713 Document generated \u2014 use Print or Download PDF to save a copy', 'success');
            }
          }
        },
        // Called by NBDDocViewer after the user finalizes signatures
        // inside the iframe. Re-uploads the signed HTML to the same
        // Storage path so reopening the doc shows the embedded sigs,
        // and stamps signedAt + signedSigners on the Firestore doc.
        onPersistFinalized: async (signedHtml, signedSigners) => {
          if (_persistPromise) { try { await _persistPromise; } catch (_) {} }
          try {
            if (_htmlPath && window.storage && window.ref && window.uploadBytes) {
              const sRef = window.ref(window.storage, _htmlPath);
              const blob = new Blob([signedHtml], { type: 'text/html' });
              // signed:'true' locks the object: storage.rules refuses any
              // later client overwrite or delete of a signed record (2026-09-29).
              await window.uploadBytes(sRef, blob, { contentType: 'text/html', customMetadata: { signed: 'true' } });
            }
          } catch (e) {
            console.warn('Signed HTML upload failed:', e && e.message);
          }
          try {
            if (_docMetaRef && window.updateDoc) {
              await window.updateDoc(_docMetaRef, {
                status: 'signed',
                signedAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
                // Keep the doc metadata lean: strip the PNG dataURLs (they
                // live in the signed HTML in Storage and in the per-role
                // signatures store written below — no need to duplicate
                // tens of KB of base64 onto every documents/{id} doc).
                signedSigners: Array.isArray(signedSigners)
                  ? signedSigners.map(s => ({ role: s.role, label: s.label || null, signedAt: s.signedAt || null }))
                  : null,
              });
            }
          } catch (e) {
            console.warn('Signed metadata update failed:', e && e.message);
          }
          // 2026-09-15 (Paperwork Filing) — auto-derive the lead-level *FiledAt
          // gate field (crm-stages.js's REQUIRED_FIELDS_BY_TYPE) from this real
          // signing event, so a rep who just e-signed a contract/AOB/COC never
          // has to separately tick a manual "filed" checkbox for the same fact.
          // Best-effort, its own try/catch — a failure here must not make the
          // signature persistence above look like it failed.
          try {
            const filedField = this.FILED_FIELD_BY_DOC_TYPE[type];
            if (filedField && _leadIdEarly && window.db && window.doc && window.updateDoc) {
              await window.updateDoc(window.doc(window.db, 'leads', _leadIdEarly), {
                [filedField]: new Date().toISOString(),
              });
            }
          } catch (e) {
            console.warn('Lead filed-stamp failed:', e && e.message);
          }
          // Repaint so the row picks up its '✓ Signed' state immediately.
          if (window.NBDCustomerDocs) {
            try { await window.NBDCustomerDocs.refresh(); }
            catch (e) { console.warn('Documents refresh failed:', e && e.message); }
          }

          // PR3a — saved-signature reuse store. Persist each captured
          // signature to leads/{leadId}/signatures/{role} keyed by role so
          // a future doc for the same lead can offer "Use saved" (PR3b)
          // instead of re-drawing. Best-effort; merge so re-signing
          // refreshes the stored image. PNGs are small (white-bg canvas)
          // and well under Firestore's 1MB doc ceiling.
          try {
            if (_leadIdEarly && window.db && window.setDoc && window.doc
                && Array.isArray(signedSigners)) {
              const _sigUid = window.auth?.currentUser?.uid || window._user?.uid || null;
              for (const s of signedSigners) {
                if (!s || !s.role || !s.png) continue;
                await window.setDoc(
                  window.doc(window.db, 'leads', _leadIdEarly, 'signatures', String(s.role)),
                  {
                    role: s.role,
                    label: s.label || null,
                    png: s.png,
                    userId: _sigUid,
                    updatedAt: window.serverTimestamp ? window.serverTimestamp() : new Date(),
                  },
                  { merge: true }
                );
              }
            }
          } catch (e) {
            console.warn('Signature reuse-store save failed:', e && e.message);
          }
        }
      });
      return;
    }
    // Fallback: legacy popup if the doc viewer isn't loaded
    const win = window.open('', '_blank');
    if (!win) {
      if(typeof showToast==='function') showToast('Popup blocked — please allow popups for this site and try again.','error');
      else alert('Please allow popups for this site to generate documents.');
      return;
    }
    // Inject action bar before closing </body>
    const actionBar = `
      <div class="doc-action-bar">
        <div class="doc-bar-left">
          <button class="doc-bar-btn doc-bar-close" data-dg-action="closeWindow">&#x2190; Close</button>
          <span class="doc-bar-title">${typeName}</span>
        </div>
        <div class="doc-bar-right">
          <button class="doc-bar-btn doc-bar-print" data-dg-action="print">Print / Save PDF</button>
        </div>
      </div>`;
    const injected = html.replace('</body>', actionBar + '</body>');
    win.document.write(injected);
    win.document.close();
  },

  /**
   * D-5: Server-side render via the renderPdf callable.
   * @param {string} template - Server-side template key (e.g. 'contract')
   * @param {string} type     - Original NBDDocGen type (used for filename)
   * @param {object} data     - Merge data, mapped to template payload
   */
  async _tryServerRender(template, type, data) {
    if (!window._functions || !window._httpsCallable) {
      const mod = await import('/assets/vendor/firebase/12.19.0/firebase-functions.js');
      window._functions = mod.getFunctions();
      window._httpsCallable = mod.httpsCallable;
    }
    const payload = this._buildServerPayload(template, data);
    if (!payload) return false;

    if (typeof showToast === 'function') showToast('Rendering ' + (this.DOCUMENT_TYPES[type]?.name || type) + '…', 'info');

    const customerName = (payload.preparedFor && payload.preparedFor.name) || 'NBD-Doc';
    const slug = customerName.replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
    // render-pdf.js takes this verbatim — tenant-resolved, never a wrong brand.
    const _srvBase = (this.DOCUMENT_TYPES[type]?.name || type).replace(/\s+/g, '-')
      + '-' + slug + '-' + new Date().toISOString().split('T')[0] + '.pdf';
    const filename = window._tenantFileName ? await window._tenantFileName(_srvBase) : _srvBase;

    const fn = window._httpsCallable(window._functions, 'renderPdf');
    const r = await fn({ template, payload, filename });
    const respData = r && r.data;
    if (!respData || !respData.ok || !respData.url) throw new Error('Render returned no URL');

    if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
      // NEW-D1: also hand the viewer the CLIENT-rendered HTML. The viewer's
      // preview is srcdoc-only by design (docviewer rule, PR #594) — a
      // url-only open() falls into its last-resort branch that sets a
      // cross-origin Firebase-Storage PDF as iframe.src, which Chrome/Brave
      // block ("This page has been blocked by Chrome"). With html supplied,
      // the preview renders same-origin and the server PDF stays attached as
      // pdfUrl for the high-fidelity Download action. Every SERVER_TYPE_MAP
      // type has a client template (generate()'s fallback path relies on it);
      // if getHTML ever returns null we degrade to the old url-only open.
      let previewHtml = null;
      try { previewHtml = this.getHTML(type, data) || null; } catch (e) { /* fall back to url-only */ }
      window.NBDDocViewer.open({
        html: previewHtml || undefined,
        url: respData.url,
        title: (this.DOCUMENT_TYPES[type]?.name || type) + (customerName ? ' — ' + customerName : ''),
        filename: respData.filename || filename,
      });
    } else {
      window.open(respData.url, '_blank', 'noopener');
    }
    const ms = respData.timing && respData.timing.totalMs;
    if (typeof showToast === 'function') {
      showToast(ms ? '✓ Document rendered in ' + ms + 'ms' : '✓ Document rendered', 'success');
    }
    return true;
  },

  /**
   * Resolve lat/lng for the lead — already on the record (`data.lat`/
   * `data.lng`, stamped when the lead was geocoded on save or on the map)
   * or, failing that, a free Nominatim geocode of the address — then fetch
   * the free NOAA/NWS 5-year storm history from the SAME relative endpoint
   * the public /storm-report page uses (functions/storm-report.js). Same
   * origin as this page, so no CORS/CSP wiring is needed regardless of
   * which tenant domain is serving /pro.
   *
   * Never throws: attaches `data.stormReport` on success or
   * `data._stormReportError` (a short reason, shown to the rep) on
   * failure, so a bad address never blocks doc generation — it just
   * renders the "unavailable" branch of the template.
   */
  async _attachStormHistory(data) {
    let lat = Number(data.lat);
    let lng = Number(data.lng != null ? data.lng : data.lon);
    if (!isFinite(lat) || !isFinite(lng)) {
      const addr = String(data.address || data.homeownerAddress || '').trim();
      if (!addr) { data._stormReportError = 'no address on file'; return; }
      try {
        const gRes = await fetch(
          'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(addr) + '&format=json&limit=1',
          { signal: AbortSignal.timeout(5000) }
        );
        const rows = await gRes.json();
        if (!Array.isArray(rows) || !rows.length) { data._stormReportError = 'address could not be located'; return; }
        lat = parseFloat(rows[0].lat);
        lng = parseFloat(rows[0].lon);
      } catch (e) {
        data._stormReportError = 'geocoding failed';
        return;
      }
    }
    if (!isFinite(lat) || !isFinite(lng)) { data._stormReportError = 'invalid coordinates'; return; }
    try {
      // 60s, not the usual 15-20s CRM fetch budget: a cache miss on
      // functions/storm-report.js chains FIVE sequential yearly IEM
      // requests server-side (each with its own 20s ceiling) before the
      // result is cached — verified live against the emulator, cold-cache
      // response took 38s. A cached lookup (the common case after the
      // first report for an address/area) returns in well under a second.
      const res = await fetch('/api/storm-report?lat=' + lat + '&lon=' + lng, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) { data._stormReportError = 'storm data service unavailable'; return; }
      const j = await res.json();
      if (j && j.empty) { data._stormReportError = 'storm data service unavailable'; return; }
      data.stormReport = j;
    } catch (e) {
      data._stormReportError = 'storm data request failed';
    }
  },

  /**
   * Deterministic document number helper. Was Date.now()-based, which
   * made every re-render of the same doc produce a fresh number — bad
   * for paperwork that's expected to keep the same INV/CT/CO/RCT
   * reference across regenerations. Seeded on stable lead context so
   * the same lead + same doc date always yields the same number.
   *
   * Falls through to Date.now()-based output only when no seed parts
   * are usable (very early renders before a lead is bound).
   */
  _seededDocNumber(prefix, seedParts, len) {
    const n = Math.max(4, Math.min(10, len || 6));
    const s = (seedParts || []).filter(Boolean).map(String).join('|');
    if (!s) return prefix + '-' + Date.now().toString().slice(-n);
    // FNV-1a 32-bit — small, deterministic, no deps. Collisions are
    // fine here; this is a display reference, not an idempotency key.
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return prefix + '-' + h.toString().padStart(n, '0').slice(-n);
  },

  /**
   * D-5: Map NBDDocGen legacy data to the new template payload shape.
   * Centralizes the conversion so the templates stay the only place
   * that knows the doc structure.
   */
  _buildServerPayload(template, data) {
    const customer = data.customer || {};
    const fullName = customer.name
      || ((customer.firstName || '') + ' ' + (customer.lastName || '')).trim()
      || data.homeownerName
      || 'Homeowner';
    const address = customer.address || data.address || '';
    const lead = (window._leads || []).find(l =>
      (l.address && address && l.address.trim() === String(address).trim()) ||
      (l.id && (l.id === customer.id || l.id === data.leadId))
    );

    const preparedFor = {
      name: fullName,
      address,
      customerId: (lead && lead.customerId) || customer.customerId || null,
      projectLine: data.projectLine || null,
    };
    // preparedBy identity is tenant-aware; NBD keeps the exact literals
    // (byte-identical), a tenant gets its own name/role/phone/email, never
    // NBD's (review M1). _resolveCompany returns the NBD base for NBD.
    const _pbCo = this._resolveCompany();
    const _pbNbd = _pbCo.name === 'No Big Deal Home Solutions';
    const preparedBy = {
      name:  (window._user && window._user.displayName) || (_pbNbd ? 'Joe Deal' : _pbCo.name),
      role:  _pbNbd ? 'Project Owner · No Big Deal Home Solutions' : ('Project Owner · ' + _pbCo.name),
      phone: _pbNbd ? '(859) 420-7382' : (_pbCo.phone || ''),
      email: _pbNbd ? 'jd@nobigdealwithjoedeal.com' : (_pbCo.email || ''),
    };
    const todayStr = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    // ── Per-template payload shaping ──
    if (template === 'invoice') {
      const lines = (data.lineItems || data.lines || []).map(i => ({
        description: i.description || i.name || '',
        category:    i.category || '',
        quantity:    i.qty || i.quantity || 1,
        unit:        i.unit || 'ea',
        unitPrice:   Number(i.rate || i.unitPrice || 0),
        lineTotal:   Number(i.lineTotal || ((i.qty || i.quantity || 1) * (i.rate || i.unitPrice || 0))),
      }));
      const subtotal = lines.reduce((s, l) => s + l.lineTotal, 0);
      const tax = Number(data.tax || (subtotal * (data.taxRate || 0)));
      const paymentsReceived = Number(data.paymentsReceived || 0);
      const total = subtotal + tax;
      const balanceDue = total - paymentsReceived;
      return {
        coverTagline: 'Final billing<br>for your project.',
        coverSub:     'Itemized invoice with payment detail and remaining balance. Pay online, by check, or by ACH.',
        preparedFor, preparedBy,
        projectMeta: [
          { label: 'Invoice Date', value: data.invoiceDate || todayStr },
          { label: 'Invoice No.',  value: data.invoiceNumber || this._seededDocNumber('INV', [data.leadId, fullName, data.invoiceDate || todayStr]) },
          { label: 'Due',          value: data.dueDate || 'Upon receipt' },
        ],
        summary: {
          headline: 'Invoice for completed work.',
          body: data.notes || null,
        },
        invoice: {
          number: data.invoiceNumber, date: data.invoiceDate || todayStr, dueDate: data.dueDate, status: data.status || 'due',
        },
        lines, subtotal, tax, paymentsReceived, total, balanceDue,
        notes: data.notes || null,
        payUrl: data.payUrl || null,
      };
    }

    if (template === 'contract') {
      // doc-preflight's CONTRACT schema collects `paymentSchedule` as a free-text
      // textarea ("Payment Schedule / Terms" -- see doc-preflight.js DOC_SCHEMAS
      // .contract), not the {stage,due,amount} row shape this branch used to
      // assume, so it arrives here as a STRING and `.map()` threw. A prose
      // schedule has no discrete stage/amount to put in the table (an invented
      // $0.00 row would misstate the contract), so route the string into the
      // paymentTerms paragraph below (contract.hbs section "3 · Payment Terms")
      // instead -- only a real array populates the table.
      const scheduleIsArray = Array.isArray(data.paymentSchedule);
      const scheduleText = (!scheduleIsArray && typeof data.paymentSchedule === 'string')
        ? data.paymentSchedule.trim() : '';
      // Deposit rule (2026-09-25): doc pre-flight attaches the job's plan from
      // deposit-rule.js (its rows honor a rep-edited Deposit Amount), so the
      // Payment Schedule table carries real stages and amounts, and the
      // paragraph falls back to the rule — never the "Fifty percent (50%)"
      // literal that used to sit here regardless of job size or insurance.
      const plan = (data.depositPlan && Array.isArray(data.depositPlan.rows)) ? data.depositPlan : null;
      const planRows = plan ? plan.rows.map(r => ({
        stage: r.label,
        dueDescription: r.due || '',
        amount: r.amountCents != null ? r.amountCents / 100 : null,
        amountText: r.amountCents != null ? '' : (r.amountText || ''),
      })) : [];
      const _cpTerms = (() => {
        try {
          const cp = window._legal ? window._legal() : (window.NBD_COMPANY_PROFILE_DEFAULTS || {});
          return (cp && cp.paymentTermsContract) || '';
        } catch (_) { return ''; }
      })();
      const _rulePolicy = (window.NBDDepositRule && typeof window.NBDDepositRule.policyText === 'function')
        ? window.NBDDepositRule.policyText() : '';
      return {
        coverTagline: 'The work,<br>committed in writing.',
        coverSub:     'A complete agreement covering scope, price, schedule, payment terms, and warranty. Both parties sign at the foot.',
        preparedFor, preparedBy,
        projectMeta: [
          { label: 'Contract Date', value: data.contractDate || todayStr },
          { label: 'Contract No.',  value: data.contractNumber || this._seededDocNumber('CT', [data.leadId, fullName, data.contractDate || todayStr]) },
          { label: 'Start',         value: data.startDate || 'Upon execution' },
        ],
        contract: { number: data.contractNumber, date: data.contractDate || todayStr, startDate: data.startDate, completionDate: data.completionDate },
        scope: data.scope || null,
        contractPrice: Number(data.contractPrice || data.total || 0),
        paymentSchedule: scheduleIsArray ? data.paymentSchedule.map(p => ({
          stage: p.stage || p.label,
          dueDescription: p.due || p.dueDescription || '',
          amount: Number(p.amount || 0),
        })) : planRows,
        paymentTerms: data.paymentTerms || scheduleText || (plan && plan.summary) || _cpTerms || _rulePolicy,
        materials: data.materials || null,
        warranty: data.warranty || null,
        rightToCancel: data.rightToCancel || 'You, the buyer, may cancel this transaction at any time prior to midnight of the third business day after the date of this transaction. See the attached Notice of Cancellation form for an explanation of this right.',
        additionalTerms: data.additionalTerms || [],
        // Kentucky SB 153 / FTC Cooling-Off (2026-09-27). The FACTS the server
        // needs to decide which statutory blocks to print — functions/
        // render-pdf.js re-classifies them with its own copy of
        // ky-insurance-law.js (never trusting a client verdict to turn a
        // Kentucky signal off) and reads the contractor's address from the
        // tenant's companyProfile server-side.
        // The LOCAL signing date (tenant timezone, default America/New_York)
        // as "YYYY-MM-DD", so the server never re-derives it from UTC.
        transactionDate: data.contractDate || (() => {
          const J = window.NBDJurisdiction;
          if (!J) return todayStr;
          const cp = data.companyProfile || (window._legal ? window._legal() : window._companyProfile) || {};
          return J.isoDay(J.todayIn(J.resolveTimeZone(cp)));
        })(),
        jurisdiction: (() => {
          const j = (data.jurisdiction && typeof data.jurisdiction === 'object') ? data.jurisdiction : (this._jurisdiction(data) || {});
          return {
            address: address,
            zip: data.zip || '',
            jobType: data.jobType || (lead && lead.jobType) || '',
            claimNumber: data.claimNumber || (lead && lead.claimNumber) || '',
            insuranceCarrier: data.insuranceCompany || data.insuranceCarrier || (lead && (lead.insuranceCarrier || lead.insCarrier)) || '',
            kentucky: j.kentucky === true,
            insurance: j.insurance === true,
            kyInsurance: j.kyInsurance === true,
          };
        })(),
      };
    }

    if (template === 'changeOrder') {
      const itemsAdded = (data.itemsAdded || []).map(i => ({
        description: i.item || i.description || '',
        quantity:    i.qty || i.quantity || 1,
        unit:        i.unit || 'ea',
        unitPrice:   Number(i.price || i.unitPrice || 0),
        lineTotal:   Number(i.lineTotal || ((i.qty || 1) * (i.price || 0))),
      }));
      const itemsRemoved = (data.itemsRemoved || []).map(i => ({
        description: i.item || i.description || '',
        quantity:    i.qty || i.quantity || 1,
        unit:        i.unit || 'ea',
        unitPrice:   Number(i.price || i.unitPrice || 0),
        lineTotal:   Number(i.lineTotal || ((i.qty || 1) * (i.price || 0))),
      }));
      const addedTotal = itemsAdded.reduce((s, x) => s + x.lineTotal, 0);
      const removedTotal = itemsRemoved.reduce((s, x) => s + x.lineTotal, 0);
      const netChange = addedTotal - removedTotal;
      const originalTotal = Number(data.originalTotal || 0);
      const newTotal = originalTotal + netChange;
      return {
        coverTagline: 'Scope changed.<br>Amended in writing.',
        coverSub:     'Amends the original contract referenced below. Work and pricing here are added to (or removed from) the previously agreed scope.',
        preparedFor, preparedBy,
        projectMeta: [
          { label: 'CO Date',         value: data.changeOrderDate || todayStr },
          { label: 'CO No.',          value: data.changeOrderNumber || this._seededDocNumber('CO', [data.leadId, fullName, data.changeOrderDate || todayStr, data.originalContractNumber]) },
          { label: 'Original Contract', value: data.originalContractNumber || '—' },
        ],
        changeOrder: {
          number: data.changeOrderNumber,
          originalContractNumber: data.originalContractNumber,
          originalDate: data.originalContractDate,
        },
        description: data.changesDescription || data.description || 'Additional work identified during project execution.',
        itemsAdded, itemsRemoved,
        originalTotal, netChange, newTotal,
        scheduleImpact: data.scheduleImpact || 'No change to estimated completion date.',
      };
    }

    if (template === 'receipt') {
      const amount = Number(data.amount || data.paymentAmount || 0);
      const contractTotal = Number(data.contractTotal || 0);
      const priorPayments = Number(data.priorPayments || 0);
      return {
        coverTagline: 'Payment<br>received.',
        coverSub:     'A record of payment posted to your project. Keep it with your project documents for warranty and tax purposes.',
        preparedFor, preparedBy,
        projectMeta: [
          { label: 'Receipt Date', value: data.paymentDate || todayStr },
          { label: 'Receipt No.',  value: data.receiptNumber || this._seededDocNumber('RCT', [data.leadId, fullName, data.paymentDate || todayStr, data.amount]) },
          { label: 'Amount',       value: '$' + amount.toLocaleString('en-US', { maximumFractionDigits: 0 }) },
        ],
        payment: {
          number: data.receiptNumber,
          date:   data.paymentDate || todayStr,
          method: data.paymentMethod || 'Check',
          reference: data.paymentReference || data.checkNumber || '—',
        },
        amount,
        contractTotal: contractTotal || null,
        priorPayments,
        balanceRemaining: contractTotal ? Math.max(0, contractTotal - priorPayments - amount) : null,
        appliedTo: data.appliedTo || (data.projectDescription) || null,
      };
    }

    return null;
  },

  /**
   * Get raw HTML string for document (without opening window)
   * @param {string} type - Document type
   * @param {object} data - Merge field data
   * @returns {string} Complete HTML document
   */
  getHTML(type, data = {}) {
    // Try the dedicated template first, fall back to generic if the
    // extended templates file hasn't loaded yet (deferred script).
    let template = this[this.DOCUMENT_TYPES[type]?.template];
    if (!template && this.DOCUMENT_TYPES[type]) {
      template = this.renderGenericDoc; // fallback
    }
    if (!template) {
      console.error(`Unknown document type: ${type}`);
      return null;
    }
    if (!data.companyProfile) {
      // Prefer window._legal() so neutralized/party-substituted legal fields
      // reach the render functions; byte-identical for NBD.
      const _profileSrc = (window._legal ? window._legal() : window._companyProfile);
      data.companyProfile = (_profileSrc && typeof _profileSrc === 'object')
        ? _profileSrc
        : (window.NBD_COMPANY_PROFILE_DEFAULTS || {});
    }
    return template.call(this, data);
  },

  /**
   * Open fill form modal, generate document on submit
   * @param {string} type - Document type
   */
  fillAndGenerate(type) {
    this.renderFillFormModal(type);
  },

  /**
   * Generate a blank copy of the template with placeholder lines
   * instead of filled data. User can print and fill by hand.
   * @param {string} type - Document type
   */
  async generateBlank(type) {
    // ── HYDRATION GATE (2026-09-14) ────────────────────────────────────────
    // Same pattern as generate() above (#1447/#1449): this._resolveCompany()
    // is a SYNCHRONOUS read of the company-profile brand doc, which
    // company-profile.js:276 seeds with the NBD DEFAULTS at parse time. This
    // function reads it FIVE times, below, BEFORE ever calling generate() —
    // and generate()'s own hydration gate is too late, because mergeFields()
    // spreads ...data LAST, so these pre-baked companyName/Phone/Email/
    // Website/Tagline values win over whatever generate() would have
    // produced after hydrating. A freshly-loaded tenant printing a blank
    // template can therefore get NBD's own identity on it.
    //
    // Gate here too, as the first statement, so _resolveCompany() below reads
    // a real tenant brand instead of the NBD defaults. Never blocks the rep:
    // a hydration failure falls through and renders with whatever brand is
    // available, exactly as before.
    try {
      if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
        await window._loadCompanyProfile();
      }
    } catch (_) { /* render with what we have rather than blocking the rep */ }

    // Build blank data with underline placeholders for hand-fill
    const blankData = {
      homeownerName: '________________________________',
      address: '________________________________',
      phone: '________________',
      email: '________________________________',
      projectDescription: '________________________________________________________________',
      totalPrice: '$__________',
      warrantyTier: '____________',
      warrantyTerms: '________________________________',
      startDate: '____ / ____ / ________',
      endDate: '____ / ____ / ________',
      signature: '________________________________',
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      // Keep company info filled since that's the contractor's data
      companyName: this._resolveCompany().name,
      companyPhone: this._resolveCompany().phone,
      companyEmail: this._resolveCompany().email,
      companyWebsite: this._resolveCompany().website,
      companyTagline: this._resolveCompany().tagline
    };
    await this.generate(type, blankData);
  },

  /**
   * Merge template fields with data
   * @param {string} template - HTML template with {{field}} placeholders
   * @param {object} data - Data object
   * @returns {string} Merged HTML
   */
  // Shared HTML-escaper for user/lead-sourced values interpolated into document
  // HTML. Docs render via NBDDocViewer's <iframe srcdoc>, which executes scripts,
  // and lead fields can originate from PUBLIC intake (submitPublicLead) — so any
  // unescaped value is a stored-XSS vector. Mirrors the local _esc already used for
  // line-items / signers in this file.
  _escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // Escape a multi-line companyProfile clause (legal/payment/warranty text)
  // then preserve author line breaks as <br/>. These come from
  // companyProfile/{tenant} (owner/admin-editable) and render into the
  // allow-scripts doc-viewer srcdoc, so they MUST be escaped before
  // interpolation (matches the escaped termsNote at the proposal terms block).
  _escClause(s) {
    return this._escHtml(s).replace(/\n/g, '<br/>');
  },

  mergeFields(template, data = {}) {
    // Provide defaults for common fields
    const mergedData = {
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      homeownerName: '',
      address: '',
      phone: this._resolveCompany().phone,
      email: this._resolveCompany().email,
      projectDescription: '',
      totalPrice: '$0.00',
      warrantyTier: 'better',
      warrantyTerms: '',
      companyName: this._resolveCompany().name,
      companyPhone: this._resolveCompany().phone,
      companyEmail: this._resolveCompany().email,
      companyWebsite: this._resolveCompany().website,
      companyTagline: this._resolveCompany().tagline,
      ...data
    };

    let result = template;
    Object.keys(mergedData).forEach(key => {
      const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
      // Escape values: placeholders carry scalar lead/company data into an HTML
      // template, so values are text. (Line-items/signature blocks are built
      // separately, not via {{placeholders}}.)
      result = result.replace(regex, this._escHtml(mergedData[key]));
    });

    return result;
  },

  // ============================================================================
  // SECTION 3: SHARED STYLING & UTILITIES
  // ============================================================================

  /**
   * Get shared CSS for all documents
   * @private
   * @returns {string} CSS styles
   */
  getSharedCSS() {
    return `
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }

        html, body {
          font-family: 'Georgia', serif;
          color: #333;
          line-height: 1.6;
          background: white;
        }

        /* min-height, NOT height: a fixed 11in box with overflow:hidden
           silently CLIPPED everything past one page — including the
           signature block, which renderContract emits last. Measured at
           375px: content 1799px tall in a 559px box, sig block at y=1733,
           container bottom y=1122, and nothing to scroll to. Remote
           signing could therefore never be completed on any screen size.
           @media print already overrides this with height:auto, which is
           why print/PDF output looked correct and the clip went unseen.
           The paper look (white page, shadow, letter width) is unchanged;
           the box now grows to fit its content instead of amputating it. */
        .document-container {
          max-width: 8.5in;
          min-height: 11in;
          margin: 20px auto;
          padding: 0.5in;
          background: white;
          box-shadow: 0 2px 8px rgba(0,0,0,0.15);
          overflow: visible;
          display: flex;
          flex-direction: column;
        }

        .document-header {
          position: relative;
          background: linear-gradient(180deg, ${this._resolveCompany().colors.primary} 0%, ${this._resolveCompany().colors.secondary} 100%);
          color: #fff;
          margin: -0.5in -0.5in 0.3in -0.5in;
          padding: 0.35in 0.5in 0.25in 0.5in;
          border-bottom: 6px solid ${this._resolveCompany().colors.accent};
        }

        .header-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 0.3in;
          margin-bottom: 0.12in;
        }

        .header-logo {
          flex: 0 0 auto;
        }

        /* Logo: inline <img> backed by an inline data URI of the real
           NBD brand mark (docs/assets/images/nbd-logo.png, 1536x1024).
           Switched from <object> after we discovered the iframe srcdoc
           CSP includes object-src 'none', which blocks <object> from
           loading its data URI regardless of MIME. <img> + data: URIs
           are allowed by img-src. The source image has a lot of
           whitespace around it; object-fit:contain keeps the mark
           centered with breathing room in this header strip. */
        .nbd-logo-img {
          display: block;
          /* Source logo is 1.5:1 (1536x1024). Width is fixed; height is
             left to auto so the white card hugs the artwork. The
             previous explicit height:72px forced a 2.78:1 box, leaving
             wide empty white bars on either side of the centered
             contain-fitted image — read as "logo stretched". */
          width: 200px;
          height: auto;
          object-fit: contain;
          object-position: left center;
          /* White card so the navy-on-white logo stays legible
             against the navy gradient header below. */
          background: #fff;
          border-radius: 8px;
          padding: 6px 10px;
          box-sizing: border-box;
        }

        .header-info {
          font: 600 10px/1.55 'Helvetica Neue', Arial, sans-serif;
          text-align: right;
          color: rgba(255,255,255,.95);
          letter-spacing: .02em;
        }
        .header-info > div + div { margin-top: 1px; }

        .header-company-name {
          font: 800 18px/1.1 'Helvetica Neue', Arial, sans-serif;
          color: #fff;
          letter-spacing: .04em;
          text-transform: uppercase;
          margin: 0.08in 0 0 0;
        }
        .header-tagline {
          font: italic 400 11px/1.3 Georgia, serif;
          color: ${this._resolveCompany().colors.accent};
          margin-top: 2px;
        }

        .header-contact-row {
          font: 600 10px/1.4 'Helvetica Neue', Arial, sans-serif;
          color: rgba(255,255,255,.85);
          margin-top: 0.08in;
          padding-top: 0.06in;
          border-top: 1px solid rgba(255,255,255,.18);
          letter-spacing: .02em;
        }

        .document-title {
          font: 800 26px/1.1 'Helvetica Neue', Arial, sans-serif;
          color: ${this._resolveCompany().colors.secondary};
          text-align: center;
          margin: 0.25in 0 0.08in 0;
          text-transform: uppercase;
          letter-spacing: 2px;
          position: relative;
          padding-bottom: 0.12in;
        }
        .document-title:after {
          content: "";
          display: block;
          width: 64px;
          height: 4px;
          background: ${this._resolveCompany().colors.accent};
          margin: 0.1in auto 0 auto;
          border-radius: 2px;
        }

        .document-subtitle {
          font: 600 12px/1.4 'Helvetica Neue', Arial, sans-serif;
          text-align: center;
          color: ${this._resolveCompany().colors.primary};
          margin-bottom: 0.22in;
          letter-spacing: .04em;
        }

        /* The second half of the clip: a flex child with overflow:hidden
           inside the fixed-height container above. Both had to go for the
           signature block to be reachable. */
        .document-content {
          flex: 1;
          overflow: visible;
          font-size: 11px;
        }

        .section {
          margin-bottom: 0.22in;
          padding: 0.12in 0.18in;
          border-left: 4px solid ${this._resolveCompany().colors.accent};
          background: linear-gradient(90deg, ${this._rgba(this._resolveCompany().colors.accent, '.04')} 0%, ${this._rgba(this._resolveCompany().colors.accent, '0')} 60%);
          border-radius: 0 6px 6px 0;
        }

        .section-title {
          font: 800 13px/1.1 'Helvetica Neue', Arial, sans-serif;
          color: ${this._resolveCompany().colors.primary};
          margin-bottom: 0.12in;
          text-transform: uppercase;
          letter-spacing: 1.2px;
          padding-bottom: 0.06in;
          position: relative;
          display: inline-block;
          padding-right: 0.3in;
        }
        .section-title:after {
          content: "";
          position: absolute;
          left: 0; bottom: 0;
          width: 28px; height: 3px;
          background: ${this._resolveCompany().colors.accent};
          border-radius: 2px;
        }

        .summary-text {
          font-size: 11px;
          line-height: 1.5;
          margin: 0.1in 0;
          color: #333;
        }

        .scope-list {
          list-style: none;
          margin: 0.1in 0;
        }

        .scope-list li {
          margin: 0.08in 0;
          padding-left: 0.25in;
        }

        .scope-list li:before {
          content: "•";
          color: ${this._resolveCompany().colors.accent};
          font-weight: bold;
          margin-right: 0.1in;
          margin-left: -0.25in;
        }

        /* TABLE STYLING */
        table {
          width: 100%;
          border-collapse: collapse;
          margin: 0.15in 0;
          font-size: 11px;
        }

        table thead {
          background-color: ${this._resolveCompany().colors.primary};
          color: white;
        }

        table th {
          padding: 0.1in;
          text-align: left;
          font-weight: bold;
          border: 1px solid ${this._resolveCompany().colors.primary};
        }

        table td {
          padding: 0.08in 0.1in;
          border: 1px solid ${this._resolveCompany().colors.borderGray};
        }

        table tr:nth-child(even) {
          background-color: ${this._resolveCompany().colors.lightGray};
        }

        .total-row {
          background-color: #fff;
          font-weight: bold;
          border-top: 2px solid ${this._resolveCompany().colors.primary};
        }

        .price-column {
          text-align: right;
        }

        .total-price {
          font-size: 14px;
          color: ${this._resolveCompany().colors.accent};
          font-weight: bold;
        }

        /* WARRANTY BADGE */
        .warranty-badge {
          display: inline-block;
          padding: 0.15in 0.25in;
          background-color: ${this._resolveCompany().colors.accent};
          color: white;
          border-radius: 4px;
          font-weight: bold;
          font-size: 12px;
          margin: 0.1in 0;
        }

        .warranty-details {
          background-color: ${this._resolveCompany().colors.lightGray};
          border-left: 3px solid ${this._resolveCompany().colors.primary};
          padding: 0.15in;
          margin: 0.1in 0;
          font-size: 10px;
          line-height: 1.5;
        }

        /* PHOTO ZONES */
        .photo-zone {
          border: 2px dashed ${this._resolveCompany().colors.borderGray};
          background-color: ${this._resolveCompany().colors.lightGray};
          padding: 0.2in;
          text-align: center;
          min-height: 1.5in;
          display: flex;
          align-items: center;
          justify-content: center;
          color: #999;
          font-size: 10px;
          margin: 0.1in 0;
        }

        .photo-zone.has-image {
          border: 1px solid ${this._resolveCompany().colors.borderGray};
          background: white;
        }

        .photo-zone img {
          max-width: 100%;
          max-height: 1.5in;
        }

        .photo-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.15in;
          margin: 0.15in 0;
        }

        .photo-grid.three-col {
          grid-template-columns: repeat(3, 1fr);
        }

        /* SIGNATURE BLOCKS */
        .signature-block {
          margin: 0.25in 0;
          font-size: 10px;
        }

        .signature-line {
          display: flex;
          justify-content: space-between;
          margin-bottom: 0.15in;
        }

        .sig-field {
          flex: 1;
          margin-right: 0.3in;
        }

        .sig-field:last-child {
          margin-right: 0;
        }

        .sig-underline {
          border-bottom: 1px solid #333;
          width: 100%;
          height: 0.4in;
          margin-bottom: 0.05in;
        }

        .sig-label {
          font-size: 9px;
          color: #666;
          font-weight: bold;
        }

        /* FOOTER */
        .document-footer {
          margin: 0.2in -0.5in -0.5in -0.5in;
          padding: 0.18in 0.5in;
          text-align: center;
          font: 600 10px/1.4 'Helvetica Neue', Arial, sans-serif;
          color: rgba(255,255,255,.92);
          background: linear-gradient(180deg, ${this._resolveCompany().colors.secondary} 0%, ${this._resolveCompany().colors.primary} 100%);
          border-top: 4px solid ${this._resolveCompany().colors.accent};
          letter-spacing: .04em;
        }
        .document-footer .footer-brand {
          display: block;
          font: 800 11px/1.2 'Helvetica Neue', Arial, sans-serif;
          color: #fff;
          letter-spacing: .1em;
          text-transform: uppercase;
          margin-bottom: 3px;
        }

        .footer-page-number {
          display: inline-block;
          margin: 0 0.2in;
          color: rgba(255,255,255,.7);
        }

        .footer-credit {
          display: block;
          font-size: 9px;
          color: rgba(255,255,255,.65);
          margin-top: 0.04in;
          letter-spacing: .06em;
        }

        /* ACTION BAR — fixed top bar with Close + Print/Save */
        .doc-action-bar {
          position: fixed;
          top: 0; left: 0; right: 0;
          height: 56px;
          background: ${this._resolveCompany().colors.primary};
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 20px;
          z-index: 1000;
          box-shadow: 0 2px 12px rgba(0,0,0,0.3);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }
        .doc-action-bar .doc-bar-left {
          display: flex; align-items: center; gap: 12px;
        }
        .doc-action-bar .doc-bar-right {
          display: flex; align-items: center; gap: 10px;
        }
        .doc-bar-btn {
          padding: 10px 20px;
          border: none; border-radius: 6px;
          font-size: 13px; font-weight: 700;
          cursor: pointer; transition: all 0.15s;
          text-transform: uppercase; letter-spacing: 0.04em;
        }
        .doc-bar-btn:active { transform: scale(0.96); }
        .doc-bar-close {
          background: rgba(255,255,255,0.15);
          color: white;
        }
        .doc-bar-close:hover { background: rgba(255,255,255,0.25); }
        .doc-bar-print {
          background: ${this._resolveCompany().colors.accent};
          color: white;
        }
        .doc-bar-print:hover { opacity: 0.9; }
        .doc-bar-title {
          color: rgba(255,255,255,0.8);
          font-size: 14px; font-weight: 600;
        }

        /* Push content below action bar */
        .document-container {
          margin-top: 66px !important;
        }

        /* Legacy print button (hidden, replaced by action bar) */
        .print-button-container { display: none; }

        /* PRINT MEDIA */
        @media print {
          body {
            margin: 0;
            padding: 0;
            background: white;
          }

          .doc-action-bar {
            display: none;
          }

          .print-button-container {
            display: none;
          }

          .document-container {
            margin-top: 0 !important;
          }

          .document-container {
            max-width: 100%;
            height: auto;
            margin: 0;
            padding: 0;
            box-shadow: none;
            page-break-after: always;
          }

          @page {
            margin: 0;
            size: letter;
          }
        }

        /* CONDITION GRADES */
        .condition-grade {
          display: inline-block;
          padding: 0.15in 0.25in;
          border-radius: 4px;
          font-weight: bold;
          color: white;
          margin: 0.05in 0;
        }

        .grade-a {
          background-color: #28a745;
        }

        .grade-b {
          background-color: #ffc107;
          color: #333;
        }

        .grade-c {
          background-color: #fd7e14;
        }

        .grade-d {
          background-color: #dc3545;
        }

        .grade-f {
          background-color: #6f42c1;
        }

        .urgency-immediate {
          color: #dc3545;
          font-weight: bold;
        }

        .urgency-monitor {
          color: #ffc107;
          font-weight: bold;
        }

        .urgency-good {
          color: #28a745;
          font-weight: bold;
        }

        /* HORIZONTAL RULE */
        hr {
          border: none;
          border-top: 1px solid ${this._resolveCompany().colors.borderGray};
          margin: 0.15in 0;
        }

        /* Credential / manufacturer badge row — same markup and asset
           lookup as affiliateRow() in document-generator-templates.js
           (window.NBD_BADGE_ASSETS, generated by scripts/build-badge-assets.js),
           just re-skinned to this engine's box-model (${this._resolveCompany().colors.rule}
           hairlines vs. that file's short CSS-var aliases). Kept in step by
           hand since the two template engines don't share a stylesheet. */
        .affiliates { display:flex; justify-content:center; align-items:center; gap:14px;
          flex-wrap:wrap; margin:0.3in 0 0.1in 0; }
        .affiliate { border:1px solid ${this._resolveCompany().colors.rule}; border-radius:6px;
          background:#fff; padding:8px 14px; text-align:left; }
        .affiliate-name { font:700 11px/1.3 'Helvetica Neue', Arial, sans-serif;
          color:${this._resolveCompany().colors.primary}; letter-spacing:0.04em; }
        .affiliate-num { font-size:10px; color:${this._resolveCompany().colors.grey}; margin-top:2px; }
        .affiliate-badge { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:6px 12px 8px; }
        .affiliate-badge-img { display:block; height:52px; width:auto; }
        .affiliate-badge-num { font-size:10px; color:${this._resolveCompany().colors.grey}; margin-top:5px; letter-spacing:0.02em; }
      </style>
    `;
  },

  // ============================================================================
  // SECTION 4: BRAND COMPONENTS (HEADER, FOOTER, LOGO, etc.)
  // ============================================================================

  /**
   * Origin for absolute asset URLs. Docs render inside the
   * universal viewer (often `about:blank` / srcdoc), where relative
   * paths can't resolve. We bake the parent origin in at render time
   * so the logo loads regardless of viewer context. Falls back to
   * the production host for headless/server-side renders.
   * @private
   */
  _assetOrigin() {
    try {
      if (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null') {
        return window.location.origin;
      }
    } catch (_) {}
    return 'https://nobigdealwithjoedeal.com';
  },

  /**
   * Inject the signature widget script + supporting CSS into a
   * rendered document HTML. Called by generate() only when
   * data.signers is populated, so templates that never opt in pay
   * zero overhead. The widget script lives at /pro/js/signature-widget.js
   * and is loaded via absolute URL so it works inside the srcdoc
   * iframe (null origin) used by NBDDocViewer.
   * @private
   */
  _injectSignatureAssets(html) {
    if (typeof html !== 'string' || !html.length) return html;
    const scriptSrc = this._assetOrigin() + '/pro/js/signature-widget.js';
    const css =
      '<style id="nbd-sig-styles">' +
      '.nbd-sig-block{margin:0.2in 0 0.4in;padding:0;page-break-inside:avoid;}' +
      '.nbd-sig-label{font-size:11px;font-weight:700;color:#1A3057;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em;}' +
      '.nbd-sig-canvas{display:block;width:100%;height:120px;border:1px dashed #999;border-radius:6px;background:#fafafa;cursor:crosshair;box-sizing:border-box;touch-action:none;}' +
      '.nbd-sig-img{display:block;max-width:100%;height:auto;background:#fff;border-bottom:1px solid #1A3057;padding-bottom:4px;}' +
      '.nbd-sig-controls{margin-top:6px;display:flex;gap:8px;align-items:center;}' +
      '.nbd-sig-controls button{font-size:11px;padding:4px 10px;background:#fff;border:1px solid #ccc;border-radius:4px;cursor:pointer;font-family:inherit;}' +
      '.nbd-sig-controls button:hover{background:#f5f5f5;}' +
      '.nbd-sig-state{font-size:10px;color:#2d7a2d;font-weight:600;margin-left:auto;}' +
      '.nbd-sig-date{margin-top:4px;font-size:10px;color:#666;font-style:italic;}' +
      '.nbd-sig-print-name{margin-top:8px;font-size:10px;color:#666;}' +
      '@media print{.nbd-sig-controls,.nbd-sig-state{display:none!important;}.nbd-sig-canvas{border:1px solid #333;background:#fff;}}' +
      '</style>';
    const scriptTag = '<script src="' + scriptSrc + '" defer></' + 'script>';
    let out = html;
    if (/<\/head>/i.test(out)) {
      out = out.replace(/<\/head>/i, css + '</head>');
    } else if (/<body[^>]*>/i.test(out)) {
      out = out.replace(/<body[^>]*>/i, function (m) { return m + css; });
    } else {
      out = css + out;
    }
    if (/<\/body>/i.test(out)) {
      out = out.replace(/<\/body>/i, scriptTag + '</body>');
    } else {
      out += scriptTag;
    }
    return out;
  },

  /**
   * Resolve the active letterhead identity by merging
   * NBD_COMPANY_PROFILE_DEFAULTS / window._companyProfile overrides
   * on top of the hardcoded NBDDocGen.COMPANY constant. Render
   * helpers (renderHeader, renderFooter, renderCustomerReport) call
   * this so editing Settings → Company Profile → Letterhead updates
   * every template at once. Empty profile fields fall through to the
   * COMPANY defaults so the existing behavior is preserved for reps
   * who never touch the Settings panel.
   * @param {object} data - Merge field data (data.companyProfile preferred)
   * @returns {{name:string,phone:string,email:string,website:string,address:string,license:string,tagline:string}}
   */
  _letterhead(data) {
    const cp = (data && data.companyProfile)
      || (typeof window !== 'undefined' && (window._legal ? window._legal() : window._companyProfile))
      || {};
    const C = this._resolveCompany();
    const pick = (override, fallback) => {
      const o = (override == null ? '' : String(override)).trim();
      return o || fallback || '';
    };
    // Escape the tenant-editable letterhead fields at the source: every consumer
    // (renderHeader/renderFooter/contract header) interpolates them into an
    // <iframe srcdoc> (allow-scripts) via NBDDocViewer, so an unescaped
    // companyProfile value (e.g. businessName '<img src=x onerror=…>') is stored
    // HTML injection. `address` stays raw here — it's escaped at each usage site
    // (it can also come from public lead intake via data.address).
    const esc = (s) => this._escHtml(s);
    return {
      name:    esc(pick(cp.businessName,    C.name)),
      phone:   esc(pick(cp.businessPhone,   C.phone)),
      email:   esc(pick(cp.businessEmail,   C.email)),
      website: esc(pick(cp.businessWebsite, C.website)),
      address: pick(cp.businessAddress, C.address),
      license: esc(pick(cp.businessLicense, '')),
      // NBD keeps the original resolution (cp.tagline — the editable shop-wide
      // marketing tagline — wins). A non-NBD tenant uses ONLY its brand-resolved
      // tagline: cp.tagline falls through the merged-profile DEFAULTS to NBD's
      // "No Big Deal — We've Got You Covered", which printed on every stranger
      // tenant's letterhead/footer (gauntlet gap; same M1 leak already fixed in
      // document-generator-templates.js:889-896 — this mirrors that fix).
      tagline: esc((C.name === 'No Big Deal Home Solutions')
        ? pick(cp.tagline, C.tagline)
        : (C.tagline || ''))
    };
  },

  /**
   * Render NBD logo + textual fallback. The text fallback ships
   * inside the same anchor so if the image fails (offline, CSP) the
   * customer still sees a readable brand mark — no JS error handler
   * needed (strict CSP blocks inline onerror anyway).
   * @private
   * @returns {string} HTML
   */
  renderNBDLogo() {
    // Inline data URI of the REAL company logo (docs/assets/images/nbd-logo.png).
    // Uses <img> instead of <object> because the doc viewer's iframe srcdoc
    // CSP includes `object-src 'none'`, which blocks <object> entirely. The
    // img-src directive allows `data:`, so inline data URIs through <img>
    // work. The actual logo bytes live in nbd-logo-asset.js, which is loaded
    // before any document render and exposes window.NBD_LOGO_DATA_URI.
    const src = this._logoSrc();
    // A logo-less tenant gets NO <img> at all — src="" renders a broken-image
    // box on their paper (_logoSrc deliberately blanks for non-NBD, M1).
    if (!src) return '';
    return `<img class="nbd-logo-img" src="${src}" alt="${this._resolveCompany().name}" />`;
  },

  /**
   * Render branded document header
   * @param {object} data - Header data
   * @returns {string} HTML
   */
  renderHeader(data = {}) {
    const L = this._letterhead(data);
    const address = data.address || L.address;
    // Escape: `address` originates from public lead intake and this header is
    // rendered into an <iframe srcdoc> (allow-scripts) by NBDDocViewer — an
    // unescaped value is stored XSS. Matches the escaped sibling at the
    // proposal title row (this._escHtml(merged.address)).
    const showAddress = address ? ` &middot; ${this._escHtml(address)}` : '';

    return `
      <div class="document-header">
        <div class="header-top">
          <div class="header-logo">
            ${this.renderNBDLogo()}
          </div>
          <div class="header-info">
            ${L.phone ? `<div>${L.phone}</div>` : ''}
            ${L.email ? `<div>${L.email}</div>` : ''}
            ${L.website ? `<div>${L.website}</div>` : ''}
          </div>
        </div>
        <div class="header-company-name">${L.name}</div>
        <div class="header-tagline">${L.tagline}</div>
        <div class="header-contact-row">
          ${[L.phone, L.email, L.website].filter(Boolean).join(' &nbsp;|&nbsp; ')}${showAddress}
        </div>
      </div>
    `;
  },

  /**
   * Render branded document footer
   * @param {object} data - Footer data (pageNumber optional)
   * @returns {string} HTML
   */
  renderFooter(data = {}) {
    const L = this._letterhead(data);
    const pageNum = data.pageNumber || '';
    const pageText = pageNum ? `<span class="footer-page-number">Page ${pageNum}</span>` : '';
    const licenseLine = L.license ? `<div class="footer-license">License #${L.license}</div>` : '';

    return `
      <div class="document-footer">
        <span class="footer-brand">${L.name}</span>
        <div>${[L.phone, L.email, L.website].filter(Boolean).join(' &nbsp;|&nbsp; ')}</div>
        ${licenseLine}
        ${pageText}
        <span class="footer-credit">${L.tagline}</span>
      </div>
    `;
  },

  /**
   * PR3b: fetch this lead's previously-saved signatures (written by
   * onPersistFinalized to leads/{leadId}/signatures/{role}). Returns a
   * { role: pngDataURL } map, or {} on any miss. Best-effort — a fetch
   * failure must never block doc generation.
   */
  async _fetchSavedSignatures(leadId) {
    const out = {};
    try {
      if (!leadId || !window.db || !window.collection || !window.getDocs) return out;
      const snap = await window.getDocs(window.collection(window.db, 'leads', leadId, 'signatures'));
      snap.forEach(d => {
        const v = d.data();
        if (v && v.png) out[d.id] = v.png;
      });
    } catch (e) {
      console.warn('[NBDDocGen] saved-signature fetch failed:', e && e.message);
    }
    return out;
  },

  /**
   * Render signature block with multiple signers
   * @param {array} signers - Array of signer names/titles
   * @returns {string} HTML
   */
  renderSignatureBlock(signers = ['Homeowner', 'Contractor']) {
    // Signers may be strings (legacy: static sig-line + printed label)
    // or config objects (new: interactive canvas widget). Object shape:
    //   { role: 'homeowner', label: 'Homeowner', required: true }
    // When ANY entry is an object we render interactive blocks for the
    // whole set — signature-widget.js (loaded by _injectSignatureAssets)
    // wires up draw/clear/undo and the Finalize postMessage handler.
    const isInteractive = signers.some(s => s && typeof s === 'object');
    let html = '<div class="signature-block">';

    if (isInteractive) {
      const escAttr = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
      ));
      const escRole = v => String(v == null ? '' : v).replace(/[^A-Za-z0-9_\-]/g, '');
      signers.forEach(signer => {
        const isObj = signer && typeof signer === 'object';
        const role = escRole(isObj ? signer.role : String(signer).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
        const label = escAttr(this._deBrandSignerLabel(isObj ? (signer.label || signer.role) : signer));
        const required = isObj ? signer.required !== false : true;
        html += `
          <div class="nbd-sig-block" data-nbd-sig="${role}" data-label="${label}" data-required="${required ? 'true' : 'false'}">
            <div class="nbd-sig-label">${label}${required ? '' : ' <span style="font-weight:400;color:#888;text-transform:none;letter-spacing:0;">(optional)</span>'}</div>
            <canvas class="nbd-sig-canvas"></canvas>
            <div class="nbd-sig-controls">
              <button type="button" data-nbd-sig-action="clear">Clear</button>
              <button type="button" data-nbd-sig-action="undo">Undo last stroke</button>
              <span class="nbd-sig-state"></span>
            </div>
            <div class="nbd-sig-print-name">Print Name &amp; Date</div>
          </div>
        `;
      });
    } else {
      signers.forEach(signer => {
        html += `
          <div class="signature-line">
            <div class="sig-field">
              <div class="sig-underline"></div>
              <div class="sig-label">Signature</div>
            </div>
            <div class="sig-field">
              <div class="sig-underline"></div>
              <div class="sig-label">Date</div>
            </div>
          </div>
          <div style="font-size: 10px; margin-bottom: 0.15in; color: #666;">
            <strong>${this._escHtml(this._deBrandSignerLabel(signer))}</strong>
          </div>
        `;
      });
    }

    html += '</div>';
    return html;
  },

  /**
   * Render photo grid
   * @param {array} photos - Array of photo URLs or null
   * @param {number} columns - Number of columns (2 or 3)
   * @returns {string} HTML
   */
  renderPhotoGrid(photos = [], columns = 2) {
    const colClass = columns === 3 ? 'three-col' : '';
    let html = `<div class="photo-grid ${colClass}">`;

    if (!photos || photos.length === 0) {
      // Empty placeholders
      for (let i = 0; i < 2; i++) {
        html += '<div class="photo-zone">Photo</div>';
      }
    } else {
      photos.forEach(photo => {
        if (photo) {
          html += `<div class="photo-zone has-image"><img src="${photo}" alt="Photo" /></div>`;
        } else {
          html += '<div class="photo-zone">Photo</div>';
        }
      });
    }

    html += '</div>';
    return html;
  },

  /**
   * Render warranty badge and details
   * @param {string} tier - Warranty tier (economy, good, better, best, beyond)
   * @returns {string} HTML
   */
  renderWarrantyBadge(tier = 'better') {
    const cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    const label = (cfg && typeof cfg.tierLabel === 'function')
      ? cfg.tierLabel(tier)
      : ({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' })[tier] || tier;
    const warrantyText = (cfg && typeof cfg.tierWarrantyText === 'function')
      ? cfg.tierWarrantyText(tier)
      : (tier === 'economy'
        ? '1-year workmanship (labor) warranty; the shingle manufacturer\'s standard limited warranty applies. No system warranty.'
        : 'Lifetime workmanship warranty.');
    const mfg = this.MANUFACTURER_COVERAGE[tier] || this.MANUFACTURER_COVERAGE.better;
    // Economy's workmanship is 1 year, not lifetime (2026-10-02).
    const yrs = tier === 'economy'
      ? ((cfg && cfg.TIER_DISPLAY && cfg.TIER_DISPLAY.economy && cfg.TIER_DISPLAY.economy.warranty.workmanshipYears) || 1)
      : 0;
    const work = yrs ? (yrs + '-Year Workmanship') : 'Lifetime Workmanship';

    return `
      <div class="warranty-badge">
        ${label}: ${work} + ${mfg.level} Manufacturer
      </div>
      <div class="warranty-details">
        <div><strong>${work} Warranty + ${mfg.level} Manufacturer Warranty</strong></div>
        <div style="margin-top: 0.08in;">${warrantyText} ${mfg.note}</div>
      </div>
    `;
  },

  /**
   * Workmanship warranty BY JOB TYPE (2026-09-25). A Job Template estimate
   * carries a warrantyKind instead of a tier (NBDCustomerEstimateRows
   * .estimateWarranty), and the doc data builders pass its sentence here as
   * data.workmanshipWarranty. Returns:
   *   null — no job-type warranty on this document: the tier badge above
   *          renders exactly as it always has (roofing, V2, classic, manual);
   *   ''   — this job carries no workmanship warranty (an unticked repair, an
   *          inspection): the Warranty Coverage section is left out entirely
   *          rather than printing a tier's lifetime promise;
   *   text — the sentence to print.
   */
  _jobWarrantyText(data) {
    const t = data && data.workmanshipWarranty;
    return (typeof t === 'string') ? t : null;
  },

  /** The Warranty Coverage body: the job-type sentence, else the tier badge. */
  renderWarrantyFor(data) {
    const text = this._jobWarrantyText(data);
    if (text === null) return this.renderWarrantyBadge(data.warrantyTier);
    const years = Number(data.workmanshipWarrantyYears);
    const headline = (Number.isFinite(years) && years > 0)
      ? years + '-Year Workmanship Warranty'
      : 'Workmanship Warranty';
    return `
      <div class="warranty-badge">
        ${headline}
      </div>
      <div class="warranty-details">
        <div><strong>${headline}</strong></div>
        <div style="margin-top: 0.08in;">${this._escHtml(text)}</div>
      </div>
    `;
  },

  // ============================================================================
  // SECTION 5: DOCUMENT TEMPLATE - PROPOSAL/ESTIMATE
  // ============================================================================

  /**
   * Render Proposal/Estimate document
   * @private
   * @param {object} data - Document data
   * @returns {string} Complete HTML document
   */
  renderProposal(data = {}) {
    const cp = data.companyProfile || (window._legal ? window._legal() : (window.NBD_COMPANY_PROFILE_DEFAULTS || {}));
    // Merge with defaults
    const merged = {
      homeownerName: '',
      address: '',
      date: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      projectDescription: 'Complete roofing system replacement including removal of existing materials, installation of new premium asphalt shingles, underlayment, flashing, and gutters.',
      scopeItems: [
        'Remove existing roofing materials and debris',
        'Install new architectural asphalt shingles',
        'Install premium underlayment and ice/water shield',
        'Install new flashing and ridge vents',
        'Install seamless gutters and downspouts',
        'Final cleanup and debris removal'
      ],
      // No placeholder line items: a roofing proposal must never render
      // fabricated dollar rows that contradict the rep-entered Total Price.
      // generate() synthesizes a single summary line from totalPrice; if none
      // was entered, the itemized table renders empty (the qualitative scope
      // list + TOTAL PROJECT COST still show).
      lineItems: [],
      totalPrice: '',
      warrantyTier: 'better',
      photos: null,
      // Rep-entered "Custom note to homeowner" (DocPreflight key: termsNote).
      // Empty default → the note block is hidden unless the rep typed one.
      termsNote: '',
      ...data
    };

    // Build line items table
    let lineItemsHTML = '<table><thead><tr><th>Item</th><th style="width: 8%;">Qty</th><th style="width: 10%;">Unit</th><th style="width: 12%;">Unit Price</th><th class="price-column" style="width: 12%;">Total</th></tr></thead><tbody>';

    let total = 0;
    const _esc = (s) => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    merged.lineItems.forEach(item => {
      const totalAmount = item.total || (item.qty * item.unitPrice);
      total += totalAmount;
      lineItemsHTML += `
        <tr>
          <td>${_esc(item.description)}</td>
          <td style="text-align: center;">${_esc(item.qty)}</td>
          <td style="text-align: center;">${_esc(item.unit)}</td>
          <td class="price-column">$${Number(item.unitPrice||0).toFixed(2)}</td>
          <td class="price-column">$${Number(totalAmount||0).toFixed(2)}</td>
        </tr>
      `;
    });

    lineItemsHTML += `
      <tr class="total-row">
        <td colspan="4" style="text-align: right; padding-right: 0.1in;">TOTAL PROJECT COST</td>
        <td class="price-column"><span class="total-price">${merged.totalPrice}</span></td>
      </tr>
    </tbody></table>`;

    // Build scope list
    let scopeHTML = '<ul class="scope-list">';
    merged.scopeItems.forEach(item => {
      scopeHTML += `<li>${_esc(item)}</li>`;
    });
    scopeHTML += '</ul>';

    // Rep-entered custom note to the homeowner (DocPreflight key: termsNote).
    // Renders above the standard terms when present; hidden when blank so a
    // skipped field never leaves an empty box. Escaped + newlines → <br/>.
    const repNoteHTML = merged.termsNote
      ? `<div style="font-size: 11px; line-height: 1.5; color: #333; margin-bottom: 12px; padding: 8px 10px; background: #f6f6f6; border-left: 3px solid #d35400;">${this._escHtml(merged.termsNote).replace(/\n/g, '<br/>')}</div>`
      : '';

    // Kentucky insurance jobs (SB 153, 2026-09-27): a signable proposal is a
    // contract entry, so it carries the KRS 367.624 notices, the lien clause
    // and the detachable cancellation forms. "Insurance assignments accepted."
    // never prints (the AOB is retired, 2026-09-27); a saved tenant
    // boilerplate that still carries it is stripped.
    const stat = this._statutoryBlocks(Object.assign({}, data, merged), cp);
    const _J = window.NBDJurisdiction;
    const proposalTerms = _J ? _J.stripAssignmentSentences(cp.paymentTermsProposal) : cp.paymentTermsProposal;

    // Standard terms — all rep-editable via Settings → Company Profile.
    const termsHTML = `
      ${repNoteHTML}
      <div style="font-size: 10px; line-height: 1.4; color: #555;">
        <strong>Payment Terms:</strong> ${(merged.depositPlan && merged.depositPlan.summary) ? this._escHtml(merged.depositPlan.summary) : this._escClause(proposalTerms)}
        <br/><br/>
        <strong>Change Orders:</strong> ${this._escClause(cp.changeOrderClauseShort)}
        <br/><br/>
        <strong>Cancellation Rights:</strong> ${this._escClause(cp.cancellationProposalShort)}
        <br/><br/>
        <strong>Warranty Disclaimer:</strong> ${this._escClause(cp.materialsWarrantyDisclaimer)}
        <br/><br/>
        <strong>Limitation of Liability:</strong> ${this._escClause(cp.limitationOfLiability)}
        ${stat.lien ? `<br/><br/><strong>Mechanic's Liens:</strong> ${this._escHtml(stat.lien)}` : ''}
      </div>
    `;

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${this._docTitleCompany()} - Proposal</title>
        ${this.getSharedCSS()}
        ${stat.css}
      </head>
      <body>
        <div class="print-button-container">
          <button class="print-button" data-dg-action="print">Print / Save as PDF</button>
        </div>

        <div class="document-container">
          ${this.renderHeader(merged)}

          <div class="document-title">Roofing Proposal</div>

          <div class="document-subtitle">
            <div><strong>Prepared for:</strong> ${this._escHtml(merged.homeownerName)}</div>
            <div><strong>Property:</strong> ${this._escHtml(merged.address)}</div>
            <div><strong>Date:</strong> ${merged.date}</div>
          </div>

          <div class="document-content">
            <!-- EXECUTIVE SUMMARY -->
            <div class="section">
              <div class="section-title">Executive Summary</div>
              <div class="summary-text">
                ${this._escHtml(merged.projectDescription)}
              </div>
            </div>

            <!-- SCOPE OF WORK -->
            <div class="section">
              <div class="section-title">Scope of Work</div>
              ${scopeHTML}
            </div>

            <!-- PRICING -->
            <div class="section">
              <div class="section-title">Pricing</div>
              ${lineItemsHTML}
            </div>

            ${this._jobWarrantyText(merged) === '' ? '' : `<!-- WARRANTY -->
            <div class="section">
              <div class="section-title">Warranty Coverage</div>
              ${this.renderWarrantyFor(merged)}
            </div>`}

            <!-- PHOTOS -->
            <div class="section">
              <div class="section-title">Site Documentation</div>
              ${this.renderPhotoGrid(merged.photos, 2)}
            </div>

            <!-- TERMS & CONDITIONS -->
            <div class="section">
              <div class="section-title">Terms & Conditions</div>
              ${termsHTML}
            </div>

            ${stat.notices ? `<!-- KRS 367.624(3) NOTICES — before the signature block -->
            <div class="section">
              <div class="section-title">Important Notices</div>
              ${stat.notices}
            </div>` : ''}

            <!-- ACCEPTANCE -->
            <div class="section">
              <div class="section-title">Acceptance</div>
              ${this.renderSignatureBlock(
                (Array.isArray(data.signers) && data.signers.length)
                  ? data.signers
                  : ['Homeowner', this._repSignerLabel()]
              )}
            </div>
            ${stat.forms}
          </div>

          ${this.affiliateRow ? this.affiliateRow() : ''}
          ${this.renderFooter({ pageNumber: '1' })}
        </div>
      </body>
      </html>
    `;

    return this.mergeFields(html, merged);
  },

  // ============================================================================
  // SECTION 6: DOCUMENT TEMPLATE - ROOFING CONTRACT
  // ============================================================================

  /**
   * Render Roofing Contract document
   * @private
   * @param {object} data - Document data
   * @returns {string} Complete HTML document
   */
  renderContract(data = {}) {
    const cp = data.companyProfile || (window._legal ? window._legal() : (window.NBD_COMPANY_PROFILE_DEFAULTS || {}));
    const merged = {
      homeownerName: '',
      homeownerAddress: '',
      contractorName: this._resolveCompany().name,
      contractorPhone: this._resolveCompany().phone,
      contractPrice: '',
      startDate: 'Upon contract execution',
      estimatedCompletion: '5-7 business days',
      projectDescription: 'Complete roofing system replacement including removal of existing materials, installation of new premium asphalt shingles, underlayment, flashing, and gutters.',
      warrantyTier: 'better',
      paymentSchedule: cp.paymentTermsContract,
      isInsuranceJob: false,
      ...data
    };
    // The contract form supplies `contractPrice`, but the template uses the
    // {{totalPrice}} token — thread it through so a binding contract shows the
    // rep-entered price, never the $0.00 mergeFields placeholder.
    merged.totalPrice = merged.contractPrice || merged.totalPrice || data.total || '';

    // Itemized scope & pricing: the contract collects line items (required in the
    // pre-flight modal) — render them so the binding contract states exactly what
    // it covers, not just a lump-sum price. Built directly (not via {{token}}) so
    // values are _escHtml-escaped here; hidden when the rep entered no items.
    let lineItemsTableHTML = '';
    if (Array.isArray(merged.lineItems) && merged.lineItems.length) {
      const _money = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const rows = merged.lineItems.map((it) => {
        const unitPrice = (it.unitPrice != null ? it.unitPrice : (it.rate != null ? it.rate : it.price)) || 0;
        const total = (it.total != null ? it.total : (Number(it.qty) || 0) * unitPrice) || 0;
        return `<tr>
          <td>${this._escHtml(it.description || it.item)}</td>
          <td style="text-align:center;">${this._escHtml(it.qty != null ? it.qty : '')}</td>
          <td style="text-align:center;">${this._escHtml(it.unit || '')}</td>
          <td style="text-align:right;">${_money(unitPrice)}</td>
          <td style="text-align:right;">${_money(total)}</td>
        </tr>`;
      }).join('');
      lineItemsTableHTML = `
              <div style="margin: 0.1in 0; margin-top: 0.12in;">
                <strong>Itemized Scope &amp; Pricing:</strong>
                <table style="width:100%;border-collapse:collapse;margin-top:0.06in;font-size:10px;">
                  <thead><tr style="border-bottom:1px solid #ccc;">
                    <th style="text-align:left;">Description</th><th>Qty</th><th>Unit</th>
                    <th style="text-align:right;">Unit Price</th><th style="text-align:right;">Total</th>
                  </tr></thead>
                  <tbody>${rows}</tbody>
                </table>
              </div>`;
    }

    // Kentucky SB 153 (2026-09-27). For a Kentucky insurance job — or an
    // insurance job whose state is unknown (fail closed) — the contract
    // carries the contractor's mailing address (KRS 367.624(1)), the two
    // (3)(a)/(3)(b) notices in bold >= 10pt before the signatures, the lien
    // undertaking (367.628(2)(g)) and the detachable NOTICE OF CANCELLATION
    // in duplicate on its own page after them (367.624(4)).
    // The "Insurance Assignment" clause is gone in every state (Jo,
    // 2026-09-27). Every contract prints the plain Payment clause instead
    // (ky-insurance-law.js PAYMENT_CLAUSE) — no assignment, no direction to
    // pay, no co-payee language anywhere.
    const stat = this._statutoryBlocks(Object.assign({}, data, merged), cp);
    const _J = window.NBDJurisdiction;
    const paymentMethodsText = _J ? _J.stripAssignmentSentences(cp.paymentMethodsNoCash) : cp.paymentMethodsNoCash;

    const contractHTML = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${this._docTitleCompany()} - Roofing Contract</title>
        ${this.getSharedCSS()}
        ${stat.css}
      </head>
      <body>
        <div class="print-button-container">
          <button class="print-button" data-dg-action="print">Print / Save as PDF</button>
        </div>

        <div class="document-container">
          ${this.renderHeader(merged)}

          <div class="document-title">Roofing Contract</div>

          <div class="document-content" style="font-size: 10px; line-height: 1.5;">
            <!-- PARTIES -->
            <div class="section">
              <div class="section-title">Parties to Agreement</div>
              <div style="margin: 0.1in 0;">
                <strong>Contractor:</strong> ${merged.contractorName}<br/>
                ${stat.partiesExtra}<strong>Phone:</strong> ${merged.contractorPhone}<br/>
                <strong>Email:</strong> ${this._resolveCompany().email}
              </div>
              <div style="margin: 0.1in 0; margin-top: 0.15in;">
                <strong>Homeowner:</strong> {{homeownerName}}<br/>
                <strong>Property Address:</strong> {{address}}<br/>
                <strong>Phone:</strong> {{phone}}<br/>
                <strong>Email:</strong> {{email}}
              </div>
            </div>

            <!-- PROJECT DETAILS -->
            <div class="section">
              <div class="section-title">Project Details</div>
              <div style="margin: 0.1in 0;">
                <strong>Description of Work:</strong><br/>
                {{projectDescription}}
              </div>
              ${lineItemsTableHTML}
              <div style="margin: 0.1in 0; margin-top: 0.08in;">
                <strong>Contract Price:</strong> {{totalPrice}}<br/>
                <strong>Start Date:</strong> {{startDate}}<br/>
                <strong>Estimated Completion:</strong> {{estimatedCompletion}}
              </div>
            </div>

            <!-- PAYMENT TERMS -->
            <div class="section">
              <div class="section-title">Payment Schedule & Terms</div>
              <div style="margin: 0.1in 0;">
                {{paymentSchedule}}
              </div>
              <div style="margin: 0.1in 0; margin-top: 0.08in; font-size: 9px;">
                ${this._escClause(paymentMethodsText)}
              </div>
            </div>

            ${this._jobWarrantyText(merged) === '' ? '' : `<!-- WARRANTY -->
            <div class="section">
              <div class="section-title">Warranty Coverage</div>
              ${this.renderWarrantyFor(merged)}
            </div>`}

            <!-- CHANGE ORDERS -->
            <div class="section">
              <div class="section-title">Change Orders & Scope Modifications</div>
              <div style="margin: 0.1in 0; font-size: 9px;">
                ${this._escClause(cp.changeOrderClause)}
              </div>
            </div>

            <!-- CANCELLATION CLAUSE -->
            <div class="section">
              <div class="section-title">Cancellation & Rescission Rights</div>
              <div style="margin: 0.1in 0; font-size: 9px;">
                ${this._escClause(cp.cancellationContractClause)}
              </div>
            </div>

            <!-- DISPUTE RESOLUTION -->
            <div class="section">
              <div class="section-title">Dispute Resolution</div>
              <div style="margin: 0.1in 0; font-size: 9px;">
                ${this._escClause(cp.disputeResolutionClause)}
              </div>
            </div>

            ${stat.paymentClause ? `<!-- PAYMENT (every contract; ky-insurance-law.js PAYMENT_CLAUSE) -->
            <div class="section">
              <div class="section-title">Payment</div>
              <div style="margin: 0.1in 0; font-size: 10px;">
                ${this._escHtml(stat.paymentClause)}
              </div>
            </div>` : ''}

            ${stat.lien ? `<!-- MECHANIC'S LIENS — KRS 367.628(2)(g) -->
            <div class="section">
              <div class="section-title">Mechanic's Liens</div>
              <div style="margin: 0.1in 0; font-size: 10px;">
                ${this._escHtml(stat.lien)}
              </div>
            </div>` : ''}

            <!-- ENTIRE AGREEMENT -->
            <div class="section">
              <div class="section-title">Entire Agreement</div>
              <div style="margin: 0.1in 0; font-size: 9px;">
                ${this._escClause(cp.entireAgreementClause)}
              </div>
            </div>

            ${stat.notices ? `<!-- KRS 367.624(3) NOTICES — before the signature block -->
            <div class="section">
              <div class="section-title">Important Notices</div>
              ${stat.notices}
            </div>` : ''}

            <!-- SIGNATURES -->
            <div class="section">
              <div class="section-title">Contract Execution</div>
              <div style="margin-top: 0.15in;">
                ${this.renderSignatureBlock(
                  (Array.isArray(data.signers) && data.signers.length)
                    ? data.signers
                    : ['Homeowner', this._contractorSignerLabel()]
                )}
              </div>
            </div>
            ${stat.forms}
          </div>

          ${this.affiliateRow ? this.affiliateRow() : ''}
          ${this.renderFooter({ pageNumber: '1' })}
        </div>
      </body>
      </html>
    `;

    return this.mergeFields(contractHTML, merged);
  },

  // ============================================================================
  // SECTION 7: DOCUMENT TEMPLATE - INSPECTION REPORT (HOMEOWNER)
  // ============================================================================

  /**
   * Render Inspection Report - Homeowner Version
   * @private
   * @param {object} data - Document data
   * @returns {string} Complete HTML document
   */
  renderInspectionHomeowner(data = {}) {
    const merged = {
      homeownerName: '',
      address: '',
      inspectionDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      // Tenant-aware default: NBD → 'NBD Inspector' (byte-identical); a non-NBD
      // tenant that left the inspector name blank → '<their seal> Inspector',
      // never 'NBD Inspector'. Real data.inspectorName still overrides this.
      inspectorName: this._deBrandSignerLabel('NBD Inspector'),
      // No fabricated assessments/grades/prices: this report renders ONLY what the
      // inspector entered in the pre-flight modal (overallDescription, roof &
      // gutter notes, recommendations note, photos). Blank defaults so a field the
      // rep left empty prints empty, never an invented condition or dollar figure.
      overallDescription: '',
      roofCondition: '',
      gutterCondition: '',
      roofAge: '',
      roofType: '',
      squareFootage: '',
      recommendations: [],
      recommendationsNote: '',
      photos: null,
      ...data
    };

    const urgencyClass = (urgency) => {
      if (urgency === 'Immediate Attention') return 'urgency-immediate';
      if (urgency === 'Monitor') return 'urgency-monitor';
      return 'urgency-good';
    };

    // Recommendations: prefer a structured array if a caller supplies one;
    // otherwise render the rep's free-text recommendations note; otherwise a
    // neutral line. Never the old hardcoded $11,500 / $1,200 / $800 / $300 table.
    let recommendationsHTML;
    if (Array.isArray(merged.recommendations) && merged.recommendations.length) {
      recommendationsHTML = '<table><thead><tr><th>Recommended Repair</th><th>Urgency</th><th style="width: 15%;">Est. Cost</th></tr></thead><tbody>';
      merged.recommendations.forEach(rec => {
        recommendationsHTML += `
        <tr>
          <td>${this._escHtml(rec.item)}</td>
          <td><span class="${urgencyClass(rec.urgency)}">${this._escHtml(rec.urgency)}</span></td>
          <td class="price-column">${this._escHtml(rec.price)}</td>
        </tr>`;
      });
      recommendationsHTML += '</tbody></table>';
    } else if (merged.recommendationsNote) {
      recommendationsHTML = `<div class="summary-text">${this._escHtml(merged.recommendationsNote)}</div>`;
    } else {
      recommendationsHTML = '<div class="summary-text" style="color:#888;">No specific repairs were noted during this inspection.</div>';
    }

    const inspectionHTML = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${this._docTitleCompany()} - Inspection Report</title>
        ${this.getSharedCSS()}
      </head>
      <body>
        <div class="print-button-container">
          <button class="print-button" data-dg-action="print">Print / Save as PDF</button>
        </div>

        <div class="document-container">
          ${this.renderHeader(merged)}

          <div class="document-title">Home Inspection Report</div>

          <div class="document-subtitle">
            <div><strong>Property:</strong> {{address}}</div>
            <div><strong>Homeowner:</strong> {{homeownerName}}</div>
            <div><strong>Inspection Date:</strong> {{inspectionDate}}</div>
            ${merged.roofType ? `<div><strong>Roof Type:</strong> {{roofType}}</div>` : ''}
            ${merged.roofAge ? `<div><strong>Roof Age:</strong> {{roofAge}} years</div>` : ''}
            ${merged.squareFootage ? `<div><strong>Square Footage:</strong> {{squareFootage}} sq ft</div>` : ''}
          </div>

          <div class="document-content" style="font-size: 10px;">
            <!-- OVERALL CONDITION -->
            <div class="section">
              <div class="section-title">Overall Condition</div>
              <div class="summary-text">
                {{overallDescription}}
              </div>
            </div>

            <!-- ROOF CONDITION -->
            ${merged.roofCondition ? `<div class="section">
              <div class="section-title">Roof Assessment</div>
              <div class="summary-text">
                {{roofCondition}}
              </div>
            </div>` : ''}

            <!-- GUTTERS & DRAINAGE -->
            ${merged.gutterCondition ? `<div class="section">
              <div class="section-title">Gutters & Drainage</div>
              <div class="summary-text">
                {{gutterCondition}}
              </div>
            </div>` : ''}

            <!-- INSPECTION PHOTOS -->
            ${this.renderPhotoGrid(Array.isArray(merged.photoUrls) ? merged.photoUrls : (Array.isArray(merged.photos) ? merged.photos.map(p => typeof p === 'string' ? p : (p && p.url)).filter(Boolean) : []), 2)}

            <!-- RECOMMENDATIONS -->
            <div class="section">
              <div class="section-title">Recommended Repairs</div>
              ${recommendationsHTML}
            </div>

            <!-- NEXT STEPS -->
            <div class="section" style="background-color: ${this._resolveCompany().colors.lightGray}; border-left: 3px solid ${this._resolveCompany().colors.primary}; padding: 0.15in;">
              <div class="section-title">Next Steps</div>
              <div class="summary-text">
                Based on this assessment, we recommend immediate attention to the roof and gutters to prevent further water damage. Contact us to schedule a free estimate and discuss financing options for recommended repairs.
              </div>
              <div style="margin-top: 0.1in; font-weight: bold; color: ${this._resolveCompany().colors.primary};">
                ${this._resolveCompany().phone} | ${this._resolveCompany().email}
              </div>
            </div>

            <!-- INSPECTOR INFO -->
            <div class="section">
              <div class="section-title">Inspector Information</div>
              ${this.renderSignatureBlock(
                (Array.isArray(data.signers) && data.signers.length)
                  ? data.signers
                  : ['Certified NBD Inspector']
              )}
            </div>
          </div>

          ${this.affiliateRow ? this.affiliateRow() : ''}
          ${this.renderFooter({ pageNumber: '1' })}
        </div>
      </body>
      </html>
    `;

    return this.mergeFields(inspectionHTML, merged);
  },

  // ============================================================================
  // SECTION 8: DOCUMENT TEMPLATE - INSPECTION REPORT (INSURANCE)
  // ============================================================================

  /**
   * Render Inspection Report - Insurance Version
   * @private
   * @param {object} data - Document data
   * @returns {string} Complete HTML document
   */
  renderInspectionInsurance(data = {}) {
    const cp = data.companyProfile || (window._legal ? window._legal() : (window.NBD_COMPANY_PROFILE_DEFAULTS || {}));
    const merged = {
      claimantName: '',
      // Blank claim defaults — an insurance document must never print a fabricated
      // claim number / date of loss / damage type / damage findings. Render only
      // what the assessor entered in the pre-flight modal.
      claimNumber: '',
      dateOfLoss: '',
      propertyAddress: '',
      inspectionDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
      inspectorName: 'NBD Damage Assessor',
      damageType: '',
      damageNotes: '',
      scopeItems: [],
      estimatedRepairCost: '',
      photos: null,
      // Lead-level override wins; otherwise fall back to the shop-wide
      // company profile.
      codeCycle: data.codeCycle || cp.codeCycle,
      codeJurisdiction: data.codeJurisdiction || cp.codeJurisdiction,
      ...data
    };
    // Re-resolve after spread, in case `data` carried explicit null/empty.
    merged.codeCycle = data.codeCycle || cp.codeCycle;
    merged.codeJurisdiction = data.codeJurisdiction || cp.codeJurisdiction;

    // Restoration scope — render the assessor's scope items (array or newline
    // text); never the old hardcoded 7-item list.
    const _scopeArr = Array.isArray(merged.scopeItems)
      ? merged.scopeItems
      : (merged.scopeItems ? String(merged.scopeItems).split(/\r?\n/) : []);
    const scopeListHTML = _scopeArr.map(s => String(s).trim()).filter(Boolean)
      .map(s => `<li>${this._escHtml(s)}</li>`).join('')
      || '<li style="color:#888;">Restoration scope to be determined.</li>';
    // Real damage photos the assessor selected (never the 6 empty placeholders).
    const _insPhotos = Array.isArray(merged.photoUrls)
      ? merged.photoUrls
      : (Array.isArray(merged.photos) ? merged.photos.map(p => typeof p === 'string' ? p : (p && p.url)).filter(Boolean) : []);

    const insuranceHTML = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${this._docTitleCompany()} - Insurance Claim Report</title>
        ${this.getSharedCSS()}
      </head>
      <body>
        <div class="print-button-container">
          <button class="print-button" data-dg-action="print">Print / Save as PDF</button>
        </div>

        <div class="document-container">
          ${this.renderHeader(merged)}

          <div class="document-title">Insurance Damage Report</div>

          <div class="document-subtitle">
            <div><strong>Claim Number:</strong> {{claimNumber}}</div>
            <div><strong>Date of Loss:</strong> {{dateOfLoss}}</div>
          </div>

          <div class="document-content" style="font-size: 10px; line-height: 1.4;">
            <!-- CLAIMANT INFO -->
            <div class="section">
              <div class="section-title">Claimant & Property Information</div>
              <div style="margin: 0.1in 0;">
                <strong>Claimant Name:</strong> {{claimantName}}<br/>
                <strong>Property Address:</strong> {{address}}<br/>
                <strong>Claim Number:</strong> {{claimNumber}}<br/>
                <strong>Inspection Date:</strong> {{inspectionDate}}
              </div>
            </div>

            <!-- DAMAGE ASSESSMENT -->
            <div class="section">
              <div class="section-title">Damage Assessment & Cause</div>
              <div style="margin: 0.1in 0;">
                ${merged.damageType ? `<strong>Type of Damage:</strong> {{damageType}}<br/>` : ''}
                <strong>Estimated Repair Cost:</strong> {{totalPrice}}
              </div>
              ${merged.damageNotes ? `<div class="summary-text" style="margin-top: 0.1in;">
                {{damageNotes}}
              </div>` : ''}
            </div>

            <!-- PHOTO EVIDENCE -->
            <div class="section">
              <div class="section-title">Photographic Evidence</div>
              ${this.renderPhotoGrid(_insPhotos, 3)}
            </div>

            <!-- SCOPE OF RESTORATION -->
            <div class="section">
              <div class="section-title">Recommended Restoration Scope</div>
              <ul class="scope-list">
                ${scopeListHTML}
              </ul>
            </div>

            <!-- CODE COMPLIANCE -->
            <div class="section">
              <div class="section-title">Code Compliance & Standards</div>
              <div style="font-size: 9px; line-height: 1.4;">
                <strong>Current Code Requirements:</strong> All repairs performed in accordance with ${merged.codeCycle} and ${merged.codeJurisdiction}. Work complies with manufacturer specifications and NRCA guidelines.
              </div>
            </div>

            <!-- RESTORATION CERTIFICATION -->
            <div class="section">
              <div class="section-title">Assessor Certification</div>
              <div style="font-size: 9px; margin: 0.1in 0;">
                I certify that I have personally inspected the subject property and that the damages, measurements, and repair estimates contained in this report are accurate to the best of my knowledge and belief.
              </div>
              ${this.renderSignatureBlock(['Certified NBD Damage Assessor'])}
            </div>
          </div>

          ${this.renderFooter({ pageNumber: '1' })}
        </div>
      </body>
      </html>
    `;

    return this.mergeFields(insuranceHTML, merged);
  },

  // ============================================================================
  // SECTION 9: FILL FORM MODAL
  // ============================================================================

  /**
   * Render and display fill form modal
   * @param {string} documentType - Type of document
   */
  // ═══════════════════════════════════════════════════════════
  // GENERIC DOCUMENT TEMPLATE
  // Professional branded document for any type that doesn't have
  // a dedicated custom render function yet. Covers invoice,
  // warranty, scope of work, change order, etc. Produces a clean
  // printable page with NBD branding, merged field data, and
  // signature blocks.
  // ═══════════════════════════════════════════════════════════
  renderGenericDoc(data = {}) {
    const type = data._documentType || 'document';
    const typeName = this.DOCUMENT_TYPES[type]?.name || type.replace(/_/g, ' ');
    const d = { ...data };
    const name = d.homeownerName || d.customerName || '';
    const addr = d.address || '';
    const date = d.date || new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    const phone = d.phone || '';
    const email = d.email || '';
    const desc = d.projectDescription || d.scopeSummary || d.workDescription || d.notes || '';
    const price = d.totalPrice || d.totalAmount || d.contractPrice || '';

    // TENANCY: this generic/fallback renderer used to hardcode NBD's palette,
    // so ANY tenant whose document fell through to it got NBD-coloured chrome.
    // The registered render* methods in document-generator-templates.js have
    // been tenant-aware since Phase B; this one was missed because no test
    // exercises it. Resolve from the active brand, exactly like they do, and
    // fall back to the NBD base only when a token is genuinely absent.
    const _gc = this._resolveCompany();
    const _gcol = (_gc && _gc.colors) || {};
    const _P = _gcol.primary   || '#1A3057';  // navy — headings, labels
    const _A = _gcol.accent    || '#BD5728';  // accent — rules, badges
    const _INK = _gcol.ink     || '#14181F';  // body copy
    const _G = _gcol.grey      || '#4C4C4D';  // captions, meta
    const _RL = _gcol.rule     || '#DFE2E7';  // hairlines
    const _WSH = _gcol.wash    || '#F6F7F8';  // panel fill

    // Collect all non-empty fields into a data table
    const skipFields = new Set(['_documentType','date','companyName','companyPhone','companyEmail','companyWebsite','companyTagline']);
    const fieldRows = Object.entries(d)
      .filter(([k,v]) => v && !skipFields.has(k) && typeof v === 'string' && v.trim())
      .map(([k,v]) => {
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).replace(/_/g, ' ');
        return `<tr><td style="padding:8px 12px;font-weight:600;color:${_P};white-space:nowrap;width:180px;border-bottom:1px solid #f0f0f0;">${this._escHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">${this._escHtml(String(v).substring(0, 500))}</td></tr>`;
      }).join('');

    const c = this._resolveCompany();
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${typeName} — ${this._escHtml(name || 'NBD Pro')}</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" rel="stylesheet">
<style>
/* NBD DOCUMENT STANDARD (locked 2026-09-07). This generic/server document
   chrome used to be a SECOND visual language — Barlow Condensed over Barlow,
   with the retired palette hardcoded — so a document that fell through to this
   renderer came out looking nothing like the 26 registered types. It now
   matches printCSS() in document-generator-templates.js.
   Every font-family carries a fallback STACK on purpose: neither Montserrat
   nor Lato is a system font, and if the webfont link above is unreachable
   (offline, print, a locked-down network) a bare family name silently renders
   as Times. The stack is what makes the CDN link an enhancement, not a
   dependency. */
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Lato','Segoe UI',Helvetica,Arial,sans-serif;padding:36px;max-width:860px;margin:0 auto;color:${_INK};line-height:1.55;}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:3px solid ${_A};margin-bottom:26px;}
.brand-row{display:flex;align-items:center;gap:12px;}
/* Width-only; height derives from the 1.5:1 source so the white card hugs the artwork. */
.brand-logo{display:block;width:140px;height:auto;background:#fff;border-radius:6px;padding:4px 8px;box-sizing:border-box;}
.brand{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:18px;font-weight:800;text-transform:uppercase;color:${_P};line-height:1.1;}
.badge{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:${_A};border:1px solid ${_A};padding:2px 9px;border-radius:2px;display:inline-block;margin-top:5px;}
.doc-type{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:28px;font-weight:800;text-transform:uppercase;color:${_P};text-align:right;}
.doc-date{font-size:12px;color:${_G};text-align:right;margin-top:4px;}
h2{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:.15em;color:${_P};margin:24px 0 12px;padding-bottom:4px;border-bottom:1px solid ${_RL};}
table{width:100%;border-collapse:collapse;margin-bottom:16px;}
.desc{background:${_WSH};border-left:4px solid ${_A};padding:16px 20px;margin:16px 0;font-size:14px;line-height:1.6;border-radius:0 6px 6px 0;}
.sig-block{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px;padding-top:20px;border-top:2px solid ${_RL};}
.sig-line{border-top:1px solid ${_P};padding-top:6px;font-size:11px;color:${_G};margin-top:50px;}
.footer{margin-top:40px;padding-top:16px;border-top:1px solid ${_RL};display:flex;justify-content:space-between;font-size:10px;color:${_G};}
@media print{body{padding:20px;}@page{margin:1.5cm;size:letter;}}
</style></head><body>
<div class="hdr">
  <div>
    <div class="brand-row">${this._logoSrc() ? `<img class="brand-logo" src="${this._logoSrc()}" alt="${this._resolveCompany().name}"/>` : ''}<div class="brand">${this._resolveCompany().name}</div></div>
    <div class="badge">${typeName}</div>
  </div>
  <div><div class="doc-type">${typeName}</div><div class="doc-date">${date}</div></div>
</div>
${name || addr ? `<h2>Customer Information</h2>
<table>
  ${name ? '<tr><td style="padding:8px 12px;font-weight:600;color:#1A3057;width:180px;border-bottom:1px solid #f0f0f0;">Homeowner</td><td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">' + this._escHtml(name) + '</td></tr>' : ''}
  ${addr ? '<tr><td style="padding:8px 12px;font-weight:600;color:#1A3057;width:180px;border-bottom:1px solid #f0f0f0;">Address</td><td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">' + this._escHtml(addr) + '</td></tr>' : ''}
  ${phone ? '<tr><td style="padding:8px 12px;font-weight:600;color:#1A3057;width:180px;border-bottom:1px solid #f0f0f0;">Phone</td><td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">' + this._escHtml(phone) + '</td></tr>' : ''}
  ${email ? '<tr><td style="padding:8px 12px;font-weight:600;color:#1A3057;width:180px;border-bottom:1px solid #f0f0f0;">Email</td><td style="padding:8px 12px;border-bottom:1px solid #f0f0f0;">' + this._escHtml(email) + '</td></tr>' : ''}
</table>` : ''}
${fieldRows ? '<h2>Details</h2><table>' + fieldRows + '</table>' : ''}
${desc ? '<h2>Description</h2><div class="desc">' + this._escHtml(desc) + '</div>' : ''}
${price ? '<div style="text-align:right;margin:24px 0;"><span style="font-size:12px;color:#666;">Total:</span> <span style="font-family:\'Barlow Condensed\',sans-serif;font-size:32px;font-weight:800;color:var(--orange,#bd5728);">' + (String(price).startsWith('$') ? price : '$' + price) + '</span></div>' : ''}
<div class="sig-block">
  <div><div class="sig-line">Homeowner Signature</div><div style="margin-top:16px;"><div class="sig-line">Date</div></div></div>
  <div><div class="sig-line">Contractor Signature</div><div style="margin-top:16px;"><div class="sig-line">Date</div></div></div>
</div>
<div class="footer"><span>${[c.name, c.phone, c.website].filter(Boolean).join(' · ')}</span><span>Generated by NBD Pro</span></div>
</body></html>`;
  },

  // ═══════════════════════════════════════════════════════════
  // CUSTOMER REPORT TEMPLATE
  // Multi-section, multi-page-friendly project summary for the
  // "Export PDF" button on a customer's portal page. Unlike the
  // single-page contract/invoice templates, this report grows
  // vertically and paginates naturally on print — long activity
  // histories no longer get truncated.
  // ═══════════════════════════════════════════════════════════
  renderCustomerReport(data = {}) {
    const cp = data.companyProfile || (window._legal ? window._legal() : (window.NBD_COMPANY_PROFILE_DEFAULTS || {}));
    const C = this._resolveCompany();
    const L = this._letterhead(data);
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const toDate = (d) => {
      if (!d) return null;
      // A bare 'YYYY-MM-DD' (scheduledDate) is a local calendar day. new Date()
      // would read it as UTC midnight — the evening before, in Eastern time.
      const ymd = typeof d === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
      if (ymd) return new Date(+ymd[1], +ymd[2] - 1, +ymd[3]);
      const dt = d.toDate ? d.toDate() : (d instanceof Date ? d : new Date(d));
      return isNaN(dt.getTime()) ? null : dt;
    };
    const fmtDate = (d) => {
      const dt = toDate(d);
      return dt ? dt.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }) : '—';
    };
    const fmtDateTime = (d) => {
      const dt = toDate(d);
      return dt ? dt.toLocaleString('en-US', { year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '—';
    };
    const fmtMoney = (v) => {
      if (v == null || v === '') return null;
      const n = parseFloat(String(v).replace(/[^0-9.\-]/g,''));
      if (!isFinite(n)) return null;
      return '$' + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    };

    const customer = data.customer || {};
    const project = data.project || {};
    const timeline = Array.isArray(data.timeline) ? data.timeline : [];
    const estimates = Array.isArray(data.estimates) ? data.estimates : [];
    const notes = Array.isArray(data.notes) ? data.notes : [];

    const fullName = customer.name
      || ((customer.firstName || '') + ' ' + (customer.lastName || '')).trim()
      || 'Customer';

    const logoSrc = this._logoSrc();

    const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });

    // 2026-09-15 (Kanban filter unification): was a hand-copied label map
    // (already stopping at 'closed', missing 'collections' added the same
    // day) — window.stageLabel is the canonical labeler (crm-stages.js,
    // exposed by both bootstrap modules); this file is a plain script with
    // no static import of crm-stages.js, so the local map stays ONLY as a
    // fallback for a load order this file can't otherwise guarantee.
    const STAGE_LABELS = {
      new: 'New', contacted: 'Contacted', inspected: 'Inspected',
      claim_filed: 'Claim Filed', adjuster_meeting_scheduled: 'Adjuster Meeting',
      adjuster_inspection_done: 'Adjuster Done', scope_received: 'Scope Received',
      estimate_submitted: 'Estimate Submitted', supplement_requested: 'Supplement Requested',
      supplement_approved: 'Supplement Approved', contract_signed: 'Contract Signed',
      job_created: 'Job Created', permit_pulled: 'Permit Pulled',
      materials_ordered: 'Materials Ordered', materials_delivered: 'Materials Delivered',
      crew_scheduled: 'Crew Scheduled', install_in_progress: 'Installing',
      install_complete: 'Install Complete', final_photos: 'Final Photos',
      deductible_collected: 'Deductible Collected', final_payment: 'Final Payment',
      closed: 'Closed'
    };
    const JOB_TYPE_LABELS = { insurance: 'Insurance', cash: 'Cash', finance: 'Finance', warranty: 'Warranty', service: 'Service' };
    const _stageLabelFor = (k) => (typeof window.stageLabel === 'function' && window.stageLabel(k)) || STAGE_LABELS[k] || k;

    const customerRowsHtml = [
      ['Customer',    fullName],
      ['Address',     customer.address],
      ['Phone',       customer.phone],
      ['Email',       customer.email],
      ['Stage',       customer.stage ? _stageLabelFor(customer.stage) : null],
      ['Lead since',  customer.createdAt ? fmtDate(customer.createdAt) : null]
    ].filter(([k, v]) => v && v !== '—').map(([k, v]) =>
      `<tr><td class="kv-k">${esc(k)}</td><td class="kv-v">${esc(v)}</td></tr>`
    ).join('');

    const projectRowsHtml = [
      ['Job type',          project.jobType ? (JOB_TYPE_LABELS[project.jobType] || project.jobType) : null],
      ['Damage type',       project.damageType],
      ['Insurance carrier', project.insCarrier],
      ['Claim #',           project.claimNumber],
      ['Claim status',      project.claimStatus],
      ['Deductible',        fmtMoney(project.deductible)],
      ['Job value',         fmtMoney(project.jobValue)],
      ['Crew',              project.crew],
      ['Scheduled',         project.scheduledDate ? fmtDate(project.scheduledDate) : null],
      ['Scope of work',     project.scopeOfWork]
    ].filter(([k, v]) => v && v !== '—').map(([k, v]) =>
      `<tr><td class="kv-k">${esc(k)}</td><td class="kv-v">${esc(v)}</td></tr>`
    ).join('');

    const TYPE_BADGE = {
      stage:         { label: 'Stage',    bg: '#dbeafe', fg: '#1a3057' },
      task:          { label: 'Task',     bg: '#fef3c7', fg: '#92400e' },
      document:      { label: 'Document', bg: '#e9d5ff', fg: '#6b21a8' },
      photo:         { label: 'Photo',    bg: '#d1fae5', fg: '#065f46' },
      communication: { label: 'Contact',  bg: '#fee2e2', fg: '#991b1b' },
      note:          { label: 'Note',     bg: '#f3f4f6', fg: '#374151' }
    };
    const timelineRowsHtml = timeline.map(t => {
      const badge = TYPE_BADGE[t.type] || TYPE_BADGE.note;
      return `
        <div class="tl-row">
          <div class="tl-time">${esc(fmtDateTime(t.time))}</div>
          <div class="tl-body">
            <div class="tl-title">
              <span class="tl-badge" style="background:${badge.bg};color:${badge.fg};">${esc(badge.label)}</span>
              <span>${esc(t.title || '')}</span>
            </div>
            ${t.desc ? `<div class="tl-desc">${esc(t.desc)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    const estimateRowsHtml = estimates.map(e => {
      const title = e.title || e.name || 'Estimate';
      const amount = (e.amount != null && e.amount !== '') ? (fmtMoney(e.amount) || 'Draft') : 'Draft';
      const created = e.createdAt ? fmtDate(e.createdAt) : '—';
      const note = e.notes || e.description || '';
      return `
        <tr><td>${esc(title)}</td><td>${esc(created)}</td><td class="num">${esc(amount)}</td></tr>
        ${note ? `<tr class="est-note"><td colspan="3">${esc(note)}</td></tr>` : ''}`;
    }).join('');

    const notesBlocksHtml = notes.map(n => `
      <div class="note-card">
        <div class="note-meta">${esc(n.createdBy || 'Note')} &middot; ${esc(n.createdAt ? fmtDateTime(n.createdAt) : '')}</div>
        <div class="note-body">${esc(n.text || '').replace(/\n/g, '<br>')}</div>
      </div>`).join('');

    const serviceArea = esc(cp.serviceArea || '');
    const tagline = esc(L.tagline);
    const disclaimer = cp.cancellationProposalShort ? esc(cp.cancellationProposalShort) : '';
    const customerRowsFinal = customerRowsHtml || `<tr><td class="kv-k">Customer</td><td class="kv-v">${esc(fullName)}</td></tr>`;

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<title>Customer Report — ${esc(fullName)}</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Barlow:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  html,body{font-family:'Barlow',sans-serif;color:#12223d;background:#f6f6f8;}
  body{padding:24px;}
  .page{max-width:8.5in;margin:0 auto;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.08);border-radius:6px;overflow:hidden;}

  .doc-hdr{background:linear-gradient(180deg,${C.colors.primary} 0%,${C.colors.secondary} 100%);color:#fff;padding:24px 36px 18px 36px;border-bottom:6px solid ${C.colors.accent};}
  .doc-hdr-top{display:flex;justify-content:space-between;align-items:flex-start;gap:24px;}
  .doc-hdr-logo{display:block;width:160px;height:auto;background:#fff;border-radius:8px;padding:6px 10px;box-sizing:border-box;}
  .doc-hdr-contact{font:600 10.5px/1.5 Barlow,sans-serif;text-align:right;color:rgba(255,255,255,.92);letter-spacing:.02em;}
  .doc-hdr-contact > div + div{margin-top:1px;}
  .doc-hdr-co{font-family:'Barlow Condensed',sans-serif;font-weight:800;font-size:20px;letter-spacing:.04em;text-transform:uppercase;margin-top:10px;}
  .doc-hdr-tag{font:italic 400 12px/1.3 Georgia,serif;color:${C.colors.accent};margin-top:2px;}
  .doc-hdr-row{margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.18);font:600 10.5px/1.4 Barlow,sans-serif;color:rgba(255,255,255,.86);letter-spacing:.02em;}

  .doc-title{font-family:'Barlow Condensed',sans-serif;font-weight:800;text-transform:uppercase;letter-spacing:2px;font-size:26px;color:${C.colors.secondary};text-align:center;margin:18px 36px 4px 36px;padding-bottom:10px;border-bottom:3px solid ${C.colors.accent};}
  .doc-sub{text-align:center;color:#666;font:600 11px/1.3 Barlow,sans-serif;letter-spacing:.04em;margin:6px 36px 18px 36px;}

  .section{margin:18px 36px;}
  h2{font-family:'Barlow Condensed',sans-serif;font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.18em;color:${C.colors.accent};margin:0 0 10px 0;padding-bottom:4px;border-bottom:1px solid #eee;}

  table.kv{width:100%;border-collapse:collapse;font-size:12px;}
  table.kv td{padding:7px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;}
  .kv-k{font-weight:600;color:${C.colors.primary};width:160px;white-space:nowrap;}
  .kv-v{color:#12223d;}

  .tl-row{display:flex;gap:14px;padding:10px 12px;border-left:3px solid ${C.colors.accent};background:linear-gradient(90deg,${this._rgba(C.colors.accent, '.05')} 0%,${this._rgba(C.colors.accent, '0')} 60%);border-radius:0 6px 6px 0;margin-bottom:8px;page-break-inside:avoid;break-inside:avoid;}
  .tl-time{font:600 10.5px/1.3 Barlow,sans-serif;color:#666;width:130px;flex:0 0 130px;}
  .tl-body{flex:1;min-width:0;}
  .tl-title{font:700 12px/1.3 Barlow,sans-serif;color:#12223d;display:flex;align-items:center;gap:8px;}
  .tl-badge{font:700 9px/1 Barlow,sans-serif;text-transform:uppercase;letter-spacing:.1em;padding:3px 7px;border-radius:3px;white-space:nowrap;}
  .tl-desc{font:500 11px/1.4 Barlow,sans-serif;color:#555;margin-top:3px;word-wrap:break-word;}
  .tl-empty{font:500 11px/1.4 Barlow,sans-serif;color:#999;font-style:italic;padding:8px 12px;}

  table.est{width:100%;border-collapse:collapse;font-size:12px;}
  table.est thead{background:${C.colors.primary};color:#fff;}
  table.est th,table.est td{padding:8px 10px;text-align:left;border-bottom:1px solid #e5e7eb;}
  table.est th{font:700 10.5px/1.2 Barlow,sans-serif;text-transform:uppercase;letter-spacing:.08em;}
  table.est td.num{text-align:right;font-weight:700;color:${C.colors.accent};font-family:'Barlow Condensed',sans-serif;font-size:14px;}
  table.est tr.est-note td{background:#fafafa;color:#666;font-size:11px;font-style:italic;padding-top:6px;padding-bottom:10px;}

  .note-card{background:#fafbfc;border-left:3px solid ${C.colors.accent};border-radius:0 6px 6px 0;padding:10px 14px;margin-bottom:8px;page-break-inside:avoid;break-inside:avoid;}
  .note-meta{font:600 10px/1.3 Barlow,sans-serif;color:#666;margin-bottom:4px;}
  .note-body{font:500 12px/1.5 Barlow,sans-serif;color:#12223d;word-wrap:break-word;}

  .doc-ftr{margin-top:24px;padding:14px 36px 18px 36px;background:linear-gradient(180deg,${C.colors.secondary} 0%,${C.colors.primary} 100%);color:rgba(255,255,255,.92);border-top:4px solid ${C.colors.accent};text-align:center;font:600 10px/1.5 Barlow,sans-serif;letter-spacing:.04em;}
  .doc-ftr .ftr-brand{display:block;font:800 11px/1.2 Barlow,sans-serif;color:#fff;letter-spacing:.1em;text-transform:uppercase;margin-bottom:3px;}
  .doc-ftr .ftr-disc{display:block;font-size:9px;color:rgba(255,255,255,.7);margin-top:6px;line-height:1.4;font-style:italic;}
  /* Credential badge row — same markup/asset lookup as affiliateRow() in
     document-generator-templates.js (window.NBD_BADGE_ASSETS), re-skinned
     to this template's palette since it doesn't share a stylesheet. */
  .affiliates{display:flex;justify-content:center;align-items:center;gap:14px;flex-wrap:wrap;margin:18px 36px 0 36px;}
  .affiliate{border:1px solid #eee;border-radius:6px;background:#fff;padding:8px 14px;text-align:left;}
  .affiliate-name{font:700 11px/1.3 'Barlow Condensed',sans-serif;color:${C.colors.primary};letter-spacing:.04em;}
  .affiliate-num{font:500 10px Barlow,sans-serif;color:#666;margin-top:2px;}
  .affiliate-badge{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:6px 12px 8px;}
  .affiliate-badge-img{display:block;height:48px;width:auto;}
  .affiliate-badge-num{font:500 10px Barlow,sans-serif;color:#666;margin-top:5px;letter-spacing:.02em;}

  @media print{
    html,body{background:#fff;}
    body{padding:0;}
    .page{max-width:none;margin:0;box-shadow:none;border-radius:0;}
    h2{page-break-after:avoid;break-after:avoid;}
    .tl-row,.note-card{page-break-inside:avoid;break-inside:avoid;}
    @page{size:letter;margin:0.4in;}
  }
</style></head>
<body>
<div class="page">
  <div class="doc-hdr">
    <div class="doc-hdr-top">
      ${logoSrc ? `<img class="doc-hdr-logo" src="${logoSrc}" alt="${esc(L.name)}"/>` : ''}
      <div class="doc-hdr-contact">
        ${L.phone ? `<div>${esc(L.phone)}</div>` : ''}
        ${L.email ? `<div>${esc(L.email)}</div>` : ''}
        ${L.website ? `<div>${esc(L.website)}</div>` : ''}
      </div>
    </div>
    <div class="doc-hdr-co">${esc(L.name)}</div>
    <div class="doc-hdr-tag">${tagline}</div>
    <div class="doc-hdr-row">${[esc(L.phone), esc(L.email), esc(L.website), L.address && esc(L.address), serviceArea].filter(Boolean).join(' &nbsp;|&nbsp; ')}</div>
  </div>

  <div class="doc-title">Customer Report</div>
  <div class="doc-sub">Prepared by ${esc(L.name)} &middot; ${esc(today)}</div>

  <div class="section">
    <h2>Customer</h2>
    <table class="kv"><tbody>${customerRowsFinal}</tbody></table>
  </div>

  ${projectRowsHtml ? `
  <div class="section">
    <h2>Project Details</h2>
    <table class="kv"><tbody>${projectRowsHtml}</tbody></table>
  </div>` : ''}

  <div class="section">
    <h2>Activity Timeline</h2>
    ${timelineRowsHtml || '<div class="tl-empty">No activity recorded yet.</div>'}
  </div>

  ${estimates.length ? `
  <div class="section">
    <h2>Estimates</h2>
    <table class="est">
      <thead><tr><th>Title</th><th>Date</th><th style="text-align:right;">Amount</th></tr></thead>
      <tbody>${estimateRowsHtml}</tbody>
    </table>
  </div>` : ''}

  ${notes.length ? `
  <div class="section">
    <h2>Notes</h2>
    ${notesBlocksHtml}
  </div>` : ''}

  ${this.affiliateRow ? this.affiliateRow() : ''}

  <div class="doc-ftr">
    <span class="ftr-brand">${esc(L.name)}</span>
    <span>${[esc(L.phone), esc(L.email), esc(L.website)].filter(Boolean).join(' &nbsp;|&nbsp; ')}</span>
    ${disclaimer ? `<span class="ftr-disc">${disclaimer}</span>` : ''}
  </div>
</div>
</body></html>`;
  },

  renderFillFormModal(documentType) {
    const fields = this.getFormFieldsForDocumentType(documentType);
    const docName = this.DOCUMENT_TYPES[documentType]?.name || documentType;
    const self = this;

    // Build auto-fill lead selector if leads available
    let leadOptions = '<option value="">— Fill manually —</option>';
    if (window._leads && window._leads.length) {
      window._leads.forEach(l => {
        const name = ((l.firstName||'')+ ' ' + (l.lastName||'')).trim() || 'Unnamed';
        leadOptions += `<option value="${this._escHtml(l.id)}">${this._escHtml(name)} — ${this._escHtml(l.address||'No address')}</option>`;
      });
    }

    // Build form fields
    let fieldsHTML = '';
    fields.forEach(f => {
      const id = 'docgen_' + f.name;
      if (f.type === 'textarea') {
        fieldsHTML += `<div style="margin-bottom:14px;"><label style="display:block;font-weight:600;font-size:13px;margin-bottom:4px;">${f.label}${f.required?'<span style="color:var(--orange,#bd5728);">*</span>':''}</label>
          <textarea id="${id}" rows="3" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;resize:vertical;font-family:inherit;" placeholder="${f.label}"></textarea></div>`;
      } else if (f.type === 'select') {
        const opts = (f.options||[]).map(o => `<option value="${o}"${f.default === o ? ' selected' : ''}>${o.charAt(0).toUpperCase()+o.slice(1)}</option>`).join('');
        fieldsHTML += `<div style="margin-bottom:14px;"><label style="display:block;font-weight:600;font-size:13px;margin-bottom:4px;">${f.label}</label>
          <select id="${id}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;">${opts}</select></div>`;
      } else {
        fieldsHTML += `<div style="margin-bottom:14px;"><label style="display:block;font-weight:600;font-size:13px;margin-bottom:4px;">${f.label}${f.required?'<span style="color:var(--orange,#bd5728);">*</span>':''}</label>
          <input type="text" id="${id}" style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;" placeholder="${f.label}"></div>`;
      }
    });

    const modal = document.createElement('div');
    modal.id = 'docgenFillModal';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:10010;';
    modal.innerHTML = `
      <div style="background:#fff;color:#12223d;border-radius:12px;max-width:600px;width:95%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column;">
        <div style="padding:20px 24px;border-bottom:2px solid #eee;display:flex;justify-content:space-between;align-items:center;">
          <div><div style="font-size:10px;color:#1a3057;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">Generate Document</div>
          <div style="font-size:18px;font-weight:700;color:#12223d;font-family:'Helvetica Neue',Arial,sans-serif;">${docName}</div></div>
          <button data-dg-action="closeFillModal" style="background:none;border:none;font-size:24px;cursor:pointer;color:#999;">&times;</button>
        </div>
        <div style="flex:1;overflow-y:auto;padding:20px 24px;">
          <div style="margin-bottom:16px;">
            <label style="display:block;font-weight:600;font-size:13px;margin-bottom:4px;">Auto-fill from Lead</label>
            <select id="docgen_leadSelect" data-dg-leadselect style="width:100%;padding:10px;border:1px solid #ddd;border-radius:6px;font-size:14px;">${leadOptions}</select>
          </div>
          <div style="border-top:1px solid #eee;padding-top:16px;">${fieldsHTML}</div>
        </div>
        <div style="padding:16px 24px;border-top:2px solid #eee;display:flex;justify-content:flex-end;gap:10px;">
          <button data-dg-action="closeFillModal" style="background:#6c757d;color:#fff;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;">Cancel</button>
          <button data-dg-action="submit" data-dg-id="${documentType}" style="background:var(--orange,#bd5728);color:#fff;border:none;padding:10px 24px;border-radius:6px;cursor:pointer;font-weight:600;">Generate Document</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    // Wave 28: change-delegate for the lead-select (replaces inline onchange).
    const _docgenLeadSelect = modal.querySelector('[data-dg-leadselect]');
    if (_docgenLeadSelect) {
      _docgenLeadSelect.addEventListener('change', (e) => window._docgenAutoFill(e.target.value));
    }

    // Auto-fill handler
    window._docgenAutoFill = function(leadId) {
      if (!leadId || !window._leads) return;
      const lead = window._leads.find(l => l.id === leadId);
      if (!lead) return;
      const fullName = ((lead.firstName||'')+' '+(lead.lastName||'')).trim();
      const map = {
        homeownerName: fullName,
        address: lead.address||'',
        phone: lead.phone||'', homeownerPhone: lead.phone||'',
        email: lead.email||'', homeownerEmail: lead.email||'',
        claimNumber: lead.claimNumber||'',
        policyNumber: lead.policyNumber||'',
        insuranceCompany: lead.insCarrier||lead.insuranceCompany||'',
        totalPrice: lead.jobValue||lead.estimateAmount||'',
        contractPrice: lead.jobValue||lead.estimateAmount||'',
        totalAmount: lead.jobValue||lead.estimateAmount||'',
        originalApproved: lead.estimateAmount||lead.jobValue||'',
        estimatedRepairCost: lead.estimateAmount||lead.jobValue||'',
        projectDescription: lead.scopeOfWork||lead.notes||'',
        scopeSummary: lead.scopeOfWork||lead.notes||'',
        workPerformed: lead.scopeOfWork||lead.notes||'',
        workDescription: lead.scopeOfWork||lead.notes||'',
        projectType: lead.jobType||'',
        dateOfLoss: lead.dateOfLoss||'',
        damageType: lead.damageType||'',
        startDate: lead.scheduledDate||'',
        completionDate: lead.completionDate||'',
        inspectorName: lead.assignedTo||'',
        deductibleAmount: lead.deductibleOrOwedByHO||'',
        notes: lead.notes||'',
        // 2026-09-17: 'better', not 'best' — matches every sibling default
        // in this file. lead.warrantyTier is never written anywhere in this
        // codebase (this fallback modal only runs if DocPreflight's own
        // estimate.tier-sourced field fails to load at all).
        warrantyTier: lead.warrantyTier||'better',
        estimatedTimeline: lead.estimatedTimeline||''
      };
      Object.keys(map).forEach(k => {
        const el = document.getElementById('docgen_'+k);
        if (el && map[k]) el.value = map[k].toString().trim();
      });
    };

    // Submit handler
    window._docgenSubmit = function(type) {
      const data = {};
      const missing = [];
      fields.forEach(f => {
        const el = document.getElementById('docgen_'+f.name);
        if (el) {
          data[f.name] = el.value;
          // The * was decorative: a certificate generated with a blank
          // homeowner or "work performed" line. (Blank hand-fill copies go
          // through the row's separate Blank button, not this form.)
          const empty = f.required && !String(el.value || '').trim();
          el.style.borderColor = empty ? '#dc2626' : '#ddd';
          if (empty) missing.push(f.label);
        }
      });
      if (missing.length) {
        if (typeof window.showToast === 'function') window.showToast('Fill in: ' + missing.join(', '), 'error');
        return;
      }
      // NEW-D2: thread the chosen lead through so generate()'s _leadIdEarly is
      // non-null and the document actually persists to leads/{id}/documents +
      // Storage (and the e-sign hook can arm). The "Auto-fill from Lead" select
      // is not part of `fields`, so without this its value was dropped and
      // "Save to Customer" from the Template Library was a silent no-op.
      const _sel = document.getElementById('docgen_leadSelect');
      if (_sel && _sel.value) data.leadId = _sel.value;
      document.getElementById('docgenFillModal').remove();
      self.generate(type, data);
    };
  },

  /**
   * Get form fields for a document type
   * @private
   * @param {string} type - Document type
   * @returns {array} Field definitions
   */
  // Every tier, cheapest first (five since 2026-10-02) — from the shared
  // config, with an inline copy for a page that didn't load it. The warranty
  // pickers below default to 'good' (their first option before Economy).
  _tierOptions() {
    const cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    return (cfg && Array.isArray(cfg.TIER_ORDER)) ? cfg.TIER_ORDER.slice() : ['economy', 'good', 'better', 'best', 'beyond'];
  },

  getFormFieldsForDocumentType(type) {
    const commonFields = [
      { name: 'homeownerName', label: 'Homeowner Name', required: true },
      { name: 'address', label: 'Property Address', required: true },
      { name: 'phone', label: 'Phone Number', required: false },
      { name: 'email', label: 'Email Address', required: false }
    ];

    const insuranceFields = [
      { name: 'claimNumber', label: 'Claim Number', required: true },
      { name: 'policyNumber', label: 'Policy Number', required: false },
      { name: 'insuranceCompany', label: 'Insurance Company', required: true },
      { name: 'dateOfLoss', label: 'Date of Loss', required: true }
    ];

    const typeSpecificFields = {
      proposal: [
        ...commonFields,
        { name: 'projectDescription', label: 'Project Description', required: true, type: 'textarea' },
        { name: 'totalPrice', label: 'Total Price', required: true },
        { name: 'warrantyTier', label: 'Warranty Tier', required: true, type: 'select', options: this._tierOptions(), default: 'good' }
      ],
      contract: [
        ...commonFields,
        { name: 'contractPrice', label: 'Contract Price', required: true },
        { name: 'projectDescription', label: 'Scope of Work', required: true, type: 'textarea' },
        { name: 'startDate', label: 'Start Date', required: true },
        { name: 'estimatedCompletion', label: 'Estimated Completion', required: true },
        { name: 'warrantyTier', label: 'Warranty Tier', required: true, type: 'select', options: this._tierOptions(), default: 'good' }
      ],
      inspectionHomeowner: [
        ...commonFields,
        { name: 'inspectorName', label: 'Inspector Name', required: true },
        { name: 'overallConditionGrade', label: 'Overall Grade', required: true, type: 'select', options: ['A', 'B', 'C', 'D', 'F'] },
        { name: 'damageType', label: 'Type of Damage', required: false },
        { name: 'projectDescription', label: 'Notes / Findings', required: false, type: 'textarea' }
      ],
      inspectionInsurance: [
        ...commonFields,
        ...insuranceFields,
        { name: 'damageType', label: 'Type of Damage', required: true },
        { name: 'estimatedRepairCost', label: 'Estimated Repair Cost', required: true },
        { name: 'inspectorName', label: 'Inspector Name', required: false }
      ],
      warranty_certificate: [
        ...commonFields,
        { name: 'warrantyTier', label: 'Warranty Tier', required: true, type: 'select', options: this._tierOptions(), default: 'good' },
        { name: 'workPerformed', label: 'Work Performed', required: true, type: 'textarea' },
        { name: 'issueDate', label: 'Issue Date', required: false }
      ],
      supplement_request: [
        ...commonFields,
        ...insuranceFields,
        { name: 'originalApproved', label: 'Original Approved Amount', required: true },
        { name: 'justification', label: 'Justification / Reason', required: true, type: 'textarea' }
      ],
      scope_of_work: [
        ...commonFields,
        { name: 'projectDescription', label: 'Project Description', required: true, type: 'textarea' },
        { name: 'materials', label: 'Material Specifications', required: false, type: 'textarea' },
        { name: 'estimatedTimeline', label: 'Estimated Timeline', required: false },
        { name: 'exclusions', label: 'Exclusions', required: false, type: 'textarea' }
      ],
      work_authorization: [
        ...commonFields,
        { name: 'scopeSummary', label: 'Scope Summary', required: true, type: 'textarea' },
        { name: 'startDate', label: 'Authorized Start Date', required: true },
        { name: 'emergencyContact', label: 'Emergency Contact', required: false },
        { name: 'accessInstructions', label: 'Property Access Instructions', required: false, type: 'textarea' },
        { name: 'isInsurance', label: 'Insurance Job?', required: false, type: 'select', options: ['false', 'true'] },
        { name: 'claimNumber', label: 'Claim Number', required: false },
        { name: 'insuranceCompany', label: 'Insurance Company', required: false }
      ],
      certificate_of_completion: [
        ...commonFields,
        { name: 'scopeSummary', label: 'Work Performed', required: true, type: 'textarea' },
        { name: 'startDate', label: 'Start Date', required: true },
        { name: 'completionDate', label: 'Completion Date', required: true },
        { name: 'inspectorName', label: 'Inspector / Crew Lead', required: false },
        { name: 'warrantyTier', label: 'Warranty Tier', required: false, type: 'select', options: this._tierOptions(), default: 'good' }
      ],
      change_order: [
        ...commonFields,
        { name: 'originalContractNumber', label: 'Original Contract #', required: true },
        { name: 'originalContractDate', label: 'Original Contract Date', required: false },
        { name: 'changeOrderNumber', label: 'Change Order #', required: true },
        { name: 'changesDescription', label: 'Description of Changes', required: true, type: 'textarea' },
        { name: 'originalTotal', label: 'Original Contract Total', required: true },
        { name: 'scheduleImpact', label: 'Schedule Impact', required: false }
      ],
      invoice: [
        ...commonFields,
        { name: 'homeownerPhone', label: 'Homeowner Phone', required: false },
        { name: 'homeownerEmail', label: 'Homeowner Email', required: false },
        { name: 'invoiceNumber', label: 'Invoice Number', required: true },
        { name: 'dueDate', label: 'Due Date', required: false },
        { name: 'totalAmount', label: 'Total Amount', required: true },
        { name: 'taxRate', label: 'Tax Rate (decimal, e.g. 0.06)', required: false },
        { name: 'paymentsReceived', label: 'Payments Already Received', required: false },
        { name: 'claimNumber', label: 'Claim # (if insurance)', required: false },
        { name: 'insuranceCompany', label: 'Insurance Company', required: false },
        { name: 'notes', label: 'Notes', required: false, type: 'textarea' }
      ],
      company_intro: [],
      before_after_report: [
        ...commonFields,
        { name: 'projectType', label: 'Project Type', required: true },
        { name: 'startDate', label: 'Start Date', required: false },
        { name: 'completionDate', label: 'Completion Date', required: false },
        { name: 'workDescription', label: 'Work Description', required: true, type: 'textarea' }
      ],
      financing_options: [
        { name: 'homeownerName', label: 'Homeowner Name', required: false },
        { name: 'totalPrice', label: 'Project Total', required: true }
      ],
      referral_card: [],
      material_delivery: [
        ...commonFields,
        { name: 'deliveryDate', label: 'Delivery Date', required: true },
        { name: 'deliveryTime', label: 'Delivery Window', required: false },
        { name: 'startDate', label: 'Project Start Date', required: false }
      ],
      storm_checklist: [],
      claim_guide: [],
      door_hanger: [],
      neighborhood_mailer: [
        { name: 'neighborhoodName', label: 'Neighborhood Name', required: true },
        { name: 'projectAddress', label: 'Nearby Project Address', required: false }
      ],
      testimonial_sheet: [],
      thank_you: [
        ...commonFields,
        { name: 'projectType', label: 'Project Type', required: true },
        { name: 'completionDate', label: 'Completion Date', required: false }
      ],
      payment_agreement: [
        ...commonFields,
        { name: 'totalAmount', label: 'Total Contract Amount', required: true },
        { name: 'depositAmount', label: 'Deposit Amount', required: false },
        { name: 'depositDue', label: 'Deposit Due', required: false },
        { name: 'progressAmount', label: 'Progress Payment Amount', required: false },
        { name: 'progressDue', label: 'Progress Payment Due', required: false },
        { name: 'finalAmount', label: 'Final Payment Amount', required: false },
        { name: 'finalDue', label: 'Final Payment Due', required: false },
        { name: 'projectDescription', label: 'Project Description', required: false, type: 'textarea' }
      ],
      // Only the address is manual — _attachStormHistory() geocodes it and
      // fetches the NOAA storm history itself once this fill form submits.
      // (The "Auto-fill from Lead" dropdown above already maps `address`
      // from the selected lead, so picking a lead is normally enough.)
      storm_history_report: [
        { name: 'address', label: 'Property Address', required: true }
      ]
    };

    return typeSpecificFields[type] || commonFields;
  }

};

// Export to window
if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.NBDDocGen;
}


// ── CSP-safe delegation for 9 data-dg-action attrs in document-generator.js
//    (close window, print, dismiss fill modal, submit doc gen).
(function () {
  if (_NBD_DG_DELEGATE_BOUND) return;
  _NBD_DG_DELEGATE_BOUND = true;
  document.addEventListener('click', function (ev) {
    const t = ev.target.closest && ev.target.closest('[data-dg-action]');
    if (!t) return;
    const action = t.dataset.dgAction;
    const id = t.dataset.dgId;
    try {
      switch (action) {
        case 'closeWindow':     window.close(); break;
        case 'print':           window.print(); break;
        case 'closeFillModal':  { const m = document.getElementById('docgenFillModal'); if (m) m.remove(); break; }
        case 'submit':          if (typeof window._docgenSubmit === 'function') window._docgenSubmit(id); break;
        default:                console.warn('[doc-generator] no dispatch for', action);
      }
    } catch (e) { console.error('[doc-generator] dispatch ' + action + ' failed:', e); }
  });
})();
