/**
 * NBD Document Generator — Template Library (2026-10-04)
 *
 * Jo, 2026-10-04: "we need to greatly expand templates contracts proposals
 * etc", and yes to lien waivers. This file adds the document types the CRM
 * was missing, in the same system as every other template:
 *
 *   lien_waiver           conditional / unconditional x progress / final,
 *                         Ohio and Kentucky. Mortgage companies ask for one
 *                         before they endorse an insurance check.
 *   right_to_cancel       the 3-business-day home-solicitation notice (FTC
 *                         Cooling-Off Rule + Ohio / Kentucky home solicitation
 *                         sales law), with the completed Notice of
 *                         Cancellation in duplicate; on a Kentucky insurance
 *                         job the KRS 367.624(4) form as well.
 *   material_selection    shingle line/color, drip edge, vents, gutters —
 *                         homeowner signs off before materials are ordered.
 *   proposal_options      a one-page Good-Better-Best comparison from the
 *                         estimate's per-tier prices; the full proposal stays
 *                         renderProposal.
 *   insurance_next_steps  a Kentucky-safe homeowner letter: the homeowner
 *                         deals with their insurer; we document the damage
 *                         and do the repair.
 *
 * Change order, certificate of completion and the per-tier warranty
 * certificate already existed; they were extended in
 * document-generator-templates.js instead of duplicated here.
 *
 * It renders through the templates file's own page / letterhead / footer /
 * signature block and per-render tenant brand (NBDDocGen._tpl), so a library
 * document looks like every other document and never carries another
 * tenant's identity. Styles live in one <style> block per document (no
 * inline style attributes — html2pdf and Print both apply the document's own
 * <style>, and the CRM's inline-style ratchet stays where it is).
 *
 * ATTORNEY REVIEW. The templates that change someone's legal rights — lien
 * waivers, change orders and the cancellation notice — are DRAFTS until Jo's
 * attorney has read them. That is marked in the CRM's template picker ONLY
 * (customer.html tiles + the Create Document modal read
 * NBDDocGen.ATTORNEY_REVIEW_TYPES' twin list), never on the customer's copy:
 * nothing in this file writes the word into a rendered document, and
 * tests/doc-template-library.test.js holds it to that.
 *
 * Kentucky: no "we handle / negotiate the claim", no assignment of benefits,
 * nothing due before the insurer's written decision on a Kentucky insurance
 * job, nothing over $100 to the insured. Jurisdiction comes from
 * ky-insurance-law.js (window.NBDJurisdiction) — the same classifier the
 * contract uses — and the statutory text is that module's, never a copy.
 *
 * Requires: document-generator.js, document-generator-templates.js.
 */
(function () {
  'use strict';
  var DG = window.NBDDocGen;
  if (!DG || !DG._tpl) { console.warn('NBDDocGen library: document-generator-templates.js must load first'); return; }
  var T = DG._tpl;
  var esc = T.esc;

  // ── Picker metadata ──────────────────────────────────────────────────
  // Types whose CRM tile shows "DRAFT — have your attorney review before
  // first use". customer-tasks-ui.js's _DOC_TEMPLATE_CATALOG and the
  // customer.html tiles carry the same list (the tiles are static HTML, the
  // docgen bundle is lazy); the library test pins all three together.
  var ATTORNEY_REVIEW_TYPES = ['lien_waiver', 'change_order', 'right_to_cancel'];
  DG.ATTORNEY_REVIEW_TYPES = ATTORNEY_REVIEW_TYPES.slice();

  var REP = { role: 'rep', label: 'Authorized NBD Representative', required: true };
  var HOMEOWNER = { role: 'homeowner', label: 'Homeowner', required: true };

  Object.assign(DG.DOCUMENT_TYPES, {
    lien_waiver:          { name: 'Lien Waiver',                       template: 'renderLienWaiver',          defaultSigners: [REP] },
    right_to_cancel:      { name: 'Notice of Right to Cancel',         template: 'renderRightToCancel',       defaultSigners: [HOMEOWNER] },
    material_selection:   { name: 'Material & Color Selection',        template: 'renderMaterialSelection',   defaultSigners: [HOMEOWNER, REP] },
    // Phase 3 (flag docAtticAckV1): the acknowledgment and its not-inspected second page, one renderer.
    attic_acknowledgment: { name: 'Attic, Ventilation & Moisture Acknowledgment', template: 'renderAtticAcknowledgment', defaultSigners: [HOMEOWNER, REP] },
    attic_not_inspected:  { name: 'Attic Not Inspected Acknowledgment', template: 'renderAtticAcknowledgment', defaultSigners: [HOMEOWNER, REP] },
    proposal_options:     { name: 'Good-Better-Best Options',          template: 'renderProposalOptions' },
    insurance_next_steps: { name: 'Insurance Job: Scope & Next Steps', template: 'renderInsuranceNextSteps' }
  });
  ATTORNEY_REVIEW_TYPES.forEach(function (t) {
    if (DG.DOCUMENT_TYPES[t]) DG.DOCUMENT_TYPES[t].attorneyReview = true;
  });

  // ── Shared pieces ────────────────────────────────────────────────────
  function J() { return (typeof window !== 'undefined' && window.NBDJurisdiction) || null; }

  // One stylesheet for the library's documents, in the tenant's colours.
  function css(B) {
    return '<style>' +
      '.lib-footer-wrap{display:flow-root;padding-bottom:40px;}' +
      '.lib-h1{text-align:center;font-family:' + B.FD + ';font-size:24px;color:' + B.S + ';margin:22px 0 4px;letter-spacing:.04em;text-transform:uppercase;}' +
      '.lib-sub{text-align:center;color:' + B.G + ';font-size:13px;margin:0 0 20px;}' +
      '.lib-intro{background:' + B.WSH + ';border-left:4px solid ' + B.A + ';padding:14px 18px;border-radius:4px;font-size:14px;margin:0 0 22px;}' +
      '.lib-intro p{margin:0 0 8px;}.lib-intro p:last-child{margin-bottom:0;}' +
      '.lib-kv{display:flex;flex-wrap:wrap;gap:10px 28px;font-size:14px;margin:0;}' +
      '.lib-kv div{min-width:200px;flex:1 1 200px;}' +
      '.lib-kv dt{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:' + B.G + ';margin:0;}' +
      '.lib-kv dd{margin:2px 0 0;font-weight:600;color:' + B.INK + ';}' +
      '.lib-body{font-size:14px;line-height:1.6;}' +
      '.lib-body p{margin:0 0 10px;}' +
      '.lib-legal{font-size:13px;line-height:1.55;color:' + B.INK + ';}' +
      '.lib-legal p{margin:0 0 8px;}' +
      '.lib-strong{font-weight:700;}' +
      '.lib-fine{font-size:11px;color:' + B.G + ';line-height:1.5;}' +
      '.lib-list{margin:0;padding-left:22px;font-size:14px;line-height:1.7;}' +
      '.lib-list li{margin:0 0 6px;}' +
      '.lib-cols{display:flex;flex-wrap:wrap;gap:16px;}' +
      '.lib-col{flex:1 1 240px;min-width:0;border:1px solid ' + B.RL + ';border-radius:6px;padding:14px 16px;}' +
      '.lib-col h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;margin:0 0 8px;}' +
      '.lib-blank{display:inline-block;min-width:180px;border-bottom:1px solid ' + B.INK + ';}' +
      '.lib-table{width:100%;border-collapse:collapse;margin:8px 0;font-size:14px;}' +
      '.lib-table th{background:' + B.P + ';color:#fff;text-align:left;padding:9px 12px;font-family:' + B.FD + ';font-size:11px;text-transform:uppercase;letter-spacing:.06em;}' +
      '.lib-table td{padding:10px 12px;border-bottom:1px solid ' + B.RL + ';vertical-align:top;}' +
      '.lib-table td.lib-item{width:38%;font-weight:600;color:' + B.P + ';}' +
      '.lib-notary{border:1px solid ' + B.RL + ';border-radius:6px;padding:14px 16px;font-size:13px;line-height:2;margin-top:18px;}' +
      '.lib-tiers{display:flex;flex-wrap:wrap;gap:10px;margin:8px 0 14px;}' +
      '.lib-tier{flex:1 1 130px;min-width:0;border:1px solid ' + B.RL + ';border-top:4px solid ' + B.P + ';border-radius:6px;padding:12px 12px 14px;font-size:12px;line-height:1.5;}' +
      '.lib-tier.lib-quoted{border-color:' + B.A + ';border-top-color:' + B.A + ';background:' + B.WSH + ';}' +
      '.lib-tier-name{font-family:' + B.FD + ';font-weight:800;font-size:14px;color:' + B.P + ';text-transform:uppercase;letter-spacing:.06em;}' +
      '.lib-tier-flag{display:inline-block;margin-top:4px;font-size:10px;font-weight:700;color:#fff;background:' + B.A + ';border-radius:10px;padding:2px 8px;letter-spacing:.04em;}' +
      '.lib-tier-price{font-family:' + B.FD + ';font-size:20px;font-weight:800;color:' + B.S + ';margin:8px 0 6px;}' +
      '.lib-tier dt{font-size:9px;text-transform:uppercase;letter-spacing:.06em;color:' + B.G + ';margin-top:8px;}' +
      '.lib-tier dd{margin:2px 0 0;}' +
      '.lib-steps{counter-reset:libstep;list-style:none;padding:0;margin:0;}' +
      '.lib-steps li{counter-increment:libstep;position:relative;padding:0 0 12px 38px;font-size:14px;line-height:1.55;}' +
      '.lib-steps li:before{content:counter(libstep);position:absolute;left:0;top:0;width:26px;height:26px;border-radius:50%;background:' + B.P + ';color:#fff;font-weight:700;font-size:13px;text-align:center;line-height:26px;}' +
      '.lib-mt{margin-top:18px;}' +
      '</style>';
  }

  function kv(rows) {
    return '<dl class="lib-kv">' + rows.filter(function (r) { return r && r[1] !== '' && r[1] != null; })
      .map(function (r) { return '<div><dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd></div>'; }).join('') + '</dl>';
  }

  function blank(v) {
    var s = String(v == null ? '' : v).trim();
    return s ? esc(s) : '<span class="lib-blank">&nbsp;</span>';
  }

  function stateOf(d) {
    var s = String(d.waiverState || d.propertyState || '').toUpperCase();
    if (s === 'OH' || s === 'KY') return s;
    var jur = d.jurisdiction && typeof d.jurisdiction === 'object' ? d.jurisdiction : null;
    if (jur && (jur.state === 'OH' || jur.state === 'KY')) return jur.state;
    var j = J();
    if (j) {
      try {
        var c = j.classify({ address: d.address || d.propertyAddress || '', zip: d.zip || '', state: d.state || '' });
        if (c.state === 'OH' || c.state === 'KY') return c.state;
      } catch (_) { /* unreadable address: no state */ }
    }
    return '';
  }

  function jurisdictionOf(d) {
    try { return (DG._jurisdiction && DG._jurisdiction(d)) || null; } catch (_) { return null; }
  }

  function docNo(suffix, parts) {
    var prefix = (DG._docPrefix ? DG._docPrefix() : 'NBD') + '-' + suffix;
    return DG._seededDocNumber ? DG._seededDocNumber(prefix, parts, 5) : prefix + '-' + String(Date.now()).slice(-5);
  }

  function companyName(B) { return (B.C && B.C.name) || ''; }
  function repLabel(B) { return B.SEAL ? 'Authorized ' + B.SEAL + ' Representative' : 'Authorized Representative'; }

  // ══════════════════════════════════════════════════════════════════
  // LIEN WAIVER
  // ══════════════════════════════════════════════════════════════════
  var WAIVER_KINDS = {
    conditional_progress:   { conditional: true,  final: false, title: 'Conditional Waiver and Release of Lien', sub: 'Progress Payment' },
    unconditional_progress: { conditional: false, final: false, title: 'Unconditional Waiver and Release of Lien', sub: 'Progress Payment' },
    conditional_final:      { conditional: true,  final: true,  title: 'Conditional Waiver and Release of Lien', sub: 'Final Payment' },
    unconditional_final:    { conditional: false, final: true,  title: 'Unconditional Waiver and Release of Lien', sub: 'Final Payment' }
  };
  DG.LIEN_WAIVER_KINDS = Object.keys(WAIVER_KINDS);

  var STATE_LAW = {
    OH: { name: 'Ohio', law: "Ohio's mechanic's lien law (Ohio Revised Code Chapter 1311)" },
    KY: { name: 'Kentucky', law: "Kentucky's mechanic's lien law (Kentucky Revised Statutes Chapter 376)" }
  };

  var PAYERS = {
    homeowner: 'Homeowner',
    insurance: 'Insurance company',
    mortgage: 'Mortgage company'
  };

  DG.renderLienWaiver = function (data) {
    T.refresh();
    var B = T.brand();
    var co = companyName(B);
    var d = Object.assign({ homeownerName: '[Owner Name]', address: '[Property Address]',
      waiverKind: 'conditional_progress', payerType: 'homeowner' }, data);
    var kind = WAIVER_KINDS[d.waiverKind] ? d.waiverKind : 'conditional_progress';
    var k = WAIVER_KINDS[kind];
    var st = stateOf(d);
    var law = STATE_LAW[st];
    var payerType = PAYERS[d.payerType] ? d.payerType : 'homeowner';
    var payerName = String(d.payerName || '').trim()
      || (payerType === 'homeowner' ? d.homeownerName
        : payerType === 'insurance' ? (d.insCarrier || d.insuranceCompany || '')
        : (d.mortgageCompany || ''));
    var amountC = T.toCents(d.amount);
    var amountText = amountC > 0 ? T.centsText(amountC) : '';
    var through = T.longDate(d.throughDate);
    var jur = jurisdictionOf(d);
    var docNumber = docNo('LW', [d.leadId, kind, amountC, d.throughDate, d.checkNumber, d.homeownerName]);

    var amt = amountText ? esc(amountText) : '<span class="lib-blank">&nbsp;</span>';
    var thr = through ? esc(through) : '<span class="lib-blank">&nbsp;</span>';
    var coE = esc(co);

    var body = [];
    if (k.conditional && !k.final) {
      body.push('When ' + coE + ' receives the payment of ' + amt + ' described below, and that payment has cleared, ' + coE +
        ' waives and releases its lien rights for the labor, services and materials it furnished to the property below through ' + thr + '.');
    } else if (!k.conditional && !k.final) {
      body.push(coE + ' has received a progress payment of ' + amt + '. ' + coE +
        ' waives and releases its lien rights for the labor, services and materials it furnished to the property below through ' + thr + '.');
    } else if (k.conditional && k.final) {
      body.push('When ' + coE + ' receives the final payment of ' + amt + ' described below, and that payment has cleared, ' + coE +
        ' waives and releases all of its lien rights for all labor, services and materials it furnished to the property below.');
    } else {
      body.push(coE + ' has received final payment of ' + amt + '. ' + coE +
        ' waives and releases all of its lien rights for all labor, services and materials it furnished to the property below.');
    }
    if (k.conditional) {
      body.push('<span class="lib-strong">This waiver is conditional.</span> It has no effect unless and until ' + coE +
        ' actually receives the payment and the check or other payment clears.');
    } else {
      body.push('<span class="lib-strong">This waiver is unconditional.</span> It takes effect when signed. ' + coE +
        ' signs it only after the payment has been received and has cleared.');
    }
    if (!k.final) {
      body.push('It does not cover work done after ' + thr + ', retainage, extra work or change orders that have not been paid, or the exceptions listed below.');
    }
    body.push(coE + ' confirms that its independent subcontractors and material suppliers have been paid for the work this waiver covers, or will be paid from this payment.');
    body.push('This waiver concerns lien rights under ' + (law ? esc(law.law) : "the mechanic's lien law of the state where the property is located") + '.');
    if (jur && jur.kyInsurance && J() && J().KY_LIEN_CLAUSE) {
      body.push('Kentucky insurance job: ' + esc(J().KY_LIEN_CLAUSE));
    }

    var rows = [
      ['Property owner', d.homeownerName],
      ['Property address', d.address],
      ['Paid by', PAYERS[payerType] + (payerName ? ' — ' + payerName : '')],
      ['Payment amount', amountText || ''],
      ['Check / payment reference no.', d.checkNumber || ''],
      [k.final ? 'Final payment for' : 'Work through', k.final ? 'All work under the contract' : (through || '')]
    ];
    if (payerType === 'mortgage' && d.loanNumber) rows.push(['Mortgage loan no.', d.loanNumber]);
    if (payerType !== 'homeowner' && d.claimNumber) rows.push(['Insurance claim no. (owner\'s)', d.claimNumber]);
    if (st) rows.push(['Property state', law.name]);

    var notary = (d.includeNotary === true || d.includeNotary === 'true') ? (
      '<div class="lib-notary">' +
        'State of <span class="lib-blank">&nbsp;</span> &nbsp; County of <span class="lib-blank">&nbsp;</span><br>' +
        'Signed and sworn to before me on <span class="lib-blank">&nbsp;</span> by <span class="lib-blank">&nbsp;</span>.<br>' +
        'Notary Public <span class="lib-blank">&nbsp;</span> &nbsp; My commission expires <span class="lib-blank">&nbsp;</span>' +
      '</div>') : '';

    return T.page(k.title, css(B) +
      T.letterhead() +
      '<h1 class="lib-h1">' + esc(k.title) + '</h1>' +
      '<p class="lib-sub">' + esc(k.sub) + (law ? ' &middot; ' + esc(law.name) : '') + ' &middot; No. ' + esc(docNumber) + '</p>' +
      '<div class="lib-intro"><p>' + coE + ' has the right to file a lien on this property for the work it has done there. ' +
        'This document gives up that right for the payment shown, on the terms below.</p></div>' +
      '<div class="section"><div class="section-title">Payment</div>' + kv(rows) + '</div>' +
      '<div class="section lib-legal">' + body.map(function (p) { return '<p>' + p + '</p>'; }).join('') + '</div>' +
      '<div class="section"><div class="section-title">Exceptions</div><p class="lib-body">' +
        (d.exceptions ? esc(d.exceptions) : 'None.') + '</p></div>' +
      '<div class="section lib-fine">Signed for ' + coE + ' on the date below. This waiver releases only the lien rights of ' + coE +
        ', and only to the extent stated above.</div>' +
      T.sigBlock([repLabel(B) + ' — ' + co], d) +
      notary +
      T.footer('Lien Waiver No. ' + docNumber)
    );
  };

  // ══════════════════════════════════════════════════════════════════
  // RIGHT TO CANCEL (3-day home solicitation notice)
  // ══════════════════════════════════════════════════════════════════
  // The law names and the "How to cancel" steps live in ky-insurance-law.js
  // (2026-10-04): the same packet is attached to every contract signed in the
  // app, so the wording has one copy.

  DG.renderRightToCancel = function (data) {
    T.refresh();
    var B = T.brand();
    var co = companyName(B);
    var coE = esc(co);
    var d = Object.assign({ homeownerName: '[Homeowner Name]', address: '[Property Address]' }, data);
    var j = J();
    var cp = d.companyProfile || null;
    var tz = j ? j.resolveTimeZone(cp) : 'America/New_York';
    var addr = DG._contractorPhysicalAddress ? DG._contractorPhysicalAddress(cp) : '';
    var txDate = d.contractDate || d.transactionDate || new Date();
    var t = j ? j.toUtcDay(txDate, tz) : null;
    var dateText = (j && t != null) ? j.formatDay(t) : T.longDate(txDate);
    var deadline = (j && t != null) ? j.formatDay(j.addBusinessDays(t, 3)) : '';
    var st = stateOf(d);
    var jur = jurisdictionOf(d);
    var ky = !!(jur && jur.kyInsurance);
    var lawName = j ? j.homeSolicitationLawText(st)
      : 'federal law (the FTC Cooling-Off Rule) and your state’s home solicitation sales law';

    var steps = j ? j.cancelHowToSteps({ sellerName: co, sellerAddress: addr, deadlineText: deadline, strongClass: 'lib-strong' }) : [];

    var kyPart = '';
    if (ky && j) {
      kyPart =
        '<div class="section"><div class="section-title">Kentucky insurance job: a second right to cancel</div>' +
        '<div class="lib-body"><p>Because this work may be paid by your insurance, Kentucky law gives you another right: ' +
        'if your insurer tells you in writing that any part of the work is not covered, you may cancel within five business days ' +
        'of getting that notice. A separate form for that is attached.</p></div>' +
        j.kyNoticesHtml() + '</div>';
    }

    var forms = j
      ? j.STATUTORY_CSS +
        j.ftcCancellationFormsHtml({ transactionDate: txDate, timeZone: tz, sellerName: co, sellerAddress: addr }) +
        (ky ? j.kyCancellationFormsHtml({
          transactionDate: txDate, timeZone: tz, physicalAddress: addr, email: (B.C && B.C.email) || '',
          fax: String((cp && cp.businessFax) || '').trim()
        }) : '')
      : '';

    return T.page('Notice of Right to Cancel', css(B) +
      T.letterhead() +
      '<h1 class="lib-h1">Your Right to Cancel</h1>' +
      '<p class="lib-sub">Contract date: ' + esc(dateText) + '</p>' +
      '<div class="lib-intro"><p>You signed a contract with ' + coE + ' at your home. Under ' + esc(lawName) +
        ', you can cancel it within three business days without any penalty or obligation.</p></div>' +
      '<div class="section">' + kv([
        ['Homeowner', d.homeownerName], ['Property', d.address], ['Contract date', dateText],
        ['Last day to cancel', deadline ? deadline + ' (before midnight)' : '']
      ]) + '</div>' +
      '<div class="section"><div class="section-title">How to cancel</div><ol class="lib-steps">' +
        steps.map(function (s) { return '<li>' + s + '</li>'; }).join('') + '</ol></div>' +
      (j ? j.ftcStatementHtml() : '') +
      // KRS 367.430(2): Kentucky (or unreadable-state) property.
      ((j && j.kyHomeSolicitationApplies && j.kyHomeSolicitationApplies(st)) ? j.kyHomeSolicitationHtml({ sellerName: co, sellerAddress: addr }) : '') +
      kyPart +
      '<div class="section lib-mt"><div class="section-title">Acknowledgment</div>' +
        '<p class="lib-body">I received this notice and two completed copies of the Notice of Cancellation form on ' + esc(dateText) + '.</p></div>' +
      T.sigBlock(['Homeowner'], d) +
      // The shared .footer band carries margin-bottom:-40px so it bleeds to the
      // page edge at the END of a document. Here more pages follow it, and that
      // negative margin pulled the detachable forms' first lines UNDER the band
      // (statutory text hidden on screen). The flow-root wrapper contains the
      // negative margin; the padding gives the forms their own clear space.
      '<div class="lib-footer-wrap">' + T.footer('Notice of Right to Cancel') + '</div>' +
      forms
    );
  };

  // ══════════════════════════════════════════════════════════════════
  // MATERIAL & COLOR SELECTION SHEET
  // ══════════════════════════════════════════════════════════════════
  DG.renderMaterialSelection = function (data) {
    T.refresh();
    var B = T.brand();
    var co = companyName(B);
    var d = Object.assign({ homeownerName: '[Homeowner Name]', address: '[Property Address]' }, data);
    var mfg = T.resolveDocManufacturer(d.estimateLineItems);
    // Only a shingle the estimate actually carries — never the resolver's
    // no-estimate GAF default — prefills the line.
    var fromEstimate = (mfg.manufacturerName && mfg.manufacturerName !== mfg.manufacturer + ' shingles') ? mfg.manufacturerName : '';
    var cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    var tierLabel = d.warrantyTier ? ((cfg && cfg.tierLabel) ? cfg.tierLabel(d.warrantyTier) : TIER_FALLBACK_LABEL[d.warrantyTier] || d.warrantyTier) : '';
    var rows = [
      ['Shingle line', d.shingleLine || fromEstimate],
      ['Shingle color', d.shingleColor],
      ['Underlayment', d.underlayment],
      ['Drip edge (style / color)', d.dripEdge],
      ['Roof vents', d.ventilation],
      ['Gutters (size / style)', d.gutters],
      ['Gutter color', d.gutterColor],
      ['Gutter guards', d.gutterGuards],
      ['Other selections', d.otherSelections]
    ];
    return T.page('Material & Color Selection', css(B) +
      T.letterhead() +
      '<h1 class="lib-h1">Material &amp; Color Selection</h1>' +
      '<p class="lib-sub">' + esc(d.homeownerName) + ' &middot; ' + esc(d.address) + (tierLabel ? ' &middot; ' + esc(tierLabel) + ' package' : '') + '</p>' +
      '<div class="lib-intro"><p>Please check each choice below. We order your materials from this sheet, so what you sign here is what goes on your home.</p>' +
        '<p>If you change a choice after materials are ordered, it may need a written change order and can affect the price and the schedule.</p></div>' +
      '<table class="lib-table"><thead><tr><th>Item</th><th>Your choice</th></tr></thead><tbody>' +
        rows.map(function (r) { return '<tr><td class="lib-item">' + esc(r[0]) + '</td><td>' + blank(r[1]) + '</td></tr>'; }).join('') +
      '</tbody></table>' +
      (d.selectionNotes ? '<div class="section lib-mt"><div class="section-title">Notes</div><p class="lib-body">' + esc(d.selectionNotes) + '</p></div>' : '') +
      '<div class="section lib-mt lib-body"><p>I have reviewed these selections and approve them for ordering.</p></div>' +
      T.sigBlock(['Homeowner', repLabel(B) + ' — ' + co], d) +
      T.affiliateRow() +
      T.footer('Material & Color Selection')
    );
  };

  // ══════════════════════════════════════════════════════════════════
  // GOOD-BETTER-BEST ONE-PAGE COMPARISON
  // ══════════════════════════════════════════════════════════════════
  var TIER_FALLBACK_ORDER = ['economy', 'good', 'better', 'best', 'beyond'];
  var TIER_FALLBACK_LABEL = { economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' };
  // Same five sentences as estimate-config.js tierWarrantyText (doc-preflight
  // keeps the same copy for pages that do not load the config).
  var TIER_FALLBACK_WARRANTY = {
    economy: '1-year written workmanship (labor) warranty; does not transfer on sale of property; the shingle manufacturer\'s standard limited warranty applies; no system warranty.',
    good:    '5-year written workmanship (labor) warranty; does not transfer on sale of property; GAF System Plus warranty included — GAF\'s manufacturer warranty on the GAF shingles and qualifying GAF accessories (GAF terms apply).',
    better:  '10-year written workmanship (labor) warranty; transferable to one subsequent owner within 30 days of sale; GAF System Plus warranty included — GAF\'s manufacturer warranty on the GAF shingles and qualifying GAF accessories (GAF terms apply).',
    best:    '20-year written workmanship (labor) warranty; fully transferable — follows the property through all subsequent owners; annual courtesy inspection included; GAF System Plus warranty included — GAF\'s manufacturer warranty on the GAF shingles and qualifying GAF accessories (GAF terms apply).',
    beyond:  '20-year written workmanship (labor) warranty; fully transferable — follows the property through all subsequent owners; annual courtesy inspection included; plus TAMKO\'s HailGuard hail warranty on the shingles (manufacturer terms apply).'
  };
  var TIER_SHINGLE = {
    economy: 'Economy-grade architectural shingles (never a 3-tab)',
    beyond: 'TAMKO HailGuard shingles'
  };

  DG.renderProposalOptions = function (data) {
    T.refresh();
    var B = T.brand();
    var co = companyName(B);
    var d = Object.assign({ homeownerName: '[Homeowner Name]', address: '[Property Address]' }, data);
    var cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    var order = (cfg && cfg.TIER_ORDER) || TIER_FALLBACK_ORDER;
    var label = function (t) { return (cfg && cfg.tierLabel) ? cfg.tierLabel(t) : (TIER_FALLBACK_LABEL[t] || t); };
    var warranty = function (t) { return (cfg && cfg.tierWarrantyText) ? cfg.tierWarrantyText(t) : (TIER_FALLBACK_WARRANTY[t] || ''); };
    var prices = (d.tierPrices && typeof d.tierPrices === 'object') ? d.tierPrices : {};
    var quoted = String(d.selectedTier || d.warrantyTier || '').toLowerCase();
    var R = (typeof window !== 'undefined') ? window.NBDDepositRule : null;
    var jur = jurisdictionOf(d);
    var insurance = !!(jur && jur.insurance);
    var tiers = order.filter(function (t) { return T.toCents(prices[t]) > 0; });
    // Warranty lines per option (Jo, 2026-10-06): NBD — the NBD Pledge
    // (promise) + the package's written labor years; another company — its
    // OWN sentence or none — and the
    // manufacturer warranty for that package (the quoted option reads the
    // estimate's own shingle + any extended warranty sold; the others name
    // only what the package itself fixes, else "per manufacturer").
    var TR = (typeof window !== 'undefined') ? window.NBDTenantRules : null;
    var tenant = !!(TR && typeof TR.isPlatformTenant === 'function' && TR.isPlatformTenant() === false);
    var lines = function (t) {
      return (TR && typeof TR.warrantyLines === 'function')
        ? TR.warrantyLines({ tier: t, isNbd: !tenant, lineItems: t === quoted ? d.estimateLineItems : [], extendedWarranty: t === quoted ? d.extendedWarranty : null })
        : null;
    };

    var cards = tiers.map(function (t) {
      var c = T.toCents(prices[t]);
      var wl = lines(t);
      var work = tenant ? ((wl && wl.workmanship) || '') : warranty(t);
      var mfg = wl ? String(wl.manufacturer).replace(/^Manufacturer warranty:\s*/, '') : '';
      var due = '';
      if (R && typeof R.fromEstimate === 'function') {
        try {
          var plan = R.fromEstimate({ mode: insurance ? 'insurance' : '', claim: { deductible: d.deductible } },
            { totalCents: c, address: d.address || '', jurisdiction: jur || null, lead: d.lead || window._leadDoc || null });
          if (plan && plan.totalCents > 0) {
            due = plan.label + ': ' + plan.valueText;
            // Ohio ORC 4722.04 (2026-10-11): say what follows the capped deposit.
            if (plan.ohio && plan.ohio.reduced === true && plan.ohio.milestoneCents > 0) {
              due += ', then ' + R.fmtCents(plan.ohio.milestoneCents) + ' when your materials are delivered or work begins';
            }
          }
        } catch (_) { due = ''; }
      }
      return '<div class="lib-tier' + (t === quoted ? ' lib-quoted' : '') + '" data-tier="' + esc(t) + '">' +
        '<div class="lib-tier-name">' + esc(label(t)) + '</div>' +
        (t === quoted ? '<div class="lib-tier-flag">As quoted</div>' : '') +
        '<div class="lib-tier-price">' + esc(T.centsText(c)) + '</div>' +
        '<dl>' +
          (TIER_SHINGLE[t] ? '<dt>Shingles</dt><dd>' + esc(TIER_SHINGLE[t]) + '</dd>' : '') +
          // NBD: the Pledge (a promise) and the package's WRITTEN labor
          // warranty, as separate rows (Jo, 2026-10-06).
          ((!tenant && wl && wl.pledge) ? '<dt>NBD Pledge</dt><dd>' + esc(wl.pledge) + '</dd>' : '') +
          (work ? '<dt>' + (tenant ? 'Workmanship' : 'Written labor warranty') + '</dt><dd>' + esc(work) + '</dd>' : '') +
          (mfg ? '<dt>Manufacturer warranty</dt><dd>' + esc(mfg) + '</dd>' : '') +
          (due ? '<dt>Payment</dt><dd>' + esc(due) + '</dd>' : '') +
        '</dl></div>';
    }).join('');

    return T.page('Your Options', css(B) +
      T.letterhead() +
      '<h1 class="lib-h1">Your Roofing Options</h1>' +
      '<p class="lib-sub">' + esc(d.homeownerName) + ' &middot; ' + esc(d.address) + ' &middot; ' + esc(T.longDate(d.date) || T.today()) + '</p>' +
      '<div class="lib-intro"><p>Every option below covers the same scope of work on your home. They differ in materials and in the warranty that comes with them. Pick the one that fits you — your full proposal has the details.</p></div>' +
      (cards ? '<div class="lib-tiers">' + cards + '</div>'
        : '<p class="lib-body">Option prices appear here once the estimate has been priced for each package.</p>') +
      (d.projectDescription ? '<div class="section"><div class="section-title">Scope (all options)</div><p class="lib-body">' + esc(d.projectDescription) + '</p></div>' : '') +
      '<div class="section lib-body">Option chosen: <span class="lib-blank">&nbsp;</span> &nbsp; Initials: <span class="lib-blank">&nbsp;</span></div>' +
      '<p class="lib-fine">Prices are for the scope in your proposal from ' + esc(co) + '. Manufacturer warranties are the manufacturer’s, on the manufacturer’s terms.</p>' +
      T.affiliateRow() +
      T.footer('Good-Better-Best Options')
    );
  };

  // ══════════════════════════════════════════════════════════════════
  // INSURANCE JOB: SCOPE & NEXT STEPS (homeowner letter)
  // ══════════════════════════════════════════════════════════════════
  // Kentucky-safe by construction (KRS 367.628): the homeowner owns and
  // decides the claim; we inspect, document, estimate, may meet the adjuster
  // AFTER the homeowner has filed, and do the work we are hired for.
  DG.renderInsuranceNextSteps = function (data) {
    T.refresh();
    var B = T.brand();
    var co = companyName(B);
    var coE = esc(co);
    var d = Object.assign({ homeownerName: '[Homeowner Name]', address: '[Property Address]' }, data);
    var jur = jurisdictionOf(d);
    var kentucky = !!(jur && (jur.kentucky || jur.kyInsurance));
    var first = String(d.firstName || '').trim() || String(d.homeownerName || '').split(' ')[0] || '';
    var scope = d.scopeOfWork || d.projectDescription || '';
    var carrier = d.insCarrier || d.insuranceCompany || '';

    var yours = [
      'Report the damage to your insurance company and decide whether to file a claim.',
      'Meet your insurance adjuster, ask your insurer your questions, and read every letter they send you.',
      'Read your insurer’s written decision and decide how you want to go ahead.',
      'Pay your deductible. It is yours to pay, and we will never offer to pay, waive or rebate it.'
    ];
    var ours = [
      'Inspect your roof and photograph the damage we find.',
      'Write a line-item estimate for the repair. You can give our estimate and photos to your insurer yourself.',
      'If you ask us to, meet your adjuster at your home after you have filed, to point out the damage we documented.',
      'If we find more damage once work starts, update our estimate and give it to you.',
      'Do the work you hire us to do, and stand behind it with our written warranty.'
    ];
    var steps = [
      'Call your insurance company to report the damage. Write down your claim number.',
      'Your insurer sends an adjuster to inspect. Tell us the date if you would like us there too.',
      'Your insurer sends you a written decision explaining what it covers.',
      'If you decide to go ahead, you sign a contract with us that shows the price, the work and when payments are due.',
      'We schedule the work, finish it, and walk the job with you.'
    ];

    var kyBlock = kentucky
      ? '<div class="section"><div class="section-title">Kentucky homeowners</div><ul class="lib-list">' +
          '<li>Nothing is due when you sign. Your deductible and your insurer’s first payment become due only after your insurer’s written coverage decision and a 5-business-day cancellation window.</li>' +
          '<li>If your insurer tells you in writing that any part of the work is not covered, you can cancel within 5 business days of getting that notice.</li>' +
          '<li>We will not offer gifts, rebates or referral payments worth more than $100 on an insurance-paid job.</li>' +
          '<li>Your contract never transfers your insurance policy rights or benefits to us.</li>' +
        '</ul></div>'
      : '';

    return T.page('Scope & Next Steps', css(B) +
      T.letterhead() +
      '<h1 class="lib-h1">Your Roof: Scope &amp; Next Steps</h1>' +
      '<p class="lib-sub">' + esc(d.homeownerName) + ' &middot; ' + esc(d.address) + '</p>' +
      '<div class="lib-intro"><p>' + (first ? 'Dear ' + esc(first) + ',' : 'Hello,') + '</p>' +
        '<p>Thank you for having us out. This letter explains what we found, who does what from here, and what happens next. ' +
        'Your insurance claim is between you and your insurance company. Our job is to document the damage, give you an honest estimate, and do the repair if you hire us.</p></div>' +
      (scope ? '<div class="section"><div class="section-title">What we found and recommend</div><p class="lib-body">' + esc(scope) + '</p></div>' : '') +
      (carrier || d.claimNumber || d.dateOfLoss ? '<div class="section">' + kv([
        ['Your insurance company', carrier], ['Your claim number', d.claimNumber || ''], ['Date of loss', T.longDate(d.dateOfLoss || '')]
      ]) + '</div>' : '') +
      '<div class="lib-cols section">' +
        '<div class="lib-col"><h3>You</h3><ul class="lib-list">' + yours.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>' +
        '<div class="lib-col"><h3>' + coE + '</h3><ul class="lib-list">' + ours.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul></div>' +
      '</div>' +
      '<div class="section lib-body"><p>' + coE + ' is a roofing contractor, not a public adjuster. We do not represent you with your insurance company. ' +
        'If you want someone to represent you on your claim, that is a licensed public adjuster or an attorney you choose.</p></div>' +
      '<div class="section"><div class="section-title">What happens next</div><ol class="lib-steps">' +
        steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' +
      kyBlock +
      '<div class="section lib-body"><p>Questions about the roof, the estimate or the schedule? Call or text us any time' +
        ((B.C && B.C.phone) ? ' at ' + esc(B.C.phone) : '') + '.</p></div>' +
      T.affiliateRow() +
      T.footer('Scope & Next Steps')
    );
  };

  // ═════════════════════════════════════════════════════════════════
  // ATTIC, VENTILATION & MOISTURE ACKNOWLEDGMENT (phase 3, flag docAtticAckV1)
  // The wording is attic-ack-text.js (the attorney packet's ATTIC-1 to ATTIC-5, copied by script). The rep's attic
  // record (data.atticCheck) fills the slots. The homeowner's per-line Yes/No and each acknowledgment are REQUIRED
  // tick controls (data-nbd-ack), recorded with the signature: the signing paths here only support signature
  // canvases, so "initials" are implemented as recorded ticks + signature (documented deviation).
  // ═════════════════════════════════════════════════════════════════
  // The form's own CSS is the twinned module's constant (window.NBDAtticAck.ATTIC_FORM_CSS): functions/attic-gate.js accepts this block in a
  // stored form only when it equals it.
  function atticCss() { return '<style>' + window.NBDAtticAck.ATTIC_FORM_CSS + '</style>'; }

  function aaMd(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }

  function atticMoney(cents) { return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function atticLongDate(v) {
    var s = String(v || '').trim();
    if (!s) return '';
    return T.longDate ? (T.longDate(s) || s) : s;
  }

  DG.renderAtticAcknowledgment = function (data) {
    T.refresh();
    var B = T.brand();
    var co = companyName(B);
    var AA = window.NBDAtticAck;
    if (!AA || !AA.TEXT) throw new Error('The attic acknowledgment wording did not load. Reload the page and try again.');
    var X = AA.TEXT;
    var d = Object.assign({ homeownerName: '[Homeowner Name]', address: '[Property Address]' }, data);
    var rec = d.atticCheck && typeof d.atticCheck === 'object' ? d.atticCheck : {};
    var g = (typeof DG._nbdGate === 'function') ? DG._nbdGate() : { isNbd: true };
    var CS = window.NBDClauseSet;
    var cp = d.companyProfile || {};
    var terms = CS && CS.paymentTermsFor ? CS.paymentTermsFor(cp.paymentTerms, g.isNbd) : { atticFreeCheckDays: g.isNbd ? 3 : null };
    var prices = (window.NBD_ESTIMATE_CONFIG && window.NBD_ESTIMATE_CONFIG.atticRecommendationPrices) || {};
    var W = function (s) { return AA.words(s, terms, g.isNbd); };
    var notInspected = rec.status === 'not_inspected';
    var urls = d.atticPhotoUrls && typeof d.atticPhotoUrls === 'object' ? d.atticPhotoUrls : {};
    var photoRow = function (kind) {
      var ps = (Array.isArray(rec.photos) ? rec.photos : []).filter(function (p) { return p && p.kind === kind; });
      if (!ps.length) return '';
      return '<div class="aa-thumbs">' + ps.map(function (p) {
        return urls[p.id] ? '<img src="' + esc(urls[p.id]) + '" alt="Attic photo">' : '<span class="lib-fine">Photo on file (' + esc(p.id) + ')</span> ';
      }).join('') + '</div>';
    };
    var tick = function (id, text, required) {
      return '<label class="aa-row"><input type="checkbox" data-nbd-ack="' + esc(id) + '"' + (required ? ' data-nbd-required="1"' : '') + '><span>' + aaMd(W(text)) + '</span></label>';
    };
    var mark = function (on) { return on ? '[x]' : '[ ]'; };
    var parts = [];
    parts.push(atticCss() + T.letterhead() +
      '<h1 class="lib-h1">Attic, Ventilation &amp; Moisture Acknowledgment</h1>' +
      '<p class="lib-sub">' + esc(d.homeownerName) + ' &middot; ' + esc(d.address) + '</p>' +
      '<p class="aa-ver">' + esc(X.VERSION) + (d.formDate ? ' &middot; ' + esc(atticLongDate(d.formDate)) : '') + '</p>' +
      '<!-- nbd:attic-ack ' + esc(X.VERSION) + ' ' + (notInspected ? 'not_inspected' : 'inspected') + ' -->');
    // ATTIC-1
    parts.push('<div class="section">' + X.WHY.map(function (p) { return '<p class="aa-p">' + aaMd(W(p)) + '</p>'; }).join('') + '</div>');
    if (!notInspected) {
      var on = atticLongDate(rec.inspectedOn) || '______';
      var line = X.INSPECTED.replace('{{date}}', on).replace(/\{\{access point:[^}]*\}\}/, String(rec.accessPoint || '______'));
      parts.push('<div class="section"><p class="aa-p">' + mark(true) + ' ' + aaMd(W(line)) + '</p><p class="aa-p">' + mark(false) + ' ' + aaMd(W(X.NOT_INSPECTED)) + '</p></div>');
      // ATTIC-2: what we saw (the rep's record, with photos)
      var cond = rec.conditions || {};
      parts.push('<div class="section"><p class="aa-p">' + aaMd(W(X.SAW_INTRO)) + '</p>' + X.CONDITIONS.map(function (t, i) {
        var k = AA.CONDITION_KEYS[i];
        var txt = t;
        if (k === 'other') txt = 'Other: ' + (rec.conditionOther ? rec.conditionOther : '______') + '. Notes: ' + (rec.notes ? rec.notes : '______');
        return '<p class="aa-p">' + mark(cond[k] === true) + ' ' + (k === 'other' ? esc(txt) : aaMd(W(txt))) + '</p>' + (cond[k] === true ? photoRow('cond:' + k) : '');
      }).join('') + (photoRow('overview') ? '<p class="aa-note">Overview photos</p>' + photoRow('overview') : '') + '</div>');
      // Ventilation numbers (approximate)
      var v = rec.vent || {};
      var slots = [v.floorSqFt, v.neededArea, v.neededIntake, v.neededExhaust, v.nowIntake, v.nowExhaust, v.manufacturer];
      var si = 0;
      var nums = X.NUMBERS.replace(/\{\{[^}]*\}\}/g, function () { var x = slots[si++]; return x == null || x === '' ? '______' : String(x); });
      ['1/300', '1/150', 'code'].forEach(function (r) {
        var label = r === 'code' ? "[ ] code official's requirement" : '[ ] ' + r;
        nums = nums.replace(label, label.replace('[ ]', mark(v.rule === r)));
      });
      parts.push('<div class="section"><p class="aa-p">' + aaMd(W(nums)) + '</p></div>');
    } else {
      // ATTIC-5: the second page, attic NOT inspected
      var rl = AA.REASON_LINE[rec.reason];
      parts.push('<div class="section"><p class="aa-p">' + aaMd(W(X.NOT_INSPECTED)) + '</p>' +
        X.REASONS.map(function (t, i) {
          var chosen = rl === i;
          var txt = t;
          if (i === 1) txt = t.replace('[ ] yours', (chosen && rec.reason === 'scheduling_homeowner' ? '[x]' : '[ ]') + ' yours').replace("[ ] NBD's", (chosen && rec.reason === 'scheduling_nbd' ? '[x]' : '[ ]') + " NBD's");
          if (i === 5) txt = 'Other: ' + (rec.reasonText ? rec.reasonText : '______');
          return '<p class="aa-p">' + mark(chosen) + ' ' + (i === 5 ? esc(txt) : aaMd(W(txt))) + '</p>';
        }).join('') + (rec.notes ? '<p class="aa-p">Note: ' + esc(rec.notes) + '</p>' : '') + photoRow('access') + '</div>');
    }
    // Recommendations (ATTIC-2): priced lines only; each line has a Yes and a No
    var lines = AA.recommendationLines(rec, terms, prices);
    parts.push('<div class="section"><p class="aa-p">' + aaMd(W(X.RECS_INTRO)) + '</p><table class="lib-table"><thead><tr><th>Recommendation</th><th>Price</th><th class="aa-opt">Yes</th><th class="aa-opt">No</th></tr></thead><tbody>' +
      lines.map(function (l) {
        var nm = 'aa-rec-' + l.id;
        return '<tr><td>' + esc(l.label) + '</td><td>' + (l.priceCents == null ? 'none' : esc(atticMoney(l.priceCents))) + '</td>' +
          '<td class="aa-opt"><input type="radio" name="' + nm + '" data-nbd-ack="rec:' + esc(l.id) + ':yes" aria-label="Yes, add it"></td>' +
          '<td class="aa-opt"><input type="radio" name="' + nm + '" data-nbd-ack="rec:' + esc(l.id) + ':no" aria-label="No, leave it out"></td></tr>';
      }).join('') + '</tbody></table></div>');
    // ATTIC-5 statements, then ATTIC-3 acknowledgments
    var ACK_IDS = ['saw', 'declined', 'existing', 'not_inspection', 'moisture', 'tearoff'];
    var STMT_IDS = ['not_checked', 'offered', 'unseen', 'no_change'];
    if (notInspected) {
      parts.push('<div class="section"><p class="aa-p">' + aaMd(X.STATEMENTS_HEAD) + '</p>' + X.STATEMENTS.map(function (t, i) { return tick('ack:stmt_' + STMT_IDS[i], t, true); }).join('') + '</div>');
    }
    parts.push('<div class="section"><p class="aa-note">Tick each box and each Yes or No. Your ticks are saved with your signature.</p>' +
      X.ACKS.map(function (t, i) { return tick('ack:' + ACK_IDS[i], t, true); }).join('') + '</div>');
    // ATTIC-4: the savings sentence (always prints, not editable per job), then the signatures
    parts.push('<div class="section"><p class="aa-p">' + aaMd(W(X.SAVINGS)) + '</p></div>');
    parts.push(T.sigBlock(['Homeowner', repLabel(B) + ' — ' + co], d));
    parts.push(T.affiliateRow() + T.footer('Attic, Ventilation & Moisture Acknowledgment'));
    return T.page('Attic, Ventilation & Moisture Acknowledgment', parts.join(''));
  };

  // ═════════════════════════════════════════════════════════════════
  // PHASE 5 TEMPLATES (flag docClauseSetV1, default OFF). Registered only while the flag is on (syncPhase5Types), so with it off
  // the picker, DOCUMENT_TYPES, FORM_FIELDS and the pre-flight schemas are exactly what they were. Wording: the clause registry
  // (printed verbatim through NBDClauseSet.textV1) and p5-forms.js TEXT (the drafter's, marked there). Acknowledgments are
  // required recorded ticks (data-nbd-ack), the same mechanism as the attic form; the server verifies them (attic-gate.js).
  // ═════════════════════════════════════════════════════════════════
  var P5_ENTRIES = {
    property_condition: { name: 'Property Condition & Access Acknowledgment', template: 'renderPropertyCondition', defaultSigners: [HOMEOWNER, REP] },
    decking_authorization: { name: 'Hidden Conditions / Decking Authorization', template: 'renderDeckingAuthorization', defaultSigners: [HOMEOWNER, REP] }
  };
  var P5_FIELDS = {
    property_condition: ['homeownerName', 'address', 'walkedOn', 'pcPhotoIds'],
    decking_authorization: ['homeownerName', 'address', 'deckingSheets', 'deckingFoundOn', 'deckingWhere', 'deckingPhotoIds']
  };
  function p5Wanted() {
    var w = typeof window !== 'undefined' ? window : null;
    return !!(w && w.NBDFlags && typeof w.NBDFlags.enabled === 'function' && w.NBDFlags.enabled('docClauseSetV1')
      && w.NBDP5Forms && w.NBDClauseSet && typeof w.NBDClauseSet.textV1 === 'function' && w.NBDClauseText && w.NBDClauseText.CLAUSES);
  }
  DG.syncPhase5Types = function () {
    var on = p5Wanted();
    Object.keys(P5_ENTRIES).forEach(function (t) {
      if (on) { DG.DOCUMENT_TYPES[t] = Object.assign({}, P5_ENTRIES[t]); if (DG.FORM_FIELDS) DG.FORM_FIELDS[t] = P5_FIELDS[t].slice(); }
      else { delete DG.DOCUMENT_TYPES[t]; if (DG.FORM_FIELDS) delete DG.FORM_FIELDS[t]; }
    });
    try { if (window.DocPreflight && typeof window.DocPreflight.syncPhase5 === 'function') window.DocPreflight.syncPhase5(on); } catch (_) { /* the schema side retries at open */ }
    return on;
  };
  DG.syncPhase5Types();
  try { if (typeof window.addEventListener === 'function') window.addEventListener('nbd:flags-loaded', function () { DG.syncPhase5Types(); }); } catch (_) { /* no events */ }

  // The pieces every phase 5 form shares: the party sentence, the registry paragraphs, the signature block.
  function p5Ctx(type, d) {
    var P = window.NBDP5Forms, CS = window.NBDClauseSet;
    if (!P || !CS || !window.NBDClauseText || !window.NBDClauseText.CLAUSES) throw new Error('The form wording did not load. Reload the page and try again.');
    var g = (typeof DG._nbdGate === 'function') ? DG._nbdGate() : { isNbd: true, brand: {} };
    var cp = d.companyProfile || {};
    var party = CS.partyFor(g.brand || {}, g.isNbd);
    var terms = CS.paymentTermsFor(cp.paymentTerms, g.isNbd);
    var st = stateOf(d);
    var o = { state: st, paymentSource: '', terms: terms, party: party,
      facts: { ownerNames: CS.plain(d.homeownerName), propertyAddress: CS.plain(d.address), date: '{{date}}', companyPhone: '' } };
    return { P: P, CS: CS, B: T.brand(), g: g, cp: cp, party: party, terms: terms, state: st, X: P.TEXT, o: o, type: type };
  }
  function p5Paras(c, id) { return c.CS.textV1(id, c.o); }
  function p5Words(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }
  function p5Fill(text, c, d) {
    return String(text).replace(/\{\{contractor\}\}/g, function () { return c.party.nameLine ? c.party.nameLine : '{{contractor}}'; })
      .replace(/\{\{owner\}\}/g, function () { return String(d.homeownerName == null ? '' : d.homeownerName); })
      .replace(/\{\{address\}\}/g, function () { return String(d.address == null ? '' : d.address); });
  }
  function p5Tick(id, html, required) {
    return '<label class="aa-row"><input type="checkbox" data-nbd-ack="' + esc(id) + '"' + (required ? ' data-nbd-required="1"' : '') + '><span>' + html + '</span></label>';
  }
  function p5Sig(c, d) {
    var signers = Array.isArray(d.signers) ? d.signers.filter(Boolean) : [];
    if (signers.length && typeof DG.renderSignatureBlock === 'function') {
      var mapped = signers.map(function (s) {
        return (s && typeof s === 'object' && s.role === 'rep') ? Object.assign({}, s, { label: c.party.signerLabel }) : s;
      });
      return '<div class="section">' + DG.renderSignatureBlock(mapped, { v1party: c.party }) + '</div>';
    }
    return T.sigBlock(['Homeowner', c.party.signerLabel], d);
  }
  function p5Head(c, d, subExtra) {
    var X = c.X;
    return '<style>' + c.P.FORM_CSS + '</style>' + T.letterhead() +
      '<h1 class="lib-h1">' + esc(X.NAMES[c.type]) + '</h1>' +
      '<p class="lib-sub">' + esc(d.homeownerName) + ' &middot; ' + esc(d.address) + (subExtra ? ' &middot; ' + esc(subExtra) : '') + '</p>' +
      '<p class="aa-ver">' + esc(c.P.VERSION) + '</p>' +
      '<div class="section"><p class="aa-p">' + p5Words(p5Fill(X.PARTY, c, d)) + '</p></div>';
  }
  function p5Photos(ids, urls) {
    if (!ids.length) return '';
    return '<div class="aa-thumbs">' + ids.map(function (id) {
      return urls && urls[id] ? '<img src="' + esc(urls[id]) + '" alt="Photo">' : '<span class="lib-fine">Photo on file (' + esc(id) + ')</span> ';
    }).join('') + '</div>';
  }

  // ── 1. PROPERTY CONDITION & ACCESS ACKNOWLEDGMENT ──
  DG.renderPropertyCondition = function (data) {
    T.refresh();
    var d = Object.assign({ homeownerName: '[Homeowner Name]', address: '[Property Address]' }, data);
    var c = p5Ctx('property_condition', d), X = c.X;
    var pc = d.propertyCondition && typeof d.propertyCondition === 'object' ? d.propertyCondition : {};
    var notes = pc.notes && typeof pc.notes === 'object' ? pc.notes : {};
    var urls = (d.propertyPhotoUrls && typeof d.propertyPhotoUrls === 'object') ? d.propertyPhotoUrls : {};
    var photos = Array.isArray(pc.photos) ? pc.photos.filter(function (p) { return p && p.id; }) : [];
    var flat = String(d.pcPhotoIds || '').split(/[,\s]+/).filter(function (s) { return /^[A-Za-z0-9_-]{1,64}$/.test(s); });
    var walked = String(pc.walkedOn || d.walkedOn || '').trim();
    var sch2 = p5Paras(c, 'SCH-2'), disp6 = p5Paras(c, 'DISP-6'), media = p5Paras(c, 'MEDIA-1');
    var mediaLine = media.length ? media[0].split(' [ ]')[0] : '';
    var parts = [];
    parts.push(p5Head(c, d, walked ? 'Walked ' + (T.longDate(walked) || walked) : ''));
    parts.push(c.P.marker('property_condition', 'base', ['SCH-2', 'DISP-6', 'MEDIA-1']));
    parts.push('<div class="section">' + sch2.concat(disp6, mediaLine ? [mediaLine] : []).map(function (p) { return '<p class="aa-p">' + p5Words(p) + '</p>'; }).join('') + '</div>');
    parts.push('<div class="section"><p class="aa-p">' + esc(X.PC_INTRO) + '</p>' + p5Tick('ack:pc_notice', esc(X.PC_NOTICE), true) + '</div>');
    parts.push('<div class="section">' + c.P.PC_KEYS.map(function (k) {
      var note = String(notes[k] != null ? notes[k] : (d['pcNote_' + k] || '')).trim();
      var ph = photos.filter(function (p) { return p.item === k; }).map(function (p) { return p.id; });
      return '<div class="p5-item">' + p5Tick('ack:pc_' + k, '<strong>' + esc(X.PC_ITEMS[k]) + '</strong>', true) +
        '<p class="p5-note">' + esc(note || X.PC_NOTE_NONE) + '</p>' + p5Photos(ph, urls) + '</div>';
    }).join('') + '</div>');
    var other = photos.filter(function (p) { return !p.item || c.P.PC_KEYS.indexOf(p.item) === -1; }).map(function (p) { return p.id; }).concat(flat);
    if (other.length) parts.push('<div class="section"><p class="aa-note">' + esc(X.PC_PHOTOS) + '</p>' + p5Photos(other, urls) + '</div>');
    parts.push('<div class="section"><p class="aa-note">' + esc(X.TICK_NOTE) + '</p></div>');
    parts.push(p5Sig(c, d), T.affiliateRow() + T.footer(X.NAMES.property_condition));
    return T.page(X.NAMES.property_condition, parts.join(''));
  };

  // ── 2. HIDDEN CONDITIONS / DECKING AUTHORIZATION ──
  // The per-sheet price is paymentTerms.deckingPerSheetCents (NBD's own default is none): unset or 0 prints the {{token}} and the send check
  // refuses. More sheets than CO-2 allows without a change order prints a [Needs A Change Order] marker, which the send check also refuses.
  DG.renderDeckingAuthorization = function (data) {
    T.refresh();
    var d = Object.assign({ homeownerName: '[Homeowner Name]', address: '[Property Address]' }, data);
    var c = p5Ctx('decking_authorization', d), X = c.X;
    var priceOk = c.CS.numOk(c.terms.deckingPerSheetCents, 'deckingPerSheetCents') && Number(c.terms.deckingPerSheetCents) > 0;
    if (!priceOk) { c.terms = Object.assign({}, c.terms, { deckingPerSheetCents: null }); c.o.terms = c.terms; }
    var perSheet = priceOk ? Number(c.terms.deckingPerSheetCents) : 0;
    var limit = c.CS.numOk(c.terms.deckingSheetsBeforeChangeOrder, 'deckingSheetsBeforeChangeOrder') ? Number(c.terms.deckingSheetsBeforeChangeOrder) : null;
    var n = Number(d.deckingSheets);
    var haveN = isFinite(n) && n > 0 && Math.floor(n) === n;
    var over = haveN && limit != null && n > limit;
    var sheetsCell = !haveN ? '[Number Of Sheets]' : (over ? '[Needs A Change Order]' : String(n));
    var priceCell = priceOk ? T.centsText(perSheet) : '{{deckingPerSheetCents}}';
    var totalCell = (haveN && !over && priceOk) ? T.centsText(n * perSheet) : (!priceOk ? '{{deckingPerSheetCents}}' : sheetsCell);
    var urls = (d.deckingPhotoUrls && typeof d.deckingPhotoUrls === 'object') ? d.deckingPhotoUrls : {};
    var ids = (Array.isArray(d.deckingPhotos) ? d.deckingPhotos : []).map(function (p) { return p && typeof p === 'object' ? p.id : p; })
      .concat(String(d.deckingPhotoIds || '').split(/[,\s]+/)).filter(function (s) { return typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s); });
    var found = String(d.deckingFoundOn || '').trim();
    var where = String(d.deckingWhere || '').trim();
    var kvRow = function (k, v) { return '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>'; };
    var parts = [];
    parts.push(p5Head(c, d, found ? 'Found ' + (T.longDate(found) || found) : ''));
    parts.push(c.P.marker('decking_authorization', 'base', ['CO-2']));
    parts.push('<div class="section">' + p5Paras(c, 'CO-2').map(function (p) { return '<p class="aa-p">' + p5Words(p) + '</p>'; }).join('') + '</div>');
    parts.push('<div class="section"><p class="aa-p">' + esc(X.DK_INTRO) + '</p><dl class="p5-kv">' +
      (found ? kvRow(X.DK_FOUND, T.longDate(found) || found) : '') + (where ? kvRow(X.DK_WHERE, where) : '') +
      kvRow(X.DK_SHEETS, sheetsCell) + kvRow(X.DK_PRICE, priceCell) + kvRow(X.DK_TOTAL, totalCell) + '</dl>' +
      (ids.length ? '<p class="aa-note">' + esc(X.DK_PHOTOS) + '</p>' + p5Photos(ids, urls) : '') + '</div>');
    parts.push('<div class="section">' + p5Tick('ack:decking_read', esc(X.DK_READ), true) +
      '<label class="aa-row"><input type="radio" name="p5-decking" data-nbd-ack="rec:decking:yes" aria-label="Approve"><span>' + esc(X.DK_YES) + '</span></label>' +
      '<label class="aa-row"><input type="radio" name="p5-decking" data-nbd-ack="rec:decking:no" aria-label="Decline"><span>' + esc(X.DK_NO) + '</span></label>' +
      '<p class="aa-note">' + esc(X.TICK_NOTE_LINE) + '</p></div>');
    parts.push(p5Sig(c, d), T.affiliateRow() + T.footer(X.NAMES.decking_authorization));
    return T.page(X.NAMES.decking_authorization, parts.join(''));
  };

  // Brand refresh is done inside each renderer (T.refresh()), so these are
  // tenant-aware without the templates file's wrapping loop.
  if (DG.FORM_FIELDS) {
    Object.assign(DG.FORM_FIELDS, {
      lien_waiver: ['homeownerName', 'address', 'waiverKind', 'payerType', 'payerName', 'amount', 'throughDate', 'checkNumber'],
      right_to_cancel: ['homeownerName', 'address', 'contractDate'],
      material_selection: ['homeownerName', 'address', 'shingleLine', 'shingleColor', 'dripEdge', 'ventilation', 'gutters', 'gutterColor'],
      attic_acknowledgment: ['homeownerName', 'address'],
      attic_not_inspected: ['homeownerName', 'address'],
      proposal_options: ['homeownerName', 'address'],
      insurance_next_steps: ['homeownerName', 'address', 'scopeOfWork']
    });
  }
})();
