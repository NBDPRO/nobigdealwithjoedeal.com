/**
 * tests/five-tier-paperwork-2026-10-02.test.js — five roof tiers on the
 * customer-facing PAPERWORK.
 *
 * Jo, 2026-10-02: five tiers, cheapest first — economy / good / better / best /
 * beyond, shown as Economy / Standard / Preferred / Elite / Beyond.
 *   Economy: an economy-grade architectural; a 1-YEAR labor (workmanship)
 *            warranty + the shingle maker's standard limited warranty, NO
 *            system warranty. Never "lifetime".
 *   Beyond:  TAMKO HailGuard only; Elite's workmanship terms + TAMKO's
 *            HailGuard hail warranty (manufacturer terms apply).
 *
 * Every renderer below is the REAL file, run in a vm (or, for the two that
 * can't boot outside a browser, the real block lifted out of the source and
 * run). Each is exercised twice where the file has an inline fallback: with
 * estimate-config.js loaded, and without it (customer.html / estimate-view.html
 * don't load it). Proves, per surface:
 *   - Economy says 1-year labor and never "lifetime" / never offers a system
 *     warranty (the only "system warranty" allowed is a "no system warranty");
 *   - Beyond names TAMKO HailGuard and the hail warranty;
 *   - all five labels render where the surface lists tiers;
 *   - an unknown tier does not render as Best/Elite.
 *
 * Needs functions/ deps (handlebars) for the server templates.
 * Run: node tests/five-tier-paperwork-2026-10-02.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let passed = 0, failed = 0; const fails = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; fails.push(name); console.log('  ✗ ' + name + (detail ? '\n      ' + String(detail).slice(0, 300) : '')); }
}
function section(t) { console.log('\n' + t); }

// Visible text of an HTML string (tags, <style> and <script> dropped).
function text(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ');
}
// Economy honesty: no "lifetime", and every "system warranty" is a "no system
// warranty" (the renderers state the absence explicitly).
function economyClean(s) {
  const t = String(s);
  if (/lifetime/i.test(t)) return 'says lifetime: …' + (t.match(/.{0,60}lifetime.{0,40}/i) || [''])[0];
  const re = /(.{0,12})system warranty/gi; let m;
  while ((m = re.exec(t))) {
    if (!/\bno\s*$/i.test(m[1])) return 'offers a system warranty: …' + m[0];
  }
  return '';
}

const CFG = require(path.join(ROOT, 'docs/pro/js/estimate-config.js'));
const FIVE = ['economy', 'good', 'better', 'best', 'beyond'];
const LABELS = ['Economy', 'Standard', 'Preferred', 'Elite', 'Beyond'];

section('0. the shared config this paperwork reads');
ok('TIER_ORDER is the five keys, cheapest first', JSON.stringify(CFG.TIER_ORDER) === JSON.stringify(FIVE));
ok('tierLabel gives the five customer names', FIVE.map(CFG.tierLabel).join() === LABELS.join());
ok('config Economy warranty text is 1-year + no system warranty', !economyClean(CFG.tierWarrantyText('economy')) && /1-year/.test(CFG.tierWarrantyText('economy')));

// ═══════════════════════════════════════════════════════════════════
// 1. estimate-finalization.js — retail-quote tier cards
// ═══════════════════════════════════════════════════════════════════
function finalization(withCfg) {
  const win = { _brand: () => ({ legalName: 'No Big Deal Home Solutions' }) };
  if (withCfg) win.NBD_ESTIMATE_CONFIG = CFG;
  win.window = win;
  const sb = { window: win, document: { getElementById() { return null; } }, console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Intl, Number, String };
  vm.createContext(sb);
  vm.runInContext(read('docs/pro/js/estimate-finalization.js'), sb, { filename: 'estimate-finalization.js' });
  return win.EstimateFinalization;
}
const EST = { total: 20000, lines: [{ name: 'Shingles', category: 'roofing', quantity: 30, unit: 'SQ' }] };
const TIERS5 = { economy: { total: 13200 }, good: { total: 16500 }, better: { total: 19800 }, best: { total: 23100 }, beyond: { total: 26400 }, recommended: 'better' };
// The card for a label: the text from that label to the next card's label.
function card(t, label) {
  const i = t.indexOf(label.toUpperCase());
  if (i < 0) return '';
  const rest = t.slice(i + label.length);
  const next = LABELS.map((l) => rest.indexOf(l.toUpperCase())).filter((n) => n >= 0);
  return label.toUpperCase() + rest.slice(0, next.length ? Math.min.apply(null, next) : 200);
}
for (const withCfg of [true, false]) {
  section('1. estimate-finalization retail quote — ' + (withCfg ? 'config loaded' : 'NO config (inline fallback)'));
  const FIN = finalization(withCfg);
  const out = FIN.formatRetailQuote(EST, { tiers: TIERS5 });
  const html = out.html || out;
  const t = text(html);
  ok('all five tier cards render (ECONOMY … BEYOND)', LABELS.every((l) => t.includes(l.toUpperCase())), t.slice(0, 200));
  ok('cards are cheapest first', LABELS.map((l) => t.indexOf(l.toUpperCase())).every((v, i, a) => i === 0 || v > a[i - 1]));
  const eco = card(t, 'Economy');
  ok('Economy card: 1-Year Labor Warranty', /1-Year Labor Warranty/.test(eco), eco);
  ok('Economy card: never lifetime / never a system warranty', !economyClean(eco), economyClean(eco));
  const bey = card(t, 'Beyond');
  ok('Beyond card: TAMKO HailGuard + hail warranty', /TAMKO HailGuard/.test(bey) && /Hail Warranty/i.test(bey), bey);
  ok('tier grid wraps (auto-fit), not a fixed three columns', /repeat\(auto-fit,minmax\(/.test(html) && !/grid-template-columns:repeat\(3,1fr\)/.test(html));
  const unk = text((FIN.formatRetailQuote(EST, { tiers: { platinum: { total: 99999 } } }).html) || '');
  ok('an unknown tier key renders no card at all — never as ELITE', !/ELITE|BEYOND|\$99,999/.test(unk));
}

// ═══════════════════════════════════════════════════════════════════
// 2. document-generator(.js + -templates.js) — warranty certificate,
//    warranty badge, rep warranty pickers
// ═══════════════════════════════════════════════════════════════════
function docgen(withCfg) {
  const win = { _brand: () => ({ legalName: 'No Big Deal Home Solutions', colors: {}, contact: {} }) };
  if (withCfg) win.NBD_ESTIMATE_CONFIG = CFG;
  win.window = win;
  const noop = () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {} });
  const sb = {
    window: win,
    document: { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, createElement: noop, body: noop() },
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, Date, Math, JSON,
  };
  vm.runInNewContext(read('docs/pro/js/document-generator.js'), sb, { filename: 'document-generator.js' });
  vm.runInNewContext(read('docs/pro/js/document-generator-templates.js'), sb, { filename: 'document-generator-templates.js' });
  return win.NBDDocGen;
}
for (const withCfg of [true, false]) {
  section('2. document generator — ' + (withCfg ? 'config loaded' : 'NO config (inline fallback)'));
  const DG = docgen(withCfg);
  const cert = (tier, items) => DG.renderWarrantyCertificate({ homeownerName: 'Jane Smith', address: '1 Elm St', warrantyTier: tier, leadId: 'L1', estimateLineItems: items || [] });

  // Economy with a TAMKO Heritage shingle — the manufacturer resolver's own
  // sentence for it says "Limited Lifetime", which Economy must not print.
  const eco = text(cert('economy', [{ code: 'RFG 240-TAMKO', name: 'TAMKO Heritage' }]));
  // Jo, 2026-10-06 (final): the NBD Pledge + the package's written labor years.
  ok('Economy cert: NBD PLEDGE · 1-YEAR WRITTEN WORKMANSHIP (LABOR) WARRANTY — ECONOMY TIER', /NBD PLEDGE · 1-YEAR WRITTEN WORKMANSHIP \(LABOR\) WARRANTY — ECONOMY TIER/.test(eco), eco.slice(0, 300));
  ok('Economy cert: expires 1 year from issue date', /1 year from issue date/.test(eco));
  ok('Economy cert: never lifetime / never a system warranty', !economyClean(eco), economyClean(eco));
  ok('Economy cert: names the manufacturer\'s standard limited warranty', /standard limited warranty/.test(eco));

  const bey = text(cert('beyond', [{ code: 'RFG 240-TAMKO-HAIL', name: 'TAMKO HailGuard' }]));
  ok('Beyond cert: BEYOND tier + TAMKO HailGuard hail warranty', /BEYOND TIER/.test(bey) && /HailGuard/.test(bey) && /hail warranty/i.test(bey), bey.slice(0, 400));
  ok('Beyond cert: Elite workmanship terms (fully transferable + inspections)', /fully transferable/.test(bey) && /annual courtesy inspections/.test(bey));
  const beyNoItems = text(cert('beyond'));
  ok('Beyond cert with no line items still names HailGuard (not the GAF default)', /HailGuard/.test(beyNoItems) && !/GAF Timberline/.test(beyNoItems), beyNoItems.slice(0, 400));

  const unkHtml = cert('platinum');
  const unk = text(unkHtml);
  ok('unknown tier cert: not ELITE, no gold Best colour', !/ELITE/.test(unk) && !/#DAA520/i.test(unkHtml), unk.slice(0, 200));

  for (const k of FIVE) {
    const label = CFG.tierLabel(k).toUpperCase();
    ok('cert prints the ' + label + ' label', text(cert(k)).includes(label + ' TIER'));
  }

  const badgeE = text(DG.renderWarrantyBadge('economy'));
  ok('Economy badge: 1-Year Workmanship + standard limited manufacturer warranty, never lifetime', /1-Year Workmanship/.test(badgeE) && /standard limited warranty/.test(badgeE) && !economyClean(badgeE), badgeE);
  const badgeB = text(DG.renderWarrantyBadge('beyond'));
  ok('Beyond badge: Beyond + HailGuard hail warranty', /Beyond/.test(badgeB) && /HailGuard hail warranty/.test(badgeB), badgeB);
  const badgeU = text(DG.renderWarrantyBadge('platinum'));
  // 2026-10-06: no tier-guessed "Enhanced/Premium" manufacturer level any more;
  // an unknown package names no manufacturer term.
  ok('unknown-tier badge: not Elite, not Premium, manufacturer "per manufacturer"', !/Elite|Premium/.test(badgeU) && /per manufacturer — see your estimate/.test(badgeU), badgeU);

  // Rep pickers: every warrantyTier <select> offers all five, default 'good'.
  const pickers = [];
  Object.keys(DG.DOCUMENT_TYPES || {}).forEach((type) => {
    (DG.getFormFieldsForDocumentType(type) || []).forEach((f) => { if (f.name === 'warrantyTier') pickers.push(f); });
  });
  ok('warranty pickers found (' + pickers.length + ')', pickers.length >= 1);
  ok('every warranty picker offers all five tiers, default good',
    pickers.length && pickers.every((f) => JSON.stringify(f.options) === JSON.stringify(FIVE) && f.default === 'good'));
}

// ═══════════════════════════════════════════════════════════════════
// 3. doc-preflight.js — warranty cards + the contract warranty sentence
// ═══════════════════════════════════════════════════════════════════
section('3. doc-preflight warranty sentence + cards');
{
  const src = read('docs/pro/js/doc-preflight.js').replace(/\r\n/g, '\n');
  const fnM = src.match(/\n  function tierWarrantySentence\(tier\) \{[\s\S]*?\n  \}\n/);
  ok('tierWarrantySentence is defined', !!fnM);
  for (const withCfg of [true, false]) {
    const ctx = { window: withCfg ? { NBD_ESTIMATE_CONFIG: CFG } : {} };
    vm.createContext(ctx);
    vm.runInContext(fnM ? fnM[0] : '', ctx);
    const s = (k) => vm.runInContext('tierWarrantySentence(' + JSON.stringify(k) + ')', ctx);
    const tag = withCfg ? ' (config)' : ' (fallback)';
    ok('Economy contract sentence: 1-year labor, never lifetime' + tag, /1-year written workmanship \(labor\)/.test(s('economy')) && !economyClean(s('economy')), s('economy'));
    ok('Beyond contract sentence: TAMKO HailGuard hail warranty' + tag, /HailGuard hail warranty/.test(s('beyond')), s('beyond'));
    ok('unknown tier sentence: no Elite perks (inspection/fully transferable)' + tag, !/inspection|fully transferable/.test(s('platinum')), s('platinum'));
  }
  ok('the contract bridges both read tierWarrantySentence (no inline lifetime-only fallback left)',
    (src.match(/tierWarrantySentence\(data\.warrantyTier\)/g) || []).length === 2 &&
    !/: 'Lifetime workmanship warranty\.';\s*\/\/ renderWarrantyBadge/.test(src));
  const cardsM = src.match(/var tiers = \[\n([\s\S]*?)\n    \];/);
  const ids = cardsM ? (cardsM[1].match(/id: '([a-z]+)'/g) || []).map((x) => x.slice(5, -1)) : [];
  ok('warranty cards: all five tiers, cheapest first', JSON.stringify(ids) === JSON.stringify(FIVE), ids.join());
  const ecoCard = cardsM ? (cardsM[1].split('\n').find((l) => /id: 'economy'/.test(l)) || '') : '';
  ok('Economy card says 1-Year Labor, never lifetime', /1-Year Labor/.test(ecoCard) && !economyClean(ecoCard.replace(/id: 'economy'.*?tag:/, '')), ecoCard);
  ok('warranty card grid wraps (auto-fill)', /\.dpf-warranty-grid\{display:grid;grid-template-columns:repeat\(auto-fill/.test(src));
}

// ═══════════════════════════════════════════════════════════════════
// 4. warranty-cert.js — wizard preview, server payload, legacy html
// ═══════════════════════════════════════════════════════════════════
async function wcRun(tier, serverOk) {
  const opts = ['economy', 'standard', 'preferred', 'elite', 'beyond'].map((v) => ({ value: v, textContent: v }));
  const els = {
    wcOwner: { value: 'Jane Smith' }, wcAddr: { value: '1 Elm St' }, wcDate: { value: '2026-10-02' },
    wcTier: { value: tier, options: opts }, wcWork: { value: 'Roof replacement' },
    wcTierDesc: { textContent: '' }, wcEyebrow: { textContent: '' },
    warrantyCertModal: { classList: { add() {}, remove() {} } },
  };
  let payload = null, viewerHtml = null;
  const win = { _brand: () => ({ legalName: 'No Big Deal Home Solutions' }), NBD_ESTIMATE_CONFIG: CFG,
    NBDDocViewer: { open: (o) => { viewerHtml = o.html; } } };
  const ctx = { window: win, document: { getElementById: (id) => els[id] || null }, console: { log() {}, warn() {}, error() {} },
    showToast() {}, Date, Math, JSON, Promise };
  vm.createContext(ctx);
  vm.runInContext(read('docs/pro/js/warranty-cert.js'), ctx, { filename: 'warranty-cert.js' });
  ctx._tryServerRender = async (p) => { payload = p; return serverOk; };
  vm.runInContext('updateCertPreview()', ctx);
  await vm.runInContext('generateWarrantyCertPDF()', ctx);
  return { payload, viewerHtml, desc: els.wcTierDesc.textContent, opts };
}
async function wcSection() {
  section('4. warranty-cert.js (wizard → server payload / legacy certificate)');
  const e = await wcRun('economy', true);
  ok('wizard preview: Economy description = one (1) year, never lifetime', /one \(1\) year/.test(e.desc) && !economyClean(e.desc), e.desc);
  ok('…and the Standard option is still relabelled with Economy listed first', e.opts[1].textContent === 'Standard — NBD Pledge · 5-Year Labor', e.opts[1].textContent);
  ok('server payload: Economy label is the NBD Pledge + 1-Year Labor Warranty, never lifetime',
    e.payload && e.payload.tierLabel === 'Economy — NBD Pledge · 1-Year Labor Warranty', e.payload && e.payload.tierLabel);
  ok('server payload: Economy terms never lifetime / no system warranty', e.payload && !economyClean(e.payload.tierTerms), e.payload && e.payload.tierTerms);
  ok('server payload: isEconomy set, no Elite/Preferred perks', e.payload && e.payload.isEconomy === true && !e.payload.isElite && !e.payload.isPreferred);

  const b = await wcRun('beyond', true);
  ok('server payload: Beyond = Elite terms (isElite) + isBeyond', b.payload && b.payload.isElite === true && b.payload.isBeyond === true);
  ok('server payload: Beyond terms name TAMKO HailGuard\'s hail warranty', b.payload && /HailGuard hail warranty/.test(b.payload.tierTerms), b.payload && b.payload.tierTerms);

  const el = await wcRun('economy', false);
  const elt = text(el.viewerHtml);
  ok('legacy Economy certificate renders', !!el.viewerHtml && /Economy — NBD Pledge · 1-Year Labor Warranty/.test(elt), elt.slice(0, 200));
  ok('legacy Economy certificate: never lifetime / never a system warranty', !economyClean(elt), economyClean(elt));
  const bl = text((await wcRun('beyond', false)).viewerHtml);
  ok('legacy Beyond certificate: TAMKO HailGuard hail warranty, TAMKO (not GAF) disclaimer', /TAMKO HailGuard hail warranty/.test(bl) && /The TAMKO manufacturer shingle warranty/.test(bl) && !/GAF/.test(bl), bl.slice(-700));

  const u = await wcRun('platinum', true);
  ok('unknown cert tier: Standard wording, not Elite', u.payload && /^Standard/.test(u.payload.tierLabel) && !u.payload.isElite, u.payload && u.payload.tierLabel);
}

// ═══════════════════════════════════════════════════════════════════
// 5. Server print templates (functions/print) — the real Handlebars
// ═══════════════════════════════════════════════════════════════════
let Handlebars = null, RENDER = null;
try {
  try { Handlebars = require(path.join(ROOT, 'functions/node_modules/handlebars')); } catch (_) { Handlebars = require('handlebars'); }
  RENDER = require(path.join(ROOT, 'functions/render-pdf.js'));
} catch (e) { ok('functions/ deps load (handlebars, render-pdf.js)', false, e && e.message); }
async function printSection() {
  section('5. functions/print — warranty.hbs, estimate.hbs, render-pdf seal, CSS');
  if (!Handlebars || !RENDER) return;
  RENDER._registerPartialsOnce();
  RENDER._registerHelpersOnce();
  const WARRANTY = Handlebars.compile(read('functions/print/templates/warranty.hbs'));
  const COMPANY = { footerName: 'No Big Deal Home Solutions', isNbd: true, seal: 'NBD' };
  const base = { owner: 'Jane Smith', address: '1 Elm St', dateFormatted: 'October 2, 2026', work: 'Roof replacement',
    certNumber: 'NBD-1', preparedFor: { name: 'Jane Smith', address: '1 Elm St' }, preparedBy: { name: 'Joe Deal' }, projectMeta: [] };
  // Body text minus the affiliate row (partner logos, not warranty terms).
  const body = (html) => text(String(html).split('affiliate')[0]);

  const eco = body(WARRANTY(Object.assign({}, base, { company: COMPANY, tier: 'economy', isEconomy: true,
    tierLabel: 'Economy — 1-Year Labor Warranty', tierLabelLong: 'Economy — 1-Year Labor Warranty',
    tierTerms: 'NBD will return and correct any labor-related defect at no charge for one (1) year from the installation date.' })));
  // Economy for NBD (Jo, 2026-10-06): the NBD Pledge cover + the 1-year labor feature line.
  ok('warranty.hbs Economy (NBD): NBD Pledge cover + 1-year written labor line', /Warranty Certificate · NBD Pledge/.test(eco) && /Written workmanship \(labor\) warranty per your package|1-year|one \(1\) year/i.test(eco), eco.slice(0, 300));
  const ecoOther = body(WARRANTY(Object.assign({}, base, { company: { footerName: 'Oaks Roofing', isNbd: false, seal: 'OAKS' }, tier: 'economy', isEconomy: true,
    tierLabel: 'Economy', tierLabelLong: 'Economy', tierTerms: '' })));
  ok('warranty.hbs Economy (another company): 1-Year Labor Warranty badge + cover, no Pledge', /economy · 1-Year Labor Warranty/i.test(ecoOther) && /Warranty Certificate · 1-Year Labor Warranty/.test(ecoOther) && !/Pledge/.test(ecoOther), ecoOther.slice(0, 300));
  ok('warranty.hbs Economy: never the Lifetime Pledge / never a system warranty', !economyClean(eco), economyClean(eco));

  const bey = body(WARRANTY(Object.assign({}, base, { company: COMPANY, tier: 'beyond', isBeyond: true, isElite: true,
    manufacturer: 'TAMKO', manufacturerWarrantyFeature: 'TAMKO HailGuard hail warranty on the shingles (manufacturer terms apply)',
    tierLabel: 'Beyond', tierLabelLong: 'Beyond', tierTerms: 'Lifetime.' })));
  ok('warranty.hbs Beyond: HailGuard hail warranty + Elite perks + TAMKO disclaimer',
    /TAMKO HailGuard hail warranty/.test(bey) && /Annual courtesy inspection/.test(bey) && /TAMKO manufacturer shingle warranty \(including the HailGuard hail warranty\)/.test(bey), bey.slice(-600));

  const std = body(WARRANTY(Object.assign({}, base, { company: COMPANY, tier: 'standard', tierLabel: 'Standard', tierLabelLong: 'Standard', tierTerms: 'x' })));
  // 2026-10-06: the workmanship line is the NBD Pledge, printed apart from the manufacturer line.
  ok('warranty.hbs Standard: the NBD Pledge promise as its own line, never "lifetime"', /NBD Pledge: for as long as you own the home, we'll come back and make it right\./.test(std) && !/lifetime/i.test(std), std.slice(0, 600));

  // The layout chrome's seal: render-pdf.js swaps "Lifetime Pledge" on Economy.
  const ecoDoc = await RENDER.buildDocHtml('warranty', Object.assign({}, base, { tier: 'economy', isEconomy: true, tierLabel: 'E', tierLabelLong: 'E', tierTerms: 'x' }), null);
  ok('render-pdf: an Economy warranty\'s chrome seal is not "Lifetime Pledge"', !/lifetime/i.test(text(ecoDoc.html)), (text(ecoDoc.html).match(/.{0,60}lifetime.{0,30}/i) || [''])[0]);
  // NBD = the owner's companyId (a null companyId is now a neutral company, whose seal is not the Pledge).
  const stdDoc = await RENDER.buildDocHtml('warranty', Object.assign({}, base, { tier: 'standard', tierLabel: 'S', tierLabelLong: 'S', tierTerms: 'x' }), '1phDvAVXHSg82wDLegAbQFq14Ci1');
  ok('render-pdf: a Standard warranty\'s NBD seal is the NBD Pledge, never "Lifetime"', /NBD Pledge/.test(text(stdDoc.html)) && !/lifetime/i.test(text(stdDoc.html)));

  const ESTIMATE = Handlebars.compile(read('functions/print/templates/estimate.hbs'));
  const tierList = FIVE.map((k) => ({ name: CFG.tierLabel(k), subtitle: k, total: 1000, features: [], isRecommended: k === 'better' }));
  const estHtml = ESTIMATE({ company: COMPANY, tiers: true, tierList, lines: [], preparedFor: {}, preparedBy: {}, projectMeta: [] });
  ok('estimate.hbs renders a card per tier (5)', (estHtml.match(/class="tier-card/g) || []).length === 5);
  ok('estimate.hbs: all five labels', LABELS.every((l) => text(estHtml).includes(l)));
  ok('estimate.hbs copy no longer hardcodes a count or "same lifetime warranty"', !/Three ways|same lifetime warranty/i.test(text(estHtml)));

  const css = read('functions/print/design-system.css').replace(/\r\n/g, '\n');
  const grid = (css.match(/\.tier-grid \{[\s\S]*?\}/) || [''])[0];
  ok('design-system .tier-grid wraps (flex-wrap), not repeat(3, 1fr)', /flex-wrap: wrap/.test(grid) && !/repeat\(3/.test(grid), grid);
  ok('design-system has Economy + Beyond badge classes', /\.badge\.tier-economy/.test(css) && /\.badge\.tier-beyond/.test(css));
}

// ═══════════════════════════════════════════════════════════════════
// 6. estimate-view.js — the homeowner's standalone estimate page
// ═══════════════════════════════════════════════════════════════════
async function renderEstimateView(est) {
  const root = { _h: '', set innerHTML(v) { this._h = String(v); }, get innerHTML() { return this._h; }, addEventListener() {}, querySelector() { return null; } };
  const sb = {
    document: { getElementById: (id) => (id === 'evRoot' ? root : null), title: '', documentElement: { style: { setProperty() {} } }, body: null, referrer: '' },
    location: { hostname: 'example.test', search: '?token=abcdefghij1234&estimateId=est1', origin: 'https://example.test' },
    history: { length: 1, back() {} }, URLSearchParams, URL, JSON, Math, Number, String, Promise, setTimeout,
    console: { log() {}, warn() {}, error() {} },
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ estimate: est, company: null }) }),
  };
  sb.window = sb;
  vm.runInNewContext(read('docs/pro/js/estimate-view.js'), sb, { filename: 'estimate-view.js' });
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return root.innerHTML;
}
async function viewSection() {
  section('6. estimate-view.js (homeowner page, no config loaded)');
  const h = text(await renderEstimateView({ number: 'E-1', tier: 'beyond', grandTotal: 26400,
    tiers: { economy: { total: 13200 }, good: { total: 16500 }, better: { total: 19800 }, best: { total: 23100 }, beyond: { total: 26400 } } }));
  ok('estimate-view: all five tier cards, cheapest first',
    LABELS.every((l) => h.includes(l)) && LABELS.map((l) => h.indexOf(l)).every((v, i, a) => i === 0 || v > a[i - 1]), h.slice(0, 300));
  const eOnly = text(await renderEstimateView({ number: 'E-2', tier: 'economy', tiers: { economy: { total: 13200 } } }));
  ok('estimate-view: an Economy-only estimate still shows its tier card', /Choose your tier/.test(eOnly) && /Economy/.test(eOnly), eOnly.slice(0, 200));
  const u = text(await renderEstimateView({ number: 'E-3', tier: 'platinum', tiers: { platinum: { total: 1 } } }));
  ok('estimate-view: an unknown tier is not rendered as Elite', !/Elite/.test(u));
}

// ═══════════════════════════════════════════════════════════════════
// 7. customer-bootstrap certificate + invoice-pipeline line (lifted blocks)
// ═══════════════════════════════════════════════════════════════════
function liftedSection() {
  section('7. customer.html warranty certificate + invoice line label (real blocks, lifted)');
  const cb = read('docs/pro/js/customer-bootstrap.module.js').replace(/\r\n/g, '\n');
  const a = cb.indexOf('  const _tierKey = _jobW ?');
  const b = cb.indexOf('\n\n  // Accent is a literal here');
  ok('certificate tier block found', a > 0 && b > a);
  const block = cb.slice(a, b);
  for (const withCfg of [true, false]) {
    const run = (tier) => {
      const ctx = { window: withCfg ? { NBD_ESTIMATE_CONFIG: CFG } : {}, _jobW: null, _jw: null, est: { tier }, String, Number };
      vm.createContext(ctx);
      vm.runInContext(block + '\nthis.__o = { period: _roofPeriod, body: _roofBody, label: tierLabelStr };', ctx);
      return ctx.__o;
    };
    const tag = withCfg ? ' (config)' : ' (fallback)';
    const e = run('economy');
    ok('customer cert Economy: 1-Year Workmanship (Labor), never lifetime' + tag,
      e.period === '1-Year Written Workmanship (Labor)' && !economyClean(e.period + ' ' + e.body) && e.label === 'Economy', JSON.stringify(e));
    const bb = run('beyond');
    ok('customer cert Beyond: lifetime + HailGuard hail warranty' + tag, /HailGuard hail warranty/.test(bb.body) && bb.label === 'Beyond', JSON.stringify(bb));
    ok('customer cert Standard: 5-Year Written Workmanship (Labor), never lifetime' + tag, run('good').period === '5-Year Written Workmanship (Labor)' && !/lifetime/i.test(run('good').body), JSON.stringify(run('good')));
  }
  ok('customer cert prints the computed period/body (not a hardcoded lifetime)',
    /: esc\(_roofPeriod\)\}/.test(cb) && /: esc\(_roofBody\)\}/.test(cb) && !/: 'Lifetime Workmanship'\}<\/span>/.test(cb));
  ok('estimate-list chip has Economy and Beyond colours', /tier==='beyond'\?/.test(cb) && /tier==='economy'\?/.test(cb));

  // The invoice's per-SQ summary line now lives in invoiceTotalsFromEstimate
  // (shared with the server's draft deposit invoice, 2026-10-03) — run it.
  const IPm = require(path.join(ROOT, 'docs/pro/js/invoice-pipeline.js'));
  ok('invoice tier-label block found', typeof IPm.invoiceTotalsFromEstimate === 'function');
  for (const withCfg of [true, false]) {
    const lab = (tier) => {
      const t = IPm.invoiceTotalsFromEstimate({ priceMode: 'per-sq', grandTotal: 1000, taxRate: 0, selectedTier: tier },
        withCfg ? { tierLabel: CFG.tierLabel } : {});
      return t.items[0].description.replace(/^Roofing system — /, '').replace(/ tier$/, '');
    };
    ok('invoice line prints customer names, not raw keys' + (withCfg ? ' (config)' : ' (fallback)'),
      FIVE.map(lab).join() === LABELS.join(), FIVE.map(lab).join());
  }
}

// ═══════════════════════════════════════════════════════════════════
// 8. estimate-analytics.js — signed tier mix counts all five
// ═══════════════════════════════════════════════════════════════════
function analyticsSection() {
  section('8. estimate-analytics signed tier mix');
  const win = { NBD_ESTIMATE_CONFIG: CFG, addEventListener() {} };
  win.window = win;
  const sb = { window: win, document: { getElementById() { return null; }, addEventListener() {} }, console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, setTimeout, clearTimeout };
  vm.createContext(sb);
  vm.runInContext(read('docs/pro/js/estimate-analytics.js'), sb, { filename: 'estimate-analytics.js' });
  const now = Date.now();
  win._estimates = FIVE.map((k, i) => ({ id: k, signedAt: now, grandTotal: 1000 * (i + 1), tier: k }))
    .concat([{ id: 'x', signedAt: now, grandTotal: 1, tier: 'platinum' }]);
  const a = win.NBDEstimateAnalytics.compute();
  ok('tierCounts has all five keys, one each', FIVE.every((k) => a.tierCounts[k] === 1), JSON.stringify(a.tierCounts));
  ok('an unknown tier is not counted as any tier (incl. best)', !Object.prototype.hasOwnProperty.call(a.tierCounts, 'platinum') && a.tierCounts.best === 1);
}

(async () => { await wcSection(); await printSection(); await viewSection(); liftedSection(); analyticsSection(); })().catch((e) => ok('async section threw', false, e && e.stack)).then(() => {
  console.log('\n──────────────────────────────');
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) { console.log('\nFailures:'); fails.forEach((f) => console.log('  - ' + f)); process.exit(1); }
});
