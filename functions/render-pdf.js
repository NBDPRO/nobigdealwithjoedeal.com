/**
 * functions/render-pdf.js — server-side PDF rendering
 * ─────────────────────────────────────────────────────────────────
 *
 * THE document-quality overhaul (D-1). Replaces the html2canvas +
 * jsPDF rasterization pipeline with real Chromium-rendered PDFs:
 *   - Vector text (no canvas anti-aliasing)
 *   - Real PDF fonts (Barlow + Barlow Condensed embedded)
 *   - Native page breaks (@page CSS works correctly)
 *   - Multi-page running headers / footers
 *   - Tabular numerals, ligatures, kerning
 *
 * Architecture:
 *   1. Client calls `renderPdf({template, data, filename})` callable
 *   2. We load templates/<name>.hbs + design-system.css + partials
 *   3. Handlebars renders the body, embeds it into _layout.hbs
 *   4. Puppeteer launches Chromium, sets content, waits for fonts +
 *      images, calls page.pdf() with the precise sizing options
 *   5. We upload the PDF to Storage at pdf-renders/{uid}/{ts}-{slug}.pdf
 *      with a Cache-Control header (renders are immutable)
 *   6. Return a signed read URL good for 7 days
 *
 * Retention + read posture (2026-09-08): pdf-renders/ is owner/admin-read and
 * client-write-denied in storage.rules, and functions/pdf-render-retention.js
 * deletes objects past 30 days. Renders are derived artifacts — the Firestore
 * row they were built from is the system of record, not the PDF. Do NOT stamp
 * a `firebaseStorageDownloadTokens` value at upload time: a token bypasses
 * storage.rules permanently and unrevocably, and doing it unconditionally is
 * what made 19 of 21 prod objects publicly fetchable. See the upload block.
 *
 * Why a Cloud Function (not a Cloud Run service):
 *   - Already in our infra, single deploy target
 *   - 2GB memory holds Chromium; ~1.5s renders on a warm instance
 *   - @sparticuz/chromium ships a pruned Chromium binary that fits the
 *     function size limit (would not fit with full puppeteer)
 *
 * Cost: this ran minInstances:1 until 2026-09-05. The header estimated
 * that at "~$5-10/mo"; the actual bill was ~$17.92/mo, because a warm
 * instance is charged on memory as well as CPU and this one holds 2GiB
 * — 2.2× a 256MiB function. It now scales to zero, so renders pay a
 * ~10-20s Chromium cold start after an idle window instead of ~1.5s.
 * Per-render compute is bounded by the 30s timeout either way.
 */

'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions/v2');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { callableRateLimit } = require('./shared');
const { withSentry } = require('./integrations/sentry');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Handlebars = require('handlebars');
// Kentucky SB 153 + FTC Cooling-Off statutory text — byte-identical copy of
// docs/pro/js/ky-insurance-law.js (pinned by tests/ky-insurance-law.test.js).
const KyLaw = require('./ky-insurance-law');

const CORS_ORIGINS = [
  'https://nobigdealwithjoedeal.com',
  'https://www.nobigdealwithjoedeal.com',
  'https://nobigdeal-pro.web.app',
];

// ─── Template registry ─────────────────────────────────────────
// Lock the allowed template names server-side so a client can't
// arbitrarily render anything off disk. Each entry maps a template
// key to a Handlebars file in print/templates/. As D-2..D-5 land,
// they add lines here — that's the only API surface change.
const TEMPLATES = {
  warranty:   { file: 'warranty.hbs',   docType: 'Warranty Certificate', seal: 'Lifetime Pledge' },
  inspection: { file: 'inspection.hbs', docType: 'Inspection Report',    seal: 'Inspection' },
  estimate:   { file: 'estimate.hbs',   docType: 'Project Estimate',     seal: 'Estimate' },
  photoReport:{ file: 'photoReport.hbs',docType: 'Photo Report',         seal: 'Photo Report' },
  invoice:    { file: 'invoice.hbs',    docType: 'Invoice',              seal: 'Invoice' },
  contract:   { file: 'contract.hbs',   docType: 'Project Contract',     seal: 'Contract' },
  changeOrder:{ file: 'changeOrder.hbs',docType: 'Change Order',         seal: 'Change Order' },
  receipt:    { file: 'receipt.hbs',    docType: 'Payment Receipt',      seal: 'Receipt' },
  // photoReport:{ file: 'photoReport.hbs',docType: 'Photo Report',     seal: 'Photo Report' },
};

// ─── Cached loaders ────────────────────────────────────────────
// Templates + CSS + partials are read once per function instance. That
// used to mean "effectively at deploy time" under minInstances:1; now
// that it scales to zero it means once per cold start, which is part of
// the ~10-20s first render. We register partials here as well so
// {{> brandBandTop}} resolves at render time.
let _designCss = null;
const _tmplCache = new Map();

// Per-template CSS, cached like the templates themselves. Optional by design:
// most templates need nothing beyond the design system, so a missing file is
// the normal case and must not throw a cold start.
const _cssCache = new Map();
function loadTemplateCss(templateKey) {
  if (_cssCache.has(templateKey)) return _cssCache.get(templateKey);
  let css = '';
  try {
    css = fs.readFileSync(path.join(__dirname, 'print', 'templates', templateKey + '.css'), 'utf8');
  } catch (e) { /* no per-template stylesheet — the common case */ }
  _cssCache.set(templateKey, css);
  return css;
}

// Density presets are a closed set: an unknown or absent value must land on
// 'comfortable' rather than emitting an unmatched class that silently styles
// nothing, and must never interpolate caller text into a class attribute.
const DENSITIES = ['comfortable', 'compact', 'evidence'];
function normalizeDensity(v) {
  return DENSITIES.indexOf(String(v || '')) >= 0 ? String(v) : 'comfortable';
}

function loadDesignSystemCss() {
  if (_designCss) return _designCss;
  _designCss = fs.readFileSync(path.join(__dirname, 'print', 'design-system.css'), 'utf8');
  return _designCss;
}

function registerPartialsOnce() {
  if (Handlebars.partials.brandBandTop) return;
  const partialsDir = path.join(__dirname, 'print', 'partials');
  for (const f of fs.readdirSync(partialsDir)) {
    if (!f.endsWith('.hbs') || f.startsWith('_')) continue;
    const name = f.replace(/\.hbs$/, '');
    Handlebars.registerPartial(name, fs.readFileSync(path.join(partialsDir, f), 'utf8'));
  }
}

// ─── Handlebars helpers ───────────────────────────────────────
// Registered once per cold-start. Templates that need additional
// helpers add them here so the renderer stays the one place that
// knows about template internals.
function registerHelpersOnce() {
  if (Handlebars.helpers.severityClass) return;

  // Map a condition string to the badge CSS class — used by
  // the inspection template's component findings table.
  Handlebars.registerHelper('severityClass', (cond) => {
    const c = String(cond || '').toLowerCase();
    if (c === 'critical')        return 'sev-critical';
    if (c === 'poor')            return 'sev-poor';
    if (c === 'fair')            return 'sev-fair';
    if (c === 'good')            return 'sev-good';
    return 'sev-neutral';
  });

  // Inline math for column counts, photo grids, etc.
  Handlebars.registerHelper('inc', (n) => Number(n) + 1);
  Handlebars.registerHelper('gt',  (a, b) => Number(a) > Number(b));
  Handlebars.registerHelper('eq',  (a, b) => a === b);
  Handlebars.registerHelper('add', (a, b) => Number(a) + Number(b));
  Handlebars.registerHelper('sub', (a, b) => Number(a) - Number(b));
  Handlebars.registerHelper('mul', (a, b) => Number(a) * Number(b));

  // Format a Date | ISO | timestamp into "Month D, YYYY" in en-US.
  // Templates pass raw values from the lead; we don't trust them
  // to pre-format.
  Handlebars.registerHelper('fmtDate', (v) => {
    if (!v) return '';
    let d;
    if (v instanceof Date) d = v;
    else if (typeof v === 'number') d = new Date(v);
    else if (typeof v === 'string') d = new Date(v);
    else if (v && typeof v.toMillis === 'function') d = new Date(v.toMillis());
    else return String(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  });

  // Tabular-num money formatter. We do the formatting in the
  // template (not CSS) so cells line up regardless of font fallback.
  //
  // Whole dollars print as they always did ("$6,988"); an amount with cents
  // prints its cents ("$6,988.13") — the same rule as the client's
  // fmtMoneyBig (estimate-finalization.js). Review of #1763 (2026-09-25):
  // this rounded every figure to the dollar, so an upgraded Job Template
  // quote (upgrades + their exact tax on a $25-rounded base) downloaded from
  // the server render as $6,988 — Project Total, Subtotal and Tax — while
  // the screen, contract, portal and invoice showed $6,988.13.
  Handlebars.registerHelper('money', (v) => {
    const n = Number(v);
    if (!isFinite(n)) return '—';
    const c = Math.round(n * 100);
    const digits = (c % 100 === 0) ? 0 : 2;
    return '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  });

  // Counter for {{photoCount}} and similar.
  Handlebars.registerHelper('len', (v) => Array.isArray(v) ? v.length : 0);

  // ── D-6 report-builder helpers ──────────────────────────────
  // Rep-authored prose arrives as plain text from a <textarea>. Escape it
  // ourselves and hand back a SafeString so the paragraph breaks the rep typed
  // survive; a bare {{{triple-stache}}} on this would be an HTML injection
  // straight into a customer-facing PDF, since the text is user input.
  Handlebars.registerHelper('nl2br', (v) => {
    const esc = hbsEsc(v == null ? '' : v);
    return new Handlebars.SafeString(
      esc.replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')
        .replace(/^/, '<p>').replace(/$/, '</p>')
    );
  });

  // Photo-grid column class. An explicit opts.columns wins; otherwise fall
  // back to D-4's rule — three-up once a section runs past six photos.
  Handlebars.registerHelper('gridClass', (opts, photos) => {
    const n = Number(opts && opts.columns) || 0;
    if (n === 1) return ' one';
    if (n === 2) return '';           // two-up is the stylesheet default
    if (n === 3) return ' three';
    if (n >= 4) return ' four';
    return (Array.isArray(photos) && photos.length > 6) ? ' three' : '';
  });

  // Which signature blocks to render. opts.signature is authoritative when
  // set; with no opts we reproduce D-4 exactly — adjuster mode signs, the
  // homeowner report has no acceptance line.
  Handlebars.registerHelper('signOff', (opts, mode, which) => {
    const s = opts && opts.signature;
    if (s === 'both') return true;
    if (s === 'none') return false;
    if (s === 'homeowner' || s === 'adjuster') return s === which;
    return mode === 'adjuster' && which === 'adjuster';
  });
}

function loadTemplate(file) {
  if (_tmplCache.has(file)) return _tmplCache.get(file);
  const src = fs.readFileSync(path.join(__dirname, 'print', 'templates', file), 'utf8');
  const compiled = Handlebars.compile(src);
  _tmplCache.set(file, compiled);
  return compiled;
}

function loadLayout() {
  if (_tmplCache.has('_layout')) return _tmplCache.get('_layout');
  const src = fs.readFileSync(path.join(__dirname, 'print', 'partials', '_layout.hbs'), 'utf8');
  const compiled = Handlebars.compile(src);
  _tmplCache.set('_layout', compiled);
  return compiled;
}

// ─── Puppeteer / Chromium boot (lazy + single instance) ────────
// Holding a single browser across invocations is the standard
// pattern for serverless Puppeteer — boot time is ~1.5s cold,
// ~50ms with the browser still attached.
let _browser = null;

// Unwrap @sparticuz/chromium regardless of how the package is built.
//
// v149.0.0 dropped its CommonJS build. Its package.json is "type":"module"
// with a single export condition ({".":{"types":..,"default":"./build/index.js"}}),
// so require() on the nodejs22 runtime takes the require(esm) path and hands
// back the ES module NAMESPACE — { __esModule, default, inflate,
// setupLambdaEnvironment } — not the module object. The real API is a class on
// `.default`, so BOTH `chromium.executablePath` and `chromium.args` read
// undefined off the namespace. `await undefined()` is what produced
// "chromium.executablePath is not a function" at stage:launch on 100% of
// renders from the 148->149 bump (#712, 2026-06-24) onward.
//
// v148 shipped dual CJS/ESM — its "require" condition resolved to a .cjs with
// executablePath/args as direct properties and no `.default` at all — which is
// why the bump alone broke it with no code change.
//
// Probe for the API rather than reaching for `.default` unconditionally, so
// this survives the package flipping back to CJS (where `.default` is absent).
// Throw a legible error if neither shape carries it: the next packaging change
// should name itself instead of resurfacing as "not a function".
function resolveChromium(mod) {
  for (const candidate of [mod, mod && mod.default]) {
    if (candidate && typeof candidate.executablePath === 'function') return candidate;
  }
  throw new Error(
    '@sparticuz/chromium exports no executablePath(); got ' +
    (mod && typeof mod === 'object'
      ? 'keys [' + Object.keys(mod).join(', ') + ']'
      : typeof mod)
  );
}

async function getBrowser() {
  if (_browser && _browser.isConnected && _browser.isConnected()) {
    return _browser;
  }
  const chromium = resolveChromium(require('@sparticuz/chromium'));
  const puppeteer = require('puppeteer-core');
  _browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: { width: 1280, height: 1696, deviceScaleFactor: 2 },
    executablePath: await chromium.executablePath(),
    headless: 'shell',
  });
  return _browser;
}

// ─── renderPdf outcome counters (health-digest signal) ─────────
// metrics/renderPdf carries LIFETIME ok/fail counters plus the last success
// and failure timestamps, mirroring metrics/imagePipeline. The digest judges
// health on whether a SUCCESS landed inside its window rather than on the
// totals, because the failure mode worth catching is the one that just
// happened: the 148->149 interop break failed 100% of renders for eleven
// weeks with no `[renderPdf] ok` line anywhere in log retention, and nothing
// alerted, because nothing was watching this path at all. A rising fail count
// is a weaker signal than a missing success.
//
// Best-effort by construction. A metrics write must never turn a good render
// into a failed one, and on the failure path it must not mask the real error —
// so it swallows its own exception and logs instead.
async function recordRenderOutcome(ok, info) {
  const patch = ok
    ? {
      okCount: FieldValue.increment(1),
      lastOkAt: FieldValue.serverTimestamp(),
      lastOkTemplate: (info && info.template) || '',
    }
    : {
      failCount: FieldValue.increment(1),
      lastFailAt: FieldValue.serverTimestamp(),
      lastFailStage: (info && info.stage) || '',
      lastFailTemplate: (info && info.template) || '',
      // Bounded: the message can carry a stack-ish tail, and this lands in an
      // email body.
      lastFailErr: String((info && info.err) || '').slice(0, 300),
    };
  try {
    await getFirestore().doc('metrics/renderPdf').set(patch, { merge: true });
  } catch (e) {
    logger.warn('[renderPdf] metrics write failed', { err: e && e.message });
  }
}

// ─── Tenant brand for document chrome (Phase B-4) ──────────────
// Resolve the caller's tenant brand server-side from their companyId claim.
// NBD — and any tenant without a distinct companyProfile.brand — renders the
// canonical NBD chrome, byte-identical. The .hbs partials consume these fields.
const NBD_DOC_COMPANY = {
  // isNbd lets the body templates (warranty.hbs / coverPage.hbs) hold the
  // canonical NBD literals byte-identical behind {{#if company.isNbd}} while a
  // stranger tenant renders its own resolved chrome. NBD → true.
  isNbd: true,
  // brandBandTop.hbs renders this into a 42x42pt `.brand-mark` box with
  // object-fit:cover (design-system.css) — a 1:1 crop meant for an ICON, not
  // a wordmark. Before 2026-09-15 this pointed at nbd-logo.png: harmless
  // while that asset was 135x75 (the old roofline icon happened to sit
  // center-left and survive the crop), but the 2026-09-14 brand refresh
  // (#1570) replaced it with a 600x308 pure-wordmark PNG, so every PDF this
  // CRM generates (contract/estimate/invoice/warranty/receipt/changeOrder/
  // inspection/photoReport — all of TEMPLATES) had cropped the wordmark down
  // to an illegible "DE" fragment since #1570 merged. apple-touch-icon.png
  // is the canonical square (180x180) home-solutions mark and needs no CSS
  // change. See tests/render-pdf-brand-mark-square.test.js — it would have
  // caught this the moment #1570 landed.
  logoUrl: 'https://nobigdealwithjoedeal.com/assets/images/apple-touch-icon.png',
  nameHtml: 'No Big <span class="accent">Deal</span> Home Solutions',
  footerName: 'No Big Deal Home Solutions',
  // Was 'Insurance Restoration Specialists' — KRS 367.628(1)(a)2 bars a
  // contractor holding itself out as an insurance/claims specialist (2026-09-27).
  brandTag: 'Roofing · Siding · Gutters · Greater Cincinnati',
  brandContact: '(859) 420-7382 · jd@nobigdealwithjoedeal.com',
  footerContact: '(859) 420-7382 · jd@nobigdealwithjoedeal.com · Greater Cincinnati, OH',
  // Individual contact pieces the invoice/receipt body templates reference
  // (they used to hardcode these). NBD keeps the exact literals → byte-identical.
  email: 'jd@nobigdealwithjoedeal.com',
  phone: '(859) 420-7382',
  contactName: 'Joe',
  seal: 'NBD',
  colors: null,
  // Credential badges — affiliateRow.hbs (see NBD Document Standard section
  // 5). Real https:// URLs, not data URIs: Puppeteer fetches them like any
  // other page resource, unlike the browser doc viewer's srcdoc iframe
  // (see docs/pro/js/nbd-badge-assets.js for why THAT context needs a
  // data URI). Same three badges, same 'no member number' note as
  // company-profile.js's client-side affiliates default.
  affiliates: [
    { name: 'GAF Certified',            number: '#1162011',
      imageUrl: 'https://nobigdealwithjoedeal.com/assets/gaf/gaf-certified-badge-120.png' },
    { name: 'TAMKO Pro Gold',           number: '#181382',
      imageUrl: 'https://nobigdealwithjoedeal.com/assets/tamko/tamko-pro-gold-badge-120.png' },
    { name: 'Locally Owned & Operated', number: '',
      imageUrl: 'https://nobigdealwithjoedeal.com/assets/american-operator/american-operator-badge-120.png',
      alt: 'Locally Owned & Operated — Certified by American Operator' },
  ],
};
// Tenant-zero (platform) owner uid — solo convention: companyId == owner uid.
// Same source of truth as estimate-email.js / lead-bridge.js / stripe.js.
const NBD_OWNER_UID = process.env.NBD_OWNER_UID || '1phDvAVXHSg82wDLegAbQFq14Ci1';

// What a NON-platform tenant renders when we cannot resolve their brand.
//
// This exists because NBD_DOC_COMPANY was the fallback for EVERY unresolved
// case, so a tenant whose companyProfile was missing or incomplete got the
// platform owner's logo, legal name, tagline, phone, email, contact name and
// seal stamped onto their contracts, warranties and invoices — paper a
// homeowner signs, naming the wrong contracting party.
//
// That is not a hypothetical edge: provisioning is BEST-EFFORT. register.js
// catches createCompany failure at three separate sites and only
// console.warn's "createCompany failed (account still usable)", so a
// contractor whose signup hiccupped ends up with a working account, no
// companyProfile doc, and Joe's identity on his paperwork.
//
// Blank beats wrong. Every field the tenant branch already blanks (logo, seal,
// contactName) is blanked here too, and the name/contact lines go empty rather
// than borrowing someone else's — the printed forms carry ruled lines for
// writing them in. isNbd:false so every {{#if company.isNbd}} branch renders
// the neutral side and coverPage.hbs's {{else}} company fallback fires.
const NEUTRAL_DOC_COMPANY = {
  isNbd: false,
  logoUrl: '',
  nameHtml: '',
  footerName: '',
  brandTag: '',
  brandContact: '',
  footerContact: '',
  email: '',
  phone: '',
  contactName: '',
  seal: '',
  colors: null,
  affiliates: [],
};

function hbsEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Native running footer ────────────────────────────────────────
// Chromium's headerTemplate/footerTemplate is an ISOLATED document: it does not
// inherit the page's stylesheet, external CSS never loads, and the default font
// size is 0 — so every rule here has to be inline and every size explicit, or
// the footer silently renders as nothing. `.pageNumber` / `.totalPages` are the
// two magic classes Chromium substitutes at paint time; they are the only way
// to number pages in this renderer, since it implements no CSS Paged Media
// counters.
//
// Tenant-safe by construction: every string comes from the resolved {{company}}
// chrome, which resolveDocCompany() already de-brands for stranger tenants
// (NEUTRAL_DOC_COMPANY), so this cannot stamp NBD's name or number on someone
// else's document. Values are escaped — footerName is tenant-controlled input.
function buildFooterTemplate(company, tmplCfg, docNumber) {
  const c = company || {};
  const left = [c.footerName, c.phone].filter(Boolean).map(hbsEsc).join(' &middot; ');
  const doc = [tmplCfg && tmplCfg.docType, docNumber].filter(Boolean).map(hbsEsc).join(' &middot; ');
  // Barlow is loaded by _layout for the page body, but NOT inside this isolated
  // footer document — name a real system stack so the footer never falls back
  // to a serif that matches nothing else on the page.
  return (
    '<div style="width:100%;box-sizing:border-box;padding:0 18mm;' +
      'font-family:Barlow,\'Segoe UI\',Arial,sans-serif;font-size:7.5pt;' +
      'line-height:1.3;color:#5A6472;-webkit-print-color-adjust:exact;">' +
      '<div style="border-top:0.5pt solid #D8D3CB;padding-top:5pt;' +
        'display:flex;justify-content:space-between;align-items:baseline;gap:12pt;">' +
        '<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + left + '</span>' +
        (doc ? '<span style="white-space:nowrap;">' + doc + '</span>' : '') +
        '<span style="white-space:nowrap;">Page <span class="pageNumber"></span>' +
          ' of <span class="totalPages"></span></span>' +
      '</div>' +
    '</div>'
  );
}
// Phase B-4b: inject the tenant's brand colours as a :root override appended
// AFTER the static design-system :root (equal specificity → later rule wins).
// NBD → '' (byte-identical render). Only the dominant brand tokens are mapped.
function hexToRgb(hex) {
  const s = String(hex || '');
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(s);
  if (m) return parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16);
  // 3-digit shorthand (#fc0) — a tenant accent written short would otherwise
  // fail to parse and the soft/line tints would fall back to NBD orange (L5).
  const s3 = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(s);
  if (s3) return parseInt(s3[1] + s3[1], 16) + ', ' + parseInt(s3[2] + s3[2], 16) + ', ' + parseInt(s3[3] + s3[3], 16);
  return null;
}
// Darken a hex by `f` (0..1) for the *-dark accent token, so the tenant gets a
// real darker shade instead of the accent repeated (L4). Falls back to the
// input if it can't be parsed.
function darken(hex, f) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const parts = rgb.split(',').map(function (n) {
    const v = Math.max(0, Math.min(255, Math.round(parseInt(n, 10) * (1 - f))));
    return ('0' + v.toString(16)).slice(-2);
  });
  return '#' + parts.join('');
}
function buildBrandVars(colors) {
  if (!colors) return '';
  const v = [];
  if (colors.accent) {
    v.push('--nbd-orange:' + colors.accent);
    v.push('--nbd-orange-dark:' + darken(colors.accent, 0.15));
    const rgb = hexToRgb(colors.accent);
    if (rgb) {
      v.push('--nbd-orange-soft:rgba(' + rgb + ',0.08)');
      v.push('--nbd-orange-line:rgba(' + rgb + ',0.35)');
    }
  }
  const charcoal = colors.charcoal || colors.primary;
  if (charcoal) {
    v.push('--nbd-charcoal:' + charcoal);
    v.push('--nbd-ink:' + (colors.ink || charcoal));
  }
  return v.length ? ':root{' + v.join(';') + ';}' : '';
}
async function resolveDocCompany(companyId) {
  // The platform tenant — and ONLY the platform tenant — gets the NBD chrome
  // when its brand can't be resolved. Everyone else falls back to neutral.
  // This used to be the fallback for all four unresolved cases below (no
  // companyId, no profile doc, no legalName, and a thrown read), which is how
  // the owner's identity reached other contractors' documents.
  const isPlatform = String(companyId || '') === NBD_OWNER_UID;
  const UNRESOLVED = isPlatform ? NBD_DOC_COMPANY : NEUTRAL_DOC_COMPANY;
  if (!companyId) return UNRESOLVED;
  try {
    const snap = await getFirestore().collection('companyProfile').doc(String(companyId)).get();
    if (snap.exists) {
      const b = (snap.data() || {}).brand || {};
      if (b.legalName && b.legalName !== NBD_DOC_COMPANY.footerName) {
        const c = b.contact || {};
        // logo/seal fall back to BLANK, never NBD's — a non-NBD tenant that
        // didn't set its own must not stamp NBD's logo or 'NBD' seal on its
        // PDF (review M1). `b` is the raw, un-merged override, so c.* is already
        // the tenant's own value or undefined.
        return {
          // Resolved brand is a stranger tenant, NOT NBD → the templates must
          // NOT stamp any NBD literal. Every {{#if company.isNbd}} branch below
          // renders the tenant/neutral side.
          isNbd: false,
          logoUrl: b.logoUrl || '',
          nameHtml: hbsEsc(b.legalName),
          footerName: b.legalName,
          brandTag: b.tagline || '',
          brandContact: [c.phone, c.email].filter(Boolean).join(' · '),
          footerContact: [c.phone, c.email, c.address].filter(Boolean).join(' · '),
          email: c.email || '',
          phone: c.phone || '',
          contactName: '', // tenants have no per-person first name; never 'Joe'
          seal: b.seal || '',
          colors: b.colors || null,
          // Same rule as logo/seal above: a tenant's own affiliates only —
          // never NBD's GAF/TAMKO/American Operator badges. A tenant that
          // set name/number without imageUrl gets affiliateRow.hbs's plain
          // text-card fallback, same as the client-side renderer.
          affiliates: Array.isArray(b.affiliates) ? b.affiliates : [],
        };
      }
    }
  } catch (e) {
    logger.error('[renderPdf] tenant resolve failed', { companyId, err: e && e.message });
  }
  // Unresolved. Platform → NBD chrome (unchanged, byte-identical). Any other
  // tenant → neutral, never the owner's identity. Logged because for a tenant
  // this means their companyProfile is missing or has no legalName — usually a
  // failed/incomplete provisioning — and the document goes out unbranded.
  if (!isPlatform) {
    logger.warn('[renderPdf] unresolved tenant brand — rendering neutral', { companyId });
  }
  return UNRESOLVED;
}

// ─── Statutory contract blocks (2026-09-27, KY SB 153 + FTC 16 CFR 429) ───
// The contractor's address/email/fax come from the TENANT'S OWN
// companyProfile, read here — the client payload only carries job facts.
// Blank beats wrong: an unresolvable tenant gets '' (never NBD's address).
async function resolveContractorContact(companyId, company) {
  const out = { address: '', email: (company && company.email) || '', fax: '', timeZone: KyLaw.DEFAULT_TIME_ZONE };
  if (!companyId) return out;
  try {
    const snap = await getFirestore().collection('companyProfile').doc(String(companyId)).get();
    if (snap.exists) {
      const p = snap.data() || {};
      const c = (p.brand && p.brand.contact) || {};
      // brand.contact.mailingAddress ONLY (Jo, 2026-09-27): the address prints
      // only where the law requires it, never from the letterhead field.
      out.address = KyLaw.contractorMailingAddress(p);
      out.email = String(p.businessEmail || c.email || out.email || '').trim();
      out.fax = String(p.businessFax || c.fax || '').trim();
      out.timeZone = KyLaw.resolveTimeZone(p);
    }
  } catch (e) {
    logger.error('[renderPdf] contractor contact resolve failed', { companyId, err: e && e.message });
  }
  return out;
}

// Pure: payload + contractor contact → the statutory HTML the contract
// template prints with triple-stash. Re-classifies the job with the server's
// own copy of ky-insurance-law.js; a client "kentucky/insurance" flag can only
// ADD protection, never remove it (fail closed).
//   { css, kyInsurance, contractorAddress, kyNoticesHtml, kyFormsHtml,
//     lienClause, ftcStatementHtml, ftcFormsHtml, missingAddress }
function buildContractStatutory(payload, contractor, company) {
  const p = payload || {};
  const facts = (p.jurisdiction && typeof p.jurisdiction === 'object') ? p.jurisdiction : {};
  const j = KyLaw.classify(Object.assign({}, facts, {
    address: facts.address || (p.preparedFor && p.preparedFor.address) || '',
  }));
  const kyInsurance = j.kyInsurance || facts.kyInsurance === true ||
    ((j.insurance || facts.insurance === true) && (j.kentucky || facts.kentucky === true));
  const c = contractor || {};
  // The signing date: the client's local-date stamp, else NOW read in the
  // tenant's timezone (default America/New_York) — this function runs on a
  // UTC clock, so a bare new Date() would date a 10 pm Kentucky signing
  // tomorrow and push the FTC deadline a day late.
  const timeZone = c.timeZone || KyLaw.DEFAULT_TIME_ZONE;
  const txDate = p.transactionDate || (p.contract && p.contract.date) || new Date();
  const out = {
    css: '', kyInsurance, contractorAddress: '', contractorFax: '',
    kyNoticesHtml: '', kyFormsHtml: '', lienClause: '',
    ftcStatementHtml: '', ftcFormsHtml: '', missingAddress: false,
    // The plain Payment clause, every contract (Jo, 2026-09-27) — the same
    // string the client contract prints.
    paymentClause: KyLaw.PAYMENT_CLAUSE,
  };
  // The FTC form is attached wherever the contract's cancel sentence promises
  // "the attached Notice of Cancellation form" (the default text does).
  if (/notice of cancellation/i.test(String(p.rightToCancel || ''))) {
    out.css = KyLaw.STATUTORY_CSS;
    out.ftcStatementHtml = KyLaw.ftcStatementHtml();
    out.ftcFormsHtml = KyLaw.ftcCancellationFormsHtml({
      transactionDate: txDate, timeZone,
      sellerName: (company && company.footerName) || '',
      sellerAddress: c.address || '',
    });
  }
  if (kyInsurance) {
    out.css = KyLaw.STATUTORY_CSS;
    out.contractorAddress = c.address || '';
    out.contractorFax = c.fax || '';
    out.contractorEmail = c.email || '';
    out.missingAddress = !c.address;
    out.kyNoticesHtml = KyLaw.kyNoticesHtml();
    out.lienClause = KyLaw.KY_LIEN_CLAUSE;
    out.kyFormsHtml = KyLaw.kyCancellationFormsHtml({
      transactionDate: txDate, timeZone, physicalAddress: c.address || '', email: c.email || '', fax: c.fax || '',
    });
  }
  return out;
}

// ─── Main callable ─────────────────────────────────────────────
exports.renderPdf = onCall(
  {
    region: 'us-central1',
    cors: CORS_ORIGINS,
    enforceAppCheck: true,
    timeoutSeconds: 60,
    // Chromium needs real memory. 1GB is borderline; 2GB is the
    // sweet spot for a single render plus future inspection reports
    // with 30+ photos.
    memory: '2GiB',
    // minInstances was 1, to spare the rep a cold start when generating
    // a cert at end-of-job. At 2GiB that single warm instance cost
    // ~$17.92/mo — more than any of the three 256MiB functions, and by
    // itself most of a $25/mo budget. THIS IS THE ONE YOU WILL FEEL:
    // Chromium cold start is ~10-20s against ~1.5s warm. It is worth
    // reinstating before the others if reps complain, but price it
    // knowing a 2GiB warm instance is ~2.2× a 256MiB one.
    minInstances: 0,
    maxInstances: 10,
  },
  withSentry('renderPdf', async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Sign in required');

    // Phase-3.2: rate-limit the expensive Puppeteer render (2GiB, now
    // minInstances:0). Auth + App Check gate WHO can call it, but nothing
    // capped HOW OFTEN — a loop could rack up Chromium compute cost.
    // 30/min/uid is generous for a rep generating end-of-job docs
    // (contract + warranty + invoice + photo report in a burst), tight
    // against an abuse loop.
    await callableRateLimit(request, 'renderPdf', 30, 60_000);

    // ── input validation ──
    const data = request.data || {};
    const templateKey = String(data.template || '').trim();
    if (!templateKey || !TEMPLATES[templateKey]) {
      throw new HttpsError('invalid-argument', 'Unknown template');
    }
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
    const filename = (typeof data.filename === 'string' ? data.filename : '')
      .trim()
      .replace(/[^A-Za-z0-9_\-\.]/g, '_')
      .slice(0, 120) || (templateKey + '.pdf');

    const tmplCfg = TEMPLATES[templateKey];
    const t0 = Date.now();

    // ── render the HTML body via Handlebars ──
    registerPartialsOnce();
    registerHelpersOnce();
    const bodyCompiled = loadTemplate(tmplCfg.file);
    const layoutCompiled = loadLayout();

    // Resolve the active tenant's brand from the caller's companyId claim
    // (solo-op convention: companyId == uid). NBD → byte-identical chrome.
    const companyId = (request.auth.token && request.auth.token.companyId) || uid;
    const company = await resolveDocCompany(companyId);
    const brandVars = buildBrandVars(company.colors);

    // Contract only: KRS 367.624 notices + detachable cancellation forms for a
    // Kentucky insurance job, the FTC form wherever the cancel sentence
    // promises one. A Kentucky insurance contract cannot be completed without
    // the contractor's physical address, so it is refused rather than printed
    // with a blank (the client pre-flight blocks the same case first).
    let statutory = null;
    if (templateKey === 'contract') {
      const contractor = await resolveContractorContact(companyId, company);
      statutory = buildContractStatutory(payload, contractor, company);
      if (statutory.kyInsurance && statutory.missingAddress) {
        throw new HttpsError('failed-precondition', KyLaw.MSG.addressRequired);
      }
    }

    const bodyHtml = bodyCompiled(Object.assign({}, payload, { company }, statutory ? { statutory } : {}));
    // Hoisted so the native footer template (page.pdf below) can stamp the same
    // document number the layout puts in the masthead.
    const docNumberForChrome = payload.certNumber || payload.docNumber || '';
    const html = layoutCompiled({
      title:           tmplCfg.docType,
      docType:         tmplCfg.docType,
      seal:            tmplCfg.seal,
      docNumber:       docNumberForChrome,
      designSystemCss: loadDesignSystemCss(),
      brandVars:       brandVars,
      // Per-template overrides. The slot has existed since D-1 and was wired to
      // '' with a "reserved for later" note, so a template that needed its own
      // rules had no home for them and had to inline styles into the .hbs.
      // It now loads print/templates/<key>.css when that file exists.
      templateCss:     loadTemplateCss(templateKey),
      // Density preset — 'comfortable' (default) | 'compact' | 'evidence'.
      // A body class rather than a payload flag threaded through every block,
      // so a preset is a stylesheet concern and the template stays structural.
      bodyClass:       'pr-density-' + normalizeDensity(payload.opts && payload.opts.density)
                       + (payload.opts && payload.opts.fit === 'contain' ? ' pr-fit-contain' : ''),
      company:         company,
      body:            bodyHtml,
    });
    const buildMs = Date.now() - t0;

    // ── render the PDF via Chromium ──
    // Track the current stage so a failure surfaces as a labeled log line +
    // HttpsError detail instead of an opaque INTERNAL (B-7 / V2-4). Without
    // this, ANY raw throw (Chromium launch, font-stall timeout, signBlob IAM,
    // upload) collapsed to a bare "INTERNAL" and the whole server-render path
    // silently fell back to html2canvas with no way to tell which failed.
    let stage = 'launch';
    let pdfBuffer, bucket, objectPath, file, downloadToken, renderMs;
    try {
      const browser = await getBrowser();
      const page = await browser.newPage();
      try {
        stage = 'setContent';
        // Cap setContent so a stalled remote asset (Google Fonts, logo) can't
        // burn the whole 60s function budget before failing.
        await page.setContent(html, { waitUntil: ['load', 'networkidle0'], timeout: 25_000 });
        // Wait for fonts to decode, but race a never-resolving font-face
        // against a short ceiling so it can't hang the render.
        stage = 'fonts';
        await Promise.race([
          page.evaluateHandle('document.fonts.ready'),
          new Promise((resolve) => setTimeout(resolve, 4_000)),
        ]);
        stage = 'pdf';
        pdfBuffer = await page.pdf({
          format: 'Letter',
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: '0', bottom: '0', left: '0', right: '0' }, // controlled by @page
          // The running footer + page numbers. This MUST be Chromium's native
          // header/footer: design-system.css asked for them with CSS Paged
          // Media (`position: running(footer)` + `@page { @bottom-center {
          // content: element(footer) } }`), and Chromium implements NEITHER —
          // `CSS.supports('position','running(footer)')` is false, so the
          // declaration was dropped, `.doc-band-bottom` fell back to static,
          // and the seal band rendered ONCE in normal flow at the top of page
          // one, above the cover. Every document this renderer has ever
          // produced — all eight types — shipped that way, with no page
          // numbers at all.
          //
          // Margins stay at 0 here on purpose: `preferCSSPageSize: true` makes
          // the CSS @page box authoritative, so these values are ignored and
          // @page's 18/22/18/18mm still owns the geometry. Chromium draws the
          // native footer into the physical page margin that @page already
          // keeps clear — measured at y=768 on a 792pt page, with body content
          // ending at y=645. No overlap, and the page count is unchanged from
          // before this fix.
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate: buildFooterTemplate(company, tmplCfg, docNumberForChrome),
          timeout: 25_000,
        });
      } finally {
        await page.close().catch(() => {});
      }
      renderMs = Date.now() - t0 - buildMs;

      // ── upload to Storage with a deterministic-ish key ──
      // NO download token is stamped here. It used to be minted
      // unconditionally so the fallback below would always have one to hand
      // back — but that stamped a permanent, rules-bypassing public URL onto
      // EVERY render, including the overwhelming majority where getSignedUrl()
      // succeeded and the token was never used or even returned to anyone.
      //
      // Measured 2026-09-08: 19 of 21 objects under pdf-renders/ in prod
      // carried one, and an unauthenticated HEAD on a customer roofing
      // contract returned 200 OK, application/pdf. The identical URL with the
      // token stripped returned 403 — the token was exactly what made it
      // public. The token is now minted lazily, only if signing actually
      // fails (see the fallback below).
      //
      // cacheControl is `private`, not `public`: these are customer invoices
      // and contracts. `public` is a caching directive, not an ACL, but it
      // licenses shared caches and proxies to retain the bytes; `private`
      // keeps the browser cache (all the callable needs) without that.
      stage = 'upload';
      bucket = getStorage().bucket();
      const ts = Date.now();
      objectPath = `pdf-renders/${uid}/${ts}-${filename}`;
      file = bucket.file(objectPath);
      await file.save(pdfBuffer, {
        metadata: {
          contentType: 'application/pdf',
          cacheControl: 'private, max-age=31536000, immutable',
          metadata: {
            template: templateKey, renderedBy: uid, renderedAtMs: String(ts),
          },
        },
        resumable: false,
      });
    } catch (e) {
      // Don't flatten an already-typed HttpsError (e.g. a future domain-specific
      // throw moved inside this block) into a generic internal error.
      if (e instanceof HttpsError) throw e;
      // The diagnosis blocker fix: log the real cause + which stage, and put
      // the stage in the HttpsError details so the client console shows it too.
      logger.error('[renderPdf] render failed', {
        stage, template: templateKey, uid, err: e && e.message, stack: e && e.stack,
      });
      await recordRenderOutcome(false, { stage, template: templateKey, err: e && e.message });
      throw new HttpsError('internal', 'PDF render failed at stage: ' + stage, { stage });
    }

    // URL strategy (B-7 / V2-4 fix): getSignedUrl() calls the IAM signBlob API,
    // which the function's default compute service account can't reach without
    // roles/iam.serviceAccountTokenCreator — the SAME gap that breaks
    // createCustomToken (access-code-login-iam-gap). When signing fails the
    // whole render threw and the client only saw a bare INTERNAL, so the entire
    // server-render path silently fell back to html2canvas. We try the signed
    // URL (7-day expiry) and fall back to a Firebase download-token URL so the
    // render succeeds either way.
    //
    // 2026-09-08: that IAM grant IS in place now —
    // `717435841570-compute@developer.gserviceaccount.com` holds
    // roles/iam.serviceAccountTokenCreator on nobigdeal-pro (verified against
    // the live project IAM policy), so signing is the live path and the
    // fallback should never fire. The fallback is KEPT rather than deleted
    // because removing it re-arms the original failure mode: an IAM policy is
    // editable from a console by someone who has no idea this callable depends
    // on it, and the observed symptom last time was the whole server-render
    // path silently degrading to html2canvas.
    //
    // What changed is the cost of that insurance. The token is now minted HERE,
    // lazily, instead of being stamped on every object at upload — so it exists
    // only on renders that actually could not be signed, and `urlMode` in the
    // success log is a true record of which objects carry one.
    let url;
    let urlMode;
    try {
      const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        // 7 days — same envelope as portal share tokens; long enough
        // for the rep to email/download but not "forever public".
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
      });
      url = signedUrl;
      urlMode = 'signed';
    } catch (signErr) {
      // Signing failed — mint a token now and attach it, so this object (and
      // only this object) gets a fetchable URL. pdfRenderRetention deletes it
      // within RETENTION_DAYS, which is the only true revocation for a token.
      downloadToken = crypto.randomUUID();
      try {
        await file.setMetadata({
          metadata: {
            template: templateKey, renderedBy: uid, renderedAtMs: String(Date.now()),
            firebaseStorageDownloadTokens: downloadToken,
          },
        });
      } catch (metaErr) {
        // Neither URL strategy worked. Fail loudly instead of returning a URL
        // that 403s — a silent bad link is what the B-7 fix set out to kill.
        logger.error('[renderPdf] no usable URL: signing and token-stamp both failed', {
          uid, path: objectPath,
          signErr: signErr && signErr.message,
          metaErr: metaErr && metaErr.message,
        });
        throw new HttpsError('internal', 'PDF rendered but no readable URL could be issued', {
          stage: 'url',
        });
      }
      const encodedPath = encodeURIComponent(objectPath);
      url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodedPath}?alt=media&token=${downloadToken}`;
      urlMode = 'download-token';
      // WARN, not info: this path leaves a permanent public URL behind, and
      // the IAM grant that makes it unnecessary is already in place — so this
      // firing means something regressed in the project's IAM policy.
      logger.warn('[renderPdf] getSignedUrl unavailable, minted download-token URL', {
        uid, path: objectPath, err: signErr && signErr.message,
      });
    }

    const totalMs = Date.now() - t0;
    logger.info('[renderPdf] ok', { template: templateKey, uid, urlMode, buildMs, renderMs, totalMs, bytes: pdfBuffer.length });
    await recordRenderOutcome(true, { template: templateKey });

    return {
      ok: true,
      url: url,
      path: objectPath,
      filename,
      bytes: pdfBuffer.length,
      timing: { buildMs, renderMs, totalMs },
    };
  })
);

// Exposed for tests. Pure — takes the resolved company chrome and returns the
// Chromium footerTemplate string. Lets the running-footer contract (page-number
// placeholders present, tenant strings escaped, no NBD literal for a stranger)
// be asserted on the real function instead of grepped for in the source.
exports._buildFooterTemplate = buildFooterTemplate;
// For tests: the statutory contract blocks (KY SB 153 / FTC 16 CFR 429).
exports._buildContractStatutory = buildContractStatutory;
// Also for tests: registering the real helpers against the shared Handlebars
// instance lets a harness compile the real templates with the real `nl2br`,
// `gridClass` and `signOff` rather than stand-ins that could diverge from them.
exports._registerHelpersOnce = registerHelpersOnce;
exports._registerPartialsOnce = registerPartialsOnce;
exports._loadTemplateCss = loadTemplateCss;
exports._normalizeDensity = normalizeDensity;
// For tests: the @sparticuz/chromium CJS/ESM unwrap. Pure and dependency-free,
// so a harness can feed it both real packaging shapes (v148's direct-property
// CJS object and v149's ESM namespace) and assert on behaviour instead of
// grepping the source for `.default` — a regex would have matched the broken
// code just as happily.
exports._resolveChromium = resolveChromium;
