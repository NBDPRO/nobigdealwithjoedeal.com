/**
 * NBD Document Generator - Extended Templates
 * Adds 11 additional document types to window.NBDDocGen
 * Requires: document-generator.js loaded first
 */
(function() {
  'use strict';
  const DG = window.NBDDocGen;
  if (!DG) { console.warn('NBDDocGen: document-generator.js must load first'); return; }

  // ── Manufacturer resolver ──────────────────────────────────────────────
  // Saved estimate line items carry the catalog CODE (e.g. RFG 240-TAMKO-HAIL),
  // not a manufacturer field — so generated docs detect the shingle manufacturer
  // from the dominant shingle line's code/name. Defaults to GAF for backward
  // compatibility (old estimates, or leads with no estimate). Gold-safe: emits
  // product/warranty names only, NEVER an installer-certification claim.
  function resolveDocManufacturer(lineItems) {
    const items = Array.isArray(lineItems) ? lineItems : [];
    const shingle = items.find(function (li) {
      const s = String((li && (li.code || li.name)) || '').toUpperCase();
      return /RFG\s*240|RFG\s*ARM|SHINGLE|TIMBERLINE|TAMKO|HAILGUARD|TITAN|STORMFIGHTER|HERITAGE|DURATION|LANDMARK/.test(s);
    });
    const key = String((shingle && (shingle.code + ' ' + (shingle.name || ''))) || '').toUpperCase();
    let manufacturer = 'GAF';
    let warranty = 'the GAF Timberline limited manufacturer shingle warranty';
    if (/TAMKO/.test(key)) {
      manufacturer = 'TAMKO';
      if (/HAIL/.test(key)) {
        warranty = 'the TAMKO HailGuard Limited System Warranty — a 10-year non-prorated Full Start period plus a 7-year hail warranty (requires TAMKO Synthetic Guard and Moisture Guard)';
      } else if (/TITAN|SFFLEX|STORMFIGHTER/.test(key)) {
        warranty = 'the TAMKO Limited Lifetime shingle warranty (single-family), with 160 mph wind coverage when installed with TAMKO starter and hip & ridge';
      } else {
        warranty = 'the TAMKO Limited Lifetime shingle warranty (single-family)';
      }
    }
    // Short bullet form (for the server warranty.hbs feature grid). Empty for
    // GAF so the template keeps its existing GAF default bullet.
    let feature = '';
    if (manufacturer === 'TAMKO') {
      feature = /HAIL/.test(key)
        ? 'TAMKO HailGuard hail warranty — 10-yr Full Start + 7-yr hail'
        : 'TAMKO Limited Lifetime manufacturer shingle warranty';
    }
    return {
      manufacturer: manufacturer,
      manufacturerName: (shingle && shingle.name) || (manufacturer + ' shingles'),
      manufacturerWarranty: warranty,
      manufacturerWarrantyFeature: feature,
    };
  }
  DG.resolveDocManufacturer = resolveDocManufacturer;

  // Phase B (tenant brand): refreshed per-render by _refreshBrand() (wrapped
  // onto every render* method below) from DG._resolveCompany()/_logoSrc().
  // NBD resolves to these same values → byte-identical.
  let C = DG.COMPANY || {
    name: 'No Big Deal Home Solutions', phone: '(859) 420-7382',
    email: 'info@nobigdealwithjoedeal.com', website: 'nobigdealwithjoedeal.com',
    colors: { primary: '#1A3057', secondary: '#12223D', accent: '#BD5728' }
  };
  // NBD DOCUMENT STANDARD, locked 2026-09-07 — measured off the logo artwork.
  let P = C.colors?.primary || '#1A3057';   // Navy — headers, borders, structure
  let S = C.colors?.secondary || '#12223D'; // Navy-deep — gradients, dark bars
  let A = C.colors?.accent || '#BD5728';    // Orange — the one accent
  let G = C.colors?.grey || '#4C4C4D';      // Captions, labels, sublines
  let RL = C.colors?.rule || '#DFE2E7';     // Hairlines, borders
  let WSH = C.colors?.wash || '#F6F7F8';    // Zebra rows, panel fills
  let INK = C.colors?.ink || '#14181F';     // Body copy
  // Document faces. These read brand.fonts.docDisplay/docBody, which existed in
  // company-profile.js but were consumed nowhere until now. Fallback stacks are
  // MANDATORY — neither face is a system font, and without a stack a document
  // opened on a machine that lacks them silently renders in Times.
  let FD = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
  let FB = "'Lato','Segoe UI',Helvetica,Arial,sans-serif";
  // Credential badges, resolved per tenant. Blanked by _resolveBrand for any
  // non-NBD tenant that has not set its own — never inherited.
  let AFF = [];
  // Short brand seal used in signature labels ("Authorized <SEAL> Representative").
  // 'NBD' for NBD → byte-identical; a tenant resolves to its own brand.seal
  // (e.g. Oaks → 'ORC') via _refreshBrand() below. Phase B tenant-awareness.
  let SEAL = 'NBD';

  // Origin for absolute asset URLs. Generated docs render inside the
  // Universal Doc Viewer (popup/about:blank/srcdoc), where root-
  // relative paths can't resolve. Bake the parent origin in at render
  // time so the logo always loads. Falls back to the production host
  // for headless/server-side renders.
  const ORIGIN = (function () {
    try {
      if (typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null') {
        return window.location.origin;
      }
    } catch (_) {}
    return 'https://nobigdealwithjoedeal.com';
  })();
  // Prefer the inlined data URI from nbd-logo-asset.js — bypasses CORP/cache
  // issues in iframe-srcdoc. Fall back to absolute URL if the asset script
  // failed to load. The SVG monogram inside each <object> is the final fallback.
  let LOGO_URL = (typeof window !== 'undefined' && window.NBD_LOGO_DATA_URI)
    ? window.NBD_LOGO_DATA_URI
    // The navy lockup: nbd-logo.png is white-on-transparent for the site's dark
    // headers, and "NO BIG" disappears on paper (2026-09-30).
    : ORIGIN + '/assets/images/nbd-logo-light-bg.png';
  // Derive the MIME from the data URI itself so a JPEG/PNG/SVG swap
  // in nbd-logo-asset.js doesn't need a parallel edit here.
  let LOGO_TYPE = (typeof window !== 'undefined' && window.NBD_LOGO_DATA_URI)
    ? ((window.NBD_LOGO_DATA_URI.match(/^data:([^;,]+)/) || [, 'image/png'])[1])
    : 'image/png';

  // Register document types by MERGING into the core entries, never
  // replacing them (2026-10-04). A plain Object.assign here replaced the
  // core change_order / certificate_of_completion / scope_of_work /
  // work_authorization / payment_agreement entries with {name, template},
  // dropping their defaultSigners — so the pre-flight seeded no signers and
  // none of those documents could be signed in-app or sent for signature.
  function registerTypes(map) {
    Object.keys(map).forEach(function (k) {
      DG.DOCUMENT_TYPES[k] = Object.assign({}, DG.DOCUMENT_TYPES[k] || {}, map[k]);
    });
  }

  // Register new document types
  registerTypes({
    warranty_certificate: { name: 'Warranty Certificate', template: 'renderWarrantyCertificate' },
    supplement_request: { name: 'Supplement Request', template: 'renderSupplementRequest' },
    scope_of_work: { name: 'Scope of Work', template: 'renderScopeOfWork' },
    work_authorization: { name: 'Work Authorization', template: 'renderWorkAuthorization' },
    certificate_of_completion: { name: 'Certificate of Completion', template: 'renderCertificateOfCompletion' },
    change_order: { name: 'Change Order', template: 'renderChangeOrder' },
    invoice: { name: 'Invoice', template: 'renderInvoice' },
    receipt: { name: 'Receipt', template: 'renderReceipt' },
    roof_assessment: { name: 'Roof Assessment Report', template: 'renderRoofAssessment' },
    company_intro: { name: 'Company Introduction', template: 'renderCompanyIntro' },
    before_after_report: { name: 'Before & After Report', template: 'renderBeforeAfterReport' },
    financing_options: { name: 'Financing Options', template: 'renderFinancingOptions' },
    referral_card: { name: 'Referral Card', template: 'renderReferralCard' }
  });

  // Shared print styles for all templates. A FUNCTION (not a baked const) so it
  // picks up the active tenant's refreshed P/S/A colours on each render — Phase B.
  //
  // COMMENTS ARE STRIPPED FROM THE EMITTED CSS (see the return below). They are
  // for whoever reads this file, not for the customer. Two real bugs came from
  // shipping them inside the document:
  //   1. a comment explaining the tagline contrast contained the brand hex, so
  //      a TENANT's document carried NBD's colour codes, and the tenancy-leak
  //      test in docgen-render.test.js flagged it;
  //   2. a comment reading "BALANCE DUE / PROJECT TOTAL" put the words
  //      "BALANCE DUE" into every document — including receipts, which
  //      docgen-preflight-contract.test.js asserts carry NO due-date language,
  //      because a receipt is proof of payment and must not read as a bill.
  // Stripping at the boundary means neither can happen again, and it trims
  // every generated document a little as well.
  function printCSS() { return stripCssComments(`
    @media print { .no-print { display:none!important; } body { margin:0; } @page { margin:0.5in; } }
    * { box-sizing:border-box; }
    body { font-family:${FB}; color:${INK}; line-height:1.55; margin:0; padding:0; background:#fff; }
    h1,h2,h3,h4 { font-family:${FD}; color:${P}; margin:0 0 12px 0; }
    .doc-page { max-width:8.5in; margin:0 auto; padding:40px 50px; }
    .orange { color:${A}; }
    .section { margin-bottom:28px; }
    .section-title { font-size:15px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em;
      color:${P}; padding-bottom:8px; margin-bottom:14px; position:relative; display:inline-block; padding-right:24px;
      font-family:${FD}; }
    .section-title:after { content:""; position:absolute; left:0; bottom:0; width:32px; height:3px;
      background:${A}; border-radius:2px; }
    /* Numbered section: orange numeral, navy head. Standard section 7. */
    .section-num { font-family:${FD}; font-weight:800; font-size:15px; color:${A};
      margin-right:10px; letter-spacing:0.04em; }
    table.items { width:100%; border-collapse:collapse; margin:16px 0; }
    table.items th { background:${P}; color:#fff; padding:10px 14px; text-align:left; font-family:${FD};
      font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
    table.items td { padding:10px 14px; border-bottom:1px solid ${RL}; font-size:14px; }
    table.items tr:nth-child(even) td { background:${WSH}; }
    /* Money reads right-aligned. Never centre a figure. Standard section 7. */
    table.items .right { text-align:right; }
    /* Total bar — BALANCE DUE / PROJECT TOTAL / AMOUNT APPROVED. */
    .total-bar { display:flex; justify-content:space-between; align-items:center;
      background:${S}; color:#fff; font-family:${FD}; font-size:14px; font-weight:700;
      padding:14px 20px; border-radius:4px; margin:18px 0; letter-spacing:0.04em; }
    .total-bar .total-figure { font-size:18px; }
    .sig-line { display:inline-block; width:280px; border-bottom:2px solid ${P}; margin:0 20px; }
    .sig-label { font-size:11px; color:${G}; margin-top:4px; }
    .photo-zone { border:2px dashed ${RL}; border-radius:8px; min-height:180px; display:flex; align-items:center;
      justify-content:center; color:${G}; font-size:13px; background:${WSH}; }
    .photo-cap { font-size:11px; color:${G}; margin-top:6px; line-height:1.4; }
    .badge { display:inline-block; padding:6px 16px; border-radius:20px; font-size:12px; font-weight:700;
      font-family:${FD}; letter-spacing:0.04em; }
    /* Credential badge row. Rendered only where the document class carries it
       and only from the tenant's OWN resolved affiliates — see affiliateRow(). */
    .affiliates { display:flex; justify-content:center; align-items:center; gap:14px; flex-wrap:wrap; margin:28px 0 8px 0; }
    .affiliate { border:1px solid ${RL}; border-radius:6px; background:#fff;
      padding:8px 14px; text-align:left; }
    .affiliate-name { font-family:${FD}; font-size:11px; font-weight:700; color:${P};
      letter-spacing:0.04em; }
    .affiliate-num { font-family:${FB}; font-size:10px; color:${G}; margin-top:2px; }
    /* Real badge artwork (GAF / TAMKO / American Operator) in place of the
       plain-text fallback above — see affiliateRow(). Height-only sizing so
       each badge keeps its own natural aspect ratio; padding centers it
       inside the same card shell the text fallback uses. The license number
       (when the entry has one) prints BELOW the emblem — the artwork alone
       isn't a verifiable credential without it. */
    .affiliate-badge { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:6px 12px 8px; }
    .affiliate-badge-img { display:block; height:52px; width:auto; }
    .affiliate-badge-num { font-family:${FB}; font-size:10px; color:${G}; margin-top:5px;
      letter-spacing:0.02em; }
    /* How-to-pay panel — invoices only. Standard section 7. */
    .pay-panel { border:2px solid ${A}; border-radius:6px; background:${WSH};
      padding:16px 20px; margin:18px 0; }
    .pay-panel-title { font-family:${FD}; font-size:12px; font-weight:700; color:${P};
      text-transform:uppercase; letter-spacing:0.08em; margin-bottom:8px; }
    .fine-print { font-size:11px; color:${G}; line-height:1.5; }
    .letterhead { background:linear-gradient(180deg,${P} 0%,${S} 100%); color:#fff;
      padding:24px 32px; margin:-40px -50px 28px -50px; border-bottom:6px solid ${A};
      display:flex; justify-content:space-between; align-items:center; gap:18px; }
    .letterhead-brand { display:flex; align-items:center; gap:14px; min-width:0; position:relative; }
    /* The letterhead "brand" cell carries the full real logo (which is
       a horizontal banner — wordmark + roof + Home Solutions + script
       tagline). The source image has navy text on white background;
       on the navy gradient header that gives a navy-on-navy contrast
       problem. White card + padding around the image gives the brand
       breathing room and makes the wordmark legible against any
       header treatment. */
    /* Source logo is 1.5:1 (1536x1024) — declare width only and let the
       browser derive height from the natural aspect ratio. The previous
       280x88 forced 3.18:1, so the white card was hundreds of pixels
       wider than the actual artwork (object-fit:contain centered the
       image, leaving empty white bars on either side that read as
       "stretched"). */
    .letterhead-logo-img { display:block; width:160px; height:auto;
      object-fit:contain; object-position:left center; flex-shrink:0;
      background:#fff; border-radius:8px; padding:6px 10px; box-sizing:border-box; }
    .letterhead-name { font-family:${FD}; font-size:22px; font-weight:800;
      color:#fff; letter-spacing:.04em; text-transform:uppercase; line-height:1.1; }
    /* Tagline sits on the navy header, so it must NOT be the orange accent:
       accent-on-navy measures 2.84:1 and is unreadable. White at 88% instead.
       (No hex literals in shipped CSS comments — every comment here is emitted
       verbatim into the customer's document, and a tenant's paper should not
       carry another brand's colour codes.) */
    .letterhead-tagline { font-family:${FB}; font-size:12px; color:rgba(255,255,255,.88);
      font-style:italic; margin-top:4px; }
    .letterhead-contact { text-align:right; font-family:${FB};
      font-size:11px; color:rgba(255,255,255,.92); line-height:1.7; flex-shrink:0; letter-spacing:.02em; }
    .footer { background:linear-gradient(180deg,${S} 0%,${P} 100%); color:rgba(255,255,255,.92);
      margin:40px -50px -40px -50px; padding:18px 32px; border-top:4px solid ${A};
      display:flex; justify-content:space-between; align-items:center; gap:18px;
      font-family:${FB}; font-size:10px; letter-spacing:.04em; }
    .footer .footer-brand { font-family:${FD}; font-weight:800; text-transform:uppercase; letter-spacing:.1em; color:#fff; font-size:11px; }
    .footer .footer-docnum { font-variant-numeric:tabular-nums; }
    .closing-tag { text-align:center; font-family:${FB}; font-style:italic; font-size:11px;
      color:${G}; margin-top:22px; }
    .print-btn { text-align:center; padding:24px; }
    .print-btn button { background:${A}; color:#fff; border:none; padding:14px 36px; border-radius:8px;
      font-size:16px; cursor:pointer; font-weight:600; font-family:${FD}; }
    .print-btn button:hover { opacity:0.9; }
  `); }

  //
  // Remove CSS block comments from a stylesheet before it is emitted into a
  // customer-facing document, and collapse the blank lines left behind.
  // Only ever fed the printCSS() literal above — pure CSS, with no strings or
  // urls containing comment-like sequences — so a plain non-greedy strip is
  // safe here and does not need a tokenizer.
  // (Line comments, not a JSDoc block: the delimiters this function talks
  // about cannot be written inside one without closing it early.)
  //
  function stripCssComments(css) {
    return String(css)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n');
  }

  function page(title, body) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title} | ${C.name}</title>
    <style>${printCSS()}</style></head><body><div class="doc-page">${body}</div>
    <div class="no-print print-btn"><button data-dgt-action="print">Print / Save as PDF</button></div>
    </body></html>`;
  }

  function letterhead() {
    // The PNG logo loads via <object> with an inline SVG monogram as
    // its fallback content. <object> automatically renders its inner
    // content if the resource fails to load — works under strict CSP
    // without JS, and survives CORP same-origin blocks (which is why
    // root-relative <img src> failed for months inside the doc
    // viewer's null-origin iframe srcdoc). When the PNG loads, the
    // SVG is hidden. When it doesn't, the SVG ring + roof + "NBD"
    // wordmark shows instead — always branded, never empty.
    return `<div class="letterhead">
      <div class="letterhead-brand">
        <!-- Real NBD logo via inline data URI (docs/assets/images/nbd-logo.png).
             <img> not <object> — the iframe srcdoc CSP has object-src 'none'.
             img-src allows data:, so this renders the actual brand mark
             (wordmark + roof + Home Solutions + script tagline) as a real
             image instead of a hand-drawn SVG approximation. -->
        ${LOGO_URL ? `<img class="letterhead-logo-img" src="${LOGO_URL}" alt="${C.name}"/>` : ''}
        <div><div class="letterhead-name">${C.name}</div>
        <div class="letterhead-tagline">${C.tagline || ''}</div></div>
      </div>
      <div class="letterhead-contact">${[C.phone, C.email, C.website].filter(Boolean).join('<br>')}</div></div>`;
  }

  function footer(extra) {
    // Every caller passes plain text; some carry record fields (a claim # the
    // phone-intake AI copies from a caller) — escaped (security audit 2026-09-29).
    return `<div class="footer">
      <span class="footer-brand">${esc(C.name)}</span>
      <span>${[C.phone, C.email, C.website].filter(Boolean).map(esc).join(' &middot; ')}</span>
      <span>${esc(extra || C.tagline || '')}</span>
    </div>`;
  }

  // `data` (optional): the document's merge data. When the pre-flight modal
  // seeded signers (DOCUMENT_TYPES[..].defaultSigners → data.signers), the
  // block is the interactive one from renderSignatureBlock — the
  // [data-nbd-sig] canvases the doc viewer's in-person signing and the remote
  // sign link (createSignRequest) both need. Before 2026-10-04 every template
  // in this file printed bare lines, so a change order, completion
  // certificate, scope, work authorization or payment agreement offered
  // "Send for Signature" on a document with nothing to sign.
  function sigBlock(labels, data) {
    const signers = data && Array.isArray(data.signers) ? data.signers.filter(Boolean) : [];
    if (signers.length && typeof DG.renderSignatureBlock === 'function') {
      return `<div class="section" style="margin-top:36px;">` + DG.renderSignatureBlock(signers) + `</div>`;
    }
    return `<div class="section" style="margin-top:36px;">` + labels.map(l =>
      `<div style="margin-bottom:28px;"><span class="sig-line"></span>
      <span style="margin-left:20px;"><span class="sig-line" style="width:140px;"></span></span>
      <div style="display:flex;gap:20px;margin-top:4px;padding-left:4px;">
        <span class="sig-label" style="width:280px;">${l}</span>
        <span class="sig-label" style="width:140px;margin-left:20px;">Date</span></div></div>`
    ).join('') + `</div>`;
  }

  /**
   * Credential / manufacturer badge row (NBD Document Standard, section 5).
   *
   * DEFENCE IN DEPTH. _resolveBrand() already blanks `affiliates` for a
   * non-NBD tenant that has not set its own (it is listed in _IDENTITY_TOP
   * precisely because a licence number is a certification claim, not styling).
   * This renderer independently refuses to emit anything it was not handed a
   * well-formed array for — '' , [], undefined and malformed entries all
   * produce NO row rather than a partial or inherited one. A false GAF number
   * on a stranger's signed contract is a materially worse failure than a
   * missing badge, so the bias is deliberately toward printing nothing.
   *
   * Which document classes carry the row is the CALLER's decision, per the
   * standard: 100 contracts, 200 estimates, 500 closeout, 600 reports and
   * 700 marketing do; 000 legal boilerplate, 300 field execution and 400
   * insurance/claims do NOT — adjuster-facing paper stays plain and factual.
   *
   * Renders the real badge artwork (GAF / TAMKO / American Operator "Locally
   * Owned & Operated") via window.NBD_BADGE_ASSETS (nbd-badge-assets.js,
   * generated by scripts/build-badge-assets.js) when an entry names one and
   * the asset has resolved — same data-URI approach as the letterhead logo,
   * for the same reason (srcdoc iframe + CSP object-src block a linked
   * <img src="/assets/...">). Falls back to the plain name/number card when
   * it hasn't (script still loading, or a tenant badge with no artwork) —
   * a slow load degrades to text, never to an empty gap.
   */
  function affiliateRow() {
    const list = Array.isArray(AFF) ? AFF : [];
    const assets = (typeof window !== 'undefined' && window.NBD_BADGE_ASSETS) || {};
    const cards = list.map(function (a) {
      const name = a && a.name ? esc(String(a.name)) : '';
      if (!name) return '';                 // no name → not a badge, skip it
      const num = a && a.number ? esc(String(a.number)) : '';
      const asset = a && a.badge && assets[a.badge];
      if (asset && asset.dataUri) {
        const alt = esc(String((a && a.alt) || name));
        // The emblem alone doesn't carry the license number — GAF/TAMKO
        // reps and homeowners verifying a certification need the actual
        // ID underneath, not just the artwork (Jo, 2026-09-09).
        return `<div class="affiliate affiliate-badge"><img class="affiliate-badge-img" src="${asset.dataUri}" alt="${alt}"/>` +
               (num ? `<div class="affiliate-badge-num">${num}</div>` : '') + `</div>`;
      }
      return `<div class="affiliate"><div class="affiliate-name">${name}</div>` +
             (num ? `<div class="affiliate-num">${num}</div>` : '') + `</div>`;
    }).filter(Boolean);
    if (!cards.length) return '';
    return `<div class="affiliates">${cards.join('')}</div>`;
  }
  DG.affiliateRow = affiliateRow;

  // Wallet payments (Venmo / PayPal) are capped by amount on purpose.
  // Small jobs settled at the truck are exactly what they are good for, and
  // they save the card fee. A large balance is a different situation: these
  // rails carry no chargeback path for the homeowner, so asking someone to
  // send five figures down one reads badly and invites the "why won't you
  // take a card" conversation. Above the cap the invoice offers the hosted
  // pay link (card + ACH, with a receipt and a record) plus Zelle and check.
  const WALLET_MAX = 1000;

  /**
   * How-to-pay panel (NBD Document Standard, section 7). Invoices only.
   *
   * Renders the hosted pay link as a button plus, when the caller supplies
   * one, a scannable QR beside it — the raw Stripe URL is far too long to
   * print legibly, which is why the button and the code both exist.
   * Degrades cleanly: with no payUrl it renders the alternatives alone, so
   * an invoice generated before the Stripe link exists is still complete.
   *
   * ONE code maximum. Four QRs on a payment page is not four times the
   * options, it is choice paralysis at the exact moment you want none.
   *
   * @param {object} o  payUrl, payQr (data URI), alternatives (array of
   *                    strings), wallets (array of {name, handle}), amount
   */
  function payPanel(o) {
    o = o || {};
    const alts = (o.alternatives || []).filter(Boolean)
      .map(function (a) { return '<div>' + a + '</div>'; }).join('');
    const btn = o.payUrl
      ? `<a href="${esc(String(o.payUrl))}" style="display:inline-block;background:${A};color:#fff;
          text-decoration:none;padding:12px 26px;border-radius:6px;font-family:${FD};font-weight:700;
          font-size:14px;letter-spacing:0.03em;">Pay${o.amount ? ' ' + esc(String(o.amount)) : ''} online</a>`
      : '';
    const qr = (o.payUrl && o.payQr)
      ? `<img src="${esc(String(o.payQr))}" alt="Scan to pay" width="96" height="96"
          style="display:block;border:1px solid ${RL};border-radius:4px;background:#fff;padding:4px;"/>`
      : '';
    // Wallets only under the cap, and only when the caller passed real ones.
    const amt = Number(String(o.amount == null ? '' : o.amount).replace(/[^0-9.\-]/g, '')) || 0;
    const wl = (Array.isArray(o.wallets) && amt > 0 && amt <= WALLET_MAX)
      ? o.wallets.filter(function (w) { return w && w.name && w.handle; })
          .map(function (w) { return '<div>' + esc(w.name) + ' — ' + esc(w.handle) + '</div>'; }).join('')
      : '';
    if (!btn && !alts && !wl) return '';
    return `<div class="pay-panel">
      <div class="pay-panel-title">How to pay</div>
      ${(btn || qr) ? `<div style="display:flex;align-items:center;gap:18px;margin-bottom:12px;">${btn}${qr}</div>` : ''}
      <div style="font-size:13px;line-height:1.8;">${alts}${wl}</div>
    </div>`;
  }
  DG.payPanel = payPanel;

  function photoGrid(count, cols) {
    cols = cols || 3;
    let html = `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;margin:16px 0;">`;
    for (let i = 0; i < count; i++) html += `<div class="photo-zone">Click to add photo</div>`;
    return html + '</div>';
  }

  // Render the rep's ACTUAL selected photos (array of url strings or {url}
  // objects). Falls back to the empty placeholder grid when none were selected,
  // so a doc generated without photos still looks complete. The url is escaped
  // for the src attribute (quotes + angle brackets).
  function photoGridReal(photos, cols) {
    cols = cols || 2;
    const urls = (Array.isArray(photos) ? photos : [])
      .map(p => typeof p === 'string' ? p : (p && p.url))
      .filter(Boolean);
    if (!urls.length) return photoGrid(cols * 2, cols);
    const safeUrl = (u) => String(u).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    let html = `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;margin:16px 0;">`;
    urls.forEach(u => { html += `<div class="photo-zone has-image" style="padding:0;overflow:hidden;"><img src="${safeUrl(u)}" alt="Photo" style="width:100%;height:100%;object-fit:cover;display:block;"/></div>`; });
    return html + '</div>';
  }

  // & and quotes too — used in alt="…" (security audit 2026-09-29).
  function esc(s) { return String(s||'').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function money(n) { return '$' + (parseFloat(n)||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
  // Cents helpers (2026-10-04): money math stays in integer cents (CLAUDE.md).
  // toCents reads a number or a "$1,234.50"-style string; a blank or
  // unreadable value is 0. The string is split at the point, never
  // multiplied as a float, so "0.29" is 29 cents and not 28.
  function toCents(v) {
    if (typeof v === 'number') return isFinite(v) ? Math.round(v * 100) : 0;
    const s = String(v == null ? '' : v).replace(/[^0-9.\-]/g, '');
    const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s);
    if (!m || (!m[2] && !m[3])) return 0;
    const c = (parseInt(m[2] || '0', 10) * 100) + parseInt(((m[3] || '') + '00').slice(0, 2), 10);
    return m[1] === '-' ? -c : c;
  }
  function centsText(c) { const n = Math.round(Number(c) || 0); const neg = n < 0; const a = Math.abs(n);
    return (neg ? '-' : '') + '$' + Math.floor(a / 100).toLocaleString('en-US') + '.' + String(a % 100).padStart(2, '0'); }
  // A date-input value ("2026-10-04") printed the way a person writes it.
  // Anything else (already written out, or blank) passes through.
  function longDate(v) {
    const s = String(v == null ? '' : v).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return s;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
  }

  // Partner identity + value props resolve through the shared company-profile
  // defaults (company-profile.js loads first on customer.html and exposes
  // window.NBD_COMPANY_PROFILE_DEFAULTS) so a partner change happens in ONE
  // place instead of parallel copies here. Read at call time — script-order
  // safe — with brand-agnostic last resorts for headless/test contexts.
  function cpDefaults() {
    return (typeof window !== 'undefined' && window.NBD_COMPANY_PROFILE_DEFAULTS) || {};
  }
  // NBD-only marketing defaults (2026-10-04, tenant-ready). The Acorn Finance
  // partnership, NBD's services list and its value props ("Lifetime
  // workmanship warranty on every tier") belong to NBD. Another company gets
  // them BLANK — company-profile.js _legal() blanks the profile copies the
  // same way it neutralizes the legal text — and these fallbacks follow suit,
  // so the financing / services / value blocks are simply left out.
  function isNbdDoc() {
    return !C || !C.name || C.name === 'No Big Deal Home Solutions';
  }
  // The company profile a renderer should read: the caller's explicit copy,
  // else the tenant-resolved one (_legal), else the raw merged profile.
  function tenantCp(d) {
    if (d && d.companyProfile) return d.companyProfile;
    if (typeof window !== 'undefined' && typeof window._legal === 'function') {
      try { return window._legal() || {}; } catch (_) { /* fall through */ }
    }
    return (typeof window !== 'undefined' && window._companyProfile) || cpDefaults();
  }
  function defaultFinancePartner() {
    if (!isNbdDoc()) return '';
    return cpDefaults().financePartner || 'our financing marketplace partner';
  }
  function defaultValueProps() {
    if (!isNbdDoc()) return [];
    const vp = cpDefaults().valueProps;
    if (Array.isArray(vp) && vp.length) return vp;
    return [
      {icon:'🛡️',title:'Warranty Protection',desc:'Lifetime workmanship warranty on every tier, plus full manufacturer coverage on all materials.'},
      {icon:'📋',title:'Storm Damage Documentation',desc:'We inspect and photograph the damage and give you a detailed repair estimate. You manage your claim with your insurer, and we can meet your adjuster after you file.'},
      {icon:'⭐',title:'5-Star Service',desc:'Exceptional service from first contact through final walkthrough and beyond.'},
      {icon:'💰',title:'Flexible Financing',desc:'Affordable monthly payments through our financing marketplace partner.'}
    ];
  }
  function today() { return new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'}); }

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 1: WARRANTY CERTIFICATE
  // ═══════════════════════════════════════════════════════════════
  DG.renderWarrantyCertificate = function(data) {
    // Seed the cert number on stable lead context so the same lead +
    // same tier + same issue date always renders the same NBD-WC- ref
    // (was Date.now()%100000 — fresh number on every re-render).
    const _wcPrefix = (window.NBDDocGen && window.NBDDocGen._docPrefix)
      ? window.NBDDocGen._docPrefix() + '-WC' : 'NBD-WC';
    const _certSeed = (window.NBDDocGen && window.NBDDocGen._seededDocNumber)
      ? window.NBDDocGen._seededDocNumber(_wcPrefix,
          [data && data.leadId, data && data.homeownerName, data && data.address,
           data && data.warrantyTier, data && (data.issueDate || data.completionDate)], 5)
      : _wcPrefix + '-' + (Date.now() % 100000);
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      // 2026-09-17: was 'best' — a lone-Elite default among sibling
      // call sites that all default to 'better', for the same reason:
      // defaulting to the TOP tier when nothing is actually known
      // overstates what a customer was promised. Only reached when no
      // estimate exists at all (doc-preflight.js's warrantyTier field
      // now reads estimate.tier); a real estimate's tier still wins.
      warrantyTier:'better', workPerformed:'', coverageDetails:'', transferable:false,
      certificateNumber: _certSeed, issueDate:today() }, data);

    // GBB audit, 2026-09-09: this certificate used to print a real
    // "Expiration Date: N years from issue date" field for the SAME tier
    // whose body text told the homeowner coverage never expires — one
    // document contradicting itself. All three tiers are now lifetime
    // workmanship (estimate-config.js TIER_DISPLAY); only transferability
    // and the inspection perk vary, so there is no expiration date to print
    // at all. Colors/label pulled from the shared config; the tier-specific
    // fallback below matches it exactly if the config fails to load.
    const cfg = (typeof window !== 'undefined') ? window.NBD_ESTIMATE_CONFIG : null;
    // Five tiers (Jo, 2026-10-02): Economy is a 1-YEAR labor warranty + the
    // shingle maker's standard limited warranty, NO system warranty; Beyond is
    // Elite's terms + TAMKO's HailGuard hail warranty. The fallback copies
    // TIER_DISPLAY for a page that didn't load the config.
    const _fallbackWarranty = {
      economy: { workmanshipYears: 1, systemWarranty: false, transferable: false },
      good: { transferable: false }, better: { transferable: true, transferWindowDays: 30 }, best: { transferable: true, inspection: true },
      beyond: { transferable: true, inspection: true, hailWarranty: true }
    };
    const label = (cfg && typeof cfg.tierLabel === 'function') ? cfg.tierLabel(d.warrantyTier) : ({ economy: 'Economy', good: 'Standard', better: 'Preferred', best: 'Elite', beyond: 'Beyond' })[d.warrantyTier] || d.warrantyTier;
    const w = (cfg && cfg.TIER_DISPLAY && cfg.TIER_DISPLAY[d.warrantyTier] && cfg.TIER_DISPLAY[d.warrantyTier].warranty)
      || _fallbackWarranty[d.warrantyTier] || {};
    const tierColors = { economy: '#57534e', good: '#cd7f32', better: '#808080', best: '#DAA520', beyond: '#5b21b6' };
    const tierBgs = { economy: '#f5f5f4', good: '#fdf4e8', better: '#f0f0f0', best: '#fefce8', beyond: '#f5f3ff' };
    // An unknown/legacy tier gets the neutral Preferred colours — never Best's
    // gold, which read as the top tier on a cert nobody sold at that level.
    const t = { label: String(label).toUpperCase(), color: tierColors[d.warrantyTier] || tierColors.better, bg: tierBgs[d.warrantyTier] || tierBgs.better };
    const termYears = Number(w.workmanshipYears) > 0 ? Number(w.workmanshipYears) : 0;
    d.expirationDate = termYears
      ? termYears + (termYears === 1 ? ' year' : ' years') + ' from issue date'
      : 'No expiration — lifetime coverage';

    let warrantyText = termYears
      ? 'Our team guarantees the quality of installation for ' + (termYears === 1 ? 'one (1) year' : termYears + ' years') + ' from the issue date. If any defect in workmanship causes a leak or failure within that period, we will repair it at no cost to you.'
      : 'Our team guarantees the quality of installation for the lifetime of this roof. If any defect in workmanship causes a leak or failure, we will repair it at no cost to you.';
    if (w.inspection) warrantyText += ' Includes priority service response and annual courtesy inspections.';
    // Transferability is tier-driven by default; the rep-selected checkbox
    // (d.transferable) can only ADD transferability on top of the tier's
    // own default, never take away what the tier already promises.
    const isTransferable = w.transferable || d.transferable;
    if (isTransferable && w.transferWindowDays) warrantyText += ' This coverage is transferable to one subsequent owner within ' + w.transferWindowDays + ' days of sale.';
    else if (isTransferable) warrantyText += ' This coverage is fully transferable and follows the property through all subsequent owners.';
    // Material warranty sentence. Economy: the maker's standard limited
    // warranty, never a system warranty — and not the resolver's sentence,
    // which can say "Limited Lifetime". Beyond: TAMKO HailGuard's hail warranty.
    const _mfgRes = resolveDocManufacturer(d.estimateLineItems).manufacturerWarranty;
    const mfgSentence = termYears
      ? 'the shingle manufacturer\'s standard limited warranty (no system warranty is included)'
      : (w.hailWarranty && !/HAIL/i.test(_mfgRes)
        ? 'TAMKO\'s HailGuard hail warranty on the TAMKO HailGuard shingles (manufacturer terms apply)'
        : _mfgRes);
    // The manufacturer warranty by NAME for the details grid (2026-10-04):
    // the tier decides Economy (standard limited, no system warranty) and
    // Beyond (HailGuard); otherwise the shingle actually on the estimate.
    const _mfgRes2 = resolveDocManufacturer(d.estimateLineItems);
    const mfgShort = termYears
      ? _mfgRes2.manufacturer + ' standard limited warranty (no system warranty)'
      : (w.hailWarranty ? 'TAMKO HailGuard hail warranty'
        : (_mfgRes2.manufacturerWarrantyFeature || (_mfgRes2.manufacturer + ' limited manufacturer warranty')));
    const badgeText = termYears
      ? termYears + '-YEAR WORKMANSHIP (LABOR) WARRANTY — ' + t.label + ' TIER'
      : 'LIFETIME WORKMANSHIP WARRANTY — ' + t.label + ' TIER';
    const coverageText = termYears ? termYears + '-Year Workmanship (Labor)' : 'Lifetime Workmanship';

    // Job-type warranty (2026-09-25). A Job Template estimate's warranty is
    // set by its job type (5 yr gutter system, 2 yr install, 1 yr repair only
    // when quoted with it), not a roofing tier. doc-preflight passes the
    // sentence as d.workmanshipWarranty; everything above is roofing's
    // lifetime certificate and must not print for a gutter or repair job.
    // Roofing estimates never set the field, so their certificate is unchanged.
    let job = null;
    if (typeof d.workmanshipWarranty === 'string') {
      const yrs = Number(d.workmanshipWarrantyYears);
      const hasYears = Number.isFinite(yrs) && yrs > 0;
      job = {
        badge: d.workmanshipWarranty
          ? (hasYears ? yrs + '-YEAR WORKMANSHIP WARRANTY' : 'WORKMANSHIP WARRANTY')
          : 'NO WORKMANSHIP WARRANTY',
        body: d.workmanshipWarranty
          ? esc(d.workmanshipWarranty) + ' If a defect in the workmanship it covers appears within that period, it will be repaired at no cost to you.'
          : 'No workmanship warranty applies to this work.',
        coverage: !d.workmanshipWarranty ? 'None' : (hasYears ? yrs + '-Year Workmanship' : 'Workmanship — see above'),
        // "1 year", not "1 years" — the opt-in repair warranty is 1 year.
        expiration: hasYears ? yrs + (yrs === 1 ? ' year' : ' years') + ' from issue date' : 'See above'
      };
    }

    return page('Warranty Certificate', `
      <style>
        .cert-border { border:4px double ${t.color}; padding:48px 40px; margin:20px 0; position:relative; }
        .cert-seal { width:90px;height:90px;border-radius:50%;background:${t.color};display:flex;align-items:center;
          justify-content:center;color:#fff;font-size:32px;position:absolute;bottom:30px;right:30px;box-shadow:0 4px 12px rgba(0,0,0,0.2); }
        .cert-title { font-family:Georgia,serif; font-size:32px; text-align:center; color:${S};
          letter-spacing:0.12em; text-transform:uppercase; margin-bottom:8px; }
        .cert-sub { text-align:center; font-size:14px; color:${A}; letter-spacing:0.08em; margin-bottom:32px; }
        .cert-body { text-align:center; font-size:16px; line-height:2; }
        .cert-name { font-size:24px; font-weight:700; color:${S}; }
        .tier-badge { display:inline-block; padding:10px 28px; border-radius:24px; background:${t.bg};
          border:2px solid ${t.color}; color:${t.color}; font-weight:700; font-size:14px;
          letter-spacing:0.1em; font-family:'Helvetica Neue',Arial,sans-serif; margin:20px 0; }
        .cert-details { display:grid; grid-template-columns:1fr 1fr; gap:16px; max-width:480px;
          margin:24px auto; text-align:left; font-size:13px; }
        .cert-details dt { color:#666; font-family:'Helvetica Neue',Arial,sans-serif; text-transform:uppercase;
          font-size:10px; letter-spacing:0.06em; }
        .cert-details dd { margin:0 0 12px 0; font-weight:600; color:#333; }
      </style>
      ${letterhead()}
      <div class="cert-border">
        <div class="cert-title">Certificate of Warranty</div>
        <div class="cert-sub">${C.name}</div>
        <div class="cert-body">
          <p>This certifies that all work performed at the property of</p>
          <p class="cert-name">${esc(d.homeownerName)}</p>
          <p style="color:#555;">${esc(d.address)}</p>
          ${job ? `<div class="tier-badge">${job.badge}</div>
          <p style="max-width:520px;margin:0 auto;font-size:14px;color:#444;">${job.body}</p>` : `<div class="tier-badge">${esc(badgeText)}</div>
          <p style="max-width:520px;margin:0 auto;font-size:14px;color:#444;">${warrantyText}</p>
          <p style="font-size:14px;color:#444;margin-top:8px;">
            Additionally, the roofing materials carry ${esc(mfgSentence)}.</p>`}
        </div>
        <dl class="cert-details">
          <div><dt>Certificate #</dt><dd>${esc(d.certificateNumber)}</dd></div>
          <div><dt>Issue Date</dt><dd>${esc(longDate(d.issueDate))}</dd></div>
          <div><dt>Install Date</dt><dd>${esc(longDate(d.installDate || d.issueDate))}</dd></div>
          <div><dt>Coverage</dt><dd>${job ? job.coverage : coverageText}</dd></div>
          ${job ? '' : `<div><dt>Manufacturer Warranty</dt><dd>${esc(mfgShort)}</dd></div>`}
          ${job || _mfgRes2.manufacturerName === _mfgRes2.manufacturer + ' shingles' ? '' : `<div><dt>Shingles</dt><dd>${esc(_mfgRes2.manufacturerName)}</dd></div>`}
          <div><dt>Expiration</dt><dd>${esc(job ? job.expiration : d.expirationDate)}</dd></div>
          ${d.workPerformed ? `<div><dt>Work Performed</dt><dd>${esc(d.workPerformed)}</dd></div>` : ''}
          ${job ? '' : `<div><dt>Warranty Tier</dt><dd>${esc(t.label)}</dd></div>`}
        </dl>
        ${d.coverageDetails ? `<p style="max-width:520px;margin:16px auto 0;font-size:13px;color:#555;text-align:center;">${esc(d.coverageDetails)}</p>` : ''}
        <div class="cert-seal">&#10003;</div>
      </div>
      ${sigBlock(['Homeowner Acknowledgment','Authorized ' + SEAL + ' Representative'], d)}
      ${affiliateRow()}
      ${footer('Certificate #' + d.certificateNumber)}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 2: SUPPLEMENT REQUEST
  // ═══════════════════════════════════════════════════════════════
  DG.renderSupplementRequest = function(data) {
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      claimNumber:'[Claim #]', policyNumber:'[Policy #]', insuranceCompany:'[Insurance Company]',
      dateOfLoss:'[Date of Loss]', originalApproved:'0.00',
      supplementItems:[],
      justification:'During the course of the approved roof replacement, additional damage was discovered that was not visible during the initial inspection. The following supplemental items are necessary to restore the roof system to its pre-loss condition and ensure compliance with local building codes.' }, data);

    let suppTotal = 0;
    const rows = d.supplementItems.map(i => {
      // Accept either the renderer's native {item,price} shape OR the estimate /
      // normalized line-item shapes ({description,rate} from mapEstimateLineItems,
      // {description,unitPrice} from hydrateDerivedFields) — otherwise supplement
      // rows render blank descriptions and $0 prices.
      const price = (i.price != null ? i.price : (i.unitPrice != null ? i.unitPrice : i.rate)) || 0;
      const lineTotal = (i.qty||0) * price;
      suppTotal += lineTotal;
      return `<tr><td>${esc(i.item || i.description)}</td><td>${esc(i.code || '')}</td><td class="right">${i.qty}</td>
        <td>${esc(i.unit)}</td><td class="right">${money(price)}</td><td class="right">${money(lineTotal)}</td></tr>`;
    }).join('');

    return page('Supplement Request', `
      ${letterhead()}
      <h1 style="text-align:center;font-size:24px;color:${S};margin:24px 0 8px;">SUPPLEMENT REQUEST</h1>
      <p style="text-align:center;color:#666;font-size:13px;margin-bottom:28px;">Insurance Claim Supplemental Documentation</p>

      <div class="section">
        <div class="section-title">Claim Information</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;">
          <div><strong>Homeowner:</strong> ${esc(d.homeownerName)}</div>
          <div><strong>Claim #:</strong> ${esc(d.claimNumber)}</div>
          <div><strong>Property:</strong> ${esc(d.address)}</div>
          <div><strong>Policy #:</strong> ${esc(d.policyNumber)}</div>
          <div><strong>Insurance:</strong> ${esc(d.insuranceCompany)}</div>
          <div><strong>Date of Loss:</strong> ${esc(d.dateOfLoss)}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Original Approved Amount</div>
        <p style="font-size:20px;font-weight:700;color:${S};">${money(d.originalApproved)}</p>
      </div>

      <div class="section">
        <div class="section-title">Supplemental Line Items</div>
        <table class="items">
          <thead><tr><th>Description</th><th>Code</th><th>Qty</th><th>Unit</th><th>Unit Price</th><th>Total</th></tr></thead>
          <tbody>${rows}
            <tr style="border-top:3px solid ${A};font-weight:700;">
              <td colspan="5" style="text-align:right;font-size:15px;">SUPPLEMENT TOTAL:</td>
              <td class="right" style="font-size:15px;color:${A};">${money(suppTotal)}</td></tr>
            <tr style="font-weight:700;">
              <td colspan="5" style="text-align:right;font-size:15px;">NEW PROJECT TOTAL:</td>
              <td class="right" style="font-size:15px;color:${S};">${money(parseFloat(d.originalApproved)+suppTotal)}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="section">
        <div class="section-title">Justification</div>
        <p style="font-size:14px;">${esc(d.justification)}</p>
      </div>

      <div class="section">
        <div class="section-title">Supporting Documentation</div>
        <div style="font-size:14px;line-height:2;">
          <label><input type="checkbox" checked disabled> Photographs of additional damage</label><br>
          <label><input type="checkbox" checked disabled> Revised scope of work</label><br>
          <label><input type="checkbox" disabled> Manufacturer specifications</label><br>
          <label><input type="checkbox" checked disabled> Code compliance documentation</label><br>
          <label><input type="checkbox" disabled> Third-party assessment</label>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Photo Evidence</div>
        ${photoGrid(4,2)}
      </div>

      ${sigBlock(['Contractor — '+C.name])}
      ${footer('Supplement Request — Claim #' + d.claimNumber)}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 3: SCOPE OF WORK
  // ═══════════════════════════════════════════════════════════════
  DG.renderScopeOfWork = function(data) {
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      projectDescription:'Complete roof replacement — tear-off, underlayment, and installation of new architectural shingle roofing system.',
      materials:'GAF Timberline HDZ Architectural Shingles, GAF FeltBuster Synthetic Underlayment, GAF Cobra Ridge Vent',
      estimatedTimeline:'2-3 business days, weather permitting',
      exclusions:'Interior repairs, landscaping restoration beyond reasonable care, code upgrades not related to roofing, structural framing repairs.' }, data);

    // If materials weren't explicitly provided and the estimate's shingle is
    // TAMKO, reflect the TAMKO system instead of the GAF default (vents stay
    // Roofivent per the install standard). Backward-compatible (GAF otherwise).
    if (!(data && data.materials)) {
      const _m = resolveDocManufacturer(d.estimateLineItems);
      if (_m.manufacturer === 'TAMKO') {
        d.materials = _m.manufacturerName + ', TAMKO Synthetic Guard Underlayment, TAMKO Moisture Guard Ice & Water, Roofivent ventilation';
      }
    }

    const sections = [
      { title:'1. Removal & Demolition', items:[
        'Remove all existing roofing materials down to decking','Remove all existing flashing, vents, and pipe boots',
        'Inspect decking for damage and replace as needed','Remove and dispose of all debris in dumpster on-site'] },
      { title:'2. Decking & Substrate', items:[
        'Replace any damaged or rotted decking (7/16" OSB or equivalent)','Ensure all decking is properly nailed per code requirements',
        'Verify structural integrity of all rafters and trusses'] },
      { title:'3. Underlayment & Ice Shield', items:[
        'Install ice and water shield at all eaves (minimum 3 feet from edge)','Install ice and water shield in all valleys',
        'Install synthetic underlayment over remaining roof deck area','Ensure all underlayment overlaps per manufacturer specifications'] },
      { title:'4. Flashing & Waterproofing', items:[
        'Install new drip edge at all eaves and rakes','Install new step flashing at all wall intersections',
        'Install new pipe boot flashings on all penetrations','Install or replace chimney flashing as needed',
        'Seal all flashing with appropriate roofing sealant'] },
      { title:'5. Shingle Installation', items:[
        'Install starter strip shingles at all eaves and rakes','Install architectural shingles per manufacturer specifications',
        'Maintain proper exposure and offset throughout','Install ridge cap shingles at all ridges and hips'] },
      { title:'6. Ventilation', items:[
        'Install ridge vent system for proper attic ventilation','Ensure soffit vents are unobstructed',
        'Verify balanced intake/exhaust ventilation per code'] },
      { title:'7. Cleanup & Final', items:[
        'Magnetic sweep of entire property for nails and debris','Remove dumpster and all materials from property',
        'Final inspection walk-around with homeowner','Touch up any landscaping disturbed during work'] }
    ];

    return page('Scope of Work', `
      ${letterhead()}
      <h1 style="text-align:center;font-size:24px;color:${S};margin:24px 0 8px;">SCOPE OF WORK</h1>
      <p style="text-align:center;color:#666;margin-bottom:28px;font-size:13px;">Detailed Project Specification</p>

      <div class="section">
        <div class="section-title">Project Overview</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;margin-bottom:16px;">
          <div><strong>Property Owner:</strong> ${esc(d.homeownerName)}</div>
          <div><strong>Date:</strong> ${today()}</div>
          <div><strong>Property:</strong> ${esc(d.address)}</div>
          <div><strong>Timeline:</strong> ${esc(d.estimatedTimeline)}</div>
        </div>
        <p style="font-size:14px;">${esc(d.projectDescription)}</p>
      </div>

      ${sections.map(s => `<div class="section">
        <div class="section-title">${s.title}</div>
        <ul style="font-size:14px;line-height:2;padding-left:24px;">
          ${s.items.map(i => `<li>${esc(i)}</li>`).join('')}
        </ul>
      </div>`).join('')}

      <div class="section">
        <div class="section-title">Material Specifications</div>
        <p style="font-size:14px;">${esc(d.materials)}</p>
      </div>

      ${d.labor ? `<div class="section">
        <div class="section-title">Labor & Crew</div>
        <p style="font-size:14px;">${esc(d.labor)}</p>
      </div>` : ''}

      <div class="section">
        <div class="section-title">Exclusions</div>
        <p style="font-size:14px;color:#666;">${esc(d.exclusions)}</p>
      </div>

      ${sigBlock(['Homeowner','Contractor — '+C.name], d)}
      ${affiliateRow()}
      ${footer('Scope of Work')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 4: WORK AUTHORIZATION
  // ═══════════════════════════════════════════════════════════════
  DG.renderWorkAuthorization = function(data) {
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      scopeSummary:'', startDate:'', emergencyContact:'', accessInstructions:'',
      isInsurance:false, claimNumber:'', insuranceCompany:'' }, data);
    // Bridge: the preflight modal collects "scopeOfWork"; this renderer reads
    // "scopeSummary". Keep the prior roof-replacement sentence as the fallback
    // so a blank scope still yields a complete authorization.
    const scopeSummary = d.scopeSummary || d.scopeOfWork ||
      'Complete roof replacement including tear-off, installation of new roofing system, and cleanup.';
    // 2026-09-27: the insurance-proceeds ASSIGNMENT paragraph is gone in
    // every state (void in Kentucky, KRS 304.20-105; Jo retired it and every
    // direction-to-pay / co-payee form in both states). Payment terms live in
    // the contract.

    return page('Work Authorization', `
      ${letterhead()}
      <h1 style="text-align:center;font-size:24px;color:${S};margin:24px 0 8px;">WORK AUTHORIZATION</h1>
      <p style="text-align:center;color:#666;margin-bottom:28px;font-size:13px;">Authorization to Perform Work</p>

      <div class="section" style="background:#f8f8f8;padding:24px;border-radius:8px;border-left:4px solid ${A};">
        <p style="font-size:15px;line-height:1.8;">
          I, <strong>${esc(d.homeownerName)}</strong>, as the owner of the property located at
          <strong>${esc(d.address)}</strong>, hereby authorize <strong>${C.name}</strong> to perform the
          following work on my property as described below. I understand and agree to the terms of the associated
          contract and scope of work documents.
        </p>
      </div>

      <div class="section">
        <div class="section-title">Scope Summary</div>
        <p style="font-size:14px;">${esc(scopeSummary)}</p>
      </div>

      ${(d.startDate || d.emergencyContact) ? `<div class="section">
        <div class="section-title">Project Details</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:14px;">
          ${d.startDate ? `<div><strong>Authorized Start Date:</strong><br>${esc(d.startDate)}</div>` : ''}
          ${d.emergencyContact ? `<div><strong>Emergency Contact:</strong><br>${esc(d.emergencyContact)}</div>` : ''}
        </div>
      </div>` : ''}

      ${d.accessInstructions ? `<div class="section">
        <div class="section-title">Property Access Instructions</div>
        <p style="font-size:14px;">${esc(d.accessInstructions)}</p>
      </div>` : ''}

      <div class="section" style="background:#fff8f5;padding:20px;border-radius:8px;border:1px solid #f0d0c0;">
        <p style="font-size:13px;color:#555;margin:0;">
          <strong>Notice of Cancellation:</strong> You have the right to cancel this authorization within three (3) business
          days of signing. To cancel, provide written notice to ${C.name} at ${C.email} or by calling ${C.phone}.
        </p>
      </div>

      ${sigBlock(['Property Owner','Witness (Optional)','Authorized ' + SEAL + ' Representative'], d)}
      ${affiliateRow()}
      ${footer('Work Authorization')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 5: CERTIFICATE OF COMPLETION
  // ═══════════════════════════════════════════════════════════════
  DG.renderCertificateOfCompletion = function(data) {
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      scopeSummary:'', startDate:'', qualitySignoff:'',
      completionDate:today(), warrantyTier:'best',
      inspectorName:'' }, data);

    const checklist = [
      {item:'All materials installed per manufacturer specifications',checked:true},
      {item:'Flashing and waterproofing completed at all penetrations',checked:true},
      {item:'Ventilation system installed and verified',checked:true},
      {item:'Property cleaned and all debris removed',checked:true},
      {item:'Magnetic nail sweep of entire property completed',checked:true},
      {item:'Final quality inspection completed by crew lead',checked:true},
      {item:'Homeowner walkthrough and approval obtained',checked:true}
    ];

    return page('Certificate of Completion', `
      <style>
        .comp-border { border:3px solid ${P}; padding:40px; margin:20px 0; border-radius:12px; }
        .check-item { display:flex; align-items:center; gap:12px; padding:8px 0; font-size:14px;
          border-bottom:1px solid #f0f0f0; }
        .check-icon { width:24px; height:24px; border-radius:50%; display:flex; align-items:center;
          justify-content:center; font-size:14px; flex-shrink:0; }
        .check-yes { background:#dcfce7; color:#16a34a; }
      </style>
      ${letterhead()}
      <div class="comp-border">
        <h1 style="text-align:center;font-size:28px;color:${S};margin-bottom:4px;">CERTIFICATE OF COMPLETION</h1>
        <p style="text-align:center;color:${A};font-size:13px;letter-spacing:0.08em;margin-bottom:28px;">${C.name}</p>

        <div class="section">
          <div class="section-title">Project Details</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;">
            <div><strong>Property Owner:</strong> ${esc(d.homeownerName)}</div>
            ${d.startDate ? `<div><strong>Start Date:</strong> ${esc(d.startDate)}</div>` : ''}
            <div><strong>Property:</strong> ${esc(d.address)}</div>
            <div><strong>Completion Date:</strong> ${esc(d.completionDate)}</div>
            <div style="grid-column:1/-1;"><strong>Work Performed:</strong> ${esc(d.scopeSummary)}</div>
          </div>
        </div>

        <div class="section">
          <div class="section-title">Completion Verification</div>
          ${checklist.map(c => `<div class="check-item">
            <div class="check-icon ${c.checked?'check-yes':''}">&#10003;</div>
            <span>${esc(c.item)}</span>
          </div>`).join('')}
        </div>

        ${d.qualitySignoff ? `<div class="section">
          <div class="section-title">Quality Sign-off</div>
          <p style="font-size:14px;">${esc(d.qualitySignoff)}</p>
        </div>` : ''}

        <div class="section">
          <div class="section-title">Final Inspection Photos</div>
          ${photoGridReal([].concat(d.afterPhotos || [], d.beforePhotos || []), 2)}
        </div>

        <div class="section" style="background:#f0fdf4;padding:20px;border-radius:8px;border:1px solid #bbf7d0;">
          <p style="font-size:14px;margin:0;color:#166534;">
            <strong>Warranty Activated:</strong> Your warranty coverage is now active as of ${esc(d.completionDate)}.
            Please retain this certificate along with your warranty certificate for your records.
          </p>
        </div>

        <div class="section" style="background:#f8f8f8;padding:20px;border-radius:8px;margin-top:16px;">
          <p style="font-size:14px;margin:0;">
            I confirm that the work described above has been completed to my satisfaction and I have inspected the
            finished project with the contractor.
          </p>
        </div>
      </div>
      ${sigBlock(['Homeowner','Authorized ' + SEAL + ' Representative'], d)}
      ${affiliateRow()}
      ${footer('Certificate of Completion')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 6: CHANGE ORDER
  // ═══════════════════════════════════════════════════════════════
  DG.renderChangeOrder = function(data) {
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      originalContractNumber:'', originalContractDate:'',
      changeOrderNumber:'CO-001', changesDescription:'Additional work identified during project execution.',
      itemsAdded:[],
      itemsRemoved:[],
      originalTotal:0, scheduleImpact:'No change to estimated completion date.',
      scheduleDays:'', newCompletionDate:'' }, data);
    // The pre-flight field is changeDescription; hydrateDerivedFields bridges
    // it, but a direct generate() caller would print the placeholder.
    if (data && !data.changesDescription && data.changeDescription) d.changesDescription = data.changeDescription;

    // Money in CENTS (2026-10-04). The old math multiplied float dollars, and
    // its New Total trusted the form's "0" default: a rep who entered only the
    // change amount printed "New Total $0.00" on a document the homeowner signs.
    let addedC = 0, removedC = 0;
    const _price = (i) => (i.price != null ? i.price : (i.unitPrice != null ? i.unitPrice : i.rate)) || 0;
    const _lineC = (i) => Math.round((Number(i.qty) || 0) * toCents(_price(i)));
    const addedRows = d.itemsAdded.map(i => { const t = _lineC(i); addedC += t;
      return `<tr><td>${esc(i.item || i.description)}</td><td class="right">${esc(i.qty)}</td><td>${esc(i.unit)}</td><td class="right">${centsText(toCents(_price(i)))}</td><td class="right">${centsText(t)}</td></tr>`; }).join('');
    const removedRows = d.itemsRemoved.map(i => { const t = _lineC(i); removedC += t;
      return `<tr><td>${esc(i.item || i.description)}</td><td class="right">${esc(i.qty)}</td><td>${esc(i.unit)}</td><td class="right">${centsText(toCents(_price(i)))}</td><td class="right" style="color:#dc2626;">-${centsText(t)}</td></tr>`; }).join('');
    // The DocPreflight modal collects a single changeAmount + newTotal (no itemized
    // add/remove rows), so when no line items were supplied reflect the rep's
    // entered figures. Itemized callers drive the math from their own rows.
    const _hasItems = (d.itemsAdded && d.itemsAdded.length) || (d.itemsRemoved && d.itemsRemoved.length);
    const netC = _hasItems ? (addedC - removedC) : toCents(d.changeAmount);
    const origC = toCents(d.originalTotal);
    // A New Total the rep typed wins; blank (or the old form's 0 default) is
    // original + change, so the three figures always foot.
    const _repNewC = toCents(d.newTotal);
    const newC = (!_hasItems && _repNewC !== 0) ? _repNewC : origC + netC;

    const days = parseInt(String(d.scheduleDays == null ? '' : d.scheduleDays).replace(/[^0-9\-]/g, ''), 10);
    const scheduleLines = [];
    if (days > 0) scheduleLines.push('This change adds ' + days + ' working day' + (days === 1 ? '' : 's') + ' to the schedule.');
    else if (days < 0) scheduleLines.push('This change shortens the schedule by ' + (-days) + ' working day' + (days === -1 ? '' : 's') + '.');
    if (d.newCompletionDate) scheduleLines.push('New estimated completion: ' + longDate(d.newCompletionDate) + '.');
    if (d.scheduleImpact) scheduleLines.push(d.scheduleImpact);

    const refBits = ['Change Order #' + esc(d.changeOrderNumber)];
    if (d.originalContractNumber) refBits.push('Original Contract: ' + esc(d.originalContractNumber));

    return page('Change Order', `
      ${letterhead()}
      <h1 style="text-align:center;font-size:24px;color:${S};margin:24px 0 8px;">CHANGE ORDER</h1>
      <p style="text-align:center;color:#666;margin-bottom:20px;font-size:13px;">${refBits.join(' | ')}</p>

      <div class="section" style="background:${WSH};border-left:4px solid ${A};padding:14px 18px;border-radius:4px;font-size:14px;">
        This is a written change to your contract. It takes effect only when you and ${esc(C.name)} have both signed it.
        Everything else in your original contract stays the same.
      </div>

      <div class="section">
        <div class="section-title">Reference Information</div>
        <div style="display:flex;flex-wrap:wrap;gap:12px 28px;font-size:14px;">
          <div><strong>Homeowner:</strong> ${esc(d.homeownerName)}</div>
          <div><strong>Property:</strong> ${esc(d.address)}</div>
          ${d.originalContractDate ? `<div><strong>Original Contract Date:</strong> ${esc(longDate(d.originalContractDate))}</div>` : ''}
          <div><strong>Change Order Date:</strong> ${today()}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">What Is Changing</div>
        <p style="font-size:14px;white-space:pre-line;">${esc(d.changesDescription)}</p>
      </div>

      ${addedRows ? `<div class="section">
        <div class="section-title">Items Added</div>
        <table class="items"><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Price</th><th>Total</th></tr></thead>
        <tbody>${addedRows}</tbody></table>
      </div>` : ''}

      ${removedRows ? `<div class="section">
        <div class="section-title">Items Removed / Credited</div>
        <table class="items"><thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Price</th><th>Credit</th></tr></thead>
        <tbody>${removedRows}</tbody></table>
      </div>` : ''}

      <div class="section" style="background:#f8f8f8;padding:24px;border-radius:8px;">
        <div style="display:flex;flex-wrap:wrap;justify-content:space-around;gap:16px;text-align:center;">
          <div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">Original Total</div>
            <div data-co-figure="original" style="font-size:22px;font-weight:700;color:#333;">${centsText(origC)}</div></div>
          <div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">Change Amount</div>
            <div data-co-figure="change" style="font-size:22px;font-weight:700;color:${netC>=0?A:'#16a34a'};">${netC>=0?'+':'-'}${centsText(Math.abs(netC))}</div></div>
          <div><div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">New Total</div>
            <div data-co-figure="new" style="font-size:22px;font-weight:700;color:${S};">${centsText(newC)}</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Effect on Schedule</div>
        ${scheduleLines.map(l => `<p style="font-size:14px;margin:0 0 6px;">${esc(l)}</p>`).join('')}
      </div>

      <div class="section" style="font-size:13px;color:#555;">
        <p>Payment for this change follows the payment terms of your original contract. By signing below, both
        parties agree to the changes described in this change order. All other terms and conditions of the
        original contract remain in full force and effect.</p>
      </div>

      ${sigBlock(['Homeowner','Contractor — '+C.name], d)}
      ${affiliateRow()}
      ${footer('Change Order #'+d.changeOrderNumber)}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 7: INVOICE
  // ═══════════════════════════════════════════════════════════════
  DG.renderInvoice = function(data) {
    const _cpInv = tenantCp(data);
    const _invFinancePartner = _cpInv.financePartner || defaultFinancePartner();
    const _invLateText = _cpInv.latePaymentChargeText || '1.5% monthly finance charge';
    // The ONE invoice due-date rule (deposit-rule.js INVOICE_DUE_DAYS — Jo
    // 2026-10-05: 7 days everywhere). This said "Due upon receipt".
    const _invDr = window.NBDDepositRule;
    const _invDueDays = _invDr ? _invDr.INVOICE_DUE_DAYS : 7;
    const _invDueDefault = new Date(_invDr ? _invDr.invoiceDueDateMs(Date.now()) : Date.now() + 7 * 86400000)
      .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      homeownerPhone:'', homeownerEmail:'',
      invoiceNumber:'INV-'+(Date.now()%100000), invoiceDate:today(), dueDate:_invDueDefault,
      // No placeholder line items / no phantom prior payment: an invoice must
      // reflect only the rep-entered figures. generate() synthesizes a single
      // summary line from the required Total Amount; taxRate/paymentsReceived
      // default to 0 so a blank field never invents tax or a $6,250 credit.
      lineItems:[],
      taxRate:0, paymentsReceived:0,
      claimNumber:'', insuranceCompany:'',
      // Extra properties worked under one job. Invoice NBD-2026-0810-XXXX bills
      // 100 AND 102 Kentucky Ave together; before this the second building
      // could not be shown at all. Empty array = block is omitted entirely.
      serviceAddresses:[],
      notes:'Thank you for choosing ' + C.name + '. We appreciate your business and trust in our team.' }, data);

    let subtotal = 0;
    const rows = d.lineItems.map(i => {
      // hydrateDerivedFields normalizes lineItems to {description,unitPrice}; this
      // loop historically read i.rate, so every normalized row priced at $0. Accept
      // unitPrice / rate / price so the rep's amounts actually total.
      const unitPrice = (i.unitPrice != null ? i.unitPrice : (i.rate != null ? i.rate : i.price)) || 0;
      const amt = (i.qty||0)*unitPrice; subtotal += amt;
      return `<tr><td>${esc(i.description || i.item)}</td><td class="right">${i.qty}</td><td>${esc(i.unit)}</td>
        <td class="right">${money(unitPrice)}</td><td class="right">${money(amt)}</td></tr>`;
    }).join('');
    const tax = subtotal * (d.taxRate||0);
    const total = subtotal + tax;
    const balance = total - (d.paymentsReceived||0);

    // .inv-balance is navy-deep, NOT the accent. A money block is structure,
    // not a call to action — the standard reserves orange for rules, numerals,
    // badges and buttons. It also matches the Project Total block in
    // renderFinancingOptions, which was already navy, and drops a full-page
    // slab of rust that dominated the invoice.
    //
    // NOTE: this per-template <style> is emitted INSIDE the document body and
    // does NOT pass through stripCssComments() — only printCSS() does. So this
    // rationale lives here in JS, not in the CSS below. A CSS comment here
    // would ship to the customer, and the words in it would be searchable
    // document text — which is exactly how the receipt/"BALANCE DUE" contract
    // failure happened. Same rule applies to every other inline <style> block
    // in this file.
    return page('Invoice', `
      <style>
        .inv-balance { background:${S}; color:#fff; padding:20px 28px; border-radius:8px; text-align:center; margin:20px 0; }
        .inv-balance-label { font-size:12px; text-transform:uppercase; letter-spacing:0.1em; opacity:0.9;
          font-family:${FD}; }
        .inv-balance-amount { font-size:36px; font-weight:700; margin-top:4px; font-family:${FD}; }
      </style>
      ${letterhead()}
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;">
        <div>
          <h1 style="font-size:36px;color:${S};margin:0;">INVOICE</h1>
          <p style="color:#666;font-size:13px;margin:4px 0 0;">#${esc(d.invoiceNumber)}</p>
        </div>
        <div style="text-align:right;font-size:14px;">
          <div><strong>Invoice Date:</strong> ${esc(d.invoiceDate)}</div>
          <div><strong>Due Date:</strong> ${esc(d.dueDate)}</div>
          ${d.claimNumber ? `<div style="margin-top:8px;"><strong>Claim #:</strong> ${esc(d.claimNumber)}</div>
            <div><strong>Insurance:</strong> ${esc(d.insuranceCompany)}</div>` : ''}
        </div>
      </div>

      <div class="section" style="background:#f8f8f8;padding:20px;border-radius:8px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Bill To</div>
        <div style="font-size:16px;font-weight:700;color:${S};">${esc(d.homeownerName)}</div>
        <div style="font-size:14px;color:#555;">${esc(d.address)}</div>
        ${d.homeownerPhone ? `<div style="font-size:14px;color:#555;">${esc(d.homeownerPhone)}</div>` : ''}
        ${d.homeownerEmail ? `<div style="font-size:14px;color:#555;">${esc(d.homeownerEmail)}</div>` : ''}
      </div>

      ${(Array.isArray(d.serviceAddresses) && d.serviceAddresses.filter(Boolean).length) ? `
      <div class="section" style="background:#f8f8f8;padding:20px;border-radius:8px;margin-top:12px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Service Locations</div>
        <div style="font-size:14px;color:#555;">${esc(d.address)}</div>
        ${d.serviceAddresses.filter(Boolean).map(a => `<div style="font-size:14px;color:#555;">${esc(a)}</div>`).join('')}
      </div>` : ''}

      <div class="section">
        <table class="items">
          <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>

        <div style="max-width:300px;margin-left:auto;font-size:14px;">
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;">
            <span>Subtotal</span><span>${money(subtotal)}</span></div>
          ${d.taxRate ? `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;">
            <span>Tax (${(d.taxRate*100).toFixed(1)}%)</span><span>${money(tax)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;font-weight:700;">
            <span>Total</span><span>${money(total)}</span></div>
          ${d.paymentsReceived ? `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;color:#16a34a;">
            <span>Payments Received</span><span>-${money(d.paymentsReceived)}</span></div>` : ''}
        </div>
      </div>

      <div class="inv-balance">
        <div class="inv-balance-label">Balance Due</div>
        <div class="inv-balance-amount">${money(balance)}</div>
      </div>

      <div class="section" style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        ${payPanel({
          payUrl: d.payUrl || '',
          payQr: d.payQr || '',
          amount: money(balance),
          alternatives: [
            'Check — payable to <strong>' + esc(C.name) + '</strong>',
            C.email ? 'Zelle — ' + esc(C.email) : '',
            d.payUrl ? '' : 'Credit Card — ask for secure link',
            _invFinancePartner ? 'Financing — through ' + esc(_invFinancePartner) : '',
          ],
          wallets: d.wallets || [],
        })}
        <div style="background:#fff8f5;padding:16px;border-radius:8px;border:1px solid #f0d0c0;">
          <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Late Payment</div>
          <div style="font-size:13px;line-height:1.8;color:#555;">
            Payment is due within ${_invDueDays} days of the invoice date (Net ${_invDueDays}) unless otherwise agreed in writing. Accounts past 30 days may be
            subject to a ${esc(_invLateText)}.
          </div>
        </div>
      </div>

      ${d.notes ? `<div class="section" style="text-align:center;font-style:italic;color:#555;font-size:14px;
        padding:16px;border-top:1px solid #eee;margin-top:20px;">${esc(d.notes)}</div>` : ''}

      ${affiliateRow()}
      ${footer('Invoice #'+d.invoiceNumber)}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 7b: RECEIPT
  // ═══════════════════════════════════════════════════════════════
  //
  // A receipt is NOT an invoice with the balance zeroed out. A customer who
  // has already paid and is handed a document headed INVOICE with payment
  // terms and a late-fee clause reads it as another bill. This is its own
  // template: PAID mark, what was paid, how, when, and an explicit balance
  // line so there is no ambiguity about whether anything is still owed.
  //
  // document-generator.js already had a `receipt` branch in _buildPremiumData
  // and in the server-render map, but `receipt` was never registered in
  // DOCUMENT_TYPES — so there was no way to produce one from the app. Jobs
  // that were paid in full (Customer BZ, Customer EE) had no closing document at all.
  DG.renderReceipt = function(data) {
    const d = Object.assign({
      homeownerName:'[Homeowner Name]', address:'[Property Address]',
      homeownerPhone:'', homeownerEmail:'',
      receiptNumber:'RCT-'+(Date.now()%100000),
      paymentDate: today(),
      paymentMethod:'',            // PayPal / Venmo / Check / Zelle / Card / Cash
      paymentReference:'',         // check no., transaction id, last 4 — optional
      // Only rep-entered figures. amountPaid drives the document; contractTotal
      // and priorPayments are optional and only shown when supplied, so a blank
      // field can never imply a balance that does not exist.
      amountPaid:0, contractTotal:0, priorPayments:0,
      workPerformed:'',
      lineItems:[],
      serviceAddresses:[],
      notes:'Thank you for your business. Please keep this receipt with your project records for warranty and tax purposes.'
    }, data);

    const amountPaid = Number(d.amountPaid || d.amount || d.paymentAmount || 0);
    const contractTotal = Number(d.contractTotal || 0);
    const priorPayments = Number(d.priorPayments || 0);
    // Balance is only asserted when we were told the contract total. Guessing
    // "PAID IN FULL" from a single payment is how a customer ends up believing
    // a job is settled when it is not.
    const knowsTotal = contractTotal > 0;
    const balance = knowsTotal ? Math.max(0, contractTotal - priorPayments - amountPaid) : null;
    const paidInFull = knowsTotal ? (balance === 0) : (d.paidInFull === true);

    const rows = (d.lineItems || []).map(i => {
      const unitPrice = (i.unitPrice != null ? i.unitPrice : (i.rate != null ? i.rate : i.price)) || 0;
      const amt = (i.qty || 0) * unitPrice;
      return `<tr><td>${esc(i.description || i.item)}</td><td class="right">${i.qty}</td><td>${esc(i.unit)}</td>
        <td class="right">${money(unitPrice)}</td><td class="right">${money(amt)}</td></tr>`;
    }).join('');

    return page('Receipt', `
      <style>
        .rct-paid { background:#16a34a; color:#fff; padding:20px 28px; border-radius:8px; text-align:center; margin:20px 0; }
        .rct-paid-label { font-size:12px; text-transform:uppercase; letter-spacing:0.1em; opacity:0.92; }
        .rct-paid-amount { font-size:36px; font-weight:700; margin-top:4px; }
        .rct-stamp { display:inline-block; border:3px solid #16a34a; color:#16a34a; font-weight:800;
          letter-spacing:0.12em; font-size:15px; padding:6px 16px; border-radius:6px; transform:rotate(-4deg); }
      </style>
      ${letterhead()}
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;">
        <div>
          <h1 style="font-size:36px;color:${S};margin:0;">RECEIPT</h1>
          <p style="color:#666;font-size:13px;margin:4px 0 0;">#${esc(d.receiptNumber)}</p>
        </div>
        <div style="text-align:right;font-size:14px;">
          <div><strong>Date Paid:</strong> ${esc(d.paymentDate)}</div>
          ${d.paymentMethod ? `<div><strong>Method:</strong> ${esc(d.paymentMethod)}</div>` : ''}
          ${d.paymentReference ? `<div><strong>Reference:</strong> ${esc(d.paymentReference)}</div>` : ''}
          ${paidInFull ? `<div style="margin-top:12px;"><span class="rct-stamp">PAID IN FULL</span></div>` : ''}
        </div>
      </div>

      <div class="section" style="background:#f8f8f8;padding:20px;border-radius:8px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Received From</div>
        <div style="font-size:16px;font-weight:700;color:${S};">${esc(d.homeownerName)}</div>
        <div style="font-size:14px;color:#555;">${esc(d.address)}</div>
        ${d.homeownerPhone ? `<div style="font-size:14px;color:#555;">${esc(d.homeownerPhone)}</div>` : ''}
        ${d.homeownerEmail ? `<div style="font-size:14px;color:#555;">${esc(d.homeownerEmail)}</div>` : ''}
      </div>

      ${(Array.isArray(d.serviceAddresses) && d.serviceAddresses.filter(Boolean).length) ? `
      <div class="section" style="background:#f8f8f8;padding:20px;border-radius:8px;margin-top:12px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Service Locations</div>
        <div style="font-size:14px;color:#555;">${esc(d.address)}</div>
        ${d.serviceAddresses.filter(Boolean).map(a => `<div style="font-size:14px;color:#555;">${esc(a)}</div>`).join('')}
      </div>` : ''}

      ${d.workPerformed ? `<div class="section">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Work Performed</div>
        <div style="font-size:14px;line-height:1.7;color:#333;">${esc(d.workPerformed)}</div>
      </div>` : ''}

      ${rows ? `<div class="section">
        <table class="items">
          <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th>Rate</th><th>Amount</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>` : ''}

      <div class="rct-paid">
        <div class="rct-paid-label">Amount Received</div>
        <div class="rct-paid-amount">${money(amountPaid)}</div>
      </div>

      ${knowsTotal ? `<div class="section">
        <div style="max-width:320px;margin-left:auto;font-size:14px;">
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;">
            <span>Contract Total</span><span>${money(contractTotal)}</span></div>
          ${priorPayments ? `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;color:#16a34a;">
            <span>Previous Payments</span><span>-${money(priorPayments)}</span></div>` : ''}
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #eee;color:#16a34a;">
            <span>This Payment</span><span>-${money(amountPaid)}</span></div>
          <div style="display:flex;justify-content:space-between;padding:10px 0;font-weight:700;
            ${balance === 0 ? 'color:#16a34a;' : ''}">
            <span>Balance Remaining</span><span>${money(balance)}</span></div>
        </div>
      </div>` : ''}

      ${d.notes ? `<div class="section" style="text-align:center;font-style:italic;color:#555;font-size:14px;
        padding:16px;border-top:1px solid #eee;margin-top:20px;">${esc(d.notes)}</div>` : ''}

      ${affiliateRow()}
      ${footer('Receipt #'+d.receiptNumber)}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 7c: ROOF ASSESSMENT REPORT
  // ═══════════════════════════════════════════════════════════════
  //
  // The deliverable for a PAID inspection. The existing inspection template is
  // insurance-shaped — it requires a carrier, claim number and date of loss —
  // so a homeowner who simply pays for an opinion on their roof had no
  // document at all. Three such inspections were outstanding on 2026-08-18.
  //
  // Structure follows how a finding is actually explained on a roof:
  // what was observed → why it matters → what it leads to if left. Severity is
  // rep-set, never inferred: this template will not decide for itself that
  // something is urgent.
  DG.renderRoofAssessment = function(data) {
    const SEV = {
      urgent:   { label: 'Address Now',    bg: '#fdecea', fg: '#c0392b', br: '#f0c0ba' },
      monitor:  { label: 'Monitor',        bg: '#fdf3e0', fg: '#9a6510', br: '#eedcb8' },
      note:     { label: 'For Your Records', bg: '#eef1f6', fg: '#4a5768', br: '#dbe1ea' }
    };
    const d = Object.assign({
      homeownerName:'[Homeowner Name]', address:'[Property Address]',
      homeownerPhone:'', homeownerEmail:'',
      reportNumber:'ASM-'+(Date.now()%100000),
      inspectionDate: today(),
      inspectorName:'',
      roofSystem:'',              // e.g. "EPDM (rubber) low-slope"
      summary:'',
      findings:[],                // [{ title, observed, whyItMatters, severity }]
      recommendations:[],         // [string]
      photos:[],                  // [{ url, caption }]
      nextSteps:'',
      notes:''
    }, data);

    const findingsHTML = (d.findings || []).filter(Boolean).map((f, i) => {
      const sev = SEV[String(f.severity || 'note').toLowerCase()] || SEV.note;
      return `
      <div style="border:1px solid ${sev.br};background:${sev.bg};border-radius:8px;padding:16px 18px;margin-bottom:14px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;margin-bottom:8px;">
          <div style="font-size:15px;font-weight:700;color:${S};">${i + 1}. ${esc(f.title)}</div>
          <span class="badge" style="background:#fff;color:${sev.fg};border:1px solid ${sev.br};white-space:nowrap;">${sev.label}</span>
        </div>
        ${f.observed ? `<div style="font-size:14px;line-height:1.7;color:#333;margin-bottom:8px;">
          <strong style="color:${sev.fg};">What I saw — </strong>${esc(f.observed)}</div>` : ''}
        ${f.whyItMatters ? `<div style="font-size:14px;line-height:1.7;color:#333;">
          <strong style="color:${sev.fg};">Why it matters — </strong>${esc(f.whyItMatters)}</div>` : ''}
      </div>`;
    }).join('');

    const recsHTML = (d.recommendations || []).filter(Boolean)
      .map(r => `<li style="margin-bottom:8px;line-height:1.7;">${esc(r)}</li>`).join('');

    // Only real photo URLs render. An empty array produces no grid at all —
    // a report padded with empty placeholder boxes reads as unfinished work.
    const photosHTML = (d.photos || [])
      .filter(p => p && /^https?:/i.test(String(p.url || '')))
      .map(p => `
      <div style="margin-bottom:16px;">
        <img src="${esc(p.url)}" alt="${esc(p.caption || 'Roof photo')}"
          style="width:100%;border-radius:8px;border:1px solid #ddd;display:block;">
        ${p.caption ? `<div style="font-size:12px;color:#666;margin-top:6px;font-style:italic;">${esc(p.caption)}</div>` : ''}
      </div>`).join('');

    return page('Roof Assessment Report', `
      ${letterhead()}
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;">
        <div>
          <h1 style="font-size:32px;color:${S};margin:0;">ROOF ASSESSMENT</h1>
          <p style="color:#666;font-size:13px;margin:4px 0 0;">#${esc(d.reportNumber)}</p>
        </div>
        <div style="text-align:right;font-size:14px;">
          <div><strong>Inspected:</strong> ${esc(d.inspectionDate)}</div>
          ${d.inspectorName ? `<div><strong>Inspected by:</strong> ${esc(d.inspectorName)}</div>` : ''}
          ${d.roofSystem ? `<div><strong>Roof system:</strong> ${esc(d.roofSystem)}</div>` : ''}
        </div>
      </div>

      <div class="section" style="background:#f8f8f8;padding:20px;border-radius:8px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Prepared For</div>
        <div style="font-size:16px;font-weight:700;color:${S};">${esc(d.homeownerName)}</div>
        <div style="font-size:14px;color:#555;">${esc(d.address)}</div>
        ${d.homeownerPhone ? `<div style="font-size:14px;color:#555;">${esc(d.homeownerPhone)}</div>` : ''}
        ${d.homeownerEmail ? `<div style="font-size:14px;color:#555;">${esc(d.homeownerEmail)}</div>` : ''}
      </div>

      ${d.summary ? `<div class="section">
        <div class="section-title">The Short Version</div>
        <div style="font-size:15px;line-height:1.8;color:#333;">${esc(d.summary)}</div>
      </div>` : ''}

      ${findingsHTML ? `<div class="section">
        <div class="section-title">What I Found</div>
        ${findingsHTML}
      </div>` : ''}

      ${photosHTML ? `<div class="section">
        <div class="section-title">Photos</div>
        ${photosHTML}
      </div>` : ''}

      ${recsHTML ? `<div class="section">
        <div class="section-title">What I Recommend</div>
        <ol style="font-size:14px;color:#333;padding-left:22px;margin:0;">${recsHTML}</ol>
      </div>` : ''}

      ${d.nextSteps ? `<div class="section" style="background:#fff8f5;border:1px solid #f0d0c0;border-radius:8px;padding:18px 20px;">
        <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Next Steps</div>
        <div style="font-size:14px;line-height:1.8;color:#333;">${esc(d.nextSteps)}</div>
      </div>` : ''}

      ${d.notes ? `<div class="section" style="text-align:center;font-style:italic;color:#555;font-size:14px;
        padding:16px;border-top:1px solid #eee;margin-top:20px;">${esc(d.notes)}</div>` : ''}

      ${affiliateRow()}
      ${footer('Assessment #'+d.reportNumber)}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 8: COMPANY INTRO ONE-PAGER
  // ═══════════════════════════════════════════════════════════════
  DG.renderCompanyIntro = function(data) {
    const d = Object.assign({}, data);
    const cp = tenantCp(d);
    // Rep-entered "Services Offered" (DocPreflight `services` textarea) overrides
    // the companyProfile/hardcoded list. It arrives as a comma-separated string
    // (e.g. "Roofing, Siding, Gutters") → one name-only card per entry. Fallback
    // chain when blank: companyProfile.services → hardcoded NBD default.
    const servicesOverride = (typeof d.services === 'string' && d.services.trim())
      ? d.services.split(',').map(s => s.trim()).filter(Boolean).map(name => ({icon:'🔧',name:name,desc:''}))
      : null;
    const services = servicesOverride || (Array.isArray(cp.services) && cp.services.length ? cp.services : !isNbdDoc() ? [] : [
      {icon:'🏠',name:'Roofing',desc:'Full replacements, repairs, and storm damage restoration'},
      {icon:'🧱',name:'Siding',desc:'Vinyl, fiber cement, LP SmartSide, and board & batten'},
      {icon:'🌧️',name:'Gutters',desc:'Seamless gutters, guards, downspouts, and drainage'},
      {icon:'🪟',name:'Windows & Doors',desc:'Energy-efficient upgrades and storm damage replacement'},
      {icon:'🎨',name:'Interior',desc:'Water damage repair, paint, drywall, flooring'},
      {icon:'⛈️',name:'Storm Damage',desc:'Full insurance claim management from inspection to completion'}
    ]);
    const valueProps = Array.isArray(cp.valueProps) && cp.valueProps.length ? cp.valueProps : defaultValueProps();
    // NBD keeps the original resolution (cp.tagline, the editable shop-wide
    // marketing tagline, wins) → byte-identical. A non-NBD tenant uses ONLY its
    // brand-resolved tagline (C.tagline) and never cp.tagline / the hardcoded NBD
    // default — for a tenant that set brand.* but not the top-level cp.tagline,
    // cp.tagline is still NBD's default and would otherwise leak (M1, adversarial pass).
    const tagline = (C.name === 'No Big Deal Home Solutions')
      ? (cp.tagline || C.tagline || "No Big Deal — We've Got You Covered")
      : (C.tagline || '');
    const financePartner = cp.financePartner || defaultFinancePartner();

    return page('About ' + C.name, `
      <style>
        .intro-hero { background:linear-gradient(135deg,${S} 0%,#2a2a4e 100%); color:#fff;
          padding:48px 40px; border-radius:12px; text-align:center; margin-bottom:32px; }
        .intro-hero h1 { font-size:32px; margin:0 0 8px; color:#fff; }
        .intro-hero .tagline { color:${A}; font-size:18px; font-style:italic; }
        .svc-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin:20px 0; }
        .svc-card { background:#f8f8f8; border-radius:8px; padding:20px; text-align:center;
          border-top:3px solid ${A}; }
        .svc-icon { font-size:28px; margin-bottom:8px; }
        .svc-name { font-weight:700; font-size:15px; color:${S}; margin-bottom:4px;
          font-family:'Helvetica Neue',Arial,sans-serif; }
        .svc-desc { font-size:12px; color:#666; }
        .value-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:16px; margin:20px 0; }
        .value-card { display:flex; align-items:flex-start; gap:12px; padding:16px;
          background:#fff; border:1px solid #eee; border-radius:8px; }
        .value-icon { font-size:24px; flex-shrink:0; }
        .value-title { font-weight:700; font-size:14px; color:${S};
          font-family:'Helvetica Neue',Arial,sans-serif; }
        .value-desc { font-size:12px; color:#666; margin-top:2px; }
        .testimonial { background:#f8f8f8; border-left:4px solid ${A}; padding:16px 20px;
          margin:12px 0; border-radius:0 8px 8px 0; }
        .testimonial-text { font-style:italic; font-size:14px; color:#444; }
        .testimonial-name { font-size:12px; color:#666; margin-top:8px; font-style:normal; }
        .finance-cta { background:linear-gradient(135deg,${A} 0%,#e0712a 100%); color:#fff;
          padding:24px; border-radius:12px; text-align:center; margin:24px 0; }
      </style>

      <div class="intro-hero">
        <!-- Real NBD logo (data URI from nbd-logo-asset.js). <img> not
             <object> — iframe CSP blocks <object>. -->
        ${LOGO_URL ? `<img class="intro-hero-logo" src="${LOGO_URL}" alt="${C.name}" style="display:block;width:320px;max-width:90%;height:auto;margin:0 auto 14px;background:#fff;border-radius:10px;padding:10px 16px;box-sizing:border-box;"/>` : ''}
        <h1>${C.name}</h1>
        <div class="tagline">${tagline}</div>
        <p style="margin-top:16px;font-size:14px;opacity:0.9;max-width:500px;margin-left:auto;margin-right:auto;">
          Your trusted partner for roofing, exteriors, and storm damage restoration.
          We handle everything from the first inspection to the final nail — so you don't have to stress.</p>
      </div>

      ${services.length || d.serviceArea ? `<div class="section">
        <div class="section-title">Our Services</div>
        ${d.serviceArea ? `<p style="font-size:13px;color:#555;margin:0 0 12px;">Proudly serving <strong>${esc(d.serviceArea)}</strong>.</p>` : ''}
        <div class="svc-grid">
          ${services.map(s => `<div class="svc-card"><div class="svc-icon">${esc(s.icon)}</div>
            <div class="svc-name">${esc(s.name)}</div>${s.desc ? `<div class="svc-desc">${esc(s.desc)}</div>` : ''}</div>`).join('')}
        </div>
      </div>` : ''}

      ${valueProps.length ? `<div class="section">
        <div class="section-title">Why Choose ${C.name.split(' ')[0] === 'No' ? 'NBD' : C.name}?</div>
        <div class="value-grid">
          ${valueProps.map(v => `<div class="value-card"><div class="value-icon">${v.icon}</div><div>
            <div class="value-title">${esc(v.title)}</div>
            <div class="value-desc">${esc(v.desc)}</div></div></div>`).join('')}
        </div>
      </div>` : ''}

      ${d.testimonialsNote ? `<div class="section">
        <div class="section-title">What Our Customers Say</div>
        <div class="testimonial">
          <div class="testimonial-text">${esc(d.testimonialsNote)}</div>
        </div>
      </div>` : ''}

      <div class="section">
        <div class="section-title">Project Photos</div>
        ${photoGrid(4,2)}
      </div>

      ${financePartner ? `<div class="finance-cta">
        <div style="font-size:20px;font-weight:700;">Flexible Financing Available</div>
        <div style="font-size:14px;margin-top:8px;opacity:0.9;">Through our partnership with ${esc(financePartner)} — affordable monthly payments with quick approval.</div>
      </div>` : ''}

      ${affiliateRow()}

      <div style="text-align:center;padding:24px 0;border-top:2px solid ${A};">
        <div style="font-size:20px;font-weight:700;color:${S};font-family:'Helvetica Neue',Arial,sans-serif;">
          Schedule Your Free Inspection</div>
        <div style="font-size:18px;color:${A};font-weight:700;margin-top:8px;">${C.phone}</div>
        <div style="font-size:14px;color:#555;margin-top:4px;">${[C.email, C.website].filter(Boolean).join(' | ')}</div>
      </div>
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 9: BEFORE & AFTER PHOTO REPORT
  // ═══════════════════════════════════════════════════════════════
  DG.renderBeforeAfterReport = function(data) {
    // projectType has NO modal field — leave it empty by default and HIDE the
    // row when blank rather than fabricating "Roof Replacement" on siding/gutter
    // jobs. highlights has no fixed default either: render the section only when
    // the rep supplies bullets (string or array) instead of inventing 5 roofing
    // claims. duration IS collected in the preflight schema — read it below.
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      projectType:'', duration:'', startDate:'[Start Date]', completionDate:today(),
      workDescription:'Complete tear-off and replacement of existing roofing system with new GAF Timberline HDZ architectural shingles, including new underlayment, flashing, ventilation, and gutters.',
      highlights:[] }, data);

    if (!(data && data.workDescription)) {
      const _m = resolveDocManufacturer(d.estimateLineItems);
      if (_m.manufacturer === 'TAMKO') {
        d.workDescription = 'Complete tear-off and replacement of existing roofing system with new ' + _m.manufacturerName + ' architectural shingles, including new underlayment, flashing, ventilation, and gutters.';
      }
    }

    // highlights may arrive as a rep-typed string (newline/bullet/semicolon
    // separated) or an array. Normalize to a clean array; empty → hide section.
    const highlightItems = (Array.isArray(d.highlights)
      ? d.highlights
      : String(d.highlights || '').split(/\r?\n|•|;/))
      .map(h => String(h).trim()).filter(Boolean);

    return page('Before & After Report', `
      <style>
        .ba-header { background:${S}; color:#fff; padding:32px; border-radius:12px; margin-bottom:28px; text-align:center; }
        .ba-label { display:inline-block; padding:6px 20px; border-radius:20px; font-size:13px; font-weight:700;
          font-family:'Helvetica Neue',Arial,sans-serif; letter-spacing:0.06em; margin-bottom:16px; }
        .ba-before { background:#fee2e2; color:#dc2626; }
        .ba-after { background:#dcfce7; color:#16a34a; }
      </style>
      ${letterhead()}
      <div class="ba-header">
        <h1 style="margin:0;color:#fff;font-size:28px;">PROJECT DOCUMENTATION</h1>
        <p style="color:${A};margin:8px 0 0;font-size:14px;">Before & After Photo Report</p>
      </div>

      <div class="section">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;">
          <div><strong>Property Owner:</strong> ${esc(d.homeownerName)}</div>
          ${d.projectType ? `<div><strong>Project:</strong> ${esc(d.projectType)}</div>` : ''}
          <div><strong>Address:</strong> ${esc(d.address)}</div>
          <div><strong>Completed:</strong> ${esc(d.completionDate)}</div>
          ${d.duration ? `<div><strong>Duration:</strong> ${esc(d.duration)}</div>` : ''}
        </div>
      </div>

      <div class="section">
        <div class="ba-label ba-before">BEFORE</div>
        <div class="section-title">Pre-Project Condition</div>
        ${photoGridReal(d.beforePhotos, 3)}
        <p style="font-size:12px;color:#666;text-align:center;margin-top:8px;">
          Add captions describing damage or existing conditions below each photo.</p>
      </div>

      <div class="section">
        <div class="section-title">Work Performed</div>
        <p style="font-size:14px;">${esc(d.workDescription)}</p>
      </div>

      <div class="section">
        <div class="ba-label ba-after">AFTER</div>
        <div class="section-title">Completed Project</div>
        ${photoGridReal(d.afterPhotos, 3)}
        <p style="font-size:12px;color:#666;text-align:center;margin-top:8px;">
          Add captions highlighting improvements and quality of work.</p>
      </div>

      ${highlightItems.length ? `<div class="section">
        <div class="section-title">Project Highlights</div>
        <ul style="font-size:14px;line-height:2;padding-left:24px;">
          ${highlightItems.map(h => `<li>${esc(h)}</li>`).join('')}
        </ul>
      </div>` : ''}

      ${sigBlock(['Homeowner Acknowledgment'])}
      ${affiliateRow()}
      ${footer('Before & After Report')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 10: FINANCING OPTIONS
  // ═══════════════════════════════════════════════════════════════
  DG.renderFinancingOptions = function(data) {
    const d = Object.assign({ homeownerName:'', totalPrice:10000 }, data);
    const cp = tenantCp(d);
    // totalPrice arrives $-formatted from the preflight bridge (jobTotal→totalPrice),
    // so strip non-numerics before parsing or it would NaN→fabricate the $10k default.
    const price = parseFloat(String(d.totalPrice).replace(/[^0-9.]/g, '')) || 10000;
    // A company with no finance partner on file (every non-NBD company until
    // it enters one) gets a generic lender phrase, never NBD's Acorn Finance.
    const financePartner = cp.financePartner || defaultFinancePartner() || 'a third-party lender';
    // apr 0 is the "rate set by the lender" sentinel: under a lending
    // marketplace (Acorn) the contractor doesn't control terms, so the
    // defaults must not print fabricated APRs or payments on customer
    // paper. A tenant with their own fixed-rate program (Hearth, GreenSky,
    // in-house) enters real APRs in Settings and gets computed payments.
    const tierDefaults = [
      { months:12, apr:0, label:'12 Months', badge:'Short Term', color:'#16a34a' },
      { months:36, apr:0, label:'36 Months', badge:'Mid Term',   color:'#0ea5e9' },
      { months:60, apr:0, label:'60 Months', badge:'Long Term',  color:'#7c3aed' }
    ];
    const tiers = Array.isArray(cp.financingTiers) && cp.financingTiers.length ? cp.financingTiers : tierDefaults;
    // apr <= 0 means "rate set by the lender" — refuse to print a fabricated
    // $/mo (the old straight-line math implied a no-cost financing program the
    // marketplace can't promise). Only a tenant-entered positive APR (their
    // own financing program) computes an amortized illustrative payment.
    const plans = tiers.map(t => {
      const months = Number(t.months) || 12;
      const apr = Number(t.apr) || 0;
      const lenderSet = apr <= 0;
      let monthly = 0;
      if (!lenderSet) {
        const r = apr / 100 / 12;
        monthly = (price * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
      }
      return {
        months,
        apr,
        lenderSet,
        label: t.label || (months + ' Months'),
        badge: t.badge || '',
        color: t.color || '#0ea5e9',
        monthly
      };
    });

    return page('Financing Options', `
      <style>
        .fin-hero { background:linear-gradient(135deg,${S} 0%,#2a2a4e 100%); color:#fff;
          padding:40px; border-radius:12px; text-align:center; margin-bottom:28px; }
        .plan-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; margin:24px 0; }
        .plan-card { border:2px solid #eee; border-radius:12px; padding:24px; text-align:center;
          transition:border-color 0.2s; }
        .plan-card:hover { border-color:${A}; }
        .plan-badge { display:inline-block; padding:4px 12px; border-radius:12px; font-size:11px;
          font-weight:700; color:#fff; margin-bottom:12px; }
        .plan-monthly { font-size:36px; font-weight:700; color:${S}; }
        .plan-monthly span { font-size:14px; font-weight:400; color:#666; }
        .plan-details { font-size:13px; color:#666; margin-top:8px; }
        .step-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:20px; margin:24px 0; }
        .step-card { text-align:center; padding:20px; }
        .step-num { width:40px; height:40px; border-radius:50%; background:${A}; color:#fff;
          display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:700;
          margin:0 auto 12px; }
      </style>
      ${letterhead()}
      <div class="fin-hero">
        <h1 style="margin:0;color:#fff;font-size:28px;">FLEXIBLE FINANCING OPTIONS</h1>
        <p style="color:${A};margin:12px 0 0;font-size:16px;">
          Make your home improvement project affordable with easy monthly payments</p>
        ${d.homeownerName ? `<p style="margin:16px 0 0;font-size:14px;opacity:0.8;">Prepared for: ${esc(d.homeownerName)}</p>` : ''}
      </div>

      <div class="section" style="text-align:center;">
        <p style="font-size:16px;color:#555;">We've partnered with <strong style="color:${A};">${esc(financePartner)}</strong> to offer
        flexible financing solutions. Check your options with a soft credit pull — pre-qualifying doesn't impact your
        credit score, and offers come from a network of vetted lenders.</p>
        ${price ? `<div style="margin:20px 0;"><div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.06em;">
          Project Total</div><div style="font-size:32px;font-weight:700;color:${S};">${money(price)}</div></div>` : ''}
      </div>

      <div class="section">
        <div class="section-title">Choose Your Plan</div>
        <div class="plan-grid">
          ${plans.map(p => `<div class="plan-card">
            <div class="plan-badge" style="background:${p.color};">${p.badge}</div>
            <div style="font-size:16px;font-weight:700;color:${S};margin-bottom:4px;">${p.label}</div>
            ${p.lenderSet
              ? `<div class="plan-monthly" style="font-size:17px;line-height:1.45;padding:6px 0;">Rate &amp; payment<br>set by your lender</div>
            <div class="plan-details">${p.months}-month term | soft-pull pre-qual</div>`
              : `<div class="plan-monthly">${money(p.monthly)}<span>/mo</span></div>
            <div class="plan-details">${p.apr}% APR | ${p.months} payments</div>`}
          </div>`).join('')}
        </div>
        <p style="font-size:11px;color:#999;text-align:center;">
          *Where a monthly payment is shown it is an illustrative estimate only. ${esc(financePartner)} is a lending
          marketplace — your actual rate, term, and monthly payment are set by the lender you choose and depend on
          your credit profile. All financing subject to credit approval.</p>
      </div>

      <div class="section">
        <div class="section-title">How It Works</div>
        <div class="step-grid">
          <div class="step-card"><div class="step-num">1</div>
            <div style="font-weight:700;font-size:15px;color:${S};margin-bottom:4px;">Apply Online</div>
            <div style="font-size:13px;color:#666;">Quick 2-minute application. No hard credit pull for pre-qualification.</div></div>
          <div class="step-card"><div class="step-num">2</div>
            <div style="font-weight:700;font-size:15px;color:${S};margin-bottom:4px;">See Your Offers</div>
            <div style="font-size:13px;color:#666;">Real offers from multiple lenders in about a minute — compare rate, term, and payment side by side.</div></div>
          <div class="step-card"><div class="step-num">3</div>
            <div style="font-weight:700;font-size:15px;color:${S};margin-bottom:4px;">Choose Your Plan</div>
            <div style="font-size:13px;color:#666;">Pick the payment plan that works best for your budget. Start your project!</div></div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Benefits of Financing</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;">
          <div style="padding:12px;background:#f8f8f8;border-radius:6px;">No money down options available</div>
          <div style="padding:12px;background:#f8f8f8;border-radius:6px;">Fixed monthly payments — no surprises</div>
          <div style="padding:12px;background:#f8f8f8;border-radius:6px;">No prepayment penalties</div>
          <div style="padding:12px;background:#f8f8f8;border-radius:6px;">Quick and easy application process</div>
        </div>
      </div>

      <div style="background:#f8f8f8;padding:20px;border-radius:8px;margin:24px 0;text-align:center;">
        <div style="font-size:18px;font-weight:700;color:${S};">Ready to Get Started?</div>
        <div style="font-size:14px;color:#555;margin-top:8px;">
          Call <strong style="color:${A};">${C.phone}</strong> or visit <strong style="color:${A};">${C.website}</strong></div>
      </div>

      <p style="font-size:10px;color:#999;text-align:center;margin-top:24px;">
        Subject to credit approval. Interest rates and terms may vary based on creditworthiness. Financing provided by
        ${esc(financePartner)} and its lending partners. ${C.name} is not a lender and does not make credit decisions.
        See ${esc(financePartner)} for full terms, conditions, and disclosures.</p>

      ${affiliateRow()}
      ${footer('Financing Options')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 11: REFERRAL CARD
  // ═══════════════════════════════════════════════════════════════
  DG.renderReferralCard = function(data) {
    const d = Object.assign({}, data);
    // Rep-entered fields (DocPreflight keys). Keep prior hardcoded copy as the
    // blank-field fallback so an empty modal still yields a complete card.
    const referredBy = ((d.firstName || '') + ' ' + (d.lastName || '')).trim()
      || (d.homeownerName || '').trim();
    const rewardLabel = (d.bonusAmount !== undefined && d.bonusAmount !== null && d.bonusAmount !== '')
      ? money(d.bonusAmount)
      : 'Ask Us For Details!';
    const terms = d.terms || 'Referral reward is paid after referred project is completed. See us for full program details and terms.';

    return page('Referral Card', `
      <style>
        .ref-card { max-width:5.5in; margin:0 auto; border:3px solid ${A}; border-radius:16px;
          overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
        .ref-top { background:linear-gradient(135deg,${S} 0%,#2a2a4e 100%); color:#fff;
          padding:28px 24px; text-align:center; }
        .ref-top h2 { margin:0; font-size:22px; color:#fff; line-height:1.3; }
        /* Width-only sizing keeps the natural 1.5:1 aspect of the source
           logo, so the white card hugs the artwork. */
        .ref-logo { display:block; width:140px; height:auto; margin:0 auto 14px;
          background:#fff; border-radius:10px; padding:8px 14px; box-sizing:border-box; }
        .ref-body { padding:24px; background:#fff; }
        .ref-reward { background:#fff8f5; border:2px dashed ${A}; border-radius:8px;
          padding:16px; text-align:center; margin:16px 0; }
        .ref-steps { margin:16px 0; }
        .ref-step { display:flex; align-items:flex-start; gap:12px; margin:12px 0; font-size:14px; }
        .ref-step-num { width:28px; height:28px; border-radius:50%; background:${A}; color:#fff;
          display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:700; flex-shrink:0; }
        .ref-from { border-top:2px solid #eee; padding-top:16px; margin-top:20px; }
        .ref-contact { background:${S}; color:#fff; padding:16px; text-align:center;
          font-size:13px; line-height:1.8; }
      </style>

      <div class="ref-card">
        <div class="ref-top">
          ${LOGO_URL ? `<img class="ref-logo" src="${LOGO_URL}" alt="${C.name}"/>` : ''}
          <h2>KNOW SOMEONE WHO<br>NEEDS A NEW ROOF?</h2>
          <p style="margin:8px 0 0;font-size:14px;color:${A};">Refer them to ${C.name}!</p>
        </div>
        <div class="ref-body">
          <div class="ref-reward">
            <div style="font-size:12px;color:#666;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:4px;">Referral Reward</div>
            <div style="font-size:20px;font-weight:700;color:${A};">${esc(rewardLabel)}</div>
            <div style="font-size:12px;color:#888;margin-top:4px;">Earn rewards for every referral that becomes a project</div>
            ${d.referralCode ? `<div style="font-size:13px;color:${S};margin-top:10px;">Referral Code: <strong style="letter-spacing:0.04em;">${esc(d.referralCode)}</strong></div>` : ''}
          </div>

          <div class="ref-steps">
            <div style="font-size:13px;font-weight:700;color:${S};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">How It Works</div>
            <div class="ref-step"><div class="ref-step-num">1</div><div>Share our number or pass along this card to someone you know</div></div>
            <div class="ref-step"><div class="ref-step-num">2</div><div>Have them mention your name when they call or schedule</div></div>
            <div class="ref-step"><div class="ref-step-num">3</div><div>Get rewarded once their project is completed!</div></div>
          </div>

          <div class="ref-from">
            <div style="font-size:12px;color:#666;margin-bottom:8px;">Referred by:</div>
            ${referredBy
              ? `<div style="border-bottom:2px solid #333;height:28px;font-size:15px;font-weight:600;color:${S};">${esc(referredBy)}</div>`
              : `<div style="border-bottom:2px solid #333;height:28px;"></div>`}
          </div>
        </div>
        <div class="ref-contact">
          <strong>${C.name}</strong><br>
          ${[C.phone, C.email].filter(Boolean).join(' | ')}${C.website ? `<br>
          ${C.website}` : ''}
        </div>
      </div>

      <p style="text-align:center;font-size:10px;color:#999;margin-top:20px;">
        ${esc(terms)}</p>
    `);
  };

  // (TEMPLATE 12 — the Assignment of Benefits, then a Direction to Pay — was
  // retired 2026-09-27: no assignment or co-payee instrument in any state.)

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 13: MATERIAL DELIVERY NOTICE
  // ═══════════════════════════════════════════════════════════════
  DG.renderMaterialDelivery = function(data) {
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      deliveryDate:'[Delivery Date]', deliveryTime:'Between 7:00 AM and 12:00 PM',
      startDate:'[Project Start Date]',
      materials:[
        {item:'GAF Timberline HDZ Architectural Shingles',qty:'30 bundles',notes:'Color: Charcoal'},
        {item:'GAF FeltBuster Synthetic Underlayment',qty:'6 rolls',notes:''},
        {item:'GAF Cobra Ridge Vent',qty:'4 pieces',notes:''},
        {item:'Drip Edge Flashing (Aluminum)',qty:'120 LF',notes:'Color-matched'},
        {item:'Ice & Water Shield',qty:'2 rolls',notes:'Eaves and valleys'},
        {item:'Pipe Boot Flashings',qty:'4 units',notes:''},
        {item:'Starter Strip Shingles',qty:'6 bundles',notes:''},
        {item:'Roofing Nails (1.25")',qty:'4 boxes',notes:''}
      ] }, data);

    return page('Material Delivery Notice', `
      ${letterhead()}
      <h1 style="text-align:center;font-size:24px;color:${S};margin:24px 0 8px;">MATERIAL DELIVERY NOTICE</h1>
      <p style="text-align:center;color:#666;font-size:13px;margin-bottom:28px;">Advance Notice of Project Material Delivery</p>

      <div class="section" style="background:linear-gradient(135deg,${S} 0%,#2a2a4e 100%);color:#fff;padding:28px;border-radius:12px;">
        <p style="font-size:16px;line-height:1.8;margin:0;">
          Dear <strong>${esc(d.homeownerName)}</strong>,<br><br>
          We are writing to let you know that materials for your upcoming project will be delivered to your property.
          Below are the details for your reference.
        </p>
      </div>

      <div class="section" style="margin-top:24px;">
        <div class="section-title">Delivery Details</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;font-size:14px;">
          <div style="background:#f8f8f8;padding:16px;border-radius:8px;">
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Delivery Date</div>
            <div style="font-size:18px;font-weight:700;color:${S};">${esc(d.deliveryDate)}</div>
          </div>
          <div style="background:#f8f8f8;padding:16px;border-radius:8px;">
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Delivery Window</div>
            <div style="font-size:18px;font-weight:700;color:${S};">${esc(d.deliveryTime)}</div>
          </div>
          <div style="background:#f8f8f8;padding:16px;border-radius:8px;">
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Property</div>
            <div style="font-size:14px;font-weight:600;color:${S};">${esc(d.address)}</div>
          </div>
          <div style="background:#f8f8f8;padding:16px;border-radius:8px;">
            <div style="font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Project Start</div>
            <div style="font-size:14px;font-weight:600;color:${S};">${esc(d.startDate)}</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Materials Being Delivered</div>
        <table class="items">
          <thead><tr><th>Material</th><th>Quantity</th><th>Notes</th></tr></thead>
          <tbody>${d.materials.map(m =>
            `<tr><td>${esc(m.item)}</td><td>${esc(m.qty)}</td><td>${esc(m.notes)}</td></tr>`
          ).join('')}</tbody>
        </table>
      </div>

      <div class="section">
        <div class="section-title">What to Expect</div>
        <ul style="font-size:14px;line-height:2;padding-left:24px;">
          <li>Materials will be placed in your driveway or alongside the home — our crew will position them for easy access.</li>
          <li>A delivery truck will need clear access to your driveway. Please move vehicles if possible.</li>
          <li>You do not need to be home for delivery, but please ensure gates are accessible.</li>
          <li>Materials may remain on the property for 1–3 days before the crew arrives — this is normal.</li>
          <li>Do not move, open, or disturb delivered materials — our crew will handle everything on project day.</li>
        </ul>
      </div>

      <div class="section" style="background:#f0fdf4;padding:20px;border-radius:8px;border:1px solid #bbf7d0;">
        <p style="font-size:14px;margin:0;color:#166534;">
          <strong>Questions?</strong> Call us at <strong>${C.phone}</strong> or email <strong>${C.email}</strong>.
          We are always happy to help.
        </p>
      </div>

      ${footer('Material Delivery Notice')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 14: STORM DAMAGE CHECKLIST
  // ═══════════════════════════════════════════════════════════════
  DG.renderStormChecklist = function(data) {
    const d = Object.assign({}, data);

    const sections = [
      { title:'Roof', icon:'🏠', items:[
        'Missing, cracked, or curling shingles',
        'Exposed or damaged underlayment',
        'Dents or dimples on ridge cap or vents',
        'Granule loss in gutters or around downspouts',
        'Damaged or displaced flashing',
        'Sagging areas or visible structural damage',
        'Exposed nail heads or lifted shingle tabs'
      ]},
      { title:'Gutters & Downspouts', icon:'🌧️', items:[
        'Dents, dings, or crush marks on gutters',
        'Gutters pulled away from fascia board',
        'Clogged or overflowing gutter runs',
        'Downspout damage or disconnection',
        'Pooling water or improper drainage'
      ]},
      { title:'Siding & Exterior', icon:'🧱', items:[
        'Cracked, chipped, or broken siding panels',
        'Holes or punctures from hail or debris',
        'Faded or discolored siding from storm impact',
        'Loose or missing trim or soffit',
        'Paint damage or peeling from moisture'
      ]},
      { title:'Windows & Doors', icon:'🪟', items:[
        'Cracked or shattered glass',
        'Damaged screens or frames',
        'Broken seals causing fogging between panes',
        'Water intrusion around window or door frames',
        'Damaged weatherstripping or caulk'
      ]},
      { title:'Interior Warning Signs', icon:'🏚️', items:[
        'Water stains on ceilings or walls',
        'Peeling paint or bubbling drywall',
        'Musty odor indicating moisture or mold',
        'Light visible through the roof in the attic',
        'Damp insulation in the attic'
      ]}
    ];

    return page('Storm Damage Checklist', `
      <style>
        .storm-hero { background:linear-gradient(135deg,#1e3a5f 0%,${S} 100%); color:#fff;
          padding:40px; border-radius:12px; text-align:center; margin-bottom:28px; }
        .check-section { margin-bottom:24px; border:1px solid #eee; border-radius:8px; overflow:hidden; }
        .check-header { display:flex; align-items:center; gap:12px; padding:16px 20px;
          background:#f8f8f8; border-bottom:1px solid #eee; }
        .check-list { padding:12px 20px; }
        .check-row { display:flex; align-items:center; gap:12px; padding:10px 0;
          border-bottom:1px solid #f5f5f5; font-size:14px; }
        .check-row:last-child { border-bottom:none; }
        .check-box { width:20px; height:20px; border:2px solid #ccc; border-radius:4px; flex-shrink:0; }
      </style>
      ${letterhead()}
      <div class="storm-hero">
        <h1 style="margin:0;color:#fff;font-size:28px;">STORM DAMAGE CHECKLIST</h1>
        <p style="color:${A};margin:12px 0 0;font-size:16px;">Free Inspection Reference Guide</p>
        ${(d.stormType || d.stormDate) ? `<p style="margin:10px 0 0;font-size:14px;font-weight:600;color:#fff;">
          ${d.stormType ? `${esc(d.stormType)} Storm` : 'Storm Event'}${d.stormDate ? ` &middot; ${esc(d.stormDate)}` : ''}</p>` : ''}
        <p style="margin:16px 0 0;font-size:13px;opacity:0.85;max-width:500px;margin-left:auto;margin-right:auto;">
          After a storm, use this checklist to identify potential damage to your property.
          Mark anything you notice and contact us for a professional inspection — always free, always no obligation.</p>
      </div>

      ${sections.map(s => `<div class="check-section">
        <div class="check-header">
          <span style="font-size:24px;">${s.icon}</span>
          <h3 style="margin:0;font-size:16px;color:${S};font-family:'Helvetica Neue',Arial,sans-serif;">${s.title}</h3>
        </div>
        <div class="check-list">
          ${s.items.map(i => `<div class="check-row">
            <div class="check-box"></div>
            <span>${esc(i)}</span>
          </div>`).join('')}
        </div>
      </div>`).join('')}

      ${d.checklistNotes ? `<div class="section" style="border:1px solid #eee;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
        <h3 style="margin:0 0 8px;font-size:15px;color:${S};font-family:'Helvetica Neue',Arial,sans-serif;">Additional Notes</h3>
        <div style="font-size:14px;color:#555;line-height:1.6;white-space:pre-wrap;">${esc(d.checklistNotes)}</div>
      </div>` : ''}

      <div class="section" style="background:${A};color:#fff;padding:28px;border-radius:12px;text-align:center;">
        <div style="font-size:20px;font-weight:700;">Found Damage? We Can Help.</div>
        <div style="font-size:14px;margin-top:8px;opacity:0.9;">
          Schedule your free, no-obligation inspection today.</div>
        <div style="font-size:22px;font-weight:700;margin-top:12px;">${esc(d.emergencyPhone) || C.phone}</div>
        <div style="font-size:13px;margin-top:4px;opacity:0.8;">${[C.email, C.website].filter(Boolean).join(' | ')}</div>
      </div>

      ${affiliateRow()}

      <p style="font-size:10px;color:#999;text-align:center;margin-top:20px;">
        This checklist is for reference only and does not constitute a professional inspection.
        ${C.name} recommends a licensed contractor inspect any suspected damage. We provide free inspections with no obligation.</p>
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE: 5-YEAR STORM HISTORY REPORT
  // ═══════════════════════════════════════════════════════════════
  // Renders the same free NOAA/NWS Local Storm Reports data the public
  // /storm-report lead-magnet already pulls (functions/storm-report.js —
  // 5 years, 30 mi radius, no API key, no per-call cost) as a branded
  // document a rep can hand an adjuster in place of a paid third-party
  // weather-verification report (e.g. GAF's). NBDDocGen.generate() attaches
  // `data.stormReport` (or `data._stormReportError`) BEFORE this template
  // runs — see document-generator.js:_attachStormHistory — so this stays a
  // pure, synchronous renderer like every other template in this file.
  DG.renderStormHistoryReport = function(data) {
    const d = Object.assign({}, data);
    const sr = d.stormReport || null;
    const addr = esc(d.address || d.homeownerAddress || 'the property');
    const genDate = d.date || new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    if (!sr) {
      // Best-effort failure path — no address, a geocode miss, or the
      // NOAA/IEM proxy was down. Never a blank/broken document.
      return page('Storm History Report', `
        ${letterhead()}
        <div class="section" style="text-align:center;padding:60px 20px;">
          <div style="font-size:40px;margin-bottom:12px;">&#9928;&#65039;</div>
          <h1 style="color:${S};font-size:22px;">Storm History Unavailable</h1>
          <p style="color:#666;font-size:14px;max-width:440px;margin:12px auto 0;">
            We couldn't pull verified NOAA storm history for ${addr} right now${d._stormReportError ? ' (' + esc(d._stormReportError) + ')' : ''}.
            Make sure the property has a complete, geocodable address on file, then try again.
          </p>
        </div>
        ${footer('Storm History Report')}
      `);
    }

    const c = sr.counts || {};
    const events = Array.isArray(sr.events) ? sr.events : [];
    // Notable-first, same triage the public tool uses: hail + tornado +
    // any non-minor wind, newest first, capped so the printed doc stays a
    // page or two instead of 200 rows of minor wind reports.
    let notable = events.filter(e => e.type !== 'wind' || e.severity !== 'minor').slice(0, 60);
    if (!notable.length) notable = events.slice(0, 30);
    const fmtDate = (s) => { try { return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch (_) { return '—'; } };
    const typeColor = { hail: '#2563eb', wind: '#16a34a', tornado: '#dc2626' };
    const stat = (v, l) => `<div style="flex:1;min-width:90px;background:${WSH};border:1px solid ${RL};border-radius:10px;padding:12px 8px;text-align:center;">
      <div style="font-size:24px;font-weight:800;color:${A};line-height:1;">${v}</div>
      <div style="font-size:10px;color:${G};text-transform:uppercase;letter-spacing:.05em;font-weight:700;margin-top:4px;">${l}</div></div>`;

    return page('Storm History Report', `
      <style>
        .shr-hero { background:linear-gradient(135deg,#1e3a5f 0%,${S} 100%); color:#fff;
          padding:32px; border-radius:12px; margin-bottom:24px; }
        .shr-table { width:100%; border-collapse:collapse; font-size:12.5px; }
        .shr-table th { background:${WSH}; text-align:left; padding:9px 10px; font-size:10px;
          text-transform:uppercase; letter-spacing:.05em; color:${G}; border-bottom:1px solid ${RL}; }
        .shr-table td { padding:8px 10px; border-bottom:1px solid ${WSH}; color:${INK}; }
        .shr-tag { display:inline-block; font-size:10px; font-weight:800; text-transform:uppercase;
          padding:2px 8px; border-radius:4px; color:#fff; }
      </style>
      ${letterhead()}
      <div class="shr-hero">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.1em;opacity:.75;">5-Year Verified Storm History</div>
        <h1 style="margin:6px 0 2px;color:#fff;font-size:26px;">${addr}</h1>
        <div style="font-size:12px;opacity:.8;">Prepared ${esc(genDate)} &middot; ${sr.radiusMi || 30} mi radius &middot; ${sr.years || 5}-year lookback</div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:22px;">
        ${stat(c.total || 0, 'Total Events')}
        ${stat(c.hail || 0, 'Hail')}
        ${stat(c.wind || 0, 'Wind')}
        ${stat(c.tornado || 0, 'Tornado')}
        ${stat((sr.maxHail || 0) + '&Prime;', 'Max Hail Size')}
        ${stat(c.stormDays || 0, 'Storm Days')}
      </div>

      <div class="section" style="border:1px solid ${RL};border-radius:10px;overflow:hidden;margin-bottom:8px;">
        <table class="shr-table">
          <thead><tr><th>Date</th><th>Type</th><th>Magnitude</th><th>Distance</th><th>Nearest City</th></tr></thead>
          <tbody>
            ${notable.length ? notable.map(e => `<tr>
              <td>${fmtDate(e.date)}</td>
              <td><span class="shr-tag" style="background:${typeColor[e.type] || '#888'};">${esc(e.type || '—')}</span></td>
              <td>${e.magnitude ? esc(String(e.magnitude)) + esc(e.unit || '') : '—'}</td>
              <td>${e.distanceMi != null ? e.distanceMi + ' mi' : '—'}</td>
              <td>${esc(e.city || '—')}</td>
            </tr>`).join('') : `<tr><td colspan="5" style="text-align:center;color:${G};padding:20px;">No individual storm reports on file within range.</td></tr>`}
          </tbody>
        </table>
      </div>
      <p style="font-size:10.5px;color:${G};margin:6px 0 24px;">
        Source: ${esc(sr.source || 'NWS Local Storm Reports (NOAA) via Iowa Environmental Mesonet')}.
        Publicly available, independently verifiable government weather data — not a paid third-party
        weather-verification service. This report documents recorded storm activity near the property;
        it is not an inspection and does not determine whether damage occurred or whether a claim will
        be approved. A free on-site inspection is the next step to confirm actual roof condition.
      </p>

      ${(() => {
        // Honesty gate: don't claim "verified storm activity" on a report
        // that found none — this document exists to be handed to an
        // adjuster, so it has to stay accurate at zero just as much as at
        // a high count. Mirrors the public /storm-report tool's own
        // three-tier verdict() (storm-report-page.js) rather than a single
        // static claim regardless of what the data actually shows.
        const hasNotable = notable.length > 0 && (c.hail || c.tornado || c.wind);
        const headline = c.total > 0
          ? (hasNotable ? 'Verified storm activity near this property.' : 'Some storm activity on record — mostly minor.')
          : 'No storm reports on file for this property in the lookback window.';
        const body = c.total > 0
          ? 'The next step is a free, no-obligation roof inspection to document any damage.'
          : 'That doesn’t rule out damage — a free on-site inspection is still the only way to know for sure.';
        return `<div class="section" style="background:${A};color:#fff;padding:24px;border-radius:12px;text-align:center;">
        <div style="font-size:18px;font-weight:700;">${esc(headline)}</div>
        <div style="font-size:13px;margin-top:6px;opacity:.9;">${esc(body)}</div>
        <div style="font-size:20px;font-weight:700;margin-top:10px;">${esc(d.emergencyPhone) || C.phone}</div>
      </div>`;
      })()}

      ${footer('Storm History Report — ' + (sr.years || 5) + '-Year NOAA Data')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 15: INSURANCE CLAIM PROCESS GUIDE
  // ═══════════════════════════════════════════════════════════════
  DG.renderClaimGuide = function(data) {
    const d = Object.assign({}, data);

    // Rep-entered fields (DocPreflight keys). Carrier is concrete data with a
    // schema field but no fabricated default — show only when supplied. Timeline
    // and the "What to Expect" notes keep their prior hardcoded copy as fallback
    // so a blank field still yields a complete document.
    const insCarrier = esc(d.insCarrier);
    const timeline = esc(d.timeline) || '30-60 days from claim filing';
    const guideNotes = esc(d.guideNotes)
      || 'Adjuster will contact you within 48-72 hours of filing. We will meet the adjuster on-site to review damage together.';

    const steps = [
      { num:1, title:'Document the Damage', desc:'Take photos and video of all visible damage from multiple angles. Include wide shots and close-ups. Note the date and time of the storm.', icon:'📸' },
      { num:2, title:'File Your Claim', desc:'Contact your insurance company to file a claim. Provide the date of loss, description of damage, and your policy number. Write down your claim number.', icon:'📞' },
      { num:3, title:'Schedule Your Free Inspection', desc:'Call us to schedule a no-cost professional inspection. We will document all damage using industry standards and create a comprehensive report.', icon:'🔍' },
      { num:4, title:'Meet the Adjuster', desc:'Your insurance company will send an adjuster to assess the damage. After you have filed, we can be there to walk the adjuster through the damage we documented.', icon:'🤝' },
      { num:5, title:'Review the Estimate', desc:'Once the insurance company issues its estimate, we compare it with our own repair estimate. If items are missing, we give you our estimate and supporting photos, and you decide what to send your insurer.', icon:'📋' },
      { num:6, title:'Approve & Schedule', desc:'Once you have your insurer’s decision and approve the scope of work, we handle scheduling, permits and coordination for the repair.', icon:'✅' },
      { num:7, title:'Project Completion', desc:'Our crew completes the work to the highest standard. We conduct a final walkthrough with you to ensure complete satisfaction before closing out the project.', icon:'🏠' }
    ];

    return page('Insurance Claim Process Guide', `
      <style>
        .guide-hero { background:linear-gradient(135deg,${S} 0%,#2a2a4e 100%); color:#fff;
          padding:40px; border-radius:12px; text-align:center; margin-bottom:32px; }
        .step-row { display:flex; align-items:flex-start; gap:20px; padding:20px 0;
          border-bottom:1px solid #f0f0f0; }
        .step-row:last-child { border-bottom:none; }
        .step-bubble { width:48px; height:48px; border-radius:50%; background:${A}; color:#fff;
          display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:700;
          flex-shrink:0; box-shadow:0 2px 8px rgba(189,87,40,0.3); }
        .step-content h3 { margin:0 0 6px; font-size:16px; color:${S}; font-family:'Helvetica Neue',Arial,sans-serif; }
        .step-content p { margin:0; font-size:14px; color:#555; line-height:1.6; }
        .faq-item { margin-bottom:16px; }
        .faq-q { font-weight:700; font-size:14px; color:${S}; margin-bottom:4px; }
        .faq-a { font-size:13px; color:#555; line-height:1.6; }
      </style>
      ${letterhead()}
      <div class="guide-hero">
        <h1 style="margin:0;color:#fff;font-size:28px;">YOUR INSURANCE CLAIM</h1>
        <h2 style="margin:8px 0 0;font-size:18px;color:${A};font-weight:400;">Step-by-Step Process Guide</h2>
        <p style="margin:16px 0 0;font-size:14px;opacity:0.9;max-width:500px;margin-left:auto;margin-right:auto;">
          Filing an insurance claim can feel overwhelming. This guide walks you through every step
          so you know exactly what to expect. We handle the hard parts — so it really is no big deal.</p>
        ${insCarrier ? `<div style="margin:16px 0 0;font-size:13px;color:#fff;opacity:0.92;">
          Prepared for your claim with <strong>${insCarrier}</strong></div>` : ''}
      </div>

      <div class="section">
        <div class="section-title">What to Expect</div>
        <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 12px;white-space:pre-line;">${guideNotes}</p>
        <div style="background:#f7f7fb;border-left:4px solid ${A};padding:12px 16px;border-radius:6px;">
          <div style="font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:${S};font-weight:700;">Expected Timeline</div>
          <div style="font-size:14px;color:#333;margin-top:4px;">${timeline}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">The 7-Step Process</div>
        ${steps.map(s => `<div class="step-row">
          <div class="step-bubble">${s.num}</div>
          <div class="step-content">
            <h3>${s.icon} ${s.title}</h3>
            <p>${s.desc}</p>
          </div>
        </div>`).join('')}
      </div>

      <div class="section">
        <div class="section-title">Common Questions</div>
        <div class="faq-item">
          <div class="faq-q">Will filing a claim raise my insurance rates?</div>
          <div class="faq-a">Storm damage claims are typically classified as "Acts of God" and generally do not result in rate increases. Your insurance exists for exactly this purpose.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">What is my deductible?</div>
          <div class="faq-a">Your deductible is the amount you pay out of pocket before insurance covers the rest. It is listed on your policy declarations page. We can help you locate it.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">How long does the process take?</div>
          <div class="faq-a">Most claims are approved within 2–4 weeks. Once approved, we typically begin work within 1–2 weeks depending on crew and material availability.</div>
        </div>
        <div class="faq-item">
          <div class="faq-q">What if the insurance estimate is too low?</div>
          <div class="faq-a">We compare it line by line with our own estimate. If it does not cover the full scope of necessary repairs, we give you our estimate and supporting documentation. You manage your claim and decide what to send your insurer.</div>
        </div>
      </div>

      <div class="section" style="background:${A};color:#fff;padding:28px;border-radius:12px;text-align:center;">
        <div style="font-size:20px;font-weight:700;">Ready to Get Started?</div>
        <div style="font-size:14px;margin-top:8px;opacity:0.9;">Call us today for your free inspection. We will walk you through every step.</div>
        <div style="font-size:22px;font-weight:700;margin-top:12px;">${C.phone}</div>
        <div style="font-size:13px;margin-top:4px;opacity:0.8;">${[C.email, C.website].filter(Boolean).join(' | ')}</div>
      </div>

      ${footer('Insurance Claim Process Guide')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 16: DOOR HANGER
  // ═══════════════════════════════════════════════════════════════
  DG.renderDoorHanger = function(data) {
    const d = Object.assign({}, data);
    const cp = tenantCp(d);
    // Door-hanger services: a per-doc override the rep types in DocPreflight
    // (the `services` field) wins; it's a free-text list separated by bullets,
    // newlines, or commas. When blank, derive from the profile services list so
    // edits in Settings propagate here; falling back to a sensible default set.
    const repServices = (typeof d.services === 'string' ? d.services : '')
      .split(/\s*[•\n,]\s*/).map(s => s.trim()).filter(Boolean);
    const hangerServices = repServices.length
      ? repServices
      : (Array.isArray(cp.services) && cp.services.length
        ? cp.services.map(s => `${s.name} — ${s.desc}`)
        : !isNbdDoc() ? [] : [
            'Roofing — replacements, repairs, storm damage',
            'Siding — vinyl, fiber cement, LP SmartSide',
            'Gutters — seamless systems and guards',
            'Windows & Doors — energy-efficient upgrades',
            'Insurance Claims — handled start to finish'
          ]);

    return page('Door Hanger', `
      <style>
        .hanger { max-width:4in; margin:0 auto; border:2px solid ${A}; border-radius:16px;
          overflow:hidden; box-shadow:0 4px 20px rgba(0,0,0,0.1); }
        .hanger-top { background:linear-gradient(180deg,${S} 0%,#2a2a4e 100%); color:#fff;
          padding:32px 24px 24px; text-align:center; position:relative; }
        .hanger-hole { width:36px; height:36px; border-radius:50%; border:3px solid ${A};
          background:#fff; margin:0 auto 16px; }
        /* Width-only sizing — natural 1.5:1 aspect of the source logo. */
        .hanger-logo { display:block; width:120px; height:auto; margin:0 auto 12px;
          background:#fff; border-radius:8px; padding:6px 10px; box-sizing:border-box; }
        .hanger-body { padding:24px; background:#fff; }
        .hanger-cta { background:${A}; color:#fff; padding:16px; text-align:center;
          font-size:14px; font-weight:700; }
        .hanger-service { display:flex; align-items:center; gap:8px; padding:6px 0; font-size:13px; color:#333; }
        .hanger-dot { width:8px; height:8px; border-radius:50%; background:${A}; flex-shrink:0; }
      </style>

      <div class="hanger">
        <div class="hanger-top">
          <div class="hanger-hole"></div>
          ${LOGO_URL ? `<img class="hanger-logo" src="${LOGO_URL}" alt="${C.name}"/>` : ''}
          <div style="font-size:12px;letter-spacing:0.15em;text-transform:uppercase;color:${A};margin-bottom:8px;">
            WE'RE IN YOUR NEIGHBORHOOD</div>
          <h2 style="margin:0;font-size:22px;color:#fff;line-height:1.3;">${d.headline ? esc(d.headline) : 'FREE ROOF<br>INSPECTION'}</h2>
          <p style="margin:12px 0 0;font-size:13px;opacity:0.85;">No cost. No obligation. No big deal.</p>
        </div>
        <div class="hanger-body">
          <p style="font-size:13px;color:#555;margin:0 0 16px;line-height:1.6;">
            Hi Neighbor! Our crew is working on a project nearby. While we are in the area, we would be happy
            to provide a complimentary roof and exterior inspection at no cost to you.</p>

          <div style="font-size:11px;font-weight:700;color:${S};text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">
            Our Services</div>
          ${hangerServices.map(s => `<div class="hanger-service"><div class="hanger-dot"></div>${esc(s)}</div>`).join('')}

          <div style="margin-top:16px;padding-top:12px;border-top:1px solid #eee;">
            <div style="font-size:12px;color:#666;">Licensed | Insured | Warranty-Backed</div>
            ${affiliateRow()}
          </div>
        </div>
        <div class="hanger-cta">
          ${C.phone ? `CALL OR TEXT: ${C.phone}<br>` : ''}
          ${C.website ? `<span style="font-size:12px;font-weight:400;opacity:0.9;">${C.website}</span>` : ''}
        </div>
      </div>

      <p style="text-align:center;font-size:10px;color:#999;margin-top:24px;">
        Print on cardstock. Cut along the border. Hang on front door handle.</p>
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 17: NEIGHBORHOOD MAILER
  // ═══════════════════════════════════════════════════════════════
  DG.renderNeighborhoodMailer = function(data) {
    const d = Object.assign({ neighborhoodName:'[Your Neighborhood]', projectAddress:'[Nearby Project Address]' }, data);
    const cp = d.companyProfile || window._companyProfile || (window.NBD_COMPANY_PROFILE_DEFAULTS || {});
    // Footer region tagline. NBD keeps its exact 'Lexington, KY & Surrounding
    // Areas' literal (byte-identical). A non-NBD tenant drops the KY region: it
    // shows its OWN serviceArea only when it has actually overridden the NBD
    // default, otherwise no region at all (just "Licensed & Insured").
    let _mb = null;
    try { _mb = (typeof window !== 'undefined' && window._brand) ? window._brand() : null; } catch (_) { _mb = null; }
    const _isNbd = !_mb || !_mb.legalName || _mb.legalName === 'No Big Deal Home Solutions';
    const _svcArea = String((cp && cp.serviceArea) || '').trim();
    const _KY_DEFAULT = 'Greater Cincinnati & Northern Kentucky';
    const mailerRegion = _isNbd
      ? ' | Lexington, KY & Surrounding Areas'
      : (_svcArea && _svcArea !== _KY_DEFAULT ? ' | ' + esc(_svcArea) : '');

    return page('Neighborhood Mailer', `
      <style>
        .mailer { max-width:6in; margin:0 auto; border:2px solid #eee; border-radius:12px;
          overflow:hidden; box-shadow:0 2px 12px rgba(0,0,0,0.08); }
        .mailer-top { background:linear-gradient(135deg,${S} 0%,#2a2a4e 100%); color:#fff;
          padding:36px 32px; text-align:center; }
        /* Width-only sizing — natural 1.5:1 aspect of the source logo. */
        .mailer-logo { display:block; width:160px; height:auto; margin:0 auto 14px;
          background:#fff; border-radius:8px; padding:6px 12px; box-sizing:border-box; }
        .mailer-body { padding:32px; background:#fff; }
        .mailer-stat { text-align:center; padding:16px; }
        .mailer-stat-num { font-size:28px; font-weight:700; color:${A}; font-family:'Helvetica Neue',Arial,sans-serif; }
        .mailer-stat-label { font-size:11px; color:#666; text-transform:uppercase; letter-spacing:0.06em; margin-top:4px; }
        .mailer-footer { background:#f8f8f8; padding:20px 32px; text-align:center; }
      </style>

      <div class="mailer">
        <div class="mailer-top">
          ${LOGO_URL ? `<img class="mailer-logo" src="${LOGO_URL}" alt="${C.name}"/>` : ''}
          <div style="font-size:11px;letter-spacing:0.2em;text-transform:uppercase;color:${A};margin-bottom:12px;">
            ATTENTION: ${esc(d.neighborhoodName)} RESIDENTS</div>
          <h1 style="margin:0;color:#fff;font-size:26px;line-height:1.3;">
            WE JUST COMPLETED A<br>PROJECT NEAR YOU</h1>
          <p style="margin:12px 0 0;font-size:14px;opacity:0.85;">
            Your neighbor at ${esc(d.projectAddress)} trusted ${C.name} — and so can you.</p>
        </div>
        <div class="mailer-body">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px;border-bottom:1px solid #eee;padding-bottom:24px;">
            <div class="mailer-stat"><div class="mailer-stat-num">5★</div><div class="mailer-stat-label">Customer Rating</div></div>
            <div class="mailer-stat"><div class="mailer-stat-num">100%</div><div class="mailer-stat-label">Satisfaction</div></div>
            <div class="mailer-stat"><div class="mailer-stat-num">0</div><div class="mailer-stat-label">Cost for Inspection</div></div>
          </div>

          <p style="font-size:14px;color:#333;line-height:1.7;margin:0 0 20px;">
            Whether your home was affected by the same storm or you have been thinking about an upgrade,
            we would love the opportunity to take a look. Our inspections are always free, and there is
            never any pressure or obligation.</p>

          <div style="background:#fff8f5;border-radius:8px;padding:16px;border-left:4px solid ${A};margin-bottom:20px;">
            <div style="font-size:14px;font-weight:700;color:${S};margin-bottom:4px;">
              Ask about our neighbor referral program!</div>
            <div style="font-size:13px;color:#555;">
              Earn rewards for every referral that turns into a completed project.</div>
          </div>

          <div style="text-align:center;padding:20px;background:${A};border-radius:8px;color:#fff;">
            <div style="font-size:18px;font-weight:700;">${esc(d.ctaText || 'Schedule Your Free Inspection')}</div>
            <div style="font-size:22px;font-weight:700;margin-top:8px;">${C.phone}</div>
            <div style="font-size:13px;margin-top:4px;opacity:0.9;">${[C.email, C.website].filter(Boolean).join(' | ')}</div>
          </div>
        </div>
        <div class="mailer-footer">
          ${affiliateRow()}
          <div style="font-size:12px;color:#666;">
            ${C.name} | Licensed & Insured${mailerRegion}</div>
        </div>
      </div>
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 18: CUSTOMER TESTIMONIAL SHEET
  // ═══════════════════════════════════════════════════════════════
  DG.renderTestimonialSheet = function(data) {
    const d = Object.assign({}, data);

    // Curated testimonials are the FALLBACK only — shown when the rep entered
    // none of testimonial1/2/3 in the preflight modal.
    const curated = [
      { text:'They made the whole process feel like no big deal. From filing the claim to the final cleanup, everything was handled professionally and on time.', name:'Satisfied Homeowner', location:'Lexington, KY', project:'Roof Replacement', rating:5 },
      { text:'The crew was on time, cleaned up everything, and the roof looks amazing. Best contractor experience I have ever had. Highly recommend.', name:'Satisfied Homeowner', location:'Georgetown, KY', project:'Roof & Gutters', rating:5 },
      { text:'Joe and his team documented every bit of the storm damage and explained each step of the repair. We did not have to stress about a single thing. The new roof looks incredible.', name:'Satisfied Homeowner', location:'Nicholasville, KY', project:'Insurance Restoration', rating:5 },
      { text:'Professional from start to finish. They showed up when they said they would, did exactly what they said they would do, and left the property cleaner than they found it.', name:'Satisfied Homeowner', location:'Versailles, KY', project:'Siding Replacement', rating:5 }
    ];

    // Wire the rep-entered testimonials. Each preflight field is a free-text
    // "Customer quote + name" textarea, so the whole entry is the displayed
    // text; rating1/2/3 (default 5) drives the stars. Only non-blank entries
    // are included.
    const clampRating = function(r) { const n = parseInt(r, 10); return (n >= 1 && n <= 5) ? n : 5; };
    const repEntries = [
      { text: d.testimonial1, rating: clampRating(d.rating1) },
      { text: d.testimonial2, rating: clampRating(d.rating2) },
      { text: d.testimonial3, rating: clampRating(d.rating3) }
    ].filter(function(t) { return t.text && String(t.text).trim(); });

    const useRep = repEntries.length > 0;
    // The curated set is NBD's own (KY cities, "Joe"). A non-NBD tenant must
    // NEVER fall back to it — show only rep-entered quotes, and hide the section
    // when the rep entered none (never fabricate testimonials for another brand).
    let _tb = null;
    try { _tb = (typeof window !== 'undefined' && window._brand) ? window._brand() : null; } catch (_) { _tb = null; }
    const _isNbd = !_tb || !_tb.legalName || _tb.legalName === 'No Big Deal Home Solutions';
    const testimonials = useRep ? repEntries : (_isNbd ? curated : []);
    const hasTestimonials = testimonials.length > 0;

    // Hero stats: with rep data, derive the average from the entries actually
    // shown (don't fabricate a 5.0). Without rep data, the curated set is all
    // 5-star, so 5.0 / 100% is accurate. (Empty → stats suppressed below.)
    const avgRating = hasTestimonials
      ? testimonials.reduce(function(s, t) { return s + (t.rating || 5); }, 0) / testimonials.length
      : 0;
    const avgDisplay = avgRating.toFixed(1);
    const recommendPct = useRep
      ? Math.round((testimonials.filter(function(t) { return (t.rating || 5) >= 4; }).length / testimonials.length) * 100)
      : 100;

    return page('Customer Testimonials', `
      <style>
        .test-hero { background:linear-gradient(135deg,${S} 0%,#2a2a4e 100%); color:#fff;
          padding:40px; border-radius:12px; text-align:center; margin-bottom:32px; }
        .test-card { background:#fff; border:1px solid #eee; border-radius:12px; padding:24px;
          margin-bottom:16px; box-shadow:0 1px 4px rgba(0,0,0,0.06); position:relative; }
        .test-quote { font-size:48px; color:${A}; opacity:0.3; position:absolute; top:8px; left:16px;
          font-family:Georgia,serif; line-height:1; }
        .test-stars { color:#fbbf24; font-size:16px; letter-spacing:2px; margin-bottom:8px; }
        .test-text { font-size:15px; color:#333; line-height:1.7; font-style:italic; padding-left:20px;
          border-left:3px solid ${A}; margin:12px 0; }
        .test-meta { display:flex; justify-content:space-between; font-size:12px; color:#666; margin-top:12px; }
      </style>
      ${letterhead()}
      <div class="test-hero">
        <h1 style="margin:0;color:#fff;font-size:28px;">WHAT OUR CUSTOMERS SAY</h1>
        <p style="color:${A};margin:12px 0 0;font-size:16px;">Real Reviews From Real Homeowners</p>
        ${hasTestimonials ? `<div style="display:flex;justify-content:center;gap:24px;margin-top:20px;">
          <div><div style="font-size:28px;font-weight:700;">${avgDisplay}</div><div style="font-size:12px;opacity:0.8;">Average Rating</div></div>
          <div><div style="font-size:28px;font-weight:700;">${recommendPct}%</div><div style="font-size:12px;opacity:0.8;">Would Recommend</div></div>
        </div>` : ''}
      </div>

      ${testimonials.map(t => `<div class="test-card">
        <div class="test-quote">&ldquo;</div>
        <div class="test-stars">${'★'.repeat(t.rating || 5)}</div>
        <div class="test-text">${esc(t.text)}</div>
        ${(t.name || t.location || t.project) ? `<div class="test-meta">
          <span>${(t.name || t.location) ? `<strong>${esc(t.name)}</strong>${t.location ? ' — ' + esc(t.location) : ''}` : ''}</span>
          <span>${esc(t.project)}</span>
        </div>` : ''}
      </div>`).join('')}

      <div class="section" style="text-align:center;margin-top:28px;">
        <div style="font-size:18px;font-weight:700;color:${S};">Join Our Growing List of Happy Homeowners</div>
        <div style="font-size:14px;color:#555;margin-top:8px;">
          Schedule your free inspection and see why our customers love working with us.</div>
        <div style="font-size:22px;font-weight:700;color:${A};margin-top:12px;">${C.phone}</div>
        <div style="font-size:13px;color:#666;margin-top:4px;">${[C.email, C.website].filter(Boolean).join(' | ')}</div>
      </div>

      ${affiliateRow()}
      ${footer('Customer Testimonials')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 19: THANK YOU LETTER
  // ═══════════════════════════════════════════════════════════════
  DG.renderThankYou = function(data) {
    // projectType/completionDate default to EMPTY (not a fabricated "roof
    // replacement" / today()): the sentence and date line below adapt to
    // whatever the rep actually entered rather than asserting a specific job.
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      projectType:'', completionDate:'', projectSummary:'', personalNote:'', reviewLink:'' }, data);
    // Only render a project-type phrase when the rep supplied one.
    const projectPhrase = d.projectType ? `recent ${esc(d.projectType)} project` : 'recent project';

    return page('Thank You Letter', `
      ${letterhead()}
      <div style="max-width:6in;margin:24px auto;font-size:15px;line-height:2;color:#333;">
        ${d.completionDate ? `<p style="text-align:right;color:#666;font-size:13px;margin-bottom:28px;">${esc(d.completionDate)}</p>` : ''}

        <p>Dear ${esc(d.homeownerName)},</p>

        <p>On behalf of everyone at ${C.name}, I want to personally thank you for trusting us with your
        ${projectPhrase} at ${esc(d.address)}. It was a privilege to work on your home,
        and we hope the experience lived up to our promise — no stress, no hassle, no big deal.</p>

        ${d.projectSummary ? `<p>${esc(d.projectSummary)}</p>` : ''}

        ${d.personalNote ? `<p>${esc(d.personalNote)}</p>` : ''}

        <p>We take enormous pride in every project we complete, and your satisfaction is the single most
        important measure of our success. If anything about your experience was less than exceptional, or
        if there is anything we can do to improve, please do not hesitate to reach out.</p>

        <p><strong>A few things to keep in mind going forward:</strong></p>

        <p style="padding-left:20px;border-left:3px solid ${A};">
          <strong>Your Warranty:</strong> Your workmanship warranty is now active. Keep your warranty certificate
          in a safe place. If you ever notice an issue, call us first — we stand behind every project we touch.<br><br>
          <strong>Maintenance:</strong> We recommend a visual check of your roof after any major storm. If you see
          anything that concerns you, give us a call and we will come take a look at no charge.<br><br>
          <strong>Referrals:</strong> If you know anyone who could benefit from our services, we would be grateful
          for the introduction. Ask us about our referral program — it is our way of saying thanks.
        </p>

        <p>Once again, thank you for choosing ${C.name}. It truly means the world to our team.</p>

        <p>If you have a moment, we would greatly appreciate a review on Google. It helps other homeowners
        find a contractor they can trust, and it lets our team know we are on the right track.${d.reviewLink ? ` You can leave a review here: <a href="${esc(d.reviewLink).replace(/"/g,'&quot;')}" style="color:${A};">${esc(d.reviewLink)}</a>.` : ''}</p>

        <p style="margin-top:32px;">
          With gratitude,<br><br>
          <strong>${C.name === 'No Big Deal Home Solutions' ? 'Joe Deal' : ((typeof window !== 'undefined' && window._user && window._user.displayName) || C.name)}</strong><br>
          <span style="font-size:13px;color:#666;">Owner, ${C.name}</span><br>
          <span style="font-size:13px;color:#666;">${[C.phone, C.email].filter(Boolean).join(' | ')}</span>
        </p>
      </div>
      ${affiliateRow()}
      ${footer('Thank You Letter')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // TEMPLATE 20: PAYMENT AGREEMENT
  // ═══════════════════════════════════════════════════════════════
  DG.renderPaymentAgreement = function(data) {
    const d = Object.assign({ homeownerName:'[Homeowner Name]', address:'[Property Address]',
      totalAmount:'0.00', depositAmount:'0.00', depositDue:'Upon contract signing',
      progressAmount:'0.00', progressDue:'Upon material delivery',
      finalAmount:'0.00', finalDue:'Upon project completion',
      projectDescription:'' }, data);
    const cp = tenantCp(d);
    const latePaymentText = cp.latePaymentChargeText || '1.5% monthly finance charge';
    const financePartner = cp.financePartner || defaultFinancePartner();

    const total = parseFloat(d.totalAmount)||0;
    const deposit = parseFloat(d.depositAmount)||0;
    const progress = parseFloat(d.progressAmount)||0;
    const final = parseFloat(d.finalAmount)||0;
    // Reconcile: the schedule's TOTAL row must equal the sum of its own
    // installment rows — never a separately-entered figure that could silently
    // contradict the line items on a binding payment agreement.
    const scheduledTotal = deposit + progress + final;
    const recMismatch = total > 0 && Math.abs(total - scheduledTotal) >= 0.01;
    // Deposit rule (2026-09-25): rows are named by the pre-flight's plan (a
    // claim's first payment is "Your deductible", its second the insurance
    // ACV check) and numbered in order; a $0 deposit row is not printed —
    // a cash job under the no-deposit threshold printed "1. Deposit $0.00
    // Pending". Labels fall back to the old Deposit / Progress / Final.
    const payRows = [
      deposit > 0 ? { label: d.depositLabel || 'Deposit', amount: deposit, due: d.depositDue } : null,
      progress > 0 ? { label: d.progressLabel || 'Progress Payment', amount: progress, due: d.progressDue } : null,
      final > 0 ? { label: d.finalLabel || 'Final Payment', amount: final, due: d.finalDue } : null,
    ].filter(Boolean);

    return page('Payment Agreement', `
      ${letterhead()}
      <h1 style="text-align:center;font-size:24px;color:${S};margin:24px 0 8px;">PAYMENT AGREEMENT</h1>
      <p style="text-align:center;color:#666;font-size:13px;margin-bottom:28px;">Payment Schedule & Terms</p>

      <div class="section">
        <div class="section-title">Project Information</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:14px;">
          <div><strong>Property Owner:</strong> ${esc(d.homeownerName)}</div>
          <div><strong>Date:</strong> ${today()}</div>
          <div><strong>Property:</strong> ${esc(d.address)}</div>
          <div><strong>Total Contract Amount:</strong> <span style="color:${A};font-weight:700;font-size:16px;">${money(total)}</span></div>
        </div>
        ${d.projectDescription ? `<p style="font-size:14px;margin-top:12px;">${esc(d.projectDescription)}</p>` : ''}
      </div>

      <div class="section">
        <div class="section-title">Payment Schedule</div>
        <table class="items">
          <thead><tr><th>Payment</th><th>Amount</th><th>Due</th><th>Status</th></tr></thead>
          <tbody>
            ${payRows.map((r, i) => `<tr><td><strong>${i + 1}. ${esc(r.label)}</strong></td><td class="right">${money(r.amount)}</td><td>${esc(r.due)}</td>
              <td><span class="badge" style="${i === 0 ? 'background:#fef3c7;color:#92400e;' : 'background:#f3f4f6;color:#6b7280;'}">${i === 0 ? 'Pending' : 'Upcoming'}</span></td></tr>`).join('')}
            <tr style="font-weight:700;border-top:3px solid ${A};">
              <td>TOTAL</td><td class="right" style="color:${A};font-size:16px;">${money(scheduledTotal)}</td>
              <td colspan="2"></td></tr>
          </tbody>
        </table>
        ${recMismatch ? `<p style="margin-top:8px;font-size:12px;color:#dc2626;font-weight:600;">⚠ Payment schedule total (${money(scheduledTotal)}) does not match the contract amount (${money(total)}). Reconcile the installments before sending.</p>` : ''}
      </div>

      <div class="section">
        <div class="section-title">Accepted Payment Methods</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;text-align:center;">
          <div style="padding:16px;background:#f8f8f8;border-radius:8px;font-size:13px;">
            <div style="font-size:24px;margin-bottom:4px;">💰</div>Check</div>
          <div style="padding:16px;background:#f8f8f8;border-radius:8px;font-size:13px;">
            <div style="font-size:24px;margin-bottom:4px;">📱</div>Zelle</div>
          <div style="padding:16px;background:#f8f8f8;border-radius:8px;font-size:13px;">
            <div style="font-size:24px;margin-bottom:4px;">💳</div>Credit Card</div>
          <div style="padding:16px;background:#f8f8f8;border-radius:8px;font-size:13px;">
            <div style="font-size:24px;margin-bottom:4px;">🏦</div>Financing</div>
        </div>
      </div>

      <div class="section">
        <div class="section-title">Terms and Conditions</div>
        <ol style="font-size:13px;line-height:2;padding-left:24px;color:#444;">
          <li>All payments are due as specified above. Late payments may be subject to a ${esc(latePaymentText)}.</li>
          <li>Checks should be made payable to <strong>${C.name}</strong>.</li>
          ${C.email ? `<li>For Zelle payments, send to <strong>${C.email}</strong>.</li>` : ''}
          <li>Credit card payments are accepted via secure link provided by ${C.name}. A convenience fee may apply.</li>
          ${financePartner ? `<li>Financing is available through ${esc(financePartner)}, subject to credit approval and separate terms.</li>` : ''}
          <li>Work will not commence until the deposit payment has been received and verified.</li>
          <li>Final payment is due upon completion of the project and successful final walkthrough.</li>
          <li>Any disputed amounts must be communicated in writing within 10 days of the payment due date.</li>
        </ol>
      </div>

      <div class="section" style="background:#f8f8f8;padding:24px;border-radius:8px;">
        <p style="font-size:14px;margin:0;">
          By signing below, both parties acknowledge and agree to the payment schedule and terms outlined in
          this document. This agreement is supplemental to the primary project contract.
        </p>
      </div>

      ${sigBlock(['Property Owner','Authorized ' + SEAL + ' Representative'], d)}
      ${affiliateRow()}
      ${footer('Payment Agreement')}
    `);
  };

  // ═══════════════════════════════════════════════════════════════
  // REGISTER ALL DOCUMENT TYPES (extended)
  // ═══════════════════════════════════════════════════════════════
  registerTypes({
    material_delivery: { name: 'Material Delivery Notice', template: 'renderMaterialDelivery' },
    storm_checklist: { name: 'Storm Damage Checklist', template: 'renderStormChecklist' },
    claim_guide: { name: 'Insurance Claim Process Guide', template: 'renderClaimGuide' },
    door_hanger: { name: 'Door Hanger', template: 'renderDoorHanger' },
    neighborhood_mailer: { name: 'Neighborhood Mailer', template: 'renderNeighborhoodMailer' },
    testimonial_sheet: { name: 'Customer Testimonial Sheet', template: 'renderTestimonialSheet' },
    thank_you: { name: 'Thank You Letter', template: 'renderThankYou' },
    payment_agreement: { name: 'Payment Agreement', template: 'renderPaymentAgreement' },
    storm_history_report: { name: 'Storm History Report (5-Yr)', template: 'renderStormHistoryReport' }
  });

  // ═══════════════════════════════════════════════════════════════
  // REGISTER FILL FORM FIELDS FOR NEW TEMPLATES
  // ═══════════════════════════════════════════════════════════════
  if (DG.FORM_FIELDS) {
    Object.assign(DG.FORM_FIELDS, {
      warranty_certificate: ['homeownerName','address','warrantyTier','workPerformed','issueDate'],
      supplement_request: ['homeownerName','address','claimNumber','policyNumber','insuranceCompany','dateOfLoss','originalApproved','justification'],
      scope_of_work: ['homeownerName','address','projectDescription','materials','estimatedTimeline','exclusions'],
      work_authorization: ['homeownerName','address','scopeSummary','startDate','emergencyContact','accessInstructions','isInsurance','claimNumber','insuranceCompany'],
      certificate_of_completion: ['homeownerName','address','scopeSummary','startDate','completionDate','inspectorName'],
      change_order: ['homeownerName','address','originalContractNumber','originalContractDate','changeOrderNumber','changesDescription','originalTotal','scheduleImpact'],
      invoice: ['homeownerName','address','homeownerPhone','homeownerEmail','invoiceNumber','dueDate','taxRate','paymentsReceived','claimNumber','insuranceCompany','notes'],
      company_intro: [],
      before_after_report: ['homeownerName','address','projectType','startDate','completionDate','workDescription'],
      financing_options: ['homeownerName','totalPrice'],
      referral_card: [],
      material_delivery: ['homeownerName','address','deliveryDate','deliveryTime','startDate'],
      storm_checklist: [],
      claim_guide: [],
      door_hanger: [],
      neighborhood_mailer: ['neighborhoodName','projectAddress'],
      testimonial_sheet: [],
      thank_you: ['homeownerName','address','projectType','completionDate'],
      payment_agreement: ['homeownerName','address','totalAmount','depositAmount','depositDue','progressAmount','progressDue','finalAmount','finalDue','projectDescription'],
      // Empty on purpose — everything the template needs (storm counts +
      // events) is fetched live from the address by NBDDocGen.generate()'s
      // _attachStormHistory() step, so this doc type has no DOC_SCHEMAS
      // entry either and generates one-click, no fill form.
      storm_history_report: []
    });
  }

  console.log('NBDDocGen: 20 additional templates loaded');

  // Phase B: refresh the brand vars (C/P/S/A/LOGO) from the active tenant's
  // resolved brand before EVERY render, so the extended doc types above are
  // tenant-aware too (they captured the static NBD COMPANY at load otherwise).
  // NBD resolves to the same values → byte-identical.
  function _refreshBrand() {
    C = (DG._resolveCompany ? DG._resolveCompany() : DG.COMPANY) || C;
    P = (C.colors && C.colors.primary) || P;
    S = (C.colors && C.colors.secondary) || S;
    A = (C.colors && C.colors.accent) || A;
    G = (C.colors && C.colors.grey) || G;
    RL = (C.colors && C.colors.rule) || RL;
    WSH = (C.colors && C.colors.wash) || WSH;
    INK = (C.colors && C.colors.ink) || INK;
    // Resolve the signature seal from the active tenant's brand (brand.seal).
    // NBD → 'NBD' (byte-identical); a tenant → its own seal (e.g. Oaks → 'ORC').
    try {
      const _b = (typeof window !== 'undefined' && window._brand) ? window._brand() : null;
      // Only NBD (or no brand) falls back to 'NBD'. A non-NBD tenant whose seal
      // is unset (blanked to '' by _resolveBrand) must render a BLANK seal, not
      // 'Authorized NBD Representative' (review M1 — '' is falsy, so a plain
      // `|| 'NBD'` would re-leak NBD onto the tenant's signed docs).
      SEAL = (_b && _b.seal) ? _b.seal
           : (_b && _b.legalName && _b.legalName !== 'No Big Deal Home Solutions') ? ''
           : 'NBD';
      // Document faces from brand.fonts.docDisplay/docBody. A fallback STACK is
      // always appended — neither Montserrat nor Lato is a system font, and a
      // bare family name silently renders as Times where the face is missing.
      // The face name is quoted defensively so a multi-word family cannot break
      // the declaration.
      const _fq = function (n, fallback) {
        const v = String(n || '').trim().replace(/["'`;{}]/g, '');
        return (v ? "'" + v + "'," : '') + fallback;
      };
      const _fonts = (_b && _b.fonts) || {};
      FD = _fq(_fonts.docDisplay || 'Montserrat', "'Segoe UI',Helvetica,Arial,sans-serif");
      FB = _fq(_fonts.docBody || 'Lato', "'Segoe UI',Helvetica,Arial,sans-serif");
      // Credential badges. NEVER fall back to NBD's — _resolveBrand blanks this
      // for a non-NBD tenant that has not set its own, and an empty list must
      // stay empty. A `|| NBD_DEFAULT` here would re-leak the certification
      // numbers that the blanking exists to stop (same trap as SEAL above).
      AFF = (_b && Array.isArray(_b.affiliates)) ? _b.affiliates : [];
    } catch (_) {
      SEAL = 'NBD';
      FD = "'Montserrat','Segoe UI',Helvetica,Arial,sans-serif";
      FB = "'Lato','Segoe UI',Helvetica,Arial,sans-serif";
      AFF = [];
    }
    LOGO_URL = DG._logoSrc ? DG._logoSrc() : LOGO_URL;
    const _m = String(LOGO_URL).match(/^data:([^;,]+)/);
    LOGO_TYPE = _m ? _m[1]
      : /\.svg(\?|$)/i.test(LOGO_URL) ? 'image/svg+xml'
      : /\.jpe?g(\?|$)/i.test(LOGO_URL) ? 'image/jpeg'
      : 'image/png';
  }
  Object.keys(DG).forEach(function (k) {
    if (typeof DG[k] === 'function' && /^render[A-Z]/.test(k)) {
      const _orig = DG[k];
      DG[k] = function () { _refreshBrand(); return _orig.apply(this, arguments); };
    }
  });

  // Shared building blocks for document-generator-library.js (2026-10-04),
  // so the template library renders in THIS file's letterhead, footer, page
  // shell and tenant brand instead of a second copy of them. refresh() is the
  // same per-render brand resolve every render* above runs; brand() reads the
  // values it set. Not a render* name, so the loop above leaves it alone.
  DG._tpl = {
    page: page, letterhead: letterhead, footer: footer, sigBlock: sigBlock,
    affiliateRow: affiliateRow, esc: esc, money: money, today: today,
    toCents: toCents, centsText: centsText, longDate: longDate,
    resolveDocManufacturer: resolveDocManufacturer,
    refresh: _refreshBrand,
    brand: function () { return { C: C, P: P, S: S, A: A, G: G, RL: RL, WSH: WSH, INK: INK, FD: FD, FB: FB, SEAL: SEAL }; }
  };
})();


(function(){if(window._NBD_DGT_DELEGATE)return;window._NBD_DGT_DELEGATE=true;document.addEventListener('click',function(ev){var t=ev.target.closest&&ev.target.closest('[data-dgt-action]');if(!t)return;if(t.dataset.dgtAction==='print')window.print();});})();
