#!/usr/bin/env node
/**
 * tests/crm-homeowner-claims-honesty-2026-10-07.test.js
 *
 * WHY THIS EXISTS
 * ────────────────
 * The public site's honesty gate (homeowner-claims-honesty-2026-10-05.test.js)
 * scans docs/ but skips docs/pro/ and functions/, so the claims Jo ruled out
 * survived on the pages and emails the CRM sends to homeowners (homeowner
 * money audit, 2026-10-07, H3 + H4):
 *   - every deal room (the page the homeowner signs) said "Licensed & insured"
 *     in its trust row and footer; so did the estimate email, the
 *     funnel-recovery email, the door hanger and neighborhood mailer
 *     templates and the storm campaign kit ("Licensed + insured in OH + KY").
 *     Jo has no OH/KY registration number behind "Licensed" (2026-10-05):
 *     NBD says "Fully insured";
 *   - a $500 shingle-patch REPAIR's deal room promised the Preferred tier's
 *     "10-year … transferable … GAF System Plus" warranty, because every card
 *     printed its tier's roofing sentence whatever the job was, and
 *     NBDCustomerEstimateRows.estimateWarranty() returned null for a repair
 *     built outside Job Templates.
 *
 * WHAT IT CHECKS
 *   A. A static scan of the homeowner-facing CRM and Cloud Function outputs
 *      (the HOMEOWNER_OUTPUTS list below plus every functions/print .hbs) for
 *      "licensed", "lifetime warranty", "in-house", "our employees",
 *      "handle your/the claim", "underpaid", "recovered". Comments are
 *      stripped line-wise first (whole-file block-comment regexes eat 10-48%
 *      of these files: see the memory note on comment-quoting assertions).
 *      Two phrases are allowed by name because they are about someone else:
 *      "licensed public adjuster" (the KY notice) and "in-house e-sign".
 *   B. Positive controls: each banned phrase planted as a string in a temp
 *      copy of close-board.js turns the scan red; the same phrase planted in
 *      a comment does not.
 *   C. Behaviour: the deal room page from close-board.js's real
 *      generatePageHTML says "Fully insured" (NBD) / "Insured" (another
 *      company) and never "Licensed"; a repair deal prints no tier warranty
 *      (and the 1-year line only when the rep ticked it), a replacement keeps
 *      its tier sentence; estimateWarranty() on a non-template repair; the
 *      V2 builder hands the deal room the job type; the two emails built by
 *      their real functions say "Fully insured".
 *
 * Pure Node, zero deps beyond functions/node_modules (the email modules load
 * firebase-functions). Run: node tests/crm-homeowner-claims-honesty-2026-10-07.test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

let passed = 0, failed = 0;
const fails = [];
function ok(label, cond, detail) {
  if (cond) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label + (detail !== undefined ? ' — ' + String(detail).slice(0, 400) : '')); failed++; fails.push(label); }
}
async function section(title, fn) {
  console.log('\n' + title);
  try { await fn(); } catch (e) { ok(title + ' — ran', false, e && (e.stack || e.message)); }
}

// ── A. The homeowner-facing CRM outputs ─────────────────────────────────
// Files whose strings reach a homeowner: the deal room, its served script and
// server, the homeowner emails, the document generators and their print
// templates, the warranty certificate, the portal, the estimate/e-sign PDFs
// and the warranty sentences they print.
const HOMEOWNER_OUTPUTS = [
  'docs/pro/js/close-board.js',
  'docs/pro/deal-room.js',
  'functions/deal-acceptance.js',
  'functions/estimate-email.js',
  'functions/funnel-recovery.js',
  'docs/pro/js/document-generator-templates.js',
  'docs/pro/js/document-generator.js',
  'docs/pro/js/document-generator-library.js',
  'docs/pro/js/estimate-finalization.js',
  'docs/pro/js/estimate-v2-ui.js',
  'docs/pro/js/doc-preflight.js',
  'docs/pro/js/storm-integration.js',
  'docs/pro/js/warranty-cert.js',
  'docs/pro/js/portal.js',
  'docs/pro/js/customer-portal.js',
  'functions/portal.js',
  'functions/homeowner-progress.js',
  'functions/estimate-esign-pdf.js',
  'functions/esign-envelope.js',
  'docs/pro/js/customer-estimate-rows.js',
  'functions/customer-estimate-rows.js',
  'docs/pro/js/estimate-config.js',
];
for (const dir of ['functions/print/templates', 'functions/print/partials']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir)).sort()) if (f.endsWith('.hbs')) HOMEOWNER_OUTPUTS.push(dir + '/' + f);
}

const BANNED = [
  ['licensed', /\blicensed\b/i],
  ['lifetime warranty', /\blifetime\s+warranty\b/i],
  // "in-house e-sign" / "in-house signing" / "in-house financing" name a
  // feature, not who does the work.
  ['in-house', /\bin-house\b(?!\s+(e-?sign|sign(ing)?\b|financing))/i],
  ['our employees', /\bour\s+employees\b/i],
  ['handle your claim', /\bhandle\s+(your|the)\s+(insurance\s+)?claim/i],
  ['underpaid', /\bunderpaid\b/i],
  ['recovered', /\brecovered\b/i],
];
// Said about someone else, and required wording where it appears.
const ALLOWED = [/licensed public adjusters?/gi];

// Line-wise comment stripper. Drops `//` lines and whole /* … */ blocks that
// START a line (tracked, so a `*`-led line outside a block is kept — a
// template literal can hold one). HTML/Handlebars comments go first in .hbs.
function stripComments(src, file) {
  let s = src;
  if (/\.(hbs|html)$/.test(file)) {
    s = s.replace(/\{\{!--[\s\S]*?--\}\}/g, '').replace(/\{\{![^}]*\}\}/g, '').replace(/<!--[\s\S]*?-->/g, '');
  }
  const out = [];
  let inBlock = false;
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) inBlock = false; continue; }
    if (t.startsWith('//')) continue;
    if (t.startsWith('/*')) { if (!t.includes('*/')) inBlock = true; continue; }
    out.push(line);
  }
  return out.join('\n');
}

function scanText(raw, file) {
  let text = stripComments(raw, file);
  for (const a of ALLOWED) text = text.replace(a, '');
  const hits = [];
  text.split('\n').forEach((line, i) => {
    for (const [name, re] of BANNED) if (re.test(line)) hits.push(name + ' @' + (i + 1) + ': ' + line.trim().slice(0, 120));
  });
  return { hits, stripped: text };
}

async function main() {
  await section('A. Homeowner-facing CRM output carries none of the ruled-out claims', async () => {
    for (const rel of HOMEOWNER_OUTPUTS) {
      const raw = read(rel);
      const { hits, stripped } = scanText(raw, rel);
      // The stripper must not have eaten the file (an absence check over a
      // corpus missing its code passes vacuously).
      const kept = stripped.length / Math.max(1, raw.length);
      ok(rel + ': stripper kept the code (' + Math.round(kept * 100) + '%)', kept > 0.3, kept);
      ok(rel + ': no ruled-out claim', hits.length === 0, hits.join(' | '));
    }
    ok('the scan list covers the deal room, both emails, the templates and every print template',
      ['docs/pro/js/close-board.js', 'functions/estimate-email.js', 'functions/funnel-recovery.js', 'docs/pro/js/document-generator-templates.js', 'docs/pro/js/estimate-finalization.js'].every((f) => HOMEOWNER_OUTPUTS.includes(f))
      && HOMEOWNER_OUTPUTS.filter((f) => f.endsWith('.hbs')).length >= 10);
  });

  await section('B. Positive controls — the scan can go red', async () => {
    const base = read('docs/pro/js/close-board.js');
    ok('control: the untouched copy is clean', scanText(base, 'close-board.js').hits.length === 0);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nbd-honesty-'));
    try {
      const plants = {
        'licensed': "'<div class=\"trust-row\">✓ Licensed &amp; insured</div>'",
        'lifetime warranty': "'Lifetime warranty on every roof'",
        'in-house': "'Our in-house crews do every job'",
        'our employees': "'Installed by our employees'",
        'handle your claim': "'We handle your insurance claim'",
        'underpaid': "'Your insurer underpaid you'",
        'recovered': "'We recovered $8,000 from the carrier'",
      };
      for (const [name, str] of Object.entries(plants)) {
        const f = path.join(tmp, 'close-board.js');
        fs.writeFileSync(f, base + '\nconst __planted = ' + str + ';\n');
        const asString = scanText(fs.readFileSync(f, 'utf8'), f).hits;
        ok('planted "' + name + '" in a string → red', asString.some((h) => h.startsWith(name + ' ')), asString.join(' | '));
        fs.writeFileSync(f, base + '\n// a comment quoting the old wording: ' + str + '\n');
        ok('planted "' + name + '" in a comment → still clean', scanText(fs.readFileSync(f, 'utf8'), f).hits.length === 0);
      }
      const f = path.join(tmp, 'x.js');
      fs.writeFileSync(f, base + "\nconst __ky = 'that is a licensed public adjuster or an attorney you choose';\nconst __es = 'in-house e-sign';\n");
      ok('allowed: "licensed public adjuster" and "in-house e-sign" stay clean', scanText(fs.readFileSync(f, 'utf8'), f).hits.length === 0);
      const hbs = path.join(tmp, 't.hbs');
      fs.writeFileSync(hbs, '{{!-- never a "lifetime warranty" --}}\n<p>Licensed and insured</p>\n');
      const h = scanText(fs.readFileSync(hbs, 'utf8'), hbs).hits;
      ok('.hbs: the comment is stripped, the markup is scanned', h.length === 1 && h[0].startsWith('licensed '), h.join(' | '));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ── C. Behaviour ───────────────────────────────────────────────────────
  function memLS() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
  function loadCB(opts) {
    opts = opts || {};
    const win = { addEventListener() {}, _user: null };
    win.window = win;
    const doc = { getElementById: () => null, addEventListener() {}, querySelector: () => null };
    win.document = doc;
    const c = { window: win, document: doc, console: { log() {}, warn() {}, error() {} }, localStorage: memLS(), setTimeout, clearTimeout, navigator: {}, Date, Math, JSON };
    vm.createContext(c);
    vm.runInContext(read('docs/pro/js/estimate-config.js'), c);
    vm.runInContext(read('docs/assets/js/financing-band.js'), c);
    vm.runInContext(read('docs/pro/js/deal-packet.js'), c);
    if (opts.cer !== false) vm.runInContext(read('docs/pro/js/customer-estimate-rows.js'), c);
    win._brand = () => (opts.brand || { legalName: 'No Big Deal Home Solutions', contact: { phone: '(859) 420-7382' } });
    vm.runInContext(read('docs/pro/js/close-board.js'), c);
    return { CB: win.CloseBoard, win };
  }
  const tierOf = (p) => ({ price: p, description: '', lineItems: [] });
  const baseDeal = (extra) => Object.assign({
    id: 'dr_honest1', customerName: 'Pat', address: '1 Test St, Milford, OH 45150', repName: 'Joe', repEmail: 'jd@example.test', repPhone: '(859) 420-7382',
    packet: 'full', scopeSummary: ['Shingle patch'],
    tiers: { economy: tierOf(9000), good: tierOf(11000), better: tierOf(13000), best: tierOf(15000) },
  }, extra || {});
  const trustRows = (html) => (html.match(/<div class="trust-row">[^<]*<\/div>/g) || []);
  const footer = (html) => { const i = html.indexOf('<div class="footer">'); return i === -1 ? '' : html.slice(i, html.indexOf('</div>', html.indexOf('<div>', i) + 5) + 6); };
  const cardWarranties = (html) => (html.match(/<div class="tier-warranty">[^<]*<\/div>/g) || []);

  await section('C1. Deal room trust row + footer (close-board.js generatePageHTML)', async () => {
    const { CB } = loadCB();
    const html = CB.generatePageHTML(baseDeal());
    const rows = trustRows(html);
    ok('control: the full packet renders its trust rows and footer', rows.length >= 2 && footer(html).length > 0, rows.join(''));
    ok('NBD trust row: "✓ Fully insured"', rows[0] === '<div class="trust-row">✓ Fully insured</div>', rows[0]);
    ok('NBD footer: "No Big Deal Home Solutions · Fully Insured"', /No Big Deal Home Solutions · Fully Insured<\/div>/.test(html), footer(html));
    ok('NBD page: no "Licensed" anywhere', !/licensed/i.test(html));
    const paper = CB.generatePageHTML(baseDeal({ packet: 'paperwork' }));
    ok('paperwork page: the footer says Fully Insured, no "Licensed"', /· Fully Insured<\/div>/.test(paper) && !/licensed/i.test(paper));

    const T = loadCB({ brand: { legalName: 'Summit Ridge Roofing LLC', contact: { phone: '(513) 555-0199' } } }).CB;
    const th = T.generatePageHTML(baseDeal());
    ok('another company: control — its own name is on the page', /Summit Ridge Roofing LLC/.test(th));
    ok('another company: the neutral "✓ Insured" row and "· Insured" footer', trustRows(th)[0] === '<div class="trust-row">✓ Insured</div>' && /Summit Ridge Roofing LLC · Insured<\/div>/.test(th), trustRows(th)[0]);
    ok('another company: no "Licensed", and NBD\'s "Fully insured" is not claimed for it', !/licensed/i.test(th) && !/fully insured/i.test(th));
  });

  await section('C2. Repair warranty in the deal room (audit H4)', async () => {
    const { CB } = loadCB();
    const est = (jobType, id) => ({ id: id, prices: { good: 450, better: 500, best: 550 }, packet: 'full', scopeSummary: ['Shingle patch'], jobType: jobType });
    const lead = { id: 'lead_h4', firstName: 'Pat', address: '1 Test St, Milford, OH 45150' };

    const rep = CB.createFromEstimate(est({ workKind: 'repair', priceMode: 'line-item' }, 'est_rep1'), lead);
    ok('repair, warranty not ticked: the deal carries jobWarranty ""', rep.jobWarranty === '', JSON.stringify(rep.jobWarranty));
    const rh = CB.generatePageHTML(rep);
    ok('control: the repair page still renders its package cards', /data-deal-tier="better"/.test(rh) && /data-deal-tier="good"/.test(rh));
    ok('repair page: no tier warranty line on any card', cardWarranties(rh).length === 0, cardWarranties(rh).join(''));
    ok('repair page: no "10-year", "transferable" or "GAF System Plus"', !/10-year/.test(rh) && !/transferable/i.test(rh) && !/System Plus/.test(rh));
    ok('repair page: no "Every package above carries its own written warranty" row', !/Every package above carries/.test(rh));

    const rep1 = CB.createFromEstimate(est({ workKind: 'repair', repairWarranty: true, priceMode: 'line-item' }, 'est_rep2'), lead);
    const r1 = CB.generatePageHTML(rep1);
    const cw = cardWarranties(r1);
    ok('repair, 1-year ticked: every card prints the 1-year line', cw.length === 3 && cw.every((w) => w === '<div class="tier-warranty">🛡️ 1-year workmanship warranty.</div>'), cw.join(''));
    ok('repair, 1-year ticked: no tier sentence', !/10-year|System Plus|transferable/i.test(r1));

    const repl = CB.createFromEstimate(est({ workKind: 'replacement', priceMode: 'line-item' }, 'est_repl'), lead);
    const pl = CB.generatePageHTML(repl);
    ok('replacement: jobWarranty null, tier wording kept', repl.jobWarranty === null);
    ok('replacement: Preferred card prints its 10-year sentence with GAF System Plus', cardWarranties(pl).some((w) => /10-year/.test(w) && /GAF System Plus/.test(w)));
    const legacy = CB.createFromEstimate({ id: 'est_legacy', prices: { good: 11000, better: 13000 } }, lead);
    ok('a caller passing no job type (older builders): tier wording, as before', legacy.jobWarranty === null && /10-year/.test(CB.generatePageHTML(legacy)));
    const econ = CB.generatePageHTML(baseDeal());
    const econCard = cardWarranties(econ)[0] || '';
    ok('Economy card: 1-year labor, no system warranty, no System Plus', /1-year/.test(econCard) && /no system warranty/.test(econCard) && !/System Plus/.test(econCard), econCard);

    const { CB: CB2 } = loadCB({ cer: false });
    const failClosed = CB2.createFromEstimate(est({ workKind: 'repair', priceMode: 'line-item' }, 'est_rep3'), lead);
    ok('rows helper missing: a repair fails closed (no warranty), not to the tier sentence', failClosed.jobWarranty === '' && !/10-year/.test(CB2.generatePageHTML(failClosed)));
  });

  await section('C3. estimateWarranty() on a repair built outside Job Templates', async () => {
    const CER = require(path.join(ROOT, 'docs/pro/js/customer-estimate-rows.js'));
    const none = CER.estimateWarranty({ workKind: 'repair', priceMode: 'line-item' });
    ok('repair, not ticked → { kind: repair, text: "" }', none && none.kind === 'repair' && none.text === '', JSON.stringify(none));
    const one = CER.estimateWarranty({ workKind: 'repair', repairWarranty: true });
    ok('repair, ticked → "1-year workmanship warranty."', one && one.text === '1-year workmanship warranty.' && one.years === 1, JSON.stringify(one));
    ok('replacement / no kind → null (caller keeps tier wording)', CER.estimateWarranty({ workKind: 'replacement' }) === null && CER.estimateWarranty({}) === null);
    ok('per-SQ stays roofing even if mislabelled a repair', CER.estimateWarranty({ workKind: 'repair', priceMode: 'per-sq' }) === null);
    const tpl = CER.estimateWarranty({ builder: 'template', sourceTemplates: ['jt_gi_k5_seamless_full'], warrantyKind: 'gutter_system', workKind: 'repair' });
    ok('a Job Template estimate still answers by its warrantyKind', tpl && tpl.text === '5-year workmanship warranty.', JSON.stringify(tpl));
    const FN = require(path.join(ROOT, 'functions/customer-estimate-rows.js'));
    ok('the functions/ copy answers the same', JSON.stringify(FN.estimateWarranty({ workKind: 'repair' })) === JSON.stringify(none));
  });

  await section('C4. V2 "Send to homeowner" hands the deal room the job type', async () => {
    function fakeEl(id) {
      const cls = new Set(); const attrs = {};
      return {
        id, textContent: '', innerHTML: '', hidden: false, disabled: false, style: {}, value: '',
        classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c),
          toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; } },
        setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: (k) => attrs[k],
      };
    }
    function loadV2() {
      const ids = ['v2sendHoBtn', 'v2shareStatus', 'v2shareBox', 'v2saveBtn', 'v2saveStatus', 'estV2Modal', 'v2packetFull', 'v2packetPaper', 'v2packetHint', 'v2packetPhotos', 'v2signBtn', 'v2signStatus', 'v2kyNote', 'v2kyContractBtn'];
      const els = {}; ids.forEach((i) => { els[i] = fakeEl(i); });
      const doc = { getElementById: (i) => els[i] || null, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => Object.assign(fakeEl(''), { appendChild() {}, addEventListener() {} }), addEventListener() {}, body: { appendChild() {} }, head: { appendChild() {} } };
      const store = new Map(); const calls = [];
      const win = {}; win.window = win;
      win._user = { uid: 'u_owner_1' }; win.localStorage = memLS(); win.db = {};
      win.doc = (_db, col, id) => col + '/' + id;
      win.getDoc = async (p) => ({ exists: () => store.has(p), data: () => store.get(p) });
      win.setDoc = async (p, data) => { store.set(p, Object.assign({}, store.get(p) || {}, data)); };
      win.NBDJurisdiction = require(path.join(ROOT, 'docs/pro/js/ky-insurance-law.js'));
      win.NBD_XACT_CATALOG = { find: (code) => ({ code, name: code, unit: 'SQ' }) };
      win.EstimateLogic = { resolveEstimate: () => ({ lines: [{ code: 'RFG', name: 'Shingle patch', quantity: 1, unit: 'EA', lineTotal: 500 }], subtotal: 500, tax: 0, total: 500 }), buildContext: (x) => x, MEASUREMENT_VARS: [] };
      win.EstimateBuilderV2 = { loadSettings: () => ({ countyTax: {} }), calculatePerSq: () => ({}),
        calculateAllTiers: () => ({ economy: { total: 9000 }, good: { total: 11000 }, better: { total: 13000 }, best: { total: 15000 }, beyond: { total: 17000 } }) };
      win._saveEstimate = async () => { win._editingEstimateId = null; return 'est_1'; };
      win.CloseBoard = {
        createFromEstimate: (est) => { calls.push(est); return { id: 'dr_1' }; },
        getAcceptLink: async () => 'https://example.test/deal/TOKEN', markShared: () => {},
      };
      win.showToast = () => {};
      const c = { window: win, document: doc, navigator: { share: async () => {} }, console: { log() {}, warn() {}, error() {} },
        Date, Math, JSON, Set, Map, Promise, setTimeout: () => 0, clearTimeout() {}, localStorage: win.localStorage };
      vm.createContext(c);
      vm.runInContext(read('docs/pro/js/deal-packet.js'), c, { filename: 'deal-packet.js' });
      vm.runInContext(read('docs/pro/js/estimate-v2-ui.js'), c, { filename: 'estimate-v2-ui.js' });
      const T = win.EstimateV2UI._test;
      const st = T.getState();
      st.scope = [{ code: 'RFG' }];
      st.measurements.rawSqft = 2000;
      st.jobMode = 'cash'; st.tier = 'better';
      st.customer = { name: 'Pat Homeowner', address: '1 Test St, Milford, OH 45150', phone: '(513) 555-0101', email: '', leadId: 'lead_h4' };
      return { T, st, calls };
    }
    const R = loadV2();
    R.st.mode = 'line-item'; R.st.workKind = 'repair';
    await R.T.sendToHomeowner();
    const d = R.calls[0] || {};
    ok('line-item repair: the deal estimate carries jobType.workKind "repair", priceMode line-item', d.jobType && d.jobType.workKind === 'repair' && d.jobType.priceMode === 'line-item', JSON.stringify(d.jobType));
    ok('jobType carries no prices (that would read as per-SQ roofing)', d.jobType && d.jobType.prices === undefined);
    const CER = require(path.join(ROOT, 'docs/pro/js/customer-estimate-rows.js'));
    ok('…which estimateWarranty() turns into no warranty claim', d.jobType && CER.estimateWarranty(d.jobType) && CER.estimateWarranty(d.jobType).text === '');
    const P = loadV2();
    P.st.mode = 'per-sq'; P.st.workKind = 'replacement';
    await P.T.sendToHomeowner();
    const dp = P.calls[0] || {};
    ok('per-SQ replacement: jobType says replacement / per-sq → tier wording (null)', dp.jobType && dp.jobType.workKind === 'replacement' && CER.estimateWarranty(dp.jobType) === null, JSON.stringify(dp.jobType));
  });

  await section('C5. Homeowner emails, built by their real functions', async () => {
    const EE = require(path.join(ROOT, 'functions/estimate-email.js'))._test;
    const FR = require(path.join(ROOT, 'functions/funnel-recovery.js'))._test;
    const eh = EE.buildEstimateEmailHtml({ firstName: 'Pat', estimateSummary: 'Roof: $11,000' });
    const et = EE.buildEstimateEmailText({ firstName: 'Pat', estimateSummary: 'Roof: $11,000' });
    ok('control: the estimate email rendered its sign-off', /— Joe/.test(eh) && /— Joe/.test(et));
    ok('estimate email (HTML + text): "Fully insured", never "Licensed"', /Fully insured · GAF Certified/.test(eh) && /Fully insured · GAF Certified/.test(et) && !/licensed/i.test(eh + et));
    const fh = FR.buildRecoveryEmailHtml({ firstName: 'Pat' });
    const ft = FR.buildRecoveryEmailText({ firstName: 'Pat' });
    ok('funnel-recovery email (HTML + text): "Fully insured", never "Licensed"', /Fully insured/.test(fh) && /Fully insured/.test(ft) && !/licensed/i.test(fh + ft));
  });

  console.log('\n──────────────────────');
  console.log(passed + ' passed, ' + failed + ' failed');
  if (failed) { console.log('FAILED: ' + fails.join(' | ')); process.exit(1); }
  process.exit(0);
}

main();
