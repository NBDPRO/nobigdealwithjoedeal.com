// ══════════════════════════════════════════════════════════════
// NBD Pro — warranty-cert.js
// Warranty Certificate PDF Generator
// ══════════════════════════════════════════════════════════════

// ══ WARRANTY CERTIFICATE GENERATOR ═══════════════════════════════════════
// Use var to avoid redeclaration collision with dashboard.html inline script
var WC_TIER_DESCS = WC_TIER_DESCS || {
  standard: 'NBD will return and correct any labor-related defect at no charge for the lifetime of the installation. Does not transfer on sale of property.',
  preferred: 'NBD will return and correct any labor-related defect at no charge for the lifetime of the installation. Transferable to one subsequent owner within 30 days of sale.',
  elite: 'NBD will return and correct any labor-related defect at no charge for the lifetime of the installation. Fully transferable — follows the property through all subsequent owners. Annual courtesy inspection included.',
  // Five tiers (Jo, 2026-10-02). Economy is a 1-YEAR labor warranty plus the
  // shingle manufacturer's standard limited warranty — never lifetime, never
  // a system warranty. Beyond is Elite's workmanship terms on TAMKO HailGuard,
  // the one shingle with a manufacturer hail warranty.
  economy: 'NBD will return and correct any labor-related defect at no charge for one (1) year from the installation date. The shingles carry the manufacturer\'s standard limited warranty, provided directly by the manufacturer. No system warranty is included. Does not transfer on sale of property.',
  beyond: 'NBD will return and correct any labor-related defect at no charge for the lifetime of the installation. Fully transferable — follows the property through all subsequent owners. Annual courtesy inspection included. The TAMKO HailGuard shingles also carry TAMKO\'s HailGuard hail warranty (manufacturer terms apply).'
};

// Per-cert-tier wording flags, shared by the server payload and the legacy
// html fallback. Unknown values read as Standard (the select's default), so a
// stray key never prints Elite/Beyond terms.
function _wcTierFlags(tier) {
  return {
    isEconomy:   tier === 'economy',
    isBeyond:    tier === 'beyond',
    // Beyond carries Elite's workmanship terms (transferable + inspection).
    isElite:     tier === 'elite' || tier === 'beyond',
    isPreferred: tier === 'preferred'
  };
}

// The company's own configured workmanship sentence for a cert tier, '' when
// it never wrote one (tenant-rules.js). Never NBD's wording for another company.
function _wcOwnWorkmanship(tier) {
  const TR = window.NBDTenantRules;
  return (TR && typeof TR.ownWarrantyText === 'function') ? (TR.ownWarrantyText(tier) || '') : '';
}

// The two warranty lines (2026-10-06): workmanship (NBD: the NBD Pledge;
// another company: its own sentence or none) and the manufacturer warranty the
// job actually bought. tenant-rules.js builds both; without it, the honest
// floor — never an invented manufacturer term.
function _wcLines(tier, isNbd) {
  const TR = window.NBDTenantRules;
  if (TR && typeof TR.warrantyLines === 'function') {
    return TR.warrantyLines({ tier, isNbd, lineItems: _wcCurrentJob.lineItems, extendedWarranty: _wcCurrentJob.extendedWarranty });
  }
  const eco = tier === 'economy';
  const own = isNbd ? '' : _wcOwnWorkmanship(tier);
  return {
    workmanship: isNbd ? (eco ? '1-year workmanship (labor) warranty from the installation date' : 'NBD Pledge — lifetime workmanship warranty') : (own || null),
    isPledge: isNbd && !eco,
    maker: (tier === 'beyond' && isNbd) ? 'TAMKO' : null,
    manufacturer: 'Manufacturer warranty: ' + (eco ? 'the shingle manufacturer’s standard limited warranty on the shingles; no system warranty' : (tier === 'beyond' && isNbd ? 'TAMKO HailGuard hail warranty on the TAMKO HailGuard shingles (manufacturer terms apply)' : 'per manufacturer — see your estimate'))
  };
}

// Step 17: track the lead id that opened the wizard so the generator
// can persist the warranty payload back onto the lead doc. Previously
// the PDF was one-shot — generated, downloaded, gone. Now the same
// data drives a digital warranty card on the homeowner portal.
var _wcCurrentLeadId = null;
// 2026-10-06: what the job actually bought — the estimate's line items (the
// shingle, any extended manufacturer warranty line) and an explicit
// extendedWarranty value — so the manufacturer line names only that.
var _wcCurrentJob = { lineItems: [], extendedWarranty: null };

function openWarrantyCertWizard(lead) {
  const modal = document.getElementById('warrantyCertModal');
  // Step 17: remember the lead so generateWarrantyCertPDF can write
  // back. Tolerates both string ids (passed directly) and full lead
  // objects (the common case).
  _wcCurrentLeadId = lead && typeof lead === 'object' ? (lead.id || null)
                  : (typeof lead === 'string' ? lead : null);
  _wcCurrentJob = {
    lineItems: (lead && typeof lead === 'object' && (lead.estimateLineItems || lead.lineItems)) || [],
    extendedWarranty: (lead && typeof lead === 'object' && lead.extendedWarranty) || null
  };
  // Pre-fill from lead if provided
  if (lead) {
    const owner = `${lead.firstName||''} ${lead.lastName||''}`.trim() || '';
    document.getElementById('wcOwner').value = owner;
    document.getElementById('wcAddr').value = lead.address || '';
    // Manufacturer pre-fill: if the lead carries estimate line items, name the
    // shingle on them via the shared resolver. No shingle on the estimate →
    // name none (2026-10-06: it used to default to "GAF Timberline", a guess
    // printed on the homeowner's certificate).
    let _mfgWork = '';
    try {
      const _li = lead.estimateLineItems || lead.lineItems || [];
      const _res = window.NBDDocGen && window.NBDDocGen.resolveDocManufacturer && window.NBDDocGen.resolveDocManufacturer(_li);
      if (_res && _res.manufacturerName && _res.manufacturerName !== _res.manufacturer + ' shingles') _mfgWork = _res.manufacturerName;
    } catch (_) { /* name no shingle */ }
    const _workBase = lead.damageType || 'Roof replacement';
    document.getElementById('wcWork').value = _mfgWork ? `${_workBase} — ${_mfgWork}` : _workBase;
    // GBB audit §7.3, 2026-09-09: this certificate is the roofing job's
    // actual warranty, not a separate rep-picked product — pre-fill the
    // Guarantee Tier from the pricing tier the estimate was actually sold
    // at (good/better/best -> standard/preferred/elite via the shared
    // config), instead of always silently defaulting to Standard. Still
    // rep-overridable below — not every lead carries a resolvable tier.
    try {
      const soldTier = String(lead.warrantyTier || lead.tier || lead.tierName || '').toLowerCase();
      const cfg = window.NBD_ESTIMATE_CONFIG;
      const mapped = (cfg && typeof cfg.tierLabel === 'function' ? cfg.tierLabel(soldTier) : soldTier).toLowerCase();
      const tierSelect = document.getElementById('wcTier');
      if (tierSelect && mapped && Array.prototype.some.call(tierSelect.options, o => o.value === mapped)) {
        tierSelect.value = mapped;
      }
    } catch (_) { /* leave the select at its default */ }
  }
  // Default date to today
  document.getElementById('wcDate').value = new Date().toISOString().split('T')[0];
  updateCertPreview();
  modal.classList.add('open');
}

function updateCertPreview() {
  const tier = document.getElementById('wcTier')?.value || 'standard';
  const desc = document.getElementById('wcTierDesc');
  if (!desc) return;
  // gauntlet Batch 3 — the tier descriptions name their subject 'NBD'; keep it
  // verbatim for NBD (byte-identical), swap the tenant's seal/legal name in
  // otherwise so the wizard preview matches the de-branded cert it generates.
  const _b = (window._brand && window._brand()) || null;
  const isNbd = !_b || !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
  const raw = WC_TIER_DESCS[tier] || '';
  // Another company never inherits NBD's lifetime terms (2026-10-06): its own
  // configured workmanship sentence, or nothing.
  desc.textContent = isNbd ? raw : _wcOwnWorkmanship(tier);
  // The Guarantee Tier <select> is static markup in dashboard.html whose first
  // option read "Standard — NBD Lifetime Pledge" for EVERY tenant's rep. The
  // Pledge is NBD's alone (2026-10-06); another company sees the plain name.
  const seal = isNbd ? 'NBD' : (_b.seal || _b.legalName || '');
  // (Found by value: Economy sits above Standard since the five-tier change.)
  const sel = document.getElementById('wcTier');
  const stdOpt = sel && sel.options ? Array.prototype.find.call(sel.options, o => o && o.value === 'standard') : null;
  if (stdOpt) {
    stdOpt.textContent = isNbd ? 'Standard — NBD Lifetime Pledge' : 'Standard';
  }
  // Same for the modal's eyebrow ("NBD Guarantee" above the title).
  const eyebrow = document.getElementById('wcEyebrow');
  if (eyebrow) eyebrow.textContent = seal ? seal + ' Guarantee' : 'Guarantee';
}

async function generateWarrantyCertPDF() {
  // ── HYDRATION GATE (2026-09-14) ────────────────────────────────────────
  // Same pattern as #1447/#1449: _b/isNbd below is a SYNCHRONOUS read of
  // window._brand(), which company-profile.js:276 seeds with the NBD
  // DEFAULTS at parse time. Rendering before _loadCompanyProfile() resolves
  // stamps the platform's identity — name/phone/email/seal/signature — onto
  // another tenant's warranty certificate. (The cert-number prefix below
  // already awaits hydration via window._tenantIdPrefix() for exactly this
  // reason; _b/isNbd did not.) Gate here, as the first statement, before any
  // company-data read. Never blocks the rep: a hydration failure falls
  // through and renders with whatever brand is available, exactly as before.
  try {
    if (window._companyProfileLoaded !== true && typeof window._loadCompanyProfile === 'function') {
      await window._loadCompanyProfile();
    }
  } catch (_) { /* render with what we have rather than blocking the rep */ }

  const owner = document.getElementById('wcOwner').value.trim() || '___________________';
  const addr  = document.getElementById('wcAddr').value.trim()  || '___________________';
  const date  = document.getElementById('wcDate').value         || '';
  const tier  = document.getElementById('wcTier').value         || 'standard';
  const work  = document.getElementById('wcWork').value.trim()  || 'Roofing installation';

  const dateFormatted = date ? new Date(date + 'T12:00:00').toLocaleDateString('en-US', {month:'long', day:'numeric', year:'numeric'}) : '___________________';

  // gauntlet Batch 3 — tenant brand resolution. NBD (or no tenant loaded)
  // keeps every literal below EXACTLY as it shipped → byte-identical output;
  // a stranger tenant substitutes its own identity so the warranty cert never
  // advertises NBD / Joe Deal / Cincinnati / (859) to another company's homeowner.
  const _b = (window._brand && window._brand()) || null;
  const isNbd = !_b || !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
  const _bc = (_b && _b.contact) || {};
  // Certificate-number prefix. ASYNC resolver: _custIdPrefix() answers NBD for
  // EVERY tenant until company-profile hydration completes, and this string is
  // printed on the certificate the homeowner keeps. Never blank — a minted
  // identifier cannot carry an orphan leading dash — so the resolver falls
  // back to the neutral CUS this codebase already uses for an underivable
  // non-NBD brand.
  const _certPrefix = window._tenantIdPrefix ? await window._tenantIdPrefix() : 'CUS';
  const certNum = _certPrefix + '-' + Date.now().toString().slice(-6);

  // Signature seal / pledge name. NBD → 'NBD Lifetime Pledge' (byte-identical);
  // tenant → '<seal> Lifetime Pledge', or a neutral 'Lifetime Pledge' if it set
  // no seal. brandSeal is also the subject the guarantee descriptions name.
  // The NBD Lifetime Pledge is NBD's own (Jo, 2026-10-06): another company's
  // certificate never names a "Lifetime Pledge" — it prints the company's own
  // configured workmanship warranty, or no workmanship line at all.
  const brandSeal = isNbd ? 'NBD' : (_b.seal || _b.legalName || '');
  const pledgeName = 'NBD Lifetime Pledge';
  const lines = _wcLines(tier, isNbd);
  const _cfgW = window.NBD_ESTIMATE_CONFIG;
  const _pkg = (k, fb) => (_cfgW && typeof _cfgW.tierLabel === 'function') ? (_cfgW.tierLabel(k) || fb) : fb;

  const tierLabels = isNbd ? {
    // Economy is NOT the Lifetime Pledge — its label never names it.
    economy: 'Economy — 1-Year Labor Warranty',
    standard: 'Standard — ' + pledgeName,
    preferred: 'Preferred — ' + pledgeName + ' (Transferable to One Owner)',
    elite: 'Elite — ' + pledgeName + ' (Fully Transferable + Annual Inspection)',
    beyond: 'Beyond — ' + pledgeName + ' (Fully Transferable + Annual Inspection + TAMKO HailGuard Hail Warranty)'
  } : {
    economy: _pkg('economy', 'Economy'), standard: _pkg('good', 'Standard'), preferred: _pkg('better', 'Preferred'),
    elite: _pkg('best', 'Elite'), beyond: _pkg('beyond', 'Beyond')
  };
  const tierLabel = tierLabels[tier] || tierLabels.standard;
  // WC_TIER_DESCS are NBD's terms; another company's are its own sentence.
  const _rawDesc = WC_TIER_DESCS[tier] || WC_TIER_DESCS.standard;
  const tierDesc = isNbd ? _rawDesc : _wcOwnWorkmanship(tier);

  // NBD's tier perks (transfer, inspection) are NBD's terms — never another company's.
  const _flags = _wcTierFlags(tier);
  const isEconomy = _flags.isEconomy, isBeyond = _flags.isBeyond;
  const isElite = isNbd && _flags.isElite, isPreferred = isNbd && _flags.isPreferred;
  // Legacy-fallback wording that differs by tier. Economy: a 1-year labor
  // warranty + the manufacturer's standard limited warranty, no system
  // warranty. Beyond: the HailGuard hail warranty is TAMKO's.
  const certTitle = (isEconomy || !isNbd) ? 'Warranty Certificate' : 'Lifetime Warranty Certificate';
  // (Escaped where it is printed — escCert is declared further down.)
  // Two separate lines: workmanship (the NBD Pledge / the company's own / none)
  // and the manufacturer warranty this job bought.
  const termFeature = lines.workmanship || '';
  const mfgFeature = lines.manufacturer;
  const mfgName = lines.maker ? lines.maker + ' manufacturer' : 'manufacturer';
  const sealWord = isEconomy ? '1-Year<br>Labor<br>Warranty' : (isNbd ? 'Lifetime<br>Guarantee' : 'Warranty');

  // D-1: try the new server-side Puppeteer renderer first. It returns
  // a real vector PDF (not a html2canvas screenshot) using the shared
  // print design system. The old html2canvas path below stays as a
  // fallback so reps are never blocked if the callable errors.
  try {
    const ok = await _tryServerRender({
      owner, addr, date, tier, work, dateFormatted, certNum,
      tierLabel, tierLabelLong: tierLabel, tierTerms: tierDesc,
      isElite, isPreferred, isEconomy, isBeyond,
      workmanshipLine: lines.workmanship || '', manufacturerLine: lines.manufacturer,
      isPledge: !!lines.isPledge, manufacturerName: lines.maker || ''
    });
    if (ok) return; // server render succeeded — bail before the legacy path runs
  } catch (e) {
    console.warn('[warranty-cert] server render failed, falling back to html2canvas:', e && e.message || e);
  }

  // SECURITY: addr/owner/work originate from public lead intake. This html is
  // rendered into a sandboxed NBDDocViewer srcdoc AND, if that fails to load,
  // via a fallback window.open('','_blank') + document.write that is
  // same-origin and unsandboxed — so escape every lead-sourced field to keep
  // the fallback from being a stored-XSS in the rep's session.
  const escCert = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <title>${isNbd ? 'NBD' : escCert(_b.legalName)} Warranty Certificate — ${escCert(addr)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800&family=Lato:wght@400;700&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:'Lato','Segoe UI',Helvetica,Arial,sans-serif;background:#fff;color:#111;padding:40px 48px;max-width:800px;margin:0 auto;}
    .header{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:20px;border-bottom:4px solid #BD5728;margin-bottom:28px;}
    .brand{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:26px;font-weight:900;text-transform:uppercase;letter-spacing:.03em;}
    .brand span{color:var(--orange,#BD5728);}
    .brand-sub{font-size:9px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--orange,#BD5728);border:1px solid #BD5728;padding:2px 10px;border-radius:2px;display:inline-block;margin-top:6px;}
    .cert-header{text-align:right;}
    .cert-type{font-size:9px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:#999;margin-bottom:4px;}
    .cert-title{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:30px;font-weight:900;text-transform:uppercase;letter-spacing:.04em;color:#111;}
    .cert-num{font-size:11px;color:#888;margin-top:4px;}
    .tier-badge{display:inline-block;background:${isBeyond?'#5b21b6':isElite?'#111':isPreferred?'#1a3260':isEconomy?'#57534e':'#BD5728'};color:#fff;font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:13px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:6px 18px;border-radius:3px;margin-bottom:24px;}
    h2{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.18em;color:#111;margin:22px 0 12px;padding-bottom:5px;border-bottom:2px solid #BD5728;}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px 24px;margin-bottom:8px;}
    .field label{font-size:9px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#999;display:block;margin-bottom:3px;}
    .field .val{font-size:15px;font-weight:700;color:#111;border-bottom:1.5px solid #ddd;padding-bottom:4px;min-height:24px;}
    .guarantee-box{background:#f9f9f9;border:1px solid #eee;border-left:4px solid #BD5728;border-radius:4px;padding:16px 18px;margin:16px 0;}
    .guarantee-box .tier{font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--orange,#BD5728);margin-bottom:6px;}
    .guarantee-box .terms{font-size:12px;color:#444;line-height:1.7;}
    .features{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:12px 0;}
    .feature{display:flex;align-items:center;gap:8px;font-size:12px;color:#333;}
    .feature-dot{width:8px;height:8px;border-radius:50%;background:var(--orange,#BD5728);flex-shrink:0;}
    .sig-section{margin-top:32px;padding-top:20px;border-top:1px solid #eee;}
    .sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:20px;}
    .sig-line{border-bottom:1.5px solid #333;height:32px;margin-bottom:5px;}
    .sig-label{font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;}
    .footer{margin-top:24px;padding-top:14px;border-top:1px solid #eee;display:flex;justify-content:space-between;align-items:center;font-size:10px;color:#aaa;}
    .seal{width:60px;height:60px;border-radius:50%;border:3px solid #BD5728;display:flex;align-items:center;justify-content:center;font-family:'Montserrat','Segoe UI',Helvetica,Arial,sans-serif;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--orange,#BD5728);text-align:center;line-height:1.3;padding:8px;}
    @page{margin:1.5cm 2cm;size:letter;}
    *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;}
  </style></head><body>

  <div class="header">
    <div>
      <div class="brand">${isNbd ? 'No Big <span>Deal</span> Home Solutions' : escCert(_b.legalName)}</div>
      ${isNbd
        ? '<div class="brand-sub">Roofing · Siding · Gutters · Greater Cincinnati</div>'
        : (_b.tagline ? '<div class="brand-sub">' + escCert(_b.tagline) + '</div>' : '')}
      <div style="font-size:11px;color:#666;margin-top:8px;">${isNbd ? '(859) 420-7382 · jd@nobigdealwithjoedeal.com' : escCert([_bc.phone, _bc.email].filter(Boolean).join(' · '))}</div>
    </div>
    <div class="cert-header">
      <div class="cert-type">Official Document</div>
      <div class="cert-title">Warranty<br>Certificate</div>
      <div class="cert-num">Certificate No. ${certNum}</div>
    </div>
  </div>

  <div class="tier-badge">🛡️ ${tierLabel}</div>

  <h2>Property &amp; Installation</h2>
  <div class="grid-2">
    <div class="field" style="grid-column:1/-1;"><label>Property Address</label><div class="val">${escCert(addr)}</div></div>
    <div class="field"><label>Homeowner</label><div class="val">${escCert(owner)}</div></div>
    <div class="field"><label>Installation Date</label><div class="val">${dateFormatted}</div></div>
    <div class="field" style="grid-column:1/-1;"><label>Work Performed</label><div class="val">${escCert(work)}</div></div>
  </div>

  ${tierDesc ? `<h2>Guarantee Terms</h2>
  <div class="guarantee-box">
    <div class="tier">${isNbd ? tierLabel : escCert(tierLabel)}</div>
    <div class="terms">${isNbd ? tierDesc : escCert(tierDesc)}</div>
  </div>` : ''}

  <div class="features">
    ${termFeature ? '<div class="feature"><div class="feature-dot"></div>' + escCert(termFeature) + '</div>' : ''}
    <div class="feature"><div class="feature-dot"></div>${escCert(mfgFeature)}</div>
    ${isPreferred||isElite ? '<div class="feature"><div class="feature-dot"></div>Transferable to new owner on sale</div>' : ''}
    ${isElite ? '<div class="feature"><div class="feature-dot"></div>Annual courtesy inspection included</div>' : ''}
    ${isElite ? '<div class="feature"><div class="feature-dot"></div>Fully transferable — follows the property</div>' : ''}
    <div class="feature"><div class="feature-dot"></div>${isNbd ? 'Backed personally by Joe Deal' : ('Backed by ' + escCert(_b.legalName))}</div>
    <div class="feature"><div class="feature-dot"></div>${isNbd ? 'Recorded on file at NBD Home Solutions' : ('Recorded on file at ' + escCert(_b.legalName))}</div>
  </div>

  <p style="font-size:11px;color:#666;margin-top:16px;line-height:1.7;">${termFeature ? 'This guarantee covers defects in labor and workmanship only. It does not cover damage caused by acts of nature, severe weather events, improper maintenance, or modifications made by parties other than ' + (isNbd ? 'No Big Deal Home Solutions' : escCert(_b.legalName)) + '. ' : ''}The ${escCert(mfgName)} shingle warranty${isBeyond && lines.maker === 'TAMKO' ? ' (including the HailGuard hail warranty)' : ''} is a separate warranty provided directly by ${(isEconomy || !lines.maker) ? 'the shingle manufacturer' : escCert(lines.maker)} and is not administered by ${isNbd ? 'No Big Deal Home Solutions' : escCert(_b.legalName)}.</p>

  <h2>Signatures</h2>
  <div class="sig-section">
    <div class="sig-grid">
      <div>
        <div class="sig-line"></div>
        <div class="sig-label">Homeowner Signature &amp; Date</div>
      </div>
      <div>
        <div class="sig-line"></div>
        <div class="sig-label">${isNbd ? 'Joe Deal — No Big Deal Home Solutions' : escCert([((window._user && (window._user.displayName || window._user.email)) || ''), _b.legalName].filter(Boolean).join(' — '))}</div>
      </div>
    </div>
  </div>

  <div class="footer">
    <div>
      <div style="font-weight:700;color:#111;font-size:11px;margin-bottom:2px;">${isNbd ? 'No Big Deal Home Solutions' : escCert(_b.legalName)}</div>
      <div>${isNbd ? 'nobigdealwithjoedeal.com · (859) 420-7382 · Greater Cincinnati, OH' : escCert([_bc.website, _bc.phone, _bc.address].filter(Boolean).join(' · '))}</div>
      <div style="margin-top:2px;">Certificate No. ${certNum} · Keep this document with your permanent home records</div>
    </div>
    <div class="seal">${isNbd ? 'NBD<br>' + sealWord : (brandSeal ? (escCert(brandSeal) + '<br>' + sealWord) : sealWord)}</div>
  </div>

  </body></html>`;

  document.getElementById('warrantyCertModal').classList.remove('open');

  // Route through the Universal Document Viewer — user picks
  // Print or Download PDF from the action bar instead of the
  // old auto-print popup.
  if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
    const customerName = (typeof ownerName !== 'undefined' && ownerName) ? ownerName : '';
    const slug = (customerName || 'warranty').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
    const _certFileBase = 'Warranty-' + slug + '-'
      + (typeof certNum !== 'undefined' ? certNum : new Date().getTime()) + '.pdf';
    const _certFileName = window._tenantFileName
      ? await window._tenantFileName(_certFileBase)
      : _certFileBase;
    window.NBDDocViewer.open({
      html: html,
      title: certTitle + (customerName ? ' — ' + customerName : ''),
      // FILENAME only — tenant-resolved, never 'NBD' for a non-platform tenant.
      // `_certPrefix` above still mints the certificate NUMBER; that is a
      // persisted, homeowner-visible identifier and is deliberately NOT changed
      // here (see the note: a blank prefix would mint an orphan "-123456", which
      // docgen-brand.test.js:98 and docgen-render.test.js:181 already forbid).
      filename: _certFileName,
      onSave: async () => {
        if (typeof showToast === 'function') {
          showToast('\u2713 Warranty certificate generated \u2014 Print or Download PDF from the action bar', 'success');
        }
      }
    });
  } else {
    // Fallback: legacy popup
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html.replace('</body>', '<script>window.print();<\/script></body>'));
      w.document.close();
    }
  }

  // Step 17: persist the warranty payload onto the lead doc so the
  // homeowner portal can render a Digital Warranty Card without
  // re-running the wizard. Fire-and-forget — PDF generation already
  // succeeded; a Firestore write failure shouldn't surface as an error
  // to the rep.
  _persistWarrantyToLead({
    leadId: _wcCurrentLeadId,
    tier,
    tierLabel,
    tierDesc,
    work,
    owner,
    address: addr,
    installDate: date,
    certNumber: certNum,
    workmanshipLine: lines.workmanship || '',
    manufacturerLine: lines.manufacturer,
  }).catch(() => { /* silent — see comment above */ });

  showToast('✓ Warranty certificate generated', 'success');
}

// ─── D-1: server-side render helper ───────────────────────────
// Calls the renderPdf callable, then routes the returned PDF URL
// through the existing NBDDocViewer so reps interact with the
// new doc the same way they always have (Print / Download / Share).
// Returns true on success so the caller can short-circuit the legacy
// html2canvas fallback.
async function _tryServerRender(payload) {
  if (!window._functions || !window._httpsCallable) {
    const mod = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js');
    window._functions = mod.getFunctions();
    window._httpsCallable = mod.httpsCallable;
  }
  // Close the wizard modal first so the doc viewer can take focus.
  const modal = document.getElementById('warrantyCertModal');
  if (modal) modal.classList.remove('open');

  if (typeof showToast === 'function') showToast('Rendering cert…', 'info');

  // gauntlet Batch 3 — the cover page renders preparedBy VERBATIM (the server
  // {{company}} chrome does not override it), so de-brand it here or a stranger
  // tenant's warranty cover would still read "No Big Deal Home Solutions ·
  // (859) 420-7382". NBD keeps the exact literals → byte-identical. Mirrors
  // customer-photo-report-generator.js.
  const _b = (window._brand && window._brand()) || null;
  const isNbd = !_b || !_b.legalName || _b.legalName === 'No Big Deal Home Solutions';
  const _bc = (_b && _b.contact) || {};
  // Certificate-number prefix. ASYNC resolver: _custIdPrefix() answers NBD for
  // EVERY tenant until company-profile hydration completes, and this string is
  // printed on the certificate the homeowner keeps. Never blank — a minted
  // identifier cannot carry an orphan leading dash — so the resolver falls
  // back to the neutral CUS this codebase already uses for an underivable
  // non-NBD brand.
  const _certPrefix = window._tenantIdPrefix ? await window._tenantIdPrefix() : 'CUS';

  const fn = window._httpsCallable(window._functions, 'renderPdf');
  const slug = (payload.owner || 'warranty').replace(/[^A-Za-z0-9]+/g, '-').substring(0, 40);
  // render-pdf.js:387 takes this verbatim, so it is what lands on the
  // homeowner's disk. Tenant-resolved; the certificate NUMBER is untouched.
  const _certBase = 'Warranty-' + slug + '-' + payload.certNum + '.pdf';
  const filename = window._tenantFileName ? await window._tenantFileName(_certBase) : _certBase;

  // D-2.5: shape the customer-specific + brand-consistent cover-page
  // payload. The cover is rendered by a SHARED partial across every
  // doc, so we always send the same {preparedFor, preparedBy,
  // projectMeta} structure — only the eyebrow/tagline change per doc.
  const repName = (window._user && (window._user.displayName || window._user.email))
    || (isNbd ? 'NBD Installer' : (_b.legalName || 'Installer'));
  const lead    = (window._leads || []).find(l =>
    (l.address && l.address.trim() === payload.addr.trim()) ||
    (l.firstName && payload.owner && payload.owner.startsWith((l.firstName + ' ' + (l.lastName||'')).trim()))
  );
  const customerId   = lead && lead.customerId;
  const projectMeta  = [
    { label: 'Installation Date', value: payload.dateFormatted },
    { label: 'Coverage Tier',     value: (payload.tier || '').toUpperCase() },
    { label: 'Certificate No.',   value: payload.certNum },
  ];
  const preparedFor  = {
    name:        payload.owner,
    address:     payload.addr,
    customerId:  customerId || null,
    projectLine: payload.work || null,
  };
  const preparedBy   = {
    name:  repName,
    role:  'Project Owner · ' + (isNbd ? 'No Big Deal Home Solutions' : _b.legalName),
    phone: isNbd ? '(859) 420-7382' : (_bc.phone || ''),
    email: isNbd ? 'jd@nobigdealwithjoedeal.com' : (_bc.email || ''),
  };

  const r = await fn({
    template: 'warranty',
    payload: {
      owner:          payload.owner,
      address:        payload.addr,
      dateFormatted:  payload.dateFormatted,
      work:           payload.work,
      tier:           payload.tier,
      tierLabel:      payload.tierLabel,
      tierLabelLong:  payload.tierLabelLong,
      tierTerms:      payload.tierTerms,
      certNumber:     payload.certNum,
      isElite:        payload.isElite,
      isPreferred:    payload.isPreferred,
      // Five tiers (2026-10-02): warranty.hbs swaps the Lifetime Pledge copy
      // for 1-year labor wording on Economy, and names TAMKO HailGuard's hail
      // warranty on Beyond (the shingle is HailGuard by rule, so TAMKO).
      isEconomy:      !!payload.isEconomy,
      isBeyond:       !!payload.isBeyond,
      // The two warranty lines (2026-10-06): warranty.hbs prints the
      // workmanship line (the NBD Pledge only when the server says this is
      // NBD) and the manufacturer warranty the job bought. manufacturer names
      // the shingle maker for the disclaimer — '' when the job names none.
      workmanshipLine:             payload.workmanshipLine || '',
      manufacturerLine:            payload.manufacturerLine || '',
      isPledge:                    !!payload.isPledge,
      manufacturer:                payload.manufacturerName || '',
      // D-2.5 cover fields
      preparedFor,
      preparedBy,
      projectMeta,
    },
    filename,
  });

  const data = r && r.data;
  if (!data || !data.ok || !data.url) {
    throw new Error('Render returned no URL');
  }

  // Hand the PDF URL to the doc viewer so the rep sees the standard
  // Print / Download / Share toolbar. iframe-embed the signed URL.
  if (window.NBDDocViewer && typeof window.NBDDocViewer.open === 'function') {
    window.NBDDocViewer.open({
      url:      data.url,
      title:    ((payload.isEconomy || !payload.isPledge) ? 'Warranty Certificate' : 'Lifetime Warranty Certificate') + (payload.owner ? ' — ' + payload.owner : ''),
      filename: data.filename || filename,
    });
  } else {
    // Last-ditch: open the signed URL directly so the rep can save it.
    window.open(data.url, '_blank', 'noopener');
  }

  if (typeof showToast === 'function') {
    const ms = data.timing && data.timing.totalMs;
    showToast(ms ? `✓ Cert rendered in ${ms}ms` : '✓ Cert rendered', 'success');
  }
  return true;
}

// Step 17: writes lead.warranty so the homeowner-side portal can
// surface a Digital Warranty Card. Uses direct addDoc/updateDoc rather
// than NBDRepos because that helper insists on creating a brand-new
// document, and we want a merge-update onto the existing lead. Falls
// back gracefully when called outside the dashboard's Firebase context.
async function _persistWarrantyToLead({ leadId, tier, tierLabel, tierDesc, work, owner, address, installDate, certNumber, workmanshipLine, manufacturerLine }) {
  if (!leadId) return;
  if (!window._db || !window.doc || !window.updateDoc || !window.serverTimestamp) return;
  try {
    await window.updateDoc(window.doc(window._db, 'leads', leadId), {
      warranty: {
        tier,
        tierLabel,
        tierDesc,
        work,
        ownerName: owner,
        address,
        installDate: installDate || null,
        certNumber,
        // The two warranty lines the certificate printed (2026-10-06).
        workmanshipLine: workmanshipLine || '',
        manufacturerLine: manufacturerLine || '',
        // We pass the wall-clock millis here (not serverTimestamp)
        // because Firestore rejects nested serverTimestamp sentinels.
        // The outer updatedAt below is the source of truth for "when
        // the warranty record was created/updated".
        createdAtMs: Date.now(),
      },
      // 2026-09-15 (Paperwork Filing) — gates REQUIRED_FIELDS_BY_TYPE's CLOSED
      // checkpoint (crm-stages.js) for insurance/cash/finance job types.
      // Alongside the warranty:{...} write above, not a second updateDoc.
      warrantyCertFiledAt: new Date().toISOString(),
      updatedAt: window.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[warranty-cert] persist failed:', e && e.message || e);
  }
}

window.openWarrantyCertWizard = openWarrantyCertWizard;
window.updateCertPreview = updateCertPreview;
window.generateWarrantyCertPDF = generateWarrantyCertPDF;
// ══ END WARRANTY CERTIFICATE ═══════════════════════════════════════════════

// Window scope exposures
window.generateWarrantyCertPDF = generateWarrantyCertPDF;
window.openWarrantyCert = typeof openWarrantyCert === 'function' ? openWarrantyCert : null;
